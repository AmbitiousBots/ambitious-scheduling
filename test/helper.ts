import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { isRecord } from "@ambitious/kit/domain/json";
import type { Calendar, Rule, Weekday } from "../src/domain/calendar.ts";
import type { Span } from "../src/domain/intervals.ts";
import type { World } from "../src/domain/plan.ts";
import { readSnapshot, type Policy } from "../src/domain/tasks.ts";

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export const object = (value: unknown): Readonly<Record<string, unknown>> => {
  assert.ok(isRecord(value), "Expected a JSON object");
  return value;
};

export const items = (value: unknown): readonly unknown[] => {
  assert.ok(Array.isArray(value), "Expected a JSON array");
  return value;
};

export const scratch = (t: TestContext): string => {
  const home = mkdtempSync(join(tmpdir(), "scheduling-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
};

export const NOW = "2026-01-05T00:00:00Z";

export const run = (home: string, command: string, input: unknown = undefined, now = NOW, seed = 7) => {
  const result = spawnSync(process.execPath, ["dist/ambitious-scheduling.mjs", ...command.split(" "), "--now", now, "--seed", String(seed)], {
    input: input === undefined ? "" : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, AMBITIOUS_HOME: home },
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.ifError(result.error);
  const parsed: unknown = JSON.parse(result.stdout);
  const envelope = object(parsed);
  assert.equal(result.stdout.trimEnd().split("\n").length, 1);
  assert.equal(envelope.module, "scheduling");
  assert.equal(envelope.command, command);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, envelope, data: object(envelope.data) };
};

export const success = (home: string, command: string, input: unknown = undefined, now?: string) => {
  const result = run(home, command, input, now);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.envelope.ok, true);
  return result.data;
};

export const refused = (home: string, command: string, input: unknown, code: string, now?: string) => {
  const result = run(home, command, input, now);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(object(items(result.envelope.errors)[0]).code, code, result.stdout);
  return result.data;
};

export const WORKDAYS: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR"];

export const rule = (days: readonly Weekday[] = WORKDAYS, start = "09:00", end = "17:00"): Rule => ({ days, start, end, valid_from: null, valid_to: null });

export const calendar = (id: string, tz = "UTC", rules: readonly Rule[] = [rule()], personRef: string | null = id, exceptions: readonly string[] = []): Calendar => ({
  id,
  version: 1,
  name: id,
  tz,
  kind: "person",
  person_ref: personRef,
  rules,
  exceptions,
});

export const POLICY: Policy = { block_minutes: 120, min_block_minutes: 15, max_minutes_per_day: null, hours_per_day: 8, default_estimate_days: 1, due: "soft" };

export const minute = (iso: string): number => Date.parse(iso) / 60_000;

export type TaskRow = {
  readonly id: string;
  readonly title?: string;
  readonly status?: string;
  readonly priority?: number;
  readonly estimate_days?: number | null;
  readonly due?: string | null;
  readonly assignee?: string | null;
  readonly labels?: readonly string[];
  readonly depends_on?: readonly string[];
  readonly updated_at?: string;
};

export const snapshotOf = (rows: readonly TaskRow[]): Readonly<Record<string, unknown>> => ({
  schema: "tasks-snapshot.v1",
  tasks: rows.map((row) => ({
    list: "default",
    title: `Work ${row.id}`,
    status: "todo",
    priority: 2,
    estimate_days: 1,
    due: null,
    assignee: null,
    labels: [],
    depends_on: [],
    updated_at: "2026-01-01T00:00:00.000Z",
    ...row,
  })),
});

export const world = (options: {
  readonly tasks: readonly TaskRow[];
  readonly calendars: readonly Calendar[];
  readonly horizon: Span;
  readonly now?: number;
  readonly policy?: Partial<Policy>;
  readonly busy?: ReadonlyMap<string, readonly Span[]>;
}): World => ({
  calendars: options.calendars,
  busy: options.busy ?? new Map(),
  horizon: options.horizon,
  now: options.now ?? options.horizon.start,
  policy: { ...POLICY, ...options.policy },
  snapshot: readSnapshot(snapshotOf(options.tasks), sha256),
  busyDigest: "0".repeat(64),
  tzdata: "test",
  calendarIds: null,
});

export const workPlanSnapshot = (): Readonly<Record<string, unknown>> => {
  const fixture = object(JSON.parse(readFileSync("test/fixtures/work-plan.json", "utf8")));
  return snapshotOf(
    items(fixture.tasks).map((entry) => {
      const task = object(entry);
      return {
        id: String(task.id),
        title: String(task.title),
        status: typeof task.status === "string" ? task.status : "todo",
        estimate_days: typeof task.estimate_days === "number" ? task.estimate_days : null,
        depends_on: items(task.depends_on ?? []).map(String),
      };
    }),
  );
};
