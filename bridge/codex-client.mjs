import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { BRIDGE_VERSION } from "./version.mjs";

const DESKTOP_RUNTIME_FILES = [
  "codex.exe",
  "codex-windows-sandbox-setup.exe",
  "codex-command-runner.exe",
  "codex-code-mode-host.exe",
  "rg.exe",
];

function where(command) {
  try {
    return execFileSync("where.exe", [command], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function stageDesktopExecutable(executable) {
  if (!/\\WindowsApps\\/i.test(executable)) return executable;
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(homedir(), ".codex"));
  const runtimeDir = path.join(codexHome, "mobile-codex-bridge-runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const result = spawnSync(
    "robocopy.exe",
    [path.dirname(executable), runtimeDir, ...DESKTOP_RUNTIME_FILES, "/COPY:DAT", "/DCOPY:DAT", "/R:1", "/W:1", "/NJH", "/NJS", "/NP"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error || result.status == null || result.status > 7) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit=${result.status}`;
    throw new Error(`无法同步桌面版 Codex 运行时：${detail}`);
  }
  const staged = path.join(runtimeDir, path.basename(executable));
  const missing = DESKTOP_RUNTIME_FILES.filter((name) => !existsSync(path.join(runtimeDir, name)));
  if (missing.length > 0) throw new Error(`桌面版 Codex 运行时同步不完整：${missing.join("、")}`);
  return staged;
}

export function resolveCodexLaunch(
  binary,
  { locate = where, fileExists = existsSync, nodeExecutable = process.execPath, stageExecutable = stageDesktopExecutable } = {},
) {
  if (process.platform !== "win32") return { command: binary, argsPrefix: [] };
  const extension = path.extname(binary).toLowerCase();
  if (extension === ".exe" || extension === ".com") return { command: binary, argsPrefix: [] };

  // The desktop app adds its versioned resources directory to PATH. Prefer its
  // native executable over npm's codex.cmd wrapper so Bridge follows app updates.
  if (!extension) {
    const desktopExecutable = locate(`${binary}.exe`).find((value) =>
      [".exe", ".com"].includes(path.extname(value).toLowerCase()),
    );
    if (desktopExecutable) return { command: stageExecutable(desktopExecutable), argsPrefix: [] };
  }

  const wrappers = extension ? [binary] : locate(`${binary}.cmd`);
  for (const wrapper of wrappers) {
    if (!/\.(cmd|ps1)$/i.test(wrapper)) continue;
    const cliScript = path.join(path.dirname(wrapper), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fileExists(cliScript)) return { command: nodeExecutable, argsPrefix: [cliScript] };
  }

  const query = extension ? binary : `${binary}.exe`;
  const executable = locate(query).find((value) => [".exe", ".com"].includes(path.extname(value).toLowerCase()));
  return { command: executable ? stageExecutable(executable) : binary, argsPrefix: [] };
}

export class CodexAppServerClient extends EventEmitter {
  constructor({ binary = "codex", requestTimeoutMs = 30_000 } = {}) {
    super();
    this.binary = binary;
    this.requestTimeoutMs = requestTimeoutMs;
    this.process = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.launch = null;
  }

  async start() {
    if (this.process) return;
    const launch = resolveCodexLaunch(this.binary);
    this.launch = launch;
    const child = spawn(launch.command, [...launch.argsPrefix, "app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    this.process = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this.emit("log", String(chunk).trim()));
    child.once("error", (error) => this.#terminate(error));
    child.once("exit", (code, signal) => {
      this.#terminate(new Error(`Codex App Server 已退出（code=${code}, signal=${signal || "none"}）`));
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "mobile_codex_bridge",
        title: "Mobile Codex Bridge",
        version: BRIDGE_VERSION,
      },
    });
    this.notify("initialized", {});
    this.ready = true;
    this.emit("ready");
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.process?.stdin?.writable) return Promise.reject(new Error("Codex App Server 未运行"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server 请求超时：${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      this.#send({ method, id, params });
    });
  }

  notify(method, params = {}) {
    this.#send({ method, params });
  }

  respond(id, result) {
    this.#send({ id, result });
  }

  respondError(id, code, message) {
    this.#send({ id, error: { code, message } });
  }

  async stop() {
    const child = this.process;
    this.process = null;
    this.ready = false;
    if (!child) return;
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 2_000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #send(message) {
    if (!this.process?.stdin?.writable) throw new Error("Codex App Server 连接不可写");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("log", `无法解析 App Server 输出：${line.slice(0, 300)}`);
      return;
    }

    if (message.id != null && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message || "未知错误"}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id != null && message.method) {
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) this.emit("notification", message);
  }

  #terminate(error) {
    this.ready = false;
    this.process = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }
}
