#!/usr/bin/env node
/**
 * chat.js - interactive REPL on a Cursor cloud-agent window, with a git bridge
 * for local projects.
 *
 * Modes
 *   node chat.js                          inside a git project: snapshot-push -> new window -> chat
 *   node chat.js --path D:\proj           same, explicit project dir (subdirs of the repo are fine)
 *   node chat.js --bc bc-xxxx             re-attach to an existing window
 *   node chat.js --repo URL [--branch b]  chat on a remote repo (no snapshot push)
 *
 * REPL
 *   anything not starting with "/" is a task message (active skill prepended)
 *   /help /models /model <id> /skills /skill <name> /skill off
 *   /status /slots /sync /diff /pull /exit
 *
 * Git bridge (snapshot mode): a temp-index snapshot of the working tree
 * (INCLUDING uncommitted changes; the user's real index is never touched) is
 * pushed to pod/chat-<stamp>. The agent works on an autoBranch off it; /pull
 * fetches, shows commits + stat, then applies as a worktree patch or a merge.
 *
 * Skills: markdown files in <pod>/skills/*.md or <project>/.pod/skills/*.md
 * (project wins on name clash). The active skill's text is prepended to every
 * message -- pure prompt injection, no server support needed.
 *
 * --proxy is parsed by pod.js at require time off the same argv, so it works
 * here too (default 127.0.0.1:7897).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { execFileSync } = require("child_process");

const pod = require("./pod.js");
const {
  HOME, DEFAULTS, S, C, log, ok, warn, bad, oneLine,
  connect, rpc, loadToken, ledger, freeSetupRuns,
  composerInfo, conversation, waitForIdle, MODEL_CATALOG,
} = pod;

/* ------------------------------------------------------------------- args */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}
const F = parseArgs(process.argv.slice(2)).flags;

const PROJECT = F.path ? path.resolve(String(F.path)) : process.cwd();
const SESSIONS = path.join(HOME, "secrets", "sessions");
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const errCode = (raw) => (String(raw).match(/ERROR_[A-Z0-9_]+/) || [""])[0];

let model = String(F.model || "claude-opus-5-5-low");
let client = null;
let rl = null;
let BC = null;            // window id
let BRIDGE = null;        // {repo, baseBranch, baseTip, baseRefs[], snapshot, project, createdMs}
let MSGCOUNT = 0;         // conversation messages already printed
let SEENROWS = new Set(); // ledger rows already accounted
let ACTIVE_SKILL = null;  // {name, text}
let abortPoll = false;
let busy = false;
const queue = [];

/* -------------------------------------------------------------------- git */
let GITROOT = null; // resolved repo root (PROJECT may be a subdir)
function git(args, opts = {}) {
  return execFileSync("git", args, {
    cwd: opts.cwd || (BRIDGE && BRIDGE.project) || GITROOT || PROJECT,
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: opts.env,
  }).trim();
}
function tryGit(args, opts) { try { return git(args, opts); } catch { return null; } }
function gitErr(e) { return String((e && (e.stderr || e.message)) || "").split("\n").slice(0, 2).join(" ").trim(); }

function normalizeRepoUrl(u) {
  const s = String(u).trim().replace(/\.git$/, "");
  let m = s.match(/^git@github\.com:(.+)$/); if (m) return "https://github.com/" + m[1];
  m = s.match(/^https?:\/\/github\.com\/(.+)$/i); if (m) return "https://github.com/" + m[1];
  m = s.match(/^([\w.-]+\/[\w.-]+)$/); if (m) return "https://github.com/" + m[1];
  return s;
}
function remoteHeads() {
  try {
    return git(["ls-remote", "--heads", "origin"]).split("\n")
      .map((l) => (l.match(/refs\/heads\/(\S+)/) || [])[1]).filter(Boolean);
  } catch { return []; }
}

