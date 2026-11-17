import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { WEEKDAYS } from "../src/domain/calendar.ts";
import { checkPlan } from "../src/domain/checker.ts";
import { greedySchedule } from "../src/domain/greedy.ts";
import { effortMinutes, isOpen } from "../src/domain/tasks.ts";
import { calendar, minute, rule, world, type TaskRow } from "./helper.ts";

const ZONES = ["UTC", "America/New_York", "Europe/Berlin", "Australia/Sydney", "Asia/Kolkata", "America/Sao_Paulo", "Pacific/Chatham"];
const PEOPLE = ["ana", "ben", "cy"];
const BASE = minute("2026-01-01T00:00:00Z");

const clock = (steps: number): string => (steps === 96 ? "24:00" : `${String(Math.floor(steps / 4)).padStart(2, "0")}:${String((steps % 4) * 15).padStart(2, "0")}`);

const ruleArb = fc
  .record({ days: fc.subarray([...WEEKDAYS], { minLength: 1 }), a: fc.integer({ min: 0, max: 96 }), b: fc.integer({ min: 0, max: 96 }) })
  .filter(({ a, b }) => a !== b && Math.min(a, b) < 96)
  .map(({ days, a, b }) => rule(days, clock(Math.min(a, b)), clock(Math.max(a, b))));

const calendarsArb = fc
  .array(fc.record({ zone: fc.constantFrom(...ZONES), rules: fc.array(ruleArb, { minLength: 1, maxLength: 2 }), person: fc.boolean() }), { minLength: 1, maxLength: 3 })
  .map((entries) => entries.map((entry, index) => calendar(`cal-${index}`, entry.zone, entry.rules, entry.person ? (PEOPLE[index] ?? null) : null)));

const tasksArb = fc
  .array(
    fc.record({
      estimate: fc.constantFrom(0, 0.125, 0.25, 0.5, 1, 1.5, 3, null),
      status: fc.constantFrom("todo", "todo", "todo", "in_progress", "blocked", "waiting", "done", "canceled"),
      assignee: fc.constantFrom(null, null, "ana", "ben", "cy", "nobody"),
      priority: fc.integer({ min: 0, max: 3 }),
      due: fc.option(fc.integer({ min: 0, max: 80 }), { nil: null }),
      deps: fc.array(fc.nat(), { maxLength: 3 }),
      outside: fc.boolean(),
    }),
    { minLength: 1, maxLength: 24 },
  )
  .map((rows) =>
    rows.map((row, index): TaskRow => ({
      id: `t-${String(index).padStart(2, "0")}`,
      estimate_days: row.estimate,
      status: row.status,
      assignee: row.assignee,
      priority: row.priority,
      due: row.due === null ? null : new Date((BASE + row.due * 1440) * 60_000).toISOString().slice(0, 10),
      depends_on: [...new Set([...(index === 0 ? [] : row.deps.map((dep) => `t-${String(dep % index).padStart(2, "0")}`)), ...(row.outside && row.deps.length > 2 ? ["missing"] : [])])],
    })),
  );

const scenario = fc.record({
  calendars: calendarsArb,
  tasks: tasksArb,
  startDay: fc.integer({ min: 0, max: 400 }),
  days: fc.integer({ min: 1, max: 60 }),
  nowOffset: fc.integer({ min: -2000, max: 4000 }),
  block: fc.constantFrom(30, 45, 60, 90, 120, 240, 480),
  shortest: fc.constantFrom(1, 15, 30),
  cap: fc.constantFrom(null, null, 120, 240, 300),
  hard: fc.boolean(),
  busy: fc.array(fc.record({ calendar: fc.nat({ max: 2 }), at: fc.integer({ min: 0, max: 60 * 1440 }), length: fc.integer({ min: 1, max: 600 }) }), { maxLength: 12 }),
});

test("for generated tasks, calendars and busy time, the independent checker finds nothing wrong with the greedy plan", () => {
  fc.assert(
    fc.property(scenario, (given) => {
      const start = BASE + given.startDay * 1440;
      const busy = new Map(
        given.calendars.map((entry, index) => [
          entry.id,
          given.busy.filter((block) => block.calendar % given.calendars.length === index).map((block) => ({ start: start + block.at, end: start + block.at + block.length })),
        ]),
      );
      const subject = world({
        tasks: given.tasks,
        calendars: given.calendars,
        horizon: { start, end: start + given.days * 1440 },
        now: start + given.nowOffset,
        busy,
        policy: { block_minutes: given.block, min_block_minutes: Math.min(given.shortest, given.block), max_minutes_per_day: given.cap, due: given.hard ? "hard" : "soft" },
      });
      const plan = greedySchedule(subject);
      const again = greedySchedule(subject);
      assert.deepEqual(plan.placed, again.placed);
      assert.deepEqual(plan.unscheduled, again.unscheduled);
      const violations = checkPlan(subject, plan.placed, { listed: new Set(plan.unscheduled.map((entry) => entry.task_id)), allowPast: false });
      assert.deepEqual(violations.filter((violation) => violation.code !== "PAST_DUE"), []);
      const placedIds = new Set(plan.placed.map((block) => block.task_id));
      const listed = new Set(plan.unscheduled.map((entry) => entry.task_id));
      for (const task of subject.snapshot.tasks) {
        const needsTime = isOpen(task) && effortMinutes(task, subject.policy) > 0;
        assert.equal(placedIds.has(task.id) || listed.has(task.id), needsTime || listed.has(task.id), task.id);
        assert.ok(!(placedIds.has(task.id) && listed.has(task.id)));
      }
      const finish = new Map<string, number>();
      const begin = new Map<string, number>();
      for (const block of plan.placed) {
        finish.set(block.task_id, Math.max(finish.get(block.task_id) ?? -Infinity, block.end));
        begin.set(block.task_id, Math.min(begin.get(block.task_id) ?? Infinity, block.start));
      }
      for (const task of subject.snapshot.tasks) {
        const own = begin.get(task.id);
        if (own === undefined) continue;
        for (const dependency of task.depends_on) {
          const done = finish.get(dependency);
          if (done !== undefined) assert.ok(done <= own, `${task.id} starts before ${dependency} ends`);
        }
        assert.ok(own >= subject.now && own >= subject.horizon.start);
      }
    }),
    { numRuns: 400, seed: 42 },
  );
});

