import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { OrderStore } from "../src/order-store.js";

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panxiang-wechat-store-"));
  const dbPath = path.join(directory, "orders.sqlite");
  const store = new OrderStore({ dbPath, legacyJsonPath: path.join(directory, "missing.json") });
  store.init({ migrateLegacy: false });
  return { directory, dbPath, store };
}

function dispose(context) {
  try { context.store.close(); } catch {}
  fs.rmSync(context.directory, { recursive: true, force: true });
}

test("persists WeChat identity, one-time OAuth state, session and order ownership", () => {
  const context = temporaryStore();
  try {
    const user = context.store.upsertWechatUser({ appid: "wx-app", openid: "openid-a" });
    const sameUser = context.store.upsertWechatUser({ appid: "wx-app", openid: "openid-a", unionid: "union-a" });
    assert.equal(sameUser.id, user.id);
    assert.equal(sameUser.unionid, "union-a");

    const stateExpires = new Date(Date.now() + 60_000).toISOString();
    context.store.createWechatOauthState("oauth-state-secret", "/orders?from=oauth", stateExpires);
    assert.equal(context.store.consumeWechatOauthState("oauth-state-secret")?.returnPath, "/orders?from=oauth");
    assert.equal(context.store.consumeWechatOauthState("oauth-state-secret"), null, "OAuth state must be one-time");

    const sessionExpires = new Date(Date.now() + 60_000).toISOString();
    context.store.createWechatSession("browser-session-secret", user.id, sessionExpires);
    const session = context.store.getWechatSession("browser-session-secret", { touch: false });
    assert.equal(session?.user?.id, user.id);
    assert.equal(session?.user?.openid, "openid-a");

    context.store.createOrder({ id: "PX-OWNED", userId: user.id, status: "pending_payment" });
    context.store.createOrder({ id: "PX-LEGACY", status: "pending_payment" });
    assert.deepEqual(context.store.listOrders({ userId: user.id }).map((order) => order.id), ["PX-OWNED"]);

    context.store.close();
    context.store = new OrderStore({ dbPath: context.dbPath, legacyJsonPath: path.join(context.directory, "missing.json") });
    context.store.init({ migrateLegacy: false });
    assert.equal(context.store.getWechatSession("browser-session-secret", { touch: false })?.user?.id, user.id);
    assert.equal(context.store.getOrder("PX-OWNED")?.userId, user.id);
    assert.equal(context.store.revokeWechatSession("browser-session-secret"), true);
    assert.equal(context.store.getWechatSession("browser-session-secret"), null);
  } finally {
    dispose(context);
  }
});

test("rejects expired sessions and OAuth states", () => {
  const context = temporaryStore();
  try {
    const user = context.store.upsertWechatUser({ appid: "wx-app", openid: "openid-expired" });
    const expired = new Date(Date.now() - 60_000).toISOString();
    context.store.createWechatSession("expired-session", user.id, expired);
    context.store.createWechatOauthState("expired-state", "/", expired);
    assert.equal(context.store.getWechatSession("expired-session"), null);
    assert.equal(context.store.consumeWechatOauthState("expired-state"), null);
    assert.equal(context.store.cleanupWechatAuth().sessions, 1);
  } finally {
    dispose(context);
  }
});

test("adds user_id to an existing orders database without losing legacy orders", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panxiang-old-orders-"));
  const dbPath = path.join(directory, "orders.sqlite");
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE orders (
      out_trade_no TEXT PRIMARY KEY,
      transaction_id TEXT UNIQUE,
      provider_order_id TEXT,
      status TEXT NOT NULL,
      order_version INTEGER NOT NULL DEFAULT 0 CHECK (order_version >= 0),
      data_json TEXT NOT NULL CHECK (json_valid(data_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  const createdAt = new Date().toISOString();
  legacyDb.prepare(`
    INSERT INTO orders (out_trade_no, transaction_id, provider_order_id, status, order_version, data_json, created_at, updated_at)
    VALUES (?, NULL, NULL, ?, 0, ?, ?, ?)
  `).run("PX-OLD", "pending_payment", JSON.stringify({ id: "PX-OLD", status: "pending_payment", createdAt }), createdAt, createdAt);
  legacyDb.close();

  const context = {
    directory,
    dbPath,
    store: new OrderStore({ dbPath, legacyJsonPath: path.join(directory, "missing.json") })
  };
  try {
    context.store.init({ migrateLegacy: false });
    assert.equal(context.store.getOrder("PX-OLD")?.status, "pending_payment");
    const columns = context.store.db.prepare("PRAGMA table_info(orders)").all().map((column) => column.name);
    assert.ok(columns.includes("user_id"));
    const user = context.store.upsertWechatUser({ appid: "wx-app", openid: "openid-old" });
    const linked = context.store.updateOrder("PX-OLD", { userId: user.id });
    assert.equal(linked.updated, true);
    assert.equal(linked.order.userId, user.id);
  } finally {
    dispose(context);
  }
});
