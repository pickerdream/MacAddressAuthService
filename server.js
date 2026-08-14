import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const { Pool } = pg;
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const port = Number(process.env.PORT || 3000);
const macFormat = process.env.RADIUS_MAC_FORMAT || 'colon';
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) throw new Error('SESSION_SECRET must be configured in production.');

app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 },
}));
app.use(express.static('public'));

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
app.get('/api/session', (req, res) => res.json({ user: req.session.user || null, radiusMacFormat: macFormat }));

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
  const params = isAdmin(req) ? [] : [req.session.user.id];
  const filter = isAdmin(req) ? '' : 'WHERE d.owner_id = $1';
  const { rows } = await pool.query(`SELECT d.*, u.display_name AS owner_name, u.email AS owner_email, p.name AS purpose_name
    FROM devices d JOIN users u ON u.id=d.owner_id LEFT JOIN purposes p ON p.id=d.purpose_id ${filter}
    ORDER BY d.created_at DESC`, params);
  res.json(rows);
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
  if (deviceId) {
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
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

app.get('/api/admin/users', requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  const { rows } = await pool.query('SELECT id,email,display_name,role,active,created_at FROM users ORDER BY role DESC, display_name');
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
app.post('/api/admin/requests/:id/review', requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const approved = Boolean(req.body.approved);
  const note = String(req.body.note || '').trim() || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM device_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
    const request = rows[0];
    if (!request) return res.status(404).json({ message: '申請が見つかりません。' });
    if (request.status !== 'pending') return res.status(409).json({ message: 'この申請はすでに処理済みです。' });
    if (approved) {
      if (request.type === 'register') {
        const exists = await client.query("SELECT id FROM devices WHERE mac_address=$1 AND status='active' FOR UPDATE", [request.mac_address]);
        if (exists.rowCount) return res.status(409).json({ message: '承認できません。このMACアドレスはすでに有効です。' });
        const device = await client.query(`INSERT INTO devices (owner_id,device_name,mac_address,purpose_id,expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [request.requester_id, request.device_name, request.mac_address, request.purpose_id, request.expires_at]);
        await client.query(`INSERT INTO radcheck (username,attribute,op,value) VALUES ($1,'Cleartext-Password',':=',$1)
          ON CONFLICT (username,attribute) DO UPDATE SET op=':=', value=EXCLUDED.value`, [request.mac_address]);
        await client.query('UPDATE device_requests SET device_id=$1 WHERE id=$2', [device.rows[0].id, request.id]);
      } else if (request.type === 'update') {
        const device = await client.query('SELECT * FROM devices WHERE id=$1 FOR UPDATE', [request.device_id]);
        if (!device.rowCount) return res.status(409).json({ message: '更新対象の端末がありません。' });
        if (device.rows[0].mac_address !== request.mac_address) await client.query('DELETE FROM radcheck WHERE username=$1', [device.rows[0].mac_address]);
        await client.query(`UPDATE devices SET device_name=$1,mac_address=$2,purpose_id=$3,expires_at=$4,status='active',updated_at=NOW() WHERE id=$5`, [request.device_name, request.mac_address, request.purpose_id, request.expires_at, request.device_id]);
        await client.query(`INSERT INTO radcheck (username,attribute,op,value) VALUES ($1,'Cleartext-Password',':=',$1)
          ON CONFLICT (username,attribute) DO UPDATE SET op=':=', value=EXCLUDED.value`, [request.mac_address]);
      } else {
        const device = await client.query('SELECT mac_address FROM devices WHERE id=$1 FOR UPDATE', [request.device_id]);
        if (!device.rowCount) return res.status(409).json({ message: '削除対象の端末がありません。' });
        await client.query("UPDATE devices SET status='disabled',updated_at=NOW() WHERE id=$1", [request.device_id]);
        await client.query('DELETE FROM radcheck WHERE username=$1', [device.rows[0].mac_address]);
      }
    }
    await client.query(`UPDATE device_requests SET status=$1,reviewer_id=$2,review_note=$3,reviewed_at=NOW() WHERE id=$4`, [approved ? 'approved' : 'rejected', req.session.user.id, note, request.id]);
    await audit(client, req.session.user.id, approved ? 'request_approved' : 'request_rejected', 'device_request', request.id, { type: request.type, mac: request.mac_address });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.get('/api/admin/accounting', requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`SELECT radacctid,username,nasipaddress,acctstarttime,acctstoptime,acctsessiontime,callingstationid,calledstationid,acctterminatecause
    FROM radacct ORDER BY COALESCE(acctupdatetime, acctstarttime) DESC NULLS LAST LIMIT 100`);
  res.json(rows);
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = error.code === '23505' ? 409 : 400;
  res.status(status).json({ message: error.message || '処理中にエラーが発生しました。' });
});
app.listen(port, () => console.log(`MAC Auth Service listening on http://localhost:${port}`));
