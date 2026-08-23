export const FX_PROVIDERS = Object.freeze({
  EXCHANGE_RATE_API: "exchange-rate-api",
  COINBASE: "coinbase",
  OPEN_ER_API: "open-er-api"
});

const PROVIDER_METADATA = Object.freeze({
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
  const configured = provider === FX_PROVIDERS.EXCHANGE_RATE_API
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
 * request URL. Supplying EXCHANGE_RATE_API_KEY opts into the keyed provider;
 * otherwise Coinbase's keyless current snapshot is used. The existing daily
 * open.er-api feed remains available as an explicitly selected degraded
 * fallback.
 */
export function selectFxProvider(env = process.env) {
  const requested = normalizedProviderName(env.FX_PROVIDER);
  const hasExchangeRateApiKey = Boolean(nonEmptyString(env.EXCHANGE_RATE_API_KEY));
  const provider = requested === "auto"
    ? (hasExchangeRateApiKey ? FX_PROVIDERS.EXCHANGE_RATE_API : FX_PROVIDERS.COINBASE)
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
