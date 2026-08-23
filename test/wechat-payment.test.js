import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSuccessfulWechatPayment,
  WechatPaymentValidationError
} from "../src/wechat-payment.js";

const order = {
  id: "PX-ORDER-1",
  price: 4.38,
  payerOpenid: "openid-1",
  userId: "user-1"
};

const owner = { id: "user-1", appid: "wx-app", openid: "openid-1" };

function payment(overrides = {}) {
  return {
    appid: "wx-app",
    mchid: "190001",
    out_trade_no: "PX-ORDER-1",
    transaction_id: "420000001",
    trade_state: "SUCCESS",
    success_time: "2026-08-24T01:00:00+08:00",
    amount: { total: 438, currency: "CNY" },
    payer: { openid: "openid-1" },
    ...overrides
  };
}

test("accepts a fully matching successful WeChat payment", () => {
  assert.deepEqual(validateSuccessfulWechatPayment(order, payment(), {
    appid: "wx-app",
    mchid: "190001",
    owner,
    now: Date.parse("2026-08-24T00:00:00.000Z")
  }), {
    transactionId: "420000001",
    payerOpenid: "openid-1",
    paidAt: "2026-08-24T01:00:00+08:00",
    amountFen: 438,
    tradeState: "SUCCESS"
  });
});

test("rejects non-successful, wrong-order and wrong-amount payments", () => {
  for (const candidate of [
    payment({ trade_state: "USERPAYING" }),
    payment({ out_trade_no: "PX-OTHER" }),
    payment({ amount: { total: 437, currency: "CNY" } })
  ]) {
    assert.throws(
      () => validateSuccessfulWechatPayment(order, candidate, { appid: "wx-app", mchid: "190001", owner }),
      (error) => error instanceof WechatPaymentValidationError
    );
  }
});

test("rejects merchant, currency and payer identity mismatches", () => {
  for (const candidate of [
    payment({ appid: "wx-other" }),
    payment({ mchid: "190002" }),
    payment({ amount: { total: 438, currency: "USD" } }),
    payment({ payer: { openid: "openid-2" } }),
    payment({ transaction_id: "" })
  ]) {
    assert.throws(
      () => validateSuccessfulWechatPayment(order, candidate, { appid: "wx-app", mchid: "190001", owner }),
      (error) => error instanceof WechatPaymentValidationError
    );
  }
});

