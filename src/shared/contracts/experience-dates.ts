const MONTH_NUMBERS: Record<string, string> = {
  jan: '01',
  january: '01',
  feb: '02',
  february: '02',
  mar: '03',
  march: '03',
  apr: '04',
  april: '04',
  may: '05',
  jun: '06',
  june: '06',
  jul: '07',
  july: '07',
  aug: '08',
  august: '08',
  sep: '09',
  sept: '09',
  september: '09',
  oct: '10',
  october: '10',
  nov: '11',
  november: '11',
  dec: '12',
  december: '12',
};

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
const EXPERIENCE_DATE_PATTERN = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

/** `Month YYYY` or `Mon. YYYY`, e.g. `Sept. 2020`. */
const MONTH_NAME_DATE_PATTERN = /^([a-z]+)\.?\s+(\d{4})$/i;

/**
 * String lengths of year-only (`YYYY`) and month-precision (`YYYY-MM`) dates.
 */
const YEAR_PRECISION_LENGTH = 4;
const MONTH_PRECISION_LENGTH = 7;

function isRealCalendarDay(year: number, month: number, day: number): boolean {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Canonical dates preserve their stated precision: year, month or day. */
export function isExperienceDate(value: string): boolean {
  if (!EXPERIENCE_DATE_PATTERN.test(value)) return false;

  const [year, month, day] = value.split('-').map(Number);
  if (year < 1) return false;
  if (month === undefined) return true;
  if (month < 1 || month > 12) return false;
  if (day === undefined) return true;

  return isRealCalendarDay(year, month, day);
}

/** Convert only unambiguous month names; never invent a day. */
export function normalizeExperienceDate(value: string): string | null {
  const text = value.trim();
  if (isExperienceDate(text)) return text;

  const match = MONTH_NAME_DATE_PATTERN.exec(text);
  if (!match) return null;

  const [, monthName, year] = match;
  const month = MONTH_NUMBERS[monthName.toLowerCase()];
  if (!month) return null;

  const canonical = `${year}-${month}`;

  return isExperienceDate(canonical) ? canonical : null;
}

/** First calendar day a date of any precision could refer to. */
function earliestDayOf(date: string): string {
  if (date.length === YEAR_PRECISION_LENGTH) return `${date}-01-01`;
  if (date.length === MONTH_PRECISION_LENGTH) return `${date}-01`;

  return date;
}

/** Last calendar day a date of any precision could refer to. */
function latestDayOf(date: string): string {
  if (date.length === YEAR_PRECISION_LENGTH) return `${date}-12-31`;
  if (date.length === MONTH_PRECISION_LENGTH) {
    return `${date}-${lastDayOfMonth(date)}`;
  }

  return date;
}

/** Zero-padded last day of a `YYYY-MM` month (day 0 of the next month). */
function lastDayOfMonth(yearMonth: string): string {
  const monthEnd = new Date(0);
  monthEnd.setUTCFullYear(
    Number(yearMonth.slice(0, 4)),
    Number(yearMonth.slice(5, 7)),
    0,
  );

  return String(monthEnd.getUTCDate()).padStart(2, '0');
}

/**
 * Unknown days can overlap: reject only a range that cannot be chronological.
 * Each side is widened to its most permissive day before comparing, so
 * `2020-05` to `2020` is valid. ISO day strings compare lexicographically.
 */
export function isExperienceDateRangeValid(
  start: string | null | undefined,
  end: string | null | undefined,
): boolean {
  if (!start || !end) return true;

  return latestDayOf(end) >= earliestDayOf(start);
}
