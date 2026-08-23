export function normalizeCustomerServiceUrl(value) {
  const configured = String(value || "").trim();
  if (!configured) return "";
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "work.weixin.qq.com" || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}
