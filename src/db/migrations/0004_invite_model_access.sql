ALTER TABLE "invite_key"
  ADD COLUMN IF NOT EXISTS "model_access" text NOT NULL DEFAULT 'all';

ALTER TABLE "invite_key"
  ADD COLUMN IF NOT EXISTS "selected_model_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
