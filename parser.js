// Statement import: CSV / Excel (.xlsx) -> rows ready to store.
// Port of import_parser.py. Two layouts are understood:
//   1. Paytm passbook: Date, Time, Transaction Details, ..., Amount (signed), UPI Ref No., Order ID, Tags ...
//   2. Bank statements (HDFC, ICICI, SBI, Axis, Kotak...): preamble lines above the header, separate
//      Debit/Credit columns or Amount + Dr/Cr, a running Balance column that is never read as an amount,
//      and long narrations from which a merchant name is pulled.
// The bank layouts are written from commonly seen layouts, not verified real files: if one is rejected
// the error lists the headers it found.
//
// Every row comes out as {created_at, amount, category, note, direction, external_ref}.

const COLUMN_HINTS = {
  date: ["transaction date", "txn date", "tran date", "posting date", "date", "value dt"],
  amount: ["amount", "amt"],
  type: ["dr/cr", "cr/dr", "debit/credit", "credit/debit", "transaction type", "txn type", "type"],
  description: ["transaction details", "narration", "particulars", "transaction remarks",
    "description", "details", "remarks", "merchant", "payee"],
  ref: ["upi ref no", "ref no", "ref.no", "ref. no", "reference", "utr", "order id",
    "transaction id", "txn id", "chq", "cheque"],
  category: ["tags", "category"],
};
const DEBIT_HINTS = ["withdrawal", "debit"];
const CREDIT_HINTS = ["deposit", "credit"];
const DEBIT_EXACT = new Set(["dr", "dr."]);
const CREDIT_EXACT = new Set(["cr", "cr."]);
const INCOME_WORDS = ["credit", "received", "refund", "cashback"];

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const cleanHeader = h => String(h ?? "").trim().toLowerCase();
const isBalance = h => h.includes("balance") || ["bal", "bal.", "closing bal"].includes(h);
const isCombinedType = h => h.includes("/") && ((h.includes("dr") && h.includes("cr")) || (h.includes("debit") && h.includes("credit")));
const isDigits = s => /^\d+$/.test(s);

function findColumn(headers, hints, skip = new Set()) {
  for (const hint of hints) {
    for (let i = 0; i < headers.length; i++) {
      const h = cleanHeader(headers[i]);
      if (skip.has(i) || isBalance(h)) continue;
      if (h.includes(hint)) return i;
    }
  }
  return null;
}

function findDebitCredit(headers) {
  const pick = (hints, exact) => {
    for (let i = 0; i < headers.length; i++) {
      const h = cleanHeader(headers[i]);
      if (isBalance(h) || isCombinedType(h)) continue;
      if (exact.has(h) || hints.some(hint => h.includes(hint))) return i;
    }
    return null;
  };
  const debit = pick(DEBIT_HINTS, DEBIT_EXACT), credit = pick(CREDIT_HINTS, CREDIT_EXACT);
  if (debit !== null && credit !== null && debit !== credit) return [debit, credit];
  return [null, null];
}

// A short deterministic hash for the "no reference number" dedup key (cyrb53).
function hash53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function fallbackRef(dateStr, amount, description, direction = "debit") {
  let raw = `${dateStr}|${amount}|${description}`;
  if (direction === "credit") raw += "|credit";
  return "auto-" + hash53(raw).toString(16).padStart(14, "0");
}

/** Banks pad UPI references with leading zeros; Paytm doesn't. Strip them so the same payment dedupes. */
export function normRef(ref) {
  ref = String(ref ?? "").trim();
  if (["none", "nan", "null", "-"].includes(ref.toLowerCase())) return "";
  return isDigits(ref) ? ref.replace(/^0+/, "") : ref;
}

