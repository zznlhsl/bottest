#!/usr/bin/env node
/**
 * pod.js - Cursor cloud-agent (BackgroundComposer / Cloud Agent) toolkit.
 *
 * One CLI, zero npm dependencies. All api2 traffic goes through an HTTP CONNECT proxy
 * (default 127.0.0.1:7890) because http2 ignores HTTP_PROXY and the models are
 * region-gated: without a US/EU exit every premium model answers 429 ERROR_UNSUPPORTED_REGION.
 *
 * Subcommands
 *   state                       account, plan, period usage, free setup runs, environments (read-only)
 *   snap                        create a VSS snapshot and remember its device path
 *   token                       snapshot -> copy Chromium Cookies -> DPAPI+AES-GCM -> secrets/webacct_session.json
 *   windows                     list composers with free/billed classification and remaining free slots
 *   setup --repo URL            start a new environment-setup window (consumes one free setup run)
 *   fire --bc ID --models a,b   fire follow-ups on an existing window, money-guarded
 *   conv --bc ID                dump the window's conversation (proof of what actually ran)
 *   ledger                      dump usage events
 *   watch --bc ID               poll the ledger for one window's rows
 *
 * Money guard: `fire` polls the ledger after every call and aborts the whole run on the
 * first row with isChargeable=true. Disable with --no-guard (not recommended).
 *
 * Examples
 *   node pod.js token
 *   node pod.js state
 *   node pod.js windows
 *   node pod.js fire --bc bc-xxxx --models claude-opus-5-5-low,claude-opus-4-8,kimi-k3
 *   node pod.js conv --bc bc-xxxx
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const http2 = require("http2");
const tls = require("tls");
const net = require("net");
const crypto = require("crypto");
const os = require("os");
const { execFileSync } = require("child_process");

/* ------------------------------------------------------------------ config */
const HOME = process.env.POD_HOME || __dirname;
const SECRETS = path.join(HOME, "secrets");
const EVIDENCE = path.join(HOME, "evidence");
const SNAP_STATE = path.join(SECRETS, ".snap.json");
const SECRET_FILE = path.join(SECRETS, "webacct_session.json");

const DEFAULTS = {
  proxy: "127.0.0.1:7897",
  host: "api2.cursor.sh",
  profile: "E:\\CloakBrowser\\profiles\\谷歌登录\\data",
  cookieName: "WorkosCursorSessionToken",
  clientVersion: "3.20.10",
  clientCommit: "d6f462cdd0a6a6d1cff570daf980e671d0a63ded",
  glassSource: "BACKGROUND_COMPOSER_SOURCE_ENVIRONMENT_SETUP_GLASS",
  freeFollowupsPerWindow: 5,
};

/* ------------------------------------------------------------------- args */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}
const { flags: F, positional: POS } = parseArgs(process.argv.slice(2));
const CMD = POS[0] || "help";
const PROXY = String(F.proxy || DEFAULTS.proxy);
const HOST = String(F.host || DEFAULTS.host);

/* --------------------------------------------------------------- logging */
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const log = (...a) => console.log(...a);
const ok = (s) => log(C.green(s));
const warn = (s) => log(C.yellow(s));
const bad = (s) => log(C.red(s));

/* ------------------------------------------------- checksum (client spoof) */
let STORAGE = {};
try {
  STORAGE = JSON.parse(
    fs.readFileSync(path.join(process.env.APPDATA || "", "Cursor", "User", "globalStorage", "storage.json"), "utf8")
  );
} catch {}
function checksum() {
  const mid = String(STORAGE["telemetry.machineId"] || "");
  const mac = String(STORAGE["telemetry.macMachineId"] || "");
  const c = Math.floor(Date.now() / 1e6);
  const t = Buffer.from([
    (c >> 40) & 255, (c >> 32) & 255, (c >> 24) & 255,
    (c >> 16) & 255, (c >> 8) & 255, c & 255,
  ]);
  let x = 165;
  for (let n = 0; n < 6; n++) { t[n] = ((t[n] ^ x) + (n % 256)) & 255; x = t[n]; }
  return mac ? t.toString("base64url") + mid + "/" + mac : t.toString("base64url") + mid;
}

/* ------------------------------------------------------------- credential */
function loadToken() {
  if (!fs.existsSync(SECRET_FILE)) {
    const token = STORAGE["cursorAuth/accessToken"];
    const userId = STORAGE["cursorAuth/userId"] || "user_local";
    if (token) {
      fs.mkdirSync(SECRETS, { recursive: true });
      fs.writeFileSync(SECRET_FILE, JSON.stringify({
        jwt: token,
        userId: userId,
        sessionToken: `${userId}::${token}`,
        capturedAt: new Date().toISOString()
      }, null, 2));
      log(C.green(`[pod] auto-generated ${SECRET_FILE} from local Cursor configuration`));
      return { jwt: token, userId, sessionToken: `${userId}::${token}` };
    }
    bad(`missing ${SECRET_FILE} -- run: node pod.js token`);
    process.exit(2);
  }
  const j = JSON.parse(fs.readFileSync(SECRET_FILE, "utf8"));
  if (!j.jwt) { bad("secret file has no .jwt"); process.exit(2); }
  return j;
}

