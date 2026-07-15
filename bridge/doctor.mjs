import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfigPath, loadConfig } from "./config.mjs";
import { resolveCodexLaunch } from "./codex-client.mjs";
import { BRIDGE_VERSION } from "./version.mjs";

const execFileAsync = promisify(execFile);

async function defaultCodexVersion(launch) {
  const { stdout, stderr } = await execFileAsync(launch.command, [...launch.argsPrefix, "--version"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  return String(stdout || stderr || "").trim();
}

async function defaultBridgeHealth(config) {
  const response = await fetch(`http://127.0.0.1:${config.server.port}/api/health`, {
    signal: AbortSignal.timeout(2_500),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function defaultFindTailscale() {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const { stdout } = await execFileAsync(command, ["tailscale"], {
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
  });
  return String(stdout).split(/\r?\n/).find(Boolean)?.trim() || null;
}

function add(checks, id, status, message, fix = null, details = null) {
  checks.push({ id, status, message, ...(fix ? { fix } : {}), ...(details ? { details } : {}) });
}

export async function runDoctor({
  nodeVersion = process.versions.node,
  platform = process.platform,
  configPath = getConfigPath(),
  load = loadConfig,
  resolveLaunch = resolveCodexLaunch,
  codexVersion = defaultCodexVersion,
  bridgeHealth = defaultBridgeHealth,
  findTailscale = defaultFindTailscale,
} = {}) {
  const checks = [];
  const nodeMajor = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  if (Number.isInteger(nodeMajor) && nodeMajor >= 20) {
    add(checks, "node", "pass", `Node.js ${nodeVersion}，满足 20+ 要求`);
  } else {
    add(checks, "node", "fail", `Node.js ${nodeVersion || "未知"}，需要 20 或更高版本`, "安装 Node.js 20+ 后重新运行 doctor");
  }

  if (platform === "win32") {
    add(checks, "platform", "pass", "Windows 平台受支持");
  } else {
    add(checks, "platform", "warn", `当前平台为 ${platform}；自动安装向导仅支持 Windows`);
  }

  let config = null;
  try {
    config = await load(configPath);
    add(checks, "config", "pass", `配置有效，已允许 ${config.projects.length} 个项目`, null, {
      configPath: config.configPath,
      projectIds: config.projects.map((project) => project.id),
      pairingTtlMinutes: config.security.pairingTtlMinutes,
    });
  } catch (error) {
    add(checks, "config", "fail", error.message, "运行 scripts/setup-windows.ps1 创建配置");
  }

  try {
    const launch = resolveLaunch(config?.codex.binary || "codex");
    const version = await codexVersion(launch);
    add(checks, "codex", "pass", `Codex 运行时可用${version ? `：${version}` : ""}`, null, {
      command: launch.command,
    });
  } catch (error) {
    add(checks, "codex", "fail", `Codex 运行时不可用：${error.message}`, "确认 Codex Desktop 已安装并登录，然后重新打开终端");
  }

  if (config) {
    try {
      const health = await bridgeHealth(config);
      if (!health.codexReady) {
        add(checks, "bridge", "fail", "Bridge 在线，但 Codex App Server 未连接", "查看 data/bridge.log 后运行 scripts/bridge.ps1 self-test");
      } else if (health.version !== BRIDGE_VERSION) {
        add(checks, "bridge", "warn", `Bridge 在线但版本为 ${health.version}，当前代码为 ${BRIDGE_VERSION}`, "运行 scripts/bridge.ps1 stop，然后重新启动");
      } else {
        add(checks, "bridge", "pass", `Bridge 在线，Codex 已连接，版本 ${health.version}`);
      }
    } catch (error) {
      add(checks, "bridge", "warn", `Bridge 尚未运行：${error.message}`, "运行 scripts/bridge.ps1 start");
    }
  }

  try {
    const tailscalePath = await findTailscale();
    if (tailscalePath) {
      add(checks, "tailscale", "pass", "已检测到 Tailscale，可用于手机私有 HTTPS 访问", null, { path: tailscalePath });
    } else {
      add(checks, "tailscale", "warn", "未检测到 Tailscale；仅同一台电脑可直接访问 Bridge");
    }
  } catch {
    add(checks, "tailscale", "warn", "未检测到 Tailscale；需要手机访问时可稍后安装");
  }

  const summary = {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length,
  };
  return {
    ok: summary.fail === 0,
    version: BRIDGE_VERSION,
    checks,
    summary,
  };
}

export function formatDoctorReport(report) {
  const icons = { pass: "[通过]", warn: "[提示]", fail: "[失败]" };
  const lines = [`Mobile Codex Bridge ${report.version} 环境诊断`, ""];
  for (const check of report.checks) {
    lines.push(`${icons[check.status]} ${check.message}`);
    if (check.fix) lines.push(`       建议：${check.fix}`);
  }
  lines.push("", `结果：${report.summary.pass} 通过，${report.summary.warn} 提示，${report.summary.fail} 失败`);
  return lines.join("\n");
}
