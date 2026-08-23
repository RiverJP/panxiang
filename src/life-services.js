export const MAX_LIFE_SERVICES = 100;

export const DEFAULT_LIFE_SERVICES = Object.freeze([
  Object.freeze({ id: "phone-unlock", title: "手机解锁协助", description: "网络锁、使用限制等问题咨询与处理协助", enabled: true, sortOrder: 10 }),
  Object.freeze({ id: "visa-consulting", title: "签证办理咨询", description: "签证类型、材料准备及常见流程咨询", enabled: true, sortOrder: 20 }),
  Object.freeze({ id: "driver-license", title: "驾照办理协助", description: "办理要求、资料准备及相关流程协助", enabled: true, sortOrder: 30 }),
  Object.freeze({ id: "other-services", title: "其他业务", description: "更多本地生活服务正在拓展中", enabled: true, sortOrder: 40 })
]);

function cleanText(value, maximumLength) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

export function normalizeLifeService(input, { requireId = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const id = cleanText(input.id, 80);
  const title = cleanText(input.title, 40);
  const description = cleanText(input.description, 240);
  const sortOrder = Number(input.sortOrder);
  if ((requireId && !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) || !title) return null;
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 1_000_000) return null;
  if (typeof input.enabled !== "boolean") return null;
  return { ...(requireId ? { id } : {}), title, description, enabled: input.enabled, sortOrder };
}

export function normalizeLifeServices(value) {
  if (!Array.isArray(value)) return DEFAULT_LIFE_SERVICES.map((service) => ({ ...service }));
  const ids = new Set();
  const services = [];
  for (const item of value.slice(0, MAX_LIFE_SERVICES)) {
    const service = normalizeLifeService(item);
    if (!service || ids.has(service.id)) continue;
    ids.add(service.id);
    services.push(service);
  }
  return services;
}

export function validateLifeServicesStrict(value) {
  if (!Array.isArray(value)) throw new Error("生活服务数据必须是数组");
  if (value.length > MAX_LIFE_SERVICES) throw new Error(`生活服务数据超过 ${MAX_LIFE_SERVICES} 项上限`);

  const allowedFields = new Set(["id", "title", "description", "enabled", "sortOrder"]);
  const ids = new Set();
  return value.map((item, index) => {
    const itemNumber = index + 1;
    const service = normalizeLifeService(item);
    if (!service) throw new Error(`生活服务第 ${itemNumber} 项格式无效`);

    const unknownFields = Object.keys(item).filter((field) => !allowedFields.has(field));
    if (unknownFields.length) throw new Error(`生活服务第 ${itemNumber} 项包含未知字段：${unknownFields.join("、")}`);
    if (typeof item.id !== "string" || item.id !== service.id) throw new Error(`生活服务第 ${itemNumber} 项 ID 格式无效`);
    if (typeof item.title !== "string" || item.title !== service.title) throw new Error(`生活服务第 ${itemNumber} 项名称格式无效`);
    if (typeof item.description !== "string" || item.description !== service.description) throw new Error(`生活服务第 ${itemNumber} 项说明格式无效`);
    if (typeof item.sortOrder !== "number" || item.sortOrder !== service.sortOrder) throw new Error(`生活服务第 ${itemNumber} 项排序格式无效`);
    if (ids.has(service.id)) throw new Error(`生活服务存在重复 ID：${service.id}`);
    ids.add(service.id);
    return service;
  });
}

export function compareLifeServices(left, right) {
  return Number(left.sortOrder) - Number(right.sortOrder)
    || String(left.title).localeCompare(String(right.title), "zh-CN", { numeric: true })
    || String(left.id).localeCompare(String(right.id));
}

export function publicLifeServices(value) {
  return normalizeLifeServices(value)
    .filter((service) => service.enabled)
    .sort(compareLifeServices)
    .map(({ id, title, description }) => ({ id, title, description }));
}
