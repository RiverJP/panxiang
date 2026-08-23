import crypto from "node:crypto";

export const catalog = [
  { id: "telkomsel-voice-10k", sku: "telkomsel-voice-10k", operator: "Telkomsel", kind: "话费", label: "Telkomsel 话费 10K", amount: 10000, price: 7.2, currency: "CNY", popular: true },
  { id: "telkomsel-data-2gb", sku: "telkomsel-data-2gb", operator: "Telkomsel", kind: "流量", label: "Telkomsel 流量 2GB", amount: 2, unit: "GB", price: 14.9, currency: "CNY", popular: true },
  { id: "indosat-data-5gb", sku: "indosat-data-5gb", operator: "Indosat", kind: "流量", label: "Indosat 流量 5GB", amount: 5, unit: "GB", price: 16.9, currency: "CNY", popular: false },
  { id: "xl-data-3gb", sku: "xl-data-3gb", operator: "XL", kind: "流量", label: "XL 流量 3GB", amount: 3, unit: "GB", price: 12.9, currency: "CNY", popular: false }
];

const operatorPrefixes = {
  Telkomsel: ["0811", "0812", "0813", "0821", "0822", "0823", "0851", "0852", "0853"],
  Indosat: ["0814", "0815", "0816", "0855", "0856", "0857", "0858"],
  XL: ["0817", "0818", "0819", "0859", "0877", "0878"],
  AXIS: ["0831", "0832", "0833", "0838"],
  Tri: ["0895", "0896", "0897", "0898", "0899"],
  Smartfren: ["0881", "0882", "0883", "0884", "0885", "0886", "0887", "0888", "0889"]
};

export function normalizePhone(phone) {
  const raw = String(phone || "").replace(/[\s()-]/g, "");
  if (raw.startsWith("+62")) return `0${raw.slice(3)}`;
  if (raw.startsWith("62")) return `0${raw.slice(2)}`;
  return raw;
}

export function detectOperator(phone) {
  const normalized = normalizePhone(phone);
  return Object.entries(operatorPrefixes).find(([, prefixes]) => prefixes.some((prefix) => normalized.startsWith(prefix)))?.[0] || null;
}

export function findProduct(productId) {
  return catalog.find((item) => item.id === productId);
}

