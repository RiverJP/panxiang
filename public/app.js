const productsEl = document.querySelector("#products");
const form = document.querySelector("#order-form");
const phoneEl = document.querySelector("#phone");
const totalEl = document.querySelector("#total");
const submitEl = document.querySelector("#submit");
const messageEl = document.querySelector("#message");
let products = [];
let visibleProducts = [];
let selected = null;
const prefixMap = {
  Telkomsel: ["0811", "0812", "0813", "0821", "0822", "0823", "0851", "0852", "0853"],
  Indosat: ["0814", "0815", "0816", "0855", "0856", "0857", "0858"],
  XL: ["0817", "0818", "0819", "0859", "0877", "0878"],
  Tri: ["0895", "0896", "0897", "0898", "0899"],
  Smartfren: ["0881", "0882", "0883", "0884", "0885", "0886", "0887", "0888", "0889"]
};

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

function showMessage(text, error = true) {
  messageEl.textContent = text;
  messageEl.style.color = error ? "#c6534a" : "#2c8a63";
}

function renderProducts() {
  productsEl.innerHTML = visibleProducts.map((p) => `<button type="button" class="product ${selected?.id === p.id ? "selected" : ""}" data-id="${p.id}"><div class="op">${p.operator} · ${p.kind}</div><h3>${p.label}${p.popular ? '<span class="tag">热门</span>' : ""}</h3><div class="price">¥${p.price.toFixed(2)} <small>起</small></div></button>`).join("") || '<div class="loading">没有匹配的套餐，请更换号码或联系客服</div>';
  productsEl.querySelectorAll(".product").forEach((el) => el.addEventListener("click", () => {
    selected = products.find((p) => p.id === el.dataset.id);
    totalEl.textContent = `¥${selected.price.toFixed(2)}`;
    renderProducts();
  }));
}

async function loadCatalog() {
  try {
    const response = await fetch("/api/catalog");
    const data = await response.json();
    products = data.products || [];
    visibleProducts = products;
    renderProducts();
  } catch {
    productsEl.innerHTML = '<div class="loading">套餐加载失败，请稍后重试</div>';
  }
}

async function ensureWechatSession() {
  if (!/MicroMessenger/i.test(navigator.userAgent)) return;
  const response = await fetch("/api/wechat/session");
  const data = await response.json();
  if (!data.authorized) window.location.href = "/api/wechat/oauth/start?return=/";
}

phoneEl.addEventListener("input", () => {
  const operator = detectOperator(phoneEl.value);
  const hint = document.querySelector("#operator-hint");
  if (operator) {
    hint.textContent = `已识别运营商：${operator}，已自动筛选套餐`;
    hint.classList.add("detected");
    visibleProducts = products.filter((product) => product.operator === operator);
    if (selected && selected.operator !== operator) {
      selected = null;
      totalEl.textContent = "请选择套餐";
    }
  } else {
    hint.textContent = "输入号码后自动识别运营商";
    hint.classList.remove("detected");
    visibleProducts = products;
  }
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
