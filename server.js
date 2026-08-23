import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalog, findProduct, normalizePhone, detectOperator, createSupplierOrder, querySupplierOrder, verifyWebhookSignature, listAllSupplierProducts } from "./src/provider.js";
import { createJsapiPrepay, buildJsapiPayParams, queryJsapiTransactionByOutTradeNo, verifyAndDecryptNotification } from "./src/wechat.js";
import { validateSuccessfulWechatPayment, WechatPaymentValidationError } from "./src/wechat-payment.js";
import { createOrderStore } from "./src/order-store.js";
import {
  DEFAULT_AUTO_PRICING_RULE,
  MAX_FIXED_MARKUP_IDR,
  MAX_PERCENT_MARKUP,
  MISSING_FROM_COMPLETE_CATALOG_REASON,
  supplierBuyPriceIdr,
  supplierProductAvailability,
  normalizeStoredSupplierAvailability,
  normalizeAutoPricingRule,
  effectiveFxRateTimestamp,
  autoPriceState,
  shouldRefreshFxRate
} from "./src/catalog-pricing.js";
import {
  appendCatalogDisplayOrder,
  assignCatalogDisplayOrder,
  catalogDisplaySkus,
  catalogOrderRevision,
  catalogSkuSetsMatch,
  compareCatalogDisplayOrder,
  normalizeCatalogOrderRequest,
  normalizeCatalogSortOrder
} from "./src/catalog-display.js";
import { defaultCustomerServiceUrl, normalizeCustomerServiceUrl } from "./src/public-config.js";
import { MAX_LIFE_SERVICES, compareLifeServices, normalizeLifeService, normalizeLifeServices, publicLifeServices, validateLifeServicesStrict } from "./src/life-services.js";
import {
  isActiveRechargeStatus,
  nextPaymentPollAt,
  nextProcessingPollAt,
  shouldActivelyReconcilePayment,
  shouldActivelyRefreshOrder,
  supplierStatusToLocal
} from "./src/order-status.js";
import { fetchFxQuote, selectFxProvider } from "./src/fx-provider.js";
import { applyPublicationTransition, migratePublicationHistory } from "./src/catalog-publication.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 3000);
const adminSessions = new Map();
const adminCaptchas = new Map();
const adminLoginAttempts = new Map();
const adminCaptchaRequests = new Map();
const adminCookieName = "__Host-px_admin_session";
const wechatCookieName = "px_wechat_session";
const wechatSessionTtlSeconds = Math.min(180 * 24 * 60 * 60, Math.max(60 * 60, Number(process.env.WECHAT_SESSION_TTL_SECONDS) || 30 * 24 * 60 * 60));
const dataDir = path.join(root, "data");
const productsFile = path.join(dataDir, "products.json");
const fxFile = path.join(dataDir, "fx.json");
const ordersFile = path.join(dataDir, "orders.json");
const syncMetaFile = path.join(dataDir, "sync-meta.json");
const auditFile = path.join(dataDir, "admin-audit.json");
const lifeServicesFile = path.join(dataDir, "life-services.json");
const orderStore = createOrderStore({ dbPath: path.join(dataDir, "orders.sqlite"), legacyJsonPath: ordersFile });
const rechargeLocks = new Set();
const paymentReconciliationLocks = new Set();
let catalogMutationTail = Promise.resolve();
let fxMutationTail = Promise.resolve();
let lifeServicesMutationTail = Promise.resolve();
let auditMutationTail = Promise.resolve();
let lastScheduledFxRefreshAttemptAt = 0;

async function withCatalogMutationLock(work) {
  const previous = catalogMutationTail;
  let release;
  catalogMutationTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

async function withFxMutationLock(work) {
  const previous = fxMutationTail;
  let release;
  fxMutationTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

async function withLifeServicesMutationLock(work) {
  const previous = lifeServicesMutationTail;
  let release;
  lifeServicesMutationTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}

async function readJsonStrict(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`${path.basename(file)} 无法读取或 JSON 已损坏，请先恢复该文件`, { cause: error });
  }
}

async function writeJson(file, value) {
  await fs.mkdir(dataDir, { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2));
  await fs.rename(temporary, file);
}

function fxStateForAdmin(fx) {
  const state = fx && typeof fx === "object" && !Array.isArray(fx) ? fx : {};
  let configuredProvider = null;
  let providerConfigurationError = null;
  try {
    configuredProvider = selectFxProvider(process.env);
  } catch (error) {
    providerConfigurationError = String(error?.message || "汇率服务配置无效");
  }
  const storedSource = String(state.source || "").trim();
  const safeStoredSource = /^https?:\/\//i.test(storedSource)
    ? (state.provider === "open-er-api"
      ? "open.er-api /v6/latest/CNY (daily fallback)"
      : state.provider === "exchange-rate-api"
        ? "ExchangeRate-API /v6/latest/CNY"
        : "legacy FX provider")
    : storedSource;
  const normalizedPricing = normalizeAutoPricingRule(state.autoPricing);
  const effectiveState = {
    ...state,
    source: safeStoredSource || null,
    provider: state.provider || configuredProvider?.provider || null,
    configuredProvider: configuredProvider?.provider || null,
    providerSource: configuredProvider?.source || null,
    recommendedRefreshMinutes: Number(state.recommendedRefreshMinutes)
      || configuredProvider?.recommendedRefreshMinutes
      || null,
    degraded: typeof state.degraded === "boolean"
      ? state.degraded
      : Boolean(configuredProvider?.degraded),
    providerConfigurationError,
    autoPricing: normalizedPricing || state.autoPricing || { ...DEFAULT_AUTO_PRICING_RULE }
  };
  const pricing = autoPriceState({ buyPriceIdr: 10_000 }, effectiveState);
  return {
    ...effectiveState,
    autoPricingValid: Boolean(normalizedPricing),
    pricingReady: pricing.status === "ready",
    pricingHealth: pricing.status,
    pricingHealthReason: pricing.reason,
    effectiveRateTimestamp: effectiveFxRateTimestamp(effectiveState)
  };
}

function fxRefreshIntervalMinutes(fx) {
  try {
    const selected = selectFxProvider(process.env);
    const persisted = Number(fx?.recommendedRefreshMinutes);
    if (fx?.provider === selected.provider && Number.isFinite(persisted) && persisted >= 5 && persisted <= 24 * 60) {
      return persisted;
    }
    return selected.recommendedRefreshMinutes;
  } catch {
    const persisted = Number(fx?.recommendedRefreshMinutes);
    return Number.isFinite(persisted) && persisted >= 5 && persisted <= 24 * 60 ? persisted : 8 * 60;
  }
}

async function appendAudit(action, details = {}) {
  const previous = auditMutationTail;
  let release;
  auditMutationTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const entries = await readJson(auditFile, []);
    entries.push({ action, details, at: new Date().toISOString() });
    await writeJson(auditFile, entries.slice(-1000));
  } catch (error) {
    // Auditing must never make an already-applied business change look like it
    // failed to the operator. Keep the failure visible in the service log.
    console.error("Admin audit write failed:", error.message);
  } finally {
    release();
  }
}

async function readLifeServices({ strict = false } = {}) {
  if (!strict) return normalizeLifeServices(await readJson(lifeServicesFile, null));
  const missing = Symbol("missing-life-services");
  const stored = await readJsonStrict(lifeServicesFile, missing);
  return stored === missing ? normalizeLifeServices(null) : validateLifeServicesStrict(stored);
}

function sortedLifeServices(services) {
  return [...services].sort(compareLifeServices);
}

function nextLifeServiceSortOrder(services) {
  const highest = services.reduce((maximum, service) => Math.max(maximum, Number(service.sortOrder) || 0), 0);
  return Math.min(1_000_000, highest + 10);
}

function lifeServiceInput(input, { existing = null } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "请求内容必须是 JSON 对象" };
  }
  if (Object.hasOwn(input, "id")) return { error: "服务 ID 由系统生成，不能自行设置或修改" };
  const allowed = new Set(["title", "description", "enabled", "sortOrder"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) return { error: `不支持的字段：${unknown.join("、")}` };
  if (existing && Object.keys(input).length === 0) return { error: "请至少提交一个需要修改的字段" };
  if ((!existing || Object.hasOwn(input, "title")) && (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 40)) {
    return { error: "服务名称必须是 1–40 个字符" };
  }
  if (Object.hasOwn(input, "description") && (typeof input.description !== "string" || input.description.trim().length > 240)) {
    return { error: "服务说明不能超过 240 个字符" };
  }
  if (Object.hasOwn(input, "enabled") && typeof input.enabled !== "boolean") {
    return { error: "启用状态必须是布尔值" };
  }
  if (Object.hasOwn(input, "sortOrder")) {
    const sortOrder = Number(input.sortOrder);
    if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 1_000_000) {
      return { error: "排序值必须是 0–1000000 的整数" };
    }
  }
  const candidate = {
    ...(existing || {}),
    ...(Object.hasOwn(input, "title") ? { title: input.title } : {}),
    ...(Object.hasOwn(input, "description") ? { description: input.description } : {}),
    ...(Object.hasOwn(input, "enabled") ? { enabled: input.enabled } : {}),
    ...(Object.hasOwn(input, "sortOrder") ? { sortOrder: Number(input.sortOrder) } : {})
  };
  const service = normalizeLifeService(candidate, { requireId: Boolean(existing) });
  return service ? { service } : { error: "服务资料不完整或格式不正确" };
}

function lifeServiceIdFromPath(pathname) {
  const match = pathname.match(/^\/api\/admin\/services\/([^/]+)$/);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return /^[a-zA-Z0-9_-]{1,80}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function migrateStoredProductAvailability() {
  const products = await readJson(productsFile, null);
  if (!Array.isArray(products)) return;
  const migrated = products.map(normalizeStoredSupplierAvailability);
  if (JSON.stringify(migrated) === JSON.stringify(products)) return;
  const restoredCount = products.filter((product, index) => product?.active !== true && migrated[index]?.active === true).length;
  const confirmedMissingCount = migrated.filter((product) => product.active === false).length;
  await writeJson(productsFile, migrated);
  await appendAudit("products.availability_migrated", { restoredCount, confirmedMissingCount });
}

async function migrateStoredPublicationHistory() {
  const products = await readJson(productsFile, null);
  if (!Array.isArray(products)) return;
  const migratedAt = new Date().toISOString();
  const migrated = products.map((product) => migratePublicationHistory(product, migratedAt));
  if (JSON.stringify(migrated) === JSON.stringify(products)) return;
  const inferredHistoricalCount = migrated.filter((product, index) => (
    product.everPublished === true && products[index]?.everPublished !== true
  )).length;
  await writeJson(productsFile, migrated);
  await appendAudit("products.publication_history_migrated", {
    count: migrated.length,
    inferredHistoricalCount,
    migratedAt
  });
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return [part, ""];
    try { return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]; }
    catch { return [part.slice(0, index), ""]; }
  }));
}

