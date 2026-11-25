"use strict";

const LEGACY_STORAGE_KEY = "moneta-finance-v1";
const RECEIPT_DB_NAME = "moneta-receipts";
const RECEIPT_STORE_NAME = "receipts";
const RECEIPT_BUCKET = "receipts";
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
const RECEIPT_ALLOWED_TYPES = new Set([...Object.values(RECEIPT_IMAGE_TYPES), "application/pdf"]);

const today = new Date();
const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const currentMonth = () => isoDate(today).slice(0, 7);
const makeId = () => crypto.randomUUID();
let state = { ...DEFAULT_STATE, transactions: [], recurring: [] };
let supabaseClient;
let currentUser;
let activeUserId;
let loadingUserId;
let authGeneration = 0;
let legacyImportCompleted = false;
let authMode = "signin";
let deleteTarget = null;
let toastTimer;
let legacyReceiptDbPromise;
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

function loadLegacyState() {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
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
    throw new Error("The previous local finance data could not be read.");
  }
}

function openLegacyReceiptDb() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("This browser does not support local receipt storage."));
  if (!legacyReceiptDbPromise) {
    legacyReceiptDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(RECEIPT_DB_NAME, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open receipt storage."));
      request.onupgradeneeded = () => {
        request.transaction.abort();
        reject(new Error("No legacy receipt data exists."));
      };
    });
  }
  return legacyReceiptDbPromise;
}

async function getLegacyReceipt(id) {
  const db = await openLegacyReceiptDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECEIPT_STORE_NAME, "readonly");
    const request = transaction.objectStore(RECEIPT_STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Could not read the previous receipt."));
  });
}

function receiptType(file) {
  if (file.type === "application/pdf") return file.type;
  const extension = file.name.split(".").pop().toLowerCase();
  if (extension === "pdf") return "application/pdf";
  return RECEIPT_IMAGE_TYPES[extension] || file.type;
}

function receiptPath(transactionId, name) {
  const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "receipt";
  return `${currentUser.id}/${transactionId}/${crypto.randomUUID()}-${safeName}`;
}

async function uploadReceipt(transactionId, file) {
  const path = receiptPath(transactionId, file.name);
  const { error } = await supabaseClient.storage.from(RECEIPT_BUCKET).upload(path, file, {
    contentType: receiptType(file),
    upsert: false,
  });
  if (error) throw error;
  return path;
}

async function downloadReceipt(path) {
  const { data, error } = await supabaseClient.storage.from(RECEIPT_BUCKET).download(path);
  if (error) throw error;
  return data;
}

async function removeReceipt(path) {
  if (!path) return;
  const { error } = await supabaseClient.storage.from(RECEIPT_BUCKET).remove([path]);
  if (error) throw error;
}

