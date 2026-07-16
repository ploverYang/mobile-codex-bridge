import assert from "node:assert/strict";
import test from "node:test";
import { codexThreadUrl, DesktopIntegration, desktopOpenCommand } from "../bridge/desktop.mjs";

const THREAD_ID = "12345678-1234-1234-1234-123456789abc";

test("desktop integration builds a validated Codex thread deep link", () => {
  assert.equal(codexThreadUrl(THREAD_ID), `codex://threads/${THREAD_ID}`);
  assert.throws(() => codexThreadUrl("not-a-thread"), /格式不正确/);
  assert.deepEqual(desktopOpenCommand(codexThreadUrl(THREAD_ID), "win32"), {
    command: "explorer.exe",
    args: [`codex://threads/${THREAD_ID}`],
  });
});

test("desktop integration auto-opens a completed turn only once", async () => {
  const urls = [];
  const desktop = new DesktopIntegration(
    { autoOpen: "on-complete" },
    { platform: "win32", launcher: async (url) => urls.push(url) },
  );
  const task = { threadId: THREAD_ID, turnId: "turn-1" };
  assert.equal(await desktop.maybeOpen(task, "start"), false);
  assert.equal(await desktop.maybeOpen(task, "complete"), true);
  assert.equal(await desktop.maybeOpen(task, "complete"), false);
  assert.deepEqual(urls, [`codex://threads/${THREAD_ID}`]);
});

test("desktop integration reloads an already opened thread for a later turn", async () => {
  const urls = [];
  const desktop = new DesktopIntegration(
    { autoOpen: "on-complete" },
    { platform: "win32", launcher: async (url) => urls.push(url), pause: async () => {} },
  );
  const task = { threadId: THREAD_ID, turnId: "turn-1", messageCount: 1 };
  assert.equal(await desktop.maybeOpen(task, "complete"), true);
  task.turnId = "turn-2";
  assert.equal(await desktop.maybeOpen(task, "complete"), true);
  assert.deepEqual(urls, [
    `codex://threads/${THREAD_ID}`,
    "codex://threads/new",
    `codex://threads/${THREAD_ID}`,
  ]);
});

test("desktop integration reloads a persisted multi-turn thread after a bridge restart", async () => {
  const urls = [];
  const desktop = new DesktopIntegration(
    { autoOpen: "on-complete" },
    { platform: "win32", launcher: async (url) => urls.push(url), pause: async () => {} },
  );
  const task = { threadId: THREAD_ID, turnId: "turn-2", messageCount: 2 };
  assert.equal(await desktop.maybeOpen(task, "complete"), true);
  assert.deepEqual(urls, [
    "codex://threads/new",
    `codex://threads/${THREAD_ID}`,
  ]);
});
