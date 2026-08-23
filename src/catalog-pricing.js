const idrCurrencies = new Set(["IDR", "RP", "RUPIAH", "INDONESIAN RUPIAH"]);
export const MISSING_FROM_COMPLETE_CATALOG_REASON = "供应商完整目录未返回该商品";

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== "");
}

export function numericIdr(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function supplierCurrency(item) {
  const value = firstPresent(
    item.currency,
    item.currency_code,
    item.currencyCode,
    item.buy_currency,
    item.buyCurrency,
    item.cost_currency,
    item.costCurrency,
    item.price?.currency,
    item.price?.currency_code,
    item.price?.currencyCode
  );
  return String(value ?? "").trim().toUpperCase();
}

/**
 * ReloadN returns product prices in the merchant account currency and does not
 * repeat that currency on every product. The production account used by this
 * project is IDR, configured through SUPPLIER_ACCOUNT_CURRENCY.
 */
export function supplierBuyPriceIdr(item, {
  accountCurrency = process.env.SUPPLIER_ACCOUNT_CURRENCY || "IDR",
  allowUndeclaredGeneric = false
} = {}) {
  const explicitlyIdr = firstPresent(
    item.buy_price_idr,
    item.buyPriceIdr,
    item.cost_idr,
    item.costIdr,
    item.price_idr,
    item.priceIdr
  );
  if (explicitlyIdr !== undefined) return numericIdr(explicitlyIdr);

  const declaredCurrency = supplierCurrency(item);
  if (!declaredCurrency && !allowUndeclaredGeneric) return null;
  const effectiveCurrency = declaredCurrency || String(accountCurrency || "").trim().toUpperCase();
  if (!idrCurrencies.has(effectiveCurrency)) return null;

  return numericIdr(firstPresent(
    item.buy_price,
    item.buyPrice,
    item.cost,
    item.sell_price,
    item.sellPrice,
    item.selling_price,
    item.sellingPrice,
    item.price?.amount,
    item.price?.value,
    item.price?.sell_price,
    item.price?.sellPrice,
    typeof item.price === "object" ? undefined : item.price,
    item.amount
  ));
}

export function supplierProductAvailability() {
  // ReloadN's catalogue is the source of truth for saleability: if a SKU is
  // returned by the current catalogue request, it is available. Some catalogue
  // rows contain stale or channel-specific status fields, so those fields must
  // not override catalogue presence.
  return { active: true, statusKnown: false, unavailableReason: "" };
}

export function normalizeStoredSupplierAvailability(product) {
  const confirmedMissing = product?.unavailableReason === MISSING_FROM_COMPLETE_CATALOG_REASON;
  if (confirmedMissing) {
    return {
      ...product,
      active: false,
      statusKnown: false,
      published: false,
      unavailableReason: MISSING_FROM_COMPLETE_CATALOG_REASON
    };
  }

  const restored = product?.active !== true;
  return {
    ...product,
    active: true,
    statusKnown: false,
    unavailableReason: "",
    ...(restored ? { published: false } : {})
  };
}

export function autoPriceState(product, fx, {
  now = Date.now(),
  maxFxAgeHours = Number(process.env.MAX_FX_AGE_HOURS || 24)
} = {}) {
  if (product?.buyPriceIdr === null || product?.buyPriceIdr === undefined || product?.buyPriceIdr === "") {
    return { status: "missing_buy_price", reason: "缺少供应商买入价", priceCny: null };
  }
  const buyPriceIdr = Number(product.buyPriceIdr);
  if (!Number.isFinite(buyPriceIdr) || buyPriceIdr <= 0) {
    return { status: "invalid_buy_price", reason: "供应商买入价无效", priceCny: null };
  }
  if (fx?.idrPerCny === null || fx?.idrPerCny === undefined || fx?.idrPerCny === "") {
    return { status: "missing_fx", reason: "汇率尚未同步", priceCny: null };
  }
  const idrPerCny = Number(fx.idrPerCny);
  if (!Number.isFinite(idrPerCny) || idrPerCny <= 0) {
    return { status: "invalid_fx", reason: "汇率数据无效", priceCny: null };
  }
  const fxAge = now - Date.parse(fx.updatedAt || 0);
  if (!Number.isFinite(fxAge) || fxAge < 0 || fxAge > maxFxAgeHours * 60 * 60 * 1000) {
    return { status: "stale_fx", reason: "汇率已过期，请刷新", priceCny: null };
  }
  const calculated = Number(((buyPriceIdr + 120) / idrPerCny).toFixed(2));
  if (!Number.isFinite(calculated) || calculated <= 0) {
    return { status: "invalid_auto_price", reason: "自动售价计算结果无效", priceCny: null };
  }
  return { status: "ready", reason: "自动售价已就绪", priceCny: calculated };
}
