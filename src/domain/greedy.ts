import { dayStart, workingWindows, type Calendar, type DstEvent } from "./calendar.ts";
import { compareText } from "./input.ts";
import { subtract, type Span } from "./intervals.ts";
import type { Placed, Unscheduled, World } from "./plan.ts";
import { effortMinutes, isOpen, type SnapshotTask } from "./tasks.ts";
import { localDayOf } from "./zone.ts";

export type Greedy = {
  readonly placed: readonly Placed[];
  readonly unscheduled: readonly Unscheduled[];
  readonly notes: readonly DstEvent[];
  readonly assigned: ReadonlyMap<string, string>;
};

type Desk = { readonly calendar: Calendar; free: readonly Span[]; readonly used: Map<number, number> };

type Attempt = { readonly desk: Desk; readonly blocks: readonly Span[]; readonly finish: number };

const dueOrder = (task: SnapshotTask): number => {
  const parsed = task.due === null ? Number.NaN : Date.parse(task.due);
  return Number.isFinite(parsed) ? parsed : Infinity;
};

const byRank = (a: SnapshotTask, b: SnapshotTask): number => {
  const [dueA, dueB] = [dueOrder(a), dueOrder(b)];
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  return a.priority - b.priority || compareText(a.id, b.id);
};

const attempt = (desk: Desk, earliest: number, minutes: number, world: World): Attempt | null => {
  const { block_minutes: longest, min_block_minutes: shortest, max_minutes_per_day: cap } = world.policy;
  const used = new Map(desk.used);
  const blocks: Span[] = [];
  let remaining = minutes;
  for (const span of desk.free) {
    let cursor = Math.max(span.start, earliest);
    while (remaining > 0 && cursor < span.end) {
      const day = localDayOf(desk.calendar.tz, cursor);
      const budget = cap === null ? Infinity : cap - (used.get(day) ?? 0);
      const size = Math.min(remaining, longest, span.end - cursor, budget);
      if (budget <= 0 || (size < shortest && size < remaining)) {
        const nextDay = dayStart(desk.calendar, day + 1);
        if (budget > 0 || nextDay <= cursor) break;
        cursor = nextDay;
        continue;
      }
      blocks.push({ start: cursor, end: cursor + size });
      used.set(day, (used.get(day) ?? 0) + size);
      remaining -= size;
      cursor += size;
    }
    if (remaining === 0) break;
  }
  const last = blocks.at(-1);
  return remaining > 0 || last === undefined ? null : { desk, blocks, finish: last.end };
};

const commit = ({ desk, blocks }: Attempt): void => {
  desk.free = subtract(desk.free, blocks);
  for (const block of blocks) {
    const day = localDayOf(desk.calendar.tz, block.start);
    desk.used.set(day, (desk.used.get(day) ?? 0) + (block.end - block.start));
  }
};

export const greedySchedule = (world: World): Greedy => {
  const bounds = { start: Math.max(world.horizon.start, world.now), end: world.horizon.end };
  const notes: DstEvent[] = [];
  const desks = world.calendars
    .toSorted((a, b) => compareText(a.id, b.id))
    .map((calendar): Desk => {
      const windows = workingWindows(calendar, bounds);
      notes.push(...windows.notes);
      return { calendar, free: subtract(windows.spans, world.busy.get(calendar.id) ?? []), used: new Map() };
    });
  const byId = new Map(world.snapshot.tasks.map((task) => [task.id, task]));
  const pending = new Map(world.snapshot.tasks.filter(isOpen).map((task) => [task.id, task]));
  const finished = new Map<string, number>();
  const placed: Placed[] = [];
  const unscheduled: Unscheduled[] = [];
  const assigned = new Map<string, string>();
  const give = (task: SnapshotTask, code: string, message: string): void => {
    unscheduled.push({ task_id: task.id, code, message });
  };
  const ready = (task: SnapshotTask): boolean => task.depends_on.every((id) => finished.has(id) || byId.get(id)?.status === "done");
  while (pending.size > 0) {
    const next = [...pending.values()].filter(ready).toSorted(byRank)[0];
    if (next === undefined) break;
    pending.delete(next.id);
    const earliest = Math.max(bounds.start, ...next.depends_on.map((id) => finished.get(id) ?? bounds.start));
    const minutes = effortMinutes(next, world.policy);
    if (minutes === 0) {
      finished.set(next.id, earliest);
      continue;
    }
    const candidates = desks.filter((desk) => next.assignee === null || desk.calendar.person_ref === next.assignee);
    if (candidates.length === 0) {
      give(next, "NO_CALENDAR", next.assignee === null ? "No calendar was given to place this task on." : `No calendar has person_ref ${next.assignee}, the task's assignee.`);
      continue;
    }
    const best = candidates
      .flatMap((desk) => attempt(desk, earliest, minutes, world) ?? [])
      .toSorted((a, b) => a.finish - b.finish || compareText(a.desk.calendar.id, b.desk.calendar.id))[0];
    if (best === undefined) {
      give(next, "NO_FEASIBLE_SLOT", "The free working time left inside the horizon is too short for this task.");
      continue;
    }
    commit(best);
    assigned.set(next.id, best.desk.calendar.id);
    finished.set(next.id, best.finish);
    best.blocks.forEach((block, seq) => placed.push({ task_id: next.id, calendar_id: best.desk.calendar.id, seq, start: block.start, end: block.end }));
  }
  for (const task of [...pending.values()].toSorted((a, b) => compareText(a.id, b.id))) {
    give(task, "DEPENDENCY_OPEN", "A prerequisite is not done and could not be scheduled, is canceled, or is not in the tasks snapshot.");
  }
  return { placed, unscheduled, notes, assigned };
};
