/**
 * probe default branches of the candidate repos (zero cost, plain HTTPS through the proxy).
 */
const https = require("https");
const repos = [
  "HighCry/Gemini-Next-Web",
  "HighCry/ai-novel",
  "HighCry/gemini-pro-chat",
  "HighCry/ehs-portfolio-control",
  "HighCry/ehs-onedesk",
  "HighCry/demo-EHS",
];

function get(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const r = https.request(
      { host: u.hostname, path: u.pathname + u.search, method: "GET", headers: { "user-agent": "pod-probe", accept: "application/vnd.github+json" } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ s: res.statusCode, b: Buffer.concat(c).toString("utf8") })); }
    );
    r.on("error", (e) => resolve({ s: 0, b: e.message }));
    r.end();
  });
}

(async () => {
  for (const repo of repos) {
    const r = await get("https://api.github.com/repos/" + repo);
    let j = {};
    try { j = JSON.parse(r.b); } catch {}
    if (r.s === 200) {
      console.log(`${repo.padEnd(32)} default_branch=${j.default_branch}  private=${j.private}  size=${j.size}`);
    } else {
      console.log(`${repo.padEnd(32)} HTTP ${r.s} ${(j.message || r.b).slice(0, 60)}`);
    }
  }
})();
