CREATE TABLE IF NOT EXISTS telephone_calls (
 id UUID PRIMARY KEY, request_id UUID NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
 task_id BIGINT REFERENCES followup_tasks(id), created_by BIGINT NOT NULL REFERENCES staff_accounts(id),
 phone VARCHAR(11) NOT NULL, stage VARCHAR(24) NOT NULL, fetus_count SMALLINT NOT NULL,
 status VARCHAR(24) NOT NULL DEFAULT 'dialing' CHECK(status IN ('dialing','answered','ended','busy','no_answer','failed','interrupted','cancelled')),
 outcome VARCHAR(32) NOT NULL DEFAULT 'in_progress', reason VARCHAR(80) NOT NULL DEFAULT '',
 draft JSONB NOT NULL DEFAULT '{}', priority VARCHAR(16) NOT NULL DEFAULT 'normal',
 review_status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','reviewed')),
 reviewed_by BIGINT REFERENCES staff_accounts(id), reviewed_at TIMESTAMPTZ, review_note VARCHAR(2000),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), answered_at TIMESTAMPTZ, ended_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS telephone_one_active_number ON telephone_calls(phone) WHERE status IN ('dialing','answered');
CREATE INDEX IF NOT EXISTS telephone_review_queue ON telephone_calls(review_status, created_at DESC);
CREATE TABLE IF NOT EXISTS telephone_events (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, call_id UUID NOT NULL REFERENCES telephone_calls(id),
 kind VARCHAR(32) NOT NULL, detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telephone_events_call ON telephone_events(call_id,id);
CREATE TABLE IF NOT EXISTS telephone_suppressions (
 phone VARCHAR(11) PRIMARY KEY, call_id UUID NOT NULL REFERENCES telephone_calls(id),
 reason VARCHAR(120) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telephone_requests (
 request_id UUID PRIMARY KEY,
 payload_hash TEXT NOT NULL,
 call_id UUID NOT NULL UNIQUE REFERENCES telephone_calls(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telephone_review_audit (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id BIGINT NOT NULL REFERENCES staff_accounts(id),
 call_id UUID NOT NULL REFERENCES telephone_calls(id),
 action VARCHAR(32) NOT NULL,
 detail JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
