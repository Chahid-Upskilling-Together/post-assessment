import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WorkflowExecutionAlreadyStartedError, WorkflowUpdateFailedError, type WorkflowHandle } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import type * as realActivities from "../src/activities";
import type {
  Candidate,
  FrontDeskNote,
  MatchResult,
  OfferCheck,
  Opening,
  OpeningInput,
  OpeningStatus,
  Policy,
  ReplyInput,
  ReplyOutcome,
} from "../src/types";
import { cancelOpening, clientReply, fillOpeningWorkflow, getOpeningStatus, parseReply } from "../src/workflows";
import { bundlerOptions } from "../src/bundler-options";

// ---------------------------------------------------------------------------
// Fixtures

const MINUTE = 60_000;
const POLICY: Policy = { sameDayHoldMinutes: 15, laterHoldMinutes: 60, minuteMs: MINUTE };
const OPENING: Omit<Opening, "id"> = {
  service: "Haircut",
  stylist: "Ana",
  date: "2026-10-10",
  time: "14:00",
  when: "on Sat 10 Oct at 2:00 pm",
  sameDay: true,
};
// Waitlist order: ann, then bob, then cat.
const CANDIDATES: MatchResult["candidates"] = [
  { id: "ann", name: "Ann Archer", mobile: "(555) 010-0001" },
  { id: "bob", name: "Bob Brooks", mobile: "(555) 010-0002" },
  { id: "cat", name: "Cat Chen", mobile: "(555) 010-0003" },
];
const TEST_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Mocked activities that record every call

type SentText = { clientId: string; openingId: string; kind: string; body: string };
type OfferCall = { clientId: string; openingId: string };
type Calls = {
  log: string[]; // every activity call, in order
  matched: Opening[];
  startOffers: (OfferCall & { result: OfferCheck })[];
  endOffers: OfferCall[];
  texts: SentText[]; // delivered
  undelivered: SentText[]; // refused by the mock
  frontDesk: Omit<FrontDeskNote, "id" | "at">[];
  booked: string[];
  optOuts: string[];
};
type MockOptions = {
  // sendText throws a non-retryable "not delivered" failure when this returns true.
  undeliverable?: (t: { clientId: string; kind: string }) => boolean;
  // What startOffer returns for a client, call by call; "ok" once the list runs out.
  offerChecks?: Record<string, OfferCheck[]>;
  // Keep markBooked / notifyFrontDesk running for a while, so the workflow is
  // still wrapping up (phase already decided) when the test looks or replies.
  markBookedDelayMs?: number;
  frontDeskDelayMs?: number;
  // Extra work done inside startOffer / endOffer after the call is recorded and
  // before it returns (e.g. a delay), to land a signal or reply mid-call.
  duringStartOffer?: (clientId: string) => Promise<void>;
  duringEndOffer?: (clientId: string) => Promise<void>;
};

const slowFor = (id: string, ms: number) => async (clientId: string) => {
  if (clientId === id) await delay(ms);
};

function mockActivities(opts: MockOptions) {
  const calls: Calls = { log: [], matched: [], startOffers: [], endOffers: [], texts: [], undelivered: [], frontDesk: [], booked: [], optOuts: [] };
  const checks = new Map(Object.entries(opts.offerChecks ?? {}).map(([id, list]) => [id, [...list]]));
  const activities: typeof realActivities = {
    async findMatchingClients(opening) {
      calls.log.push("findMatchingClients");
      calls.matched.push(opening);
      return { candidates: CANDIDATES.map((c) => ({ ...c })), skippedOptedOut: [] };
    },
    async startOffer(clientId, openingId) {
      const result = checks.get(clientId)?.shift() ?? "ok";
      calls.log.push(`startOffer:${clientId}:${result}`);
      calls.startOffers.push({ clientId, openingId, result });
      await opts.duringStartOffer?.(clientId);
      return result;
    },
    async endOffer(clientId, openingId) {
      calls.log.push(`endOffer:${clientId}`);
      calls.endOffers.push({ clientId, openingId });
      await opts.duringEndOffer?.(clientId);
    },
    async sendText({ clientId, openingId, kind, body }) {
      if (opts.undeliverable?.({ clientId, kind })) {
        calls.log.push(`sendText:${clientId}:${kind}:undelivered`);
        calls.undelivered.push({ clientId, openingId, kind, body });
        throw ApplicationFailure.nonRetryable("not delivered");
      }
      calls.log.push(`sendText:${clientId}:${kind}`);
      calls.texts.push({ clientId, openingId, kind, body });
    },
    async notifyFrontDesk(note) {
      calls.log.push(`notifyFrontDesk:${note.kind}`);
      calls.frontDesk.push(note);
      if (opts.frontDeskDelayMs) await delay(opts.frontDeskDelayMs);
    },
    async markBooked(clientId) {
      calls.log.push(`markBooked:${clientId}`);
      calls.booked.push(clientId);
      if (opts.markBookedDelayMs) await delay(opts.markBookedDelayMs);
    },
    async recordOptOut(clientId) {
      calls.log.push(`recordOptOut:${clientId}`);
      calls.optOuts.push(clientId);
    },
  };
  return { calls, activities };
}

const kindsTo = (calls: Calls, clientId: string) => calls.texts.filter((t) => t.clientId === clientId).map((t) => t.kind);
const frontDeskKinds = (calls: Calls) => calls.frontDesk.map((n) => n.kind);
const clientIds = (xs: { clientId: string }[]) => xs.map((x) => x.clientId);
const before_ = (calls: Calls, a: string, b: string) => {
  const ia = calls.log.indexOf(a);
  const ib = calls.log.indexOf(b);
  assert.ok(ia >= 0 && ib >= 0 && ia < ib, `expected "${a}" before "${b}" in ${JSON.stringify(calls.log)}`);
};

