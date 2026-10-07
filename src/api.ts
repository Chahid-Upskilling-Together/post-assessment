import path from "node:path";
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import express, { type NextFunction, type Request, type Response } from "express";
import { SERVICES, STYLISTS } from "./seed";
import * as store from "./store";
import type { Opening, OpeningStatus, Policy } from "./types";
import { cancelOpening, clientReply, fillOpeningWorkflow, getOpeningStatus, parseReply } from "./workflows";

const TASK_QUEUE = "juniper-waitlist";

// Lena's rule: 15 minutes for a same-day opening, longer otherwise (60 is our
// assumption). MINUTE_MS=2000 runs the demo clock at one minute per 2 seconds.
const policy: Policy = {
  sameDayHoldMinutes: Number(process.env.SAME_DAY_HOLD_MINUTES ?? 15),
  laterHoldMinutes: Number(process.env.LATER_HOLD_MINUTES ?? 60),
  minuteMs: Number(process.env.MINUTE_MS ?? 2000),
};

store.ensureSeeded();
const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

let clientPromise: Promise<Client> | undefined;
function getClient(): Promise<Client> {
  clientPromise ??= Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  }).then((connection) => new Client({ connection, namespace: "default" }));
  return clientPromise;
}

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Pre-fill the form with the next slot the sample waitlist can take: the next
// hour today (10:00 to 17:00), otherwise tomorrow at 2:00 pm.
function defaultSlot(now = new Date()): { date: string; time: string } {
  const hour = Math.max(10, now.getHours() + 1);
  if (hour <= 17) return { date: localDate(now), time: `${pad(hour)}:00` };
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  return { date: localDate(tomorrow), time: "14:00" };
}

function describeWhen(date: string, time: string, sameDay: boolean): string {
  const [h, m] = time.split(":").map(Number);
  const clock = `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? "am" : "pm"}`;
  if (sameDay) return `today at ${clock}`;
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `on ${day} at ${clock}`;
}

type OpeningView = {
  id: string;
  running: boolean;
  workerOnline: boolean;
  status?: OpeningStatus;
  error?: string;
};

// Last status seen for each opening, shown if the Worker is offline.
const lastKnown = new Map<string, OpeningStatus>();

async function viewOpening(client: Client, id: string): Promise<OpeningView> {
  const handle = client.workflow.getHandle(id);
  try {
    const description = await handle.describe();
    if (description.status.name !== "RUNNING") {
      const status = (await handle.result()) as OpeningStatus;
      return { id, running: false, workerOnline: true, status };
    }
    try {
      const status = await client.connection.withDeadline(Date.now() + 2000, () => handle.query(getOpeningStatus));
      lastKnown.set(id, status);
      return { id, running: true, workerOnline: true, status };
    } catch {
      return { id, running: true, workerOnline: false, status: lastKnown.get(id) };
    }
  } catch (error) {
    return { id, running: false, workerOnline: true, error: error instanceof Error ? error.message : String(error) };
  }
}

app.get("/api/config", (_request, response) => {
  const slot = defaultSlot();
  response.json({ services: SERVICES, stylists: STYLISTS, policy, today: localDate(), defaultDate: slot.date, defaultTime: slot.time });
});

app.get("/api/state", async (_request, response) => {
  const client = await getClient();
  const openings = await Promise.all(store.getOpeningIds().slice(0, 12).map((id) => viewOpening(client, id)));
  response.json({
    now: Date.now(),
    policy,
    settings: store.getSettings(),
    openings,
    waitlist: store.getWaitlist(),
    messages: store.getMessages(),
    frontDesk: store.getFrontDesk().reverse(),
  });
});

// Staff create an opening when a client cancels in Square.
app.post("/api/openings", async (request, response) => {
  const { service, stylist, date, time } = request.body ?? {};
  if (!SERVICES.includes(service) || !STYLISTS.includes(stylist) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    response.status(400).json({ error: "Choose a service, stylist, date and time." });
    return;
  }
  const startsAt = new Date(`${date}T${time}:00`).getTime(); // the salon's local time
  if (startsAt <= Date.now()) {
    response.status(400).json({ error: "That time has already passed. Choose a later time." });
    return;
  }
  const sameDay = date === localDate();
  // One Workflow per stylist and time: Temporal refuses a second run with the
  // same ID while the first is still going, so a slot can't be offered twice
  // (a double click, or Lena and Carla both entering the same cancellation).
  const id = `opening-${date}-${time.replace(":", "")}-${stylist.toLowerCase()}`;
  const opening: Opening = { id, service, stylist, date, time, sameDay, startsAt, when: describeWhen(date, time, sameDay) };
  const client = await getClient();
  try {
    await client.workflow.start(fillOpeningWorkflow, {
      workflowId: id,
      taskQueue: TASK_QUEUE,
      args: [{ opening, policy }],
    });
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      response.status(409).json({ error: `This slot (${stylist}, ${describeWhen(date, time, sameDay)}) is already being offered. See it below.`, id });
      return;
    }
    throw error;
  }
  store.addOpeningId(id);
  response.status(201).json({ id });
});

