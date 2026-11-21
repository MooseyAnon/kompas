-- Identity-owned receipt survives deletion of the private CV draft.
CREATE TABLE identity_import_receipts (
  import_id TEXT PRIMARY KEY,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL
);
