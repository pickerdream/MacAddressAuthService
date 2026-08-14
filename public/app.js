const state = { user: null, page: 'home', devices: [], allDevices: [], requests: [], purposes: [], users: [], accounting: [], settings: {}, sort: { key: null, dir: 1 }, filters: {}, activeMenu: null, pagination: { page: 1, limit: 30 } };
const $ = (selector) => document.querySelector(selector);
const api = async (path, options = {}) => {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || '通信エラーが発生しました。');
  return body;
};
const escape = (value = '') => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const date = (value) => value ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '無期限';
const status = (value) => `<span class="badge ${escape(value)}">${({active:'有効',disabled:'停止',pending:'承認待ち',approved:'承認済み',rejected:'却下',register:'登録',update:'変更',delete:'削除'})[value] || escape(value)}</span>`;
function notice(message) { const t = $('#toast'); t.textContent = message; t.hidden = false; clearTimeout(notice.timer); notice.timer = setTimeout(() => t.hidden = true, 3200); }

function filterData(rows, columns) {
  if (Object.keys(state.filters).length === 0) return rows;
  return rows.filter(row => {
    return columns.every(c => {
      const q = state.filters[c.sortKey || c.label];
      if (!q) return true;
      const text = String(c.value(row)).replace(/<[^>]*>?/gm, '').toLowerCase();
      return text.includes(q.toLowerCase());
    });
  });
}

function sortData(rows, columns) {
  if (!state.sort.key) return rows;
  const col = columns.find(c => (c.sortKey || c.label) === state.sort.key);
  if (!col || !col.sortValue) return rows;
  return [...rows].sort((a, b) => {
    const va = col.sortValue(a);
    const vb = col.sortValue(b);
    if (va < vb) return -1 * state.sort.dir;
    if (va > vb) return 1 * state.sort.dir;
    return 0;
  });
}

function renderTable(rows, columns, options = {}) {
  const empty = options.empty || '表示するデータはありません。';
  const selectable = options.selectable;
  const doPaginate = options.paginate !== false; // デフォルトでページネーション有効
  const filtered = filterData(rows, columns);
  const sorted = sortData(filtered, columns);

  const headers = columns.map(c => {
    const key = c.sortKey || c.label;
    const hasFilter = !!state.filters[key];
    const isSorted = state.sort.key === key;
    let cls = 'cursor-pointer select-none';
    if (hasFilter) cls += ' has-filter';
    let icon = '▾';
    if (isSorted) icon = state.sort.dir === 1 ? '▲' : '▼';
    else if (hasFilter) icon = '◒';
    if (c.label === '操作' || !c.sortValue) {
      return `<th>${c.label}</th>`;
    }
    return `<th class="${cls}" data-col="${key}">${c.label} ${icon}</th>`;
  }).join('');

  const selectAll = selectable ? `<th><input type="checkbox" id="check-all"></th>` : '';
  const headHTML = `<thead><tr>${selectAll}${headers}</tr></thead>`;

  if (!filtered.length) {
    return `<div class="table-wrap"><table>${headHTML}<tbody><tr><td colspan="${columns.length + (selectable ? 1 : 0)}" class="empty">${empty}</td></tr></tbody></table></div>`;
  }

  let paginated = sorted;
  let paginationHTML = '';
  
  if (doPaginate) {
    const totalItems = sorted.length;
    const limit = state.pagination.limit;
    const totalPages = Math.ceil(totalItems / limit);
    // ページ番号が範囲外にならないよう補正
    if (state.pagination.page > totalPages) state.pagination.page = totalPages;
    if (state.pagination.page < 1) state.pagination.page = 1;
    
    const page = state.pagination.page;
    const startIdx = (page - 1) * limit;
    paginated = sorted.slice(startIdx, startIdx + limit);
    
    const limits = [10, 30, 50].map(l => `<option value="${l}" ${l === limit ? 'selected' : ''}>${l}件表示</option>`).join('');
    
    paginationHTML = `
      <div class="pagination">
        <select class="per-page-select">${limits}</select>
        <span class="pagination-info">${startIdx + 1} - ${Math.min(startIdx + limit, totalItems)} / ${totalItems} 件</span>
        <div class="pagination-controls">
          <button class="page-btn page-prev" ${page === 1 ? 'disabled' : ''}>前へ</button>
          <span>${page} / ${totalPages}</span>
          <button class="page-btn page-next" ${page === totalPages ? 'disabled' : ''}>次へ</button>
        </div>
      </div>
    `;
  }

  const body = paginated.map(row => {
    const cols = columns.map(c => `<td>${c.value(row)}</td>`).join('');
    const check = selectable ? `<td><input type="checkbox" class="row-checkbox" value="${row.id}"></td>` : '';
    return `<tr>${check}${cols}</tr>`;
  }).join('');

  return `<div class="table-wrap"><table>${headHTML}<tbody>${body}</tbody></table></div>${paginationHTML}`;
}

