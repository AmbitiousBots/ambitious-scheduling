import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { describeSchemaProblems, schemaProblems } from "@ambitious/kit/domain/json-schema";
import { items, NOW, object, refused, run, scratch, snapshotOf, success, workPlanSnapshot } from "./helper.ts";

const schemaOf = (name: string): unknown => JSON.parse(readFileSync(`schemas/interchange/${name}.json`, "utf8"));
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR"];
const HORIZON = { start: "2026-01-05T00:00:00Z", end: "2026-07-06T00:00:00Z" };
const dbHash = (home: string): string => createHash("sha256").update(readFileSync(join(home, "scheduling", "scheduling.sqlite"))).digest("hex");

const office = (t: TestContext): string => {
  const home = scratch(t);
  success(home, "calendar add", { id: "lead", name: "Lead", tz: "America/Los_Angeles", idem_key: "cal-lead" });
  success(home, "calendar add", { id: "second", name: "Second", tz: "Europe/Berlin", kind: "person", idem_key: "cal-second" });
  for (const id of ["lead", "second"]) {
    success(home, "availability set", { calendar_id: id, expected_version: 1, rules: [{ days: WEEKDAYS, start: "09:00", end: "17:00" }], exceptions: ["2026-01-19"], idem_key: `hours-${id}` });
  }
  success(home, "busy import", {
    calendar_id: "lead",
    source: "manual",
    window: { start: "2026-01-05T00:00:00Z", end: "2026-01-12T00:00:00Z" },
    taken_at: NOW,
    blocks: [{ start: "2026-01-05T18:00:00Z", end: "2026-01-05T19:30:00Z", label: "Standing meeting" }, { start: "2026-01-07T17:00:00Z", end: "2026-01-08T01:00:00Z" }],
    idem_key: "busy-1",
  });
  return home;
};

const proposal = (home: string, policy: object = { block_minutes: 120 }, extra: object = {}) =>
  success(home, "plan propose", { tasks: workPlanSnapshot(), horizon: HORIZON, policy, ...extra });

const commitInput = (plan: Readonly<Record<string, unknown>>, planId: string, baseVersion: number, idemKey: string, extra: object = {}) => ({
  plan_id: planId,
  base_version: baseVersion,
  digest: plan.digest,
  tasks_digest: plan.tasks_digest,
  plan,
  tasks: workPlanSnapshot(),
  idem_key: idemKey,
  actor: "tester",
  ...extra,
});

