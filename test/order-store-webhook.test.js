import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrderStore } from "../src/order-store.js";

function temporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panxiang-order-store-"));
  const store = new OrderStore({
    dbPath: path.join(directory, "orders.sqlite"),
    legacyJsonPath: path.join(directory, "missing-orders.json")
  }).init({ migrateLegacy: false });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

test("unmatched provider webhook remains replayable after the order is created", (t) => {
  const store = temporaryStore(t);
  const webhook = {
    webhookId: "wh_early",
    outTradeNo: "PX-EARLY",
    providerOrderId: "provider-early",
    orderVersion: 1,
    eventType: "order.success",
    status: "recharge_success",
    payload: { type: "order.success" }
  };

  assert.throws(
    () => store.applyProviderWebhook(webhook),
    (error) => error?.code === "WEBHOOK_ORDER_NOT_FOUND" && error?.status === 503
  );
  assert.equal(store.getWebhook("wh_early"), null);

  store.createOrder({ id: "PX-EARLY", status: "recharge_processing", orderVersion: 0 });
  const result = store.applyProviderWebhook(webhook);
  assert.equal(result.applied, true);
  assert.equal(store.getOrder("PX-EARLY").status, "recharge_success");
});

test("a newer supplier refund moves a successful recharge into refund handling", (t) => {
  const store = temporaryStore(t);
  store.createOrder({ id: "PX-REVERSED", status: "recharge_success", orderVersion: 1 });

  const result = store.applyProviderWebhook({
    webhookId: "wh_refunded",
    outTradeNo: "PX-REVERSED",
    providerOrderId: "provider-reversed",
    orderVersion: 2,
    eventType: "order.refunded",
    status: "refund_required",
    patch: { needsManualAction: true },
    payload: { type: "order.refunded" }
  });

  assert.equal(result.applied, true);
  assert.equal(store.getOrder("PX-REVERSED").status, "refund_required");
  assert.equal(store.getOrder("PX-REVERSED").needsManualAction, true);
});
