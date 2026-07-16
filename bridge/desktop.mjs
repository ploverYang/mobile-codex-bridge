import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function codexThreadUrl(threadId) {
  if (!THREAD_ID.test(threadId || "")) throw new Error("Codex 线程 ID 格式不正确");
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

export function desktopOpenCommand(url, platform = process.platform) {
  if (platform === "win32") return { command: "explorer.exe", args: [url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

function launchUrl(url, platform = process.platform) {
  const launch = desktopOpenCommand(url, platform);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export class DesktopIntegration {
  constructor({ autoOpen = "never" } = {}, { launcher = launchUrl, platform = process.platform, pause = delay } = {}) {
    this.autoOpen = autoOpen;
    this.launcher = launcher;
    this.platform = platform;
    this.pause = pause;
    this.openedTurns = new Set();
    this.lastOpenedTurn = new Map();
  }

  async openThread(threadId, { refresh = false } = {}) {
    const url = codexThreadUrl(threadId);
    if (refresh) {
      await this.launcher("codex://threads/new", this.platform);
      await this.pause(600);
    }
    await this.launcher(url, this.platform);
    return { url };
  }

  async maybeOpen(task, phase) {
    const expected = this.autoOpen === "on-start" ? "start" : this.autoOpen === "on-complete" ? "complete" : null;
    if (!expected || phase !== expected || !task.threadId) return false;
    const key = `${task.threadId}:${task.turnId || "turn"}:${phase}`;
    if (this.openedTurns.has(key)) return false;
    this.openedTurns.add(key);
    try {
      const previousTurn = this.lastOpenedTurn.get(task.threadId);
      const laterTurn = Number(task.messageCount) > 1 || Boolean(previousTurn && previousTurn !== task.turnId);
      await this.openThread(task.threadId, { refresh: laterTurn });
      this.lastOpenedTurn.set(task.threadId, task.turnId || "turn");
      return true;
    } catch (error) {
      this.openedTurns.delete(key);
      throw error;
    }
  }
}
