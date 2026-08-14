-- Add IPv6 columns to radacct table for FreeRADIUS compatibility
ALTER TABLE radacct
  ADD COLUMN IF NOT EXISTS framedipv6address INET DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS framedipv6prefix INET DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS framedinterfaceid VARCHAR(253) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS delegatedipv6prefix INET DEFAULT NULL;
