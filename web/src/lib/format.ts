const AU_DATE = new Intl.DateTimeFormat("en-AU", { dateStyle: "medium" });

/** en-AU medium date, or an em dash for null/invalid. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : AU_DATE.format(d);
}

/** Cents → currency string (e.g. 14900, "AUD" → "$149.00"). */
export function formatMoney(
  cents: number | null | undefined,
  currency = "AUD",
): string | null {
  if (cents == null) return null;
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
  }).format(cents / 100);
}

/** snake_case / camelCase key → "Sentence case" label for generic JSON display. */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
