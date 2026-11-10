"use strict";

const STORAGE_KEY = "moneta-finance-v1";
const RECEIPT_DB_NAME = "moneta-receipts";
const RECEIPT_STORE_NAME = "receipts";
const MAX_RECEIPT_SIZE = 10 * 1024 * 1024;
const DEFAULT_STATE = { transactions: [], recurring: [], currency: "USD", theme: "light" };
const CATEGORIES = {
  expense: ["Food & dining", "Transport", "Shopping", "Health", "Entertainment", "Home", "Personal", "Other"],
  bill: ["Housing", "Utilities", "Internet & phone", "Insurance", "Other"],
  subscription: ["Entertainment", "Software", "Memberships", "Other"],
  income: ["Salary", "Freelance", "Investment", "Gift", "Other"],
};
const TYPE_LABELS = { expense: "Expense", bill: "Bill payment", subscription: "Subscription", income: "Income" };
const CATEGORY_COLORS = ["#4d866b", "#ed967e", "#8ca4cb", "#e8c879", "#b4c7b9", "#a893bf", "#7bb5bb", "#d0a592"];
const TYPE_ICONS = { expense: "↘", bill: "⌂", subscription: "◷", income: "↗" };
const THEMES = ["light", "dark", "ocean", "lavender", "sunset"];
const PAYMENT_METHODS = ["Cash", "QR payment", "Credit card", "Debit card", "Bank transfer", "E-wallet", "Other"];
const RECEIPT_IMAGE_TYPES = {
  avif: "image/avif", bmp: "image/bmp", gif: "image/gif", heic: "image/heic", heif: "image/heif",
  jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", tif: "image/tiff", tiff: "image/tiff", webp: "image/webp",
};

const today = new Date();
const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const currentMonth = () => isoDate(today).slice(0, 7);
const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let state = loadState();
let deleteTarget = null;
let toastTimer;
let receiptDbPromise;
let receiptObjectUrl;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const money = (value) => new Intl.NumberFormat(undefined, { style: "currency", currency: state.currency || "USD" }).format(value);
const parseDate = (value) => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
};
const formatDate = (value, options = { month: "short", day: "numeric", year: "numeric" }) => {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, options).format(parseDate(value));
};
const daysFromToday = (value) => Math.round((parseDate(value) - parseDate(isoDate(today))) / 86400000);
const selectedMonth = () => $("#month-picker").value || currentMonth();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.transactions) || !Array.isArray(data.recurring)) throw new Error("Saved data has an invalid format.");
    return {
      transactions: data.transactions,
      recurring: data.recurring,
      currency: /^[A-Z]{3}$/.test(data.currency) ? data.currency : "USD",
      theme: THEMES.includes(data.theme) ? data.theme : "light",
    };
  } catch (error) {
    console.error("Could not load saved finance data.", error);
    window.setTimeout(() => showToast("Saved data could not be loaded. Export or inspect your browser storage."), 0);
    return { ...DEFAULT_STATE };
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    $$(".local-status").forEach((item) => { item.innerHTML = "<i></i> Saved on this device"; });
    return true;
  } catch (error) {
    console.error("Could not save finance data.", error);
    $$(".local-status").forEach((item) => { item.innerHTML = "<i class='status-error'></i> Save failed"; });
    showToast("Could not save. Your browser storage may be full or unavailable.");
    return false;
  }
}

function openReceiptDb() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("This browser does not support local receipt storage."));
  if (!receiptDbPromise) {
    receiptDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(RECEIPT_DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(RECEIPT_STORE_NAME)) {
          request.result.createObjectStore(RECEIPT_STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open receipt storage."));
      request.onblocked = () => reject(new Error("Receipt storage is blocked by another tab. Close other Moneta tabs and try again."));
    });
  }
  return receiptDbPromise;
}

function storeReceipt(id, file) {
  return receiptStore("put", { id, name: file.name, type: receiptType(file), blob: file });
}

function receiptType(file) {
  if (file.type === "application/pdf") return file.type;
  const extension = file.name.split(".").pop().toLowerCase();
  if (extension === "pdf") return "application/pdf";
  return RECEIPT_IMAGE_TYPES[extension] || file.type;
}

