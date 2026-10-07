import {
  allHandlersFinished,
  condition,
  defineQuery,
  defineSignal,
  defineUpdate,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import type { Candidate, OpeningInput, OpeningStatus, ReplyInput, ReplyResult } from "./types";

// Bookkeeping steps: retry until they work.
const { findMatchingClients, notifyFrontDesk, markBooked, recordOptOut, startOffer, endOffer } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: "10 seconds",
    retry: { initialInterval: "1 second", maximumInterval: "10 seconds" },
  });

// Texts: a few quick retries, then give up so the opening can move on and
// staff can be told ("a message not reaching someone").
const { sendText } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumAttempts: 3 },
});

export const getOpeningStatus = defineQuery<OpeningStatus>("getOpeningStatus");
export const clientReply = defineUpdate<ReplyResult, [ReplyInput]>("clientReply");
export const cancelOpening = defineSignal<[string]>("cancelOpening");

export type ReplyIntent = "yes" | "no" | "stop" | "unclear";

export function parseReply(text: string): ReplyIntent {
  const t = text.trim().toLowerCase().replace(/[.!\s]+$/g, "");
  if (/^(y|yes|yes please|yep|yeah|yup|sure|i'll take it)$/.test(t)) return "yes";
  if (/^(n|no|no thanks|no thank you|nope|can't|cannot|pass)$/.test(t)) return "no";
  if (/^(stop|unsubscribe|opt out)$/.test(t)) return "stop";
  return "unclear";
}

const firstName = (name: string) => name.split(" ")[0];

const SKIP_REASON = {
  opted_out: "opted out of texts",
  booked: "already booked by another opening",
  busy: "still answering another opening's offer",
} as const;

// One run of this Workflow fills one opening: it offers the slot to one
// matching client at a time, in waitlist order, and waits durably for a reply.
// The API starts it with an ID made from the stylist and time, so the same
// slot can't be offered by two runs at once.
export async function fillOpeningWorkflow({ opening, policy }: OpeningInput): Promise<OpeningStatus> {
  const holdMinutes = opening.sameDay ? policy.sameDayHoldMinutes : policy.laterHoldMinutes;
  const holdMs = holdMinutes * policy.minuteMs;
  const what = `${opening.service} with ${opening.stylist} ${opening.when}`;
  const status: OpeningStatus = {
    opening,
    phase: "finding",
    holdMinutes,
    candidates: [],
    skippedOptedOut: [],
    wrappedUp: false,
    attention: [],
    history: [],
  };
  const decisions = new Map<string, "yes" | "no">();
  const contacted = new Set<string>();
  const toldUnavailable = new Set<string>();
  let cancelReason: string | undefined;

  const note = (text: string) => status.history.push({ at: Date.now(), text });
  const text = (c: Candidate, kind: string, body: string) =>
    sendText({ clientId: c.id, openingId: opening.id, kind, body });
  const resolveAttention = (clientId: string, kind?: string) =>
    status.attention
      .filter((a) => a.clientId === clientId && (!kind || a.kind === kind))
      .forEach((a) => (a.resolved = true));

  // For texts after a decision (confirmations, replies, updates): if one still
  // fails after its retries, staff are told instead of the whole opening failing.
  async function tryText(c: Candidate, kind: string, body: string): Promise<void> {
    try {
      await text(c, kind, body);
    } catch {
      status.attention.push({
        at: Date.now(),
        clientId: c.id,
        kind: "not_delivered",
        message: `Couldn't send ${c.name} the "${kind.replace("_", " ")}" text at ${c.mobile}. Please call them.`,
        resolved: false,
      });
      note(`The "${kind}" text to ${c.name} was not delivered after 3 tries`);
      await notifyFrontDesk({ openingId: opening.id, kind: "attention", message: `Couldn't text ${c.name} (${c.mobile}) about the ${what}. Please call them.` });
    }
  }

  setHandler(getOpeningStatus, () => status);

  setHandler(cancelOpening, (reason) => {
    cancelReason = reason || "cancelled by staff";
  });

  setHandler(
    clientReply,
    async ({ clientId, text: reply, by }) => {
      const c = status.candidates.find((x) => x.id === clientId)!;
      const intent = parseReply(reply);
      const theirTurn = status.phase === "offering" && status.currentClientId === clientId && !cancelReason;
      const alreadyBooked = c.state === "booked" || decisions.get(clientId) === "yes";
      note(`${c.name} replied "${reply}"${by === "staff" ? " (entered by staff)" : ""}`);

      if (intent === "stop") {
        resolveAttention(clientId, "unclear_reply");
        // STOP ends future texts; it never undoes a booking already made.
        if (theirTurn && !alreadyBooked) decisions.set(clientId, "no");
        if (!alreadyBooked) c.state = "opted_out";
        await recordOptOut(clientId);
        await tryText(c, "opted_out", "You won't get any more opening texts from Juniper Salon. Call us any time if you change your mind.");
        return { outcome: "opted_out" };
      }
      if (alreadyBooked) {
        await tryText(c, "already_booked", `You're already booked: ${what}. See you then!`);
        return { outcome: "already_booked" };
      }
      if (!theirTurn) {
        toldUnavailable.add(clientId);
        await tryText(c, "too_late", `Sorry, the ${what} is no longer available. You're still on our waitlist for the next opening.`);
        return { outcome: "too_late" };
      }
      if (intent === "yes") {
        resolveAttention(clientId, "unclear_reply");
        decisions.set(clientId, "yes");
        return { outcome: "accepted" };
      }
      if (intent === "no") {
        resolveAttention(clientId, "unclear_reply");
        decisions.set(clientId, "no");
        await tryText(c, "declined", "No problem, thanks for letting us know. You're still on our waitlist.");
        return { outcome: "declined" };
      }
      status.attention.push({
        at: Date.now(),
        clientId,
        kind: "unclear_reply",
        message: `Unclear reply from ${c.name}: "${reply}". They were asked to answer YES or NO; you can also mark it yourself while their time runs.`,
        resolved: false,
      });
      await tryText(c, "unclear", "Sorry, we didn't catch that. Reply YES to take the appointment or NO to pass.");
      return { outcome: "unclear" };
    },
    {
      validator: ({ clientId, text: reply }) => {
        if (!contacted.has(clientId)) throw new Error("This client has not been offered this opening.");
        if (!reply?.trim()) throw new Error("Empty reply.");
      },
    },
  );

  const found = await findMatchingClients(opening);
  status.candidates = found.candidates.map((c) => ({ ...c, state: "in_line" }));
  status.skippedOptedOut = found.skippedOptedOut;
  note(
    `Found ${found.candidates.length} matching client(s) in waitlist order` +
      (found.skippedOptedOut.length ? `; not texting ${found.skippedOptedOut.join(", ")} (opted out)` : ""),
  );
  status.phase = "offering";

  const queue = [...status.candidates];
  const deferred = new Set<string>();
  let booked: Candidate | undefined;
  while (queue.length > 0 && !cancelReason) {
    const c = queue.shift()!;
    if (c.state !== "in_line") continue;
    if (opening.startsAt !== undefined && Date.now() >= opening.startsAt) {
      status.endReason = "the appointment time arrived";
      break;
    }

    // The waitlist may have changed since this opening started.
    const check = await startOffer(c.id, opening.id);
    if (check === "busy" && !deferred.has(c.id)) {
      deferred.add(c.id);
      queue.push(c);
      note(`${c.name} is answering another opening's offer; trying the next person first`);
      continue;
    }
    if (check !== "ok") {
      c.state = "skipped";
      c.note = SKIP_REASON[check];
      note(`Skipped ${c.name}: ${c.note}`);
      continue;
    }

    status.currentClientId = c.id;
    c.state = "offered";
    try {
      await text(
        c,
        "offer",
        `Hi ${firstName(c.name)}, it's Juniper Salon. A spot just opened: ${what}. Reply YES to take it or NO to pass. We'll hold it for you for ${holdMinutes} minutes.`,
      );
    } catch {
      c.state = "unreachable";
      status.currentClientId = undefined;
      status.attention.push({
        at: Date.now(),
        clientId: c.id,
        kind: "not_delivered",
        message: `Couldn't text ${c.name} at ${c.mobile} after 3 tries, so the offer moved to the next person. Please check the number.`,
        resolved: false,
      });
      note(`Text to ${c.name} was not delivered after 3 tries; moved on`);
      await endOffer(c.id, opening.id);
      await notifyFrontDesk({ openingId: opening.id, kind: "attention", message: `Couldn't reach ${c.name} (${c.mobile}) about the ${what}. Moved on to the next person; please check the number.` });
      continue;
    }
    contacted.add(c.id);
    c.offeredAt = Date.now();
    // Hold for the agreed time, but never past the start of the appointment.
    const untilStart = opening.startsAt === undefined ? holdMs : Math.max(0, opening.startsAt - c.offeredAt);
    const holdFor = Math.min(holdMs, untilStart);
    c.expiresAt = c.offeredAt + holdFor;
    note(`Offered to ${c.name}; holding for ${holdMinutes} minutes`);

    // Durable wait: survives restarts. Ends on a reply, a cancel, or the hold running out.
    await condition(() => decisions.has(c.id) || cancelReason !== undefined, holdFor);
    status.currentClientId = undefined;
    const decision = decisions.get(c.id);

    if (decision === "yes") {
      c.state = "booked";
      booked = c;
      break;
    }
    await endOffer(c.id, opening.id);
    resolveAttention(c.id, "unclear_reply"); // their turn is over; nothing left to settle
    if (decision === "no") {
      // The reply handler may have marked them opted out (they texted STOP).
      if ((c.state as Candidate["state"]) !== "opted_out") c.state = "declined";
      continue;
    }
    if (cancelReason) {
      c.state = "withdrawn";
      await tryText(c, "withdrawn", `Sorry, the ${what} is no longer available, so there's nothing you need to do. You're still on our waitlist.`);
      break;
    }
    c.state = "timed_out";
    note(`${c.name} didn't reply within ${holdMinutes} minutes; moving on`);
  }

  if (booked) {
    status.phase = "filled";
    status.bookedClientId = booked.id;
    note(`${booked.name} said yes. Opening filled.`);
    await markBooked(booked.id);
    await endOffer(booked.id, opening.id);
    await tryText(booked, "confirmed", `You're booked: ${what}. See you then! If anything changes, just call the salon.`);
    await notifyFrontDesk({ openingId: opening.id, kind: "filled", message: `Filled: ${booked.name} (${booked.mobile}) took the ${what}. Please add it to Square.` });
    // Tell anyone whose offer ran out, unless they already heard it's gone.
    for (const other of status.candidates.filter((x) => x.state === "timed_out" && !toldUnavailable.has(x.id))) {
      await tryText(other, "filled", `Update from Juniper Salon: the ${what} has been filled. You're still on our waitlist for the next opening.`);
    }
  } else if (cancelReason) {
    status.phase = "cancelled";
    status.cancelReason = cancelReason;
    note(`Cancelled: ${cancelReason}`);
    await notifyFrontDesk({ openingId: opening.id, kind: "cancelled", message: `Cancelled: the ${what} (${cancelReason}).` });
  } else {
    status.phase = "unfilled";
    const matched = status.candidates.length;
    const message = status.endReason
      ? `Unfilled: the appointment time arrived before anyone took the ${what}.`
      : matched
        ? `Unfilled: none of the ${matched} matching client(s) took the ${what}.`
        : `Unfilled: nobody on the waitlist fits the ${what}.`;
    note(message.replace("Unfilled: ", "Marked unfilled: "));
    await notifyFrontDesk({ openingId: opening.id, kind: "unfilled", message });
  }

  status.wrappedUp = true;
  await condition(allHandlersFinished);
  return status;
}