/** '#🛒 Groceries' -> 'Groceries' */
function cleanCategory(raw) {
  return raw.replace(/^#+/, "").trim().replace(/^[^\p{L}]+/u, "").trim();
}

function titleCase(s) {
  return s.toLowerCase().replace(/\p{L}+/gu, w => w[0].toUpperCase() + w.slice(1));
}
function titleIfShouting(name) {
  return name === name.toUpperCase() && name !== name.toLowerCase() ? titleCase(name) : name;
}

export function merchantFromNarration(description, direction) {
  const text = String(description ?? "").split(/\s+/).filter(Boolean).join(" ");
  const upper = text.toUpperCase();

  if (upper.startsWith("UPI-")) {                  // HDFC style: UPI-<NAME>-<vpa>-<ifsc>-<ref>-<note>
    const parts = text.split("-");
    if (parts.length > 1 && parts[1].trim() && !isDigits(parts[1].trim())) {
      return titleIfShouting(parts[1].trim()).slice(0, 40);
    }
  }
  if (upper.startsWith("UPI/")) {                  // Axis/ICICI style: UPI/P2M/<ref>/<NAME>/...
    for (let seg of text.split("/").slice(1)) {
      seg = seg.trim();
      if (seg && !isDigits(seg) && !seg.includes("@")
          && !["P2A", "P2M", "P2P", "PAYMENT", "UPI", "DR", "CR"].includes(seg.toUpperCase())) {
        return titleIfShouting(seg).slice(0, 40);
      }
    }
  }
  if (["ATM", "NFS", "CASH WDL", "CASH WITHDRAWAL"].some(p => upper.startsWith(p))) return "ATM Withdrawal";
  if (["NEFT", "IMPS", "RTGS"].some(p => upper.startsWith(p))) return "Bank Transfer";
  if (/\b(?:INT\.?\s*PD|INTEREST|INT\s+CREDIT)\b/.test(upper) && direction === "credit") return "Interest";
  if (upper.includes("SALARY") && direction === "credit") return "Salary";
  return "";
}

// ---- dates ---------------------------------------------------------------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const TIME = String.raw`(?:[T\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([ap]m)?)?`;
const TAIL = String.raw`\s*(?:Z|[+-]\d{2}:?\d{2})?$`;
const RE_ISO = new RegExp(String.raw`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})` + TIME + TAIL, "i");
const RE_DMY = new RegExp(String.raw`^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})` + TIME + TAIL, "i");
const RE_DMONY = new RegExp(String.raw`^(\d{1,2})(?:st|nd|rd|th)?[\s\-/,.]+([A-Za-z]{3,9})\.?[\s\-/,.]+(\d{2,4})` + TIME + TAIL, "i");
const RE_MONDY = new RegExp(String.raw`^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})` + TIME + TAIL, "i");

const p2 = n => String(n).padStart(2, "0");

function fullYear(y, len) {
  if (len > 2) return y;
  let year = y + 2000;                      // two-digit years land within 50 years of now (as dateutil does)
  const now = new Date().getFullYear();
  if (year - now >= 50) year -= 100;
  return year;
}

function build(y, mo, d, hh, mi, ss, ampm) {
  hh = hh === undefined ? 0 : Number(hh);
  mi = mi === undefined ? 0 : Number(mi);
  ss = ss === undefined ? 0 : Number(ss);
  if (ampm) {
    if (hh < 1 || hh > 12) return null;
    hh = (hh % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  }
  if (hh > 23 || mi > 59 || ss > 59) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${p2(mo)}-${p2(d)} ${p2(hh)}:${p2(mi)}:${p2(ss)}`;
}

/** Day-first (Indian) date text -> 'YYYY-MM-DD HH:MM:SS', or null. */
export function parseDateText(text) {
  text = String(text).trim();
  let m;
  if ((m = RE_ISO.exec(text))) return build(+m[1], +m[2], +m[3], m[4], m[5], m[6], m[7]);
  if ((m = RE_DMY.exec(text))) {
    let day = +m[1], mon = +m[2];
    if (mon > 12 && day <= 12) [day, mon] = [mon, day];       // 03/25/2026 can only be month-first
    return build(fullYear(+m[3], m[3].length), mon, day, m[4], m[5], m[6], m[7]);
  }
  if ((m = RE_DMONY.exec(text)) && MONTHS[m[2].toLowerCase()]) {
    return build(fullYear(+m[3], m[3].length), MONTHS[m[2].toLowerCase()], +m[1], m[4], m[5], m[6], m[7]);
  }
  if ((m = RE_MONDY.exec(text)) && MONTHS[m[1].toLowerCase()]) {
    return build(+m[3], MONTHS[m[1].toLowerCase()], +m[2], m[4], m[5], m[6], m[7]);
  }
  return null;
}

function parseDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // read-excel-file hands back cell dates as UTC-based Date objects, and float noise in the Excel
    // serial can leave them a millisecond short (14:29:59.999), so snap to the nearest second first.
    value = new Date(Math.round(value.getTime() / 1000) * 1000);
    return `${value.getUTCFullYear()}-${p2(value.getUTCMonth() + 1)}-${p2(value.getUTCDate())} ` +
           `${p2(value.getUTCHours())}:${p2(value.getUTCMinutes())}:${p2(value.getUTCSeconds())}`;
  }
  const text = String(value).trim();
  return text ? parseDateText(text) : null;
}

// ---- amounts -------------------------------------------------------------
/** '1,250.00' | '₹1,250' | '+1,000.00' | '-20.00' | '(1,250.00)' | '1250.00 Dr' -> [value, sign] */
export function parseAmount(raw) {
  let text = String(raw ?? "").trim();
  if (!text) return [null, null];
  text = text.replaceAll(",", "").replaceAll("₹", "").replaceAll("Rs.", "").replaceAll("Rs", "").replaceAll("INR", "").trim();

  let sign = null;
  if (text.startsWith("(") && text.endsWith(")")) {
    sign = "-";
    text = text.slice(1, -1).trim();
  }
  const suffix = /\s*(dr|cr)\.?$/i.exec(text);
  if (suffix) {
    sign = suffix[1].toLowerCase() === "dr" ? "-" : "+";
    text = text.slice(0, suffix.index).trim();
  }
  if (text.startsWith("+") || text.startsWith("-")) {
    sign = text[0];
    text = text.slice(1).trim();
  }
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(text)) return [null, null];
  return [Number(text), sign];
}

// ---- tables --------------------------------------------------------------
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const headers = rows[i].map(c => cleanHeader(c ?? ""));
    const hasDate = headers.some(h => h.includes("date"));
    const hasMoney = headers.some(h =>
      ["amount", "amt", "debit", "credit", "withdrawal", "deposit"].some(k => h.includes(k))
      || DEBIT_EXACT.has(h) || CREDIT_EXACT.has(h));
    if (hasDate && hasMoney) return i;
  }
  return null;
}

const cell = (row, idx) => (idx === null || idx >= row.length || row[idx] === null || row[idx] === undefined) ? "" : row[idx];
const str = v => (v instanceof Date ? (parseDate(v) ?? "") : String(v));

function parseRows(headers, rows) {
  const [debitIdx, creditIdx] = findDebitCredit(headers);
  const split = debitIdx !== null;

  const skip = split ? new Set([debitIdx, creditIdx]) : new Set();
  const idx = {};
  for (const [key, hints] of Object.entries(COLUMN_HINTS)) idx[key] = findColumn(headers, hints, skip);
  if (idx.amount !== null && isCombinedType(cleanHeader(headers[idx.amount]))) {
    idx.amount = findColumn(headers, ["amount", "amt"], new Set([...skip, idx.amount]));
  }
  if (idx.type !== null && idx.type === idx.amount) idx.type = null;

  if (idx.date === null || (idx.amount === null && !split)) return null;   // not a transaction table

  const bankMode = split || idx.type !== null;
  const parsed = [];
  const seenKeys = new Map();

  for (const row of rows) {
    const dateVal = cell(row, idx.date);
    const dateStr = str(dateVal).trim();
    const createdAt = parseDate(dateVal);
    if (!dateStr || createdAt === null) continue;     // footer / totals / blank line

    let amount, isCredit;
    if (split) {
      const [debitVal] = parseAmount(cell(row, debitIdx));
      const [creditVal] = parseAmount(cell(row, creditIdx));
      if (debitVal && !creditVal) { amount = debitVal; isCredit = false; }
      else if (creditVal && !debitVal) { amount = creditVal; isCredit = true; }
      else continue;                                  // opening-balance line, or ambiguous
    } else {
      let sign;
      [amount, sign] = parseAmount(cell(row, idx.amount));
      if (amount === null) continue;
      if (sign !== null) {
        isCredit = sign === "+";
      } else {
        const t = idx.type !== null ? str(cell(row, idx.type)).trim().toLowerCase() : "";
        isCredit = Boolean(t) && (t === "cr" || t === "cr." || INCOME_WORDS.some(w => t.includes(w)));
      }
    }
    if (!(amount > 0)) continue;

    const direction = isCredit ? "credit" : "debit";
    const description = str(cell(row, idx.description)).trim();
    const ref = normRef(str(cell(row, idx.ref)));

    let category = idx.category !== null ? cleanCategory(str(cell(row, idx.category))) : "";
    if (!category && bankMode) category = merchantFromNarration(description, direction);

    let externalRef;
    if (ref) {
      externalRef = ref;
    } else {
      externalRef = fallbackRef(dateStr, amount, description, direction);
      // Two identical same-day transactions (two ₹20 teas) share one fallback key: the later ones get a counter.
      const n = (seenKeys.get(externalRef) || 0) + 1;
      seenKeys.set(externalRef, n);
      if (n > 1) externalRef += `#${n}`;
    }

    parsed.push({
      created_at: createdAt,
      amount,
      category: category || (description.slice(0, 40) || "Imported"),
      note: description,
      direction,
      external_ref: externalRef,
    });
  }
  return parsed;
}

