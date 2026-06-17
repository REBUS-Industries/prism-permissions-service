CREATE TABLE IF NOT EXISTS "tool_grant" (
  "id" text PRIMARY KEY NOT NULL,
  "principal_type" text NOT NULL,
  "principal_ref" text NOT NULL,
  "tool" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "tool_grant_principal_tool_idx"
  ON "tool_grant" ("principal_type", "principal_ref", "tool");

-- Default grants: staff gets convert + visualiser; viewer gets visualiser only.
INSERT INTO "tool_grant" ("id", "principal_type", "principal_ref", "tool")
VALUES
  ('seed-staff-convert', 'role', 'staff', 'convert'),
  ('seed-staff-visualiser', 'role', 'staff', 'visualiser'),
  ('seed-viewer-visualiser', 'role', 'viewer', 'visualiser')
ON CONFLICT DO NOTHING;
