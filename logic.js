// Everything the dashboard shows, computed from the stored rows.
// Port of the helper functions and the index() route in app.py.

import { monthLabel, nowIST } from "./format.js";
import { budgetStatus, buildInsights, norm } from "./insights.js";
import { sortedRows } from "./store.js";

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const words = s => String(s ?? "").split(/\s+/).filter(Boolean).join(" ");

/** Month = created_at starts with 'YYYY-MM'. Search = substring of category or note, any case. */
export function applyFilters(rows, q, month) {
  const needle = (q || "").toLowerCase();
  return rows.filter(r => {
    if (month && !(r.created_at || "").startsWith(month)) return false;
    if (needle && !(r.category || "").toLowerCase().includes(needle) && !(r.note || "").toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** [[value, label]] for every month that has data, newest first. */
export function monthsPresent(rows) {
  const keys = [...new Set(rows.map(r => (r.created_at || "").slice(0, 7)).filter(k => MONTH_RE.test(k)))].sort().reverse();
  return keys.map(k => [k, monthLabel(k)]);
}

/** One tab per category (similar spellings merged), biggest spend first. */
export function groupByCategory(rows, total) {
  const groups = new Map();
  for (const r of rows) {
    const label = words(r.category) || "Uncategorised";
    const key = label.toLowerCase();
    if (!groups.has(key)) groups.set(key, { spellings: new Map(), total: 0, rows: [] });
    const g = groups.get(key);
    g.spellings.set(label, (g.spellings.get(label) || 0) + 1);
    g.total += r.amount;
    g.rows.push(r);
  }
  const tabs = [...groups.values()].map(g => {
    let name = null, best = 0;
    for (const [s, n] of g.spellings) if (n > best) { name = s; best = n; }   // most-used spelling; first wins ties
    return { name, total: g.total, count: g.rows.length, share: total ? g.total / total * 100 : 0, rows: g.rows };
  });
  tabs.sort((a, b) => b.total - a.total);
  return tabs;
}

/** Incoming transactions bucketed by month (newest first) with a subtotal for each. */
export function groupByMonth(rows) {
  const months = new Map();
  for (const r of rows) {
    const key = MONTH_RE.test((r.created_at || "").slice(0, 7)) ? r.created_at.slice(0, 7) : "undated";
    if (!months.has(key)) months.set(key, { label: key === "undated" ? "Undated" : monthLabel(key), total: 0, rows: [] });
    const m = months.get(key);
    m.total += r.amount;
    m.rows.push(r);
  }
  return [...months.values()];
}

export function dashboardModel(data, { q = "", month = "", now = nowIST() } = {}) {
  const rows = sortedRows(data);
  const spent = rows.filter(r => r.direction !== "credit");
  const incoming = rows.filter(r => r.direction === "credit");
  const sum = list => list.reduce((a, r) => a + r.amount, 0);

  const total = sum(spent), received = sum(incoming);
  const thisMonth = now.slice(0, 7);
  const today = { year: Number(now.slice(0, 4)), month: Number(now.slice(5, 7)), day: Number(now.slice(8, 10)) };

  const shownSpent = applyFilters(spent, q, month);
  const shownIncoming = applyFilters(incoming, q, month);
  const budgets = budgetStatus(data.budgets, spent, thisMonth);
  const options = monthsPresent(rows);

  const names = [...new Set(spent.filter(r => r.category).map(r => words(r.category)))]
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));

  return {
    spentThisMonth: sum(spent.filter(r => (r.created_at || "").startsWith(thisMonth))),
    receivedThisMonth: sum(incoming.filter(r => (r.created_at || "").startsWith(thisMonth))),
    thisMonthLabel: monthLabel(thisMonth),
    total, received, balance: received - total, incomingCount: incoming.length,
    categories: groupByCategory(shownSpent, sum(shownSpent)),
    incomingMonths: groupByMonth(shownIncoming),
    q, month, monthOptions: options,
    monthLabel: (options.find(([v]) => v === month) || [month, month])[1],
    filtered: Boolean(q || month),
    shownCount: shownSpent.length + shownIncoming.length,
    totalCount: rows.length,
    budgets, budgetAlerts: budgets.filter(b => b.level !== "ok"),
    categoryNames: names,
    insightItems: buildInsights(spent, today),
  };
}

export { norm };
