const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && MONTH_KEY_PATTERN.test(value);
}

export function nextMonthKey(month: string): string {
  if (!isMonthKey(month)) throw new Error(`Invalid month key: ${month}`);

  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;

  if (nextYear > 9999) throw new Error(`Month key is out of range: ${month}`);
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}`;
}

export function monthKeysAfter(startExclusive: string, endInclusive: string): string[] {
  if (!isMonthKey(startExclusive)) throw new Error(`Invalid start month key: ${startExclusive}`);
  if (!isMonthKey(endInclusive)) throw new Error(`Invalid end month key: ${endInclusive}`);
  if (startExclusive >= endInclusive) return [];

  const months: string[] = [];
  for (let month = nextMonthKey(startExclusive); month <= endInclusive; month = nextMonthKey(month)) {
    months.push(month);
  }
  return months;
}

export function currentUtcMonthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}