function safeReturnPath(value) {
  const candidate = String(value || "/").trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\") || /[\r\n]/.test(candidate)) return "/";
  try {
    const parsed = new URL(candidate, "https://reloadb.invalid");
    if (parsed.origin !== "https://reloadb.invalid") return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

function getWechatIdentity(req, options = {}) {
  try {
    const token = parseCookies(req)[wechatCookieName];
    if (!token) return null;
    const session = orderStore.getWechatSession(token, { touch: options.touch !== false });
    return session?.user ? { token, session, user: session.user } : null;
  } catch {
    // Cookies are untrusted input. A malformed/oversized cookie is simply not an authenticated session.
    return null;
  }
}

function requireWechatIdentity(req, res) {
  const identity = getWechatIdentity(req);
  if (!identity) {
    json(res, 401, { ok: false, code: "WECHAT_AUTH_REQUIRED", message: "请在微信服务号内重新打开页面完成授权" });
    return null;
  }
  return identity;
}

function publicWechatUser(user) {
  return user ? { id: user.id, hasUnionId: Boolean(user.unionid) } : null;
}

function orderOwnedByIdentity(order, identity) {
  if (!order || !identity?.user) return false;
  if (order.userId) return safeEqualText(order.userId, identity.user.id);
  return Boolean(order.payerOpenid && safeEqualText(order.payerOpenid, identity.user.openid));
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function base32Decode(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(value || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const character of clean) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("invalid base32 secret");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

function totpAt(secret, timestamp) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30000)));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(number).padStart(6, "0");
}

function verifyTotp(code) {
  const secret = process.env.ADMIN_TOTP_SECRET;
  const normalized = String(code || "").replace(/\s/g, "");
  if (!secret || !/^\d{6}$/.test(normalized)) return false;
  const now = Date.now();
  return [-1, 0, 1].some((window) => safeEqualText(normalized, totpAt(secret, now + window * 30000)));
}

function verifyAdminPassword(password) {
  const encoded = String(process.env.ADMIN_PASSWORD_HASH || "");
  if (encoded.startsWith("scrypt$")) {
    try {
      const [, saltHex, expectedHex] = encoded.split("$");
      const expected = Buffer.from(expectedHex, "hex");
      const actual = crypto.scryptSync(String(password || ""), Buffer.from(saltHex, "hex"), expected.length);
      return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
    } catch { return false; }
  }
  return safeEqualText(password, process.env.ADMIN_PASSWORD || "");
}

function clientIp(req) {
  return String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function cleanupAdminState() {
  const now = Date.now();
  for (const [key, value] of adminCaptchas) if (value.expiresAt <= now) adminCaptchas.delete(key);
  for (const [key, value] of adminSessions) if (value.expiresAt <= now) adminSessions.delete(key);
  for (const [key, value] of adminLoginAttempts) if ((value.lockedUntil || value.firstAt + 15 * 60 * 1000) <= now) adminLoginAttempts.delete(key);
  for (const [key, value] of adminCaptchaRequests) if (value.windowStartedAt + 60 * 1000 <= now) adminCaptchaRequests.delete(key);
}

function getAdminSession(req) {
  cleanupAdminState();
  const token = parseCookies(req)[adminCookieName];
  const session = token ? adminSessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now()) return null;
  return { token, ...session };
}

function requireAdmin(req, res, requireCsrf = false) {
  const session = getAdminSession(req);
  if (!session) {
    json(res, 401, { ok: false, message: "登录状态已失效，请重新登录" });
    return null;
  }
  if (requireCsrf && !safeEqualText(req.headers["x-csrf-token"], session.csrfToken)) {
    json(res, 403, { ok: false, message: "安全校验失败，请刷新页面后重试" });
    return null;
  }
  return session;
}

function captchaHash(id, code) {
  return crypto.createHash("sha256").update(`${id}:${String(code).toUpperCase()}`).digest("hex");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function createCaptchaPng(code) {
  const width = 150, height = 54;
  const pixels = Buffer.alloc(width * height * 4);
  const background = [crypto.randomInt(241, 249), crypto.randomInt(244, 251), crypto.randomInt(247, 253)];
  const setPixel = (x, y, color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (Math.floor(y) * width + Math.floor(x)) * 4;
    pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2]; pixels[offset + 3] = 255;
  };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) setPixel(x, y, background);
  const line = (x0, y0, x1, y1, color, thickness = 1) => {
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let error = dx + dy;
    while (true) {
      for (let tx = -thickness; tx <= thickness; tx += 1) for (let ty = -thickness; ty <= thickness; ty += 1) setPixel(x0 + tx, y0 + ty, color);
      if (x0 === x1 && y0 === y1) break;
      const doubled = 2 * error;
      if (doubled >= dy) { error += dy; x0 += sx; }
      if (doubled <= dx) { error += dx; y0 += sy; }
    }
  };
  for (let index = 0; index < 8; index += 1) line(crypto.randomInt(0, width), crypto.randomInt(0, height), crypto.randomInt(0, width), crypto.randomInt(0, height), [crypto.randomInt(178, 225), crypto.randomInt(180, 226), crypto.randomInt(190, 235)]);
  const segmentMap = { "0": "abcdef", "1": "bc", "2": "abdeg", "3": "abcdg", "4": "bcfg", "5": "acdfg", "6": "acdefg", "7": "abc", "8": "abcdefg", "9": "abcdfg" };
  const segments = { a: [4, 0, 14, 2], b: [18, 3, 2, 14], c: [18, 21, 2, 14], d: [4, 36, 14, 2], e: [1, 21, 2, 14], f: [1, 3, 2, 14], g: [4, 18, 14, 2] };
  const rect = (x, y, rectWidth, rectHeight, color) => { for (let ry = 0; ry < rectHeight; ry += 1) for (let rx = 0; rx < rectWidth; rx += 1) setPixel(x + rx, y + ry, color); };
  [...code].forEach((digit, index) => {
    const startX = 8 + index * 28 + crypto.randomInt(-1, 2), startY = 8 + crypto.randomInt(-2, 3);
    const color = [crypto.randomInt(24, 75), crypto.randomInt(31, 82), crypto.randomInt(48, 100)];
    for (const segment of segmentMap[digit]) { const [x, y, rectWidth, rectHeight] = segments[segment]; rect(startX + x, startY + y, rectWidth, rectHeight, color); }
  });
  for (let index = 0; index < 55; index += 1) setPixel(crypto.randomInt(0, width), crypto.randomInt(0, height), [crypto.randomInt(90, 190), crypto.randomInt(90, 190), crypto.randomInt(100, 200)]);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    raw[rowOffset] = 0;
    pixels.copy(raw, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND")]);
}

function createAdminCaptcha() {
  cleanupAdminState();
  while (adminCaptchas.size >= 1000) adminCaptchas.delete(adminCaptchas.keys().next().value);
  const alphabet = "23456789";
  const code = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join("");
  const id = crypto.randomBytes(18).toString("hex");
  adminCaptchas.set(id, { hash: captchaHash(id, code), expiresAt: Date.now() + 5 * 60 * 1000 });
  return { captchaId: id, image: `data:image/png;base64,${createCaptchaPng(code).toString("base64")}`, expiresIn: 300 };
}

function allowCaptchaRequest(ip) {
  const now = Date.now();
  const current = adminCaptchaRequests.get(ip);
  const request = !current || now - current.windowStartedAt >= 60 * 1000 ? { count: 0, windowStartedAt: now } : current;
  request.count += 1;
  adminCaptchaRequests.set(ip, request);
  return request.count <= 30;
}

function loginLockSeconds(ip) {
  const attempt = adminLoginAttempts.get(ip);
  if (!attempt?.lockedUntil) return 0;
  return Math.max(0, Math.ceil((attempt.lockedUntil - Date.now()) / 1000));
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const current = adminLoginAttempts.get(ip);
  const attempt = !current || now - current.firstAt > 15 * 60 * 1000 ? { count: 0, firstAt: now, lockedUntil: 0 } : current;
  attempt.count += 1;
  if (attempt.count >= 5) attempt.lockedUntil = now + 15 * 60 * 1000;
  adminLoginAttempts.set(ip, attempt);
}

const telecomOperators = [
  { canonical: "Telkomsel", aliases: /telkomsel|simpati|kartu\s*as|by\.?u/i, sku: /^TK\d/i },
  { canonical: "Indosat", aliases: /indosat|im3|mentari/i, sku: /^(IS|IM3)\d/i },
  { canonical: "XL", aliases: /\bxl\b|xl\s*axiata/i, sku: /^XL\d/i },
  { canonical: "AXIS", aliases: /\baxis\b/i, sku: /^AX\d/i },
  { canonical: "Tri", aliases: /\btri\b|three|3\s*indonesia/i, sku: /^(TRI|THREE)\d/i },
  { canonical: "Smartfren", aliases: /smartfren/i, sku: /^SF\d/i }
];
const blockedProductPattern = /game|gaming|gift\s*card|steam|google\s*play|pln|listrik|e-?wallet|\bdana\b|\bovo\b|gopay|shopee\s*pay|television|\btv\b|streaming|insurance|bpjs/i;
const dataProductPattern = /\bdata\b|internet|kuota|quota|paket|package|combo|unlimited|\d+(?:[.,]\d+)?\s*(?:gb|mb)\b/i;
const airtimeProductPattern = /top\s*up|topup|pulsa|airtime|reload|phone\s*credit|saldo/i;
const unsupportedTelecomPattern = /sms\s*only|sms\s*package|voice\s*only|telepon\s*only/i;

function productText(item) {
  return [item.sku, item.code, item.product_code, item.name, item.product_name, item.title, item.description, item.operator, item.telco, item.provider, item.brand, item.network, item.type, item.product_type, item.service_type, item.kind, item.category, item.subcategory]
    .filter((value) => value !== null && value !== undefined)
    .join(" ");
}

function inferSupplierOperator(item) {
  const sku = String(item.sku || item.code || item.product_code || item.id || "");
  const text = productText(item);
  return telecomOperators.find((definition) => definition.sku.test(sku))?.canonical
    || telecomOperators.find((definition) => definition.aliases.test(text))?.canonical
    || "";
}

function supplierOperatorLabel(item) {
  return inferSupplierOperator(item)
    || String(item.operator || item.telco || item.provider || item.brand || item.network || "").trim()
    || "未知运营商";
}

function inferSupplierCategory(item, operator) {
  if (!operator) return "unclassified";
  const text = productText(item);
  if (blockedProductPattern.test(text) || unsupportedTelecomPattern.test(text)) return "unclassified";
  if (dataProductPattern.test(text)) return "data";
  if (airtimeProductPattern.test(text)) return "airtime";
  const structuredType = String(item.type || item.product_type || item.service_type || item.kind || item.category || item.subcategory || "").toLowerCase();
  if (["data", "internet", "quota", "package"].some((value) => structuredType.includes(value))) return "data";
  if (["topup", "airtime", "pulsa", "reload"].some((value) => structuredType.includes(value))) return "airtime";
  if (/^(TK|IS|IM3|XL|AX|TRI|THREE|SF)\d/i.test(String(item.sku || item.code || ""))) return "airtime";
  return "unclassified";
}

