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
    error.details = data;
    throw error;
  }
  return data;
}

export async function listSupplierProducts() {
  return supplierRequest("GET", "/v1/products", { type: "topup" });
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
    response?.data?.meta,
    response?.data,
    response?.pagination,
    response?.meta,
    response
  ].filter((value) => value && typeof value === "object" && !Array.isArray(value));
}

function paginationField(response, names) {
  for (const container of paginationContainers(response)) {
    for (const name of names) {
      if (Object.hasOwn(container, name)) return { known: true, value: container[name] };
    }
  }
  return { known: false, value: undefined };
}

function supplierPagination(response) {
  const cursorField = paginationField(response, ["next_cursor", "nextCursor"]);
  const hasMoreField = paginationField(response, ["has_more", "hasMore"]);
  const totalField = paginationField(response, ["total", "total_count", "totalCount"]);
  const cursor = cursorField.value === null || cursorField.value === undefined || cursorField.value === ""
    ? ""
    : String(cursorField.value);
  const normalizedHasMore = typeof hasMoreField.value === "string" ? hasMoreField.value.trim().toLowerCase() : hasMoreField.value;
  const hasMore = [true, 1, "1", "true", "yes"].includes(normalizedHasMore)
    ? true
    : [false, 0, "0", "false", "no"].includes(normalizedHasMore)
      ? false
      : null;
  const parsedTotal = Number(totalField.value);
  const total = totalField.known && Number.isInteger(parsedTotal) && parsedTotal >= 0 ? parsedTotal : null;
  return {
    cursor,
    cursorKnown: cursorField.known,
    hasMore,
    hasMoreKnown: hasMoreField.known && hasMore !== null,
    total
  };
}

/**
 * ReloadN may return a cursor when the catalogue is large. Keep following that
 * cursor so the management console does not silently stop at the first page.
 * Additional official product types can be configured without changing code,
 * for example SUPPLIER_PRODUCT_TYPES=topup,data.
 */
export async function listAllSupplierProducts() {
  const types = [...new Set(String(process.env.SUPPLIER_PRODUCT_TYPES || "topup")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean))];
  const bySku = new Map();
  let pages = 0;
  const pagination = [];

  if (!types.length) throw new Error("SUPPLIER_PRODUCT_TYPES 不能为空");

  for (const type of types) {
    let cursor = "";
    let fetched = 0;
    let expectedTotal = null;
    let complete = false;
    const seenCursors = new Set();
    for (let page = 0; page < 100; page += 1) {
      const query = { type, ...(cursor ? { cursor } : {}) };
      const response = await supplierRequest("GET", "/v1/products", query);
      pages += 1;
      const items = supplierProductItems(response);
      fetched += items.length;
      for (const item of items) {
        const sku = String(item?.sku || item?.code || item?.product_code || item?.id || "");
        if (sku) bySku.set(sku, item);
      }
      const pageInfo = supplierPagination(response);
      if (pageInfo.total !== null) expectedTotal = pageInfo.total;
      if (!pageInfo.cursor) {
        if (pageInfo.hasMoreKnown && pageInfo.hasMore === true) {
          complete = false;
        } else {
          const explicitlyFinished = (pageInfo.hasMoreKnown && pageInfo.hasMore === false)
            || (pageInfo.cursorKnown && (!pageInfo.hasMoreKnown || pageInfo.hasMore === false));
          complete = expectedTotal !== null ? fetched >= expectedTotal : explicitlyFinished;
        }
        break;
      }
      if (seenCursors.has(pageInfo.cursor)) throw new Error(`供应商商品分页游标循环（type=${type}）`);
      if (page === 99) throw new Error(`供应商商品超过 100 页，已停止同步（type=${type}）`);
      seenCursors.add(pageInfo.cursor);
      cursor = pageInfo.cursor;
    }
    pagination.push({ type, fetched, expectedTotal, complete });
  }

  if (!bySku.size) throw new Error("供应商返回的商品目录为空，已保留现有商品数据");
  return { items: [...bySku.values()], pages, types, complete: pagination.every((entry) => entry.complete), pagination };
}

/** Create an idempotent ReloadN v1 order after payment has succeeded. */
export async function createSupplierOrder({ order, product }) {
  if (!process.env.SUPPLIER_API_KEY || !process.env.SUPPLIER_API_SECRET) {
    return { mode: "demo", status: "pending_provider", message: "供应商 API 尚未配置" };
  }
  const local = normalizePhone(order.phone);
  const dest = `0062${local.startsWith("0") ? local.slice(1) : local}`;
  const data = await supplierRequest("POST", process.env.SUPPLIER_ORDER_PATH || "/v1/orders", {}, {
    client_order_id: order.id,
    sku: product.sku || product.id,
    dest
  });
  return { mode: "live", status: data?.data?.order?.status || "processing", data };
}

/** Query the current ReloadN order state without creating a second order. */
export async function querySupplierOrder(clientOrderId) {
  if (!process.env.SUPPLIER_API_KEY || !process.env.SUPPLIER_API_SECRET) {
    return { mode: "demo", status: "processing", message: "供应商 API 尚未配置" };
  }
  const data = await supplierRequest("GET", "/v1/orders", { client_order_id: clientOrderId });
  const order = data?.data?.order
    || data?.data?.items?.[0]
    || data?.data?.orders?.[0]
    || data?.order
    || data?.items?.[0]
    || null;
  return { mode: "live", status: order?.status || "processing", data };
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