async function showReceipt(transactionId) {
  const entry = state.transactions.find((item) => item.id === transactionId);
  if (!entry?.receiptPath) return;
  try {
    const blob = await downloadReceipt(entry.receiptPath);
    if (!(blob instanceof Blob)) throw new Error("This receipt could not be downloaded.");
    if (entry.receiptType !== "application/pdf" && !entry.receiptType.startsWith("image/")) throw new Error("This receipt file type is not supported.");
    if (receiptObjectUrl) URL.revokeObjectURL(receiptObjectUrl);
    receiptObjectUrl = URL.createObjectURL(blob);
    $("#receipt-title").textContent = entry.name;
    $("#receipt-preview").replaceChildren();
    if (entry.receiptType === "application/pdf") {
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
    $("#receipt-download").download = entry.receiptName || "receipt";
    $("#receipt-download").dataset.receiptId = entry.id;
    $("#receipt-modal").showModal();
  } catch (error) {
    console.error("Could not open receipt.", error);
    showToast(error.message || "Could not open this receipt.");
  }
}

async function deleteReceiptFromTransaction(transactionId) {
  const entry = state.transactions.find((item) => item.id === transactionId);
  if (!entry?.receiptPath) return;
  const path = entry.receiptPath;
  const { error } = await supabaseClient.from("transactions").update({
    receipt_path: null,
    receipt_name: null,
    receipt_type: null,
  }).eq("id", transactionId);
  if (error) throw error;
  delete entry.receiptPath;
  delete entry.receiptName;
  delete entry.receiptType;
  $("#receipt-modal").close();
  renderTransactions();
  try {
    await removeReceipt(path);
    showToast("Receipt removed.");
  } catch (error) {
    console.error("Could not remove detached receipt file.", error);
    showToast("Receipt detached, but its file could not be removed from storage.");
  }
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

function transactionToRow(item) {
  return {
    user_id: currentUser.id,
    id: item.id,
    name: item.name,
    amount: item.amount,
    type: item.type,
    category: item.category,
    payment_method: item.paymentMethod || "Other",
    date: item.date,
    note: item.note || "",
    receipt_path: item.receiptPath || null,
    receipt_name: item.receiptName || null,
    receipt_type: item.receiptType || null,
  };
}

function recurringToRow(item) {
  return {
    user_id: currentUser.id,
    id: item.id,
    name: item.name,
    amount: item.amount,
    type: item.type,
    category: item.category,
    payment_method: item.paymentMethod || "Other",
    next_due: item.nextDue,
    frequency: item.frequency,
    day_of_month: item.dayOfMonth,
  };
}

function transactionFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    amount: Number(row.amount),
    type: row.type,
    category: row.category,
    paymentMethod: row.payment_method,
    date: row.date,
    note: row.note || "",
    ...(row.receipt_path ? {
      receiptPath: row.receipt_path,
      receiptName: row.receipt_name,
      receiptType: row.receipt_type,
    } : {}),
  };
}

function recurringFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    amount: Number(row.amount),
    type: row.type,
    category: row.category,
    paymentMethod: row.payment_method,
    nextDue: row.next_due,
    frequency: row.frequency,
    dayOfMonth: row.day_of_month,
  };
}

async function saveTransaction(item) {
  const { error } = await supabaseClient.from("transactions").upsert(transactionToRow(item), { onConflict: "user_id,id" });
  if (error) throw error;
}

async function saveRecurring(item) {
  const { error } = await supabaseClient.from("recurring_payments").upsert(recurringToRow(item), { onConflict: "user_id,id" });
  if (error) throw error;
}