async function loadBase() { 
  const promises = [api('/api/devices'), api('/api/requests'), api('/api/purposes')];
  if (state.user?.role === 'admin') promises.push(api('/api/admin/devices'));
  const res = await Promise.all(promises);
  state.devices = res[0]; state.requests = res[1]; state.purposes = res[2];
  if (state.user?.role === 'admin') state.allDevices = res[3];
}

async function loadMembersData() {
  if (state.user?.role === 'admin') {
    state.users = await api('/api/admin/users');
  }
}

async function loadAccountingData() {
  if (state.user?.role === 'admin') {
    state.accounting = await api('/api/admin/accounting');
  }
}

async function loadSettingsData() {
  if (state.user?.role === 'admin') {
    state.settings = await api('/api/admin/settings');
  }
}

const appContent = {
  home() { 
    const active = state.devices.filter(x => x.status === 'active'); 
    const pending = state.requests.filter(x => x.status === 'pending'); 
    
    const statsHTML = `<div class="stats">
      <article class="stat lime"><span class="eyebrow">ACTIVE DEVICES</span><strong>${active.length}</strong><span>現在有効な認証端末</span></article>
      <article class="stat"><span class="eyebrow">PENDING REQUESTS</span><strong>${pending.length}</strong><span>確認待ちの申請</span></article>
      <article class="stat"><span class="eyebrow">ACCESS EXPIRES</span><strong>${active.filter(x => x.expires_at).length}</strong><span>期限が設定された端末</span></article>
    </div>`;

    return `${statsHTML}<section class="card"><div class="split-head"><div><span class="eyebrow">RECENT ACTIVITY</span><h2>最近の申請</h2></div><button class="small-button secondary" data-go="request">${state.user.role === 'admin' ? '新規登録' : '新しい申請'}</button></div>${renderTable(state.requests.slice(0,5), [{label:'種別',value:x=>status(x.type)},{label:'端末',value:x=>`<strong>${escape(x.device_name)}</strong><br><span class="mono">${escape(x.mac_address)}</span>`},{label:'状態',value:x=>status(x.status)},{label:'日時',value:x=>date(x.created_at)}], { paginate: false })}</section>`; 
  },
  
  devices() { return `<section class="card"><div class="split-head"><div><span class="eyebrow">MY DEVICES</span><h2>自分の端末</h2></div><div class="actions"><button class="small-button primary" data-go="request">＋ 登録${state.user.role === 'admin' ? '' : '申請'}</button></div></div>
  <div class="actions" style="margin-bottom: 1rem;"><button class="small-button danger batch-btn" id="batch-delete" disabled>選択した端末を一括削除${state.user.role === 'admin' ? '' : '申請'}</button></div>
  ${renderTable(state.devices, [
    {label:'端末名',sortKey:'name',sortValue:x=>x.device_name,value:x=>`<strong>${escape(x.device_name)}</strong><br><span class="mono">${escape(x.mac_address)}</span>`},
    {label:'利用期限',sortKey:'expires',sortValue:x=>x.expires_at||'9999-12-31',value:x=>date(x.expires_at)},
    {label:'状態',sortKey:'status',sortValue:x=>x.status,value:x=>status(x.status)},
    {label:'操作',value:x=>`<button class="small-button secondary" data-edit="${x.id}">変更${state.user.role === 'admin' ? '' : '申請'}</button> <button class="small-button danger" data-delete="${x.id}">削除${state.user.role === 'admin' ? '' : '申請'}</button>`}
  ], { selectable: true })}</section>`; },
  
  all_devices() { return `<section class="card"><div class="split-head"><div><span class="eyebrow">ALL DEVICES</span><h2>全端末管理</h2></div><div class="actions"><a href="/api/devices/export" class="small-button secondary" download>CSVエクスポート</a><button class="small-button primary" data-go="request">＋ 端末登録</button></div></div>
  <div class="actions" style="margin-bottom: 1rem;"><button class="small-button danger batch-btn" id="batch-delete" disabled>選択した端末を一括削除</button></div>
  ${renderTable(state.allDevices, [
    {label:'端末名',sortKey:'name',sortValue:x=>x.device_name,value:x=>`<strong>${escape(x.device_name)}</strong><br><span class="mono">${escape(x.mac_address)}</span>`},
    {label:'所有者',sortKey:'owner',sortValue:x=>x.owner_name,value:x=>escape(x.owner_name)},
    {label:'利用期限',sortKey:'expires',sortValue:x=>x.expires_at||'9999-12-31',value:x=>date(x.expires_at)},
    {label:'操作',value:x=>`<button class="small-button secondary" data-edit="${x.id}">変更</button> <button class="small-button danger" data-delete="${x.id}">削除</button>`}
  ], { selectable: true })}</section>`; },

  request() { const device = state.editDevice; const admin = state.user.role === 'admin'; return `<section class="card form-card"><div class="split-head"><div><span class="eyebrow">DEVICE REQUEST</span><h2>${device ? `端末変更${admin ? '' : '申請'}` : `MACアドレス登録${admin ? '' : '申請'}`}</h2></div></div><div class="notice">MACアドレスは ${escape(state.radiusMacFormat)} 形式でFreeRADIUSに登録されます。</div><form id="request-form" class="form-grid"><input type="hidden" name="deviceId" value="${device?.id || ''}"><input type="hidden" name="type" value="${device ? 'update' : 'register'}"><label>申請者<input value="${escape(state.user.displayName)}" disabled></label><label class="wide">端末名<input name="deviceName" required value="${escape(device?.device_name || '')}" placeholder="例：Kouta のノートPC"></label><label>MACアドレス<input class="mono" name="macAddress" required value="${escape(device?.mac_address || '')}" placeholder="AA:BB:CC:DD:EE:FF"></label><label>利用期限（空欄なら無期限）<input name="expiresAt" type="datetime-local" value="${device?.expires_at ? new Date(device.expires_at).toISOString().slice(0,16) : ''}"></label><label class="wide">備考<textarea name="note" rows="4" placeholder="備考や補足事項があれば記載してください。"></textarea></label><div class="wide actions"><button class="button primary">${admin ? '登録を実行する' : '申請を送る'} <span>→</span></button></div></form></section>
  ${!device ? `<section class="card form-card" style="margin-top:20px"><div class="split-head"><div><span class="eyebrow">BATCH REQUEST</span><h2>CSV一括登録${admin ? '' : '申請'}</h2></div></div><form id="import-form" class="form-grid"><label class="wide">テンプレート<br><a href="/api/requests/template" download class="small-button secondary" style="display:inline-block;margin-top:8px">テンプレートCSVをダウンロード</a></label><label class="wide">CSVファイルを選択<input type="file" name="file" accept=".csv" required></label><div class="wide actions"><button type="submit" class="button primary" id="import-button">一括${admin ? '登録' : '申請'}する <span>→</span></button></div></form></section>` : ''}`; },
  
  requests() { return `<section class="card"><div class="split-head"><div><span class="eyebrow">REQUEST HISTORY</span><h2>申請履歴</h2></div></div>${renderTable(state.requests, [
    {label:'申請',sortKey:'type',sortValue:x=>x.type,value:x=>status(x.type)},
    {label:'端末',sortKey:'name',sortValue:x=>x.device_name,value:x=>`<strong>${escape(x.device_name)}</strong><br><span class="mono">${escape(x.mac_address)}</span>`},
    {label:'状態',sortKey:'status',sortValue:x=>x.status,value:x=>status(x.status)},
    {label:'コメント',value:x=>escape(x.review_note||'—')},
    {label:'日時',sortKey:'created_at',sortValue:x=>x.created_at,value:x=>date(x.created_at)}
  ])}</section>`; },
  
  review() { const pending = state.requests.filter(x=>x.status==='pending'); return `<section class="card"><div class="split-head"><div><span class="eyebrow">APPROVAL QUEUE</span><h2>承認待ちの申請</h2></div></div>
  <div class="actions" style="margin-bottom: 1rem; align-items:center;"><input type="text" id="batch-note" placeholder="一括処理のコメント(任意)" style="padding:6px; font-size:14px; flex:1; max-width:300px; min-width:150px;"><button class="small-button primary batch-btn" id="batch-approve" disabled>選択した申請を承認</button> <button class="small-button danger batch-btn" id="batch-reject" disabled>選択した申請を却下</button></div>
  ${renderTable(pending, [
    {label:'申請者',sortKey:'requester',sortValue:x=>x.requester_name,value:x=>`<strong>${escape(x.requester_name)}</strong><br><span class="log-details">${escape(x.requester_email)}</span>`},
    {label:'内容',sortKey:'type',sortValue:x=>x.type,value:x=>`${status(x.type)} <strong>${escape(x.device_name)}</strong><br><span class="mono">${escape(x.mac_address)}</span>`},
    {label:'詳細',value:x=>`期限：${date(x.expires_at)}<br><span class="log-details">${escape(x.note||'備考なし')}</span>`},
    {label:'操作',value:x=>`<div class="actions" style="flex-direction:column;gap:4px;align-items:stretch;"><input type="text" id="note-${x.id}" placeholder="コメント(任意)" style="padding:4px;font-size:12px;width:100%;box-sizing:border-box;"><div style="display:flex;gap:4px;justify-content:flex-end;"><button class="small-button danger" data-review="${x.id}:false">却下</button><button class="small-button primary" data-review="${x.id}:true">承認</button></div></div>`}
  ], { selectable: true })}</section>`; },
  
  accounting() { return `<section class="card"><div class="split-head"><div><span class="eyebrow">RADIUS ACCOUNTING</span><h2>接続ログ</h2></div>
    <div class="actions">
      <a href="/api/admin/accounting/export" target="_blank" class="small-button secondary">CSVで一括ダウンロード</a>
      <button class="small-button danger batch-btn" id="batch-accounting-delete" disabled>選択したログを削除</button>
    </div>
  </div>
  ${renderTable(state.accounting,[
    {label:'MAC / Username',sortKey:'mac',sortValue:x=>x.username,value:x=>`<span class="mono">${escape(x.username||x.callingstationid||'—')}</span>`},
    {label:'NAS',value:x=>escape(x.nasipaddress||'—')},
    {label:'開始',sortKey:'start',sortValue:x=>x.acctstarttime,value:x=>date(x.acctstarttime)},
    {label:'終了',sortKey:'stop',sortValue:x=>x.acctstoptime,value:x=>x.acctstoptime?date(x.acctstoptime):status('active')},
    {label:'セッション',sortKey:'session',sortValue:x=>x.acctsessiontime,value:x=>x.acctsessiontime?`${Math.floor(x.acctsessiontime/60)} 分`:'—'}
  ], { selectable: true, empty: 'まだアカウンティングログはありません。' })}</section>`; },
  
  members() { return `<section class="card"><div class="split-head"><div><span class="eyebrow">MEMBER DIRECTORY</span><h2>メンバー管理</h2></div><div class="actions"><button class="small-button danger batch-btn" id="batch-member-delete" disabled>一括削除</button><button class="small-button primary" id="add-member">＋ メンバー追加</button></div></div><div id="member-form" hidden></div>
  ${renderTable(state.users,[
    {label:'氏名',sortKey:'name',sortValue:x=>x.display_name,value:x=>`<strong>${escape(x.display_name)}</strong>`},
    {label:'メールアドレス',sortKey:'email',sortValue:x=>x.email,value:x=>escape(x.email)},
    {label:'ロール',sortKey:'role',sortValue:x=>x.role,value:x=>status(x.role)},
    {label:'状態',sortKey:'active',sortValue:x=>x.active,value:x=>status(x.active?'active':'disabled')},
    {label:'登録日',sortKey:'created',sortValue:x=>x.created_at,value:x=>date(x.created_at)},
    {label:'操作',value:x=>`<button class="small-button secondary member-edit" data-member-edit="${x.id}">編集</button> <button class="small-button danger member-delete" data-member-delete="${x.id}">削除</button>`}
  ], { selectable: true })}</section>`; },
  
  settings() { return `<section class="card form-card"><div class="split-head"><div><span class="eyebrow">SYSTEM SETTINGS</span><h2>データ保持期間</h2></div></div>
  <div class="notice">指定した期間を超過した古いログ・履歴は、バックグラウンド処理により自動的に削除されます。</div>
  <form id="settings-form" class="form-grid">
    <label>接続ログの保持期間 (月)<input type="number" name="retention_accounting_months" min="1" max="120" required value="${state.settings.retention_accounting_months || 3}"></label>
    <label>申請履歴の保持期間 (月)<input type="number" name="retention_requests_months" min="1" max="120" required value="${state.settings.retention_requests_months || 3}"></label>
    <label>監査ログの保持期間 (月)<input type="number" name="retention_audit_months" min="1" max="120" required value="${state.settings.retention_audit_months || 3}"></label>
    <div class="wide actions"><button class="button primary" type="submit">設定を保存する</button></div>
  </form></section>`; }
};

