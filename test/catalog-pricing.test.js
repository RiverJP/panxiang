import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AUTO_PRICING_RULE,
  MISSING_FROM_COMPLETE_CATALOG_REASON,
  supplierBuyPriceIdr,
  supplierProductAvailability,
  normalizeStoredSupplierAvailability,
  normalizeAutoPricingRule,
  normalizeProviderFxTimestamp,
  effectiveFxRateTimestamp,
  autoPriceState,
  shouldRefreshFxRate
} from "../src/catalog-pricing.js";

test("interprets ReloadN amount as IDR when the merchant account currency is IDR", () => {
  assert.equal(supplierBuyPriceIdr({ sku: "TK2K", amount: "2900" }, { accountCurrency: "IDR", allowUndeclaredGeneric: true }), 2900);
});

test("uses a primitive product price in the configured IDR account currency", () => {
  assert.equal(supplierBuyPriceIdr({ sku: "TK5K", price: "5500" }, { accountCurrency: "IDR", allowUndeclaredGeneric: true }), 5500);
});

test("explicit IDR price wins even when the generic price currency differs", () => {
  assert.equal(supplierBuyPriceIdr({ buy_price_idr: "5500", currency: "CNY", amount: "2.00" }, { accountCurrency: "CNY" }), 5500);
});

test("does not treat a generic amount in a non-IDR account as IDR", () => {
  assert.equal(supplierBuyPriceIdr({ amount: "2.00" }, { accountCurrency: "CNY", allowUndeclaredGeneric: true }), null);
});

test("does not use a currency-less generic amount until the product is recognized as eligible", () => {
  assert.equal(supplierBuyPriceIdr({ amount: "2900" }, { accountCurrency: "IDR" }), null);
});

test("products returned by the supplier catalogue are available without a status", () => {
  assert.deepEqual(supplierProductAvailability({ sku: "TK2K" }), {
    active: true,
    statusKnown: false,
    unavailableReason: ""
  });
});

test("catalogue presence overrides supplier status fields", () => {
  for (const item of [
    { status: "inactive" },
    { active: false },
    { available: false },
    { status: "unknown-channel-state" }
  ]) {
    assert.deepEqual(supplierProductAvailability(item), {
      active: true,
      statusKnown: false,
      unavailableReason: ""
    });
  }
});

test("migrates legacy supplier status failures to available without auto-publishing", () => {
  for (const unavailableReason of [
    "供应商标记为不可用",
    "供应商未返回可用状态",
    "未识别供应状态：maintenance"
  ]) {
    assert.deepEqual(normalizeStoredSupplierAvailability({
      sku: "TK5K",
      active: false,
      statusKnown: true,
      published: true,
      unavailableReason
    }), {
      sku: "TK5K",
      active: true,
      statusKnown: false,
      published: false,
      unavailableReason: ""
    });
  }
});

test("keeps products missing from a confirmed complete catalogue unavailable", () => {
  const product = {
    sku: "OLD-SKU",
    active: false,
    statusKnown: true,
    published: true,
    unavailableReason: MISSING_FROM_COMPLETE_CATALOG_REASON
  };
  const migrated = normalizeStoredSupplierAvailability(product);
  assert.deepEqual(migrated, {
    ...product,
    statusKnown: false,
    published: false
  });
  assert.deepEqual(normalizeStoredSupplierAvailability(migrated), migrated);
});

test("does not unpublish an already available product during migration", () => {
  assert.deepEqual(normalizeStoredSupplierAvailability({
    sku: "TK10K",
    active: true,
    published: true,
    unavailableReason: ""
  }), {
    sku: "TK10K",
    active: true,
    statusKnown: false,
    published: true,
    unavailableReason: ""
  });
});

test("calculates automatic CNY price from a current IDR/CNY rate", () => {
  const state = autoPriceState(
    { buyPriceIdr: 2900 },
    { idrPerCny: 2638.5224, updatedAt: "2026-08-22T12:00:00.000Z" },
    { now: Date.parse("2026-08-22T13:00:00.000Z"), maxFxAgeHours: 24 }
  );
  assert.equal(state.status, "ready");
  assert.equal(state.priceCny, 1.14);
  assert.deepEqual(state.pricingRule, DEFAULT_AUTO_PRICING_RULE);
});

