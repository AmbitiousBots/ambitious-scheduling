import { canonical, compareText, type Hasher } from "./input.ts";

export const OPEN_STATUSES = ["todo", "in_progress", "blocked", "waiting"] as const;

export type SnapshotTask = {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly priority: number;
  readonly estimate_days: number | null;
  readonly due: string | null;
  readonly assignee: string | null;
  readonly labels: readonly string[];
  readonly depends_on: readonly string[];
  readonly updated_at: string;
};

export type Snapshot = { readonly tasks: readonly SnapshotTask[]; readonly digest: string };

type Raw = Readonly<Record<string, unknown>>;

const strings = (value: unknown): readonly string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

export const tasksDigest = (tasks: readonly { readonly id: string; readonly updated_at: string }[], sha256: Hasher): string =>
  sha256(canonical(tasks.map((task) => [task.id, task.updated_at] as const).toSorted(([a], [b]) => compareText(a, b))));

export const readSnapshot = (raw: Raw, sha256: Hasher): Snapshot => {
  const rows = Array.isArray(raw.tasks) ? raw.tasks.filter((row): row is Raw => typeof row === "object" && row !== null) : [];
  const tasks = rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    status: String(row.status),
    priority: typeof row.priority === "number" ? row.priority : 2,
    estimate_days: typeof row.estimate_days === "number" ? row.estimate_days : null,
    due: typeof row.due === "string" ? row.due : null,
    assignee: typeof row.assignee === "string" ? row.assignee : null,
    labels: strings(row.labels),
    depends_on: strings(row.depends_on),
    updated_at: String(row.updated_at),
  }));
  return { tasks, digest: tasksDigest(tasks, sha256) };
};

export const isOpen = (task: SnapshotTask): boolean => OPEN_STATUSES.some((status) => status === task.status);

export type Policy = {
  readonly block_minutes: number;
  readonly min_block_minutes: number;
  readonly max_minutes_per_day: number | null;
  readonly hours_per_day: number;
  readonly default_estimate_days: number;
  readonly due: "soft" | "hard";
};

export const effortMinutes = (task: SnapshotTask, policy: Policy): number =>
  Math.round((task.estimate_days ?? policy.default_estimate_days) * policy.hours_per_day * 60);
