import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migrate } from "@ambitious/kit/db/migrate";
import { openDb, readUserVersion } from "@ambitious/kit/db/open-db";

const migration = { name: "0001_scheduling", sql: readFileSync("migrations/0001_scheduling.sql", "utf8") };

test("0001 creates the scheduling tables on an empty database, keeps rows, and makes history and plan versions append-only", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "scheduling-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = openDb(join(directory, "scheduling.sqlite"), { readonly: false });
  t.after(() => db.close());
  assert.equal(readUserVersion(db), 0);
  assert.deepEqual(migrate(db, [migration]), ["0001_scheduling"]);
  assert.equal(readUserVersion(db), 1);
  db.exec(`
    INSERT INTO calendars (id, version, name, tz, kind, created_at, updated_at) VALUES ('c', 1, 'C', 'UTC', 'person', 'now', 'now');
    INSERT INTO busy_snapshots (id, calendar_id, source, window_start, window_end, taken_at, digest) VALUES (1, 'c', 'manual', 0, 10, 'now', 'd');
    INSERT INTO busy_blocks (snapshot_id, start_minute, end_minute) VALUES (1, 1, 2);
    INSERT INTO plans (id, version, created_at, updated_at) VALUES ('p', 1, 'now', 'now');
    INSERT INTO plan_versions (plan_id, version, digest, tasks_digest, doc, committed_at, actor) VALUES ('p', 1, 'd', 't', '{"blocks":[]}', 'now', 'a');
    INSERT INTO holds (plan_id, idempotency_key, status, provider, event_id, hold, recorded_at) VALUES ('p', 'k', 'created', 'x', 'e', '{}', 'now');
    INSERT INTO audit (at, actor, kind, subject, payload, idem_key) VALUES ('now', 'a', 'plan_committed', 'p', '{}', 'k1');
    INSERT INTO request_receipts (idem_key, request, response) VALUES ('k1', '{}', '{}');
  `);
  assert.deepEqual(migrate(db, [migration]), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM plan_versions").get()?.n, 1);
  assert.throws(() => db.exec("UPDATE audit SET actor = 'b'"), /append-only/);
  assert.throws(() => db.exec("DELETE FROM audit"), /append-only/);
  assert.throws(() => db.exec("UPDATE plan_versions SET digest = 'x'"), /never edited/);
  assert.throws(() => db.exec("DELETE FROM plan_versions"), /never deleted/);
  assert.throws(() => db.exec("INSERT INTO holds (plan_id, idempotency_key, status, provider, hold, recorded_at) VALUES ('p', 'k2', 'created', 'x', '{}', 'now')"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO calendars (id, version, name, tz, kind, created_at, updated_at) VALUES ('d', 1, 'D', 'UTC', 'robot', 'now', 'now')"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO busy_blocks (snapshot_id, start_minute, end_minute) VALUES (99, 1, 2)"), /FOREIGN KEY/);
  db.exec("DELETE FROM busy_snapshots WHERE id = 1");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM busy_blocks").get()?.n, 0);
});
