import { randomUUID } from "node:crypto";

const ACTIVE_STATUSES = new Set(["creating", "resuming", "running", "waiting_approval", "cancelling"]);
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);
const MOBILE_THREAD_PERMISSIONS = {
  approvalPolicy: "never",
  sandbox: "danger-full-access",
};
const MOBILE_TURN_PERMISSIONS = {
  approvalPolicy: "never",
  sandboxPolicy: { type: "dangerFullAccess" },
};

function isMissingRollout(error) {
  return /no rollout found for thread id/i.test(String(error?.message || error));
}

function publicTask(task) {
  return {
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
    output: task.output,
    error: task.error,
    archivedAt: task.archivedAt || null,
    archiveSync: task.archivedAt ? (task.archiveSync || "synced") : null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    canFollowUp: Boolean(task.threadId) && !task.archivedAt && !ACTIVE_STATUSES.has(task.status),
    canCancel: Boolean(task.threadId && task.turnId) && ACTIVE_STATUSES.has(task.status) && task.status !== "cancelling",
    canOpenOnDesktop: Boolean(task.threadId),
    canArchive: Boolean(task.threadId) && !task.archivedAt && !ACTIVE_STATUSES.has(task.status),
    canUnarchive: Boolean(task.threadId && task.archivedAt),
    approvals: task.approvals.map(publicApproval),
  };
}

function publicApproval(approval) {
  const params = approval.params;
  return {
    id: approval.id,
    method: approval.method,
    status: approval.status,
    command: params.command || null,
    reason: params.reason || null,
    cwd: params.cwd || null,
    permissions: params.permissions || null,
    createdAt: approval.createdAt,
  };
}

function notificationThreadId(params = {}) {
  return params.threadId || params.thread?.id || params.turn?.threadId || null;
}

function statusName(status) {
  const value = typeof status === "string" ? status : status?.type || status?.status || "completed";
  if (value === "inProgress") return "running";
  if (value === "notStarted") return "creating";
  return value;
}

function preview(prompt) {
  return prompt.replace(/\s+/g, " ").slice(0, 180);
}

function safeText(value, limit = 100_000) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  return `…已省略前 ${text.length - limit} 个字符\n${text.slice(-limit)}`;
}

function userMessageText(content = []) {
  return content.map((part) => {
    if (part?.type === "text") return part.text || "";
    if (part?.type === "image" || part?.type === "localImage") return "[图片]";
    if (part?.type === "skill") return `[技能：${part.name || "unknown"}]`;
    if (part?.type === "mention") return `@${part.name || "mention"}`;
    return "";
  }).filter(Boolean).join("\n");
}

function publicThreadItem(item = {}) {
  const base = { id: item.id || randomUUID(), type: item.type || "activity" };
  if (item.type === "userMessage") return { ...base, type: "user", text: safeText(userMessageText(item.content)) };
  if (item.type === "agentMessage") return { ...base, type: "assistant", text: safeText(item.text), phase: item.phase || null };
  if (item.type === "reasoning") {
    return { ...base, type: "reasoning", title: "思考摘要", text: safeText((item.summary || []).filter(Boolean).join("\n")) };
  }
  if (item.type === "plan") return { ...base, type: "plan", title: "执行计划", text: safeText(item.text) };
  if (item.type === "commandExecution") {
    return {
      ...base,
      type: "activity",
      activityType: "command",
      title: "执行命令",
      text: safeText(item.command, 10_000),
      detail: safeText(item.aggregatedOutput, 20_000),
      status: item.status || null,
      exitCode: item.exitCode ?? null,
      durationMs: item.durationMs ?? null,
    };
  }
  if (item.type === "fileChange") {
    const paths = (item.changes || []).map((change) => `${change.kind || "update"} · ${change.path}`).join("\n");
    return { ...base, type: "activity", activityType: "file", title: "修改文件", text: safeText(paths, 20_000), status: item.status || null };
  }
  if (item.type === "webSearch") {
    return { ...base, type: "activity", activityType: "search", title: "网页搜索", text: safeText(item.query || "正在检索资料", 10_000), status: "completed" };
  }
  if (item.type === "mcpToolCall") {
    return { ...base, type: "activity", activityType: "tool", title: `调用工具 · ${item.server || "MCP"}/${item.tool || "tool"}`, text: safeText(item.error?.message || ""), status: item.status || null, durationMs: item.durationMs ?? null };
  }
  if (item.type === "dynamicToolCall") {
    return { ...base, type: "activity", activityType: "tool", title: `调用工具 · ${item.tool || "tool"}`, text: item.success === false ? "工具执行失败" : "", status: item.status || null, durationMs: item.durationMs ?? null };
  }
  if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") {
    return { ...base, type: "activity", activityType: "agent", title: "协作代理", text: safeText(item.prompt || item.kind || item.tool || "协作处理中"), status: item.status || null };
  }
  if (item.type === "contextCompaction") return { ...base, type: "activity", activityType: "context", title: "整理上下文", text: "Codex 已压缩较早内容以继续执行。", status: "completed" };
  return { ...base, type: "activity", activityType: "other", title: "执行步骤", text: item.type || "Codex 正在处理", status: item.status || null };
}