// ---------------------------------------------------------------------------
// Status helpers

type Handle = WorkflowHandle<typeof fillOpeningWorkflow>;

function candidate(s: OpeningStatus, id: string): Candidate {
  const c = s.candidates.find((x) => x.id === id);
  assert.ok(c, `no candidate "${id}" in status`);
  return c;
}
const stateOf = (s: OpeningStatus, id: string) => candidate(s, id).state;
const states = (s: OpeningStatus) => s.candidates.map((c) => [c.id, c.state]);
const offeredIds = (s: OpeningStatus) => s.candidates.filter((c) => c.state === "offered").map((c) => c.id);
const attentionSummary = (s: OpeningStatus) =>
  s.attention.map(({ clientId, kind, resolved }) => ({ clientId, kind, resolved }));

// True once the offer text to `id` has gone out and their hold clock is running.
const holds = (id: string) => (s: OpeningStatus) => {
  const c = s.candidates.find((x) => x.id === id);
  return s.phase === "offering" && s.currentClientId === id && c?.state === "offered" && c.expiresAt !== undefined;
};

// Checked on every status the tests see: at most one client holds the offer,
// currentClientId is exactly that client (or unset when nobody does), and
// nothing is wrapped up early.
function assertStatusInvariants(s: OpeningStatus): void {
  const offered = offeredIds(s);
  assert.ok(offered.length <= 1, `more than one client holds the offer: ${offered.join(", ")}`);
  assert.equal(s.currentClientId, offered[0], "currentClientId should be the one client holding the offer");
  if (s.phase === "finding" || s.phase === "offering") assert.equal(s.wrappedUp, false, "wrappedUp while still offering");
}

// Waits (in real time) for something the mocks record.
async function waitUntil(cond: () => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(10);
  }
}

