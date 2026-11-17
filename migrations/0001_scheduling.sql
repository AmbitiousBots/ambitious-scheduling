CREATE TABLE audit (
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'calendar_added', 'calendar_updated', 'availability_set', 'busy_imported',
    'plan_committed', 'plan_cloned', 'holds_recorded'
  )),
  subject TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  idem_key TEXT UNIQUE
);

CREATE INDEX audit_by_subject ON audit(subject, seq);

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
BEGIN
  SELECT RAISE(ABORT, 'The audit history is append-only');
END;

CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
BEGIN
  SELECT RAISE(ABORT, 'The audit history is append-only');
END;

CREATE TABLE request_receipts (
  idem_key TEXT PRIMARY KEY NOT NULL,
  request TEXT NOT NULL CHECK (json_valid(request)),
  response TEXT NOT NULL CHECK (json_valid(response))
);

CREATE TABLE calendars (
  id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  name TEXT NOT NULL,
  tz TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'resource', 'team')),
  person_ref TEXT,
  rules TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(rules)),
  exceptions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exceptions)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE busy_snapshots (
  id INTEGER PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id),
  source TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL CHECK (window_end > window_start),
  taken_at TEXT NOT NULL,
  digest TEXT NOT NULL,
  UNIQUE (calendar_id, source, window_start, window_end)
);

CREATE TABLE busy_blocks (
  snapshot_id INTEGER NOT NULL REFERENCES busy_snapshots(id) ON DELETE CASCADE,
  start_minute INTEGER NOT NULL,
  end_minute INTEGER NOT NULL CHECK (end_minute > start_minute),
  label TEXT
);

CREATE INDEX busy_blocks_by_snapshot ON busy_blocks(snapshot_id, start_minute);

CREATE TABLE plans (
  id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  forked_from_plan TEXT,
  forked_from_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((forked_from_plan IS NULL) = (forked_from_version IS NULL))
);

CREATE TABLE plan_versions (
  plan_id TEXT NOT NULL REFERENCES plans(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  digest TEXT NOT NULL,
  tasks_digest TEXT NOT NULL,
  doc TEXT NOT NULL CHECK (json_valid(doc)),
  committed_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  PRIMARY KEY (plan_id, version)
);

CREATE TRIGGER plan_versions_no_update BEFORE UPDATE ON plan_versions
BEGIN
  SELECT RAISE(ABORT, 'A committed plan version is never edited');
END;

CREATE TRIGGER plan_versions_no_delete BEFORE DELETE ON plan_versions
BEGIN
  SELECT RAISE(ABORT, 'A committed plan version is never deleted');
END;

CREATE TABLE holds (
  plan_id TEXT NOT NULL REFERENCES plans(id),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'canceled', 'failed')),
  provider TEXT NOT NULL,
  event_id TEXT,
  calendar TEXT,
  note TEXT,
  hold TEXT NOT NULL CHECK (json_valid(hold)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, idempotency_key),
  CHECK (status <> 'created' OR event_id IS NOT NULL)
);
