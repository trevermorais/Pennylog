// PennyLog: the whole app UI. One page, hash-routed:  #/  (dashboard)  #/edit/ID  #/import  #/settings
// All data lives on the device (store.js). Nothing is sent anywhere.

import { esc, inr, nowIST } from "./format.js";
import {
  loadData, saveData, emptyData, sortedRows, addEntry, updateEntry, deleteEntry, setBudget, insertRows,
  toCsv, toBackup, fromBackup,
} from "./store.js";
import { dashboardModel, applyFilters, MONTH_RE } from "./logic.js";
import { parseStatementFile } from "./parser.js";
import { saveFile } from "./files.js";

const APP_VERSION = "1.0.0";
const root = document.getElementById("app");
const toastEl = document.getElementById("toast");

// ---- storage (falls back to memory if the browser blocks localStorage) -------------------
let storageWorks = true;
const memory = new Map();
const storage = (() => {
  try {
    const probe = "pennylog.probe";
    localStorage.setItem(probe, "1"); localStorage.removeItem(probe);
    return localStorage;
  } catch {
    storageWorks = false;
    return { getItem: k => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, v) };
  }
})();

let data = loadData(storage);
const ui = { q: "", month: "", importResult: null, importError: null, editError: null, editValues: null, busy: false };

function persist() {
  try { saveData(storage, data); }
  catch { toast("Couldn't save: this device is out of storage space."); }
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove("show"), 3200);
}

