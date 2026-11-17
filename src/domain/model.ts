import { failure } from "@ambitious/kit/domain/failure";
import { isRecord, type JsonObject, type JsonValue } from "@ambitious/kit/domain/json";
import { dueMinute, workingWindows } from "./calendar.ts";
import type { Greedy } from "./greedy.ts";
import { compareText, integer, list, minuteIso, object, text } from "./input.ts";
import { subtract } from "./intervals.ts";
import type { Placed, World } from "./plan.ts";

export type MappedBlock = {
  readonly task_id: string;
  readonly calendar_id: string;
  readonly seq: number;
  readonly start_var: string;
  readonly end_var: string;
  readonly minutes: number;
};

export type Mapping = { readonly unit: "minute"; readonly origin: string; readonly blocks: readonly MappedBlock[] };

export const DUE_WEIGHT = 1440;

const unsupported = (message: string, hint: string): never => {
  throw failure("E_UNSUPPORTED", message, hint);
};

export const planModel = (world: World, greedy: Greedy, name: string): { readonly model: JsonObject; readonly mapping: Mapping } => {
  if (world.policy.max_minutes_per_day !== null) {
    unsupported("A constraint model with max_minutes_per_day is not available in this version.", "Leave max_minutes_per_day out of the policy for plan model, or use plan propose, which honors it.");
  }
  const origin = world.horizon.start;
  const length = world.horizon.end - origin;
  const bounds = { start: Math.max(world.horizon.start, world.now), end: world.horizon.end };
  const free = new Map(
    world.calendars.map((calendar) => [calendar.id, subtract(workingWindows(calendar, bounds).spans, world.busy.get(calendar.id) ?? [])]),
  );
  const tasks = new Map(world.snapshot.tasks.map((task) => [task.id, task]));
  const zones = new Map(world.calendars.map((calendar) => [calendar.id, calendar.tz]));
  const ordered = greedy.placed.toSorted((a, b) => compareText(a.task_id, b.task_id) || a.seq - b.seq);
  const index = new Map(ordered.map((block, position) => [`${block.task_id}\u0000${block.seq}`, position]));
  const chunk = (taskId: string, seq: number): number | undefined => index.get(`${taskId}\u0000${seq}`);
  const lastSeq = new Map<string, number>();
  for (const block of ordered) lastSeq.set(block.task_id, Math.max(lastSeq.get(block.task_id) ?? 0, block.seq));
  const variables: JsonValue[] = [];
  const constraints: JsonValue[] = [];
  const evidence: JsonValue[] = [];
  const hints: Record<string, number> = {};
  const blocks: MappedBlock[] = [];
  ordered.forEach((block, position) => {
    const size = block.end - block.start;
    const ranges = (free.get(block.calendar_id) ?? [])
      .filter((span) => span.end - span.start >= size)
      .map((span) => [span.start - origin, span.end - size - origin] as const);
    const [start, end] = [`b${position}_s`, `b${position}_e`];
    const title = tasks.get(block.task_id)?.title ?? block.task_id;
    variables.push(
      { name: start, type: "int", domain: { ranges }, description: `Start of block ${block.seq} of "${title}", in minutes after ${minuteIso(origin)}` },
      { name: end, type: "int", domain: { lo: 0, hi: length } },
      { name: `b${position}`, type: "interval", interval: { start, size, end } },
    );
    hints[start] = block.start - origin;
    hints[end] = block.end - origin;
    blocks.push({ task_id: block.task_id, calendar_id: block.calendar_id, seq: block.seq, start_var: start, end_var: end, minutes: size });
    const following = chunk(block.task_id, block.seq + 1);
    if (following !== undefined) {
      constraints.push({
        id: `order_${position}`,
        kind: "precedence",
        args: { before: `b${position}`, after: `b${following}` },
        strength: "structural",
        category: "definition",
        label: `Blocks of "${title}" follow each other in order`,
      });
    }
  });
  variables.push({ name: "makespan", type: "int", domain: { lo: 0, hi: length }, description: "The minute the last block ends" });
  hints.makespan = Math.max(0, ...ordered.map((block) => block.end - origin));
  const scheduled = [...lastSeq.keys()].toSorted(compareText);
  for (const taskId of scheduled) {
    const task = tasks.get(taskId);
    const first = chunk(taskId, 0);
    const last = chunk(taskId, lastSeq.get(taskId) ?? 0);
    if (task === undefined || first === undefined || last === undefined) continue;
    for (const dependency of task.depends_on.toSorted(compareText)) {
      const before = chunk(dependency, lastSeq.get(dependency) ?? 0);
      if (before === undefined) continue;
      constraints.push({
        id: `dep_${before}_${first}`,
        kind: "precedence",
        args: { before: `b${before}`, after: `b${first}` },
        strength: "hard",
        category: "fact",
        negotiable: false,
        label: `"${task.title}" starts after "${tasks.get(dependency)?.title ?? dependency}" is finished`,
      });
      evidence.push({ target: { constraint: `dep_${before}_${first}` }, source: `tasks snapshot ${world.snapshot.digest}`, confidence: "sourced" });
    }
    const zone = zones.get(ordered[last]?.calendar_id ?? "");
    const due = task.due === null || zone === undefined ? null : dueMinute(zone, task.due);
    if (due !== null) {
      constraints.push({
        id: `due_${last}`,
        kind: "linear",
        args: { terms: [[1, `b${last}_e`]], op: "<=", rhs: due - origin },
        strength: world.policy.due,
        ...(world.policy.due === "soft" ? { weight: DUE_WEIGHT } : {}),
        category: "goal",
        negotiable: true,
        label: `"${task.title}" is due ${task.due ?? ""}`,
      });
      evidence.push({ target: { constraint: `due_${last}` }, source: `tasks snapshot ${world.snapshot.digest}`, confidence: "sourced" });
    }
  }
  const ends = scheduled.flatMap((taskId) => chunk(taskId, lastSeq.get(taskId) ?? 0) ?? []);
  if (ends.length > 0) {
    constraints.push({
      id: "makespan_def",
      kind: "linear",
      args: { rows: ends.map((position) => ({ terms: [[1, `b${position}_e`], [-1, "makespan"]], op: "<=", rhs: 0 })) },
      strength: "structural",
      category: "definition",
      label: "The plan ends when its last block ends",
    });
  }
  const byCalendar = Map.groupBy(blocks, (block) => block.calendar_id);
  [...byCalendar.keys()].toSorted(compareText).forEach((calendarId, position) => {
    constraints.push({
      id: `calendar_${position}`,
      kind: "no_overlap",
      args: { intervals: (byCalendar.get(calendarId) ?? []).map((block) => block.start_var.replace(/_s$/, "")) },
      strength: "structural",
      category: "fact",
      label: `Calendar ${calendarId} holds one block at a time`,
    });
  });
  return {
    model: {
      schema: "constraint-model.v1",
      name,
      description: `Place ${blocks.length} blocks of ${scheduled.length} tasks inside free working time between ${minuteIso(world.horizon.start)} and ${minuteIso(world.horizon.end)}. Times are minutes after the horizon start.`,
      variables,
      params: [],
      constraints,
      evidence,
      objective: { sense: "min", terms: [{ coef: 1, var: "makespan" }] },
      scenarios: [],
      hints,
    },
    mapping: { unit: "minute", origin: minuteIso(origin), blocks },
  };
};