test("supports a configurable fixed IDR markup", () => {
  const state = autoPriceState(
    { buyPriceIdr: 2900 },
    {
      idrPerCny: 2638.5224,
      updatedAt: "2026-08-22T12:00:00.000Z",
      autoPricing: { mode: "fixed", value: 500 }
    },
    { now: Date.parse("2026-08-22T13:00:00.000Z"), maxFxAgeHours: 24 }
  );
  assert.equal(state.status, "ready");
  assert.equal(state.priceCny, 1.29);
  assert.deepEqual(state.pricingRule, { mode: "fixed", value: 500 });
});

test("supports a configurable percentage markup", () => {
  const state = autoPriceState(
    { buyPriceIdr: 2900 },
    {
      idrPerCny: 2638.5224,
      updatedAt: "2026-08-22T12:00:00.000Z",
      autoPricing: { mode: "percent", value: 10 }
    },
    { now: Date.parse("2026-08-22T13:00:00.000Z"), maxFxAgeHours: 24 }
  );
  assert.equal(state.status, "ready");
  assert.equal(state.priceCny, 1.21);
  assert.deepEqual(state.pricingRule, { mode: "percent", value: 10 });
});

test("accepts a zero markup and rejects malformed pricing rules", () => {
  assert.deepEqual(normalizeAutoPricingRule({ mode: "fixed", value: 0 }), { mode: "fixed", value: 0 });
  assert.deepEqual(normalizeAutoPricingRule({ mode: "percent", value: 0 }), { mode: "percent", value: 0 });
  assert.equal(normalizeAutoPricingRule({ mode: "fixed", value: 1.5 }), null);
  assert.equal(normalizeAutoPricingRule({ mode: "percent", value: -1 }), null);
  assert.equal(normalizeAutoPricingRule({ mode: "percent", value: "5" }), null);

  const state = autoPriceState(
    { buyPriceIdr: 2900 },
    {
      idrPerCny: 2638.5224,
      updatedAt: "2026-08-22T12:00:00.000Z",
      autoPricing: { mode: "percent", value: -1 }
    },
    { now: Date.parse("2026-08-22T13:00:00.000Z"), maxFxAgeHours: 24 }
  );
  assert.equal(state.status, "invalid_pricing_rule");
  assert.equal(state.priceCny, null);
});

test("reports the precise reason when the supplier buy price is missing", () => {
  const state = autoPriceState(
    { buyPriceIdr: null },
    { idrPerCny: 2638.5224, updatedAt: new Date().toISOString() }
  );
  assert.equal(state.status, "missing_buy_price");
  assert.equal(state.reason, "缺少供应商买入价");
});

test("reports an expired exchange rate separately from missing price", () => {
  const state = autoPriceState(
    { buyPriceIdr: 2900 },
    { idrPerCny: 2638.5224, updatedAt: "2026-08-20T12:00:00.000Z" },
    { now: Date.parse("2026-08-22T13:00:00.000Z"), maxFxAgeHours: 24 }
  );
  assert.equal(state.status, "stale_fx");
  assert.equal(state.reason, "上游汇率行情已过期，请刷新或手动设置");
});

test("daily FX quotes remain usable through the default delay tolerance", () => {
  const state = autoPriceState(
    { buyPriceIdr: 2900 },
    { idrPerCny: 2638.5224, updatedAt: "2026-08-21T07:00:00.000Z" },
    { now: Date.parse("2026-08-22T13:00:00.000Z"), maxFxAgeHours: 36 }
  );
  assert.equal(state.status, "ready");
});

test("rejects provider timestamps beyond the allowed future clock skew", () => {
  const now = Date.parse("2026-08-22T13:00:00.000Z");
  assert.equal(
    normalizeProviderFxTimestamp(now + 5 * 60 * 1000, { now, maxFutureSkewSeconds: 300 }),
    "2026-08-22T13:05:00.000Z"
  );
  assert.equal(normalizeProviderFxTimestamp(now + 5 * 60 * 1000 + 1, { now, maxFutureSkewSeconds: 300 }), null);
  assert.equal(normalizeProviderFxTimestamp("not-a-date", { now }), null);
});

