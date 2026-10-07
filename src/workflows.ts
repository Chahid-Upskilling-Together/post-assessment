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
const { findMatchingClients, notifyFrontDesk, markBooked, recordOptOut } = proxyActivities<typeof activities>({
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

// One run of this Workflow fills one opening: it offers the slot to one
// matching client at a time, in waitlist order, and waits durably for a reply.
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
    attention: [],
    history: [],
  };
  const decisions = new Map<string, "yes" | "no">();
  const toldUnavailable = new Set<string>();
  let cancelReason: string | undefined;

  const note = (text: string) => status.history.push({ at: Date.now(), text });
  const text = (c: Candidate, kind: string, body: string) =>
    sendText({ clientId: c.id, openingId: opening.id, kind, body });
  const resolveAttention = (clientId: string) =>
    status.attention.filter((a) => a.clientId === clientId).forEach((a) => (a.resolved = true));

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
        resolveAttention(clientId);
        // STOP ends future texts; it never undoes a booking already made.
        if (theirTurn && !alreadyBooked) decisions.set(clientId, "no");
        if (!alreadyBooked) c.state = "opted_out";
        await recordOptOut(clientId);
        await text(c, "opted_out", "You won't get any more opening texts from Juniper Salon. Call us any time if you change your mind.");
        return { outcome: "opted_out" };
      }
      if (alreadyBooked) {
        await text(c, "already_booked", `You're already booked: ${what}. See you then!`);
        return { outcome: "already_booked" };
      }
      if (!theirTurn) {
        toldUnavailable.add(clientId);
        await text(c, "too_late", `Sorry, the ${what} is no longer available. You're still on our waitlist for the next opening.`);
        return { outcome: "too_late" };
      }
      if (intent === "yes") {
        resolveAttention(clientId);
        decisions.set(clientId, "yes");
        return { outcome: "accepted" };
      }
      if (intent === "no") {
        resolveAttention(clientId);
        decisions.set(clientId, "no");
        await text(c, "declined", "No problem, thanks for letting us know. You're still on our waitlist.");
        return { outcome: "declined" };
      }
      status.attention.push({
        at: Date.now(),
        clientId,
        kind: "unclear_reply",
        message: `Unclear reply from ${c.name}: "${reply}". They were asked to answer YES or NO; you can also mark it yourself.`,
        resolved: false,
      });
      await text(c, "unclear", "Sorry, we didn't catch that. Reply YES to take the appointment or NO to pass.");
      return { outcome: "unclear" };
    },
    {
      validator: ({ clientId, text: reply }) => {
        if (!status.candidates.some((c) => c.id === clientId && c.state !== "in_line")) {
          throw new Error("This client has not been offered this opening.");
        }
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

  let booked: Candidate | undefined;
  for (const c of status.candidates) {
    if (cancelReason) break;
    if (c.state !== "in_line") continue;
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
      await notifyFrontDesk({ openingId: opening.id, kind: "attention", message: `Couldn't reach ${c.name} (${c.mobile}) about the ${what}. Moved on to the next person; please check the number.` });
      continue;
    }
    c.offeredAt = Date.now();
    c.expiresAt = c.offeredAt + holdMs;
    note(`Offered to ${c.name}; holding for ${holdMinutes} minutes`);

    // Durable wait: survives restarts. Ends on a reply, a cancel, or the hold running out.
    await condition(() => decisions.has(c.id) || cancelReason !== undefined, holdMs);
    status.currentClientId = undefined;
    const decision = decisions.get(c.id);

    if (decision === "yes") {
      c.state = "booked";
      booked = c;
      break;
    }
    if (decision === "no") {
      // The reply handler may have marked them opted out (they texted STOP).
      if ((c.state as Candidate["state"]) !== "opted_out") c.state = "declined";
      continue;
    }
    if (cancelReason) {
      c.state = "withdrawn";
      await text(c, "withdrawn", `Sorry, the ${what} is no longer available, so there's nothing you need to do. You're still on our waitlist.`);
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
    await text(booked, "confirmed", `You're booked: ${what}. See you then! If anything changes, just call the salon.`);
    await notifyFrontDesk({ openingId: opening.id, kind: "filled", message: `Filled: ${booked.name} (${booked.mobile}) took the ${what}. Please add it to Square.` });
    // Tell anyone whose offer ran out, unless they already heard it's gone.
    for (const other of status.candidates.filter((x) => x.state === "timed_out" && !toldUnavailable.has(x.id))) {
      await text(other, "filled", `Update from Juniper Salon: the ${what} has been filled. You're still on our waitlist for the next opening.`);
    }
  } else if (cancelReason) {
    status.phase = "cancelled";
    status.cancelReason = cancelReason;
    note(`Cancelled: ${cancelReason}`);
    await notifyFrontDesk({ openingId: opening.id, kind: "cancelled", message: `Cancelled: the ${what} (${cancelReason}).` });
  } else {
    status.phase = "unfilled";
    const contacted = status.candidates.length;
    note(contacted ? "Everyone who fits has passed. Marked unfilled." : "Nobody on the waitlist fits. Marked unfilled.");
    await notifyFrontDesk({
      openingId: opening.id,
      kind: "unfilled",
      message: contacted
        ? `Unfilled: none of the ${contacted} matching client(s) took the ${what}.`
        : `Unfilled: nobody on the waitlist fits the ${what}.`,
    });
  }

  await condition(allHandlersFinished);
  return status;
}
