import type { Calendar, DstEvent } from "./calendar.ts";
import { canonical, compareText, minuteIso, type Hasher } from "./input.ts";
import type { Span } from "./intervals.ts";
import type { Policy, Snapshot } from "./tasks.ts";
import { localText } from "./zone.ts";

export type Placed = { readonly task_id: string; readonly calendar_id: string; readonly seq: number; readonly start: number; readonly end: number };

export type Unscheduled = { readonly task_id: string; readonly code: string; readonly message: string };

export type World = {
  readonly calendars: readonly Calendar[];
  readonly busy: ReadonlyMap<string, readonly Span[]>;
  readonly horizon: Span;
  readonly now: number;
  readonly policy: Policy;
  readonly snapshot: Snapshot;
  readonly busyDigest: string;
  readonly tzdata: string;
  readonly calendarIds: readonly string[] | null;
};

export type Block = {
  readonly task_id: string;
  readonly calendar_id: string;
  readonly seq: number;
  readonly start: string;
  readonly end: string;
  readonly local_start?: string;
  readonly local_end?: string;
  readonly tz?: string;
  readonly title?: string;
};

export type PlanDoc = {
  readonly schema: "schedule-plan.v1";
  readonly plan_id?: string;
  readonly version?: number;
  readonly forked_from?: { readonly plan_id: string; readonly version: number } | null;
  readonly status: "proposed" | "committed";
  readonly horizon: { readonly start: string; readonly end: string };
  readonly policy: Policy;
  readonly tasks_digest: string;
  readonly busy_digest: string;
  readonly tzdata: string;
  readonly solver: "greedy" | "constraints";
  readonly blocks: readonly Block[];
  readonly unscheduled: readonly Unscheduled[];
  readonly digest: string;
  readonly calendar_ids?: readonly string[];
};

export const comparePlaced = (a: Placed, b: Placed): number =>
  a.start - b.start || compareText(a.calendar_id, b.calendar_id) || compareText(a.task_id, b.task_id) || a.seq - b.seq;

export const compareBlocks = (a: Block, b: Block): number =>
  compareText(a.start, b.start) || compareText(a.calendar_id, b.calendar_id) || compareText(a.task_id, b.task_id) || a.seq - b.seq;

type Digested = Pick<PlanDoc, "horizon" | "policy" | "tasks_digest" | "busy_digest" | "blocks">;

export const planDigest = (plan: Digested, sha256: Hasher): string =>
  sha256(
    canonical({
      horizon: { start: plan.horizon.start, end: plan.horizon.end },
      policy: plan.policy,
      tasks_digest: plan.tasks_digest,
      busy_digest: plan.busy_digest,
      blocks: plan.blocks
        .toSorted(compareBlocks)
        .map(({ task_id, calendar_id, seq, start, end }) => ({ task_id, calendar_id, seq, start, end })),
    }),
  );

export const proposedPlan = (
  world: World,
  placed: readonly Placed[],
  unscheduled: readonly Unscheduled[],
  solver: PlanDoc["solver"],
  sha256: Hasher,
): PlanDoc => {
  const zones = new Map(world.calendars.map((calendar) => [calendar.id, calendar.tz]));
  const titles = new Map(world.snapshot.tasks.map((task) => [task.id, task.title]));
  const blocks = placed.toSorted(comparePlaced).map((block): Block => {
    const zone = zones.get(block.calendar_id);
    const title = titles.get(block.task_id);
    return {
      task_id: block.task_id,
      calendar_id: block.calendar_id,
      seq: block.seq,
      start: minuteIso(block.start),
      end: minuteIso(block.end),
      ...(zone === undefined ? {} : { local_start: localText(zone, block.start), local_end: localText(zone, block.end), tz: zone }),
      ...(title === undefined ? {} : { title }),
    };
  });
  const body = {
    horizon: { start: minuteIso(world.horizon.start), end: minuteIso(world.horizon.end) },
    policy: world.policy,
    tasks_digest: world.snapshot.digest,
    busy_digest: world.busyDigest,
    blocks,
  };
  return {
    schema: "schedule-plan.v1",
    status: "proposed",
    ...body,
    tzdata: world.tzdata,
    solver,
    unscheduled: unscheduled.toSorted((a, b) => compareText(a.task_id, b.task_id)),
    digest: planDigest(body, sha256),
    ...(world.calendarIds === null ? {} : { calendar_ids: world.calendarIds.toSorted(compareText) }),
  };
};

export type BlockChange = { readonly task_id: string; readonly seq: number; readonly from?: Block; readonly to?: Block };

const slot = (block: Block): string => `${block.task_id}\u0000${block.seq}`;

const same = (a: Block, b: Block): boolean => a.start === b.start && a.end === b.end && a.calendar_id === b.calendar_id;

export const diffBlocks = (
  from: readonly Block[],
  to: readonly Block[],
): { readonly added: readonly Block[]; readonly removed: readonly Block[]; readonly moved: readonly BlockChange[]; readonly unchanged: number } => {
  const before = new Map(from.map((block) => [slot(block), block]));
  const after = new Map(to.map((block) => [slot(block), block]));
  const kept = to.filter((block) => before.has(slot(block)));
  return {
    added: to.filter((block) => !before.has(slot(block))).toSorted(compareBlocks),
    removed: from.filter((block) => !after.has(slot(block))).toSorted(compareBlocks),
    moved: kept.flatMap((block) => {
      const earlier = before.get(slot(block));
      return earlier === undefined || same(earlier, block) ? [] : [{ task_id: block.task_id, seq: block.seq, from: earlier, to: block }];
    }),
    unchanged: kept.filter((block) => {
      const earlier = before.get(slot(block));
      return earlier !== undefined && same(earlier, block);
    }).length,
  };
};

export const dstNotes = (notes: readonly DstEvent[]): readonly DstEvent[] =>
  notes.toSorted((a, b) => compareText(a.calendar_id, b.calendar_id) || compareText(a.date, b.date) || compareText(a.code, b.code));
