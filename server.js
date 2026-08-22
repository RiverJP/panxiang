import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalog, findProduct, normalizePhone, detectOperator, createSupplierOrder, querySupplierOrder, verifyWebhookSignature, listAllSupplierProducts } from "./src/provider.js";
import { createJsapiPrepay, buildJsapiPayParams, verifyAndDecryptNotification } from "./src/wechat.js";
import { createOrderStore } from "./src/order-store.js";
import { supplierBuyPriceIdr, supplierProductAvailability, autoPriceState } from "./src/catalog-pricing.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 3000);
const wechatStates = new Map();
const wechatSessions = new Map();
const adminSessions = new Map();
const adminCaptchas = new Map();
const adminLoginAttempts = new Map();
const adminCaptchaRequests = new Map();
const adminCookieName = "__Host-px_admin_session";
const dataDir = path.join(root, "data");
const productsFile = path.join(dataDir, "products.json");
const fxFile = path.join(dataDir, "fx.json");
const ordersFile = path.join(dataDir, "orders.json");
const syncMetaFile = path.join(dataDir, "sync-meta.json");
const auditFile = path.join(dataDir, "admin-audit.json");
const orderStore = createOrderStore({ dbPath: path.join(dataDir, "orders.sqlite"), legacyJsonPath: ordersFile });
const rechargeLocks = new Set();
let catalogMutationTail = Promise.resolve();

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

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}

async function writeJson(file, value) {
  await fs.mkdir(dataDir, { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2));
  await fs.rename(temporary, file);
}

async function appendAudit(action, details = {}) {
  const entries = await readJson(auditFile, []);
  entries.push({ action, details, at: new Date().toISOString() });
  await writeJson(auditFile, entries.slice(-1000));
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return [part, ""];
    try { return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]; }
    catch { return [part.slice(0, index), ""]; }
  }));
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

function adminProductView(product, fx) {
  const { raw: _raw, ...view } = product;
  const pricing = autoPriceState(product, fx);
  return {
    ...view,
    autoPriceCny: pricing.priceCny,
    autoPriceStatus: pricing.status,
    autoPriceReason: pricing.reason
  };
}

async function refreshFxRate(source = "manual") {
  const fxUrl = process.env.FX_RATE_URL || "https://open.er-api.com/v6/latest/CNY";
  const response = await fetch(fxUrl, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`汇率服务返回 ${response.status}`);
  const data = await response.json();
  const idrPerCny = Number(data?.rates?.IDR);
  const minRate = Number(process.env.FX_IDR_CNY_MIN || 1000);
  const maxRate = Number(process.env.FX_IDR_CNY_MAX || 5000);
  if (!Number.isFinite(idrPerCny) || idrPerCny < minRate || idrPerCny > maxRate) throw new Error("汇率响应超出安全范围，未更新自动售价");
  const previous = await readJson(fxFile, null);
  const previousRate = Number(previous?.idrPerCny);
  const maxChangeRatio = Number(process.env.FX_MAX_CHANGE_RATIO || 0.15);
  if (Number.isFinite(previousRate) && previousRate > 0 && Math.abs(idrPerCny / previousRate - 1) > maxChangeRatio) {
    throw new Error("汇率变动超过安全阈值，需在后台人工确认");
  }
  const fx = { idrPerCny, source: fxUrl, updateMode: "automatic", trigger: source, updatedAt: new Date().toISOString() };
  await writeJson(fxFile, fx);
  return fx;
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
      const previous = oldBySku.get(fresh.sku) || {};
      const category = previous.categoryManual ? previous.category : fresh.category;
      const operator = previous.operatorManual ? previous.operator : fresh.operator;
      const manualCatalogApproved = Boolean(previous.manualCatalogApproved);
      const catalogEligible = ["airtime", "data"].includes(category)
        && Boolean(operator)
        && operator !== "未知运营商"
        && (fresh.sourceEligible || manualCatalogApproved);
      return {
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
        published: Boolean(previous.published && fresh.active && catalogEligible),
        popular: Boolean(previous.popular),
        sortOrder: Number.isFinite(Number(previous.sortOrder)) ? Number(previous.sortOrder) : 0,
        firstSeenAt: previous.firstSeenAt || now,
        lastSeenAt: now,
        syncedAt: now
      };
    });
    for (const previous of old) {
      if (seen.has(previous.sku)) continue;
      products.push(canRetireMissing
        ? { ...previous, active: false, published: false, unavailableReason: "供应商完整目录未返回该商品", syncedAt: now }
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
      unavailableCount: products.filter((product) => !product.active).length
    };
    await writeJson(productsFile, products);
    await writeJson(syncMetaFile, meta);
    await appendAudit("products.sync", meta);
    return { products, meta };
  });
}

