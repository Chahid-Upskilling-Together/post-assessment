import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WorkflowUpdateFailedError, type WorkflowHandle } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import type * as realActivities from "../src/activities";
import type { Candidate, FrontDeskNote, MatchResult, Opening, OpeningStatus, Policy, ReplyInput, ReplyOutcome } from "../src/types";
import { cancelOpening, clientReply, fillOpeningWorkflow, getOpeningStatus, parseReply } from "../src/workflows";

// ---------------------------------------------------------------------------
// Fixtures

const POLICY: Policy = { sameDayHoldMinutes: 15, laterHoldMinutes: 60, minuteMs: 60_000 };
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

type SentText = { clientId: string; kind: string; body: string };
type Calls = {
  matched: Opening[];
  texts: SentText[]; // delivered
  undelivered: SentText[]; // refused by the mock
  frontDesk: Omit<FrontDeskNote, "id" | "at">[];
  booked: string[];
  optOuts: string[];
};
type MockOptions = {
  undeliverableTo?: string[];
  // Keeps markBooked running for a while, so the workflow is still wrapping up
  // (phase already "filled") when a later reply arrives.
  markBookedDelayMs?: number;
};

function mockActivities(opts: MockOptions) {
  const calls: Calls = { matched: [], texts: [], undelivered: [], frontDesk: [], booked: [], optOuts: [] };
  const activities: typeof realActivities = {
    async findMatchingClients(opening) {
      calls.matched.push(opening);
      return { candidates: CANDIDATES.map((c) => ({ ...c })), skippedOptedOut: [] };
    },
    async sendText({ clientId, kind, body }) {
      if (opts.undeliverableTo?.includes(clientId)) {
        calls.undelivered.push({ clientId, kind, body });
        throw ApplicationFailure.nonRetryable("not delivered");
      }
      calls.texts.push({ clientId, kind, body });
    },
    async notifyFrontDesk(note) {
      calls.frontDesk.push(note);
    },
    async markBooked(clientId) {
      calls.booked.push(clientId);
      if (opts.markBookedDelayMs) await delay(opts.markBookedDelayMs);
    },
    async recordOptOut(clientId) {
      calls.optOuts.push(clientId);
    },
  };
  return { calls, activities };
}

const kindsTo = (calls: Calls, clientId: string) => calls.texts.filter((t) => t.clientId === clientId).map((t) => t.kind);
const frontDeskKinds = (calls: Calls) => calls.frontDesk.map((n) => n.kind);

// ---------------------------------------------------------------------------
// Status helpers

type Handle = WorkflowHandle<typeof fillOpeningWorkflow>;

function candidate(s: OpeningStatus, id: string): Candidate {
  const c = s.candidates.find((x) => x.id === id);
  assert.ok(c, `no candidate "${id}" in status`);
  return c;
}
const stateOf = (s: OpeningStatus, id: string) => candidate(s, id).state;
const offeredIds = (s: OpeningStatus) => s.candidates.filter((c) => c.state === "offered").map((c) => c.id);
const attentionSummary = (s: OpeningStatus) =>
  s.attention.map(({ clientId, kind, resolved }) => ({ clientId, kind, resolved }));

// True once the offer text to `id` has gone out and their hold clock is running.
const holds = (id: string) => (s: OpeningStatus) => {
  const c = s.candidates.find((x) => x.id === id);
  return s.phase === "offering" && s.currentClientId === id && c?.state === "offered" && c.expiresAt !== undefined;
};

// Checked on every status the tests see: at most one client holds the offer,
// and currentClientId names exactly that client.
function assertOneOfferAtATime(s: OpeningStatus): void {
  const offered = offeredIds(s);
  assert.ok(offered.length <= 1, `more than one client holds the offer: ${offered.join(", ")}`);
  assert.equal(s.currentClientId, offered[0], "currentClientId should be the one client holding the offer");
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
      assertOneOfferAtATime(s);
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
  assertOneOfferAtATime(s);
  return s;
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
      bundleWorkflowCode({ workflowsPath: require.resolve("../src/workflows"), logger: new DefaultLogger("WARN") }),
    ]);
  },
  { timeout: 180_000 },
);

after(async () => {
  await env?.teardown();
});

type Run = { handle: Handle; calls: Calls; openingId: string };

