export const ACTIVE_STATUSES = new Set(["creating", "resuming", "running", "cancelling", "interrupted"]);

export function shouldRefreshTaskList({ appVisible, documentHidden, followupFocused }) {
  return Boolean(appVisible && !documentHidden && !followupFocused);
}

export function taskMatchesFilter(task, { filter = "all", query = "" } = {}) {
  if (filter === "archived") {
    if (!task.archivedAt) return false;
  } else if (task.archivedAt) {
    return false;
  }

  if (filter === "active" && !ACTIVE_STATUSES.has(task.status)) return false;
  if (filter === "approval" && task.status !== "waiting_approval") return false;
  if (filter === "completed" && task.status !== "completed") return false;
  if (!query) return true;
  const haystack = [task.promptPreview, task.projectName, task.output, task.error]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("zh-CN");
  return haystack.includes(query);
}

export class TaskRefreshGate {
  #latestRequest = 0;

  begin() {
    this.#latestRequest += 1;
    return this.#latestRequest;
  }

  isCurrent(request) {
    return request === this.#latestRequest;
  }
}