/* ------------------------------------------------------- http2 over proxy */
function connect(target = HOST) {
  return new Promise((resolve, reject) => {
    const [ph, pp] = PROXY.split(":");
    const req = http.request({
      host: ph, port: Number(pp || 80), method: "CONNECT",
      path: `${target}:443`, headers: { host: `${target}:443` },
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error("CONNECT " + res.statusCode));
      const t = tls.connect({ socket, servername: target, ALPNProtocols: ["h2"], rejectUnauthorized: false }, () => {
        const c = http2.connect(`https://${target}`, { createConnection: () => t });
        c.on("error", reject);
        c.on("connect", () => resolve(c));
      });
      t.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function rpc(client, rpcPath, body, { timeout = 90000, jwt, headers = {} } = {}) {
  const token = jwt || loadToken().jwt;
  return new Promise((resolve) => {
    const chunks = [];
    let status = 0;
    const t0 = Date.now();
    const done = (x) => resolve({ status, ms: Date.now() - t0, raw: Buffer.concat(chunks).toString("utf8"), ...x });
    const req = client.request({
      ":method": "POST",
      ":path": "/" + rpcPath,
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "connect-protocol-version": "1",
      "x-cursor-checksum": checksum(),
      "x-cursor-client-type": "glass",
      "x-cursor-client-version": DEFAULTS.clientVersion,
      "x-cursor-client-commit": DEFAULTS.clientCommit,
      "x-ghost-mode": "false",
      "x-request-id": crypto.randomUUID(),
      ...headers,
    });
    req.on("response", (h) => (status = Number(h[":status"] || 0)));
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => done({}));
    req.on("error", (e) => done({ err: e.message }));
    req.end(Buffer.from(JSON.stringify(body)));
    setTimeout(() => done({ timeout: true }), timeout);
  });
}

const S = {
  Dashboard: "aiserver.v1.DashboardService/",
  Composer: "aiserver.v1.BackgroundComposerService/",
};
const errCode = (raw) => (String(raw).match(/ERROR_[A-Z0-9_]+/) || [""])[0];
const oneLine = (s, n = 260) => String(s || "").replace(/\s+/g, " ").slice(0, n);

/* ----------------------------------------------------------- RPC shortcuts */
async function periodUsage(client) {
  return rpc(client, S.Dashboard + "GetCurrentPeriodUsage", {});
}
async function freeSetupRuns(client) {
  return rpc(client, S.Dashboard + "IsNextSetupRunFree", {});
}
async function ledger(client, minutes = 60) {
  const r = await rpc(client, S.Dashboard + "GetFilteredUsageEvents", {
    teamId: 0,
    startDate: String(Date.now() - minutes * 60e3),
    endDate: String(Date.now() + 60e3),
    page: 1,
    pageSize: 200,
  });
  try { return JSON.parse(r.raw.match(/\{[\s\S]*\}/)[0]).usageEventsDisplay || []; } catch { return []; }
}
async function composerInfo(client, bcId) {
  const r = await rpc(client, S.Composer + "GetBackgroundComposerInfo", { bcId });
  if (r.status !== 200) return null;
  const pick = (re) => (r.raw.match(re) || [])[1] || null;
  return {
    bcId,
    name: pick(/"name"\s*:\s*"([^"]+)"/),
    repo: pick(/"repoUrl"\s*:\s*"([^"]+)"/),
    status: pick(/"status"\s*:\s*"([^"]+)"/),
    envPublicId: pick(/"environmentPublicId"\s*:\s*"([^"]+)"/),
    modelName: pick(/"modelName"\s*:\s*"([^"]+)"/),
    createdAtMs: Number(pick(/"createdAtMs"\s*:\s*(\d+)/) || 0),
  };
}
/**
 * Block until the composer stops running. Firing follow-ups into a RUNNING setup window is
 * what bills the setup workflow's own subagents (measured: claude-4.5-sonnet rows).
 */
async function waitForIdle(client, bcId, timeoutS = 900, intervalS = 20) {
  const deadline = Date.now() + timeoutS * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const info = await composerInfo(client, bcId);
    last = info?.status || null;
    if (last && last !== "BACKGROUND_COMPOSER_STATUS_CREATING" && last !== "BACKGROUND_COMPOSER_STATUS_RUNNING") {
      return { status: last, waitedS: Math.round((timeoutS * 1000 - (deadline - Date.now())) / 1000) };
    }
    process.stdout.write(C.dim("~"));
    await new Promise((s) => setTimeout(s, intervalS * 1000));
  }
  log("");
  return { status: last, timedOut: true };
}
async function conversation(client, bcId) {
  const r = await rpc(client, S.Composer + "GetBackgroundComposerConversation", { bcId });
  try { return JSON.parse(r.raw); } catch { return { error: oneLine(r.raw, 400) }; }
}

/* ------------------------------------------------------------- VSS snapshot */
function createSnapshot(volume = "E:\\") {
  const ps =
    `$r = Invoke-CimMethod -ClassName Win32_ShadowCopy -MethodName Create -Arguments @{Volume='${volume}'; Context='ClientAccessible'} -ErrorAction Stop;` +
    `$sc = Get-CimInstance Win32_ShadowCopy | Where-Object { $_.ID -eq $r.ShadowID };` +
    `$sc.DeviceObject`;
  const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim();
  if (!out) throw new Error("snapshot creation returned nothing");
  fs.mkdirSync(SECRETS, { recursive: true });
  fs.writeFileSync(SNAP_STATE, JSON.stringify({ device: out, volume, at: new Date().toISOString() }, null, 2));
  return out;
}
function lastSnapshot() {
  try { return JSON.parse(fs.readFileSync(SNAP_STATE, "utf8")).device; } catch { return null; }
}
/** map a live path to its in-snapshot path: E:\a\b -> <device>\a\b */
function snapPath(device, livePath) {
  return device + "\\" + livePath.replace(/^[A-Za-z]:\\/, "");
}

