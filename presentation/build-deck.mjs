// Builds the Juniper Salon customer deck.
//
//   node presentation/build-deck.mjs        (works from any directory)
//
// Writes deck.html and juniper-salon-slides.pdf next to this script: five
// 13.333in x 7.5in slides rendered with Playwright Chromium.
//
// Screenshots are optional. Put img/staff-board.png (wide desktop shot) and
// img/client-phone.png (tall phone shot) next to this script and rebuild; each
// is embedded as a data URI. Until a file exists, a dashed placeholder box is
// drawn in its place, so the deck always builds.
//
// After rendering, a layout check reports any element that spills past its
// slide, crowds the footer, is clipped, or uses text smaller than 11pt.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML_OUT = join(HERE, 'deck.html');
const PDF_OUT = join(HERE, 'juniper-salon-slides.pdf');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// ESM ignores NODE_PATH, so resolve Playwright from the global npm root.
function loadChromium() {
  const require = createRequire(import.meta.url);
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(join(globalRoot, 'playwright')).chromium;
  } catch {
    return require('playwright').chromium; // fall back to a local install
  }
}

// ---------------------------------------------------------------- images ---

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

function dataUri(rel) {
  const file = join(HERE, rel);
  if (!existsSync(file)) return null;
  const mime = MIME[extname(file).toLowerCase()] || 'image/png';
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
}

// A fixed-size box. The image is scaled to fit inside it (object-fit: contain),
// so a wide desktop shot or a tall phone shot never overflows the slide.
function shot(rel, label, kind) {
  const src = dataUri(rel);
  if (src) return `<div class="shot ${kind}"><img src="${src}" alt="${label}"></div>`;
  return `<div class="shot ${kind} placeholder"><div><strong>${label}</strong><span class="ph-path">${rel}</span></div></div>`;
}

// ---------------------------------------------------------------- slides ---

