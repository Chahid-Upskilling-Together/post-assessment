const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

let state;
let selectedClient;
let lastRenderedThread = "";
let lastMessageCount = 0;

const PHASE = {
  finding: ["Finding matches", "finding"],
  offering: ["Offering", "offering"],
  filled: ["Filled", "filled"],
  unfilled: ["Unfilled", "unfilled"],
  cancelled: ["Cancelled", "cancelled"],
};

const CANDIDATE = {
  in_line: "In line",
  offered: "Has the offer",
  declined: "Declined",
  timed_out: "Timed out",
  unreachable: "Couldn't reach",
  opted_out: "Opted out",
  withdrawn: "Told it's cancelled",
  booked: "Booked",
};

function minutesLeft(candidate) {
  if (!candidate.expiresAt) return "";
  const ms = Math.max(0, candidate.expiresAt - Date.now());
  const minutes = Math.ceil(ms / state.policy.minuteMs);
  return `${minutes} min left`;
}

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

function renderOpening(view) {
  const temporalLink = `http://localhost:8233/namespaces/default/workflows/${encodeURIComponent(view.id)}`;
  if (!view.status) {
    return `<article class="card opening"><p class="headline">${view.running ? "Waiting for the Worker to start this opening…" : esc(view.error ?? "Unavailable")}</p>
      <footer><span class="wfid">Workflow ID: ${esc(view.id)}</span><a href="${temporalLink}" target="_blank">View in Temporal</a></footer></article>`;
  }
  const s = view.status;
  const [label, tone] = view.running && !view.workerOnline ? ["Paused: worker offline", "paused"] : PHASE[s.phase];
  const byId = Object.fromEntries(s.candidates.map((c) => [c.id, c]));
  const current = s.currentClientId ? byId[s.currentClientId] : undefined;
  const booked = s.bookedClientId ? byId[s.bookedClientId] : undefined;
  let headline;
  if (view.running && !view.workerOnline) {
    headline = "Temporal is holding this opening. It will carry on from exactly this point when the worker is back.";
  } else if (s.phase === "finding") headline = "Checking the waitlist for people who fit…";
  else if (s.phase === "offering") headline = current
    ? `Waiting for <b>${esc(current.name)}</b> to reply · ${minutesLeft(current)}`
    : "Moving to the next person…";
  else if (s.phase === "filled") headline = `Filled by <b>${esc(booked?.name)}</b>. Client and front desk have been told.`;
  else if (s.phase === "cancelled") headline = `Cancelled (${esc(s.cancelReason)}). Anyone holding the offer was told.`;
  else headline = s.candidates.length
    ? "Unfilled: everyone who fits has passed. The front desk has been told."
    : "Unfilled: nobody on the waitlist fits this opening. The front desk has been told.";

  const line = s.candidates.length
    ? `<ol class="line">${s.candidates.map((c) => `
        <li class="cand st-${c.state}">
          <span class="name">${esc(c.name)}</span>
          <span class="chip">${CANDIDATE[c.state]}${c.state === "offered" && s.phase === "offering" ? ` · ${minutesLeft(c)}` : ""}</span>
        </li>`).join("")}</ol>`
    : "";
  const skipped = s.skippedOptedOut.length
    ? `<p class="skipped">Not texted because they opted out: ${s.skippedOptedOut.map(esc).join(", ")}</p>` : "";
  const open = s.attention.filter((a) => !a.resolved);
  const attention = open.map((a) => `
    <div class="attention">
      <span>⚠ ${esc(a.message)}</span>
      ${a.kind === "unclear_reply" && s.phase === "offering" && s.currentClientId === a.clientId
        ? `<span class="actions"><button data-mark="yes" data-opening="${esc(view.id)}" data-client="${esc(a.clientId)}">Mark YES</button><button class="ghost" data-mark="no" data-opening="${esc(view.id)}" data-client="${esc(a.clientId)}">Mark NO</button></span>` : ""}
    </div>`).join("");
  const canCancel = view.running && (s.phase === "finding" || s.phase === "offering");
  const cancel = canCancel ? `
    <span class="cancel">
      <select data-reason="${esc(view.id)}">
        <option>client changed their mind</option>
        <option>stylist unavailable</option>
        <option>filled another way</option>
      </select>
      <button class="danger" data-cancel="${esc(view.id)}">Cancel opening</button>
    </span>` : "";
  const history = s.history.slice().reverse().map((h) =>
    `<li><time>${new Date(h.at).toLocaleTimeString()}</time> ${esc(h.text)}</li>`).join("");

  return `
    <article class="card opening tone-${tone}">
      <header>
        <div>
          <h3>${esc(s.opening.service)} with ${esc(s.opening.stylist)}</h3>
          <p class="when">${esc(s.opening.when)} · each person gets ${s.holdMinutes} min to reply</p>
        </div>
        <span class="chip phase">${label}</span>
      </header>
      <p class="headline">${headline}</p>
      ${attention}
      ${line}
      ${skipped}
      <details><summary>What happened</summary><ul class="history">${history}</ul></details>
      <footer>
        <span class="wfid">Workflow ID: ${esc(view.id)}</span>
        <a href="${temporalLink}" target="_blank">View in Temporal</a>
        ${cancel}
      </footer>
    </article>`;
}

