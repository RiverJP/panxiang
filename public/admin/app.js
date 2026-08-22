"use strict";

const state = {
  csrfToken: "",
  products: [],
  orders: [],
  selectedSkus: new Set(),
  productPage: 1,
  productPageSize: 100,
  section: "products",
  fx: null,
  status: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

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

async function api(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (!new Set(["GET", "HEAD", "OPTIONS"]).has(method)) headers["X-CSRF-Token"] = state.csrfToken;

  const response = await fetch(url, {
    ...options,
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store"
  });
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

function productRow(product) {
  const active = product.active !== false;
  const sourceEligible = (product.sourceEligible ?? product.eligible) === true;
  const automatic = product.priceMode !== "manual";
  const price = automatic ? product.autoPriceCny : product.priceCny;
  const missingCost = product.buyPriceIdr == null;
  const autoPriceReason = product.autoPriceReason || (missingCost ? "缺少供应商买入价" : "汇率尚未同步");
  const checked = state.selectedSkus.has(String(product.sku));
  return `<tr data-sku="${escapeHtml(product.sku)}">
    <td><input class="row-select" type="checkbox" aria-label="选择 ${escapeHtml(product.sku)}" ${checked ? "checked" : ""}></td>
    <td><div class="sku-title">${escapeHtml(product.name || product.sku)}</div><div class="subline">${escapeHtml(product.sku)} · ${escapeHtml(product.operator || "未知运营商")}</div></td>
    <td><select class="table-select product-category" aria-label="商品分类"><option value="unclassified" ${!["airtime", "data"].includes(product.category) ? "selected" : ""}>待分类 / 其他</option><option value="airtime" ${product.category === "airtime" ? "selected" : ""}>话费充值</option><option value="data" ${product.category === "data" ? "selected" : ""}>流量套餐</option></select><br><input class="table-input operator-input product-operator" maxlength="80" value="${escapeHtml(product.operator || "")}" placeholder="运营商" aria-label="运营商"><br><span class="state-badge ${active ? "" : "offline"}">${active ? "供应正常" : "供应不可用"}</span>${product.excludeReason ? `<div class="subline">${escapeHtml(product.excludeReason)}</div>` : ""}${product.unavailableReason ? `<div class="subline">${escapeHtml(product.unavailableReason)}</div>` : ""}</td>
    <td><div class="cost">${product.buyPriceIdr == null ? "—" : Number(product.buyPriceIdr).toLocaleString("zh-CN")}</div><div class="subline">IDR</div></td>
    <td><input class="table-input name-input product-name" maxlength="120" value="${escapeHtml(product.name || product.sku)}" aria-label="前台名称"><br><input class="table-input description-input product-description" maxlength="500" value="${escapeHtml(product.description || "")}" placeholder="套餐说明" aria-label="套餐说明"></td>
    <td><select class="table-select price-mode" aria-label="价格模式"><option value="auto" ${automatic ? "selected" : ""}>自动定价</option><option value="manual" ${automatic ? "" : "selected"}>手动定价</option></select><br><input class="table-input price-input product-price" type="number" min="0.01" step="0.01" value="${price == null ? "" : escapeHtml(Number(price).toFixed(2))}" ${automatic ? "readonly" : ""} placeholder="${automatic && price == null ? escapeHtml(autoPriceReason) : "售价"}"><div class="subline">${automatic && price == null ? escapeHtml(autoPriceReason) : "人民币"}</div></td>
    <td><input class="table-input sort-input product-sort" type="number" min="-9999" max="9999" step="1" value="${escapeHtml(product.sortOrder ?? 0)}" aria-label="排序"><label class="display-controls"><input class="product-popular" type="checkbox" ${product.popular ? "checked" : ""}> 热门推荐</label><label class="display-controls approval-control"><input class="product-manual-approval" type="checkbox" ${sourceEligible || product.manualCatalogApproved ? "checked" : ""} ${sourceEligible ? "disabled" : ""}> ${sourceEligible ? "系统已识别" : "确认是印尼通信套餐"}</label></td>
    <td><label class="switch" title="${active ? "设置上架状态" : "供应商不可用，无法上架"}"><input class="product-published" type="checkbox" ${product.published ? "checked" : ""} ${active ? "" : "disabled"}><span class="slider"></span></label></td>
    <td><button class="save-button save-product">保存</button></td>
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
  $("#statPublished").textContent = state.products.filter((product) => product.published && product.active !== false).length.toLocaleString("zh-CN");
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

async function saveProduct(event) {
  const button = event.currentTarget;
  const row = button.closest("tr");
  const sku = row.dataset.sku;
  const product = state.products.find((item) => String(item.sku) === sku);
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
    sortOrder: Number($(".product-sort", row).value || 0),
    published: $(".product-published", row).checked
  };
  if (!payload.name) return notify("前台商品名称不能为空", "error");
  if (payload.published && !["airtime", "data"].includes(payload.category)) return notify("上架前请先选择话费或流量分类", "error");
  if (payload.published && (!payload.operator || payload.operator === "未知运营商")) return notify("上架前请填写运营商", "error");
  if (payload.published && !sourceEligible && !payload.manualCatalogApproved) return notify("该 SKU 未被系统识别为印尼通信套餐，请人工核对后勾选确认", "error");
  if (priceMode === "manual") {
    payload.priceCny = Number(priceInput.value);
    if (!Number.isFinite(payload.priceCny) || payload.priceCny <= 0) return notify("请输入有效的手动售价", "error");
  } else if (!priceInput.value && payload.published) {
    return notify("自动价格尚未生成，请先刷新汇率", "error");
  }

  setButtonBusy(button, true, "保存中…");
  try {
    await api(`/api/admin/products/${encodeURIComponent(sku)}`, { method: "PUT", body: JSON.stringify(payload) });
    notify(`${sku} 已保存`);
    await loadProducts();
  } catch (error) {
    notify(error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function loadProducts() {
  const data = await api("/api/admin/products");
  state.products = Array.isArray(data.products) ? data.products : [];
  const validSkus = new Set(state.products.map((product) => String(product.sku)));
  state.selectedSkus = new Set([...state.selectedSkus].filter((sku) => validSkus.has(sku)));
  const selectedOperator = $("#operatorFilter").value;
  const operators = [...new Set(state.products.map((product) => product.operator).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $("#operatorFilter").innerHTML = '<option value="all">全部运营商</option>' + operators.map((operator) => `<option value="${escapeHtml(operator)}">${escapeHtml(operator)}</option>`).join("");
  if (operators.includes(selectedOperator)) $("#operatorFilter").value = selectedOperator;
  renderProducts();
}

async function loadFx() {
  const data = await api("/api/admin/fx");
  state.fx = data.fx || null;
  const rate = Number(state.fx?.idrPerCny);
  $("#statRate").textContent = Number.isFinite(rate) ? rate.toLocaleString("zh-CN", { maximumFractionDigits: 4 }) : "—";
  $("#statRateTime").textContent = state.fx?.updatedAt ? formatDate(state.fx.updatedAt) : "等待汇率更新";
  $("#manualFx").value = Number.isFinite(rate) ? String(rate) : "";
  $("#fxSource").textContent = state.fx?.source === "manual" ? "后台手动设置" : (state.fx?.source || "—");
  $("#fxUpdated").textContent = formatDate(state.fx?.updatedAt);
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
    await api("/api/admin/fx/refresh", { method: "POST", body: "{}" });
    notify("汇率已刷新，自动售价已重新计算");
    await Promise.all([loadFx(), loadProducts(), loadSystemStatus()]);
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
    notify(`批量${action}完成，实际更新 ${result.changed || 0} 项`);
    state.selectedSkus.clear();
    await loadProducts();
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
    "product.update": "修改商品设置",
    "fx.refresh": "刷新在线汇率",
    "fx.manual_update": "手动修改汇率",
    "order.retry": "人工重新提交订单"
  })[action] || action || "后台操作";
}

function summarizeAudit(details) {
  if (!details || typeof details !== "object") return "—";
  const parts = [];
  if (details.sku) parts.push(`SKU ${details.sku}`);
  if (details.changed !== undefined) parts.push(`更新 ${details.changed} 项`);
  if (details.eligibleCount !== undefined) parts.push(`通信商品 ${details.eligibleCount} 项`);
  if (details.supplierCount !== undefined) parts.push(`供应商返回 ${details.supplierCount} 项`);
  if (details.idrPerCny !== undefined) parts.push(`汇率 ${details.idrPerCny}`);
  if (details.orderId) parts.push(`订单 ${details.orderId}`);
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
  const foot = $(".sidebar-foot");
  if (foot) foot.innerHTML = '<span class="health-dot"></span>生产服务运行中';
  if (status.fx) {
    state.fx = status.fx;
    $("#fxSource").textContent = status.fx.source === "manual" ? "后台手动设置" : (status.fx.source || "—");
    $("#fxUpdated").textContent = formatDate(status.fx.updatedAt);
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

async function switchSection(section) {
  state.section = section;
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.section === section));
  $$(".section").forEach((element) => element.classList.toggle("active", element.id === `section-${section}`));
  const titles = { products: "商品中心", orders: "订单中心", system: "系统状态" };
  $("#pageTitle").textContent = titles[section] || "运营后台";
  closeMobileMenu();
  try {
    if (section === "orders") await loadOrders();
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
  $("#refreshSystem").addEventListener("click", async (event) => {
    setButtonBusy(event.currentTarget, true, "刷新中…");
    try { await loadSystem(); notify("系统状态已刷新"); } catch (error) { notify(error.message, "error"); }
    finally { setButtonBusy(event.currentTarget, false); }
  });
  $("#saveFx").addEventListener("click", saveManualFx);
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