function receiptStore(action, value) {
  return openReceiptDb().then((db) => new Promise((resolve, reject) => {
    const reading = action === "get";
    const transaction = db.transaction(RECEIPT_STORE_NAME, reading ? "readonly" : "readwrite");
    const store = transaction.objectStore(RECEIPT_STORE_NAME);
    const request = action === "get" ? store.get(value) : store[action](value);
    if (reading) request.onsuccess = () => resolve(request.result || null);
    else transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error(`Could not ${action} receipt.`));
    transaction.onabort = () => reject(transaction.error || new Error(`Receipt ${action} was cancelled.`));
  }));
}

function getReceipt(id) {
  return receiptStore("get", id);
}

function removeReceipt(id) {
  return receiptStore("delete", id);
}

async function showReceipt(transactionId) {
  const entry = state.transactions.find((item) => item.id === transactionId);
  if (!entry?.receiptId) return;
  try {
    const receipt = await getReceipt(entry.receiptId);
    if (!receipt || !(receipt.blob instanceof Blob)) throw new Error("This receipt could not be found in browser storage.");
    if (receipt.type !== "application/pdf" && !receipt.type.startsWith("image/")) throw new Error("This receipt file type is not supported.");
    if (receiptObjectUrl) URL.revokeObjectURL(receiptObjectUrl);
    receiptObjectUrl = URL.createObjectURL(receipt.blob);
    $("#receipt-title").textContent = entry.name;
    $("#receipt-preview").replaceChildren();
    if (receipt.type === "application/pdf") {
      const frame = document.createElement("iframe");
      frame.src = receiptObjectUrl;
      frame.title = `Receipt for ${entry.name}`;
      $("#receipt-preview").append(frame);
    } else {
      const image = document.createElement("img");
      image.src = receiptObjectUrl;
      image.alt = `Receipt for ${entry.name}`;
      image.onerror = () => {
        const message = document.createElement("p");
        message.className = "receipt-preview-message";
        message.textContent = "This image can’t be previewed in your browser. Use Download receipt to open it.";
        $("#receipt-preview").replaceChildren(message);
      };
      $("#receipt-preview").append(image);
    }
    $("#receipt-download").href = receiptObjectUrl;
    $("#receipt-download").download = receipt.name || "receipt";
    $("#receipt-download").dataset.receiptId = entry.id;
    $("#receipt-modal").showModal();
  } catch (error) {
    console.error("Could not open receipt.", error);
    showToast(error.message || "Could not open this receipt.");
  }
}

async function deleteReceiptFromTransaction(transactionId) {
  const entry = state.transactions.find((item) => item.id === transactionId);
  if (!entry?.receiptId) return;
  const receiptId = entry.receiptId;
  let receipt;
  try {
    receipt = await getReceipt(receiptId);
    if (!receipt) throw new Error("This receipt could not be found in browser storage.");
    await removeReceipt(receiptId);
  } catch (error) {
    console.error("Could not remove receipt.", error);
    showToast(error.message || "Could not remove this receipt.");
    return;
  }
  delete entry.receiptId;
  if (!saveState()) {
    entry.receiptId = receiptId;
    try {
      await receiptStore("put", receipt);
    } catch (error) {
      console.error("Could not restore receipt after saving changes failed.", error);
      showToast("Could not save changes or restore the receipt. Export your finance data and check browser storage.");
    }
    return;
  }
  $("#receipt-modal").close();
  renderTransactions();
  showToast("Receipt removed.");
}

function releaseReceiptPreview() {
  if (receiptObjectUrl) {
    URL.revokeObjectURL(receiptObjectUrl);
    receiptObjectUrl = null;
  }
  $("#receipt-preview").replaceChildren();
  $("#receipt-download").removeAttribute("href");
  delete $("#receipt-download").dataset.receiptId;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#171d1a" : theme === "ocean" ? "#eef4f7" : theme === "lavender" ? "#f3f0f8" : theme === "sunset" ? "#faf3ed" : "#f6f7f5";
}

function populateCategorySelect(select, type) {
  const categories = CATEGORIES[type] || CATEGORIES.expense;
  select.innerHTML = categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("");
}

