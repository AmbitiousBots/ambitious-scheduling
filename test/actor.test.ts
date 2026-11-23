import assert from "node:assert/strict";
import { test } from "node:test";
import { Failure } from "@ambitious/kit/domain/failure";
import { parseCalendarAdd } from "../src/domain/requests.ts";

const input = (actor?: string): { readonly id: string; readonly tz: string; readonly idem_key: string; readonly actor?: string } => ({
  id: "sam",
  tz: "UTC",
  idem_key: "add-sam",
  ...(actor === undefined ? {} : { actor }),
});

const refused = (actor: string): void => {
  assert.throws(
    () => parseCalendarAdd(input(actor)),
    (error: unknown) => {
      assert.ok(error instanceof Failure);
      assert.equal(error.errors[0].code, "E_INPUT_SCHEMA");
      assert.match(error.errors[0].hint, /1 to 200 Unicode characters/);
      return true;
    },
  );
};

test("a write actor follows the shared rule and defaults to caller", () => {
  assert.equal(parseCalendarAdd(input()).actor, "caller");
  assert.equal(parseCalendarAdd(input("front desk")).actor, "front desk");
  refused(" sam");
  refused("sam\n");
  refused("a".repeat(201));
  refused("");
});
