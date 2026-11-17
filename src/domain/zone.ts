import { MINUTE } from "./input.ts";

export type LocalDate = { readonly year: number; readonly month: number; readonly day: number };
export type LocalTime = LocalDate & { readonly hour: number; readonly minute: number };
export type DstNote = "DST_GAP" | "DST_OVERLAP";
export type Resolved = { readonly minute: number; readonly note: DstNote | null };

const DAY_MINUTES = 1440;
const formatters = new Map<string, Intl.DateTimeFormat>();

const formatter = (zone: string): Intl.DateTimeFormat => {
  const cached = formatters.get(zone);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatters.set(zone, created);
  return created;
};

export const isZone = (zone: string): boolean => {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
};

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

export const wallMinute = ({ year, month, day, hour, minute }: LocalTime): number => {
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, 0, 0);
  return instant.getTime() / MINUTE;
};

export const localAt = (zone: string, minute: number): LocalTime => {
  const parts = new Map<string, string>(formatter(zone).formatToParts(new Date(minute * MINUTE)).map((part) => [part.type, part.value]));
  const field = (name: string): number => Number(parts.get(name) ?? "0");
  const year = parts.get("era") === "BC" ? 1 - field("year") : field("year");
  return { year, month: field("month"), day: field("day"), hour: field("hour"), minute: field("minute") };
};

export const offsetAt = (zone: string, minute: number): number => wallMinute(localAt(zone, minute)) - minute;

const firstMinuteWithOffset = (zone: string, from: number, to: number, offset: number): number => {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsetAt(zone, middle) === offset) high = middle;
    else low = middle + 1;
  }
  return low;
};

export const resolveLocal = (zone: string, local: LocalTime): Resolved => {
  const wall = wallMinute(local);
  const before = offsetAt(zone, wall - DAY_MINUTES);
  const after = offsetAt(zone, wall + DAY_MINUTES);
  const candidates = [...new Set([before, after])].map((offset) => wall - offset).filter((minute) => wallMinute(localAt(zone, minute)) === wall);
  const [first, second] = candidates.toSorted((a, b) => a - b);
  if (first !== undefined) return { minute: first, note: second === undefined ? null : "DST_OVERLAP" };
  const [early, late] = [wall - before, wall - after].toSorted((a, b) => a - b);
  if (early === undefined || late === undefined) return { minute: wall - before, note: "DST_GAP" };
  return { minute: firstMinuteWithOffset(zone, early, late, offsetAt(zone, late)), note: "DST_GAP" };
};

export const dayNumber = ({ year, month, day }: LocalDate): number => wallMinute({ year, month, day, hour: 0, minute: 0 }) / DAY_MINUTES;

export const dateOfDayNumber = (dayIndex: number): LocalDate => {
  const instant = new Date(dayIndex * DAY_MINUTES * MINUTE);
  return { year: instant.getUTCFullYear(), month: instant.getUTCMonth() + 1, day: instant.getUTCDate() };
};

export const weekdayOf = (dayIndex: number): number => (((dayIndex + 4) % 7) + 7) % 7;

export const dateText = ({ year, month, day }: LocalDate): string => `${pad(year, 4)}-${pad(month)}-${pad(day)}`;

export const parseDate = (raw: string): LocalDate | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return dateText(dateOfDayNumber(dayNumber(date))) === raw ? date : null;
};

export const localText = (zone: string, minute: number): string => {
  const local = localAt(zone, minute);
  const offset = offsetAt(zone, minute);
  const size = Math.abs(offset);
  return `${dateText(local)}T${pad(local.hour)}:${pad(local.minute)}:00${offset < 0 ? "-" : "+"}${pad(Math.floor(size / 60))}:${pad(size % 60)}`;
};

export const localDayOf = (zone: string, minute: number): number => dayNumber(localAt(zone, minute));
