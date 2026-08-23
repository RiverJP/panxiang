import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPublicationTransition,
  isHistoricalPublishedProduct,
  migratePublicationHistory
} from "../src/catalog-publication.js";

const firstAt = "2026-08-20T01:02:03.000Z";
const republishedAt = "2026-08-21T02:03:04.000Z";
const unpublishedAt = "2026-08-22T03:04:05.000Z";

test("publishing a draft records its first and latest publication", () => {
  const draft = { sku: "TK5K", published: false, sortOrder: 0 };
  const published = applyPublicationTransition(draft, true, firstAt);

  assert.deepEqual(published, {
    sku: "TK5K",
    published: true,
    sortOrder: 0,
    everPublished: true,
    firstPublishedAt: firstAt,
    lastPublishedAt: firstAt,
    lastUnpublishedAt: null
  });
  assert.deepEqual(draft, { sku: "TK5K", published: false, sortOrder: 0 });
});

test("unpublishing and republishing preserve the first publication date", () => {
  const firstPublication = applyPublicationTransition(
    { sku: "TK5K", published: false, sortOrder: 0 },
    true,
    firstAt
  );
  const unpublished = applyPublicationTransition(firstPublication, false, unpublishedAt);
  const republished = applyPublicationTransition(unpublished, true, republishedAt);

  assert.equal(unpublished.firstPublishedAt, firstAt);
  assert.equal(unpublished.lastPublishedAt, firstAt);
  assert.equal(unpublished.lastUnpublishedAt, unpublishedAt);
  assert.equal(republished.firstPublishedAt, firstAt);
  assert.equal(republished.lastPublishedAt, republishedAt);
  assert.equal(republished.lastUnpublishedAt, unpublishedAt);
  assert.equal(isHistoricalPublishedProduct(unpublished), true);
  assert.equal(isHistoricalPublishedProduct(republished), false);
});

test("reapplying the current state is idempotent and keeps timestamps", () => {
  const published = {
    sku: "TK10K",
    published: true,
    everPublished: true,
    firstPublishedAt: firstAt,
    lastPublishedAt: firstAt,
    lastUnpublishedAt: null
  };

  assert.deepEqual(applyPublicationTransition(published, true, unpublishedAt), published);
  assert.notEqual(applyPublicationTransition(published, true, unpublishedAt), published);
});

test("migration marks a currently published legacy row as previously published", () => {
  const legacy = { sku: "TK20K", published: true };
  const migrated = migratePublicationHistory(legacy, firstAt);

  assert.equal(migrated.everPublished, true);
  assert.equal(migrated.firstPublishedAt, firstAt);
  assert.equal(migrated.lastPublishedAt, firstAt);
  assert.equal(migrated.lastUnpublishedAt, null);
  assert.deepEqual(legacy, { sku: "TK20K", published: true });
});

test("migration can infer hidden historical products from a positive legacy rank", () => {
  const migrated = migratePublicationHistory(
    { sku: "TK25K", published: false, sortOrder: 7 },
    unpublishedAt
  );

  assert.equal(migrated.everPublished, true);
  assert.equal(migrated.firstPublishedAt, unpublishedAt);
  assert.equal(migrated.lastPublishedAt, unpublishedAt);
  assert.equal(migrated.lastUnpublishedAt, unpublishedAt);
  assert.equal(isHistoricalPublishedProduct(migrated), true);
});

test("zero or invalid legacy ranks do not create publication history", () => {
  for (const sortOrder of [0, -1, "bad", null]) {
    const migrated = migratePublicationHistory(
      { sku: `SKU-${sortOrder}`, published: false, sortOrder },
      firstAt
    );
    assert.equal(migrated.everPublished, false);
    assert.equal(migrated.firstPublishedAt, null);
    assert.equal(migrated.lastPublishedAt, null);
    assert.equal(migrated.lastUnpublishedAt, null);
    assert.equal(isHistoricalPublishedProduct(migrated), false);
  }
});

test("migration preserves known history fields", () => {
  const product = {
    sku: "TK50K",
    published: false,
    everPublished: true,
    firstPublishedAt: firstAt,
    lastPublishedAt: republishedAt,
    lastUnpublishedAt: unpublishedAt
  };
  assert.deepEqual(migratePublicationHistory(product, "2026-08-23T00:00:00Z"), product);
});

test("invalid arguments are rejected", () => {
  assert.throws(() => migratePublicationHistory(null, firstAt), /商品对象/);
  assert.throws(() => migratePublicationHistory({}, "not-a-date"), /有效的日期/);
  assert.throws(() => applyPublicationTransition({}, "yes", firstAt), /布尔值/);
});
