import { failure } from "@ambitious/kit/domain/failure";
import { invalid, list, object, oneOf, optionalText, text, type Fields } from "./input.ts";
import { clip, merge, type Span } from "./intervals.ts";
import { dateOfDayNumber, dayNumber, isZone, localDayOf, parseDate, resolveLocal, weekdayOf, type DstNote } from "./zone.ts";

export const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
export const CALENDAR_KINDS = ["person", "resource", "team"] as const;

export type Weekday = (typeof WEEKDAYS)[number];
export type CalendarKind = (typeof CALENDAR_KINDS)[number];

export type Rule = {
  readonly days: readonly Weekday[];
  readonly start: string;
  readonly end: string;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
};

export type Calendar = {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly tz: string;
  readonly kind: CalendarKind;
  readonly person_ref: string | null;
  readonly rules: readonly Rule[];
  readonly exceptions: readonly string[];
};

export type DstEvent = { readonly calendar_id: string; readonly date: string; readonly code: DstNote; readonly message: string };

export type Windows = { readonly spans: readonly Span[]; readonly notes: readonly DstEvent[] };

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_END = 1440;

const clockMinutes = (raw: unknown, field: string, allowDayEnd: boolean): number => {
  if (raw === "24:00" && allowDayEnd) return DAY_END;
  const match = typeof raw === "string" ? CLOCK.exec(raw) : null;
  return match === null ? invalid(field, `a 24-hour local time such as 09:00${allowDayEnd ? ", or 24:00 for the end of the day" : ""}`) : Number(match[1]) * 60 + Number(match[2]);
};

const dateField = (raw: unknown, field: string): string => {
  if (typeof raw !== "string" || parseDate(raw) === null) return invalid(field, "a calendar date written YYYY-MM-DD");
  return raw;
};

const RRULE = /^FREQ=WEEKLY;BYDAY=([A-Z]{2}(?:,[A-Z]{2})*)$/;

const daysOf = (record: Fields, field: string): readonly Weekday[] => {
  const fromRule = typeof record.rrule === "string" ? RRULE.exec(record.rrule)?.[1]?.split(",") : undefined;
  if (record.rrule !== undefined && fromRule === undefined) return invalid(`${field}.rrule`, "of the form FREQ=WEEKLY;BYDAY=MO,TU");
  if (record.rrule !== undefined && record.days !== undefined) return invalid(`${field}.days`, "left out when rrule is given");
  const days = list(fromRule ?? record.days, `${field}.days`, 7).map((day) => oneOf(day, `${field}.days`, WEEKDAYS));
  if (days.length === 0 || new Set(days).size !== days.length) return invalid(`${field}.days`, "a non-empty list of distinct weekdays from SU, MO, TU, WE, TH, FR, SA");
  return WEEKDAYS.filter((day) => days.includes(day));
};

export const parseRules = (raw: unknown): readonly Rule[] =>
  list(raw, "rules", 200).map((entry, index) => {
    const field = `rules[${index}]`;
    const record = object(entry, field, ["days", "rrule", "start", "end", "valid_from", "valid_to"]);
    const start = clockMinutes(record.start, `${field}.start`, false);
    const end = clockMinutes(record.end, `${field}.end`, true);
    if (end <= start) return invalid(`${field}.end`, "later than start on the same day");
    const validFrom = record.valid_from === undefined || record.valid_from === null ? null : dateField(record.valid_from, `${field}.valid_from`);
    const validTo = record.valid_to === undefined || record.valid_to === null ? null : dateField(record.valid_to, `${field}.valid_to`);
    if (validFrom !== null && validTo !== null && validTo < validFrom) return invalid(`${field}.valid_to`, "on or after valid_from");
    return { days: daysOf(record, field), start: String(record.start), end: String(record.end), valid_from: validFrom, valid_to: validTo };
  });

export const parseExceptions = (raw: unknown): readonly string[] =>
  raw === undefined ? [] : [...new Set(list(raw, "exceptions", 5000).map((entry, index) => dateField(entry, `exceptions[${index}]`)))].sort();

export const zoneField = (raw: unknown, field: string): string => {
  const zone = text(raw, field);
  return isZone(zone) ? zone : invalid(field, "an IANA time zone name such as Europe/Paris");
};

export const kindField = (raw: unknown): CalendarKind => (raw === undefined ? "person" : oneOf(raw, "kind", CALENDAR_KINDS));

export const personField = (raw: unknown): string | null => optionalText(raw, "person_ref");

export const workingWindows = (calendar: Calendar, bounds: Span): Windows => {
  if (bounds.end <= bounds.start) return { spans: [], notes: [] };
  const excluded = new Set(calendar.exceptions);
  const spans: Span[] = [];
  const notes: DstEvent[] = [];
  const firstDay = localDayOf(calendar.tz, bounds.start) - 1;
  const lastDay = localDayOf(calendar.tz, bounds.end) + 1;
  for (let day = firstDay; day <= lastDay; day += 1) {
    const date = dateOfDayNumber(day);
    const label = `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
    if (excluded.has(label)) continue;
    const weekday = WEEKDAYS[weekdayOf(day)];
    for (const rule of calendar.rules) {
      if (weekday === undefined || !rule.days.includes(weekday)) continue;
      if ((rule.valid_from !== null && label < rule.valid_from) || (rule.valid_to !== null && label > rule.valid_to)) continue;
      const edge = (clock: string): { readonly minute: number; readonly note: DstNote | null } => {
        const minutes = clock === "24:00" ? DAY_END : Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
        const onDay = minutes === DAY_END ? dateOfDayNumber(day + 1) : date;
        return resolveLocal(calendar.tz, { ...onDay, hour: minutes === DAY_END ? 0 : Math.floor(minutes / 60), minute: minutes === DAY_END ? 0 : minutes % 60 });
      };
      const [start, end] = [edge(rule.start), edge(rule.end)];
      for (const [side, resolved] of [["start", start], ["end", end]] as const) {
        if (resolved.note === null || resolved.minute < bounds.start || resolved.minute > bounds.end) continue;
        notes.push({
          calendar_id: calendar.id,
          date: label,
          code: resolved.note,
          message:
            resolved.note === "DST_GAP"
              ? `The working-hours ${side} ${side === "start" ? rule.start : rule.end} on ${label} does not exist in ${calendar.tz}; the first valid time after it was used.`
              : `The working-hours ${side} ${side === "start" ? rule.start : rule.end} on ${label} happens twice in ${calendar.tz}; the earlier one was used.`,
        });
      }
      if (end.minute > start.minute) spans.push({ start: start.minute, end: end.minute });
    }
  }
  const unique = new Map(notes.map((note) => [`${note.date}|${note.code}|${note.message}`, note]));
  return { spans: clip(merge(spans), bounds), notes: [...unique.values()] };
};

export const dayStart = (calendar: Calendar, day: number): number => resolveLocal(calendar.tz, { ...dateOfDayNumber(day), hour: 0, minute: 0 }).minute;

export const dueMinute = (zone: string, due: string): number | null => {
  const date = parseDate(due.slice(0, 10));
  if (date === null) return null;
  if (due.length === 10) return resolveLocal(zone, { ...dateOfDayNumber(dayNumber(date) + 1), hour: 0, minute: 0 }).minute;
  const parsed = Date.parse(due);
  return Number.isFinite(parsed) ? Math.ceil(parsed / 60_000) : null;
};

export const unknownCalendar = (id: string): never => {
  throw failure("E_NOT_FOUND", `Calendar ${id} does not exist.`, "Use calendar list to find a calendar id, or add the calendar first.");
};
