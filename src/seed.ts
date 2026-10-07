import type { WaitlistClient } from "./types";

// Made-up clients with 555 numbers. No real personal information.
const everyDay = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const SERVICES = ["Haircut", "Color", "Blowout"];
export const STYLISTS = ["Ana", "Ben", "Priya"];

export function seedWaitlist(): WaitlistClient[] {
  return [
    { id: "maya", name: "Maya Chen", mobile: "(555) 201-0101", service: "Haircut", preferredStylist: "Ana", stylistRequired: false, availability: { days: [...everyDay], from: "09:00", to: "19:00" }, joinedAt: "2026-09-01", optedOut: false, status: "waiting" },
    { id: "jordan", name: "Jordan Lee", mobile: "(555) 201-0102", service: "Haircut", preferredStylist: "Ana", stylistRequired: true, availability: { days: [...everyDay], from: "10:00", to: "18:00" }, joinedAt: "2026-09-04", optedOut: false, status: "waiting" },
    { id: "lucy", name: "Lucy Brown", mobile: "(555) 201-0103", service: "Haircut", stylistRequired: false, availability: { days: [...everyDay], from: "09:00", to: "19:00" }, joinedAt: "2026-09-06", optedOut: true, status: "waiting" },
    { id: "sofia", name: "Sofia Ramirez", mobile: "(555) 201-0104", service: "Haircut", stylistRequired: false, availability: { days: [...everyDay], from: "12:00", to: "20:00" }, joinedAt: "2026-09-09", optedOut: false, status: "waiting" },
    { id: "dev", name: "Dev Patel", mobile: "(555) 201-0105", service: "Haircut", preferredStylist: "Ben", stylistRequired: true, availability: { days: ["Mon", "Tue", "Wed", "Thu", "Fri"], from: "12:00", to: "19:00" }, joinedAt: "2026-09-12", optedOut: false, status: "waiting" },
    { id: "grace", name: "Grace Kim", mobile: "(555) 201-0106", service: "Color", preferredStylist: "Priya", stylistRequired: false, availability: { days: [...everyDay], from: "09:00", to: "18:00" }, joinedAt: "2026-09-03", optedOut: false, status: "waiting", unreachable: true },
    { id: "omar", name: "Omar Haddad", mobile: "(555) 201-0107", service: "Color", stylistRequired: false, availability: { days: [...everyDay], from: "09:00", to: "18:00" }, joinedAt: "2026-09-08", optedOut: false, status: "waiting" },
    { id: "nina", name: "Nina Rossi", mobile: "(555) 201-0108", service: "Blowout", stylistRequired: false, availability: { days: [...everyDay], from: "09:00", to: "19:00" }, joinedAt: "2026-09-20", optedOut: false, status: "waiting" },
  ];
}