const slides = [
// 1 ─ The problem, in her words
`
  <div class="kicker">The problem, in your words</div>
  <h1>Short-notice cancellations leave chairs empty, and filling them is a manual chase.</h1>
  <p class="sub">Today you or Carla spot the cancellation in Square, look through the Google Sheet for clients who
  might fit, text them from the salon phone, and keep checking for replies in between everything else.</p>

  <div class="grid3">
    <div class="card qcard">
      <h3>Chasing replies by hand</h3>
      <blockquote>“We have to keep checking replies and move down the list manually, and sometimes the
      appointment stays empty.”</blockquote>
    </div>
    <div class="card qcard">
      <h3>Two clients, one Saturday haircut</h3>
      <blockquote>“Last month two clients expected the same Saturday haircut after both replied yes to a group
      text. Different staff members had answered them, so one client left angry.”</blockquote>
    </div>
    <div class="card qcard">
      <h3>The next person never gets asked</h3>
      <blockquote>“We lose track of who was contacted and who declined, and sometimes nobody gets to the next
      person. Then the chair sits empty even though someone might have taken it.”</blockquote>
    </div>
  </div>

  <div class="banner">
    <div class="stat"><span class="big">8–12</span><span class="lbl">cancellations inside 48 hours<br>in a typical week</span></div>
    <p>Each one that isn’t refilled is an empty chair, and an empty chair “affects both the salon and the
    stylist because they’re paid on commission.”</p>
  </div>
`,

// 2 ─ How it works
`
  <div class="kicker">How the prototype works</div>
  <h2>Add the opening once. It works the waitlist for you.</h2>
  <p class="sub">It follows the rule you chose: “one at a time in waitlist order feels fairer and avoids competing acceptances.”</p>

  <div class="cols">
    <ol class="steps">
      <li><span class="n">1</span><div><h4>Add the opening</h4>
        <p>You or Carla enter the service, stylist, date and time. It takes a few seconds, and Square stays
        your real calendar.</p></div></li>
      <li><span class="n">2</span><div><h4>It finds who fits</h4>
        <p>Clients who want that service, are free at that time, and either don’t mind which stylist or asked
        for this one. Whoever joined the waitlist first goes first. Anyone who opted out of texts is never
        contacted.</p></div></li>
      <li><span class="n">3</span><div><h4>One client gets a text</h4>
        <p>It shows the service, stylist, date and time, and asks them to <span class="chip">Reply YES or NO</span>.
        Only one client holds the offer at a time.</p></div></li>
      <li><span class="n">4</span><div><h4>It waits, then moves on by itself</h4>
        <p>A same-day offer is held for 15 minutes (60 minutes for later dates). After a NO, or no reply in
        time, the next client gets the text.</p></div></li>
      <li><span class="n">5</span><div><h4>Booked, and everyone is told</h4>
        <p>On a YES, the client gets a confirmation, the front desk gets a note to add it to Square, and anyone
        whose time ran out hears that it has been filled.</p></div></li>
    </ol>
    <figure class="fig-board">
      ${shot('img/staff-board.png', 'Staff board screenshot', 'board')}
      <figcaption>The staff board, at a glance: who has the offer and how long they have left, who declined,
      timed out or couldn’t be reached, who’s next, and whether the opening is filled, cancelled or
      unfilled.</figcaption>
    </figure>
  </div>
`,

// 3 ─ Nothing slips through the cracks
`
  <div class="kicker">When something goes wrong</div>
  <h2>Built so nothing slips through the cracks.</h2>
  <p class="sub">Every problem is either handled automatically or shown to staff right away. Temporal, the system
  underneath, makes sure no opening gets lost or forgotten along the way.</p>

  <div class="cols">
    <div class="tablewrap">
      <table class="cases">
        <thead><tr><th>If this happens</th><th>What the prototype does</th><th>What you told us</th></tr></thead>
        <tbody>
          <tr><td class="if">Two clients want the same opening</td>
              <td>Only one client holds the offer at a time, so two people can never both be booked into it.</td>
              <td class="said">“two clients expected the same Saturday haircut”</td></tr>
          <tr><td class="if">A YES arrives after their time ran out</td>
              <td>They get a polite text saying it’s no longer available and they’re still on the waitlist.</td>
              <td class="said">“We have to tell them it’s gone, which is awkward.”</td></tr>
          <tr><td class="if">A text doesn’t go through</td>
              <td>It’s retried automatically. If it still fails, that client is skipped and staff are told to
              check the number.</td>
              <td class="said">“a message not reaching someone”</td></tr>
          <tr><td class="if">A reply is unclear, like <em>maybe later?</em></td>
              <td>The client is asked to answer YES or NO, and staff see a flag with one-click
              <span class="btn">Mark yes</span> and <span class="btn">Mark no</span> buttons.</td>
              <td class="said">“Replies can also be unclear”</td></tr>
          <tr><td class="if">Nobody takes the opening</td>
              <td>It’s marked unfilled and staff are told, so you can step in yourselves.</td>
              <td class="said">“we need to know when the process stops”</td></tr>
          <tr><td class="if">You need to call it off</td>
              <td>Staff can cancel an opening at any time, and whoever holds the offer is told.</td>
              <td class="said">“cancel it if the client changes their mind”</td></tr>
          <tr><td class="if">The computer running it restarts</td>
              <td>Every opening picks up exactly where it was, countdown included.</td>
              <td class="said">“an opening quietly stalling”</td></tr>
        </tbody>
      </table>
    </div>
    <figure class="fig-phone">
      ${shot('img/client-phone.png', 'Client phone screenshot', 'phone')}
      <figcaption>A client’s phone: the offer, then a clear answer either way.</figcaption>
    </figure>
  </div>
`,

// 4 ─ Real vs. simulated
`
  <div class="kicker">Real vs. simulated</div>
  <h2>What’s real in this prototype, and what isn’t yet.</h2>
  <p class="sub">How it decides who to text, when to move on and what to tell people is real and working. Anything
  that would reach real clients or your real records is simulated for now.</p>

  <div class="cols two">
    <div class="panel real">
      <h3>Working in the prototype</h3>
      <ul class="ticks">
        <li>Creating an opening in a few seconds, and cancelling it at any time</li>
        <li>Matching clients by service, time and stylist, in waitlist order, and never texting anyone who opted out</li>
        <li>One offer at a time, the 15- and 60-minute holds, and moving on by itself after a NO or no reply</li>
        <li>Confirmations, front-desk notes, letting others know it’s filled, and polite replies to a late YES</li>
        <li>Retrying failed texts, flagging unclear replies, and telling staff when an opening goes unfilled</li>
        <li>Picking up exactly where it was if the computer restarts</li>
        <li>The staff board, plus on-screen client phones so you can play the client</li>
      </ul>
    </div>
    <div class="panel sim">
      <h3>Simulated or left out, for now</h3>
      <ul class="rings">
        <li><strong>Texts</strong> appear on simulated phones on screen. No real texting service is connected yet.</li>
        <li><strong>The waitlist</strong> is sample data with made-up names and 555 numbers, not your Google Sheet.</li>
        <li><strong>Square</strong> isn’t connected, as you chose: “We don’t need this to update Square; staff handle
        the real calendar.”</li>
        <li><strong>The clock</strong> runs fast for demos: 1 minute = 1 second, so a 15-minute hold lasts 15 seconds.</li>
        <li><strong>Not built yet:</strong> staff logins, running on more than one computer, a quiet-hours rule
        (you have “no formal rule” yet), and clients joining the waitlist from the app.</li>
      </ul>
    </div>
  </div>
`,

// 5 ─ Next step
`
  <div class="kicker">Practical next step</div>
  <h2>Next step: a two-week pilot at Juniper.</h2>
  <p class="sub">Real clients, the salon’s own number and your own waitlist, so we can see whether it fills more
  chairs and saves you time.</p>

  <div class="cols three">
    <div class="panel">
      <h3>The pilot</h3>
      <ol class="nums">
        <li>Connect a real texting service to the salon’s phone number.</li>
        <li>Import your Google Sheet waitlist.</li>
        <li>Use it for every cancellation inside 48 hours.</li>
        <li>Carla watches the board instead of the phone.</li>
      </ol>
    </div>
    <div class="panel warm">
      <h3>Two decisions for you first</h3>
      <div class="decision">
        <h4>Hold time for later openings</h4>
        <p>How long a client gets to answer when the opening isn’t same-day. We used 60 minutes.</p>
      </div>
      <div class="decision">
        <h4>Quiet hours</h4>
        <p>When texts should never go out, for example before 9am or after 8pm.</p>
      </div>
    </div>
    <div class="panel">
      <h3>How we’ll measure it</h3>
      <div class="measure"><b>Openings filled</b><span>out of your 8–12 short-notice cancellations a week</span></div>
      <div class="measure"><b>Time spent chasing replies</b><span>compared with today</span></div>
      <div class="measure"><b>Double bookings</b><span>target: zero</span></div>
    </div>
  </div>

  <div class="banner quote">
    <span class="lbl">Success, in your words</span>
    <p>“We’d spend much less time chasing replies, and Carla would know when the process had stopped or failed.”</p>
  </div>
`,
];

