import { ACTIVE_STATUSES, TaskRefreshGate, taskMatchesFilter } from "./task-list-state.mjs";

const $ = (selector) => document.querySelector(selector);
const state = {
  token: localStorage.getItem("mobile-codex-token") || "",
  projects: [],
  tasks: [],
  taskFilter: "all",
  taskQuery: "",
  activeTaskId: null,
  activeView: "compose",
  detailRefreshing: false,
  detailFirstRender: true,
  installPrompt: null,
  taskRefreshGate: new TaskRefreshGate(),
};

const STATUS = {
  creating: "正在创建",
  resuming: "正在续聊",
  running: "执行中",
  waiting_approval: "等待审批",
  cancelling: "正在取消",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "可继续",
};

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/pair") clearSession(false);
    throw new Error(body.error || `请求失败（${response.status}）`);
  }
  return body;
}

function setConnection(ok, label) {
  $("#connection-state").classList.toggle("online", ok);
  $("#connection-label").textContent = label;
  $("#codex-state").textContent = ok ? "Codex 在线" : "Codex 离线";
  $("#codex-state").closest(".status-item").classList.toggle("offline", !ok);
}

function message(element, text, success = false) {
  element.textContent = text;
  element.classList.toggle("success", success);
}

async function checkHealth() {
  try {
    const health = await api("/api/health");
    document.querySelectorAll(".app-version").forEach((element) => {
      element.textContent = health.version ? `v${health.version}` : "v—";
    });
    setConnection(Boolean(health.codexReady), health.codexReady ? "电脑在线" : "Codex 未连接");
  } catch {
    document.querySelectorAll(".app-version").forEach((element) => {
      element.textContent = "v—";
    });
    setConnection(false, "电脑离线");
  }
}

async function pair(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  message($("#pair-message"), "正在验证配对码…");
  try {
    const result = await api("/api/pair", {
      method: "POST",
      body: JSON.stringify({
        code: $("#pair-code").value.replace(/\D/g, ""),
        deviceName: $("#device-name").value.trim(),
      }),
    });
    state.token = result.token;
    localStorage.setItem("mobile-codex-token", state.token);
    message($("#pair-message"), "配对成功", true);
    await enterApp();
  } catch (error) {
    message($("#pair-message"), error.message);
  } finally {
    button.disabled = false;
  }
}

async function enterApp() {
  const projectsResult = await api("/api/projects");
  state.projects = projectsResult.projects;
  const select = $("#project-select");
  select.replaceChildren(...state.projects.map((project) => new Option(project.name, project.id)));
  $("#pair-panel").hidden = true;
  $("#app-panel").hidden = false;
  await refreshTasks();
}

async function restoreSession() {
  try {
    await api("/api/session");
    await enterApp();
  } catch {
    clearSession(false);
  }
}

function clearSession(reload = true) {
  state.token = "";
  localStorage.removeItem("mobile-codex-token");
  if (reload) location.reload();
  else {
    $("#app-panel").hidden = true;
    $("#pair-panel").hidden = false;
  }
}

async function logout() {
  try {
    if (state.token) await api("/api/session/revoke", { method: "POST" });
  } catch {
    // Local removal is still required if the computer is offline.
  } finally {
    clearSession();
  }
}

