import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIFE_SERVICES,
  MAX_LIFE_SERVICES,
  compareLifeServices,
  normalizeLifeService,
  normalizeLifeServices,
  publicLifeServices,
  validateLifeServicesStrict
} from "../src/life-services.js";

test("missing persisted data receives independent default service records", () => {
  const first = normalizeLifeServices(null);
  const second = normalizeLifeServices(undefined);
  assert.deepEqual(first, DEFAULT_LIFE_SERVICES);
  assert.notEqual(first, second);
  assert.notEqual(first[0], second[0]);
});

test("service validation requires safe immutable IDs and complete typed fields", () => {
  assert.deepEqual(normalizeLifeService({
    id: "service_123",
    title: "  手机解锁协助  ",
    description: "  网络锁\n咨询  ",
    enabled: true,
    sortOrder: 20
  }), {
    id: "service_123",
    title: "手机解锁协助",
    description: "网络锁 咨询",
    enabled: true,
    sortOrder: 20
  });
  assert.equal(normalizeLifeService({ id: "bad/id", title: "服务", description: "", enabled: true, sortOrder: 1 }), null);
  assert.equal(normalizeLifeService({ id: "safe", title: "", description: "", enabled: true, sortOrder: 1 }), null);
  assert.equal(normalizeLifeService({ id: "safe", title: "服务", description: "", enabled: "yes", sortOrder: 1 }), null);
  assert.equal(normalizeLifeService({ id: "safe", title: "服务", description: "", enabled: true, sortOrder: 1.5 }), null);
});

test("new service payloads can be normalized before the server generates an ID", () => {
  assert.deepEqual(normalizeLifeService({
    title: "签证咨询",
    description: "材料和流程咨询",
    enabled: false,
    sortOrder: 30
  }, { requireId: false }), {
    title: "签证咨询",
    description: "材料和流程咨询",
    enabled: false,
    sortOrder: 30
  });
});

test("stored services discard invalid and duplicate IDs without exceeding the limit", () => {
  const value = [
    { id: "one", title: "第一项", description: "", enabled: true, sortOrder: 10 },
    { id: "one", title: "重复项", description: "", enabled: true, sortOrder: 20 },
    { id: "two", title: "第二项", description: "", enabled: false, sortOrder: 30 },
    { id: "bad/id", title: "无效项", description: "", enabled: true, sortOrder: 40 },
    ...Array.from({ length: MAX_LIFE_SERVICES + 20 }, (_, index) => ({
      id: `extra_${index}`,
      title: `服务 ${index}`,
      description: "",
      enabled: true,
      sortOrder: 100 + index
    }))
  ];
  const normalized = normalizeLifeServices(value);
  assert.equal(normalized.filter((service) => service.id === "one").length, 1);
  assert.equal(normalized.some((service) => service.id === "bad/id"), false);
  assert.ok(normalized.length <= MAX_LIFE_SERVICES);
});

test("public services include only enabled records, sorted deterministically", () => {
  const services = [
    { id: "later", title: "稍后", description: "B", enabled: true, sortOrder: 20 },
    { id: "hidden", title: "隐藏", description: "C", enabled: false, sortOrder: 1 },
    { id: "first", title: "优先", description: "A", enabled: true, sortOrder: 10 }
  ];
  assert.deepEqual(publicLifeServices(services), [
    { id: "first", title: "优先", description: "A" },
    { id: "later", title: "稍后", description: "B" }
  ]);
  assert.deepEqual([...services].sort(compareLifeServices).map((service) => service.id), ["hidden", "first", "later"]);
});

test("strict persisted-service validation rejects data that normalization would discard", () => {
  const valid = [
    { id: "one", title: "第一项", description: "说明", enabled: true, sortOrder: 10 },
    { id: "two", title: "第二项", description: "", enabled: false, sortOrder: 20 }
  ];
  assert.deepEqual(validateLifeServicesStrict(valid), valid);
  assert.throws(() => validateLifeServicesStrict({}), /必须是数组/);
  assert.throws(() => validateLifeServicesStrict([...valid, { ...valid[0] }]), /重复 ID/);
  assert.throws(() => validateLifeServicesStrict([{ ...valid[0], title: " 第一项 " }]), /名称格式无效/);
  assert.throws(() => validateLifeServicesStrict([{ ...valid[0], sortOrder: "10" }]), /排序格式无效/);
  assert.throws(() => validateLifeServicesStrict([{ ...valid[0], extra: true }]), /未知字段/);
  assert.throws(() => validateLifeServicesStrict(Array.from({ length: MAX_LIFE_SERVICES + 1 }, (_, index) => ({
    id: `service_${index}`,
    title: `服务 ${index}`,
    description: "",
    enabled: true,
    sortOrder: index
  }))), /超过 100 项上限/);
});
