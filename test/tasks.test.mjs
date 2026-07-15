import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { TaskManager } from "../bridge/tasks.mjs";

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.responses = [];
    this.threadReadError = null;
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "thread/resume") return { thread: { id: "thread-1" } };
    if (method === "thread/read") {
      if (this.threadReadError) throw this.threadReadError;
      return {
      thread: {
        id: "thread-1",
        preview: "Inspect the repository",
        turns: [
          {
            id: "turn-1",
            status: "completed",
            startedAt: 1,
            completedAt: 2,
            durationMs: 1000,
            items: [
              { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Inspect the repository" }] },
              { id: "reasoning-1", type: "reasoning", summary: ["先检查项目结构"], content: [] },
              { id: "agent-1", type: "agentMessage", text: "Working", phase: "final_answer" },
            ],
          },
        ],
      },
      };
    }
    if (method === "turn/start") return { turn: { id: `turn-${this.calls.filter((call) => call.method === "turn/start").length}` } };
    if (method === "turn/interrupt") return {};
    if (method === "thread/archive" && this.archiveError) throw this.archiveError;
    if (method === "thread/archive" || method === "thread/unarchive") return {};
    throw new Error(`unexpected method: ${method}`);
  }

  respond(id, result) {
    this.responses.push({ id, result });
  }

  respondError(id, code, message) {
    this.responses.push({ id, error: { code, message } });
  }
}

test("task manager starts a Codex thread and turn, streams output, and routes approval", async () => {
  const client = new FakeClient();
  const manager = new TaskManager(client, {
    codex: { model: null },
    projects: [{ id: "demo", name: "Demo", path: "C:/demo" }],
    storage: { maxTasks: 100 },
  });
  const task = await manager.createTask({
    project: { id: "demo", name: "Demo", path: "C:/demo" },
    prompt: "Inspect the repository",
    source: "pwa",
  });

  assert.deepEqual(client.calls, [
    { method: "thread/start", params: { cwd: "C:/demo", approvalPolicy: "never", sandbox: "danger-full-access" } },
    { method: "turn/start", params: { threadId: "thread-1", input: [{ type: "text", text: "Inspect the repository" }], summary: "concise", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } },
  ]);
  assert.equal(task.status, "creating");

  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  });
  assert.equal(manager.get(task.id).status, "running");

  client.emit("notification", {
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", delta: "Working" },
  });
  client.emit("serverRequest", {
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", command: "npm test", reason: "run tests" },
  });
  let current = manager.get(task.id);
  assert.equal(current.status, "waiting_approval");
  assert.equal(current.output, "Working");
  assert.equal(current.approvals[0].command, "npm test");

  await manager.decideApproval(current.approvals[0].id, "accept");
  assert.deepEqual(client.responses, [{ id: 42, result: { decision: "accept" } }]);

  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { status: "completed" } },
  });
  current = manager.get(task.id);
  assert.equal(current.status, "completed");

  const continued = await manager.followUp(task.id, "Now run the tests");
  assert.equal(continued.messageCount, 2);
  assert.equal(continued.promptPreview, "Now run the tests");
  assert.deepEqual(client.calls.slice(-2), [
    { method: "thread/resume", params: { threadId: "thread-1", cwd: "C:/demo", approvalPolicy: "never", sandbox: "danger-full-access" } },
    { method: "turn/start", params: { threadId: "thread-1", input: [{ type: "text", text: "Now run the tests" }], summary: "concise", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } },
  ]);

  const detail = await manager.getDetail(task.id);
  assert.equal(detail.turns.length, 2);
  assert.equal(detail.turns[0].items[0].type, "user");
  assert.equal(detail.turns[0].items[1].type, "reasoning");
  assert.equal(detail.turns[0].items[2].text, "Working");

  const cancelled = await manager.cancel(task.id);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(client.calls.at(-1), {
    method: "turn/interrupt",
    params: { threadId: "thread-1", turnId: "turn-2" },
  });
});

test("accepted turn remains creating until App Server confirms start or reports an error", async () => {
  const client = new FakeClient();
  const manager = new TaskManager(client, {
    codex: { model: null },
    projects: [{ id: "demo", name: "Demo", path: "C:/demo" }],
    storage: { maxTasks: 100 },
  });
  const task = await manager.createTask({
    project: { id: "demo", name: "Demo", path: "C:/demo" },
    prompt: "Start a task",
  });
  assert.equal(task.status, "creating");

  client.emit("notification", {
    method: "error",
    params: { threadId: "thread-1", error: { message: "model is not supported" } },
  });
  const failed = manager.get(task.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "model is not supported");
});

test("completed tasks archive and restore their Codex thread with the phone history", async () => {
  const client = new FakeClient();
  const manager = new TaskManager(client, {
    codex: { model: null },
    projects: [{ id: "demo", name: "Demo", path: "C:/demo" }],
    storage: { maxTasks: 100 },
  });
  const task = await manager.createTask({
    project: { id: "demo", name: "Demo", path: "C:/demo" },
    prompt: "Archive this conversation",
  });

  await assert.rejects(manager.archive(task.id), /进行中的任务/);
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { status: "completed" } },
  });
  const archived = await manager.archive(task.id);
  assert.deepEqual(client.calls.at(-1), { method: "thread/archive", params: { threadId: "thread-1" } });
  assert.ok(archived.archivedAt);
  assert.equal(archived.canFollowUp, false);
  assert.equal(manager.list().length, 0);
  assert.equal(manager.list({ archived: true })[0].threadId, "thread-1");

  const restored = await manager.unarchive(task.id);
  assert.deepEqual(client.calls.at(-1), { method: "thread/unarchive", params: { threadId: "thread-1" } });
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.canFollowUp, true);
  assert.equal(manager.list()[0].id, task.id);
});

