---
name: verify-module-formal
description: Model-check this Ambitious module's behavior where the order of steps matters (state changes, retries, concurrent runs) with TLA+ and the TLC model checker. Use when a change touches code listed in the coverage table below or any file under spec/.
---

# Formal verification of this module

A test checks the cases someone wrote. A model check tries every order of steps in a small model of the design. Use it for behavior a person relies on that has ordering, retries, concurrency or a state machine.

One command checks every model:

```text
npm run tlc
```

It needs the pinned tools (`mise trust && mise install`): Java, and `tla2tools.jar`, the TLA+ tools, pinned by address and SHA-256 in `.mise.toml`. It prints a table and exits non-zero when a model fails or a broken variant is not caught. `spec/README.md` explains the files.

## What is covered

Last confirmed in step with the code at commit `6bcd4c12e4384931f067b982184e63bd730f6da7`. Move this commit forward only after you have read the covered code at the new commit and confirmed that the model still describes it.

| Model | Covers | Each model step is this code |
|---|---|---|
| `spec/PlanCommit.tla` | `commitPlan` and `clonePlan` in `src/db/store.ts` | `Propose`: `plan propose` reading the current version and the tasks digest; it stores nothing. `EditTask`: a task changing in the task module. `RefuseStale`: the `E_STALE` refusal. `RefuseTasksChanged`: the `E_TASKS_CHANGED` refusals. `Commit`: the one write transaction that inserts the next row of `plan_versions`, moves `plans.version` and stores the receipt. `Retry`: `withReceipt` returning the stored answer for a used `idem_key`. `Clone`: `clonePlan`, which inserts a new plan and never writes the source. |
| `spec/HoldLifecycle.tla` | `holdsProposal` and `holdKey` in `src/domain/holds.ts`, `recordHolds` in `src/db/store.ts` | `CommitVersion`: a new plan version with any set of blocks. `CreateAndRecord`: the bot creating an event for a `create` hold and `holds record` with `created`. `CancelAndRecord`: the bot removing an event for a `cancel` hold and `holds record` with `canceled`. `AskAgain`: `plan holds` run again, which reads only. |

## The properties, in plain words

`spec/README.md` lists every invariant in plain words with a state diagram of each lifecycle, and names the broken variant that shows each protection is needed.

Bounds and assumptions: two writers and one plan id; two blocks and three versions; a write command is one SQLite transaction; the bot records a calendar event right after creating or removing it. The models do not cover a bot that creates an event and never records it: the calendar then holds an event this module does not know about, and the next `plan holds` proposes it again.

## When you change covered code

1. Decide whether the change alters a step in the table above. If it does not, run `npm run tlc` and you are done.
2. If it does, change the model first so it describes the new design, run `npm run tlc`, then change the code to match.
3. If TLC reports a violation, read the numbered states it prints from top to bottom: each one is one step, and the last is where the rule broke. Decide which is wrong. If the path can happen in the code, fix the code and keep the property. If it cannot, fix the model and say in the pull request what was wrong with it. Never weaken or delete an invariant to get a pass.
4. For a new protection, add a broken variant that removes only that protection, with its entry in `spec/broken/EXPECTED.json`.
5. Update the coverage table and the commit above.