function indonesiaCountryMatches(item, operator) {
  const values = [item.country_code, item.countryCode, item.country, item.iso_country, item.isoCountry]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => String(value).trim());
  if (!values.length) return Boolean(operator);
  return values.some((value) => /^(ID|IDN|360|62|\+62)$/i.test(value) || /indonesia/i.test(value));
}

function supplierCountryLabel(item) {
  return String(item.country_code || item.countryCode || item.country || item.iso_country || item.isoCountry || "").trim();
}

function normalizeSupplierProduct(item) {
  const sku = String(item.sku || item.code || item.product_code || item.id || "").trim();
  const inferredOperator = inferSupplierOperator(item);
  const operator = supplierOperatorLabel(item);
  const category = inferSupplierCategory(item, inferredOperator);
  const text = productText(item);
  const countryOk = indonesiaCountryMatches(item, inferredOperator);
  const blocked = blockedProductPattern.test(text);
  const sourceEligible = Boolean(sku && countryOk && inferredOperator && ["airtime", "data"].includes(category) && !blocked);
  const buyPriceIdr = supplierBuyPriceIdr(item, { allowUndeclaredGeneric: sourceEligible });
  // Catalogue presence is the availability signal. ReloadN status fields are
  // intentionally ignored because they can describe a channel rather than the
  // SKU's ability to accept an API order.
  const availability = supplierProductAvailability(item);
  const name = String(item.name || item.title || item.product_name || sku);
  return {
    sku,
    countryCode: countryOk ? "ID" : "",
    sourceCountry: supplierCountryLabel(item),
    operator,
    category,
    kind: category === "airtime" ? "话费" : category === "data" ? "流量" : "待分类",
    name,
    buyPriceIdr,
    active: availability.active,
    statusKnown: availability.statusKnown,
    unavailableReason: availability.unavailableReason,
    sourceEligible,
    excludeReason: sourceEligible ? "" : !countryOk ? "未自动识别为印尼商品" : !inferredOperator ? "未自动识别运营商" : blocked ? "非通信充值商品" : "未自动识别为话费或流量套餐",
    raw: item
  };
}

function productCanAppearInCatalog(product) {
  return ["airtime", "data"].includes(String(product?.category || ""))
    && Boolean(String(product?.operator || "").trim())
    && String(product?.operator || "").trim() !== "未知运营商"
    && ((product?.sourceEligible ?? product?.eligible) === true || product?.manualCatalogApproved === true);
}

function getAutoPriceCny(product, fx) {
  return autoPriceState(product, fx).priceCny;
}

function getSellPriceCny(product, fx) {
  if (product?.priceMode === "manual") {
    if (product.priceCny === null || product.priceCny === undefined || product.priceCny === "") return null;
    const manualPrice = Number(product.priceCny);
    return Number.isFinite(manualPrice) && manualPrice > 0 ? manualPrice : null;
  }
  return getAutoPriceCny(product, fx);
}

function isProductStorefrontVisible(product, fx) {
  return Boolean(product?.published)
    && product?.active === true
    && productCanAppearInCatalog(product)
    && getSellPriceCny(product, fx) !== null;
}

function adminProductView(product, fx) {
  const { raw: _raw, ...view } = product;
  const pricing = autoPriceState(product, fx);
  return {
    ...view,
    sellPriceCny: getSellPriceCny(product, fx),
    storefrontVisible: isProductStorefrontVisible(product, fx),
    autoPriceCny: pricing.priceCny,
    autoPriceStatus: pricing.status,
    autoPriceReason: pricing.reason
  };
}

function publishedCatalogOrder(products, fx) {
  return catalogDisplaySkus(products
    .filter((product) => Boolean(product?.published))
    .map((product) => ({
      id: String(product?.sku || ""),
      sku: String(product?.sku || ""),
      sortOrder: product?.sortOrder,
      popular: Boolean(product?.popular),
      price: getSellPriceCny(product, fx)
    })));
}

function publishedCatalogOrderState(products, fx) {
  const skus = publishedCatalogOrder(products, fx);
  return { skus, revision: catalogOrderRevision(skus) };
}

function appendNewlyPublishedProducts(products, skus, fx) {
  if (skus.length === 0) return publishedCatalogOrder(products, fx);
  return appendCatalogDisplayOrder(products, publishedCatalogOrder(products, fx), skus);
}

async function refreshFxRate(source = "manual") {
  const refreshStartedAt = Date.now();
  // The network request deliberately stays outside the mutation lock. Only
  // reading the current record, applying safety checks and writing the new
  // record need serialization; a slow rate provider must not block a manual
  // rate or pricing-rule update.
  const quote = await fetchFxQuote({
    env: process.env,
    fetchImpl: fetch,
    now: refreshStartedAt,
    signal: AbortSignal.timeout(10000)
  });
  const idrPerCny = Number(quote.idrPerCny);
  const minRate = Number(process.env.FX_IDR_CNY_MIN || 1000);
  const maxRate = Number(process.env.FX_IDR_CNY_MAX || 5000);
  if (!Number.isFinite(idrPerCny) || idrPerCny < minRate || idrPerCny > maxRate) throw new Error("汇率响应超出安全范围，未更新自动售价");
  const providerUpdatedAt = quote.providerUpdatedAt;
  const providerNextUpdateAt = quote.providerNextUpdateAt;

  return withFxMutationLock(async () => {
    const previous = await readJsonStrict(fxFile, null);
    const previousUpdatedAt = Date.parse(previous?.updatedAt || "");
    if (previous?.updateMode === "manual" && Number.isFinite(previousUpdatedAt) && previousUpdatedAt > refreshStartedAt) {
      throw new Error("汇率在本次获取期间已被手动修改，在线报价未覆盖人工设置");
    }
    const previousRate = Number(previous?.idrPerCny);
    const maxChangeRatio = Number(process.env.FX_MAX_CHANGE_RATIO || 0.15);
    if (Number.isFinite(previousRate) && previousRate > 0 && Math.abs(idrPerCny / previousRate - 1) > maxChangeRatio) {
      throw new Error("汇率变动超过安全阈值，需在后台人工确认");
    }
    const previousQuoteTime = Date.parse(previous?.providerUpdatedAt || "");
    const incomingQuoteTime = Date.parse(providerUpdatedAt);
    if (previous?.updateMode === "automatic" && Number.isFinite(previousQuoteTime) && incomingQuoteTime < previousQuoteTime) {
      throw new Error("汇率服务返回的行情时间早于当前记录，已拒绝覆盖");
    }
    const fetchedAt = quote.fetchedAt || new Date().toISOString();
    const autoPricing = previous && Object.hasOwn(previous, "autoPricing")
      ? previous.autoPricing
      : { ...DEFAULT_AUTO_PRICING_RULE };
    const fx = {
      ...(previous || {}),
      idrPerCny,
      provider: quote.provider,
      source: quote.source,
      recommendedRefreshMinutes: quote.recommendedRefreshMinutes,
      degraded: Boolean(quote.degraded),
      updateMode: "automatic",
      trigger: source,
      rateChanged: !Number.isFinite(previousRate) || previousRate !== idrPerCny,
      providerUpdatedAt,
      providerNextUpdateAt,
      effectiveRateUpdatedAt: providerUpdatedAt,
      fetchedAt,
      updatedAt: fetchedAt,
      autoPricing
    };
    await writeJson(fxFile, fx);
    return fx;
  });
}

async function syncSupplierCatalog(source = "manual") {
  return withCatalogMutationLock(async () => {
    if (!process.env.SUPPLIER_API_KEY || !process.env.SUPPLIER_API_SECRET) throw new Error("供应商 API 未配置");
    const response = await listAllSupplierProducts();
    const old = await readJson(productsFile, []);
    const previousMeta = await readJson(syncMetaFile, null);
    const oldBySku = new Map(old.map((product) => [product.sku, product]));
    const now = new Date().toISOString();
    const normalized = response.items.map(normalizeSupplierProduct).filter((product) => product.sku);
    const sourceEligible = normalized.filter((product) => product.sourceEligible);
    const previousEligible = old.filter((product) => (product.sourceEligible ?? product.eligible) === true && product.active !== false);
    const minimumRetentionRatio = Number(process.env.CATALOG_MIN_RETENTION_RATIO || 0.25);
    if (!normalized.length) throw new Error("供应商未返回有效 SKU，已保留现有商品数据");
    if (response.complete && previousEligible.length >= 20 && sourceEligible.length / previousEligible.length < minimumRetentionRatio) {
      throw new Error(`本次自动识别通信商品数量异常下降（${previousEligible.length} → ${sourceEligible.length}），已取消同步`);
    }
    const currentQueryTypes = [...response.types].map(String).sort();
    const previousQueryTypes = Array.isArray(previousMeta?.queriedTypes) ? [...previousMeta.queriedTypes].map(String).sort() : [];
    const sameQueryScope = previousQueryTypes.length === currentQueryTypes.length
      && previousQueryTypes.every((type, index) => type === currentQueryTypes[index]);
    const canRetireMissing = Boolean(response.complete && sameQueryScope);
    const seen = new Set(normalized.map((product) => product.sku));
    const products = normalized.map((fresh) => {
      const previous = migratePublicationHistory(oldBySku.get(fresh.sku) || {}, now);
      const category = previous.categoryManual ? previous.category : fresh.category;
      const operator = previous.operatorManual ? previous.operator : fresh.operator;
      const manualCatalogApproved = Boolean(previous.manualCatalogApproved);
      const catalogEligible = ["airtime", "data"].includes(category)
        && Boolean(operator)
        && operator !== "未知运营商"
        && (fresh.sourceEligible || manualCatalogApproved);
      const next = {
        ...fresh,
        supplierName: fresh.name,
        sourceQueryTypes: response.types,
        name: previous.sku ? (previous.name || fresh.name) : fresh.name,
        category,
        operator,
        kind: category === "airtime" ? "话费" : category === "data" ? "流量" : "待分类",
        eligible: fresh.sourceEligible,
        catalogReady: catalogEligible,
        nameManual: Boolean(previous.nameManual),
        categoryManual: Boolean(previous.categoryManual),
        operatorManual: Boolean(previous.operatorManual),
        manualCatalogApproved,
        description: Object.hasOwn(previous, "description") ? previous.description : fresh.name,
        priceMode: previous.priceMode === "manual" ? "manual" : "auto",
        ...(previous.priceCny !== undefined ? { priceCny: previous.priceCny } : {}),
        published: Boolean(previous.published),
        everPublished: Boolean(previous.everPublished),
        firstPublishedAt: previous.firstPublishedAt,
        lastPublishedAt: previous.lastPublishedAt,
        lastUnpublishedAt: previous.lastUnpublishedAt,
        popular: Boolean(previous.popular),
        sortOrder: Number.isFinite(Number(previous.sortOrder)) ? Number(previous.sortOrder) : 0,
        firstSeenAt: previous.firstSeenAt || now,
        lastSeenAt: now,
        syncedAt: now
      };
      return applyPublicationTransition(next, Boolean(previous.published && fresh.active && catalogEligible), now);
    });
    for (const storedPrevious of old) {
      const previous = migratePublicationHistory(storedPrevious, now);
      if (seen.has(previous.sku)) continue;
      products.push(canRetireMissing
        ? applyPublicationTransition({
          ...previous,
          active: false,
          statusKnown: false,
          unavailableReason: MISSING_FROM_COMPLETE_CATALOG_REASON,
          syncedAt: now
        }, false, now)
        : { ...previous });
    }
    products.sort((left, right) => String(left.operator || "").localeCompare(String(right.operator || "")) || String(left.category || "").localeCompare(String(right.category || "")) || String(left.sku || "").localeCompare(String(right.sku || "")));
    const meta = {
      source,
      startedAt: now,
      completedAt: new Date().toISOString(),
      pages: response.pages,
      queriedTypes: response.types,
      catalogComplete: Boolean(response.complete),
      queryScopeMatchesPrevious: sameQueryScope,
      missingProductsRetired: canRetireMissing,
      pagination: response.pagination,
      supplierCount: normalized.length,
      eligibleCount: sourceEligible.length,
      excludedCount: normalized.length - sourceEligible.length,
      unavailableCount: products.filter((product) => product.active === false).length
    };
    await writeJson(productsFile, products);
    await writeJson(syncMetaFile, meta);
    await appendAudit("products.sync", meta);
    return { products, meta };
  });
}