export const parseMapping = (raw: unknown): Mapping => {
  const record = object(raw, "mapping", ["unit", "origin", "blocks"]);
  if (record.unit !== "minute") {
    throw failure("E_INPUT_SCHEMA", "The field mapping.unit must be minute.", "Pass data.mapping from plan model unchanged.");
  }
  const origin = text(record.origin, "mapping.origin");
  if (!Number.isFinite(Date.parse(origin))) {
    throw failure("E_INPUT_SCHEMA", "The field mapping.origin must be a UTC time.", "Pass data.mapping from plan model unchanged.");
  }
  return {
    unit: "minute",
    origin,
    blocks: list(record.blocks, "mapping.blocks").map((entry, position) => {
      const field = `mapping.blocks[${position}]`;
      const block = object(entry, field, ["task_id", "calendar_id", "seq", "start_var", "end_var", "minutes"]);
      return {
        task_id: text(block.task_id, `${field}.task_id`),
        calendar_id: text(block.calendar_id, `${field}.calendar_id`),
        seq: integer(block.seq, `${field}.seq`, 0, 1_000_000),
        start_var: text(block.start_var, `${field}.start_var`),
        end_var: text(block.end_var, `${field}.end_var`),
        minutes: integer(block.minutes, `${field}.minutes`, 1, 10_000_000),
      };
    }),
  };
};

export const placedFromSolution = (solution: Readonly<Record<string, unknown>>, mapping: Mapping): readonly Placed[] => {
  if (solution.status !== "optimal" && solution.status !== "feasible") {
    throw failure(
      "E_NO_SOLUTION",
      `The constraint solution has status ${String(solution.status)}, so it places no blocks.`,
      "Ask the constraint module to explain the conflict, change the policy or the horizon, or use the plan proposed without a solution.",
    );
  }
  const values = isRecord(solution.values) ? solution.values : {};
  const origin = Date.parse(mapping.origin) / 60_000;
  return mapping.blocks.map((block) => {
    const start = values[block.start_var];
    if (typeof start !== "number" || !Number.isInteger(start)) {
      throw failure("E_INPUT_SCHEMA", `The solution has no whole-number value for ${block.start_var}.`, "Pass the solution of the model that plan model returned, with its mapping unchanged.");
    }
    return { task_id: block.task_id, calendar_id: block.calendar_id, seq: block.seq, start: origin + start, end: origin + start + block.minutes };
  });
};