test("the 104-task work plan is placed on two calendars with nothing left over, nothing wrong, and the same bytes every time", (t) => {
  const home = office(t);
  const before = dbHash(home);
  const first = run(home, "plan propose", { tasks: workPlanSnapshot(), horizon: HORIZON, policy: { block_minutes: 120 } });
  const second = run(home, "plan propose", { tasks: workPlanSnapshot(), horizon: HORIZON, policy: { block_minutes: 120 } });
  assert.equal(first.status, 0, first.stdout);
  assert.equal(first.stdout, second.stdout);
  assert.equal(dbHash(home), before);
  const plan = object(first.data.plan);
  assert.equal(describeSchemaProblems(schemaProblems(schemaOf("schedule-plan.v1"), plan)), "");
  assert.deepEqual(first.data.violations, []);
  assert.deepEqual(first.data.unscheduled, []);
  assert.equal(plan.solver, "greedy");
  assert.equal(plan.status, "proposed");
  assert.equal(typeof first.data.tzdata, "string");
  const blocks = items(plan.blocks).map(object);
  const tasks = items(workPlanSnapshot().tasks).map(object);
  const open = tasks.filter((task) => task.status !== "done");
  assert.equal(tasks.length, 104);
  assert.equal(open.length, 101);
  assert.deepEqual([...new Set(blocks.map((block) => block.task_id))].sort(), open.map((task) => task.id).sort());
  const minutes = blocks.reduce((sum, block) => sum + (Date.parse(String(block.end)) - Date.parse(String(block.start))) / 60_000, 0);
  assert.equal(minutes, open.reduce((sum, task) => sum + Number(task.estimate_days) * 480, 0));
  assert.ok(blocks.every((block) => Date.parse(String(block.end)) - Date.parse(String(block.start)) <= 120 * 60_000));
  const finish = new Map<string, number>();
  const begin = new Map<string, number>();
  for (const block of blocks) {
    const id = String(block.task_id);
    finish.set(id, Math.max(finish.get(id) ?? -Infinity, Date.parse(String(block.end))));
    begin.set(id, Math.min(begin.get(id) ?? Infinity, Date.parse(String(block.start))));
  }
  for (const task of open) {
    for (const dependency of items(task.depends_on).map(String)) {
      const done = finish.get(dependency);
      if (done !== undefined) assert.ok(done <= (begin.get(String(task.id)) ?? 0), `${String(task.id)} starts before ${dependency} ends`);
    }
  }
  assert.ok(blocks.every((block) => !(block.calendar_id === "lead" && String(block.start) < "2026-01-05T19:30:00.000Z" && String(block.end) > "2026-01-05T18:00:00.000Z")));
  assert.ok(blocks.every((block) => !String(block.local_start).startsWith("2026-01-19")));
  const check = success(home, "plan check", { plan, tasks: workPlanSnapshot() });
  assert.deepEqual([check.errors, check.warnings, check.tasks_changed, check.calendars_changed], [0, 0, false, false]);
});

test("a plan is committed only from the version it was proposed against, exactly as proposed, and a retry returns the first answer", (t) => {
  const home = office(t);
  const plan = object(proposal(home).plan);
  const tampered = { ...plan, blocks: items(plan.blocks).map((block, index) => (index === 0 ? { ...object(block), calendar_id: object(block).calendar_id === "second" ? "lead" : "second" } : block)) };
  assert.equal(typeof refused(home, "plan commit", commitInput(tampered, "work", 0, "commit-bad"), "E_DIGEST").computed_digest, "string");
  const edited = snapshotOf(items(workPlanSnapshot().tasks).map((task, index) => ({ ...object(task), id: String(object(task).id), ...(index === 5 ? { updated_at: "2026-01-04T00:00:00.000Z" } : {}) })));
  refused(home, "plan commit", commitInput(plan, "work", 0, "commit-edited", { tasks: edited }), "E_TASKS_CHANGED");
  refused(home, "plan commit", commitInput(plan, "work", 0, "commit-other-digest", { tasks_digest: "0".repeat(64) }), "E_TASKS_CHANGED");
  assert.deepEqual(refused(home, "plan commit", commitInput(plan, "work", 3, "commit-ahead"), "E_STALE"), { current_version: 0, expected_version: 3 });
  refused(home, "plan get", { plan_id: "work" }, "E_NOT_FOUND");
  const first = run(home, "plan commit", commitInput(plan, "work", 0, "commit-1"));
  assert.equal(first.status, 0, first.stdout);
  assert.deepEqual([first.data.plan_id, first.data.version, first.data.digest], ["work", 1, plan.digest]);
  const replay = run(home, "plan commit", commitInput(plan, "work", 0, "commit-1"), "2026-01-06T00:00:00Z");
  assert.deepEqual(replay.data, first.data);
  refused(home, "plan commit", commitInput(plan, "work", 1, "commit-1"), "E_IDEM_CONFLICT");
  assert.deepEqual(refused(home, "plan commit", commitInput(plan, "work", 0, "commit-late"), "E_STALE"), { current_version: 1, expected_version: 0 });
  const stored = object(success(home, "plan get", { plan_id: "work" }).plan);
  assert.deepEqual([stored.plan_id, stored.version, stored.status, stored.forked_from, stored.digest], ["work", 1, "committed", null, plan.digest]);
  assert.equal(describeSchemaProblems(schemaProblems(schemaOf("schedule-plan.v1"), stored)), "");
  assert.deepEqual(stored.blocks, plan.blocks);
  success(home, "busy import", { calendar_id: "second", source: "manual", window: { start: "2026-02-02T00:00:00Z", end: "2026-02-03T00:00:00Z" }, taken_at: NOW, blocks: [{ start: "2026-02-02T09:00:00Z", end: "2026-02-02T10:00:00Z" }], idem_key: "busy-late" });
  refused(home, "plan commit", commitInput(plan, "work", 1, "commit-after-busy"), "E_CALENDAR_CHANGED");
  assert.equal(items(success(home, "plan history", { plan_id: "work" }).versions).length, 1);
});