function rfc3986(value) {
  return encodeURIComponent(String(value ?? "")).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sortedQuery(params = {}) {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`)
    .join("&");
}

function signRequest(method, pathname, query, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const canonical = [method.toUpperCase(), pathname, query, timestamp, nonce, bodyHash].join("\n");
  const secret = process.env.SUPPLIER_API_SECRET;
  if (!secret) throw new Error("SUPPLIER_API_SECRET 未配置");
  const signature = crypto.createHmac("sha256", secret).update(canonical).digest("hex");
  return { timestamp, nonce, signature };
}

export async function supplierRequest(method, pathname, queryParams = {}, payload) {
  const timeoutMs = Number(process.env.SUPPLIER_TIMEOUT_MS || 10000);
  const supplierBaseUrl = process.env.SUPPLIER_API_BASE_URL || "https://api.reloadn.com";
  const query = sortedQuery(queryParams);
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const signature = signRequest(method, pathname, query, body);
  const url = `${supplierBaseUrl.replace(/\/$/, "")}${pathname}${query ? `?${query}` : ""}`;
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
      "X-Api-Key": process.env.SUPPLIER_API_KEY || "",
      "X-Timestamp": signature.timestamp,
      "X-Nonce": signature.nonce,
      "X-Signature": signature.signature
    },
    body: payload === undefined ? undefined : body,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    const error = new Error(`Supplier API ${response.status}`);
    error.status = response.status;
    error.code = String(data?.code || data?.error_code || "SUPPLIER_API_ERROR");
    error.details = data;
    throw error;
  }
  return data;
}

export async function listSupplierProducts() {
  return supplierRequest("GET", "/v1/products", { type: "topup" });
}

/**
 * Keep every order operation on the same API version/path.  ReloadN accounts
 * may be migrated from /v1/orders to /v2/orders, so create and query must not
 * each carry their own hard-coded path.
 */
export function supplierOrderPath(env = process.env) {
  const raw = String(env?.SUPPLIER_ORDER_PATH || "/v1/orders").trim();
  if (!raw) throw new Error("SUPPLIER_ORDER_PATH 不能为空");
  if (/^https?:\/\//i.test(raw) || raw.includes("?") || raw.includes("#")) {
    throw new Error("SUPPLIER_ORDER_PATH 只能填写 API 路径，例如 /v2/orders");
  }
  const pathname = `/${raw.replace(/^\/+|\/+$/g, "")}`;
  if (pathname === "/") throw new Error("SUPPLIER_ORDER_PATH 不能为空");
  return pathname;
}

function supplierProductItems(response) {
  const candidates = [
    response?.data?.items,
    response?.data?.products,
    response?.items,
    response?.products,
    Array.isArray(response?.data) ? response.data : null,
    Array.isArray(response) ? response : null
  ];
  return candidates.find(Array.isArray) || [];
}

function paginationContainers(response) {
  return [
    response?.data?.pagination,
    response?.data?.paging,
    response?.data?.page_info,
    response?.data?.pageInfo,
    response?.data?.meta,
    response?.data,
    response?.pagination,
    response?.paging,
    response?.page_info,
    response?.pageInfo,
    response?.meta,
    response
  ].filter((value) => value && typeof value === "object" && !Array.isArray(value));
}

function paginationField(response, names) {
  for (const container of paginationContainers(response)) {
    for (const name of names) {
      if (Object.hasOwn(container, name)) return { known: true, name, value: container[name] };
    }
  }
  return { known: false, name: "", value: undefined };
}

function paginationNextLink(response) {
  const linkContainers = [
    response?.data?.pagination?.links,
    response?.data?.paging?.links,
    response?.data?.meta?.links,
    response?.data?.links,
    response?.pagination?.links,
    response?.paging?.links,
    response?.meta?.links,
    response?.links
  ].filter((value) => value && typeof value === "object" && !Array.isArray(value));
  for (const container of linkContainers) {
    if (Object.hasOwn(container, "next")) return { known: true, value: container.next };
  }
  return paginationField(response, ["next_url", "nextUrl", "next_link", "nextLink"]);
}

function positiveInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function truthyPaginationFlag(field) {
  const value = typeof field.value === "string" ? field.value.trim().toLowerCase() : field.value;
  if ([true, 1, "1", "true", "yes"].includes(value)) return true;
  if ([false, 0, "0", "false", "no"].includes(value)) return false;
  return null;
}

function paginationScopeQuery(currentQuery) {
  const query = { ...currentQuery };
  for (const key of ["cursor", "token", "page_token", "pageToken", "page", "offset"]) delete query[key];
  return query;
}

function queryFromNextLink(field, pathname) {
  if (!field.known || field.value === null || field.value === undefined || field.value === "") return null;
  const raw = typeof field.value === "object"
    ? field.value.href || field.value.url || field.value.uri
    : field.value;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const url = new URL(raw, `https://pagination.invalid${pathname}`);
  if (url.pathname !== pathname) throw new Error(`供应商商品下一页链接路径异常（${url.pathname}）`);
  return Object.fromEntries(url.searchParams.entries());
}

function supplierPagination(response, currentQuery, pathname = "/v1/products") {
  const cursorField = paginationField(response, ["next_cursor", "nextCursor"]);
  const tokenField = paginationField(response, ["next_page_token", "nextPageToken", "next_token", "nextToken"]);
  const nextPageField = paginationField(response, ["next_page", "nextPage"]);
  const currentPageField = paginationField(response, ["current_page", "currentPage", "page"]);
  const lastPageField = paginationField(response, ["last_page", "lastPage", "total_pages", "totalPages", "page_count", "pageCount", "pages"]);
  const nextOffsetField = paginationField(response, ["next_offset", "nextOffset"]);
  const offsetField = paginationField(response, ["offset", "current_offset", "currentOffset"]);
  const limitField = paginationField(response, ["limit", "per_page", "perPage", "page_size", "pageSize"]);
  const nextLinkField = paginationNextLink(response);
  const hasMoreField = paginationField(response, ["has_more", "hasMore"]);
  const totalField = paginationField(response, ["total", "total_count", "totalCount"]);
  const cursor = cursorField.value === null || cursorField.value === undefined || cursorField.value === ""
    ? ""
    : String(cursorField.value);
  const token = tokenField.value === null || tokenField.value === undefined || tokenField.value === ""
    ? ""
    : String(tokenField.value);
  const hasMore = truthyPaginationFlag(hasMoreField);
  const total = totalField.known ? positiveInteger(totalField.value) : null;
  const scope = paginationScopeQuery(currentQuery);
  let nextQuery = null;
  let strategy = "unknown";

  const linkedQuery = queryFromNextLink(nextLinkField, pathname);
  if (hasMore !== false) {
    if (linkedQuery) {
      nextQuery = { ...scope, ...linkedQuery };
      strategy = "link";
    } else if (cursor) {
      nextQuery = { ...scope, cursor };
      strategy = "cursor";
    } else if (token) {
      const tokenQueryKey = tokenField.name === "nextPageToken"
        ? "pageToken"
        : tokenField.name === "next_page_token"
          ? "page_token"
          : "token";
      nextQuery = { ...scope, [tokenQueryKey]: token };
      strategy = "token";
    } else {
      const nextPage = positiveInteger(nextPageField.value);
      const currentPage = positiveInteger(currentPageField.value);
      const lastPage = positiveInteger(lastPageField.value);
      const limit = positiveInteger(limitField.value);
      const morePagesByTotal = currentPage !== null && limit && total !== null && currentPage * limit < total;
      if (nextPage !== null) {
        nextQuery = { ...scope, page: nextPage };
        strategy = "page";
      } else if (currentPage !== null && ((lastPage !== null && currentPage < lastPage) || (lastPage === null && (hasMore === true || morePagesByTotal)))) {
        nextQuery = { ...scope, page: currentPage + 1 };
        strategy = "page";
      } else {
        const nextOffset = positiveInteger(nextOffsetField.value);
        const currentOffset = positiveInteger(offsetField.value);
        const moreOffsetsByTotal = currentOffset !== null && limit && total !== null && currentOffset + limit < total;
        if (nextOffset !== null) {
          nextQuery = { ...scope, offset: nextOffset };
          strategy = "offset";
        } else if (currentOffset !== null && limit && (hasMore === true || moreOffsetsByTotal)) {
          nextQuery = { ...scope, offset: currentOffset + limit };
          strategy = "offset";
        }
      }
    }
  }

  const terminalMarker = (nextLinkField.known && !linkedQuery)
    || (cursorField.known && !cursor)
    || (tokenField.known && !token)
    || (nextPageField.known && positiveInteger(nextPageField.value) === null)
    || (lastPageField.known
      && positiveInteger(currentPageField.value) !== null
      && positiveInteger(lastPageField.value) !== null
      && positiveInteger(currentPageField.value) >= positiveInteger(lastPageField.value));
  return {
    nextQuery,
    strategy,
    hasMore,
    hasMoreKnown: hasMoreField.known && hasMore !== null,
    total,
    terminalMarker
  };
}

/**
 * ReloadN may return a cursor when the catalogue is large. Keep following that
 * cursor so the management console does not silently stop at the first page.
 * The documented ReloadN catalogue is `type=topup`. Other explicit types can
 * be configured as a comma-separated list. `all`/`*` deliberately omits the
 * type filter, but should only be used when ReloadN has enabled that behaviour
 * for the merchant account.
 */
export async function listAllSupplierProducts({ request = supplierRequest } = {}) {
  const types = [...new Set(String(process.env.SUPPLIER_PRODUCT_TYPES || "topup")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean))];
  const bySku = new Map();
  let pages = 0;
  const pagination = [];

  if (!types.length) throw new Error("SUPPLIER_PRODUCT_TYPES 不能为空");

  for (const type of types) {
    const wildcardType = ["all", "*"].includes(type.toLowerCase());
    let query = wildcardType ? {} : { type };
    let fetched = 0;
    let expectedTotal = null;
    let complete = false;
    const seenQueries = new Set();
    const strategies = new Set();
    const typeSkus = new Set();
    for (let page = 0; page < 100; page += 1) {
      const queryKey = sortedQuery(query);
      if (seenQueries.has(queryKey)) throw new Error(`供应商商品分页参数循环（type=${type}）`);
      seenQueries.add(queryKey);
      const response = await request("GET", "/v1/products", query);
      pages += 1;
      const items = supplierProductItems(response);
      for (const item of items) {
        const sku = String(item?.sku || item?.code || item?.product_code || item?.id || "");
        if (sku) {
          typeSkus.add(sku);
          bySku.set(sku, item);
        }
      }
      fetched = typeSkus.size;
      const pageInfo = supplierPagination(response, query);
      if (pageInfo.strategy !== "unknown") strategies.add(pageInfo.strategy);
      if (pageInfo.total !== null) expectedTotal = pageInfo.total;
      if (!pageInfo.nextQuery) {
        if (pageInfo.hasMoreKnown && pageInfo.hasMore === true) {
          throw new Error(`供应商提示仍有下一页，但未返回可识别的分页参数（type=${type}）`);
        } else {
          const explicitlyFinished = (pageInfo.hasMoreKnown && pageInfo.hasMore === false)
            || pageInfo.terminalMarker;
          complete = expectedTotal !== null ? fetched >= expectedTotal : explicitlyFinished;
        }
        break;
      }
      if (!wildcardType) {
        const linkedType = pageInfo.nextQuery.type;
        if (linkedType !== undefined && String(linkedType) !== type) {
          throw new Error(`供应商商品下一页链接改变了查询类型（${type} → ${linkedType}）`);
        }
        pageInfo.nextQuery.type = type;
      }
      if (page === 99) throw new Error(`供应商商品超过 100 页，已停止同步（type=${type}）`);
      query = pageInfo.nextQuery;
    }
    pagination.push({ type, fetched, expectedTotal, complete, strategies: [...strategies] });
  }

  if (!bySku.size) throw new Error("供应商返回的商品目录为空，已保留现有商品数据");
  return { items: [...bySku.values()], pages, types, complete: pagination.every((entry) => entry.complete), pagination };
}

