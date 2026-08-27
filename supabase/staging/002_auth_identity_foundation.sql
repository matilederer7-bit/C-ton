-- R1 Supabase Auth identity bindings. No users are imported by this migration.
-- Business rows survive auth-user deletion; the binding becomes NULL.

BEGIN;

ALTER TABLE siton.seller_accounts
  ADD COLUMN IF NOT EXISTS auth_user_id uuid NULL;

ALTER TABLE siton.admin_users
  ADD COLUMN IF NOT EXISTS auth_user_id uuid NULL;

ALTER TABLE siton.affiliate_accounts
  ADD COLUMN IF NOT EXISTS auth_user_id uuid NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_seller_accounts_auth_user
  ON siton.seller_accounts (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_admin_users_auth_user
  ON siton.admin_users (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_affiliate_accounts_auth_user
  ON siton.affiliate_accounts (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

DO $constraints$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'Supabase auth.users is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_seller_accounts_auth_user'
       AND conrelid = 'siton.seller_accounts'::regclass
  ) THEN
    ALTER TABLE siton.seller_accounts
      ADD CONSTRAINT fk_seller_accounts_auth_user
      FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_admin_users_auth_user'
       AND conrelid = 'siton.admin_users'::regclass
  ) THEN
    ALTER TABLE siton.admin_users
      ADD CONSTRAINT fk_admin_users_auth_user
      FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_affiliate_accounts_auth_user'
       AND conrelid = 'siton.affiliate_accounts'::regclass
  ) THEN
    ALTER TABLE siton.affiliate_accounts
      ADD CONSTRAINT fk_affiliate_accounts_auth_user
      FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END;
$constraints$;

COMMIT;