test("a later version, a diff, an explicit clone and task updates all name what they changed and leave the rest alone", (t) => {
  const home = office(t);
  const v1 = object(proposal(home).plan);
  success(home, "plan commit", commitInput(v1, "work", 0, "commit-1"));
  const longer = proposal(home, { block_minutes: 240 }, { base_plan: { plan_id: "work" } });
  const v2 = object(longer.plan);
  assert.equal(object(object(longer.diff).base_plan).version, 1);
  assert.deepEqual(success(home, "plan commit", commitInput(v2, "work", 1, "commit-2")).version, 2);
  const diff = success(home, "plan diff", { plan_id: "work", from_version: 1, to_version: 2 });
  assert.ok(items(diff.removed).length > 0 && items(diff.moved).length > 0);
  assert.equal(items(diff.added).length + items(diff.moved).length + Number(diff.unchanged), items(v2.blocks).length);
  assert.equal(items(diff.removed).length + items(diff.moved).length + Number(diff.unchanged), items(v1.blocks).length);
  assert.deepEqual(object(success(home, "plan get", { plan_id: "work", version: 1 }).plan).blocks, v1.blocks);
  const history = success(home, "plan history", { plan_id: "work" });
  assert.deepEqual(items(history.versions).map((entry) => object(entry).version), [1, 2]);
  assert.deepEqual(items(history.events).map((entry) => object(entry).kind), ["plan_committed", "plan_committed"]);

  const beforeClone = object(success(home, "plan get", { plan_id: "work" }).plan);
  const clone = success(home, "plan clone", { plan_id: "work", version: 1, new_id: "what-if", idem_key: "clone-1", actor: "tester" });
  assert.deepEqual([clone.plan_id, clone.version, clone.forked_from], ["what-if", 1, { plan_id: "work", version: 1 }]);
  assert.deepEqual(success(home, "plan clone", { plan_id: "work", version: 1, new_id: "what-if", idem_key: "clone-1", actor: "tester" }), clone);
  refused(home, "plan clone", { plan_id: "work", new_id: "what-if", idem_key: "clone-2" }, "E_DUPLICATE");
  refused(home, "plan clone", { plan_id: "nothing", new_id: "x", idem_key: "clone-3" }, "E_NOT_FOUND");
  const copy = object(success(home, "plan get", { plan_id: "what-if" }).plan);
  assert.deepEqual([copy.forked_from, copy.blocks, copy.digest], [{ plan_id: "work", version: 1 }, v1.blocks, v1.digest]);
  assert.deepEqual(object(success(home, "plan get", { plan_id: "work" }).plan), beforeClone);
  assert.deepEqual(items(success(home, "plan list").plans).map((entry) => [object(entry).plan_id, object(entry).version]), [["what-if", 1], ["work", 2]]);
  assert.equal(success(home, "plan commit", commitInput(v2, "what-if", 1, "commit-fork")).version, 2);
  assert.equal(object(success(home, "plan get", { plan_id: "what-if" }).plan).forked_from === null, false);
  assert.equal(object(success(home, "plan get", { plan_id: "work" }).plan).version, 2);

  const updates = success(home, "plan task-updates", { plan_id: "work", tasks: workPlanSnapshot() });
  const suggested = items(updates.suggestedUpdates).map(object);
  assert.equal(suggested.length, 101);
  const firstId = String(suggested[0]?.id);
  assert.deepEqual(suggested[0], { id: firstId, patch: { labels: ["sched:work@v2"] }, idem_key: `sched:work:2:${firstId}`, actor: "ambitious-scheduling" });
  assert.deepEqual(suggested.map((entry) => entry.id), suggested.map((entry) => entry.id).toSorted());
  assert.deepEqual(updates.notes, []);
  const labelled = snapshotOf([
    { id: "task-050", labels: ["keep", "sched:work@v1"], due: "2026-01-01" },
    { id: "task-051", labels: ["sched:work@v2"] },
  ]);
  const second = success(home, "plan task-updates", { plan_id: "work", tasks: labelled });
  assert.deepEqual(items(second.suggestedUpdates).map(object).map((entry) => [entry.id, object(entry.patch).labels]), [["task-050", ["keep", "sched:work@v2"]]]);
  assert.deepEqual(items(second.notes).map((entry) => [object(entry).task_id, object(entry).code]), [["task-050", "FINISHES_AFTER_DUE"]]);
  assert.equal(items(second.skipped).length, 99);
});

