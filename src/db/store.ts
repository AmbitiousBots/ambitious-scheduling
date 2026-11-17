import { failure } from "@ambitious/kit/domain/failure";
import { isRecord, type JsonObject, type JsonValue } from "@ambitious/kit/domain/json";
import type { Db } from "@ambitious/kit/db/open-db";
import { parseExceptions, parseRules, type Calendar, type CalendarKind } from "../domain/calendar.ts";
import { checkPlan, type Violation } from "../domain/checker.ts";
import { holdBody, holdKey, holdsProposal, type HoldRecord, type HoldStatus } from "../domain/holds.ts";
import { canonical, compareText, minuteIso, toIso, type Hasher } from "../domain/input.ts";
import { clip, merge, type Span } from "../domain/intervals.ts";
import { compareBlocks, diffBlocks, planDigest, type Block, type PlanDoc, type World } from "../domain/plan.ts";
import type {
  AvailabilitySet, BusyImport, CalendarAdd, CalendarUpdate, CloneInput, CommitInput, HoldsInput, HoldsRecord, PlanBody, PlanRefInput, Write,
} from "../domain/requests.ts";
import { readSnapshot, type Policy, type Snapshot } from "../domain/tasks.ts";

type Row = Readonly<Record<string, unknown>>;

const corrupt = (): never => {
  throw failure("E_DB", "Stored scheduling data does not match the database schema.", "Run selfcheck and restore a valid database backup if needed.");
};

const str = (value: unknown): string => (typeof value === "string" ? value : corrupt());
const num = (value: unknown): number => (typeof value === "number" ? value : corrupt());
const optional = (value: unknown): string | null => (value === null || value === undefined ? null : str(value));

const parsed = (value: unknown): unknown => {
  try {
    const result: unknown = JSON.parse(str(value));
    return result;
  } catch {
    return corrupt();
  }
};

const isJson = (raw: unknown): raw is JsonValue => {
  if (raw === null || typeof raw === "string" || typeof raw === "boolean") return true;
  if (typeof raw === "number") return Number.isFinite(raw);
  if (Array.isArray(raw)) return raw.every((item: unknown) => isJson(item));
  return isRecord(raw) && Object.values(raw).every(isJson);
};

const jsonObject = (raw: unknown): JsonObject => (isRecord(raw) && isJson(raw) ? raw : corrupt());

const plain = (value: unknown): JsonObject => jsonObject(JSON.parse(JSON.stringify(value)));

const jsonList = (value: unknown): JsonValue => {
  const copy: unknown = JSON.parse(JSON.stringify(value));
  return Array.isArray(copy) && isJson(copy) ? copy : corrupt();
};

const audit = (db: Db, kind: string, subject: string, payload: unknown, now: string, write: Write): void => {
  db.prepare("INSERT INTO audit (at, actor, kind, subject, payload, idem_key) VALUES (?, ?, ?, ?, ?, ?)").run(now, write.actor, kind, subject, JSON.stringify(payload), write.idem_key);
};

const withReceipt = (db: Db, command: string, input: Write, work: () => JsonObject): JsonObject => {
  const request = canonical({ command, input });
  const existing = db.prepare("SELECT request, response FROM request_receipts WHERE idem_key = ?").get(input.idem_key);
  if (existing !== undefined) {
    if (existing.request !== request) {
      throw failure("E_IDEM_CONFLICT", "This idem_key already identifies a different request.", "Retry the original request unchanged, or use a new idem_key for the new request.");
    }
    return jsonObject(parsed(existing.response));
  }
  const response = work();
  db.prepare("INSERT INTO request_receipts (idem_key, request, response) VALUES (?, ?, ?)").run(input.idem_key, request, JSON.stringify(response));
  return response;
};

