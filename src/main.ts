/* GC3 Repost Engine v2
   Live pool + cross-device state from Supabase (gc3-sermon-library project).
   Product law: evergreen only, verbatim text, 90d repost / 14d skip cooldowns,
   daily batch of 6 diverse across themes and eras. */

import './style.css';

// ---------- config ----------
const SUPABASE_URL = 'https://eibrykdamgyoylnqknao.supabase.co';
const SUPABASE_KEY = 'sb_publishable_nbdBW4joMJcL9TqYG2EKyg_L7qDSKI1';
const BATCH_SIZE = 6;
const REPOST_COOLDOWN_DAYS = 90;
const SKIP_COOLDOWN_DAYS = 14;
const MAX_PER_YEAR = 1;
const MAX_PER_THEME = 2;
const PASS_KEY = 'repost:pass';

// ---------- types ----------
interface Post { id: number; year: number; date: string; text: string; n: number; theme: string; }
interface LogRow { id: number; post_id: number | null; action: 'reposted' | 'skipped' | 'shuffled'; acted_at: string; acted_on: string; edited_text: string | null; }
interface Data { refreshed_at: string; pool_count: number; pool: Post[]; log: LogRow[]; }

// ---------- state ----------
let data: Data | null = null;
let batch: Post[] = [];
let currentFilter = 'All';
let currentTab: 'today' | 'history' = 'today';

const app = document.getElementById('app')!;

