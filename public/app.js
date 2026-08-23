const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const isWechat = /MicroMessenger/i.test(navigator.userAgent);
const pageSize = 12;
const orderStorageKey = "px_order_refs_v1";

const els = {
  form: $("#order-form"), phone: $("#phone"), clearPhone: $("#clear-phone"), hint: $("#operator-hint"),
  kindFilters: $("#kind-filters"), operatorFilters: $("#operator-filters"), products: $("#products"),
  summary: $("#catalog-summary"), loadMore: $("#load-more"), checkoutBar: $("#checkout-bar"),
  checkout: $("#checkout"), checkoutLabel: $("#checkout-label"), total: $("#total"),
  confirmSheet: $("#confirm-sheet"), confirmPay: $("#confirm-pay"), paymentMessage: $("#payment-message"),
  ordersList: $("#orders-list"), orderDetail: $("#order-detail"), infoSheet: $("#info-sheet"),
  infoTitle: $("#info-title"), infoContent: $("#info-content"), toast: $("#toast")
};

const prefixMap = {
  Telkomsel: ["0811", "0812", "0813", "0821", "0822", "0823", "0851", "0852", "0853"],
  Indosat: ["0814", "0815", "0816", "0855", "0856", "0857", "0858"],
  XL: ["0817", "0818", "0819", "0859", "0877", "0878"],
  AXIS: ["0831", "0832", "0833", "0838"], Tri: ["0895", "0896", "0897", "0898", "0899"],
  Smartfren: ["0881", "0882", "0883", "0884", "0885", "0886", "0887", "0888", "0889"]
};

const statusMeta = {
  created: ["订单已创建", "等待进入支付流程", "progress"],
  pending_payment: ["待支付", "请完成微信支付", "progress"],
  payment_pending: ["支付确认中", "正在确认微信支付结果", "progress"],
  paid_pending_recharge: ["已支付，等待充值", "款项已确认，即将提交充值", "progress"],
  recharge_processing: ["充值处理中", "运营商正在处理，请耐心等待", "progress"],
  recharge_success: ["充值成功", "套餐已充值到指定号码", "success"],
  refund_required: ["待退款处理", "充值未完成，客服将核查并处理退款", "danger"],
  refunded: ["已退款", "款项已按原支付方式退回", "danger"],
  manual_review: ["人工处理中", "客服正在核查本订单", "progress"]
};
const terminalStatuses = new Set(["recharge_success", "refunded"]);
const state = { products: [], selected: null, kind: "all", operator: "all", detectedOperator: null, visibleLimit: pageSize, route: "recharge", pollTimer: null, pollCount: 0, wechatAuthorized: false, accountOrderIds: new Set(), paymentFallbackOrderId: null, customerServiceUrl: "", publicConfigLoaded: false };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function formatMoney(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(amount) : "—";
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function normalizePhone(value) {
  const raw = String(value || "").replace(/[^\d+]/g, "");
  if (raw.startsWith("+62")) return `0${raw.slice(3)}`;
  if (raw.startsWith("62")) return `0${raw.slice(2)}`;
  if (raw.startsWith("8")) return `0${raw}`;
  return raw;
}

function displayPhone(value) {
  const local = normalizePhone(value);
  return local.startsWith("0") ? `+62 ${local.slice(1).replace(/(\d{3})(?=\d)/g, "$1 ")}` : value;
}

function validPhone(value) { return /^08\d{8,12}$/.test(normalizePhone(value)); }
function normalizedOperator(value) { return String(value || "").trim().toLocaleLowerCase("en-US"); }
function detectOperator(value) {
  const phone = normalizePhone(value);
  return Object.entries(prefixMap).find(([, prefixes]) => prefixes.some((prefix) => phone.startsWith(prefix)))?.[0] || null;
}

function classifyProduct(product) {
  const explicit = String(product?.category || "").toLowerCase();
  if (["data", "internet", "quota"].includes(explicit)) return "data";
  if (["airtime", "topup", "pulsa"].includes(explicit)) return "topup";
  const text = `${product?.kind || ""} ${product?.label || product?.name || ""} ${product?.sku || product?.id || ""}`.toLowerCase();
  if (/流量|\b(data|internet|quota)\b|\d+(\.\d+)?\s*(gb|mb)\b/i.test(text)) return "data";
  if (/话费|充值|top[\s_-]?up|airtime|pulsa|reload|tk\d+/i.test(text)) return "topup";
  return null;
}

function prepareProduct(product) {
  const id = String(product?.id || product?.sku || "").trim();
  const price = Number(product?.price);
  const category = classifyProduct(product);
  if (!id || !category || !Number.isFinite(price) || price <= 0) return null;
  return { ...product, id, price, category, operator: String(product.operator || "其他运营商").trim(), label: String(product.label || product.name || id).trim() };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let data = {};
  try { data = await response.json(); } catch { /* Preserve a useful generic error. */ }
  if (!response.ok) throw new Error(data.message || `请求失败（${response.status}）`);
  return data;
}

let toastTimer;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2600);
}

