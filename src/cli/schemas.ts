import { failure } from "@ambitious/kit/domain/failure";
import { describeSchemaProblems, schemaProblems } from "@ambitious/kit/domain/json-schema";
import calendarHolds from "../../schemas/interchange/calendar-holds.v1.json" with { type: "json" };
import constraintModel from "../../schemas/interchange/constraint-model.v1.json" with { type: "json" };
import constraintSolution from "../../schemas/interchange/constraint-solution.v1.json" with { type: "json" };
import schedulePlan from "../../schemas/interchange/schedule-plan.v1.json" with { type: "json" };
import tasksSnapshot from "../../schemas/interchange/tasks-snapshot.v1.json" with { type: "json" };

const SCHEMAS = {
  "calendar-holds.v1": calendarHolds,
  "constraint-model.v1": constraintModel,
  "constraint-solution.v1": constraintSolution,
  "schedule-plan.v1": schedulePlan,
  "tasks-snapshot.v1": tasksSnapshot,
} as const;

export type Interchange = keyof typeof SCHEMAS;

export const refuseInput = (name: Interchange, field: string, value: unknown): void => {
  const problems = schemaProblems(SCHEMAS[name], value);
  if (problems.length > 0) {
    throw failure("E_INPUT_SCHEMA", `The field ${field} is not a valid ${name} document: ${describeSchemaProblems(problems.slice(0, 5))}.`, `Send ${field} in the ${name} shape; the README links its schema.`);
  }
};

export const checkedOutput = <T>(name: Interchange, value: T): T => {
  const problems = schemaProblems(SCHEMAS[name], value);
  if (problems.length > 0) throw new Error(`This module wrote a ${name} document its schema refuses: ${describeSchemaProblems(problems.slice(0, 5))}`);
  return value;
};