const calendarOf = (row: Row): Calendar => {
  const kind = str(row.kind);
  if (kind !== "person" && kind !== "resource" && kind !== "team") return corrupt();
  const checkedKind: CalendarKind = kind;
  try {
    return {
      id: str(row.id),
      version: num(row.version),
      name: str(row.name),
      tz: str(row.tz),
      kind: checkedKind,
      person_ref: optional(row.person_ref),
      rules: parseRules(parsed(row.rules)),
      exceptions: parseExceptions(parsed(row.exceptions)),
    };
  } catch {
    return corrupt();
  }
};

export const calendarView = (calendar: Calendar): JsonObject => plain(calendar);

export const listCalendars = (db: Db): readonly Calendar[] => db.prepare("SELECT * FROM calendars ORDER BY id").all().map(calendarOf);

const findCalendar = (db: Db, id: string): Calendar | undefined => {
  const row = db.prepare("SELECT * FROM calendars WHERE id = ?").get(id);
  return row === undefined ? undefined : calendarOf(row);
};

export const getCalendar = (db: Db, id: string): Calendar =>
  findCalendar(db, id) ?? (() => {
    throw failure("E_NOT_FOUND", `Calendar ${id} does not exist.`, "Use calendar list to find a calendar id, or add the calendar first.");
  })();

const stale = (what: string, expected: number, current: number): never => {
  throw failure(
    "E_STALE",
    `${what} is at version ${current}, not ${expected}.`,
    "Read it again, apply the change to what is there now, and send the request with the current version and a new idem_key.",
    { current_version: current, expected_version: expected },
  );
};