function safeErrorDetails(error) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  return {
    message: String(error?.message || "供应商请求失败").slice(0, 300),
    code: String(details.code || details.error_code || "").slice(0, 100),
    supplierMessage: String(details.message || details.error || "").slice(0, 300)
  };
}

const PAYMENT_ALREADY_ACCEPTED_STATUSES = new Set([
  "paid_pending_recharge",
  "recharge_processing",
  "recharge_success",
  "refund_required",
  "manual_review",
  "refunded"
]);

function acceptSuccessfulWechatPayment(order, payment, { checkedAt = new Date().toISOString() } = {}) {
  const owner = order.userId ? orderStore.getWechatUser(order.userId) : null;
  const verified = validateSuccessfulWechatPayment(order, payment, {
    appid: process.env.WECHAT_APPID,
    mchid: process.env.WECHAT_MCHID,
    owner,
    now: Date.parse(checkedAt)
  });
  const payer = owner || orderStore.upsertWechatUser({
    appid: payment.appid,
    openid: verified.payerOpenid
  });
  const paymentCheckCount = Math.max(0, Number(order.paymentCheckCount || 0)) + 1;
  const update = orderStore.updateOrder(order.id, {
    status: "paid_pending_recharge",
    transactionId: verified.transactionId,
    userId: payer.id,
    payerOpenid: verified.payerOpenid || order.payerOpenid,
    paidAt: verified.paidAt,
    paymentSummary: {
      transactionId: verified.transactionId,
      amountFen: verified.amountFen,
      tradeState: verified.tradeState
    },
    wechatTradeState: verified.tradeState,
    paymentCheckedAt: checkedAt,
    paymentCheckCount,
    nextPaymentCheckAt: null,
    lastPaymentQueryError: null,
    retryCount: Number(order.retryCount || 0),
    nextRetryAt: checkedAt,
    statusUpdatedAt: verified.paidAt,
    updatedAt: checkedAt
  }, { expectedStatuses: ["pending_payment", "payment_pending"] });
  return { update, verified };
}

function pendingPaymentCheckPatch(order, {
  checkedAt,
  tradeState = null,
  error = null
}) {
  const paymentCheckCount = Math.max(0, Number(order.paymentCheckCount || 0)) + 1;
  return {
    wechatTradeState: tradeState || order.wechatTradeState || null,
    paymentCheckedAt: checkedAt,
    paymentCheckCount,
    nextPaymentCheckAt: nextPaymentPollAt(paymentCheckCount, {
      now: Date.parse(checkedAt),
      maxMs: 5 * 60 * 1000
    }),
    lastPaymentQueryError: error ? safeErrorDetails(error) : null,
    updatedAt: checkedAt
  };
}

async function reconcileWechatPayment(orderId, { force = false } = {}) {
  if (paymentReconciliationLocks.has(orderId)) return { skipped: "locked" };
  paymentReconciliationLocks.add(orderId);
  try {
    const order = orderStore.getOrder(orderId);
    if (!order) return { skipped: "not_found" };
    if (order.status !== "payment_pending") {
      return { skipped: PAYMENT_ALREADY_ACCEPTED_STATUSES.has(order.status) ? "already_accepted" : "status", order };
    }
    if (!force && !shouldActivelyReconcilePayment(order)) return { skipped: "not_due", order };

    const checkedAt = new Date().toISOString();
    let payment;
    try {
      payment = await queryJsapiTransactionByOutTradeNo(order.id);
    } catch (error) {
      const latest = orderStore.getOrder(order.id);
      if (latest?.status === "payment_pending") {
        orderStore.updateOrder(order.id, pendingPaymentCheckPatch(latest, { checkedAt, error }), {
          expectedStatuses: ["payment_pending"]
        });
      }
      return { error: safeErrorDetails(error), retryable: true };
    }

    const tradeState = String(payment?.trade_state || "").trim().toUpperCase();
    if (tradeState !== "SUCCESS") {
      const latest = orderStore.getOrder(order.id);
      if (latest?.status === "payment_pending") {
        orderStore.updateOrder(order.id, pendingPaymentCheckPatch(latest, { checkedAt, tradeState }), {
          expectedStatuses: ["payment_pending"]
        });
      }
      // NOTPAY/USERPAYING and terminal unpaid states must never reach ReloadN.
      return { paymentState: tradeState || "UNKNOWN", accepted: false };
    }

    const latest = orderStore.getOrder(order.id);
    if (!latest || latest.status !== "payment_pending") {
      return { skipped: PAYMENT_ALREADY_ACCEPTED_STATUSES.has(latest?.status) ? "already_accepted" : "status_changed", order: latest };
    }
    let accepted;
    try {
      accepted = acceptSuccessfulWechatPayment(latest, payment, { checkedAt });
    } catch (error) {
      if (error instanceof WechatPaymentValidationError) {
        const current = orderStore.getOrder(order.id);
        if (current?.status === "payment_pending") {
          orderStore.updateOrder(order.id, pendingPaymentCheckPatch(current, { checkedAt, tradeState, error }), {
            expectedStatuses: ["payment_pending"]
          });
        }
        return { error: { message: error.message, code: error.code }, retryable: false };
      }
      throw error;
    }
    if (!accepted.update.updated) {
      return { skipped: PAYMENT_ALREADY_ACCEPTED_STATUSES.has(accepted.update.order?.status) ? "already_accepted" : "status_changed", order: accepted.update.order };
    }

    // ReloadN create uses the local order ID as its idempotency key. Calling
    // the existing processor therefore recovers both "never submitted" and
    // "submitted but local result was lost" without duplicating a recharge.
    const recharge = await processRecharge(order.id);
    return { accepted: true, recharge, order: orderStore.getOrder(order.id) };
  } finally {
    paymentReconciliationLocks.delete(orderId);
  }
}

