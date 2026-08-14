import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import passport from 'passport';
import { Strategy as SamlStrategy } from '@node-saml/passport-saml';

const { Pool } = pg;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const port = Number(process.env.PORT || 3000);
const macFormat = process.env.RADIUS_MAC_FORMAT || 'colon';
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) throw new Error('SESSION_SECRET must be configured in production.');

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const PostgresStore = pgSession(session);
app.use(session({
  store: new PostgresStore({ pool: pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 1000 * 60 * 60 * 8 },
}));
app.use(passport.initialize());
app.use(express.static('public'));

const samlEnabled = Boolean(process.env.SAML_ENTRY_POINT && process.env.SAML_ISSUER);
if (samlEnabled) {
  passport.use(new SamlStrategy({
    entryPoint: process.env.SAML_ENTRY_POINT,
    issuer: process.env.SAML_ISSUER,
    callbackUrl: process.env.SAML_CALLBACK_URL || `http://localhost:${port}/auth/saml/callback`,
    idpCert: process.env.SAML_CERT || 'dummy',
    wantAssertionsSigned: false, // In production this should be true depending on IdP config
  }, (profile, done) => {
    return done(null, profile);
  }));
}

async function cleanupOldLogs() {
  try {
    const { rows } = await pool.query("SELECT key, value FROM settings WHERE key LIKE 'retention_%'");
    if (!rows.length) return; // settings table may not be ready yet

    const getMonths = (k) => { const r = rows.find(x => x.key === k); return r && !isNaN(r.value) ? parseInt(r.value, 10) : 3; };
    const acctMonths = getMonths('retention_accounting_months');
    const reqMonths = getMonths('retention_requests_months');
    const auditMonths = getMonths('retention_audit_months');

    // radacct (終了しているセッションのみ)
    if (acctMonths > 0) await pool.query(`DELETE FROM radacct WHERE acctstoptime IS NOT NULL AND acctstoptime < NOW() - INTERVAL '${acctMonths} months'`);
    // device_requests
    if (reqMonths > 0) await pool.query(`DELETE FROM device_requests WHERE created_at < NOW() - INTERVAL '${reqMonths} months'`);
    // audit_logs
    if (auditMonths > 0) await pool.query(`DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '${auditMonths} months'`);
    
    console.log('Cleanup job completed successfully.');
  } catch (err) {
    console.error('Error during cleanup job:', err.message);
  }
}
setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000);
setTimeout(cleanupOldLogs, 10000); // 起動10秒後に初回実行

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const isAdmin = (req) => req.session.user?.role === 'admin';
function requireUser(req, res, next) {
  if (!req.session.user) return res.status(401).json({ message: 'ログインが必要です。' });
  next();
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ message: '管理者権限が必要です。' });
  next();
}
function normaliseMac(value) {
  const compact = String(value || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(compact)) throw new Error('MACアドレスは12桁の16進数で入力してください。');
  if (macFormat === 'plain') return compact;
  if (macFormat === 'hyphen') return compact.match(/.{2}/g).join('-');
  return compact.match(/.{2}/g).join(':');
}
function nullableDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('利用期限の形式が正しくありません。');
  if (date <= new Date()) throw new Error('利用期限は現在より後の日時にしてください。');
  return date.toISOString();
}
async function audit(client, actorId, action, entityType, entityId, detail = {}) {
  await client.query('INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, detail) VALUES ($1,$2,$3,$4,$5)', [actorId, action, entityType, entityId, detail]);
}
function requestQuery(where = '') {
  return `SELECT r.*, p.name AS purpose_name, u.display_name AS requester_name, u.email AS requester_email,
    reviewer.display_name AS reviewer_name
    FROM device_requests r JOIN users u ON u.id = r.requester_id
    LEFT JOIN purposes p ON p.id = r.purpose_id LEFT JOIN users reviewer ON reviewer.id = r.reviewer_id ${where}`;
}

app.get('/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', env: process.env.NODE_ENV || 'development' });
}));
app.get('/api/session', (req, res) => res.json({ user: req.session.user || null, radiusMacFormat: macFormat, samlEnabled }));

