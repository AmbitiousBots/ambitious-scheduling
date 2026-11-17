---
name: verify-module
description: Prove that this Ambitious module works the way a bot uses it, by running the built binary from the command line against a fresh AMBITIOUS_HOME and checking the JSON envelope and exit code. Use after any change to the module, and to produce the evidence for a pull request.
---

# Verify this module

A module has no user interface. Its user is a bot that runs the built binary, writes JSON to it and reads one JSON envelope from stdout. This skill drives that same surface. One command runs everything:

```text
node verify/run
```

It prints one row per feature in `verify/features.json` and exits non-zero when any row fails. Its output is the evidence a pull request pastes under `## Evidence`.

## Launch

There is no server. "Launch" means installing the pinned tools and dependencies once, then building the binary:

```text
mise trust && mise install
npm ci
npm run build
```

[mise](https://mise.jdx.dev) installs the tool versions pinned in `.mise.toml`. Skip `npm ci` and `npm run build` while the repository has no dependencies or build step yet. It is ready when `node verify/run --doctor` prints `ok` on every row.

## Doctor

```text
node verify/run --doctor
```

Read-only. It checks the Node version against `package.json`, that dependencies are installed and that the feature list is well formed.

## Drive

- Everything: `node verify/run`.
- One feature: `node verify/run --only <id>`. Repeat `--only` for several.
- The list with each check command: `node verify/run --list`.

Each check runs from the repository root with `AMBITIOUS_HOME` set to its own new, empty temporary directory, so two runs never share a database and nothing touches the default home. Runs can go side by side.

To drive the binary by hand the way a bot does, give it a home and fixed `--now` and `--seed`, then read stdout and the exit code. Every module has `selfcheck` and `commands`:

```text
export AMBITIOUS_HOME="$(mktemp -d)"
node dist/ambitious-<module>.mjs selfcheck --now 2026-01-01T00:00:00Z --seed 7; echo "exit $?"
node dist/ambitious-<module>.mjs commands
```

## Feature map

`verify/features.json` is the map: `[{ "id", "userVisible", "check" }]`.

- `id`: lower-case words joined by hyphens.
- `userVisible`: one plain sentence saying what a person who talks to the bot can rely on.
- `check`: one shell command that exits 0 only when that is true. It must run the built binary or another real entry point, not an internal function, and must check the result as well as the action: the exit code, the envelope, the rows that were stored.

The list starts with the two features every repository has: the standalone check and the model check. Add one entry for each command the module gains, in the same pull request as the command. Put a longer check in a script under `verify/checks/` and make it print what it ran and what it saw. If a check cannot pass because a precondition is missing, leave it failing and say why; do not weaken the check.

## Evidence

Paste the table `node verify/run` prints. The complete output of every check is written to a temporary evidence directory, one `<feature id>.log` per feature, and the path is printed on the line that starts `Full output of every check:`.

## Cleanup

`verify/run` removes every temporary `AMBITIOUS_HOME` it created. The evidence directory is kept; delete it yourself when you no longer need it. A check script that creates anything else removes it itself, also after a failure.
