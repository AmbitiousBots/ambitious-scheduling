# Changelog

All notable changes to this module are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow the module contract's versioning rule.

## 0.1.0 - 2026-11-17

### Added

- 0.1.0: calendars with IANA time zones, weekly working hours with days off, and busy time imported as data.
- `free`, and `plan propose`, a greedy scheduler that places a tasks snapshot into free working time, with `plan check`, an independent checker.
- `plan commit` with optimistic concurrency and digest checks, `plan clone`, `plan get`, `plan list`, `plan history` and `plan diff`.
- `plan task-updates`, the task updates a bot forwards to a task module, and `plan holds` with `holds record` and `holds list`, the calendar holds a bot may create, keep or cancel through its own connectors.
- `plan model`, the same planning question as a `constraint-model.v1`, and `plan propose` from a `constraint-solution.v1`.
- TLA+ models of plan commit and of the calendar hold lifecycle.