/**
 * Push a snapshot of the current working tree (incl. uncommitted changes) as a
 * new branch, via a scratch index so the user's real index and worktree stay
 * exactly as they are.
 */
function snapshotPush() {
  GITROOT = tryGit(["rev-parse", "--show-toplevel"]);
  if (!GITROOT) { bad(`"${PROJECT}" is not inside a git repository`); process.exit(2); }
  const origin = tryGit(["remote", "get-url", "origin"]);
  if (!origin) { bad("no git remote 'origin' -- add one, or use: node chat.js --repo URL"); process.exit(2); }
  const repo = normalizeRepoUrl(origin);
  log(C.bold("git bridge"));
  log(`  project : ${GITROOT}`);
  log(`  origin  : ${repo}`);

  const baseRefs = remoteHeads();
  const head = tryGit(["rev-parse", "HEAD"]);
  if (!head) { bad("repo has no commits yet -- commit something first"); process.exit(2); }

  const idx = path.join(os.tmpdir(), `pod-chat-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    git(["read-tree", "HEAD"], { env });
    git(["add", "-A"], { env });
    const tree = git(["write-tree"], { env });
    const commit = git(["commit-tree", tree, "-p", head, "-m", "pod chat snapshot (working tree)"]);
    const stamp = new Date().toISOString().slice(2, 16).replace(/[-T:]/g, "");
    const branch = `pod/chat-${stamp}`;
    log(C.dim(`  pushing working-tree snapshot -> ${branch} ...`));
    try {
      git(["push", "origin", `${commit}:refs/heads/${branch}`]);
    } catch (e) {
      bad("push failed: " + gitErr(e));
      log(C.dim("  (https remotes need stored credentials; ssh remotes need your key)"));
      process.exit(3);
    }
    ok(`  snapshot ${branch} (${commit.slice(0, 8)}) pushed -- your local index/worktree untouched`);
    return { repo, baseBranch: branch, baseTip: commit, baseRefs, snapshot: commit, project: GITROOT, createdMs: Date.now() };
  } finally {
    try { fs.unlinkSync(idx); } catch {}
  }
}

/* -------------------------------------------------------------------- api */
async function ensureClient() {
  if (!client || client.destroyed) client = await connect();
  return client;
}
async function api(pathname, body) {
  let r = await rpc(await ensureClient(), pathname, body);
  if (r.err || r.timeout) { client = null; r = await rpc(await ensureClient(), pathname, body); }
  return r;
}
const info = async (bc = BC) => composerInfo(await ensureClient(), bc);
const conv = async (bc = BC) => conversation(await ensureClient(), bc);
async function rowsFor(bc = BC, minutes = 240) {
  return (await ledger(await ensureClient(), minutes)).filter((r) => String(r.conversationId) === bc);
}

async function createWindow(repo, branch, modelId) {
  const text = "Standby for tasks. Do not change anything yet.";
  const bcId = "bc-" + crypto.randomUUID();
  const body = {
    bcId,
    snapshotNameOrId: repo, snapshotWorkspaceRootPath: "/workspace", returnImmediately: true,
    repoUrl: repo, source: DEFAULTS.glassSource, autoBranch: true, baseBranch: branch,
    addInitialMessageToResponses: true, enableSetupVmEnvironmentTool: true,
    repositoryInfo: { pathEncryptionKey: "", shouldSyncIndex: false },
    requestedModels: [{ modelId }],
    prompt: text,
    conversationAction: { userMessageAction: { userMessage: { text, messageId: crypto.randomUUID() } } },
    startingMessageType: 1,
    devcontainerStartingPoint: { url: repo, ref: branch },
    environmentSetupRunStartedMetadata: {
      setupSessionId: crypto.randomUUID(), surface: "glass", entrypoint: "onboarding", resumedSession: false,
    },
  };
  const r = await api(S.Composer + "StartBackgroundComposerFromSnapshot", body);
  return { status: r.status, raw: r.raw, bcId: r.status === 200 ? bcId : null };
}

/* ---------------------------------------------------------------- sessions */
function saveSession() {
  if (!BC) return;
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.writeFileSync(path.join(SESSIONS, BC + ".json"), JSON.stringify({
    bcId: BC, model, bridge: BRIDGE, savedAt: new Date().toISOString(),
  }, null, 2));
}
function loadSession(bcId) {
  try { return JSON.parse(fs.readFileSync(path.join(SESSIONS, bcId + ".json"), "utf8")); }
  catch { return null; }
}

/* ------------------------------------------------------------------ skills */
function skillFiles() {
  const map = new Map();
  for (const dir of [path.join(HOME, "skills"), path.join(PROJECT, ".pod", "skills")]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".md")) map.set(f.replace(/\.md$/, ""), path.join(dir, f)); // project dir wins
    }
  }
  return map;
}
function setSkill(name) {
  const file = skillFiles().get(name);
  if (!file) { warn(`no skill "${name}" (/skills lists what exists)`); return; }
  ACTIVE_SKILL = { name, text: fs.readFileSync(file, "utf8").trim() };
  ok(`skill on: ${name} -- prepended to every message (/skill off disables)`);
}

/* --------------------------------------------------------------- messages */
const isHuman = (m) => m.type === 1 || m.type === "MESSAGE_TYPE_HUMAN" || m.type === "human";
function typeTag(m) { return String(m.type ?? m.role ?? "ai").replace(/^MESSAGE_TYPE_/, "").toLowerCase(); }
function printMsg(m) {
  const text = String(m.text || "").trim();
  if (!text || isHuman(m)) return;
  log(C.cyan(`[${typeTag(m) || "ai"}] `) + text);
}

async function awaitReply(timeoutS = Number(F.timeout || 900), pollMs = Number(F.poll || 5000)) {
  abortPoll = false;
  const deadline = Date.now() + timeoutS * 1000;
  let stable = 0, status = "?";
  while (Date.now() < deadline) {
    if (abortPoll) { log(C.yellow("\n(poll interrupted -- /sync re-checks later)")); return "INTERRUPTED"; }
    await sleep(pollMs);
    process.stdout.write(C.dim("."));
    const c = await conv();
    if (!c || c.error) { client = null; continue; }
    const msgs = c.conversation || [];
    for (let i = MSGCOUNT; i < msgs.length; i++) printMsg(msgs[i]);
    MSGCOUNT = Math.max(MSGCOUNT, msgs.length);
    const inf = await info().catch(() => null);
    status = inf?.status || "?";
    if (!/RUNNING|CREATING/.test(status)) { stable++; if (stable >= 2) break; } else stable = 0;
  }
  log("");
  return status;
}

async function refreshLedger({ quiet = true } = {}) {
  const rows = await rowsFor();
  let billedNew = false;
  for (const r of rows) {
    const k = r.timestamp + "|" + r.model;
    if (SEENROWS.has(k)) continue;
    SEENROWS.add(k);
    if (!quiet) log(`  ${r.isChargeable ? C.red("BILLED") : C.green("free  ")} ${String(r.model).padEnd(30)} cents=${r.chargedCents}`);
    if (r.isChargeable) billedNew = true;
  }
  const billed = rows.some((r) => r.isChargeable === true);
  const used = Math.max(0, rows.length - 1);
  const left = billed ? 0 : Math.max(0, DEFAULTS.freeFollowupsPerWindow - used);
  return { rows, billed, billedNew, left };
}

async function sendTask(text) {
  const full = ACTIVE_SKILL
    ? `[skill: ${ACTIVE_SKILL.name}]\n${ACTIVE_SKILL.text}\n[end of skill]\n\n---\n\n${text}`
    : text;
  const r = await api(S.Composer + "AddAsyncFollowupBackgroundComposer", {
    bcId: BC,
    followupMessage: { text: full, type: 1, bubbleId: crypto.randomUUID(), messageId: crypto.randomUUID() },
    requestedModel: { modelId: model },
  });
  if (r.status !== 200) {
    bad(`send failed: ${r.status} ${errCode(r.raw)}`);
    if (/UNSUPPORTED_REGION/.test(r.raw)) log(C.dim("  region-gated -> run: node clash.js region-us"));
    return;
  }
  log(C.dim(`sent to ${model}; waiting for the agent`));
  const status = await awaitReply();
  const led = await refreshLedger();
  if (led.billedNew && !F["no-guard"]) bad("!!! BILLED row appeared -- stop using this window (/exit, switch account)");
  log(C.dim(`window ${status}  |  free slots left: ${led.left}`));
  if (BRIDGE) log(C.dim("agent changes land on its auto branch -- /pull reviews & applies them locally"));
}

/* ------------------------------------------------------------------ /pull */
function ask(q) {
  return new Promise((res) => rl.question(q, (x) => res(String(x).trim().toLowerCase())));
}
/** fetch + list agent branches: refs newer than this window that we didn't ship */
function fetchAndList() {
  const dir = BRIDGE.project;
  if (!fs.existsSync(dir)) { bad("project dir is gone: " + dir); return null; }
  try { git(["fetch", "origin", "--prune"], { cwd: dir }); }
  catch (e) { bad("fetch failed: " + gitErr(e)); return null; }
  const since = (BRIDGE.createdMs || Date.now()) / 1000 - 3600;
  const out = git(["for-each-ref", "--format=%(refname:short) %(committerdate:unix)", "refs/remotes/origin"], { cwd: dir });
  const cands = [];
  for (const line of String(out).split("\n").filter(Boolean)) {
    const [ref, ts] = line.split(" ");
    const name = ref.replace(/^origin\//, "");
    if (name === "HEAD" || name === BRIDGE.baseBranch) continue;
    if ((BRIDGE.baseRefs || []).includes(name)) continue;
    if (Number(ts) < since) continue; // predates this window -> not the agent's
    cands.push(name);
  }
  return { dir, cands };
}
function showBranch(dir, name) {
  const ref = "origin/" + name;
  log(C.bold(`\nagent branch: ${name}`));
  try {
    log(C.dim("  commits:"));
    for (const l of git(["log", "--oneline", `${BRIDGE.baseTip}..${ref}`], { cwd: dir }).split("\n").filter(Boolean)) log("    " + l);
    log(C.dim("  changes:"));
    for (const l of git(["diff", "--stat", `${BRIDGE.baseTip}..${ref}`], { cwd: dir }).split("\n").filter(Boolean)) log("    " + l);
  } catch (e) { bad("inspect failed: " + gitErr(e)); }
}
function applyChoice(a, dir, name) {
  const ref = "origin/" + name;
  try {
    if (a === "p" || a.startsWith("patch")) {
      const diff = execFileSync("git", ["diff", `${BRIDGE.baseTip}..${ref}`],
        { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      execFileSync("git", ["apply", "--whitespace=nowarn", "-"],
        { cwd: dir, input: diff, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      ok(`patched working tree from ${name} -- uncommitted; review with git diff, commit when happy`);
    } else if (a === "m" || a.startsWith("merge")) {
      git(["merge", "--no-edit", ref], { cwd: dir });
      ok(`merged ${name} into the current branch`);
    } else log(C.dim("skipped"));
  } catch (e) { bad("apply failed: " + gitErr(e) + C.dim("\n  (patch conflicts? commit/stash local changes and retry)")); }
}
async function cmdDiff() {
  if (!BRIDGE) { warn("no git bridge in this session"); return; }
  const r = fetchAndList();
  if (!r) return;
  if (!r.cands.length) { warn("no agent branch yet (it appears only when the agent commits changes)"); return; }
  for (const name of r.cands) showBranch(r.dir, name);
}
async function cmdPull() {
  if (!BRIDGE) { warn("no git bridge in this session"); return; }
  const r = fetchAndList();
  if (!r) return;
  if (!r.cands.length) { warn("no agent branch yet (it appears only when the agent commits changes)"); return; }
  for (const name of r.cands) {
    showBranch(r.dir, name);
    let a = await ask("  apply how? [d]iff / [p]atch worktree / [m]erge branch / [n]othing : ");
    if (a === "d" || a.startsWith("diff")) {
      try { log(git(["diff", `${BRIDGE.baseTip}..origin/${name}`], { cwd: r.dir })); } catch (e) { bad(gitErr(e)); }
      a = await ask("  now apply? [p]atch / [m]erge / [n]o : ");
    }
    applyChoice(a, r.dir, name);
    return; // one branch per /pull; rerun for more
  }
}

/* -------------------------------------------------------------- /models */
function cmdModels() {
  log(C.bold("free (measured on a free window)"));
  for (const [req, actual] of MODEL_CATALOG.free) log(`  ${req.padEnd(32)} -> ${C.green(actual)}`);
  log(C.bold("\nbilled even on a free window"));
  for (const [req, note] of MODEL_CATALOG.billed) log(`  ${req.padEnd(32)} -> ${C.red(note)}`);
  log(C.bold("\ninvalid ids (404)"));
  log(C.dim("  " + MODEL_CATALOG.invalid.join(", ")));
  log(C.dim("\nthe server rewrites some ids; /slots + ledger show what actually ran"));
}
function setModel(id) {
  if (!id) { log(`current model: ${C.bold(model)}`); return; }
  if (MODEL_CATALOG.invalid.includes(id)) { warn(`${id} is a known-bad id (404)`); return; }
  if (MODEL_CATALOG.billed.some((x) => x[0] === id)) warn(`${id}: measured BILLED even on free windows -- continuing anyway`);
  else if (!MODEL_CATALOG.free.some((x) => x[0] === id)) log(C.dim(`${id} is unverified -- the ledger will tell`));
  model = id; saveSession();
  ok(`model: ${model}`);
}

/* ---------------------------------------------------------------- commands */
function cmdHelp() {
  log(C.bold("commands"));
  log(`  /model <id>    switch model (now: ${model})    /models   catalog`);
  log(`  /skill <name>  prepend skill to messages       /skills   list`);
  log(`  /skill off     stop prepending`);
  log(`  /status        window info                     /slots    free slots left`);
  log(`  /sync          re-pull the conversation        /diff     agent branch stats`);
  log(`  /pull          review + apply agent changes    /exit     leave`);
  log(C.dim("anything else is sent as a task message to the cloud agent"));
}
async function handleCommand(t) {
  const sp = t.indexOf(" ");
  const cmd = (sp < 0 ? t : t.slice(0, sp)).slice(1).toLowerCase();
  const rest = sp < 0 ? "" : t.slice(sp + 1).trim();
  switch (cmd) {
    case "help": case "h": return cmdHelp();
    case "model": return setModel(rest);
    case "models": return cmdModels();
    case "skills": {
      const m = skillFiles();
      if (!m.size) { log(C.dim("no skills yet -- drop .md files into <pod>/skills/ or <project>/.pod/skills/")); return; }
      for (const [name, file] of m)
        log(`  ${ACTIVE_SKILL && ACTIVE_SKILL.name === name ? C.green(name + " *") : name.padEnd(16)} ${C.dim(file)}`);
      return;
    }
    case "skill": {
      if (!rest || rest === "off") { ACTIVE_SKILL = null; ok("skill off"); return; }
      return setSkill(rest);
    }
    case "status": {
      const inf = await info();
      log(`window ${BC}`);
      log(`  repo=${inf?.repo || "?"}  status=${inf?.status || "?"}  model=${inf?.modelName || "?"}`);
      return;
    }
    case "slots": {
      const led = await refreshLedger();
      log(`free slots left: ${led.left}${led.billed ? C.red("  (window already BILLED)") : ""}`);
      return;
    }
    case "sync": {
      const c = await conv();
      if (!c || c.error) { warn("conversation not readable right now"); return; }
      const msgs = c.conversation || [];
      for (let i = MSGCOUNT; i < msgs.length; i++) printMsg(msgs[i]);
      MSGCOUNT = Math.max(MSGCOUNT, msgs.length);
      return;
    }
    case "diff": return cmdDiff();
    case "pull": return cmdPull();
    case "exit": case "quit": case "q": return process.exit(0);
    default: warn(`unknown command /${cmd} (/help)`);
  }
}

/* ---------------------------------------------------------------- startup */
async function boot() {
  log(C.bold("pod chat -- cloud-agent REPL"));
  loadToken(); // exits with a hint if missing
  const cl = await ensureClient();

  const free = await freeSetupRuns(cl);
  log(`free setup runs: ${free.raw.includes("remainingRuns") ? C.green(free.raw) : C.yellow(free.raw + "  (pool exhausted -- a NEW window will bill!)")}`);

  /* attach mode */
  if (F.bc) {
    BC = String(F.bc);
    const inf = await info();
    log(C.bold(`\nattach ${BC}`));
    log(`  repo=${inf?.repo || "?"}  status=${inf?.status || "?"}  model=${inf?.modelName || "?"}`);
    const s = loadSession(BC);
    if (s && s.bridge && fs.existsSync(s.bridge.project)) {
      BRIDGE = s.bridge;
      BRIDGE.createdMs = inf?.createdAtMs || BRIDGE.createdMs || Date.now();
      ok(`git bridge restored: ${BRIDGE.project} (base ${BRIDGE.baseBranch || BRIDGE.baseTip?.slice(0, 8)})`);
    } else {
      GITROOT = tryGit(["rev-parse", "--show-toplevel"]);
      const origin = GITROOT ? tryGit(["remote", "get-url", "origin"]) : null;
      if (origin && normalizeRepoUrl(origin) === inf?.repo) {
        BRIDGE = {
          repo: inf.repo, baseBranch: null, baseTip: tryGit(["rev-parse", "HEAD"]),
          baseRefs: remoteHeads(), snapshot: null, project: GITROOT,
          createdMs: inf?.createdAtMs || Date.now(),
        };
        log(C.dim("bridge improvised from the matching local clone (base = local HEAD; /pull lists branches newer than this window)"));
      } else {
        log(C.dim("no git bridge (run from the project dir to enable /pull)"));
      }
    }
    if (s && s.model && !F.model) model = s.model;
    const c = await conv();
    MSGCOUNT = (c?.conversation || []).length;
    const led = await refreshLedger();
    log(C.dim(`history: ${MSGCOUNT} messages (not replayed); /sync prints only new ones`));
    log(`free slots left: ${led.left}${led.billed ? C.red("  (BILLED window)") : ""}`);
    saveSession();
    return;
  }

  /* remote-repo mode */
  if (F.repo) {
    const repo = normalizeRepoUrl(String(F.repo));
    let res = null, usedBranch = null;
    for (const b of (F.branch ? [String(F.branch)] : ["main", "master"])) {
      log(C.dim(`setup on ${repo} (${b}) ...`));
      res = await createWindow(repo, b, model);
      if (res.bcId) { usedBranch = b; break; }
      log(C.dim(`  ${res.status} ${oneLine(res.raw, 120)}`));
      if (!/branch/i.test(res.raw)) break;
    }
    if (!res || !res.bcId) { bad("could not open a window: " + (res ? errCode(res.raw) || res.status : "?")); process.exit(3); }
    BC = res.bcId;
    GITROOT = tryGit(["rev-parse", "--show-toplevel"]);
    const origin = GITROOT ? tryGit(["remote", "get-url", "origin"]) : null;
    if (origin && normalizeRepoUrl(origin) === repo) {
      const tip = tryGit(["ls-remote", "origin", "refs/heads/" + usedBranch]);
      BRIDGE = {
        repo, baseBranch: usedBranch, baseTip: tip ? tip.split("\t")[0] : null,
        baseRefs: remoteHeads(), snapshot: null, project: GITROOT, createdMs: Date.now(),
      };
      log(C.dim("matching local clone found -- /pull enabled"));
    }
    await afterSetup();
    return;
  }

  /* snapshot mode (default) */
  BRIDGE = snapshotPush();
  log(C.dim("opening window ..."));
  const res = await createWindow(BRIDGE.repo, BRIDGE.baseBranch, model);
  if (!res.bcId) { bad(`setup failed: ${res.status} ${errCode(res.raw)}`); process.exit(3); }
  BC = res.bcId;
  await afterSetup();
}

/** post-setup: wait idle, money-check the setup row, baseline conversation */
async function afterSetup() {
  saveSession();
  ok(`window ${BC}  (model ${model})`);
  log(C.dim("waiting for the environment setup to finish (this can take minutes) ..."));
  const idle = await waitForIdle(await ensureClient(), BC, Number(F.setupwait || 1200), 20);
  log(`  status: ${idle.status}${idle.timedOut ? C.yellow("  (timeout -- sending may still work)") : ""}`);

  const rows = await rowsFor();
  for (const r of rows) SEENROWS.add(r.timestamp + "|" + r.model);
  if (rows.some((r) => r.isChargeable === true) && !F.force) {
    bad("the setup row is BILLED -- this window costs real money. aborting. (override with --force)");
    process.exit(4);
  }
  for (const r of rows)
    log(`  ${r.isChargeable ? C.red("BILLED") : C.green("free  ")} ${String(r.model).padEnd(30)} cents=${r.chargedCents}  (setup row)`);
  const led = await refreshLedger();
  const c = await conv();
  MSGCOUNT = (c?.conversation || []).length;
  log(C.bold(`free slots left: ${led.left}`));
  log(C.dim("type a task, or /help. changes come back with /pull"));
}

/* ------------------------------------------------------------------- repl */
function startRepl() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: C.bold("you > ") });
  rl.prompt();
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return rl.prompt();
    if (t.startsWith("/")) {
      if (busy && !/^\/(exit|quit|q)$/i.test(t)) { warn(C.dim("(busy -- command runs after the agent replies)")); return rl.prompt(); }
      handleCommand(t).then(() => rl.prompt()).catch((e) => { bad("ERR " + e.message); rl.prompt(); });
      return;
    }
    if (busy) { queue.push(t); log(C.dim(`(busy -- queued #${queue.length})`)); return; }
    busy = true;
    sendTask(t)
      .then(async () => {
        busy = false;
        while (queue.length) { const n = queue.shift(); log(C.dim(`\n-- queued: ${oneLine(n, 60)}`)); await sendTask(n); }
      })
      .catch((e) => { bad("ERR " + e.message); busy = false; })
      .finally(() => rl.prompt());
  });
  rl.on("SIGINT", () => { abortPoll = true; log(C.dim("\n(interrupting poll -- /exit to leave)")); });
  rl.on("close", () => {
    if (client) try { client.destroy(); } catch {}
    log(C.dim(`\nbye. re-attach: node chat.js --bc ${BC}`));
    process.exit(0);
  });
}

/* -------------------------------------------------------------------- go */
boot()
  .then(startRepl)
  .catch((e) => {
    const msg = String((e && e.message) || e);
    bad("ERR " + msg);
    if (/CONNECT|ECONNREFUSED|ENOTFOUND|proxy/i.test(msg))
      log(C.dim("  is the proxy up? default 127.0.0.1:7897 (--proxy to change) -- node clash.js exit checks it"));
    process.exit(1);
  });
