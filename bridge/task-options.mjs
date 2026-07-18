const REASONING_LABELS = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
  ultra: "Ultra",
};

export function accessParams(accessLevel) {
  return { thread: { permissions: accessLevel }, turn: { permissions: accessLevel } };
}

function permissionLabel(id) {
  if (id === ":read-only") return { label: "只读", description: "与电脑端只读模式一致" };
  if (id === ":workspace") return { label: "工作区", description: "与电脑端工作区访问模式一致" };
  if (id === ":danger-full-access") return { label: "完全访问", description: "与电脑端完全访问模式一致" };
  return { label: id.replace(/^:/, ""), description: "电脑端权限配置" };
}

export function executionCatalog(modelResponse, permissionResponse, configuredModel = null) {
  const models = (modelResponse?.data || []).filter((model) => model && !model.hidden && typeof model.model === "string").map((model) => ({
    id: model.model,
    label: model.displayName || model.model,
    description: model.description || "",
    isDefault: Boolean(model.isDefault),
    defaultEffort: model.defaultReasoningEffort || null,
    efforts: (model.supportedReasoningEfforts || []).map((effort) => ({
      id: effort.reasoningEffort,
      label: REASONING_LABELS[effort.reasoningEffort] || effort.reasoningEffort,
      description: effort.description || "",
    })).filter((effort) => effort.id),
  }));
  const configured = models.find((model) => model.id === configuredModel);
  const defaultModel = configured || models.find((model) => model.isDefault) || models[0] || null;
  const accessLevels = (permissionResponse?.data || []).filter((profile) => profile?.allowed && typeof profile.id === "string").map((profile) => ({
    id: profile.id,
    ...permissionLabel(profile.id),
    description: profile.description || permissionLabel(profile.id).description,
  }));
  const defaultAccess = accessLevels.find((item) => item.id === ":danger-full-access") || accessLevels[0] || null;
  return {
    accessLevels,
    models,
    defaults: {
      accessLevel: defaultAccess?.id || "",
      model: defaultModel?.id || configuredModel || "",
      effort: defaultModel?.defaultEffort || "medium",
    },
  };
}

export function validateExecutionSelection(selection = {}, catalog) {
  const requestedAccess = String(selection.accessLevel || "");
  const accessLevel = requestedAccess
    ? catalog.accessLevels.find((item) => item.id === requestedAccess)?.id
    : catalog.defaults.accessLevel;
  if (requestedAccess && !accessLevel) throw new Error("请选择电脑端允许的访问等级");
  if (!accessLevel) throw new Error("Codex 当前没有返回可用的访问等级");
  const requestedModel = String(selection.model || "");
  const model = requestedModel
    ? catalog.models.find((item) => item.id === requestedModel)
    : catalog.models.find((item) => item.id === catalog.defaults.model) || catalog.models[0];
  if (requestedModel && !model) throw new Error("请选择电脑端当前可用的模型");
  if (!model) throw new Error("Codex 当前没有返回可用模型");
  const requestedEffort = String(selection.effort || "");
  const effort = requestedEffort
    ? model.efforts.find((item) => item.id === requestedEffort)?.id
    : model.efforts.find((item) => item.id === model.defaultEffort)?.id || model.efforts[0]?.id;
  if (requestedEffort && !effort) throw new Error(`模型 ${model.label} 不支持所选推理深度`);
  if (!effort) throw new Error(`模型 ${model.label} 没有返回可用的推理深度`);
  return { accessLevel, model: model.id, effort };
}