function render() { 
  const titles = {home:['OVERVIEW','概要'],devices:['DEVICE INVENTORY','自分の端末'],all_devices:['ALL DEVICES','全端末管理'],request:['NEW REQUEST',state.user.role==='admin'?'新規登録':'申請する'],requests:['REQUEST HISTORY','申請履歴'],review:['ADMINISTRATION','承認待ち'],accounting:['ADMINISTRATION','接続ログ'],members:['ADMINISTRATION','メンバー管理'],settings:['ADMINISTRATION','システム設定']}; 
  const [k,t]=titles[state.page]; $('#page-kicker').textContent=k; $('#page-title').textContent=t; 
  $('#page-content').innerHTML=appContent[state.page](); 
  document.querySelectorAll('#navigation button').forEach(b=>b.classList.toggle('active',b.dataset.page===state.page)); 
  bindPage(); 
}

async function go(page, device = null, push = true) { 
  state.page = page; 
  state.editDevice = page === 'request' ? device : null; 
  state.filters = {}; state.sort = { key: null, dir: 1 }; state.activeMenu = null;
  state.pagination.page = 1;
  
  if (page === 'members') await loadMembersData();
  if (page === 'accounting') await loadAccountingData();
  if (page === 'settings') await loadSettingsData();
  if ($('#sidebar')) $('#sidebar').classList.remove('open');
  if ($('#column-menu')) $('#column-menu').hidden = true;
  
  if (push) {
    const urlPath = page === 'home' ? '/' : `/${page}`;
    if (window.location.pathname !== urlPath) {
      window.history.pushState({ page, device }, '', urlPath);
    }
  }
  render(); 
}

