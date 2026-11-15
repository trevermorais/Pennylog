// Small formatting helpers shared by the UI and the tests.

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

export function monthName(m) { return MONTH_NAMES[m - 1]; }

/** "2026-10" -> "October 2026" */
export function monthLabel(key) {
  return `${monthName(Number(key.slice(5, 7)))} ${key.slice(0, 4)}`;
}

/** HTML-escape anything that came from a file, a note or a category before it goes into innerHTML. */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/**
 * Like Number.prototype.toFixed, but exact ties round to even the way Python's
 * format() does (JS rounds them up). Keeps the numbers identical to the Flask version.
 */
export function fixed(value, digits) {
  const abs = Math.abs(value);
  // toFixed with extra digits prints the float's exact decimal expansion, so a true tie (…5000…) is
  // detectable without floating-point multiplication error (0.005 is NOT a tie: it is 0.005000000000000000104…).
  const exact = abs.toFixed(Math.min(100, digits + 40));
  const dot = exact.indexOf(".");
  if (/^50*$/.test(exact.slice(dot + 1 + digits))) {
    let n = BigInt(exact.slice(0, dot) + exact.slice(dot + 1, dot + 1 + digits));
    if (n % 2n === 1n) n += 1n;                                  // half-even
    let s = n.toString().padStart(digits + 1, "0");
    if (digits) s = s.slice(0, -digits) + "." + s.slice(-digits);
    return (value < 0 ? "-" : "") + s;
  }
  return value.toFixed(digits);
}

/** 1234567.5 -> '₹12,34,567.50' (Indian lakh/crore digit grouping). */
export function inr(value) {
  value = Number(value) || 0;
  const rounded = Number(fixed(value, 2));
  const sign = rounded < 0 ? "-" : "";
  let [whole, frac] = fixed(Math.abs(value), 2).split(".");
  if (whole.length > 3) {
    let head = whole.slice(0, -3);
    const tail = whole.slice(-3);
    const groups = [];
    while (head.length > 2) {
      groups.unshift(head.slice(-2));
      head = head.slice(0, -2);
    }
    if (head) groups.unshift(head);
    whole = [...groups, tail].join(",");
  }
  return `${sign}₹${whole}.${frac}`;
}

/** Western grouping, no decimals: used inside the plain-language insights. */
export function money(value) {
  return "₹" + fixed(value, 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Current time as 'YYYY-MM-DD HH:MM:SS' in Indian Standard Time, whatever the phone's own time zone is. */
export function nowIST(date = new Date()) {
  return new Date(date.getTime() + 330 * 60000).toISOString().slice(0, 19).replace("T", " ");
}

/** Strict YYYY-MM-DD check (real calendar date). */
export function validDateString(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text || "");
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
