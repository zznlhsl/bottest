const fs = require("fs");
const path = require("path");
const http = require("http");
const http2 = require("http2");
const tls = require("tls");
const crypto = require("crypto");

const HOME = process.env.POD_HOME || __dirname;
const SECRETS = path.join(HOME, "secrets");
const SECRET_FILE = path.join(SECRETS, "webacct_session.json");
const ACCOUNTS_FILE = path.join(SECRETS, "accounts.json");
const PROXY = "127.0.0.1:7897";
const HOST = "api2.cursor.sh";
const PORT = 4567;

/* -------------------------------------------------- Token & Checksum */
let STORAGE = {};
try {
  STORAGE = JSON.parse(
    fs.readFileSync(path.join(process.env.APPDATA || "", "Cursor", "User", "globalStorage", "storage.json"), "utf8")
  );
} catch {}

function loadToken() {
  if (fs.existsSync(SECRET_FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(SECRET_FILE, "utf8"));
      if (j.jwt) return j;
    } catch {}
  }
  const token = STORAGE["cursorAuth/accessToken"];
  const userId = STORAGE["cursorAuth/userId"] || "user_local";
  if (token) {
    fs.mkdirSync(SECRETS, { recursive: true });
    const data = { jwt: token, userId, sessionToken: `${userId}::${token}`, capturedAt: new Date().toISOString() };
    fs.writeFileSync(SECRET_FILE, JSON.stringify(data, null, 2));
    return data;
  }
  throw new Error("No token found. Please login to Cursor first.");
}

function parseTokenString(str) {
  let text = str.trim();
  if (text.includes("WorkosCursorSessionToken=")) {
    text = (text.match(/WorkosCursorSessionToken=([^;]+)/) || [])[1] || text;
  }
  try { text = decodeURIComponent(text); } catch {}
  const sep = text.indexOf("::");
  const jwt = sep >= 0 ? text.slice(sep + 2) : text;
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("无效的 Token 格式（需为 JWT 或 Workos 完整 Cookie）");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  const userId = sep >= 0 ? text.slice(0, sep) : String(payload.sub || "").split("|").pop() || "user_imported";
  return {
    jwt,
    userId,
    sessionToken: `${userId}::${jwt}`,
    email: payload.email || payload.name || "Unknown",
    capturedAt: new Date().toISOString(),
  };
}