function bindPage() { 
  document.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go)); 
  document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>go('request', (state.devices.find(x=>String(x.id)===b.dataset.edit) || state.allDevices.find(x=>String(x.id)===b.dataset.edit)))); 
  document.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>deleteRequest(b.dataset.delete)); 
  document.querySelectorAll('[data-review]').forEach(b=>b.onclick=()=>review(...b.dataset.review.split(':'))); 
  document.querySelectorAll('[data-member-edit]').forEach(button=>button.onclick=()=>showMemberEditor(state.users.find(user=>Number(user.id)===Number(button.dataset.memberEdit))));
  document.querySelectorAll('[data-member-delete]').forEach(button=>button.onclick=()=>deleteMember(button.dataset.memberDelete));
  
  if ($('#add-member')) $('#add-member').onclick = showMemberCreate;
  
  document.querySelectorAll('th[data-col]').forEach(th => th.onclick = (e) => {
    e.stopPropagation();
    const key = th.dataset.col;
    state.activeMenu = key;
    const menu = $('#column-menu');
    menu.hidden = false;
    const rect = th.getBoundingClientRect();
    menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
    menu.style.left = `${rect.left + window.scrollX}px`;
    const input = $('#col-search-input');
    input.value = state.filters[key] || '';
    input.focus();
  });
  
  const pagePrev = document.querySelector('.page-prev');
  if (pagePrev) pagePrev.onclick = () => { state.pagination.page--; render(); };
  const pageNext = document.querySelector('.page-next');
  if (pageNext) pageNext.onclick = () => { state.pagination.page++; render(); };
  const perPageSelect = document.querySelector('.per-page-select');
  if (perPageSelect) perPageSelect.onchange = (e) => {
    state.pagination.limit = Number(e.target.value);
    state.pagination.page = 1;
    render();
  };
  
  if ($('#open-menu')) $('#open-menu').onclick = () => $('#sidebar').classList.add('open');
  if ($('#close-menu')) $('#close-menu').onclick = () => $('#sidebar').classList.remove('open');
  
  const checkAll = $('#check-all');
  const rowChecks = document.querySelectorAll('.row-checkbox');
  const batchBtns = document.querySelectorAll('.batch-btn');

  const updateBatchButtons = () => {
    const anyChecked = Array.from(rowChecks).some(c => c.checked);
    batchBtns.forEach(btn => btn.disabled = !anyChecked);
  };

  if (checkAll) {
    checkAll.onchange = (e) => {
      rowChecks.forEach(c => c.checked = e.target.checked);
      updateBatchButtons();
    };
  }
  rowChecks.forEach(c => c.onchange = updateBatchButtons);

  if ($('#batch-approve')) $('#batch-approve').onclick = () => batchReview(true);
  if ($('#batch-reject')) $('#batch-reject').onclick = () => batchReview(false);
  if ($('#batch-delete')) $('#batch-delete').onclick = () => batchDelete();
  if ($('#batch-member-delete')) $('#batch-member-delete').onclick = () => batchMemberDelete();
  if ($('#batch-accounting-delete')) $('#batch-accounting-delete').onclick = () => batchAccountingDelete();

  const form=$('#request-form'); if(form) form.onsubmit=submitRequest; 
  const importForm=$('#import-form'); if(importForm) importForm.onsubmit=submitImport; 
  const settingsForm=$('#settings-form'); if(settingsForm) settingsForm.onsubmit=saveSettings;
}