test("calendar holds are proposed once, kept across versions when a block is unchanged, and canceled when a version drops them", (t) => {
  const home = scratch(t);
  success(home, "calendar add", { id: "lead", name: "Lead", tz: "America/Los_Angeles", person_ref: "lead", idem_key: "cal" });
  success(home, "availability set", { calendar_id: "lead", expected_version: 1, rules: [{ days: WEEKDAYS, start: "09:00", end: "17:00" }], idem_key: "hours" });
  const tasks = snapshotOf([{ id: "a", title: "Draft the note", estimate_days: 0.25 }, { id: "b", title: "Review the note", estimate_days: 0.25, depends_on: ["a"] }]);
  const horizon = { start: "2026-01-05T00:00:00Z", end: "2026-01-12T00:00:00Z" };
  const commit = (policy: object, base: number, key: string): void => {
    const plan = object(success(home, "plan propose", { tasks, horizon, policy, calendar_ids: ["lead"] }).plan);
    success(home, "plan commit", { plan_id: "note", base_version: base, digest: plan.digest, tasks_digest: plan.tasks_digest, plan, tasks, idem_key: key });
  };
  const holdsOf = (input: object = {}) => {
    const data = success(home, "plan holds", { plan_id: "note", ...input });
    assert.equal(describeSchemaProblems(schemaProblems(schemaOf("calendar-holds.v1"), data.holds)), "");
    return { summary: data.summary, holds: items(object(data.holds).holds).map(object), plan: object(object(data.holds).plan) };
  };
  commit({ block_minutes: 120 }, 0, "c1");
  const first = holdsOf();
  assert.deepEqual(first.summary, { create: 2, keep: 0, cancel: 0 });
  assert.deepEqual(first.holds[0]?.start, { utc: "2026-01-05T17:00:00.000Z", local: "2026-01-05T09:00:00-08:00", time_zone: "America/Los_Angeles" });
  assert.deepEqual([first.holds[0]?.title, first.holds[0]?.calendar_hint, first.holds[0]?.source], ["Draft the note", { calendar_id: "lead", name: "Lead", person_ref: "lead" }, { plan_id: "note", version: 1, task_id: "a", seq: 0 }]);
  assert.match(String(first.holds[0]?.idempotency_key), /^hold:note:a:0:[0-9a-f]{16}$/);
  const [keyA, keyB] = first.holds.map((hold) => String(hold.idempotency_key));
  const recorded = { plan_id: "note", records: [{ idempotency_key: keyA, status: "created", provider: "example-calendar", event_id: "evt-1", calendar: "primary" }, { idempotency_key: keyB, status: "created", provider: "example-calendar", event_id: "evt-2" }], idem_key: "rec-1", actor: "bot" };
  assert.deepEqual(success(home, "holds record", recorded).totals, { created: 2, canceled: 0, failed: 0 });
  assert.deepEqual(success(home, "holds record", recorded).totals, { created: 2, canceled: 0, failed: 0 });
  const again = holdsOf();
  assert.deepEqual(again.summary, { create: 0, keep: 2, cancel: 0 });
  assert.deepEqual(again.holds[0]?.external, { provider: "example-calendar", event_id: "evt-1", calendar: "primary" });
  refused(home, "holds record", { plan_id: "note", records: [{ idempotency_key: keyA, status: "created", provider: "example-calendar", event_id: "evt-9" }], idem_key: "rec-dup" }, "E_HOLD_STATE");
  refused(home, "holds record", { plan_id: "note", records: [{ idempotency_key: "hold:note:zz:0:0000000000000000", status: "created", provider: "x", event_id: "e" }], idem_key: "rec-unknown" }, "E_UNKNOWN_HOLD");
  refused(home, "holds record", { plan_id: "note", records: [{ idempotency_key: keyA, status: "created", provider: "x" }], idem_key: "rec-no-event" }, "E_INPUT_SCHEMA");

  commit({ block_minutes: 120, hours_per_day: 12 }, 1, "c2");
  const moved = holdsOf();
  assert.deepEqual(moved.summary, { create: 3, keep: 1, cancel: 1 });
  assert.deepEqual(moved.holds.filter((hold) => hold.action === "keep").map((hold) => hold.idempotency_key), [keyA]);
  const cancel = moved.holds.find((hold) => hold.action === "cancel");
  assert.deepEqual([cancel?.idempotency_key, cancel?.external, object(cancel?.source).version], [keyB, { provider: "example-calendar", event_id: "evt-2" }, 1]);
  assert.equal(moved.plan.version, 2);
  assert.deepEqual(holdsOf({ version: 1 }).summary, { create: 0, keep: 2, cancel: 0 });
  success(home, "holds record", { plan_id: "note", records: [{ idempotency_key: keyB, status: "canceled", provider: "example-calendar" }], idem_key: "rec-2" });
  assert.deepEqual(holdsOf().summary, { create: 3, keep: 1, cancel: 0 });
  const failing = String(moved.holds.find((hold) => hold.action === "create")?.idempotency_key);
  success(home, "holds record", { plan_id: "note", records: [{ idempotency_key: failing, status: "failed", provider: "example-calendar", note: "The calendar refused the event." }], idem_key: "rec-3" });
  assert.deepEqual(holdsOf().summary, { create: 3, keep: 1, cancel: 0 });
  refused(home, "holds record", { plan_id: "note", records: [{ idempotency_key: String(moved.holds.filter((hold) => hold.action === "create")[1]?.idempotency_key), status: "canceled", provider: "x" }], idem_key: "rec-4" }, "E_HOLD_STATE");
  const all = holdsOf({ cancel_all: true });
  assert.deepEqual(all.summary, { create: 0, keep: 0, cancel: 1 });
  assert.equal(all.holds[0]?.idempotency_key, keyA);
  const list = items(success(home, "holds list", { plan_id: "note" }).records).map(object);
  assert.deepEqual(list.map((record) => record.status).sort(), ["canceled", "created", "failed"]);
  assert.equal(list.find((record) => record.status === "canceled")?.event_id, "evt-2");
  assert.deepEqual(items(success(home, "plan history", { plan_id: "note" }).events).map((entry) => object(entry).kind), ["plan_committed", "holds_recorded", "plan_committed", "holds_recorded", "holds_recorded"]);
});

