import crypto from "node:crypto";

function safeEqualText(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class WechatPaymentValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WechatPaymentValidationError";
    this.code = code;
  }
}

function reject(code, message) {
  throw new WechatPaymentValidationError(code, message);
}

/**
 * Validates the complete identity and amount boundary before a WeChat payment
 * is allowed to trigger a real supplier recharge. This is shared by webhook
 * delivery and active transaction reconciliation so neither path is weaker.
 */
export function validateSuccessfulWechatPayment(order, payment, {
  appid,
  mchid,
  owner = null,
  now = Date.now()
} = {}) {
  if (!order || typeof order !== "object") reject("ORDER_MISSING", "本地订单不存在");
  if (!payment || typeof payment !== "object") reject("PAYMENT_MISSING", "微信支付记录不存在");
  if (String(payment.trade_state || "").toUpperCase() !== "SUCCESS") {
    reject("PAYMENT_NOT_SUCCESS", "微信支付尚未成功");
  }
  if (!safeEqualText(payment.out_trade_no, order.id)) {
    reject("OUT_TRADE_NO_MISMATCH", "微信商户订单号不匹配");
  }
  if (!safeEqualText(payment.appid, appid) || !safeEqualText(payment.mchid, mchid)) {
    reject("MERCHANT_IDENTITY_MISMATCH", "微信支付商户身份不匹配");
  }
  if (!safeEqualText(payment.amount?.currency, "CNY")) {
    reject("CURRENCY_MISMATCH", "微信支付币种不匹配");
  }

  const expectedFen = Math.round(Number(order.price) * 100);
  const paidFen = Number(payment.amount?.total);
  if (!Number.isSafeInteger(expectedFen) || expectedFen <= 0 || !Number.isSafeInteger(paidFen) || paidFen !== expectedFen) {
    reject("AMOUNT_MISMATCH", "微信支付金额不匹配");
  }

  const payerOpenid = String(payment.payer?.openid || "").trim();
  if (!payerOpenid) reject("PAYER_MISSING", "微信支付用户标识缺失");
  if (order.payerOpenid && !safeEqualText(payerOpenid, order.payerOpenid)) {
    reject("PAYER_MISMATCH", "微信支付用户与订单不匹配");
  }
  if (owner && (!safeEqualText(owner.appid, payment.appid) || !safeEqualText(owner.openid, payerOpenid))) {
    reject("OWNER_MISMATCH", "微信支付用户与订单归属不匹配");
  }

  const transactionId = String(payment.transaction_id || "").trim();
  if (!transactionId) reject("TRANSACTION_ID_MISSING", "微信支付流水号缺失");
  const checkedNow = Number(now);
  const fallbackPaidAt = new Date(Number.isFinite(checkedNow) ? checkedNow : Date.now()).toISOString();

  return {
    transactionId,
    payerOpenid,
    paidAt: String(payment.success_time || "").trim() || fallbackPaidAt,
    amountFen: paidFen,
    tradeState: "SUCCESS"
  };
}

