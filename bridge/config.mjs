import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function getConfigPath() {
  return path.resolve(process.env.MOBILE_CODEX_CONFIG || path.join(pluginRoot, "config.local.json"));
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value.trim();
}

function integerInRange(value, fallback, min, max, label) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return number;
}

function enumValue(value, fallback, allowed, label) {
  const normalized = value == null ? fallback : String(value).trim();
  if (!allowed.includes(normalized)) throw new Error(`${label} 必须是：${allowed.join("、")}`);
  return normalized;
}

export async function loadConfig(configPath = getConfigPath()) {
  await access(configPath).catch(() => {
    throw new Error(`找不到配置文件：${configPath}\n请复制 config.example.json 为 config.local.json 后再启动。`);
  });

  const raw = JSON.parse(await readFile(configPath, "utf8"));
  const projectList = Array.isArray(raw.projects) ? raw.projects : [];
  if (projectList.length === 0) {
    throw new Error("projects 至少需要配置一个项目");
  }

  const seenIds = new Set();
  const projects = [];
  for (const item of projectList) {
    const id = requiredString(item.id, "projects[].id");
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)) {
      throw new Error(`项目 id 只能包含字母、数字和连字符：${id}`);
    }
    if (seenIds.has(id)) throw new Error(`项目 id 重复：${id}`);
    seenIds.add(id);

    const projectPath = path.resolve(requiredString(item.path, `projects[${id}].path`));
    const info = await stat(projectPath).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`项目目录不存在：${projectPath}`);

    projects.push({
      id,
      name: requiredString(item.name || id, `projects[${id}].name`),
      path: projectPath,
    });
  }

  const defaultProjectId = raw.wechat?.defaultProjectId || projects[0].id;
  if (!seenIds.has(defaultProjectId)) {
    throw new Error(`wechat.defaultProjectId 不在 projects 中：${defaultProjectId}`);
  }

  return {
    configPath,
    server: {
      host: requiredString(raw.server?.host || "127.0.0.1", "server.host"),
      port: integerInRange(raw.server?.port, 3847, 1024, 65535, "server.port"),
      publicBaseUrl: String(raw.server?.publicBaseUrl || "").replace(/\/$/, ""),
    },
    projects,
    codex: {
      binary: requiredString(raw.codex?.binary || "codex", "codex.binary"),
      model: raw.codex?.model ? requiredString(raw.codex.model, "codex.model") : null,
    },
    desktop: {
      autoOpen: enumValue(raw.desktop?.autoOpen, "never", ["never", "on-start", "on-complete"], "desktop.autoOpen"),
    },
    security: {
      pairingTtlMinutes: integerInRange(raw.security?.pairingTtlMinutes, 10_080, 1, 525_600, "security.pairingTtlMinutes"),
      sessionTtlDays: integerInRange(raw.security?.sessionTtlDays, 30, 1, 365, "security.sessionTtlDays"),
      maxPromptChars: integerInRange(raw.security?.maxPromptChars, 12000, 100, 100000, "security.maxPromptChars"),
      rateLimitPerMinute: integerInRange(raw.security?.rateLimitPerMinute, 30, 5, 600, "security.rateLimitPerMinute"),
    },
    storage: {
      persistTaskHistory: raw.storage?.persistTaskHistory !== false,
      persistOutputs: Boolean(raw.storage?.persistOutputs),
      maxTasks: integerInRange(raw.storage?.maxTasks, 100, 10, 1000, "storage.maxTasks"),
    },
    wechat: {
      enabled: Boolean(raw.wechat?.enabled),
      tokenEnv: requiredString(raw.wechat?.tokenEnv || "WECHAT_BRIDGE_TOKEN", "wechat.tokenEnv"),
      defaultProjectId,
      routePrefix: String(raw.wechat?.routePrefix || "#").slice(0, 1),
    },
  };
}