test("the checker reports each kind of mistake when a sound plan is damaged", () => {
  const start = minute("2026-01-05T00:00:00Z");
  const subject = world({
    tasks: [
      { id: "a", estimate_days: 0.25, assignee: "ana", due: "2026-01-05" },
      { id: "b", estimate_days: 0.25, depends_on: ["a"], assignee: "ana" },
      { id: "c", status: "done" },
    ],
    calendars: [calendar("ana"), calendar("ben")],
    horizon: { start, end: start + 5 * 1440 },
    busy: new Map([["ana", [{ start: start + 13 * 60, end: start + 14 * 60 }]]]),
    policy: { max_minutes_per_day: 240 },
  });
  const nine = start + 9 * 60;
  const first = { task_id: "a", calendar_id: "ana", seq: 0, start: nine, end: nine + 120 };
  const second = { task_id: "b", calendar_id: "ana", seq: 0, start: nine + 120, end: nine + 240 };
  const good = [first, second];
  const codes = (blocks: typeof good, allowPast = false): readonly string[] =>
    [...new Set(checkPlan(subject, blocks, { listed: new Set(), allowPast }).map((violation) => violation.code))].sort();
  assert.deepEqual(codes(good), []);
  assert.deepEqual(codes([first, { ...second, start: nine + 60, end: nine + 180 }]), ["DEPENDENCY_OPEN", "OVERLAP"]);
  assert.deepEqual(codes(good.map((block) => ({ ...block, calendar_id: "ben" }))), ["ASSIGNEE_MISMATCH"]);
  assert.deepEqual(codes(good.map((block) => (block.task_id === "a" ? { ...block, end: block.end - 30 } : block))), ["DURATION_MISMATCH"]);
  assert.deepEqual(codes(good.map((block) => (block.task_id === "b" ? { ...block, start: nine + 480, end: nine + 600 } : block))), ["OUTSIDE_WORKING_HOURS"]);
  assert.deepEqual(codes(good.map((block) => (block.task_id === "b" ? { ...block, start: nine + 210, end: nine + 330 } : block))), ["BUSY_CONFLICT"]);
  assert.deepEqual(codes(good.map((block) => (block.task_id === "b" ? { ...block, start: nine + 6 * 1440, end: nine + 6 * 1440 + 120 } : block))), ["OUTSIDE_HORIZON", "OUTSIDE_WORKING_HOURS"]);
  assert.deepEqual(codes(good.map((block) => ({ ...block, start: block.start + 1440, end: block.end + 1440 }))), ["PAST_DUE"]);
  assert.deepEqual(codes([...good, { task_id: "c", calendar_id: "ben", seq: 0, start: nine, end: nine + 120 }]), ["CLOSED_TASK", "DURATION_MISMATCH"]);
  assert.deepEqual(codes([...good, { task_id: "zz", calendar_id: "nowhere", seq: 0, start: nine, end: nine + 60 }]), ["UNKNOWN_CALENDAR", "UNKNOWN_TASK"]);
  assert.deepEqual(codes([first, first, second]), ["DUPLICATE_BLOCK", "DURATION_MISMATCH", "MAX_PER_DAY_EXCEEDED", "OVERLAP", "SEQUENCE_ORDER"]);
  assert.deepEqual(codes(good.slice(0, 1)), ["NOT_SCHEDULED"]);
  assert.deepEqual(codes(good.map((block) => (block.task_id === "b" ? { ...block, end: block.start } : block))), ["INVALID_INTERVAL", "NOT_SCHEDULED"]);
  const later = { ...subject, now: nine + 30 };
  assert.deepEqual([...new Set(checkPlan(later, good, { listed: new Set(), allowPast: false }).map((violation) => violation.code))], ["IN_THE_PAST"]);
  assert.deepEqual(checkPlan(later, good, { listed: new Set(), allowPast: true }), []);
  const crowded = { ...subject, policy: { ...subject.policy, max_minutes_per_day: 200, block_minutes: 60 } };
  assert.deepEqual([...new Set(checkPlan(crowded, good, { listed: new Set(), allowPast: false }).map((violation) => violation.code))].sort(), ["BLOCK_TOO_LONG", "MAX_PER_DAY_EXCEEDED"]);
});
