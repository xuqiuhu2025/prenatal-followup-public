CREATE TABLE IF NOT EXISTS prenatal_cases (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 patient_id BIGINT NOT NULL REFERENCES patients(id),
 pregnancy_no VARCHAR(64) NOT NULL,
 lmp DATE,
 edd DATE,
 fetus_count INTEGER NOT NULL DEFAULT 1 CHECK(fetus_count BETWEEN 1 AND 6),
 referral_org VARCHAR(120) NOT NULL DEFAULT '',
 indications VARCHAR(1000) NOT NULL DEFAULT '',
 status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed','lost','refused')),
 close_reason VARCHAR(1000) NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(patient_id,pregnancy_no)
);
CREATE TABLE IF NOT EXISTS prenatal_projects (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 case_id BIGINT NOT NULL REFERENCES prenatal_cases(id),
 project_code VARCHAR(32) NOT NULL,
 result JSONB NOT NULL DEFAULT '{}',
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(case_id,project_code)
);
CREATE TABLE IF NOT EXISTS prenatal_changes (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 case_id BIGINT NOT NULL REFERENCES prenatal_cases(id),
 actor_id BIGINT NOT NULL REFERENCES staff_accounts(id),
 action VARCHAR(32) NOT NULL,
 detail JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS prenatal_imports (
 request_id UUID PRIMARY KEY,payload_hash TEXT NOT NULL,result JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE followup_tasks ADD COLUMN IF NOT EXISTS prenatal_case_id BIGINT REFERENCES prenatal_cases(id);
ALTER TABLE followup_tasks ADD COLUMN IF NOT EXISTS project_code VARCHAR(32);
ALTER TABLE followup_tasks ADD COLUMN IF NOT EXISTS stage_code VARCHAR(32);
ALTER TABLE followup_records ADD COLUMN IF NOT EXISTS prenatal_data JSONB;
CREATE INDEX IF NOT EXISTS idx_prenatal_case_tasks ON followup_tasks(prenatal_case_id);