// Polls the query (in real time; queries do not skip time) until `done` holds.
async function waitForStatus(handle: Handle, label: string, done: (s: OpeningStatus) => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last: OpeningStatus | undefined;
  let lastError: unknown;
  for (;;) {
    let s: OpeningStatus | undefined;
    try {
      s = await handle.query(getOpeningStatus);
    } catch (err) {
      lastError = err; // e.g. queried before the first workflow task ran
    }
    if (s) {
      last = s;
      assertStatusInvariants(s);
      if (done(s)) return s;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}. Last status: ${JSON.stringify(last)}. Last query error: ${lastError}`);
    }
    await delay(25);
  }
}

const waitUntilHolding = (handle: Handle, id: string) => waitForStatus(handle, `${id} to hold the offer`, holds(id));

async function query(handle: Handle): Promise<OpeningStatus> {
  const s = await handle.query(getOpeningStatus);
  assertStatusInvariants(s);
  return s;
}

// Awaits the result (this lets the time-skipping server skip time) and checks the closing state.
async function finish(handle: Handle): Promise<OpeningStatus> {
  const final = await handle.result();
  assertStatusInvariants(final);
  assert.equal(final.wrappedUp, true, "the returned status should be wrapped up");
  assert.equal(final.currentClientId, undefined);
  return final;
}

async function reply(handle: Handle, clientId: string, text: string, by: ReplyInput["by"] = "client"): Promise<ReplyOutcome> {
  const { outcome } = await handle.executeUpdate(clientReply, { args: [{ clientId, text, by }] });
  return outcome;
}

const rejectedAsNotOffered = (err: unknown) => {
  assert.ok(err instanceof WorkflowUpdateFailedError, `expected the update to be rejected, got ${err}`);
  assert.match(String(err.cause?.message), /not been offered/);
  return true;
};

// ---------------------------------------------------------------------------
// One time-skipping test server and one workflow bundle for the whole file;
// each test gets its own Worker, task queue and workflow id.

let env: TestWorkflowEnvironment;
let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;

before(
  async () => {
    // Quiet output: SDK warnings still show; the native core only reports errors
    // (it otherwise warns about the test server's version on every Worker).
    Runtime.install({
      logger: new DefaultLogger("WARN"),
      telemetryOptions: { logging: { filter: { core: "ERROR", other: "ERROR" } } },
    });
    [env, workflowBundle] = await Promise.all([
      TestWorkflowEnvironment.createTimeSkipping(),
      bundleWorkflowCode({ workflowsPath: require.resolve("../src/workflows"), logger: new DefaultLogger("WARN"), ...bundlerOptions }),
    ]);
  },
  { timeout: 180_000 },
);

after(async () => {
  await env?.teardown();
});

type Run = { handle: Handle; calls: Calls; openingId: string; startAgain: () => Promise<unknown> };

async function runOpening(
  name: string,
  opts: MockOptions & { opening?: Partial<Opening> },
  scenario: (run: Run) => Promise<void>,
): Promise<void> {
  const id = `${name}-${randomUUID()}`;
  const { calls, activities } = mockActivities(opts);
  const input: OpeningInput = { opening: { ...OPENING, ...opts.opening, id }, policy: POLICY };
  const start = () => env.client.workflow.start(fillOpeningWorkflow, { workflowId: id, taskQueue: id, args: [input] });
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: id, workflowBundle, activities });
  await worker.runUntil(async () => {
    const handle = await start();
    try {
      await scenario({ handle, calls, openingId: id, startAgain: start });
    } catch (err) {
      // Don't leave a running workflow (and its hold timer) behind for later tests.
      await handle.terminate("test failed").catch(() => undefined);
      throw err;
    }
  });
  // Every bookkeeping call, text and note was for this opening.
  for (const x of [...calls.startOffers, ...calls.endOffers, ...calls.texts, ...calls.undelivered, ...calls.frontDesk]) {
    assert.equal(x.openingId, id);
  }
}

// ---------------------------------------------------------------------------
// Tests

test("parseReply reads simple yes / no / stop answers and flags anything else as unclear", () => {
  for (const t of ["YES", "yes please", "Y"]) assert.equal(parseReply(t), "yes", t);
  for (const t of ["no thanks", "Nope"]) assert.equal(parseReply(t), "no", t);
  assert.equal(parseReply("STOP"), "stop");
  assert.equal(parseReply("maybe later?"), "unclear");
});

test("first yes wins: ann accepts, the opening is filled once and nobody else is offered", { timeout: TEST_TIMEOUT }, () =>
  runOpening("first-yes", {}, async ({ handle, calls, openingId }) => {
    const s = await waitUntilHolding(handle, "ann");
    assert.equal(s.holdMinutes, 15);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer"]);
    const offer = calls.texts[0];
    assert.match(offer.body, /^Hi Ann,/);
    assert.match(offer.body, /Haircut with Ana on Sat 10 Oct at 2:00 pm/);
    assert.match(offer.body, /15 minutes/);

    // bob has not been offered the slot, so he cannot claim it.
    await assert.rejects(reply(handle, "bob", "yes"), rejectedAsNotOffered);

    assert.equal(await reply(handle, "ann", "yes"), "accepted");
    const final = await finish(handle);

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "ann");
    assert.deepEqual(states(final), [["ann", "booked"], ["bob", "in_line"], ["cat", "in_line"]]);
    assert.deepEqual(calls.matched.map((o) => o.id), [openingId]);
    assert.deepEqual(calls.booked, ["ann"]);
    assert.deepEqual(clientIds(calls.startOffers), ["ann"]);
    assert.deepEqual(clientIds(calls.endOffers), ["ann"]);
    before_(calls, "startOffer:ann:ok", "sendText:ann:offer");
    before_(calls, "markBooked:ann", "endOffer:ann");
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "confirmed"]);
    assert.deepEqual(kindsTo(calls, "bob"), []);
    assert.deepEqual(kindsTo(calls, "cat"), []);
    assert.deepEqual(frontDeskKinds(calls), ["filled"]);
    assert.deepEqual(calls.optOuts, []);
  }),
);

test("no reply moves the offer on after 15 minutes; ann's late yes is turned away and bob gets it", { timeout: TEST_TIMEOUT }, () =>
  runOpening("late-yes", {}, async ({ handle, calls }) => {
    await waitUntilHolding(handle, "ann");

    await env.sleep("14 minutes");
    let s = await query(handle);
    assert.ok(holds("ann")(s), "ann should still hold the offer after 14 minutes");
    assert.deepEqual(kindsTo(calls, "bob"), []);
    assert.deepEqual(clientIds(calls.endOffers), []);

    await env.sleep("2 minutes"); // 16 minutes in total
    s = await waitUntilHolding(handle, "bob");
    assert.equal(stateOf(s, "ann"), "timed_out");
    assert.deepEqual(offeredIds(s), ["bob"]);
    before_(calls, "endOffer:ann", "startOffer:bob:ok");

    assert.equal(await reply(handle, "ann", "yes"), "too_late");
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "too_late"]);
    s = await query(handle);
    assert.equal(s.currentClientId, "bob");
    assert.equal(stateOf(s, "ann"), "timed_out");

    assert.equal(await reply(handle, "bob", "YES"), "accepted");
    const final = await finish(handle);

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "bob");
    assert.deepEqual(states(final), [["ann", "timed_out"], ["bob", "booked"], ["cat", "in_line"]]);
    assert.deepEqual(calls.booked, ["bob"]);
    assert.deepEqual(clientIds(calls.endOffers), ["ann", "bob"]);
    // ann already heard it's gone (one too_late text), so she gets no separate "filled" text.
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "too_late"]);
    assert.deepEqual(kindsTo(calls, "bob"), ["offer", "confirmed"]);
    assert.deepEqual(kindsTo(calls, "cat"), []);
    assert.deepEqual(frontDeskKinds(calls), ["filled"]);
  }),
);

test("a timed-out client who never replied late is told once the opening is filled", { timeout: TEST_TIMEOUT }, () =>
  runOpening("timed-out-told", {}, async ({ handle, calls }) => {
    await waitUntilHolding(handle, "ann");
    await env.sleep("16 minutes");
    await waitUntilHolding(handle, "bob");

    assert.equal(await reply(handle, "bob", "yes"), "accepted");
    const final = await finish(handle);

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "bob");
    assert.equal(stateOf(final, "ann"), "timed_out");
    assert.deepEqual(clientIds(calls.endOffers), ["ann", "bob"]);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "filled"]);
    assert.deepEqual(kindsTo(calls, "bob"), ["offer", "confirmed"]);
    assert.deepEqual(kindsTo(calls, "cat"), []);
  }),
);

test("everyone passes: ann declines, bob times out, cat declines, so the opening is unfilled", { timeout: TEST_TIMEOUT }, () =>
  runOpening("unfilled", {}, async ({ handle, calls }) => {
    let s = await waitUntilHolding(handle, "ann");
    assert.deepEqual(offeredIds(s), ["ann"]);

    assert.equal(await reply(handle, "ann", "no"), "declined");
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "declined"]);

    s = await waitUntilHolding(handle, "bob");
    assert.deepEqual(offeredIds(s), ["bob"]);
    assert.equal(stateOf(s, "ann"), "declined");
    assert.equal(stateOf(s, "cat"), "in_line");

    await env.sleep("16 minutes");
    s = await waitUntilHolding(handle, "cat");
    assert.deepEqual(offeredIds(s), ["cat"]);
    assert.equal(stateOf(s, "bob"), "timed_out");

    assert.equal(await reply(handle, "cat", "no"), "declined");
    const final = await finish(handle);

    assert.equal(final.phase, "unfilled");
    assert.equal(final.bookedClientId, undefined);
    assert.equal(final.endReason, undefined);
    assert.deepEqual(states(final), [["ann", "declined"], ["bob", "timed_out"], ["cat", "declined"]]);
    assert.deepEqual(frontDeskKinds(calls), ["unfilled"]);
    assert.deepEqual(calls.booked, []);
    assert.deepEqual(clientIds(calls.startOffers), ["ann", "bob", "cat"]);
    assert.deepEqual(clientIds(calls.endOffers), ["ann", "bob", "cat"]);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "declined"]);
    assert.deepEqual(kindsTo(calls, "bob"), ["offer"]);
    assert.deepEqual(kindsTo(calls, "cat"), ["offer", "declined"]);
  }),
);

test("staff cancel while ann holds the offer withdraws it and nobody else is offered", { timeout: TEST_TIMEOUT }, () =>
  runOpening("cancel", {}, async ({ handle, calls }) => {
    await waitUntilHolding(handle, "ann");
    await handle.signal(cancelOpening, "stylist unavailable");
    const final = await finish(handle);

    assert.equal(final.phase, "cancelled");
    assert.equal(final.cancelReason, "stylist unavailable");
    assert.equal(final.bookedClientId, undefined);
    assert.deepEqual(states(final), [["ann", "withdrawn"], ["bob", "in_line"], ["cat", "in_line"]]);
    assert.deepEqual(clientIds(calls.startOffers), ["ann"]);
    assert.deepEqual(clientIds(calls.endOffers), ["ann"]);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "withdrawn"]);
    assert.deepEqual(kindsTo(calls, "bob"), []);
    assert.deepEqual(kindsTo(calls, "cat"), []);
    assert.deepEqual(frontDeskKinds(calls), ["cancelled"]);
    assert.deepEqual(calls.booked, []);
  }),
);

test("a text that is not delivered marks ann unreachable, flags staff, and offers bob next", { timeout: TEST_TIMEOUT }, () =>
  runOpening("not-delivered", { undeliverable: (t) => t.clientId === "ann" }, async ({ handle, calls }) => {
    const s = await waitUntilHolding(handle, "bob");
    assert.equal(stateOf(s, "ann"), "unreachable");
    // Non-retryable failure: exactly one attempt, then the offer moves on.
    assert.deepEqual(calls.undelivered.map((t) => [t.clientId, t.kind]), [["ann", "offer"]]);
    assert.deepEqual(kindsTo(calls, "ann"), []);
    assert.deepEqual(kindsTo(calls, "bob"), ["offer"]);
    assert.deepEqual(attentionSummary(s), [{ clientId: "ann", kind: "not_delivered", resolved: false }]);
    assert.deepEqual(frontDeskKinds(calls), ["attention"]);
    assert.deepEqual(clientIds(calls.endOffers), ["ann"]);

    // ann never received the offer, so a reply from her is refused.
    await assert.rejects(reply(handle, "ann", "yes"), rejectedAsNotOffered);

    assert.equal(await reply(handle, "bob", "yes"), "accepted");
    const final = await finish(handle);

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "bob");
    assert.equal(stateOf(final, "ann"), "unreachable");
    assert.deepEqual(attentionSummary(final), [{ clientId: "ann", kind: "not_delivered", resolved: false }]);
    assert.deepEqual(frontDeskKinds(calls), ["attention", "filled"]);
    assert.deepEqual(calls.booked, ["bob"]);
    assert.deepEqual(clientIds(calls.endOffers), ["ann", "bob"]);
    assert.equal(calls.undelivered.length, 1);
    assert.deepEqual(kindsTo(calls, "bob"), ["offer", "confirmed"]);
  }),
);

test("an unclear reply asks again and flags staff; staff can then enter ann's YES", { timeout: TEST_TIMEOUT }, () =>
  runOpening("unclear", {}, async ({ handle, calls }) => {
    await waitUntilHolding(handle, "ann");

    assert.equal(await reply(handle, "ann", "maybe later?"), "unclear");
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "unclear"]);
    const s = await query(handle);
    assert.equal(s.currentClientId, "ann");
    assert.ok(holds("ann")(s), "ann should still hold the offer");
    assert.deepEqual(attentionSummary(s), [{ clientId: "ann", kind: "unclear_reply", resolved: false }]);

    assert.equal(await reply(handle, "ann", "YES", "staff"), "accepted");
    const final = await finish(handle);

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "ann");
    assert.equal(stateOf(final, "ann"), "booked");
    assert.deepEqual(attentionSummary(final), [{ clientId: "ann", kind: "unclear_reply", resolved: true }]);
    assert.ok(final.history.some((h) => h.text.includes("(entered by staff)")));
    assert.deepEqual(calls.booked, ["ann"]);
    assert.deepEqual(clientIds(calls.endOffers), ["ann"]);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "unclear", "confirmed"]);
    assert.deepEqual(kindsTo(calls, "bob"), []);
    assert.deepEqual(frontDeskKinds(calls), ["filled"]);
  }),
);

test("STOP opts ann out and moves the offer to bob", { timeout: TEST_TIMEOUT }, () =>
  runOpening("stop", {}, async ({ handle, calls }) => {
    await waitUntilHolding(handle, "ann");

    assert.equal(await reply(handle, "ann", "STOP"), "opted_out");
    assert.deepEqual(calls.optOuts, ["ann"]);

    const s = await waitUntilHolding(handle, "bob");
    assert.equal(stateOf(s, "ann"), "opted_out");
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "opted_out"]);

    assert.equal(await reply(handle, "bob", "yes"), "accepted");
    const final = await finish(handle);

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "bob");
    assert.equal(stateOf(final, "ann"), "opted_out");
    assert.equal(stateOf(final, "bob"), "booked");
    assert.deepEqual(calls.optOuts, ["ann"]);
    assert.deepEqual(calls.booked, ["bob"]);
    assert.deepEqual(clientIds(calls.endOffers), ["ann", "bob"]);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "opted_out"]);
    assert.deepEqual(kindsTo(calls, "bob"), ["offer", "confirmed"]);
  }),
);

// Regression: a reply from the client who already booked, arriving while the
// workflow is still recording the booking (slow markBooked).
const waitUntilWrappingUp = (handle: Handle, calls: Calls) =>
  waitForStatus(handle, "the opening to be filled with markBooked still running", (s) => s.phase === "filled" && calls.booked.length > 0);

test("regression: a second YES from ann while her booking is being recorded gets already_booked, not too_late", { timeout: TEST_TIMEOUT }, () =>
  runOpening("double-yes", { markBookedDelayMs: 1_000 }, async ({ handle, calls }) => {
    await waitUntilHolding(handle, "ann");
    assert.equal(await reply(handle, "ann", "yes"), "accepted");
    const s = await waitUntilWrappingUp(handle, calls);
    assert.equal(s.bookedClientId, "ann");
    assert.equal(s.wrappedUp, false);

    assert.equal(await reply(handle, "ann", "YES"), "already_booked");
    const final = await finish(handle);

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "ann");
    assert.equal(stateOf(final, "ann"), "booked");
    assert.deepEqual(calls.booked, ["ann"]);
    assert.deepEqual(clientIds(calls.endOffers), ["ann"]);
    assert.ok(!kindsTo(calls, "ann").includes("too_late"), "ann must not be told the opening is gone");
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "already_booked", "confirmed"]);
    assert.match(calls.texts.find((t) => t.kind === "already_booked")!.body, /^You're already booked:/);
    assert.deepEqual(kindsTo(calls, "bob"), []);
    assert.deepEqual(frontDeskKinds(calls), ["filled"]);
  }),
);

test("regression: STOP from ann after she booked records the opt-out but keeps her booking", { timeout: TEST_TIMEOUT }, () =>
  runOpening("booked-stop", { markBookedDelayMs: 1_000 }, async ({ handle, calls }) => {
    await waitUntilHolding(handle, "ann");
    assert.equal(await reply(handle, "ann", "yes"), "accepted");
    await waitUntilWrappingUp(handle, calls);

    assert.equal(await reply(handle, "ann", "STOP"), "opted_out");
    assert.deepEqual(calls.optOuts, ["ann"]);
    const s = await query(handle);
    assert.equal(stateOf(s, "ann"), "booked");
    assert.equal(s.bookedClientId, "ann");

    const final = await finish(handle);

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "ann");
    assert.equal(stateOf(final, "ann"), "booked");
    assert.deepEqual(calls.booked, ["ann"]);
    assert.deepEqual(calls.optOuts, ["ann"]);
    assert.deepEqual(clientIds(calls.endOffers), ["ann"]);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "opted_out", "confirmed"]);
    assert.deepEqual(kindsTo(calls, "bob"), []);
    assert.deepEqual(frontDeskKinds(calls), ["filled"]);
  }),
);

// --- startOffer: the waitlist can change while an opening runs -------------

test("startOffer says ann opted out and bob is already booked: both are skipped without a text and cat is offered", { timeout: TEST_TIMEOUT }, () =>
  runOpening("skip", { offerChecks: { ann: ["opted_out"], bob: ["booked"] } }, async ({ handle, calls }) => {
    const s = await waitUntilHolding(handle, "cat");
    assert.equal(stateOf(s, "ann"), "skipped");
    assert.equal(candidate(s, "ann").note, "opted out of texts");
    assert.equal(stateOf(s, "bob"), "skipped");
    assert.equal(candidate(s, "bob").note, "already booked by another opening");
    assert.deepEqual(kindsTo(calls, "ann"), []);
    assert.deepEqual(kindsTo(calls, "bob"), []);
    assert.deepEqual(kindsTo(calls, "cat"), ["offer"]);

    // Skipped clients never got this opening's offer, so their replies are refused.
    await assert.rejects(reply(handle, "ann", "yes"), rejectedAsNotOffered);
    await assert.rejects(reply(handle, "bob", "yes"), rejectedAsNotOffered);

    assert.equal(await reply(handle, "cat", "yes"), "accepted");
    const final = await finish(handle);

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "cat");
    assert.deepEqual(states(final), [["ann", "skipped"], ["bob", "skipped"], ["cat", "booked"]]);
    assert.deepEqual(calls.startOffers.map((c) => [c.clientId, c.result]), [["ann", "opted_out"], ["bob", "booked"], ["cat", "ok"]]);
    // Only cat's turn started, so only cat's ends.
    assert.deepEqual(clientIds(calls.endOffers), ["cat"]);
    assert.deepEqual(kindsTo(calls, "ann"), []);
    assert.deepEqual(kindsTo(calls, "bob"), []);
    assert.deepEqual(kindsTo(calls, "cat"), ["offer", "confirmed"]);
    assert.deepEqual(calls.booked, ["cat"]);
  }),
);

test("startOffer says ann is busy: she moves to the back of the queue, bob and cat go first, then she is offered", { timeout: TEST_TIMEOUT }, () =>
  runOpening("busy", { offerChecks: { ann: ["busy", "ok"] } }, async ({ handle, calls }) => {
    let s = await waitUntilHolding(handle, "bob");
    assert.equal(stateOf(s, "ann"), "in_line");
    assert.deepEqual(kindsTo(calls, "ann"), []);

    assert.equal(await reply(handle, "bob", "no"), "declined");
    s = await waitUntilHolding(handle, "cat");
    assert.equal(stateOf(s, "ann"), "in_line");

    assert.equal(await reply(handle, "cat", "no"), "declined");
    s = await waitUntilHolding(handle, "ann");
    assert.deepEqual(kindsTo(calls, "ann"), ["offer"]);

    assert.equal(await reply(handle, "ann", "yes"), "accepted");
    const final = await finish(handle);

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "ann");
    assert.deepEqual(states(final), [["ann", "booked"], ["bob", "declined"], ["cat", "declined"]]);
    assert.deepEqual(calls.startOffers.map((c) => [c.clientId, c.result]), [["ann", "busy"], ["bob", "ok"], ["cat", "ok"], ["ann", "ok"]]);
    assert.deepEqual(clientIds(calls.endOffers), ["bob", "cat", "ann"]);
    assert.ok(final.history.some((h) => h.text.includes("answering another opening's offer")));
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "confirmed"]);
  }),
);

test("a client still busy on the second try is skipped", { timeout: TEST_TIMEOUT }, () =>
  runOpening("busy-twice", { offerChecks: { ann: ["busy", "busy"] } }, async ({ handle, calls }) => {
    await waitUntilHolding(handle, "bob");
    assert.equal(await reply(handle, "bob", "no"), "declined");
    await waitUntilHolding(handle, "cat");
    assert.equal(await reply(handle, "cat", "no"), "declined");
    const final = await finish(handle);

    assert.equal(final.phase, "unfilled");
    assert.equal(final.endReason, undefined);
    assert.deepEqual(states(final), [["ann", "skipped"], ["bob", "declined"], ["cat", "declined"]]);
    assert.equal(candidate(final, "ann").note, "still answering another opening's offer");
    assert.deepEqual(calls.startOffers.map((c) => [c.clientId, c.result]), [["ann", "busy"], ["bob", "ok"], ["cat", "ok"], ["ann", "busy"]]);
    assert.deepEqual(clientIds(calls.endOffers), ["bob", "cat"]);
    assert.deepEqual(kindsTo(calls, "ann"), []);
    assert.deepEqual(frontDeskKinds(calls), ["unfilled"]);
  }),
);

// --- Appointment-time cutoff ---------------------------------------------------

test("cutoff: holds never run past the appointment start and nobody is offered after it", { timeout: TEST_TIMEOUT }, async () => {
  // Use the test server's own clock: earlier tests have skipped it ahead of real time.
  const startsAt = (await env.currentTimeMs()) + 20 * MINUTE;
  await runOpening("cutoff", { opening: { startsAt } }, async ({ handle, calls }) => {
    let s = await waitUntilHolding(handle, "ann");
    const ann = candidate(s, "ann");
    assert.equal(ann.expiresAt! - ann.offeredAt!, 15 * MINUTE, "ann gets the full 15-minute hold");

    await env.sleep("16 minutes");
    s = await waitUntilHolding(handle, "bob");
    assert.equal(stateOf(s, "ann"), "timed_out");
    const bob = candidate(s, "bob");
    assert.equal(bob.expiresAt, startsAt, "bob's hold ends when the appointment starts");
    assert.ok(bob.expiresAt! - bob.offeredAt! <= 5 * MINUTE, `bob's hold should be capped at 5 minutes, got ${(bob.expiresAt! - bob.offeredAt!) / MINUTE}`);

    // 6 more minutes passes the appointment start: bob's hold has run out and cat is never offered.
    await env.sleep("6 minutes");
    await waitForStatus(handle, "the opening to be unfilled", (x) => x.phase === "unfilled");
    const final = await finish(handle);

    assert.equal(final.phase, "unfilled");
    assert.equal(final.endReason, "the appointment time arrived");
    assert.deepEqual(states(final), [["ann", "timed_out"], ["bob", "timed_out"], ["cat", "in_line"]]);
    assert.deepEqual(clientIds(calls.startOffers), ["ann", "bob"]);
    assert.deepEqual(clientIds(calls.endOffers), ["ann", "bob"]);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer"]);
    assert.deepEqual(kindsTo(calls, "bob"), ["offer"]);
    assert.deepEqual(kindsTo(calls, "cat"), []);
    assert.deepEqual(frontDeskKinds(calls), ["unfilled"]);
    assert.match(calls.frontDesk[0].message, /appointment time arrived/);
    // Each offer and note states the hold that client actually got.
    assert.match(calls.texts.find((t) => t.clientId === "ann")!.body, /We'll hold it for you for 15 minutes\./);
    assert.match(calls.texts.find((t) => t.clientId === "bob")!.body, /We'll hold it for you for 5 minutes\./);
    assert.ok(final.history.some((h) => h.text === "Ann Archer didn't reply within 15 minutes; moving on"));
    assert.ok(final.history.some((h) => h.text === "Bob Brooks didn't reply within 5 minutes; moving on"));
  });
});

