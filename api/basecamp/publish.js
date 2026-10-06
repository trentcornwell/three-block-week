// Posts the staff's week to a Basecamp project as one document per week (Docs & Files).
//   GET  (daily schedule)              -> refresh this week's document (and next week's on weekends)
//   POST {action:"projects"}           -> list the caller's Basecamp projects
//   POST {action:"setup", project}     -> turn posting on into that project, using the caller's Basecamp
//   POST {action:"run", week?}         -> refresh now (any staff member)
//   POST {action:"off"}                -> stop posting
const crypto = require("node:crypto");
const L = require("../_lib");

const BLOCKS = [["m", "Morning"], ["a", "Afternoon"], ["e", "Evening"]];
const TYPE = { office: "Work · Office", remote: "Work · Remote", education: "Education", church: "Church", family: "Family", rest: "Rest" };
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TZ = "America/New_York";

const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (k, n) => { const d = new Date(k + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const dt = k => new Date(k + "T12:00:00Z");
function todayNY() { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function mondayOf(k) { const d = dt(k); return addDays(k, -((d.getUTCDay() + 6) % 7)); }
function fmtTime(t) { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; }
const label = k => { const d = dt(k); return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
function rangeTitle(ws) {
  const a = dt(ws), b = dt(addDays(ws, 6));
  return a.getUTCMonth() === b.getUTCMonth() ? `${MON[a.getUTCMonth()]} ${a.getUTCDate()} – ${b.getUTCDate()}` : `${MON[a.getUTCMonth()]} ${a.getUTCDate()} – ${MON[b.getUTCMonth()]} ${b.getUTCDate()}`;
}
const byTime = list => [...list.filter(i => i.time).sort((x, y) => (x.time < y.time ? -1 : 1)), ...list.filter(i => !i.time)];

// Builds the Basecamp document body. Basecamp allows only simple tags (div, h1, strong, em, br, ul, ol, li, blockquote, a).
function render(ws, data) {
  const days = {}; for (const d of data.days || []) (days[d.user_id] || (days[d.user_id] = {}))[String(d.date).slice(0, 10)] = d.data;
  const pri = {}; for (const w of data.weeks || []) pri[w.user_id] = (w.data && w.data.priorities) || [];
  const dates = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const people = (data.people || []).filter(p => days[p.id] || (pri[p.id] || []).length);
  let html = `<div><em>Each person's three blocks for every day this week, with their objectives and events. Personal tasks stay in the planner. Open the planner to make changes: <a href="https://three-block-week.vercel.app">three-block-week.vercel.app</a></em></div>`;
  if (!people.length) return html + `<div><br>Nobody has planned this week yet.</div>`;
  for (const p of people) {
    const mine = days[p.id] || {};
    const counts = {};
    const lines = [];
    for (const k of dates) {
      const day = mine[k]; if (!day || !day.blocks) continue;
      const parts = [], notes = [];
      for (const [b, bl] of BLOCKS) {
        const blk = day.blocks[b] || {};
        const conts = blk.split ? (blk.halves || []) : [blk];
        const names = conts.map(c => c.mode && TYPE[c.mode]).filter(Boolean);
        conts.forEach(c => { if (c.mode) counts[c.mode] = (counts[c.mode] || 0) + (blk.split ? 0.5 : 1); });
        if (names.length) parts.push(`${bl}: ${names.join(" / ")}`);
        for (const c of conts) {
          const items = byTime((c.items || []).filter(i => i.kind === "event" || i.kind === "obj" || i.kind === "break"));
          for (const i of items) {
            const t = i.time ? `${fmtTime(i.time)} ` : "";
            if (i.kind === "event") notes.push(`${bl}: ${t}${esc(i.text)}`);
            else if (i.kind === "break") notes.push(`${bl}: Break (${esc(i.text || "errand")})`);
            else {
              const n = (i.tasks || []).length, done = (i.tasks || []).filter(x => x.done).length;
              notes.push(`${bl}: <strong>${esc(i.text)}</strong>${n ? ` (${done}/${n} done)` : ""}`);
            }
          }
        }
      }
      if (!parts.length && !notes.length) continue;
      lines.push(`<li><strong>${label(k)}</strong> — ${parts.join(" · ") || "Not planned"}${notes.length ? `<ul>${notes.map(n => `<li>${n}</li>`).join("")}</ul>` : ""}</li>`);
    }
    const tally = ["rest", "family", "office", "remote", "education", "church"].filter(m => counts[m]).map(m => `${TYPE[m]} ${counts[m]}`).join(" · ");
    html += `<h1>${esc(p.name || p.email || "Staff member")}</h1>`;
    if ((pri[p.id] || []).length) html += `<div><strong>Priorities this week</strong></div><ol>${pri[p.id].map(x => `<li>${esc(x.text)}</li>`).join("")}</ol>`;
    if (tally) html += `<div><em>Blocks: ${tally}</em></div>`;
    html += lines.length ? `<ul>${lines.join("")}</ul>` : `<div>Nothing planned yet.</div>`;
  }
  return html;
}

async function getLink(data, s) {
  if (!data.blob) throw Object.assign(new Error(`${s.publisher_name || "The person who set this up"} needs to reconnect Basecamp in the planner.`), { code: "nolink" });
  let link;
  try { link = L.open(data.blob); } catch (e) { throw Object.assign(new Error("The Basecamp connection couldn't be read. Reconnect Basecamp and set up posting again."), { code: "nolink" }); }
  if (link.uid !== s.publisher) throw Object.assign(new Error("The Basecamp connection doesn't match. Set up posting again."), { code: "nolink" });
  let changed = false;
  try { changed = await L.refreshIfNeeded(link); }
  catch (e) { throw Object.assign(new Error(`${s.publisher_name || "The publisher"}'s Basecamp connection expired. Reconnect Basecamp in the planner.`), { code: "nolink" }); }
  return { link, newBlob: changed ? L.seal(link) : null };
}

// ---------- Schedule entries: one per block, plus one per event ----------
const SPAN = { m: ["08:00", "12:00"], a: ["12:00", "16:00"], e: ["16:00", "20:00"] };
function nyISO(date, hm) {
  // Offset for that day in New York (handles daylight saving).
  const probe = new Date(`${date}T12:00:00Z`);
  const off = (new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(probe).find(x => x.type === "timeZoneName") || {}).value || "GMT-05:00";
  const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(off);
  return `${date}T${hm}:00${m ? `${m[1]}:${m[2] || "00"}` : "-05:00"}`;
}
function addHour(hm) { const [h, m] = hm.split(":").map(Number); const t = Math.min(h * 60 + m + 60, 23 * 60 + 59); return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; }
function first(name) { return String(name || "Staff").trim(); }

function desiredEntries(ws, data, peopleIds) {
  const want = {};
  const names = Object.fromEntries((data.people || []).map(p => [p.id, first(p.name || p.email)]));
  for (const d of data.days || []) {
    if (!names[d.user_id]) continue;
    const date = String(d.date).slice(0, 10), day = d.data || {}, who = names[d.user_id];
    const pids = peopleIds[d.user_id] ? [peopleIds[d.user_id]] : [];
    for (const [b, bl] of BLOCKS) {
      const blk = (day.blocks || {})[b]; if (!blk) continue;
      const conts = blk.split ? (blk.halves || []) : [blk];
      const modes = conts.map(c => c.mode && TYPE[c.mode]).filter(Boolean);
      const objs = conts.flatMap(c => (c.items || []).filter(i => i.kind === "obj").map(i => i.text));
      if (modes.length) {
        want[`b:${d.user_id}:${date}:${b}`] = {
          summary: `${who} · ${bl}: ${modes.join(" / ")}`,
          starts_at: nyISO(date, SPAN[b][0]), ends_at: nyISO(date, SPAN[b][1]),
          description: objs.length ? `<div><strong>Objectives</strong></div><ul>${objs.map(o => `<li>${esc(o)}</li>`).join("")}</ul>` : "",
          participant_ids: pids
        };
      }
      for (const c of conts) for (const i of (c.items || []).filter(x => x.kind === "event")) {
        const st = i.time || SPAN[b][0], en = i.time ? addHour(i.time) : SPAN[b][1];
        want[`e:${d.user_id}:${i.id}`] = { summary: `${who} · ${i.text}`, starts_at: nyISO(date, st), ends_at: nyISO(date, en), description: "", participant_ids: pids };
      }
    }
  }
  return want;
}
const sig = e => crypto.createHash("sha256").update(JSON.stringify(e)).digest("hex").slice(0, 12);

async function basecampPeopleIds(link, s, data) {
  const out = {};
  try {
    const ppl = await L.bc(link, "GET", `/projects/${s.bucket_id}/people.json`);
    const byEmail = Object.fromEntries((ppl || []).map(p => [String(p.email_address || "").toLowerCase(), p.id]));
    for (const p of data.people || []) { const id = byEmail[String(p.email || "").toLowerCase()]; if (id) out[p.id] = id; }
  } catch (e) { /* participants are optional */ }
  return out;
}

async function scheduleId(link, s) {
  const p = await L.bc(link, "GET", `/projects/${s.bucket_id}.json`);
  const d = (p.dock || []).find(x => x.name === "schedule" && x.enabled !== false);
  return d ? d.id : null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Brings the project's Schedule in line with the planner. Saves progress as it goes back into `have`.
async function syncSchedule(link, s, want, have, deadline) {
  const sched = await scheduleId(link, s);
  if (!sched) return { note: "That project's Schedule is turned off, so only the document was updated." };
  let n = 0;
  const call = async (m, path, body) => { if (Date.now() > deadline) throw Object.assign(new Error("later"), { code: "later" }); n++; if (n > 1) await sleep(220); return L.bc(link, m, path, body); };
  try {
    for (const [k, e] of Object.entries(want)) {
      const sg = sig(e), cur = have[k];
      if (cur && cur.s === sg) continue;
      const body = { summary: e.summary, starts_at: e.starts_at, ends_at: e.ends_at, description: e.description, participant_ids: e.participant_ids, all_day: false, notify: false };
      let out = null;
      if (cur && cur.id) {
        try { out = await call("PUT", `/buckets/${s.bucket_id}/schedule_entries/${cur.id}.json`, body); }
        catch (err) { if (err.status !== 404 && err.status !== 403) throw err; }
      }
      if (!out) out = await call("POST", `/buckets/${s.bucket_id}/schedules/${sched}/entries.json`, body);
      have[k] = { id: out.id, s: sg };
    }
    for (const k of Object.keys(have)) {
      if (want[k]) continue;
      try { await call("PUT", `/buckets/${s.bucket_id}/recordings/${have[k].id}/status/trashed.json`); }
      catch (err) { if (err.status !== 404 && err.status !== 403) throw err; }
      delete have[k];
    }
  } catch (err) {
    if (err.code === "later" || err.status === 429) return { partial: true };
    throw err;
  }
  return {};
}

// Creates or updates the document and the schedule entries for one week.
async function publishWeek(ws, force) {
  const started = Date.now();
  const key = L.publishKey();
  const data = await L.rpc("publish_data", { p_key: key, p_week: ws });
  const s = data.settings || {};
  if (!s.enabled) return { skipped: "off" };
  const prev = (s.docs || {})[ws] || null;
  let newBlob = null, doc = prev ? { ...prev, entries: { ...(prev.entries || {}) } } : { entries: {} }, err = null, info = {};
  try {
    const got = await getLink(data, s); newBlob = got.newBlob; const link = got.link;
    if (String(link.account) !== String(s.account_id)) throw new Error("Your Basecamp account changed. Set up posting again.");
    const body = render(ws, data);
    const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);
    const title = `Staff week · ${rangeTitle(ws)}`;
    if (!(doc.id && doc.hash === hash && !force)) {
      let out = null;
      if (doc.id) {
        try { out = await L.bc(link, "PUT", `/buckets/${s.bucket_id}/documents/${doc.id}.json`, { title, content: body }); }
        catch (e) { if (e.status !== 404 && e.status !== 403) throw e; out = null; }
      }
      if (!out) out = await L.bc(link, "POST", `/buckets/${s.bucket_id}/vaults/${s.vault_id}/documents.json`, { title, content: body, status: "active" });
      doc.id = out.id; doc.url = out.app_url; doc.hash = hash; doc.at = new Date().toISOString();
    }
    // Schedule: skip the Basecamp calls entirely when nothing changed since last time.
    const ids = await basecampPeopleIds(link, s, data);
    const want = desiredEntries(ws, data, ids);
    const wantHash = sig(Object.fromEntries(Object.entries(want).map(([k, e]) => [k, sig(e)])));
    if (doc.sched !== wantHash || force) {
      try { info = await syncSchedule(link, s, want, doc.entries, started + 45000); }
      catch (e) { info = { note: `Couldn't update the Schedule (Basecamp said ${e.status || e.message}). Will try again.` }; }
      if (!info.partial && !info.note) doc.sched = wantHash; else delete doc.sched;
    }
  } catch (e) {
    err = e.code === "nolink" || !e.status ? e.message : e.status === 403 || e.status === 404 ? "Basecamp wouldn't let this account post to that project. Check access, or set up posting again." : `Basecamp said ${e.status}. Will try again.`;
  }
  // Always save entry ids we created, even after an error, so nothing is duplicated next time.
  const save = doc.id || Object.keys(doc.entries).length ? doc : null;
  await L.rpc("publish_save", { p_key: key, p_week: save ? ws : null, p_doc: save, p_error: err || info.note || null, p_blob: newBlob });
  if (err) return { error: err };
  return { url: doc.url, ...(info.partial ? { more: true } : {}), ...(info.note ? { note: info.note } : {}) };
}

async function listProjects(link) {
  const out = []; let url = "/projects.json";
  for (let i = 0; i < 6 && url; i++) {
    const r = await fetch(/^https:/.test(url) ? url : `https://3.basecampapi.com/${link.account}${url}`, { headers: { Authorization: `Bearer ${link.access}`, "User-Agent": L.UA, Accept: "application/json" } });
    if (!r.ok) throw Object.assign(new Error(`basecamp ${r.status}`), { status: r.status });
    for (const p of await r.json()) {
      const vault = (p.dock || []).find(d => d.name === "vault" && d.enabled !== false);
      if (vault) out.push({ id: p.id, name: p.name, vault: vault.id });
    }
    const m = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get("link") || "");
    url = m ? m[1] : null;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise(res => { let d = ""; req.on("data", c => (d += c)); req.on("end", () => { try { res(JSON.parse(d || "{}")); } catch (e) { res({}); } }); });
}

module.exports = async (req, res) => {
  if (!L.configured()) return L.send(res, 200, { configured: false });
  try {
    if (req.method === "GET") {
      // Daily schedule: this week, plus next week from Friday on.
      const today = todayNY(), ws = mondayOf(today);
      const results = { [ws]: await publishWeek(ws) };
      const dow = dt(today).getUTCDay();
      if (dow === 5 || dow === 6 || dow === 0) { const nx = addDays(ws, 7); results[nx] = await publishWeek(nx); }
      return L.send(res, 200, results);
    }
    if (req.method !== "POST") return L.send(res, 405, { error: "Use POST" });
    const user = await L.planUser(req);
    if (!user) return L.send(res, 401, { error: "Sign in to the planner first." });
    const b = await readBody(req);
    if (b.action === "projects" || b.action === "setup") {
      const link = await L.loadLink(user);
      if (!link || link.expired) return L.send(res, 200, { connected: false });
      const projects = await listProjects(link);
      if (b.action === "projects") return L.send(res, 200, { connected: true, projects });
      const p = projects.find(x => String(x.id) === String(b.project));
      if (!p) return L.send(res, 400, { error: "Pick a project you can post to." });
      const rows = await L.rest(user, "GET", `profiles?select=name&id=eq.${encodeURIComponent(user.id)}`);
      await L.rpc("publish_setup", { p_key: L.publishKey(), p_account: String(link.account), p_bucket: String(p.id), p_vault: String(p.vault), p_project: p.name, p_name: (rows[0] && rows[0].name) || user.email }, user);
      const ws = mondayOf(todayNY());
      return L.send(res, 200, { ok: true, result: await publishWeek(ws, true) });
    }
    if (b.action === "off") { await L.rpc("publish_off", {}, user); return L.send(res, 200, { ok: true }); }
    if (b.action === "run") {
      const cur = mondayOf(todayNY());
      const ws = /^\d{4}-\d{2}-\d{2}$/.test(b.week || "") ? mondayOf(b.week) : cur;
      if (ws < cur || ws > addDays(cur, 7)) return L.send(res, 200, { skipped: "only this week and next are posted" });
      return L.send(res, 200, await publishWeek(ws, !!b.force));
    }
    L.send(res, 400, { error: "Unknown action" });
  } catch (e) {
    if (/bad key/.test(e.message)) return L.send(res, 200, { skipped: "not set up" });
    if (/publish_data|function/.test(e.message) && e.status === 404) return L.send(res, 200, { skipped: "database not updated yet" });
    console.error(e);
    L.send(res, 502, { error: e.status === 401 ? "Your Basecamp connection expired. Reconnect Basecamp." : "Couldn't reach Basecamp. Try again in a minute." });
  }
};