function supplierOrderFromResponse(provider) {
  return provider?.data?.data?.order
    || provider?.data?.data?.items?.[0]
    || provider?.data?.data?.orders?.[0]
    || provider?.data?.order
    || provider?.data?.items?.[0]
    || null;
}

function supplierStatusToLocal(status) {
  const normalized = String(status || "").toLowerCase();
  if (["success", "successful", "completed", "complete"].includes(normalized)) return "recharge_success";
  if (["failed", "failure", "cancelled", "canceled", "rejected"].includes(normalized)) return "refund_required";
  if (["refunded", "refund"].includes(normalized)) return "refund_required";
  return "recharge_processing";
}

function safeErrorDetails(error) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  return {
    message: String(error?.message || "供应商请求失败").slice(0, 300),
    code: String(details.code || details.error_code || "").slice(0, 100),
    supplierMessage: String(details.message || details.error || "").slice(0, 300)
  };
}

function retryableSupplierError(error) {
  const status = Number(String(error?.message || "").match(/Supplier API (\d+)/)?.[1]);
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
      ? await querySupplierOrder(order.id)
      : await createSupplierOrder({ order, product: { id: order.productId, sku: order.productId } });
    const providerOrder = supplierOrderFromResponse(provider);
    const localStatus = supplierStatusToLocal(providerOrder?.status || provider.status);
    const patch = {
      status: localStatus,
      provider,
      providerOrderId: providerOrder?.order_id || providerOrder?.id || order.providerOrderId,
      retryCount: localStatus === "recharge_processing" ? Number(order.retryCount || 0) : 0,
      nextRetryAt: localStatus === "recharge_processing" ? new Date(Date.now() + 10 * 60 * 1000).toISOString() : null,
      lastProviderError: null,
      needsManualAction: localStatus === "refund_required",
      updatedAt: new Date().toISOString()
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
    orderStore.updateOrder(order.id, {
      status: retryable ? "paid_pending_recharge" : "manual_review",
      retryCount,
      nextRetryAt: retryable ? nextRetryAt(retryCount) : null,
      lastProviderError: safeErrorDetails(error),
      needsManualAction: !retryable,
      updatedAt: new Date().toISOString()
    }, { expectedStatuses: ["paid_pending_recharge", "recharge_processing", "manual_review"] });
    return { error: safeErrorDetails(error), retryable };
  } finally {
    rechargeLocks.delete(orderId);
  }
}