const pref = {
  get: k => { try { return storage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { storage.setItem(k, v); } catch { /* convenience only */ } },
};

// ---- shared pieces -----------------------------------------------------------------------
const icon = {
  edit: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  moon: '<svg class="icon-moon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  sun: '<svg class="icon-sun" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
};

function topbar(links) {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  return `
    <header class="topbar">
      <a class="brand" href="#/" aria-label="PennyLog home">Penny<span>Log</span></a>
      <nav class="mono topnav">
        ${links}
        <button type="button" id="theme-toggle" class="theme-toggle" aria-label="Switch to ${dark ? "light" : "dark"} theme" title="Toggle dark theme">${icon.moon}${icon.sun}</button>
      </nav>
    </header>
    ${storageWorks ? "" : '<div class="alert alert--over" role="alert">This browser is blocking storage, so nothing you enter will be kept after you close the app.</div>'}`;
}

const mainLinks = `<a href="#/import">import</a><a href="#/settings">settings</a>`;

function rowActions(e) {
  return `
    <a class="row-edit" href="#/edit/${e.id}" aria-label="Edit this entry" title="Edit">${icon.edit}</a>
    <span class="row-del"><button type="button" data-del="${e.id}" aria-label="Delete this entry" title="Delete">&times;</button></span>`;
}

// ---- dashboard ---------------------------------------------------------------------------
function dashboardView() {
  const m = dashboardModel(data, { q: ui.q, month: ui.month });
  const summaryView = pref.get("pennylog.summaryView") === "view-received" ? "view-received" : "view-balance";
  const mark = { up: "▲", down: "▼", recurring: "↻" };

  const alerts = m.budgetAlerts.length ? `
    <div class="alert-stack" role="status">
      ${m.budgetAlerts.map(b => `<div class="alert alert--${b.level}">${b.level === "over"
        ? `<strong>${esc(b.category)}</strong> is over budget: ${inr(b.spent)} of ${inr(b.limit)} this month (${b.pct.toFixed(0)}%).`
        : `<strong>${esc(b.category)}</strong>: you've used ${b.pct.toFixed(0)}% of your ${inr(b.limit)} budget this month.`}</div>`).join("")}
    </div>` : "";

  const filterNote = m.filtered ? `
    <div class="filter-note mono">
      Showing ${m.shownCount} of ${m.totalCount} entries${m.q ? ` matching &ldquo;${esc(m.q)}&rdquo;` : ""}${m.month ? ` in ${esc(m.monthLabel)}` : ""}.
      The balance and cashflow cards still cover everything.
    </div>` : "";

  const budgetRows = m.budgets.length ? m.budgets.map(b => `
    <div class="budget-row budget--${b.level}">
      <div class="budget-head">
        <span class="budget-name">${esc(b.category)}</span>
        <span class="mono budget-amts">${inr(b.spent)} of ${inr(b.limit)}</span>
      </div>
      <div class="budget-bar"><span style="width: ${b.bar.toFixed(1)}%"></span></div>
      <div class="budget-sub mono">${b.level === "over" ? `over by ${inr(-b.left)}` : `${inr(b.left)} left &middot; ${b.pct.toFixed(0)}% used`}</div>
    </div>`).join("")
    : '<div class="info-empty mono">No budgets yet. Set a monthly limit for a category below and PennyLog will warn you at 80%.</div>';

  const insights = m.insightItems.length ? m.insightItems.map(i => `
    <div class="insight insight--${i.kind}">
      <span class="insight-mark" aria-hidden="true">${mark[i.kind] || "●"}</span>
      <span>${esc(i.text)}</span>
    </div>`).join("")
    : '<div class="info-empty mono">Insights show up once you have spending from this month and last month.</div>';

  const categories = m.categories.length ? m.categories.map(c => `
    <details class="cat-tab"${m.q ? " open" : ""}>
      <summary>
        <span class="cat-chev" aria-hidden="true"></span>
        <span class="cat-name">${esc(c.name)}</span>
        <span class="cat-count mono">${c.count}</span>
        <span class="cat-total mono">${inr(c.total)}</span>
        <span class="cat-share" title="${c.share.toFixed(0)}% of total spent"><span style="width: ${c.share.toFixed(1)}%"></span></span>
      </summary>
      <div class="cat-body">
        ${c.rows.map(e => `
          <div class="expense-row" title="${esc(e.created_at)}">
            <div class="expense-category">${esc(e.category)}</div>
            <div class="expense-note mono">${esc(e.note)}</div>
            <div class="expense-amount">${inr(e.amount)}</div>
            ${rowActions(e)}
          </div>`).join("")}
      </div>
    </details>`).join("")
    : `<div class="mono empty">${m.filtered ? "No spending matches this search." : "Categories appear here once you log an expense."}</div>`;

  const incoming = m.incomingMonths.length ? m.incomingMonths.map(mo => `
    <div class="month-head mono"><span>${esc(mo.label)}</span></div>
    ${mo.rows.map(e => `
      <div class="expense-row" title="${esc(e.created_at)}">
        <div class="expense-category">${esc(e.category)}</div>
        <div class="expense-note mono">${esc(e.note)}</div>
        <div class="expense-amount is-in">+${inr(e.amount)}</div>
        ${rowActions(e)}
      </div>`).join("")}`).join("")
    : `<div class="mono empty">${m.filtered ? "No received money matches this search."
      : "No money received yet. Add one above or import a statement."}</div>`;

  return `
  <div class="page page--wide">
    ${topbar(mainLinks)}
    ${alerts}

    <form class="filter-bar" data-form="filter">
      <input type="search" name="q" value="${esc(m.q)}" placeholder="Search category or note" aria-label="Search category or note" maxlength="80" enterkeyhint="search" />
      <select name="month" aria-label="Filter by month">
        <option value="">All time</option>
        ${m.monthOptions.map(([v, l]) => `<option value="${v}"${v === m.month ? " selected" : ""}>${esc(l)}</option>`).join("")}
      </select>
      <button type="submit">Search</button>
      ${m.filtered ? '<button type="button" class="filter-link" data-clear>Clear</button>' : ""}
      <button type="button" class="filter-link filter-export" data-export title="Download ${m.filtered ? "these results" : "everything"} as a CSV file">Export CSV</button>
    </form>
    ${filterNote}

    <div class="dashboard">
      <div class="col">
        <div class="total-card summary-card">
          <input type="radio" name="summary-view" id="view-balance"${summaryView === "view-balance" ? " checked" : ""} />
          <input type="radio" name="summary-view" id="view-received"${summaryView === "view-received" ? " checked" : ""} />
          <div class="seg" role="group" aria-label="Summary view">
            <label for="view-balance">Balance</label>
            <label for="view-received">Received</label>
          </div>
          <div class="view view-balance">
            <div class="total-label">Current balance</div>
            <div class="total-amount ${m.balance < 0 ? "is-negative" : "is-ink"}">${inr(m.balance)}</div>
            <div class="flow-sub mono"><span class="is-in">in ${inr(m.received)}</span> &middot; <span>out ${inr(m.total)}</span></div>
          </div>
          <div class="view view-received">
            <div class="total-label">Money received</div>
            <div class="total-amount is-income">${inr(m.received)}</div>
            <div class="flow-sub mono">${m.incomingCount} transaction${m.incomingCount === 1 ? "" : "s"}</div>
          </div>
        </div>

        <div class="info-card">
          <div class="info-title">Budgets &middot; ${esc(m.thisMonthLabel)}</div>
          ${budgetRows}
          <form class="budget-form" data-form="budget">
            <input list="category-names" name="category" placeholder="Category" required maxlength="60" autocomplete="off" />
            <input type="number" inputmode="numeric" name="limit" min="0" step="1" placeholder="Limit ₹" required />
            <button type="submit">Set</button>
          </form>
          <datalist id="category-names">${m.categoryNames.map(n => `<option value="${esc(n)}"></option>`).join("")}</datalist>
          <div class="info-hint mono">Setting a limit of 0 removes that budget.</div>
        </div>

        <div class="info-card">
          <div class="info-title">Insights</div>
          ${insights}
        </div>

        <div class="section-label">Spending by category</div>
        <div class="cat-list">${categories}</div>
      </div>

      <div class="col col--incoming">
        <div class="total-card">
          <div class="total-label">Incoming cashflow &middot; ${esc(m.thisMonthLabel)}</div>
          <div class="total-amount is-income">${inr(m.receivedThisMonth)}</div>
        </div>
        <div class="total-card">
          <div class="total-label">Outgoing cashflow &middot; ${esc(m.thisMonthLabel)}</div>
          <div class="total-amount is-negative">${inr(m.spentThisMonth)}</div>
        </div>

        <form class="add-form add-form--wrap" data-form="add">
          <input type="number" inputmode="decimal" step="0.01" name="amount" placeholder="Amount" required />
          <input type="text" name="category" placeholder="Source / category" maxlength="80" />
          <input type="text" name="note" placeholder="Note (optional)" class="grow" maxlength="300" />
          <button type="submit" name="direction" value="credit" class="add-btn" title="Add as money received (increases balance)">Add</button>
          <button type="submit" name="direction" value="debit" class="spend-btn" title="Add as an expense (subtracts from balance)">Spend</button>
        </form>

        <div class="expense-list">${incoming}</div>
      </div>
    </div>
  </div>`;
}

// ---- edit --------------------------------------------------------------------------------
function editView(id) {
  const entry = data.expenses.find(e => e.id === id);
  if (!entry) { location.hash = "#/"; return ""; }
  const v = ui.editValues || {
    amount: entry.amount.toFixed(2), category: entry.category, note: entry.note,
    date: (entry.created_at || "").slice(0, 10), direction: entry.direction,
  };
  return `
  <div class="page">
    ${topbar(mainLinks)}
    <a href="#/" class="back-link">&larr; back to expenses</a>
    <div class="total-card panel-card">
      <div class="total-label" style="margin-bottom:14px;">Edit entry</div>
      ${ui.editError ? `<div class="auth-error" role="alert">${esc(ui.editError)}</div>` : ""}
      <form data-form="edit" data-id="${id}" autocomplete="off">
        <div class="auth-field">
          <label for="direction">Type</label>
          <select id="direction" name="direction" class="edit-select">
            <option value="debit"${v.direction !== "credit" ? " selected" : ""}>Spent (deducts from balance)</option>
            <option value="credit"${v.direction === "credit" ? " selected" : ""}>Received (adds to balance)</option>
          </select>
        </div>
        <div class="auth-field"><label for="amount">Amount (₹)</label>
          <input type="number" inputmode="decimal" id="amount" name="amount" step="0.01" min="0.01" value="${esc(v.amount)}" required /></div>
        <div class="auth-field"><label for="category">Category / source</label>
          <input type="text" id="category" name="category" value="${esc(v.category)}" required maxlength="80" /></div>
        <div class="auth-field"><label for="note">Note</label>
          <input type="text" id="note" name="note" value="${esc(v.note)}" maxlength="300" /></div>
        <div class="auth-field"><label for="date">Date</label>
          <input type="date" id="date" name="date" value="${esc(v.date)}" required /></div>
        <button type="submit" class="auth-submit">Save changes</button>
      </form>
    </div>
  </div>`;
}

// ---- import ------------------------------------------------------------------------------
function importView() {
  const r = ui.importResult;
  return `
  <div class="page">
    ${topbar(mainLinks)}
    <a href="#/" class="back-link">&larr; back to expenses</a>
    <div class="total-card panel-card">
      <div class="total-label" style="margin-bottom:14px;">Import a transaction statement</div>
      <p class="mono lead">
        Export your transaction history as CSV or Excel (.xlsx) from your bank or payment app
        (Paytm, HDFC, ICICI, SBI, Axis, Kotak and similar), then choose the file here. The file is read on
        this device and never uploaded. Transactions already imported are detected and skipped, so it's safe to
        import a statement that overlaps an earlier one.
      </p>
      ${ui.importError ? `<div class="auth-error" role="alert">${esc(ui.importError)}</div>` : ""}
      ${r ? `<div class="import-result" role="status">Imported <strong>${r.imported}</strong> new transaction${r.imported !== 1 ? "s" : ""},
        skipped <strong>${r.skipped}</strong> already on file (of ${r.total} rows in the file).
        <a href="#/">See them</a></div>` : ""}
      <form data-form="import" class="import-form">
        <input type="file" name="file" id="import-file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
        <button type="submit"${ui.busy ? " disabled" : ""}>${ui.busy ? "Reading…" : "Import"}</button>
      </form>
    </div>
  </div>`;
}

// ---- settings ----------------------------------------------------------------------------
function settingsView() {
  return `
  <div class="page">
    ${topbar(mainLinks)}
    <a href="#/" class="back-link">&larr; back to expenses</a>
    <div class="total-card panel-card">
      <div class="total-label" style="margin-bottom:14px;">Your data</div>
      <p class="mono lead">Everything is stored only on this device: ${data.expenses.length} entr${data.expenses.length === 1 ? "y" : "ies"}, ${data.budgets.length} budget${data.budgets.length === 1 ? "" : "s"}.
        If you uninstall the app or clear its data, it is gone, so keep a backup.</p>
      <div class="settings-list">
        <button type="button" class="auth-submit" data-backup>Back up all data</button>
        <label class="auth-submit secondary file-btn">Restore from a backup
          <input type="file" id="restore-file" accept=".json,application/json" hidden />
        </label>
        <button type="button" class="auth-submit secondary" data-export-all>Export everything as CSV</button>
        <button type="button" class="auth-submit danger" data-erase>Erase all data</button>
      </div>
    </div>
    <div class="total-card panel-card">
      <div class="total-label" style="margin-bottom:10px;">About</div>
      <p class="mono lead" style="margin:0">PennyLog ${APP_VERSION} &middot; works offline &middot; no account, no ads, no tracking.
        Amounts are in rupees and dates use Indian Standard Time. <a href="privacy.html">Privacy policy</a></p>
    </div>
  </div>`;
}

// ---- router ------------------------------------------------------------------------------
function render() {
  const [name, arg] = location.hash.replace(/^#\/?/, "").split("/");
  let html;
  if (name === "edit") html = editView(Number(arg));
  else if (name === "import") html = importView();
  else if (name === "settings") html = settingsView();
  else html = dashboardView();
  if (html) root.innerHTML = html;
}

let lastRoute = null;
window.addEventListener("hashchange", () => {
  const name = location.hash.replace(/^#\/?/, "").split("/")[0];
  if (name !== "edit") { ui.editError = null; ui.editValues = null; }
  if (name !== "import") { ui.importError = null; ui.importResult = null; }
  render();
  if (name !== lastRoute) window.scrollTo(0, 0);
  lastRoute = name;
});

// ---- events (delegated, so re-rendering never loses them) ----------------------------------
const formValues = form => Object.fromEntries(new FormData(form).entries());

root.addEventListener("submit", async ev => {
  const form = ev.target.closest("form[data-form]");
  if (!form) return;
  ev.preventDefault();
  const kind = form.dataset.form;
  const v = formValues(form);

  if (kind === "filter") {
    ui.q = String(v.q || "").trim().slice(0, 80);
    ui.month = MONTH_RE.test(v.month || "") ? v.month : "";
    render();
  } else if (kind === "add") {
    const res = addEntry(data, { amount: v.amount, category: v.category, note: v.note, direction: ev.submitter?.value }, nowIST());
    if (!res.ok) return toast(res.error);
    persist(); render();
    toast(ev.submitter?.value === "credit" ? "Added as money received." : "Expense added.");
  } else if (kind === "budget") {
    setBudget(data, v.category, v.limit);
    persist(); render();
  } else if (kind === "edit") {
    const id = Number(form.dataset.id);
    const res = updateEntry(data, id, v);
    if (!res.ok) { ui.editError = res.error; ui.editValues = v; render(); return; }
    ui.editError = null; ui.editValues = null;
    persist();
    location.hash = "#/";
  } else if (kind === "import") {
    const file = form.querySelector("input[type=file]").files[0];
    if (!file) return;
    ui.busy = true; ui.importError = null; ui.importResult = null; render();
    try {
      const rows = await parseStatementFile(file);
      const { imported, skipped } = insertRows(data, rows);
      if (imported) persist();
      ui.importResult = { imported, skipped, total: rows.length };
    } catch (e) {
      ui.importError = e.message || "Couldn't read that file.";
    }
    ui.busy = false; render();
  }
});

root.addEventListener("change", async ev => {
  const t = ev.target;
  if (t.matches('form[data-form="filter"] select[name="month"]')) {
    ui.month = MONTH_RE.test(t.value) ? t.value : "";
    ui.q = String(new FormData(t.form).get("q") || "").trim().slice(0, 80);
    render();
  } else if (t.name === "summary-view") {
    pref.set("pennylog.summaryView", t.id);
  } else if (t.id === "restore-file" && t.files[0]) {
    try {
      const restored = fromBackup(await t.files[0].text());
      if (!confirm(`Replace everything on this device with the backup (${restored.expenses.length} entries)?`)) return;
      data = restored; persist(); toast("Backup restored.");
      location.hash = "#/";
    } catch (e) {
      toast(e.message);
    }
    t.value = "";
  }
});

let selectedRow = null;
root.addEventListener("click", async ev => {
  const t = ev.target;

  const del = t.closest("[data-del]");
  if (del) {
    if (confirm("Delete this entry?")) { deleteEntry(data, Number(del.dataset.del)); persist(); render(); }
    return;
  }
  if (t.closest(".row-edit")) return;

  const row = t.closest(".expense-row");
  if (row) {                      // tap a block to select it; its edit/delete buttons then show. Tap again to deselect.
    if (selectedRow) selectedRow.classList.remove("is-selected");
    selectedRow = row === selectedRow ? null : row;
    if (selectedRow) selectedRow.classList.add("is-selected");
    return;
  }
  if (selectedRow) { selectedRow.classList.remove("is-selected"); selectedRow = null; }

  if (t.closest("#theme-toggle")) {
    const dark = document.documentElement.getAttribute("data-theme") !== "dark";
    if (dark) document.documentElement.setAttribute("data-theme", "dark"); else document.documentElement.removeAttribute("data-theme");
    pref.set("pennylog.theme", dark ? "dark" : "light");
    t.closest("#theme-toggle").setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} theme`);
    return;
  }
  if (t.closest("[data-clear]")) { ui.q = ""; ui.month = ""; render(); return; }

  try {
    if (t.closest("[data-export]") || t.closest("[data-export-all]")) {
      const all = Boolean(t.closest("[data-export-all]"));
      const rows = all ? sortedRows(data) : applyFilters(sortedRows(data), ui.q, ui.month);
      const name = `pennylog-${all ? "all" : ui.month || "all"}.csv`;
      const how = await saveFile(name, toCsv(rows), "text/csv");
      toast(how === "downloaded" ? `Saved ${name}` : "Choose where to save the CSV.");
    } else if (t.closest("[data-backup]")) {
      const name = `pennylog-backup-${nowIST().slice(0, 10)}.json`;
      const how = await saveFile(name, toBackup(data), "application/json");
      toast(how === "downloaded" ? `Saved ${name}` : "Choose where to keep the backup.");
    } else if (t.closest("[data-erase]")) {
      if (confirm("Erase ALL entries and budgets on this device? This can't be undone.") &&
          confirm("Really erase everything? Make sure you have a backup if you want one.")) {
        data = emptyData(); persist(); toast("All data erased."); render();
      }
    }
  } catch (e) {
    toast(e.message || "Couldn't save the file.");
  }
});

// ---- start -------------------------------------------------------------------------------
render();
lastRoute = location.hash.replace(/^#\/?/, "").split("/")[0];

if ("serviceWorker" in navigator && location.protocol.startsWith("http") && !globalThis.Capacitor?.isNativePlatform?.()) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
