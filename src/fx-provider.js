export const FX_PROVIDERS = Object.freeze({
  BANK_OF_CHINA: "bank-of-china",
  EXCHANGE_RATE_API: "exchange-rate-api",
  COINBASE: "coinbase",
  OPEN_ER_API: "open-er-api"
});

const PROVIDER_METADATA = Object.freeze({
  [FX_PROVIDERS.BANK_OF_CHINA]: Object.freeze({
    source: "中国银行外汇牌价·印尼卢比现汇卖出价",
    recommendedRefreshMinutes: 60
  }),
  [FX_PROVIDERS.EXCHANGE_RATE_API]: Object.freeze({
    source: "ExchangeRate-API /v6/latest/CNY",
    recommendedRefreshMinutes: 60
  }),
  [FX_PROVIDERS.COINBASE]: Object.freeze({
    source: "Coinbase current snapshot",
    recommendedRefreshMinutes: 60
  }),
  [FX_PROVIDERS.OPEN_ER_API]: Object.freeze({
    source: "open.er-api /v6/latest/CNY (daily fallback)",
    recommendedRefreshMinutes: 8 * 60
  })
});

const DEFAULT_BANK_OF_CHINA_FX_URL = "https://www.boc.cn/sourcedb/whpj/";
const DEFAULT_EXCHANGE_RATE_API_BASE_URL = "https://v6.exchangerate-api.com/v6";
const DEFAULT_COINBASE_EXCHANGE_RATE_URL = "https://api.coinbase.com/v2/exchange-rates";
const DEFAULT_OPEN_ER_API_URL = "https://open.er-api.com/v6/latest/CNY";
const MAX_LAST_UPDATE_FUTURE_SKEW_SECONDS = 300;

