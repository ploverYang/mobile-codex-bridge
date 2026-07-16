import assert from "node:assert/strict";
import test from "node:test";
import { shouldRefreshTaskList, TaskRefreshGate, taskMatchesFilter } from "../public/task-list-state.mjs";

const activeTask = { id: "active", status: "running", archivedAt: null, promptPreview: "正在执行" };
const completedTask = { id: "completed", status: "completed", archivedAt: null, promptPreview: "已完成" };
const archivedTask = { id: "archived", status: "completed", archivedAt: 123, promptPreview: "已归档" };

test("all and status filters never include archived tasks", () => {
  assert.equal(taskMatchesFilter(activeTask, { filter: "all" }), true);
  assert.equal(taskMatchesFilter(completedTask, { filter: "completed" }), true);
  assert.equal(taskMatchesFilter(archivedTask, { filter: "all" }), false);
  assert.equal(taskMatchesFilter(archivedTask, { filter: "completed" }), false);
  assert.equal(taskMatchesFilter(archivedTask, { filter: "archived" }), true);
});

test("newer task refreshes prevent stale results from replacing archive state", () => {
  const gate = new TaskRefreshGate();
  const beforeArchive = gate.begin();
  const afterArchive = gate.begin();

  assert.equal(gate.isCurrent(beforeArchive), false);
  assert.equal(gate.isCurrent(afterArchive), true);
});

test("a cookie-restored session refreshes tasks without a local bearer token", () => {
  assert.equal(shouldRefreshTaskList({
    appVisible: true,
    documentHidden: false,
    followupFocused: false,
  }), true);
  assert.equal(shouldRefreshTaskList({
    appVisible: false,
    documentHidden: false,
    followupFocused: false,
  }), false);
});