/* ------------------------------------------------------ browser cookie grab */
function dpapiUnprotect(blob) {
  const tmp = path.join(os.tmpdir(), "pod_key.bin");
  fs.writeFileSync(tmp, blob);
  const ps =
    `Add-Type -AssemblyName System.Security;` +
    `$b=[IO.File]::ReadAllBytes('${tmp.replace(/'/g, "''")}');` +
    `$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');` +
    `[Convert]::ToBase64String($p)`;
  return Buffer.from(execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim(), "base64");
}
/** Chromium v10/v11 value -> plaintext (strips the 32-byte SHA256(domain) prefix) */
function decryptCookieValue(enc, master) {
  const v = enc.slice(0, 3).toString();
  if (v !== "v10" && v !== "v11") {
    if (v === "v20") return { value: null, note: "v20 app-bound (needs in-browser extraction)" };
    return { value: enc.toString("utf8"), note: "plaintext" };
  }
  const iv = enc.slice(3, 15);
  const tag = enc.slice(enc.length - 16);
  const data = enc.slice(15, enc.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", master, iv);
  d.setAuthTag(tag);
  const out = Buffer.concat([d.update(data), d.final()]);
  return { value: out.slice(32).toString("utf8"), note: "aes-256-gcm" };
}

async function cmdToken() {
  const { DatabaseSync } = require("node:sqlite");
  const profile = String(F.profile || DEFAULTS.profile);
  const cookieName = String(F.cookie || DEFAULTS.cookieName);
  const outDir = String(F.out || SECRETS);

  let device = F.device ? String(F.device) : null;
  if (!device && !F["no-snapshot"]) {
    log(C.dim("creating VSS snapshot (the live profile holds Chromium's cookie db with an exclusive lock)..."));
    device = createSnapshot(String(F.volume || profile.slice(0, 3)));
    log(C.dim("snapshot: " + device));
  }

  // cookie db: prefer in-snapshot copy, else a --db hint, else the live path
  const liveCookies = path.join(profile, "Default", "Network", "Cookies");
  const candidates = [];
  if (F.db) candidates.push(String(F.db));
  const tmpCopy = path.join(os.tmpdir(), "pod_cookies.db");
  if (device) {
    const src = snapPath(device, liveCookies);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, tmpCopy);
      candidates.push(tmpCopy);
      log(C.dim("copied Cookies out of the snapshot"));
    }
  }
  candidates.push(liveCookies);

  let dbPath = null;
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c) || fs.statSync(c).size < 1024) continue;
      const probe = new DatabaseSync(c, { readOnly: true });
      probe.prepare("select count(*) c from cookies").get();
      probe.close();
      dbPath = c;
      break;
    } catch (e) {
      log(C.dim(`  skip ${c} (${e.errstr || e.message})`));
    }
  }
  if (!dbPath) {
    bad("no readable Cookies db. Run `node pod.js snap` then pass --db <snapshot copy>.");
    process.exit(3);
  }

  // master key
  const lsPath = device ? snapPath(device, path.join(profile, "Local State")) : path.join(profile, "Local State");
  const ls = JSON.parse(fs.readFileSync(fs.existsSync(lsPath) ? lsPath : path.join(profile, "Local State"), "utf8"));
  let keyBlob = Buffer.from(ls.os_crypt.encrypted_key, "base64");
  if (keyBlob.slice(0, 5).toString() === "DPAPI") keyBlob = keyBlob.slice(5);
  const master = dpapiUnprotect(keyBlob);
  log(C.dim(`master key: ${master.length} bytes`));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare(
    "select host_key, name, encrypted_value, is_httponly, path from cookies where host_key like ? order by host_key, name"
  ).all("%cursor.com%");

  const found = {};
  for (const r of rows) {
    const { value } = decryptCookieValue(Buffer.from(r.encrypted_value), master);
    if (value) found[r.host_key + "|" + r.name] = value;
  }
  const hit = Object.entries(found).find(([k]) => k.toLowerCase().includes(cookieName.toLowerCase()));
  if (!hit) {
    bad(`cookie "${cookieName}" not found (${Object.keys(found).length} cursor.com cookies decrypted)`);
    process.exit(4);
  }
  let text = hit[1].trim();
  try { text = decodeURIComponent(text); } catch {}
  const sep = text.indexOf("::");
  const jwt = sep >= 0 ? text.slice(sep + 2) : text;
  if (jwt.split(".").length !== 3) { bad("cookie is not a JWT"); process.exit(5); }
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  const userId = sep >= 0 ? text.slice(0, sep) : String(payload.sub).split("|").pop();

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "webacct_session.json"),
    JSON.stringify({ jwt, userId, sessionToken: `${userId}::${jwt}`, capturedAt: new Date().toISOString() }, null, 2));
  fs.writeFileSync(path.join(outDir, "access_token.txt"), jwt);
  fs.writeFileSync(path.join(outDir, "cloak_cookies.json"), JSON.stringify(found, null, 2));

  ok(`token written: ${path.join(outDir, "webacct_session.json")}`);
  log(`  userId : ${userId}`);
  log(`  sub    : ${payload.sub}`);
  log(`  exp    : ${new Date(payload.exp * 1000).toISOString()}`);
  log(`  cookies decrypted: ${Object.keys(found).length} -> ${path.join(outDir, "cloak_cookies.json")}`);
}

