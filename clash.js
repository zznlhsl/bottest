#!/usr/bin/env node
/**
 * clash.js - Clash / mihomo control for this machine (FlyClash sidecar).
 *
 * The FlyClash bundle exposes mihomo on a NAMED PIPE, not a TCP controller:
 *   \\.\pipe\flycast-mihomo-service
 * so the usual 9090/9097 REST ports are dead here. Proxy listeners: HTTP/mixed 127.0.0.1:7890,
 * SOCKS 127.0.0.1:7891.
 *
 * Commands
 *   list                 groups, current selection, and US/EU node names
 *   switch "NODE NAME"   set a node in every group that contains it
 *   region-us            pick a US node in every group that offers one (premium models need this)
 *   exit                 report the exit country and confirm api2 is reachable through it
 *   test                 just print the proxy/IP echo
 *
 * Examples
 *   node clash.js list
 *   node clash.js --switch "🇺🇸 United States | 01"
 *   node clash.js region-us
 *   node clash.js exit
 */
const net = require("net");
const http = require("http");
const http2 = require("http2");
const tls = require("tls");
const fs = require("fs");
const crypto = require("crypto");

const PIPE = "\\\\.\\pipe\\flycast-mihomo-service";
const PROXY = { host: "127.0.0.1", port: 7890 };
const SECRET_FILE = "D:\\QQ\\secrets\\webacct_session.json";

function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2), n = argv[i + 1];
      if (n !== undefined && !n.startsWith("--")) { flags[k] = n; i++; } else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}
const { pos, flags } = parseArgs(process.argv.slice(2));
const CMD = pos[0] || "help";

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/* ---------------------------------------------- HTTP/1.1 over the named pipe */
function pipeRaw(method, p, body, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const sock = net.connect(PIPE);
    let buf = Buffer.alloc(0);
    const done = (x) => { try { sock.destroy(); } catch {} resolve(x); };
    sock.setTimeout(timeoutMs, () => done({ err: "pipe timeout" }));
    sock.on("error", (e) => done({ err: e.message }));
    sock.on("connect", () => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
      sock.write(
        `${method} ${p} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n`
      );
      if (payload.length) sock.write(payload);
    });
    sock.on("data", (d) => (buf = Buffer.concat([buf, d])));
    sock.on("end", () => done({ buf }));
    sock.on("close", () => done({ buf }));
  });
}
function dechunk(body) {
  let out = Buffer.alloc(0), i = 0;
  for (;;) {
    const nl = body.indexOf("\r\n", i, "latin1");
    if (nl < 0) break;
    const size = parseInt(body.slice(i, nl).toString("latin1").trim().split(";")[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    out = Buffer.concat([out, body.slice(nl + 2, nl + 2 + size)]);
    i = nl + 2 + size + 2;
  }
  return out;
}
async function api(method, p, body) {
  const r = await pipeRaw(method, p, body);
  if (r.err) return { err: r.err };
  const text = r.buf.toString("latin1");
  const i = text.indexOf("\r\n\r\n");
  const headers = text.slice(0, i);
  let bodyBuf = r.buf.slice(i + 4);
  if (/transfer-encoding:\s*chunked/i.test(headers)) bodyBuf = dechunk(bodyBuf);
  const status = Number((headers.match(/HTTP\/1\.1 (\d+)/) || [])[1] || 0);
  let json = null;
  try { json = JSON.parse(bodyBuf.toString("utf8")); } catch {}
  return { status, json, text: bodyBuf.toString("utf8") };
}

/* --------------------------------------------------- api2 reachability check */
function connectApi2() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: PROXY.host, port: PROXY.port, method: "CONNECT",
      path: "api2.cursor.sh:443", headers: { host: "api2.cursor.sh:443" },
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error("CONNECT " + res.statusCode));
      const t = tls.connect({ socket, servername: "api2.cursor.sh", ALPNProtocols: ["h2"], rejectUnauthorized: false }, () => {
        const c = http2.connect("https://api2.cursor.sh", { createConnection: () => t });
        c.on("error", reject);
        c.on("connect", () => resolve(c));
      });
      t.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
function rpc(client, p, body) {
  const jwt = JSON.parse(fs.readFileSync(SECRET_FILE, "utf8")).jwt;
  return new Promise((resolve) => {
    const chunks = [];
    let status = 0;
    const req = client.request({
      ":method": "POST", ":path": "/" + p,
      authorization: "Bearer " + jwt,
      "content-type": "application/json",
      "connect-protocol-version": "1",
      "x-cursor-checksum": "AAAA",
      "x-ghost-mode": "false",
      "x-request-id": crypto.randomUUID(),
    });
    req.on("response", (h) => (status = Number(h[":status"] || 0)));
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { try { client.close(); } catch {} resolve({ status, raw: Buffer.concat(chunks).toString("utf8") }); });
    req.on("error", (e) => resolve({ status: 0, raw: e.message }));
    req.end(Buffer.from(JSON.stringify(body)));
    setTimeout(() => resolve({ status: 0, raw: "timeout" }), 20000);
  });
}
function ipEcho() {
  return new Promise((resolve) => {
    const q = http.request(
      { host: PROXY.host, port: PROXY.port, method: "GET", path: "http://ip-api.com/json/?fields=country,countryCode,isp,query", headers: { host: "ip-api.com" } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve(Buffer.concat(c).toString())); }
    );
    q.on("error", (e) => resolve("ERR " + e.message));
    q.end();
  });
}

