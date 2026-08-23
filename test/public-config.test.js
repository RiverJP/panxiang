import test from "node:test";
import assert from "node:assert/strict";
import { defaultCustomerServiceUrl, normalizeCustomerServiceUrl } from "../src/public-config.js";

test("ships with the configured Panxiang customer service link", () => {
  assert.equal(defaultCustomerServiceUrl, "https://work.weixin.qq.com/kfid/kfcd7c68ab23401a2ba");
});

test("accepts official WeCom customer service and contact links", () => {
  assert.equal(normalizeCustomerServiceUrl("https://work.weixin.qq.com/kf/example?enc_scene=abc"), "https://work.weixin.qq.com/kf/example?enc_scene=abc");
  assert.equal(normalizeCustomerServiceUrl("https://work.weixin.qq.com/ca/example"), "https://work.weixin.qq.com/ca/example");
});

test("rejects insecure, credentialed and lookalike customer service links", () => {
  assert.equal(normalizeCustomerServiceUrl("http://work.weixin.qq.com/kf/example"), "");
  assert.equal(normalizeCustomerServiceUrl("https://user:pass@work.weixin.qq.com/kf/example"), "");
  assert.equal(normalizeCustomerServiceUrl("https://work.weixin.qq.com.evil.example/kf/example"), "");
  assert.equal(normalizeCustomerServiceUrl("javascript:alert(1)"), "");
});