function retryableSupplierError(error) {
  if (error?.code === "SUPPLIER_ORDER_NOT_FOUND") return true;
  const status = Number(error?.status || String(error?.message || "").match(/Supplier API (\d+)/)?.[1]);
  return !Number.isFinite(status) || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function nextRetryAt(retryCount, baseMinutes = 2) {
  const minutes = Math.min(60, baseMinutes * (2 ** Math.min(Math.max(retryCount - 1, 0), 5)));
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

async function processRecharge(orderId, { force = false } = {}) {
  if (rechargeLocks.has(orderId)) return { skipped: "locked" };
  rechargeLocks.add(orderId);
  try {
    const order = orderStore.getOrder(orderId);
    if (!order) return { skipped: "not_found" };
    if (!force && order.nextRetryAt && Date.parse(order.nextRetryAt) > Date.now()) return { skipped: "not_due" };
    if (!force && !["paid_pending_recharge", "recharge_processing"].includes(order.status)) return { skipped: "status" };
    if (force && !["paid_pending_recharge", "recharge_processing", "manual_review"].includes(order.status)) return { skipped: "status" };

    const shouldQuery = order.status === "recharge_processing" || Boolean(order.providerOrderId);
    const provider = shouldQuery
      ? await querySupplierOrder(order.id, order.providerOrderId)
      : await createSupplierOrder({ order, product: { id: order.productId, sku: order.productId } });
    const providerOrder = provider?.order || null;
    const localStatus = supplierStatusToLocal(providerOrder?.status || provider.status);
    const checkedAt = new Date().toISOString();
    const latestOrder = orderStore.getOrder(orderId);
    if (!latestOrder || !["paid_pending_recharge", "recharge_processing", "manual_review"].includes(latestOrder.status)) {
      return { skipped: "status_changed", order: latestOrder };
    }
    const incomingVersion = Number(providerOrder?.order_version);
    const currentVersion = Number(latestOrder.orderVersion || 0);
    if (Number.isSafeInteger(incomingVersion) && incomingVersion >= 0 && incomingVersion < currentVersion) {
      orderStore.updateOrder(orderId, { providerCheckedAt: checkedAt, updatedAt: checkedAt }, {
        expectedStatuses: ["paid_pending_recharge", "recharge_processing", "manual_review"]
      });
      return { skipped: "stale_provider_version", order: orderStore.getOrder(orderId) };
    }
    const previousPollCount = Number(latestOrder.providerPollCount || 0);
    const providerPollCount = localStatus === "recharge_processing" ? previousPollCount + 1 : 0;
    const patch = {
      status: localStatus,
      provider,
      providerOrderId: providerOrder?.order_id || providerOrder?.id || latestOrder.providerOrderId,
      providerCheckedAt: checkedAt,
      providerPollCount,
      orderVersion: Number.isSafeInteger(incomingVersion) && incomingVersion >= 0
        ? Math.max(currentVersion, incomingVersion)
        : currentVersion,
      retryCount: localStatus === "recharge_processing" ? Number(latestOrder.retryCount || 0) : 0,
      nextRetryAt: localStatus === "recharge_processing"
        ? nextProcessingPollAt(previousPollCount, { maxMs: 5 * 60 * 1000 })
        : null,
      lastProviderError: null,
      needsManualAction: localStatus === "refund_required",
      statusUpdatedAt: localStatus === latestOrder.status ? latestOrder.statusUpdatedAt : checkedAt,
      updatedAt: checkedAt
    };
    return orderStore.updateOrder(order.id, patch, {
      expectedStatuses: ["paid_pending_recharge", "recharge_processing", "manual_review"]
    });
  } catch (error) {
    const order = orderStore.getOrder(orderId);
    if (!order) throw error;
    if (!["paid_pending_recharge", "recharge_processing", "manual_review"].includes(order.status)) {
      return { skipped: "status_changed", order };
    }
    const retryCount = Number(order.retryCount || 0) + 1;
    const retryable = retryableSupplierError(error) && retryCount <= 8;
    const checkedAt = new Date().toISOString();
    const nextStatus = retryable ? order.status : "manual_review";
    orderStore.updateOrder(order.id, {
      status: nextStatus,
      retryCount,
      nextRetryAt: retryable ? nextRetryAt(retryCount) : null,
      providerCheckedAt: checkedAt,
      lastProviderError: safeErrorDetails(error),
      needsManualAction: !retryable,
      statusUpdatedAt: nextStatus === order.status ? order.statusUpdatedAt : checkedAt,
      updatedAt: checkedAt
    }, { expectedStatuses: ["paid_pending_recharge", "recharge_processing", "manual_review"] });
    return { error: safeErrorDetails(error), retryable };
  } finally {
    rechargeLocks.delete(orderId);
  }
}

async function refreshActiveOrders(orders, { minIntervalMs = 10_000, limit = 20 } = {}) {
  const sourceOrders = Array.isArray(orders) ? orders : [];
  const paymentCandidates = sourceOrders
    .filter((order) => shouldActivelyReconcilePayment(order, { minIntervalMs: Math.max(15_000, minIntervalMs) }))
    .slice(0, limit);
  for (let index = 0; index < paymentCandidates.length; index += 5) {
    const batch = paymentCandidates.slice(index, index + 5);
    await Promise.allSettled(batch.map((order) => reconcileWechatPayment(order.id)));
  }

  const latestOrders = sourceOrders.map((order) => orderStore.getOrder(order.id) || order);
  const rechargeCandidates = latestOrders
    .filter((order) => shouldActivelyRefreshOrder(order, { minIntervalMs }))
    .slice(0, limit);
  for (let index = 0; index < rechargeCandidates.length; index += 5) {
    const batch = rechargeCandidates.slice(index, index + 5);
    await Promise.allSettled(batch.map((order) => processRecharge(order.id)));
  }
  return paymentCandidates.length + rechargeCandidates.length;
}

async function processPendingRecharges() {
  const pendingPayments = orderStore.listOrders({ status: "payment_pending", limit: 1000 })
    .filter((order) => shouldActivelyReconcilePayment(order))
    .sort((left, right) => Date.parse(left.nextPaymentCheckAt || left.paymentCheckedAt || left.createdAt || 0) - Date.parse(right.nextPaymentCheckAt || right.paymentCheckedAt || right.createdAt || 0))
    .slice(0, 20);
  for (let index = 0; index < pendingPayments.length; index += 5) {
    const batch = pendingPayments.slice(index, index + 5);
    await Promise.allSettled(batch.map((order) => reconcileWechatPayment(order.id)));
  }

  const candidates = [
    ...orderStore.listOrders({ status: "paid_pending_recharge", limit: 1000 }),
    ...orderStore.listOrders({ status: "recharge_processing", limit: 1000 })
  ]
    .filter((order) => !order.nextRetryAt || Date.parse(order.nextRetryAt) <= Date.now())
    .sort((left, right) => Date.parse(left.nextRetryAt || left.createdAt || 0) - Date.parse(right.nextRetryAt || right.createdAt || 0))
    .slice(0, 20);
  for (const order of candidates) await processRecharge(order.id);
}

function publicOrder(order) {
  if (!order) return null;
  const phone = String(order.phone || "");
  return {
    id: order.id,
    status: order.status,
    phone: phone.length > 7 ? `${phone.slice(0, 5)}****${phone.slice(-3)}` : "***",
    productId: order.productId,
    productLabel: order.productLabel,
    price: order.price,
    currency: order.currency,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt || order.createdAt
  };
}

async function adminApi(req, res, url) {
  if (!url.pathname.startsWith("/api/admin/")) return false;
  if (req.method === "GET" && url.pathname === "/api/admin/captcha") {
    if (!allowCaptchaRequest(clientIp(req))) return json(res, 429, { ok: false, message: "验证码刷新过于频繁，请稍后再试" }, { "retry-after": "60" });
    return json(res, 200, { ok: true, ...createAdminCaptcha() });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const ip = clientIp(req);
    const ipKey = `ip:${ip}`;
    const lockedFor = loginLockSeconds(ipKey);
    if (lockedFor > 0) return json(res, 429, { ok: false, message: `登录失败次数过多，请 ${Math.ceil(lockedFor / 60)} 分钟后重试`, retryAfter: lockedFor }, { "retry-after": String(lockedFor) });
    if (!process.env.ADMIN_USER || (!process.env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD_HASH) || !process.env.ADMIN_TOTP_SECRET) {
      return json(res, 503, { ok: false, message: "后台登录尚未完成安全配置" });
    }
    let input;
    try { input = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, message: "请求格式错误" }); }
    const userKey = `user:${String(input.username || "").trim().toLowerCase()}`;
    const userLockedFor = loginLockSeconds(userKey);
    if (userLockedFor > 0) return json(res, 429, { ok: false, message: `账号已临时锁定，请 ${Math.ceil(userLockedFor / 60)} 分钟后重试`, retryAfter: userLockedFor }, { "retry-after": String(userLockedFor) });
    const captcha = adminCaptchas.get(String(input.captchaId || ""));
    adminCaptchas.delete(String(input.captchaId || ""));
    if (!captcha || captcha.expiresAt <= Date.now() || !safeEqualText(captcha.hash, captchaHash(String(input.captchaId || ""), input.captchaCode || ""))) {
      recordLoginFailure(ipKey);
      recordLoginFailure(userKey);
      return json(res, 400, { ok: false, message: "图片验证码错误或已失效" });
    }
    const credentialsValid = safeEqualText(input.username, process.env.ADMIN_USER) && verifyAdminPassword(input.password) && verifyTotp(input.totpCode);
    if (!credentialsValid) {
      recordLoginFailure(ipKey);
      recordLoginFailure(userKey);
      const remainingLock = Math.max(loginLockSeconds(ipKey), loginLockSeconds(userKey));
      return json(res, remainingLock > 0 ? 429 : 401, { ok: false, message: remainingLock > 0 ? "登录失败次数过多，账号已临时锁定 15 分钟" : "账号、密码或 Google 验证码不正确" });
    }
    adminLoginAttempts.delete(ipKey);
    adminLoginAttempts.delete(userKey);
    const token = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(24).toString("base64url");
    const configuredTtl = Number(process.env.ADMIN_SESSION_TTL_SECONDS || 8 * 60 * 60);
    const maxAge = Number.isFinite(configuredTtl) ? Math.min(24 * 60 * 60, Math.max(900, Math.floor(configuredTtl))) : 8 * 60 * 60;
    adminSessions.set(token, { user: process.env.ADMIN_USER, csrfToken, expiresAt: Date.now() + maxAge * 1000 });
    return json(res, 200, { ok: true, user: process.env.ADMIN_USER, csrfToken }, { "set-cookie": `${adminCookieName}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict` });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/session") {
    const session = requireAdmin(req, res);
    if (!session) return true;
    return json(res, 200, { ok: true, user: session.user, csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/logout") {
    const session = requireAdmin(req, res, true);
    if (!session) return true;
    adminSessions.delete(session.token);
    return json(res, 200, { ok: true }, { "set-cookie": `${adminCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
  }
  if (!requireAdmin(req, res, !["GET", "HEAD"].includes(req.method))) return true;
  if (req.method === "GET" && url.pathname === "/api/admin/services") {
    return json(res, 200, { ok: true, services: sortedLifeServices(await readLifeServices({ strict: true })), maximum: MAX_LIFE_SERVICES });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/services") {
    let input;
    try { input = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, message: "请求格式错误" }); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return json(res, 400, { ok: false, message: "请求内容必须是 JSON 对象" });
    return withLifeServicesMutationLock(async () => {
      const services = await readLifeServices({ strict: true });
      if (services.length >= MAX_LIFE_SERVICES) return json(res, 409, { ok: false, message: `生活服务最多支持 ${MAX_LIFE_SERVICES} 项` });
      const prepared = {
        ...input,
        enabled: Object.hasOwn(input, "enabled") ? input.enabled : true,
        description: Object.hasOwn(input, "description") ? input.description : "",
        sortOrder: Object.hasOwn(input, "sortOrder") ? input.sortOrder : nextLifeServiceSortOrder(services)
      };
      const validated = lifeServiceInput(prepared);
      if (!validated.service) return json(res, 400, { ok: false, message: validated.error });
      const service = { ...validated.service, id: `svc_${crypto.randomBytes(12).toString("hex")}` };
      services.push(service);
      await writeJson(lifeServicesFile, sortedLifeServices(services));
      await appendAudit("service.create", { id: service.id, title: service.title, enabled: service.enabled, sortOrder: service.sortOrder });
      return json(res, 201, { ok: true, service, services: sortedLifeServices(services), maximum: MAX_LIFE_SERVICES });
    });
  }
  if (["PUT", "PATCH", "DELETE"].includes(req.method) && url.pathname.startsWith("/api/admin/services/")) {
    const serviceId = lifeServiceIdFromPath(url.pathname);
    if (!serviceId) return json(res, 400, { ok: false, message: "服务 ID 格式错误" });
    if (req.method === "DELETE") {
      return withLifeServicesMutationLock(async () => {
        const services = await readLifeServices({ strict: true });
        const index = services.findIndex((service) => service.id === serviceId);
        if (index < 0) return json(res, 404, { ok: false, message: "生活服务不存在" });
        const [deleted] = services.splice(index, 1);
        await writeJson(lifeServicesFile, sortedLifeServices(services));
        await appendAudit("service.delete", { id: deleted.id, title: deleted.title });
        return json(res, 200, { ok: true, deletedId: deleted.id, services: sortedLifeServices(services), maximum: MAX_LIFE_SERVICES });
      });
    }
    let input;
    try { input = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, message: "请求格式错误" }); }
    return withLifeServicesMutationLock(async () => {
      const services = await readLifeServices({ strict: true });
      const index = services.findIndex((service) => service.id === serviceId);
      if (index < 0) return json(res, 404, { ok: false, message: "生活服务不存在" });
      const validated = lifeServiceInput(input, { existing: services[index] });
      if (!validated.service) return json(res, 400, { ok: false, message: validated.error });
      const previous = services[index];
      const service = { ...validated.service, id: serviceId };
      services[index] = service;
      await writeJson(lifeServicesFile, sortedLifeServices(services));
      await appendAudit("service.update", {
        id: service.id,
        title: service.title,
        enabled: service.enabled,
        sortOrder: service.sortOrder,
        changedFields: Object.keys(input),
        previousTitle: previous.title
      });
      return json(res, 200, { ok: true, service, services: sortedLifeServices(services), maximum: MAX_LIFE_SERVICES });
    });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/products") {
    const products = await readJson(productsFile, []);
    const fx = await readJson(fxFile, null);
    return json(res, 200, {
      ok: true,
      products: products.map((product) => adminProductView(product, fx)),
      publishedOrder: publishedCatalogOrderState(products, fx)
    });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/products/sync") {
    try {
      const result = await syncSupplierCatalog("manual");
      return json(res, 200, { ok: true, count: result.products.length, meta: result.meta });
    } catch (error) {
      return json(res, 502, { ok: false, message: error.message || "供应商商品同步失败" });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/admin/products/bulk") {
    let input; try { input = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, message: "请求格式错误" }); }
    const skus = [...new Set(Array.isArray(input.skus) ? input.skus.map(String) : [])].slice(0, 500);
    if (!skus.length || typeof input.published !== "boolean") return json(res, 400, { ok: false, message: "请选择商品并指定上架状态" });
    return withCatalogMutationLock(async () => {
      const products = await readJson(productsFile, []);
      const fx = await readJson(fxFile, null);
      const productsBySku = new Map(products.map((product) => [String(product.sku), product]));
      const selectedProducts = skus.map((sku) => productsBySku.get(sku)).filter(Boolean);
      const eligibleProducts = selectedProducts.filter((product) => !input.published
        || (product.active === true && productCanAppearInCatalog(product) && getSellPriceCny(product, fx) !== null));
      const skipped = input.published
        ? selectedProducts.filter((product) => !eligibleProducts.includes(product)).map((product) => ({
          sku: String(product.sku),
          reason: product.active !== true
            ? "最近确认的完整目录中已缺失"
            : !productCanAppearInCatalog(product)
              ? "尚未完成通信套餐分类、运营商或人工确认"
              : "尚无有效售价"
        }))
        : [];
      const missing = skus.filter((sku) => !productsBySku.has(sku));
      if (input.published && eligibleProducts.length === 0) {
        const firstReason = skipped[0]?.reason || (missing.length ? "SKU 不存在" : "没有符合上架条件的商品");
        return json(res, 409, {
          ok: false,
          message: `所选商品均未上架：${firstReason}`,
          skipped,
          missing
        });
      }
      const newlyPublishedSkus = input.published
        ? eligibleProducts.filter((product) => !product.published).map((product) => String(product.sku))
        : [];
      let changed = 0;
      const transitionedAt = new Date().toISOString();
      for (const product of eligibleProducts) {
        if (Boolean(product.published) !== input.published) changed += 1;
        Object.assign(product, applyPublicationTransition(product, input.published, transitionedAt));
      }
      try {
        appendNewlyPublishedProducts(products, newlyPublishedSkus, fx);
      } catch (error) {
        return json(res, 409, { ok: false, message: error.message || "上架商品数量超过排序上限" });
      }
      await writeJson(productsFile, products);
      await appendAudit(input.published ? "products.bulk_publish" : "products.bulk_unpublish", { skus, changed });
      return json(res, 200, {
        ok: true,
        changed,
        skipped,
        missing,
        publishedOrder: publishedCatalogOrderState(products, fx)
      });
    });
  }
  if (req.method === "PUT" && url.pathname === "/api/admin/products/order") {
    let input;
    try {
      input = normalizeCatalogOrderRequest(JSON.parse(await readBody(req)));
    } catch (error) {
      return json(res, 400, { ok: false, message: error.message || "请求格式错误" });
    }
    const { skus, expectedRevision } = input;
    return withCatalogMutationLock(async () => {
      const products = await readJson(productsFile, []);
      const fx = await readJson(fxFile, null);
      const current = publishedCatalogOrderState(products, fx);
      if (!catalogSkuSetsMatch(current.skus, skus)) {
        return json(res, 409, { ok: false, message: "上架商品已发生变化，请刷新列表后重新排序", publishedOrder: current });
      }
      if (current.revision !== expectedRevision) {
        return json(res, 409, { ok: false, message: "商品排序已被其他操作更新，请刷新后重试", publishedOrder: current });
      }
      assignCatalogDisplayOrder(products, skus);
      await writeJson(productsFile, products);
      await appendAudit("products.reorder", { count: skus.length, firstSkus: skus.slice(0, 10) });
      return json(res, 200, { ok: true, order: skus, publishedOrder: publishedCatalogOrderState(products, fx) });
    });
  }
  if (req.method === "PUT" && url.pathname.startsWith("/api/admin/products/")) {
    let input; try { input = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, message: "请求格式错误" }); }
    const sku = decodeURIComponent(url.pathname.split("/").pop());
    return withCatalogMutationLock(async () => {
      const products = await readJson(productsFile, []);
      const product = products.find((p) => p.sku === sku);
      if (!product) return json(res, 404, { ok: false, message: "SKU不存在" });
      const fx = await readJson(fxFile, null);
      const wasPublished = Boolean(product.published);
      const requestedPublished = typeof input.published === "boolean" ? input.published : product.published;
      if (typeof input.category === "string") {
        if (!["airtime", "data", "unclassified"].includes(input.category)) return json(res, 400, { ok: false, message: "商品分类无效" });
        product.category = input.category;
        product.categoryManual = true;
        product.kind = input.category === "airtime" ? "话费" : input.category === "data" ? "流量" : "待分类";
      }
      if (typeof input.operator === "string") {
        product.operator = input.operator.trim().slice(0, 80) || "未知运营商";
        product.operatorManual = true;
      }
      if (typeof input.manualCatalogApproved === "boolean") product.manualCatalogApproved = input.manualCatalogApproved;
      product.catalogReady = productCanAppearInCatalog(product);
      if (typeof input.name === "string" && input.name.trim()) {
        product.name = input.name.trim().slice(0, 120);
        product.nameManual = true;
      }
      if (typeof input.description === "string") product.description = input.description.slice(0, 500);
      if (typeof input.popular === "boolean") product.popular = input.popular;
      if (input.priceMode === "auto" || input.priceMode === "manual") product.priceMode = input.priceMode;
      const manualPriceWasSubmitted = Object.hasOwn(input, "priceCny") || input.priceMode === "manual";
      if (product.priceMode === "manual" && (requestedPublished || manualPriceWasSubmitted)) {
        const manualPrice = Number(input.priceCny);
        if (input.priceCny === "" || !Number.isFinite(manualPrice) || manualPrice <= 0) return json(res, 400, { ok: false, message: "请输入有效的手动售价" });
        product.priceCny = manualPrice;
      }
      if (requestedPublished && product.active !== true) return json(res, 400, { ok: false, message: "该 SKU 已从最近确认的完整目录中缺失，请重新同步确认后再上架" });
      if (requestedPublished && !productCanAppearInCatalog(product)) return json(res, 400, { ok: false, message: "请先确认商品是印尼通信套餐，并完成分类和运营商设置" });
      if (requestedPublished && getSellPriceCny(product, fx) === null) return json(res, 400, { ok: false, message: "商品没有有效售价，不能上架" });
      Object.assign(product, applyPublicationTransition(product, requestedPublished, new Date().toISOString()));
      if (requestedPublished && !wasPublished) {
        try {
          appendNewlyPublishedProducts(products, [String(product.sku)], fx);
        } catch (error) {
          return json(res, 409, { ok: false, message: error.message || "上架商品数量超过排序上限" });
        }
      }
      await writeJson(productsFile, products);
      await appendAudit("product.update", { sku, published: product.published, priceMode: product.priceMode, popular: product.popular, sortOrder: product.sortOrder });
      return json(res, 200, { ok: true, product: adminProductView(product, fx), publishedOrder: publishedCatalogOrderState(products, fx) });
    });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/fx") {
    return json(res, 200, { ok: true, fx: fxStateForAdmin(await readJson(fxFile, null)) });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/fx/refresh") {
    try {
      const fx = await refreshFxRate("manual");
      await appendAudit("fx.refresh", { idrPerCny: fx.idrPerCny, rateChanged: fx.rateChanged, providerUpdatedAt: fx.providerUpdatedAt });
      return json(res, 200, { ok: true, fx: fxStateForAdmin(fx) });
    } catch (error) {
      return json(res, 502, { ok: false, message: error.message || "汇率刷新失败" });
    }
  }
  if (req.method === "PUT" && url.pathname === "/api/admin/fx") {
    let input; try { input = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, message: "请求格式错误" }); }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return json(res, 400, { ok: false, message: "请求必须包含 IDR/CNY 汇率" });
    }
    const idrPerCny = Number(input.idrPerCny);
    const minRate = Number(process.env.FX_IDR_CNY_MIN || 1000);
    const maxRate = Number(process.env.FX_IDR_CNY_MAX || 5000);
    if (!Number.isFinite(idrPerCny) || idrPerCny < minRate || idrPerCny > maxRate) return json(res, 400, { ok: false, message: `汇率需在 ${minRate}–${maxRate} IDR/CNY 范围内` });
    const fx = await withFxMutationLock(async () => {
      const previous = await readJsonStrict(fxFile, null);
      const updatedAt = new Date().toISOString();
      const autoPricing = previous && Object.hasOwn(previous, "autoPricing")
        ? previous.autoPricing
        : { ...DEFAULT_AUTO_PRICING_RULE };
      const next = {
        ...(previous || {}),
        idrPerCny,
        source: "manual",
        updateMode: "manual",
        trigger: "manual",
        rateChanged: Number(previous?.idrPerCny) !== idrPerCny,
        providerUpdatedAt: null,
        providerNextUpdateAt: null,
        effectiveRateUpdatedAt: updatedAt,
        fetchedAt: null,
        updatedAt,
        autoPricing
      };
      await writeJson(fxFile, next);
      return next;
    });
    await appendAudit("fx.manual_update", { idrPerCny });
    return json(res, 200, { ok: true, fx: fxStateForAdmin(fx) });
  }
  if (req.method === "PUT" && url.pathname === "/api/admin/pricing") {
    let input; try { input = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, message: "请求格式错误" }); }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return json(res, 400, { ok: false, message: "请求必须包含自动定价规则" });
    }
    const requestedRule = { mode: input?.mode, value: input?.value };
    const rule = normalizeAutoPricingRule(requestedRule, { useDefaultWhenMissing: false });
    if (!rule) {
      const message = requestedRule.mode === "fixed"
        ? `固定加价必须是 0–${MAX_FIXED_MARKUP_IDR.toLocaleString("zh-CN")} 的整数 IDR`
        : requestedRule.mode === "percent"
          ? `比例加价必须是 0–${MAX_PERCENT_MARKUP.toLocaleString("zh-CN")} 的数字百分比`
          : "自动定价模式必须是固定加价或比例加价";
      return json(res, 400, { ok: false, message });
    }
    const saved = await withFxMutationLock(async () => {
      const previousFx = await readJsonStrict(fxFile, null);
      const previousRule = normalizeAutoPricingRule(previousFx?.autoPricing) || { ...DEFAULT_AUTO_PRICING_RULE };
      const autoPricing = { ...rule, updatedAt: new Date().toISOString() };
      const fx = { ...(previousFx || {}), autoPricing };
      await writeJson(fxFile, fx);
      return { fx, previousRule, autoPricing };
    });
    await appendAudit("pricing.rule_update", {
      previousMode: saved.previousRule.mode,
      previousValue: saved.previousRule.value,
      mode: saved.autoPricing.mode,
      value: saved.autoPricing.value
    });
    return json(res, 200, { ok: true, fx: fxStateForAdmin(saved.fx) });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/orders") {
    let orders = orderStore.listOrders({ limit: 2000 });
    await refreshActiveOrders(orders, { minIntervalMs: 10_000, limit: 50 });
    orders = orderStore.listOrders({ limit: 2000 });
    return json(res, 200, { ok: true, orders });
  }
  if (req.method === "POST" && /^\/api\/admin\/orders\/[^/]+\/retry$/.test(url.pathname)) {
    const orderId = decodeURIComponent(url.pathname.split("/").at(-2));
    const order = orderStore.getOrder(orderId);
    if (!order) return json(res, 404, { ok: false, message: "订单不存在" });
    if (!["payment_pending", "paid_pending_recharge", "recharge_processing", "manual_review"].includes(order.status)) {
      return json(res, 400, { ok: false, message: "当前订单状态不允许查单或重新提交" });
    }
    const result = order.status === "payment_pending"
      ? await reconcileWechatPayment(orderId, { force: true })
      : await processRecharge(orderId, { force: true });
    await appendAudit("order.retry", { orderId, status: orderStore.getOrder(orderId)?.status });
    return json(res, 200, { ok: true, result, order: orderStore.getOrder(orderId) });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/status") {
    const products = await readJson(productsFile, []);
    const fx = await readJson(fxFile, null);
    const sync = await readJson(syncMetaFile, null);
    const fxRefreshMinutes = fxRefreshIntervalMinutes(fx);
    return json(res, 200, {
      ok: true,
      status: {
        products: products.length,
        published: products.filter((product) => product.published && product.active === true).length,
        unavailable: products.filter((product) => product.active === false).length,
        orders: orderStore.listOrders({ limit: 2000 }).length,
        fx: fxStateForAdmin(fx),
        sync,
        schedules: {
          productSyncHours: 24,
          fxRefreshMinutes,
          fxRefreshHours: Number((fxRefreshMinutes / 60).toFixed(2))
        }
      }
    });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/audit") {
    const entries = await readJson(auditFile, []);
    return json(res, 200, { ok: true, entries: entries.slice(-200).reverse() });
  }
  return json(res, 404, { ok: false, message: "管理接口不存在" });
}

const json = (res, status, payload, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(payload));
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validPhone(phone) {
  return /^08\d{8,12}$/.test(normalizePhone(phone));
}

async function handleApi(req, res, url) {
  if (url.pathname.startsWith("/api/admin/")) {
    await adminApi(req, res, url);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { ok: true, service: "panxiang-recharge", time: new Date().toISOString() });
  }
  if (req.method === "GET" && url.pathname === "/api/public-config") {
    return json(res, 200, { ok: true, customerServiceUrl: normalizeCustomerServiceUrl(process.env.WECOM_CUSTOMER_SERVICE_URL || defaultCustomerServiceUrl) });
  }
  if (req.method === "GET" && url.pathname === "/api/services") {
    return json(res, 200, { ok: true, services: publicLifeServices(await readLifeServices()) });
  }
  if (req.method === "GET" && url.pathname === "/api/catalog") {
    const managed = await readJson(productsFile, []);
    const fx = await readJson(fxFile, null);
    const published = managed
      .filter((product) => isProductStorefrontVisible(product, fx))
      .map((product) => ({
        id: product.sku,
        operator: product.operator,
        kind: product.kind,
        category: product.category,
        label: product.name || product.sku,
        description: product.description || "",
        price: getSellPriceCny(product, fx),
        currency: "CNY",
        popular: Boolean(product.popular),
        sortOrder: normalizeCatalogSortOrder(product.sortOrder)
      }))
      .filter((product) => Number.isFinite(product.price) && product.price > 0)
      .sort(compareCatalogDisplayOrder);
    const allowDemo = process.env.NODE_ENV !== "production" && managed.length === 0;
    return json(res, 200, { ok: true, currency: "CNY", products: allowDemo ? catalog : published });
  }
  if (req.method === "GET" && url.pathname === "/api/me") {
    const identity = requireWechatIdentity(req, res);
    if (!identity) return;
    return json(res, 200, { ok: true, authenticated: true, user: publicWechatUser(identity.user) });
  }
  if (req.method === "GET" && url.pathname === "/api/me/orders") {
    const identity = requireWechatIdentity(req, res);
    if (!identity) return;
    const requestedLimit = Number(url.searchParams.get("limit"));
    const requestedOffset = Number(url.searchParams.get("offset"));
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(100, requestedLimit) : 50;
    const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? Math.min(1_000_000_000, requestedOffset) : 0;
    let ownedOrders = orderStore.listOrders({ userId: identity.user.id, limit, offset });
    await refreshActiveOrders(ownedOrders, { minIntervalMs: 8_000, limit: 20 });
    ownedOrders = orderStore.listOrders({ userId: identity.user.id, limit, offset });
    const orders = ownedOrders.map(publicOrder);
    return json(res, 200, { ok: true, orders, limit, offset, nextOffset: orders.length === limit ? offset + limit : null });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/orders/")) {
    const orderId = String(url.pathname.split("/").pop() || "").trim();
    if (!orderId || orderId.length > 128) return json(res, 404, { ok: false, message: "订单不存在" });
    let order = orderStore.getOrder(orderId);
    if (!order) return json(res, 404, { ok: false, message: "订单不存在" });
    const token = String(url.searchParams.get("token") || "");
    const identity = getWechatIdentity(req);
    const legacyTokenMatches = !order.userId && token && order.lookupToken && safeEqualText(token, order.lookupToken);
    const mayClaimLegacy = identity && (orderOwnedByIdentity(order, identity) || (!order.payerOpenid && legacyTokenMatches));
    if (!order.userId && mayClaimLegacy) {
      const linked = orderStore.updateOrder(order.id, { userId: identity.user.id, payerOpenid: order.payerOpenid || identity.user.openid });
      if (linked.updated) order = linked.order;
    }
    const ownsOrder = orderOwnedByIdentity(order, identity) || (!order.userId && legacyTokenMatches);
    if (!ownsOrder) return json(res, 403, { ok: false, message: "无权查看该订单" });
    await refreshActiveOrders([order], { minIntervalMs: 5_000, limit: 1 });
    order = orderStore.getOrder(orderId) || order;
    return json(res, 200, { ok: true, order: publicOrder(order) });
  }
  if (req.method === "POST" && url.pathname === "/api/orders") {
    const identity = requireWechatIdentity(req, res);
    if (!identity) return;
    let input;
    try { input = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, message: "请求格式错误" }); }
    const managed = await readJson(productsFile, []);
    const fx = await readJson(fxFile, null);
    const managedItem = managed.find((product) => product.sku === input.productId && product.published && product.active && productCanAppearInCatalog(product));
    const demoProduct = process.env.NODE_ENV !== "production" && managed.length === 0 ? findProduct(input.productId) : null;
    const product = managedItem ? { ...managedItem, id: managedItem.sku, label: managedItem.name || managedItem.sku, price: getSellPriceCny(managedItem, fx), currency: "CNY" } : demoProduct;
    const phone = normalizePhone(input.phone);
    const detectedOperator = detectOperator(phone);
    if (!product) return json(res, 400, { ok: false, message: "套餐不存在" });
    if (!Number.isFinite(Number(product.price)) || Number(product.price) <= 0) return json(res, 409, { ok: false, message: "套餐当前售价不可用，请稍后刷新重试" });
    if (!validPhone(phone)) return json(res, 400, { ok: false, message: "请输入有效的印尼手机号，例如 +62812xxxxxxx 或 0812xxxxxxx" });
    if (detectedOperator && detectedOperator !== product.operator) return json(res, 400, { ok: false, message: `该手机号段识别为 ${detectedOperator}，请选择对应套餐` });
    const id = `PX${Date.now()}${crypto.randomBytes(3).toString("hex")}`;
    const lookupToken = crypto.randomBytes(24).toString("base64url");
    const createdAt = new Date().toISOString();
    const order = { id, lookupToken, userId: identity.user.id, payerOpenid: identity.user.openid, phone: `+62${phone.slice(1)}`, detectedOperator, productId: product.id, productLabel: product.label, price: product.price, currency: product.currency, status: "created", createdAt, statusUpdatedAt: createdAt };
    // 供应商下单必须在微信支付成功后执行，避免用户未付款却触发真实充值。
    order.status = "pending_payment";
    const created = orderStore.createOrder(order);
    return json(res, 201, { ok: true, order: publicOrder(created), lookupToken, next: "wechat_jsapi_payment" });
  }
  if (req.method === "GET" && url.pathname === "/api/wechat/oauth/start") {
    if (!process.env.WECHAT_APPID || !process.env.WECHAT_APP_SECRET) return json(res, 503, { ok: false, message: "微信 AppID 或 AppSecret 未配置" });
    const state = crypto.randomBytes(18).toString("hex");
    const returnPath = safeReturnPath(url.searchParams.get("return"));
    orderStore.cleanupWechatAuth();
    orderStore.createWechatOauthState(state, returnPath, new Date(Date.now() + 5 * 60 * 1000).toISOString());
    const redirect = `${process.env.PUBLIC_BASE_URL || "https://reloadb.com"}/api/wechat/oauth/callback`;
    const oauth = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${encodeURIComponent(process.env.WECHAT_APPID)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=snsapi_base&state=${state}#wechat_redirect`;
    res.writeHead(302, { location: oauth }); res.end(); return;
  }
  if (req.method === "GET" && url.pathname === "/api/wechat/oauth/callback") {
    let state = null;
    try { state = orderStore.consumeWechatOauthState(String(url.searchParams.get("state") || "")); } catch {}
    if (!state) return json(res, 400, { ok: false, message: "授权状态已失效" });
    const code = String(url.searchParams.get("code") || "");
    if (!code) return json(res, 400, { ok: false, message: "微信授权未返回 code" });
    const tokenResponse = await fetch(`https://api.weixin.qq.com/sns/oauth2/access_token?appid=${encodeURIComponent(process.env.WECHAT_APPID)}&secret=${encodeURIComponent(process.env.WECHAT_APP_SECRET)}&code=${encodeURIComponent(code)}&grant_type=authorization_code`);
    const token = await tokenResponse.json();
    if (!token.openid) return json(res, 502, { ok: false, message: "微信授权失败" });
    const user = orderStore.upsertWechatUser({ appid: process.env.WECHAT_APPID, openid: token.openid, unionid: token.unionid });
    const session = crypto.randomBytes(32).toString("base64url");
    orderStore.createWechatSession(session, user.id, new Date(Date.now() + wechatSessionTtlSeconds * 1000).toISOString());
    res.writeHead(302, { location: state.returnPath, "set-cookie": `${wechatCookieName}=${session}; Path=/; Max-Age=${wechatSessionTtlSeconds}; HttpOnly; Secure; SameSite=Lax` }); res.end(); return;
  }
  if (req.method === "GET" && url.pathname === "/api/wechat/session") {
    const identity = getWechatIdentity(req);
    return json(res, 200, { ok: true, authorized: Boolean(identity), user: publicWechatUser(identity?.user) });
  }
  if (req.method === "POST" && url.pathname === "/api/wechat/prepay") {
    let input; try { input = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, message: "请求格式错误" }); }
    const identity = requireWechatIdentity(req, res);
    if (!identity) return;
    const orderId = String(input.orderId || "").trim();
    if (!orderId || orderId.length > 128) return json(res, 400, { ok: false, message: "订单不存在或状态不允许支付" });
    let order = orderStore.getOrder(orderId);
    if (!order || !["pending_payment", "payment_pending"].includes(order.status)) return json(res, 400, { ok: false, message: "订单不存在或状态不允许支付" });
    if (!orderOwnedByIdentity(order, identity)) return json(res, 403, { ok: false, message: "无权支付该订单" });
    if (!order.userId) {
      const linked = orderStore.updateOrder(order.id, { userId: identity.user.id });
      if (!linked.updated) return json(res, 409, { ok: false, message: "订单归属更新失败，请刷新后重试" });
      order = linked.order;
    }
    const openid = identity.user.openid;
    const amountFen = Math.round(Number(order.price) * 100);
    if (!Number.isFinite(amountFen) || amountFen <= 0) return json(res, 400, { ok: false, message: "订单金额无效" });
    if (order.status === "payment_pending" && order.prepayId) {
      return json(res, 200, { ok: true, orderId: order.id, payment: await buildJsapiPayParams(order.prepayId), replay: true });
    }
    const data = await createJsapiPrepay({ description: order.productLabel.slice(0, 120), outTradeNo: order.id, amountFen, openid });
    const paymentPendingAt = new Date().toISOString();
    const update = orderStore.updateOrder(order.id, {
      status: "payment_pending",
      prepayId: data.prepay_id,
      payerOpenid: openid,
      userId: identity.user.id,
      paymentCheckCount: 0,
      paymentCheckedAt: null,
      nextPaymentCheckAt: nextPaymentPollAt(0, { now: Date.parse(paymentPendingAt) }),
      lastPaymentQueryError: null,
      statusUpdatedAt: paymentPendingAt,
      updatedAt: paymentPendingAt
    }, { expectedStatuses: ["pending_payment", "payment_pending"] });
    if (!update.updated) {
      const current = update.order;
      if (current?.status === "payment_pending" && current.prepayId) {
        return json(res, 200, { ok: true, orderId: current.id, payment: await buildJsapiPayParams(current.prepayId), replay: true });
      }
      return json(res, 409, { ok: false, message: "订单状态已变化，请刷新后查看订单状态" });
    }
    return json(res, 200, { ok: true, orderId: order.id, payment: await buildJsapiPayParams(data.prepay_id) });
  }
  if (req.method === "POST" && url.pathname === "/api/wechat/notify") {
    const raw = await readBody(req);
    const payment = await verifyAndDecryptNotification(raw, req.headers);
    const order = orderStore.getOrder(String(payment.out_trade_no || ""));
    if (!order) return json(res, 500, { code: "FAIL", message: "本地订单不存在，请稍后重试" });
    let accepted;
    try {
      accepted = acceptSuccessfulWechatPayment(order, payment);
    } catch (error) {
      if (error instanceof WechatPaymentValidationError) {
        return json(res, 400, { code: "FAIL", message: error.message });
      }
      throw error;
    }
    if (!accepted.update.updated) {
      if (PAYMENT_ALREADY_ACCEPTED_STATUSES.has(accepted.update.order?.status)) {
        return json(res, 200, { code: "SUCCESS", message: "成功" });
      }
      return json(res, 409, { code: "FAIL", message: "订单状态冲突，请稍后重试" });
    }
    setImmediate(() => processRecharge(order.id).catch((error) => {
      console.error(`Recharge processing failed for ${order.id}:`, error.message);
    }));
    return json(res, 200, { code: "SUCCESS", message: "成功" });
  }
  if (req.method === "POST" && url.pathname === "/api/provider/webhook") {
    const raw = await readBody(req);
    if (!verifyWebhookSignature(raw, req.headers)) return json(res, 401, { ok: false, message: "webhook签名无效" });
    let event;
    try { event = JSON.parse(raw); } catch { return json(res, 400, { ok: false, message: "webhook格式错误" }); }
    const webhookId = String(req.headers["x-webhook-id"] || "");
    const payloadOrder = event?.data?.order || event?.order || event?.data || event;
    const eventType = String(event.type || event.event_type || payloadOrder.event_type || "");
    if (eventType === "test.ping") return json(res, 200, { ok: true, ping: true });
    const status = eventType === "order.success" ? "recharge_success"
      : eventType === "order.failed" ? "refund_required"
      // ReloadN refunded only confirms that the supplier-side balance was
      // returned. It does not prove that the customer's WeChat payment has
      // been refunded, so keep the order in the manual-refund queue.
      : eventType === "order.refunded" ? "refund_required"
      : null;
    if (!status) return json(res, 200, { ok: true, ignored: true, message: "未识别的供应商事件" });
    let result;
    try {
      const receivedAt = new Date().toISOString();
      result = orderStore.applyProviderWebhook({
        webhookId,
        outTradeNo: payloadOrder.client_order_id || event.client_order_id,
        providerOrderId: payloadOrder.order_id || payloadOrder.id || event.order_id,
        orderVersion: payloadOrder.order_version ?? event.order_version,
        eventType,
        status,
        payload: event,
        patch: {
          nextRetryAt: null,
          providerCheckedAt: receivedAt,
          statusUpdatedAt: receivedAt,
          needsManualAction: status === "refund_required"
        }
      });
    } catch (error) {
      if (error?.code === "WEBHOOK_ORDER_NOT_FOUND") {
        return json(res, 503, { ok: false, message: "订单尚未就绪，请稍后重试" });
      }
      throw error;
    }
    return json(res, 200, { ok: true, duplicate: result.reason === "duplicate", applied: result.applied });
  }
  return json(res, 404, { ok: false, message: "接口不存在" });
}

async function serveStatic(req, res, url) {
  if (url.pathname === "/admin.html") {
    res.writeHead(301, { location: "/admin/", "cache-control": "no-store" }); res.end(); return;
  }
  if (["/admin-login", "/admin-login.html"].includes(url.pathname)) {
    res.writeHead(301, { location: "/admin/login", "cache-control": "no-store" }); res.end(); return;
  }
  const isAdminPage = ["/admin", "/admin/", "/admin/index.html"].includes(url.pathname);
  const isLoginPage = ["/admin/login", "/admin/login/"].includes(url.pathname);
  const isAdminArea = isAdminPage || (url.pathname.startsWith("/admin/") && !isLoginPage);
  const session = getAdminSession(req);
  if (isAdminArea && !session) {
    res.writeHead(302, { location: "/admin/login", "cache-control": "no-store" });
    res.end();
    return;
  }
  if (isLoginPage && session) {
    res.writeHead(302, { location: "/admin/", "cache-control": "no-store" });
    res.end();
    return;
  }
  const requested = url.pathname === "/" ? "/index.html" : isAdminPage ? "/admin/index.html" : isLoginPage ? "/admin-login.html" : url.pathname;
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return json(res, 403, { ok: false });
  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
    const headers = {
      "content-type": types[ext] || "application/octet-stream",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "x-frame-options": isAdminArea || isLoginPage ? "DENY" : "SAMEORIGIN",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      ...(process.env.NODE_ENV === "production" ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {})
    };
    if (isAdminArea || isLoginPage) headers["cache-control"] = "no-store";
    res.writeHead(200, headers);
    res.end(body);
  } catch { json(res, 404, { ok: false, message: "页面不存在" }); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    json(res, 500, { ok: false, message: "服务器内部错误" });
  }
});

