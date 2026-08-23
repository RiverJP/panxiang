"use strict";

const state = {
  csrfToken: "",
  products: [],
  services: [],
  orders: [],
  selectedSkus: new Set(),
  publishedOrder: [],
  savedPublishedOrder: [],
  orderRevision: "",
  draggedPublishedSku: "",
  productPage: 1,
  productPageSize: 100,
  section: "products",
  fx: null,
  status: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const productMutationsInFlight = new Set();
let productLoadRequestId = 0;
let lastAppliedProductLoadRequestId = 0;
let serviceLoadRequestId = 0;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function notify(message, type = "success") {
  const toast = $("#toast");
  toast.textContent = String(message || "操作完成");
  toast.classList.toggle("error", type === "error");
  toast.classList.add("show");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function formatDate(value, fallback = "—") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString("zh-CN", { hour12: false });
}

function formatMoney(value, currency = "CNY") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${currency === "CNY" ? "¥" : ""}${number.toFixed(2)}${currency === "CNY" ? "" : ` ${currency}`}`;
}

const DEFAULT_PRICING_RULE = Object.freeze({ mode: "fixed", value: 120 });

function pricingRuleFromFx(fx = state.fx) {
  const mode = String(fx?.autoPricing?.mode || "").toLowerCase();
  const value = Number(fx?.autoPricing?.value);
  if (["fixed", "percent"].includes(mode) && Number.isFinite(value) && value >= 0) return { mode, value };
  return { ...DEFAULT_PRICING_RULE };
}

function pricingFormula(rule, { compact = false } = {}) {
  if (rule.mode === "percent") {
    return compact
      ? `自动售价 = IDR 买入价 ×（1 + ${rule.value}%）÷ 当前 IDR/CNY 汇率`
      : `比例加价：自动售价 = 买入价 ×（1 + ${rule.value}%）÷ 汇率；手动定价商品不受影响。`;
  }
  const value = Number(rule.value).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
  return compact
    ? `自动售价 =（IDR 买入价 + ${value} IDR）÷ 当前 IDR/CNY 汇率`
    : `固定金额：自动售价 =（买入价 + ${value} IDR）÷ 汇率；手动定价商品不受影响。`;
}

function updatePricingDraftHelp() {
  const mode = $("#pricingMode")?.value === "percent" ? "percent" : "fixed";
  const input = $("#pricingValue");
  if (!input) return;
  input.step = mode === "fixed" ? "1" : "0.01";
  input.max = mode === "fixed" ? "1000000" : "1000";
  input.placeholder = mode === "fixed" ? "例如 120" : "例如 5";
  const value = Number(input.value);
  const previewRule = { mode, value: Number.isFinite(value) && value >= 0 ? value : 0 };
  $("#pricingRuleHelp").textContent = pricingFormula(previewRule);
}

function formatFxSource(source) {
  if (source === "manual") return "后台手动设置";
  if (String(source || "").includes("open.er-api.com")) return "ExchangeRate-API 免费行情";
  return source || "—";
}

function fxHealthPresentation(fx) {
  if (fx?.pricingReady === true) return { tone: "success", label: "可自动定价", reason: fx.pricingHealthReason || "汇率与定价规则有效" };
  if (fx?.pricingHealth === "stale_fx") return { tone: "warning", label: "报价已过期", reason: fx.pricingHealthReason || "请刷新或手动设置汇率" };
  if (["missing_fx"].includes(fx?.pricingHealth)) return { tone: "warning", label: "等待汇率", reason: fx.pricingHealthReason || "尚未配置汇率" };
  return { tone: "error", label: "需要处理", reason: fx?.pricingHealthReason || "汇率或自动定价规则不可用" };
}

function renderFxHealth(fx) {
  const health = fxHealthPresentation(fx);
  const badge = $("#fxHealthBadge");
  if (badge) {
    badge.className = `status-badge ${health.tone}`;
    badge.textContent = health.label;
    badge.title = health.reason;
  }
  const foot = $(".sidebar-foot");
  if (foot) {
    const dotTone = health.tone === "success" ? "success" : health.tone;
    foot.innerHTML = `<span class="health-dot ${dotTone}"></span>后台已连接 · ${escapeHtml(health.label)}`;
    foot.title = health.reason;
  }
}

function renderFxState(fx) {
  state.fx = fx || null;
  const rate = Number(state.fx?.idrPerCny);
  $("#statRate").textContent = Number.isFinite(rate) ? rate.toLocaleString("zh-CN", { maximumFractionDigits: 4 }) : "—";
  const isManual = state.fx?.updateMode === "manual" || state.fx?.source === "manual";
  const quoteTime = isManual ? null : state.fx?.providerUpdatedAt;
  const effectiveTime = state.fx?.effectiveRateTimestamp || state.fx?.effectiveRateUpdatedAt || state.fx?.updatedAt;
  const activityTime = isManual ? state.fx?.updatedAt : (state.fx?.fetchedAt || state.fx?.updatedAt);
  $("#statRateTime").textContent = isManual
    ? (effectiveTime ? `手动设置 ${formatDate(effectiveTime)}` : "等待手动汇率")
    : (quoteTime ? `上游行情 ${formatDate(quoteTime)}` : (activityTime ? `获取于 ${formatDate(activityTime)}` : "等待汇率更新"));
  $("#manualFx").value = Number.isFinite(rate) ? String(rate) : "";
  const sourceLabel = formatFxSource(state.fx?.source);
  $("#fxSource").textContent = sourceLabel;
  $("#fxSource").title = state.fx?.source || "";
  $("#fxProviderUpdated").textContent = isManual ? "不适用（手动汇率）" : formatDate(quoteTime, "上游未提供");
  $("#fxUpdated").textContent = formatDate(activityTime);
  const refreshPolicy = $("#fxRefreshPolicy");
  if (refreshPolicy) {
    const activityTimestamp = Date.parse(activityTime || "");
    const nextAutomaticAt = isManual && Number.isFinite(activityTimestamp)
      ? new Date(activityTimestamp + 8 * 60 * 60 * 1000).toISOString()
      : null;
    refreshPolicy.textContent = isManual
      ? `手动值临时生效；预计 ${formatDate(nextAutomaticAt)} 后由在线报价覆盖，也可立即点“刷新汇率”`
      : "正常每 8 小时；异常 30 分钟重试";
  }

  const rule = pricingRuleFromFx(state.fx);
  $("#pricingMode").value = rule.mode;
  $("#pricingValue").value = String(rule.value);
  $("#autoPricingFormula").textContent = pricingFormula(rule, { compact: true });
  updatePricingDraftHelp();
  if (state.fx?.autoPricingValid === false) {
    $("#pricingRuleHelp").textContent = "当前保存的自动定价规则无效，请重新选择模式、填写数值并保存。";
  }
  renderFxHealth(state.fx);
}

async function api(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (!new Set(["GET", "HEAD", "OPTIONS"]).has(method)) headers["X-CSRF-Token"] = state.csrfToken;

  const controller = new AbortController();
  const timeoutMs = new Set(["GET", "HEAD", "OPTIONS"]).has(method) ? 15000 : 60000;
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      ...options,
      method,
      headers,
      signal: options.signal || controller.signal,
      credentials: "same-origin",
      cache: "no-store"
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("请求超时，请重试");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  let data = {};
  try { data = await response.json(); } catch { /* The status code still controls the result. */ }
  if (response.status === 401) {
    window.location.replace("/admin/login");
    throw new Error("登录状态已失效");
  }
  if (!response.ok) throw new Error(data.message || `请求失败（${response.status}）`);
  return data;
}

function setButtonBusy(button, busy, busyText = "处理中…") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function currentFilteredProducts() {
  const query = $("#productSearch").value.trim().toLowerCase();
  const category = $("#categoryFilter").value;
  const operator = $("#operatorFilter").value;
  const publish = $("#publishFilter").value;
  return state.products.filter((product) => {
    const searchText = [product.sku, product.name, product.description, product.operator].join(" ").toLowerCase();
    if (query && !searchText.includes(query)) return false;
    if (category !== "all" && product.category !== category) return false;
    if (operator !== "all" && product.operator !== operator) return false;
    if (publish === "published" && !product.published) return false;
    if (publish === "hidden" && product.published) return false;
    if (publish === "unavailable" && product.active !== false) return false;
    return true;
  });
}

function pagedProducts(filtered = currentFilteredProducts()) {
  const totalPages = Math.max(1, Math.ceil(filtered.length / state.productPageSize));
  state.productPage = Math.max(1, Math.min(state.productPage, totalPages));
  const start = (state.productPage - 1) * state.productPageSize;
  return { items: filtered.slice(start, start + state.productPageSize), totalPages };
}

function productFiltersActive() {
  return Boolean(
    $("#productSearch").value.trim()
    || $("#categoryFilter").value !== "all"
    || $("#operatorFilter").value !== "all"
    || $("#publishFilter").value !== "all"
  );
}

function formatSyncTypes(types) {
  if (!Array.isArray(types) || !types.length) return "—";
  return types.map((type) => ["all", "*"].includes(String(type).toLowerCase()) ? "all（无类型筛选）" : String(type)).join("、");
}

function syncCompleteness(sync) {
  if (!sync || !sync.completedAt) return { text: "尚未同步", className: "unknown" };
  return sync.catalogComplete === true
    ? { text: "已确认完整", className: "complete" }
    : { text: "未确认完整", className: "incomplete" };
}

function renderProductDiagnostics(filteredCount = currentFilteredProducts().length) {
  const sync = state.status?.sync || null;
  const completeness = syncCompleteness(sync);
  $("#diagnosticFilteredCount").textContent = Number(filteredCount).toLocaleString("zh-CN");
  $("#diagnosticLocalCount").textContent = state.products.length.toLocaleString("zh-CN");
  $("#diagnosticSupplierCount").textContent = sync?.supplierCount == null ? "—" : Number(sync.supplierCount).toLocaleString("zh-CN");
  $("#diagnosticQueryTypes").textContent = formatSyncTypes(sync?.queriedTypes);
  $("#diagnosticPages").textContent = sync?.pages == null ? "—" : Number(sync.pages).toLocaleString("zh-CN");
  const completenessElement = $("#diagnosticCompleteness");
  completenessElement.textContent = completeness.text;
  completenessElement.className = `sync-completeness ${completeness.className}`;
  $("#clearProductFilters").disabled = !productFiltersActive();
}

function productSellPrice(product) {
  const price = Number(product?.sellPriceCny ?? (product?.priceMode === "manual" ? product?.priceCny : product?.autoPriceCny));
  return Number.isFinite(price) && price > 0 ? price : null;
}

function normalizeSortOrder(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(-9999, Math.min(9999, Math.round(parsed))) : 0;
}

function comparePublishedProducts(left, right) {
  return normalizeSortOrder(left?.sortOrder) - normalizeSortOrder(right?.sortOrder)
    || Number(Boolean(right?.popular)) - Number(Boolean(left?.popular))
    || (productSellPrice(left) ?? Number.POSITIVE_INFINITY) - (productSellPrice(right) ?? Number.POSITIVE_INFINITY)
    || String(left?.sku || "").localeCompare(String(right?.sku || ""));
}

function publishedProducts() {
  return state.products
    .filter((product) => product.published === true)
    .sort(comparePublishedProducts);
}

function resetPublishedOrderFromProducts(preferredOrder = []) {
  const products = publishedProducts();
  const publishedSkus = new Set(products.map((product) => String(product.sku)));
  const seen = new Set();
  const orderedSkus = [];
  for (const sku of Array.isArray(preferredOrder) ? preferredOrder : []) {
    const normalizedSku = String(sku || "");
    if (!publishedSkus.has(normalizedSku) || seen.has(normalizedSku)) continue;
    seen.add(normalizedSku);
    orderedSkus.push(normalizedSku);
  }
  for (const product of products) {
    const sku = String(product.sku);
    if (seen.has(sku)) continue;
    seen.add(sku);
    orderedSkus.push(sku);
  }
  state.publishedOrder = orderedSkus;
  state.savedPublishedOrder = [...state.publishedOrder];
  state.draggedPublishedSku = "";
  renderPublishedProducts();
}

function publishedOrderIsDirty() {
  return state.publishedOrder.length !== state.savedPublishedOrder.length
    || state.publishedOrder.some((sku, index) => sku !== state.savedPublishedOrder[index]);
}

function publishedProductsInOrder() {
  const bySku = new Map(publishedProducts().map((product) => [String(product.sku), product]));
  return state.publishedOrder.map((sku) => bySku.get(String(sku))).filter(Boolean);
}

function publishedProductAvailability(product) {
  if (product.storefrontVisible === true) {
    return { sellable: true, label: "前台可售", reason: "用户可正常购买" };
  }
  if (product.active !== true) {
    return { sellable: false, label: "暂不可售", reason: product.unavailableReason || "最近确认的完整目录中已缺失" };
  }
  if (!["airtime", "data"].includes(String(product.category || ""))) {
    return { sellable: false, label: "暂不可售", reason: "尚未选择话费或流量分类" };
  }
  if (!String(product.operator || "").trim() || String(product.operator).trim() === "未知运营商") {
    return { sellable: false, label: "暂不可售", reason: "尚未填写运营商" };
  }
  if ((product.sourceEligible ?? product.eligible) !== true && product.manualCatalogApproved !== true) {
    return { sellable: false, label: "暂不可售", reason: product.excludeReason || "尚未确认是印尼通信套餐" };
  }
  if (productSellPrice(product) === null) {
    return { sellable: false, label: "暂不可售", reason: product.autoPriceReason || "售价尚未生成" };
  }
  return { sellable: false, label: "暂不可售", reason: "当前未通过前台可售校验" };
}

function publishedProductRow(product, index, total) {
  const category = product.category === "data" ? "流量套餐" : product.category === "airtime" ? "话费充值" : "待分类";
  const availability = publishedProductAvailability(product);
  return `<tr class="published-order-row" data-sku="${escapeHtml(product.sku)}" draggable="true">
    <td><span class="rank-number">${index + 1}</span></td>
    <td><button class="drag-handle" type="button" aria-label="拖动 ${escapeHtml(product.name || product.sku)}" title="按住拖动">⠿</button></td>
    <td><div class="sku-title">${escapeHtml(product.name || product.sku)}</div><div class="subline">${escapeHtml(product.sku)}</div></td>
    <td><div>${escapeHtml(product.operator || "未知运营商")}</div><span class="category-badge ${escapeHtml(product.category || "airtime")}">${category}</span></td>
    <td class="money">${escapeHtml(formatMoney(productSellPrice(product)))}</td>
    <td><span class="sale-state ${availability.sellable ? "sellable" : "unavailable"}">${availability.label}</span><div class="sale-reason">${escapeHtml(availability.reason)}</div></td>
    <td>${product.popular ? '<span class="status-badge popular">热门推荐</span>' : '<span class="subline">普通展示</span>'}</td>
    <td><div class="order-buttons"><button class="mini-button move-published" type="button" data-delta="-1" ${index === 0 ? "disabled" : ""}>上移</button><button class="mini-button move-published" type="button" data-delta="1" ${index === total - 1 ? "disabled" : ""}>下移</button></div></td>
  </tr>`;
}

function clearPublishedDropIndicators() {
  $$(".published-order-row").forEach((row) => row.classList.remove("drop-before", "drop-after"));
}

function setPublishedOrder(nextOrder) {
  state.publishedOrder = nextOrder;
  renderPublishedProducts();
}

function movePublishedProduct(sku, delta) {
  const index = state.publishedOrder.indexOf(String(sku));
  const target = index + Number(delta);
  if (index < 0 || target < 0 || target >= state.publishedOrder.length) return;
  const next = [...state.publishedOrder];
  [next[index], next[target]] = [next[target], next[index]];
  setPublishedOrder(next);
}

function dropPublishedProduct(sourceSku, targetSku, after) {
  if (!sourceSku || !targetSku || sourceSku === targetSku) return;
  const next = state.publishedOrder.filter((sku) => sku !== sourceSku);
  const targetIndex = next.indexOf(targetSku);
  if (targetIndex < 0) return;
  next.splice(targetIndex + (after ? 1 : 0), 0, sourceSku);
  setPublishedOrder(next);
}

function renderPublishedProducts() {
  const products = publishedProductsInOrder();
  const sellableCount = products.filter((product) => product.storefrontVisible === true).length;
  const unavailableCount = products.length - sellableCount;
  $("#publishedOrderCount").textContent = products.length.toLocaleString("zh-CN");
  $("#publishedSellableCount").textContent = sellableCount.toLocaleString("zh-CN");
  $("#publishedUnavailableCount").textContent = unavailableCount.toLocaleString("zh-CN");
  const warning = $("#publishedOrderWarning");
  warning.hidden = unavailableCount === 0;
  warning.innerHTML = unavailableCount === 0 ? "" : `<strong>${unavailableCount} 个已设置上架的套餐暂不可售</strong><span>具体原因已逐行标明；可到商品中心补全配置。</span><button class="text-link go-products" type="button">前往商品中心</button>`;
  $("#publishedOrderRows").innerHTML = products.length
    ? products.map((product, index) => publishedProductRow(product, index, products.length)).join("")
    : '<tr><td colspan="8" class="empty-state">暂无已设置上架的套餐，请先到商品中心选择商品上架</td></tr>';

  const dirty = publishedOrderIsDirty();
  const saveButton = $("#savePublishedOrder");
  saveButton.disabled = !dirty || products.length === 0;
  const stateLabel = $("#publishedOrderState");
  stateLabel.textContent = dirty ? "有未保存调整" : "顺序已保存";
  stateLabel.className = `order-save-state ${dirty ? "dirty" : "saved"}`;
  $("#resetPublishedOrder").disabled = !dirty;

  $$(".move-published", $("#publishedOrderRows")).forEach((button) => button.addEventListener("click", () => {
    movePublishedProduct(button.closest("tr").dataset.sku, button.dataset.delta);
  }));
  $$(".published-order-row", $("#publishedOrderRows")).forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      state.draggedPublishedSku = row.dataset.sku;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", row.dataset.sku);
      requestAnimationFrame(() => row.classList.add("dragging"));
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      clearPublishedDropIndicators();
      row.classList.add(event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2 ? "drop-after" : "drop-before");
    });
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
      dropPublishedProduct(state.draggedPublishedSku || event.dataTransfer.getData("text/plain"), row.dataset.sku, after);
      state.draggedPublishedSku = "";
      clearPublishedDropIndicators();
      $$(".published-order-row").forEach((item) => item.classList.remove("dragging"));
    });
    row.addEventListener("dragend", () => {
      state.draggedPublishedSku = "";
      clearPublishedDropIndicators();
      row.classList.remove("dragging");
    });
  });
  const goProducts = $(".go-products", warning);
  if (goProducts) goProducts.addEventListener("click", () => switchSection("products"));
}

async function savePublishedOrder() {
  const button = $("#savePublishedOrder");
  if (!publishedOrderIsDirty()) return;
  setButtonBusy(button, true, "保存中…");
  try {
    await api("/api/admin/products/order", {
      method: "PUT",
      body: JSON.stringify({ skus: state.publishedOrder, expectedRevision: state.orderRevision })
    });
    notify("前台商品顺序已保存");
    await Promise.all([loadProducts(), loadAudit()]);
  } catch (error) {
    notify(error.message, "error");
  } finally {
    setButtonBusy(button, false);
    button.disabled = !publishedOrderIsDirty() || state.publishedOrder.length === 0;
  }
}

function productRow(product) {
  const sku = String(product.sku);
  const active = product.active === true;
  const saving = productMutationsInFlight.has(sku);
  const sourceEligible = (product.sourceEligible ?? product.eligible) === true;
  const automatic = product.priceMode !== "manual";
  const price = automatic ? product.autoPriceCny : product.priceCny;
  const missingCost = product.buyPriceIdr == null;
  const autoPriceReason = product.autoPriceReason || (missingCost ? "缺少供应商买入价" : "汇率尚未同步");
  const checked = state.selectedSkus.has(String(product.sku));
  return `<tr data-sku="${escapeHtml(product.sku)}">
    <td><input class="row-select" type="checkbox" aria-label="选择 ${escapeHtml(product.sku)}" ${checked ? "checked" : ""}></td>
    <td><div class="sku-title">${escapeHtml(product.name || product.sku)}</div><div class="subline">${escapeHtml(product.sku)} · ${escapeHtml(product.operator || "未知运营商")}</div></td>
    <td><select class="table-select product-category" aria-label="商品分类"><option value="unclassified" ${!["airtime", "data"].includes(product.category) ? "selected" : ""}>待分类 / 其他</option><option value="airtime" ${product.category === "airtime" ? "selected" : ""}>话费充值</option><option value="data" ${product.category === "data" ? "selected" : ""}>流量套餐</option></select><br><input class="table-input operator-input product-operator" maxlength="80" value="${escapeHtml(product.operator || "")}" placeholder="运营商" aria-label="运营商"><br><span class="state-badge ${active ? "" : "offline"}">${active ? "当前目录存在" : "完整目录已缺失"}</span>${product.excludeReason ? `<div class="subline">${escapeHtml(product.excludeReason)}</div>` : ""}${product.unavailableReason ? `<div class="subline">${escapeHtml(product.unavailableReason)}</div>` : ""}</td>
    <td><div class="cost">${product.buyPriceIdr == null ? "—" : Number(product.buyPriceIdr).toLocaleString("zh-CN")}</div><div class="subline">IDR</div></td>
    <td><input class="table-input name-input product-name" maxlength="120" value="${escapeHtml(product.name || product.sku)}" aria-label="前台名称"><br><input class="table-input description-input product-description" maxlength="500" value="${escapeHtml(product.description || "")}" placeholder="套餐说明" aria-label="套餐说明"></td>
    <td><select class="table-select price-mode" aria-label="价格模式"><option value="auto" ${automatic ? "selected" : ""}>自动定价</option><option value="manual" ${automatic ? "" : "selected"}>手动定价</option></select><br><input class="table-input price-input product-price" type="number" min="0.01" step="0.01" value="${price == null ? "" : escapeHtml(Number(price).toFixed(2))}" ${automatic ? "readonly" : ""} placeholder="${automatic && price == null ? escapeHtml(autoPriceReason) : "售价"}"><div class="subline">${automatic && price == null ? escapeHtml(autoPriceReason) : "人民币"}</div></td>
    <td><label class="display-controls"><input class="product-popular" type="checkbox" ${product.popular ? "checked" : ""}> 热门推荐</label><div class="subline">排序请到“上架商品”页面调整</div><label class="display-controls approval-control"><input class="product-manual-approval" type="checkbox" ${sourceEligible || product.manualCatalogApproved ? "checked" : ""} ${sourceEligible ? "disabled" : ""}> ${sourceEligible ? "系统已识别" : "确认是印尼通信套餐"}</label></td>
    <td><label class="switch" title="${saving ? "正在保存" : active ? "点击后立即保存上架状态" : "最近确认的完整目录中已缺失，无法上架"}"><input class="product-published" type="checkbox" ${product.published ? "checked" : ""} ${active && !saving ? "" : "disabled"}><span class="slider"></span></label><div class="subline">${saving ? "保存中…" : product.published ? "已上架 · 点击即下架" : active ? "点击即上架" : "重新同步后确认"}</div></td>
    <td><button class="save-button save-product" ${saving ? "disabled" : ""}>${saving ? "保存中…" : "保存"}</button></td>
  </tr>`;
}

function updateSelectionSummary(filtered = currentFilteredProducts()) {
  const selectedCount = state.selectedSkus.size;
  $("#selectedCount").textContent = `已选择 ${selectedCount} 项`;
  const currentSkus = filtered.map((product) => String(product.sku));
  const selectedVisible = currentSkus.filter((sku) => state.selectedSkus.has(sku)).length;
  const selectAll = $("#selectAll");
  selectAll.checked = currentSkus.length > 0 && selectedVisible === currentSkus.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < currentSkus.length;
  $("#bulkPublish").disabled = selectedCount === 0;
  $("#bulkUnpublish").disabled = selectedCount === 0;
}

function renderProducts() {
  const filtered = currentFilteredProducts();
  const page = pagedProducts(filtered);
  const products = page.items;
  $("#statProducts").textContent = state.products.length.toLocaleString("zh-CN");
  $("#statPublished").textContent = state.products.filter((product) => product.published && product.active === true).length.toLocaleString("zh-CN");
  $("#statUnavailable").textContent = state.products.filter((product) => product.active === false).length.toLocaleString("zh-CN");
  $("#productResultCount").textContent = `当前筛选 ${filtered.length.toLocaleString("zh-CN")} / 本地 ${state.products.length.toLocaleString("zh-CN")}，每页最多 ${state.productPageSize} 个`;
  $("#productPageInfo").textContent = `第 ${state.productPage} / ${page.totalPages} 页`;
  $("#productPrev").disabled = state.productPage <= 1;
  $("#productNext").disabled = state.productPage >= page.totalPages;
  $("#productRows").innerHTML = products.length
    ? products.map(productRow).join("")
    : '<tr><td colspan="9" class="empty-state">没有符合当前筛选条件的 SKU</td></tr>';
  renderProductDiagnostics(filtered.length);

  $$(".row-select", $("#productRows")).forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const sku = checkbox.closest("tr").dataset.sku;
      if (checkbox.checked) state.selectedSkus.add(sku); else state.selectedSkus.delete(sku);
      updateSelectionSummary(products);
    });
  });
  $$(".price-mode", $("#productRows")).forEach((select) => select.addEventListener("change", onPriceModeChange));
  $$(".product-published", $("#productRows")).forEach((input) => input.addEventListener("change", savePublishedState));
  $$(".save-product", $("#productRows")).forEach((button) => button.addEventListener("click", saveProduct));
  updateSelectionSummary(products);
}

function onPriceModeChange(event) {
  const row = event.currentTarget.closest("tr");
  const product = state.products.find((item) => String(item.sku) === row.dataset.sku);
  const input = $(".product-price", row);
  const automatic = event.currentTarget.value === "auto";
  input.readOnly = automatic;
  input.value = automatic ? (product?.autoPriceCny == null ? "" : Number(product.autoPriceCny).toFixed(2)) : (product?.priceCny ?? product?.autoPriceCny ?? "");
  input.placeholder = automatic && !input.value ? (product?.autoPriceReason || (product?.buyPriceIdr == null ? "缺少供应商买入价" : "汇率尚未同步")) : "售价";
  if (!automatic) input.focus();
}

function productPayloadFromRow(row, product) {
  const priceMode = $(".price-mode", row).value;
  const priceInput = $(".product-price", row);
  const approvalInput = $(".product-manual-approval", row);
  const sourceEligible = (product?.sourceEligible ?? product?.eligible) === true;
  const payload = {
    name: $(".product-name", row).value.trim(),
    description: $(".product-description", row).value.trim(),
    category: $(".product-category", row).value,
    operator: $(".product-operator", row).value.trim(),
    priceMode,
    popular: $(".product-popular", row).checked,
    manualCatalogApproved: sourceEligible ? Boolean(product?.manualCatalogApproved) : approvalInput.checked,
    published: $(".product-published", row).checked
  };
  if (!payload.name) throw new Error("前台商品名称不能为空");
  if (payload.published && !["airtime", "data"].includes(payload.category)) throw new Error("上架前请先选择话费或流量分类");
  if (payload.published && (!payload.operator || payload.operator === "未知运营商")) throw new Error("上架前请填写运营商");
  if (payload.published && !sourceEligible && !payload.manualCatalogApproved) throw new Error("该 SKU 未被系统识别为印尼通信套餐，请人工核对后勾选确认");
  if (priceMode === "manual") {
    payload.priceCny = Number(priceInput.value);
    if (!Number.isFinite(payload.priceCny) || payload.priceCny <= 0) throw new Error("请输入有效的手动售价");
  } else if (!priceInput.value && payload.published) {
    throw new Error("自动价格尚未生成，请先刷新汇率");
  }
  return payload;
}

async function persistProductRow(row, { button = null, publishedChanged = false } = {}) {
  const sku = row.dataset.sku;
  const product = state.products.find((item) => String(item.sku) === sku);
  const publishInput = $(".product-published", row);
  const previousPublished = Boolean(product?.published);
  if (productMutationsInFlight.has(sku)) {
    if (publishedChanged) publishInput.checked = previousPublished;
    notify(`${sku} 正在保存，请稍候`, "error");
    return false;
  }

  let payload;
  try {
    // The publish switch owns only the publication state. Sending the whole
    // visible row here could overwrite a newer catalogue sync or another tab's
    // edits with stale form values. Other product fields are saved explicitly
    // with the row's Save button.
    payload = publishedChanged
      ? { published: publishInput.checked }
      : productPayloadFromRow(row, product);
  } catch (error) {
    if (publishedChanged) publishInput.checked = previousPublished;
    notify(error.message, "error");
    return false;
  }

  productMutationsInFlight.add(sku);
  publishInput.disabled = true;
  setButtonBusy(button, true, publishedChanged ? (payload.published ? "上架中…" : "下架中…") : "保存中…");
  let result;
  try {
    result = await api(`/api/admin/products/${encodeURIComponent(sku)}`, { method: "PUT", body: JSON.stringify(payload) });
  } catch (error) {
    productMutationsInFlight.delete(sku);
    setButtonBusy(button, false);
    notify(error.message, "error");
    renderProducts();
    return false;
  }

  const successMessage = publishedChanged ? `${sku} 已${payload.published ? "上架" : "下架"}` : `${sku} 已保存`;
  productMutationsInFlight.delete(sku);
  setButtonBusy(button, false);
  const productIndex = state.products.findIndex((item) => String(item.sku) === sku);
  if (productIndex >= 0 && result?.product) state.products[productIndex] = result.product;
  const serverPublishedOrder = result?.publishedOrder && typeof result.publishedOrder === "object" ? result.publishedOrder : {};
  if (serverPublishedOrder.revision !== undefined) state.orderRevision = serverPublishedOrder.revision;
  renderProducts();
  resetPublishedOrderFromProducts(serverPublishedOrder.skus);
  notify(successMessage);
  return Boolean(result?.product);
}

async function saveProduct(event) {
  const button = event.currentTarget;
  await persistProductRow(button.closest("tr"), { button });
}

async function savePublishedState(event) {
  const input = event.currentTarget;
  const row = input.closest("tr");
  await persistProductRow(row, { button: $(".save-product", row), publishedChanged: true });
}

async function loadProducts() {
  const requestId = ++productLoadRequestId;
  const data = await api("/api/admin/products");
  if (requestId < lastAppliedProductLoadRequestId) return;
  lastAppliedProductLoadRequestId = requestId;
  state.products = Array.isArray(data.products) ? data.products : [];
  const serverPublishedOrder = data.publishedOrder && typeof data.publishedOrder === "object" ? data.publishedOrder : {};
  state.orderRevision = serverPublishedOrder.revision ?? "";
  const validSkus = new Set(state.products.map((product) => String(product.sku)));
  state.selectedSkus = new Set([...state.selectedSkus].filter((sku) => validSkus.has(sku)));
  const selectedOperator = $("#operatorFilter").value;
  const operators = [...new Set(state.products.map((product) => product.operator).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $("#operatorFilter").innerHTML = '<option value="all">全部运营商</option>' + operators.map((operator) => `<option value="${escapeHtml(operator)}">${escapeHtml(operator)}</option>`).join("");
  if (operators.includes(selectedOperator)) $("#operatorFilter").value = selectedOperator;
  renderProducts();
  resetPublishedOrderFromProducts(serverPublishedOrder.skus);
}

async function loadFx() {
  const data = await api("/api/admin/fx");
  renderFxState(data.fx || null);
}

async function runProductSync() {
  const button = $("#syncProducts");
  if (!window.confirm("确定从 ReloadN 拉取全部 SKU 吗？未知运营商或类型的商品也会进入后台，但不会自动上架；现有人工设置会保留。")) return;
  setButtonBusy(button, true, "同步中…");
  try {
    const result = await api("/api/admin/products/sync", { method: "POST", body: "{}" });
    const completeness = !result.meta?.catalogComplete
      ? "供应商未提供完整性确认，旧 SKU 已安全保留"
      : result.meta?.missingProductsRetired
        ? "已确认当前查询范围的完整目录"
        : "已拉完当前查询范围；因查询范围首次启用或有变化，旧 SKU 暂保留一轮";
    notify(`同步完成，共保留 ${Number(result.count || 0).toLocaleString("zh-CN")} 个 SKU；${completeness}`);
    state.selectedSkus.clear();
    state.productPage = 1;
    await Promise.all([loadProducts(), loadSystemStatus()]);
  } catch (error) {
    notify(error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function refreshFx() {
  const button = $("#refreshFx");
  setButtonBusy(button, true, "刷新中…");
  try {
    const result = await api("/api/admin/fx/refresh", { method: "POST", body: "{}" });
    renderFxState(result.fx || null);
    notify(result.fx?.rateChanged === false
      ? "已重新获取汇率，但上游报价尚未变化"
      : "汇率已更新，自动售价已重新计算");
    await Promise.all([loadProducts(), loadSystemStatus(), loadAudit()]);
  } catch (error) {
    notify(error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function bulkSetPublished(published) {
  const skus = [...state.selectedSkus];
  if (!skus.length) return notify("请先选择商品", "error");
  const action = published ? "上架" : "下架";
  if (!window.confirm(`确定批量${action}选中的 ${skus.length} 个商品吗？`)) return;
  const button = published ? $("#bulkPublish") : $("#bulkUnpublish");
  setButtonBusy(button, true, `${action}中…`);
  try {
    const result = await api("/api/admin/products/bulk", { method: "POST", body: JSON.stringify({ skus, published }) });
    const skipped = Array.isArray(result.skipped) ? result.skipped.length : 0;
    const missing = Array.isArray(result.missing) ? result.missing.length : 0;
    const firstSkippedReason = result.skipped?.[0]?.reason;
    notify(`批量${action}完成，更新 ${result.changed || 0} 项${skipped || missing ? `，跳过 ${skipped + missing} 项${firstSkippedReason ? `（${firstSkippedReason}）` : ""}` : ""}`);
    state.selectedSkus.clear();
    await loadProducts();
  } catch (error) {
    notify(error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function sortedServices(services = state.services) {
  return [...services].sort((left, right) => {
    const order = Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
    return order || String(left.title || "").localeCompare(String(right.title || ""), "zh-CN") || String(left.id || "").localeCompare(String(right.id || ""));
  });
}

function serviceRow(service, draft = null) {
  const view = draft ? { ...service, ...draft } : service;
  return `<tr class="service-row" data-service-id="${escapeHtml(service.id)}">
    <td><input class="table-input service-title-input" maxlength="40" value="${escapeHtml(view.title)}" aria-label="服务名称"></td>
    <td><textarea class="table-input service-description-input" maxlength="240" rows="2" aria-label="服务说明">${escapeHtml(view.description || "")}</textarea></td>
    <td><input class="table-input service-sort-input" type="number" min="0" max="1000000" step="1" inputmode="numeric" value="${escapeHtml(view.sortOrder ?? 0)}" aria-label="排序值"></td>
    <td><label class="switch" title="控制是否在前台展示"><input class="service-enabled-input" type="checkbox" ${view.enabled !== false ? "checked" : ""}><span class="slider"></span></label><div class="subline">${view.enabled !== false ? "前台展示中" : "已停用"}</div></td>
    <td><div class="service-row-actions"><button class="save-button save-service" type="button">保存</button><button class="mini-button danger delete-service" type="button">删除</button></div></td>
  </tr>`;
}

function collectServiceDrafts() {
  const drafts = new Map();
  const baselines = new Map(state.services.map((service) => [String(service.id), service]));
  $$(".service-row").forEach((row) => {
    const id = String(row.dataset.serviceId || "");
    if (!id) return;
    const draft = {
      title: $(".service-title-input", row)?.value ?? "",
      description: $(".service-description-input", row)?.value ?? "",
      sortOrder: $(".service-sort-input", row)?.value ?? "",
      enabled: Boolean($(".service-enabled-input", row)?.checked)
    };
    const baseline = baselines.get(id);
    const changed = !baseline
      || draft.title !== String(baseline.title ?? "")
      || draft.description !== String(baseline.description ?? "")
      || draft.sortOrder !== String(baseline.sortOrder ?? 0)
      || draft.enabled !== (baseline.enabled !== false);
    if (changed) drafts.set(id, draft);
  });
  return drafts;
}

function renderServices(drafts = new Map()) {
  const services = sortedServices();
  $("#serviceCount").textContent = services.length.toLocaleString("zh-CN");
  $("#serviceRows").innerHTML = services.length
    ? services.map((service) => serviceRow(service, drafts.get(service.id))).join("")
    : '<tr><td colspan="5" class="empty-state">暂无生活服务，可使用上方表单添加</td></tr>';
}

async function loadServices(showMessage = false, { preserveDrafts = !showMessage, excludeDraftIds = [] } = {}) {
  const requestId = ++serviceLoadRequestId;
  const data = await api("/api/admin/services");
  if (requestId !== serviceLoadRequestId) return false;
  const drafts = preserveDrafts ? collectServiceDrafts() : new Map();
  excludeDraftIds.forEach((id) => drafts.delete(String(id)));
  state.services = Array.isArray(data.services) ? data.services : [];
  renderServices(drafts);
  if (showMessage) notify("生活服务已刷新");
  return true;
}

function readServiceRow(row) {
  const title = $(".service-title-input", row).value.trim();
  const description = $(".service-description-input", row).value.trim();
  const rawSortOrder = $(".service-sort-input", row).value.trim();
  const sortOrder = Number(rawSortOrder);
  if (!title) throw new Error("服务名称不能为空");
  if (title.length > 40) throw new Error("服务名称不能超过 40 个字符");
  if (description.length > 240) throw new Error("服务说明不能超过 240 个字符");
  if (!rawSortOrder || !Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 1_000_000) throw new Error("排序必须是 0–1,000,000 的整数");
  return { title, description, sortOrder, enabled: $(".service-enabled-input", row).checked };
}

function changedServiceFields(id, payload) {
  const baseline = state.services.find((service) => String(service.id) === String(id));
  if (!baseline) throw new Error("服务资料已变化，请刷新后重试");
  const changed = {};
  if (payload.title !== baseline.title) changed.title = payload.title;
  if (payload.description !== baseline.description) changed.description = payload.description;
  if (payload.sortOrder !== baseline.sortOrder) changed.sortOrder = payload.sortOrder;
  if (payload.enabled !== baseline.enabled) changed.enabled = payload.enabled;
  return changed;
}

function setServiceRowBusy(row, busy) {
  $$("input, textarea, button", row).forEach((element) => { element.disabled = busy; });
}

async function saveService(button) {
  const row = button.closest(".service-row");
  const id = row?.dataset.serviceId;
  if (!id) return;
  let payload;
  try { payload = changedServiceFields(id, readServiceRow(row)); } catch (error) { return notify(error.message, "error"); }
  if (!Object.keys(payload).length) return notify("没有需要保存的修改");
  serviceLoadRequestId += 1;
  setServiceRowBusy(row, true);
  try {
    await api(`/api/admin/services/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) });
    notify(`${$(".service-title-input", row)?.value.trim() || "生活服务"} 已保存`);
    await loadServices(false, { excludeDraftIds: [id] });
    loadAudit().catch(() => {});
  } catch (error) {
    notify(error.message, "error");
  } finally {
    if (row.isConnected) setServiceRowBusy(row, false);
  }
}

