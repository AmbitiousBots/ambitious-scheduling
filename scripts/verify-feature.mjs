import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [feature] = process.argv.slice(2);
assert.ok(process.env.AMBITIOUS_HOME, 'Set AMBITIOUS_HOME to a fresh directory.');
const now = '2026-01-05T00:00:00Z';
const invoke = (command, input) => {
  const result = spawnSync(process.execPath, ['dist/ambitious-scheduling.mjs', ...command.split(' '), '--now', now, '--seed', '7'], {
    input: input === undefined ? '' : JSON.stringify(input), encoding: 'utf8', env: process.env, maxBuffer: 256 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.stdout.trimEnd().split('\n').length, 1, result.stderr);
  const answer = JSON.parse(result.stdout);
  assert.equal(answer.module, 'scheduling');
  assert.equal(answer.command, command);
  assert.deepEqual(Object.keys(answer), ['ok', 'schemaVersion', 'module', 'command', 'data', 'errors', 'meta']);
  return { ...result, answer };
};
const ok = (command, input) => {
  const result = invoke(command, input);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.answer.ok, true);
  return result.answer.data;
};
const refused = (command, input, code) => {
  const result = invoke(command, input);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.answer.errors[0].code, code);
};
const hashDb = () => createHash('sha256').update(readFileSync(join(process.env.AMBITIOUS_HOME, 'scheduling/scheduling.sqlite'))).digest('hex');
const snapshot = () => ({
  schema: 'tasks-snapshot.v1',
  tasks: JSON.parse(readFileSync('test/fixtures/work-plan.json', 'utf8')).tasks.map((task) => ({
    id: task.id, title: task.title, status: task.status ?? 'todo', priority: 2, estimate_days: task.estimate_days ?? null, due: null, assignee: null,
    labels: [], depends_on: task.depends_on ?? [], updated_at: '2026-01-01T00:00:00.000Z',
  })),
});
const horizon = { start: '2026-01-05T00:00:00Z', end: '2026-07-06T00:00:00Z' };
const office = () => {
  ok('calendar add', { id: 'lead', name: 'Lead', tz: 'America/Los_Angeles', idem_key: 'cal-lead' });
  ok('calendar add', { id: 'second', name: 'Second', tz: 'Europe/Berlin', idem_key: 'cal-second' });
  for (const id of ['lead', 'second']) {
    ok('availability set', { calendar_id: id, expected_version: 1, rules: [{ days: ['MO', 'TU', 'WE', 'TH', 'FR'], start: '09:00', end: '17:00' }], idem_key: `hours-${id}` });
  }
  ok('busy import', { calendar_id: 'lead', source: 'manual', window: { start: '2026-01-05T00:00:00Z', end: '2026-01-12T00:00:00Z' }, taken_at: now,
    blocks: [{ start: '2026-01-05T18:00:00Z', end: '2026-01-05T19:30:00Z' }], idem_key: 'busy-1' });
};
const propose = (policy = { block_minutes: 120 }) => ok('plan propose', { tasks: snapshot(), horizon, policy });
const commit = (plan, base, key) => ok('plan commit', { plan_id: 'work', base_version: base, digest: plan.digest, tasks_digest: plan.tasks_digest, plan, tasks: snapshot(), idem_key: key, actor: 'verify' });