function populatePaymentMethodSelect(select) {
  select.innerHTML = PAYMENT_METHODS.map((method) => `<option value="${escapeHtml(method)}">${escapeHtml(method)}</option>`).join("");
}

function monthTransactions(month) {
  return state.transactions.filter((item) => item.date.startsWith(month));
}

function renderSummary() {
  const month = selectedMonth();
  const transactions = monthTransactions(month);
  const spent = transactions.filter((item) => item.type !== "income").reduce((sum, item) => sum + item.amount, 0);
  const income = transactions.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amount, 0);
  $("#total-spent").textContent = money(spent);
  $("#total-income").textContent = money(income);
  $("#net-balance").textContent = money(income - spent);
  $("#transaction-count").textContent = `${transactions.filter((item) => item.type !== "income").length} transaction${transactions.filter((item) => item.type !== "income").length === 1 ? "" : "s"}`;
  const monthDate = parseDate(`${month}-01`);
  const period = month === currentMonth() ? "This month" : new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(monthDate);
  $("#spending-period").textContent = period;
  $("#income-period").textContent = period;
  $("#breakdown-period").textContent = `Where your money went ${month === currentMonth() ? "this month" : `in ${period}`}`;
  renderBreakdown(transactions.filter((item) => item.type !== "income"), spent);
}

function renderBreakdown(transactions, total) {
  const host = $("#breakdown-content");
  const byCategory = new Map();
  transactions.forEach((item) => byCategory.set(item.category, (byCategory.get(item.category) || 0) + item.amount));
  const entries = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!total || !entries.length) {
    host.innerHTML = `<div class="empty-breakdown"><strong>No spending to show just yet</strong><span>Add a transaction to see your breakdown.</span></div>`;
    return;
  }
  let angle = 0;
  const stops = entries.map(([, value], index) => {
    const next = angle + value / total * 360;
    const stop = `${CATEGORY_COLORS[index % CATEGORY_COLORS.length]} ${angle.toFixed(2)}deg ${next.toFixed(2)}deg`;
    angle = next;
    return stop;
  });
  host.innerHTML = `<div class="donut-wrap"><div class="donut-chart" style="background:conic-gradient(${stops.join(",")})"></div><div class="donut-center"><strong>${money(total)}</strong><span>Total spent</span></div></div><div class="category-bars">${entries.map(([category, value], index) => `<div class="category-row"><span class="category-color" style="background:${CATEGORY_COLORS[index % CATEGORY_COLORS.length]}"></span><span class="category-name">${escapeHtml(category)}</span><span class="category-amount">${money(value)}</span></div>`).join("")}</div>`;
}

function renderTransactionRow(item) {
  const isIncome = item.type === "income";
  const hasReceipt = Boolean(item.receiptId);
  return `<tr>
    <td><div class="transaction-cell"><span class="transaction-icon icon-${escapeHtml(item.type)}">${TYPE_ICONS[item.type] || "↘"}</span><span><span class="transaction-name">${escapeHtml(item.name)}</span>${item.note ? `<span class="transaction-note">${escapeHtml(item.note)}</span>` : ""}</span></div></td>
    <td><span class="category-pill">${escapeHtml(item.category)}</span></td>
    <td>${escapeHtml(PAYMENT_METHODS.includes(item.paymentMethod) ? item.paymentMethod : "—")}</td>
    <td>${escapeHtml(formatDate(item.date))}</td>
    <td>${hasReceipt ? `<button class="receipt-view-button" data-view-receipt="${escapeHtml(item.id)}" aria-label="View receipt for ${escapeHtml(item.name)}">▧ View</button>` : "—"}</td>
    <td class="amount-column ${isIncome ? "income-amount" : ""}">${isIncome ? "+" : "−"}${money(item.amount)}</td>
    <td class="row-actions"><button class="delete-row" data-delete-transaction="${escapeHtml(item.id)}" aria-label="Delete ${escapeHtml(item.name)}">×</button></td>
  </tr>`;
}