/* ---------------------------------------------------------------- state */
async function cmdState() {
  const client = await connect();
  const t = loadToken();
  log(C.bold("account"));
  const me = await rpc(client, S.Dashboard + "GetMe", {});
  log("  " + oneLine(me.raw, 400));
  log(C.bold("\nplan"));
  const plan = await rpc(client, S.Dashboard + "GetPlanInfo", {});
  log("  " + oneLine(plan.raw, 400));
  log(C.bold("\nperiod usage"));
  const per = await periodUsage(client);
  const rem = (per.raw.match(/"remaining":(\d+)/) || [])[1];
  const lim = (per.raw.match(/"limit":(\d+)/) || [])[1];
  const used = (per.raw.match(/"totalSpend":(\d+)/) || [])[1];
  log(`  remaining=${rem}  limit=${lim}  totalSpend=${used ?? "(n/a)"}`);
  log(C.dim("  " + oneLine(per.raw, 400)));
  log(C.bold("\nfree setup runs"));
  const free = await freeSetupRuns(client);
  log("  " + free.raw + (free.raw.includes("remainingRuns") ? "" : C.yellow("   (no remainingRuns = pool exhausted)")));
  log(C.bold("\nenvironments"));
  const envs = await rpc(client, S.Composer + "ListEnvironments", {});
  try {
    for (const e of JSON.parse(envs.raw).environments || []) {
      const repos = (e.repoConfig?.repos || []).map((r) => r.repoUrl).join(", ");
      log(`  id=${e.id} ${e.publicId}  ${repos}`);
    }
  } catch { log("  " + oneLine(envs.raw, 300)); }
  log(C.bold("\nledger (last 60 min)"));
  const rows = await ledger(client, 60);
  if (!rows.length) log(C.dim("  (empty)"));
  for (const r of rows) {
    const tag = r.isChargeable ? C.red("BILLED") : C.green("free  ");
    log(`  ${tag} ${String(r.model).padEnd(30)} cents=${String(r.chargedCents).padEnd(10)} conv=${String(r.conversationId).slice(0, 18)} at=${new Date(Number(r.timestamp)).toISOString().slice(11, 19)}`);
  }
  log(`\nuser: ${t.userId}`);
  client.destroy();
}

/* -------------------------------------------------------------- windows */
async function cmdWindows() {
  const client = await connect();
  const rows = await ledger(client, 240);
  const byBc = new Map();
  for (const r of rows) {
    const k = String(r.conversationId || "");
    if (!k.startsWith("bc-")) continue;
    if (!byBc.has(k)) byBc.set(k, []);
    byBc.get(k).push(r);
  }
  const free = await freeSetupRuns(client);
  log(C.bold(`free setup runs: ${free.raw}`));
  log(C.bold(`composers in the last 4h: ${byBc.size}\n`));
  for (const [bc, rs] of byBc) {
    const info = await composerInfo(client, bc);
    const billed = rs.filter((r) => r.isChargeable === true);
    const freeRows = rs.filter((r) => r.isChargeable === false);
    const tag = billed.length ? C.red("BILLED") : (freeRows.length ? C.green("FREE  ") : C.dim("?     "));
    // one ledger row per message (setup counts as one). Once any row is billed the window's
    // free allowance is spent -- measured: a window that showed 2 billed rows billed everything after.
    const used = Math.max(0, rs.length - 1);
    const left = billed.length ? 0 : Math.max(0, DEFAULTS.freeFollowupsPerWindow - used);
    log(`${tag} ${bc}`);
    log(`      name=${info?.name || "-"}  repo=${info?.repo || "-"}`);
    log(`      rows=${rs.length} (free ${freeRows.length} / billed ${billed.length})   used ${used}/${DEFAULTS.freeFollowupsPerWindow}  ${billed.length ? C.red("free slots exhausted (window already billed)") : left === 0 ? C.yellow("no free slots left") : C.green(`remaining ~${left}`)}`);
    for (const r of rs) {
      log(C.dim(`        ${String(r.model).padEnd(30)} cents=${String(r.chargedCents).padEnd(10)} chargeable=${r.isChargeable}`));
    }
  }
  client.destroy();
}

/* ---------------------------------------------------------------- setup */
async function cmdSetup() {
  const repo = String(F.repo || "");
  if (!repo) { bad("need --repo <https://github.com/owner/name>"); process.exit(2); }
  const branch = String(F.branch || "main");
  const envId = String(F.env || "");
  const model = String(F.model || "claude-opus-5-5-low");
  const client = await connect();

  const pre = await freeSetupRuns(client);
  log(C.bold(`free setup runs before: ${pre.raw}`));
  if (!pre.raw.includes("remainingRuns")) warn("no remainingRuns -- this window is likely billable");

  const mark = "POD_" + crypto.randomBytes(3).toString("hex");
  const text = "Reply exactly " + mark;
  const body = {
    bcId: "bc-" + crypto.randomUUID(),
    snapshotNameOrId: repo,
    snapshotWorkspaceRootPath: "/workspace",
    returnImmediately: true,
    repoUrl: repo,
    source: DEFAULTS.glassSource,
    autoBranch: true,
    baseBranch: branch,
    addInitialMessageToResponses: true,
    enableSetupVmEnvironmentTool: true,
    repositoryInfo: { pathEncryptionKey: "", shouldSyncIndex: false },
    requestedModels: [{ modelId: model }],
    prompt: text,
    conversationAction: { userMessageAction: { userMessage: { text, messageId: crypto.randomUUID() } } },
    startingMessageType: 1,
    devcontainerStartingPoint: { url: repo, ref: branch },
    environmentSetupRunStartedMetadata: {
      setupSessionId: crypto.randomUUID(), surface: "glass", entrypoint: "onboarding", resumedSession: false,
    },
  };
  if (envId) body.environmentPublicId = envId;

  const r = await rpc(client, S.Composer + "StartBackgroundComposerFromSnapshot", body);
  const bcId = (r.raw.match(/"bcId"\s*:\s*"([^"]+)"/) || [])[1] || null;
  const srvModel = (r.raw.match(/"modelName"\s*:\s*"([^"]+)"/) || [])[1] || null;
  log(`status=${r.status}  bcId=${bcId}  serverModel=${srvModel}  (the setup run's own model gets rewritten by the server)`);
  if (r.status !== 200) log("  " + oneLine(r.raw, 400));
  if (bcId) {
    log(C.dim("waiting 45s for the setup run to land..."));
    await new Promise((s) => setTimeout(s, 45000));
    const rw = (await ledger(client, 30)).filter((x) => String(x.conversationId) === bcId);
    for (const x of rw) {
      log(`  ROW ${String(x.model).padEnd(30)} cents=${String(x.chargedCents).padEnd(10)} chargeable=${x.isChargeable} ${x.isChargeable ? C.red("← this window is BILLABLE") : C.green("← free window")}`);
    }
    if (!rw.length) warn("  no ledger row yet; re-check with: node pod.js watch --bc " + bcId);
  }
  const post = await freeSetupRuns(client);
  log(`free setup runs after: ${post.raw}`);
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, "ex-setup-" + (bcId || Date.now()) + ".json"),
    JSON.stringify({ observed_at: new Date().toISOString(), repo, branch, envId: envId || null, request: body, status: r.status, bcId, srvModel, raw: r.raw }, null, 2));
  client.destroy();
}