function readOrderRefs() {
  try {
    const refs = JSON.parse(localStorage.getItem(orderStorageKey) || "[]");
    return Array.isArray(refs) ? refs.filter((item) => item?.id).slice(0, 50) : [];
  } catch { return []; }
}

function saveOrderRef(ref) {
  const next = [ref, ...readOrderRefs().filter((item) => item.id !== ref.id)].slice(0, 50);
  try { localStorage.setItem(orderStorageKey, JSON.stringify(next)); } catch { /* Private mode can reject storage. */ }
  updateIdentity();
}

function findOrderRef(id) { return readOrderRefs().find((item) => item.id === id); }
function orderUrl(ref) { return `/api/orders/${encodeURIComponent(ref.id)}${ref.token ? `?token=${encodeURIComponent(ref.token)}` : ""}`; }

function setRoute(route, orderId, replace = false) {
  const allowed = new Set(["recharge", "orders", "order", "services", "me"]);
  const next = allowed.has(route) ? route : "recharge";
  const url = new URL(location.href);
  if (next === "recharge") url.searchParams.delete("view"); else url.searchParams.set("view", next);
  if (next === "order" && orderId) url.searchParams.set("id", orderId); else url.searchParams.delete("id");
  history[replace ? "replaceState" : "pushState"]({ view: next, id: orderId || null }, "", `${url.pathname}${url.search}${url.hash}`);
  renderRoute(next, orderId);
}

function renderRoute(route, orderId) {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.route = route;
  $$(".app-view").forEach((view) => { view.hidden = view.dataset.view !== route; });
  const navRoute = route === "order" ? "orders" : route;
  $$(".bottom-nav [data-route]").forEach((button) => button.classList.toggle("active", button.dataset.route === navRoute));
  els.checkoutBar.hidden = route !== "recharge";
  scrollTo({ top: 0, behavior: "smooth" });
  if (route === "orders") loadOrders();
  if (route === "order") loadOrderDetail(orderId, true);
  if (route === "me") updateIdentity();
}

function updateCheckout() {
  els.checkoutLabel.textContent = state.selected ? state.selected.label : "尚未选择套餐";
  els.total.textContent = state.selected ? formatMoney(state.selected.price) : "¥0.00";
  els.checkout.disabled = !state.selected || !validPhone(els.phone.value) || !state.detectedOperator;
}

function operatorOptions() {
  const map = new Map();
  state.products.forEach((product) => map.set(normalizedOperator(product.operator), product.operator));
  return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], "zh-CN", { numeric: true }));
}