test("automatic pricing uses the same future clock-skew tolerance as FX ingestion", () => {
  const now = Date.parse("2026-08-22T13:00:00.000Z");
  const accepted = autoPriceState(
    { buyPriceIdr: 2900 },
    { idrPerCny: 2638.5224, updateMode: "automatic", providerUpdatedAt: "2026-08-22T13:05:00.000Z" },
    { now, maxFutureSkewSeconds: 300 }
  );
  const rejected = autoPriceState(
    { buyPriceIdr: 2900 },
    { idrPerCny: 2638.5224, updateMode: "automatic", providerUpdatedAt: "2026-08-22T13:05:00.001Z" },
    { now, maxFutureSkewSeconds: 300 }
  );
  assert.equal(accepted.status, "ready");
  assert.equal(rejected.status, "stale_fx");
});

test("uses provider quote time rather than fetch time for automatic rate freshness", () => {
  const fx = {
    idrPerCny: 2638.5224,
    updateMode: "automatic",
    providerUpdatedAt: "2026-08-20T12:00:00.000Z",
    fetchedAt: "2026-08-22T12:55:00.000Z",
    updatedAt: "2026-08-22T12:55:00.000Z"
  };
  assert.equal(effectiveFxRateTimestamp(fx), fx.providerUpdatedAt);
  const state = autoPriceState(
    { buyPriceIdr: 2900 },
    fx,
    { now: Date.parse("2026-08-22T13:00:00.000Z"), maxFxAgeHours: 24 }
  );
  assert.equal(state.status, "stale_fx");
  assert.equal(state.priceCny, null);
});

test("does not treat an automatic rate with no provider timestamp as fresh", () => {
  const state = autoPriceState(
    { buyPriceIdr: 2900 },
    {
      idrPerCny: 2638.5224,
      updateMode: "automatic",
      fetchedAt: "2026-08-22T12:55:00.000Z",
      updatedAt: "2026-08-22T12:55:00.000Z"
    },
    { now: Date.parse("2026-08-22T13:00:00.000Z"), maxFxAgeHours: 24 }
  );
  assert.equal(state.status, "stale_fx");
  assert.equal(state.reason, "上游未提供行情时间，无法确认汇率新鲜度");
});

test("manual rates use their effective save time", () => {
  const fx = {
    idrPerCny: 2638.5224,
    updateMode: "manual",
    effectiveRateUpdatedAt: "2026-08-22T12:55:00.000Z",
    providerUpdatedAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-22T12:55:00.000Z"
  };
  assert.equal(effectiveFxRateTimestamp(fx), fx.effectiveRateUpdatedAt);
  const state = autoPriceState(
    { buyPriceIdr: 2900 },
    fx,
    { now: Date.parse("2026-08-22T13:00:00.000Z"), maxFxAgeHours: 24 }
  );
  assert.equal(state.status, "ready");
});

test("FX scheduling retries stale quotes quickly without retrying fresh quotes too often", () => {
  const now = Date.parse("2026-08-22T13:00:00.000Z");
  const staleFx = {
    idrPerCny: 2638.5224,
    updateMode: "automatic",
    providerUpdatedAt: "2026-08-20T00:00:00.000Z",
    fetchedAt: "2026-08-22T12:45:00.000Z",
    updatedAt: "2026-08-22T12:45:00.000Z"
  };
  assert.equal(shouldRefreshFxRate(staleFx, { now }), false);
  assert.equal(shouldRefreshFxRate(staleFx, { now: now + 16 * 60 * 1000 }), true);

  const freshFx = {
    ...staleFx,
    providerUpdatedAt: "2026-08-22T12:00:00.000Z",
    fetchedAt: "2026-08-22T12:45:00.000Z",
    updatedAt: "2026-08-22T12:45:00.000Z"
  };
  assert.equal(shouldRefreshFxRate(freshFx, { now }), false);
  assert.equal(shouldRefreshFxRate(freshFx, { now: now + 8 * 60 * 60 * 1000 }), true);
});

test("FX scheduling backs off after a failed recovery attempt", () => {
  const now = Date.parse("2026-08-22T13:00:00.000Z");
  assert.equal(shouldRefreshFxRate(null, { now, lastAttemptAt: now - 5 * 60 * 1000 }), false);
  assert.equal(shouldRefreshFxRate(null, { now, lastAttemptAt: now - 31 * 60 * 1000 }), true);
});
