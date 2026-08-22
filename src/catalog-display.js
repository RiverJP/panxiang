import crypto from "node:crypto";

const minimumSortOrder = -9999;
const maximumSortOrder = 9999;

export function normalizeCatalogSortOrder(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(minimumSortOrder, Math.min(maximumSortOrder, Math.round(parsed)));
}

function comparablePrice(product) {
  const parsed = Number(product?.price);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * The admin-defined rank is authoritative. “Popular” remains a storefront
 * badge and is only used to make legacy duplicate ranks deterministic.
 */
export function compareCatalogDisplayOrder(left, right) {
  return normalizeCatalogSortOrder(left?.sortOrder) - normalizeCatalogSortOrder(right?.sortOrder)
    || Number(Boolean(right?.popular)) - Number(Boolean(left?.popular))
    || comparablePrice(left) - comparablePrice(right)
    || String(left?.id || left?.sku || "").localeCompare(String(right?.id || right?.sku || ""));
}

export function assignCatalogDisplayOrder(products, orderedSkus) {
  if (!Array.isArray(orderedSkus) || orderedSkus.length > maximumSortOrder) {
    throw new RangeError(`商品排序最多支持 ${maximumSortOrder} 个 SKU`);
  }
  const ranks = new Map(orderedSkus.map((sku, index) => [String(sku), index + 1]));
  for (const product of products) {
    const rank = ranks.get(String(product?.sku || ""));
    if (rank !== undefined) product.sortOrder = rank;
  }
  return products;
}

export function catalogDisplaySkus(products) {
  return [...products]
    .sort(compareCatalogDisplayOrder)
    .map((product) => String(product?.id || product?.sku || ""));
}

export function appendCatalogDisplayOrder(products, currentOrderedSkus, appendedSkus) {
  const appended = appendedSkus.map(String);
  const appendedSet = new Set(appended);
  if (appendedSet.size !== appended.length) throw new TypeError("待追加的 SKU 不能重复");
  const combined = [
    ...currentOrderedSkus.map(String).filter((sku) => !appendedSet.has(sku)),
    ...appended
  ];
  if (new Set(combined).size !== combined.length) throw new TypeError("商品排序中存在重复 SKU");
  assignCatalogDisplayOrder(products, combined);
  return combined;
}

export function catalogOrderRevision(orderedSkus) {
  return crypto.createHash("sha256")
    .update(`panxiang-catalog-order-v1\n${JSON.stringify(orderedSkus.map(String))}`)
    .digest("hex");
}

export function normalizeCatalogOrderRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("请求内容必须是 JSON 对象");
  }
  if (!Array.isArray(input.skus) || input.skus.length === 0 || input.skus.length > maximumSortOrder) {
    throw new TypeError("请提交完整的上架商品 SKU 顺序");
  }
  if (input.skus.some((sku) => typeof sku !== "string")) {
    throw new TypeError("SKU 必须是字符串");
  }
  const skus = input.skus.map((sku) => sku.trim());
  if (skus.some((sku) => !sku) || new Set(skus).size !== skus.length) {
    throw new TypeError("SKU 顺序中存在空值或重复项");
  }
  if (typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
    throw new TypeError("请提交有效的排序版本");
  }
  return { skus, expectedRevision: input.expectedRevision };
}

export function catalogSkuSetsMatch(leftSkus, rightSkus) {
  if (!Array.isArray(leftSkus) || !Array.isArray(rightSkus) || leftSkus.length !== rightSkus.length) return false;
  const left = new Set(leftSkus.map(String));
  const right = new Set(rightSkus.map(String));
  if (left.size !== leftSkus.length || right.size !== rightSkus.length || left.size !== right.size) return false;
  return [...left].every((sku) => right.has(sku)) && [...right].every((sku) => left.has(sku));
}