function renderOperatorFilters() {
  const locked = Boolean(state.detectedOperator);
  const detectedKey = normalizedOperator(state.detectedOperator);
  const options = [["all", "全部运营商"], ...operatorOptions()];
  els.operatorFilters.innerHTML = options.map(([key, label]) => {
    const active = state.operator === key;
    const disabled = locked && key !== detectedKey;
    return `<button type="button" data-operator="${escapeHtml(key)}" class="${active ? "active" : ""}" aria-pressed="${active}"${disabled ? " disabled" : ""}>${escapeHtml(label)}</button>`;
  }).join("");
}

function renderProducts() {
  const filtered = state.products.filter((product) => (state.kind === "all" || product.category === state.kind) && (state.operator === "all" || normalizedOperator(product.operator) === state.operator));
  if (state.selected && !filtered.some((item) => item.id === state.selected.id)) state.selected = null;
  const shown = filtered.slice(0, state.visibleLimit);
  els.products.innerHTML = shown.map((product) => `<button type="button" class="product${state.selected?.id === product.id ? " selected" : ""}" data-id="${escapeHtml(product.id)}" aria-pressed="${state.selected?.id === product.id}"><div class="op">${escapeHtml(product.operator)} · ${product.category === "data" ? "流量" : "话费"}</div><h3>${escapeHtml(product.label)}${product.popular ? '<span class="tag">热门</span>' : ""}</h3>${product.description ? `<p class="product-description">${escapeHtml(product.description)}</p>` : ""}<div class="price">${formatMoney(product.price)} <small>起</small></div></button>`).join("") || '<div class="empty-state">暂无匹配套餐，请调整筛选或联系客服</div>';
  els.summary.textContent = filtered.length ? `${state.detectedOperator ? `已匹配 ${state.detectedOperator}，` : ""}共 ${filtered.length} 个套餐` : "当前筛选下暂无套餐";
  const remaining = Math.max(filtered.length - shown.length, 0);
  els.loadMore.hidden = remaining === 0;
  els.loadMore.textContent = remaining ? `查看更多（剩余 ${remaining} 个）` : "查看更多";
  $$("[data-kind]", els.kindFilters).forEach((button) => { const active = button.dataset.kind === state.kind; button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); });
  renderOperatorFilters();
  updateCheckout();
}