app.post("/api/openings/:id/cancel", async (request, response) => {
  const client = await getClient();
  await client.workflow.getHandle(request.params.id).signal(cancelOpening, String(request.body?.reason ?? "cancelled by staff"));
  response.status(202).json({ accepted: true });
});

// Staff settle an unclear reply on the client's behalf.
app.post("/api/openings/:id/mark", async (request, response) => {
  const { clientId, decision } = request.body ?? {};
  const client = await getClient();
  const result = await client.workflow
    .getHandle(request.params.id)
    .executeUpdate(clientReply, { args: [{ clientId, text: decision === "yes" ? "YES" : "NO", by: "staff" }] });
  response.json(result);
});

// A client texts back. Like a real text, the reply is matched to the last
// opening offered to that client.
app.post("/api/replies", async (request, response) => {
  const clientId = String(request.body?.clientId ?? "");
  const text = String(request.body?.text ?? "").trim();
  if (!store.getClient(clientId) || !text) {
    response.status(400).json({ error: "Unknown client or empty reply." });
    return;
  }
  store.addMessage({ clientId, direction: "in", kind: "reply", body: text });
  const offer = [...store.getMessages()].reverse().find((m) => m.clientId === clientId && m.kind === "offer" && m.openingId);
  const answer = (body: string, outcome: string, openingId?: string) => {
    store.addMessage({ clientId, openingId, direction: "out", kind: "auto_reply", body });
    response.json({ outcome });
  };
  if (parseReply(text) === "stop" && !offer) {
    store.updateClient(clientId, { optedOut: true });
    answer("You won't get any more opening texts from Juniper Salon. Call us any time if you change your mind.", "opted_out");
    return;
  }
  if (!offer?.openingId) {
    answer("Thanks! There's no opening on offer for you right now. We'll text you when one comes up.", "no_offer");
    return;
  }
  const client = await getClient();
  const handle = client.workflow.getHandle(offer.openingId);
  try {
    const result = await handle.executeUpdate(clientReply, { args: [{ clientId, text, by: "client" }] });
    response.json(result);
  } catch {
    // Either that opening has finished (filled, cancelled or unfilled), or this
    // client wasn't offered it. If Temporal itself can't be reached, say so
    // rather than telling the client something that may not be true.
    try {
      await client.connection.withDeadline(Date.now() + 3000, () => handle.describe());
    } catch {
      response.status(503).json({ error: "Temporal can't be reached right now, so the reply wasn't processed. Try again in a moment." });
      return;
    }
    if (parseReply(text) === "stop") {
      store.updateClient(clientId, { optedOut: true });
      answer("You won't get any more opening texts from Juniper Salon. Call us any time if you change your mind.", "opted_out", offer.openingId);
      return;
    }
    answer("Sorry, that opening is no longer available. You're still on our waitlist for the next one.", "too_late", offer.openingId);
  }
});

app.post("/api/settings", (request, response) => {
  store.setSettings({ flakyTexts: Boolean(request.body?.flakyTexts) });
  response.json(store.getSettings());
});

// Demo only: stop running openings and restore the sample waitlist.
app.post("/api/reset", async (_request, response) => {
  const client = await getClient();
  for (const id of store.getOpeningIds()) {
    try {
      const handle = client.workflow.getHandle(id);
      if ((await handle.describe()).status.name === "RUNNING") await handle.terminate("demo reset");
    } catch {
      // Already gone.
    }
  }
  store.resetDemoData();
  response.json({ reset: true });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  response.status(500).json({
    error: error instanceof Error ? error.message : "Unexpected error",
  });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Juniper Salon waitlist is available at http://localhost:${port}`));
