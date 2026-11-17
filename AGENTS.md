# Agent guide

## Goal

Ambitious is a Grok Bot configuration and monitoring service: a free Ambitious Bot template, flat per-org monthly monitoring with human review, and open-source single-purpose CLI modules with no UI that the bot drives. This repo is one of those modules. The user is a person who talks to a bot and never sees this code, so a change is good when the bot can do more for them, or the same with less risk.

## How to work

- Work in small steps and prove each one: say what the change must do, make the smallest change that does it, then run the checks and show their output. Model choices per agent role are in `.cursor/rules/agent-models.mdc`. Claude Code analysis runs use `--model claude-fable-5-2`.
- Trust in this order: types and API design, then lint and the dependency graph, then tests and verification, then prose.
- When you are corrected, turn the correction into a lint rule with a fix-the-root-cause message or into an API change. Do not add it to this file.
- When a check fails, fix the cause. Never weaken or skip a check to make it pass.

## Data shape

- In: JSON on stdin or `--in`. Out: one JSON envelope on stdout, `{ ok, schemaVersion, module, command, data, errors, meta }`.
- State: one SQLite file per module. Its shape is the files in `migrations/` plus the types in `src/domain/`. Read those before changing behavior; they are the source of truth, not this file.
- The full contract is `MODULE_CONTRACT.md`, a copy of the one in the ambitious-kit repo. Part 5 says how data crosses between modules: this module never imports, starts or reads another module, and never contacts a calendar service.

## Directory boundaries

- `src/cli/`: argument parsing and the envelope only. The one place that reads the clock, randomness and the environment.
- `src/domain/`: pure logic with no IO. Time and randomness arrive as arguments.
- `src/db/`: the only place that imports `node:sqlite`.
- `src/ai/`: the only place with network calls.
- `schemas/interchange/`: copies of the kit's interchange schemas this module reads and writes, pinned by checksum. Change a schema in the kit first.
- `spec/`: TLA+ models. `test/`: tests. `verify/`: the verification skill. `skills/`: what a bot follows when it drives this module.

## Judgment calls

- Which layer a piece of code belongs in: if it can be stated without IO, it is domain logic, even when it is first needed by a database or AI call.
- Whether a behavior needs a model in `spec/` before code: yes when it has ordering, retries, concurrency or a state machine a person relies on.
- What an error says: plain words a bot can relay, and a hint the bot can act on without a human.
- How much to build: the smallest change that meets the goal. Delete before you add.
- What counts as proof: output from `verify/run` against a fresh `AMBITIOUS_HOME`, not a reading of the diff.
- Whether a write is safe: a proposal stores nothing, a commit changes only the id it is given and only from the version the caller read, a copy is an explicit clone, and every write is idempotent by key and leaves an audit row. A change that weakens one of these needs the model in `spec/` changed first.
- What to write down: a choice you made without asking goes in the PR under `## Decisions`.
- Wording: keep code and docs generic for every kind of organization. No person, bot or customer names, no industry terms, and no compliance or security claim beyond what the code enforces.
