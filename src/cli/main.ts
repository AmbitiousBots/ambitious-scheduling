import { createHash } from "node:crypto";
import { readCommand, writeCommand, type DbContext } from "@ambitious/kit/cli/command";
import { embedded } from "@ambitious/kit/cli/embedded";
import { isRecord, type JsonObject, type JsonValue } from "@ambitious/kit/domain/json";
import {
  addCalendar, busySnapshots, busySpans, calendarView, chosenCalendars, clonePlan, commitPlan, diffPlan, getCalendar, importBusy, listCalendars,
  listHolds, listPlans, loadWorld, planHistory, planView, proposeHolds, recordHolds, setAvailability, storedVersion, updateCalendar, withReadSnapshot,
  type Runtime,
} from "../db/store.ts";
import { workingWindows } from "../domain/calendar.ts";
import { checkPlan } from "../domain/checker.ts";
import { greedySchedule } from "../domain/greedy.ts";
import { ceilMinute, minuteIso } from "../domain/input.ts";
import { subtract } from "../domain/intervals.ts";
import { placedFromSolution, planModel } from "../domain/model.ts";
import { diffBlocks, dstNotes, proposedPlan, type Placed } from "../domain/plan.ts";
import {
  parseAvailabilitySet, parseBusyImport, parseCalendarAdd, parseCalendarUpdate, parseCheck, parseClone, parseCommit, parseDiff, parseFree, parseHolds,
  parseHoldsRecord, parseId, parsePlanId, parsePlanInput, parsePlanRef, parseTaskUpdates, type BlockInput, type CheckInput, type CommitInput, type PlanInput, type TaskUpdatesInput,
} from "../domain/requests.ts";
import { readSnapshot } from "../domain/tasks.ts";
import { taskUpdates } from "../domain/updates.ts";
import { localText } from "../domain/zone.ts";
import { checkedOutput, refuseInput } from "./schemas.ts";
import { runModule } from "./shell.ts";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const tzdata = process.versions.tz ?? "unknown";

const runtimeOf = (context: DbContext<unknown>): Runtime => ({ now: ceilMinute(context.clock.now().getTime()), sha256, tzdata });

const json = (value: unknown): JsonValue => {
  const copy: JsonValue = JSON.parse(JSON.stringify(value));
  return copy;
};

const read = <Input>(spec: { readonly input: (raw: unknown) => Input; readonly run: (context: DbContext<Input>) => JsonObject }) =>
  readCommand({ input: spec.input, run: (context) => withReadSnapshot(context.db, () => spec.run(context)) });

const field = (raw: unknown, name: string): unknown => (isRecord(raw) ? raw[name] : undefined);

const withSnapshot = <Input>(parse: (raw: unknown) => Input) => (raw: unknown): Input => {
  const input = parse(raw);
  if (field(raw, "tasks") !== undefined) refuseInput("tasks-snapshot.v1", "tasks", field(raw, "tasks"));
  if (field(raw, "solution") !== undefined) refuseInput("constraint-solution.v1", "solution", field(raw, "solution"));
  if (field(raw, "plan") !== undefined) refuseInput("schedule-plan.v1", "plan", field(raw, "plan"));
  return input;
};

const placedOf = (blocks: readonly BlockInput[]): readonly Placed[] =>
  blocks.map((block) => ({ task_id: block.task_id, calendar_id: block.calendar_id, seq: block.seq, start: block.startMinute, end: block.endMinute }));

const propose = (context: DbContext<PlanInput>): JsonObject => {
  const { db, input } = context;
  const world = loadWorld(db, input, runtimeOf(context));
  const greedy = greedySchedule(world);
  const fromSolution = input.solution !== null && input.mapping !== null ? placedFromSolution(input.solution, input.mapping) : null;
  const placed = fromSolution ?? greedy.placed;
  const scheduled = new Set(placed.map((block) => block.task_id));
  const unscheduled = greedy.unscheduled.filter((entry) => !scheduled.has(entry.task_id));
  const plan = checkedOutput("schedule-plan.v1", proposedPlan(world, placed, unscheduled, fromSolution === null ? "greedy" : "constraints", sha256));
  const violations = checkPlan(world, placed, { listed: new Set(unscheduled.map((entry) => entry.task_id)), allowPast: false });
  const base = input.base_plan === null ? null : storedVersion(db, input.base_plan).doc;
  return {
    plan: json(plan),
    violations: json(violations),
    unscheduled: json(plan.unscheduled),
    notes: json(dstNotes(greedy.notes)),
    ...(base === null ? {} : { diff: json({ base_plan: { plan_id: base.plan_id, version: base.version }, ...diffBlocks(base.blocks, plan.blocks) }) }),
    tzdata,
  };
};

const model = (context: DbContext<PlanInput>): JsonObject => {
  const { db, input } = context;
  const world = loadWorld(db, input, runtimeOf(context));
  const greedy = greedySchedule(world);
  const built = planModel(world, greedy, input.name ?? "schedule-plan");
  return {
    model: checkedOutput("constraint-model.v1", built.model),
    mapping: json(built.mapping),
    unscheduled: json(greedy.unscheduled),
    tasks_digest: world.snapshot.digest,
    busy_digest: world.busyDigest,
    tzdata,
  };
};