async function saveSettings(currency = state.currency, theme = state.theme, importedLegacy = legacyImportCompleted) {
  const { error } = await supabaseClient.from("user_settings").upsert({
    user_id: currentUser.id,
    currency,
    theme,
    legacy_imported: importedLegacy,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (error) throw error;
}

function setAuthNotice(message, isError = false) {
  const notice = $("#auth-notice");
  notice.textContent = message;
  notice.classList.toggle("error", isError);
}

function setAuthMode(mode) {
  authMode = mode;
  const signingIn = mode === "signin";
  const resetting = mode === "reset";
  $("#auth-heading").textContent = signingIn ? "Welcome back." : "Create your account.";
  if (resetting) {
    $("#auth-heading").textContent = "Choose a new password.";
    $("#auth-subheading").textContent = "Use at least 8 characters for your new password.";
  } else {
    $("#auth-subheading").textContent = signingIn
      ? "Sign in to securely access your finances."
      : "Your finances will be private to your account.";
  }
  $("#auth-submit").textContent = resetting ? "Update password" : signingIn ? "Sign in" : "Create account";
  $("#auth-switch").hidden = resetting;
  $("#auth-switch").textContent = signingIn ? "New to Moneta? Create an account" : "Already have an account? Sign in";
  $("#auth-password").autocomplete = signingIn ? "current-password" : "new-password";
  $("#auth-forgot").hidden = !signingIn;
  setAuthNotice("");
}

function showAuthScreen(mode = "signin") {
  $("#landing-screen").hidden = true;
  $("#app-shell").hidden = true;
  $("#auth-screen").hidden = false;
  $("#app-error").hidden = true;
  setAuthMode(mode);
  $("#auth-email").focus();
}

function showLandingScreen() {
  $("#landing-screen").hidden = false;
  $("#auth-screen").hidden = true;
  $("#app-shell").hidden = true;
  $("#app-error").hidden = true;
}

async function fetchAllRows(table, orderColumn, ascending) {
  const rows = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabaseClient.from(table)
      .select("*")
      .order(orderColumn, { ascending })
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}

async function loadAccount(user, generation) {
  const [transactionRows, recurringRows, { data: settings, error: settingsError }] = await Promise.all([
    fetchAllRows("transactions", "date", false),
    fetchAllRows("recurring_payments", "next_due", true),
    supabaseClient.from("user_settings").select("currency,theme,legacy_imported").eq("user_id", user.id).maybeSingle(),
  ]);
  if (settingsError) throw settingsError;
  if (generation !== authGeneration) return;

  const preferences = settings || DEFAULT_STATE;
  if (!settings) {
    const { error } = await supabaseClient.from("user_settings").insert({ user_id: user.id });
    if (error) throw error;
  }
  if (generation !== authGeneration) return;
  currentUser = user;
  legacyImportCompleted = Boolean(preferences.legacy_imported);
  state = {
    transactions: transactionRows.map(transactionFromRow),
    recurring: recurringRows.map(recurringFromRow),
    currency: /^[A-Z]{3}$/.test(preferences.currency) ? preferences.currency : "USD",
    theme: THEMES.includes(preferences.theme) ? preferences.theme : "light",
  };
  activeUserId = user.id;
  $("#profile-email").textContent = user.email || "My finances";
  $(".avatar").textContent = (user.email || "M").slice(0, 1).toUpperCase();
  $("#currency-picker").value = state.currency;
  $("#theme-picker").value = state.theme;
  applyTheme(state.theme);
  $("#landing-screen").hidden = true;
  $("#auth-screen").hidden = true;
  $("#app-shell").hidden = false;
  $("#app-error").hidden = true;
  renderAll();
  await maybeOfferLegacyImport();
}

async function activateUser(user) {
  if (!user) {
    authGeneration += 1;
    currentUser = null;
    activeUserId = null;
    loadingUserId = null;
    legacyImportCompleted = false;
    state = { ...DEFAULT_STATE, transactions: [], recurring: [] };
    applyTheme(DEFAULT_STATE.theme);
    if ($("#migration-modal").open) $("#migration-modal").close();
    releaseReceiptPreview();
    $("#auth-form").reset();
    setAuthMode("signin");
    showLandingScreen();
    return;
  }
  if (activeUserId === user.id || loadingUserId === user.id) return;
  const generation = ++authGeneration;
  loadingUserId = user.id;
  currentUser = user;
  activeUserId = null;
  legacyImportCompleted = false;
  state = { ...DEFAULT_STATE, transactions: [], recurring: [] };
  if ($("#migration-modal").open) $("#migration-modal").close();
  releaseReceiptPreview();
  $("#app-shell").hidden = true;
  try {
    await loadAccount(user, generation);
  } catch (error) {
    if (generation !== authGeneration) return;
    console.error("Could not load account data.", error);
    $("#landing-screen").hidden = true;
    $("#auth-screen").hidden = true;
    $("#app-shell").hidden = false;
    $("#app-error-message").textContent = error.message || "Check your Supabase schema and connection, then try again.";
    $("#app-error").hidden = false;
  } finally {
    if (loadingUserId === user.id) loadingUserId = null;
  }
}

async function initializeAuth() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    const body = await response.text();
    let config;
    try {
      config = JSON.parse(body);
    } catch {
      throw new Error("Open Moneta through its Vercel deployment or run it with `vercel dev` so authentication can connect.");
    }
    if (!response.ok) throw new Error(config.error || "Could not load Supabase configuration.");
    if (!window.supabase?.createClient) throw new Error("The Supabase client could not be loaded. Check your connection and refresh.");
    supabaseClient = window.supabase.createClient(config.url, config.anonKey, {
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
    });
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        window.setTimeout(() => {
          $("#auth-email").value = session?.user?.email || "";
          showAuthScreen("reset");
        }, 0);
        return;
      }
      window.setTimeout(() => activateUser(session?.user || null), 0);
    });
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    await activateUser(data.session?.user || null);
  } catch (error) {
    console.error("Could not initialize authentication.", error);
    $("#auth-config").textContent = error.message || "Could not connect to authentication. Check the deployment configuration.";
    $("#auth-config").hidden = false;
    $("#auth-submit").disabled = true;
    $("#auth-switch").disabled = true;
    $("#auth-forgot").disabled = true;
  }
}

