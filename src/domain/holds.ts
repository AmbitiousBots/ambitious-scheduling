import { isRecord, type JsonObject } from "@ambitious/kit/domain/json";
import type { Calendar } from "./calendar.ts";
import { compareText, type Hasher } from "./input.ts";
import type { Block } from "./plan.ts";
import { localText } from "./zone.ts";

export const HOLD_STATUSES = ["created", "canceled", "failed"] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

export type HoldRecord = {
  readonly idempotency_key: string;
  readonly status: HoldStatus;
  readonly provider: string;
  readonly event_id: string | null;
  readonly calendar: string | null;
  readonly note: string | null;
  readonly hold: JsonObject;
  readonly recorded_at: string;
};

export type PlanRef = { readonly plan_id: string; readonly version: number; readonly digest: string };

const KEY_HASH_LENGTH = 16;

export const holdKey = (planId: string, block: Block, sha256: Hasher): string =>
  `hold:${planId}:${block.task_id}:${block.seq}:${sha256(`${block.calendar_id}|${block.start}|${block.end}`).slice(0, KEY_HASH_LENGTH)}`;

const moment = (iso: string, zone: string): JsonObject => ({ utc: iso, local: localText(zone, Date.parse(iso) / 60_000), time_zone: zone });

export const holdBody = (plan: PlanRef, block: Block, calendars: ReadonlyMap<string, Calendar>, sha256: Hasher): JsonObject => {
  const calendar = calendars.get(block.calendar_id);
  const zone = calendar?.tz ?? block.tz ?? "UTC";
  return {
    idempotency_key: holdKey(plan.plan_id, block, sha256),
    title: block.title ?? block.task_id,
    description: `Planned work on task ${block.task_id}, block ${block.seq + 1}, from plan ${plan.plan_id} version ${plan.version}.`,
    start: moment(block.start, zone),
    end: moment(block.end, zone),
    calendar_hint: { calendar_id: block.calendar_id, ...(calendar === undefined ? {} : { name: calendar.name, person_ref: calendar.person_ref }) },
    source: { plan_id: plan.plan_id, version: plan.version, task_id: block.task_id, seq: block.seq },
  };
};

const external = (record: HoldRecord): JsonObject => ({
  provider: record.provider,
  event_id: record.event_id ?? "",
  ...(record.calendar === null ? {} : { calendar: record.calendar }),
});

const startOf = (hold: JsonObject): string => {
  const start: unknown = hold.start;
  return isRecord(start) && typeof start.utc === "string" ? start.utc : "";
};

export const holdsProposal = (
  plan: PlanRef,
  blocks: readonly Block[],
  records: readonly HoldRecord[],
  calendars: ReadonlyMap<string, Calendar>,
  cancelAll: boolean,
  sha256: Hasher,
): JsonObject => {
  const created = new Map(records.filter((record) => record.status === "created").map((record) => [record.idempotency_key, record]));
  const wanted = cancelAll ? [] : blocks.map((block) => holdBody(plan, block, calendars, sha256));
  const wantedKeys = new Set(wanted.map((hold) => String(hold.idempotency_key)));
  const current = wanted.map((hold): JsonObject => {
    const record = created.get(String(hold.idempotency_key));
    return record === undefined ? { action: "create", ...hold } : { action: "keep", ...hold, external: external(record) };
  });
  const cancels = [...created.values()]
    .filter((record) => !wantedKeys.has(record.idempotency_key))
    .map((record): JsonObject => ({ action: "cancel", ...record.hold, external: external(record) }));
  const holds = [...current, ...cancels].toSorted(
    (a, b) => compareText(startOf(a), startOf(b)) || compareText(String(a.idempotency_key), String(b.idempotency_key)),
  );
  return { schema: "calendar-holds.v1", plan: { plan_id: plan.plan_id, version: plan.version, digest: plan.digest }, holds };
};
