// A tiny JSON-file store standing in for Lena's Google Sheet and the salon
// phone. Shared by the API (reads, staff actions) and the Worker's Activities
// (texts, bookings). Never imported by Workflow code.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { seedWaitlist } from "./seed";
import type { FrontDeskNote, OfferCheck, Settings, TextMessage, WaitlistClient } from "./types";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

function file(name: string): string {
  return path.join(DATA_DIR, `${name}.json`);
}

function read<T>(name: string, fallback: () => T): T {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8")) as T;
  } catch {
    return fallback();
  }
}

function write(name: string, value: unknown): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file(name)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file(name));
}

export function ensureSeeded(): void {
  if (!fs.existsSync(file("waitlist"))) resetDemoData();
}

export function resetDemoData(): void {
  write("waitlist", seedWaitlist());
  write("openings", []);
  write("offers", {});
  write("settings", { flakyTexts: false });
  for (const log of ["messages", "frontdesk"]) fs.rmSync(path.join(DATA_DIR, `${log}.jsonl`), { force: true });
}

export const getWaitlist = (): WaitlistClient[] => read("waitlist", seedWaitlist);
export const getClient = (id: string): WaitlistClient | undefined => getWaitlist().find((c) => c.id === id);

export function updateClient(id: string, change: Partial<WaitlistClient>): void {
  write("waitlist", getWaitlist().map((c) => (c.id === id ? { ...c, ...change } : c)));
}

// Texts and front desk notes are append-only logs (one JSON object per line),
// so the API and the Worker can both add to them without overwriting each other.
function readLog<T>(name: string): T[] {
  try {
    return fs
      .readFileSync(path.join(DATA_DIR, `${name}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

function appendLog(name: string, entry: unknown): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(path.join(DATA_DIR, `${name}.jsonl`), `${JSON.stringify(entry)}\n`);
}

export const getMessages = (): TextMessage[] => readLog("messages");
export function addMessage(message: Omit<TextMessage, "id" | "at">): TextMessage {
  const saved = { ...message, id: randomUUID(), at: new Date().toISOString() };
  appendLog("messages", saved);
  return saved;
}

export const getFrontDesk = (): FrontDeskNote[] => readLog("frontdesk");
export function addFrontDeskNote(note: Omit<FrontDeskNote, "id" | "at">): void {
  appendLog("frontdesk", { ...note, id: randomUUID(), at: new Date().toISOString() });
}

export const getOpeningIds = (): string[] => read("openings", () => []);
export function addOpeningId(id: string): void {
  write("openings", [id, ...getOpeningIds().filter((x) => x !== id)]);
}

// Which opening each client currently holds a live offer from. A client gets
// one offer at a time, so a "YES" can only mean one thing.
const getActiveOffers = (): Record<string, string> => read("offers", () => ({}));

export function claimOffer(clientId: string, openingId: string): OfferCheck {
  const client = getClient(clientId);
  if (!client || client.optedOut) return "opted_out";
  if (client.status === "booked") return "booked";
  const offers = getActiveOffers();
  if (offers[clientId] && offers[clientId] !== openingId) return "busy";
  write("offers", { ...offers, [clientId]: openingId });
  return "ok";
}

export function releaseOffer(clientId: string, openingId: string): void {
  const offers = getActiveOffers();
  if (offers[clientId] !== openingId) return;
  delete offers[clientId];
  write("offers", offers);
}

export const getSettings = (): Settings => read("settings", () => ({ flakyTexts: false }));
export function setSettings(settings: Settings): void {
  write("settings", settings);
}