function supplierOrderIdentifier(order) {
  return String(order?.order_id || order?.orderId || order?.id || "").trim();
}

function supplierClientOrderIdentifier(order) {
  return String(order?.client_order_id || order?.clientOrderId || order?.merchant_order_id || order?.merchantOrderId || "").trim();
}

function looksLikeSupplierOrder(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Boolean(
    supplierOrderIdentifier(value)
    || supplierClientOrderIdentifier(value)
    || Object.hasOwn(value, "status")
    || Object.hasOwn(value, "order_status")
  );
}

function supplierOrderCandidates(response) {
  const direct = [
    response?.data?.order,
    response?.order,
    response?.data?.data?.order,
    response?.data?.data,
    response?.data,
    response
  ].filter(looksLikeSupplierOrder);
  const arrays = [
    response?.data?.items,
    response?.data?.orders,
    response?.data?.data?.items,
    response?.data?.data?.orders,
    response?.items,
    response?.orders,
    Array.isArray(response?.data) ? response.data : null,
    Array.isArray(response) ? response : null
  ].filter(Array.isArray);
  return [...direct, ...arrays.flat().filter(looksLikeSupplierOrder)];
}

/**
 * Extract one order from either the single-order or list response shape.
 * When an identifier is supplied this is intentionally strict: returning the
 * first unrelated list item would update the wrong local order.
 */
