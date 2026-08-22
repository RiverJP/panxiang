import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultDataDir = path.resolve(moduleDir, "../data");
const migrationKey = "legacy-orders-json-v1";
const maxJsonBytes = 2 * 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function nullableText(value, maxLength = 255) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength) throw new RangeError(`字段长度不能超过 ${maxLength}`);
  return text;
}

function requiredText(value, label, maxLength = 255) {
  const text = nullableText(value, maxLength);
  if (!text) throw new TypeError(`${label}不能为空`);
  return text;
}

function encodeJson(value, label = "JSON") {
  let encoded;
  try {
    encoded = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
  } catch (error) {
    throw new TypeError(`${label}无法序列化: ${error.message}`);
  }
  if (encoded === undefined) throw new TypeError(`${label}无法序列化`);
  if (Buffer.byteLength(encoded, "utf8") > maxJsonBytes) throw new RangeError(`${label}不能超过 ${maxJsonBytes} 字节`);
  return encoded;
}

function decodeJson(value, label = "数据库 JSON") {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label}已损坏: ${error.message}`);
  }
}

function outTradeNoOf(order) {
  return requiredText(order?.id ?? order?.outTradeNo ?? order?.out_trade_no, "订单号", 128);
}

function transactionIdOf(order) {
  return nullableText(order?.transactionId ?? order?.transaction_id ?? order?.payment?.transaction_id, 128);
}

function providerOrderIdOf(order) {
  return nullableText(
    order?.providerOrderId
      ?? order?.provider_order_id
      ?? order?.provider?.order_id
      ?? order?.provider?.data?.order?.order_id
      ?? order?.provider?.data?.data?.order?.order_id,
    128
  );
}

function orderVersionOf(order) {
  const value = Number(order?.orderVersion ?? order?.order_version ?? order?.provider?.order_version ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("order_version必须是非负安全整数");
  return value;
}

function canonicalOrder(order, existing = null) {
  if (!order || typeof order !== "object" || Array.isArray(order)) throw new TypeError("订单必须是对象");
  const outTradeNo = outTradeNoOf(order);
  const createdAt = nullableText(order.createdAt ?? order.created_at ?? existing?.createdAt, 64) || nowIso();
  const updatedAt = nullableText(order.updatedAt ?? order.updated_at, 64) || nowIso();
  const status = requiredText(order.status ?? existing?.status ?? "created", "订单状态", 64);
  const normalized = {
    ...order,
    id: outTradeNo,
    status,
    createdAt,
    updatedAt
  };
  delete normalized.outTradeNo;
  delete normalized.out_trade_no;
  const transactionId = transactionIdOf(normalized);
  const providerOrderId = providerOrderIdOf(normalized);
  const orderVersion = orderVersionOf(normalized);
  if (transactionId) normalized.transactionId = transactionId;
  else delete normalized.transactionId;
  if (providerOrderId) normalized.providerOrderId = providerOrderId;
  else delete normalized.providerOrderId;
  normalized.orderVersion = orderVersion;
  return { outTradeNo, transactionId, providerOrderId, orderVersion, status, createdAt, updatedAt, order: normalized };
}

function rowToOrder(row) {
  if (!row) return null;
  const order = decodeJson(row.data_json, `订单 ${row.out_trade_no} JSON`);
  order.id = row.out_trade_no;
  order.status = row.status;
  order.createdAt = row.created_at;
  order.updatedAt = row.updated_at;
  order.orderVersion = Number(row.order_version || 0);
  if (row.transaction_id) order.transactionId = row.transaction_id;
  else delete order.transactionId;
  if (row.provider_order_id) order.providerOrderId = row.provider_order_id;
  else delete order.providerOrderId;
  return order;
}

function rowToWebhook(row) {
  if (!row) return null;
  return {
    webhookId: row.webhook_id,
    outTradeNo: row.out_trade_no,
    providerOrderId: row.provider_order_id,
    orderVersion: row.order_version === null ? null : Number(row.order_version),
    eventType: row.event_type,
    outcome: row.outcome,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    payload: decodeJson(row.payload_json, `Webhook ${row.webhook_id} JSON`)
  };
}

export class OrderStore {
  constructor(options = {}) {
    this.dbPath = path.resolve(options.dbPath || path.join(defaultDataDir, "orders.sqlite"));
    this.legacyJsonPath = path.resolve(options.legacyJsonPath || path.join(defaultDataDir, "orders.json"));
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.initialized = false;
    this.inTransaction = false;
  }

  init({ migrateLegacy = true } = {}) {
    if (this.initialized) return this;
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS orders (
        out_trade_no TEXT PRIMARY KEY,
        transaction_id TEXT UNIQUE,
        provider_order_id TEXT,
        status TEXT NOT NULL,
        order_version INTEGER NOT NULL DEFAULT 0 CHECK (order_version >= 0),
        data_json TEXT NOT NULL CHECK (json_valid(data_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_orders_provider_order_id ON orders(provider_order_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON orders(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);

      CREATE TABLE IF NOT EXISTS provider_webhooks (
        webhook_id TEXT PRIMARY KEY,
        out_trade_no TEXT,
        provider_order_id TEXT,
        order_version INTEGER CHECK (order_version IS NULL OR order_version >= 0),
        event_type TEXT,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        outcome TEXT NOT NULL,
        received_at TEXT NOT NULL,
        processed_at TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_provider_webhooks_order ON provider_webhooks(out_trade_no);
      CREATE INDEX IF NOT EXISTS idx_provider_webhooks_provider_order ON provider_webhooks(provider_order_id);
      CREATE INDEX IF NOT EXISTS idx_provider_webhooks_received_at ON provider_webhooks(received_at DESC);
    `);
    this.initialized = true;
    if (migrateLegacy) this.migrateLegacyJson();
    return this;
  }

  close() {
    this.db.close();
    this.initialized = false;
  }

  transaction(work) {
    this.#assertInitialized();
    if (this.inTransaction) return work();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = work();
      if (result && typeof result.then === "function") throw new TypeError("SQLite事务回调必须是同步函数");
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  migrateLegacyJson(file = this.legacyJsonPath) {
    this.#assertInitialized();
    const migration = this.db.prepare("SELECT value_json FROM store_meta WHERE key = ?").get(migrationKey);
    if (migration) return { ...decodeJson(migration.value_json, "迁移记录"), migrated: false };

    const sourceExists = fs.existsSync(file);
    let legacyOrders = [];
    if (sourceExists) {
      const source = fs.readFileSync(file, "utf8");
      const parsed = decodeJson(source, `旧订单文件 ${file}`);
      if (!Array.isArray(parsed)) throw new TypeError("旧 orders.json 必须是订单数组");
      legacyOrders = parsed;
    }

    return this.transaction(() => {
      let inserted = 0;
      for (const legacyOrder of legacyOrders) {
        const normalized = canonicalOrder(legacyOrder);
        const result = this.#insertNormalized(normalized, true);
        inserted += Number(result.changes || 0);
      }
      const result = { migrated: true, sourceExists, source: file, found: legacyOrders.length, inserted, at: nowIso() };
      this.db.prepare(`
        INSERT INTO store_meta (key, value_json, updated_at)
        VALUES (?, ?, ?)
      `).run(migrationKey, encodeJson(result, "迁移记录"), result.at);
      return result;
    });
  }

  createOrder(order) {
    this.#assertInitialized();
    const normalized = canonicalOrder(order);
    this.#insertNormalized(normalized, false);
    return this.getOrder(normalized.outTradeNo);
  }

  getOrder(outTradeNo) {
    this.#assertInitialized();
    const id = requiredText(outTradeNo, "订单号", 128);
    return rowToOrder(this.db.prepare("SELECT * FROM orders WHERE out_trade_no = ?").get(id));
  }

  getOrderByTransactionId(transactionId) {
    this.#assertInitialized();
    const id = requiredText(transactionId, "微信支付流水号", 128);
    return rowToOrder(this.db.prepare("SELECT * FROM orders WHERE transaction_id = ?").get(id));
  }

  getOrderByProviderOrderId(providerOrderId) {
    this.#assertInitialized();
    const id = requiredText(providerOrderId, "供应商订单号", 128);
    return rowToOrder(this.db.prepare("SELECT * FROM orders WHERE provider_order_id = ? ORDER BY created_at DESC LIMIT 1").get(id));
  }

  listOrders(options = {}) {
    this.#assertInitialized();
    const limit = Math.min(2000, Math.max(1, Math.floor(Number(options.limit) || 200)));
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const where = [];
    const parameters = [];
    if (options.status !== undefined && options.status !== null && options.status !== "") {
      where.push("status = ?");
      parameters.push(requiredText(options.status, "订单状态", 64));
    }
    if (options.providerOrderId !== undefined && options.providerOrderId !== null && options.providerOrderId !== "") {
      where.push("provider_order_id = ?");
      parameters.push(requiredText(options.providerOrderId, "供应商订单号", 128));
    }
    const sql = `SELECT * FROM orders${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    parameters.push(limit, offset);
    return this.db.prepare(sql).all(...parameters).map(rowToOrder);
  }

  updateOrder(outTradeNo, patch, options = {}) {
    this.#assertInitialized();
    const id = requiredText(outTradeNo, "订单号", 128);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("订单更新内容必须是对象");
    const expectedStatuses = options.expectedStatuses === undefined
      ? null
      : new Set((Array.isArray(options.expectedStatuses) ? options.expectedStatuses : [options.expectedStatuses]).map(String));

    return this.transaction(() => {
      const existing = this.getOrder(id);
      if (!existing) return { updated: false, reason: "not_found", order: null };
      if (expectedStatuses && !expectedStatuses.has(existing.status)) return { updated: false, reason: "status_mismatch", order: existing };
      const merged = { ...existing, ...patch, id, createdAt: existing.createdAt, updatedAt: patch.updatedAt || nowIso() };
      const normalized = canonicalOrder(merged, existing);
      this.#updateNormalized(normalized);
      return { updated: true, reason: "updated", order: this.getOrder(id) };
    });
  }

  getWebhook(webhookId) {
    this.#assertInitialized();
    const id = requiredText(webhookId, "Webhook ID", 255);
    return rowToWebhook(this.db.prepare("SELECT * FROM provider_webhooks WHERE webhook_id = ?").get(id));
  }

  /**
   * Atomically records one ReloadN webhook and applies it only when its
   * order_version is newer than the version already stored on the order.
   */
  applyProviderWebhook(input) {
    this.#assertInitialized();
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Webhook内容必须是对象");
    const webhookId = requiredText(input.webhookId, "Webhook ID", 255);
    const suppliedOutTradeNo = nullableText(input.outTradeNo ?? input.orderId ?? input.clientOrderId, 128);
    const providerOrderId = nullableText(input.providerOrderId, 128);
    const eventType = nullableText(input.eventType, 128);
    const receivedAt = nullableText(input.receivedAt, 64) || nowIso();
    const payload = input.payload ?? {};
    const payloadJson = encodeJson(payload, "Webhook payload");
    const rawVersion = input.orderVersion;
    const orderVersion = rawVersion === null || rawVersion === undefined || rawVersion === "" ? null : Number(rawVersion);
    if (orderVersion !== null && (!Number.isSafeInteger(orderVersion) || orderVersion < 0)) throw new TypeError("Webhook order_version必须是非负安全整数");

    return this.transaction(() => {
      const duplicate = this.getWebhook(webhookId);
      if (duplicate) return { applied: false, reason: "duplicate", webhook: duplicate, order: duplicate.outTradeNo ? this.getOrder(duplicate.outTradeNo) : null };

      const orderByTradeNo = suppliedOutTradeNo ? this.getOrder(suppliedOutTradeNo) : null;
      const orderByProviderId = providerOrderId ? this.getOrderByProviderOrderId(providerOrderId) : null;
      let order = orderByTradeNo || orderByProviderId;
      const resolvedOutTradeNo = order?.id || suppliedOutTradeNo;
      let outcome = "unmatched";
      let processedAt = null;
      const identityConflict = Boolean(
        (orderByTradeNo && orderByProviderId && orderByTradeNo.id !== orderByProviderId.id)
        || (orderByTradeNo?.providerOrderId && providerOrderId && orderByTradeNo.providerOrderId !== providerOrderId)
        || (suppliedOutTradeNo && orderByProviderId && suppliedOutTradeNo !== orderByProviderId.id)
      );

      if (identityConflict) {
        outcome = "identity_conflict";
        processedAt = nowIso();
      } else if (order) {
        if (orderVersion === null) throw new TypeError("订单类 Webhook 缺少 order_version");
        if (orderVersion <= Number(order.orderVersion || 0)) {
          outcome = "stale";
          processedAt = nowIso();
        } else {
          const requestedStatus = input.status ? requiredText(input.status, "Webhook订单状态", 64) : null;
          const protectedStatus = order.status === "refunded"
            || (order.status === "recharge_success" && requestedStatus && !["recharge_success", "refunded"].includes(requestedStatus))
            || (order.status === "refund_required" && requestedStatus === "recharge_processing")
            ? order.status
            : requestedStatus;
          const patch = {
            ...(input.patch && typeof input.patch === "object" && !Array.isArray(input.patch) ? input.patch : {}),
            ...(protectedStatus ? { status: protectedStatus } : {}),
            provider: payload,
            orderVersion,
            ...(providerOrderId ? { providerOrderId } : {}),
            updatedAt: nowIso()
          };
          const updated = this.updateOrder(order.id, patch);
          if (!updated.updated) throw new Error(`Webhook更新订单失败: ${updated.reason}`);
          order = updated.order;
          outcome = "applied";
          processedAt = nowIso();
        }
      }

      this.db.prepare(`
        INSERT INTO provider_webhooks (
          webhook_id, out_trade_no, provider_order_id, order_version,
          event_type, payload_json, outcome, received_at, processed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(webhookId, resolvedOutTradeNo, providerOrderId, orderVersion, eventType, payloadJson, outcome, receivedAt, processedAt);

      return { applied: outcome === "applied", reason: outcome, webhook: this.getWebhook(webhookId), order };
    });
  }

  #assertInitialized() {
    if (!this.initialized) throw new Error("OrderStore尚未初始化，请先调用 init()");
  }

  #insertNormalized(normalized, ignoreExisting) {
    const conflict = ignoreExisting ? "ON CONFLICT(out_trade_no) DO NOTHING" : "";
    return this.db.prepare(`
      INSERT INTO orders (
        out_trade_no, transaction_id, provider_order_id, status,
        order_version, data_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ${conflict}
    `).run(
      normalized.outTradeNo,
      normalized.transactionId,
      normalized.providerOrderId,
      normalized.status,
      normalized.orderVersion,
      encodeJson(normalized.order, `订单 ${normalized.outTradeNo}`),
      normalized.createdAt,
      normalized.updatedAt
    );
  }

  #updateNormalized(normalized) {
    const result = this.db.prepare(`
      UPDATE orders SET
        transaction_id = ?, provider_order_id = ?, status = ?,
        order_version = ?, data_json = ?, updated_at = ?
      WHERE out_trade_no = ?
    `).run(
      normalized.transactionId,
      normalized.providerOrderId,
      normalized.status,
      normalized.orderVersion,
      encodeJson(normalized.order, `订单 ${normalized.outTradeNo}`),
      normalized.updatedAt,
      normalized.outTradeNo
    );
    if (Number(result.changes || 0) !== 1) throw new Error(`订单 ${normalized.outTradeNo} 更新失败`);
  }
}

export function createOrderStore(options = {}) {
  return new OrderStore(options).init();
}
