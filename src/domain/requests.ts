import { failure } from "@ambitious/kit/domain/failure";
import { isRecord } from "@ambitious/kit/domain/json";
import { kindField, parseExceptions, parseRules, personField, zoneField, type CalendarKind, type Rule } from "./calendar.ts";
import { HOLD_STATUSES, type HoldStatus } from "./holds.ts";
import { ceilMinute, floorMinute, instantMs, integer, invalid, list, number, object, oneOf, optionalText, text, type Fields } from "./input.ts";
import type { Span } from "./intervals.ts";
import { parseMapping, type Mapping } from "./model.ts";
import type { Block } from "./plan.ts";
import type { Policy } from "./tasks.ts";

export type Write = { readonly idem_key: string; readonly actor: string };

const WRITE = ["idem_key", "actor"] as const;
const MAX_HORIZON_MINUTES = 3 * 366 * 1440;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const write = (record: Fields): Write => ({ idem_key: text(record.idem_key, "idem_key"), actor: record.actor === undefined ? "caller" : text(record.actor, "actor") });

export const idField = (raw: unknown, field: string): string => {
  if (typeof raw !== "string" || !ID.test(raw)) return invalid(field, "an identifier of 1 to 100 letters, digits, dots, hyphens or underscores, starting with a letter or digit");
  return raw;
};

const version = (raw: unknown, field: string, minimum = 1): number => integer(raw, field, minimum, 1_000_000_000);

export type CalendarAdd = Write & { readonly id: string; readonly name: string; readonly tz: string; readonly kind: CalendarKind; readonly person_ref: string | null };

export const parseCalendarAdd = (raw: unknown): CalendarAdd => {
  const record = object(raw, "input", ["id", "name", "tz", "kind", "person_ref", ...WRITE]);
  const id = idField(record.id, "id");
  return { id, name: record.name === undefined ? id : text(record.name, "name"), tz: zoneField(record.tz, "tz"), kind: kindField(record.kind), person_ref: personField(record.person_ref), ...write(record) };
};

export type CalendarPatch = { readonly name?: string; readonly tz?: string; readonly kind?: CalendarKind; readonly person_ref?: string | null };
export type CalendarUpdate = Write & { readonly id: string; readonly expected_version: number; readonly patch: CalendarPatch };

export const parseCalendarUpdate = (raw: unknown): CalendarUpdate => {
  const record = object(raw, "input", ["id", "expected_version", "patch", ...WRITE]);
  const patch = object(record.patch, "patch", ["name", "tz", "kind", "person_ref"]);
  return {
    id: idField(record.id, "id"),
    expected_version: version(record.expected_version, "expected_version"),
    patch: {
      ...(patch.name === undefined ? {} : { name: text(patch.name, "patch.name") }),
      ...(patch.tz === undefined ? {} : { tz: zoneField(patch.tz, "patch.tz") }),
      ...(patch.kind === undefined ? {} : { kind: kindField(patch.kind) }),
      ...(patch.person_ref === undefined ? {} : { person_ref: personField(patch.person_ref) }),
    },
    ...write(record),
  };
};

export type AvailabilitySet = Write & { readonly calendar_id: string; readonly expected_version: number; readonly rules: readonly Rule[]; readonly exceptions: readonly string[] };

export const parseAvailabilitySet = (raw: unknown): AvailabilitySet => {
  const record = object(raw, "input", ["calendar_id", "expected_version", "rules", "exceptions", ...WRITE]);
  return {
    calendar_id: idField(record.calendar_id, "calendar_id"),
    expected_version: version(record.expected_version, "expected_version"),
    rules: parseRules(record.rules),
    exceptions: parseExceptions(record.exceptions),
    ...write(record),
  };
};

export type IdInput = { readonly id: string };

export const parseId = (raw: unknown): IdInput => ({ id: idField(object(raw, "input", ["id"]).id, "id") });

