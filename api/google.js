// Keeps Google Calendar connected: stores each person's Google refresh token (encrypted, tied to them)
// and hands back a fresh short-lived calendar token when the page needs one.
//   POST {action:"link", refresh}  -> save the refresh token from a Google sign-in
//   POST {action:"token"}          -> a fresh access token, or {connected:false}
//   POST {action:"unlink"}         -> forget it
const crypto = require("node:crypto");
const L = require("./_lib");

const GID = process.env.GOOGLE_CLIENT_ID || "";
const GSECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const configured = () => !!(GID && GSECRET);

const b64u = buf => Buffer.from(buf).toString("base64url");
const key = () => Buffer.from(crypto.hkdfSync("sha256", GSECRET, "three-block-week", "google-link-v1", 32));
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return b64u(Buffer.concat([iv, c.getAuthTag(), ct]));
}
function open(blob) {
  const raw = Buffer.from(String(blob || ""), "base64url");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise(res => { let d = ""; req.on("data", c => (d += c)); req.on("end", () => { try { res(JSON.parse(d || "{}")); } catch (e) { res({}); } }); });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return L.send(res, 405, { error: "Use POST" });
  if (!configured()) return L.send(res, 200, { configured: false });
  const user = await L.planUser(req);
  if (!user) return L.send(res, 401, { error: "Sign in to the planner first." });
  const b = await readBody(req);
  const path = `meta?user_id=eq.${encodeURIComponent(user.id)}&name=eq.google`;
  try {
    if (b.action === "link") {
      if (!b.refresh || typeof b.refresh !== "string") return L.send(res, 400, { error: "Missing token" });
      const row = { user_id: user.id, name: "google", data: { blob: seal({ uid: user.id, refresh: b.refresh }) }, updated_at: new Date().toISOString() };
      const r = await fetch(`${L.SB_URL}/rest/v1/meta?on_conflict=user_id,name`, {
        method: "POST",
        headers: { apikey: process.env.SUPABASE_ANON_KEY || require("../config.js").supabaseAnonKey, Authorization: `Bearer ${user.jwt}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(row)
      });
      if (!r.ok) throw new Error(`database ${r.status}`);
      return L.send(res, 200, { ok: true });
    }
    if (b.action === "unlink") { await L.rest(user, "DELETE", path); return L.send(res, 200, { ok: true }); }
    if (b.action === "token") {
      const rows = await L.rest(user, "GET", `${path}&select=data`);
      if (!rows.length || !rows[0].data || !rows[0].data.blob) return L.send(res, 200, { connected: false });
      let link; try { link = open(rows[0].data.blob); } catch (e) { return L.send(res, 200, { connected: false }); }
      if (link.uid !== user.id) return L.send(res, 200, { connected: false });
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: GID, client_secret: GSECRET, refresh_token: link.refresh, grant_type: "refresh_token" })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) {
        if (j.error === "invalid_grant") { await L.rest(user, "DELETE", path).catch(() => {}); }
        return L.send(res, 200, { connected: false });
      }
      return L.send(res, 200, { connected: true, token: j.access_token, expires_in: j.expires_in || 3600 });
    }
    L.send(res, 400, { error: "Unknown action" });
  } catch (e) {
    console.error(e);
    L.send(res, 502, { error: "Couldn't reach Google. Try again in a minute." });
  }
};