function dedupeConversationItems(items) {
  const result = [];
  const assistantText = new Map();
  for (const item of items) {
    if (item.type !== "assistant" || !item.text?.trim()) {
      result.push(item);
      continue;
    }
    const key = item.text.trim();
    const previousIndex = assistantText.get(key);
    if (previousIndex === undefined) {
      assistantText.set(key, result.length);
      result.push(item);
      continue;
    }
    const previous = result[previousIndex];
    if (item.phase === "final_answer" && previous.phase !== "final_answer") {
      result[previousIndex] = item;
    }
  }
  return result;
}

function publicTurn(turn = {}) {
  const items = (turn.items || []).map(publicThreadItem).filter((item) => item.type !== "reasoning" || item.text);
  return {
    id: turn.id || randomUUID(),
    status: statusName(turn.status),
    startedAt: turn.startedAt ? Number(turn.startedAt) * 1000 : null,
    completedAt: turn.completedAt ? Number(turn.completedAt) * 1000 : null,
    durationMs: turn.durationMs ?? null,
    items: dedupeConversationItems(items),
  };
}

function runtimeTurns(task) {
  if (!(task.liveTurns instanceof Map)) task.liveTurns = new Map();
  return task.liveTurns;
}

function ensureLiveTurn(task, turnId, prompt = "") {
  if (!turnId) return null;
  const turns = runtimeTurns(task);
  let turn = turns.get(turnId);
  if (!turn) {
    turn = { id: turnId, status: "inProgress", startedAt: Date.now() / 1000, completedAt: null, durationMs: null, items: [] };
    turns.set(turnId, turn);
  }
  if (prompt && !turn.items.some((item) => item.type === "userMessage")) {
    turn.items.push({ type: "userMessage", id: `local-user-${turnId}`, content: [{ type: "text", text: prompt }] });
  }
  return turn;
}

function upsertLiveItem(turn, item) {
  if (!turn || !item?.id) return null;
  const index = turn.items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) {
    turn.items.push(structuredClone(item));
    return turn.items.at(-1);
  }
  turn.items[index] = { ...turn.items[index], ...structuredClone(item) };
  return turn.items[index];
}

