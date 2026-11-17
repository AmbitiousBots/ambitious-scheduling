import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const USAGE = `Usage: node examples/end-to-end/run.mjs --tasks <ambitious-tasks binary> [--scheduling <binary>] [--constraints <ambitious-constraints binary>] [--python <python3.13>] [--solver-limit <n>]

Plays the part of the bot for one planning request, start to finish, and prints
one JSON summary on stdout. Each module is a separate program; this script only
carries JSON from one to the next, which is all a bot does:

  1. ambitious-tasks       import the 104-task fixture, then list -> tasks-snapshot.v1
  2. ambitious-scheduling  calendars, working hours, busy time
  3. ambitious-scheduling  plan propose (greedy) and plan model -> constraint-model.v1
  4. ambitious-constraints solve -> constraint-solution.v1 (skipped without --constraints,
                           or when its pinned runtime is not installed)
  5. ambitious-scheduling  plan propose with the solution, checked independently
  6. ambitious-scheduling  plan commit (the step a person approves)
  7. ambitious-scheduling  plan task-updates -> ambitious-tasks update, one call per task
  8. ambitious-scheduling  plan holds -> calendar-holds.v1 proposal; the script stands in
                           for the calendar and records made-up event ids with holds record
  9. a second commit after a task changed: task-updates and holds for the new version

Every database is created in a temporary directory that is removed at the end.
AMBITIOUS_HOME is left as it is, because the constraints module finds its pinned
runtime there. --python names the Python 3.13 that runs the constraints module
(default: python3). No calendar service and no network is used.
`;

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
if (args.includes('--help') || flag('tasks') === undefined) {
  (args.includes('--help') ? process.stdout : process.stderr).write(USAGE);
  process.exit(args.includes('--help') ? 0 : 2);
}

const root = join(import.meta.dirname, '..', '..');
const binaries = {
  tasks: resolve(flag('tasks')),
  scheduling: resolve(flag('scheduling') ?? join(root, 'dist', 'ambitious-scheduling.mjs')),
  constraints: flag('constraints') === undefined ? null : resolve(flag('constraints')),
};
const solverLimit = Number(flag('solver-limit') ?? 20);
const NOW = '2026-01-05T08:00:00Z';
const scratch = mkdtempSync(join(tmpdir(), 'ambitious-end-to-end-'));
const say = (line) => process.stderr.write(`${line}\n`);

const launcher = (binary) => (extname(binary) === '.pyz' ? [flag('python') ?? 'python3', binary] : [process.execPath, binary]);

const call = (module, command, input, now = NOW) => {
  const [program, ...first] = launcher(binaries[module]);
  const result = spawnSync(program, [...first, ...command.split(' '), '--db', join(scratch, `${module}.sqlite`), '--now', now, '--seed', '7'], {
    input: input === undefined ? '' : JSON.stringify(input), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
  });
  assert.ifError(result.error);
  const answer = JSON.parse(result.stdout);
  assert.equal(answer.module, module);
  assert.equal(answer.command, command);
  return answer;
};

const ok = (module, command, input, now) => {
  const answer = call(module, command, input, now);
  assert.equal(answer.ok, true, `${module} ${command}: ${JSON.stringify(answer.errors)}`);
  return answer.data;
};

const snapshotOf = (now) => ({ schema: 'tasks-snapshot.v1', taken_at: now, tasks: ok('tasks', 'list', {}, now).tasks });
const lastEnd = (plan) => plan.blocks.reduce((latest, block) => (block.end > latest ? block.end : latest), '');

