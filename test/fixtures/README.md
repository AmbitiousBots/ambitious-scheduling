# test/fixtures

`work-plan.json` is a byte-for-byte copy of `test/fixtures/work-plan.json` from [ambitious-tasks](https://github.com/AmbitiousBots/ambitious-tasks) at release `tasks-v0.1.2`: 104 generic tasks with prerequisites and 105.5 estimated effort days, in that module's import format. The tests turn it into a `tasks-snapshot.v1` document the way a bot would, from the rows the task module lists. It is test data only; this module never reads the task module.
