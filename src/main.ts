/* GC3 Repost Engine v2
   Live pool + cross-device state from Supabase (gc3-sermon-library project).
   Sign-in: email code (Supabase OTP), allowlist enforced server-side.
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
const SESSION_KEY = 'repost:session:v1';

// ---------- types ----------
interface Post { id: number; year: number; date: string; text: string; n: number; theme: string; }
interface LogRow { id: number; post_id: number | null; action: 'reposted' | 'skipped' | 'shuffled'; acted_at: string; acted_on: string; edited_text: string | null; }
interface Data { me: { email: string; role: string }; refreshed_at: string; pool_count: number; pool: Post[]; log: LogRow[]; }
interface Session { access_token: string; refresh_token: string; expires_at: number; email: string; }

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

// ---------- auth (email code via Supabase OTP, no SDK needed) ----------
function getSession(): Session | null {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null'); } catch { return null; }
}
function setSession(s: Session | null) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}
async function authPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
    body: JSON.stringify(body),
  });
}
async function sendCode(email: string): Promise<void> {
  const res = await authPost('otp', { email, create_user: true });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.msg ?? 'Could not send the code.');
}
async function verifyCode(email: string, code: string): Promise<void> {
  const res = await authPost('verify', { type: 'email', email, token: code.trim() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(body?.msg ?? body?.error_description ?? 'That code did not work.');
  setSession({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600),
    email,
  });
}
async function refreshSession(): Promise<boolean> {
  const s = getSession();
  if (!s?.refresh_token) return false;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
    body: JSON.stringify({ refresh_token: s.refresh_token }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) { setSession(null); return false; }
  setSession({
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? s.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600),
    email: s.email,
  });
  return true;
}
async function freshToken(): Promise<string | null> {
  const s = getSession();
  if (!s) return null;
  if (s.expires_at - Math.floor(Date.now() / 1000) < 60) {
    if (!(await refreshSession())) return null;
  }
  return getSession()?.access_token ?? null;
}
function signOut() { setSession(null); data = null; renderGate(); }

// magic-link fallback: if the emailed link is clicked and lands here with tokens in the hash
(function adoptHashSession() {
  const h = new URLSearchParams(location.hash.slice(1));
  const at = h.get('access_token'), rt = h.get('refresh_token');
  if (at && rt) {
    setSession({ access_token: at, refresh_token: rt, expires_at: Math.floor(Date.now() / 1000) + Number(h.get('expires_in') ?? 3600), email: '' });
    history.replaceState(null, '', location.pathname);
  }
})();

// ---------- api ----------
class AuthNeeded extends Error {}
class NotAllowed extends Error {}
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await freshToken();
    if (!token) throw new AuthNeeded();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
    });
    if (res.ok) return res.json() as Promise<T>;
    const body = await res.text();
    if (res.status === 401 && attempt === 0) { await refreshSession(); continue; }
    if (res.status === 401) throw new AuthNeeded();
    if (body.includes('not allowed') || res.status === 403) throw new NotAllowed();
    throw new Error(`rpc ${fn}: ${res.status}`);
  }
  throw new AuthNeeded();
}
const loadData = () => rpc<Data>('repost_data', {});
function logAction(postId: number | null, action: LogRow['action'], editedText: string | null = null) {
  return rpc<number>('repost_act', {
    p_post_id: postId, p_action: action,
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
function renderGate(msg = '') {
  app.innerHTML = `
  <div class="gate">
    <div class="flame">🔥</div>
    <h2>Repost Engine</h2>
    <p>Enter your email and we will send you a sign-in code.</p>
    <input id="email" type="email" autocomplete="email" inputmode="email" placeholder="you@godchasers.church" />
    <button id="send">Email me a code</button>
    <div class="err">${escapeHTML(msg)}</div>
  </div>
  <div class="toast" id="toast"></div>`;
  const input = document.getElementById('email') as HTMLInputElement;
  const go = async () => {
    const email = input.value.trim().toLowerCase();
    if (!email.includes('@')) { renderGate('That does not look like an email address.'); return; }
    (document.getElementById('send') as HTMLButtonElement).disabled = true;
    try {
      await sendCode(email);
      renderCodeStep(email);
    } catch (e) {
      renderGate((e as Error).message);
    }
  };
  document.getElementById('send')!.addEventListener('click', go);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  input.focus();
}

function renderCodeStep(email: string, msg = '') {
  app.innerHTML = `
  <div class="gate">
    <div class="flame">📬</div>
    <h2>Check your email</h2>
    <p>We sent a 6-digit code to <b>${escapeHTML(email)}</b>. Enter it below. If the email shows a sign-in link instead, tapping it works too.</p>
    <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="10" />
    <button id="verify">Sign in</button>
    <div class="err">${escapeHTML(msg)}</div>
    <p style="margin-top:14px"><a href="#" id="resend" style="color:var(--gold)">Resend code</a> &nbsp;&middot;&nbsp; <a href="#" id="back" style="color:var(--ink-faint)">Different email</a></p>
  </div>
  <div class="toast" id="toast"></div>`;
  const input = document.getElementById('code') as HTMLInputElement;
  const go = async () => {
    (document.getElementById('verify') as HTMLButtonElement).disabled = true;
    try {
      await verifyCode(email, input.value);
      boot();
    } catch (e) {
      renderCodeStep(email, (e as Error).message);
    }
  };
  document.getElementById('verify')!.addEventListener('click', go);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  document.getElementById('resend')!.addEventListener('click', async e => {
    e.preventDefault();
    try { await sendCode(email); showToast('New code sent'); } catch { showToast('Could not resend, wait a minute and try again'); }
  });
  document.getElementById('back')!.addEventListener('click', e => { e.preventDefault(); renderGate(); });
  input.focus();
}

function renderNotAllowed() {
  const email = getSession()?.email || data?.me?.email || 'this email';
  app.innerHTML = `
  <div class="gate">
    <div class="flame">🚫</div>
    <h2>No access yet</h2>
    <p><b>${escapeHTML(email)}</b> is signed in but is not on the access list for the Repost Engine. Ask PD to add you.</p>
    <button id="out">Use a different email</button>
    <div class="err"></div>
  </div>
  <div class="toast" id="toast"></div>`;
  document.getElementById('out')!.addEventListener('click', signOut);
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
      <div class="sync-note"><b>&#9679; Synced</b> &middot; pool refreshed ${refreshed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} &middot; signed in as ${escapeHTML(data.me.email)}${data.me.role === 'admin' ? ' (admin)' : ''} &middot; <a href="#" id="signout" style="color:var(--ink-faint)">sign out</a></div>
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

  document.getElementById('signout')!.addEventListener('click', e => { e.preventDefault(); signOut(); });
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
  if (!getSession()) { renderGate(); return; }
  renderLoading();
  try {
    data = await loadData();
    computeBatch();
    renderShell();
  } catch (e) {
    if (e instanceof AuthNeeded) { setSession(null); renderGate('Your session expired. Sign in again.'); }
    else if (e instanceof NotAllowed) { renderNotAllowed(); }
    else {
      app.innerHTML = `<div class="empty-state"><div class="big">&#9888;&#65039;</div>Could not reach the vault. Check your connection.<br><br><button class="btn primary" id="retry">Retry</button></div>`;
      document.getElementById('retry')!.addEventListener('click', boot);
    }
  }
}
boot();