async function submitTask(event) {
  event.preventDefault();
  const button = $("#submit-task");
  const prompt = $("#prompt").value.trim();
  button.disabled = true;
  message($("#task-message"), "正在电脑端创建 Codex 任务…");
  try {
    const result = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ projectId: $("#project-select").value, prompt }),
    });
    $("#prompt").value = "";
    message($("#task-message"), "指令已提交，正在等待 Codex 确认启动…");
    await refreshTasks();
    await openTaskDetail(result.task.id);
    const task = await waitForTaskStart(result.task);
    const threadLabel = task.threadId ? ` ${task.threadId.slice(0, 12)}…` : "";
    message($("#task-message"), `Codex 任务已启动${threadLabel}`, true);
    await refreshTaskDetail();
  } catch (error) {
    message($("#task-message"), error.message);
  } finally {
    button.disabled = false;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForTaskStart(initialTask, timeoutMs = 30_000) {
  let task = initialTask;
  const deadline = Date.now() + timeoutMs;
  while (task.status === "creating" && Date.now() < deadline) {
    await delay(500);
    ({ task } = await api(`/api/tasks/${encodeURIComponent(task.id)}`));
    await refreshTasks();
  }
  if (task.status === "failed") throw new Error(task.error || "Codex 任务启动失败");
  if (task.status === "creating") throw new Error("Codex 尚未确认任务启动，请在任务列表中查看后续状态");
  return task;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(value);
}

function approvalCard(approval) {
  const card = element("div", "approval-card");
  card.append(element("strong", "", approval.method.includes("fileChange") ? "Codex 请求修改文件" : "Codex 请求额外权限"));
  const detail = element("code", "", approval.command || approval.reason || JSON.stringify(approval.permissions || {}, null, 2));
  card.append(detail);
  const actions = element("div", "approval-actions");
  const approve = element("button", "approve", "批准本次");
  const deny = element("button", "deny", "拒绝");
  approve.type = deny.type = "button";
  approve.addEventListener("click", () => decideApproval(approval.id, "accept", approve));
  deny.addEventListener("click", () => decideApproval(approval.id, "decline", deny));
  actions.append(approve, deny);
  card.append(actions);
  return card;
}

function taskCard(task) {
  const card = element("article", "task-card");
  card.dataset.status = task.status;
  const main = element("div", "task-main");
  main.append(element("h3", "", task.promptPreview));
  const meta = element("div", "task-meta");
  meta.append(element("span", "", task.projectName), element("span", "", formatTime(task.createdAt)));
  if (task.messageCount > 1) meta.append(element("span", "", `${task.messageCount} 轮对话`));
  if (task.threadId) meta.append(element("span", "", task.threadId.slice(0, 13)));
  main.append(meta);
  const outputText = task.error || task.output;
  if (outputText) main.append(element("p", `task-output${task.error ? " task-error" : ""}`, outputText.slice(-360)));
  card.append(main, element("span", "status-pill", STATUS[task.status] || task.status));
  for (const approval of task.approvals.filter((item) => item.status === "pending")) card.append(approvalCard(approval));
  const actions = element("div", "task-actions");
  if (task.canOpenOnDesktop) {
    const open = element("button", "task-action", "电脑端打开");
    open.type = "button";
    open.addEventListener("click", () => openOnDesktop(task.id, open));
    actions.append(open);
  }
  if (task.canCancel) {
    const cancel = element("button", "task-action danger-action", "停止任务");
    cancel.type = "button";
    cancel.addEventListener("click", () => cancelTask(task.id, cancel));
    actions.append(cancel);
  }
  if (task.canFollowUp) {
    const follow = element("button", "task-action", "继续这个任务");
    follow.type = "button";
    const followForm = element("form", "followup-form");
    followForm.hidden = true;
    const input = element("textarea", "followup-input");
    input.rows = 3;
    input.maxLength = 12000;
    input.placeholder = "补充要求或继续追问…";
    const send = element("button", "followup-send", "发送后续指令 →");
    send.type = "submit";
    followForm.append(input, send);
    follow.addEventListener("click", () => {
      followForm.hidden = !followForm.hidden;
      if (!followForm.hidden) input.focus();
    });
    followForm.addEventListener("submit", (event) => sendFollowUp(event, task.id, input, send));
    actions.append(follow, followForm);
  }
  if (task.canArchive || task.canUnarchive) {
    const archive = element("button", "task-action archive-action", task.canUnarchive ? "恢复到任务列表" : "归档任务");
    archive.type = "button";
    archive.addEventListener("click", () => setTaskArchived(task.id, task.canUnarchive, archive));
    actions.append(archive);
  }
  if (actions.childElementCount) card.append(actions);
  card.classList.add("task-card-link");
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `查看任务详情：${task.firstPromptPreview || task.promptPreview}`);
  const openDetail = (event) => {
    if (event.target.closest("button, form, textarea, input, a")) return;
    openTaskDetail(task.id);
  };
  card.addEventListener("click", openDetail);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openTaskDetail(task.id);
    }
  });
  return card;
}

