// Checks off (or reopens) a Basecamp to-do for the signed-in user.
const L = require("../_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return L.send(res, 405, { error: "Use POST" });
  if (!L.configured()) return L.send(res, 200, { configured: false });
  const user = await L.planUser(req);
  if (!user) return L.send(res, 401, { error: "Sign in to the planner first." });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const id = Number(body.id);
  if (!Number.isSafeInteger(id) || id <= 0) return L.send(res, 400, { error: "Missing to-do." });
  try {
    const link = await L.loadLink(user);
    if (!link || link.expired) return L.send(res, 200, { connected: false });
    await L.bc(link, body.done === false ? "DELETE" : "POST", `/todos/${id}/completion.json`);
    L.send(res, 200, { ok: true });
  } catch (e) {
    if (e.status === 401) return L.send(res, 200, { connected: false });
    if (e.status === 404) return L.send(res, 404, { error: "That to-do isn't in Basecamp anymore, or it's a card rather than a to-do." });
    L.send(res, 502, { error: "Couldn't update Basecamp. Try again in a minute." });
  }
};