function getSelectedIds() {
  return Array.from(document.querySelectorAll('.row-checkbox:checked')).map(c => Number(c.value));
}

async function batchReview(approved) {
  const ids = getSelectedIds();
  if (!ids.length) return;
  const noteEl = document.getElementById('batch-note');
  const note = noteEl ? noteEl.value : '';
  try {
    const res = await api('/api/admin/requests/batch-review', { method: 'POST', body: JSON.stringify({ ids, approved, note }) });
    await loadBase(); render(); notice(`${res.count}件の申請を${approved ? '承認' : '却下'}しました。`);
  } catch(e) { notice(e.message); }
}

async function batchDelete() {
  const ids = getSelectedIds();
  if (!ids.length) return;
  if (!confirm(`選択した ${ids.length} 件の端末を削除${state.user.role === 'admin' ? 'します' : '申請します'}か？`)) return;
  
  let successCount = 0;
  let errors = [];
  for (const id of ids) {
    const device = state.devices.find(x => String(x.id) === String(id)) || state.allDevices.find(x => String(x.id) === String(id));
    if (!device) continue;
    try {
      await api('/api/requests', { method:'POST', body:JSON.stringify({ type:'delete', deviceId:id, deviceName:device.device_name, macAddress:device.mac_address }) });
      successCount++;
    } catch (e) {
      console.error(e);
      errors.push(`${device.device_name}: ${e.message}`);
    }
  }
  await loadBase(); render(); 
  if (errors.length > 0) {
    alert(`一部の端末でエラーが発生しました:\n${errors.join('\n')}`);
  }
  notice(`${successCount} 件の端末を削除${state.user.role === 'admin' ? 'しました' : '申請しました'}。`);
}