function renderTasks() {
  const list = $("#task-list");
  const visibleTasks = state.tasks.filter((task) => taskMatchesFilter(task, {
    filter: state.taskFilter,
    query: state.taskQuery,
  }));
  const activeCount = state.tasks.filter((task) => ACTIVE_STATUSES.has(task.status) || task.status === "waiting_approval").length;
  $("#task-count").textContent = `${state.tasks.length} 条${state.taskFilter === "archived" ? "归档" : ""}`;
  $("#tasks-heading").textContent = state.taskFilter === "archived" ? "归档历史" : "最近任务";
  $("#active-task-count").textContent = activeCount > 99 ? "99+" : String(activeCount);
  $("#active-task-count").hidden = activeCount === 0;
  if (visibleTasks.length) {
    list.replaceChildren(...visibleTasks.map(taskCard));
    return;
  }
  const empty = element("div", "empty-state");
  empty.append(
    element("span", "", state.tasks.length ? "没有匹配的任务" : "等待第一条指令"),
    element("p", "", state.tasks.length ? "试试切换状态或清空搜索条件。" : "在“新建任务”中输入要求，电脑端会创建一个真实的 Codex 任务。"),
  );
  list.replaceChildren(empty);
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function appendInlineMarkdown(parent, text) {
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(cursor, match.index)));
    if (match[2]) parent.append(element("strong", "", match[2]));
    else if (match[3]) parent.append(element("code", "", match[3]));
    else if (match[4] && match[5]) {
      const link = element("a", "", match[4]);
      link.href = match[5];
      link.target = "_blank";
      link.rel = "noreferrer";
      parent.append(link);
    }
    cursor = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(cursor)));
}

function renderMarkdown(container, text) {
  const lines = String(text || "").split(/\r?\n/);
  let list = null;
  let code = null;
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (code) {
        container.append(code);
        code = null;
      } else {
        list = null;
        code = element("pre", "message-code");
      }
      continue;
    }
    if (code) {
      code.textContent += `${code.textContent ? "\n" : ""}${line}`;
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      if (!list) {
        list = element("ul", "message-list");
        container.append(list);
      }
      const item = element("li");
      appendInlineMarkdown(item, bullet[1]);
      list.append(item);
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    const block = element(heading ? "h4" : "p");
    appendInlineMarkdown(block, heading ? heading[1] : line);
    container.append(block);
  }
  if (code) container.append(code);
}

function detailMessage(item) {
  const wrapper = element("article", `conversation-message ${item.type}`);
  const label = element("div", "message-role", item.type === "user" ? "你" : "Codex");
  const text = element("div", "message-text");
  renderMarkdown(text, item.text || "");
  wrapper.append(label, text);
  return wrapper;
}

function detailProcess(item, expanded = false) {
  const card = element("details", `process-card ${item.activityType || item.type}`);
  card.open = expanded;
  const summary = element("summary", "process-summary");
  const marker = element("i", "process-marker");
  const title = element("strong", "", item.title || "执行步骤");
  const meta = element("span", "", [item.status, formatDuration(item.durationMs)].filter(Boolean).join(" · "));
  summary.append(marker, title, meta);
  const body = element("div", "process-body");
  if (item.text) body.append(element("pre", "process-text", item.text));
  if (item.detail) body.append(element("pre", "process-output", item.detail));
  if (!item.text && !item.detail) body.append(element("p", "", "步骤已完成"));
  card.append(summary, body);
  return card;
}

function renderTaskDetail(task) {
  const conversation = $("#detail-conversation");
  const wasNearBottom = state.detailFirstRender || conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 140;
  $("#detail-title").textContent = task.firstPromptPreview || task.threadPreview || task.promptPreview;
  $("#detail-project").textContent = task.projectName || "任务详情";
  $("#detail-status").textContent = STATUS[task.status] || task.status;
  $("#detail-status").dataset.status = task.status;
  const threadLabel = task.threadId ? task.threadId.slice(0, 13) : "等待线程";
  $("#detail-turn-count").textContent = `${task.turns.length} 轮对话 · ${threadLabel}`;
  $("#detail-open-desktop").disabled = !task.canOpenOnDesktop;
  $("#detail-cancel").hidden = !task.canCancel;
  const archiveButton = $("#detail-archive");
  archiveButton.hidden = !task.canArchive && !task.canUnarchive;
  archiveButton.textContent = task.canUnarchive ? "恢复到任务列表" : "归档任务";
  archiveButton.dataset.unarchive = String(task.canUnarchive);
  $("#detail-followup-form").hidden = !task.canFollowUp;
  $("#detail-hint").textContent = task.canFollowUp
    ? "继续追问会保留这个 Codex 线程的全部上下文"
    : task.archivedAt
      ? task.archiveSync === "local"
        ? "此会话仅归档到手机历史；电脑端尚未同步，可在桌面端手动归档。"
        : "此会话已归档到电脑端 Codex 的 Archived tasks，可在此恢复。"
    : task.status === "waiting_approval"
      ? "Codex 正在等待你的审批"
      : "Codex 正在执行，进度会自动更新";

  const content = document.createDocumentFragment();
  if (task.error) content.append(element("div", "detail-warning", `任务未完成：${task.error}`));
  if (task.detailError) content.append(element("div", "detail-warning", task.detailError));
  task.turns.forEach((turn, index) => {
    const section = element("section", "conversation-turn");
    section.dataset.status = turn.status;
    const divider = element("div", "turn-divider");
    divider.append(
      element("span", "", `第 ${index + 1} 轮`),
      element("small", "", [STATUS[turn.status] || turn.status, formatDuration(turn.durationMs)].filter(Boolean).join(" · ")),
    );
    section.append(divider);
    for (const item of turn.items) {
      if (item.type === "user" || item.type === "assistant") section.append(detailMessage(item));
      else section.append(detailProcess(item, turn.status !== "completed"));
    }
    content.append(section);
  });
  if (!task.turns.length) {
    const loading = element("div", "detail-loading");
    loading.append(element("i"), element("span", "", task.status === "creating" ? "正在电脑端创建 Codex 线程…" : "等待 Codex 返回对话历史…"));
    content.append(loading);
  }
  for (const approval of task.approvals.filter((item) => item.status === "pending")) content.append(approvalCard(approval));
  conversation.replaceChildren(content);
  if (wasNearBottom) conversation.scrollTop = conversation.scrollHeight;
  state.detailFirstRender = false;
}