function mergePublicTurns(historyTurns, liveTurns) {
  const merged = historyTurns.map((turn) => ({ ...turn, items: turn.items.map((item) => ({ ...item })) }));
  for (const live of liveTurns) {
    const existing = merged.find((turn) => turn.id === live.id);
    if (!existing) {
      merged.push(live);
      continue;
    }
    existing.status = live.status || existing.status;
    existing.startedAt ||= live.startedAt;
    existing.completedAt = live.completedAt || existing.completedAt;
    existing.durationMs = live.durationMs ?? existing.durationMs;
    const hasHistoryUser = existing.items.some((item) => item.type === "user");
    for (const item of live.items) {
      if (item.type === "user" && hasHistoryUser) continue;
      const index = existing.items.findIndex((candidate) => candidate.id === item.id);
      if (index === -1) existing.items.push(item);
      else existing.items[index] = { ...existing.items[index], ...item };
    }
    existing.items = dedupeConversationItems(existing.items);
  }
  return merged.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

export class TaskManager {
  constructor(client, config, historyStore = null, desktop = null) {
    this.client = client;
    this.config = config;
    this.historyStore = historyStore;
    this.desktop = desktop;
    this.tasks = new Map();
    this.threadToTask = new Map();
    this.approvals = new Map();
    this.persistTimer = null;
    this.persistQueue = Promise.resolve();
    client.on("notification", (message) => this.#onNotification(message));
    client.on("serverRequest", (message) => this.#onServerRequest(message));
    client.on("closed", (error) => this.#onClosed(error));
  }

  async init() {
    if (!this.historyStore) return this;
    for (const task of await this.historyStore.load()) {
      this.tasks.set(task.id, task);
      if (task.threadId) this.threadToTask.set(task.threadId, task.id);
    }
    await this.flush();
    return this;
  }

  list({ archived = false } = {}) {
    const limit = this.config.storage?.maxTasks || 100;
    return [...this.tasks.values()]
      .filter((task) => Boolean(task.archivedAt) === archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map(publicTask);
  }

  get(id) {
    const task = this.tasks.get(id);
    return task ? publicTask(task) : null;
  }

  async getDetail(id) {
    const task = this.tasks.get(id);
    if (!task) return null;
    let historyTurns = [];
    let threadPreview = task.firstPromptPreview || task.promptPreview;
    let detailError = null;
    if (task.threadId) {
      try {
        const result = await this.client.request("thread/read", { threadId: task.threadId, includeTurns: true }, 60_000);
        historyTurns = (result?.thread?.turns || []).map(publicTurn);
        threadPreview = result?.thread?.preview || threadPreview;
      } catch (error) {
        const rolloutIsStillEmpty = ACTIVE_STATUSES.has(task.status) && /rollout.+(?:is empty|empty$)/i.test(error.message);
        if (!rolloutIsStillEmpty) detailError = `暂时无法读取 Codex 完整历史：${error.message}`;
      }
    }
    const live = [...runtimeTurns(task).values()].map(publicTurn);
    return {
      ...publicTask(task),
      threadPreview,
      turns: mergePublicTurns(historyTurns, live),
      detailError,
    };
  }

  async openOnDesktop(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error("任务不存在");
    if (!task.threadId) throw new Error("这个任务还没有 Codex 线程");
    if (!this.desktop) throw new Error("桌面集成未启用");
    await this.desktop.openThread(task.threadId, { refresh: task.messageCount > 1 });
    return publicTask(task);
  }

  async createTask({ project, prompt, source = "pwa" }) {
    const now = Date.now();
    const promptPreview = preview(prompt);
    const task = {
      id: randomUUID(),
      threadId: null,
      turnId: null,
      projectId: project.id,
      projectName: project.name,
      promptPreview,
      firstPromptPreview: promptPreview,
      messageCount: 1,
      source,
      status: "creating",
      output: "",
      error: null,
      archivedAt: null,
      archiveSync: null,
      createdAt: now,
      updatedAt: now,
      approvals: [],
    };
    this.tasks.set(task.id, task);
    this.#changed(task);

    try {
      const threadParams = { cwd: project.path, ...MOBILE_THREAD_PERMISSIONS };
      if (this.config.codex.model) threadParams.model = this.config.codex.model;
      const threadResult = await this.client.request("thread/start", threadParams);
      task.threadId = threadResult?.thread?.id;
      if (!task.threadId) throw new Error("thread/start 未返回 thread.id");
      this.threadToTask.set(task.threadId, task.id);

      const turnResult = await this.client.request("turn/start", {
        threadId: task.threadId,
        input: [{ type: "text", text: prompt }],
        summary: "concise",
        ...MOBILE_TURN_PERMISSIONS,
      });
      task.turnId = turnResult?.turn?.id || task.turnId;
      ensureLiveTurn(task, task.turnId, prompt);
      // Keep the task in "creating" until App Server confirms turn/started.
      // A successful turn/start RPC only means the request was accepted and can
      // still be followed immediately by a model/version error notification.
      this.#changed(task);
      return publicTask(task);
    } catch (error) {
      task.status = "failed";
      task.error = error.message;
      this.#changed(task);
      this.#autoOpen(task, "complete");
      throw error;
    }
  }

  async followUp(taskId, prompt) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("任务不存在");
    if (!task.threadId) throw new Error("这个任务没有可继续的 Codex 线程");
    if (ACTIVE_STATUSES.has(task.status)) throw new Error("任务仍在执行，暂时不能继续发送");
    const project = this.config.projects.find((item) => item.id === task.projectId);
    if (!project) throw new Error(`项目已不在白名单中：${task.projectId}`);

    const previousStatus = task.status;
    task.status = "resuming";
    task.turnId = null;
    task.output = "";
    task.error = null;
    for (const approval of task.approvals) this.approvals.delete(approval.id);
    task.approvals = [];
    this.#changed(task);

    try {
      const resumeParams = { threadId: task.threadId, cwd: project.path, ...MOBILE_THREAD_PERMISSIONS };
      if (this.config.codex.model) resumeParams.model = this.config.codex.model;
      await this.client.request("thread/resume", resumeParams);
      this.threadToTask.set(task.threadId, task.id);
      const turnResult = await this.client.request("turn/start", {
        threadId: task.threadId,
        input: [{ type: "text", text: prompt }],
        summary: "concise",
        ...MOBILE_TURN_PERMISSIONS,
      });
      task.turnId = turnResult?.turn?.id || task.turnId;
      ensureLiveTurn(task, task.turnId, prompt);
      task.promptPreview = preview(prompt);
      task.messageCount += 1;
      task.status = "running";
      this.#changed(task);
      return publicTask(task);
    } catch (error) {
      task.status = previousStatus;
      task.error = error.message;
      this.#changed(task);
      throw error;
    }
  }

  async cancel(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("任务不存在");
    if (!task.threadId || !task.turnId || !ACTIVE_STATUSES.has(task.status)) throw new Error("任务当前不能取消");
    const previousStatus = task.status;
    task.status = "cancelling";
    this.#changed(task);
    try {
      await this.client.request("turn/interrupt", { threadId: task.threadId, turnId: task.turnId });
      task.status = "cancelled";
      for (const approval of task.approvals) {
        if (approval.status === "pending") approval.status = "cancelled";
      }
      this.#changed(task);
      return publicTask(task);
    } catch (error) {
      task.status = previousStatus;
      task.error = error.message;
      this.#changed(task);
      throw error;
    }
  }

  async archive(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("任务不存在");
    if (!task.threadId) throw new Error("这个任务还没有 Codex 线程");
    if (ACTIVE_STATUSES.has(task.status)) throw new Error("进行中的任务不能归档");
    if (!task.archivedAt) {
      try {
        await this.client.request("thread/archive", { threadId: task.threadId });
        task.archiveSync = "synced";
      } catch (error) {
        if (!isMissingRollout(error)) throw error;
        task.archiveSync = "local";
      }
      task.archivedAt = Date.now();
      this.#changed(task);
    }
    return publicTask(task);
  }

  async unarchive(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("任务不存在");
    if (!task.threadId) throw new Error("这个任务还没有 Codex 线程");
    if (task.archivedAt) {
      if (task.archiveSync !== "local") {
        await this.client.request("thread/unarchive", { threadId: task.threadId });
      }
      task.archivedAt = null;
      task.archiveSync = null;
      this.#changed(task);
    }
    return publicTask(task);
  }

  async decideApproval(approvalId, decision) {
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.status !== "pending") throw new Error("审批不存在或已处理");
    if (!["accept", "decline", "cancel"].includes(decision)) throw new Error("不支持的审批决定");

    let result;
    if (approval.method === "item/permissions/requestApproval") {
      result = {
        permissions: decision === "accept" ? approval.params.permissions : {},
        scope: "turn",
      };
    } else {
      result = { decision };
    }
    this.client.respond(approval.rpcId, result);
    approval.status = decision;
    approval.updatedAt = Date.now();
    const task = this.tasks.get(approval.taskId);
    if (task) {
      task.status = decision === "cancel" ? "cancelled" : "running";
      this.#changed(task);
    }
    return publicApproval(approval);
  }

  async flush() {
    if (!this.historyStore) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const snapshot = [...this.tasks.values()];
    this.persistQueue = this.persistQueue.then(() => this.historyStore.save(snapshot));
    await this.persistQueue;
  }

  #changed(task) {
    task.updatedAt = Date.now();
    this.#schedulePersist();
  }

  #schedulePersist() {
    if (!this.historyStore || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const snapshot = [...this.tasks.values()];
      this.persistQueue = this.persistQueue
        .then(() => this.historyStore.save(snapshot))
        .catch((error) => console.error(`[history] ${error.stack || error}`));
    }, 350);
    this.persistTimer.unref?.();
  }

  #taskForThread(threadId) {
    return this.tasks.get(this.threadToTask.get(threadId));
  }

  #autoOpen(task, phase) {
    if (!this.desktop) return;
    this.desktop.maybeOpen(task, phase).then((opened) => {
      if (opened) console.log(`[desktop] 已加载 Codex 线程 ${task.threadId}`);
    }).catch((error) => console.error(`[desktop] 无法加载线程 ${task.threadId || "unknown"}：${error.message}`));
  }

  #onNotification({ method, params = {} }) {
    const task = this.#taskForThread(notificationThreadId(params));
    if (!task) return;

    if (method === "turn/started") {
      task.turnId = params.turn?.id || params.turnId || task.turnId;
      task.status = "running";
      const turn = ensureLiveTurn(task, task.turnId);
      if (params.turn) {
        turn.status = statusName(params.turn.status || "inProgress");
        turn.startedAt = params.turn.startedAt || turn.startedAt;
        for (const item of params.turn.items || []) upsertLiveItem(turn, item);
      }
      this.#changed(task);
      this.#autoOpen(task, "start");
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      const turn = ensureLiveTurn(task, params.turnId || task.turnId);
      upsertLiveItem(turn, params.item);
      this.#changed(task);
      return;
    }

    if (method === "item/agentMessage/delta") {
      task.output = `${task.output}${params.delta || ""}`.slice(-12_000);
      const turn = ensureLiveTurn(task, params.turnId || task.turnId);
      const item = upsertLiveItem(turn, { id: params.itemId || `agent-${turn?.id}`, type: "agentMessage" });
      if (item) item.text = `${item.text || ""}${params.delta || ""}`;
      this.#changed(task);
      return;
    }

    if (method === "item/reasoning/summaryTextDelta") {
      const turn = ensureLiveTurn(task, params.turnId || task.turnId);
      const item = upsertLiveItem(turn, { id: params.itemId || `reasoning-${turn?.id}`, type: "reasoning" });
      if (item) {
        if (!Array.isArray(item.summary)) item.summary = [];
        const index = Number(params.summaryIndex) || 0;
        item.summary[index] = `${item.summary[index] || ""}${params.delta || ""}`;
      }
      this.#changed(task);
      return;
    }

    if (method === "item/commandExecution/outputDelta") {
      const turn = ensureLiveTurn(task, params.turnId || task.turnId);
      const item = upsertLiveItem(turn, { id: params.itemId || `command-${turn?.id}`, type: "commandExecution" });
      if (item) item.aggregatedOutput = `${item.aggregatedOutput || ""}${params.delta || ""}`.slice(-20_000);
      this.#changed(task);
      return;
    }

    if (method === "item/plan/delta") {
      const turn = ensureLiveTurn(task, params.turnId || task.turnId);
      const item = upsertLiveItem(turn, { id: params.itemId || `plan-${turn?.id}`, type: "plan" });
      if (item) item.text = `${item.text || ""}${params.delta || ""}`;
      this.#changed(task);
      return;
    }

    if (method === "turn/completed") {
      const finalStatus = statusName(params.turn?.status);
      const liveTurn = ensureLiveTurn(task, params.turn?.id || params.turnId || task.turnId);
      if (liveTurn) {
        liveTurn.status = finalStatus;
        liveTurn.completedAt = params.turn?.completedAt || Date.now() / 1000;
        liveTurn.durationMs = params.turn?.durationMs ?? liveTurn.durationMs;
        const completedItems = params.turn?.items;
        if (Array.isArray(completedItems) && completedItems.length) {
          const localUser = liveTurn.items.find((item) => item.type === "userMessage");
          liveTurn.items = completedItems.map((item) => structuredClone(item));
          if (localUser && !liveTurn.items.some((item) => item.type === "userMessage")) {
            liveTurn.items.unshift(localUser);
          }
        }
      }
      if (/fail|error/i.test(finalStatus)) {
        task.status = "failed";
        task.error ||= params.turn?.error?.message || `任务结束状态：${finalStatus}`;
      } else if (/cancel|interrupt/i.test(finalStatus)) {
        task.status = "cancelled";
      } else {
        task.status = "completed";
      }
      this.#changed(task);
      this.#autoOpen(task, "complete");
      return;
    }

    if (method === "error") {
      task.status = "failed";
      task.error = params.error?.message || params.message || "Codex 返回错误";
      this.#changed(task);
      this.#autoOpen(task, "complete");
    }
  }

  #onServerRequest(message) {
    const { id: rpcId, method, params = {} } = message;
    const task = this.#taskForThread(notificationThreadId(params));
    if (!APPROVAL_METHODS.has(method) || !task) {
      this.client.respondError(rpcId, -32601, "此交互需要在电脑端 Codex 中处理");
      if (task) {
        task.status = "failed";
        task.error = `手机桥接暂不支持交互：${method}`;
        this.#changed(task);
        this.#autoOpen(task, "complete");
      }
      return;
    }

    const approval = {
      id: randomUUID(),
      rpcId,
      method,
      params,
      taskId: task.id,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.approvals.set(approval.id, approval);
    task.approvals.push(approval);
    task.status = "waiting_approval";
    this.#changed(task);
  }

  #onClosed(error) {
    for (const task of this.tasks.values()) {
      if (ACTIVE_STATUSES.has(task.status)) {
        task.status = task.status === "cancelling" ? "cancelled" : "interrupted";
        task.error = task.status === "interrupted" ? "Codex 连接已关闭，可稍后继续这个任务。" : error.message;
        this.#changed(task);
      }
    }
  }
}