export function extractSupplierOrder(response, { providerOrderId = "", clientOrderId = "" } = {}) {
  const candidates = supplierOrderCandidates(response);
  const wantedProviderId = String(providerOrderId || "").trim();
  const wantedClientId = String(clientOrderId || "").trim();
  if (wantedProviderId) {
    const matched = candidates.find((order) => supplierOrderIdentifier(order) === wantedProviderId);
    if (matched) return matched;
  }
  if (wantedClientId) {
    const matched = candidates.find((order) => supplierClientOrderIdentifier(order) === wantedClientId);
    if (matched) return matched;
  }
  return wantedProviderId || wantedClientId ? null : candidates[0] || null;
}

export class SupplierOrderNotFoundError extends Error {
  constructor({ clientOrderId = "", providerOrderId = "", lookup = "query" } = {}) {
    const identifiers = [
      providerOrderId ? `providerOrderId=${providerOrderId}` : "",
      clientOrderId ? `clientOrderId=${clientOrderId}` : ""
    ].filter(Boolean).join(", ");
    super(`供应商响应中未找到匹配订单${identifiers ? `（${identifiers}）` : ""}`);
    this.name = "SupplierOrderNotFoundError";
    this.code = "SUPPLIER_ORDER_NOT_FOUND";
    this.status = 404;
    this.details = { code: this.code, clientOrderId, providerOrderId, lookup };
  }
}