async function refreshTaskDetail() {
  if (!state.activeTaskId || document.hidden || state.detailRefreshing) return;
  state.detailRefreshing = true;
  try {
    const { task } = await api(`/api/tasks/${encodeURIComponent(state.activeTaskId)}`);
    renderTaskDetail(task);
  } catch (error) {
    $("#detail-conversation").replaceChildren(element("div", "detail-warning", error.message));
  } finally {
    state.detailRefreshing = false;
  }
}

async function openTaskDetail(taskId) {
  const changed = state.activeTaskId !== taskId;
  state.activeTaskId = taskId;
  state.detailFirstRender = changed;
  if (changed) {
    const loading = element("div", "detail-loading");
    loading.append(element("i"), element("span", "", "正在读取 Codex 对话历史…"));
    $("#detail-conversation").replaceChildren(loading);
  }
  setTaskView("detail");
  await refreshTaskDetail();
}

async function refreshTasks() {
  if (!state.token || document.hidden || document.activeElement?.closest?.(".followup-form")) return;
  const refreshRequest = state.taskRefreshGate.begin();
  try {
    const result = await api(state.taskFilter === "archived" ? "/api/tasks?archived=true" : "/api/tasks");
    if (!state.taskRefreshGate.isCurrent(refreshRequest)) return;
    state.tasks = result.tasks;
    renderTasks();
  } catch (error) {
    if (!state.taskRefreshGate.isCurrent(refreshRequest)) return;
    message($("#task-message"), error.message);
  }
}

async function setTaskArchived(taskId, unarchive, button) {
  const action = unarchive ? "unarchive" : "archive";
  const confirmation = unarchive
    ? "恢复这个会话？它会重新出现在手机任务中心和电脑端 Codex 任务列表。"
    : "归档这个历史任务？会话内容会保留；旧线程无法同步时将仅归档到手机历史。";
  if (!window.confirm(confirmation)) return;
  button.disabled = true;
  try {
    const { task } = await api(`/api/tasks/${encodeURIComponent(taskId)}/${action}`, { method: "POST" });
    if (unarchive && state.taskFilter !== "archived") {
      state.tasks = [task, ...state.tasks.filter((item) => item.id !== taskId)];
    } else {
      state.tasks = state.tasks.filter((item) => item.id !== taskId);
    }
    renderTasks();
    const successMessage = unarchive
      ? "会话已恢复到任务列表"
      : task.archiveSync === "local"
        ? "会话已归档到手机历史；电脑端尚未同步"
        : "会话已归档到电脑端 Codex";
    message($("#task-message"), successMessage, true);
    if (!unarchive && state.activeTaskId === taskId) {
      state.activeTaskId = null;
      setTaskView("tasks");
    }
    await refreshTasks();
  } catch (error) {
    message($("#task-message"), error.message);
    button.disabled = false;
  }
}

