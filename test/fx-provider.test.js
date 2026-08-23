import test from "node:test";
import assert from "node:assert/strict";
import {
  FX_PROVIDERS,
  FxProviderError,
  fetchFxQuote,
  parseFxQuote,
  recommendedFxRefreshMinutes,
  selectFxProvider
} from "../src/fx-provider.js";

const now = Date.parse("2026-08-23T04:00:00.000Z");
const lastUpdate = Math.floor(Date.parse("2026-08-23T03:00:00.000Z") / 1000);
const nextUpdate = Math.floor(Date.parse("2026-08-23T05:00:00.000Z") / 1000);

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

function exchangeRateApiPayload(overrides = {}) {
  return {
    result: "success",
    base_code: "CNY",
    time_last_update_unix: lastUpdate,
    time_next_update_unix: nextUpdate,
    conversion_rates: { IDR: 2631.25 },
    ...overrides
  };
}

function openErApiPayload(overrides = {}) {
  return {
    result: "success",
    base_code: "CNY",
    time_last_update_unix: lastUpdate,
    time_next_update_unix: nextUpdate,
    rates: { IDR: 2630.75 },
    ...overrides
  };
}

function coinbasePayload(overrides = {}) {
  return {
    data: {
      currency: "CNY",
      rates: { IDR: "2631.125" },
      ...overrides
    }
  };
}

test("selects the keyed provider without exposing the key in configuration", () => {
  const config = selectFxProvider({ EXCHANGE_RATE_API_KEY: "super-secret-key" });
  assert.deepEqual(config, {
    provider: FX_PROVIDERS.EXCHANGE_RATE_API,
    source: "ExchangeRate-API /v6/latest/CNY",
    recommendedRefreshMinutes: 60,
    degraded: false
  });
  assert.doesNotMatch(JSON.stringify(config), /super-secret-key/);
});

test("selects Coinbase current snapshots when no key is configured", () => {
  assert.deepEqual(selectFxProvider({}), {
    provider: FX_PROVIDERS.COINBASE,
    source: "Coinbase current snapshot",
    recommendedRefreshMinutes: 60,
    degraded: false
  });
});

