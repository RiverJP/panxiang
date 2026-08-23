const idrCurrencies = new Set(["IDR", "RP", "RUPIAH", "INDONESIAN RUPIAH"]);
export const MISSING_FROM_COMPLETE_CATALOG_REASON = "供应商完整目录未返回该商品";
export const DEFAULT_AUTO_PRICING_RULE = Object.freeze({ mode: "fixed", value: 120 });
export const MAX_FIXED_MARKUP_IDR = 1_000_000;
export const MAX_PERCENT_MARKUP = 1_000;

export function normalizeProviderFxTimestamp(value, {
  now = Date.now(),
  maxFutureSkewSeconds = 300
} = {}) {
  const parsed = typeof value === "number" ? value : Date.parse(String(value || ""));
  const configuredSkew = Number(maxFutureSkewSeconds);
  const safeSkewSeconds = Math.min(3600, Math.max(0, Number.isFinite(configuredSkew) ? configuredSkew : 300));
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > Number(now) + safeSkewSeconds * 1000) return null;
  return new Date(parsed).toISOString();
}

export function normalizeAutoPricingRule(rule, { useDefaultWhenMissing = true } = {}) {
  if (rule === null || rule === undefined) {
    return useDefaultWhenMissing ? { ...DEFAULT_AUTO_PRICING_RULE } : null;
  }
  if (typeof rule !== "object" || Array.isArray(rule)) return null;
  const mode = String(rule.mode || "").trim().toLowerCase();
  const value = rule.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (mode === "fixed" && Number.isSafeInteger(value) && value <= MAX_FIXED_MARKUP_IDR) return { mode, value };
  if (mode === "percent" && value <= MAX_PERCENT_MARKUP) return { mode, value };
  return null;
}

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

export function effectiveFxRateTimestamp(fx) {
  if (!fx || typeof fx !== "object" || Array.isArray(fx)) return null;
  // A successful HTTP fetch does not make an old provider quote fresh. New
  // automatic records must therefore use the timestamp supplied by the rate
  // provider. Manual records are effective at the time the operator saves
  // them, while the final fallback keeps pre-migration records usable.
  if (fx.updateMode === "automatic") return fx.providerUpdatedAt || null;
  return fx.effectiveRateUpdatedAt || fx.updatedAt || fx.fetchedAt || null;
}

export function autoPriceState(product, fx, {
  now = Date.now(),
  maxFxAgeHours = Number(process.env.MAX_FX_AGE_HOURS || 36),
  maxFutureSkewSeconds = Number(process.env.FX_MAX_FUTURE_SKEW_SECONDS || 300),
  pricingRule = fx?.autoPricing
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
  const rateTimestamp = effectiveFxRateTimestamp(fx);
  const fxAge = now - Date.parse(rateTimestamp || "");
  const configuredMaxAge = Number(maxFxAgeHours);
  const safeMaxAgeHours = Number.isFinite(configuredMaxAge) && configuredMaxAge > 0 ? configuredMaxAge : 36;
  const configuredFutureSkew = Number(maxFutureSkewSeconds);
  const safeFutureSkewSeconds = Math.min(3600, Math.max(0, Number.isFinite(configuredFutureSkew) ? configuredFutureSkew : 300));
  if (!rateTimestamp || !Number.isFinite(fxAge)) {
    return { status: "stale_fx", reason: "上游未提供行情时间，无法确认汇率新鲜度", priceCny: null };
  }
  if (fxAge < -safeFutureSkewSeconds * 1000 || fxAge > safeMaxAgeHours * 60 * 60 * 1000) {
    return { status: "stale_fx", reason: "上游汇率行情已过期，请刷新或手动设置", priceCny: null };
  }
  const normalizedRule = normalizeAutoPricingRule(pricingRule);
  if (!normalizedRule) {
    return { status: "invalid_pricing_rule", reason: "自动定价规则无效，请在系统状态中重新保存", priceCny: null };
  }
  const markedUpIdr = normalizedRule.mode === "percent"
    ? buyPriceIdr * (1 + normalizedRule.value / 100)
    : buyPriceIdr + normalizedRule.value;
  const calculated = Number((markedUpIdr / idrPerCny).toFixed(2));
  if (!Number.isFinite(calculated) || calculated <= 0) {
    return { status: "invalid_auto_price", reason: "自动售价计算结果无效", priceCny: null };
  }
  return { status: "ready", reason: "自动售价已就绪", priceCny: calculated, pricingRule: normalizedRule, rateTimestamp };
}

export function shouldRefreshFxRate(fx, {
  now = Date.now(),
  lastAttemptAt = 0,
  normalIntervalMs = 8 * 60 * 60 * 1000,
  recoveryIntervalMs = 30 * 60 * 1000,
  maxFxAgeHours = Number(process.env.MAX_FX_AGE_HOURS || 36)
} = {}) {
  const pricing = autoPriceState({ buyPriceIdr: 10_000 }, fx, { now, maxFxAgeHours });
  const needsFxRecovery = new Set(["missing_fx", "invalid_fx", "stale_fx"]).has(pricing.status);
  const persistedActivity = Date.parse(fx?.fetchedAt || fx?.updatedAt || effectiveFxRateTimestamp(fx) || "");
  const explicitAttempt = Number(lastAttemptAt);
  const latestActivity = Math.max(
    Number.isFinite(persistedActivity) ? persistedActivity : 0,
    Number.isFinite(explicitAttempt) ? explicitAttempt : 0
  );
  const age = now - latestActivity;
  const interval = needsFxRecovery ? Number(recoveryIntervalMs) : Number(normalIntervalMs);
  if (!latestActivity || !Number.isFinite(age) || age < 0) return true;
  return age >= interval;
}