/* ----------------------------------------------------------------- fire */
async function cmdFire() {
  const bcId = String(F.bc || POS[1] || "");
  const models = String(F.models || "").split(",").map((s) => s.trim()).filter(Boolean);
  const guard = F["no-guard"] ? false : true;
  const tries = Number(F.tries || 9);
  const pollMs = Number(F.poll || 20000);
  if (!bcId || !models.length) { bad("need --bc bc-xxxx --models a,b,c"); process.exit(2); }

  const client = await connect();
  const p0 = await periodUsage(client);
  const rem0 = Number((p0.raw.match(/"remaining":(\d+)/) || [])[1] || 0);
  log(C.bold(`bc=${bcId}`));
  log(`remaining(before)=${rem0}  models=${models.join(", ")}  guard=${guard ? "on" : "OFF"}`);

  {
    const info = await composerInfo(client, bcId);
    log(`window status: ${info?.status || "?"}  model=${info?.modelName || "-"}`);
    if (info && /RUNNING|CREATING/.test(info.status) && !F.force) {
      warn("window is still running -- follow-ups fired now can bill the setup workflow's own subagents.");
      log(C.dim("  waiting for it to become idle (override with --force)..."));
      const idle = await waitForIdle(client, bcId, Number(F.finish || 900), 20);
      log(`  status: ${idle.status}${idle.timedOut ? C.yellow(" (timeout)") : ""}`);
    }
  }

  const known = new Set(
    (await ledger(client, 240)).filter((r) => String(r.conversationId) === bcId).map((r) => r.timestamp + "|" + r.model)
  );
  const report = { observed_at: new Date().toISOString(), bc: bcId, remainingBefore: rem0, models, results: [], aborted: false };

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const r = await rpc(client, S.Composer + "AddAsyncFollowupBackgroundComposer", {
      bcId,
      followupMessage: {
        text: `Reply exactly POD_${i + 1}`,
        type: 1,
        bubbleId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
      },
      requestedModel: { modelId: model },
    });
    const code = errCode(r.raw);
    log(C.bold(`\n[${i + 1}/${models.length}] ${model}`) + `  status=${r.status} ${code}  (${r.ms}ms)`);
    if (r.status !== 200) { log("  " + oneLine(r.raw, 300)); report.results.push({ model, status: r.status, code }); continue; }

    let newRows = [];
    for (let t = 0; t < tries; t++) {
      await new Promise((s) => setTimeout(s, pollMs));
      const rows = await ledger(client, 240);
      newRows = rows.filter((x) => String(x.conversationId) === bcId && !known.has(x.timestamp + "|" + x.model));
      if (newRows.length) break;
      process.stdout.write(C.dim("."));
    }
    if (!newRows.length) log("");
    for (const x of newRows) {
      known.add(x.timestamp + "|" + x.model);
      const tag = x.isChargeable ? C.red("BILLED") : C.green("free  ");
      log(`      ${tag} ${String(x.model).padEnd(30)} cents=${String(x.chargedCents).padEnd(10)}`);
    }
    const billed = newRows.filter((x) => x.isChargeable === true);
    report.results.push({
      model, status: r.status, runId: (r.raw.match(/"runId"\s*:\s*"([^"]+)"/) || [])[1] || null,
      rows: newRows.map((x) => ({ model: x.model, cents: x.chargedCents, chargeable: x.isChargeable, kind: x.kind })),
      billed: billed.length > 0,
    });
    if (billed.length && guard) {
      bad(`\n!!! BILLED ROW (${billed.map((b) => `${b.model}:${b.chargedCents}`).join(", ")}) -- aborting ${models.length - i - 1} remaining slot(s)`);
      report.aborted = true;
      break;
    }
  }

  const p1 = await periodUsage(client);
  const rem1 = Number((p1.raw.match(/"remaining":(\d+)/) || [])[1] || 0);
  log(C.bold(`\nremaining: ${rem0} -> ${rem1}  (consumed ${rem0 - rem1})`));
  report.remainingAfter = rem1;
  const conv = await conversation(client, bcId);
  report.conversationAnswers = (conv?.conversation || [])
    .map((m) => ({ type: m.type, text: oneLine(m.text || "", 120) }))
    .filter((m) => m.text);
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const file = path.join(EVIDENCE, "ex-fire-" + bcId.slice(3, 11) + ".json");
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  log("evidence -> " + file);
  client.destroy();
}

