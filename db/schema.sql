CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'admin')) DEFAULT 'user',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purposes (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_requests (
  id BIGSERIAL PRIMARY KEY,
  requester_id BIGINT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('register', 'update', 'delete')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')) DEFAULT 'pending',
  device_id BIGINT,
  device_name TEXT NOT NULL,
  mac_address TEXT NOT NULL,
  purpose_id BIGINT REFERENCES purposes(id),
  expires_at TIMESTAMPTZ,
  note TEXT,
  reviewer_id BIGINT REFERENCES users(id),
  review_note TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devices (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES users(id),
  device_name TEXT NOT NULL,
  mac_address TEXT NOT NULL UNIQUE,
  purpose_id BIGINT REFERENCES purposes(id),
  expires_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')) DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE device_requests
  DROP CONSTRAINT IF EXISTS device_requests_device_id_fkey;
ALTER TABLE device_requests
  ADD CONSTRAINT device_requests_device_id_fkey
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id BIGINT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- FreeRADIUS (rlm_sql) compatibility tables. FreeRADIUS should use this same database.
CREATE TABLE IF NOT EXISTS radcheck (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(253) NOT NULL DEFAULT '',
  attribute VARCHAR(64) NOT NULL DEFAULT '',
  op CHAR(2) NOT NULL DEFAULT ':=',
  value VARCHAR(253) NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS radcheck_mac_password_idx
  ON radcheck (username, attribute);

-- Standard FreeRADIUS accounting table. Enable sqlacct in FreeRADIUS to populate it.
CREATE TABLE IF NOT EXISTS radacct (
  radacctid BIGSERIAL PRIMARY KEY,
  acctsessionid VARCHAR(64) NOT NULL DEFAULT '',
  acctuniqueid VARCHAR(32) NOT NULL DEFAULT '',
  username VARCHAR(253) DEFAULT NULL,
  realm VARCHAR(64) DEFAULT '',
  nasipaddress INET NOT NULL,
  nasportid VARCHAR(15) DEFAULT NULL,
  nasporttype VARCHAR(32) DEFAULT NULL,
  acctstarttime TIMESTAMPTZ DEFAULT NULL,
  acctupdatetime TIMESTAMPTZ DEFAULT NULL,
  acctstoptime TIMESTAMPTZ DEFAULT NULL,
  acctinterval INTEGER DEFAULT NULL,
  acctsessiontime INTEGER DEFAULT NULL,
  acctauthentic VARCHAR(32) DEFAULT NULL,
  connectinfo_start VARCHAR(50) DEFAULT NULL,
  connectinfo_stop VARCHAR(50) DEFAULT NULL,
  acctinputoctets BIGINT DEFAULT NULL,
  acctoutputoctets BIGINT DEFAULT NULL,
  calledstationid VARCHAR(50) NOT NULL DEFAULT '',
  callingstationid VARCHAR(50) NOT NULL DEFAULT '',
  acctterminatecause VARCHAR(32) NOT NULL DEFAULT '',
  servicetype VARCHAR(32) DEFAULT NULL,
  framedprotocol VARCHAR(32) DEFAULT NULL,
  framedipaddress INET DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS radacct_username_idx ON radacct (username);
CREATE INDEX IF NOT EXISTS radacct_active_idx ON radacct (acctstoptime) WHERE acctstoptime IS NULL;
