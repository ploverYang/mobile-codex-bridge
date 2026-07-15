import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskHistoryStore } from "../bridge/history.mjs";

test("task history is restored locally without persisted output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mobile-codex-history-"));
  try {
    const store = new TaskHistoryStore(path.join(directory, "tasks.json"), { maxTasks: 10, persistOutputs: false });
    await store.save([{
      id: "task-1",
      threadId: "thread-1",
      turnId: "turn-1",
      projectId: "demo",
      projectName: "Demo",
      promptPreview: "Latest prompt",
      firstPromptPreview: "First prompt",
      messageCount: 2,
      source: "pwa",
      status: "running",
      output: "sensitive output",
      error: null,
      archivedAt: 300,
      archiveSync: "local",
      createdAt: 100,
      updatedAt: 200,
      approvals: [],
    }]);
    const [restored] = await store.load();
    assert.equal(restored.status, "interrupted");
    assert.equal(restored.output, "");
    assert.equal(restored.messageCount, 2);
    assert.equal(restored.archivedAt, 300);
    assert.equal(restored.archiveSync, "local");
    assert.match(restored.error, /重启/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