test("a constraint solution placed through its mapping is checked like any other plan", (t) => {
  const home = office(t);
  const input = { tasks: workPlanSnapshot(), horizon: HORIZON, policy: { block_minutes: 480 }, name: "work-plan" };
  const first = run(home, "plan model", input);
  assert.equal(first.status, 0, first.stdout);
  assert.equal(first.stdout, run(home, "plan model", input).stdout);
  const model = object(first.data.model);
  const mapping = object(first.data.mapping);
  assert.equal(describeSchemaProblems(schemaProblems(schemaOf("constraint-model.v1"), model)), "");
  assert.deepEqual([model.schema, model.name, mapping.unit, mapping.origin], ["constraint-model.v1", "work-plan", "minute", "2026-01-05T00:00:00.000Z"]);
  const greedy = object(success(home, "plan propose", input).plan);
  assert.equal(items(mapping.blocks).length, items(greedy.blocks).length);
  const solution = {
    schema: "constraint-solution.v1",
    model: { name: "work-plan", digest: "a".repeat(64) },
    scenario: null,
    status: "feasible",
    objective: object(model.hints).makespan,
    bound: null,
    values: model.hints,
    solver: { name: "cp-sat", version: "9.15.6755", seed: 7, workers: 1 },
  };
  const solved = success(home, "plan propose", { ...input, solution, mapping });
  const plan = object(solved.plan);
  assert.deepEqual([plan.solver, solved.violations, plan.blocks], ["constraints", [], greedy.blocks]);
  assert.notEqual(plan.digest, undefined);
  assert.equal(success(home, "plan commit", commitInput(plan, "solved", 0, "commit-solved")).version, 1);
  refused(home, "plan propose", { ...input, solution: { ...solution, status: "infeasible", values: {} }, mapping }, "E_NO_SOLUTION");
  refused(home, "plan propose", { ...input, solution: { ...solution, status: "done" }, mapping }, "E_INPUT_SCHEMA");
  refused(home, "plan propose", { ...input, solution }, "E_INPUT_SCHEMA");
  refused(home, "plan model", { ...input, policy: { max_minutes_per_day: 240 } }, "E_UNSUPPORTED");
  const first0 = object(items(mapping.blocks)[0]);
  const broken = { ...solution, values: { ...object(model.hints), [String(first0.start_var)]: 0 } };
  const bad = success(home, "plan propose", { ...input, solution: broken, mapping });
  assert.ok(items(bad.violations).map((entry) => object(entry).code).includes("OUTSIDE_WORKING_HOURS"));
  refused(home, "plan commit", commitInput(object(bad.plan), "bad", 0, "commit-bad-plan"), "E_VIOLATIONS");
  assert.equal(success(home, "plan commit", commitInput(object(bad.plan), "bad", 0, "commit-bad-plan-2", { allow_violations: true })).version, 1);
});

