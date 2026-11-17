# End to end: tasks, scheduling, constraints

`run.mjs` plays the part of the bot for one planning request. It starts three separate programs and carries JSON between them; no module imports, starts or reads another. It uses the 104-task fixture in `test/fixtures/work-plan.json`, creates every database in a temporary directory, and uses no calendar service and no network.

```sh
npm run build
node examples/end-to-end/run.mjs \
  --tasks /path/to/ambitious-tasks-0.1.2.mjs \
  --constraints /path/to/ambitious-constraints-0.1.0.pyz --python python3.13
```

`--tasks` is required. `--scheduling` defaults to `dist/ambitious-scheduling.mjs`. `--constraints` is optional: without it, or when the constraints module answers `E_RUNTIME` because its pinned runtime is not installed, the example says so and goes on with the greedy plan. The constraints module finds its runtime under `AMBITIOUS_HOME`, so set that to the directory the runtime was installed in.

| Step | Program | What crosses |
|---|---|---|
| 1 | `ambitious-tasks import`, `list` | the `list` rows, wrapped as a `tasks-snapshot.v1` |
| 2 | `ambitious-scheduling calendar add`, `availability set`, `busy import` | calendars, working hours, busy time the bot read elsewhere |
| 3 | `ambitious-scheduling plan propose`, `plan model` | a proposed `schedule-plan.v1`; a `constraint-model.v1` with its `mapping` |
| 4 | `ambitious-constraints solve` | a `constraint-solution.v1` |
| 5 | `ambitious-scheduling plan propose` with `solution` and `mapping` | the solver's plan, checked by the scheduling module's own checker |
| 6 | `ambitious-scheduling plan commit` | the approved plan becomes version 1; a writer on the old base gets `E_STALE` |
| 7 | `ambitious-scheduling plan task-updates`, then `ambitious-tasks update` | one update per task, each with its `idem_key`; a replay changes nothing |
| 8 | `ambitious-scheduling plan holds`, `holds record` | a `calendar-holds.v1` proposal; the script stands in for the calendar and reports made-up event ids |
| 9 | a task is finished, then steps 3, 6, 7 and 8 again | the old proposal is refused with `E_TASKS_CHANGED`; version 2 keeps, creates and cancels holds |

Progress goes to stderr and one JSON summary to stdout. The script fails if a plan has a violation, if the solver's plan ends later than the greedy plan it was given as a hint, if a hold is proposed for creation twice, or if the events left on the stand-in calendar are not exactly the blocks of the latest version.

In a real bot, steps 6 and 8 happen only after the person approves the plan and the list of calendar events, and the events are created through the bot's own calendar connectors.

A plan made a day later moves most blocks, because a proposal starts from the current time and does not try to keep earlier placements. Most holds are therefore canceled and created again in step 9.