function parseTable(rows, label) {
  const hi = findHeaderRow(rows);
  if (hi === null) {
    const first = rows.find(r => r.some(c => c !== null && c !== undefined && String(c).trim())) || [];
    return [null, `${label}: ${first.filter(h => h !== null && h !== undefined && h !== "").map(String).join(", ")}`];
  }
  const headers = rows[hi].map(h => (h === null || h === undefined ? "" : str(h)));
  return [parseRows(headers, rows.slice(hi + 1)), `${label}: ${headers.filter(Boolean).join(", ")}`];
}

// ---- CSV -----------------------------------------------------------------
export function decodeCsvBytes(buffer) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder("windows-1252").decode(buffer);       // older bank exports
  }
  return text.replace(/^﻿/, "");
}

function splitLine(line, delim) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function sniffDelimiter(text) {
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim()).slice(0, 30);
  let best = ",", bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = lines.map(l => splitLine(l, d).length - 1);
    const freq = new Map();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) || 0) + 1);
    let modal = 0, modalLines = 0;
    for (const [c, n] of freq) if (n > modalLines || (n === modalLines && c > modal)) { modal = c; modalLines = n; }
    const score = modalLines * 1000 + modal;
    if (modalLines > 0 && score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

export function readCsvRows(text) {
  const delim = sniffDelimiter(text);
  // Split into records, keeping newlines inside quoted fields.
  const records = [];
  let cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQ = !inQ;
    if (!inQ && (c === "\n" || c === "\r")) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      records.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) records.push(cur);
  return records.map(r => (r === "" ? [] : splitLine(r, delim)));
}