function getAccountsList() {
  let list = [];
  if (fs.existsSync(ACCOUNTS_FILE)) {
    try { list = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8")); } catch {}
  }
  return list;
}

function saveAccount(acc) {
  const list = getAccountsList();
  const idx = list.findIndex((a) => a.userId === acc.userId || a.email === acc.email);
  if (idx >= 0) list[idx] = acc;
  else list.push(acc);
  fs.mkdirSync(SECRETS, { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(list, null, 2));
}

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

/* -------------------------------------------------- HTTP2 via CONNECT proxy */
function connect() {
  return new Promise((resolve, reject) => {
    const [ph, pp] = PROXY.split(":");
    const req = http.request({
      host: ph, port: Number(pp || 80), method: "CONNECT",
      path: `${HOST}:443`, headers: { host: `${HOST}:443` },
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error("Proxy CONNECT error " + res.statusCode));
      const t = tls.connect({ socket, servername: HOST, ALPNProtocols: ["h2"], rejectUnauthorized: false }, () => {
        const c = http2.connect(`https://${HOST}`, { createConnection: () => t });
        c.on("error", reject);
        c.on("connect", () => resolve(c));
      });
      t.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function rpc(client, rpcPath, body) {
  const token = loadToken().jwt;
  return new Promise((resolve) => {
    const chunks = [];
    let status = 0;
    const req = client.request({
      ":method": "POST",
      ":path": "/" + rpcPath,
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "connect-protocol-version": "1",
      "x-cursor-checksum": checksum(),
      "x-cursor-client-type": "glass",
      "x-cursor-client-version": "3.20.10",
      "x-cursor-client-commit": "d6f462cdd0a6a6d1cff570daf980e671d0a63ded",
      "x-ghost-mode": "false",
      "x-request-id": crypto.randomUUID(),
    });
    req.on("response", (h) => (status = Number(h[":status"] || 0)));
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve({ status, raw: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", (e) => resolve({ status: -1, raw: e.message }));
    req.end(Buffer.from(JSON.stringify(body)));
  });
}

const S = {
  Dashboard: "aiserver.v1.DashboardService/",
  Composer: "aiserver.v1.BackgroundComposerService/",
};

async function getLedger(client, minutes = 60) {
  const r = await rpc(client, S.Dashboard + "GetFilteredUsageEvents", {
    filterTeamMembers: [],
    pageNumber: 1,
    pageSize: 50,
    startTime: (Date.now() - minutes * 60 * 1000).toString(),
    endTime: Date.now().toString(),
  });
  try {
    const j = JSON.parse(r.raw);
    return (j.usageEvents || []).map((e) => ({
      timestamp: e.timestamp,
      model: e.modelDetails?.modelName || e.modelName || "-",
      chargedCents: Number(e.chargedCents || 0),
      isChargeable: Boolean(e.isChargeable),
      conversationId: e.conversationId || "-",
      kind: e.kind || "-",
    }));
  } catch {
    return [];
  }
}

async function getComposerInfo(client, bcId) {
  const r = await rpc(client, S.Composer + "GetBackgroundComposerInfo", { bcId });
  try {
    const j = JSON.parse(r.raw);
    return {
      name: j.name || "",
      repo: j.repoUrl || "",
      status: j.status || "",
      modelName: j.modelDetails?.modelName || "",
      envPublicId: j.environmentPublicId || "",
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------- Web Server & API */
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsed.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(200); return res.end(); }

  if (pathname.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    // 1. Status
    if (pathname === "/api/status") {
      let client;
      try {
        client = await connect();
        const me = await rpc(client, S.Dashboard + "GetMe", {});
        const plan = await rpc(client, S.Dashboard + "GetPlanInfo", {});
        const usage = await rpc(client, S.Dashboard + "GetCurrentPeriodUsage", {});
        const free = await rpc(client, S.Dashboard + "IsNextSetupRunFree", {});
        const envs = await rpc(client, S.Composer + "ListEnvironments", {});
        client.destroy();

        // Sync account to list
        try {
          const accData = JSON.parse(me.raw || "{}");
          if (accData.email) {
            const currentToken = loadToken();
            saveAccount({ ...currentToken, email: accData.email });
          }
        } catch {}

        return res.end(JSON.stringify({
          ok: true,
          account: JSON.parse(me.raw || "{}"),
          plan: JSON.parse(plan.raw || "{}"),
          usage: JSON.parse(usage.raw || "{}"),
          free: JSON.parse(free.raw || "{}"),
          environments: JSON.parse(envs.raw || "{}").environments || [],
          accounts: getAccountsList(),
          proxy: PROXY,
        }));
      } catch (err) {
        if (client) client.destroy();
        return res.end(JSON.stringify({ ok: false, error: err.message, accounts: getAccountsList() }));
      }
    }

    // 2. Switch Account / Import Token
    if (pathname === "/api/switch-account" && req.method === "POST") {
      let bodyStr = "";
      req.on("data", (c) => (bodyStr += c));
      req.on("end", async () => {
        try {
          const params = JSON.parse(bodyStr || "{}");
          let accData;
          if (params.token) {
            accData = parseTokenString(params.token);
          } else if (params.userId) {
            const list = getAccountsList();
            accData = list.find((a) => a.userId === params.userId);
            if (!accData) throw new Error("未找到对应账号");
          } else if (params.fromStorage) {
            const token = STORAGE["cursorAuth/accessToken"];
            const userId = STORAGE["cursorAuth/userId"] || "user_local";
            if (!token) throw new Error("本地 Cursor 中未检测到登录 Token");
            accData = { jwt: token, userId, sessionToken: `${userId}::${token}`, capturedAt: new Date().toISOString() };
          } else {
            throw new Error("参数不足");
          }

          fs.mkdirSync(SECRETS, { recursive: true });
          fs.writeFileSync(SECRET_FILE, JSON.stringify(accData, null, 2));
          saveAccount(accData);

          return res.end(JSON.stringify({ ok: true, current: accData }));
        } catch (err) {
          return res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // 3. Windows & Ledger
    if (pathname === "/api/windows") {
      let client;
      try {
        client = await connect();
        const rows = await getLedger(client, 240);
        const byBc = new Map();
        for (const r of rows) {
          const k = String(r.conversationId || "");
          if (!k.startsWith("bc-")) continue;
          if (!byBc.has(k)) byBc.set(k, []);
          byBc.get(k).push(r);
        }
        const windows = [];
        for (const [bc, rs] of byBc) {
          const info = await getComposerInfo(client, bc);
          const billed = rs.filter((r) => r.isChargeable);
          const freeRows = rs.filter((r) => !r.isChargeable);
          windows.push({
            bcId: bc,
            info,
            rows: rs,
            totalRows: rs.length,
            isBilled: billed.length > 0,
            freeCount: freeRows.length,
            usedSlots: Math.max(0, rs.length - 1),
            remainingSlots: billed.length ? 0 : Math.max(0, 5 - Math.max(0, rs.length - 1)),
          });
        }
        client.destroy();
        return res.end(JSON.stringify({ ok: true, windows }));
      } catch (err) {
        if (client) client.destroy();
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 4. Setup (Create Window)
    if (pathname === "/api/setup" && req.method === "POST") {
      let bodyStr = "";
      req.on("data", (c) => (bodyStr += c));
      req.on("end", async () => {
        let client;
        try {
          const params = JSON.parse(bodyStr || "{}");
          const repo = params.repo || "https://github.com/octocat/Hello-World";
          const branch = params.branch || "master";
          const model = params.model || "claude-opus-5-5-low";
          const prompt = params.prompt || "Hello! Cloud environment setup initialized.";

          client = await connect();
          const bcId = "bc-" + crypto.randomUUID();
          const body = {
            bcId,
            snapshotNameOrId: repo,
            snapshotWorkspaceRootPath: "/workspace",
            returnImmediately: true,
            repoUrl: repo,
            source: "BACKGROUND_COMPOSER_SOURCE_ENVIRONMENT_SETUP_GLASS",
            autoBranch: true,
            baseBranch: branch,
            addInitialMessageToResponses: true,
            enableSetupVmEnvironmentTool: true,
            repositoryInfo: { pathEncryptionKey: "", shouldSyncIndex: false },
            requestedModels: [{ modelId: model }],
            prompt,
            conversationAction: { userMessageAction: { userMessage: { text: prompt, messageId: crypto.randomUUID() } } },
            startingMessageType: 1,
            devcontainerStartingPoint: { url: repo, ref: branch },
            environmentSetupRunStartedMetadata: {
              setupSessionId: crypto.randomUUID(), surface: "glass", entrypoint: "onboarding", resumedSession: false,
            },
          };
          if (params.envId) body.environmentPublicId = params.envId;

          const r = await rpc(client, S.Composer + "StartBackgroundComposerFromSnapshot", body);
          client.destroy();
          return res.end(JSON.stringify({
            ok: r.status === 200,
            status: r.status,
            bcId,
            raw: r.raw,
          }));
        } catch (err) {
          if (client) client.destroy();
          return res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // 5. Send Message / Ask AI (with Stop-Loss Guard)
    if (pathname === "/api/chat" && req.method === "POST") {
      let bodyStr = "";
      req.on("data", (c) => (bodyStr += c));
      req.on("end", async () => {
        let client;
        try {
          const params = JSON.parse(bodyStr || "{}");
          const bcId = params.bcId;
          const model = params.model || "claude-opus-5-5-low";
          const text = params.prompt || "Hello";
          if (!bcId) throw new Error("bcId is required");

          client = await connect();

          const r = await rpc(client, S.Composer + "AddAsyncFollowupBackgroundComposer", {
            bcId,
            followupMessage: {
              text,
              type: 1,
              bubbleId: crypto.randomUUID(),
              messageId: crypto.randomUUID(),
            },
            requestedModel: { modelId: model },
          });

          await new Promise((s) => setTimeout(s, 5000));
          const rows = await getLedger(client, 10);
          const currentRows = rows.filter((x) => String(x.conversationId) === bcId);
          const billed = currentRows.find((x) => x.isChargeable);

          client.destroy();
          return res.end(JSON.stringify({
            ok: r.status === 200,
            status: r.status,
            raw: r.raw,
            guardTriggered: Boolean(billed),
            latestRow: currentRows[0] || null,
          }));
        } catch (err) {
          if (client) client.destroy();
          return res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // 6. Conversation History
    if (pathname === "/api/conversation") {
      const bcId = parsed.searchParams.get("bc");
      if (!bcId) return res.end(JSON.stringify({ ok: false, error: "bc param missing" }));
      let client;
      try {
        client = await connect();
        const info = await getComposerInfo(client, bcId);
        const r = await rpc(client, S.Composer + "GetBackgroundComposerConversation", { bcId });
        const rows = (await getLedger(client, 240)).filter((x) => String(x.conversationId) === bcId);
        client.destroy();
        return res.end(JSON.stringify({
          ok: true,
          info,
          data: JSON.parse(r.raw || "{}"),
          rows,
        }));
      } catch (err) {
        if (client) client.destroy();
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 7. Ledger
    if (pathname === "/api/ledger") {
      let client;
      try {
        client = await connect();
        const rows = await getLedger(client, 120);
        client.destroy();
        return res.end(JSON.stringify({ ok: true, rows }));
      } catch (err) {
        if (client) client.destroy();
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    return res.end(JSON.stringify({ ok: false, error: "Endpoint not found" }));
  }

  // HTML: Strict rule NO PURPLE! Clean Blue & Slate Theme.
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Cursor Cloud Agent 控制台</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; }
    body { background-color: #f1f5f9; color: #1e293b; padding: 20px; }
    .container { max-width: 1240px; margin: 0 auto; }
    header { background: #1e293b; color: #ffffff; padding: 18px 24px; border-radius: 12px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
    h1 { font-size: 20px; font-weight: 600; color: #ffffff; display: flex; align-items: center; gap: 8px; }
    .status-badge { display: inline-flex; align-items: center; gap: 6px; background: #059669; color: #ffffff; font-size: 13px; font-weight: 500; padding: 4px 12px; border-radius: 20px; }
    .badge-amber { background: #d97706; }
    .badge-red { background: #dc2626; }
    .grid { display: grid; grid-template-columns: 380px 1fr; gap: 20px; }
    .card { background: #ffffff; border-radius: 12px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px 0 rgba(0,0,0,0.1); border: 1px solid #e2e8f0; }
    .card-title { font-size: 15px; font-weight: 600; color: #0f172a; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #f1f5f9; padding-bottom: 8px; }
    .stat-row { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 10px; }
    .stat-label { color: #64748b; }
    .stat-value { font-weight: 600; color: #0f172a; }
    .btn { display: inline-block; background: #2563eb; color: #ffffff; border: none; padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; transition: background 0.2s; text-align: center; }
    .btn:hover { background: #1d4ed8; }
    .btn-emerald { background: #059669; }
    .btn-emerald:hover { background: #047857; }
    .btn-sm { padding: 4px 10px; font-size: 12px; border-radius: 6px; }
    .btn-secondary { background: #e2e8f0; color: #1e293b; }
    .btn-secondary:hover { background: #cbd5e1; }
    .form-group { margin-bottom: 14px; }
    label { display: block; font-size: 13px; font-weight: 500; color: #475569; margin-bottom: 6px; }
    input, select, textarea { width: 100%; border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px 12px; font-size: 13px; color: #1e293b; outline: none; transition: border 0.2s; }
    input:focus, select:focus, textarea:focus { border-color: #2563eb; ring: 2px solid #93c5fd; }
    textarea { height: 90px; resize: vertical; }
    .window-item { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 10px; cursor: pointer; transition: all 0.2s; }
    .window-item:hover, .window-item.active { border-color: #2563eb; background: #eff6ff; }
    .chat-box { height: 420px; overflow-y: auto; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin-bottom: 14px; display: flex; flex-direction: column; gap: 12px; }
    .msg { max-width: 85%; padding: 10px 14px; border-radius: 10px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
    .msg-user { align-self: flex-end; background: #2563eb; color: #ffffff; border-bottom-right-radius: 2px; }
    .msg-ai { align-self: flex-start; background: #ffffff; color: #1e293b; border: 1px solid #e2e8f0; border-bottom-left-radius: 2px; }
    .msg-meta { font-size: 11px; opacity: 0.8; margin-bottom: 4px; font-weight: 600; }
    .ledger-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
    .ledger-table th, .ledger-table td { padding: 8px; text-align: left; border-bottom: 1px solid #e2e8f0; }
    .ledger-table th { background: #f8fafc; color: #64748b; font-weight: 600; }
    .tag-free { color: #059669; font-weight: 600; }
    .tag-billed { color: #dc2626; font-weight: 600; }
    .empty-tip { text-align: center; color: #94a3b8; padding: 25px; font-size: 13px; }
    .tip-box { background: #eff6ff; border-left: 4px solid #2563eb; padding: 10px 14px; font-size: 12px; color: #1e40af; border-radius: 4px; margin-bottom: 12px; }
    .modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 999; justify-content: center; align-items: center; }
    .modal.show { display: flex; }
    .modal-content { background: #ffffff; border-radius: 12px; width: 480px; padding: 24px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.2); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
        Cursor Cloud Agent 控制台
      </h1>
      <div style="display:flex; gap:10px; align-items:center;">
        <button class="btn btn-secondary btn-sm" onclick="showSwitchModal()">换号 / 导入 Token</button>
        <span class="status-badge" id="proxyBadge">正在检查代理...</span>
      </div>
    </header>

    <div class="grid">
      <!-- 左侧栏：账号与窗口管理 -->
      <div>
        <!-- 账号信息卡片 -->
        <div class="card">
          <div class="card-title">
            <span>当前登录账号</span>
            <button class="btn btn-secondary btn-sm" onclick="refreshStatus()">刷新</button>
          </div>
          <div class="stat-row">
            <span class="stat-label">账号邮箱</span>
            <span class="stat-value" id="accEmail">加载中...</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">会员套餐</span>
            <span class="stat-value" id="accPlan">--</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">免费开窗剩余</span>
            <span class="stat-value" style="color:#059669; font-size:15px;" id="freeRuns">--</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">自动止损守卫</span>
            <span class="stat-value" style="color:#059669">● 已开启（检测到计费即停止）</span>
          </div>
        </div>

        <!-- 开辟新窗口 -->
        <div class="card">
          <div class="card-title">开辟新环境窗口</div>
          <div class="tip-box">
            💡 <strong>不需要自己创建仓库！</strong> 可以选择内置仓库或任意公开 GitHub 仓库，即可直接创建隔离的云端容器环境。
          </div>
          <div class="form-group">
            <label>预设仓库快速选择</label>
            <select id="presetRepoSelect" onchange="applyPresetRepo()">
              <option value="https://github.com/octocat/Hello-World|master">GitHub 官方测试仓库 (Hello-World, master)</option>
              <option value="origin.cursor.com/git/hill-jackson/cursor-helper-cloud-starter|main">Cursor 预置云端环境 (推荐)</option>
              <option value="https://github.com/torvalds/linux|master">公开开源仓库 (linux, master)</option>
              <option value="custom">-- 自定义仓库 URL --</option>
            </select>
          </div>
          <div class="form-group">
            <label>仓库 URL</label>
            <input id="setupRepo" value="https://github.com/octocat/Hello-World" />
          </div>
          <div class="form-group">
            <label>默认分支 (Branch)</label>
            <input id="setupBranch" value="master" />
          </div>
          <div class="form-group">
            <label>开窗首选模型</label>
            <select id="setupModel" class="model-dropdown">
              <!-- JS 填充完整高级模型列表 -->
            </select>
          </div>
          <button class="btn btn-emerald" style="width:100%" id="btnSetup" onclick="createWindow()">立即开辟新环境窗口</button>
        </div>

        <!-- 窗口列表 -->
        <div class="card">
          <div class="card-title">
            <span>活跃窗口列表</span>
            <button class="btn btn-secondary btn-sm" onclick="refreshWindows()">刷新</button>
          </div>
          <div id="windowList">
            <div class="empty-tip">近 4 小时无活跃窗口，请在上方开辟新窗口</div>
          </div>
        </div>
      </div>

      <!-- 右侧栏：对话与任务交互 -->
      <div>
        <div class="card">
          <div class="card-title">
            <span>云端对话与任务执行</span>
            <span id="activeWindowLabel" style="font-size:12px; font-weight:normal; color:#64748b;">未选择窗口</span>
          </div>

          <div class="chat-box" id="chatBox">
            <div class="empty-tip">请在左侧选择一个窗口，或者开辟新窗口后开始交互</div>
          </div>

          <div class="form-group">
            <div style="display:flex; gap:10px; margin-bottom:8px;">
              <select id="chatModel" class="model-dropdown" style="flex:1;">
                <!-- JS 填充完整高级模型列表 -->
              </select>
              <button class="btn btn-secondary btn-sm" onclick="loadConversation()">同步最新回复</button>
            </div>
            <textarea id="chatInput" placeholder="输入要让 AI 执行的代码任务、分析或提问（支持直接写需求）..."></textarea>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:12px; color:#64748b;" id="guardStatus">保护模式：每次提问后自动核验账本</span>
            <button class="btn" id="btnSend" onclick="sendMessage()">发送任务至云端</button>
          </div>
        </div>

        <!-- 账本监控卡片 -->
        <div class="card">
          <div class="card-title">
            <span>实时账本明细（近 60 分钟）</span>
            <button class="btn btn-secondary btn-sm" onclick="refreshLedger()">刷新账本</button>
          </div>
          <table class="ledger-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>实际模型</th>
                <th>扣费</th>
                <th>计费状态</th>
                <th>关联会话 ID</th>
              </tr>
            </thead>
            <tbody id="ledgerBody">
              <tr><td colspan="5" class="empty-tip">暂无调用明细</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <!-- 换号弹窗 -->
  <div class="modal" id="switchModal">
    <div class="modal-content">
      <div style="font-size:16px; font-weight:600; margin-bottom:14px;">换号 / 导入 Cursor 账号</div>
      <div class="form-group">
        <label>已保存的历史账号</label>
        <select id="savedAccountsSelect" onchange="pickSavedAccount()">
          <option value="">-- 选择已有账号直接切换 --</option>
        </select>
      </div>
      <div class="form-group">
        <label>或从本地 Cursor 重新读取</label>
        <button class="btn btn-secondary" style="width:100%; margin-bottom:10px;" onclick="syncFromLocalCursor()">从本机 Cursor IDE 重新同步</button>
      </div>
      <div class="form-group">
        <label>或粘贴新账号的 Cookie / Token</label>
        <textarea id="importTokenInput" style="height:70px;" placeholder="粘贴浏览器 cursor.com Cookie (WorkosCursorSessionToken) 或 JWT"></textarea>
      </div>
      <div style="display:flex; justify-content:flex-end; gap:10px;">
        <button class="btn btn-secondary" onclick="hideSwitchModal()">取消</button>
        <button class="btn" onclick="submitImportToken()">确认切换</button>
      </div>
    </div>
  </div>

  <script>
    let currentBcId = null;

    // 所有实测支持的高级模型及其服务端映射说明
    const MODELS = [
      { id: "claude-opus-4-8", name: "Claude Opus 4.8 (自动映射到 Thinking High 强化推理)" },
      { id: "claude-4.6-opus-high-thinking", name: "Claude 4.6 Opus (Thinking High 强化推理)" },
      { id: "claude-opus-5-5-low", name: "Claude Opus 5.5 Low (推荐免费档)" },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5 Medium (推荐免费档)" },
      { id: "claude-4.5-opus-high", name: "Claude 4.5 Opus High" },
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (自动映射到 High 档)" },
      { id: "claude-fable-5-1-thinking-max", name: "Claude Fable 5.1 Thinking Max (极致推理)" },
      { id: "claude-fable-5", name: "Claude Fable 5 (Thinking High)" },
      { id: "claude-haiku-5-5", name: "Claude Haiku 5.5 (Thinking High 极速)" },
      { id: "gpt-5.6-sol-high", name: "GPT-5.6 Sol High (OpenAI 新一代高阶)" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol Medium" },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra Medium" },
    ];

    function initModels() {
      const selects = document.querySelectorAll('.model-dropdown');
      selects.forEach(s => {
        s.innerHTML = MODELS.map(m => \`<option value="\${m.id}">\${m.name}</option>\`).join('');
      });
    }

    function applyPresetRepo() {
      const val = document.getElementById('presetRepoSelect').value;
      if (val === 'custom') return;
      const [repo, branch] = val.split('|');
      document.getElementById('setupRepo').value = repo;
      document.getElementById('setupBranch').value = branch || 'main';
    }

    async function api(path, opts = {}) {
      try {
        const res = await fetch(path, opts);
        return await res.json();
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    async function refreshStatus() {
      const res = await api('/api/status');
      if (!res.ok) {
        document.getElementById('proxyBadge').className = 'status-badge badge-red';
        document.getElementById('proxyBadge').innerText = '连接异常: ' + (res.error || '检查代理');
        return;
      }
      document.getElementById('proxyBadge').className = 'status-badge';
      document.getElementById('proxyBadge').innerText = '代理在线: ' + res.proxy + ' (US)';

      document.getElementById('accEmail').innerText = res.account.email || '已连接';
      document.getElementById('accPlan').innerText = res.plan.planInfo?.planName || '未知';
      const freeRuns = res.free.remainingRuns !== undefined ? res.free.remainingRuns + ' 次' : '已耗尽';
      document.getElementById('freeRuns').innerText = freeRuns;

      // 更新账号切换列表
      const accSelect = document.getElementById('savedAccountsSelect');
      const accounts = res.accounts || [];
      accSelect.innerHTML = '<option value="">-- 选择已有账号直接切换 --</option>' +
        accounts.map(a => \`<option value="\${a.userId}">\${a.email || a.userId} (ID: \${(a.userId||'').slice(0,12)}...)</option>\`).join('');
    }

    async function refreshWindows() {
      const res = await api('/api/windows');
      const box = document.getElementById('windowList');
      if (!res.ok || !res.windows || !res.windows.length) {
        box.innerHTML = '<div class="empty-tip">近 4 小时无活跃窗口，请在上方开辟新窗口</div>';
        return;
      }
      box.innerHTML = res.windows.map(w => {
        const isAct = w.bcId === currentBcId ? 'active' : '';
        const tag = w.isBilled ? '<span style="color:#dc2626">已计费</span>' : '<span style="color:#059669">免费(' + w.remainingSlots + '位剩余)</span>';
        return \`<div class="window-item \${isAct}" onclick="selectWindow('\${w.bcId}')">
          <div style="font-weight:600; font-size:13px; color:#0f172a; margin-bottom:4px;">\${w.bcId.slice(0, 18)}...</div>
          <div style="font-size:12px; color:#64748b;">\${w.info?.repo || '默认仓库'}</div>
          <div style="font-size:12px; margin-top:4px;">\${tag} | 已用 \${w.usedSlots}/5 次</div>
        </div>\`;
      }).join('');
    }

    function selectWindow(bcId) {
      currentBcId = bcId;
      document.getElementById('activeWindowLabel').innerText = '当前窗口: ' + bcId;
      refreshWindows();
      loadConversation();
    }

    async function createWindow() {
      const repo = document.getElementById('setupRepo').value.trim();
      const branch = document.getElementById('setupBranch').value.trim() || 'master';
      const model = document.getElementById('setupModel').value;
      const btn = document.getElementById('btnSetup');
      btn.disabled = true;
      btn.innerText = '正在开辟云端环境...';

      const res = await api('/api/setup', {
        method: 'POST',
        body: JSON.stringify({ repo, branch, model, prompt: 'Initialize cloud environment' }),
      });
      btn.disabled = false;
      btn.innerText = '立即开辟新环境窗口';

      if (res.ok && res.bcId) {
        selectWindow(res.bcId);
        refreshStatus();
        refreshWindows();
        alert('环境创建成功！窗口 ID: ' + res.bcId);
      } else {
        alert('创建失败: ' + (res.error || res.raw || '未知错误'));
      }
    }

    async function loadConversation() {
      if (!currentBcId) return;
      const box = document.getElementById('chatBox');
      box.innerHTML = '<div class="empty-tip">正在同步云端记录...</div>';
      const res = await api('/api/conversation?bc=' + currentBcId);
      if (!res.ok || !res.data) {
        box.innerHTML = '<div class="empty-tip">无法获取对话</div>';
        return;
      }
      const msgs = res.data.conversation || [];
      if (!msgs.length) {
        box.innerHTML = '<div class="empty-tip">该窗口暂无消息，请在下方输入并发送</div>';
        return;
      }
      box.innerHTML = msgs.map(m => {
        const isUser = (m.type === 1 || m.type === 'MESSAGE_TYPE_HUMAN');
        const role = isUser ? 'msg-user' : 'msg-ai';
        const name = isUser ? '你 (User)' : 'Cursor Cloud Agent';
        return \`<div class="msg \${role}">
          <div class="msg-meta">\${name}</div>
          <div>\${escapeHtml(m.text || '')}</div>
        </div>\`;
      }).join('');
      box.scrollTop = box.scrollHeight;
    }

    async function sendMessage() {
      if (!currentBcId) {
        alert('请先在左侧选择一个窗口，或者创建一个新窗口！');
        return;
      }
      const text = document.getElementById('chatInput').value.trim();
      if (!text) return;
      const model = document.getElementById('chatModel').value;
      const btn = document.getElementById('btnSend');
      btn.disabled = true;
      btn.innerText = '正在调用云端并监控账本...';

      const box = document.getElementById('chatBox');
      const tempUser = document.createElement('div');
      tempUser.className = 'msg msg-user';
      tempUser.innerHTML = '<div class="msg-meta">你 (User)</div><div>' + escapeHtml(text) + '</div>';
      box.appendChild(tempUser);
      box.scrollTop = box.scrollHeight;
      document.getElementById('chatInput').value = '';

      const res = await api('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ bcId: currentBcId, model, prompt: text }),
      });
      btn.disabled = false;
      btn.innerText = '发送任务至云端';

      if (res.guardTriggered) {
        alert('⚠️ 警告：检测到账本计费，已触发止损守卫！');
      }
      setTimeout(loadConversation, 1500);
      refreshLedger();
      refreshWindows();
    }

    async function refreshLedger() {
      const res = await api('/api/ledger');
      const tbody = document.getElementById('ledgerBody');
      if (!res.ok || !res.rows || !res.rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-tip">暂无记录</td></tr>';
        return;
      }
      tbody.innerHTML = res.rows.slice(0, 15).map(r => {
        const time = new Date(Number(r.timestamp)).toLocaleTimeString();
        const tag = r.isChargeable ? '<span class="tag-billed">收费</span>' : '<span class="tag-free">免费</span>';
        return \`<tr>
          <td>\${time}</td>
          <td>\${r.model}</td>
          <td>\${r.chargedCents}¢</td>
          <td>\${tag}</td>
          <td>\${(r.conversationId || '').slice(0, 18)}</td>
        </tr>\`;
      }).join('');
    }

    function showSwitchModal() {
      document.getElementById('switchModal').classList.add('show');
    }
    function hideSwitchModal() {
      document.getElementById('switchModal').classList.remove('show');
    }

    async function pickSavedAccount() {
      const uid = document.getElementById('savedAccountsSelect').value;
      if (!uid) return;
      const res = await api('/api/switch-account', {
        method: 'POST',
        body: JSON.stringify({ userId: uid }),
      });
      if (res.ok) {
        hideSwitchModal();
        alert('切换账号成功！');
        refreshStatus();
        refreshWindows();
      } else {
        alert('切换失败: ' + res.error);
      }
    }

    async function syncFromLocalCursor() {
      const res = await api('/api/switch-account', {
        method: 'POST',
        body: JSON.stringify({ fromStorage: true }),
      });
      if (res.ok) {
        hideSwitchModal();
        alert('已成功同步本地 Cursor 账号！');
        refreshStatus();
        refreshWindows();
      } else {
        alert('同步失败: ' + res.error);
      }
    }

    async function submitImportToken() {
      const token = document.getElementById('importTokenInput').value.trim();
      if (!token) return alert('请输入 Cookie 或 Token');
      const res = await api('/api/switch-account', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        hideSwitchModal();
        alert('新账号导入并切换成功！');
        document.getElementById('importTokenInput').value = '';
        refreshStatus();
        refreshWindows();
      } else {
        alert('导入失败: ' + res.error);
      }
    }

    function escapeHtml(str) {
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    initModels();
    refreshStatus();
    refreshWindows();
    refreshLedger();
    setInterval(refreshLedger, 30000);
  </script>
</body>
</html>`);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[Pod Web Server] Running at http://127.0.0.1:${PORT}`);
});
