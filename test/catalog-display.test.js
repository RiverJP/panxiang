import test from "node:test";
import assert from "node:assert/strict";
import {
  appendCatalogDisplayOrder,
  assignCatalogDisplayOrder,
  catalogDisplaySkus,
  catalogOrderRevision,
  catalogSkuSetsMatch,
  compareCatalogDisplayOrder,
  normalizeCatalogOrderRequest,
  normalizeCatalogSortOrder
} from "../src/catalog-display.js";

test("admin rank takes precedence over the popular badge", () => {
  const products = [
    { sku: "POPULAR", sortOrder: 2, popular: true, price: 1 },
    { sku: "FIRST", sortOrder: 1, popular: false, price: 9 }
  ];
  products.sort(compareCatalogDisplayOrder);
  assert.deepEqual(products.map((product) => product.sku), ["FIRST", "POPULAR"]);
});

test("legacy duplicate ranks have a deterministic fallback order", () => {
  const products = [
    { sku: "B", sortOrder: 0, popular: false, price: 5 },
    { sku: "A", sortOrder: 0, popular: false, price: 5 },
    { sku: "POPULAR", sortOrder: 0, popular: true, price: 99 }
  ];
  products.sort(compareCatalogDisplayOrder);
  assert.deepEqual(products.map((product) => product.sku), ["POPULAR", "A", "B"]);
});

test("invalid sort values are normalized safely", () => {
  assert.equal(normalizeCatalogSortOrder("not-a-number"), 0);
  assert.equal(normalizeCatalogSortOrder(10000), 9999);
  assert.equal(normalizeCatalogSortOrder(-10000), -9999);
  assert.equal(normalizeCatalogSortOrder(3.7), 4);
});

test("assigns one-based storefront ranks without changing hidden products", () => {
  const products = [
    { sku: "A", sortOrder: 8 },
    { sku: "B", sortOrder: 9 },
    { sku: "HIDDEN", sortOrder: 42 }
  ];
  assignCatalogDisplayOrder(products, ["B", "A"]);
  assert.deepEqual(products.map((product) => product.sortOrder), [2, 1, 42]);
});

test("published ordering can include temporarily unavailable products", () => {
  const products = [
    { sku: "VISIBLE", published: true, active: true, sortOrder: 2, price: 2 },
    { sku: "UNAVAILABLE", published: true, active: false, sortOrder: 1, price: null },
    { sku: "DRAFT", published: false, active: true, sortOrder: 0, price: 1 }
  ];
  const published = products.filter((product) => product.published);
  assert.deepEqual(catalogDisplaySkus(published), ["UNAVAILABLE", "VISIBLE"]);
});

test("newly published products compact legacy ranks and append in request order", () => {
  const products = [
    { sku: "A", sortOrder: 9999 },
    { sku: "B", sortOrder: 9999 },
    { sku: "C", sortOrder: -12 },
    { sku: "D", sortOrder: 42 }
  ];
  const order = appendCatalogDisplayOrder(products, ["B", "A"], ["D", "C"]);
  assert.deepEqual(order, ["B", "A", "D", "C"]);
  assert.deepEqual(products.map((product) => product.sortOrder), [2, 1, 4, 3]);
});

test("append rejects duplicate SKUs and ordering cannot exceed the stored rank range", () => {
  assert.throws(() => appendCatalogDisplayOrder([], [], ["A", "A"]), /不能重复/);
  assert.throws(
    () => assignCatalogDisplayOrder([], Array.from({ length: 10000 }, (_, index) => `SKU-${index}`)),
    /最多支持 9999/
  );
});

test("order request requires a JSON object, string SKUs, and a revision", () => {
  const revision = catalogOrderRevision(["A", "B"]);
  assert.deepEqual(
    normalizeCatalogOrderRequest({ skus: [" A ", "B"], expectedRevision: revision }),
    { skus: ["A", "B"], expectedRevision: revision }
  );
  assert.throws(() => normalizeCatalogOrderRequest(null), /JSON 对象/);
  assert.throws(() => normalizeCatalogOrderRequest([]), /JSON 对象/);
  assert.throws(() => normalizeCatalogOrderRequest({ skus: [1], expectedRevision: revision }), /字符串/);
  assert.throws(() => normalizeCatalogOrderRequest({ skus: ["A", " A "], expectedRevision: revision }), /重复/);
  assert.throws(() => normalizeCatalogOrderRequest({ skus: ["A"] }), /排序版本/);
  assert.throws(() => normalizeCatalogOrderRequest({ skus: ["A"], expectedRevision: "not-a-revision" }), /排序版本/);
});

test("order revisions are stable and detect stale order submissions", () => {
  const first = catalogOrderRevision(["A", "B"]);
  assert.equal(first, catalogOrderRevision(["A", "B"]));
  assert.notEqual(first, catalogOrderRevision(["B", "A"]));
});

test("SKU set matching is bidirectional and rejects duplicate lists", () => {
  assert.equal(catalogSkuSetsMatch(["A", "B"], ["B", "A"]), true);
  assert.equal(catalogSkuSetsMatch(["A", "B"], ["A", "C"]), false);
  assert.equal(catalogSkuSetsMatch(["A", "A"], ["A", "A"]), false);
});
