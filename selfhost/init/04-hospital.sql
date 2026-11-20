CREATE TABLE IF NOT EXISTS patients (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 patient_no VARCHAR(64) NOT NULL UNIQUE,
 name VARCHAR(80) NOT NULL,
 phone VARCHAR(11) NOT NULL CHECK (phone ~ '^1[3-9][0-9]{9}$'),
 sex VARCHAR(8) NOT NULL DEFAULT '未知',
 birth_date DATE,
 department VARCHAR(80) NOT NULL DEFAULT '',
 clinician VARCHAR(80) NOT NULL DEFAULT '',
 discharge_date DATE,
 diagnosis VARCHAR(300) NOT NULL DEFAULT '',
 tags VARCHAR(160) NOT NULL DEFAULT '',
 notes VARCHAR(1000) NOT NULL DEFAULT '',
 source VARCHAR(120) NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_patients_department ON patients(department);
CREATE TABLE IF NOT EXISTS patient_imports (
 request_id UUID PRIMARY KEY, payload_hash TEXT NOT NULL, result JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS followup_tasks (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 patient_id BIGINT NOT NULL REFERENCES patients(id),
 title VARCHAR(120) NOT NULL,
 due_date DATE NOT NULL,
 assigned_to VARCHAR(80) NOT NULL,
 channel VARCHAR(20) NOT NULL CHECK(channel IN ('phone','clinic','online')),
 status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled')),
 focus VARCHAR(1000) NOT NULL DEFAULT '',
 plan_key UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 completed_at TIMESTAMPTZ
);
-- A rescheduled task can share a day with another node in the same plan.
-- Request tables, rather than dates, enforce retry idempotency.
ALTER TABLE followup_tasks DROP CONSTRAINT IF EXISTS followup_tasks_plan_key_due_date_key;
CREATE INDEX IF NOT EXISTS idx_followup_due ON followup_tasks(status, due_date);
CREATE TABLE IF NOT EXISTS followup_records (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 task_id BIGINT NOT NULL REFERENCES followup_tasks(id),
 request_id UUID NOT NULL UNIQUE,
 payload_hash TEXT NOT NULL,
 operator VARCHAR(80) NOT NULL,
 contact VARCHAR(20) NOT NULL CHECK(contact IN ('reached','unreachable','declined','cancelled')),
 condition VARCHAR(20) NOT NULL CHECK(condition IN ('stable','attention','urgent','unknown')),
 medication VARCHAR(20) NOT NULL CHECK(medication IN ('as_directed','issue','not_applicable','unknown')),
 appointment VARCHAR(20) NOT NULL CHECK(appointment IN ('scheduled','needed','not_needed','unknown')),
 notes VARCHAR(2000) NOT NULL,
 next_date DATE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS followup_plans (
 request_id UUID PRIMARY KEY, payload_hash TEXT NOT NULL, result JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hospital_messages (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 session_id VARCHAR(100) NOT NULL,
 role VARCHAR(20) NOT NULL,
 content TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hospital_messages ON hospital_messages(session_id,id);