const checks = {
  commands: () => {
    const { commands } = ok('commands');
    const expected = {
      'calendar add': 'write', 'calendar update': 'write', 'calendar get': 'read', 'calendar list': 'read', 'availability set': 'write', 'busy import': 'write',
      free: 'read', 'plan propose': 'read', 'plan model': 'read', 'plan check': 'read', 'plan commit': 'write', 'plan clone': 'write', 'plan get': 'read',
      'plan list': 'read', 'plan history': 'read', 'plan diff': 'read', 'plan task-updates': 'read', 'plan holds': 'read', 'holds record': 'write',
      'holds list': 'read', selfcheck: 'write', commands: 'none',
    };
    assert.deepEqual(Object.fromEntries(commands.map((entry) => [entry.name, entry.access])), expected);
  },
  selfcheck: () => {
    const first = ok('selfcheck');
    assert.deepEqual(first.problems, []);
    assert.equal(first.db.integrityCheck, 'ok');
    assert.equal(first.db.userVersion, 1);
    assert.equal(first.runtime.name, 'node');
    assert.match(first.binary.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(ok('selfcheck').db.migrationsApplied, []);
  },
  calendars: () => {
    office();
    refused('calendar update', { id: 'lead', expected_version: 1, patch: { name: 'Desk' }, idem_key: 'stale' }, 'E_STALE');
    assert.equal(ok('calendar update', { id: 'lead', expected_version: 2, patch: { name: 'Desk' }, idem_key: 'fresh' }).calendar.version, 3);
    const free = ok('free', { calendar_ids: ['lead'], from: '2026-03-06T00:00:00Z', to: '2026-03-10T00:00:00Z' }).calendars[0].free;
    assert.deepEqual(free.map((span) => span.local_start), ['2026-03-05T16:00:00-08:00', '2026-03-06T09:00:00-08:00', '2026-03-09T09:00:00-07:00']);
  },
  propose: () => {
    office();
    const before = hashDb();
    const first = propose();
    assert.equal(first.plan.blocks.length > 100, true);
    assert.deepEqual([first.violations, first.unscheduled], [[], []]);
    assert.equal(new Set(first.plan.blocks.map((block) => block.task_id)).size, 101);
    assert.deepEqual(propose(), first);
    assert.equal(hashDb(), before);
    assert.deepEqual(ok('plan check', { plan: first.plan, tasks: snapshot() }).errors, 0);
  },
  commit: () => {
    office();
    const plan = propose().plan;
    assert.equal(commit(plan, 0, 'c1').version, 1);
    assert.equal(commit(plan, 0, 'c1').version, 1);
    refused('plan commit', { plan_id: 'work', base_version: 0, digest: plan.digest, tasks_digest: plan.tasks_digest, plan, idem_key: 'c-late' }, 'E_STALE');
    refused('plan commit', { plan_id: 'work', base_version: 1, digest: plan.digest, tasks_digest: plan.tasks_digest, plan: { ...plan, blocks: plan.blocks.slice(1) }, idem_key: 'c-cut' }, 'E_DIGEST');
    const changed = snapshot();
    changed.tasks[0].updated_at = '2026-01-04T00:00:00.000Z';
    refused('plan commit', { plan_id: 'work', base_version: 1, digest: plan.digest, tasks_digest: plan.tasks_digest, plan, tasks: changed, idem_key: 'c-changed' }, 'E_TASKS_CHANGED');
    const next = propose({ block_minutes: 240 }).plan;
    assert.equal(commit(next, 1, 'c2').version, 2);
    const diff = ok('plan diff', { plan_id: 'work', from_version: 1, to_version: 2 });
    assert.equal(diff.removed.length > 0, true);
    const clone = ok('plan clone', { plan_id: 'work', version: 1, new_id: 'copy', idem_key: 'k1' });
    assert.deepEqual(clone.forked_from, { plan_id: 'work', version: 1 });
    assert.equal(ok('plan get', { plan_id: 'work' }).plan.version, 2);
    assert.deepEqual(ok('plan get', { plan_id: 'copy' }).plan.blocks, plan.blocks);
  },
  flow: () => {
    office();
    const plan = propose().plan;
    commit(plan, 0, 'c1');
    const updates = ok('plan task-updates', { plan_id: 'work', tasks: snapshot() });
    assert.equal(updates.suggestedUpdates.length, 101);
    assert.match(updates.suggestedUpdates[0].idem_key, /^sched:work:1:/);
    const holds = ok('plan holds', { plan_id: 'work' });
    assert.deepEqual(holds.summary, { create: plan.blocks.length, keep: 0, cancel: 0 });
    const records = holds.holds.holds.map((hold, index) => ({ idempotency_key: hold.idempotency_key, status: 'created', provider: 'example-calendar', event_id: `event-${index}` }));
    ok('holds record', { plan_id: 'work', records, idem_key: 'r1' });
    assert.deepEqual(ok('plan holds', { plan_id: 'work' }).summary, { create: 0, keep: plan.blocks.length, cancel: 0 });
    assert.deepEqual(ok('plan holds', { plan_id: 'work', cancel_all: true }).summary, { create: 0, keep: 0, cancel: plan.blocks.length });
  },
  model: () => {
    office();
    const input = { tasks: snapshot(), horizon, policy: { block_minutes: 480 } };
    const { model, mapping } = ok('plan model', input);
    assert.equal(model.schema, 'constraint-model.v1');
    const solution = { schema: 'constraint-solution.v1', model: { name: model.name, digest: 'a'.repeat(64) }, status: 'feasible', values: model.hints, solver: { name: 'cp-sat', version: '9.15.6755', seed: 7 } };
    const solved = ok('plan propose', { ...input, solution, mapping });
    assert.deepEqual([solved.plan.solver, solved.violations], ['constraints', []]);
  },
};
assert.ok(feature in checks, `Unknown feature "${feature}". Use one of: ${Object.keys(checks).join(', ')}.`);
checks[feature]();