test("task detail hides the transient empty-rollout error while a turn is starting", async () => {
  const client = new FakeClient();
  const manager = new TaskManager(client, {
    codex: { model: null },
    projects: [{ id: "demo", name: "Demo", path: "C:/demo" }],
    storage: { maxTasks: 100 },
  });
  const task = await manager.createTask({
    project: { id: "demo", name: "Demo", path: "C:/demo" },
    prompt: "Start a task",
  });
  client.threadReadError = new Error("rollout at C:/sessions/new.jsonl is empty");

  const detail = await manager.getDetail(task.id);
  assert.equal(detail.detailError, null);
  assert.equal(detail.turns[0].status, "running");
  assert.equal(detail.turns[0].items[0].text, "Start a task");
});

test("task manager supports manual desktop open and completion auto-open", async () => {
  const client = new FakeClient();
  const calls = [];
  const desktop = {
    async openThread(threadId, options) {
      calls.push({ type: "manual", threadId, options });
    },
    async maybeOpen(task, phase) {
      calls.push({ type: "auto", threadId: task.threadId, phase });
      return phase === "complete";
    },
  };
  const manager = new TaskManager(client, {
    codex: { model: null },
    projects: [{ id: "demo", name: "Demo", path: "C:/demo" }],
    storage: { maxTasks: 100 },
  }, null, desktop);
  const task = await manager.createTask({
    project: { id: "demo", name: "Demo", path: "C:/demo" },
    prompt: "Open this task",
  });
  await manager.openOnDesktop(task.id);
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { status: "completed" } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    { type: "manual", threadId: "thread-1", options: { refresh: false } },
    { type: "auto", threadId: "thread-1", phase: "complete" },
  ]);
});

test("task manager archives and restores an inactive Codex thread", async () => {
  const client = new FakeClient();
  const manager = new TaskManager(client, {
    codex: { model: null },
    projects: [{ id: "demo", name: "Demo", path: "C:/demo" }],
    storage: { maxTasks: 100 },
  });
  const task = await manager.createTask({
    project: { id: "demo", name: "Demo", path: "C:/demo" },
    prompt: "Archive this task",
  });
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { status: "completed" } },
  });

  assert.equal(manager.get(task.id).canArchive, true);
  await manager.archive(task.id);
  assert.deepEqual(client.calls.at(-1), { method: "thread/archive", params: { threadId: "thread-1" } });
  assert.equal(manager.get(task.id).archivedAt > 0, true);
  assert.deepEqual(manager.list(), []);
  assert.equal(manager.list({ archived: true }).length, 1);

  await manager.unarchive(task.id);
  assert.deepEqual(client.calls.at(-1), { method: "thread/unarchive", params: { threadId: "thread-1" } });
  assert.equal(manager.get(task.id).archivedAt, null);
});

test("task manager archives locally when an older thread has no App Server rollout", async () => {
  const client = new FakeClient();
  client.archiveError = new Error("thread/archive: no rollout found for thread id old-thread");
  const manager = new TaskManager(client, {
    codex: { model: null },
    projects: [{ id: "demo", name: "Demo", path: "C:/demo" }],
    storage: { maxTasks: 100 },
  });
  const task = await manager.createTask({
    project: { id: "demo", name: "Demo", path: "C:/demo" },
    prompt: "Archive an older task",
  });
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { status: "completed" } },
  });

  const archived = await manager.archive(task.id);
  assert.equal(archived.archiveSync, "local");
  assert.equal(manager.list().length, 0);
  assert.equal(manager.list({ archived: true }).length, 1);

  const callsBeforeRestore = client.calls.length;
  const restored = await manager.unarchive(task.id);
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.archiveSync, null);
  assert.equal(client.calls.length, callsBeforeRestore);
});

test("task manager preserves non-rollout archive errors", async () => {
  const client = new FakeClient();
  client.archiveError = new Error("thread/archive: service unavailable");
  const manager = new TaskManager(client, {
    codex: { model: null },
    projects: [{ id: "demo", name: "Demo", path: "C:/demo" }],
    storage: { maxTasks: 100 },
  });
  const task = await manager.createTask({
    project: { id: "demo", name: "Demo", path: "C:/demo" },
    prompt: "Archive failure",
  });
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { status: "completed" } },
  });

  await assert.rejects(manager.archive(task.id), /service unavailable/);
  assert.equal(manager.get(task.id).archivedAt, null);
});

test("task manager refuses to archive an active Codex thread", async () => {
  const client = new FakeClient();
  const manager = new TaskManager(client, {
    codex: { model: null },
    projects: [{ id: "demo", name: "Demo", path: "C:/demo" }],
    storage: { maxTasks: 100 },
  });
  const task = await manager.createTask({
    project: { id: "demo", name: "Demo", path: "C:/demo" },
    prompt: "Keep running",
  });

  await assert.rejects(manager.archive(task.id), /进行中的任务不能归档/);
  assert.equal(client.calls.some((call) => call.method === "thread/archive"), false);
});