const US_RE = /United States|🇺🇸|\bUS\b/i;
const EU_RE = /United Kingdom|🇬🇧|Germany|🇩🇪|Netherlands|🇳🇱|France|🇫🇷/i;

async function loadProxies() {
  const v = await api("GET", "/version");
  if (v.err) { console.error(C.red("mihomo pipe unreachable: " + v.err)); process.exit(1); }
  const r = await api("GET", "/proxies");
  if (!r.json) { console.error(C.red("proxies unavailable: " + (r.err || r.text.slice(0, 120)))); process.exit(1); }
  return { version: v.json, proxies: r.json.proxies };
}

(async () => {
  if (CMD === "help") {
    console.log(C.bold("clash.js -- Clash/mihomo control (FlyClash named pipe)"));
    console.log(`
  node clash.js list                  groups + current node + US/EU options
  node clash.js --switch "NAME"       set a node in every group containing it
  node clash.js region-us             switch every group that has a US option
  node clash.js exit                  exit country + api2 reachability
  node clash.js test                  proxy IP echo only
`);
    return;
  }

  if (CMD === "test") { console.log(await ipEcho()); return; }

  const { version, proxies } = await loadProxies();
  const groups = Object.entries(proxies).filter(([, p]) => Array.isArray(p.all) && p.all.length);

  const doList = CMD === "list" || flags.list;
  if (doList) {
    console.log(C.dim(`mihomo ${version.version ?? ""}`));
    console.log(C.bold(`\ngroups (${groups.length})`));
    for (const [n, g] of groups) console.log(`  [${n}] type=${g.type} now=${g.now} n=${g.all.length}`);
    const us = [...new Set(groups.flatMap(([, g]) => g.all.filter((x) => US_RE.test(x))))];
    const eu = [...new Set(groups.flatMap(([, g]) => g.all.filter((x) => EU_RE.test(x))))];
    console.log(C.bold(`\nUS nodes (${us.length})`));
    for (const n of us) console.log("  " + n);
    console.log(C.bold(`\nEU nodes (${eu.length})`));
    for (const n of eu) console.log("  " + n);
  }

  const sw = typeof flags.switch === "string" ? flags.switch : (CMD === "switch" ? pos[1] : null);
  if (sw) {
    const hit = groups.filter(([, g]) => g.all.includes(sw));
    if (!hit.length) {
      console.error(C.red(`no group contains "${sw}"`));
      const us = [...new Set(groups.flatMap(([, g]) => g.all.filter((x) => US_RE.test(x))))];
      console.log("US candidates: " + us.join(" | "));
      process.exit(1);
    }
    for (const [gn] of hit) {
      const r = await api("PUT", `/proxies/${encodeURIComponent(gn)}`, { name: sw });
      console.log(`${r.status === 204 ? C.green("ok  ") : C.yellow("?   ")} [${gn}] -> ${sw} (${r.status})`);
    }
  }

  if (CMD === "region-us" || flags["region-us"]) {
    for (const [gn, g] of groups) {
      const us = g.all.filter((x) => US_RE.test(x));
      if (!us.length) { console.log(C.dim(`  [${gn}] no US option`)); continue; }
      const pick = us.find((n) => /01/.test(n)) || us[0];
      const r = await api("PUT", `/proxies/${encodeURIComponent(gn)}`, { name: pick });
      console.log(`${r.status === 204 ? C.green("ok  ") : C.yellow("?   ")} [${gn}] ${g.now} -> ${pick}`);
    }
  }

  if (CMD === "exit" || flags.exit) {
    console.log(C.bold("\nexit: ") + (await ipEcho()));
    try {
      const client = await connectApi2();
      const me = await rpc(client, "aiserver.v1.DashboardService/GetMe", {});
      console.log(C.bold("api2: ") + me.status + " " + me.raw.replace(/\s+/g, " ").slice(0, 160));
    } catch (e) {
      console.log(C.red("api2 via proxy failed: " + e.message));
    }
  }
})().catch((e) => { console.error(C.red("ERR " + (e && e.message ? e.message : e))); process.exit(1); });
