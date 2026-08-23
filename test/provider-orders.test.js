import test from "node:test";
import assert from "node:assert/strict";
import {
  SupplierOrderNotFoundError,
  createSupplierOrder,
  extractSupplierOrder,
  querySupplierOrder,
  supplierOrderPath
} from "../src/provider.js";

test("normalizes one configurable order path for create and query", () => {
  assert.equal(supplierOrderPath({}), "/v1/orders");
  assert.equal(supplierOrderPath({ SUPPLIER_ORDER_PATH: "v2/orders/" }), "/v2/orders");
  assert.throws(() => supplierOrderPath({ SUPPLIER_ORDER_PATH: "https://example.com/v2/orders" }), /API 路径/);
});

test("extracts only the requested supplier order from list responses", () => {
  const response = { data: { items: [
    { order_id: "o_other", client_order_id: "PX-OTHER", status: "success" },
    { order_id: "o_target", client_order_id: "PX-TARGET", status: "processing" }
  ] } };
  assert.equal(extractSupplierOrder(response, { clientOrderId: "PX-TARGET" })?.order_id, "o_target");
  assert.equal(extractSupplierOrder(response, { clientOrderId: "PX-MISSING" }), null);
});

test("create uses the configured order path and requires an order in the response", async () => {
  const calls = [];
  const result = await createSupplierOrder({
    order: { id: "PX-1", phone: "08131007191" },
    product: { sku: "TK5K" }
  }, {
    orderPath: "/v2/orders",
    request: async (...args) => {
      calls.push(args);
      return { data: { order: { order_id: "o_1", client_order_id: "PX-1", status: "processing" } } };
    }
  });
  assert.equal(calls[0][1], "/v2/orders");
  assert.equal(calls[0][3].dest, "00628131007191");
  assert.equal(result.order.order_id, "o_1");

  await assert.rejects(
    () => createSupplierOrder({
      order: { id: "PX-2", phone: "08131007191" },
      product: { sku: "TK5K" }
    }, { orderPath: "/v2/orders", request: async () => ({ code: "OK", data: {} }) }),
    SupplierOrderNotFoundError
  );
});

test("query prefers the provider order detail endpoint", async () => {
  const calls = [];
  const result = await querySupplierOrder("PX-1", "o_1", {
    orderPath: "/v2/orders",
    request: async (method, pathname, query) => {
      calls.push({ method, pathname, query });
      return { data: { order: { order_id: "o_1", client_order_id: "PX-1", status: "success" } } };
    }
  });
  assert.deepEqual(calls, [{ method: "GET", pathname: "/v2/orders/o_1", query: {} }]);
  assert.equal(result.lookup, "provider_order_id");
  assert.equal(result.status, "success");
});

test("query falls back to the same path with client_order_id", async () => {
  const calls = [];
  const result = await querySupplierOrder("PX-1", "o_stale", {
    orderPath: "/v2/orders",
    request: async (method, pathname, query) => {
      calls.push({ method, pathname, query });
      if (pathname.endsWith("/o_stale")) {
        const error = new Error("Supplier API 404");
        error.status = 404;
        throw error;
      }
      return { data: { items: [{ order_id: "o_real", client_order_id: "PX-1", status: "processing" }] } };
    }
  });
  assert.deepEqual(calls, [
    { method: "GET", pathname: "/v2/orders/o_stale", query: {} },
    { method: "GET", pathname: "/v2/orders", query: { client_order_id: "PX-1" } }
  ]);
  assert.equal(result.order.order_id, "o_real");
  assert.equal(result.lookup, "client_order_id");
});

test("query throws instead of fabricating a processing order", async () => {
  await assert.rejects(
    () => querySupplierOrder("PX-MISSING", "", {
      orderPath: "/v2/orders",
      request: async () => ({ code: "OK", data: { items: [] } })
    }),
    (error) => error instanceof SupplierOrderNotFoundError
      && error.code === "SUPPLIER_ORDER_NOT_FOUND"
      && /PX-MISSING/.test(error.message)
  );
});
