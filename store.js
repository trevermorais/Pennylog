// On-device data: expenses + budgets, kept in localStorage as one JSON document.
// Replaces the Flask routes + SQLite tables. Nothing ever leaves the phone.

import { norm } from "./insights.js";
import { nowIST, validDateString } from "./format.js";

export const STORAGE_KEY = "pennylog.data.v1";

export const emptyData = () => ({ v: 1, nextId: 1, expenses: [], budgets: [] });

export function loadData(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return emptyData();
    return sanitize(JSON.parse(raw)) || emptyData();
  } catch {
    return emptyData();
  }
}

export function saveData(storage, data) {
  storage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/** Newest first, like ORDER BY created_at DESC, id DESC. */
export function sortedRows(data) {
  return [...data.expenses].sort((a, b) =>
    (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0) || (b.id - a.id));
}

const okAmount = n => Number.isFinite(n) && n > 0;

export function parseAmountInput(raw) {
  const n = Number(String(raw ?? "").trim());
  return String(raw ?? "").trim() !== "" && Number.isFinite(n) ? n : 0;
}

/** Insert imported rows; a row whose external_ref is already on file is skipped. Returns {imported, skipped}. */
export function insertRows(data, rows) {
  const refs = new Set(data.expenses.map(e => e.external_ref).filter(Boolean));
  let imported = 0, skipped = 0;
  for (const r of rows) {
    if (r.external_ref && refs.has(r.external_ref)) { skipped++; continue; }
    if (r.external_ref) refs.add(r.external_ref);
    data.expenses.push({
      id: data.nextId++,
      created_at: r.created_at,
      amount: r.amount,
      category: r.category,
      note: r.note || "",
      external_ref: r.external_ref || null,
      direction: r.direction === "credit" ? "credit" : "debit",
    });
    imported++;
  }
  return { imported, skipped };
}

/**
 * Manual entry. direction 'credit' = money received (category required, like the Add button);
 * direction 'debit' = Spend (blank category becomes 'Other').
 */
export function addEntry(data, { amount, category, note, direction }, now = nowIST()) {
  amount = typeof amount === "number" ? amount : parseAmountInput(amount);
  category = String(category ?? "").trim();
  if (direction !== "credit" && !category) category = "Other";
  if (!okAmount(amount)) return { ok: false, error: "Enter an amount greater than zero." };
  if (!category) return { ok: false, error: "Enter a source or category." };
  data.expenses.push({
    id: data.nextId++, created_at: now, amount, category,
    note: String(note ?? "").trim(), external_ref: null,
    direction: direction === "credit" ? "credit" : "debit",
  });
  return { ok: true };
}

export function updateEntry(data, id, { amount, category, note, date, direction }) {
  const entry = data.expenses.find(e => e.id === id);
  if (!entry) return { ok: false, error: "That entry no longer exists." };
  const amt = parseAmountInput(amount);
  category = String(category ?? "").trim();
  if (!okAmount(amt)) return { ok: false, error: "Enter an amount greater than zero." };
  if (!category) return { ok: false, error: "Category can't be empty." };
  if (!validDateString(date)) return { ok: false, error: "Enter a valid date." };
  entry.amount = amt;
  entry.category = category;
  entry.note = String(note ?? "").trim();
  entry.direction = direction === "credit" ? "credit" : "debit";
  entry.created_at = `${date} ${(entry.created_at || "").slice(11, 19) || "00:00:00"}`;   // keep the time of day
  return { ok: true };
}

export function deleteEntry(data, id) {
  data.expenses = data.expenses.filter(e => e.id !== id);
}

/** Set or change a category's monthly cap. A blank or zero limit removes it. */
export function setBudget(data, categoryRaw, limitRaw) {
  const label = String(categoryRaw ?? "").split(/\s+/).filter(Boolean).join(" ");
  const key = norm(label);
  if (!key) return;
  const raw = String(limitRaw ?? "").trim();
  const limit = raw ? Number(raw) : 0;
  if (!Number.isFinite(limit) || limit < 0) return;
  data.budgets = data.budgets.filter(b => b.category_key !== key);
  if (limit > 0) data.budgets.push({ category_key: key, category_label: label, monthly_limit: limit });
}

// ---- CSV export ------------------------------------------------------------
/** Spreadsheet apps run cells starting with = + - @ as formulas; a leading apostrophe makes them plain text. */
export function csvSafe(text) {
  text = String(text ?? "");
  return ["=", "+", "-", "@", "\t", "\r"].includes(text[0]) ? "'" + text : text;
}
const csvCell = v => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function toCsv(rows) {
  const lines = [["Date", "Type", "Category", "Note", "Amount (INR)", "Reference"]];
  for (const r of rows) {
    lines.push([
      (r.created_at || "").slice(0, 19),
      r.direction === "credit" ? "Received" : "Spent",
      csvSafe(r.category), csvSafe(r.note), r.amount.toFixed(2), csvSafe(r.external_ref),
    ]);
  }
  // BOM so Excel shows ₹ and non-English names correctly
  return "﻿" + lines.map(l => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ---- backup / restore ------------------------------------------------------
export function toBackup(data) {
  return JSON.stringify({ app: "PennyLog", version: 1, exported_at: nowIST(), data }, null, 2);
}

function sanitize(d) {
  if (!d || typeof d !== "object" || !Array.isArray(d.expenses)) return null;
  const out = emptyData();
  let maxId = 0;
  const seen = new Set();
  for (const e of d.expenses) {
    if (!e || typeof e !== "object") return null;
    const amount = Number(e.amount);
    if (!okAmount(amount) || typeof e.category !== "string" || !e.category.trim()) return null;
    if (typeof e.created_at !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(e.created_at)) return null;
    let id = Number.isInteger(e.id) && e.id > 0 && !seen.has(e.id) ? e.id : 0;
    if (!id) id = -1;                      // assigned below
    if (id > 0) { seen.add(id); maxId = Math.max(maxId, id); }
    out.expenses.push({
      id, created_at: e.created_at, amount, category: e.category,
      note: typeof e.note === "string" ? e.note : "",
      external_ref: typeof e.external_ref === "string" && e.external_ref ? e.external_ref : null,
      direction: e.direction === "credit" ? "credit" : "debit",
    });
  }
  for (const e of out.expenses) if (e.id === -1) e.id = ++maxId;
  out.nextId = maxId + 1;
  for (const b of Array.isArray(d.budgets) ? d.budgets : []) {
    const limit = Number(b && b.monthly_limit);
    if (b && typeof b.category_label === "string" && norm(b.category_label) && Number.isFinite(limit) && limit > 0) {
      out.budgets.push({ category_key: norm(b.category_label), category_label: b.category_label, monthly_limit: limit });
    }
  }
  return out;
}

/** Throws a readable Error if the text isn't a PennyLog backup. */
export function fromBackup(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("That file isn't a PennyLog backup."); }
  const data = sanitize(parsed && parsed.app === "PennyLog" ? parsed.data : null);
  if (!data) throw new Error("That file isn't a valid PennyLog backup.");
  return data;
}