const span = (raw: unknown, field: string, startName = "start", endName = "end"): Span => {
  const record = object(raw, field, [startName, endName]);
  const start = floorMinute(instantMs(record[startName], `${field}.${startName}`));
  const end = ceilMinute(instantMs(record[endName], `${field}.${endName}`));
  if (end <= start) return invalid(`${field}.${endName}`, `later than ${field}.${startName}`);
  return { start, end };
};

export type BusyBlock = Span & { readonly label: string | null };
export type BusyImport = Write & { readonly calendar_id: string; readonly source: string; readonly window: Span; readonly taken_at: number; readonly blocks: readonly BusyBlock[] };

export const parseBusyImport = (raw: unknown): BusyImport => {
  const record = object(raw, "input", ["calendar_id", "source", "window", "taken_at", "blocks", ...WRITE]);
  const window = span(record.window, "window");
  const blocks = list(record.blocks, "blocks").map((entry, index) => {
    const field = `blocks[${index}]`;
    const block = object(entry, field, ["start", "end", "label"]);
    return { ...span({ start: block.start, end: block.end }, field), label: optionalText(block.label, `${field}.label`) };
  });
  const outside = blocks.findIndex((block) => block.end <= window.start || block.start >= window.end);
  if (outside !== -1) return invalid(`blocks[${outside}]`, "at least partly inside window");
  return {
    calendar_id: idField(record.calendar_id, "calendar_id"),
    source: idField(record.source, "source"),
    window,
    taken_at: instantMs(record.taken_at, "taken_at"),
    blocks: blocks.toSorted((a, b) => a.start - b.start || a.end - b.end),
    ...write(record),
  };
};

const calendarIds = (raw: unknown): readonly string[] | null =>
  raw === undefined ? null : [...new Set(list(raw, "calendar_ids", 1000).map((id, index) => idField(id, `calendar_ids[${index}]`)))];

export type FreeInput = { readonly calendar_ids: readonly string[] | null; readonly range: Span; readonly min_minutes: number };

export const parseFree = (raw: unknown): FreeInput => {
  const record = object(raw, "input", ["calendar_ids", "from", "to", "min_minutes"]);
  const range = span({ from: record.from, to: record.to }, "input", "from", "to");
  if (range.end - range.start > MAX_HORIZON_MINUTES) return invalid("to", "at most three years after from");
  return { calendar_ids: calendarIds(record.calendar_ids), range, min_minutes: record.min_minutes === undefined ? 1 : integer(record.min_minutes, "min_minutes", 1, 1440) };
};

const POLICY = ["block_minutes", "min_block_minutes", "max_minutes_per_day", "hours_per_day", "default_estimate_days", "due"] as const;

export const parsePolicy = (raw: unknown): Policy => {
  const record = object(raw ?? {}, "policy", POLICY);
  const blockMinutes = record.block_minutes === undefined ? 120 : integer(record.block_minutes, "policy.block_minutes", 5, 1440);
  const minimum = record.min_block_minutes === undefined ? Math.min(15, blockMinutes) : integer(record.min_block_minutes, "policy.min_block_minutes", 1, blockMinutes);
  const cap = record.max_minutes_per_day === undefined || record.max_minutes_per_day === null ? null : integer(record.max_minutes_per_day, "policy.max_minutes_per_day", minimum, 1440);
  return {
    block_minutes: blockMinutes,
    min_block_minutes: minimum,
    max_minutes_per_day: cap,
    hours_per_day: record.hours_per_day === undefined ? 8 : number(record.hours_per_day, "policy.hours_per_day", 0.25, 24),
    default_estimate_days: record.default_estimate_days === undefined ? 1 : number(record.default_estimate_days, "policy.default_estimate_days", 0, 3660),
    due: record.due === undefined ? "soft" : oneOf(record.due, "policy.due", ["soft", "hard"]),
  };
};

const horizon = (raw: unknown): Span => {
  const range = span(raw, "horizon");
  if (range.end - range.start > MAX_HORIZON_MINUTES) return invalid("horizon.end", "at most three years after horizon.start");
  return range;
};