export const addCalendar = (db: Db, input: CalendarAdd, now: string): JsonObject =>
  withReceipt(db, "calendar add", input, () => {
    if (findCalendar(db, input.id) !== undefined) {
      throw failure("E_DUPLICATE", `Calendar ${input.id} already exists.`, "Use calendar update for an existing calendar, or choose a new id.");
    }
    db.prepare("INSERT INTO calendars (id, version, name, tz, kind, person_ref, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.name, input.tz, input.kind, input.person_ref, now, now);
    const calendar = getCalendar(db, input.id);
    audit(db, "calendar_added", input.id, calendar, now, input);
    return { calendar: calendarView(calendar) };
  });

const saveCalendar = (db: Db, kind: string, before: Calendar, after: Omit<Calendar, "version">, now: string, write: Write): JsonObject => {
  db.prepare("UPDATE calendars SET version = ?, name = ?, tz = ?, kind = ?, person_ref = ?, rules = ?, exceptions = ?, updated_at = ? WHERE id = ? AND version = ?")
    .run(before.version + 1, after.name, after.tz, after.kind, after.person_ref, JSON.stringify(after.rules), JSON.stringify(after.exceptions), now, before.id, before.version);
  const calendar = getCalendar(db, before.id);
  audit(db, kind, before.id, calendar, now, write);
  return { calendar: calendarView(calendar) };
};

export const updateCalendar = (db: Db, input: CalendarUpdate, now: string): JsonObject =>
  withReceipt(db, "calendar update", input, () => {
    const before = getCalendar(db, input.id);
    if (before.version !== input.expected_version) stale(`Calendar ${input.id}`, input.expected_version, before.version);
    return saveCalendar(db, "calendar_updated", before, { ...before, ...input.patch }, now, input);
  });

export const setAvailability = (db: Db, input: AvailabilitySet, now: string): JsonObject =>
  withReceipt(db, "availability set", input, () => {
    const before = getCalendar(db, input.calendar_id);
    if (before.version !== input.expected_version) stale(`Calendar ${input.calendar_id}`, input.expected_version, before.version);
    return saveCalendar(db, "availability_set", before, { ...before, rules: input.rules, exceptions: input.exceptions }, now, input);
  });

export const importBusy = (db: Db, input: BusyImport, now: string, sha256: Hasher): JsonObject =>
  withReceipt(db, "busy import", input, () => {
    getCalendar(db, input.calendar_id);
    const digest = sha256(canonical(input.blocks.map((block) => [block.start, block.end, block.label])));
    const existing = db
      .prepare("SELECT id, digest FROM busy_snapshots WHERE calendar_id = ? AND source = ? AND window_start = ? AND window_end = ?")
      .get(input.calendar_id, input.source, input.window.start, input.window.end);
    const summary = {
      calendar_id: input.calendar_id,
      source: input.source,
      window: { start: minuteIso(input.window.start), end: minuteIso(input.window.end) },
      taken_at: toIso(input.taken_at),
      blocks: input.blocks.length,
      digest,
    };
    if (existing !== undefined && existing.digest === digest) return { snapshot: summary, action: "unchanged" };
    if (existing !== undefined) db.prepare("DELETE FROM busy_snapshots WHERE id = ?").run(num(existing.id));
    const id = db
      .prepare("INSERT INTO busy_snapshots (calendar_id, source, window_start, window_end, taken_at, digest) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.calendar_id, input.source, input.window.start, input.window.end, toIso(input.taken_at), digest).lastInsertRowid;
    const insert = db.prepare("INSERT INTO busy_blocks (snapshot_id, start_minute, end_minute, label) VALUES (?, ?, ?, ?)");
    for (const block of input.blocks) insert.run(id, block.start, block.end, block.label);
    audit(db, "busy_imported", input.calendar_id, summary, now, input);
    return { snapshot: summary, action: existing === undefined ? "imported" : "replaced" };
  });

export const busySnapshots = (db: Db, calendarId: string): readonly JsonObject[] =>
  db
    .prepare(
      "SELECT s.source, s.window_start, s.window_end, s.taken_at, s.digest, (SELECT COUNT(*) FROM busy_blocks b WHERE b.snapshot_id = s.id) AS blocks FROM busy_snapshots s WHERE s.calendar_id = ? ORDER BY s.source, s.window_start, s.window_end",
    )
    .all(calendarId)
    .map((row) => ({
      source: str(row.source),
      window: { start: minuteIso(num(row.window_start)), end: minuteIso(num(row.window_end)) },
      taken_at: str(row.taken_at),
      blocks: num(row.blocks),
      digest: str(row.digest),
    }));

export const busySpans = (db: Db, calendarId: string, range: Span): readonly Span[] =>
  clip(
    merge(
      db
        .prepare(
          "SELECT b.start_minute, b.end_minute FROM busy_blocks b JOIN busy_snapshots s ON s.id = b.snapshot_id WHERE s.calendar_id = ? AND b.end_minute > ? AND b.start_minute < ? ORDER BY b.start_minute, b.end_minute",
        )
        .all(calendarId, range.start, range.end)
        .map((row) => ({ start: num(row.start_minute), end: num(row.end_minute) })),
    ),
    range,
  );

export const chosenCalendars = (db: Db, ids: readonly string[] | null): readonly Calendar[] =>
  ids === null ? listCalendars(db) : ids.toSorted(compareText).map((id) => getCalendar(db, id));

export type WorldRequest = {
  readonly tasks: Readonly<Record<string, unknown>>;
  readonly calendar_ids: readonly string[] | null;
  readonly horizon: Span;
  readonly policy: Policy;
};

export type Runtime = { readonly now: number; readonly sha256: Hasher; readonly tzdata: string };

export const loadWorld = (db: Db, request: WorldRequest, runtime: Runtime): World => {
  const calendars = chosenCalendars(db, request.calendar_ids);
  const busy = new Map(calendars.map((calendar) => [calendar.id, busySpans(db, calendar.id, request.horizon)]));
  const busyDigest = runtime.sha256(
    canonical({
      calendars: calendars.map(({ id, tz, person_ref, rules, exceptions }) => ({ id, tz, person_ref, rules, exceptions })),
      busy: calendars.map((calendar) => [calendar.id, (busy.get(calendar.id) ?? []).map((span) => [span.start, span.end])]),
    }),
  );
  return {
    calendars,
    busy,
    horizon: request.horizon,
    now: runtime.now,
    policy: request.policy,
    snapshot: readSnapshot(request.tasks, runtime.sha256),
    busyDigest,
    tzdata: runtime.tzdata,
    calendarIds: request.calendar_ids,
  };
};

type StoredVersion = { readonly doc: PlanDoc; readonly committed_at: string; readonly actor: string };

const planMissing = (planId: string): never => {
  throw failure("E_NOT_FOUND", `Plan ${planId} does not exist.`, "Use plan list to find a plan id, or commit a proposed plan first.");
};

const currentVersion = (db: Db, planId: string): number => {
  const row = db.prepare("SELECT version FROM plans WHERE id = ?").get(planId);
  return row === undefined ? 0 : num(row.version);
};

const isPlanDoc = (value: unknown): value is StoredVersion["doc"] =>
  isRecord(value) && value.schema === "schedule-plan.v1" && Array.isArray(value.blocks) && typeof value.digest === "string" && isRecord(value.horizon) && isRecord(value.policy);

export const storedVersion = (db: Db, ref: PlanRefInput): StoredVersion => {
  const current = currentVersion(db, ref.plan_id);
  if (current === 0) planMissing(ref.plan_id);
  const version = ref.version ?? current;
  const row = db.prepare("SELECT doc, committed_at, actor FROM plan_versions WHERE plan_id = ? AND version = ?").get(ref.plan_id, version);
  if (row === undefined) {
    throw failure("E_NOT_FOUND", `Plan ${ref.plan_id} has no version ${version}; its current version is ${current}.`, "Use plan history to list the versions of this plan.");
  }
  const doc = parsed(row.doc);
  return isPlanDoc(doc) ? { doc, committed_at: str(row.committed_at), actor: str(row.actor) } : corrupt();
};

export const planView = (stored: StoredVersion): JsonObject => ({ plan: plain(stored.doc), committed_at: stored.committed_at, actor: stored.actor });

export const listPlans = (db: Db): readonly JsonObject[] =>
  db
    .prepare("SELECT id, version, forked_from_plan, forked_from_version, created_at, updated_at FROM plans ORDER BY id")
    .all()
    .map((row) => ({
      plan_id: str(row.id),
      version: num(row.version),
      forked_from: row.forked_from_plan === null ? null : { plan_id: str(row.forked_from_plan), version: num(row.forked_from_version) },
      created_at: str(row.created_at),
      updated_at: str(row.updated_at),
    }));

export const planHistory = (db: Db, planId: string): JsonObject => {
  if (currentVersion(db, planId) === 0) planMissing(planId);
  const versions = db
    .prepare("SELECT version, digest, tasks_digest, committed_at, actor, json_array_length(doc, '$.blocks') AS blocks FROM plan_versions WHERE plan_id = ? ORDER BY version")
    .all(planId)
    .map((row) => ({ version: num(row.version), digest: str(row.digest), tasks_digest: str(row.tasks_digest), committed_at: str(row.committed_at), actor: str(row.actor), blocks: num(row.blocks) }));
  const events = db
    .prepare("SELECT seq, at, actor, kind, idem_key FROM audit WHERE subject = ? AND kind IN ('plan_committed', 'plan_cloned', 'holds_recorded') ORDER BY seq")
    .all(planId)
    .map((row) => ({ seq: num(row.seq), at: str(row.at), actor: str(row.actor), kind: str(row.kind), idem_key: optional(row.idem_key) }));
  const plan = listPlans(db).find((entry) => entry.plan_id === planId) ?? null;
  return { plan, versions, events };
};

const bodyDigest = (plan: PlanBody, sha256: Hasher): string =>
  planDigest(
    {
      horizon: { start: minuteIso(plan.horizon.start), end: minuteIso(plan.horizon.end) },
      policy: plan.policy,
      tasks_digest: plan.tasks_digest,
      busy_digest: plan.busy_digest,
      blocks: plan.blocks,
    },
    sha256,
  );

const refuse = (code: `E_${string}`, message: string, hint: string, data: JsonObject = {}): never => {
  throw failure(code, message, hint, data);
};

const blockDocs = (plan: PlanBody): readonly Block[] => plan.blocks.map(({ startMinute: _start, endMinute: _end, ...block }) => block).toSorted(compareBlocks);

const insertVersion = (db: Db, doc: StoredVersion["doc"], now: string, actor: string): void => {
  db.prepare("INSERT INTO plan_versions (plan_id, version, digest, tasks_digest, doc, committed_at, actor) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(doc.plan_id ?? "", doc.version ?? 0, doc.digest, doc.tasks_digest, JSON.stringify(doc), now, actor);
};

export const errorsOf = (violations: readonly Violation[]): readonly Violation[] => violations.filter((violation) => violation.severity === "error");

export const commitPlan = (db: Db, input: CommitInput, now: string, runtime: Runtime): JsonObject =>
  withReceipt(db, "plan commit", input, () => {
    const calendarIds = input.plan.calendar_ids;
    const computed = bodyDigest(input.plan, runtime.sha256);
    if (computed !== input.digest || input.plan.digest !== input.digest) {
      refuse("E_DIGEST", "The plan's blocks do not match the digest that was passed.", "Commit the plan exactly as plan propose returned it, with its digest. To change a block, propose again.", { computed_digest: computed });
    }
    if (input.tasks_digest !== input.plan.tasks_digest) {
      refuse("E_TASKS_CHANGED", "The tasks_digest passed is not the one this plan was proposed for.", "Read the tasks again and propose a new plan from the current snapshot.", { plan_tasks_digest: input.plan.tasks_digest });
    }
    const snapshot: Snapshot | null = input.tasks === null ? null : readSnapshot(input.tasks, runtime.sha256);
    if (snapshot !== null && snapshot.digest !== input.plan.tasks_digest) {
      refuse("E_TASKS_CHANGED", "A task changed after this plan was proposed.", "Propose a new plan from the current tasks snapshot and ask for approval again.", { current_tasks_digest: snapshot.digest, plan_tasks_digest: input.plan.tasks_digest });
    }
    const current = currentVersion(db, input.plan_id);
    if (current !== input.base_version) stale(`Plan ${input.plan_id}`, input.base_version, current);
    const world = loadWorld(db, { tasks: input.tasks ?? { tasks: [] }, calendar_ids: calendarIds, horizon: input.plan.horizon, policy: input.plan.policy }, runtime);
    if (world.busyDigest !== input.plan.busy_digest) {
      refuse("E_CALENDAR_CHANGED", "A calendar's working hours or busy time changed after this plan was proposed.", "Propose a new plan and ask for approval again.", { current_busy_digest: world.busyDigest, plan_busy_digest: input.plan.busy_digest });
    }
    const violations =
      snapshot === null
        ? []
        : checkPlan(world, input.plan.blocks.map((block) => ({ task_id: block.task_id, calendar_id: block.calendar_id, seq: block.seq, start: block.startMinute, end: block.endMinute })), {
            listed: new Set(input.plan.unscheduled.map((entry) => entry.task_id)),
            allowPast: true,
          });
    if (errorsOf(violations).length > 0 && !input.allow_violations) {
      refuse("E_VIOLATIONS", `The plan has ${errorsOf(violations).length} violation(s) that make it unusable.`, "Read data.violations, propose a plan without them, or pass allow_violations: true after the person accepted them.", { violations: jsonList(violations) });
    }
    const version = current + 1;
    const forked = db.prepare("SELECT forked_from_plan, forked_from_version FROM plans WHERE id = ?").get(input.plan_id);
    const doc: StoredVersion["doc"] = {
      schema: "schedule-plan.v1",
      plan_id: input.plan_id,
      version,
      forked_from: forked === undefined || forked.forked_from_plan === null ? null : { plan_id: str(forked.forked_from_plan), version: num(forked.forked_from_version) },
      status: "committed",
      horizon: { start: minuteIso(input.plan.horizon.start), end: minuteIso(input.plan.horizon.end) },
      policy: input.plan.policy,
      tasks_digest: input.plan.tasks_digest,
      busy_digest: input.plan.busy_digest,
      tzdata: input.plan.tzdata,
      solver: input.plan.solver,
      blocks: blockDocs(input.plan),
      unscheduled: input.plan.unscheduled,
      digest: input.digest,
      ...(calendarIds === null ? {} : { calendar_ids: calendarIds }),
    };
    if (current === 0) db.prepare("INSERT INTO plans (id, version, created_at, updated_at) VALUES (?, 1, ?, ?)").run(input.plan_id, now, now);
    else db.prepare("UPDATE plans SET version = ?, updated_at = ? WHERE id = ? AND version = ?").run(version, now, input.plan_id, current);
    insertVersion(db, doc, now, input.actor);
    audit(db, "plan_committed", input.plan_id, { version, digest: input.digest, tasks_digest: input.plan.tasks_digest, base_version: input.base_version }, now, input);
    return { plan_id: input.plan_id, version, digest: input.digest, tasks_digest: input.plan.tasks_digest, blocks: doc.blocks.length, violations: jsonList(violations) };
  });

export const clonePlan = (db: Db, input: CloneInput, now: string): JsonObject =>
  withReceipt(db, "plan clone", input, () => {
    const source = storedVersion(db, input);
    if (currentVersion(db, input.new_id) !== 0) refuse("E_DUPLICATE", `Plan ${input.new_id} already exists.`, "Choose a new_id that is not in use.");
    const forkedFrom = { plan_id: input.plan_id, version: source.doc.version ?? 0 };
    const doc: StoredVersion["doc"] = { ...source.doc, plan_id: input.new_id, version: 1, forked_from: forkedFrom };
    db.prepare("INSERT INTO plans (id, version, forked_from_plan, forked_from_version, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?)")
      .run(input.new_id, forkedFrom.plan_id, forkedFrom.version, now, now);
    insertVersion(db, doc, now, input.actor);
    audit(db, "plan_cloned", input.new_id, { forked_from: forkedFrom, digest: doc.digest }, now, input);
    return { plan_id: input.new_id, version: 1, forked_from: forkedFrom, digest: doc.digest, blocks: doc.blocks.length };
  });

export const diffPlan = (db: Db, planId: string, fromVersion: number, toVersion: number): JsonObject => {
  const from = storedVersion(db, { plan_id: planId, version: fromVersion });
  const to = storedVersion(db, { plan_id: planId, version: toVersion });
  return { plan_id: planId, from_version: fromVersion, to_version: toVersion, ...plain(diffBlocks(from.doc.blocks, to.doc.blocks)) };
};

const holdRecords = (db: Db, planId: string): readonly HoldRecord[] =>
  db
    .prepare("SELECT * FROM holds WHERE plan_id = ? ORDER BY idempotency_key")
    .all(planId)
    .map((row) => {
      const status = str(row.status);
      if (status !== "created" && status !== "canceled" && status !== "failed") return corrupt();
      const checked: HoldStatus = status;
      return {
        idempotency_key: str(row.idempotency_key),
        status: checked,
        provider: str(row.provider),
        event_id: optional(row.event_id),
        calendar: optional(row.calendar),
        note: optional(row.note),
        hold: jsonObject(parsed(row.hold)),
        recorded_at: str(row.recorded_at),
      };
    });

const calendarMap = (db: Db): ReadonlyMap<string, Calendar> => new Map(listCalendars(db).map((calendar) => [calendar.id, calendar]));

export const proposeHolds = (db: Db, input: HoldsInput, sha256: Hasher): JsonObject => {
  const stored = storedVersion(db, input);
  const ref = { plan_id: input.plan_id, version: stored.doc.version ?? 0, digest: stored.doc.digest };
  const holds = holdsProposal(ref, stored.doc.blocks, holdRecords(db, input.plan_id), calendarMap(db), input.cancel_all, sha256);
  const list = Array.isArray(holds.holds) ? holds.holds : [];
  const count = (action: string): number => list.filter((hold) => isRecord(hold) && hold.action === action).length;
  return { holds, summary: { create: count("create"), keep: count("keep"), cancel: count("cancel") } };
};

export const listHolds = (db: Db, planId: string): JsonObject => {
  if (currentVersion(db, planId) === 0) planMissing(planId);
  return { plan_id: planId, records: jsonList(holdRecords(db, planId)) };
};

export const recordHolds = (db: Db, input: HoldsRecord, now: string, sha256: Hasher): JsonObject =>
  withReceipt(db, "holds record", input, () => {
    const current = currentVersion(db, input.plan_id);
    if (current === 0) planMissing(input.plan_id);
    const calendars = calendarMap(db);
    const bodies = new Map<string, JsonObject>();
    for (let version = 1; version <= current; version += 1) {
      const { doc } = storedVersion(db, { plan_id: input.plan_id, version });
      for (const block of doc.blocks) {
        bodies.set(holdKey(input.plan_id, block, sha256), holdBody({ plan_id: input.plan_id, version, digest: doc.digest }, block, calendars, sha256));
      }
    }
    const existing = new Map(holdRecords(db, input.plan_id).map((record) => [record.idempotency_key, record]));
    const upsert = db.prepare(
      "INSERT INTO holds (plan_id, idempotency_key, status, provider, event_id, calendar, note, hold, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(plan_id, idempotency_key) DO UPDATE SET status = excluded.status, provider = excluded.provider, event_id = excluded.event_id, calendar = excluded.calendar, note = excluded.note, recorded_at = excluded.recorded_at",
    );
    for (const entry of input.records) {
      const body = bodies.get(entry.idempotency_key);
      const before = existing.get(entry.idempotency_key);
      if (body === undefined) {
        refuse("E_UNKNOWN_HOLD", `No version of plan ${input.plan_id} has a hold with the key ${entry.idempotency_key}.`, "Record only keys that plan holds returned for this plan.");
        continue;
      }
      if (entry.status === "created" && before?.status === "created" && before.event_id !== entry.event_id) {
        refuse("E_HOLD_STATE", `The hold ${entry.idempotency_key} is already recorded as created with event ${before.event_id ?? ""}.`, "Keep the first event and delete the duplicate in the calendar, or record the first one as canceled before recording a new one.");
      }
      if (entry.status === "canceled" && before === undefined) {
        refuse("E_HOLD_STATE", `The hold ${entry.idempotency_key} was never recorded as created, so it cannot be recorded as canceled.`, "Record a hold as created when the calendar event is made, and as canceled only after that event is removed.");
      }
      const eventId = entry.event_id ?? (entry.status === "canceled" ? (before?.event_id ?? null) : null);
      upsert.run(input.plan_id, entry.idempotency_key, entry.status, entry.provider, eventId, entry.calendar ?? before?.calendar ?? null, entry.note, JSON.stringify(body), now);
    }
    audit(db, "holds_recorded", input.plan_id, { records: input.records }, now, input);
    const after = holdRecords(db, input.plan_id);
    const count = (status: HoldStatus): number => after.filter((record) => record.status === status).length;
    return { plan_id: input.plan_id, recorded: input.records.length, totals: { created: count("created"), canceled: count("canceled"), failed: count("failed") } };
  });

export const withReadSnapshot = <T>(db: Db, read: () => T): T => {
  if (db.isTransaction) return read();
  db.exec("BEGIN");
  try {
    const result = read();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
};