async function batchMemberDelete() {
  const ids = getSelectedIds();
  if (!ids.length) return;
  if (!confirm(`選択した ${ids.length} 人のメンバーを削除しますか？\n※関連データがある場合は「無効化」扱いになります。`)) return;
  try {
    const res = await api('/api/admin/users/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
    await loadMembersData(); render(); notice(`${res.count}人のメンバーを削除または無効化しました。`);
  } catch(e) { notice(e.message); }
}

async function batchAccountingDelete() {
  const ids = getSelectedIds();
  if (!ids.length) return;
  if (!confirm(`選択した ${ids.length} 件の接続ログを削除しますか？\n（この操作は元に戻せません）`)) return;
  try {
    const res = await api('/api/admin/accounting', { method: 'DELETE', body: JSON.stringify({ ids }) });
    await loadAccountingData(); render(); notice(`${res.count}件の接続ログを削除しました。`);
  } catch(e) { notice(e.message); }
}

async function deleteMember(id) {
  const user = state.users.find(x => Number(x.id) === Number(id));
  if (!user) return;
  if (!confirm(`${user.display_name} を削除しますか？\n※関連データがある場合は「無効化」扱いになります。`)) return;
  try {
    const res = await api('/api/admin/users/batch-delete', { method: 'POST', body: JSON.stringify({ ids: [id] }) });
    await loadMembersData(); render(); notice(`メンバーを削除または無効化しました。`);
  } catch(e) { notice(e.message); }
}

async function submitImport(e) { e.preventDefault(); const btn=$('#import-button'); btn.disabled=true; btn.textContent='アップロード中...'; try { const f=new FormData(e.target); const res = await fetch('/api/requests/import', { method:'POST', body:f }); const body = await res.json(); if(!res.ok) throw new Error(body.message); await loadBase(); state.page = state.user.role === 'admin' ? 'devices' : 'requests'; render(); notice(`${body.count} 件の${state.user.role === 'admin' ? '一括登録' : '一括申請'}を完了しました。`); } catch(err) { notice(err.message); } finally { btn.disabled=false; btn.innerHTML='一括申請する <span>→</span>'; } }
async function submitRequest(e) { e.preventDefault(); const f=new FormData(e.target); try { await api('/api/requests',{method:'POST',body:JSON.stringify({type:f.get('type'),deviceId:f.get('deviceId')||null,deviceName:f.get('deviceName'),macAddress:f.get('macAddress'),expiresAt:f.get('expiresAt')||null,note:f.get('note')})}); await loadBase(); state.page = state.user.role === 'admin' ? 'devices' : 'requests'; render(); notice(state.user.role === 'admin' ? '登録を完了しました。' : '申請を送信しました。'); } catch(e) { notice(e.message); } }
async function deleteRequest(id) { const device = state.devices.find(x=>String(x.id)===String(id)) || state.allDevices.find(x=>String(x.id)===String(id)); if(!device)return notice('端末が見つかりません。'); if(!confirm(`${device.device_name} の削除${state.user.role === 'admin' ? 'を実行' : '申請を送ります'}しますか？`))return; try{await api('/api/requests',{method:'POST',body:JSON.stringify({type:'delete',deviceId:id,deviceName:device.device_name,macAddress:device.mac_address})});await loadBase();state.page = state.user.role === 'admin' ? 'devices' : 'requests';render();notice(state.user.role === 'admin' ? '削除しました。' : '削除申請を送信しました。')}catch(e){notice(e.message)} }
async function review(id, approved) { const noteEl=document.getElementById(`note-${id}`); const note = noteEl ? noteEl.value : ''; try{await api(`/api/admin/requests/${id}/review`,{method:'POST',body:JSON.stringify({approved:approved==='true',note})});await loadBase();render();notice(approved==='true'?'承認し、RADIUS用DBへ反映しました。':'申請を却下しました。');}catch(e){notice(e.message)} }
async function saveSettings(e) { e.preventDefault(); const f=new FormData(e.target); try { await api('/api/admin/settings', { method:'PUT', body:JSON.stringify(Object.fromEntries(f)) }); notice('設定を保存し、クリーンアップ処理を実行しました。'); } catch(e) { notice(e.message); } }

function showMemberCreate(){const box=$('#member-form');box.hidden=false;box.innerHTML=`<form id="member-add" class="form-grid card" style="margin-bottom:16px"><label>氏名<input name="displayName" required></label><label>ロール<select name="role"><option value="user">利用者</option><option value="admin">管理者</option></select></label><label>メールアドレス<input name="email" type="email" required></label><label>初期パスワード<input name="password" type="password" minlength="10" required></label><div class="wide actions"><button class="small-button secondary" type="button" data-member-cancel>キャンセル</button><button class="small-button primary">追加する</button></div></form>`;$('#member-add').onsubmit=addMember;$('[data-member-cancel]').onclick=()=>box.hidden=true;}
function showMemberEditor(user){if(!user){notice('編集対象のユーザーを取得できませんでした。画面を再読み込みしてください。');return;}const box=$('#member-form');box.hidden=false;const pwdField=user.sso?'<div class="notice">このユーザーはSSO（SAML）経由で管理されているため、パスワードの変更はできません。</div>':'<label class="wide">新しいパスワード（変更しない場合は空欄）<input name="password" type="password" minlength="10" placeholder="10文字以上"></label>';box.innerHTML=`<form id="member-edit-form" class="form-grid card" style="margin-bottom:16px"><label>氏名<input name="displayName" required value="${escape(user.display_name)}"></label><label>ロール<select name="role"><option value="user" ${user.role==='user'?'selected':''}>利用者</option><option value="admin" ${user.role==='admin'?'selected':''}>管理者</option></select></label><label>メールアドレス<input name="email" type="email" required value="${escape(user.email)}"></label><label>状態<select name="active"><option value="true" ${user.active?'selected':''}>有効</option><option value="false" ${!user.active?'selected':''}>無効</option></select></label>${pwdField}<div class="wide actions"><button class="small-button secondary" type="button" data-member-cancel>キャンセル</button><button class="small-button primary">変更を保存</button></div></form>`;$('#member-edit-form').onsubmit=e=>updateMember(e,user.id);$('[data-member-cancel]').onclick=()=>box.hidden=true;}
async function addMember(e){e.preventDefault();const f=new FormData(e.target);try{await api('/api/admin/users',{method:'POST',body:JSON.stringify(Object.fromEntries(f))});notice('メンバーを追加しました。');await loadMembersData();render();}catch(e){notice(e.message)}}
async function updateMember(e,id){e.preventDefault();const f=new FormData(e.target);const value=Object.fromEntries(f);value.active=value.active==='true';try{await api(`/api/admin/users/${id}`,{method:'PATCH',body:JSON.stringify(value)});notice('ユーザー情報を更新しました。');await loadMembersData();render();}catch(e){notice(e.message)}}

async function init() {
  try {
    const { user: currentUser, radiusMacFormat, samlEnabled } = await api('/api/session');
    state.user = currentUser;
    if (samlEnabled && $('#sso-container')) {
      $('#sso-container').hidden = false;
    }
    
    if (!state.user) {
      if (window.location.pathname !== '/login') {
        window.history.replaceState(null, '', '/login');
      }
      const { needsSetup } = await api('/api/setup/status');
      if (needsSetup) {
        $('#setup-view').hidden = false; $('#login-view').hidden = true;
      } else {
        $('#login-view').hidden = false; $('#setup-view').hidden = true;
      }
      return;
    }
    
    document.body.classList.add('logged-in');
    state.radiusMacFormat = radiusMacFormat;
    $('#login-view').hidden = true;
    $('#setup-view').hidden = true;
    $('#app-view').hidden = false;
    $('#user-name').textContent = state.user.displayName;
    $('#user-role').textContent = state.user.role === 'admin' ? '管理者' : '利用者';
    $('#avatar').textContent = state.user.displayName.slice(0, 1);
    document.querySelectorAll('[data-admin-only]').forEach(x => x.hidden = state.user.role !== 'admin');
    await loadBase();
    if ($('#pending-count')) $('#pending-count').textContent = state.requests.filter(x => x.status === 'pending').length;
    
    // URLから初期ページを決定
    const path = window.location.pathname.replace(/^\//, '') || 'home';
    const validPages = Object.keys(appContent);
    const initialPage = validPages.includes(path) ? path : 'home';
    go(initialPage, null, true); // replaceState的な意味合いも含めて初期表示
    
  } catch(e) { notice(e.message); }
}

window.addEventListener('popstate', (e) => {
  if (e.state && e.state.page) {
    go(e.state.page, e.state.device || null, false);
  } else {
    const path = window.location.pathname.replace(/^\//, '') || 'home';
    if (appContent[path]) go(path, null, false);
  }
});

$('#login-form').onsubmit=async(e)=>{e.preventDefault();const f=new FormData(e.target);try{const s=await api('/api/login',{method:'POST',body:JSON.stringify(Object.fromEntries(f))});state.user=s.user;await init()}catch(e){$('#login-error').textContent=e.message;$('#login-error').hidden=false}};
$('#setup-form').onsubmit=async(e)=>{e.preventDefault();const f=new FormData(e.target);if(f.get('password')!==f.get('passwordConfirm')){$('#setup-error').textContent='パスワードが一致しません。';$('#setup-error').hidden=false;return;}try{await api('/api/setup/initialize',{method:'POST',body:JSON.stringify({displayName:f.get('displayName'),email:f.get('email'),password:f.get('password')})});$('#setup-view').hidden=true;$('#login-view').hidden=false;$('#login-error').hidden=true;notice('管理者を作成しました。ログインしてください。')}catch(e){$('#setup-error').textContent=e.message;$('#setup-error').hidden=false}};
$('#navigation').onclick=e=>{const page=e.target.dataset.page;if(page)go(page)};
$('#logout').onclick=async()=>{await api('/api/logout',{method:'POST'});location.reload()};

document.addEventListener('click', (e) => {
  const menu = $('#column-menu');
  if (!menu || menu.hidden) return;
  if (!menu.contains(e.target) && !e.target.closest('th[data-col]')) {
    menu.hidden = true;
    state.activeMenu = null;
  }
});

$('#col-sort-asc').onclick = () => {
  if (state.activeMenu) {
    state.sort = { key: state.activeMenu, dir: 1 };
    state.pagination.page = 1;
    render();
  }
};

$('#col-sort-desc').onclick = () => {
  if (state.activeMenu) {
    state.sort = { key: state.activeMenu, dir: -1 };
    state.pagination.page = 1;
    render();
  }
};

$('#col-search-input').oninput = (e) => {
  if (state.activeMenu) {
    state.filters[state.activeMenu] = e.target.value;
    state.pagination.page = 1;
    render();
  }
};

init();
