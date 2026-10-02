// Returns the signed-in user's open Basecamp assignments.
const L = require("../_lib");

function slim(a) {
  return {
    id: a.id, type: a.type, content: a.content, due_on: a.due_on || null, starts_on: a.starts_on || null,
    project: a.bucket && a.bucket.name, list: a.parent && a.parent.title, url: a.app_url,
    steps: (a.children || []).length
  };
}

module.exports = async (req, res) => {
  if (!L.configured()) return L.send(res, 200, { configured: false });
  const user = await L.planUser(req);
  if (!user) return L.send(res, 401, { error: "Sign in to the planner first." });
  try {
    const link = await L.loadLink(user);
    if (!link) return L.send(res, 200, { configured: true, connected: false });
    if (link.expired) return L.send(res, 200, { configured: true, connected: false, reason: "expired" });
    const data = await L.bc(link, "GET", "/my/assignments.json");
    const pri = (data.priorities || []).map(a => ({ ...slim(a), upNext: true }));
    const rest = (data.non_priorities || []).map(slim);
    L.send(res, 200, { configured: true, connected: true, account: link.accountName, items: [...pri, ...rest] });
  } catch (e) {
    if (e.status === 401) return L.send(res, 200, { configured: true, connected: false, reason: "expired" });
    if (e.status === 429) return L.send(res, 200, { configured: true, connected: true, busy: true, items: null });
    L.send(res, 502, { error: "Couldn't reach Basecamp. Try again in a minute." });
  }
};
