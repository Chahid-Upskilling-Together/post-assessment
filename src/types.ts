// Shared data types for the Juniper Salon waitlist prototype.

export type Weekday = "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat";

// "General availability" as Lena's Google Sheet records it.
export type Availability = { days: Weekday[]; from: string; to: string };

export type WaitlistClient = {
  id: string;
  name: string;
  mobile: string;
  service: string;
  preferredStylist?: string;
  stylistRequired: boolean;
  availability: Availability;
  joinedAt: string;
  optedOut: boolean;
  status: "waiting" | "booked";
  // Demo only: texts to this number always fail, to show what happens when a
  // message cannot be delivered.
  unreachable?: boolean;
};

export type Opening = {
  id: string;
  service: string;
  stylist: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM, 24h
  when: string; // human label, e.g. "today at 2:00 pm"
  sameDay: boolean;
};

export type Policy = {
  sameDayHoldMinutes: number;
  laterHoldMinutes: number;
  // How long one "minute" lasts. 60000 in real use; 1000 in the demo so a
  // 15-minute hold takes 15 seconds.
  minuteMs: number;
};

export type OpeningInput = { opening: Opening; policy: Policy };

export type CandidateState =
  | "in_line"
  | "offered"
  | "declined"
  | "timed_out"
  | "unreachable"
  | "opted_out"
  | "withdrawn"
  | "booked";

export type Candidate = {
  id: string;
  name: string;
  mobile: string;
  state: CandidateState;
  offeredAt?: number;
  expiresAt?: number;
};

export type OpeningPhase = "finding" | "offering" | "filled" | "unfilled" | "cancelled";

export type Attention = {
  at: number;
  clientId?: string;
  kind: "unclear_reply" | "not_delivered";
  message: string;
  resolved: boolean;
};

export type HistoryEntry = { at: number; text: string };

export type OpeningStatus = {
  opening: Opening;
  phase: OpeningPhase;
  holdMinutes: number;
  candidates: Candidate[];
  skippedOptedOut: string[];
  currentClientId?: string;
  bookedClientId?: string;
  cancelReason?: string;
  attention: Attention[];
  history: HistoryEntry[];
};

export type ReplyInput = { clientId: string; text: string; by: "client" | "staff" };
export type ReplyOutcome = "accepted" | "already_booked" | "declined" | "opted_out" | "unclear" | "too_late";
export type ReplyResult = { outcome: ReplyOutcome };

export type MatchResult = {
  candidates: { id: string; name: string; mobile: string }[];
  skippedOptedOut: string[];
};

export type TextMessage = {
  id: string;
  at: string;
  clientId: string;
  openingId?: string;
  direction: "out" | "in";
  body: string;
  kind: string;
};

export type FrontDeskNote = {
  id: string;
  at: string;
  openingId: string;
  kind: "filled" | "unfilled" | "cancelled" | "attention";
  message: string;
};

export type Settings = { flakyTexts: boolean };
