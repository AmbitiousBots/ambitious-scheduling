import { parseNow } from "@ambitious/kit/domain/clock";
import { failure } from "@ambitious/kit/domain/failure";
import { isRecord } from "@ambitious/kit/domain/json";

export type Fields = Readonly<Record<string, unknown>>;

export const MINUTE = 60_000;
export const MAX_TEXT = 500;

export const invalid = (field: string, expected: string): never => {
  throw failure("E_INPUT_SCHEMA", `The field ${field} must be ${expected}.`, "Send one JSON object with the fields the README lists for this command.");
};

export const object = (raw: unknown, field: string, allowed: readonly string[]): Fields => {
  if (!isRecord(raw)) return invalid(field, "an object");
  const extra = Object.keys(raw).find((name) => !allowed.includes(name));
  if (extra !== undefined) return invalid(`${field}.${extra}`, `left out; ${field} takes only ${allowed.join(", ")}`);
  return raw;
};

export const text = (raw: unknown, field: string): string => {
  if (typeof raw !== "string" || raw.trim() === "" || raw.trim() !== raw || raw.length > MAX_TEXT) {
    return invalid(field, `a non-empty string of at most ${MAX_TEXT} characters with no surrounding spaces`);
  }
  return raw;
};

export const optionalText = (raw: unknown, field: string): string | null => (raw === undefined || raw === null ? null : text(raw, field));

export const integer = (raw: unknown, field: string, minimum: number, maximum: number): number => {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < minimum || raw > maximum) {
    return invalid(field, `a whole number from ${minimum} to ${maximum}`);
  }
  return raw;
};

export const number = (raw: unknown, field: string, minimum: number, maximum: number): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < minimum || raw > maximum) return invalid(field, `a number from ${minimum} to ${maximum}`);
  return raw;
};

export const list = (raw: unknown, field: string, maximum = 100_000): readonly unknown[] => {
  if (!Array.isArray(raw) || raw.length > maximum) return invalid(field, `a list of at most ${maximum} entries`);
  return raw;
};

export const oneOf = <const Options extends readonly string[]>(raw: unknown, field: string, options: Options): Options[number] => {
  const found = options.find((option) => option === raw);
  return found ?? invalid(field, `one of ${options.join(", ")}`);
};

export const instantMs = (raw: unknown, field: string): number => {
  const parsed = typeof raw === "string" ? parseNow(raw) : null;
  return parsed === null ? invalid(field, "an ISO 8601 time with a time zone, for example 2026-01-05T09:00:00Z") : parsed.getTime();
};

export const toIso = (ms: number): string => new Date(ms).toISOString();

export const floorMinute = (ms: number): number => Math.floor(ms / MINUTE);

export const ceilMinute = (ms: number): number => Math.ceil(ms / MINUTE);

export const minuteIso = (minute: number): string => toIso(minute * MINUTE);

export const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonical(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export type Hasher = (text: string) => string;