test("calendars change only from the version the caller read, busy time is replaced per window, and free time reflects both", (t) => {
  const home = office(t);
  assert.deepEqual(refused(home, "calendar update", { id: "lead", expected_version: 1, patch: { name: "Lead desk" }, idem_key: "u1" }, "E_STALE"), { current_version: 2, expected_version: 1 });
  assert.equal(object(success(home, "calendar update", { id: "lead", expected_version: 2, patch: { name: "Lead desk", person_ref: "lee" }, idem_key: "u2" }).calendar).version, 3);
  refused(home, "availability set", { calendar_id: "lead", expected_version: 2, rules: [], idem_key: "h-stale" }, "E_STALE");
  refused(home, "calendar add", { id: "lead", tz: "UTC", idem_key: "dup" }, "E_DUPLICATE");
  refused(home, "calendar add", { id: "x", tz: "Mars/Olympus", idem_key: "tz" }, "E_INPUT_SCHEMA");
  refused(home, "calendar get", { id: "nobody" }, "E_NOT_FOUND");
  const lead = success(home, "calendar get", { id: "lead" });
  assert.deepEqual([object(lead.calendar).name, object(lead.calendar).person_ref, items(lead.busy).length], ["Lead desk", "lee", 1]);
  assert.deepEqual(items(success(home, "calendar list").calendars).map((entry) => object(entry).id), ["lead", "second"]);
  const busy = { calendar_id: "lead", source: "manual", window: { start: "2026-01-05T00:00:00Z", end: "2026-01-12T00:00:00Z" }, taken_at: NOW, blocks: [{ start: "2026-01-05T18:00:00Z", end: "2026-01-05T19:30:00Z", label: "Standing meeting" }, { start: "2026-01-07T17:00:00Z", end: "2026-01-08T01:00:00Z" }] };
  assert.equal(success(home, "busy import", { ...busy, idem_key: "busy-same" }).action, "unchanged");
  assert.equal(success(home, "busy import", { ...busy, blocks: busy.blocks.slice(0, 1), idem_key: "busy-less" }).action, "replaced");
  refused(home, "busy import", { ...busy, blocks: [{ start: "2026-02-01T00:00:00Z", end: "2026-02-01T01:00:00Z" }], idem_key: "busy-out" }, "E_INPUT_SCHEMA");
  const free = object(items(success(home, "free", { calendar_ids: ["lead"], from: "2026-01-05T00:00:00Z", to: "2026-01-08T12:00:00Z", min_minutes: 60 }).calendars)[0]);
  assert.deepEqual(items(free.free).map((entry) => [object(entry).local_start, object(entry).minutes]), [
    ["2026-01-05T09:00:00-08:00", 60],
    ["2026-01-05T11:30:00-08:00", 330],
    ["2026-01-06T09:00:00-08:00", 480],
    ["2026-01-07T09:00:00-08:00", 480],
  ]);
  assert.equal(free.free_minutes, 1350);
});

