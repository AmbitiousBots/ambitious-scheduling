import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const PINNED: Readonly<Record<string, string>> = JSON.parse(readFileSync("schemas/interchange/SHA256SUMS.json", "utf8"));

test("the interchange schemas are byte-for-byte the copies taken from the kit", () => {
  const files = readdirSync("schemas/interchange").filter((name) => name.endsWith(".v1.json")).sort();
  assert.deepEqual(files, Object.keys(PINNED).sort());
  for (const file of files) {
    assert.equal(createHash("sha256").update(readFileSync(join("schemas/interchange", file))).digest("hex"), PINNED[file], `${file} differs from the kit's copy. Change the schema in the kit first, then copy it here and update the pin.`);
  }
});