/* ------------------------------------------------------------- campaign */
/**
 * campaign: for each repo -> start a setup window (trying branch candidates), wait for the
 * setup row, refuse to continue if that row is billed, then fire the repo's model plan with
 * the money guard. Aborts everything on the first billed row or when free runs are gone.
 *
 *   node pod.js campaign --repos "URL1,URL2" --plan "m1,m2,m3;m4,m5,m6" [--wait 45] [--branches main,master]
 */
async function cmdCampaign() {
  const repos = String(F.repos || "").split(",").map((s) => s.trim()).filter(Boolean);
  const plan = String(F.plan || "").split(";").map((s) => s.split(",").map((x) => x.trim()).filter(Boolean));
  const branches = String(F.branches || "main,master").split(",").map((s) => s.trim());
  const waitS = Number(F.wait || 45);
  const tries = Number(F.tries || 9);
  const pollMs = Number(F.poll || 20000);
  if (!repos.length) { bad("need --repos URL1,URL2 [--plan \"models;models\"]"); process.exit(2); }

  const client = await connect();
  const envId = String(F.env || "");
  const report = { observed_at: new Date().toISOString(), windows: [], aborted: false };
  const rem0 = Number(((await periodUsage(client)).raw.match(/"remaining":(\d+)/) || [])[1] || 0);

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    const models = plan[i] || [];
    const freeNow = await freeSetupRuns(client);
    log(C.bold(`\n================ window ${i + 1}/${repos.length}  ${repo}`));
    log(`  free setup runs: ${freeNow.raw}`);
    if (!freeNow.raw.includes("remainingRuns")) {
      warn("  no free setup runs left -- this window would be billable; stopping.");
      report.aborted = true;
      break;
    }

    // setup, trying branch candidates
    let bcId = null, usedBranch = null, lastRaw = "";
    for (const branch of branches) {
      const mark = "CAMP_" + crypto.randomBytes(3).toString("hex");
      const text = "Reply exactly " + mark;
      const body = {
        bcId: "bc-" + crypto.randomUUID(),
        snapshotNameOrId: repo, snapshotWorkspaceRootPath: "/workspace", returnImmediately: true,
        repoUrl: repo, source: DEFAULTS.glassSource, autoBranch: true, baseBranch: branch,
        addInitialMessageToResponses: true, enableSetupVmEnvironmentTool: true,
        repositoryInfo: { pathEncryptionKey: "", shouldSyncIndex: false },
        requestedModels: [{ modelId: models[0] || "claude-opus-5-5-low" }],
        prompt: text,
        conversationAction: { userMessageAction: { userMessage: { text, messageId: crypto.randomUUID() } } },
        startingMessageType: 1,
        devcontainerStartingPoint: { url: repo, ref: branch },
        environmentSetupRunStartedMetadata: { setupSessionId: crypto.randomUUID(), surface: "glass", entrypoint: "onboarding", resumedSession: false },
      };
      if (envId) body.environmentPublicId = envId;
      const r = await rpc(client, S.Composer + "StartBackgroundComposerFromSnapshot", body);
      lastRaw = r.raw;
      bcId = (r.raw.match(/"bcId"\s*:\s*"([^"]+)"/) || [])[1] || null;
      log(`  setup[${branch}] status=${r.status} bc=${bcId} ${oneLine(r.raw, 120)}`);
      if (bcId) { usedBranch = branch; break; }
      if (!/branch/i.test(r.raw)) break; // not a branch problem -> give up on this repo
    }
    const entry = { repo, branch: usedBranch, bcId, models, setupRaw: oneLine(lastRaw, 400), results: [] };
    report.windows.push(entry);
    if (!bcId) { warn("  could not create a window for this repo; skipping."); continue; }

    log(C.dim(`  waiting for the setup workflow to finish (firing into a RUNNING window bills its subagents)...`));
    const idle = await waitForIdle(client, bcId, Number(F.finish || 900), 20);
    log(`  window status: ${idle.status}${idle.timedOut ? C.yellow(" (timeout -- proceed with caution)") : ""}`);
    await new Promise((s) => setTimeout(s, waitS * 1000));
    let setupRows = (await ledger(client, 30)).filter((r) => String(r.conversationId) === bcId);
    for (const r of setupRows) {
      const tag = r.isChargeable ? C.red("BILLED") : C.green("free  ");
      log(`  setup row: ${tag} ${r.model} cents=${r.chargedCents}`);
    }
    if (setupRows.some((r) => r.isChargeable === true)) {
      bad("  this window is BILLABLE -- aborting campaign (nothing further fired).");
      report.aborted = true;
      break;
    }
    if (!setupRows.length) warn("  setup row not visible yet; firing anyway under the money guard.");

    const known = new Set((await ledger(client, 240)).filter((r) => String(r.conversationId) === bcId).map((r) => r.timestamp + "|" + r.model));
    for (let k = 0; k < models.length; k++) {
      const model = models[k];
      const r = await rpc(client, S.Composer + "AddAsyncFollowupBackgroundComposer", {
        bcId,
        followupMessage: { text: `Reply exactly CAMP_w${i + 1}s${k + 1}`, type: 1, bubbleId: crypto.randomUUID(), messageId: crypto.randomUUID() },
        requestedModel: { modelId: model },
      });
      const code = errCode(r.raw);
      log(`    [${k + 1}/${models.length}] ${model.padEnd(32)} ${String(r.status).padEnd(4)} ${code}`);
      if (r.status !== 200) { entry.results.push({ model, status: r.status, code }); continue; }

      let newRows = [];
      for (let t = 0; t < tries; t++) {
        await new Promise((s) => setTimeout(s, pollMs));
        const rows = await ledger(client, 240);
        newRows = rows.filter((x) => String(x.conversationId) === bcId && !known.has(x.timestamp + "|" + x.model));
        if (newRows.length) break;
        process.stdout.write(C.dim("."));
      }
      if (!newRows.length) log("");
      for (const x of newRows) {
        known.add(x.timestamp + "|" + x.model);
        const tag = x.isChargeable ? C.red("BILLED") : C.green("free  ");
        log(`        ${tag} ${String(x.model).padEnd(30)} cents=${String(x.chargedCents).padEnd(10)}`);
      }
      const billed = newRows.filter((x) => x.isChargeable === true);
      entry.results.push({
        model, status: r.status,
        runId: (r.raw.match(/"runId"\s*:\s*"([^"]+)"/) || [])[1] || null,
        rows: newRows.map((x) => ({ model: x.model, cents: x.chargedCents, chargeable: x.isChargeable })),
        billed: billed.length > 0,
      });
      if (billed.length) {
        bad(`        !!! BILLED (${billed.map((b) => `${b.model}:${b.chargedCents}`).join(", ")}) -- aborting campaign`);
        report.aborted = true;
        break;
      }
    }
    if (report.aborted) break;
  }

  const rem1 = Number(((await periodUsage(client)).raw.match(/"remaining":(\d+)/) || [])[1] || 0);
  const fr = await freeSetupRuns(client);
  log(C.bold(`\nremaining: ${rem0} -> ${rem1}   freeRuns: ${fr.raw}`));
  report.remainingBefore = rem0;
  report.remainingAfter = rem1;
  report.freeRuns = fr.raw;

  fs.mkdirSync(EVIDENCE, { recursive: true });
  const file = path.join(EVIDENCE, "ex-campaign-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  log("evidence -> " + file);
  client.destroy();
}