async function deleteService(button) {
  const row = button.closest(".service-row");
  const id = row?.dataset.serviceId;
  const title = $(".service-title-input", row)?.value.trim() || "该服务";
  if (!id || !window.confirm(`确定删除“${title}”吗？删除后前台将不再显示，且无法撤销。`)) return;
  serviceLoadRequestId += 1;
  setServiceRowBusy(row, true);
  try {
    await api(`/api/admin/services/${encodeURIComponent(id)}`, { method: "DELETE" });
    notify(`${title} 已删除`);
    await loadServices();
    loadAudit().catch(() => {});
  } catch (error) {
    notify(error.message, "error");
    if (row.isConnected) setServiceRowBusy(row, false);
  }
}

async function createService(event) {
  event.preventDefault();
  const button = $("#createService");
  const title = $("#serviceTitle").value.trim();
  const description = $("#serviceDescription").value.trim();
  const rawSortOrder = $("#serviceSortOrder").value.trim();
  const sortOrder = Number(rawSortOrder);
  if (!title) return notify("请输入服务名称", "error");
  if (title.length > 40) return notify("服务名称不能超过 40 个字符", "error");
  if (description.length > 240) return notify("服务说明不能超过 240 个字符", "error");
  if (!rawSortOrder || !Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 1_000_000) return notify("排序必须是 0–1,000,000 的整数", "error");
  const payload = { title, description, sortOrder, enabled: $("#serviceEnabled").checked };
  serviceLoadRequestId += 1;
  setButtonBusy(button, true, "添加中…");
  try {
    await api("/api/admin/services", { method: "POST", body: JSON.stringify(payload) });
    await loadServices();
    $("#serviceCreateForm").reset();
    $("#serviceEnabled").checked = true;
    $("#serviceSortOrder").value = String((Math.max(0, ...state.services.map((service) => Number(service.sortOrder) || 0)) + 10));
    notify(`${title} 已添加`);
    loadAudit().catch(() => {});
  } catch (error) {
    notify(error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

const orderLabels = {
  created: "已创建",
  pending_payment: "待支付",
  payment_pending: "支付处理中",
  paid_pending_recharge: "已支付待提交",
  recharge_processing: "充值处理中",
  recharge_success: "充值成功",
  recharge_failed: "充值失败",
  refund_required: "待退款/人工处理",
  manual_review: "需要人工处理",
  refunded: "已退款"
};

function orderStatusClass(status) {
  if (status === "recharge_success") return "success";
  if (["pending_payment", "payment_pending", "paid_pending_recharge", "recharge_processing", "created"].includes(status)) return "pending";
  if (["recharge_failed", "refund_required", "manual_review", "refunded"].includes(status)) return "failed";
  return "";
}

function renderOrders() {
  const query = $("#orderSearch").value.trim().toLowerCase();
  const status = $("#orderStatus").value;
  const orders = state.orders.filter((order) => {
    const text = [order.id, order.phone, order.productLabel, order.productId].join(" ").toLowerCase();
    return (!query || text.includes(query)) && (status === "all" || order.status === status);
  });
  $("#orderResultCount").textContent = `${orders.length.toLocaleString("zh-CN")} 个订单`;
  $("#orderRows").innerHTML = orders.length ? orders.map((order) => {
    const canRetry = ["paid_pending_recharge", "recharge_processing", "manual_review"].includes(order.status);
    return `<tr>
    <td><div class="order-id">${escapeHtml(order.id)}</div><div class="subline">${escapeHtml(order.detectedOperator || "")}</div></td>
    <td>${escapeHtml(order.phone || "—")}</td>
    <td><div>${escapeHtml(order.productLabel || order.productId || "—")}</div><div class="subline">${escapeHtml(order.productId || "")}</div></td>
    <td class="money">${escapeHtml(formatMoney(order.price, order.currency || "CNY"))}</td>
    <td><span class="order-status ${orderStatusClass(order.status)}">${escapeHtml(orderLabels[order.status] || order.status || "未知")}</span>${order.provider?.data?.data?.order?.order_id ? `<div class="subline">ReloadN: ${escapeHtml(order.provider.data.data.order.order_id)}</div>` : ""}</td>
    <td>${escapeHtml(formatDate(order.createdAt))}</td>
    <td>${escapeHtml(formatDate(order.updatedAt || order.createdAt))}</td>
    <td>${canRetry ? `<button class="mini-button retry-order" data-order-id="${escapeHtml(order.id)}">重新提交/查单</button>` : "—"}</td>
  </tr>`;
  }).join("") : '<tr><td colspan="8" class="empty-state">暂无符合条件的订单</td></tr>';
}

async function retryOrder(button) {
  const orderId = button.dataset.orderId;
  if (!orderId || !window.confirm(`确定重新提交或查询订单 ${orderId} 吗？请先核对供应商后台，避免错误操作。`)) return;
  setButtonBusy(button, true, "处理中…");
  try {
    const result = await api(`/api/admin/orders/${encodeURIComponent(orderId)}/retry`, { method: "POST", body: "{}" });
    notify(`订单当前状态：${orderLabels[result.order?.status] || result.order?.status || "已处理"}`);
    await Promise.all([loadOrders(), loadAudit()]);
  } catch (error) {
    notify(error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function loadOrders(showMessage = false) {
  const data = await api("/api/admin/orders");
  state.orders = Array.isArray(data.orders) ? data.orders : [];
  renderOrders();
  if (showMessage) notify("订单列表已刷新");
}

function auditLabel(action) {
  return ({
    "products.sync": "同步供应商商品",
    "products.bulk_publish": "批量上架商品",
    "products.bulk_unpublish": "批量下架商品",
    "products.reorder": "调整前台商品顺序",
    "product.update": "修改商品设置",
    "fx.refresh": "刷新在线汇率",
    "fx.manual_update": "手动修改汇率",
    "pricing.rule_update": "修改自动定价规则",
    "service.create": "添加生活服务",
    "service.update": "修改生活服务",
    "service.delete": "删除生活服务",
    "services.create": "添加生活服务",
    "services.update": "修改生活服务",
    "services.delete": "删除生活服务",
    "order.retry": "人工重新提交订单"
  })[action] || action || "后台操作";
}

function summarizeAudit(details) {
  if (!details || typeof details !== "object") return "—";
  const parts = [];
  if (details.sku) parts.push(`SKU ${details.sku}`);
  if (details.changed !== undefined) parts.push(`更新 ${details.changed} 项`);
  if (details.count !== undefined) parts.push(`排序 ${details.count} 项`);
  if (details.eligibleCount !== undefined) parts.push(`通信商品 ${details.eligibleCount} 项`);
  if (details.supplierCount !== undefined) parts.push(`供应商返回 ${details.supplierCount} 项`);
  if (details.idrPerCny !== undefined) parts.push(`汇率 ${details.idrPerCny}`);
  if (details.rateChanged === false) parts.push("上游报价未变化");
  if (details.mode === "fixed" && details.value !== undefined) parts.push(`固定加价 ${details.value} IDR`);
  if (details.mode === "percent" && details.value !== undefined) parts.push(`比例加价 ${details.value}%`);
  if (details.orderId) parts.push(`订单 ${details.orderId}`);
  if (details.serviceId) parts.push(`服务 ${details.serviceId}`);
  if (details.title) parts.push(String(details.title));
  if (details.status) parts.push(`状态 ${details.status}`);
  if (details.published !== undefined) parts.push(details.published ? "已上架" : "未上架");
  return parts.length ? parts.join(" · ") : JSON.stringify(details);
}

async function loadAudit() {
  const data = await api("/api/admin/audit");
  const entries = Array.isArray(data.entries) ? data.entries : [];
  $("#auditList").innerHTML = entries.length ? entries.map((entry) => `<div class="audit-item"><time>${escapeHtml(formatDate(entry.at))}</time><span class="audit-action">${escapeHtml(auditLabel(entry.action))}</span><span class="audit-details" title="${escapeHtml(JSON.stringify(entry.details || {}))}">${escapeHtml(summarizeAudit(entry.details))}</span></div>`).join("") : '<div class="empty-state">暂无后台操作记录</div>';
}

async function loadSystemStatus() {
  const data = await api("/api/admin/status");
  state.status = data.status || {};
  const status = state.status;
  const sync = status.sync || {};
  $("#syncCompleted").textContent = formatDate(sync.completedAt);
  $("#syncSupplierCount").textContent = sync.supplierCount == null ? "—" : Number(sync.supplierCount).toLocaleString("zh-CN");
  $("#syncEligibleCount").textContent = sync.eligibleCount == null ? "—" : Number(sync.eligibleCount).toLocaleString("zh-CN");
  $("#syncQueryTypes").textContent = formatSyncTypes(sync.queriedTypes);
  $("#syncPages").textContent = sync.pages == null ? "—" : Number(sync.pages).toLocaleString("zh-CN");
  $("#syncCompleteness").textContent = syncCompleteness(sync).text;
  renderProductDiagnostics();
  if (status.fx) {
    renderFxState(status.fx);
  } else {
    renderFxHealth(null);
  }
}

async function loadSystem() {
  await Promise.all([loadSystemStatus(), loadFx(), loadAudit()]);
}

async function saveManualFx() {
  const button = $("#saveFx");
  const idrPerCny = Number($("#manualFx").value);
  if (!Number.isFinite(idrPerCny) || idrPerCny <= 0) return notify("请输入有效的 IDR/CNY 汇率", "error");
  if (!window.confirm(`确定将汇率手动设置为 ${idrPerCny} IDR / CNY 吗？这会立即影响所有自动售价。`)) return;
  setButtonBusy(button, true, "保存中…");
  try {
    await api("/api/admin/fx", { method: "PUT", body: JSON.stringify({ idrPerCny }) });
    notify("手动汇率已保存，自动售价已重新计算");
    await Promise.all([loadFx(), loadProducts(), loadSystemStatus(), loadAudit()]);
  } catch (error) {
    notify(error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function savePricingRule() {
  const button = $("#savePricing");
  const mode = $("#pricingMode").value === "percent" ? "percent" : "fixed";
  const rawValue = $("#pricingValue").value.trim();
  const value = Number(rawValue);
  if (!rawValue || !Number.isFinite(value) || value < 0) return notify("请输入有效的非负加价值", "error");
  if (mode === "fixed" && (!Number.isSafeInteger(value) || value > 1_000_000)) return notify("固定加价必须是 0–1,000,000 的整数 IDR", "error");
  if (mode === "percent" && value > 1_000) return notify("比例加价必须是 0–1,000 的数字百分比", "error");
  const rule = { mode, value };
  if (!window.confirm(`确定保存“${mode === "fixed" ? `买入价 + ${value} IDR` : `买入价 + ${value}%`}”吗？这会立即影响所有自动定价商品，手动定价商品不变。`)) return;
  setButtonBusy(button, true, "保存中…");
  try {
    const result = await api("/api/admin/pricing", { method: "PUT", body: JSON.stringify(rule) });
    renderFxState(result.fx || state.fx);
    notify("自动定价规则已保存，自动售价已重新计算");
    await Promise.all([loadProducts(), loadSystemStatus(), loadAudit()]);
  } catch (error) {
    notify(error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function switchSection(section) {
  state.section = section;
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.section === section));
  $$(".section").forEach((element) => element.classList.toggle("active", element.id === `section-${section}`));
  const titles = { products: "商品中心", published: "上架商品", services: "生活服务", orders: "订单中心", system: "系统状态" };
  $("#pageTitle").textContent = titles[section] || "运营后台";
  closeMobileMenu();
  try {
    if (section === "orders") await loadOrders();
    if (section === "published") renderPublishedProducts();
    if (section === "services") await loadServices();
    if (section === "system") await loadSystem();
  } catch (error) {
    notify(error.message, "error");
  }
}

function openMobileMenu() {
  $(".sidebar").classList.add("open");
  $("#mobileOverlay").classList.add("show");
}

function closeMobileMenu() {
  $(".sidebar").classList.remove("open");
  $("#mobileOverlay").classList.remove("show");
}

async function logout() {
  const button = $("#logout");
  setButtonBusy(button, true, "退出中…");
  try {
    await api("/api/admin/logout", { method: "POST", body: "{}" });
  } catch (error) {
    if (!String(error.message).includes("登录状态")) notify(error.message, "error");
  } finally {
    window.location.replace("/admin/login");
  }
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchSection(button.dataset.section)));
  ["#productSearch", "#categoryFilter", "#operatorFilter", "#publishFilter"].forEach((selector) => $(selector).addEventListener("input", () => { state.productPage = 1; renderProducts(); }));
  $("#clearProductFilters").addEventListener("click", () => {
    $("#productSearch").value = "";
    $("#categoryFilter").value = "all";
    $("#operatorFilter").value = "all";
    $("#publishFilter").value = "all";
    state.productPage = 1;
    renderProducts();
  });
  $("#selectAll").addEventListener("change", (event) => {
    pagedProducts().items.forEach((product) => {
      const sku = String(product.sku);
      if (event.currentTarget.checked) state.selectedSkus.add(sku); else state.selectedSkus.delete(sku);
    });
    renderProducts();
  });
  $("#productPrev").addEventListener("click", () => { state.productPage -= 1; renderProducts(); });
  $("#productNext").addEventListener("click", () => { state.productPage += 1; renderProducts(); });
  $("#bulkPublish").addEventListener("click", () => bulkSetPublished(true));
  $("#bulkUnpublish").addEventListener("click", () => bulkSetPublished(false));
  $("#savePublishedOrder").addEventListener("click", savePublishedOrder);
  $("#resetPublishedOrder").addEventListener("click", () => setPublishedOrder([...state.savedPublishedOrder]));
  $("#syncProducts").addEventListener("click", runProductSync);
  $("#refreshFx").addEventListener("click", refreshFx);
  $("#orderSearch").addEventListener("input", renderOrders);
  $("#orderStatus").addEventListener("input", renderOrders);
  $("#orderRows").addEventListener("click", (event) => {
    const button = event.target.closest(".retry-order");
    if (button) retryOrder(button);
  });
  $("#refreshOrders").addEventListener("click", async (event) => {
    setButtonBusy(event.currentTarget, true, "刷新中…");
    try { await loadOrders(true); } catch (error) { notify(error.message, "error"); }
    finally { setButtonBusy(event.currentTarget, false); }
  });
  $("#serviceCreateForm").addEventListener("submit", createService);
  $("#refreshServices").addEventListener("click", async (event) => {
    if (collectServiceDrafts().size && !window.confirm("刷新会放弃尚未保存的生活服务修改，是否继续？")) return;
    setButtonBusy(event.currentTarget, true, "刷新中…");
    try { await loadServices(true); } catch (error) { notify(error.message, "error"); }
    finally { setButtonBusy(event.currentTarget, false); }
  });
  $("#serviceRows").addEventListener("click", (event) => {
    const saveButton = event.target.closest(".save-service");
    if (saveButton) return saveService(saveButton);
    const deleteButton = event.target.closest(".delete-service");
    if (deleteButton) deleteService(deleteButton);
  });
  $("#refreshSystem").addEventListener("click", async (event) => {
    setButtonBusy(event.currentTarget, true, "刷新中…");
    try { await loadSystem(); notify("系统状态已刷新"); } catch (error) { notify(error.message, "error"); }
    finally { setButtonBusy(event.currentTarget, false); }
  });
  $("#saveFx").addEventListener("click", saveManualFx);
  $("#savePricing").addEventListener("click", savePricingRule);
  $("#pricingMode").addEventListener("change", updatePricingDraftHelp);
  $("#pricingValue").addEventListener("input", updatePricingDraftHelp);
  $("#logout").addEventListener("click", logout);
  $("#menuButton").addEventListener("click", openMobileMenu);
  $("#mobileOverlay").addEventListener("click", closeMobileMenu);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeMobileMenu(); });
}

async function bootstrap() {
  bindEvents();
  try {
    const session = await api("/api/admin/session");
    state.csrfToken = session.csrfToken || "";
    $("#adminName").textContent = session.user || "管理员";
    await Promise.all([loadProducts(), loadFx(), loadSystemStatus()]);
  } catch (error) {
    if (!String(error.message).includes("登录状态")) notify(error.message, "error");
  }
}

bootstrap();