// ---------- utils ----------
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime()) / 86400000);
}
function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
// deterministic PRNG so every device draws the same batch for the same day
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function showToast(msg: string) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------- api ----------
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 || body.includes('bad passphrase')) throw new Error('bad-pass');
    throw new Error(`rpc ${fn}: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
const getPass = () => localStorage.getItem(PASS_KEY) ?? '';
const loadData = () => rpc<Data>('repost_data', { pass: getPass() });
function logAction(postId: number | null, action: LogRow['action'], editedText: string | null = null) {
  return rpc<number>('repost_act', {
    pass: getPass(), p_post_id: postId, p_action: action,
    p_acted_on: todayStr(), p_edited_text: editedText,
  });
}

// ---------- batch selection (deterministic, diverse, cooldown-aware) ----------
function latestActionPerPost(log: LogRow[], beforeDay: string): Map<number, LogRow> {
  const m = new Map<number, LogRow>();
  for (const row of log) {
    if (row.post_id == null || row.action === 'shuffled') continue;
    if (row.acted_on >= beforeDay) continue; // today's actions overlay the UI, they don't reshape the batch
    const prev = m.get(row.post_id);
    if (!prev || row.acted_at > prev.acted_at) m.set(row.post_id, row);
  }
  return m;
}
function eligiblePool(pool: Post[], log: LogRow[], day: string): Post[] {
  const last = latestActionPerPost(log, day);
  return pool.filter(p => {
    const rec = last.get(p.id);
    if (!rec) return true;
    const cooldown = rec.action === 'reposted' ? REPOST_COOLDOWN_DAYS : SKIP_COOLDOWN_DAYS;
    return daysBetween(rec.acted_on, day) >= cooldown;
  });
}
function pickDiverseBatch(pool: Post[], seed: number): Post[] {
  const rand = mulberry32(seed);
  const shuffled = [...pool].sort((a, b) => a.id - b.id);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const picked: Post[] = [];
  const perYear = new Map<number, number>();
  const perTheme = new Map<string, number>();
  const fits = (p: Post, maxY: number, maxT: number) =>
    (perYear.get(p.year) ?? 0) < maxY && (perTheme.get(p.theme) ?? 0) < maxT;
  const take = (p: Post) => {
    picked.push(p);
    perYear.set(p.year, (perYear.get(p.year) ?? 0) + 1);
    perTheme.set(p.theme, (perTheme.get(p.theme) ?? 0) + 1);
  };
  // pass 1: strict diversity; pass 2 and 3 relax if the pool is thin
  for (const p of shuffled) { if (picked.length >= BATCH_SIZE) break; if (fits(p, MAX_PER_YEAR, MAX_PER_THEME)) take(p); }
  for (const p of shuffled) { if (picked.length >= BATCH_SIZE) break; if (!picked.includes(p) && fits(p, 2, 3)) take(p); }
  for (const p of shuffled) { if (picked.length >= BATCH_SIZE) break; if (!picked.includes(p)) take(p); }
  return picked;
}
function computeBatch() {
  if (!data) return;
  const day = todayStr();
  const shuffles = data.log.filter(r => r.action === 'shuffled' && r.acted_on === day).length;
  const pool = eligiblePool(data.pool, data.log, day);
  batch = pickDiverseBatch(pool.length >= BATCH_SIZE ? pool : data.pool, hashSeed(`${day}:${shuffles}`));
}
function todayActions(): Map<number, LogRow> {
  const m = new Map<number, LogRow>();
  if (!data) return m;
  const day = todayStr();
  for (const row of data.log) {
    if (row.post_id != null && row.action !== 'shuffled' && row.acted_on === day) m.set(row.post_id, row);
  }
  return m;
}

// ---------- views ----------
function renderGate(err = '') {
  app.innerHTML = `
  <div class="gate">
    <div class="flame">🔥</div>
    <h2>Repost Engine</h2>
    <p>Enter the passphrase to open your vault.</p>
    <input id="pass" type="password" autocomplete="current-password" placeholder="Passphrase" />
    <button id="enter">Open the vault</button>
    <div class="err">${escapeHTML(err)}</div>
  </div>
  <div class="toast" id="toast"></div>`;
  const input = document.getElementById('pass') as HTMLInputElement;
  const go = () => { localStorage.setItem(PASS_KEY, input.value.trim()); boot(); };
  document.getElementById('enter')!.addEventListener('click', go);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  input.focus();
}

function renderLoading() {
  app.innerHTML = `<div class="loading"><div class="flame">🔥</div>Pulling your vault from the archive…</div>`;
}

function renderShell() {
  if (!data) return;
  const repostedCount = new Set(data.log.filter(r => r.action === 'reposted' && r.post_id != null).map(r => r.post_id)).size;
  const years = data.pool.map(p => p.year);
  const themes = ['All', ...[...new Set(data.pool.map(p => p.theme))].sort()];
  const refreshed = new Date(data.refreshed_at);
  app.innerHTML = `
  <div class="wrap">
    <header>
      <p class="eyebrow">GC3 Voice Vault &middot; Repost Engine</p>
      <h1>Today's Picks</h1>
      <p class="sub">Evergreen only: your own words, filtered to remove anything tied to a moment that can't be recreated. Repost as-is, tweak a line, or pass. Nothing repeats until it's cooled off.</p>
      <div class="stats-row">
        <div class="stat"><b>${data.pool.length.toLocaleString()}</b><span>In rotation</span></div>
        <div class="stat"><b>${repostedCount}</b><span>Reposted</span></div>
        <div class="stat"><b>${Math.min(...years)}&ndash;${Math.max(...years)}</b><span>Years covered</span></div>
      </div>
      <div class="sync-note"><b>&#9679; Synced</b> &middot; pool refreshed ${refreshed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, refreshes itself as new posts land &middot; history follows you on every device</div>
    </header>
    <div class="controls">
      <div class="tabbar">
        <button id="tab-today" class="${currentTab === 'today' ? 'active' : ''}">Today's Picks</button>
        <button id="tab-history" class="${currentTab === 'history' ? 'active' : ''}">History</button>
      </div>
      <select id="tag-filter" aria-label="Theme filter">${themes.map(t =>
        `<option value="${escapeHTML(t)}" ${t === currentFilter ? 'selected' : ''}>${t === 'All' ? 'All themes' : escapeHTML(t)}</option>`).join('')}</select>
      <div class="spacer"></div>
      <button class="btn primary" id="btn-shuffle">New batch</button>
    </div>
    <div id="view"></div>
  </div>
  <div class="toast" id="toast"></div>`;

  document.getElementById('tab-today')!.addEventListener('click', () => { currentTab = 'today'; renderShell(); });
  document.getElementById('tab-history')!.addEventListener('click', () => { currentTab = 'history'; renderShell(); });
  document.getElementById('tag-filter')!.addEventListener('change', e => {
    currentFilter = (e.target as HTMLSelectElement).value;
    renderView();
  });
  document.getElementById('btn-shuffle')!.addEventListener('click', async () => {
    try {
      await logAction(null, 'shuffled');
      data = await loadData();
      computeBatch();
      renderShell();
      showToast('New batch pulled');
    } catch { showToast('Could not reach the vault, try again'); }
  });
  renderView();
}

function renderView() {
  if (currentTab === 'today') renderToday(); else renderHistory();
}

function cardHTML(p: Post, idx: number, acted?: LogRow): string {
  return `
  <div class="card ${acted ? 'acted' : ''}" data-id="${p.id}">
    <div class="ghost-num">${String(idx + 1).padStart(2, '0')}</div>
    <div class="card-top">
      <span class="pill">${escapeHTML(p.theme)}</span>
      <span class="year-tag">${p.year} &middot; ${p.n} chars</span>
      ${acted ? `<span class="acted-tag">${acted.action === 'reposted' ? '&#10003; Reposted' : 'Passed'}</span>` : ''}
    </div>
    <div class="card-text">${escapeHTML(p.text)}</div>
    <textarea class="edit-box" aria-label="Edit before copying">${escapeHTML(p.text)}</textarea>
    <div class="card-actions">
      <button class="copy" data-action="copy">Copy</button>
      <button data-action="edit">Edit</button>
      <button class="repost" data-action="repost" ${acted ? 'disabled' : ''}>Mark reposted</button>
      <button class="skip" data-action="skip" ${acted ? 'disabled' : ''}>Not this one</button>
    </div>
  </div>`;
}

function renderToday() {
  const view = document.getElementById('view')!;
  const acted = todayActions();
  let posts = batch;
  if (currentFilter !== 'All') posts = posts.filter(p => p.theme === currentFilter);
  if (posts.length === 0) {
    view.innerHTML = `<div class="empty-state"><div class="big">&#9679;</div>No picks match that theme today. Try "New batch" or switch themes.</div>`;
    return;
  }
  view.innerHTML = `<div class="grid">${posts.map((p, i) => cardHTML(p, i, acted.get(p.id))).join('')}</div>`;

  view.querySelectorAll<HTMLElement>('.card').forEach(card => {
    const id = Number(card.dataset.id);
    const post = batch.find(p => p.id === id)!;
    const editBox = card.querySelector<HTMLTextAreaElement>('.edit-box')!;
    const textDiv = card.querySelector<HTMLElement>('.card-text')!;

    card.querySelector('[data-action="copy"]')!.addEventListener('click', () => {
      const text = editBox.style.display === 'block' ? editBox.value : post.text;
      navigator.clipboard.writeText(text).then(
        () => showToast('Copied to clipboard'),
        () => showToast('Copy failed, long-press to select'),
      );
    });
    card.querySelector('[data-action="edit"]')!.addEventListener('click', e => {
      const editing = editBox.style.display === 'block';
      editBox.style.display = editing ? 'none' : 'block';
      textDiv.style.display = editing ? 'block' : 'none';
      (e.target as HTMLElement).textContent = editing ? 'Edit' : 'Done editing';
    });
    card.querySelector('[data-action="repost"]')!.addEventListener('click', async () => {
      const edited = editBox.style.display === 'block' && editBox.value.trim() !== post.text.trim()
        ? editBox.value.trim() : null;
      card.classList.add('leaving');
      try {
        await logAction(id, 'reposted', edited);
        data = await loadData();
        showToast('Marked as reposted');
      } catch { showToast('Could not sync, try again'); }
      renderShell();
    });
    card.querySelector('[data-action="skip"]')!.addEventListener('click', async () => {
      card.classList.add('leaving');
      try {
        await logAction(id, 'skipped');
        data = await loadData();
        showToast('Passed, resting it for 14 days');
      } catch { showToast('Could not sync, try again'); }
      renderShell();
    });
  });
}