function renderTransactions() {
  const sorted = [...state.transactions].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const recent = sorted.slice(0, 5);
  $("#recent-transactions").innerHTML = recent.length ? recent.map(renderTransactionRow).join("") : `<tr><td class="empty-row" colspan="7">Your transactions will show up here once you add your first one.</td></tr>`;
  const query = $("#transaction-search").value.trim().toLowerCase();
  const type = $("#type-filter").value;
  const category = $("#category-filter").value;
  const month = $("#transaction-month").value;
  const filtered = sorted.filter((item) => {
    const matchesText = !query || [item.name, item.category, item.paymentMethod, item.note, TYPE_LABELS[item.type]].some((value) => String(value || "").toLowerCase().includes(query));
    return matchesText && (type === "all" || item.type === type) && (category === "all" || item.category === category) && (!month || item.date.startsWith(month));
  });
  $("#all-transactions").innerHTML = filtered.length ? filtered.map(renderTransactionRow).join("") : `<tr><td class="empty-row" colspan="7">${sorted.length ? "No transactions match these filters." : "Nothing here yet — add your first transaction to get started."}</td></tr>`;
  $("#transaction-list-footer").textContent = `${filtered.length} transaction${filtered.length === 1 ? "" : "s"}`;
  const categories = [...new Set(state.transactions.map((item) => item.category))].sort();
  const categoryFilter = $("#category-filter");
  const selectedCategory = categoryFilter.value;
  categoryFilter.innerHTML = `<option value="all">All categories</option>${categories.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
  if (categories.includes(selectedCategory)) categoryFilter.value = selectedCategory;
}

function renderUpcoming() {
  const upcoming = [...state.recurring].sort((a, b) => a.nextDue.localeCompare(b.nextDue)).slice(0, 3);
  const host = $("#upcoming-list");
  if (!upcoming.length) {
    host.innerHTML = `<div class="upcoming-empty">No upcoming payments. Add a subscription or bill to stay ahead.</div>`;
    return;
  }
  host.innerHTML = upcoming.map((item) => {
    const date = parseDate(item.nextDue);
    const relative = daysFromToday(item.nextDue);
    const when = relative < 0 ? `${Math.abs(relative)}d overdue` : relative === 0 ? "Due today" : relative === 1 ? "Tomorrow" : `In ${relative} days`;
    return `<div class="upcoming-item"><div class="date-tile"><span>${new Intl.DateTimeFormat(undefined, { month: "short" }).format(date)}</span><span>${date.getDate()}</span></div><div><div class="upcoming-name">${escapeHtml(item.name)}</div><div class="upcoming-meta">${escapeHtml(when)} · ${escapeHtml(item.category)}</div></div><span class="upcoming-amount">${money(item.amount)}</span></div>`;
  }).join("");
}

function nextDueDate(value, frequency, anchorDay = parseDate(value).getDate()) {
  const date = parseDate(value);
  if (frequency === "weekly") date.setDate(date.getDate() + 7);
  if (frequency === "monthly" || frequency === "quarterly" || frequency === "yearly") {
    date.setDate(1);
    if (frequency === "yearly") date.setFullYear(date.getFullYear() + 1);
    else date.setMonth(date.getMonth() + (frequency === "quarterly" ? 3 : 1));
    date.setDate(Math.min(anchorDay, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  }
  return isoDate(date);
}

function followingDueDate(value, frequency, anchorDay) {
  const validFrequencies = ["weekly", "monthly", "quarterly", "yearly"];
  if (!validFrequencies.includes(frequency)) throw new Error(`Unsupported recurring frequency: ${frequency}`);
  let next = nextDueDate(value, frequency, anchorDay);
  while (next <= isoDate(today)) next = nextDueDate(next, frequency, anchorDay);
  return next;
}

function renderRecurring() {
  const list = [...state.recurring].sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  const currentMonthDue = list.filter((item) => item.nextDue.startsWith(currentMonth())).reduce((sum, item) => sum + item.amount, 0);
  const monthlyEstimate = list.reduce((sum, item) => sum + item.amount * ({ weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 }[item.frequency] || 1), 0);
  $("#recurring-summary").innerHTML = `<div class="recurring-stat"><span class="recurring-stat-icon">◷</span><div><span>Due this month</span><strong>${money(currentMonthDue)}</strong></div></div><div class="recurring-stat"><span class="recurring-stat-icon">↻</span><div><span>Estimated monthly</span><strong>${money(monthlyEstimate)}</strong></div></div>`;
  const host = $("#recurring-list");
  if (!list.length) {
    host.innerHTML = `<div class="recurring-empty">No recurring payments yet.<br />Add a bill or subscription to keep track of what’s coming.</div>`;
    return;
  }
  host.innerHTML = list.map((item) => `<div class="recurring-full-row">
    <div class="recurring-full-name"><span class="transaction-icon icon-${escapeHtml(item.type || "subscription")}">${TYPE_ICONS[item.type] || TYPE_ICONS.subscription}</span><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(TYPE_LABELS[item.type] || TYPE_LABELS.subscription)} · ${escapeHtml(item.category)}</span></div></div>
    <div class="recurring-cell"><span class="recurring-cell-label">AMOUNT</span><span class="recurring-cell-value">${money(item.amount)}</span></div>
    <div class="recurring-cell"><span class="recurring-cell-label">NEXT DUE</span><span class="recurring-cell-value">${escapeHtml(formatDate(item.nextDue, { month: "short", day: "numeric" }))}</span></div>
    <div class="recurring-cell"><span class="recurring-cell-label">PAYMENT METHOD</span><span class="recurring-cell-value">${escapeHtml(PAYMENT_METHODS.includes(item.paymentMethod) ? item.paymentMethod : "—")}</span></div>
    <button class="paid-button" data-mark-paid="${escapeHtml(item.id)}">Mark paid</button>
    <button class="recurring-delete" data-delete-recurring="${escapeHtml(item.id)}" aria-label="Delete ${escapeHtml(item.name)}">×</button>
  </div>`).join("");
}

function renderAll() {
  renderSummary();
  renderTransactions();
  renderUpcoming();
  renderRecurring();
}

function openTransactionModal() {
  const form = $("#transaction-form");
  form.reset();
  $("#receipt-selection").hidden = true;
  $("#receipt-selection-name").textContent = "";
  form.elements.date.value = isoDate(today);
  form.elements.type.value = "expense";
  populateCategorySelect($("#transaction-category"), "expense");
  $("#transaction-currency-prefix").textContent = state.currency;
  $("#transaction-error").textContent = "";
  $("#transaction-modal").showModal();
  form.elements.name.focus();
}

function openRecurringModal() {
  const form = $("#recurring-form");
  form.reset();
  form.elements.nextDue.value = isoDate(today);
  form.elements.type.value = "subscription";
  populateCategorySelect($("#recurring-category"), form.elements.type.value);
  $("#recurring-currency-prefix").textContent = state.currency;
  $("#recurring-error").textContent = "";
  $("#recurring-modal").showModal();
  form.elements.name.focus();
}

async function addTransaction(formData) {
  const amount = Number(formData.get("amount"));
  const name = String(formData.get("name") || "").trim();
  const type = String(formData.get("type"));
  const date = String(formData.get("date"));
  const receipt = formData.get("receipt");
  const hasReceipt = receipt instanceof File && receipt.size > 0;
  if (!name || !Number.isFinite(amount) || amount <= 0 || !CATEGORIES[type] || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    $("#transaction-error").textContent = "Add a description, valid amount, type, and date.";
    return;
  }
  const receiptMime = hasReceipt ? receiptType(receipt) : "";
  if (hasReceipt && ((!receiptMime.startsWith("image/") && receiptMime !== "application/pdf") || receipt.size > MAX_RECEIPT_SIZE)) {
    $("#transaction-error").textContent = receipt.size > MAX_RECEIPT_SIZE ? "Receipt must be 10 MB or smaller." : "Choose an image or PDF receipt.";
    return;
  }
  const id = makeId();
  if (hasReceipt) {
    try {
      await storeReceipt(id, receipt);
    } catch (error) {
      console.error("Could not save receipt.", error);
      $("#transaction-error").textContent = error.message || "Could not save the receipt. Try another file or browser.";
      return;
    }
  }
  state.transactions.push({ id, name, amount: Math.round(amount * 100) / 100, type, category: String(formData.get("category")), paymentMethod: String(formData.get("paymentMethod")), date, note: String(formData.get("note") || "").trim(), ...(hasReceipt ? { receiptId: id } : {}) });
  if (!saveState()) {
    state.transactions.pop();
    if (hasReceipt) {
      try {
        await removeReceipt(id);
      } catch (error) {
        console.error("Could not clean up receipt after transaction save failed.", error);
        showToast("Transaction was not saved; its receipt remains in browser storage.");
      }
    }
    return;
  }
  $("#transaction-modal").close();
  renderAll();
  showToast("Transaction saved.");
}

function addRecurring(formData) {
  const amount = Number(formData.get("amount"));
  const name = String(formData.get("name") || "").trim();
  const nextDue = String(formData.get("nextDue"));
  const frequency = String(formData.get("frequency"));
  const type = String(formData.get("type"));
  if (!name || !Number.isFinite(amount) || amount <= 0 || !["bill", "subscription"].includes(type) || !["weekly", "monthly", "quarterly", "yearly"].includes(frequency) || !/^\d{4}-\d{2}-\d{2}$/.test(nextDue)) {
    $("#recurring-error").textContent = "Add a name, valid amount, payment type, and due date.";
    return;
  }
  const item = { id: makeId(), name, amount: Math.round(amount * 100) / 100, type, category: String(formData.get("category")), paymentMethod: String(formData.get("paymentMethod")), nextDue, frequency, dayOfMonth: parseDate(nextDue).getDate() };
  state.recurring.push(item);
  if (!saveState()) {
    state.recurring.pop();
    return;
  }
  $("#recurring-modal").close();
  renderAll();
  showToast("Recurring payment saved.");
}

function markPaid(id) {
  const item = state.recurring.find((entry) => entry.id === id);
  if (!item) return;
  const previousDue = item.nextDue;
  const transaction = { id: makeId(), name: item.name, amount: item.amount, type: item.type || "subscription", category: item.category, paymentMethod: item.paymentMethod, date: isoDate(today), note: `Recurring payment · ${item.frequency}` };
  state.transactions.push(transaction);
  item.nextDue = followingDueDate(item.nextDue, item.frequency, item.dayOfMonth || parseDate(item.nextDue).getDate());
  if (!saveState()) {
    state.transactions.pop();
    item.nextDue = previousDue;
    return;
  }
  renderAll();
  showToast(`${item.name} marked as paid.`);
}

function exportData() {
  const payload = JSON.stringify({ ...state, exportedAt: new Date().toISOString(), format: "moneta-backup-v1" }, null, 2);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  link.download = `moneta-backup-${isoDate(today)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("Your finance data was exported.");
}