// --- Texts after a decision never fail the opening ----------------------------

test("a confirmation text that can't be delivered flags staff, but the opening is still filled", { timeout: TEST_TIMEOUT }, () =>
  runOpening("confirm-undelivered", { undeliverable: (t) => t.kind === "confirmed" }, async ({ handle, calls }) => {
    await waitUntilHolding(handle, "ann");
    assert.equal(await reply(handle, "ann", "yes"), "accepted");
    const final = await finish(handle);

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "ann");
    assert.equal(stateOf(final, "ann"), "booked");
    assert.deepEqual(attentionSummary(final), [{ clientId: "ann", kind: "not_delivered", resolved: false }]);
    assert.deepEqual(frontDeskKinds(calls), ["attention", "filled"]);
    assert.deepEqual(calls.undelivered.map((t) => [t.clientId, t.kind]), [["ann", "confirmed"]]);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer"]);
    assert.deepEqual(calls.booked, ["ann"]);
    assert.deepEqual(clientIds(calls.endOffers), ["ann"]);
  }),
);

// --- wrappedUp -------------------------------------------------------------------

test("wrappedUp stays false until the closing texts and front desk note are done", { timeout: TEST_TIMEOUT }, () =>
  runOpening("wrapped-up", { frontDeskDelayMs: 1_000 }, async ({ handle, calls }) => {
    let s = await waitUntilHolding(handle, "ann");
    assert.equal(s.wrappedUp, false);

    assert.equal(await reply(handle, "ann", "yes"), "accepted");
    // The "filled" front desk note is still being written.
    s = await waitForStatus(handle, "the filled note to be in progress", (x) => x.phase === "filled" && calls.frontDesk.length > 0);
    assert.equal(s.wrappedUp, false);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "confirmed"]);

    const final = await finish(handle);
    assert.equal(final.wrappedUp, true);
    assert.deepEqual(frontDeskKinds(calls), ["filled"]);
  }),
);

