import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalog, findProduct, normalizePhone, detectOperator, createSupplierOrder, verifyWebhookSignature, listSupplierProducts } from "./src/provider.js";
import { createJsapiPrepay, buildJsapiPayParams, verifyAndDecryptNotification } from "./src/wechat.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 3000);
const orders = new Map();
const webhookIds = new Set();
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

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}

async function writeJson(file, value) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
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

function normalizeSupplierProduct(item) {
  const sku = String(item.sku || item.code || item.product_code || item.id || "");
  const idr = Number(item.buy_price_idr ?? item.cost_idr ?? item.price_idr ?? item.price ?? item.amount);
  return { sku, operator: item.operator || item.telco || item.provider || "", kind: item.type || item.kind || "流量", name: item.name || item.title || sku, buyPriceIdr: Number.isFinite(idr) ? idr : null, active: item.active !== false && item.status !== "inactive", raw: item };
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
    return json(res, 200, { ok: true, products });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/products/sync") {
    if (!process.env.SUPPLIER_API_KEY || !process.env.SUPPLIER_API_SECRET) return json(res, 503, { ok: false, message: "供应商 API 未配置" });
    const response = await listSupplierProducts();
    const items = response?.data?.items || response?.data?.products || response?.items || response?.products || [];
    const old = await readJson(productsFile, []);
    const oldBySku = new Map(old.map((p) => [p.sku, p]));
    const products = items.map(normalizeSupplierProduct).filter((p) => p.sku).map((p) => ({ ...p, ...(oldBySku.get(p.sku) || {}), ...p }));
    await writeJson(productsFile, products);
    return json(res, 200, { ok: true, count: products.length, products });
  }
  if (req.method === "PUT" && url.pathname.startsWith("/api/admin/products/")) {
    let input; try { input = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, message: "请求格式错误" }); }
    const sku = decodeURIComponent(url.pathname.split("/").pop());
    const products = await readJson(productsFile, []);
    const product = products.find((p) => p.sku === sku);
    if (!product) return json(res, 404, { ok: false, message: "SKU不存在" });
    if (typeof input.published === "boolean") product.published = input.published;
    if (typeof input.description === "string") product.description = input.description.slice(0, 500);
    if (input.priceMode === "auto" || input.priceMode === "manual") product.priceMode = input.priceMode;
    if (input.priceCny !== undefined && Number.isFinite(Number(input.priceCny))) product.priceCny = Math.max(0, Number(input.priceCny));
    await writeJson(productsFile, products);
    return json(res, 200, { ok: true, product });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/fx") return json(res, 200, { ok: true, fx: await readJson(fxFile, null) });
  if (req.method === "POST" && url.pathname === "/api/admin/fx/refresh") {
    const fxUrl = process.env.FX_RATE_URL || "https://open.er-api.com/v6/latest/CNY";
    const response = await fetch(fxUrl, { signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    const idrPerCny = Number(data?.rates?.IDR);
    if (!Number.isFinite(idrPerCny)) return json(res, 502, { ok: false, message: "汇率响应中没有 IDR" });
    const fx = { idrPerCny, source: fxUrl, updatedAt: new Date().toISOString() };
    await writeJson(fxFile, fx);
    return json(res, 200, { ok: true, fx });
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
    const published = managed.filter((p) => p.published).map((p) => ({ ...p, id: p.sku, label: p.name || p.sku, popular: false, price: p.priceMode === "manual" ? p.priceCny : (p.buyPriceIdr && fx?.idrPerCny ? Number(((p.buyPriceIdr - 120) / fx.idrPerCny).toFixed(2)) : p.priceCny) })).filter((p) => Number.isFinite(p.price));
    return json(res, 200, { ok: true, currency: "CNY", products: published.length ? published : catalog });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/orders/")) {
    const order = orders.get(url.pathname.split("/").pop());
    return order ? json(res, 200, { ok: true, order }) : json(res, 404, { ok: false, message: "订单不存在" });
  }
  if (req.method === "POST" && url.pathname === "/api/orders") {
    let input;
    try { input = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, message: "请求格式错误" }); }
    const managed = await readJson(productsFile, []);
    const fx = await readJson(fxFile, null);
    const managedItem = managed.find((p) => p.sku === input.productId && p.published);
    const product = managedItem ? { ...managedItem, id: managedItem.sku, label: managedItem.name || managedItem.sku, price: managedItem.priceMode === "manual" ? managedItem.priceCny : (managedItem.buyPriceIdr && fx?.idrPerCny ? Number(((managedItem.buyPriceIdr - 120) / fx.idrPerCny).toFixed(2)) : managedItem.priceCny) } : findProduct(input.productId);
    const phone = normalizePhone(input.phone);
    const detectedOperator = detectOperator(phone);
    if (!product) return json(res, 400, { ok: false, message: "套餐不存在" });
    if (!validPhone(phone)) return json(res, 400, { ok: false, message: "请输入有效的印尼手机号，例如 +62812xxxxxxx 或 0812xxxxxxx" });
    if (detectedOperator && detectedOperator !== product.operator) return json(res, 400, { ok: false, message: `该手机号段识别为 ${detectedOperator}，请选择对应套餐` });
    const id = `PX${Date.now()}${crypto.randomBytes(3).toString("hex")}`;
    const order = { id, phone: `+62${phone.slice(1)}`, detectedOperator, productId: product.id, productLabel: product.label, price: product.price, currency: product.currency, status: "created", createdAt: new Date().toISOString() };
    orders.set(id, order);
    // 供应商下单必须在微信支付成功后执行，避免用户未付款却触发真实充值。
    order.status = "pending_payment";
    return json(res, 201, { ok: true, order, next: "wechat_jsapi_payment" });
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
    const order = orders.get(String(input.orderId || ""));
    if (!order || order.status !== "pending_payment") return json(res, 400, { ok: false, message: "订单不存在或状态不允许支付" });
    const cookie = String(req.headers.cookie || "").split(";").map((v) => v.trim()).find((v) => v.startsWith("px_wechat_session="));
    const session = cookie?.slice("px_wechat_session=".length);
    const openid = String(input.openid || wechatSessions.get(session)?.openid || "");
    if (!openid) return json(res, 400, { ok: false, message: "缺少微信用户OpenID，请在服务号网页内打开" });
    const amountFen = Math.round(Number(order.price) * 100);
    if (!Number.isFinite(amountFen) || amountFen <= 0) return json(res, 400, { ok: false, message: "订单金额无效" });
    const data = await createJsapiPrepay({ description: order.productLabel.slice(0, 120), outTradeNo: order.id, amountFen, openid });
    order.status = "payment_pending";
    order.prepayId = data.prepay_id;
    order.updatedAt = new Date().toISOString();
    return json(res, 200, { ok: true, orderId: order.id, payment: await buildJsapiPayParams(data.prepay_id) });
  }
  if (req.method === "POST" && url.pathname === "/api/wechat/notify") {
    const raw = await readBody(req);
    const payment = await verifyAndDecryptNotification(raw, req.headers);
    const order = orders.get(String(payment.out_trade_no || ""));
    if (!order) return json(res, 200, { code: "SUCCESS", message: "订单已处理" });
    const expectedFen = Math.round(Number(order.price) * 100);
    if (payment.trade_state !== "SUCCESS" || Number(payment.amount?.total) !== expectedFen) return json(res, 400, { code: "FAIL", message: "支付状态或金额不匹配" });
    if (order.status === "recharge_processing" || order.status === "recharge_success") return json(res, 200, { code: "SUCCESS", message: "成功" });
    const product = findProduct(order.productId) || { id: order.productId, sku: order.productId };
    const provider = await createSupplierOrder({ order, product });
    order.status = "recharge_processing";
    order.payment = payment;
    order.provider = provider;
    order.updatedAt = new Date().toISOString();
    return json(res, 200, { code: "SUCCESS", message: "成功" });
  }
  if (req.method === "POST" && url.pathname === "/api/provider/webhook") {
    const raw = await readBody(req);
    if (!verifyWebhookSignature(raw, req.headers)) return json(res, 401, { ok: false, message: "webhook签名无效" });
    let event;
    try { event = JSON.parse(raw); } catch { return json(res, 400, { ok: false, message: "webhook格式错误" }); }
    const webhookId = String(req.headers["x-webhook-id"] || "");
    if (webhookIds.has(webhookId)) return json(res, 200, { ok: true, duplicate: true });
    webhookIds.add(webhookId);
    const orderId = event.client_order_id || event.order_id;
    const order = orders.get(orderId);
    if (order) {
      const eventType = event.type || event.event_type;
      order.status = eventType === "order.success" ? "recharge_success" : eventType === "order.failed" ? "recharge_failed" : eventType === "order.refunded" ? "refunded" : "processing";
      order.provider = event;
      order.orderVersion = Number(event.order_version || order.orderVersion || 0);
      order.updatedAt = new Date().toISOString();
    }
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { ok: false, message: "接口不存在" });
}

async function serveStatic(req, res, url) {
  const isAdminPage = ["/admin", "/admin/", "/admin.html"].includes(url.pathname);
  const isLoginPage = ["/admin-login", "/admin-login.html"].includes(url.pathname);
  const session = getAdminSession(req);
  if (isAdminPage && !session) {
    res.writeHead(302, { location: "/admin-login.html", "cache-control": "no-store" });
    res.end();
    return;
  }
  if (isLoginPage && session) {
    res.writeHead(302, { location: "/admin.html", "cache-control": "no-store" });
    res.end();
    return;
  }
  const requested = url.pathname === "/" ? "/index.html" : isAdminPage ? "/admin.html" : isLoginPage ? "/admin-login.html" : url.pathname;
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
      "x-frame-options": isAdminPage || isLoginPage ? "DENY" : "SAMEORIGIN"
    };
    if (isAdminPage || isLoginPage) headers["cache-control"] = "no-store";
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

server.listen(port, () => console.log(`Panxiang Recharge listening on http://localhost:${port}`));
