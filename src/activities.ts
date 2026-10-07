// Activities: the steps that touch the outside world (the waitlist sheet, the
// salon phone, the front desk). Temporal retries them when they fail.
import { ApplicationFailure, Context } from "@temporalio/activity";
import * as store from "./store";
import type { FrontDeskNote, MatchResult, Opening, Weekday } from "./types";

const WEEKDAYS: Weekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Same service, free at that time, and the right stylist if they insist on one.
// Earliest to join the waitlist goes first; opted-out clients are never texted.
export async function findMatchingClients(opening: Opening): Promise<MatchResult> {
  const day = WEEKDAYS[new Date(`${opening.date}T12:00:00Z`).getUTCDay()];
  const fits = store.getWaitlist().filter(
    (c) =>
      c.status === "waiting" &&
      c.service === opening.service &&
      (!c.stylistRequired || c.preferredStylist === opening.stylist) &&
      c.availability.days.includes(day) &&
      c.availability.from <= opening.time &&
      opening.time < c.availability.to,
  );
  const inOrder = fits.filter((c) => !c.optedOut).sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  return {
    candidates: inOrder.map(({ id, name, mobile }) => ({ id, name, mobile })),
    skippedOptedOut: fits.filter((c) => c.optedOut).map((c) => c.name),
  };
}

// Simulated text message. Delivery can fail; Temporal retries it.
export async function sendText(text: { clientId: string; openingId: string; kind: string; body: string }): Promise<void> {
  const client = store.getClient(text.clientId);
  const { attempt } = Context.current().info;
  if (client?.unreachable) {
    throw ApplicationFailure.retryable(`Text to ${client.mobile} was not delivered (number not reachable), attempt ${attempt}`, "TextNotDelivered");
  }
  if (store.getSettings().flakyTexts && attempt < 3) {
    throw ApplicationFailure.retryable(`Text service did not respond (attempt ${attempt})`, "TextServiceUnavailable");
  }
  store.addMessage({ clientId: text.clientId, openingId: text.openingId, direction: "out", kind: text.kind, body: text.body });
}

export async function notifyFrontDesk(note: Omit<FrontDeskNote, "id" | "at">): Promise<void> {
  store.addFrontDeskNote(note);
}

// The client got an appointment, so they come off the waitlist.
export async function markBooked(clientId: string): Promise<void> {
  store.updateClient(clientId, { status: "booked" });
}

export async function recordOptOut(clientId: string): Promise<void> {
  store.updateClient(clientId, { optedOut: true });
}
