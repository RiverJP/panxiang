import crypto from "node:crypto";

const timeoutMs = Number(process.env.SUPPLIER_TIMEOUT_MS || 10000);
const supplierBaseUrl = process.env.SUPPLIER_API_BASE_URL || "https://api.reloadn.com";

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

function sortedQuery(params = {}) {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value ?? "")}`)
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

/**
 * This adapter deliberately does not guess the supplier's payload/signature.
 * Update the body and response mapping after copying the official ReloadN API docs.
 */
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