async function processPendingRecharges() {
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
  if (req.method === "GET" && url.pathname === "/api/admin/products") {
    const products = await readJson(productsFile, []);
    const fx = await readJson(fxFile, null);
    return json(res, 200, { ok: true, products: products.map((product) => adminProductView(product, fx)) });
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
      const skuSet = new Set(skus);
      const products = await readJson(productsFile, []);
      const fx = await readJson(fxFile, null);
      let changed = 0;
      for (const product of products) {
        if (!skuSet.has(product.sku)) continue;
        if (input.published && (!product.active || !productCanAppearInCatalog(product) || getSellPriceCny(product, fx) === null)) continue;
        product.published = input.published;
        changed += 1;
      }
      await writeJson(productsFile, products);
      await appendAudit(input.published ? "products.bulk_publish" : "products.bulk_unpublish", { skus, changed });
      return json(res, 200, { ok: true, changed });
    });
  }
  if (req.method === "PUT" && url.pathname.startsWith("/api/admin/products/")) {
    let input; try { input = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, message: "请求格式错误" }); }
    const sku = decodeURIComponent(url.pathname.split("/").pop());
    return withCatalogMutationLock(async () => {
      const products = await readJson(productsFile, []);
      const product = products.find((p) => p.sku === sku);
      if (!product) return json(res, 404, { ok: false, message: "SKU不存在" });
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
      if (input.sortOrder !== undefined) {
        const sortOrder = Number(input.sortOrder);
        if (!Number.isFinite(sortOrder)) return json(res, 400, { ok: false, message: "排序值无效" });
        product.sortOrder = Math.max(-9999, Math.min(9999, Math.round(sortOrder)));
      }
      if (input.priceMode === "auto" || input.priceMode === "manual") product.priceMode = input.priceMode;
      if (product.priceMode === "manual") {
        const manualPrice = Number(input.priceCny);
        if (input.priceCny === "" || !Number.isFinite(manualPrice) || manualPrice <= 0) return json(res, 400, { ok: false, message: "请输入有效的手动售价" });
        product.priceCny = manualPrice;
      }
      if (requestedPublished && !product.active) return json(res, 400, { ok: false, message: "供应商已停用该商品，不能上架" });
      if (requestedPublished && !productCanAppearInCatalog(product)) return json(res, 400, { ok: false, message: "请先确认商品是印尼通信套餐，并完成分类和运营商设置" });
      if (requestedPublished && getSellPriceCny(product, await readJson(fxFile, null)) === null) return json(res, 400, { ok: false, message: "商品没有有效售价，不能上架" });
      product.published = requestedPublished;
      await writeJson(productsFile, products);
      await appendAudit("product.update", { sku, published: product.published, priceMode: product.priceMode, popular: product.popular, sortOrder: product.sortOrder });
      return json(res, 200, { ok: true, product: adminProductView(product, await readJson(fxFile, null)) });
    });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/fx") return json(res, 200, { ok: true, fx: await readJson(fxFile, null) });
  if (req.method === "POST" && url.pathname === "/api/admin/fx/refresh") {
    try {
      const fx = await refreshFxRate("manual");
      await appendAudit("fx.refresh", { idrPerCny: fx.idrPerCny });
      return json(res, 200, { ok: true, fx });
    } catch (error) {
      return json(res, 502, { ok: false, message: error.message || "汇率刷新失败" });
    }
  }
  if (req.method === "PUT" && url.pathname === "/api/admin/fx") {
    let input; try { input = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, message: "请求格式错误" }); }
    const idrPerCny = Number(input.idrPerCny);
    const minRate = Number(process.env.FX_IDR_CNY_MIN || 1000);
    const maxRate = Number(process.env.FX_IDR_CNY_MAX || 5000);
    if (!Number.isFinite(idrPerCny) || idrPerCny < minRate || idrPerCny > maxRate) return json(res, 400, { ok: false, message: `汇率需在 ${minRate}–${maxRate} IDR/CNY 范围内` });
    const fx = { idrPerCny, source: "manual", updateMode: "manual", updatedAt: new Date().toISOString() };
    await writeJson(fxFile, fx);
    await appendAudit("fx.manual_update", { idrPerCny });
    return json(res, 200, { ok: true, fx });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/orders") {
    return json(res, 200, { ok: true, orders: orderStore.listOrders({ limit: 2000 }) });
  }
  if (req.method === "POST" && /^\/api\/admin\/orders\/[^/]+\/retry$/.test(url.pathname)) {
    const orderId = decodeURIComponent(url.pathname.split("/").at(-2));
    const order = orderStore.getOrder(orderId);
    if (!order) return json(res, 404, { ok: false, message: "订单不存在" });
    if (!["paid_pending_recharge", "recharge_processing", "manual_review"].includes(order.status)) {
      return json(res, 400, { ok: false, message: "当前订单状态不允许重新提交" });
    }
    const result = await processRecharge(orderId, { force: true });
    await appendAudit("order.retry", { orderId, status: orderStore.getOrder(orderId)?.status });
    return json(res, 200, { ok: true, result, order: orderStore.getOrder(orderId) });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/status") {
    const products = await readJson(productsFile, []);
    const fx = await readJson(fxFile, null);
    const sync = await readJson(syncMetaFile, null);
    return json(res, 200, {
      ok: true,
      status: {
        products: products.length,
        published: products.filter((product) => product.published && product.active).length,
        unavailable: products.filter((product) => !product.active).length,
        orders: orderStore.listOrders({ limit: 2000 }).length,
        fx,
        sync,
        schedules: { productSyncHours: 24, fxRefreshHours: 8 }
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
  if (req.method === "GET" && url.pathname === "/api/catalog") {
    const managed = await readJson(productsFile, []);
    const fx = await readJson(fxFile, null);
    const published = managed
      .filter((product) => product.published && product.active && productCanAppearInCatalog(product))
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
        sortOrder: Number(product.sortOrder || 0)
      }))
      .filter((product) => Number.isFinite(product.price) && product.price > 0)
      .sort((left, right) => right.popular - left.popular || left.sortOrder - right.sortOrder || left.price - right.price);
    const allowDemo = process.env.NODE_ENV !== "production" && managed.length === 0;
    return json(res, 200, { ok: true, currency: "CNY", products: allowDemo ? catalog : published });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/orders/")) {
    const order = orderStore.getOrder(url.pathname.split("/").pop());
    if (!order) return json(res, 404, { ok: false, message: "订单不存在" });
    const token = String(url.searchParams.get("token") || "");
    const cookie = String(req.headers.cookie || "").split(";").map((value) => value.trim()).find((value) => value.startsWith("px_wechat_session="));
    const sessionId = cookie?.slice("px_wechat_session=".length);
    const openid = wechatSessions.get(sessionId)?.openid;
    const ownsOrder = (token && safeEqualText(token, order.lookupToken)) || (openid && safeEqualText(openid, order.payerOpenid));
    return ownsOrder ? json(res, 200, { ok: true, order: publicOrder(order) }) : json(res, 403, { ok: false, message: "无权查看该订单" });
  }
  if (req.method === "POST" && url.pathname === "/api/orders") {
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
    const order = { id, lookupToken, phone: `+62${phone.slice(1)}`, detectedOperator, productId: product.id, productLabel: product.label, price: product.price, currency: product.currency, status: "created", createdAt: new Date().toISOString() };
    // 供应商下单必须在微信支付成功后执行，避免用户未付款却触发真实充值。
    order.status = "pending_payment";
    const created = orderStore.createOrder(order);
    return json(res, 201, { ok: true, order: publicOrder(created), lookupToken, next: "wechat_jsapi_payment" });
  }
  if (req.method === "GET" && url.pathname === "/api/wechat/oauth/start") {
    if (!process.env.WECHAT_APPID || !process.env.WECHAT_APP_SECRET) return json(res, 503, { ok: false, message: "微信 AppID 或 AppSecret 未配置" });
    const state = crypto.randomBytes(18).toString("hex");
    const returnPath = String(url.searchParams.get("return") || "/").startsWith("/") ? String(url.searchParams.get("return") || "/") : "/";
    wechatStates.set(state, { returnPath, expiresAt: Date.now() + 5 * 60 * 1000 });
    const redirect = `${process.env.PUBLIC_BASE_URL || "https://reloadb.com"}/api/wechat/oauth/callback`;
    const oauth = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${encodeURIComponent(process.env.WECHAT_APPID)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=snsapi_base&state=${state}#wechat_redirect`;
    res.writeHead(302, { location: oauth }); res.end(); return;
  }
  if (req.method === "GET" && url.pathname === "/api/wechat/oauth/callback") {
    const state = wechatStates.get(String(url.searchParams.get("state") || ""));
    if (!state || state.expiresAt < Date.now()) return json(res, 400, { ok: false, message: "授权状态已失效" });
    wechatStates.delete(String(url.searchParams.get("state") || ""));
    const code = String(url.searchParams.get("code") || "");
    const tokenResponse = await fetch(`https://api.weixin.qq.com/sns/oauth2/access_token?appid=${encodeURIComponent(process.env.WECHAT_APPID)}&secret=${encodeURIComponent(process.env.WECHAT_APP_SECRET)}&code=${encodeURIComponent(code)}&grant_type=authorization_code`);
    const token = await tokenResponse.json();
    if (!token.openid) return json(res, 502, { ok: false, message: "微信授权失败" });
    const session = crypto.randomBytes(24).toString("hex");
    wechatSessions.set(session, { openid: token.openid, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    res.writeHead(302, { location: state.returnPath, "set-cookie": `px_wechat_session=${session}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax` }); res.end(); return;
  }
  if (req.method === "GET" && url.pathname === "/api/wechat/session") {
    const cookie = String(req.headers.cookie || "").split(";").map((v) => v.trim()).find((v) => v.startsWith("px_wechat_session="));
    const session = cookie?.slice("px_wechat_session=".length);
    const value = wechatSessions.get(session);
    return json(res, 200, { ok: true, authorized: Boolean(value && value.expiresAt > Date.now()) });
  }
  if (req.method === "POST" && url.pathname === "/api/wechat/prepay") {
    let input; try { input = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, message: "请求格式错误" }); }
    const order = orderStore.getOrder(String(input.orderId || ""));
    if (!order || order.status !== "pending_payment") return json(res, 400, { ok: false, message: "订单不存在或状态不允许支付" });
    const cookie = String(req.headers.cookie || "").split(";").map((v) => v.trim()).find((v) => v.startsWith("px_wechat_session="));
    const session = cookie?.slice("px_wechat_session=".length);
    const openid = String(input.openid || wechatSessions.get(session)?.openid || "");
    if (!openid) return json(res, 400, { ok: false, message: "缺少微信用户OpenID，请在服务号网页内打开" });
    const amountFen = Math.round(Number(order.price) * 100);
    if (!Number.isFinite(amountFen) || amountFen <= 0) return json(res, 400, { ok: false, message: "订单金额无效" });
    const data = await createJsapiPrepay({ description: order.productLabel.slice(0, 120), outTradeNo: order.id, amountFen, openid });
    const update = orderStore.updateOrder(order.id, { status: "payment_pending", prepayId: data.prepay_id, payerOpenid: openid, updatedAt: new Date().toISOString() }, { expectedStatuses: "pending_payment" });
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
    const expectedFen = Math.round(Number(order.price) * 100);
    const payerOpenid = String(payment.payer?.openid || "");
    const identityMatches = safeEqualText(payment.appid, process.env.WECHAT_APPID)
      && safeEqualText(payment.mchid, process.env.WECHAT_MCHID)
      && safeEqualText(payment.amount?.currency, "CNY")
      && (!order.payerOpenid || safeEqualText(payerOpenid, order.payerOpenid));
    if (!identityMatches || payment.trade_state !== "SUCCESS" || Number(payment.amount?.total) !== expectedFen) {
      return json(res, 400, { code: "FAIL", message: "支付身份、状态或金额不匹配" });
    }
    if (["paid_pending_recharge", "recharge_processing", "recharge_success", "refund_required", "manual_review"].includes(order.status)) return json(res, 200, { code: "SUCCESS", message: "成功" });
    const transactionId = String(payment.transaction_id || "");
    if (!transactionId) return json(res, 400, { code: "FAIL", message: "微信支付流水号缺失" });
    const update = orderStore.updateOrder(order.id, {
      status: "paid_pending_recharge",
      transactionId,
      payerOpenid: payerOpenid || order.payerOpenid,
      paidAt: payment.success_time || new Date().toISOString(),
      paymentSummary: { transactionId, amountFen: Number(payment.amount?.total), tradeState: payment.trade_state },
      retryCount: Number(order.retryCount || 0),
      nextRetryAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, { expectedStatuses: ["pending_payment", "payment_pending"] });
    if (!update.updated) {
      if (["paid_pending_recharge", "recharge_processing", "recharge_success", "refund_required", "manual_review", "refunded"].includes(update.order?.status)) {
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
      : eventType === "order.refunded" ? "refunded"
      : null;
    const result = orderStore.applyProviderWebhook({
      webhookId,
      outTradeNo: payloadOrder.client_order_id || event.client_order_id,
      providerOrderId: payloadOrder.order_id || payloadOrder.id || event.order_id,
      orderVersion: payloadOrder.order_version ?? event.order_version,
      eventType,
      ...(status ? { status } : {}),
      payload: event,
      patch: status ? { nextRetryAt: null, needsManualAction: status === "refund_required" } : {}
    });
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
      const fx = await readJson(fxFile, null);
      const fxAge = now - Date.parse(fx?.updatedAt || 0);
      if (!fx || !Number.isFinite(fxAge) || fxAge >= 8 * 60 * 60 * 1000) await refreshFxRate("scheduled");
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

server.listen(port, () => console.log(`Panxiang Recharge listening on http://localhost:${port}`));
setTimeout(scheduledMaintenance, 5000).unref();
setInterval(scheduledMaintenance, 30 * 60 * 1000).unref();
setTimeout(() => processPendingRecharges().catch((error) => console.error("Initial recharge recovery failed:", error.message)), 10000).unref();
setInterval(() => processPendingRecharges().catch((error) => console.error("Recharge recovery failed:", error.message)), 60 * 1000).unref();
