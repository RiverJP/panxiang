import crypto from "node:crypto";
import fs from "node:fs/promises";

const baseUrl = "https://api.mch.weixin.qq.com";

async function readKey(file) {
  if (!file) throw new Error("微信证书路径未配置");
  return fs.readFile(file, "utf8");
}

function authHeader(method, path, body, privateKey) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString("hex");
  const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = crypto.createSign("RSA-SHA256").update(message).sign(privateKey, "base64");
  return `WECHATPAY2-SHA256-RSA2048 mchid="${process.env.WECHAT_MCHID}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${process.env.WECHAT_MCH_SERIAL_NO}",signature="${signature}"`;
}

export async function wechatRequest(method, path, payload) {
  const normalizedMethod = String(method || "").toUpperCase();
  const hasBody = payload !== undefined && normalizedMethod !== "GET" && normalizedMethod !== "HEAD";
  const body = hasBody ? JSON.stringify(payload) : "";
  const privateKey = await readKey(process.env.WECHAT_PRIVATE_KEY_PATH);
  const requestOptions = {
    method: normalizedMethod,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: authHeader(normalizedMethod, path, body, privateKey),
      "User-Agent": "panxiang-recharge/1.0"
    },
    signal: AbortSignal.timeout(15000)
  };
  if (hasBody) requestOptions.body = body;
  const response = await fetch(`${baseUrl}${path}`, requestOptions);
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) { const error = new Error(`WeChat Pay ${response.status}`); error.details = data; throw error; }
  return data;
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export async function queryJsapiTransactionByOutTradeNo(
  outTradeNo,
  { requestImpl = wechatRequest, mchid = process.env.WECHAT_MCHID } = {}
) {
  const normalizedOutTradeNo = String(outTradeNo ?? "").trim();
  const normalizedMchid = String(mchid ?? "").trim();
  if (!normalizedOutTradeNo) throw new Error("微信商户订单号不能为空");
  if (!normalizedMchid) throw new Error("微信商户号未配置");
  if (typeof requestImpl !== "function") throw new TypeError("微信支付请求函数无效");

  const path = `/v3/pay/transactions/out-trade-no/${encodeRfc3986(normalizedOutTradeNo)}?mchid=${encodeRfc3986(normalizedMchid)}`;
  return requestImpl("GET", path);
}

export async function createJsapiPrepay({ description, outTradeNo, amountFen, openid, notifyUrl }) {
  if (!process.env.WECHAT_APPID || !process.env.WECHAT_MCHID) throw new Error("微信 AppID 或商户号未配置");
  return wechatRequest("POST", "/v3/pay/transactions/jsapi", {
    appid: process.env.WECHAT_APPID,
    mchid: process.env.WECHAT_MCHID,
    description,
    out_trade_no: outTradeNo,
    notify_url: notifyUrl || process.env.WECHAT_NOTIFY_URL,
    amount: { total: amountFen, currency: "CNY" },
    payer: { openid }
  });
}

export async function buildJsapiPayParams(prepayId) {
  const appId = process.env.WECHAT_APPID;
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const nonceStr = crypto.randomBytes(16).toString("hex");
  const packageValue = `prepay_id=${prepayId}`;
  const privateKey = await readKey(process.env.WECHAT_PRIVATE_KEY_PATH);
  const message = `${appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`;
  const paySign = crypto.createSign("RSA-SHA256").update(message).sign(privateKey, "base64");
  return { appId, timeStamp, nonceStr, package: packageValue, signType: "RSA", paySign };
}

export async function verifyAndDecryptNotification(rawBody, headers) {
  const timestamp = String(headers["wechatpay-timestamp"] || "");
  const nonce = String(headers["wechatpay-nonce"] || "");
  const signature = String(headers["wechatpay-signature"] || "");
  if (!timestamp || !nonce || !signature) throw new Error("缺少微信回调签名头");
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) throw new Error("微信回调已过期");
  const platformPem = await readKey(process.env.WECHAT_PLATFORM_CERT_PATH);
  const platformKey = crypto.createPublicKey(platformPem);
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  const ok = crypto.createVerify("RSA-SHA256").update(message).verify(platformKey, signature, "base64");
  if (!ok) throw new Error("微信回调签名无效");
  const notification = JSON.parse(rawBody);
  const resource = notification.resource;
  if (!resource) throw new Error("微信回调缺少 resource");
  const key = Buffer.from(process.env.WECHAT_API_V3_KEY || "", "utf8");
  if (key.length !== 32) throw new Error("WECHAT_API_V3_KEY 必须是32字节");
  const ciphertext = Buffer.from(resource.ciphertext, "base64");
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(resource.nonce, "utf8"));
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(resource.associated_data || "", "utf8"));
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"));
}
