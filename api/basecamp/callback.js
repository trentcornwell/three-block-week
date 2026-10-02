// Basecamp sends people back here after they allow access. Trades the code for tokens and hands the
// planner an encrypted bundle (in the address fragment, never sent to any server) to save to the user's row.
const L = require("../_lib");

function back(res, req, frag) {
  res.statusCode = 302;
  res.setHeader("Location", `${L.origin(req)}/#${frag}`);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

module.exports = async (req, res) => {
  const url = new URL(req.url, L.origin(req));
  if (url.searchParams.get("error")) return back(res, req, "bc-error=declined");
  const st = L.readState(url.searchParams.get("state"));
  const code = url.searchParams.get("code");
  if (!L.configured() || !st || !code) return back(res, req, "bc-error=expired");
  try {
    const t = await L.tokenRequest({ grant_type: "authorization_code", redirect_uri: L.redirectUri(req), code });
    const a = await fetch(`${L.LAUNCHPAD}/authorization.json`, { headers: { Authorization: `Bearer ${t.access_token}`, "User-Agent": L.UA } }).then(r => r.json());
    const acct = (a.accounts || []).find(x => x.product === "bc3") || (a.accounts || []).find(x => /basecampapi/.test(x.href || ""));
    if (!acct) return back(res, req, "bc-error=no-account");
    const blob = L.seal({ uid: st.uid, access: t.access_token, refresh: t.refresh_token, exp: Date.now() + (t.expires_in || 1209600) * 1000, account: acct.id, accountName: acct.name });
    back(res, req, `bc-link=${blob}&bc-name=${encodeURIComponent(acct.name || "Basecamp")}`);
  } catch (e) {
    back(res, req, "bc-error=failed");
  }
};
