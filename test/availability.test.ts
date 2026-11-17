import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { dueMinute, parseExceptions, parseRules, WEEKDAYS, workingWindows, type Weekday } from "../src/domain/calendar.ts";
import { dateText, localAt, dayNumber, weekdayOf } from "../src/domain/zone.ts";
import { calendar, minute, rule } from "./helper.ts";

const ZONES = ["UTC", "America/New_York", "Europe/Berlin", "Australia/Sydney", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Auckland", "Asia/Tokyo"];
const STEP = 5;

const clock = fc.integer({ min: 4 * 12, max: 24 * 12 }).map((steps) => steps * STEP);
const clockText = (minutes: number): string => (minutes === 1440 ? "24:00" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);

const ruleArb = fc
  .record({ days: fc.subarray([...WEEKDAYS], { minLength: 1 }), a: clock, b: clock })
  .filter(({ a, b }) => a !== b && Math.min(a, b) < 1440)
  .map(({ days, a, b }) => rule(days, clockText(Math.min(a, b)), clockText(Math.max(a, b))));

test("working windows match a walk over every five minutes of local time, in zones with and without daylight saving", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...ZONES),
      fc.array(ruleArb, { minLength: 1, maxLength: 3 }),
      fc.integer({ min: minute("2024-01-01T00:00:00Z") / STEP, max: minute("2028-12-01T00:00:00Z") / STEP }),
      fc.integer({ min: 1, max: 9 * 24 * 12 }),
      fc.array(fc.integer({ min: 0, max: 9 }), { maxLength: 2 }),
      (zone, rules, startStep, lengthSteps, excludedOffsets) => {
        const bounds = { start: startStep * STEP, end: (startStep + lengthSteps) * STEP };
        const firstDay = dayNumber(localAt(zone, bounds.start));
        const exceptions = excludedOffsets.map((offset) => {
          const local = localAt(zone, (firstDay + offset) * 1440);
          return dateText(local);
        });
        const subject = calendar("c", zone, rules, "c", exceptions);
        const { spans } = workingWindows(subject, bounds);
        const inside = (at: number): boolean => spans.some((span) => span.start <= at && at < span.end);
        for (let at = bounds.start; at < bounds.end; at += STEP) {
          const local = localAt(zone, at);
          const weekday: Weekday | undefined = WEEKDAYS[weekdayOf(dayNumber(local))];
          const time = local.hour * 60 + local.minute;
          const expected =
            !exceptions.includes(dateText(local)) &&
            rules.some((entry) => weekday !== undefined && entry.days.includes(weekday) && clockText(time) >= entry.start && (entry.end === "24:00" || clockText(time) < entry.end));
          assert.equal(inside(at), expected, `${zone} ${new Date(at * 60_000).toISOString()}`);
        }
        assert.ok(spans.every((span, index) => span.start < span.end && span.start >= bounds.start && span.end <= bounds.end && (index === 0 || (spans[index - 1]?.end ?? 0) < span.start)));
      },
    ),
    { numRuns: 60, seed: 11 },
  );
});

test("a working day that starts in a skipped hour starts at the first valid time, and the note says so", () => {
  const subject = calendar("c", "America/Los_Angeles", [rule(["SU"], "02:30", "06:00")]);
  const windows = workingWindows(subject, { start: minute("2026-03-07T00:00:00Z"), end: minute("2026-03-10T00:00:00Z") });
  assert.deepEqual(windows.spans, [{ start: minute("2026-03-08T10:00:00Z"), end: minute("2026-03-08T13:00:00Z") }]);
  assert.deepEqual(windows.notes.map((note) => [note.date, note.code]), [["2026-03-08", "DST_GAP"]]);
});

test("a working day that starts in a repeated hour starts at its first occurrence, and the note says so", () => {
  const subject = calendar("c", "America/Los_Angeles", [rule(["SU"], "01:30", "03:00")]);
  const windows = workingWindows(subject, { start: minute("2026-10-31T00:00:00Z"), end: minute("2026-11-03T00:00:00Z") });
  assert.deepEqual(windows.spans, [{ start: minute("2026-11-01T08:30:00Z"), end: minute("2026-11-01T11:00:00Z") }]);
  assert.deepEqual(windows.notes.map((note) => note.code), ["DST_OVERLAP"]);
});

test("validity dates and days off bound a rule", () => {
  const rules = parseRules([{ days: ["MO", "TU"], start: "09:00", end: "10:00", valid_from: "2026-01-06", valid_to: "2026-01-12" }]);
  const subject = calendar("c", "UTC", rules, "c", parseExceptions(["2026-01-12"]));
  const windows = workingWindows(subject, { start: minute("2026-01-01T00:00:00Z"), end: minute("2026-02-01T00:00:00Z") });
  assert.deepEqual(windows.spans, [{ start: minute("2026-01-06T09:00:00Z"), end: minute("2026-01-06T10:00:00Z") }]);
});

test("rules are refused when a field is wrong, and the weekly rule text form is accepted", () => {
  assert.deepEqual(parseRules([{ rrule: "FREQ=WEEKLY;BYDAY=TU,MO", start: "09:00", end: "24:00" }])[0]?.days, ["MO", "TU"]);
  for (const bad of [
    [{ days: [], start: "09:00", end: "10:00" }],
    [{ days: ["MO"], start: "10:00", end: "09:00" }],
    [{ days: ["MO"], start: "9:00", end: "10:00" }],
    [{ days: ["XX"], start: "09:00", end: "10:00" }],
    [{ rrule: "FREQ=DAILY", start: "09:00", end: "10:00" }],
    [{ days: ["MO"], start: "09:00", end: "10:00", valid_from: "2026-02-30" }],
    [{ days: ["MO"], start: "09:00", end: "10:00", extra: 1 }],
  ]) {
    assert.throws(() => parseRules(bad), /E_INPUT_SCHEMA/);
  }
});

test("a due date is the end of that local day, and a due instant is itself", () => {
  assert.equal(dueMinute("America/Los_Angeles", "2026-01-09"), minute("2026-01-10T08:00:00Z"));
  assert.equal(dueMinute("UTC", "2026-01-09T12:00:00Z"), minute("2026-01-09T12:00:00Z"));
  assert.equal(dueMinute("UTC", "soon"), null);
});
