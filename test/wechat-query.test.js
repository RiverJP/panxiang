import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  queryJsapiTransactionByOutTradeNo,
  wechatRequest
} from "../src/wechat.js";

test("queries a JSAPI transaction by an exact, RFC 3986 encoded URI", async () => {
  const calls = [];
  const expected = { trade_state: "SUCCESS" };
  const result = await queryJsapiTransactionByOutTradeNo("PX /+!*()", {
    mchid: "1900/01",
    requestImpl: async (...args) => {
      calls.push(args);
      return expected;
    }
  });

  assert.equal(result, expected);
  assert.deepEqual(calls, [[
    "GET",
    "/v3/pay/transactions/out-trade-no/PX%20%2F%2B%21%2A%28%29?mchid=1900%2F01"
  ]]);
});

test("rejects an empty merchant order number or merchant ID before requesting", async () => {
  let requestCount = 0;
  const requestImpl = async () => { requestCount += 1; };

  await assert.rejects(
    () => queryJsapiTransactionByOutTradeNo("  ", { mchid: "190001", requestImpl }),
    /微信商户订单号不能为空/
  );
  await assert.rejects(
    () => queryJsapiTransactionByOutTradeNo("PX-1", { mchid: "  ", requestImpl }),
    /微信商户号未配置/
  );
  assert.equal(requestCount, 0);
});

test("wechatRequest signs GET with an empty body and omits the HTTP body option", async (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "panxiang-wechat-query-"));
  const privateKeyPath = path.join(temporaryDirectory, "merchant-private-key.pem");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));

  const originalFetch = globalThis.fetch;
  const originalEnvironment = {
    WECHAT_PRIVATE_KEY_PATH: process.env.WECHAT_PRIVATE_KEY_PATH,
    WECHAT_MCHID: process.env.WECHAT_MCHID,
    WECHAT_MCH_SERIAL_NO: process.env.WECHAT_MCH_SERIAL_NO
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  process.env.WECHAT_PRIVATE_KEY_PATH = privateKeyPath;
  process.env.WECHAT_MCHID = "190001";
  process.env.WECHAT_MCH_SERIAL_NO = "SERIAL-1";

  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ trade_state: "SUCCESS" }); }
    };
  };

  const requestPath = "/v3/pay/transactions/out-trade-no/PX-1?mchid=190001";
  const result = await wechatRequest("GET", requestPath);
  assert.equal(result.trade_state, "SUCCESS");
  assert.equal(captured.url, `https://api.mch.weixin.qq.com${requestPath}`);
  assert.equal(captured.options.method, "GET");
  assert.equal(Object.hasOwn(captured.options, "body"), false);

  const authorization = captured.options.headers.Authorization;
  const fields = Object.fromEntries(
    [...authorization.matchAll(/([a-z_]+)="([^"]*)"/g)].map((match) => [match[1], match[2]])
  );
  const canonicalRequest = `GET\n${requestPath}\n${fields.timestamp}\n${fields.nonce_str}\n\n`;
  const signatureIsValid = crypto.createVerify("RSA-SHA256")
    .update(canonicalRequest)
    .verify(publicKey, fields.signature, "base64");
  assert.equal(signatureIsValid, true);
});