if (samlEnabled) {
  app.get('/auth/saml/login', passport.authenticate('saml', { failureRedirect: '/', failureFlash: false }));
  app.post('/auth/saml/callback', passport.authenticate('saml', { failureRedirect: '/', session: false }), asyncRoute(async (req, res) => {
    const profile = req.user;
    // IdP may send email in email, nameID, or other custom claims
    const email = (profile.email || profile.nameID || '').trim().toLowerCase();
    if (!email) return res.status(400).send('SAML response did not contain an email address or NameID.');
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT id, email, display_name, role, active FROM users WHERE email = $1', [email]);
      let user = rows[0];
      
      if (!user) {
        // JIT Provisioning
        const displayName = profile.displayName || profile.firstName || email.split('@')[0];
        const dummyHash = '*SSO-MANAGED*';
        const created = await client.query(`INSERT INTO users (email, display_name, password_hash, role) VALUES ($1,$2,$3,'user') RETURNING id, email, display_name, role, active`, [email, displayName, dummyHash]);
        user = created.rows[0];
        await audit(client, user.id, 'sso_user_provisioned', 'user', user.id, { email });
      }
      await client.query('COMMIT');
      
      if (!user.active) return res.status(403).send('アカウントが無効化されています。');
      
      req.session.regenerate((error) => {
        if (error) throw error;
        req.session.user = { id: user.id, email: user.email, displayName: user.display_name, role: user.role };
        res.redirect('/');
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }));
}

app.get('/api/setup/status', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  res.json({ needsSetup: rows[0].count === 0 });
}));
app.post('/api/setup/initialize', asyncRoute(async (req, res) => {
  const { email, displayName, password } = req.body;
  if (!/^\S+@\S+\.\S+$/.test(String(email || ''))) throw new Error('有効なメールアドレスを入力してください。');
  if (!String(displayName || '').trim()) throw new Error('管理者名を入力してください。');
  if (String(password || '').length < 10) throw new Error('パスワードは10文字以上で入力してください。');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE users IN EXCLUSIVE MODE');
    const existing = await client.query('SELECT id FROM users LIMIT 1');
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: '初期設定はすでに完了しています。' });
    }
    const hash = await bcrypt.hash(String(password), 12);
    const { rows } = await client.query(`INSERT INTO users (email,display_name,password_hash,role) VALUES ($1,$2,$3,'admin') RETURNING id,email,display_name,role`, [String(email).trim().toLowerCase(), String(displayName).trim(), hash]);
    await client.query(`INSERT INTO purposes (name) VALUES ('業務端末'), ('検証'), ('来訪者') ON CONFLICT (name) DO NOTHING`);
    await audit(client, rows[0].id, 'initial_setup_completed', 'user', rows[0].id, {});
    await client.query('COMMIT');
    res.status(201).json({ ok: true });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.post('/api/login', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await pool.query('SELECT id, email, display_name, password_hash, role, active FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user || !user.active || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ message: 'メールアドレスまたはパスワードが正しくありません。' });
  }
  req.session.regenerate((error) => {
    if (error) throw error;
    req.session.user = { id: user.id, email: user.email, displayName: user.display_name, role: user.role };
    res.json({ user: req.session.user });
  });
}));
app.post('/api/logout', requireUser, (req, res) => req.session.destroy(() => res.status(204).end()));

