-- FreeRADIUS compatibility tables
-- These are required by default FreeRADIUS queries even if not actively used by MacAddressAuthService.

CREATE TABLE IF NOT EXISTS radreply (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(253) NOT NULL DEFAULT '',
  attribute VARCHAR(64) NOT NULL DEFAULT '',
  op CHAR(2) NOT NULL DEFAULT '=',
  value VARCHAR(253) NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS radreply_username_idx ON radreply (username);

CREATE TABLE IF NOT EXISTS radgroupcheck (
  id BIGSERIAL PRIMARY KEY,
  groupname VARCHAR(64) NOT NULL DEFAULT '',
  attribute VARCHAR(64) NOT NULL DEFAULT '',
  op CHAR(2) NOT NULL DEFAULT '==',
  value VARCHAR(253) NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS radgroupcheck_groupname_idx ON radgroupcheck (groupname);

CREATE TABLE IF NOT EXISTS radgroupreply (
  id BIGSERIAL PRIMARY KEY,
  groupname VARCHAR(64) NOT NULL DEFAULT '',
  attribute VARCHAR(64) NOT NULL DEFAULT '',
  op CHAR(2) NOT NULL DEFAULT '=',
  value VARCHAR(253) NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS radgroupreply_groupname_idx ON radgroupreply (groupname);

CREATE TABLE IF NOT EXISTS radusergroup (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(253) NOT NULL DEFAULT '',
  groupname VARCHAR(64) NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS radusergroup_username_idx ON radusergroup (username);

CREATE TABLE IF NOT EXISTS radpostauth (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(253) NOT NULL DEFAULT '',
  pass VARCHAR(253) NOT NULL DEFAULT '',
  reply VARCHAR(32) NOT NULL DEFAULT '',
  authdate TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
