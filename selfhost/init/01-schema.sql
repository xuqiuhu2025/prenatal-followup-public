-- 智能客服自托管版数据库结构（与 CloudBase PG 版同构，自建库无需 RLS）
CREATE TABLE conversations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL DEFAULT '访客',
  status TEXT NOT NULL DEFAULT 'open',
  intent TEXT,
  flow JSONB,
  miss_count INT NOT NULL DEFAULT 0,
  rating INT,
  call_requested BOOLEAN NOT NULL DEFAULT FALSE,
  last_message TEXT NOT NULL DEFAULT '',
  last_order_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_session_created ON messages (session_id, created_at);

CREATE TABLE faqs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  faq_id TEXT NOT NULL UNIQUE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  category TEXT NOT NULL DEFAULT '通用',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  nickname TEXT,
  items TEXT,
  amount NUMERIC(10,2),
  status TEXT,
  logistics TEXT,
  refund_no TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE escalations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL,
  nickname TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  conversation_snapshot TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE satisfaction (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL,
  rating INT NOT NULL,
  comment TEXT,
  intent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE calls (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_id TEXT NOT NULL UNIQUE,
  session_id TEXT,
  nickname TEXT,
  phone TEXT NOT NULL,
  purpose TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  script TEXT,
  transcript TEXT,
  result TEXT,
  source TEXT NOT NULL DEFAULT 'user_request',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