function navigate(view) {
  $$(".view").forEach((section) => section.classList.toggle("active-view", section.id === `${view}-view`));
  $$(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $("#current-page").textContent = view === "overview" ? "Overview" : view === "transactions" ? "Transactions" : "Recurring";
  $("#sidebar").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function deleteTransaction(id) {
  const index = state.transactions.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [deleted] = state.transactions.splice(index, 1);
  if (!saveState()) {
    state.transactions.splice(index, 0, deleted);
    return;
  }
  renderAll();
  if (deleted.receiptId) {
    removeReceipt(deleted.receiptId).then(() => showToast("Transaction and receipt deleted.")).catch((error) => {
      console.error("Could not remove receipt after deleting transaction.", error);
      showToast("Transaction deleted, but its receipt could not be removed from browser storage.");
    });
  } else {
    showToast("Transaction deleted.");
  }
}

function bindEvents() {
  $("#month-picker").value = currentMonth();
  $("#transaction-month").value = "";
  $("#currency-picker").value = state.currency;
  $("#theme-picker").value = state.theme;
  applyTheme(state.theme);
  const hour = today.getHours();
  $("#greeting").textContent = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  $("#today-label").textContent = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(today).toUpperCase();
  $("#transaction-type").addEventListener("change", (event) => populateCategorySelect($("#transaction-category"), event.target.value));
  $("#transaction-receipt").addEventListener("change", (event) => {
    const file = event.target.files[0];
    $("#transaction-error").textContent = "";
    $("#receipt-selection").hidden = !file;
    $("#receipt-selection-name").textContent = file ? file.name : "";
  });
  $("#receipt-remove").addEventListener("click", () => {
    $("#transaction-receipt").value = "";
    $("#receipt-selection").hidden = true;
    $("#receipt-selection-name").textContent = "";
  });
  $("#recurring-type").addEventListener("change", (event) => populateCategorySelect($("#recurring-category"), event.target.value));
  $("#currency-picker").addEventListener("change", (event) => {
    const previousCurrency = state.currency;
    state.currency = event.target.value;
    if (saveState()) renderAll();
    else {
      state.currency = previousCurrency;
      event.target.value = previousCurrency;
    }
  });
  $("#theme-picker").addEventListener("change", (event) => {
    const previousTheme = state.theme;
    state.theme = event.target.value;
    applyTheme(state.theme);
    if (!saveState()) {
      state.theme = previousTheme;
      event.target.value = previousTheme;
      applyTheme(previousTheme);
    }
  });
  $("#month-picker").addEventListener("change", renderSummary);
  $("#transaction-search").addEventListener("input", renderTransactions);
  $("#type-filter").addEventListener("change", renderTransactions);
  $("#category-filter").addEventListener("change", renderTransactions);
  $("#transaction-month").addEventListener("change", renderTransactions);
  $("#top-add-button").addEventListener("click", openTransactionModal);
  $("#transaction-add-button").addEventListener("click", openTransactionModal);
  $("#recurring-add-button").addEventListener("click", openRecurringModal);
  $("#add-recurring-link").addEventListener("click", openRecurringModal);
  $("#export-button").addEventListener("click", exportData);
  $("#menu-button").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $$(".nav-link").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
  $$("[data-navigate]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.navigate)));
  $$("[data-close]").forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
  $("#transaction-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const submit = $("#transaction-submit");
    submit.disabled = true;
    addTransaction(new FormData(event.currentTarget)).catch((error) => {
      console.error("Could not save transaction.", error);
      $("#transaction-error").textContent = error.message || "Could not save the transaction.";
    }).finally(() => { submit.disabled = false; });
  });
  $("#recurring-form").addEventListener("submit", (event) => {
    event.preventDefault();
    addRecurring(new FormData(event.currentTarget));
  });
  $("#delete-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (deleteTarget) deleteTransaction(deleteTarget);
    deleteTarget = null;
    $("#delete-modal").close();
  });
  $("#receipt-modal").addEventListener("close", releaseReceiptPreview);
  $("#receipt-delete").addEventListener("click", () => {
    const entry = state.transactions.find((item) => item.receiptId === $("#receipt-download").dataset.receiptId);
    if (entry) deleteReceiptFromTransaction(entry.id);
  });
  document.addEventListener("click", (event) => {
    const receiptButton = event.target.closest("[data-view-receipt]");
    if (receiptButton) {
      const entry = state.transactions.find((item) => item.id === receiptButton.dataset.viewReceipt);
      if (entry) {
        $("#receipt-download").dataset.receiptId = entry.id;
        showReceipt(entry.id);
      }
    }
    const deleteButton = event.target.closest("[data-delete-transaction]");
    if (deleteButton) {
      deleteTarget = deleteButton.dataset.deleteTransaction;
      $("#delete-modal").showModal();
    }
    const paidButton = event.target.closest("[data-mark-paid]");
    if (paidButton) markPaid(paidButton.dataset.markPaid);
    const recurringDelete = event.target.closest("[data-delete-recurring]");
    if (recurringDelete) {
      const index = state.recurring.findIndex((item) => item.id === recurringDelete.dataset.deleteRecurring);
      if (index < 0) return;
      const [removed] = state.recurring.splice(index, 1);
      if (!saveState()) state.recurring.splice(index, 0, removed);
      else { renderAll(); showToast("Recurring payment removed."); }
    }
  });
  $("#sidebar").addEventListener("click", (event) => {
    if (event.target === $("#sidebar") && window.innerWidth <= 800) $("#sidebar").classList.remove("open");
  });
}

bindEvents();
populateCategorySelect($("#transaction-category"), "expense");
populateCategorySelect($("#recurring-category"), "subscription");
populatePaymentMethodSelect($("#transaction-payment-method"));
populatePaymentMethodSelect($("#recurring-payment-method"));
renderAll();
