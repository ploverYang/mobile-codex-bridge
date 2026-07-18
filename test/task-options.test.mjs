import assert from "node:assert/strict";
import test from "node:test";
import { accessParams, executionCatalog, validateExecutionSelection } from "../bridge/task-options.mjs";

const catalog = executionCatalog({
  data: [{
    model: "gpt-test",
    displayName: "GPT Test",
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Deep" },
    ],
    defaultReasoningEffort: "medium",
  }],
}, {
  data: [
    { id: ":read-only", allowed: true },
    { id: ":workspace", allowed: true },
    { id: ":danger-full-access", allowed: true },
    { id: ":blocked", allowed: false },
  ],
});

test("execution options mirror Codex model and permission profile catalogs", () => {
  assert.deepEqual(catalog.accessLevels.map((item) => item.id), [":read-only", ":workspace", ":danger-full-access"]);
  assert.equal(catalog.defaults.accessLevel, ":danger-full-access");
  assert.equal(catalog.defaults.model, "gpt-test");
  assert.equal(catalog.defaults.effort, "medium");
});

test("execution selection validates model effort and uses the native permission profile", () => {
  const selection = validateExecutionSelection({ accessLevel: ":workspace", model: "gpt-test", effort: "high" }, catalog);
  assert.deepEqual(selection, { accessLevel: ":workspace", model: "gpt-test", effort: "high" });
  assert.deepEqual(accessParams(selection.accessLevel), {
    thread: { permissions: ":workspace" },
    turn: { permissions: ":workspace" },
  });
});

test("omitted values use Codex defaults", () => {
  assert.deepEqual(validateExecutionSelection({}, catalog), {
    accessLevel: ":danger-full-access",
    model: "gpt-test",
    effort: "medium",
  });
});

test("unsupported values are rejected before reaching App Server", () => {
  assert.throws(() => validateExecutionSelection({ accessLevel: "fake", model: "gpt-test", effort: "medium" }, catalog), /访问等级/);
  assert.throws(() => validateExecutionSelection({ accessLevel: ":workspace", model: "fake", effort: "medium" }, catalog), /可用的模型/);
  assert.throws(() => validateExecutionSelection({ accessLevel: ":workspace", model: "gpt-test", effort: "ultra" }, catalog), /不支持/);
});