try {
  const fixture = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'work-plan.json'), 'utf8'));
  const imported = ok('tasks', 'import', { ...fixture, idem_key: 'example-import', actor: 'example-bot' });
  let tasks = snapshotOf(NOW);
  say(`1. tasks: imported the fixture, list returned ${tasks.tasks.length} tasks`);

  for (const [id, tz] of [['lead', 'America/Los_Angeles'], ['second', 'Europe/Berlin']]) {
    ok('scheduling', 'calendar add', { id, name: id, tz, idem_key: `calendar-${id}` });
    ok('scheduling', 'availability set', { calendar_id: id, expected_version: 1, rules: [{ days: ['MO', 'TU', 'WE', 'TH', 'FR'], start: '09:00', end: '17:00' }], idem_key: `hours-${id}` });
  }
  ok('scheduling', 'busy import', {
    calendar_id: 'lead', source: 'example-calendar', window: { start: '2026-01-05T00:00:00Z', end: '2026-01-12T00:00:00Z' }, taken_at: NOW,
    blocks: [{ start: '2026-01-06T18:00:00Z', end: '2026-01-06T20:00:00Z' }, { start: '2026-01-08T17:00:00Z', end: '2026-01-08T18:30:00Z' }], idem_key: 'busy-week-1',
  });
  say('2. scheduling: two calendars in two time zones, weekday working hours, one week of busy time');

  const request = { tasks, horizon: { start: '2026-01-05T00:00:00Z', end: '2026-07-06T00:00:00Z' }, policy: { block_minutes: 480 } };
  const greedy = ok('scheduling', 'plan propose', request);
  assert.deepEqual(greedy.violations, []);
  const { model, mapping } = ok('scheduling', 'plan model', request);
  say(`3. scheduling: greedy plan has ${greedy.plan.blocks.length} blocks ending ${lastEnd(greedy.plan)}; model has ${model.variables.length} variables and ${model.constraints.length} constraints`);

  let solved = null;
  let solver = { used: false, reason: 'no --constraints binary was given' };
  if (binaries.constraints !== null) {
    ok('constraints', 'selfcheck');
    const answer = call('constraints', 'solve', { model, limits: { deterministic_time: solverLimit } });
    if (answer.ok) {
      const { solution } = answer.data;
      assert.deepEqual(solution.checked.violations, []);
      solved = ok('scheduling', 'plan propose', { ...request, solution, mapping });
      assert.deepEqual(solved.violations, []);
      assert.ok(lastEnd(solved.plan) <= lastEnd(greedy.plan), 'the solver was given the greedy plan as a hint and must not do worse');
      solver = { used: true, status: solution.status, objective: solution.objective, bound: solution.bound, solver: solution.solver };
      say(`4. constraints: ${solution.status}, makespan ${solution.objective} minutes (bound ${solution.bound})`);
      say(`5. scheduling: the solver's plan ends ${lastEnd(solved.plan)} and passes the independent check`);
    } else {
      assert.equal(answer.errors[0].code, 'E_RUNTIME', JSON.stringify(answer.errors));
      solver = { used: false, reason: answer.errors[0].message };
      say(`4. constraints: skipped, ${answer.errors[0].message}`);
    }
  } else {
    say('4. constraints: skipped, no --constraints binary was given');
  }

  const chosen = (solved ?? greedy).plan;
  const first = ok('scheduling', 'plan commit', {
    plan_id: 'work', base_version: 0, digest: chosen.digest, tasks_digest: chosen.tasks_digest, plan: chosen, tasks, idem_key: 'commit-1', actor: 'example-owner',
  });
  const stale = call('scheduling', 'plan commit', {
    plan_id: 'work', base_version: 0, digest: greedy.plan.digest, tasks_digest: greedy.plan.tasks_digest, plan: greedy.plan, tasks, idem_key: 'commit-late', actor: 'someone-else',
  });
  assert.equal(stale.errors[0]?.code, 'E_STALE');
  say(`6. scheduling: committed plan "work" version ${first.version} (${chosen.solver}); a second writer on the old base got E_STALE`);

  const forward = (version, now) => {
    const { suggestedUpdates } = ok('scheduling', 'plan task-updates', { plan_id: 'work', version, tasks: snapshotOf(now) });
    for (const update of suggestedUpdates) ok('tasks', 'update', update, now);
    for (const update of suggestedUpdates.slice(0, 3)) ok('tasks', 'update', update, now);
    return suggestedUpdates.length;
  };
  const forwarded = forward(1, '2026-01-05T08:05:00Z');
  say(`7. tasks: applied ${forwarded} suggested updates; replaying three with the same idem_key changed nothing`);

  const calendar = new Map();
  const act = (version) => {
    const { holds } = ok('scheduling', 'plan holds', { plan_id: 'work', version });
    const records = holds.holds.flatMap((hold) => {
      if (hold.action === 'create') {
        const event = `event-${calendar.size + 1}`;
        calendar.set(hold.idempotency_key, event);
        return [{ idempotency_key: hold.idempotency_key, status: 'created', provider: 'example-calendar', event_id: event }];
      }
      if (hold.action === 'cancel') {
        assert.equal(calendar.get(hold.idempotency_key), hold.external.event_id);
        calendar.delete(hold.idempotency_key);
        return [{ idempotency_key: hold.idempotency_key, status: 'canceled', provider: 'example-calendar', event_id: hold.external.event_id }];
      }
      return [];
    });
    if (records.length > 0) ok('scheduling', 'holds record', { plan_id: 'work', records, idem_key: `holds-v${version}`, actor: 'example-bot' });
    const counts = { create: 0, keep: 0, cancel: 0 };
    for (const hold of holds.holds) counts[hold.action] += 1;
    return counts;
  };
  const holdsV1 = act(1);
  const again = ok('scheduling', 'plan holds', { plan_id: 'work', version: 1 }).summary;
  assert.deepEqual(again, { create: 0, keep: chosen.blocks.length, cancel: 0 });
  say(`8. holds: proposal for version 1 had ${holdsV1.create} to create; after recording them the same request proposes ${again.create} to create and ${again.keep} to keep`);

  const later = '2026-01-06T08:00:00Z';
  const firstOpen = tasks.tasks.find((task) => task.status === 'todo');
  ok('tasks', 'status', { id: firstOpen.id, status: 'done', idem_key: 'example-done', actor: 'example-owner' }, later);
  tasks = snapshotOf(later);
  const replanned = ok('scheduling', 'plan propose', { ...request, tasks, base_plan: { plan_id: 'work' } }, later);
  const changed = call('scheduling', 'plan commit', {
    plan_id: 'work', base_version: 1, digest: chosen.digest, tasks_digest: chosen.tasks_digest, plan: chosen, tasks, idem_key: 'commit-old-tasks', actor: 'example-owner',
  }, later);
  assert.equal(changed.errors[0]?.code, 'E_TASKS_CHANGED');
  const second = ok('scheduling', 'plan commit', {
    plan_id: 'work', base_version: 1, digest: replanned.plan.digest, tasks_digest: replanned.plan.tasks_digest, plan: replanned.plan, tasks, idem_key: 'commit-2', actor: 'example-owner',
  }, later);
  const diff = ok('scheduling', 'plan diff', { plan_id: 'work', from_version: 1, to_version: 2 }, later);
  const forwardedAgain = forward(2, '2026-01-06T08:05:00Z');
  const holdsV2 = act(2);
  const settled = ok('scheduling', 'plan holds', { plan_id: 'work', version: 2 }, later).summary;
  assert.deepEqual(settled, { create: 0, keep: replanned.plan.blocks.length, cancel: 0 });
  assert.equal(calendar.size, replanned.plan.blocks.length);
  say(`9. replan: ${firstOpen.id} was finished, the old proposal was refused with E_TASKS_CHANGED, version ${second.version} committed; holds: ${holdsV2.keep} kept, ${holdsV2.create} created, ${holdsV2.cancel} canceled`);

  process.stdout.write(`${JSON.stringify({
    tasks: { imported: imported.tasks?.length ?? tasks.tasks.length, listed: tasks.tasks.length },
    greedy: { blocks: greedy.plan.blocks.length, ends: lastEnd(greedy.plan), violations: greedy.violations.length },
    model: { variables: model.variables.length, constraints: model.constraints.length },
    solver,
    solved: solved === null ? null : { blocks: solved.plan.blocks.length, ends: lastEnd(solved.plan), violations: solved.violations.length },
    committed: [{ version: first.version, solver: chosen.solver, digest: first.digest }, { version: second.version, solver: replanned.plan.solver, digest: second.digest }],
    taskUpdates: [forwarded, forwardedAgain],
    holds: { version1: holdsV1, version2: holdsV2, eventsOnTheCalendar: calendar.size },
    diff: Object.fromEntries(Object.entries(diff).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])),
  })}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
