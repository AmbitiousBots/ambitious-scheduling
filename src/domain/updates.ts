import type { JsonObject } from "@ambitious/kit/domain/json";
import { dueMinute, type Calendar } from "./calendar.ts";
import { compareText } from "./input.ts";
import type { Block } from "./plan.ts";
import type { Snapshot } from "./tasks.ts";

export const ACTOR = "ambitious-scheduling";

export const taskUpdates = (planId: string, version: number, blocks: readonly Block[], snapshot: Snapshot, calendars: ReadonlyMap<string, Calendar>): JsonObject => {
  const label = `sched:${planId}@v${version}`;
  const prefix = `sched:${planId}@`;
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const byTask = Map.groupBy(blocks, (block) => block.task_id);
  const ids = [...byTask.keys()].toSorted(compareText);
  const scheduled = ids.map((id) => {
    const own = (byTask.get(id) ?? []).toSorted((a, b) => a.seq - b.seq);
    const end = own.map((block) => block.end).toSorted(compareText).at(-1) ?? "";
    return { task_id: id, calendar_id: own[0]?.calendar_id ?? "", start: own.map((block) => block.start).toSorted(compareText)[0] ?? "", end, blocks: own.length };
  });
  const known = scheduled.filter(({ task_id: id }) => tasks.has(id));
  const suggestedUpdates = known.flatMap(({ task_id: id }) => {
    const task = tasks.get(id);
    if (task === undefined || task.labels.includes(label)) return [];
    return [{ id, patch: { labels: [...task.labels.filter((existing) => !existing.startsWith(prefix)), label] }, idem_key: `sched:${planId}:${version}:${id}`, actor: ACTOR }];
  });
  const notes = known.flatMap(({ task_id: id, calendar_id: calendarId, end }) => {
    const task = tasks.get(id);
    const zone = calendars.get(calendarId)?.tz;
    const due = task === undefined || task.due === null || zone === undefined ? null : dueMinute(zone, task.due);
    if (task === undefined || due === null || Date.parse(end) / 60_000 <= due) return [];
    return [{ task_id: id, code: "FINISHES_AFTER_DUE", message: `The plan finishes this task at ${end}, after it is due (${task.due ?? ""}). The due date was left as it is.` }];
  });
  const skipped = scheduled
    .filter(({ task_id: id }) => !tasks.has(id))
    .map(({ task_id: id }) => ({ task_id: id, code: "UNKNOWN_TASK", message: "The task is in the plan but not in the tasks snapshot that was passed." }));
  return { label, scheduled, suggestedUpdates, notes, skipped };
};