test("fetches and normalizes a keyless Coinbase current snapshot", async () => {
  const calls = [];
  const quote = await fetchFxQuote({
    env: { COINBASE_REFRESH_MINUTES: "15" },
    now,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(coinbasePayload());
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.coinbase.com/v2/exchange-rates?currency=CNY");
  assert.deepEqual(calls[0].options.headers, { Accept: "application/json" });
  assert.deepEqual(quote, {
    idrPerCny: 2631.125,
    provider: FX_PROVIDERS.COINBASE,
    source: "Coinbase current snapshot",
    providerUpdatedAt: "2026-08-23T04:00:00.000Z",
    providerNextUpdateAt: null,
    fetchedAt: "2026-08-23T04:00:00.000Z",
    recommendedRefreshMinutes: 15,
    degraded: false
  });
});

test("fetches and normalizes a keyed ExchangeRate-API quote", async () => {
  const calls = [];
  const env = {
    EXCHANGE_RATE_API_KEY: "secret/key",
    EXCHANGE_RATE_API_REFRESH_MINUTES: "30"
  };
  const quote = await fetchFxQuote({
    env,
    now,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(exchangeRateApiPayload());
    }
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v6\/secret%2Fkey\/latest\/CNY$/);
  assert.deepEqual(calls[0].options.headers, { Accept: "application/json" });
  assert.deepEqual(quote, {
    idrPerCny: 2631.25,
    provider: FX_PROVIDERS.EXCHANGE_RATE_API,
    source: "ExchangeRate-API /v6/latest/CNY",
    providerUpdatedAt: "2026-08-23T03:00:00.000Z",
    providerNextUpdateAt: "2026-08-23T05:00:00.000Z",
    fetchedAt: "2026-08-23T04:00:00.000Z",
    recommendedRefreshMinutes: 30,
    degraded: false
  });
  assert.doesNotMatch(JSON.stringify(quote), /secret/);
});

test("fetches and normalizes the open.er-api fallback format", async () => {
  const calls = [];
  const quote = await fetchFxQuote({
    env: { FX_PROVIDER: "open-er-api" },
    now,
    fetchImpl: async (url) => {
      calls.push(url);
      return response(openErApiPayload());
    }
  });

  assert.equal(calls[0], "https://open.er-api.com/v6/latest/CNY");
  assert.equal(quote.idrPerCny, 2630.75);
  assert.equal(quote.provider, FX_PROVIDERS.OPEN_ER_API);
  assert.equal(quote.degraded, true);
  assert.equal(quote.recommendedRefreshMinutes, 480);
});

test("allows an operator to explicitly select the fallback despite having a key", () => {
  assert.equal(selectFxProvider({
    FX_PROVIDER: "open-er-api",
    EXCHANGE_RATE_API_KEY: "unused-key"
  }).provider, FX_PROVIDERS.OPEN_ER_API);
});

test("allows an operator to select Coinbase explicitly despite having a keyed provider", () => {
  assert.equal(selectFxProvider({
    FX_PROVIDER: "coinbase",
    EXCHANGE_RATE_API_KEY: "unused-key"
  }).provider, FX_PROVIDERS.COINBASE);
});

test("requires a key when the keyed provider is selected explicitly", () => {
  assert.throws(
    () => selectFxProvider({ FX_PROVIDER: "exchange-rate-api" }),
    (error) => error instanceof FxProviderError && error.code === "FX_CONFIG_ERROR"
  );
});

test("strictly rejects unsuccessful, wrong-base, invalid-rate and invalid-time payloads", () => {
  const cases = [
    exchangeRateApiPayload({ result: "error" }),
    exchangeRateApiPayload({ base_code: "USD" }),
    exchangeRateApiPayload({ conversion_rates: { IDR: "2631.25" } }),
    exchangeRateApiPayload({ time_last_update_unix: String(lastUpdate) }),
    exchangeRateApiPayload({ time_next_update_unix: lastUpdate })
  ];
  for (const payload of cases) {
    assert.throws(
      () => parseFxQuote(payload, {
        provider: FX_PROVIDERS.EXCHANGE_RATE_API,
        now,
        env: {}
      }),
      (error) => error instanceof FxProviderError && /^FX_(PARSE_ERROR|PROVIDER_REJECTED)$/.test(error.code)
    );
  }
});

test("strictly rejects malformed Coinbase snapshots", () => {
  const cases = [
    null,
    {},
    coinbasePayload({ currency: "USD" }),
    coinbasePayload({ rates: null }),
    coinbasePayload({ rates: { IDR: 2631.25 } }),
    coinbasePayload({ rates: { IDR: "not-a-number" } })
  ];
  for (const payload of cases) {
    assert.throws(
      () => parseFxQuote(payload, {
        provider: FX_PROVIDERS.COINBASE,
        now,
        env: {}
      }),
      (error) => error instanceof FxProviderError && error.code === "FX_PARSE_ERROR"
    );
  }
});

test("rejects a last-update timestamp too far in the future", () => {
  const future = Math.floor((now + 301_000) / 1000);
  assert.throws(
    () => parseFxQuote(exchangeRateApiPayload({
      time_last_update_unix: future,
      time_next_update_unix: future + 3600
    }), {
      provider: FX_PROVIDERS.EXCHANGE_RATE_API,
      now,
      env: {}
    }),
    (error) => error instanceof FxProviderError && error.code === "FX_PARSE_ERROR"
  );
});

test("sanitizes transport errors so a secret-bearing URL is not exposed", async () => {
  await assert.rejects(
    fetchFxQuote({
      env: { EXCHANGE_RATE_API_KEY: "must-not-leak" },
      now,
      fetchImpl: async (url) => {
        throw new Error(`request failed: ${url}`);
      }
    }),
    (error) => {
      assert.equal(error.code, "FX_FETCH_FAILED");
      assert.doesNotMatch(error.message, /must-not-leak/);
      return true;
    }
  );
});

test("rejects non-HTTPS endpoint overrides", async () => {
  await assert.rejects(
    fetchFxQuote({
      env: {
        EXCHANGE_RATE_API_KEY: "key",
        EXCHANGE_RATE_API_BASE_URL: "http://rates.example.test/v6"
      },
      now,
      fetchImpl: async () => response(exchangeRateApiPayload())
    }),
    (error) => error instanceof FxProviderError && error.code === "FX_CONFIG_ERROR"
  );
});

test("rejects non-HTTPS Coinbase endpoint overrides", async () => {
  await assert.rejects(
    fetchFxQuote({
      env: { COINBASE_EXCHANGE_RATE_URL: "http://rates.example.test/v2/exchange-rates" },
      now,
      fetchImpl: async () => response(coinbasePayload())
    }),
    (error) => error instanceof FxProviderError && error.code === "FX_CONFIG_ERROR"
  );
});

test("exposes bounded provider-specific refresh recommendations", () => {
  assert.equal(recommendedFxRefreshMinutes(FX_PROVIDERS.EXCHANGE_RATE_API, {
    env: { EXCHANGE_RATE_API_REFRESH_MINUTES: "5" }
  }), 5);
  assert.equal(recommendedFxRefreshMinutes(FX_PROVIDERS.OPEN_ER_API, {
    env: { OPEN_ER_API_REFRESH_MINUTES: "15" }
  }), 480);
  assert.equal(recommendedFxRefreshMinutes(FX_PROVIDERS.COINBASE, {
    env: { COINBASE_REFRESH_MINUTES: "5" }
  }), 5);
  assert.equal(recommendedFxRefreshMinutes(FX_PROVIDERS.COINBASE, {
    env: { COINBASE_REFRESH_MINUTES: "4" }
  }), 60);
});
