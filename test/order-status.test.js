import test from "node:test";
import assert from "node:assert/strict";
import {
  supplierStatusToLocal,
  normalizeSupplierOrderStatus,
  isActiveRechargeStatus,
  isPendingWechatPaymentStatus,
  paymentPollDelayMs,
  nextPaymentPollAt,
  shouldActivelyReconcilePayment,
  processingPollDelayMs,
  nextProcessingPollAt,
  shouldActivelyRefreshOrder
} from "../src/order-status.js";

test("only payment_pending orders are eligible for active WeChat reconciliation", () => {
  assert.equal(isPendingWechatPaymentStatus("payment_pending"), true);
  assert.equal(isPendingWechatPaymentStatus("pending_payment"), false);
  assert.equal(isPendingWechatPaymentStatus("paid_pending_recharge"), false);
  assert.equal(shouldActivelyReconcilePayment({ status: "payment_pending" }), true);
  assert.equal(shouldActivelyReconcilePayment({ status: "pending_payment" }), false);
  assert.equal(shouldActivelyReconcilePayment({ status: "recharge_processing" }), false);
});

test("backs off pending WeChat payment polls from 15 seconds to five minutes", () => {
  assert.equal(paymentPollDelayMs(0), 15_000);
  assert.equal(paymentPollDelayMs(1), 30_000);
  assert.equal(paymentPollDelayMs(2), 60_000);
  assert.equal(paymentPollDelayMs(3), 120_000);
  assert.equal(paymentPollDelayMs(4), 240_000);
  assert.equal(paymentPollDelayMs(5), 300_000);
  assert.equal(paymentPollDelayMs(99), 300_000);
  assert.equal(
    nextPaymentPollAt(1, { now: Date.parse("2026-08-24T00:00:00.000Z") }),
    "2026-08-24T00:00:30.000Z"
  );
});

test("respects nextPaymentCheckAt and falls back to paymentCheckedAt throttling", () => {
  const now = Date.parse("2026-08-24T00:01:00.000Z");
  assert.equal(shouldActivelyReconcilePayment({
    status: "payment_pending",
    nextPaymentCheckAt: "2026-08-24T00:01:30.000Z"
  }, { now }), false);
  assert.equal(shouldActivelyReconcilePayment({
    status: "payment_pending",
    nextPaymentCheckAt: "2026-08-24T00:01:00.000Z"
  }, { now }), true);
  assert.equal(shouldActivelyReconcilePayment({
    status: "payment_pending",
    paymentCheckedAt: "2026-08-24T00:00:50.000Z"
  }, { now }), false);
  assert.equal(shouldActivelyReconcilePayment({
    status: "payment_pending",
    paymentCheckedAt: "2026-08-24T00:00:45.000Z"
  }, { now }), true);
});

test("future clock corruption cannot suppress WeChat reconciliation forever", () => {
  const now = Date.parse("2026-08-24T00:00:00.000Z");
  assert.equal(shouldActivelyReconcilePayment({
    status: "payment_pending",
    nextPaymentCheckAt: "2026-08-25T00:00:00.000Z"
  }, { now }), true);
  assert.equal(shouldActivelyReconcilePayment({
    status: "payment_pending",
    paymentCheckedAt: "2026-08-25T00:00:00.000Z"
  }, { now }), true);
});

test("maps successful, failed and refunded supplier states", () => {
  assert.equal(supplierStatusToLocal("SUCCESS"), "recharge_success");
  assert.equal(supplierStatusToLocal("in-progress"), "recharge_processing");
  assert.equal(supplierStatusToLocal("cancelled"), "refund_required");
  assert.equal(supplierStatusToLocal("refunded"), "refund_required");
  assert.equal(normalizeSupplierOrderStatus(" In Progress "), "in_progress");
});

test("only recharge work-in-progress states are actively refreshed", () => {
  assert.equal(isActiveRechargeStatus("paid_pending_recharge"), true);
  assert.equal(isActiveRechargeStatus("recharge_processing"), true);
  assert.equal(isActiveRechargeStatus("recharge_success"), false);
  assert.equal(isActiveRechargeStatus("refund_required"), false);
});

test("backs off normal processing polls up to the configured ceiling", () => {
  assert.equal(processingPollDelayMs(0), 15_000);
  assert.equal(processingPollDelayMs(1), 30_000);
  assert.equal(processingPollDelayMs(2), 60_000);
  assert.equal(processingPollDelayMs(3), 120_000);
  assert.equal(processingPollDelayMs(99), 120_000);
  assert.equal(
    nextProcessingPollAt(1, { now: Date.parse("2026-08-23T00:00:00.000Z") }),
    "2026-08-23T00:00:30.000Z"
  );
});

test("throttles active page refreshes using the last provider check time", () => {
  const now = Date.parse("2026-08-23T00:00:10.000Z");
  assert.equal(shouldActivelyRefreshOrder({ status: "recharge_processing" }, { now }), true);
  assert.equal(shouldActivelyRefreshOrder({
    status: "recharge_processing",
    providerCheckedAt: "2026-08-23T00:00:05.000Z"
  }, { now }), false);
  assert.equal(shouldActivelyRefreshOrder({
    status: "recharge_processing",
    providerCheckedAt: "2026-08-23T00:00:00.000Z"
  }, { now }), true);
  assert.equal(shouldActivelyRefreshOrder({
    status: "recharge_success",
    providerCheckedAt: "2026-08-22T00:00:00.000Z"
  }, { now }), false);
});

test("future clock corruption does not suppress refresh forever", () => {
  const now = Date.parse("2026-08-23T00:00:00.000Z");
  assert.equal(shouldActivelyRefreshOrder({
    status: "recharge_processing",
    providerCheckedAt: "2026-08-24T00:00:00.000Z"
  }, { now }), true);
});

test("an active page refresh never bypasses supplier error backoff", () => {
  const now = Date.parse("2026-08-23T00:00:00.000Z");
  assert.equal(shouldActivelyRefreshOrder({
    status: "recharge_processing",
    providerCheckedAt: "2026-08-22T23:00:00.000Z",
    nextRetryAt: "2026-08-23T00:02:00.000Z"
  }, { now }), false);
  assert.equal(shouldActivelyRefreshOrder({
    status: "recharge_processing",
    providerCheckedAt: "2026-08-22T23:00:00.000Z",
    nextRetryAt: "2026-08-22T23:59:59.000Z"
  }, { now }), true);
});