async function runOpening(name: string, opts: MockOptions, scenario: (run: Run) => Promise<void>): Promise<void> {
  const id = `${name}-${randomUUID()}`;
  const { calls, activities } = mockActivities(opts);
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: id, workflowBundle, activities });
  await worker.runUntil(async () => {
    const handle = await env.client.workflow.start(fillOpeningWorkflow, {
      workflowId: id,
      taskQueue: id,
      args: [{ opening: { ...OPENING, id }, policy: POLICY }],
    });
    try {
      await scenario({ handle, calls, openingId: id });
    } catch (err) {
      // Don't leave a running workflow (and its hold timer) behind for later tests.
      await handle.terminate("test failed").catch(() => undefined);
      throw err;
    }
  });
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
    const final = await handle.result();

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "ann");
    assert.equal(final.currentClientId, undefined);
    assert.deepEqual(
      final.candidates.map((c) => [c.id, c.state]),
      [["ann", "booked"], ["bob", "in_line"], ["cat", "in_line"]],
    );
    assert.deepEqual(calls.matched.map((o) => o.id), [openingId]);
    assert.deepEqual(calls.booked, ["ann"]);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "confirmed"]);
    assert.deepEqual(kindsTo(calls, "bob"), []);
    assert.deepEqual(kindsTo(calls, "cat"), []);
    assert.deepEqual(frontDeskKinds(calls), ["filled"]);
    assert.ok(calls.frontDesk.every((n) => n.openingId === openingId));
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

    await env.sleep("2 minutes"); // 16 minutes in total
    s = await waitUntilHolding(handle, "bob");
    assert.equal(stateOf(s, "ann"), "timed_out");
    assert.deepEqual(offeredIds(s), ["bob"]);

    assert.equal(await reply(handle, "ann", "yes"), "too_late");
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "too_late"]);
    s = await query(handle);
    assert.equal(s.currentClientId, "bob");
    assert.equal(stateOf(s, "ann"), "timed_out");

    assert.equal(await reply(handle, "bob", "YES"), "accepted");
    const final = await handle.result();

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "bob");
    assert.equal(stateOf(final, "ann"), "timed_out");
    assert.equal(stateOf(final, "bob"), "booked");
    assert.equal(stateOf(final, "cat"), "in_line");
    assert.deepEqual(calls.booked, ["bob"]);
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
    const final = await handle.result();

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "bob");
    assert.equal(stateOf(final, "ann"), "timed_out");
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
    const final = await handle.result();

    assert.equal(final.phase, "unfilled");
    assert.equal(final.currentClientId, undefined);
    assert.equal(final.bookedClientId, undefined);
    assert.deepEqual(
      final.candidates.map((c) => [c.id, c.state]),
      [["ann", "declined"], ["bob", "timed_out"], ["cat", "declined"]],
    );
    assert.deepEqual(frontDeskKinds(calls), ["unfilled"]);
    assert.deepEqual(calls.booked, []);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "declined"]);
    assert.deepEqual(kindsTo(calls, "bob"), ["offer"]);
    assert.deepEqual(kindsTo(calls, "cat"), ["offer", "declined"]);
  }),
);

test("staff cancel while ann holds the offer withdraws it and nobody else is offered", { timeout: TEST_TIMEOUT }, () =>
  runOpening("cancel", {}, async ({ handle, calls }) => {
    await waitUntilHolding(handle, "ann");
    await handle.signal(cancelOpening, "stylist unavailable");
    const final = await handle.result();

    assert.equal(final.phase, "cancelled");
    assert.equal(final.cancelReason, "stylist unavailable");
    assert.equal(final.currentClientId, undefined);
    assert.equal(final.bookedClientId, undefined);
    assert.deepEqual(
      final.candidates.map((c) => [c.id, c.state]),
      [["ann", "withdrawn"], ["bob", "in_line"], ["cat", "in_line"]],
    );
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "withdrawn"]);
    assert.deepEqual(kindsTo(calls, "bob"), []);
    assert.deepEqual(kindsTo(calls, "cat"), []);
    assert.deepEqual(frontDeskKinds(calls), ["cancelled"]);
    assert.deepEqual(calls.booked, []);
  }),
);

test("a text that is not delivered marks ann unreachable, flags staff, and offers bob next", { timeout: TEST_TIMEOUT }, () =>
  runOpening("not-delivered", { undeliverableTo: ["ann"] }, async ({ handle, calls }) => {
    const s = await waitUntilHolding(handle, "bob");
    assert.equal(stateOf(s, "ann"), "unreachable");
    // Non-retryable failure: exactly one attempt, then the offer moves on.
    assert.deepEqual(calls.undelivered.map((t) => [t.clientId, t.kind]), [["ann", "offer"]]);
    assert.deepEqual(kindsTo(calls, "ann"), []);
    assert.deepEqual(kindsTo(calls, "bob"), ["offer"]);
    assert.deepEqual(attentionSummary(s), [{ clientId: "ann", kind: "not_delivered", resolved: false }]);
    assert.deepEqual(frontDeskKinds(calls), ["attention"]);

    assert.equal(await reply(handle, "bob", "yes"), "accepted");
    const final = await handle.result();

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "bob");
    assert.equal(stateOf(final, "ann"), "unreachable");
    assert.deepEqual(attentionSummary(final), [{ clientId: "ann", kind: "not_delivered", resolved: false }]);
    assert.deepEqual(frontDeskKinds(calls), ["attention", "filled"]);
    assert.deepEqual(calls.booked, ["bob"]);
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
    const final = await handle.result();

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "ann");
    assert.equal(stateOf(final, "ann"), "booked");
    assert.deepEqual(attentionSummary(final), [{ clientId: "ann", kind: "unclear_reply", resolved: true }]);
    assert.ok(final.history.some((h) => h.text.includes("(entered by staff)")));
    assert.deepEqual(calls.booked, ["ann"]);
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
    const final = await handle.result();

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "bob");
    assert.equal(stateOf(final, "ann"), "opted_out");
    assert.equal(stateOf(final, "bob"), "booked");
    assert.deepEqual(calls.optOuts, ["ann"]);
    assert.deepEqual(calls.booked, ["bob"]);
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

    assert.equal(await reply(handle, "ann", "YES"), "already_booked");
    const final = await handle.result();

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "ann");
    assert.equal(stateOf(final, "ann"), "booked");
    assert.deepEqual(calls.booked, ["ann"]);
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

    const final = await handle.result();

    assert.equal(final.phase, "filled");
    assert.equal(final.bookedClientId, "ann");
    assert.equal(stateOf(final, "ann"), "booked");
    assert.deepEqual(calls.booked, ["ann"]);
    assert.deepEqual(calls.optOuts, ["ann"]);
    assert.deepEqual(kindsTo(calls, "ann"), ["offer", "opted_out", "confirmed"]);
    assert.deepEqual(kindsTo(calls, "bob"), []);
    assert.deepEqual(frontDeskKinds(calls), ["filled"]);
  }),
);
