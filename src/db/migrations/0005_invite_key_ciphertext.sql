-- Store sealed invite-key plaintext so admins can reveal keys after create.
ALTER TABLE "invite_key"
  ADD COLUMN IF NOT EXISTS "key_ciphertext" text;
