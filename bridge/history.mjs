import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const ACTIVE_STATUSES = new Set(["creating", "resuming", "running", "waiting_approval", "cancelling"]);

function restoredTask(task) {
  const status = ACTIVE_STATUSES.has(task.status) ? "interrupted" : task.status;
  return {
    ...task,
    status,
    output: String(task.output || ""),
    error: status === "interrupted" ? "桥接服务曾重启，可从手机继续这个任务。" : task.error || null,
    archivedAt: Number.isFinite(Number(task.archivedAt)) ? Number(task.archivedAt) : null,
    approvals: [],
    messageCount: Math.max(1, Number(task.messageCount) || 1),
  };
}

export class TaskHistoryStore {
  constructor(filePath, { maxTasks = 100, persistOutputs = false } = {}) {
    this.filePath = filePath;
    this.maxTasks = maxTasks;
    this.persistOutputs = persistOutputs;
  }

  async load() {
    const document = await readFile(this.filePath, "utf8").then(JSON.parse).catch(() => null);
    if (!document || document.version !== 1 || !Array.isArray(document.tasks)) return [];
    return document.tasks
      .filter((task) => task && typeof task.id === "string" && typeof task.projectId === "string")
      .slice(0, this.maxTasks)
      .map(restoredTask);
  }

  async save(tasks) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const normalized = tasks
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, this.maxTasks)
      .map((task) => ({
        id: task.id,
        threadId: task.threadId,
        turnId: task.turnId,
        projectId: task.projectId,
        projectName: task.projectName,
        promptPreview: task.promptPreview,
        firstPromptPreview: task.firstPromptPreview || task.promptPreview,
        messageCount: Math.max(1, Number(task.messageCount) || 1),
        source: task.source,
        status: task.status,
        output: this.persistOutputs ? task.output : "",
        error: task.error,
        archivedAt: Number.isFinite(Number(task.archivedAt)) ? Number(task.archivedAt) : null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      }));
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, tasks: normalized }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
