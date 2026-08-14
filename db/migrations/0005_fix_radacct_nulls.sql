-- Drop NOT NULL constraints from radacct columns that FreeRADIUS might explicitly set to NULL
ALTER TABLE radacct ALTER COLUMN acctterminatecause DROP NOT NULL;