/* ----------------------------------------------------------------- conv */
async function cmdConv() {
  const bcId = String(F.bc || POS[1] || "");
  if (!bcId) { bad("need --bc bc-xxxx"); process.exit(2); }
  const client = await connect();
  const info = await composerInfo(client, bcId);
  log(C.bold(`${bcId}`));
  if (info) {
    log(`  name=${info.name}`);
    log(`  repo=${info.repo}`);
    log(`  status=${info.status}  model=${info.modelName}  env=${info.envPublicId}`);
  }
  const conv = await conversation(client, bcId);
  const msgs = conv?.conversation || [];
  log(C.bold(`\nconversation (${msgs.length} messages)`));
  msgs.forEach((m, i) => {
    const text = oneLine(m.text || "", 160);
    if (!text) return;
    const type = String(m.type || "").replace("MESSAGE_TYPE_", "");
    const color = type === "HUMAN" ? C.cyan : C.dim;
    log(`  #${String(i).padStart(2)} ${color(type.padEnd(9))} ${text}`);
  });
  const rows = (await ledger(client, 240)).filter((r) => String(r.conversationId) === bcId);
  log(C.bold(`\nledger rows (${rows.length})`));
  for (const r of rows) {
    const tag = r.isChargeable ? C.red("BILLED") : C.green("free  ");
    log(`  ${tag} ${String(r.model).padEnd(30)} cents=${String(r.chargedCents).padEnd(10)}`);
  }
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, `ex-conv-${bcId.slice(3, 11)}.json`),
    JSON.stringify({ info, conversation: conv, rows }, null, 2));
  log("evidence -> " + path.join(EVIDENCE, `ex-conv-${bcId.slice(3, 11)}.json`));
  client.destroy();
}

/* --------------------------------------------------------------- ledger */
async function cmdLedger() {
  const client = await connect();
  const rows = await ledger(client, Number(F.minutes || 60));
  log(C.bold(`${rows.length} rows`));
  for (const r of rows) {
    const tag = r.isChargeable ? C.red("BILLED") : C.green("free  ");
    log(`  ${tag} ${String(r.model).padEnd(30)} cents=${String(r.chargedCents).padEnd(10)} kind=${r.kind} conv=${String(r.conversationId).slice(0, 18)} at=${new Date(Number(r.timestamp)).toISOString().slice(11, 19)}`);
  }
  if (F.json) { log(JSON.stringify(rows, null, 2)); }
  client.destroy();
}

/* ---------------------------------------------------------------- watch */
async function cmdWatch() {
  const bcId = String(F.bc || POS[1] || "");
  if (!bcId) { bad("need --bc bc-xxxx"); process.exit(2); }
  const minutes = Number(F.minutes || 10);
  const client = await connect();
  const deadline = Date.now() + minutes * 60e3;
  const seen = new Set();
  log(`watching ${bcId} for ${minutes} min...`);
  while (Date.now() < deadline) {
    const rows = (await ledger(client, 240)).filter((r) => String(r.conversationId) === bcId);
    for (const r of rows) {
      const k = r.timestamp + "|" + r.model;
      if (seen.has(k)) continue;
      seen.add(k);
      const tag = r.isChargeable ? C.red("BILLED") : C.green("free  ");
      log(`  ${tag} ${String(r.model).padEnd(30)} cents=${String(r.chargedCents).padEnd(10)} at=${new Date(Number(r.timestamp)).toISOString().slice(11, 19)}`);
    }
    await new Promise((s) => setTimeout(s, 45000));
  }
  client.destroy();
}