// --- Unclear replies settle themselves when the turn ends -----------------------

test("an unresolved unclear reply is resolved automatically when that client's turn ends", { timeout: TEST_TIMEOUT }, () =>
  runOpening("unclear-auto", {}, async ({ handle, calls }) => {
    await waitUntilHolding(handle, "ann");
    assert.equal(await reply(handle, "ann", "maybe later?"), "unclear");
    let s = await query(handle);
    assert.deepEqual(attentionSummary(s), [{ clientId: "ann", kind: "unclear_reply", resolved: false }]);

    // ann's time runs out without a clear answer.
    await env.sleep("16 minutes");
    s = await waitUntilHolding(handle, "bob");
    assert.equal(stateOf(s, "ann"), "timed_out");
    assert.deepEqual(attentionSummary(s), [{ clientId: "ann", kind: "unclear_reply", resolved: true }]);

    // bob is unclear, then declines.
    assert.equal(await reply(handle, "bob", "what time?"), "unclear");
    s = await query(handle);
    assert.deepEqual(attentionSummary(s), [
      { clientId: "ann", kind: "unclear_reply", resolved: true },
      { clientId: "bob", kind: "unclear_reply", resolved: false },
    ]);
    assert.equal(await reply(handle, "bob", "no"), "declined");
    s = await waitUntilHolding(handle, "cat");
    assert.equal(stateOf(s, "bob"), "declined");
    assert.deepEqual(attentionSummary(s), [
      { clientId: "ann", kind: "unclear_reply", resolved: true },
      { clientId: "bob", kind: "unclear_reply", resolved: true },
    ]);

    assert.equal(await reply(handle, "cat", "yes"), "accepted");
    const final = await finish(handle);

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "cat");
    assert.ok(final.attention.every((a) => a.resolved));
    assert.deepEqual(clientIds(calls.endOffers), ["ann", "bob", "cat"]);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "unclear", "filled"]);
    assert.deepEqual(kindsTo(calls, "bob"), ["offer", "unclear", "declined"]);
    assert.deepEqual(kindsTo(calls, "cat"), ["offer", "confirmed"]);
  }),
);

