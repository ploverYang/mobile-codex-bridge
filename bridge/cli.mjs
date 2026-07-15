import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "./codex-client.mjs";
import { loadConfig, pluginRoot } from "./config.mjs";
import { formatDoctorReport, runDoctor } from "./doctor.mjs";
import { startBridge } from "./server.mjs";

const dataDir = path.join(pluginRoot, "data");
const statePath = path.join(dataDir, "state.json");
const cliPath = fileURLToPath(import.meta.url);

async function localBaseUrl() {
  const config = await loadConfig();
  return { config, baseUrl: `http://127.0.0.1:${config.server.port}` };
}

async function call(pathname, options = {}) {
  const { baseUrl } = await localBaseUrl();
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function adminToken() {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (!state.adminToken) throw new Error("本地管理员令牌不存在，请先启动服务");
  return state.adminToken;
}

async function status({ quiet = false } = {}) {
  try {
    const health = await call("/api/health");
    if (!quiet) console.log(`服务在线，Codex ${health.codexReady ? "已连接" : "未连接"}，版本 ${health.version}`);
    return true;
  } catch (error) {
    if (!quiet) console.log(`服务未运行：${error.message}`);
    return false;
  }
}

async function startDetached() {
  if (await status({ quiet: true })) {
    console.log("服务已经在运行。");
    return;
  }
  await mkdir(dataDir, { recursive: true });
  const logHandle = await open(path.join(dataDir, "bridge.log"), "a");
  const child = spawn(process.execPath, [cliPath, "serve"], {
    cwd: pluginRoot,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
    env: process.env,
  });
  child.unref();
  await logHandle.close();

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await status({ quiet: true })) {
      console.log(`服务已在后台启动，PID ${child.pid}。运行 npm run pair 生成配对码。`);
      return;
    }
  }
  throw new Error(`服务启动超时，请检查 ${path.join(dataDir, "bridge.log")}`);
}

async function pair() {
  const token = await adminToken();
  const result = await call("/api/admin/pairing", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const { config } = await localBaseUrl();
  const url = config.server.publicBaseUrl || `http://${config.server.host}:${config.server.port}`;
  console.log(`手机地址：${url}`);
  console.log(`一次性配对码：${result.code}`);
  console.log(`有效期至：${new Date(result.expiresAt).toLocaleString("zh-CN")}`);
}

async function stop() {
  if (!(await status({ quiet: true }))) {
    console.log("服务没有运行。");
    return;
  }
  const token = await adminToken();
  await call("/api/admin/shutdown", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log("停止请求已发送。");
}

async function selfTest() {
  const config = await loadConfig();
  const client = new CodexAppServerClient({ binary: config.codex.binary });
  await client.start();
  try {
    const result = await client.request("thread/start", {
      cwd: config.projects[0].path,
      ephemeral: true,
    });
    if (!result?.thread?.id) throw new Error("没有收到 thread.id");
    console.log(`协议自检通过，临时线程 ${result.thread.id}`);
  } finally {
    await client.stop();
  }
}

async function doctor() {
  const report = await runDoctor();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDoctorReport(report));
  }
  if (!report.ok) process.exitCode = 1;
}

const command = process.argv[2] || "serve";
const actions = {
  serve: () => startBridge(),
  start: startDetached,
  stop,
  status,
  pair,
  doctor,
  "self-test": selfTest,
};

if (!actions[command]) {
  console.error("用法：node bridge/cli.mjs <serve|start|stop|status|pair|doctor|self-test> [--json]");
  process.exitCode = 2;
} else {
  actions[command]().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
