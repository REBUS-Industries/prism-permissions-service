CREATE TABLE IF NOT EXISTS "identity_link" (
  "id" text PRIMARY KEY NOT NULL,
  "portal_user_id" text NOT NULL,
  "google_sub" text,
  "email" text NOT NULL,
  "orbit_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "identity_link_portal_user_idx" ON "identity_link" ("portal_user_id");
CREATE INDEX IF NOT EXISTS "identity_link_email_idx" ON "identity_link" ("email");

CREATE TABLE IF NOT EXISTS "project_permission_cache" (
  "id" text PRIMARY KEY NOT NULL,
  "orbit_user_id" text NOT NULL,
  "orbit_project_id" text NOT NULL,
  "level" text NOT NULL,
  "project_name" text,
  "fetched_at" timestamp with time zone NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "project_perm_user_project_idx" ON "project_permission_cache" ("orbit_user_id", "orbit_project_id");
CREATE INDEX IF NOT EXISTS "project_perm_user_idx" ON "project_permission_cache" ("orbit_user_id");

CREATE TABLE IF NOT EXISTS "function_policy_nodes" (
  "id" text PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "label" text NOT NULL,
  "ref" text,
  "position_x" text NOT NULL,
  "position_y" text NOT NULL,
  "data" jsonb,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "function_policy_edges" (
  "id" text PRIMARY KEY NOT NULL,
  "source_id" text NOT NULL,
  "target_id" text NOT NULL,
  "grant" boolean DEFAULT true NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "minted_token" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "orbit_user_id" text NOT NULL,
  "email" text NOT NULL,
  "orbit_target" text NOT NULL,
  "project_ids" jsonb NOT NULL,
  "scopes" jsonb NOT NULL,
  "token_prefix" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "minted_token_session_idx" ON "minted_token" ("session_id");

CREATE TABLE IF NOT EXISTS "access_session" (
  "id" text PRIMARY KEY NOT NULL,
  "identity_link_id" text NOT NULL,
  "minted_token_id" text NOT NULL,
  "orbit_target" text NOT NULL,
  "manifest" jsonb NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "access_session_identity_idx" ON "access_session" ("identity_link_id");

CREATE TABLE IF NOT EXISTS "policy_settings" (
  "id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
  "default_functions" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

INSERT INTO "policy_settings" ("id", "default_functions")
VALUES ('default', '["list_projects","list_models","list_versions","receive"]'::jsonb)
ON CONFLICT ("id") DO NOTHING;