// --- One run per slot -------------------------------------------------------------

test("starting the same opening again while it runs is refused with WorkflowExecutionAlreadyStartedError", { timeout: TEST_TIMEOUT }, () =>
  runOpening("duplicate", {}, async ({ handle, calls, startAgain }) => {
    await waitUntilHolding(handle, "ann");

    await assert.rejects(startAgain(), WorkflowExecutionAlreadyStartedError);

    // The first run carries on untouched.
    const s = await query(handle);
    assert.ok(holds("ann")(s), "ann should still hold the offer in the first run");
    assert.equal(calls.matched.length, 1);
    assert.deepEqual(clientIds(calls.startOffers), ["ann"]);

    await handle.signal(cancelOpening, "test over");
    const final = await finish(handle);
    assert.equal(final.phase, "cancelled");
    assert.equal(calls.matched.length, 1);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "withdrawn"]);
    assert.deepEqual(clientIds(calls.endOffers), ["ann"]);
  }),
);

// --- Regressions: replies and signals that land mid-activity ---------------------

test("regression: STOP while a timed-out client's offer is being closed keeps them opted out, with no 'filled' text later", { timeout: TEST_TIMEOUT }, () =>
  runOpening("stop-during-end-timeout", { duringEndOffer: slowFor("ann", 1_500) }, async ({ handle, calls }) => {
    await waitUntilHolding(handle, "ann");
    const sleeping = env.sleep("16 minutes");
    await waitUntil(() => calls.endOffers.some((c) => c.clientId === "ann"), "endOffer for ann to start");
    // Her turn is already settled while endOffer runs.
    let s = await query(handle);
    assert.equal(stateOf(s, "ann"), "timed_out");
    assert.equal(s.currentClientId, undefined);

    assert.equal(await reply(handle, "ann", "STOP"), "opted_out");
    await sleeping;
    s = await waitUntilHolding(handle, "bob");
    assert.equal(stateOf(s, "ann"), "opted_out");
    // The STOP was handled before ann's endOffer finished (bob's turn starts after it).
    before_(calls, "recordOptOut:ann", "startOffer:bob:ok");

    assert.equal(await reply(handle, "bob", "yes"), "accepted");
    const final = await finish(handle);

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "bob");
    assert.equal(stateOf(final, "ann"), "opted_out");
    assert.deepEqual(calls.optOuts, ["ann"]);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "opted_out"]); // no "filled" text after STOP
    assert.deepEqual(kindsTo(calls, "bob"), ["offer", "confirmed"]);
    assert.deepEqual(clientIds(calls.endOffers), ["ann", "bob"]);
  }),
);