let maintenanceRunning = false;
async function scheduledMaintenance() {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  const now = Date.now();
  try {
    try {
      orderStore.cleanupWechatAuth();
    } catch (error) {
      console.error("Wechat auth cleanup failed:", error.message);
    }
    try {
      const fx = await readJson(fxFile, null);
      const normalIntervalMs = fxRefreshIntervalMinutes(fx) * 60 * 1000;
      let providerSelectionChanged = false;
      try {
        const selected = selectFxProvider(process.env);
        providerSelectionChanged = Boolean(fx?.idrPerCny) && fx?.provider !== selected.provider;
      } catch {
        // refreshFxRate will surface the provider configuration error when a
        // refresh is otherwise due; a bad configuration must not crash the
        // rest of the maintenance cycle.
      }
      if (providerSelectionChanged || shouldRefreshFxRate(fx, {
        now,
        lastAttemptAt: lastScheduledFxRefreshAttemptAt,
        normalIntervalMs
      })) {
        lastScheduledFxRefreshAttemptAt = now;
        await refreshFxRate("scheduled");
      }
    } catch (error) {
      console.error("Scheduled FX refresh failed:", error.message);
    }
    try {
      const sync = await readJson(syncMetaFile, null);
      const syncAge = now - Date.parse(sync?.completedAt || 0);
      if (process.env.SUPPLIER_API_KEY && process.env.SUPPLIER_API_SECRET && (!sync || !Number.isFinite(syncAge) || syncAge >= 24 * 60 * 60 * 1000)) {
        await syncSupplierCatalog("scheduled");
      }
    } catch (error) {
      console.error("Scheduled product sync failed:", error.message);
    }
  } finally {
    maintenanceRunning = false;
  }
}

try {
  await migrateStoredProductAvailability();
} catch (error) {
  console.error("Stored product availability migration failed:", error.message);
}
try {
  await migrateStoredPublicationHistory();
} catch (error) {
  console.error("Stored product publication-history migration failed:", error.message);
}
server.listen(port, () => console.log(`Panxiang Recharge listening on http://localhost:${port}`));
setTimeout(scheduledMaintenance, 5000).unref();
setInterval(scheduledMaintenance, 30 * 60 * 1000).unref();
setTimeout(() => processPendingRecharges().catch((error) => console.error("Initial recharge recovery failed:", error.message)), 5000).unref();
// Webhook normally updates the order immediately. This recovery loop closes
// the gap quickly when a callback is delayed or lost; per-order nextRetryAt
// still applies exponential backoff, so the supplier is not polled every run.
setInterval(() => processPendingRecharges().catch((error) => console.error("Recharge recovery failed:", error.message)), 15 * 1000).unref();
