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

Last confirmed in step with the code at commit: none yet. When you add the first real model, write the commit here, and move it forward only after you have read the covered code at the new commit and confirmed that the model still describes it.

| Model | Covers | Each model step is this code |
|---|---|---|
| `spec/Sample.tla` | Nothing in this module. It is the starting example: a count that must never go past `Capacity`. Replace it with the module's first real model. | |

For each real model, add a row: the file, the source files and functions it describes, and which piece of code each model step stands for. One model step must be one indivisible step in the code, for example one transaction.

## The properties, in plain words

For each invariant, add a row that a person can read without knowing TLA+.

| Invariant | Promise | Harm if it broke |
|---|---|---|
| `WithinCapacity` (sample) | The count never goes past the capacity. | None; it is the sample. |

Also write down the bounds (how many items, how many actors) and what the model leaves out. A pass covers the model within those bounds, not the whole module.

## Each property must be seen to fail

`spec/broken/` holds copies of a model with one protection removed, and `spec/broken/EXPECTED.json` names the invariant each must break and why. `npm run tlc` fails if a broken variant passes or breaks a different invariant. A property with no broken variant has never been seen to fail and proves nothing yet.

## When you change covered code

1. Decide whether the change alters a step in the coverage table: a new state, a different order, a new way to fail. If it does not, run `npm run tlc` and you are done.
2. If it does, change the model first so it describes the new design, run `npm run tlc`, then change the code to match.
3. If TLC reports a violation, read it with the pstack `/statechart` skill (pstack is a public plugin of agent skills for the Cursor editor; install it from the plugin marketplace inside Cursor by searching for "pstack". `/statechart` turns TLC output into the shortest failing path in plain words, and draws the state chart when the check passes. Without it, read the numbered states TLC prints from top to bottom: each one is one step, and the last is where the rule broke). Retell the path in the code's terms.
4. Decide which is wrong. If the path can happen in the code, it is a real bug: fix the code, keep the property. If it cannot, the model is wrong: fix the model so it matches the code, and say in the pull request what was wrong with it. Never weaken or delete an invariant to get a pass.
5. For a new protection, add a broken variant that removes only that protection, with its entry in `EXPECTED.json`.
6. Update the coverage table and the sync commit above.
