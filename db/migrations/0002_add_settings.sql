-- 設定を保存するためのテーブル
CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- デフォルトの保持期間設定（単位：月）を追加
INSERT INTO settings (key, value) VALUES 
('retention_accounting_months', '3'),
('retention_requests_months', '3'),
('retention_audit_months', '3')
ON CONFLICT (key) DO NOTHING;