test("regression: STOP while a cancelled offer is being closed means no 'withdrawn' text", { timeout: TEST_TIMEOUT }, () =>
  runOpening("stop-during-end-cancel", { duringEndOffer: slowFor("ann", 1_500) }, async ({ handle, calls }) => {
    await waitUntilHolding(handle, "ann");
    await handle.signal(cancelOpening, "stylist unavailable");
    await waitUntil(() => calls.endOffers.length > 0, "endOffer for ann to start");
    const s = await query(handle);
    assert.equal(stateOf(s, "ann"), "withdrawn");
    assert.equal(s.currentClientId, undefined);

    assert.equal(await reply(handle, "ann", "STOP"), "opted_out");
    const final = await finish(handle);

    assert.equal(final.phase, "cancelled");
    assert.equal(final.cancelReason, "stylist unavailable");
    assert.equal(stateOf(final, "ann"), "opted_out");
    assert.deepEqual(calls.optOuts, ["ann"]);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "opted_out"]); // no "withdrawn" text after STOP
    assert.deepEqual(clientIds(calls.endOffers), ["ann"]);
    assert.deepEqual(frontDeskKinds(calls), ["cancelled"]);
    // The STOP was handled before ann's endOffer finished (the cancel note follows it).
    before_(calls, "recordOptOut:ann", "notifyFrontDesk:cancelled");
  }),
);