function renderHistory() {
  const view = document.getElementById('view')!;
  if (!data) return;
  const byId = new Map(data.pool.map(p => [p.id, p]));
  const entries = data.log
    .filter(r => r.action === 'reposted' && r.post_id != null)
    .sort((a, b) => b.acted_at.localeCompare(a.acted_at));
  if (entries.length === 0) {
    view.innerHTML = `<div class="empty-state"><div class="big">&#9711;</div>Nothing reposted yet. Mark one from Today's Picks and it shows up here.</div>`;
    return;
  }
  view.innerHTML = entries.map(r => {
    const post = byId.get(r.post_id!);
    const text = r.edited_text ?? post?.text ?? '(original post no longer in rotation)';
    const when = new Date(r.acted_on + 'T12:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    return `
    <div class="history-item">
      <div class="h-meta">Originally ${post ? post.year : '?'} &middot; Reposted <b>${when}</b>${r.edited_text ? ' &middot; edited before posting' : ''}</div>
      <div class="h-text">${escapeHTML(text)}</div>
    </div>`;
  }).join('');
}

// ---------- boot ----------
async function boot() {
  if (!getPass()) { renderGate(); return; }
  renderLoading();
  try {
    data = await loadData();
    computeBatch();
    renderShell();
  } catch (e) {
    if ((e as Error).message === 'bad-pass') {
      localStorage.removeItem(PASS_KEY);
      renderGate('That passphrase did not match. Try again.');
    } else {
      app.innerHTML = `<div class="empty-state"><div class="big">&#9888;&#65039;</div>Could not reach the vault. Check your connection.<br><br><button class="btn primary" id="retry">Retry</button></div>`;
      document.getElementById('retry')!.addEventListener('click', boot);
    }
  }
}
boot();