function renderWaitlist() {
  const rows = state.waitlist.map((c) => {
    const status = c.optedOut ? "Opted out" : c.status === "booked" ? "Booked" : "Waiting";
    const stylist = c.preferredStylist ? `${esc(c.preferredStylist)}${c.stylistRequired ? " (only)" : " (preferred)"}` : "Anyone";
    const days = c.availability.days.length === 7 ? "Every day" : c.availability.days.join(", ");
    return `<tr class="${c.optedOut || c.status === "booked" ? "dim" : ""}">
      <td>${esc(c.name)}${c.unreachable ? ' <span class="tag" title="Demo: texts to this number always fail">texts fail</span>' : ""}</td>
      <td>${esc(c.service)}</td><td>${stylist}</td>
      <td>${days}, ${c.availability.from}–${c.availability.to}</td>
      <td>${c.joinedAt.slice(5)}</td><td>${status}</td></tr>`;
  }).join("");
  $("#waitlist").innerHTML = `<table><thead><tr><th>Name</th><th>Wants</th><th>Stylist</th><th>Available</th><th>Joined</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderFrontDesk() {
  const icons = { filled: "✅", unfilled: "⭕", cancelled: "✖", attention: "⚠" };
  $("#frontdesk").innerHTML = state.frontDesk.length
    ? state.frontDesk.map((n) => `<li class="note-${n.kind}"><span>${icons[n.kind] ?? "•"}</span><div>${esc(n.message)}<time>${new Date(n.at).toLocaleTimeString()}</time></div></li>`).join("")
    : '<li class="empty">Notes for the front desk appear here: filled, unfilled, cancelled, or needs attention.</li>';
}

function renderPhones() {
  const messages = state.messages;
  if ($("#follow").checked && messages.length > lastMessageCount) {
    const latestOut = [...messages].reverse().find((m) => m.direction === "out");
    if (latestOut) selectedClient = latestOut.clientId;
  }
  lastMessageCount = messages.length;
  selectedClient ??= state.waitlist[0]?.id;
  const counts = {};
  for (const m of messages) counts[m.clientId] = (counts[m.clientId] ?? 0) + 1;
  $("#phone-tabs").innerHTML = state.waitlist.map((c) =>
    `<button type="button" class="tab ${c.id === selectedClient ? "active" : ""}" data-client="${esc(c.id)}">${esc(c.name.split(" ")[0])}${counts[c.id] ? ` <span class="count">${counts[c.id]}</span>` : ""}</button>`).join("");
  const client = state.waitlist.find((c) => c.id === selectedClient);
  $("#phone-head").innerHTML = client ? `<b>${esc(client.name)}</b><span>${esc(client.mobile)}</span>` : "";
  const thread = messages.filter((m) => m.clientId === selectedClient);
  const html = thread.length
    ? thread.map((m) => `<div class="bubble ${m.direction}"><p>${esc(m.body)}</p><time>${m.direction === "out" ? "Juniper Salon · " : ""}${new Date(m.at).toLocaleTimeString()}</time></div>`).join("")
    : '<p class="empty">No texts yet. When this client is offered an opening, the text shows up here and you can reply as them.</p>';
  if (html !== lastRenderedThread) {
    $("#thread").innerHTML = html;
    $("#thread").scrollTop = $("#thread").scrollHeight;
    lastRenderedThread = html;
  }
}

function render() {
  $("#flaky").checked = state.settings.flakyTexts;
  $("#openings").innerHTML = state.openings.length
    ? state.openings.map(renderOpening).join("")
    : '<section class="card empty-state"><h2>No openings yet</h2><p>When a client cancels in Square, add the slot above. The waitlist is offered it one person at a time.</p></section>';
  renderWaitlist();
  renderFrontDesk();
  renderPhones();
}

async function refresh() {
  try {
    state = await api("/api/state");
    render();
  } catch (error) {
    console.error(error);
  }
}

async function init() {
  const config = await api("/api/config");
  const form = $("#new-opening");
  form.service.innerHTML = config.services.map((s) => `<option>${esc(s)}</option>`).join("");
  form.stylist.innerHTML = config.stylists.map((s) => `<option>${esc(s)}</option>`).join("");
  form.date.value = config.today;
  form.time.value = "14:00";
  const p = config.policy;
  $("#rules").textContent = `Offered only to clients with the same service, free at that time, and the stylist they insist on. Opted-out clients are never texted. Each person gets ${p.sameDayHoldMinutes} min (same day) or ${p.laterHoldMinutes} min (later days).`;
  $("#clock-pill").textContent = p.minuteMs === 60000 ? "Real-time clock" : `Demo clock: 1 minute = ${p.minuteMs / 1000} second${p.minuteMs === 1000 ? "" : "s"}`;
  await refresh();
  setInterval(refresh, 1000);
}

$("#new-opening").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  $("#form-error").hidden = true;
  try {
    await api("/api/openings", { service: form.service.value, stylist: form.stylist.value, date: form.date.value, time: form.time.value });
    await refresh();
  } catch (error) {
    $("#form-error").textContent = error.message;
    $("#form-error").hidden = false;
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.cancel) {
    const reason = document.querySelector(`select[data-reason="${CSS.escape(target.dataset.cancel)}"]`)?.value;
    target.disabled = true;
    await api(`/api/openings/${encodeURIComponent(target.dataset.cancel)}/cancel`, { reason }).catch(alert);
    await refresh();
  } else if (target.dataset.mark) {
    target.disabled = true;
    await api(`/api/openings/${encodeURIComponent(target.dataset.opening)}/mark`, { clientId: target.dataset.client, decision: target.dataset.mark }).catch(alert);
    await refresh();
  } else if (target.classList.contains("tab")) {
    selectedClient = target.dataset.client;
    $("#follow").checked = false;
    renderPhones();
  } else if (target.dataset.quick) {
    await sendReply(target.dataset.quick);
  }
});

async function sendReply(text) {
  if (!selectedClient || !text.trim()) return;
  await api("/api/replies", { clientId: selectedClient, text }).catch(alert);
  await refresh();
}

$("#reply").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = event.target.text;
  const text = input.value;
  input.value = "";
  await sendReply(text);
});

$("#flaky").addEventListener("change", async (event) => {
  await api("/api/settings", { flakyTexts: event.target.checked });
  await refresh();
});

$("#reset").addEventListener("click", async () => {
  if (!confirm("Reset the demo? Running openings are stopped and the sample waitlist is restored.")) return;
  await api("/api/reset", {});
  selectedClient = undefined;
  lastMessageCount = 0;
  lastRenderedThread = "";
  await refresh();
});

init().catch((error) => {
  $("#openings").innerHTML = `<section class="card"><p>Could not reach the app: ${esc(error.message)}</p></section>`;
});
