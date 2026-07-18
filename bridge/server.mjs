import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import { CodexAppServerClient } from "./codex-client.mjs";
import { loadConfig, pluginRoot } from "./config.mjs";
import { DesktopIntegration } from "./desktop.mjs";
import { TaskHistoryStore } from "./history.mjs";
import { bearerToken, clearSessionCookie, SecurityStore, sessionCookie } from "./security.mjs";
import { TaskManager } from "./tasks.mjs";
import { BRIDGE_VERSION } from "./version.mjs";
import { parseWechatXml, routeWechatText, verifyWechatSignature, wechatTextReply } from "./wechat.mjs";

const publicDir = path.join(pluginRoot, "public");
const dataDir = path.join(pluginRoot, "data");
const serverStatePath = path.join(dataDir, "server.json");
const MAX_BODY_BYTES = 96 * 1024;

export const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function securityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function sendJson(response, status, body, headers = {}) {
  securityHeaders(response);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

function sendText(response, status, body, contentType = "text/plain; charset=utf-8") {
  securityHeaders(response);
  response.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request) {
  const body = await readBody(request);
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error("请求 JSON 格式不正确");
  }
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

class RateLimiter {
  constructor(limit) {
    this.limit = limit;
    this.clients = new Map();
  }

  allow(key) {
    const now = Date.now();
    const windowStart = now - 60_000;
    const entries = (this.clients.get(key) || []).filter((time) => time > windowStart);
    if (entries.length >= this.limit) return false;
    entries.push(now);
    this.clients.set(key, entries);
    if (this.clients.size > 1000) {
      for (const [client, times] of this.clients) {
        if (times.at(-1) <= windowStart) this.clients.delete(client);
      }
    }
    return true;
  }
}

export function requestLimitClass(method, pathname) {
  if (pathname === "/api/health") return "none";
  return String(method || "GET").toUpperCase() === "GET" ? "read" : "write";
}

function projectPublicView(config) {
  return config.projects.map(({ id, name }) => ({ id, name }));
}

function getWechatToken(config) {
  return process.env[config.wechat.tokenEnv] || "";
}

export async function startBridge({ configPath } = {}) {
  const config = await loadConfig(configPath);
  await mkdir(dataDir, { recursive: true });
  const security = await new SecurityStore(dataDir, config.security).init();
  const pairing = security.createPairing();
  const codex = new CodexAppServerClient({ binary: config.codex.binary });
  codex.on("log", (message) => message && console.error(`[codex] ${message}`));
  await codex.start();
  console.log(`[codex] 运行时：${codex.launch?.command || config.codex.binary}`);
  const historyStore = config.storage.persistTaskHistory
    ? new TaskHistoryStore(path.join(dataDir, "tasks.json"), config.storage)
    : null;
  const desktop = new DesktopIntegration(config.desktop);
  const tasks = await new TaskManager(codex, config, historyStore, desktop).init();
  const writeLimiter = new RateLimiter(config.security.rateLimitPerMinute);
  const readLimiter = new RateLimiter(Math.max(120, config.security.rateLimitPerMinute * 6));
  const seenWechatMessages = new Set();

  let closing = false;
  let httpServer;
  const close = async () => {
    if (closing) return;
    closing = true;
    await new Promise((resolve) => httpServer?.close(resolve));
    await codex.stop();
    await tasks.flush();
    await rm(serverStatePath, { force: true });
  };

  httpServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      const pathname = decodeURIComponent(url.pathname);
      const clientKey = request.socket.remoteAddress || "unknown";

      if (pathname.startsWith("/api/")) {
        const limitClass = requestLimitClass(request.method, pathname);
        const limiter = limitClass === "read" ? readLimiter : limitClass === "write" ? writeLimiter : null;
        if (limiter && !limiter.allow(clientKey)) {
          sendJson(response, 429, { error: "请求过于频繁，请稍后再试" }, { "Retry-After": "5" });
          return;
        }
      }
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method || "") && !sameOrigin(request)) {
        sendJson(response, 403, { error: "Origin 校验失败" });
        return;
      }

      if (pathname === "/api/health" && request.method === "GET") {
        sendJson(response, 200, {
          ok: true,
          codexReady: codex.ready,
          version: BRIDGE_VERSION,
          desktopAutoOpen: config.desktop.autoOpen,
          sessionTtlDays: config.security.sessionTtlDays,
          time: new Date().toISOString(),
        });
        return;
      }

      if (pathname === "/api/pair" && request.method === "POST") {
        const body = await readJson(request);
        const session = await security.pair(String(body.code || ""), body.deviceName);
        sendJson(response, 200, session, { "Set-Cookie": sessionCookie(session.token, session.expiresAt, request) });
        return;
      }

      if (pathname === "/wechat/callback") {
        if (!config.wechat.enabled) {
          sendText(response, 404, "微信适配器未启用");
          return;
        }
        const token = getWechatToken(config);
        if (!token) {
          sendText(response, 503, `缺少环境变量 ${config.wechat.tokenEnv}`);
          return;
        }
        const query = Object.fromEntries(url.searchParams);
        if (!verifyWechatSignature(token, query)) {
          sendText(response, 403, "signature mismatch");
          return;
        }
        if (request.method === "GET") {
          sendText(response, 200, query.echostr || "");
          return;
        }
        if (request.method !== "POST") {
          sendText(response, 405, "method not allowed");
          return;
        }
        if (query.encrypt_type === "aes") {
          sendText(response, 501, "MVP 暂不支持微信安全模式加密回调");
          return;
        }
        const incoming = parseWechatXml(await readBody(request));
        const messageId = incoming.MsgId || `${incoming.FromUserName}:${incoming.CreateTime}`;
        if (seenWechatMessages.has(messageId)) {
          sendText(response, 200, "success");
          return;
        }
        seenWechatMessages.add(messageId);
        if (seenWechatMessages.size > 200) seenWechatMessages.delete(seenWechatMessages.values().next().value);

        const rawText = incoming.MsgType === "voice" ? incoming.Recognition : incoming.Content;
        let routed;
        try {
          routed = routeWechatText(rawText, config);
        } catch (error) {
          sendText(response, 200, wechatTextReply(incoming, error.message), "application/xml; charset=utf-8");
          return;
        }
        tasks.createTask({ ...routed, source: "wechat" }).catch((error) => console.error(`[wechat] ${error.stack || error}`));
        sendText(
          response,
          200,
          wechatTextReply(incoming, `已收到，正在 ${routed.project.name} 中创建 Codex 任务。`),
          "application/xml; charset=utf-8",
        );
        return;
      }

      const token = bearerToken(request);
      if (pathname.startsWith("/api/admin/")) {
        if (!security.authorizeAdmin(token)) {
          sendJson(response, 401, { error: "管理员认证失败" });
          return;
        }
        if (pathname === "/api/admin/pairing" && request.method === "POST") {
          sendJson(response, 200, security.createPairing());
          return;
        }
        if (pathname === "/api/admin/shutdown" && request.method === "POST") {
          sendJson(response, 202, { ok: true });
          setTimeout(() => close().then(() => process.exit(0)), 50).unref();
          return;
        }
      }

      if (pathname.startsWith("/api/") && !security.authorize(token)) {
        sendJson(response, 401, { error: "请先输入电脑上显示的一次性配对码" });
        return;
      }

      if (pathname === "/api/session/revoke" && request.method === "POST") {
        await security.revoke(token);
        sendJson(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie(request) });
        return;
      }

      if (pathname === "/api/session" && request.method === "GET") {
        const session = security.session(token);
        sendJson(response, 200, { ok: true, expiresAt: session.expiresAt }, {
          "Set-Cookie": sessionCookie(token, session.expiresAt, request),
        });
        return;
      }

      if (pathname === "/api/projects" && request.method === "GET") {
        sendJson(response, 200, { projects: projectPublicView(config) });
        return;
      }
      if (pathname === "/api/tasks" && request.method === "GET") {
        sendJson(response, 200, { tasks: tasks.list({ archived: url.searchParams.get("archived") === "true" }) });
        return;
      }
      const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch && request.method === "GET") {
        const task = await tasks.getDetail(taskMatch[1]);
        if (!task) {
          sendJson(response, 404, { error: "任务不存在" });
          return;
        }
        sendJson(response, 200, { task });
        return;
      }
      if (pathname === "/api/tasks" && request.method === "POST") {
        const body = await readJson(request);
        const prompt = String(body.prompt || "").trim();
        const project = config.projects.find((item) => item.id === body.projectId);
        if (!project) throw new Error("请选择有效项目");
        if (!prompt) throw new Error("任务描述不能为空");
        if (prompt.length > config.security.maxPromptChars) throw new Error("任务描述超过长度限制");
        const task = await tasks.createTask({ project, prompt, source: "pwa" });
        sendJson(response, 201, { task });
        return;
      }
      const taskActionMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(follow-up|cancel|open|archive|unarchive)$/);
      if (taskActionMatch && request.method === "POST") {
        const [, taskId, action] = taskActionMatch;
        if (action === "archive") {
          const task = await tasks.archive(taskId);
          sendJson(response, 200, { task });
          return;
        }
        if (action === "unarchive") {
          const task = await tasks.unarchive(taskId);
          sendJson(response, 200, { task });
          return;
        }
        if (action === "open") {
          const task = await tasks.openOnDesktop(taskId);
          sendJson(response, 200, { task });
          return;
        }
        if (action === "cancel") {
          const task = await tasks.cancel(taskId);
          sendJson(response, 200, { task });
          return;
        }
        const body = await readJson(request);
        const prompt = String(body.prompt || "").trim();
        if (!prompt) throw new Error("后续指令不能为空");
        if (prompt.length > config.security.maxPromptChars) throw new Error("后续指令超过长度限制");
        const task = await tasks.followUp(taskId, prompt);
        sendJson(response, 201, { task });
        return;
      }
      const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
      if (approvalMatch && request.method === "POST") {
        const body = await readJson(request);
        const approval = await tasks.decideApproval(approvalMatch[1], String(body.decision || ""));
        sendJson(response, 200, { approval });
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        sendText(response, 404, "not found");
        return;
      }
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const filePath = path.resolve(publicDir, relative);
      if (!filePath.startsWith(`${publicDir}${path.sep}`) && filePath !== path.join(publicDir, "index.html")) {
        sendText(response, 403, "forbidden");
        return;
      }
      const content = await readFile(filePath).catch(() => null);
      if (!content) {
        sendText(response, 404, "not found");
        return;
      }
      securityHeaders(response);
      response.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": filePath.endsWith("service-worker.js") ? "no-cache" : "public, max-age=300",
      });
      if (request.method === "HEAD") response.end();
      else response.end(content);
    } catch (error) {
      const status = /认证|配对码/.test(error.message) ? 401 : 400;
      sendJson(response, status, { error: error.message || "请求失败" });
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.server.port, config.server.host, resolve);
  });
  await writeFile(
    serverStatePath,
    `${JSON.stringify({ pid: process.pid, host: config.server.host, port: config.server.port, startedAt: Date.now() }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const localUrl = `http://${config.server.host}:${config.server.port}`;
  console.log(`Mobile Codex Bridge 已启动：${config.server.publicBaseUrl || localUrl}`);
  const pairingDays = config.security.pairingTtlMinutes / 1_440;
  const pairingValidity = Number.isInteger(pairingDays)
    ? `${pairingDays} 天`
    : `${config.security.pairingTtlMinutes} 分钟`;
  console.log(`一次性配对码：${pairing.code}（${pairingValidity}内有效）`);
  console.log("按 Ctrl+C 停止服务。");

  const handleSignal = () => close().then(() => process.exit(0));
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  return { config, codex, tasks, security, server: httpServer, close, pairing };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startBridge().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
