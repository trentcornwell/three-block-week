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

// What each person chose to share: blocks and items they checked "BC" on, in time order.
function sharedFor(day) {
  const out = [];
  for (const [b, bl] of BLOCKS) {
    const blk = (day.blocks || {})[b]; if (!blk) continue;
    const conts = blk.split ? (blk.halves || []) : [blk];
    const modes = conts.map(c => c.mode && TYPE[c.mode]).filter(Boolean);
    if (blk.share && modes.length) out.push({ key: `b:${b}`, b, bl, kind: "block", text: `${bl}: ${modes.join(" / ")}` });
    for (const c of conts) for (const i of c.items || []) {
      if (i.share && (i.kind === "event" || i.kind === "obj" || i.kind === "task" || !i.kind)) out.push({ key: `i:${i.id}`, b, bl, kind: i.kind || "task", text: i.text, time: i.kind === "event" ? i.time : null });
      if (i.kind === "obj") for (const t of i.tasks || []) if (t.share) out.push({ key: `i:${t.id}`, b, bl, kind: "task", text: t.text, time: null });
    }
  }
  return out;
}

// Builds the Basecamp document body. Basecamp allows only simple tags (div, h1, strong, em, br, ul, ol, li, blockquote, a).
function render(ws, data) {
  const days = {}; for (const d of data.days || []) (days[d.user_id] || (days[d.user_id] = {}))[String(d.date).slice(0, 10)] = d.data;
  const dates = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  let html = `<div><em>What each staff member chose to share from their week. ${L.SITE ? `Open the planner to make changes: <a href="${L.SITE}">${L.SITE.replace(/^https:\/\//, "")}</a>` : ""}</em></div>`;
  let any = false;
  for (const p of data.people || []) {
    const mine = days[p.id] || {}, lines = [];
    for (const k of dates) {
      const day = mine[k]; if (!day) continue;
      const items = sharedFor(day); if (!items.length) continue;
      lines.push(`<li><strong>${label(k)}</strong><ul>${items.map(x => `<li>${x.kind === "block" ? `<strong>${esc(x.text)}</strong> (${HRS[x.b]})` : `${x.bl}: ${x.time ? fmtTime(x.time) + " " : ""}${esc(x.text)}`}</li>`).join("")}</ul></li>`);
    }
    if (!lines.length) continue;
    any = true;
    html += `<h1>${esc(p.name || p.email || "Staff member")}</h1><ul>${lines.join("")}</ul>`;
  }
  return any ? html : html + `<div><br>Nothing has been shared for this week yet.</div>`;
}
const HRS = { m: "8 AM – 12 PM", a: "12 – 4 PM", e: "4 – 8 PM" };

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
    const date = String(d.date).slice(0, 10), who = names[d.user_id];
    const pids = peopleIds[d.user_id] ? [peopleIds[d.user_id]] : [];
    for (const x of sharedFor(d.data || {})) {
      const st = x.time || SPAN[x.b][0], en = x.time ? addHour(x.time) : SPAN[x.b][1];
      const k = x.kind === "block" ? `b:${d.user_id}:${date}:${x.b}` : `e:${d.user_id}:${x.key.slice(2)}`;
      want[k] = { summary: `${who} · ${x.text}`, starts_at: nyISO(date, st), ends_at: nyISO(date, en), description: "", participant_ids: pids };
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
// Basecamp lists entries oldest first, so page until past the end of the week.
async function listEntries(link, s, sched, untilMs) {
  const out = []; let url = `/buckets/${s.bucket_id}/schedules/${sched}/entries.json`;
  for (let i = 0; i < 80 && url; i++) {
    const r = await fetch(/^https:/.test(url) ? url : `https://3.basecampapi.com/${link.account}${url}`, { headers: { Authorization: `Bearer ${link.access}`, "User-Agent": L.UA, Accept: "application/json" } });
    if (!r.ok) break;
    const page = await r.json();
    out.push(...page);
    if (page.length && Date.parse(page[page.length - 1].starts_at) > untilMs) break;
    const m = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get("link") || "");
    url = m ? m[1] : null;
  }
  return out;
}

async function syncSchedule(link, s, want, have, deadline, ws, names, checkpoint, sweep) {
  const sched = await scheduleId(link, s);
  if (!sched) return { note: "That project's Schedule is turned off, so only the document was updated." };
  let n = 0;
  const call = async (m, path, body) => { if (Date.now() > deadline) throw Object.assign(new Error("later"), { code: "later" }); n++; if (n > 1) await sleep(220); const out = await L.bc(link, m, path, body); if (n % 8 === 0) await checkpoint(); return out; };
  try {
    // Clean up: entries this planner made for this week that it isn't tracking (for example, duplicates).
    const me = await L.bc(link, "GET", "/my/profile.json").catch(() => null);
    if (sweep && me && names.length) {
      const known = new Set(Object.values(have).map(h => String(h.id)));
      const lo = nyISO(ws, "00:00"), hi = nyISO(addDays(ws, 7), "00:00");
      const ours = e => e.creator && e.creator.id === me.id && names.some(nm => String(e.summary || "").startsWith(nm + " · "));
      const inWeek = e => { const t = Date.parse(e.starts_at); return t >= Date.parse(lo) && t < Date.parse(hi); };
      const all = await listEntries(link, s, sched, Date.parse(hi));
      for (const e of all) {
        if (ours(e) && inWeek(e) && !known.has(String(e.id))) {
          try { await call("PUT", `/buckets/${s.bucket_id}/recordings/${e.id}/status/trashed.json`); } catch (err) { if (err.status !== 404 && err.status !== 403) throw err; }
        }
      }
    }
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
  const key = L.publishKey();
  let locked = false;
  for (let i = 0; i < 3 && !locked; i++) { locked = await L.rpc("publish_lock", { p_key: key }); if (!locked) await sleep(4000); }
  if (!locked) return { busy: true, more: true };
  try { return await publishWeekLocked(ws, force, key); }
  finally { await L.rpc("publish_unlock", { p_key: key }).catch(() => {}); }
}
async function publishWeekLocked(ws, force, key) {
  const started = Date.now();
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
    const empty = !(data.days || []).some(d => sharedFor(d.data || {}).length);
    if (empty) {
      // Nothing shared this week: no document. Move any earlier one to Basecamp's trash.
      if (doc.id) {
        try { await L.bc(link, "PUT", `/buckets/${s.bucket_id}/recordings/${doc.id}/status/trashed.json`); }
        catch (e) { if (e.status !== 404 && e.status !== 403) throw e; }
        delete doc.id; delete doc.url; delete doc.hash;
      }
    } else if (!(doc.id && doc.hash === hash && !force)) {
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
    if (doc.sched !== wantHash || force || !doc.swept) {
      const names = [...new Set((data.people || []).map(p => first(p.name || p.email)))];
      const checkpoint = () => L.rpc("publish_save", { p_key: key, p_week: ws, p_doc: doc, p_error: null, p_blob: null }).catch(() => {});
      const sweep = !doc.swept;
      try { info = await syncSchedule(link, s, want, doc.entries, started + 45000, ws, names, checkpoint, sweep); if (sweep && !info.partial && !info.note) doc.swept = true; }
      catch (e) { info = { note: `Couldn't update the Schedule (Basecamp said ${e.status || e.message}). Will try again.` }; }
      if (!info.partial && !info.note) doc.sched = wantHash; else delete doc.sched;
    }
  } catch (e) {
    err = e.code === "nolink" || !e.status ? e.message : e.status === 403 || e.status === 404 ? "Basecamp wouldn't let this account post to that project. Check access, or set up posting again." : `Basecamp said ${e.status}. Will try again.`;
  }
  // Always save entry ids we created, even after an error, so nothing is duplicated next time.
  const save = doc;
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