async function maybeOfferLegacyImport() {
  if (legacyImportCompleted) return;
  let legacy;
  try {
    legacy = loadLegacyState();
  } catch (error) {
    console.error("Could not check previous local data.", error);
    showToast(error.message || "Could not check previous local data.");
    return;
  }
  if (!legacy || (!legacy.transactions.length && !legacy.recurring.length)) return;
  $("#migration-modal").showModal();
}

async function importLegacyData() {
  const legacy = loadLegacyState();
  if (!legacy) return;
  const transactionIds = new Map(legacy.transactions.map((item) => [item.id, makeId()]));
  const uploadedPaths = [];
  const transactions = [];
  let persistStarted = false;
  try {
    for (const item of legacy.transactions) {
      const id = transactionIds.get(item.id);
      const transaction = { ...item, id };
      delete transaction.receiptId;
      if (item.receiptId) {
        const receipt = await getLegacyReceipt(item.receiptId);
        if (!receipt || !(receipt.blob instanceof Blob)) {
          throw new Error(`Could not find the saved receipt for “${item.name}”. Import was stopped; no records were changed.`);
        }
        const file = new File([receipt.blob], receipt.name || "receipt", { type: receipt.type || "" });
        const path = await uploadReceipt(id, file);
        uploadedPaths.push(path);
        transaction.receiptPath = path;
        transaction.receiptName = receipt.name || "receipt";
        transaction.receiptType = receiptType(file);
      }
      transactions.push(transaction);
    }
    const recurring = legacy.recurring.map((item) => ({ ...item, id: makeId() }));
    persistStarted = true;
    await persistImportedData(transactions, recurring, legacy, uploadedPaths, true);
  } catch (error) {
    if (!persistStarted && uploadedPaths.length) {
      try {
        await removeReceiptPaths(uploadedPaths);
      } catch (cleanupError) {
        console.error("Could not remove receipt files after local import failed.", cleanupError);
        throw new Error(`${error.message} Some uploaded receipt files could not be removed: ${cleanupError.message}`);
      }
    }
    throw error;
  }
  $("#migration-modal").close();
  $("#currency-picker").value = state.currency;
  $("#theme-picker").value = state.theme;
  applyTheme(state.theme);
  renderAll();
  showToast("Your local finance data was imported.");
}

async function removeReceiptPaths(paths) {
  if (!paths.length) return;
  const { error } = await supabaseClient.storage.from(RECEIPT_BUCKET).remove(paths);
  if (error) throw error;
}

