---
name: scheduling-for-bots
description: Place tasks into free working time with the Ambitious Scheduling CLI, and get the task updates and calendar holds that follow from an approved plan. Use when a user asks to schedule work, find free time, plan a week, move a plan, or put planned work on a calendar.
---

# Plan work in time with Ambitious Scheduling

Use the installed `ambitious-scheduling` binary at `$AMBITIOUS_HOME/bin/ambitious-scheduling`. When `AMBITIOUS_HOME` is not set, that path is `/workspace/ambitious/bin/ambitious-scheduling`. Run `selfcheck --json` at routine start and read `data.problems`. Resolve a reported problem before writing data. Run `commands` to list the operations this binary offers. Read the module documentation at https://github.com/AmbitiousBots/ambitious-scheduling#readme for every input shape.

Pass one JSON object on stdin or with `--in`, never both. Keep every input file outside `/home/box/agent-data`. You may pass `--json`; it changes nothing. Pass `--now` and `--seed` when you need a repeatable result, and keep the `now`, `seed` and `version` values from `meta` with the evidence.

This module never contacts a calendar service or another module. You carry the data in and out, and the person decides.

Set up once: `calendar add` for each person or resource, with an IANA time zone and, for a person, `person_ref` equal to the assignee name the task module uses. `availability set` for working hours. Read a calendar's version with `calendar get` before changing it and pass it as `expected_version`.

Follow this order every time. Do not skip or reorder a step.

1. Read the tasks from the task module and wrap its `list` rows as `{"schema":"tasks-snapshot.v1","tasks":[...]}`. Do not edit the rows.
2. If the person's calendar is connected, read busy time for the planning window through your own calendar connector and store it with `busy import`, one call per calendar. Import busy intervals only; leave titles out unless the person asked for them.
3. Run `plan propose` with the snapshot, the horizon and the policy. It stores nothing.
4. Show the person the proposed blocks, every entry of `violations` and `unscheduled`, and any `notes`, in a Page. Use this module's Page skill. Say plainly which tasks did not fit and why, using the messages returned.
5. Commit only after the person approves that exact plan. Run `plan commit` with the plan as returned, its `digest` and `tasks_digest`, the snapshot as `tasks`, and `base_version`: 0 for a new plan id, otherwise the version you read. Never pass `allow_violations` unless the person accepted the listed violations.
6. Run `plan task-updates` with a current snapshot and forward each entry of `suggestedUpdates` to the task module's `update` command unchanged, including its `idem_key`. Report `notes` to the person. Never change a due date yourself.
7. Run `plan holds` and show the person what would be created, kept and canceled. Create or cancel calendar events only after the person approves, through your own calendar connector, one event per hold, with the title and times given. Never invent an event the proposal does not list.
8. Report what you did with `holds record`: `created` with the event id the calendar service returned, `canceled`, or `failed` with a note. Do this right after each batch, so a later run proposes nothing twice.

Always pass an `idem_key` for a write. Choose one stable key per intended action and keep both the key and the input unchanged for a retry. `E_IDEM_CONFLICT` means the key was used for a different request: look at the original action, do not change the payload under the same key.

When a commit is refused, do what the code says and ask again. `E_STALE`: someone committed first; read the plan, propose again. `E_TASKS_CHANGED` or `E_CALENDAR_CHANGED`: a task, working hours or busy time changed since the proposal; read them again, propose again, and get approval for the new plan. `E_DIGEST`: you changed the plan; commit it exactly as proposed. Never work around a refusal by editing blocks by hand.

To try an alternative without touching the approved plan, run `plan clone` to a new id and commit there. Create calendar holds for one plan id only.

Never compute free time, block times, time zone conversions or durations by hand. Use `free`, `plan propose`, `plan check` and `plan diff`, and copy times as returned: `start` and `end` are UTC, `local_start` and `local_end` carry the calendar's offset. A proposed plan is not a commitment and a committed plan is not a calendar event: say which of the three the person is looking at.

When a constraint solver module is installed and the person asks for a better or explained plan, run `plan model`, pass `data.model` to the solver, and pass its solution back to `plan propose` as `solution` together with the unchanged `mapping`. Show the result like any other proposal, with its violations.

Read the envelope and the exit code after every command. Require the expected `module` and `command`, a successful exit, and `ok: true` before using a result. When `ok` is false, relay `errors[].message` and `errors[].hint` in plain words. Do not invent a successful result. Never place credentials or private bot files in module input.