/* ----------------------------------------------------------- model catalog */
const MODEL_CATALOG = {
  // measured on a FREE window (cents=0 / chargeable=false)
  free: [
    ["claude-opus-5-5-low", "claude-opus-5-5-low"],
    ["claude-opus-5-5", "claude-opus-5-5-medium"],
    ["claude-opus-4-8", "claude-opus-4-8-thinking-high"],
    ["claude-4.6-opus-high-thinking", "claude-4.6-opus-high-thinking"],
    ["claude-4.5-opus-high", "claude-4.5-opus-high"],
    ["claude-sonnet-5-5", "claude-sonnet-5-5-high"],
    ["claude-haiku-5-5", "claude-haiku-5-5-thinking-high"],
    ["claude-fable-5-1-thinking-max", "claude-fable-5-1-thinking-max"],
    ["claude-fable-5", "claude-fable-5-thinking-high"],
    ["gpt-5.6-sol-high", "gpt-5.6-sol-high"],
    ["gpt-5.6-sol", "gpt-5.6-sol-medium"],
    ["gpt-5.6-terra", "gpt-5.6-terra-medium"],
  ],
  // measured as billed even inside a free window
  billed: [
    ["claude-opus-5-5-high", "billed 0.39c"],
    ["claude-opus-5-5-max", "billed 0.64c"],
    ["kimi-k3", "rewritten to kimi-k3-max, billed"],
  ],
  // ids that do not exist (404 ERROR_BAD_MODEL_NAME)
  invalid: ["claude-opus-5-5-1m-low", "cursor-opus-5-5-low", "opus-5-5-low", "composer-1", "composer-2"],
};
function cmdModels() {
  log(C.bold("free on a free window"));
  for (const [req, actual] of MODEL_CATALOG.free) log(`  ${req.padEnd(32)} -> ${C.green(actual)}`);
  log(C.bold("\nbilled even on a free window"));
  for (const [req, note] of MODEL_CATALOG.billed) log(`  ${req.padEnd(32)} -> ${C.red(note)}`);
  log(C.bold("\ninvalid ids (404)"));
  for (const id of MODEL_CATALOG.invalid) log(`  ${id.padEnd(32)} -> ${C.dim("ERROR_BAD_MODEL_NAME")}`);
  log(C.dim(`\nnote: the server rewrites some ids; the right-hand column is what the ledger records.`));
}

/* ----------------------------------------------------------------- help */
function cmdHelp() {
  log(C.bold("pod.js -- Cursor cloud-agent toolkit"));
  log(`
usage: node pod.js <command> [options]

  state                     account / plan / period usage / free setup runs / environments / ledger
  snap   [--volume E:\\]     create a VSS snapshot (needed when the browser holds its cookie db)
  token  [--profile DIR]    snapshot -> decrypt Chromium cookies -> secrets/webacct_session.json
         [--cookie NAME] [--db PATH] [--device \\\\?\\GLOBALROOT\\...] [--out DIR] [--no-snapshot]
  windows                   list composers: FREE / BILLED, rows, remaining free slots
  setup  --repo URL         start a new environment-setup window
         [--branch main] [--env PUBLIC_ID] [--model MODEL_ID]
  fire   --bc ID --models a,b,c    fire follow-ups, money-guarded
         [--tries 9] [--poll 20000] [--no-guard]
  campaign --repos URL1,URL2 --plan "m1,m2,m3;m4,m5,m6"
                                    create windows per repo, verify each is FREE, then fill the plan
         [--branches main,master] [--wait 45] [--tries 9] [--poll 20000] [--env PUBLIC_ID]
  conv   --bc ID            conversation + ledger rows for one window
  ledger [--minutes 60] [--json]
  watch  --bc ID [--minutes 10]
  models                    model-id catalogue (free / billed / invalid)

global: --proxy 127.0.0.1:7890   --host api2.cursor.sh

examples
  node pod.js token
  node pod.js state
  node pod.js windows
  node pod.js setup --repo https://github.com/OWNER/REPO --branch main
  node pod.js fire --bc bc-xxxx --models claude-opus-5-5-low,claude-opus-4-8
  node pod.js conv --bc bc-xxxx

region: premium models are region-gated; switch the Clash exit first:  node clash.js --region-us
`);
}

/* ---------------------------------------------------------------- dispatch */
async function main() {
  switch (CMD) {
    case "state": return cmdState();
    case "snap":
      log("snapshot: " + createSnapshot(String(F.volume || "E:\\")));
      return;
    case "token": return cmdToken();
    case "windows": return cmdWindows();
    case "setup": return cmdSetup();
    case "campaign": return cmdCampaign();
    case "fire": return cmdFire();
    case "conv": return cmdConv();
    case "ledger": return cmdLedger();
    case "watch": return cmdWatch();
    case "models": return cmdModels();
    case "snapdev": {
      const d = lastSnapshot();
      log(d ? d : "no snapshot recorded -- run `node pod.js snap`");
      return;
    }
    default: return cmdHelp();
  }
}

if (require.main === module) {
  main().catch((e) => {
    bad("ERR " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e));
    process.exit(1);
  });
}

/* ---------------------------------------------------------------- exports */
/* everything chat.js needs; the CLI above only runs when invoked directly */
module.exports = {
  HOME, SECRETS, DEFAULTS, S, C, log, ok, warn, bad, oneLine,
  connect, rpc, loadToken, ledger, freeSetupRuns, periodUsage,
  composerInfo, conversation, waitForIdle, MODEL_CATALOG,
};
