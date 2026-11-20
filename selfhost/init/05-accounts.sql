CREATE TABLE IF NOT EXISTS staff_accounts (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 username VARCHAR(40) NOT NULL UNIQUE,
 display_name VARCHAR(80) NOT NULL,
 department VARCHAR(80) NOT NULL DEFAULT '',
 role VARCHAR(16) NOT NULL CHECK(role IN ('admin','staff')),
 enabled BOOLEAN NOT NULL DEFAULT true,
 password_hash TEXT NOT NULL,
 last_login_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS staff_sessions (
 token_hash CHAR(64) PRIMARY KEY,
 account_id BIGINT NOT NULL REFERENCES staff_accounts(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staff_sessions_account ON staff_sessions(account_id);
CREATE TABLE IF NOT EXISTS staff_audit (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id BIGINT REFERENCES staff_accounts(id),
 target_id BIGINT NOT NULL REFERENCES staff_accounts(id),
 action VARCHAR(32) NOT NULL,
 detail JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE followup_records ADD COLUMN IF NOT EXISTS recorded_by BIGINT REFERENCES staff_accounts(id);