async function sendFollowUp(event, taskId, input, button) {
  event.preventDefault();
  const prompt = input.value.trim();
  if (!prompt) return;
  button.disabled = true;
  message($("#task-message"), "正在继续原 Codex 线程…");
  try {
    const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/follow-up`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
    message($("#task-message"), `已发送第 ${result.task.messageCount} 轮指令`, true);
    await refreshTasks();
    input.value = "";
    await openTaskDetail(taskId);
  } catch (error) {
    message($("#task-message"), error.message);
  } finally {
    button.disabled = false;
  }
}

async function cancelTask(taskId, button) {
  if (!window.confirm("停止当前 Codex 任务？已经完成的修改不会自动撤销。")) return;
  button.disabled = true;
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
    message($("#task-message"), "任务已停止", true);
    await refreshTasks();
    await refreshTaskDetail();
  } catch (error) {
    message($("#task-message"), error.message);
    button.disabled = false;
  }
}

async function openOnDesktop(taskId, button) {
  button.disabled = true;
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}/open`, { method: "POST" });
    message($("#task-message"), "已让电脑端 Codex 打开这个任务", true);
  } catch (error) {
    message($("#task-message"), error.message);
  } finally {
    button.disabled = false;
  }
}

async function decideApproval(id, decision, button) {
  button.disabled = true;
  try {
    await api(`/api/approvals/${encodeURIComponent(id)}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
    await refreshTasks();
    await refreshTaskDetail();
  } catch (error) {
    message($("#task-message"), error.message);
    button.disabled = false;
  }
}

function setTaskView(view) {
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  state.activeView = view;
  document.querySelectorAll("[data-view]").forEach((panel) => panel.classList.toggle("mobile-active", panel.dataset.view === view));
  document.querySelectorAll("[data-view-target]").forEach((button) => {
    const active = button.dataset.viewTarget === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.body.classList.toggle("overlay-open", mobile && (view === "tasks" || view === "detail"));
  if (mobile) window.scrollTo({ top: 0, behavior: "smooth" });
}

function startNewTask() {
  setTaskView("compose");
  const composer = document.querySelector('[data-view="compose"]');
  composer.classList.remove("composer-attention");
  void composer.offsetWidth;
  composer.classList.add("composer-attention");
  window.setTimeout(() => {
    $("#prompt").focus({ preventScroll: true });
    composer.classList.remove("composer-attention");
  }, 180);
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPrompt = event;
  $("#install-app").hidden = false;
});
$("#install-app").addEventListener("click", async () => {
  await state.installPrompt?.prompt();
  state.installPrompt = null;
  $("#install-app").hidden = true;
});

$("#pair-code").addEventListener("input", (event) => {
  event.target.value = event.target.value.replace(/\D/g, "").slice(0, 6);
});
$("#pair-form").addEventListener("submit", pair);
$("#task-form").addEventListener("submit", submitTask);
$("#logout").addEventListener("click", logout);
$("#refresh-tasks").addEventListener("click", refreshTasks);
$("#new-task-button").addEventListener("click", startNewTask);
$("#refresh-detail").addEventListener("click", refreshTaskDetail);
$("#detail-open-desktop").addEventListener("click", (event) => openOnDesktop(state.activeTaskId, event.currentTarget));
$("#detail-cancel").addEventListener("click", (event) => cancelTask(state.activeTaskId, event.currentTarget));
$("#detail-archive").addEventListener("click", (event) => setTaskArchived(state.activeTaskId, event.currentTarget.dataset.unarchive === "true", event.currentTarget));
$("#detail-followup-form").addEventListener("submit", (event) => sendFollowUp(
  event,
  state.activeTaskId,
  $("#detail-followup-input"),
  $("#detail-followup-send"),
));
$("#task-search").addEventListener("input", (event) => {
  state.taskQuery = event.target.value.trim().toLocaleLowerCase("zh-CN");
  renderTasks();
});
document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
  const wasShowingArchived = state.taskFilter === "archived";
  state.taskFilter = button.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach((item) => {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
  });
  if (wasShowingArchived || state.taskFilter === "archived") refreshTasks();
  else renderTasks();
}));
document.querySelectorAll("[data-view-target]").forEach((button) => button.addEventListener("click", () => setTaskView(button.dataset.viewTarget)));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  checkHealth();
  if (state.activeView === "detail") refreshTaskDetail();
  else refreshTasks();
});

setTaskView("compose");
checkHealth();
setInterval(checkHealth, 15_000);
setInterval(() => {
  if (state.activeView !== "detail") refreshTasks();
}, 6_000);
setInterval(() => {
  if (state.activeView === "detail") refreshTaskDetail();
}, 3_500);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js").catch(() => {});

const codeFromUrl = new URLSearchParams(location.search).get("code");
if (codeFromUrl) $("#pair-code").value = codeFromUrl.replace(/\D/g, "").slice(0, 6);
restoreSession();