const check = (context: DbContext<CheckInput>): JsonObject => {
  const { db, input } = context;
  const stored = input.stored === null ? null : storedVersion(db, input.stored).doc;
  const body = input.plan;
  const horizon =
    body?.horizon ?? input.horizon ?? (stored === null ? null : { start: Date.parse(stored.horizon.start) / 60_000, end: Date.parse(stored.horizon.end) / 60_000 });
  const policy = body?.policy ?? input.policy ?? stored?.policy;
  if (horizon === null || policy === undefined) throw new Error("The parser lets through only inputs that carry a horizon and a policy.");
  const calendarIds = input.calendar_ids ?? body?.calendar_ids ?? stored?.calendar_ids ?? null;
  const world = loadWorld(db, { tasks: input.tasks, calendar_ids: calendarIds, horizon, policy }, runtimeOf(context));
  const blocks =
    body?.blocks ??
    input.blocks ??
    (stored?.blocks ?? []).map((block) => ({ ...block, startMinute: Date.parse(block.start) / 60_000, endMinute: Date.parse(block.end) / 60_000 }));
  const listed = new Set((body?.unscheduled ?? stored?.unscheduled ?? []).map((entry) => entry.task_id));
  const violations = checkPlan(world, placedOf(blocks), { listed, allowPast: false });
  const planTasksDigest = body?.tasks_digest ?? stored?.tasks_digest ?? null;
  const planBusyDigest = body?.busy_digest ?? stored?.busy_digest ?? null;
  return {
    violations: json(violations),
    errors: violations.filter((violation) => violation.severity === "error").length,
    warnings: violations.filter((violation) => violation.severity === "warning").length,
    blocks: blocks.length,
    tasks_digest: world.snapshot.digest,
    busy_digest: world.busyDigest,
    tasks_changed: planTasksDigest === null ? null : planTasksDigest !== world.snapshot.digest,
    calendars_changed: planBusyDigest === null ? null : planBusyDigest !== world.busyDigest,
    tzdata,
  };
};

await runModule(
  {
    ...embedded(),
    schemaVersion: 1,
    commands: {
      "calendar add": writeCommand({ input: parseCalendarAdd, run: ({ db, input, clock }) => addCalendar(db, input, clock.now().toISOString()) }),
      "calendar update": writeCommand({ input: parseCalendarUpdate, run: ({ db, input, clock }) => updateCalendar(db, input, clock.now().toISOString()) }),
      "calendar get": read({ input: parseId, run: ({ db, input }) => ({ calendar: calendarView(getCalendar(db, input.id)), busy: json(busySnapshots(db, input.id)) }) }),
      "calendar list": readCommand({ run: ({ db }) => withReadSnapshot(db, () => ({ calendars: json(listCalendars(db)) })) }),
      "availability set": writeCommand({ input: parseAvailabilitySet, run: ({ db, input, clock }) => setAvailability(db, input, clock.now().toISOString()) }),
      "busy import": writeCommand({ input: parseBusyImport, run: ({ db, input, clock }) => importBusy(db, input, clock.now().toISOString(), sha256) }),
      free: read({
        input: parseFree,
        run: ({ db, input }) => {
          const calendars = chosenCalendars(db, input.calendar_ids).map((calendar) => {
            const windows = workingWindows(calendar, input.range);
            const free = subtract(windows.spans, busySpans(db, calendar.id, input.range)).filter((span) => span.end - span.start >= input.min_minutes);
            return {
              calendar_id: calendar.id,
              tz: calendar.tz,
              free: free.map((span) => ({
                start: minuteIso(span.start),
                end: minuteIso(span.end),
                local_start: localText(calendar.tz, span.start),
                local_end: localText(calendar.tz, span.end),
                minutes: span.end - span.start,
              })),
              free_minutes: free.reduce((sum, span) => sum + (span.end - span.start), 0),
              notes: dstNotes(windows.notes),
            };
          });
          return { calendars: json(calendars), tzdata };
        },
      }),
      "plan propose": read({ input: withSnapshot(parsePlanInput), run: propose }),
      "plan model": read({ input: withSnapshot(parsePlanInput), run: model }),
      "plan check": read({ input: withSnapshot(parseCheck), run: check }),
      "plan commit": writeCommand({ input: withSnapshot<CommitInput>(parseCommit), run: (context) => commitPlan(context.db, context.input, context.clock.now().toISOString(), runtimeOf(context)) }),
      "plan clone": writeCommand({ input: parseClone, run: ({ db, input, clock }) => clonePlan(db, input, clock.now().toISOString()) }),
      "plan get": read({ input: parsePlanRef, run: ({ db, input }) => planView(storedVersion(db, input)) }),
      "plan list": readCommand({ run: ({ db }) => withReadSnapshot(db, () => ({ plans: json(listPlans(db)) })) }),
      "plan history": read({ input: parsePlanId, run: ({ db, input }) => planHistory(db, input.plan_id) }),
      "plan diff": read({ input: parseDiff, run: ({ db, input }) => diffPlan(db, input.plan_id, input.from_version, input.to_version) }),
      "plan task-updates": read({
        input: withSnapshot<TaskUpdatesInput>(parseTaskUpdates),
        run: ({ db, input }) => {
          const { doc } = storedVersion(db, input);
          const calendars = new Map(listCalendars(db).map((calendar) => [calendar.id, calendar]));
          return { plan_id: input.plan_id, version: doc.version ?? 0, ...taskUpdates(input.plan_id, doc.version ?? 0, doc.blocks, readSnapshot(input.tasks, sha256), calendars) };
        },
      }),
      "plan holds": read({
        input: parseHolds,
        run: ({ db, input }) => {
          const proposal = proposeHolds(db, input, sha256);
          checkedOutput("calendar-holds.v1", proposal.holds);
          return proposal;
        },
      }),
      "holds record": writeCommand({ input: parseHoldsRecord, run: ({ db, input, clock }) => recordHolds(db, input, clock.now().toISOString(), sha256) }),
      "holds list": read({ input: parsePlanId, run: ({ db, input }) => listHolds(db, input.plan_id) }),
    },
  },
  new Set<string>(),
);
