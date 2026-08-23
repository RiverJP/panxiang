const SUCCESS_SUPPLIER_STATUSES = new Set([
  "success",
  "successful",
  "completed",
  "complete",
  "delivered",
  "fulfilled"
]);

const FAILED_SUPPLIER_STATUSES = new Set([
  "failed",
  "failure",
  "cancelled",
  "canceled",
  "rejected",
  "error",
  "expired"
]);

const REFUNDED_SUPPLIER_STATUSES = new Set([
  "refunded",
  "refund",
  "reversed"
]);

export const ACTIVE_RECHARGE_STATUSES = Object.freeze([
  "paid_pending_recharge",
  "recharge_processing"
]);

export function normalizeSupplierOrderStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/** Map ReloadN/upstream status names onto the local customer-facing states. */
export function supplierStatusToLocal(status) {
  const normalized = normalizeSupplierOrderStatus(status);
  if (SUCCESS_SUPPLIER_STATUSES.has(normalized)) return "recharge_success";
  if (FAILED_SUPPLIER_STATUSES.has(normalized) || REFUNDED_SUPPLIER_STATUSES.has(normalized)) return "refund_required";
  return "recharge_processing";
}

export function isActiveRechargeStatus(status) {
  return ACTIVE_RECHARGE_STATUSES.includes(String(status || ""));
}

/**
 * Normal processing is not an error, but it still needs progressively slower
 * polling so an upstream backlog cannot create a request storm.
 */
export function processingPollDelayMs(pollCount, { baseMs = 15_000, maxMs = 120_000 } = {}) {
  const safeBase = Number.isFinite(Number(baseMs)) && Number(baseMs) > 0 ? Number(baseMs) : 15_000;
  const safeMax = Number.isFinite(Number(maxMs)) && Number(maxMs) >= safeBase ? Number(maxMs) : 120_000;
  const count = Math.max(0, Math.min(20, Math.trunc(Number(pollCount) || 0)));
  return Math.min(safeMax, safeBase * (2 ** count));
}

export function nextProcessingPollAt(pollCount, { now = Date.now(), baseMs, maxMs } = {}) {
  const timestamp = Number(now);
  if (!Number.isFinite(timestamp)) throw new TypeError("now 必须是有效时间戳");
  return new Date(timestamp + processingPollDelayMs(pollCount, { baseMs, maxMs })).toISOString();
}

/**
 * Used by customer/admin GET endpoints before actively querying ReloadN.
 * Both page-triggered and background refreshes respect the provider backoff in
 * `nextRetryAt`; the short checked-at throttle also prevents parallel page
 * refreshes from hammering the provider.
 */
export function shouldActivelyRefreshOrder(order, {
  now = Date.now(),
  minIntervalMs = 10_000,
  maxFutureSkewMs = 300_000
} = {}) {
  if (!order || !isActiveRechargeStatus(order.status)) return false;
  const nextRetryTimestamp = Date.parse(order.nextRetryAt || "");
  const timestamp = Number(now);
  if (Number.isFinite(nextRetryTimestamp) && Number.isFinite(timestamp) && nextRetryTimestamp > timestamp) return false;
  const checkedAt = order.providerCheckedAt || order.lastProviderCheckedAt;
  if (!checkedAt) return true;
  const checkedTimestamp = Date.parse(checkedAt);
  if (!Number.isFinite(checkedTimestamp)) return true;
  if (!Number.isFinite(timestamp)) return true;
  if (checkedTimestamp - timestamp > maxFutureSkewMs) return true;
  return timestamp - checkedTimestamp >= Math.max(0, Number(minIntervalMs) || 0);
}