function hasSupplierCredentials(request) {
  return request !== supplierRequest || Boolean(process.env.SUPPLIER_API_KEY && process.env.SUPPLIER_API_SECRET);
}

function shouldFallBackToClientLookup(error) {
  const status = Number(error?.status || String(error?.message || "").match(/Supplier API (\d+)/)?.[1]);
  return [400, 404, 405].includes(status) || error instanceof SupplierOrderNotFoundError;
}

/** Create an idempotent ReloadN order after payment has succeeded. */
export async function createSupplierOrder({ order, product }, options = {}) {
  const request = options.request || supplierRequest;
  const orderPath = options.orderPath || supplierOrderPath();
  if (!hasSupplierCredentials(request)) {
    return { mode: "demo", status: "pending_provider", message: "供应商 API 尚未配置" };
  }
  const local = normalizePhone(order.phone);
  const dest = `0062${local.startsWith("0") ? local.slice(1) : local}`;
  const data = await request("POST", orderPath, {}, {
    client_order_id: order.id,
    sku: product.sku || product.id,
    dest
  });
  const providerOrder = extractSupplierOrder(data, { clientOrderId: order.id });
  if (!providerOrder) throw new SupplierOrderNotFoundError({ clientOrderId: order.id, lookup: "create" });
  return { mode: "live", status: providerOrder.status || providerOrder.order_status || "processing", order: providerOrder, data };
}

/**
 * Query the current ReloadN order state without creating a second order.
 * Prefer the immutable provider order id.  Older API deployments that do not
 * expose the detail endpoint fall back to the idempotent client_order_id list
 * query on the exact same configured order path.
 */
export async function querySupplierOrder(clientOrderId, providerOrderId = "", options = {}) {
  if (providerOrderId && typeof providerOrderId === "object") {
    options = providerOrderId;
    providerOrderId = options.providerOrderId || "";
  }
  const request = options.request || supplierRequest;
  const orderPath = options.orderPath || supplierOrderPath();
  if (!hasSupplierCredentials(request)) {
    return { mode: "demo", status: "pending_provider", message: "供应商 API 尚未配置" };
  }
  const wantedClientId = String(clientOrderId || "").trim();
  const wantedProviderId = String(providerOrderId || "").trim();
  if (!wantedClientId && !wantedProviderId) throw new Error("查询供应商订单至少需要一个订单号");

  if (wantedProviderId) {
    try {
      const data = await request("GET", `${orderPath}/${rfc3986(wantedProviderId)}`, {});
      const order = extractSupplierOrder(data, { providerOrderId: wantedProviderId });
      if (order) {
        return {
          mode: "live",
          status: order.status || order.order_status || "processing",
          order,
          data,
          lookup: "provider_order_id"
        };
      }
      if (!wantedClientId) throw new SupplierOrderNotFoundError({ providerOrderId: wantedProviderId, lookup: "provider_order_id" });
    } catch (error) {
      if (!wantedClientId || !shouldFallBackToClientLookup(error)) throw error;
    }
  }

  const data = await request("GET", orderPath, { client_order_id: wantedClientId });
  const order = extractSupplierOrder(data, { clientOrderId: wantedClientId, providerOrderId: wantedProviderId });
  if (!order) {
    throw new SupplierOrderNotFoundError({
      clientOrderId: wantedClientId,
      providerOrderId: wantedProviderId,
      lookup: "client_order_id"
    });
  }
  return {
    mode: "live",
    status: order.status || order.order_status || "processing",
    order,
    data,
    lookup: "client_order_id"
  };
}

export function verifyWebhookSignature(rawBody, headers) {
  const secret = process.env.SUPPLIER_WEBHOOK_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  const timestamp = String(headers["x-webhook-timestamp"] || "");
  const webhookId = String(headers["x-webhook-id"] || "");
  const environment = String(headers["x-webhook-environment"] || "");
  const keyVersion = String(headers["x-webhook-key-version"] || "");
  const signature = String(headers["x-webhook-signature"] || "");
  if (!timestamp || !webhookId || !environment || !keyVersion || !signature) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const stringToSign = [timestamp, webhookId, environment, keyVersion, bodyHash].join("\n");
  const expected = `v1=${crypto.createHmac("sha256", secret).update(stringToSign).digest("hex")}`;
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && crypto.timingSafeEqual(wanted, actual);
}