const snapshot = (raw: unknown): Fields => (isRecord(raw) ? raw : invalid("tasks", "a tasks-snapshot.v1 object"));

export type PlanRefInput = { readonly plan_id: string; readonly version: number | null };

const planRef = (raw: unknown, field: string): PlanRefInput => {
  const record = object(raw, field, ["plan_id", "version"]);
  return { plan_id: idField(record.plan_id, `${field}.plan_id`), version: record.version === undefined ? null : version(record.version, `${field}.version`) };
};

export type PlanInput = {
  readonly tasks: Fields;
  readonly calendar_ids: readonly string[] | null;
  readonly horizon: Span;
  readonly policy: Policy;
  readonly base_plan: PlanRefInput | null;
  readonly solution: Fields | null;
  readonly mapping: Mapping | null;
  readonly name: string | null;
};

export const parsePlanInput = (raw: unknown): PlanInput => {
  const record = object(raw, "input", ["tasks", "calendar_ids", "horizon", "policy", "base_plan", "solution", "mapping", "name"]);
  if ((record.solution === undefined) !== (record.mapping === undefined)) return invalid("solution", "given together with mapping, or both left out");
  return {
    tasks: snapshot(record.tasks),
    calendar_ids: calendarIds(record.calendar_ids),
    horizon: horizon(record.horizon),
    policy: parsePolicy(record.policy),
    base_plan: record.base_plan === undefined ? null : planRef(record.base_plan, "base_plan"),
    solution: record.solution === undefined ? null : isRecord(record.solution) ? record.solution : invalid("solution", "a constraint-solution.v1 object"),
    mapping: record.mapping === undefined ? null : parseMapping(record.mapping),
    name: record.name === undefined ? null : idField(record.name, "name"),
  };
};

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const utcMinute = (raw: unknown, field: string): number => {
  if (typeof raw !== "string" || !UTC.test(raw)) return invalid(field, "a UTC time written like 2026-01-05T17:00:00.000Z");
  const ms = instantMs(raw, field);
  return ms % 60_000 === 0 ? ms / 60_000 : invalid(field, "on a whole minute");
};

export type BlockInput = Block & { readonly startMinute: number; readonly endMinute: number };

export const parseBlocks = (raw: unknown, field: string): readonly BlockInput[] =>
  list(raw, field).map((entry, index) => {
    const where = `${field}[${index}]`;
    const block = isRecord(entry) ? entry : invalid(where, "an object");
    const [startMinute, endMinute] = [utcMinute(block.start, `${where}.start`), utcMinute(block.end, `${where}.end`)];
    return {
      task_id: text(block.task_id, `${where}.task_id`),
      calendar_id: idField(block.calendar_id, `${where}.calendar_id`),
      seq: integer(block.seq, `${where}.seq`, 0, 1_000_000),
      start: String(block.start),
      end: String(block.end),
      ...(typeof block.local_start === "string" ? { local_start: block.local_start } : {}),
      ...(typeof block.local_end === "string" ? { local_end: block.local_end } : {}),
      ...(typeof block.tz === "string" ? { tz: block.tz } : {}),
      ...(typeof block.title === "string" ? { title: block.title } : {}),
      startMinute,
      endMinute,
    };
  });

export type PlanBody = {
  readonly horizon: Span;
  readonly policy: Policy;
  readonly blocks: readonly BlockInput[];
  readonly unscheduled: readonly { readonly task_id: string; readonly code: string; readonly message: string }[];
  readonly tasks_digest: string;
  readonly busy_digest: string;
  readonly digest: string;
  readonly solver: "greedy" | "constraints";
  readonly tzdata: string;
  readonly calendar_ids: readonly string[] | null;
};

const SHA = /^[0-9a-f]{64}$/;

