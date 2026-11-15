// Budgets, recurring payments and plain-language insights.
// Straight port of insights.py: pure functions over plain row objects.
// Rows need: created_at ('YYYY-MM-DD HH:MM:SS'), amount, category, note. Pass only SPENT rows.

import { fixed, money } from "./format.js";

export const WARN_AT = 0.80;
export const OVER_AT = 1.00;

const PAYEE_PREFIX = /^(?:money sent to|payment to|paid to|sent to|paid|upi)\s+/i;

const words = s => String(s ?? "").split(/\s+/).filter(Boolean);

/** 'Groceries ', 'groceries' and 'GROCERIES' are one category. */
export function norm(label) {
  return words(label).join(" ").toLowerCase();
}

export function monthOf(createdAt) {
  const text = (createdAt || "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(text) ? text : null;
}

export function dayOf(createdAt) {
  const n = parseInt((createdAt || "").slice(8, 10), 10);
  return Number.isNaN(n) ? 0 : n;
}

export function previousMonth(month) {
  const year = Number(month.slice(0, 4)), mon = Number(month.slice(5, 7));
  return mon === 1 ? `${year - 1}-12` : `${year}-${String(mon - 1).padStart(2, "0")}`;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** One entry per budget, most-used first, with this month's spend and a level: ok | warn | over. */
export function budgetStatus(budgets, spentRows, month) {
  const spent = new Map();
  for (const r of spentRows) {
    if (monthOf(r.created_at) === month) {
      const k = norm(r.category);
      spent.set(k, (spent.get(k) || 0) + r.amount);
    }
  }
  const out = budgets.map(b => {
    const limit = Number(b.monthly_limit);
    const used = spent.get(b.category_key) || 0;
    const ratio = limit > 0 ? used / limit : 0;
    const level = ratio >= OVER_AT ? "over" : ratio >= WARN_AT ? "warn" : "ok";
    return {
      category: b.category_label, key: b.category_key, limit, spent: used, left: limit - used,
      pct: ratio * 100, bar: Math.min(ratio, 1) * 100, level,
    };
  });
  out.sort((a, b) => b.pct - a.pct);
  return out;
}

function payee(row) {
  const note = (row.note || "").trim().replace(PAYEE_PREFIX, "").trim();
  return note.length > 0 && note.length <= 40 ? note : (row.category || "").trim().slice(0, 40);
}

/** Same payee, roughly the same amount, in 2+ months, at most twice in any month. */
export function findRecurring(spentRows) {
  const byPayee = new Map();   // key -> Map(month -> [amounts])
  const names = new Map();
  for (const r of spentRows) {
    const m = monthOf(r.created_at);
    const p = payee(r);
    if (!m || !p) continue;
    const key = p.toLowerCase();
    if (!names.has(key)) names.set(key, p);
    if (!byPayee.has(key)) byPayee.set(key, new Map());
    const months = byPayee.get(key);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(r.amount);
  }

  const found = [];
  for (const [key, months] of byPayee) {
    if (months.size < 2) continue;
    if ([...months.values()].some(v => v.length > 2)) continue;
    const amounts = [...months.values()].flat();
    if (Math.max(...amounts) > Math.min(...amounts) * 1.10) continue;
    found.push({ name: names.get(key), amount: median(amounts), months: months.size });
  }
  found.sort((a, b) => b.amount - a.amount);
  return found;
}

/** today: {year, month, day}. Returns [{kind, text}]. */
export function buildInsights(spentRows, today, maxItems = 6) {
  const thisM = `${today.year}-${String(today.month).padStart(2, "0")}`;
  const lastM = previousMonth(thisM);
  const cutoff = today.day;

  const thisByCat = new Map(), lastByCat = new Map(), labels = new Map();
  const add = (map, k, v) => map.set(k, (map.get(k) || 0) + v);
  for (const r of spentRows) {
    const m = monthOf(r.created_at);
    const k = norm(r.category) || "uncategorised";
    if (!labels.has(k)) labels.set(k, words(r.category || "Uncategorised").join(" "));
    if (m === thisM) add(thisByCat, k, r.amount);
    else if (m === lastM && dayOf(r.created_at) <= cutoff) add(lastByCat, k, r.amount);
  }

  const items = [];
  const sum = map => [...map.values()].reduce((a, b) => a + b, 0);
  const thisTotal = sum(thisByCat), lastTotal = sum(lastByCat);

  // 1) Overall pace
  if (thisTotal > 0 && lastTotal > 0) {
    const change = (thisTotal - lastTotal) / lastTotal * 100;
    if (Math.abs(change) >= 10) {
      const direction = change > 0 ? "more" : "less";
      items.push({
        kind: change > 0 ? "up" : "down",
        text: `You've spent ${money(thisTotal)} so far this month — ${fixed(Math.abs(change), 0)}% ${direction} than the same days last month (${money(lastTotal)}).`,
      });
    }
  }

  // 2) Biggest spend this month
  if (thisByCat.size) {
    let top = null;
    for (const [k, v] of thisByCat) if (top === null || v > thisByCat.get(top)) top = k;
    const share = thisByCat.get(top) / thisTotal * 100;
    items.push({
      kind: "info",
      text: `Your biggest spend this month is ${labels.get(top)}: ${money(thisByCat.get(top))} (${fixed(share, 0)}% of spending).`,
    });
  }

  // 3) Categories that moved most vs the same days last month
  const moves = [];
  for (const [k, last] of lastByCat) {
    if (last < 100) continue;                 // tiny bases make huge, meaningless percentages
    const cur = thisByCat.get(k) || 0;
    const change = (cur - last) / last * 100;
    if (Math.abs(change) >= 25) moves.push([Math.abs(cur - last), k, change, cur, last]);
  }
  moves.sort((a, b) => (b[0] - a[0]) || (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
  for (const [, k, change, cur, last] of moves.slice(0, 3)) {
    const direction = change > 0 ? "up" : "down";
    items.push({
      kind: direction,
      text: `${labels.get(k)} is ${direction} ${fixed(Math.abs(change), 0)}% vs the same days last month (${money(last)} → ${money(cur)}).`,
    });
  }

  // 4) Recurring payments
  const recurring = findRecurring(spentRows);
  if (recurring.length) {
    const monthly = recurring.reduce((a, r) => a + r.amount, 0);
    const names = recurring.slice(0, 3).map(r => r.name).join(", ");
    const more = recurring.length > 3 ? ` and ${recurring.length - 3} more` : "";
    items.push({
      kind: "recurring",
      text: `${recurring.length} payment${recurring.length !== 1 ? "s" : ""} look${recurring.length === 1 ? "s" : ""} recurring, about ${money(monthly)} a month: ${names}${more}.`,
    });
  }

  return items.slice(0, maxItems);
}
