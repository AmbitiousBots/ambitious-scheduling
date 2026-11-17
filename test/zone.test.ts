import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { dateOfDayNumber, dayNumber, localAt, localText, offsetAt, parseDate, resolveLocal, wallMinute, weekdayOf } from "../src/domain/zone.ts";
import { minute } from "./helper.ts";

const ZONES = Intl.supportedValuesOf("timeZone");
const FROM = minute("1972-01-01T00:00:00Z");
const TO = minute("2037-12-31T00:00:00Z");

test("a time in a spring-forward gap resolves to the first valid instant after it", () => {
  assert.deepEqual(resolveLocal("America/Los_Angeles", { year: 2026, month: 3, day: 8, hour: 2, minute: 30 }), { minute: minute("2026-03-08T10:00:00Z"), note: "DST_GAP" });
  assert.deepEqual(resolveLocal("Europe/Paris", { year: 2026, month: 3, day: 29, hour: 2, minute: 0 }), { minute: minute("2026-03-29T01:00:00Z"), note: "DST_GAP" });
  assert.deepEqual(resolveLocal("Australia/Lord_Howe", { year: 2026, month: 10, day: 4, hour: 2, minute: 10 }), { minute: minute("2026-10-03T15:30:00Z"), note: "DST_GAP" });
});

test("a time in a fall-back overlap resolves to the earlier of its two instants", () => {
  assert.deepEqual(resolveLocal("America/Los_Angeles", { year: 2026, month: 11, day: 1, hour: 1, minute: 30 }), { minute: minute("2026-11-01T08:30:00Z"), note: "DST_OVERLAP" });
  assert.deepEqual(resolveLocal("Europe/Paris", { year: 2026, month: 10, day: 25, hour: 2, minute: 30 }), { minute: minute("2026-10-25T00:30:00Z"), note: "DST_OVERLAP" });
});

test("a whole local day that a zone skipped resolves to the first instant of the next day", () => {
  const resolved = resolveLocal("Pacific/Apia", { year: 2011, month: 12, day: 30, hour: 12, minute: 0 });
  assert.equal(resolved.note, "DST_GAP");
  assert.deepEqual(localAt("Pacific/Apia", resolved.minute), { year: 2011, month: 12, day: 31, hour: 0, minute: 0 });
});

test("an ordinary local time resolves to itself with no note, with the offset written out", () => {
  assert.deepEqual(resolveLocal("Asia/Kolkata", { year: 2026, month: 6, day: 1, hour: 9, minute: 0 }), { minute: minute("2026-06-01T03:30:00Z"), note: null });
  assert.equal(localText("Asia/Kolkata", minute("2026-06-01T03:30:00Z")), "2026-06-01T09:00:00+05:30");
  assert.equal(localText("America/St_Johns", minute("2026-01-01T12:00:00Z")), "2026-01-01T08:30:00-03:30");
});

test("in every zone and year, an instant's local time resolves back to that instant or, in an overlap, to its earlier twin", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: ZONES.length - 1 }), fc.integer({ min: FROM, max: TO }), (zoneIndex, instant) => {
      const zone = ZONES[zoneIndex] ?? "UTC";
      const local = localAt(zone, instant);
      const resolved = resolveLocal(zone, local);
      assert.notEqual(resolved.note, "DST_GAP");
      assert.equal(wallMinute(localAt(zone, resolved.minute)), wallMinute(local));
      if (resolved.note === null) assert.equal(resolved.minute, instant);
      else assert.ok(resolved.minute <= instant);
    }),
    { numRuns: 3000, seed: 20260105 },
  );
});

test("in every zone and year, any wall-clock time resolves to an instant at or after it, exactly when it exists and at the first valid instant when it does not", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: ZONES.length - 1 }),
      fc.integer({ min: 1972, max: 2037 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 1, max: 28 }),
      fc.integer({ min: 0, max: 23 }),
      fc.integer({ min: 0, max: 59 }),
      (zoneIndex, year, month, day, hour, minuteOfHour) => {
        const zone = ZONES[zoneIndex] ?? "UTC";
        const local = { year, month, day, hour, minute: minuteOfHour };
        const resolved = resolveLocal(zone, local);
        const wall = wallMinute(local);
        const back = wallMinute(localAt(zone, resolved.minute));
        if (resolved.note === "DST_GAP") {
          assert.ok(back > wall);
          assert.ok(wallMinute(localAt(zone, resolved.minute - 1)) < wall);
        } else {
          assert.equal(back, wall);
        }
        if (resolved.note === "DST_OVERLAP") {
          const shift = offsetAt(zone, resolved.minute) - offsetAt(zone, resolved.minute + 24 * 60);
          assert.ok(shift > 0);
          assert.equal(wallMinute(localAt(zone, resolved.minute + shift)), wall);
        }
      },
    ),
    { numRuns: 3000, seed: 20260106 },
  );
});

test("day numbers, dates and weekdays agree with the calendar", () => {
  assert.equal(weekdayOf(dayNumber({ year: 2026, month: 1, day: 5 })), 1);
  assert.equal(weekdayOf(dayNumber({ year: 1969, month: 12, day: 28 })), 0);
  assert.deepEqual(dateOfDayNumber(dayNumber({ year: 2024, month: 2, day: 29 })), { year: 2024, month: 2, day: 29 });
  assert.equal(parseDate("2026-02-30"), null);
  assert.equal(parseDate("2026-2-3"), null);
  assert.deepEqual(parseDate("2026-02-03"), { year: 2026, month: 2, day: 3 });
});
