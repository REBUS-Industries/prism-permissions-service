CREATE TABLE IF NOT EXISTS "invite_key" (
  "id" text PRIMARY KEY NOT NULL,
  "key_hash" text NOT NULL,
  "key_prefix" text NOT NULL,
  "label" text,
  "orbit_target" text NOT NULL,
  "orbit_project_ids" jsonb NOT NULL,
  "project_names" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "allowed_functions" jsonb NOT NULL,
  "expires_at" timestamp with time zone,
  "max_redemptions" integer,
  "redemption_count" integer DEFAULT 0 NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "last_redeemed_at" timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS "invite_key_hash_idx" ON "invite_key" ("key_hash");
CREATE INDEX IF NOT EXISTS "invite_key_created_by_idx" ON "invite_key" ("created_by");

CREATE TABLE IF NOT EXISTS "invite_key_redemption" (
  "id" text PRIMARY KEY NOT NULL,
  "invite_key_id" text NOT NULL REFERENCES "invite_key" ("id") ON DELETE CASCADE,
  "session_id" text NOT NULL,
  "orbit_target" text NOT NULL,
  "redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "client_meta" jsonb
);

CREATE INDEX IF NOT EXISTS "invite_key_redemption_key_idx"
  ON "invite_key_redemption" ("invite_key_id");
CREATE INDEX IF NOT EXISTS "invite_key_redemption_session_idx"
  ON "invite_key_redemption" ("session_id");

ALTER TABLE "access_session"
  ADD COLUMN IF NOT EXISTS "invite_key_id" text;

CREATE INDEX IF NOT EXISTS "access_session_invite_key_idx"
  ON "access_session" ("invite_key_id");

-- Demo invite key for mock / prism-dev Connector Light testing.
-- Plaintext: invite_demo_light_mock-project-1
-- SHA-256: computed at seed time below (fixed).
INSERT INTO "invite_key" (
  "id",
  "key_hash",
  "key_prefix",
  "label",
  "orbit_target",
  "orbit_project_ids",
  "project_names",
  "allowed_functions",
  "expires_at",
  "max_redemptions",
  "redemption_count",
  "created_by",
  "created_at"
)
VALUES (
  'invite-demo-light',
  'c3006228ae84604ad6d0a04ac881567a3dabf4cd7e3e2e457d093f450f25d60d',
  'invite_d',
  'Demo Connector Light (mock-project-1)',
  'dev',
  '["mock-project-1"]'::jsonb,
  '{"mock-project-1":"Demo Project A"}'::jsonb,
  '["send","create_model","create_version","list_models","list_versions"]'::jsonb,
  NULL,
  NULL,
  0,
  'system:seed',
  now()
)
ON CONFLICT ("id") DO NOTHING;
