# Changelog

All notable changes to this module are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow the module contract's versioning rule.

## 0.1.1 - 2026-11-23

### Changed

- Built on kit 0.4.9. `--help`, with or without a command name, returns one envelope: the same listing as `commands`, or that one command. It does not run the command, read input or open the database.
- A write's `actor`, when sent, follows the kit's rule: 1 to 200 Unicode characters, no control characters or line breaks, no leading or trailing whitespace, internal spaces allowed, nothing trimmed. Leaving it out still stores `caller`.
- Development dependencies match the kit: TypeScript 7.0.2 typechecks the module, TypeScript API 6.0.3 serves lint and the dependency graph, and dependency-cruiser is 18.9.0. TLC uses Temurin 25.

## 0.1.0 - 2026-11-17

### Added

- 0.1.0: calendars with IANA time zones, weekly working hours with days off, and busy time imported as data.
- `free`, and `plan propose`, a greedy scheduler that places a tasks snapshot into free working time, with `plan check`, an independent checker.
- `plan commit` with optimistic concurrency and digest checks, `plan clone`, `plan get`, `plan list`, `plan history` and `plan diff`.
- `plan task-updates`, the task updates a bot forwards to a task module, and `plan holds` with `holds record` and `holds list`, the calendar holds a bot may create, keep or cancel through its own connectors.
- `plan model`, the same planning question as a `constraint-model.v1`, and `plan propose` from a `constraint-solution.v1`.
- TLA+ models of plan commit and of the calendar hold lifecycle.
