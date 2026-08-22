import test from "node:test";
import assert from "node:assert/strict";
import { listAllSupplierProducts } from "../src/provider.js";

async function withProductTypes(value, callback) {
  const previous = process.env.SUPPLIER_PRODUCT_TYPES;
  process.env.SUPPLIER_PRODUCT_TYPES = value;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.SUPPLIER_PRODUCT_TYPES;
    else process.env.SUPPLIER_PRODUCT_TYPES = previous;
  }
}

function queuedRequester(responses, calls) {
  return async (method, pathname, query) => {
    calls.push({ method, pathname, query: { ...query } });
    assert.ok(responses.length, "unexpected extra supplier request");
    return responses.shift();
  };
}

test("follows snake-case cursor pagination until the catalogue is complete", async () => {
  await withProductTypes("topup", async () => {
    const calls = [];
    const result = await listAllSupplierProducts({ request: queuedRequester([
      { data: { items: [{ sku: "TK2K" }], pagination: { next_cursor: "cursor-2", total: 2 } } },
      { data: { items: [{ sku: "TK5K" }], pagination: { next_cursor: null, has_more: false, total: 2 } } }
    ], calls) });

    assert.deepEqual(calls.map((call) => call.query), [
      { type: "topup" },
      { type: "topup", cursor: "cursor-2" }
    ]);
    assert.deepEqual(result.items.map((item) => item.sku), ["TK2K", "TK5K"]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.pagination[0].strategies, ["cursor"]);
  });
});

test("follows camel-case page tokens with the matching request parameter", async () => {
  await withProductTypes("topup", async () => {
    const calls = [];
    const result = await listAllSupplierProducts({ request: queuedRequester([
      { data: { products: [{ sku: "A" }], nextPageToken: "token-b" } },
      { data: { products: [{ sku: "B" }], nextPageToken: "", totalCount: 2 } }
    ], calls) });

    assert.deepEqual(calls[1].query, { type: "topup", pageToken: "token-b" });
    assert.equal(result.complete, true);
    assert.deepEqual(result.pagination[0].strategies, ["token"]);
  });
});

test("follows current/last page metadata", async () => {
  await withProductTypes("topup", async () => {
    const calls = [];
    const result = await listAllSupplierProducts({ request: queuedRequester([
      { data: { items: [{ sku: "A" }], meta: { current_page: 1, last_page: 2, total: 2 } } },
      { data: { items: [{ sku: "B" }], meta: { current_page: 2, last_page: 2, total: 2 } } }
    ], calls) });

    assert.deepEqual(calls[1].query, { type: "topup", page: 2 });
    assert.equal(result.complete, true);
    assert.deepEqual(result.pagination[0].strategies, ["page"]);
  });
});

test("follows offset pagination", async () => {
  await withProductTypes("topup", async () => {
    const calls = [];
    const result = await listAllSupplierProducts({ request: queuedRequester([
      { items: [{ sku: "A" }], meta: { offset: 0, limit: 1, has_more: true, total: 2 } },
      { items: [{ sku: "B" }], meta: { offset: 1, limit: 1, has_more: false, total: 2 } }
    ], calls) });

    assert.deepEqual(calls[1].query, { type: "topup", offset: 1 });
    assert.equal(result.complete, true);
    assert.deepEqual(result.pagination[0].strategies, ["offset"]);
  });
});

test("infers the next offset from offset, limit and total", async () => {
  await withProductTypes("topup", async () => {
    const calls = [];
    const result = await listAllSupplierProducts({ request: queuedRequester([
      { items: [{ sku: "A" }], meta: { offset: 0, limit: 1, total: 2 } },
      { items: [{ sku: "B" }], meta: { offset: 1, limit: 1, total: 2 } }
    ], calls) });

    assert.deepEqual(calls[1].query, { type: "topup", offset: 1 });
    assert.equal(result.complete, true);
  });
});

test("respects an explicit has_more false even if a stale cursor is present", async () => {
  await withProductTypes("topup", async () => {
    let calls = 0;
    const result = await listAllSupplierProducts({ request: async () => {
      calls += 1;
      return { items: [{ sku: "A" }], next_cursor: "stale", has_more: false };
    } });
    assert.equal(calls, 1);
    assert.equal(result.complete, true);
  });
});

test("follows links.next without allowing it to change the product type", async () => {
  await withProductTypes("topup", async () => {
    const calls = [];
    const result = await listAllSupplierProducts({ request: queuedRequester([
      { data: { items: [{ sku: "A" }], links: { next: "https://api.reloadn.com/v1/products?type=topup&page=2&limit=1" } } },
      { data: { items: [{ sku: "B" }], links: { next: null }, total: 2 } }
    ], calls) });

    assert.deepEqual(calls[1].query, { type: "topup", page: "2", limit: "1" });
    assert.equal(result.complete, true);
    assert.deepEqual(result.pagination[0].strategies, ["link"]);
  });
});

test("marks an unpaginated response incomplete instead of retiring missing products", async () => {
  await withProductTypes("topup", async () => {
    const result = await listAllSupplierProducts({ request: async () => ({ data: { items: [{ sku: "A" }] } }) });
    assert.equal(result.complete, false);
    assert.equal(result.pagination[0].complete, false);
  });
});

test("rejects has_more when the provider gives no usable continuation", async () => {
  await withProductTypes("topup", async () => {
    await assert.rejects(
      () => listAllSupplierProducts({ request: async () => ({ data: { items: [{ sku: "A" }], has_more: true } }) }),
      /未返回可识别的分页参数/
    );
  });
});

test("rejects a next link that silently changes the configured product type", async () => {
  await withProductTypes("topup", async () => {
    await assert.rejects(
      () => listAllSupplierProducts({ request: async () => ({
        data: {
          items: [{ sku: "A" }],
          links: { next: "/v1/products?type=data&page=2" }
        }
      }) }),
      /改变了查询类型/
    );
  });
});
