# ambitious-scheduling

Ambitious Scheduling is a command-line module that owns time for a bot: calendars with time zones, working hours, imported busy time, and versioned plans that place tasks into blocks of free working time. It proposes a plan, checks it with a separate checker, stores it only when the bot commits the plan the person approved, and then hands the bot two proposals: the task updates to forward to a task module, and the calendar holds the bot may create through its own calendar connectors. Every command reads JSON and returns one JSON envelope. There is no user interface, document rendering, network access or AI key requirement.

Part of [Ambitious](https://ambitiousbots.com). The shared [module contract](MODULE_CONTRACT.md) defines the envelope, installation, database and runtime rules, and how data crosses between modules (Part 5).

The module never calls another module and never contacts a calendar service. Tasks arrive as a `tasks-snapshot.v1` document the bot built from a task module's `list` rows. Busy time arrives as JSON the bot read through its own connectors. What leaves is JSON the bot forwards after the person approves.

## Run

The release contains `ambitious-scheduling-0.1.1.mjs` and `SHA256SUMS`. Verify the checksum before running the file with Node 24. The binary includes its dependencies and migrations; it needs no npm install or other repository files.

```sh
shasum -a 256 -c SHA256SUMS
export AMBITIOUS_HOME="$(mktemp -d)"
node ambitious-scheduling-0.1.1.mjs selfcheck
printf '%s\n' '{"id":"sam","name":"Sam","tz":"Europe/Paris","person_ref":"sam","idem_key":"add-sam"}' | node ambitious-scheduling-0.1.1.mjs calendar add
```

The command words are separate arguments: `ambitious-scheduling calendar add`, `ambitious-scheduling plan propose`. Choose a persistent `AMBITIOUS_HOME` for real work. The default is `/workspace/ambitious`, the module storage directory on a Grok Bot computer. The database lives at `$AMBITIOUS_HOME/scheduling/scheduling.sqlite`; `--db` overrides that file. Modules refuse `/home/box/agent-data`, the bot's private state directory, including paths that reach it through symbolic links.

The kit's [installer](https://github.com/AmbitiousBots/ambitious-kit#start-a-module-on-the-kit) verifies release checksums and installs an exact version under `$AMBITIOUS_HOME/bin`. Run `selfcheck` at every routine start.

## JSON interface

```text
ambitious-scheduling <command> [--in input.json] [--db scheduling.sqlite] [--now ISO8601] [--seed integer] [--json] [--help]
```

Pass one JSON object on stdin or with `--in`, never both. Every response is one line with `{ ok, schemaVersion, module, command, data, errors, meta }`. Successful commands exit 0; caller errors exit 1; database and internal failures exit 2. The same binary, database state, input, `--now` and `--seed` produce identical stdout bytes. `--now` is the earliest moment a plan may start: nothing is placed in the past. Every instant in output is UTC with a `Z`; local times carry their offset and the calendar's zone.

`--help` answers with one envelope and exit 0. With no command name it lists every command, the same as `commands`. With a command name, `data.commands` holds that one command. It does not run the command, read input or open the database.

| Command | Access | Input | Result in `data` |
|---|---|---|---|
| `commands` | none | none | `commands` with names, access and input requirements |
| `selfcheck` | write | none | runtime, binary SHA-256, database integrity, applied migrations, problems |
| `calendar add` | write | `{id, name?, tz, kind?, person_ref?, idem_key, actor?}` | `calendar` at version 1 |
| `calendar update` | write | `{id, expected_version, patch:{name?, tz?, kind?, person_ref?}, idem_key, actor?}` | `calendar` |
| `calendar get` | read | `{id}` | `calendar`, `busy` (imported snapshots) |
| `calendar list` | read | none | `calendars` |
| `availability set` | write | `{calendar_id, expected_version, rules:[...], exceptions?:[dates], idem_key, actor?}` | `calendar` |
| `busy import` | write | `{calendar_id, source, window:{start,end}, taken_at, blocks:[{start,end,label?}], idem_key, actor?}` | `snapshot`, `action` (`imported`, `replaced`, `unchanged`) |
| `free` | read | `{calendar_ids?, from, to, min_minutes?}` | per calendar: `free` intervals in UTC and local time, `free_minutes`, DST `notes`; `tzdata` |
| `plan propose` | read | `{tasks, horizon:{start,end}, policy?, calendar_ids?, base_plan?, solution?, mapping?}` | `plan` (a `schedule-plan.v1`, status `proposed`), `violations`, `unscheduled`, `notes`, `diff?`, `tzdata` |
| `plan check` | read | `{tasks, plan}` or `{tasks, plan_id, version?}` or `{tasks, blocks, horizon, policy?}`; `calendar_ids?` | `violations`, `errors`, `warnings`, `tasks_changed`, `calendars_changed` |
| `plan model` | read | same as `plan propose`, plus `name?` | `model` (a `constraint-model.v1`), `mapping`, `unscheduled`, digests |
| `plan commit` | write | `{plan_id, base_version, digest, tasks_digest, plan, tasks?, allow_violations?, idem_key, actor?}` | `plan_id`, `version`, `digest`, `blocks`, `violations` |
| `plan clone` | write | `{plan_id, version?, new_id, idem_key, actor?}` | `plan_id`, `version` 1, `forked_from` |
| `plan get` | read | `{plan_id, version?}` | `plan` (status `committed`), `committed_at`, `actor` |
| `plan list` | read | none | `plans` |
| `plan history` | read | `{plan_id}` | `plan`, `versions`, `events` |
| `plan diff` | read | `{plan_id, from_version, to_version}` | `added`, `removed`, `moved`, `unchanged` |
| `plan task-updates` | read | `{plan_id, version?, tasks}` | `suggestedUpdates`, `scheduled`, `notes`, `skipped`, `label` |
| `plan holds` | read | `{plan_id, version?, cancel_all?}` | `holds` (a `calendar-holds.v1`), `summary` |
| `holds record` | write | `{plan_id, records:[{idempotency_key, status, provider, event_id?, calendar?, note?}], idem_key, actor?}` | `recorded`, `totals` |
| `holds list` | read | `{plan_id}` | `records` |

Read commands open the database read-only and store nothing. A read command on a database that does not exist yet fails with `E_MIGRATION`; run `selfcheck` first.

### Module error codes

| Code | Exit | Meaning | Typical hint |
|---|---|---|---|
| `E_NOT_FOUND` | 1 | The calendar, plan or plan version named in the input does not exist. | Use `calendar list`, `plan list` or `plan history` to find it. |
| `E_DUPLICATE` | 1 | `calendar add` or `plan clone` named an id that is already in use. | Update the existing one, or choose a new id. |
| `E_STALE` | 1 | `expected_version` or `base_version` is not the current version: someone else wrote first. `data` has `current_version`. | Read again, redo the change on what is there now, send it with a new `idem_key`. |
| `E_DIGEST` | 1 | The plan passed to `plan commit` is not the plan its `digest` names. | Commit the plan exactly as `plan propose` returned it. |
| `E_TASKS_CHANGED` | 1 | A task changed after the plan was proposed, or the `tasks_digest` passed is not the plan's. | Propose again from the current tasks snapshot and ask for approval again. |
| `E_CALENDAR_CHANGED` | 1 | Working hours or busy time changed after the plan was proposed. | Propose again and ask for approval again. |
| `E_VIOLATIONS` | 1 | The plan has violations of severity `error`; they are in `data.violations`. | Propose a plan without them, or pass `allow_violations: true` after the person accepted them. |
| `E_IDEM_CONFLICT` | 1 | The `idem_key` already identifies a different request. | Retry the original request unchanged, or use a new key. |
| `E_NO_SOLUTION` | 1 | The constraint solution passed to `plan propose` is `infeasible` or `unknown`, so it places nothing. | Ask the constraint module to explain, or use the plan proposed without a solution. |
| `E_UNSUPPORTED` | 1 | `plan model` was asked for a policy it cannot express (`max_minutes_per_day`). | Leave that field out for `plan model`. |
| `E_UNKNOWN_HOLD` | 1 | `holds record` named a key no version of the plan has. | Record only keys `plan holds` returned. |
| `E_HOLD_STATE` | 1 | A hold is recorded as created twice with different events, or canceled without ever being created. | Keep the first event, or record in the order things happened. |

## The scheduling model

Version 0.1.0 is deliberately simple. What it does:

- **Calendars.** A calendar is `{id, name, tz, kind, person_ref}`. `tz` is an IANA zone name. `kind` is `person` (default), `resource` or `team`. `person_ref` is matched against a task's `assignee`.
- **Working hours.** `availability set` replaces a calendar's weekly rules and days off. A rule is `{days:["MO",...], start:"09:00", end:"17:00", valid_from?, valid_to?}` in the calendar's local wall time; `end` may be `24:00`; `{rrule:"FREQ=WEEKLY;BYDAY=MO,TU", start, end}` is accepted as another way to write `days`. `exceptions` is a list of local dates with no working hours. A start or end that falls in the hour skipped when clocks go forward moves to the first valid time after it (`DST_GAP`); one that falls in the hour repeated when clocks go back takes its first occurrence (`DST_OVERLAP`). Both are reported in `notes`.
- **Busy time.** `busy import` stores busy intervals the bot read from a calendar service. A later import for the same calendar, source and window replaces the earlier one; the same content again is `unchanged`. Labels are optional and never needed.
- **Free time** is working hours minus busy time.
- **Effort.** A task needs `estimate_days × hours_per_day × 60` minutes (defaults: 8 hours per day, 1 day when a task has no estimate). Only open tasks (`todo`, `in_progress`, `blocked`, `waiting`) are placed. A prerequisite that is `done` is satisfied. A prerequisite that is canceled, or that is not in the snapshot, leaves its dependents unscheduled with `DEPENDENCY_OPEN`.
- **Policy.** `{block_minutes (default 120, 5 to 1440), min_block_minutes (default 15), max_minutes_per_day?, hours_per_day (8), default_estimate_days (1), due ("soft" or "hard")}`.
- **`plan propose`** is a greedy serial scheduler. It takes the ready task with the earliest due date, then the lowest priority number, then the lowest id; places it on the calendar whose `person_ref` is the task's assignee, or, for a task with no assignee, on whichever of the calendars would finish it first (ties by calendar id); and fills that calendar's free time from the later of `--now`, the horizon start and the end of every prerequisite, in blocks of at most `block_minutes`. A task that does not fit inside the horizon is listed in `unscheduled` with `NO_FEASIBLE_SLOT`, and nothing of it is placed. It stores nothing.
- **`plan check`** is a separate checker that shares no placement code with the scheduler. Its codes extend the task module's schedule vocabulary: `OVERLAP`, `OUTSIDE_HORIZON`, `DEPENDENCY_OPEN`, `DURATION_MISMATCH`, `ASSIGNEE_MISMATCH`, `CLOSED_TASK`, `UNKNOWN_TASK`, `UNKNOWN_CALENDAR`, `DUPLICATE_BLOCK`, `INVALID_INTERVAL`, `OUTSIDE_WORKING_HOURS`, `BUSY_CONFLICT`, `BLOCK_TOO_LONG`, `MULTIPLE_CALENDARS`, `SEQUENCE_ORDER`, `MAX_PER_DAY_EXCEEDED`, `IN_THE_PAST`, `PAST_DUE` and `NOT_SCHEDULED`. Each violation has a `severity`. `PAST_DUE` is a `warning` under `due: "soft"` and an `error` under `"hard"`; `NOT_SCHEDULED` is a `warning`; the rest are `error`. `plan propose` returns the checker's findings on its own output.
- **Digests.** `plan.tasks_digest` is the snapshot digest the `tasks-snapshot.v1` schema defines. `plan.busy_digest` covers the chosen calendars' zones, working hours and busy time inside the horizon. `plan.digest` covers the horizon, policy, both digests and the blocks.

What it does not do: a task has one assignee and its blocks stay on one calendar; there are no meetings, attendees or rooms booked together; the only recurrence is weekly working hours; busy time is whatever the bot last imported; and no calendar service is ever contacted. Dates in `due` are the end of that local day in the calendar's zone.

### Writes

`plan propose` is the dry run. `plan commit` is the only command that stores a plan, and it changes only the `plan_id` it is given:

1. It recomputes the digest of the plan it was passed and compares it with `digest` (`E_DIGEST`).
2. It compares `tasks_digest`, and the snapshot in `tasks` when given, with the digest the plan was proposed for (`E_TASKS_CHANGED`).
3. It compares `base_version` with the plan's current version, 0 for a plan that does not exist yet (`E_STALE`).
4. It recomputes the calendars' digest (`E_CALENDAR_CHANGED`) and, when `tasks` is given, runs the checker (`E_VIOLATIONS`).
5. It stores version `base_version + 1`. A stored version is never edited or deleted; the database refuses both.

`plan clone` is the only way to copy a plan: it creates `new_id` at version 1 with `forked_from` naming its source, and leaves the source as it was. Nothing branches silently. Calendar writes take `expected_version`. Every write takes an `idem_key`: a retry of the same request returns the stored answer, and the same key with a different request is `E_IDEM_CONFLICT`. A write's `actor`, when sent, is 1 to 200 Unicode characters, with no control characters or line breaks and no leading or trailing whitespace. Internal spaces are allowed and nothing is trimmed. When `actor` is left out, the stored actor is `caller`. Every write appends one row to an audit table that the database does not let anyone update or delete.

### Task updates

`plan task-updates` needs the current tasks snapshot. For every scheduled task it returns the exact input of the task module's `update` command: `{id, patch:{labels:[...]}, idem_key:"sched:<plan>:<version>:<task>", actor:"ambitious-scheduling"}`. The patch keeps the task's other labels and replaces any earlier `sched:<plan>@v<N>` label with the new one. It never changes a due date: a task the plan finishes after its due date is reported in `notes` as `FINISHES_AFTER_DUE`. The bot forwards the updates; this module never starts the task module. Forwarding them changes the tasks' `updated_at`, so the next proposal needs a fresh snapshot.

### Calendar holds

`plan holds` returns a `calendar-holds.v1` proposal for one committed version. Each hold has a title, `start` and `end` (`utc`, `local` with offset, `time_zone`), a `calendar_hint`, its `source` block and an `idempotency_key` of the form `hold:<plan_id>:<task_id>:<seq>:<16 hex>`, where the hex is the start of the SHA-256 of `calendar_id|start|end`. The key names the block's content and not the version, so an unchanged block keeps its key in a later version.

| `action` | When |
|---|---|
| `create` | No event is recorded as created for this key. |
| `keep` | An event is recorded as created for this key; `external` names it. |
| `cancel` | An event is recorded as created for a key of this plan that the requested version no longer has, or `cancel_all` was passed; `external` names it. |

After the person approves, the bot creates and cancels events with its own connectors and reports each one with `holds record`: `created` with the service's `event_id`, `canceled`, or `failed`. Asking `plan holds` again then proposes nothing twice. A clone has its own plan id and therefore its own keys: create holds for one of the two plans, not both.

### Constraint model

`plan model` takes the same input as `plan propose` and returns the same question as a `constraint-model.v1` for a constraint solver module, with a `mapping` from model variables back to blocks:

```json
{"unit":"minute","origin":"2026-01-05T00:00:00.000Z","blocks":[{"task_id":"draft","calendar_id":"sam","seq":0,"start_var":"b0_s","end_var":"b0_e","minutes":120}]}
```

Times are whole minutes after the horizon start. The model has one interval per block of the greedy plan, with the same block sizes; each start variable's domain is the list of ranges in which the block fits one stretch of free time; `precedence` constraints order a task's blocks and put each task after its prerequisites; one `no_overlap` per calendar; a due date is a `linear` constraint of category `goal`, `hard` or `soft` (weight 1440) by `policy.due`; `makespan` is minimized; and `hints` hold the greedy plan. Tasks the greedy scheduler could not place are left out and listed in `unscheduled`; a task with no assignee stays on the calendar the greedy scheduler chose. `max_minutes_per_day` is not expressed: `plan model` refuses it with `E_UNSUPPORTED`.

The bot passes `data.model` to the solver module and passes the `constraint-solution.v1` it gets back, with the unchanged `mapping`, to `plan propose` as `solution` and `mapping`. The blocks then come from the solution, `plan.solver` is `constraints`, and the same independent checker runs on them.

### Time zone data

Zone rules come from the time zone data built into Node. Every time-dependent answer reports its version in `data.tzdata`, and a plan stores it in `plan.tzdata`, because a change in zone rules can change which instant a local working hour is.

## Example

The dataset in `test/fixtures/work-plan.json` is the task module's example of 104 tasks and 105.5 estimated effort days, 101 of them open. With two calendars working weekdays 09:00 to 17:00 in two time zones and a horizon of 26 weeks from 2026-01-05, `plan propose` with 120-minute blocks places all 101 open tasks in 419 blocks, ending 2026-03-24, with no violations; with one calendar it ends 2026-05-29. `plan model` with 480-minute blocks gives 163 intervals.

## End to end with the task and constraints modules

[`examples/end-to-end`](examples/end-to-end) plays the part of the bot for one planning request: it reads tasks from `ambitious-tasks`, proposes and models a plan here, optionally solves the model with `ambitious-constraints`, commits the plan, forwards the suggested task updates, and works through a calendar holds proposal with a stand-in calendar. Each module is a separate program and only JSON passes between them.

## Build and verify

Install [mise](https://mise.jdx.dev). Tool versions are pinned in `.mise.toml`. The kit packages are vendored under `vendor/` and bundled at build time.

```sh
mise trust && mise install
npm ci
npm run release:check
```

`release:check` runs types, lint and standalone wording, import boundaries, unit, property and CLI tests, the shared contract tests, TLA+/TLC, feature verification and release packaging. `verify/run --doctor`, `--list` and `--only <feature>` support targeted verification.

### On a Debian 13 computer without root

The module needs only Node 24 (24.8.0 or later). TLC, which `npm run tlc` and the `models` feature use, also needs Java and is a development check, not something the module needs to run.

```sh
cd "$HOME"
curl -fsSLO https://nodejs.org/dist/v24.8.0/node-v24.8.0-linux-x64.tar.xz
echo "2598641d188b41793930917f1a99a81c9615856b4205d408a44ab676c1acbb3d  node-v24.8.0-linux-x64.tar.xz" | sha256sum -c
mkdir -p "$HOME/.local/node" && tar -xJf node-v24.8.0-linux-x64.tar.xz -C "$HOME/.local/node" --strip-components=1
export PATH="$HOME/.local/node/bin:$PATH"

git clone https://github.com/AmbitiousBots/ambitious-scheduling.git && cd ambitious-scheduling
npm ci
npm run typecheck && npm run lint && npm run depcruise
npm test
npm run contract
node verify/run --only build --only commands --only selfcheck --only calendars --only time-zones --only propose --only independent-check --only commit --only approval-flow --only constraint-model --only contract --only standalone
npm run release:build

export AMBITIOUS_HOME="$HOME/ambitious"
mkdir -p "$AMBITIOUS_HOME/bin" && cp release/ambitious-scheduling-0.1.1.mjs "$AMBITIOUS_HOME/bin/" && ln -sf ambitious-scheduling-0.1.1.mjs "$AMBITIOUS_HOME/bin/ambitious-scheduling"
node "$AMBITIOUS_HOME/bin/ambitious-scheduling" selfcheck
```

If the computer already has Node 24.8 or later, skip the download. CI runs these steps in a Debian 13 container as a user without root.

## Bot skills

`skills/scheduling-for-bots/SKILL.md` tells a bot how to run the approval flow. `skills/scheduling-page/SKILL.md` tells it how to show a plan as a Grok Bot Page. The module itself renders nothing.

## License

Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