async function loadCatalog() {
  try {
    const data = await fetchJson("/api/catalog");
    state.products = (Array.isArray(data.products) ? data.products : []).map(prepareProduct).filter(Boolean);
    renderProducts();
  } catch (error) {
    els.products.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}，请稍后重试</div>`;
    els.summary.textContent = "";
  }
}

function handlePhoneInput() {
  const operator = detectOperator(els.phone.value);
  state.detectedOperator = operator;
  if (operator) {
    const available = state.products.some((product) => normalizedOperator(product.operator) === normalizedOperator(operator));
    els.hint.textContent = available ? `已识别：${operator}，以下为匹配套餐` : `已识别：${operator}，当前暂无可售套餐`;
    els.hint.className = `field-hint ${available ? "detected" : "error"}`;
    state.operator = normalizedOperator(operator);
  } else {
    els.hint.textContent = els.phone.value ? "继续输入有效的印尼手机号码" : "输入完整号码后自动识别运营商";
    els.hint.className = "field-hint";
    state.operator = "all";
  }
  state.visibleLimit = pageSize;
  renderProducts();
}

function openSheet(sheet) { sheet.hidden = false; document.body.style.overflow = "hidden"; }
function closeSheet(sheet) { sheet.hidden = true; document.body.style.overflow = ""; }

function openConfirmation() {
  if (!validPhone(els.phone.value)) { els.phone.focus(); return showToast("请输入有效的印尼手机号"); }
  if (!state.detectedOperator) return showToast("暂时无法识别该号码的运营商");
  if (!state.selected) return showToast("请先选择充值套餐");
  if (normalizedOperator(state.selected.operator) !== normalizedOperator(state.detectedOperator)) return showToast(`该号码属于 ${state.detectedOperator}，请重新选择套餐`);
  $("#confirm-phone").textContent = displayPhone(els.phone.value);
  $("#confirm-operator").textContent = state.detectedOperator;
  $("#confirm-product").textContent = state.selected.label;
  $("#confirm-price").textContent = formatMoney(state.selected.price);
  els.paymentMessage.textContent = "";
  els.paymentMessage.classList.remove("error");
  state.paymentFallbackOrderId = null;
  els.confirmPay.disabled = false;
  els.confirmPay.textContent = "确认并微信支付";
  openSheet(els.confirmSheet);
}

function invokeWechatPay(payment) {
  return new Promise((resolve, reject) => {
    const invoke = () => window.WeixinJSBridge.invoke("getBrandWCPayRequest", payment, (result) => {
      const value = result?.err_msg || "";
      if (value === "get_brand_wcpay_request:ok") resolve(result);
      else if (value === "get_brand_wcpay_request:cancel") reject(new Error("你已取消支付，可在订单记录中查看状态"));
      else reject(new Error("支付未完成，请在订单记录中确认状态"));
    });
    if (window.WeixinJSBridge) invoke();
    else document.addEventListener("WeixinJSBridgeReady", invoke, { once: true });
  });
}

async function createAndPay() {
  if (state.paymentFallbackOrderId) {
    const orderId = state.paymentFallbackOrderId;
    state.paymentFallbackOrderId = null;
    closeSheet(els.confirmSheet);
    setRoute("order", orderId);
    return;
  }
  if (!isWechat) { els.paymentMessage.textContent = "请从服务号菜单进入本页面后支付"; els.paymentMessage.classList.add("error"); return; }
  els.confirmPay.disabled = true;
  els.confirmPay.textContent = "正在创建订单…";
  let createdRef = null;
  try {
    if (!state.wechatAuthorized) {
      location.href = `/api/wechat/oauth/start?return=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
      return;
    }
    const data = await fetchJson("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId: state.selected.id, phone: els.phone.value }) });
    createdRef = { id: data.order.id, token: data.lookupToken, createdAt: data.order.createdAt };
    saveOrderRef(createdRef);
    els.confirmPay.textContent = "正在调起微信支付…";
    const pay = await fetchJson("/api/wechat/prepay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: data.order.id }) });
    await invokeWechatPay(pay.payment);
    closeSheet(els.confirmSheet);
    showToast("支付已提交，正在确认充值状态");
    setRoute("order", data.order.id);
  } catch (error) {
    els.paymentMessage.textContent = error.message;
    els.paymentMessage.classList.add("error");
    if (createdRef) {
      state.paymentFallbackOrderId = createdRef.id;
      els.confirmPay.textContent = "查看订单状态";
      els.confirmPay.disabled = false;
    } else {
      els.confirmPay.textContent = "重新尝试";
      els.confirmPay.disabled = false;
    }
  }
}

async function payExistingOrder(orderId) {
  if (!isWechat) return showToast("请从盼享通服务号内继续支付");
  const button = $("#continue-payment");
  if (button) { button.disabled = true; button.textContent = "正在调起支付…"; }
  try {
    if (!state.wechatAuthorized) {
      const returnPath = `${location.pathname}${location.search}`;
      location.href = `/api/wechat/oauth/start?return=${encodeURIComponent(returnPath)}`;
      return;
    }
    const pay = await fetchJson("/api/wechat/prepay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId })
    });
    await invokeWechatPay(pay.payment);
    showToast("支付已提交，正在确认充值状态");
    loadOrderDetail(orderId, true);
  } catch (error) {
    showToast(error.message);
    loadOrderDetail(orderId, false);
  }
}

function metaFor(status) { return statusMeta[status] || ["状态更新中", "正在获取最新处理结果", "progress"]; }