// ----------------------------------------------------------------- style ---

const css = `
  :root {
    --cream: #f7f2e9;
    --paper: #fffdf9;
    --ink: #26352e;
    --muted: #4f5d55;
    --faint: #87928b;
    --sage: #7a9a80;
    --sage-deep: #3c6a50;
    --sage-soft: #e5eee4;
    --sage-line: #c9d8ca;
    --line: #e6ddcd;
    --clay: #a8663f;
    --clay-soft: #f8ece0;
    --clay-line: #ecd3bb;
  }
  @page { size: 13.333in 7.5in; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: var(--cream); }
  body {
    font-family: 'Inter', 'Helvetica Neue', Helvetica, Arial, 'Liberation Sans', system-ui, sans-serif;
    color: var(--ink);
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }

  .slide {
    width: 13.333in; height: 7.5in; padding: 0.58in 0.75in 0.8in;
    background: var(--cream); position: relative; overflow: hidden;
    display: flex; flex-direction: column;
    break-after: page; page-break-after: always;
  }
  .slide:last-child { break-after: auto; page-break-after: auto; }
  .slide > * { flex-shrink: 0; }
  .slide::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 0.09in; background: var(--sage); }

  .kicker { font-size: 12pt; font-weight: 800; color: var(--sage-deep); letter-spacing: .07em;
            text-transform: uppercase; margin-bottom: 10px; }
  h1 { font-size: 30pt; font-weight: 800; line-height: 1.12; letter-spacing: -.02em; max-width: 30ch; }
  h2 { font-size: 26pt; font-weight: 800; line-height: 1.15; letter-spacing: -.02em; }
  .sub { font-size: 14pt; line-height: 1.42; color: var(--muted); margin-top: 10px; max-width: 72em; }

  .cols { display: flex; gap: 0.38in; margin-top: 0.26in; min-height: 0; }

  /* cards */
  .card { background: var(--paper); border: 1px solid var(--line); border-radius: 14px;
          padding: 18px 20px; box-shadow: 0 1px 10px rgba(38,53,46,.05); }
  .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.24in; margin-top: 0.34in; }
  .qcard { border-left: 5px solid var(--clay); }
  .qcard { padding: 20px 22px; }
  .qcard h3 { font-size: 14pt; font-weight: 800; color: var(--sage-deep); margin-bottom: 9px; }
  blockquote { font-size: 13.5pt; line-height: 1.45; color: var(--ink); }

  .banner { margin-top: 0.32in; background: var(--sage-deep); color: #fff; border-radius: 14px;
            padding: 18px 26px; display: flex; align-items: center; gap: 28px; }
  .banner .stat { display: flex; align-items: center; gap: 14px; flex: none; padding-right: 28px;
                  border-right: 1px solid rgba(255,255,255,.3); }
  .banner .big { font-size: 34pt; font-weight: 800; letter-spacing: -.02em; line-height: 1; }
  .banner .lbl { font-size: 11.5pt; font-weight: 600; line-height: 1.3; opacity: .92; }
  .banner p { font-size: 14pt; line-height: 1.45; }

  /* slide 2: steps + board */
  ol.steps { list-style: none; flex: 1; display: flex; flex-direction: column; gap: 0.12in; }
  ol.steps li { display: flex; gap: 14px; align-items: flex-start; position: relative; }
  ol.steps li:not(:last-child)::after { content: ''; position: absolute; left: 14px; top: 34px;
                                        bottom: calc(-0.12in + 3px); width: 2px; background: var(--sage-line); }
  ol.steps .n { flex: none; width: 30px; height: 30px; border-radius: 50%; background: var(--sage-deep);
                color: #fff; font-weight: 800; font-size: 12pt; display: flex; align-items: center;
                justify-content: center; }
  ol.steps h4 { font-size: 13pt; font-weight: 800; margin: 4px 0 2px; }
  ol.steps p { font-size: 11.5pt; line-height: 1.42; color: var(--muted); }
  .chip { display: inline-block; white-space: nowrap; background: var(--sage-soft); color: var(--sage-deep);
          border: 1px solid var(--sage-line); border-radius: 999px; padding: 0 8px; font-size: 11pt;
          font-weight: 700; line-height: 1.45; }

  figure { flex: none; display: flex; flex-direction: column; }
  figcaption { font-size: 11pt; line-height: 1.4; color: var(--muted); margin-top: 10px; }
  .fig-board { width: 5.2in; }
  .fig-phone { width: 1.9in; }

  /* Fixed boxes sized to the expected screenshots: ~1440x1000 desktop, ~400x800 phone. */
  .shot { position: relative; background: var(--paper); border: 1px solid var(--line); border-radius: 14px;
          box-shadow: 0 8px 22px rgba(38,53,46,.10); overflow: hidden; padding: 5px; }
  .shot img { display: block; width: 100%; height: 100%; object-fit: contain; border-radius: 9px; }
  .shot.board { width: 5.2in; height: 3.62in; }
  .shot.phone { width: 1.9in; height: 3.8in; border-radius: 18px; }
  .shot.phone.placeholder { padding: 8px; }
  .shot.placeholder { background: rgba(255,255,255,.45); border: 2px dashed var(--sage-line); box-shadow: none;
                      display: flex; align-items: center; justify-content: center; text-align: center; padding: 14px; }
  .shot.placeholder strong { display: block; font-size: 12.5pt; font-weight: 700; color: var(--sage-deep); }
  .shot.placeholder .ph-path { display: block; margin-top: 5px; font-size: 9.5pt; color: var(--faint);
                               font-family: 'DejaVu Sans Mono', Menlo, Consolas, monospace; }

  /* slide 3: cases table */
  .tablewrap { flex: 1; align-self: flex-start; background: var(--paper); border: 1px solid var(--line);
               border-radius: 14px; overflow: hidden; box-shadow: 0 1px 10px rgba(38,53,46,.05); }
  table.cases { width: 100%; border-collapse: collapse; }
  .cases th { text-align: left; font-size: 11pt; font-weight: 800; letter-spacing: .03em; color: var(--sage-deep);
              background: var(--sage-soft); padding: 8px 14px; }
  .cases td { font-size: 11pt; line-height: 1.36; color: var(--muted); padding: 7px 14px;
              border-top: 1px solid var(--line); vertical-align: top; }
  .cases td.if { width: 24%; font-weight: 700; color: var(--ink); }
  .cases td.said { width: 27%; font-style: italic; color: var(--clay); }
  .btn { display: inline-block; white-space: nowrap; border: 1px solid var(--sage-line); background: var(--sage-soft);
         color: var(--sage-deep); border-radius: 6px; padding: 0 6px; font-size: 11pt; font-weight: 700; line-height: 1.4; }

  /* slide 4: panels */
  .cols.two > .panel { flex: 1; }
  .panel { background: var(--paper); border: 1px solid var(--line); border-radius: 16px; padding: 20px 24px;
           box-shadow: 0 1px 10px rgba(38,53,46,.05); }
  .panel h3 { font-size: 15pt; font-weight: 800; margin-bottom: 14px; }
  .panel.real { border-top: 6px solid var(--sage); }
  .panel.sim { border-top: 6px solid var(--clay); }
  ul.ticks, ul.rings { list-style: none; }
  ul.ticks li, ul.rings li { font-size: 12pt; line-height: 1.42; padding-left: 28px; position: relative; }
  ul.ticks li + li, ul.rings li + li { margin-top: 9px; }
  ul.ticks li::before { content: ''; position: absolute; left: 4px; top: .22em; width: 6px; height: 11px;
                        border: solid var(--sage-deep); border-width: 0 2.5px 2.5px 0; transform: rotate(45deg); }
  ul.rings li::before { content: ''; position: absolute; left: 2px; top: .4em; width: 9px; height: 9px;
                        border-radius: 50%; border: 2px solid var(--clay); }
  ul.rings strong { font-weight: 800; }

  /* slide 5 */
  .cols.three { display: grid; grid-template-columns: 1.05fr 1fr 1fr; gap: 0.26in; margin-top: 0.28in; }
  .cols.three > .panel { padding: 20px 26px; }
  .cols.three h3 { font-size: 16pt; margin-bottom: 16px; }
  ol.nums { list-style: none; counter-reset: n; }
  ol.nums li { counter-increment: n; position: relative; padding-left: 40px; font-size: 13pt; line-height: 1.42;
               min-height: 28px; }
  ol.nums li + li { margin-top: 15px; }
  ol.nums li::before { content: counter(n); position: absolute; left: 0; top: -1px; width: 27px; height: 27px;
                       border-radius: 50%; background: var(--sage-soft); color: var(--sage-deep); font-weight: 800;
                       font-size: 11pt; line-height: 27px; text-align: center; }
  .panel.warm { background: var(--clay-soft); border-color: var(--clay-line); }
  .decision + .decision { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--clay-line); }
  .decision h4 { font-size: 13.5pt; font-weight: 800; margin-bottom: 5px; }
  .decision p { font-size: 12.5pt; line-height: 1.42; color: var(--muted); }
  .measure { display: flex; flex-direction: column; gap: 2px; }
  .measure + .measure { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
  .measure b { font-size: 13.5pt; font-weight: 800; color: var(--sage-deep); }
  .measure span { font-size: 12.5pt; line-height: 1.38; color: var(--muted); }
  .banner.quote { flex-direction: column; align-items: flex-start; gap: 7px; padding: 18px 28px; margin-top: 0.28in; }
  .banner.quote .lbl { font-size: 11pt; font-weight: 800; letter-spacing: .07em; text-transform: uppercase; opacity: .85; }
  .banner.quote p { font-size: 15pt; font-weight: 600; line-height: 1.4; }

  .foot { position: absolute; left: 0.75in; right: 0.75in; bottom: 0.3in; display: flex; justify-content: space-between;
          align-items: center; padding-top: 0.09in; border-top: 1px solid var(--line);
          font-size: 10pt; font-weight: 600; color: var(--faint); }
  .foot .mark { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--sage);
                margin-right: 8px; vertical-align: 1px; }
`;

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Juniper Salon · Waitlist openings</title>
<style>${css}</style>
</head><body>
${slides.map((inner, i) => `<section class="slide">${inner}
  <div class="foot"><span><span class="mark"></span>Juniper Salon · Waitlist openings</span><span>${i + 1} / ${slides.length}</span></div>
</section>`).join('\n')}
</body></html>`;

writeFileSync(HTML_OUT, html);

// ---------------------------------------------------------------- render ---

const chromium = loadChromium();
const browser = await chromium.launch(existsSync(CHROME) ? { executablePath: CHROME } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.emulateMedia({ media: 'print' });
  await page.goto(pathToFileURL(HTML_OUT).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  const problems = await page.evaluate(() => {
    const out = [];
    const MIN_PX = 11 * 96 / 72 - 0.05; // 11pt
    const BOXES = '.cols, .grid3, .card, .panel, .banner, .tablewrap, table, figure, .shot, ol, ul';
    document.querySelectorAll('.slide').forEach((slide, i) => {
      const s = slide.getBoundingClientRect();
      const footTop = slide.querySelector('.foot').getBoundingClientRect().top;
      for (const el of slide.querySelectorAll('*')) {
        if (el.closest('.foot')) continue;
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        const name = `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).trim().replace(/\s+/g, '.') : ''}`;
        if (r.bottom > footTop - 8) out.push(`slide ${i + 1}: ${name} reaches ${Math.round(r.bottom - s.top)}px, footer line at ${Math.round(footTop - s.top)}px`);
        if (r.left < s.left + 60 || r.right > s.right - 60) out.push(`slide ${i + 1}: ${name} runs into the side margin`);
        const cs = getComputedStyle(el);
        // Layout boxes only: text lines and decorative connectors may poke out by a few px by design.
        if (el.matches(BOXES) && el.clientHeight && el.scrollHeight > el.clientHeight + 2) {
          out.push(`slide ${i + 1}: ${name} content is ${el.scrollHeight - el.clientHeight}px taller than its box`);
        }
        const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (hasText && !el.closest('.ph-path') && parseFloat(cs.fontSize) < MIN_PX) out.push(`slide ${i + 1}: ${name} text is ${cs.fontSize}, under 11pt`);
      }
    });
    return out;
  });

  await page.pdf({ path: PDF_OUT, width: '13.333in', height: '7.5in', printBackground: true, preferCSSPageSize: true });

  console.log(`Wrote ${HTML_OUT}`);
  console.log(`Wrote ${PDF_OUT}`);
  for (const [rel, label] of [['img/staff-board.png', 'staff board'], ['img/client-phone.png', 'client phone']]) {
    console.log(`  ${label}: ${existsSync(join(HERE, rel)) ? 'screenshot embedded' : 'placeholder (add ' + rel + ')'}`);
  }
  if (problems.length) {
    console.log(`Layout check found ${problems.length} problem(s):`);
    for (const p of problems) console.log('  - ' + p);
    process.exitCode = 1;
  } else {
    console.log('Layout check: every slide fits its page.');
  }
} finally {
  await browser.close();
}
