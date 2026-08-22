const productsEl = document.querySelector("#products");
const form = document.querySelector("#order-form");
const phoneEl = document.querySelector("#phone");
const totalEl = document.querySelector("#total");
const submitEl = document.querySelector("#submit");
const messageEl = document.querySelector("#message");
const kindFiltersEl = document.querySelector("#kind-filters");
const operatorFiltersEl = document.querySelector("#operator-filters");
const catalogSummaryEl = document.querySelector("#catalog-summary");
const loadMoreEl = document.querySelector("#load-more");
const pageSize = 12;

let products = [];
let selected = null;
let kindFilter = "all";
let operatorFilter = "all";
let detectedOperatorKey = null;
let visibleLimit = pageSize;

const prefixMap = {
  Telkomsel: ["0811", "0812", "0813", "0821", "0822", "0823", "0851", "0852", "0853"],
  Indosat: ["0814", "0815", "0816", "0855", "0856", "0857", "0858"],
  XL: ["0817", "0818", "0819", "0859", "0877", "0878"],
  AXIS: ["0831", "0832", "0833", "0838"],
  Tri: ["0895", "0896", "0897", "0898", "0899"],
  Smartfren: ["0881", "0882", "0883", "0884", "0885", "0886", "0887", "0888", "0889"]
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function normalizePhone(value) {
  const raw = String(value || "").replace(/[\s()-]/g, "");
  if (raw.startsWith("+62")) return `0${raw.slice(3)}`;
  if (raw.startsWith("62")) return `0${raw.slice(2)}`;
  return raw;
}

function detectOperator(value) {
  const phone = normalizePhone(value);
  return Object.entries(prefixMap).find(([, prefixes]) => prefixes.some((prefix) => phone.startsWith(prefix)))?.[0] || null;
}

function normalizeOperator(value) {
  return String(value || "").trim().toLocaleLowerCase("en-US");
}

function classifyProduct(product) {
  const explicitCategory = String(product?.category || "").trim().toLocaleLowerCase("en-US");
  if (["data", "internet", "quota"].includes(explicitCategory)) return "data";
  if (["airtime", "topup", "pulsa"].includes(explicitCategory)) return "topup";
  const kind = String(product?.kind || "");
  const label = String(product?.label || product?.name || "");
  const sku = String(product?.sku || product?.id || "");
  const source = `${kind} ${label} ${sku}`.toLocaleLowerCase("en-US");
  if (/流量|(?:^|[^a-z])(data|internet|quota)(?:$|[^a-z])|\d+(?:\.\d+)?\s*(gb|mb)\b/i.test(source)) return "data";
  if (/话费|充值|top[\s_-]?up|airtime|pulsa|reload|(?:^|[^a-z])tk\d+/i.test(source)) return "topup";
  return null;
}

function kindLabel(kind) {
  return kind === "data" ? "流量" : "话费";
}

function prepareProduct(product) {
  const id = String(product?.id || product?.sku || "").trim();
  const price = Number(product?.price);
  const category = classifyProduct(product);
  if (!id || !category || !Number.isFinite(price) || price <= 0) return null;
  return {
    ...product,
    id,
    price,
    category,
    operator: String(product?.operator || "其他运营商").trim() || "其他运营商",
    label: String(product?.label || product?.name || product?.sku || id).trim() || id
  };
}

function showMessage(text, error = true) {
  messageEl.textContent = text;
  messageEl.style.color = error ? "#c6534a" : "#2c8a63";
}

function operatorOptions() {
  const options = new Map();
  for (const product of products) {
    const key = normalizeOperator(product.operator);
    if (key && !options.has(key)) options.set(key, product.operator);
  }
  const detectedLabel = Object.keys(prefixMap).find((operator) => normalizeOperator(operator) === detectedOperatorKey);
  if (detectedOperatorKey && detectedLabel && !options.has(detectedOperatorKey)) options.set(detectedOperatorKey, detectedLabel);
  return [...options.entries()].sort((left, right) => left[1].localeCompare(right[1], "zh-CN", { numeric: true }));
}

function renderOperatorFilters() {
  const locked = Boolean(detectedOperatorKey);
  const options = [["all", "全部运营商"], ...operatorOptions()];
  operatorFiltersEl.innerHTML = options.map(([key, label]) => {
    const active = operatorFilter === key;
    const disabled = locked && key !== detectedOperatorKey;
    return `<button type="button" class="filter-chip${active ? " active" : ""}" data-operator="${escapeHtml(key)}" aria-pressed="${active}"${disabled ? " disabled" : ""}>${escapeHtml(label)}</button>`;
  }).join("");
}

function productMatchesFilters(product) {
  const kindMatches = kindFilter === "all" || product.category === kindFilter;
  const operatorMatches = operatorFilter === "all" || normalizeOperator(product.operator) === operatorFilter;
  return kindMatches && operatorMatches;
}

function resetSelectedIfHidden(filteredProducts) {
  if (!selected || filteredProducts.some((product) => product.id === selected.id)) return;
  selected = null;
  totalEl.textContent = "请选择套餐";
}

function renderProducts() {
  const filteredProducts = products.filter(productMatchesFilters);
  resetSelectedIfHidden(filteredProducts);
  const shownProducts = filteredProducts.slice(0, visibleLimit);

  productsEl.innerHTML = shownProducts.map((product) => {
    const isSelected = selected?.id === product.id;
    const description = String(product.description || "").trim();
    return `<button type="button" class="product${isSelected ? " selected" : ""}" data-id="${escapeHtml(product.id)}" aria-pressed="${isSelected}"><div class="op">${escapeHtml(product.operator)} · ${kindLabel(product.category)}</div><h3>${escapeHtml(product.label)}${product.popular ? '<span class="tag">热门</span>' : ""}</h3>${description ? `<p class="product-description">${escapeHtml(description)}</p>` : ""}<div class="price">¥${product.price.toFixed(2)} <small>起</small></div></button>`;
  }).join("") || '<div class="loading">没有匹配的话费或流量套餐，请调整筛选或联系客服</div>';

  const shownCount = Math.min(visibleLimit, filteredProducts.length);
  catalogSummaryEl.textContent = filteredProducts.length ? `共 ${filteredProducts.length} 个套餐，当前显示 ${shownCount} 个` : "当前筛选下暂无套餐";
  const remaining = Math.max(filteredProducts.length - shownCount, 0);
  loadMoreEl.hidden = remaining === 0;
  loadMoreEl.textContent = remaining ? `查看更多（剩余 ${remaining} 个）` : "查看更多";

  kindFiltersEl.querySelectorAll("[data-kind]").forEach((button) => {
    const active = button.dataset.kind === kindFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  renderOperatorFilters();
}

async function loadCatalog() {
  try {
    const response = await fetch("/api/catalog");
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "套餐加载失败");
    products = (Array.isArray(data.products) ? data.products : []).map(prepareProduct).filter(Boolean);
    visibleLimit = pageSize;
    renderProducts();
  } catch {
    productsEl.innerHTML = '<div class="loading">套餐加载失败，请稍后重试</div>';
    catalogSummaryEl.textContent = "";
    loadMoreEl.hidden = true;
  }
}

async function ensureWechatSession() {
  if (!/MicroMessenger/i.test(navigator.userAgent)) return;
  const response = await fetch("/api/wechat/session");
  const data = await response.json();
  if (!data.authorized) window.location.href = "/api/wechat/oauth/start?return=/";
}

kindFiltersEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-kind]");
  if (!button) return;
  kindFilter = button.dataset.kind;
  visibleLimit = pageSize;
  renderProducts();
});

operatorFiltersEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-operator]");
  if (!button || button.disabled) return;
  operatorFilter = button.dataset.operator;
  visibleLimit = pageSize;
  renderProducts();
});

productsEl.addEventListener("click", (event) => {
  const button = event.target.closest(".product[data-id]");
  if (!button) return;
  selected = products.find((product) => product.id === button.dataset.id) || null;
  totalEl.textContent = selected ? `¥${selected.price.toFixed(2)}` : "请选择套餐";
  renderProducts();
});

loadMoreEl.addEventListener("click", () => {
  visibleLimit += pageSize;
  renderProducts();
});

phoneEl.addEventListener("input", () => {
  const operator = detectOperator(phoneEl.value);
  const nextDetectedKey = normalizeOperator(operator);
  const hint = document.querySelector("#operator-hint");
  if (operator) {
    const hasProducts = products.some((product) => normalizeOperator(product.operator) === nextDetectedKey);
    hint.textContent = hasProducts ? `已识别运营商：${operator}，已自动筛选套餐` : `已识别运营商：${operator}，暂无已上架套餐`;
    hint.classList.add("detected");
    operatorFilter = nextDetectedKey;
  } else {
    hint.textContent = "输入号码后自动识别运营商";
    hint.classList.remove("detected");
    if (detectedOperatorKey) operatorFilter = "all";
  }
  detectedOperatorKey = nextDetectedKey || null;
  visibleLimit = pageSize;
  renderProducts();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selected) return showMessage("请先选择充值套餐");
  submitEl.disabled = true;
  showMessage("正在创建订单…", false);
  try {
    const response = await fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId: selected.id, phone: phoneEl.value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "创建订单失败");
    const payResponse = await fetch("/api/wechat/prepay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: data.order.id }) });
    const payData = await payResponse.json();
    if (!payResponse.ok) throw new Error(payData.message || "微信支付下单失败");
    if (!window.WeixinJSBridge) throw new Error("请在微信内打开此页面");
    window.WeixinJSBridge.invoke("getBrandWCPayRequest", payData.payment, (result) => {
      if (result.err_msg === "get_brand_wcpay_request:ok") showMessage(`订单 ${data.order.id} 已支付，等待充值结果`, false);
      else showMessage("支付未完成，请勿重复提交");
    });
  } catch (error) {
    showMessage(error.message);
  } finally {
    submitEl.disabled = false;
  }
});

ensureWechatSession().then(loadCatalog).catch(loadCatalog);