async function loadOrders() {
  const refs = readOrderRefs();
  els.ordersList.innerHTML = '<div class="empty-state">正在同步订单状态…</div>';
  let accountOrders = [];
  if (isWechat) {
    try {
      const data = await fetchJson("/api/me/orders?limit=50");
      accountOrders = Array.isArray(data.orders) ? data.orders : [];
      state.wechatAuthorized = true;
      state.accountOrderIds = new Set(accountOrders.map((order) => order.id));
    } catch { state.accountOrderIds = new Set(); }
  }
  const accountIds = new Set(accountOrders.map((order) => order.id));
  const localResults = await Promise.all(refs.filter((ref) => !accountIds.has(ref.id)).map(async (ref) => {
    try { return { ref, order: (await fetchJson(orderUrl(ref))).order }; } catch (error) { return { ref, error }; }
  }));
  const results = [...accountOrders.map((order) => ({ ref: { id: order.id }, order })), ...localResults]
    .sort((left, right) => Date.parse(right.order?.createdAt || right.ref?.createdAt || 0) - Date.parse(left.order?.createdAt || left.ref?.createdAt || 0));
  $("#my-order-count").textContent = String(results.length);
  if (!results.length) { els.ordersList.innerHTML = '<div class="empty-state">还没有充值订单<br>完成首笔下单后可在这里查看进度</div>'; return; }
  els.ordersList.innerHTML = results.map(({ ref, order, error }) => {
    if (error) return `<button type="button" class="order-row" data-order-id="${escapeHtml(ref.id)}"><div class="order-row-head"><small>${escapeHtml(ref.id)}</small><span class="status-chip danger">查询失败</span></div><h3>暂时无法获取订单</h3><p>${escapeHtml(error.message)}</p></button>`;
    const meta = metaFor(order.status);
    return `<button type="button" class="order-row" data-order-id="${escapeHtml(order.id)}"><div class="order-row-head"><small>${formatTime(order.createdAt)}</small><span class="status-chip ${meta[2]}">${meta[0]}</span></div><h3>${escapeHtml(order.productLabel)}</h3><div class="order-row-foot"><p>${escapeHtml(order.phone)}</p><strong>${formatMoney(order.price)}</strong></div></button>`;
  }).join("");
}

function timelineFor(order) {
  const status = order.status;
  const paymentDone = !["created", "pending_payment", "payment_pending"].includes(status);
  const submitted = ["recharge_processing", "recharge_success", "refund_required", "refunded", "manual_review"].includes(status);
  const finished = terminalStatuses.has(status);
  const rows = [
    [true, "订单已创建", formatTime(order.createdAt)],
    [paymentDone, paymentDone ? "微信支付已确认" : "等待支付确认", ""],
    [submitted, submitted ? "已提交运营商处理" : "等待提交充值", ""],
    [finished, status === "refunded" ? "退款已完成" : finished ? "充值已完成" : "等待最终结果", formatTime(order.updatedAt)]
  ];
  return rows.map(([done, label, time]) => `<div class="timeline-item${done ? " done" : ""}">${escapeHtml(label)}${time ? `<br><small>${escapeHtml(time)}</small>` : ""}</div>`).join("");
}

function renderOrderDetail(order) {
  const meta = metaFor(order.status);
  const symbol = order.status === "recharge_success" ? "✓" : order.status === "refunded" ? "↩" : "…";
  const payable = ["created", "pending_payment", "payment_pending"].includes(order.status);
  els.orderDetail.innerHTML = `<article class="order-detail-card"><div class="order-status-hero"><div class="status-symbol">${symbol}</div><h1>${meta[0]}</h1><p>${escapeHtml(meta[1])}${terminalStatuses.has(order.status) ? "" : " · 页面将自动刷新"}</p></div><dl class="detail-list"><div><dt>充值套餐</dt><dd>${escapeHtml(order.productLabel)}</dd></div><div><dt>充值号码</dt><dd>${escapeHtml(order.phone)}</dd></div><div><dt>实付金额</dt><dd>${formatMoney(order.price)}</dd></div><div><dt>订单编号</dt><dd>${escapeHtml(order.id)}</dd></div><div><dt>创建时间</dt><dd>${formatTime(order.createdAt)}</dd></div></dl><div class="timeline"><h2>处理进度</h2>${timelineFor(order)}</div>${payable ? '<div class="payment-action"><button type="button" id="continue-payment">继续微信支付</button></div>' : ""}<div class="detail-actions"><button type="button" id="manual-refresh">刷新状态</button><button type="button" id="detail-support">联系客服</button></div></article>`;
  $("#continue-payment")?.addEventListener("click", () => payExistingOrder(order.id));
  $("#manual-refresh")?.addEventListener("click", () => loadOrderDetail(order.id, false));
  $("#detail-support")?.addEventListener("click", () => showSupport("订单问题"));
}