export class FxProviderError extends Error {
  constructor(code, message, { provider = null, status = null } = {}) {
    super(message);
    this.name = "FxProviderError";
    this.code = code;
    this.provider = provider;
    this.status = status;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedProviderName(value) {
  const normalized = nonEmptyString(value).toLowerCase();
  if (!normalized || normalized === "auto") return "auto";
  if (["bank-of-china", "bank_of_china", "boc"].includes(normalized)) {
    return FX_PROVIDERS.BANK_OF_CHINA;
  }
  if (["exchange-rate-api", "exchangerate-api", "exchangerate_api"].includes(normalized)) {
    return FX_PROVIDERS.EXCHANGE_RATE_API;
  }
  if (["coinbase", "coinbase-api", "coinbase_api"].includes(normalized)) {
    return FX_PROVIDERS.COINBASE;
  }
  if (["open-er-api", "open.er-api", "open_er_api", "fallback"].includes(normalized)) {
    return FX_PROVIDERS.OPEN_ER_API;
  }
  throw new FxProviderError("FX_CONFIG_ERROR", `Unsupported FX provider: ${normalized}`);
}

function positiveInteger(value, fallback, { min = 1, max = 24 * 60 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function recommendedFxRefreshMinutes(provider, { env = process.env } = {}) {
  const metadata = PROVIDER_METADATA[provider];
  if (!metadata) throw new FxProviderError("FX_CONFIG_ERROR", `Unsupported FX provider: ${provider}`);
  const configured = provider === FX_PROVIDERS.BANK_OF_CHINA
    ? env.BOC_REFRESH_MINUTES
    : provider === FX_PROVIDERS.EXCHANGE_RATE_API
      ? env.EXCHANGE_RATE_API_REFRESH_MINUTES
      : provider === FX_PROVIDERS.COINBASE
        ? env.COINBASE_REFRESH_MINUTES
        : env.OPEN_ER_API_REFRESH_MINUTES;
  return positiveInteger(configured, metadata.recommendedRefreshMinutes, {
    min: provider === FX_PROVIDERS.OPEN_ER_API ? 30 : 5
  });
}

/**
 * Selects the configured provider without returning a secret or a secret-bearing
 * request URL. `auto` intentionally uses Bank of China's domestic official
 * exchange-rate page so a mainland-hosted server does not depend on an
 * overseas endpoint. Other providers remain available when explicitly chosen.
 */
export function selectFxProvider(env = process.env) {
  const requested = normalizedProviderName(env.FX_PROVIDER);
  const hasExchangeRateApiKey = Boolean(nonEmptyString(env.EXCHANGE_RATE_API_KEY));
  const provider = requested === "auto"
    ? FX_PROVIDERS.BANK_OF_CHINA
    : requested;

  if (provider === FX_PROVIDERS.EXCHANGE_RATE_API && !hasExchangeRateApiKey) {
    throw new FxProviderError(
      "FX_CONFIG_ERROR",
      "EXCHANGE_RATE_API_KEY is required for the exchange-rate-api provider",
      { provider }
    );
  }

  return {
    provider,
    source: PROVIDER_METADATA[provider].source,
    recommendedRefreshMinutes: recommendedFxRefreshMinutes(provider, { env }),
    degraded: provider === FX_PROVIDERS.OPEN_ER_API
  };
}

function safeHttpsUrl(value, fallback, name) {
  const raw = nonEmptyString(value) || fallback;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new FxProviderError("FX_CONFIG_ERROR", `${name} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new FxProviderError("FX_CONFIG_ERROR", `${name} must be a credential-free HTTPS URL`);
  }
  return parsed;
}

function providerRequest(provider, env) {
  if (provider === FX_PROVIDERS.BANK_OF_CHINA) {
    const url = safeHttpsUrl(
      env.BOC_FX_URL,
      DEFAULT_BANK_OF_CHINA_FX_URL,
      "BOC_FX_URL"
    );
    return {
      url: url.toString(),
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "User-Agent": "Mozilla/5.0 (compatible; PanxiangRecharge/1.0; +https://reloadb.com)"
      }
    };
  }

  if (provider === FX_PROVIDERS.EXCHANGE_RATE_API) {
    const key = nonEmptyString(env.EXCHANGE_RATE_API_KEY);
    if (!key) {
      throw new FxProviderError("FX_CONFIG_ERROR", "EXCHANGE_RATE_API_KEY is required", { provider });
    }
    const base = safeHttpsUrl(
      env.EXCHANGE_RATE_API_BASE_URL,
      DEFAULT_EXCHANGE_RATE_API_BASE_URL,
      "EXCHANGE_RATE_API_BASE_URL"
    );
    base.pathname = `${base.pathname.replace(/\/+$/, "")}/${encodeURIComponent(key)}/latest/CNY`;
    base.search = "";
    return { url: base.toString(), headers: { Accept: "application/json" } };
  }

  if (provider === FX_PROVIDERS.COINBASE) {
    const url = safeHttpsUrl(
      env.COINBASE_EXCHANGE_RATE_URL,
      DEFAULT_COINBASE_EXCHANGE_RATE_URL,
      "COINBASE_EXCHANGE_RATE_URL"
    );
    url.search = "";
    url.searchParams.set("currency", "CNY");
    return { url: url.toString(), headers: { Accept: "application/json" } };
  }

  const url = safeHttpsUrl(
    env.OPEN_ER_API_URL || env.FX_RATE_URL,
    DEFAULT_OPEN_ER_API_URL,
    "OPEN_ER_API_URL"
  );
  return { url: url.toString(), headers: { Accept: "application/json" } };
}

function validNow(now) {
  const parsed = Number(now);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new FxProviderError("FX_PARSE_ERROR", "FX fetch time is invalid");
  }
  return parsed;
}

function unixTimestamp(value, field, { now, allowFuture = false } = {}) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new FxProviderError("FX_PARSE_ERROR", `${field} must be a positive Unix-second timestamp`);
  }
  const milliseconds = value * 1000;
  if (!allowFuture && milliseconds > now + MAX_LAST_UPDATE_FUTURE_SKEW_SECONDS * 1000) {
    throw new FxProviderError("FX_PARSE_ERROR", `${field} is unexpectedly in the future`);
  }
  const iso = new Date(milliseconds).toISOString();
  if (!iso) throw new FxProviderError("FX_PARSE_ERROR", `${field} is invalid`);
  return { seconds: value, iso };
}

function validatedRate(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1_000_000_000) {
    throw new FxProviderError("FX_PARSE_ERROR", "IDR conversion rate must be a positive finite number");
  }
  return value;
}

function validatedCoinbaseRate(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    throw new FxProviderError("FX_PARSE_ERROR", "Coinbase IDR conversion rate must be a numeric string");
  }
  return validatedRate(Number(value));
}

function htmlCellText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function strictPositiveDecimal(value, field) {
  const normalized = String(value || "").replace(/,/g, "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new FxProviderError("FX_PARSE_ERROR", `${field} must be a positive decimal`);
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new FxProviderError("FX_PARSE_ERROR", `${field} must be a positive decimal`);
  }
  return parsed;
}

function bankOfChinaTimestamp(value, now) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) {
    throw new FxProviderError("FX_PARSE_ERROR", "Bank of China quote timestamp is invalid");
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const [year, month, day, hour, minute, second] = parts;
  const milliseconds = Date.UTC(year, month - 1, day, hour - 8, minute, second);
  const shanghaiTime = new Date(milliseconds + 8 * 60 * 60 * 1000);
  if (
    shanghaiTime.getUTCFullYear() !== year
    || shanghaiTime.getUTCMonth() + 1 !== month
    || shanghaiTime.getUTCDate() !== day
    || shanghaiTime.getUTCHours() !== hour
    || shanghaiTime.getUTCMinutes() !== minute
    || shanghaiTime.getUTCSeconds() !== second
  ) {
    throw new FxProviderError("FX_PARSE_ERROR", "Bank of China quote timestamp is invalid");
  }
  if (milliseconds > now + MAX_LAST_UPDATE_FUTURE_SKEW_SECONDS * 1000) {
    throw new FxProviderError("FX_PARSE_ERROR", "Bank of China quote timestamp is unexpectedly in the future");
  }
  return new Date(milliseconds).toISOString();
}

/**
 * Parses the Bank of China row for Indonesian rupiah. BOC quotes the number of
 * CNY paid for 100 units of foreign currency. For our IDR-per-CNY pricing
 * direction the spot selling quote is therefore inverted as 100 / quote.
 */
export function parseBankOfChinaQuote(html, {
  now = Date.now(),
  env = process.env
} = {}) {
  const checkedNow = validNow(now);
  if (typeof html !== "string" || html.length === 0) {
    throw new FxProviderError("FX_PARSE_ERROR", "Bank of China FX response must be HTML", {
      provider: FX_PROVIDERS.BANK_OF_CHINA
    });
  }
  const row = /<tr\b[^>]*\bdata-currency\s*=\s*(["'])\s*印尼卢比\s*\1[^>]*>([\s\S]*?)<\/tr>/i.exec(html);
  if (!row) {
    throw new FxProviderError("FX_PARSE_ERROR", "Bank of China Indonesian rupiah quote is missing", {
      provider: FX_PROVIDERS.BANK_OF_CHINA
    });
  }
  const cells = [...row[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
    .map((match) => htmlCellText(match[1]));
  if (cells.length < 8 || cells[0] !== "印尼卢比") {
    throw new FxProviderError("FX_PARSE_ERROR", "Bank of China Indonesian rupiah row is incomplete", {
      provider: FX_PROVIDERS.BANK_OF_CHINA
    });
  }

  const spotSellingCnyPer100Idr = strictPositiveDecimal(cells[3], "Bank of China spot selling price");
  const providerUpdatedAt = bankOfChinaTimestamp(cells[6], checkedNow);
  const fetchedAt = new Date(checkedNow).toISOString();
  return {
    idrPerCny: validatedRate(100 / spotSellingCnyPer100Idr),
    provider: FX_PROVIDERS.BANK_OF_CHINA,
    source: PROVIDER_METADATA[FX_PROVIDERS.BANK_OF_CHINA].source,
    providerUpdatedAt,
    providerNextUpdateAt: null,
    fetchedAt,
    recommendedRefreshMinutes: recommendedFxRefreshMinutes(FX_PROVIDERS.BANK_OF_CHINA, { env }),
    degraded: false
  };
}

/**
 * Converts a supported provider payload into the format persisted by the
 * application. Timestamped providers preserve their upstream quote time;
 * Coinbase snapshots use the successful fetch time because that API does not
 * expose an upstream timestamp.
 */
export function parseFxQuote(payload, {
  provider,
  now = Date.now(),
  env = process.env
} = {}) {
  if (!PROVIDER_METADATA[provider]) {
    throw new FxProviderError("FX_CONFIG_ERROR", `Unsupported FX provider: ${provider}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new FxProviderError("FX_PARSE_ERROR", "FX provider response must be an object", { provider });
  }

  const checkedNow = validNow(now);
  if (provider === FX_PROVIDERS.COINBASE) {
    const data = payload.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new FxProviderError("FX_PARSE_ERROR", "Coinbase FX response data is missing", { provider });
    }
    if (data.currency !== "CNY") {
      throw new FxProviderError("FX_PARSE_ERROR", "Coinbase FX base currency must be CNY", { provider });
    }
    if (!data.rates || typeof data.rates !== "object" || Array.isArray(data.rates)) {
      throw new FxProviderError("FX_PARSE_ERROR", "Coinbase FX rate table is missing", { provider });
    }
    const snapshotAt = new Date(checkedNow).toISOString();
    return {
      idrPerCny: validatedCoinbaseRate(data.rates.IDR),
      provider,
      source: PROVIDER_METADATA[provider].source,
      providerUpdatedAt: snapshotAt,
      providerNextUpdateAt: null,
      fetchedAt: snapshotAt,
      recommendedRefreshMinutes: recommendedFxRefreshMinutes(provider, { env }),
      degraded: false
    };
  }

  if (payload.result !== "success") {
    throw new FxProviderError("FX_PROVIDER_REJECTED", "FX provider did not return a successful result", { provider });
  }
  if (payload.base_code !== "CNY") {
    throw new FxProviderError("FX_PARSE_ERROR", "FX provider base currency must be CNY", { provider });
  }

  const rateContainer = provider === FX_PROVIDERS.EXCHANGE_RATE_API
    ? payload.conversion_rates
    : payload.rates;
  if (!rateContainer || typeof rateContainer !== "object" || Array.isArray(rateContainer)) {
    throw new FxProviderError("FX_PARSE_ERROR", "FX provider rate table is missing", { provider });
  }

  const last = unixTimestamp(payload.time_last_update_unix, "time_last_update_unix", {
    now: checkedNow
  });
  const next = unixTimestamp(payload.time_next_update_unix, "time_next_update_unix", {
    now: checkedNow,
    allowFuture: true
  });
  if (next.seconds <= last.seconds) {
    throw new FxProviderError(
      "FX_PARSE_ERROR",
      "time_next_update_unix must be later than time_last_update_unix",
      { provider }
    );
  }

  const metadata = PROVIDER_METADATA[provider];
  return {
    idrPerCny: validatedRate(rateContainer.IDR),
    provider,
    source: metadata.source,
    providerUpdatedAt: last.iso,
    providerNextUpdateAt: next.iso,
    fetchedAt: new Date(checkedNow).toISOString(),
    recommendedRefreshMinutes: recommendedFxRefreshMinutes(provider, { env }),
    degraded: provider === FX_PROVIDERS.OPEN_ER_API
  };
}

/** Fetches a quote while keeping the API key out of returned data and errors. */
export async function fetchFxQuote({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  signal
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new FxProviderError("FX_CONFIG_ERROR", "A fetch implementation is required");
  }
  const selection = selectFxProvider(env);
  const request = providerRequest(selection.provider, env);
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: "GET",
      headers: request.headers,
      signal
    });
  } catch {
    throw new FxProviderError("FX_FETCH_FAILED", "Unable to reach the FX provider", {
      provider: selection.provider
    });
  }

  if (!response || response.ok !== true) {
    const status = Number.isInteger(response?.status) ? response.status : null;
    throw new FxProviderError("FX_HTTP_ERROR", "FX provider returned an unsuccessful HTTP response", {
      provider: selection.provider,
      status
    });
  }

  if (selection.provider === FX_PROVIDERS.BANK_OF_CHINA) {
    let html;
    try {
      html = await response.text();
    } catch {
      throw new FxProviderError("FX_PARSE_ERROR", "Bank of China returned invalid HTML", {
        provider: selection.provider
      });
    }
    return parseBankOfChinaQuote(html, { now, env });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new FxProviderError("FX_PARSE_ERROR", "FX provider returned invalid JSON", {
      provider: selection.provider
    });
  }
  return parseFxQuote(payload, { provider: selection.provider, now, env });
}
