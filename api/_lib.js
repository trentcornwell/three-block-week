// Shared helpers for the Basecamp connection (files starting with "_" are not routes on Vercel).
const crypto = require("node:crypto");

const SB_URL = process.env.SUPABASE_URL || "https://roaxulhdehqwqcjefxce.supabase.co";
const SB_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_Pg7EXQgFfUdYuWfLA1gImg_-1IsPOGw";
const BC_ID = process.env.BASECAMP_CLIENT_ID || "";
const BC_SECRET = process.env.BASECAMP_CLIENT_SECRET || "";
const UA = "Three-Block Week (https://three-block-week.vercel.app)";
const LAUNCHPAD = "https://launchpad.37signals.com";

const configured = () => !!(BC_ID && BC_SECRET);

function origin(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}
const redirectUri = req => `${origin(req)}/api/basecamp/callback`;

const b64u = buf => Buffer.from(buf).toString("base64url");
function key(info) {
  return Buffer.from(crypto.hkdfSync("sha256", BC_SECRET, "three-block-week", info, 32));
}

// Encrypted, user-bound token bundle. Only this server can read it.
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key("basecamp-link-v1"), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return b64u(Buffer.concat([iv, c.getAuthTag(), ct]));
}
function open(blob) {
  const raw = Buffer.from(String(blob || ""), "base64url");
  if (raw.length < 29) throw new Error("bad link");
  const d = crypto.createDecipheriv("aes-256-gcm", key("basecamp-link-v1"), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
}

// Signed, short-lived "state" so the Basecamp callback knows which planner user started it.
function signState(obj) {
  const body = b64u(JSON.stringify(obj));
  const mac = b64u(crypto.createHmac("sha256", key("state-v1")).update(body).digest());
  return `${body}.${mac}`;
}
function readState(s) {
  const [body, mac] = String(s || "").split(".");
  if (!body || !mac) return null;
  const want = b64u(crypto.createHmac("sha256", key("state-v1")).update(body).digest());
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  const obj = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  return obj.exp > Date.now() ? obj : null;
}

function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}
// Confirms the caller is a signed-in planner user; returns {id, email, jwt} or null.
async function planUser(req) {
  const jwt = bearer(req);
  if (!jwt) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${jwt}` } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? { id: u.id, email: u.email, jwt } : null;
}
// Talks to the database as the signed-in user, so its security rules still apply.
async function rest(user, method, path, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${user.jwt}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error(`database ${r.status}`);
  return method === "GET" ? r.json() : null;
}

async function tokenRequest(params) {
  const r = await fetch(`${LAUNCHPAD}/authorization/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams({ client_id: BC_ID, client_secret: BC_SECRET, ...params })
  });
  if (!r.ok) throw Object.assign(new Error(`token ${r.status}`), { status: r.status });
  return r.json();
}

// Loads the caller's Basecamp link, refreshing the access token when it is close to expiring.
async function loadLink(user) {
  const rows = await rest(user, "GET", `basecamp_links?select=blob&user_id=eq.${encodeURIComponent(user.id)}`);
  if (!rows.length) return null;
  let link;
  try { link = open(rows[0].blob); } catch (e) { return null; }
  if (link.uid !== user.id) return null;
  if (!link.exp || link.exp - Date.now() < 2 * 24 * 3600 * 1000) {
    try {
      const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: link.refresh });
      link.access = t.access_token;
      if (t.refresh_token) link.refresh = t.refresh_token;
      link.exp = Date.now() + (t.expires_in || 1209600) * 1000;
      await rest(user, "PATCH", `basecamp_links?user_id=eq.${encodeURIComponent(user.id)}`, { blob: seal(link), updated_at: new Date().toISOString() });
    } catch (e) {
      if (e.status === 400 || e.status === 401) return { expired: true };
      throw e;
    }
  }
  return link;
}

async function bc(link, method, path, body) {
  const url = /^https:/.test(path) ? path : `https://3.basecampapi.com/${link.account}${path}`;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${link.access}`, "User-Agent": UA, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 404) throw Object.assign(new Error("basecamp 404"), { status: 404 });
  if (r.status === 401) throw Object.assign(new Error("basecamp auth"), { status: 401 });
  if (r.status === 429) throw Object.assign(new Error("basecamp busy"), { status: 429 });
  if (!r.ok) throw Object.assign(new Error(`basecamp ${r.status}`), { status: r.status });
  return r.status === 204 ? null : r.json().catch(() => null);
}

// Key the weekly-plan publisher uses to read the staff week (derived here; never leaves the server).
const publishKey = () => b64u(key("publish-v1"));

// Calls a database function. With a user it runs as that user; without one it runs as the public role.
async function rpc(fn, args, user) {
  const headers = { apikey: SB_KEY, "Content-Type": "application/json" };
  if (user) headers.Authorization = `Bearer ${user.jwt}`;
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args || {}) });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`database ${r.status}: ${text.slice(0, 200)}`), { status: r.status });
  return text ? JSON.parse(text) : null;
}

// Refreshes a link's access token when it is close to expiring. Returns true if it changed.
async function refreshIfNeeded(link) {
  if (link.exp && link.exp - Date.now() >= 2 * 24 * 3600 * 1000) return false;
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: link.refresh });
  link.access = t.access_token;
  if (t.refresh_token) link.refresh = t.refresh_token;
  link.exp = Date.now() + (t.expires_in || 1209600) * 1000;
  return true;
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

module.exports = { SB_URL, LAUNCHPAD, BC_ID, UA, configured, redirectUri, origin, seal, open, signState, readState, planUser, rest, tokenRequest, loadLink, bc, send, publishKey, rpc, refreshIfNeeded };