async function loadOrderDetail(id, resetPoll) {
  clearTimeout(state.pollTimer);
  const localRef = findOrderRef(id);
  const ref = localRef || (isWechat ? { id } : null);
  if (!id || !ref) { els.orderDetail.innerHTML = '<div class="empty-state">未找到本机订单凭证，请从订单列表重新进入</div>'; return; }
  if (resetPoll) { state.pollCount = 0; els.orderDetail.innerHTML = '<div class="empty-state">正在查询最新状态…</div>'; }
  try {
    const order = (await fetchJson(orderUrl(ref))).order;
    renderOrderDetail(order);
    if (!terminalStatuses.has(order.status) && state.route === "order") {
      state.pollCount += 1;
      const delay = Math.min(3000 + state.pollCount * 700, 12000);
      state.pollTimer = setTimeout(() => loadOrderDetail(id, false), delay);
    }
  } catch (error) {
    els.orderDetail.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}<br><button class="load-more" id="retry-detail" type="button">重新查询</button></div>`;
    $("#retry-detail")?.addEventListener("click", () => loadOrderDetail(id, true));
  }
}

function showInfo(title, html) {
  els.infoTitle.textContent = title;
  els.infoContent.innerHTML = html;
  openSheet(els.infoSheet);
}

async function loadPublicConfig() {
  if (state.publicConfigLoaded) return;
  try {
    const config = await fetchJson("/api/public-config");
    state.customerServiceUrl = String(config.customerServiceUrl || "");
    state.publicConfigLoaded = true;
  } catch {
    state.customerServiceUrl = "";
  }
}

async function showSupport(service = "服务咨询") {
  await loadPublicConfig();
  const contactAction = state.customerServiceUrl
    ? `<a class="support-action" href="${escapeHtml(state.customerServiceUrl)}">打开企业微信客服</a><p class="support-fallback">如果没有自动打开，请返回“盼享通”服务号，在对话框发送关键词 <strong>客服</strong>。</p>`
    : '<p>请关闭网页回到“盼享通”服务号，在对话框发送关键词 <strong>客服</strong>，并说明需要咨询的业务。</p>';
  showInfo(service, `<h3>联系客服</h3>${contactAction}<h3>温馨提示</h3><p>办理条件、费用、周期及所需材料以客服最终确认为准，请勿提供支付密码、短信验证码等敏感信息。</p>`);
}

async function updateIdentity() {
  const count = readOrderRefs().length;
  $("#my-order-count").textContent = String(count);
  const title = $("#identity-title"), copy = $("#identity-copy"), badge = $("#identity-status");
  if (!title) return;
  if (!isWechat) { title.textContent = "微信访客"; copy.textContent = "请从服务号菜单进入以使用微信支付"; badge.textContent = "浏览模式"; badge.className = "status-badge"; return; }
  try {
    const session = await fetchJson("/api/wechat/session");
    state.wechatAuthorized = Boolean(session.authorized);
    title.textContent = state.wechatAuthorized ? "微信用户" : "等待微信授权";
    copy.textContent = state.wechatAuthorized ? "已连接盼享通服务号" : "重新进入页面即可完成静默授权";
    badge.textContent = state.wechatAuthorized ? "已登录" : "未登录";
    badge.className = `status-badge${state.wechatAuthorized ? " ok" : ""}`;
  } catch { copy.textContent = "暂时无法确认登录状态"; badge.textContent = "离线"; }
}

async function ensureWechatSession() {
  if (!isWechat) { updateIdentity(); return; }
  try {
    const session = await fetchJson("/api/wechat/session");
    state.wechatAuthorized = Boolean(session.authorized);
    if (!state.wechatAuthorized) {
      const returnPath = `${location.pathname}${location.search}`;
      location.href = `/api/wechat/oauth/start?return=${encodeURIComponent(returnPath)}`;
      return;
    }
  } catch { /* Catalog remains available if session check is temporarily unavailable. */ }
  updateIdentity();
}

document.addEventListener("click", (event) => {
  const routeButton = event.target.closest("[data-route]");
  if (routeButton) setRoute(routeButton.dataset.route);
  const supportButton = event.target.closest("[data-support]");
  if (supportButton) showSupport(supportButton.dataset.support);
  const infoButton = event.target.closest("[data-info]");
  if (infoButton?.dataset.info === "guide") showInfo("充值须知", "<h3>核对手机号</h3><p>提交前请确认号码和运营商正确，充值成功后通常无法撤回。</p><h3>到账时间</h3><p>支付成功不等于充值完成，请以订单详情中的最终状态为准。</p><h3>失败与退款</h3><p>未成功受理的订单将按系统状态进入退款或人工核查流程。</p>");
  if (infoButton?.dataset.info === "about") showInfo("关于盼享随充", "<p>盼享随充为在印度尼西亚生活或旅行的用户提供通信充值及生活服务咨询。</p><p>商品库存和到账结果以供应商及运营商处理结果为准。</p>");
});

els.kindFilters.addEventListener("click", (event) => { const button = event.target.closest("[data-kind]"); if (!button) return; state.kind = button.dataset.kind; state.visibleLimit = pageSize; renderProducts(); });
els.operatorFilters.addEventListener("click", (event) => { const button = event.target.closest("[data-operator]"); if (!button || button.disabled) return; state.operator = button.dataset.operator; state.visibleLimit = pageSize; renderProducts(); });
els.products.addEventListener("click", (event) => { const button = event.target.closest("[data-id]"); if (!button) return; state.selected = state.products.find((product) => product.id === button.dataset.id) || null; renderProducts(); });
els.loadMore.addEventListener("click", () => { state.visibleLimit += pageSize; renderProducts(); });
els.phone.addEventListener("input", handlePhoneInput);
els.clearPhone.addEventListener("click", () => { els.phone.value = ""; handlePhoneInput(); els.phone.focus(); });
els.form.addEventListener("submit", (event) => { event.preventDefault(); openConfirmation(); });
els.checkout.addEventListener("click", openConfirmation);
els.confirmPay.addEventListener("click", createAndPay);
$$('[data-close-sheet]').forEach((button) => button.addEventListener("click", () => closeSheet(els.confirmSheet)));
$$('[data-close-info]').forEach((button) => button.addEventListener("click", () => closeSheet(els.infoSheet)));
$("#show-help").addEventListener("click", () => showSupport());
$("#refresh-orders").addEventListener("click", loadOrders);
els.ordersList.addEventListener("click", (event) => { const row = event.target.closest("[data-order-id]"); if (row) setRoute("order", row.dataset.orderId); });
$("#order-back").addEventListener("click", () => setRoute("orders"));
window.addEventListener("popstate", () => { const url = new URL(location.href); renderRoute(url.searchParams.get("view") || "recharge", url.searchParams.get("id")); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { if (!els.confirmSheet.hidden) closeSheet(els.confirmSheet); if (!els.infoSheet.hidden) closeSheet(els.infoSheet); } });

const initialUrl = new URL(location.href);
renderRoute(initialUrl.searchParams.get("view") || "recharge", initialUrl.searchParams.get("id"));
loadCatalog();
loadPublicConfig();
ensureWechatSession();