const sha = (raw: unknown, field: string): string => (typeof raw === "string" && SHA.test(raw) ? raw : invalid(field, "64 lowercase hex characters"));

export const parsePlanBody = (raw: unknown): PlanBody => {
  const record = isRecord(raw) ? raw : invalid("plan", "a schedule-plan.v1 object");
  const range = isRecord(record.horizon) ? record.horizon : invalid("plan.horizon", "an object");
  return {
    horizon: { start: utcMinute(range.start, "plan.horizon.start"), end: utcMinute(range.end, "plan.horizon.end") },
    policy: parsePolicy(record.policy),
    blocks: parseBlocks(record.blocks, "plan.blocks"),
    unscheduled: list(record.unscheduled ?? [], "plan.unscheduled").map((entry, index) => {
      const item = isRecord(entry) ? entry : invalid(`plan.unscheduled[${index}]`, "an object");
      return { task_id: String(item.task_id), code: String(item.code), message: String(item.message) };
    }),
    tasks_digest: sha(record.tasks_digest, "plan.tasks_digest"),
    busy_digest: sha(record.busy_digest ?? "0".repeat(64), "plan.busy_digest"),
    digest: sha(record.digest, "plan.digest"),
    solver: record.solver === "constraints" ? "constraints" : "greedy",
    tzdata: typeof record.tzdata === "string" ? record.tzdata : "",
    calendar_ids: calendarIds(record.calendar_ids),
  };
};

export type CheckInput = {
  readonly tasks: Fields;
  readonly calendar_ids: readonly string[] | null;
  readonly plan: PlanBody | null;
  readonly stored: PlanRefInput | null;
  readonly blocks: readonly BlockInput[] | null;
  readonly horizon: Span | null;
  readonly policy: Policy | null;
};

export const parseCheck = (raw: unknown): CheckInput => {
  const record = object(raw, "input", ["tasks", "calendar_ids", "plan", "plan_id", "version", "blocks", "horizon", "policy"]);
  const given = [record.plan, record.plan_id, record.blocks].filter((value) => value !== undefined).length;
  if (given !== 1) return invalid("plan", "given, or plan_id, or blocks with horizon: exactly one of the three");
  if (record.blocks !== undefined && record.horizon === undefined) return invalid("horizon", "given when blocks are passed without a plan");
  return {
    tasks: snapshot(record.tasks),
    calendar_ids: calendarIds(record.calendar_ids),
    plan: record.plan === undefined ? null : parsePlanBody(record.plan),
    stored: record.plan_id === undefined ? null : planRef({ plan_id: record.plan_id, ...(record.version === undefined ? {} : { version: record.version }) }, "input"),
    blocks: record.blocks === undefined ? null : parseBlocks(record.blocks, "blocks"),
    horizon: record.horizon === undefined ? null : horizon(record.horizon),
    policy: record.policy === undefined ? null : parsePolicy(record.policy),
  };
};

export type CommitInput = Write & {
  readonly plan_id: string;
  readonly base_version: number;
  readonly digest: string;
  readonly tasks_digest: string;
  readonly plan: PlanBody;
  readonly tasks: Fields | null;
  readonly allow_violations: boolean;
};

export const parseCommit = (raw: unknown): CommitInput => {
  const record = object(raw, "input", ["plan_id", "base_version", "digest", "tasks_digest", "plan", "tasks", "allow_violations", ...WRITE]);
  if (record.allow_violations !== undefined && typeof record.allow_violations !== "boolean") return invalid("allow_violations", "true or false");
  return {
    plan_id: idField(record.plan_id, "plan_id"),
    base_version: version(record.base_version, "base_version", 0),
    digest: sha(record.digest, "digest"),
    tasks_digest: sha(record.tasks_digest, "tasks_digest"),
    plan: parsePlanBody(record.plan),
    tasks: record.tasks === undefined ? null : snapshot(record.tasks),
    allow_violations: record.allow_violations === true,
    ...write(record),
  };
};