app.get('/api/purposes', requireUser, asyncRoute(async (_req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM purposes WHERE active = TRUE ORDER BY name');
  res.json(rows);
}));
app.get('/api/devices', requireUser, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`SELECT d.*, u.display_name AS owner_name, u.email AS owner_email, p.name AS purpose_name
    FROM devices d JOIN users u ON u.id=d.owner_id LEFT JOIN purposes p ON p.id=d.purpose_id WHERE d.owner_id = $1 AND d.status='active'
    ORDER BY d.created_at DESC`, [req.session.user.id]);
  res.json(rows);
}));
app.get('/api/admin/devices', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(`SELECT d.*, u.display_name AS owner_name, u.email AS owner_email, p.name AS purpose_name
    FROM devices d JOIN users u ON u.id=d.owner_id LEFT JOIN purposes p ON p.id=d.purpose_id WHERE d.status='active'
    ORDER BY d.created_at DESC`);
  res.json(rows);
}));
app.get('/api/devices/export', requireUser, asyncRoute(async (req, res) => {
  const params = isAdmin(req) ? [] : [req.session.user.id];
  const filter = isAdmin(req) ? "WHERE d.status='active'" : "WHERE d.owner_id = $1 AND d.status='active'";
  const { rows } = await pool.query(`SELECT d.device_name, d.mac_address, p.name AS purpose_name, d.expires_at, d.status, u.email AS owner_email
    FROM devices d JOIN users u ON u.id=d.owner_id LEFT JOIN purposes p ON p.id=d.purpose_id ${filter}
    ORDER BY d.created_at DESC`, params);
  
  const csvData = stringify(rows.map(r => ({
    '端末名': r.device_name,
    'MACアドレス': r.mac_address,
    '利用期限': r.expires_at ? new Date(r.expires_at).toISOString().split('T')[0] : '',
    '状態': r.status,
    '所有者': r.owner_email
  })), { header: true, quoted: true });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="devices.csv"');
  res.send('\uFEFF' + csvData); // BOM for Excel
}));
app.get('/api/requests', requireUser, asyncRoute(async (req, res) => {
  const admin = isAdmin(req);
  const result = await pool.query(`${requestQuery(admin ? '' : 'WHERE r.requester_id = $1')} ORDER BY r.created_at DESC`, admin ? [] : [req.session.user.id]);
  res.json(result.rows);
}));
app.post('/api/requests', requireUser, asyncRoute(async (req, res) => {
  const { type = 'register', deviceId = null, deviceName, macAddress, purposeId = null, expiresAt = null, note = '' } = req.body;
  if (!['register', 'update', 'delete'].includes(type)) throw new Error('申請種別が不正です。');
  if (!String(deviceName || '').trim()) throw new Error('端末名を入力してください。');
  const mac = normaliseMac(macAddress);
  const date = type === 'delete' ? null : nullableDate(expiresAt);
  if (deviceId && req.session.user.role !== 'admin') {
    const ownership = await pool.query('SELECT id FROM devices WHERE id=$1 AND owner_id=$2', [deviceId, req.session.user.id]);
    if (!ownership.rowCount) return res.status(403).json({ message: 'この端末には申請権限がありません。' });
  }
  const duplicate = await pool.query(`SELECT id FROM devices WHERE mac_address=$1 AND status='active' ${deviceId ? 'AND id <> $2' : ''}`, deviceId ? [mac, deviceId] : [mac]);
  if (duplicate.rowCount && type !== 'delete') return res.status(409).json({ message: 'このMACアドレスはすでに登録されています。' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`INSERT INTO device_requests
      (requester_id,type,device_id,device_name,mac_address,purpose_id,expires_at,note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [req.session.user.id, type, deviceId, String(deviceName).trim(), mac, purposeId || null, date, String(note).trim() || null]);
    await audit(client, req.session.user.id, 'request_created', 'device_request', rows[0].id, { type, mac });
    
    if (req.session.user.role === 'admin') {
      await processReview(client, rows[0].id, true, req.session.user.id, '自動承認（管理者による直接操作）');
    }
    
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.get('/api/requests/template', requireUser, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="template.csv"');
  res.send('\uFEFF' + '端末名,MACアドレス,利用期限,備考\nテスト端末,AA:BB:CC:DD:EE:FF,2025-12-31,テスト用\n');
});
app.post('/api/requests/import', requireUser, upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw new Error('ファイルが選択されていません。');
  const records = parse(req.file.buffer.toString(), { columns: true, skip_empty_lines: true, bom: true, trim: true });
  if (!records.length) throw new Error('データがありません。');
  
  const client = await pool.connect();
  let count = 0;
  try {
    await client.query('BEGIN');
    const queries = [];
    for (const row of records) {
      const deviceName = row['端末名'] || '';
      if (!deviceName) continue;
      let mac;
      try { mac = normaliseMac(row['MACアドレス']); } catch (e) { throw new Error(`エラー (${deviceName}): ` + e.message); }
      
      let expiresAt = null;
      try { expiresAt = nullableDate(row['利用期限']); } catch (e) { throw new Error(`エラー (${deviceName}): ` + e.message); }
      const note = row['備考'] || null;
      
      const duplicate = await client.query(`SELECT id FROM devices WHERE mac_address=$1 AND status='active'`, [mac]);
      if (duplicate.rowCount) throw new Error(`重複エラー: ${mac} はすでに登録されています。`);
      
      queries.push(
        client.query(`INSERT INTO device_requests 
        (requester_id,type,device_name,mac_address,purpose_id,expires_at,note)
        VALUES ($1,'register',$2,$3,NULL,$4,$5) RETURNING id`, [req.session.user.id, deviceName, mac, expiresAt, note])
      );
    }
    const results = await Promise.all(queries);
    for (const resItem of results) {
      const requestId = resItem.rows[0].id;
      await audit(client, req.session.user.id, 'request_created', 'device_request', requestId, { type: 'register', batch: true });
      if (req.session.user.role === 'admin') {
        await processReview(client, requestId, true, req.session.user.id, '自動承認（管理者による一括登録）');
      }
      count++;
    }
    await client.query('COMMIT');
    res.json({ count });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

app.get('/api/admin/users', requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  const { rows } = await pool.query("SELECT id,email,display_name,role,active,created_at, password_hash='*SSO-MANAGED*' AS sso FROM users ORDER BY role DESC, display_name");
  res.json(rows);
}));
app.post('/api/admin/users', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const { email, displayName, password, role = 'user' } = req.body;
  if (!/^\S+@\S+\.\S+$/.test(String(email))) throw new Error('有効なメールアドレスを入力してください。');
  if (!String(displayName || '').trim() || String(password || '').length < 10) throw new Error('表示名と10文字以上のパスワードを入力してください。');
  if (!['user', 'admin'].includes(role)) throw new Error('ロールが不正です。');
  const hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query('INSERT INTO users (email,display_name,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id,email,display_name,role,active', [String(email).toLowerCase(), String(displayName).trim(), hash, role]);
  res.status(201).json(rows[0]);
}));
app.patch('/api/admin/users/:id', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const userId = Number(req.params.id);
  const { email, displayName, role, active, password } = req.body;
  if (!Number.isInteger(userId)) throw new Error('ユーザーIDが不正です。');
  if (!/^\S+@\S+\.\S+$/.test(String(email || ''))) throw new Error('有効なメールアドレスを入力してください。');
  if (!String(displayName || '').trim()) throw new Error('表示名を入力してください。');
  if (!['user', 'admin'].includes(role) || typeof active !== 'boolean') throw new Error('ユーザー設定が不正です。');
  if (password && String(password).length < 10) throw new Error('パスワードは10文字以上で入力してください。');
  const target = await pool.query('SELECT id, role, active FROM users WHERE id=$1', [userId]);
  if (!target.rowCount) return res.status(404).json({ message: 'ユーザーが見つかりません。' });
  const admins = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role='admin' AND active=TRUE");
  if (target.rows[0].role === 'admin' && target.rows[0].active && (role !== 'admin' || !active) && admins.rows[0].count <= 1) return res.status(409).json({ message: '最後の有効な管理者はロール変更・無効化できません。' });
  if (userId === Number(req.session.user.id) && (!active || role !== 'admin')) return res.status(409).json({ message: '自分自身の管理者権限を解除・無効化することはできません。' });
  const values = [String(email).trim().toLowerCase(), String(displayName).trim(), role, active, userId];
  let sql = 'UPDATE users SET email=$1,display_name=$2,role=$3,active=$4,updated_at=NOW()';
  if (password) { values.splice(4, 0, await bcrypt.hash(String(password), 12)); sql += ',password_hash=$5 WHERE id=$6'; }
  else sql += ' WHERE id=$5';
  const { rows } = await pool.query(`${sql} RETURNING id,email,display_name,role,active,created_at`, values);
  const client = await pool.connect();
  try { await audit(client, req.session.user.id, 'user_updated', 'user', userId, { role, active }); } finally { client.release(); }
  res.json(rows[0]);
}));
app.post('/api/admin/users/batch-delete', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) throw new Error('対象が選択されていません。');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of ids) {
      const targetId = Number(id);
      if (targetId === Number(req.session.user.id)) throw new Error('自分自身は削除できません。');
      const target = await client.query('SELECT role, active FROM users WHERE id=$1', [targetId]);
      if (!target.rowCount) continue;
      
      const admins = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE role='admin' AND active=TRUE");
      if (target.rows[0].role === 'admin' && target.rows[0].active && admins.rows[0].count <= 1) {
        throw new Error('最後の有効な管理者は削除できません。');
      }
      
      // ユーザーの削除または無効化に伴う、認証情報(radcheck)と端末(devices)のクリーンアップ
      const devices = await client.query('SELECT mac_address FROM devices WHERE owner_id=$1', [targetId]);
      for (const d of devices.rows) {
        for (const m of getMacFormats(d.mac_address)) {
          await client.query('DELETE FROM radcheck WHERE username=$1', [m]);
        }
      }
      await client.query("UPDATE devices SET status='disabled', updated_at=NOW() WHERE owner_id=$1", [targetId]);
      
      try {
        await client.query('DELETE FROM users WHERE id=$1', [targetId]);
      } catch (e) {
        if (e.code === '23503') { // foreign_key_violation
          await client.query('UPDATE users SET active=false WHERE id=$1', [targetId]);
        } else throw e;
      }
      await audit(client, req.session.user.id, 'user_deleted', 'user', targetId, {});
    }
    await client.query('COMMIT');
    res.json({ count: ids.length });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

// ヘルパー: 1つのMACアドレスから、colon, hyphen, plain の3つのフォーマット配列を返す
function getMacFormats(mac) {
  if (!mac) return [];
  const plain = mac.replace(/[:-]/g, '').toLowerCase();
  if (plain.length !== 12) return [mac];
  const colon = plain.match(/.{1,2}/g).join(':');
  const hyphen = plain.match(/.{1,2}/g).join('-');
  // radcheckに登録する全パターンの配列（重複排除）
  return [...new Set([colon, hyphen, plain, plain.toUpperCase(), colon.toUpperCase(), hyphen.toUpperCase()])];
}

async function processReview(client, requestId, approved, reviewerId, note) {
  const { rows } = await client.query('SELECT * FROM device_requests WHERE id=$1 FOR UPDATE', [requestId]);
  const request = rows[0];
  if (!request) throw new Error('申請が見つかりません。');
  if (request.status !== 'pending') throw new Error('この申請はすでに処理済みです。');
  
  if (approved) {
    if (request.type === 'register') {
      const exists = await client.query("SELECT id FROM devices WHERE mac_address=$1 AND status='active' FOR UPDATE", [request.mac_address]);
      if (exists.rowCount) throw new Error(`承認エラー: ${request.mac_address} はすでに登録されています。`);
      const device = await client.query(`INSERT INTO devices (owner_id,device_name,mac_address,purpose_id,expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [request.requester_id, request.device_name, request.mac_address, request.purpose_id, request.expires_at]);
      
      for (const m of getMacFormats(request.mac_address)) {
        await client.query(`INSERT INTO radcheck (username,attribute,op,value) VALUES ($1,'Cleartext-Password',':=',$1)
          ON CONFLICT (username,attribute) DO UPDATE SET op=':=', value=EXCLUDED.value`, [m]);
      }
      await client.query('UPDATE device_requests SET device_id=$1 WHERE id=$2', [device.rows[0].id, request.id]);
    } else if (request.type === 'update') {
      const device = await client.query('SELECT * FROM devices WHERE id=$1 FOR UPDATE', [request.device_id]);
      if (!device.rowCount) throw new Error('更新対象の端末がありません。');
      
      if (device.rows[0].mac_address !== request.mac_address) {
        for (const m of getMacFormats(device.rows[0].mac_address)) {
          await client.query('DELETE FROM radcheck WHERE username=$1', [m]);
        }
      }
      
      await client.query(`UPDATE devices SET device_name=$1,mac_address=$2,purpose_id=$3,expires_at=$4,status='active',updated_at=NOW() WHERE id=$5`, [request.device_name, request.mac_address, request.purpose_id, request.expires_at, request.device_id]);
      
      for (const m of getMacFormats(request.mac_address)) {
        await client.query(`INSERT INTO radcheck (username,attribute,op,value) VALUES ($1,'Cleartext-Password',':=',$1)
          ON CONFLICT (username,attribute) DO UPDATE SET op=':=', value=EXCLUDED.value`, [m]);
      }
    } else {
      const device = await client.query('SELECT mac_address FROM devices WHERE id=$1 FOR UPDATE', [request.device_id]);
      if (!device.rowCount) throw new Error('削除対象の端末がありません。');
      await client.query("UPDATE devices SET status='disabled',updated_at=NOW() WHERE id=$1", [request.device_id]);
      
      for (const m of getMacFormats(device.rows[0].mac_address)) {
        await client.query('DELETE FROM radcheck WHERE username=$1', [m]);
      }
    }
  }
  await client.query(`UPDATE device_requests SET status=$1,reviewer_id=$2,review_note=$3,reviewed_at=NOW() WHERE id=$4`, [approved ? 'approved' : 'rejected', reviewerId, note, request.id]);
  await audit(client, reviewerId, approved ? 'request_approved' : 'request_rejected', 'device_request', request.id, { type: request.type, mac: request.mac_address });
}

app.post('/api/admin/requests/:id/review', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const approved = Boolean(req.body.approved);
  const note = String(req.body.note || '').trim() || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await processReview(client, req.params.id, approved, req.session.user.id, note);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

app.post('/api/admin/requests/batch-review', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const { ids, approved, note } = req.body;
  if (!Array.isArray(ids) || !ids.length) throw new Error('対象が選択されていません。');
  const client = await pool.connect();
  let count = 0;
  try {
    await client.query('BEGIN');
    for (const id of ids) {
      try {
        await processReview(client, id, Boolean(approved), req.session.user.id, String(note || '').trim() || null);
        count++;
      } catch (err) {
        // バッチ処理なので、1件でも失敗したら全体をロールバックするか、エラーをスキップするか
        // ここでは全体をロールバックする（トランザクション保護）
        throw new Error(`ID ${id} の処理に失敗しました: ` + err.message);
      }
    }
    await client.query('COMMIT');
    res.json({ count });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.get('/api/admin/accounting', requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`SELECT radacctid,username,nasipaddress,acctstarttime,acctstoptime,acctsessiontime,callingstationid,calledstationid,acctterminatecause
    FROM radacct ORDER BY COALESCE(acctupdatetime, acctstarttime) DESC NULLS LAST LIMIT 100`);
  res.json(rows);
}));

app.get('/api/admin/settings', requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  const settings = rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
  res.json(settings);
}));

app.put('/api/admin/settings', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const settings = req.body;
  if (!settings || typeof settings !== 'object') throw new Error('無効な設定データです。');
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(settings)) {
      if (!key.startsWith('retention_')) continue;
      const num = parseInt(value, 10);
      if (isNaN(num) || num < 1 || num > 120) throw new Error(`${key} の保持期間は1〜120ヶ月の間で指定してください。`);
      await client.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, String(num)]);
    }
    await audit(client, req.session.user.id, 'settings_updated', 'system', null, settings);
    await client.query('COMMIT');
    res.json({ ok: true });
    
    // 設定変更後に即時クリーンアップを実行
    cleanupOldLogs();
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = error.code === '23505' ? 409 : 400;
  res.status(status).json({ message: error.message || '処理中にエラーが発生しました。' });
});
app.listen(port, () => console.log(`MAC Auth Service listening on http://localhost:${port}`));
