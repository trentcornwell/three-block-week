// Starts "Connect Basecamp": returns the Basecamp sign-in address for the signed-in planner user.
const L = require("../_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return L.send(res, 405, { error: "Use POST" });
  if (!L.configured()) return L.send(res, 200, { configured: false });
  const user = await L.planUser(req);
  if (!user) return L.send(res, 401, { error: "Sign in to the planner first." });
  const state = L.signState({ uid: user.id, exp: Date.now() + 10 * 60 * 1000 });
  const q = new URLSearchParams({ response_type: "code", client_id: L.BC_ID, redirect_uri: L.redirectUri(req), state });
  L.send(res, 200, { configured: true, url: `${L.LAUNCHPAD}/authorization/new?${q}` });
};
