const idrCurrencies = new Set(["IDR", "RP", "RUPIAH", "INDONESIAN RUPIAH"]);

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

export function supplierProductAvailability(item, { listedProductsDefaultActive = false } = {}) {
  const unavailable = new Set([
    "0", "false", "no", "off", "inactive", "disabled", "offline", "suspended", "unavailable",
    "maintenance", "maintaining", "out_of_stock", "out-of-stock", "out of stock", "sold_out", "sold-out", "sold out", "closed"
  ]);
  const available = new Set(["1", "true", "yes", "on", "active", "enabled", "online", "available", "ready", "live", "open", "normal", "in_stock", "in-stock", "in stock"]);
  const candidates = [item.active, item.is_active, item.isActive, item.enabled, item.is_enabled, item.isEnabled, item.available, item.is_available, item.isAvailable, item.status, item.state, item.product_status, item.productStatus, item.availability]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => String(value).trim().toLowerCase());

  if (!candidates.length) {
    return listedProductsDefaultActive
      ? { active: true, statusKnown: false, unavailableReason: "供应商未单独返回状态，按当前产品目录视为可用" }
      : { active: false, statusKnown: false, unavailableReason: "供应商未返回可用状态" };
  }
  if (candidates.some((value) => unavailable.has(value))) return { active: false, statusKnown: true, unavailableReason: "供应商标记为不可用" };
  if (candidates.some((value) => available.has(value))) return { active: true, statusKnown: true, unavailableReason: "" };
  return { active: false, statusKnown: false, unavailableReason: `未识别供应状态：${candidates[0]}` };
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
  const calculated = Number(((buyPriceIdr - 120) / idrPerCny).toFixed(2));
  if (!Number.isFinite(calculated) || calculated <= 0) {
    return { status: "invalid_auto_price", reason: "自动售价计算结果无效", priceCny: null };
  }
  return { status: "ready", reason: "自动售价已就绪", priceCny: calculated };
}