async function persistImportedData(transactions, recurring, preferences, uploadedPaths = [], markLegacyImported = false) {
  let insertedTransactions = false;
  let insertedRecurring = false;
  try {
    if (transactions.length) {
      const { error } = await supabaseClient.from("transactions").insert(transactions.map(transactionToRow));
      if (error) throw error;
      insertedTransactions = true;
    }
    if (recurring.length) {
      const { error } = await supabaseClient.from("recurring_payments").insert(recurring.map(recurringToRow));
      if (error) throw error;
      insertedRecurring = true;
    }
    await saveSettings(preferences.currency, preferences.theme, legacyImportCompleted || markLegacyImported);
  } catch (error) {
    const cleanupErrors = [];
    if (insertedRecurring) {
      const { error: cleanupError } = await supabaseClient.from("recurring_payments").delete().in("id", recurring.map((item) => item.id));
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (insertedTransactions) {
      const { error: cleanupError } = await supabaseClient.from("transactions").delete().in("id", transactions.map((item) => item.id));
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (uploadedPaths.length) {
      try {
        await removeReceiptPaths(uploadedPaths);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    cleanupErrors.forEach((cleanupError) => console.error("Could not roll back an incomplete import.", cleanupError));
    if (cleanupErrors.length) {
      throw new Error(`${error.message} The import rollback was incomplete: ${cleanupErrors.map((item) => item.message).join("; ")}`);
    }
    throw error;
  }
  state.transactions.push(...transactions);
  state.recurring.push(...recurring);
  state.currency = preferences.currency;
  state.theme = preferences.theme;
  legacyImportCompleted ||= markLegacyImported;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not include a receipt in the backup."));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToFile(dataUrl, name) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+|application\/pdf);base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
  if (!match) throw new Error(`The receipt backup for ${name} is invalid.`);
  if (!RECEIPT_ALLOWED_TYPES.has(match[1])) throw new Error(`The receipt format for ${name} is not supported.`);
  const binary = atob(match[2]);
  if (binary.length > MAX_RECEIPT_SIZE) throw new Error(`The receipt ${name} is larger than 10 MB.`);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new File([bytes], name, { type: match[1] });
}

async function importBackup(file) {
  if (file.size > 100 * 1024 * 1024) throw new Error("Backup files must be 100 MB or smaller.");
  const backup = JSON.parse(await file.text());
  if (!backup || !["moneta-backup-v1", "moneta-backup-v2"].includes(backup.format)
      || !Array.isArray(backup.transactions) || !Array.isArray(backup.recurring)) {
    throw new Error("Choose a valid Moneta JSON backup.");
  }
  const ids = new Map(backup.transactions.map((item) => [item.id, makeId()]));
  const recurringIds = new Map(backup.recurring.map((item) => [item.id, makeId()]));
  const receiptByTransaction = new Map((Array.isArray(backup.receipts) ? backup.receipts : []).map((receipt) => [receipt.transactionId, receipt]));
  const uploadedPaths = [];
  const transactions = [];
  const recurring = [];
  let persistStarted = false;
  try {
    for (const item of backup.transactions) {
      const name = String(item.name || "").trim();
      const amount = Number(item.amount);
      if (!name || name.length > 70 || !Number.isFinite(amount) || amount <= 0
          || !CATEGORIES[item.type] || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
        throw new Error("The backup contains a transaction with invalid or missing details.");
      }
      const transaction = {
        id: ids.get(item.id),
        name,
        amount: Math.round(amount * 100) / 100,
        type: item.type,
        category: String(item.category || "Other"),
        paymentMethod: String(item.paymentMethod || "Other"),
        date: item.date,
        note: String(item.note || "").slice(0, 160),
      };
      const attachment = receiptByTransaction.get(item.id);
      if (attachment?.dataUrl) {
        const receipt = dataUrlToFile(attachment.dataUrl, attachment.name || "receipt");
        const path = await uploadReceipt(transaction.id, receipt);
        uploadedPaths.push(path);
        transaction.receiptPath = path;
        transaction.receiptName = receipt.name;
        transaction.receiptType = receiptType(receipt);
      }
      transactions.push(transaction);
    }
    for (const item of backup.recurring) {
      const name = String(item.name || "").trim();
      const amount = Number(item.amount);
      if (!name || name.length > 70 || !Number.isFinite(amount) || amount <= 0
          || !["bill", "subscription"].includes(item.type)
          || !["weekly", "monthly", "quarterly", "yearly"].includes(item.frequency)
          || !/^\d{4}-\d{2}-\d{2}$/.test(item.nextDue)) {
        throw new Error("The backup contains a recurring payment with invalid or missing details.");
      }
      recurring.push({
        id: recurringIds.get(item.id),
        name,
        amount: Math.round(amount * 100) / 100,
        type: item.type,
        category: String(item.category || "Other"),
        paymentMethod: String(item.paymentMethod || "Other"),
        nextDue: item.nextDue,
        frequency: item.frequency,
        dayOfMonth: Number(item.dayOfMonth) || parseDate(item.nextDue).getDate(),
      });
    }
    const preferences = {
      currency: /^[A-Z]{3}$/.test(backup.currency) ? backup.currency : state.currency,
      theme: THEMES.includes(backup.theme) ? backup.theme : state.theme,
    };
    persistStarted = true;
    await persistImportedData(transactions, recurring, preferences, uploadedPaths);
  } catch (error) {
    if (!persistStarted && uploadedPaths.length) {
      try {
        await removeReceiptPaths(uploadedPaths);
      } catch (cleanupError) {
        console.error("Could not remove receipt files after backup import failed.", cleanupError);
        throw new Error(`${error.message} Some uploaded receipt files could not be removed: ${cleanupError.message}`);
      }
    }
    throw error;
  }
  $("#currency-picker").value = state.currency;
  $("#theme-picker").value = state.theme;
  applyTheme(state.theme);
  renderAll();
  showToast("Your Moneta backup was imported.");
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
  const hasReceipt = Boolean(item.receiptPath);
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
  if (hasReceipt && (!RECEIPT_ALLOWED_TYPES.has(receiptMime) || receipt.size > MAX_RECEIPT_SIZE)) {
    $("#transaction-error").textContent = receipt.size > MAX_RECEIPT_SIZE ? "Receipt must be 10 MB or smaller." : "Choose a supported image or PDF receipt.";
    return;
  }
  const id = makeId();
  const transaction = {
    id,
    name,
    amount: Math.round(amount * 100) / 100,
    type,
    category: String(formData.get("category")),
    paymentMethod: String(formData.get("paymentMethod")),
    date,
    note: String(formData.get("note") || "").trim(),
  };
  if (hasReceipt) {
    try {
      transaction.receiptPath = await uploadReceipt(id, receipt);
      transaction.receiptName = receipt.name;
      transaction.receiptType = receiptMime;
    } catch (error) {
      console.error("Could not save receipt.", error);
      $("#transaction-error").textContent = error.message || "Could not upload the receipt.";
      return;
    }
  }
  try {
    await saveTransaction(transaction);
  } catch (error) {
    if (transaction.receiptPath) {
      try {
        await removeReceipt(transaction.receiptPath);
      } catch (cleanupError) {
        console.error("Could not clean up receipt after transaction save failed.", cleanupError);
        throw new Error(`${error.message} The uploaded receipt could not be removed: ${cleanupError.message}`);
      }
    }
    throw error;
  }
  state.transactions.push(transaction);
  $("#transaction-modal").close();
  renderAll();
  showToast("Transaction saved.");
}

async function addRecurring(formData) {
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
  await saveRecurring(item);
  state.recurring.push(item);
  $("#recurring-modal").close();
  renderAll();
  showToast("Recurring payment saved.");
}

async function markPaid(id) {
  const item = state.recurring.find((entry) => entry.id === id);
  if (!item) return;
  const transaction = { id: makeId(), name: item.name, amount: item.amount, type: item.type || "subscription", category: item.category, paymentMethod: item.paymentMethod, date: isoDate(today), note: `Recurring payment · ${item.frequency}` };
  const nextDue = followingDueDate(item.nextDue, item.frequency, item.dayOfMonth || parseDate(item.nextDue).getDate());
  await saveTransaction(transaction);
  try {
    await saveRecurring({ ...item, nextDue });
  } catch (error) {
    const { error: rollbackError } = await supabaseClient.from("transactions").delete().eq("id", transaction.id);
    if (rollbackError) {
      console.error("Could not roll back recurring transaction.", rollbackError);
      throw new Error(`${error.message} The generated transaction could not be rolled back: ${rollbackError.message}`);
    }
    throw error;
  }
  state.transactions.push(transaction);
  item.nextDue = nextDue;
  renderAll();
  showToast(`${item.name} marked as paid.`);
}

async function exportData() {
  const receipts = [];
  for (const transaction of state.transactions) {
    if (!transaction.receiptPath) continue;
    const blob = await downloadReceipt(transaction.receiptPath);
    receipts.push({
      transactionId: transaction.id,
      name: transaction.receiptName,
      type: transaction.receiptType,
      dataUrl: await blobToDataUrl(blob),
    });
  }
  const transactions = state.transactions.map(({ receiptPath, ...item }) => item);
  const payload = JSON.stringify({
    ...state,
    transactions,
    receipts,
    exportedAt: new Date().toISOString(),
    format: "moneta-backup-v2",
  }, null, 2);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  link.download = `moneta-backup-${isoDate(today)}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  showToast("Your finance data was exported.");
}

function setSidebarOpen(isOpen) {
  $("#sidebar").classList.toggle("open", isOpen);
  $("#menu-button").setAttribute("aria-expanded", String(isOpen));
  $("#menu-button").setAttribute("aria-label", isOpen ? "Close menu" : "Open menu");
}

function navigate(view) {
  $$(".view").forEach((section) => section.classList.toggle("active-view", section.id === `${view}-view`));
  $$(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $("#current-page").textContent = view === "overview" ? "Overview" : view === "transactions" ? "Transactions" : "Recurring";
  setSidebarOpen(false);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function deleteTransaction(id) {
  const index = state.transactions.findIndex((item) => item.id === id);
  if (index < 0) return;
  const deleted = state.transactions[index];
  const { error } = await supabaseClient.from("transactions").delete().eq("id", id);
  if (error) throw error;
  state.transactions.splice(index, 1);
  renderAll();
  if (deleted.receiptPath) {
    try {
      await removeReceipt(deleted.receiptPath);
      showToast("Transaction and receipt deleted.");
    } catch (error) {
      console.error("Could not remove receipt after deleting transaction.", error);
      showToast("Transaction deleted, but its receipt file could not be removed from storage.");
    }
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
    saveSettings().then(renderAll).catch((error) => {
      console.error("Could not save currency preference.", error);
      state.currency = previousCurrency;
      event.target.value = previousCurrency;
      showToast("Could not save your currency preference.");
    });
  });
  $("#theme-picker").addEventListener("change", (event) => {
    const previousTheme = state.theme;
    state.theme = event.target.value;
    applyTheme(state.theme);
    saveSettings().catch((error) => {
      console.error("Could not save theme preference.", error);
      state.theme = previousTheme;
      event.target.value = previousTheme;
      applyTheme(previousTheme);
      showToast("Could not save your theme preference.");
    });
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
  $("#export-button").addEventListener("click", async () => {
    const button = $("#export-button");
    button.disabled = true;
    try {
      await exportData();
    } catch (error) {
      console.error("Could not export finance data.", error);
      showToast(error.message || "Could not export your finance data.");
    } finally {
      button.disabled = false;
    }
  });
  $("#import-button").addEventListener("click", () => $("#backup-import-file").click());
  $("#backup-import-file").addEventListener("change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (file) importBackup(file).catch((error) => {
      console.error("Could not import Moneta backup.", error);
      showToast(error.message || "Could not import this backup.");
    });
  });
  $$("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => showAuthScreen(button.dataset.authMode));
  });
  $("#auth-switch").addEventListener("click", () => setAuthMode(authMode === "signin" ? "signup" : "signin"));
  $("#auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $("#auth-submit");
    submit.disabled = true;
    setAuthNotice("");
    try {
      const email = $("#auth-email").value.trim();
      const password = $("#auth-password").value;
      if (authMode === "signin") {
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (authMode === "signup") {
        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        if (!data.session) setAuthNotice("Check your email for a confirmation link, then come back to sign in.");
      } else {
        const { error } = await supabaseClient.auth.updateUser({ password });
        if (error) throw error;
        const { error: signOutError } = await supabaseClient.auth.signOut();
        if (signOutError) throw signOutError;
        setAuthMode("signin");
        setAuthNotice("Your password was updated. Sign in with your new password.");
      }
    } catch (error) {
      console.error("Authentication failed.", error);
      setAuthNotice(error.message || "Could not authenticate. Please try again.", true);
    } finally {
      submit.disabled = false;
    }
  });
  $("#auth-forgot").addEventListener("click", async () => {
    const email = $("#auth-email").value.trim();
    if (!email) {
      setAuthNotice("Enter your email address first.", true);
      $("#auth-email").focus();
      return;
    }
    try {
      const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
      if (error) throw error;
      setAuthNotice("If an account exists for this address, a password reset link is on its way.");
    } catch (error) {
      console.error("Could not request password reset.", error);
      setAuthNotice(error.message || "Could not request a password reset.", true);
    }
  });
  $("#signout-button").addEventListener("click", async () => {
    try {
      const { error } = await supabaseClient.auth.signOut();
      if (error) throw error;
    } catch (error) {
      console.error("Could not sign out.", error);
      showToast(error.message || "Could not sign out.");
    }
  });
  $("#retry-load").addEventListener("click", () => activateUser(currentUser));
  $("#error-signout").addEventListener("click", async () => {
    try {
      const { error } = await supabaseClient.auth.signOut();
      if (error) throw error;
    } catch (error) {
      showToast(error.message || "Could not sign out.");
    }
  });
  $("#migration-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#migration-submit");
    button.disabled = true;
    $("#migration-skip").disabled = true;
    $("#migration-error").textContent = "";
    try {
      await importLegacyData();
    } catch (error) {
      console.error("Could not import previous local data.", error);
      $("#migration-error").textContent = error.message || "Could not import the saved data.";
    } finally {
      button.disabled = false;
      $("#migration-skip").disabled = false;
    }
  });
  $("#migration-skip").addEventListener("click", async () => {
    try {
      await saveSettings(state.currency, state.theme, true);
      legacyImportCompleted = true;
      $("#migration-modal").close();
    } catch (error) {
      console.error("Could not save legacy import choice.", error);
      $("#migration-error").textContent = error.message || "Could not save this choice.";
    }
  });
  $("#menu-button").addEventListener("click", () => {
    setSidebarOpen(!$("#sidebar").classList.contains("open"));
  });
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
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    addRecurring(new FormData(event.currentTarget)).catch((error) => {
      console.error("Could not save recurring payment.", error);
      $("#recurring-error").textContent = error.message || "Could not save the recurring payment.";
    }).finally(() => { submit.disabled = false; });
  });
  $("#delete-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      if (deleteTarget) await deleteTransaction(deleteTarget);
      deleteTarget = null;
      $("#delete-modal").close();
    } catch (error) {
      console.error("Could not delete transaction.", error);
      showToast(error.message || "Could not delete this transaction.");
    }
  });
  $("#receipt-modal").addEventListener("close", releaseReceiptPreview);
  $("#receipt-delete").addEventListener("click", async () => {
    const entry = state.transactions.find((item) => item.id === $("#receipt-download").dataset.receiptId);
    if (!entry) return;
    try {
      await deleteReceiptFromTransaction(entry.id);
    } catch (error) {
      console.error("Could not remove receipt.", error);
      showToast(error.message || "Could not remove this receipt.");
    }
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
    if (paidButton) markPaid(paidButton.dataset.markPaid).catch((error) => {
      console.error("Could not mark recurring payment as paid.", error);
      showToast(error.message || "Could not mark this payment as paid.");
    });
    const recurringDelete = event.target.closest("[data-delete-recurring]");
    if (recurringDelete) {
      const index = state.recurring.findIndex((item) => item.id === recurringDelete.dataset.deleteRecurring);
      if (index < 0) return;
      supabaseClient.from("recurring_payments").delete().eq("id", recurringDelete.dataset.deleteRecurring).then(({ error }) => {
        if (error) throw error;
        state.recurring.splice(index, 1);
        renderAll();
        showToast("Recurring payment removed.");
      }).catch((error) => {
        console.error("Could not remove recurring payment.", error);
        showToast(error.message || "Could not remove this recurring payment.");
      });
    }
  });
  document.addEventListener("click", (event) => {
    const sidebar = $("#sidebar");
    const menuButton = $("#menu-button");
    if (
      window.innerWidth <= 800 &&
      sidebar.classList.contains("open") &&
      !sidebar.contains(event.target) &&
      !menuButton.contains(event.target)
    ) {
      setSidebarOpen(false);
    }
  });
}

bindEvents();
populateCategorySelect($("#transaction-category"), "expense");
populateCategorySelect($("#recurring-category"), "subscription");
populatePaymentMethodSelect($("#transaction-payment-method"));
populatePaymentMethodSelect($("#recurring-payment-method"));
applyTheme(state.theme);
initializeAuth();
