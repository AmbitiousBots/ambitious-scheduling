import { dueMinute, workingWindows } from "./calendar.ts";
import { compareText } from "./input.ts";
import { contains, merge, overlaps } from "./intervals.ts";
import type { Placed, World } from "./plan.ts";
import { effortMinutes, isOpen } from "./tasks.ts";
import { localDayOf } from "./zone.ts";

export type Severity = "error" | "warning";

export type Violation = {
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  readonly task_id?: string;
  readonly calendar_id?: string;
  readonly seq?: number;
};

export type CheckOptions = { readonly listed: ReadonlySet<string>; readonly allowPast: boolean };

const order = (a: Violation, b: Violation): number =>
  compareText(a.task_id ?? "", b.task_id ?? "") || (a.seq ?? -1) - (b.seq ?? -1) || compareText(a.code, b.code) || compareText(a.calendar_id ?? "", b.calendar_id ?? "");

export const checkPlan = (world: World, blocks: readonly Placed[], options: CheckOptions): readonly Violation[] => {
  const found: Violation[] = [];
  const tasks = new Map(world.snapshot.tasks.map((task) => [task.id, task]));
  const calendars = new Map(world.calendars.map((calendar) => [calendar.id, calendar]));
  const working = new Map(world.calendars.map((calendar) => [calendar.id, workingWindows(calendar, world.horizon).spans]));
  const busy = new Map(world.calendars.map((calendar) => [calendar.id, merge(world.busy.get(calendar.id) ?? [])]));
  const report = (block: Placed, code: string, message: string, severity: Severity = "error"): void => {
    found.push({ code, severity, message, task_id: block.task_id, calendar_id: block.calendar_id, seq: block.seq });
  };
  const seen = new Set<string>();
  const sound: Placed[] = [];
  for (const block of blocks) {
    const key = `${block.task_id}\u0000${block.seq}`;
    if (seen.has(key)) report(block, "DUPLICATE_BLOCK", "Two blocks have the same task and sequence number.");
    seen.add(key);
    const task = tasks.get(block.task_id);
    const calendar = calendars.get(block.calendar_id);
    if (task === undefined) report(block, "UNKNOWN_TASK", "The block's task is not in the tasks snapshot.");
    if (calendar === undefined) report(block, "UNKNOWN_CALENDAR", "The block's calendar does not exist or was not part of this plan.");
    if (!Number.isInteger(block.start) || !Number.isInteger(block.end) || block.end <= block.start) {
      report(block, "INVALID_INTERVAL", "A block needs whole-minute times with its end after its start.");
      continue;
    }
    sound.push(block);
    if (block.end - block.start > world.policy.block_minutes) report(block, "BLOCK_TOO_LONG", `The block is longer than the ${world.policy.block_minutes} minutes the policy allows.`);
    if (block.start < world.horizon.start || block.end > world.horizon.end) report(block, "OUTSIDE_HORIZON", "The block falls outside the planning horizon.");
    if (!options.allowPast && block.start < world.now) report(block, "IN_THE_PAST", "The block starts before the time the plan was made for.");
    if (task !== undefined && !isOpen(task)) report(block, "CLOSED_TASK", "A done or canceled task must not be scheduled.");
    if (task !== undefined && calendar !== undefined && task.assignee !== null && calendar.person_ref !== task.assignee) {
      report(block, "ASSIGNEE_MISMATCH", "The block's calendar does not belong to the task's assignee.");
    }
    if (calendar === undefined) continue;
    if (!contains(working.get(calendar.id) ?? [], block)) report(block, "OUTSIDE_WORKING_HOURS", "The block is not inside one stretch of the calendar's working hours.");
    if ((busy.get(calendar.id) ?? []).some((span) => overlaps(span, block))) report(block, "BUSY_CONFLICT", "The block overlaps imported busy time.");
  }
  const byTask = Map.groupBy(sound, (block) => block.task_id);
  const finish = new Map([...byTask].map(([id, own]) => [id, Math.max(...own.map((block) => block.end))]));
  const begin = new Map([...byTask].map(([id, own]) => [id, Math.min(...own.map((block) => block.start))]));
  for (const [id, own] of byTask) {
    const task = tasks.get(id);
    const first = own[0];
    if (task === undefined || first === undefined) continue;
    const about = { task_id: id };
    const total = own.reduce((sum, block) => sum + (block.end - block.start), 0);
    const needed = effortMinutes(task, world.policy);
    if (total !== needed) found.push({ code: "DURATION_MISMATCH", severity: "error", message: `The blocks add up to ${total} minutes, but the task's estimate is ${needed} minutes.`, ...about });
    if (new Set(own.map((block) => block.calendar_id)).size > 1) found.push({ code: "MULTIPLE_CALENDARS", severity: "error", message: "A task's blocks must all be on one calendar.", ...about });
    const ordered = own.toSorted((a, b) => a.seq - b.seq);
    if (ordered.some((block, index) => index > 0 && block.start < (ordered[index - 1]?.end ?? -Infinity))) {
      found.push({ code: "SEQUENCE_ORDER", severity: "error", message: "A task's blocks must follow each other in sequence order.", ...about });
    }
    for (const dependency of task.depends_on) {
      const prerequisite = tasks.get(dependency);
      if (prerequisite?.status === "done") continue;
      const done = finish.get(dependency);
      const needsNoTime = prerequisite !== undefined && isOpen(prerequisite) && effortMinutes(prerequisite, world.policy) === 0;
      if (needsNoTime) continue;
      if (done === undefined || done > (begin.get(id) ?? -Infinity)) {
        found.push({ code: "DEPENDENCY_OPEN", severity: "error", message: `The prerequisite ${dependency} is neither done nor scheduled to finish before this task starts.`, ...about });
      }
    }
    const zone = calendars.get(first.calendar_id)?.tz;
    const due = task.due === null || zone === undefined ? null : dueMinute(zone, task.due);
    const end = finish.get(id);
    if (due !== null && end !== undefined && end > due) {
      found.push({ code: "PAST_DUE", severity: world.policy.due === "hard" ? "error" : "warning", message: `The task finishes after it is due (${task.due ?? ""}).`, ...about });
    }
  }
  for (const [calendarId, own] of Map.groupBy(sound, (block) => block.calendar_id)) {
    const ordered = own.toSorted((a, b) => a.start - b.start || compareText(a.task_id, b.task_id) || a.seq - b.seq);
    let latest = -Infinity;
    for (const block of ordered) {
      if (block.start < latest) report(block, "OVERLAP", "The calendar has two blocks at the same time.");
      latest = Math.max(latest, block.end);
    }
    const calendar = calendars.get(calendarId);
    const cap = world.policy.max_minutes_per_day;
    if (calendar === undefined || cap === null) continue;
    const perDay = new Map<number, number>();
    for (const block of own) {
      const day = localDayOf(calendar.tz, block.start);
      perDay.set(day, (perDay.get(day) ?? 0) + (block.end - block.start));
    }
    for (const [day, minutes] of [...perDay].toSorted(([a], [b]) => a - b)) {
      if (minutes > cap) found.push({ code: "MAX_PER_DAY_EXCEEDED", severity: "error", message: `Local day number ${day} holds ${minutes} planned minutes, more than the ${cap} the policy allows.`, calendar_id: calendarId });
    }
  }
  for (const task of world.snapshot.tasks) {
    if (!isOpen(task) || byTask.has(task.id) || options.listed.has(task.id) || effortMinutes(task, world.policy) === 0) continue;
    found.push({ code: "NOT_SCHEDULED", severity: "warning", message: "An open task has no block and is not listed as unscheduled.", task_id: task.id });
  }
  return found.toSorted(order);
};