test("tasks that cannot be placed are listed with the reason, and a hard due date that is missed is an error", (t) => {
  const home = office(t);
  const tasks = snapshotOf([
    { id: "big", estimate_days: 40 },
    { id: "after-big", depends_on: ["big"] },
    { id: "theirs", assignee: "someone-else" },
    { id: "late", estimate_days: 2, due: "2026-01-05" },
    { id: "orphan", depends_on: ["not-in-snapshot"] },
    { id: "after-canceled", depends_on: ["dropped"] },
    { id: "dropped", status: "canceled" },
    { id: "nothing-to-do", estimate_days: 0 },
  ]);
  const input = { tasks, horizon: { start: "2026-01-05T00:00:00Z", end: "2026-01-12T00:00:00Z" } };
  const soft = success(home, "plan propose", input);
  assert.deepEqual(items(soft.unscheduled).map((entry) => [object(entry).task_id, object(entry).code]), [
    ["after-big", "DEPENDENCY_OPEN"], ["after-canceled", "DEPENDENCY_OPEN"], ["big", "NO_FEASIBLE_SLOT"], ["orphan", "DEPENDENCY_OPEN"], ["theirs", "NO_CALENDAR"],
  ]);
  assert.deepEqual(items(soft.violations).map((entry) => [object(entry).task_id, object(entry).code, object(entry).severity]), [["late", "PAST_DUE", "warning"]]);
  const hard = success(home, "plan propose", { ...input, policy: { due: "hard" } });
  assert.deepEqual(items(hard.violations).map((entry) => object(entry).severity), ["error"]);
  const started = success(home, "plan propose", input, "2026-01-08T20:10:30Z");
  assert.ok(items(object(started.plan).blocks).every((block) => String(object(block).start) >= "2026-01-08T20:11:00.000Z"));
  refused(home, "plan propose", { ...input, tasks: { schema: "tasks-snapshot.v2", tasks: [] } }, "E_INPUT_SCHEMA");
  refused(home, "plan propose", { ...input, horizon: { start: "2026-01-05T00:00:00Z", end: "2026-01-05T00:00:00Z" } }, "E_INPUT_SCHEMA");
  refused(home, "plan propose", { ...input, calendar_ids: ["nobody"] }, "E_NOT_FOUND");
  refused(home, "plan propose", { ...input, policy: { block_minutes: 2 } }, "E_INPUT_SCHEMA");
});