test("regression: if the appointment starts while startOffer runs, no offer goes out and the opening ends unfilled", { timeout: TEST_TIMEOUT }, async () => {
  const startsAt = (await env.currentTimeMs()) + 2_000;
  // startOffer for ann only returns once the test server's clock is past startsAt.
  const untilPastStart = async () => {
    while ((await env.currentTimeMs()) <= startsAt) await delay(50);
  };
  await runOpening("cutoff-during-start", { opening: { startsAt }, duringStartOffer: untilPastStart }, async ({ handle, calls }) => {
    await waitForStatus(handle, "the opening to be unfilled", (x) => x.phase === "unfilled", 15_000);
    const final = await finish(handle);

    assert.equal(final.phase, "unfilled");
    assert.equal(final.endReason, "the appointment time arrived");
    assert.deepEqual(states(final), [["ann", "in_line"], ["bob", "in_line"], ["cat", "in_line"]]);
    assert.deepEqual(calls.texts, []);
    assert.deepEqual(clientIds(calls.startOffers), ["ann"]);
    assert.deepEqual(clientIds(calls.endOffers), ["ann"]); // the claim is released
    assert.deepEqual(frontDeskKinds(calls), ["unfilled"]);
    assert.match(calls.frontDesk[0].message, /appointment time arrived/);
  });
});

test("regression: a cancel that lands while startOffer runs sends no offer", { timeout: TEST_TIMEOUT }, () =>
  runOpening("cancel-during-start", { duringStartOffer: slowFor("ann", 1_000) }, async ({ handle, calls }) => {
    await waitUntil(() => calls.startOffers.length > 0, "startOffer for ann to start");
    await handle.signal(cancelOpening, "stylist unavailable");
    const final = await finish(handle);

    assert.equal(final.phase, "cancelled");
    assert.equal(final.cancelReason, "stylist unavailable");
    assert.deepEqual(states(final), [["ann", "in_line"], ["bob", "in_line"], ["cat", "in_line"]]);
    assert.deepEqual(calls.texts, []);
    assert.deepEqual(clientIds(calls.startOffers), ["ann"]);
    assert.deepEqual(clientIds(calls.endOffers), ["ann"]); // the claim is released
    assert.deepEqual(frontDeskKinds(calls), ["cancelled"]);
  }),
);

test("regression: a hold capped by the appointment start is stated as such in the offer text and notes", { timeout: TEST_TIMEOUT }, async () => {
  const startsAt = (await env.currentTimeMs()) + 5 * MINUTE;
  await runOpening("capped-label", { opening: { startsAt } }, async ({ handle, calls }) => {
    const s = await waitUntilHolding(handle, "ann");
    assert.equal(candidate(s, "ann").expiresAt, startsAt);
    const offer = calls.texts.find((t) => t.clientId === "ann" && t.kind === "offer")!;
    assert.match(offer.body, /We'll hold it for you for 5 minutes\./);
    assert.doesNotMatch(offer.body, /15 minutes/);
    assert.ok(s.history.some((h) => h.text === "Offered to Ann Archer; holding for 5 minutes"));

    await env.sleep("6 minutes");
    await waitForStatus(handle, "the opening to be unfilled", (x) => x.phase === "unfilled");
    const final = await finish(handle);

    assert.equal(stateOf(final, "ann"), "timed_out");
    assert.ok(final.history.some((h) => h.text === "Ann Archer didn't reply within 5 minutes; moving on"));
    assert.equal(final.endReason, "the appointment time arrived");
    assert.deepEqual(kindsTo(calls, "bob"), []);
    assert.deepEqual(clientIds(calls.endOffers), ["ann"]);
  });
});
