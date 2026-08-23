import test from "node:test";
import assert from "node:assert/strict";
import {
  MISSING_FROM_COMPLETE_CATALOG_REASON,
  supplierBuyPriceIdr,
  supplierProductAvailability,
  normalizeStoredSupplierAvailability,
  autoPriceState
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
  assert.equal(state.reason, "汇率已过期，请刷新");
});