export type CloneInput = Write & { readonly plan_id: string; readonly version: number | null; readonly new_id: string };

export const parseClone = (raw: unknown): CloneInput => {
  const record = object(raw, "input", ["plan_id", "version", "new_id", ...WRITE]);
  const from = planRef({ plan_id: record.plan_id, ...(record.version === undefined ? {} : { version: record.version }) }, "input");
  const newId = idField(record.new_id, "new_id");
  if (newId === from.plan_id) return invalid("new_id", "different from plan_id");
  return { ...from, new_id: newId, ...write(record) };
};

export const parsePlanRef = (raw: unknown): PlanRefInput => {
  const record = object(raw, "input", ["plan_id", "version"]);
  return planRef(record, "input");
};

export type DiffInput = { readonly plan_id: string; readonly from_version: number; readonly to_version: number };

export const parseDiff = (raw: unknown): DiffInput => {
  const record = object(raw, "input", ["plan_id", "from_version", "to_version"]);
  return { plan_id: idField(record.plan_id, "plan_id"), from_version: version(record.from_version, "from_version"), to_version: version(record.to_version, "to_version") };
};

export type TaskUpdatesInput = PlanRefInput & { readonly tasks: Fields };

export const parseTaskUpdates = (raw: unknown): TaskUpdatesInput => {
  const record = object(raw, "input", ["plan_id", "version", "tasks"]);
  return { ...planRef({ plan_id: record.plan_id, ...(record.version === undefined ? {} : { version: record.version }) }, "input"), tasks: snapshot(record.tasks) };
};

export type HoldsInput = PlanRefInput & { readonly cancel_all: boolean };

export const parseHolds = (raw: unknown): HoldsInput => {
  const record = object(raw, "input", ["plan_id", "version", "cancel_all"]);
  if (record.cancel_all !== undefined && typeof record.cancel_all !== "boolean") return invalid("cancel_all", "true or false");
  return { ...planRef({ plan_id: record.plan_id, ...(record.version === undefined ? {} : { version: record.version }) }, "input"), cancel_all: record.cancel_all === true };
};

export type HoldEntry = {
  readonly idempotency_key: string;
  readonly status: HoldStatus;
  readonly provider: string;
  readonly event_id: string | null;
  readonly calendar: string | null;
  readonly note: string | null;
};
export type HoldsRecord = Write & { readonly plan_id: string; readonly records: readonly HoldEntry[] };

export const parseHoldsRecord = (raw: unknown): HoldsRecord => {
  const record = object(raw, "input", ["plan_id", "records", ...WRITE]);
  const records = list(record.records, "records", 10_000).map((entry, index) => {
    const field = `records[${index}]`;
    const item = object(entry, field, ["idempotency_key", "status", "provider", "event_id", "calendar", "note"]);
    const status = oneOf(item.status, `${field}.status`, HOLD_STATUSES);
    const eventId = optionalText(item.event_id, `${field}.event_id`);
    if (status === "created" && eventId === null) return invalid(`${field}.event_id`, "given when status is created: the identifier the calendar service returned");
    return {
      idempotency_key: text(item.idempotency_key, `${field}.idempotency_key`),
      status,
      provider: text(item.provider, `${field}.provider`),
      event_id: eventId,
      calendar: optionalText(item.calendar, `${field}.calendar`),
      note: optionalText(item.note, `${field}.note`),
    };
  });
  if (records.length === 0) return invalid("records", "a non-empty list");
  if (new Set(records.map((entry) => entry.idempotency_key)).size !== records.length) return invalid("records", "a list with each idempotency_key at most once");
  return { plan_id: idField(record.plan_id, "plan_id"), records, ...write(record) };
};

export const parsePlanId = (raw: unknown): { readonly plan_id: string } => ({ plan_id: idField(object(raw, "input", ["plan_id"]).plan_id, "plan_id") });

export const notFound = (what: string, hint: string): never => {
  throw failure("E_NOT_FOUND", what, hint);
};
