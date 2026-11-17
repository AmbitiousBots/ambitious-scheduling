import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fc from "fast-check";
import { isRecord } from "@ambitious/kit/domain/json";
import { describeSchemaProblems, schemaProblems } from "@ambitious/kit/domain/json-schema";
import { checkPlan } from "../src/domain/checker.ts";
import { greedySchedule } from "../src/domain/greedy.ts";
import { parseMapping, placedFromSolution, planModel } from "../src/domain/model.ts";
import { comparePlaced } from "../src/domain/plan.ts";
import { calendar, items, minute, object, world } from "./helper.ts";

const schema: unknown = JSON.parse(readFileSync("schemas/interchange/constraint-model.v1.json", "utf8"));
const start = minute("2026-01-05T00:00:00Z");

const subject = (due: "soft" | "hard" = "soft") =>
  world({
    tasks: [
      { id: "draft", estimate_days: 0.5, assignee: "ana", due: "2026-01-06" },
      { id: "review", estimate_days: 0.25, assignee: "ben", depends_on: ["draft"] },
      { id: "ship it!", estimate_days: 0.125, depends_on: ["review", "gone"], assignee: "ana" },
      { id: "gone", status: "done" },
    ],
    calendars: [calendar("ana", "America/New_York"), calendar("ben", "Europe/Berlin")],
    horizon: { start, end: start + 7 * 1440 },
    busy: new Map([["ana", [{ start: start + 15 * 60, end: start + 16 * 60 }]]]),
    policy: { due },
  });

test("the constraint model is a valid constraint-model.v1 whose names never carry a task id", () => {
  const given = subject();
  const { model, mapping } = planModel(given, greedySchedule(given), "week");
  assert.equal(describeSchemaProblems(schemaProblems(schema, model)), "");
  const kinds = items(model.constraints).map((entry) => String(object(entry).kind));
  assert.deepEqual([...new Set(kinds)].sort(), ["linear", "no_overlap", "precedence"]);
  assert.equal(items(model.variables).filter((entry) => object(entry).type === "interval").length, mapping.blocks.length);
  assert.ok(!JSON.stringify(items(model.variables).map((entry) => object(entry).name)).includes("ship"));
  assert.deepEqual(object(model.objective), { sense: "min", terms: [{ coef: 1, var: "makespan" }] });
  const due = items(model.constraints).map(object).find((entry) => String(entry.id).startsWith("due_"));
  assert.equal(due?.strength, "soft");
  assert.equal(due?.category, "goal");
  assert.equal(due?.negotiable, true);
  assert.match(String(due?.label), /is due 2026-01-06/);
  assert.equal(parseMapping(JSON.parse(JSON.stringify(mapping))).blocks.length, mapping.blocks.length);
  const hard = planModel(subject("hard"), greedySchedule(subject("hard")), "week").model;
  assert.equal(items(hard.constraints).map(object).find((entry) => String(entry.id).startsWith("due_"))?.strength, "hard");
});

test("the model's hints are the greedy plan, and a solution equal to the hints gives back the greedy blocks", () => {
  const given = subject();
  const greedy = greedySchedule(given);
  const { model, mapping } = planModel(given, greedy, "week");
  const placed = placedFromSolution({ status: "feasible", values: model.hints }, mapping);
  assert.deepEqual(placed.toSorted(comparePlaced), greedy.placed.toSorted(comparePlaced));
  assert.deepEqual(checkPlan(given, placed, { listed: new Set(), allowPast: false }).filter((violation) => violation.severity === "error"), []);
});

test("every hinted start lies inside its variable's ranges, and a start moved to another range still fits working hours and busy time", () => {
  const given = subject();
  const greedy = greedySchedule(given);
  const { model, mapping } = planModel(given, greedy, "week");
  const hints = object(model.hints);
  const domains = new Map(items(model.variables).map(object).map((entry) => [String(entry.name), isRecord(entry.domain) ? entry.domain : {}]));
  fc.assert(
    fc.property(fc.integer({ min: 0, max: mapping.blocks.length - 1 }), fc.nat(), fc.nat(), (blockIndex, rangeSeed, offsetSeed) => {
      const block = mapping.blocks[blockIndex];
      if (block === undefined) return;
      const ranges = items(domains.get(block.start_var)?.ranges).map((range) => items(range).map(Number));
      const hinted = Number(hints[block.start_var]);
      assert.ok(ranges.some(([low = 0, high = -1]) => low <= hinted && hinted <= high));
      const [low = 0, high = 0] = ranges[rangeSeed % ranges.length] ?? [];
      const moved = low + (offsetSeed % (high - low + 1));
      const placed = placedFromSolution({ status: "optimal", values: { ...hints, [block.start_var]: moved } }, mapping);
      const codes = checkPlan(given, placed, { listed: new Set(), allowPast: false }).map((violation) => violation.code);
      assert.ok(!codes.includes("OUTSIDE_WORKING_HOURS") && !codes.includes("BUSY_CONFLICT") && !codes.includes("OUTSIDE_HORIZON") && !codes.includes("DURATION_MISMATCH"), codes.join(","));
    }),
    { numRuns: 200, seed: 5 },
  );
});

test("a solution that places nothing, or lacks a value, is refused in plain words", () => {
  const given = subject();
  const { mapping } = planModel(given, greedySchedule(given), "week");
  assert.throws(() => placedFromSolution({ status: "infeasible", values: {} }, mapping), /E_NO_SOLUTION/);
  assert.throws(() => placedFromSolution({ status: "optimal", values: {} }, mapping), /E_INPUT_SCHEMA/);
  assert.throws(() => planModel({ ...given, policy: { ...given.policy, max_minutes_per_day: 240 } }, greedySchedule(given), "week"), /E_UNSUPPORTED/);
});