// ---- entry points ----------------------------------------------------------
export function parseCsvText(text) {
  const rows = readCsvRows(text);
  if (!rows.length) return [];
  const [result, seen] = parseTable(rows, "CSV");
  if (result === null) throw new Error("Couldn't find date/amount columns in this file. Headers found — " + seen);
  return result;
}

/** sheets: [{sheet: "Name", data: [[cell, ...], ...]}, ...] as returned by read-excel-file. */
export function parseSheets(sheets) {
  const tried = [];
  for (const { sheet, data } of sheets) {
    if (!data || !data.length) continue;
    const [result, seen] = parseTable(data, sheet);
    if (result !== null) return result;
    tried.push(seen);
  }
  throw new Error("Couldn't find a sheet with date/amount columns. Checked — " + tried.join(" | "));
}

/**
 * file: a File from <input type="file">. readXlsx: the read-excel-file function
 * (the global `readXlsxFile` in the browser, passed in by tests).
 */
export async function parseStatementFile(file, readXlsx = globalThis.readXlsxFile) {
  const name = (file.name || "").toLowerCase();
  if (file.size > MAX_FILE_BYTES) throw new Error("That file is bigger than 5 MB. Export a shorter date range and try again.");

  if (name.endsWith(".csv")) return parseCsvText(decodeCsvBytes(await file.arrayBuffer()));

  if (name.endsWith(".xlsx")) {
    let sheets;
    try {
      sheets = await readXlsx(file);
    } catch {
      throw new Error("Couldn't open this Excel file. If it's password-protected, remove the password first.");
    }
    if (!Array.isArray(sheets)) sheets = [{ sheet: "Sheet1", data: sheets }];
    return parseSheets(sheets);
  }
  if (name.endsWith(".xls")) throw new Error("Old .xls files aren't supported. Open it in Excel, Save As .xlsx (or CSV), then upload that.");
  if (name.endsWith(".pdf")) throw new Error("PDF statements aren't supported yet. In net banking, download the statement as CSV or Excel instead.");
  throw new Error("Unsupported file type — upload a .csv or .xlsx export.");
}
