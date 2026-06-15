-- Google Workspace link + pre-provisioned users (permissions before first login)

CREATE TABLE IF NOT EXISTS "google_workspace" (
  "id" text PRIMARY KEY,
  "domain" text NOT NULL,
  "display_name" text,
  "status" text NOT NULL DEFAULT 'disconnected',
  "adapter" text NOT NULL DEFAULT 'mock',
  "linked_at" timestamptz,
  "last_sync_at" timestamptz,
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "google_workspace_domain_idx" ON "google_workspace" ("domain");

CREATE TABLE IF NOT EXISTS "provisioned_user" (
  "id" text PRIMARY KEY,
  "workspace_id" text NOT NULL REFERENCES "google_workspace"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "display_name" text,
  "google_sub" text,
  "status" text NOT NULL DEFAULT 'pending',
  "source" text NOT NULL DEFAULT 'manual',
  "is_prism_admin" boolean NOT NULL DEFAULT false,
  "prism_admin_username" text,
  "project_permissions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "role_refs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "last_login_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "provisioned_user_email_idx" ON "provisioned_user" (lower("email"));
CREATE INDEX IF NOT EXISTS "provisioned_user_workspace_idx" ON "provisioned_user" ("workspace_id");
