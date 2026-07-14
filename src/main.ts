/* GC3 Repost Engine v3
   Live pool + cross-device state from Supabase (gc3-sermon-library project).
   Sign-in: email code (Supabase OTP), allowlist enforced server-side.
   Roles: admin (PD) = full engine; team member = pick a channel (Facebook / Gloo
   Text / Twitter) and one of two modes... Repost, or Create New Post (drafts in
   PD's voice via the social_generate function + surfaces evergreen posts to repost).
   Product law: evergreen only, verbatim on repost, 14-month repost cooloff (also
   enforced in repost_act), 14d skip cooldown, daily batch of 6 diverse across eras. */

import './style.css';

// ---------- config ----------
const SUPABASE_URL = 'https://eibrykdamgyoylnqknao.supabase.co';
const SUPABASE_KEY = 'sb_publishable_nbdBW4joMJcL9TqYG2EKyg_L7qDSKI1';
const BATCH_SIZE = 6;
const REPOST_COOLDOWN_DAYS = 425; // 14 months. Matches the server-side rule in repost_act.
const SKIP_COOLDOWN_DAYS = 14;
const MAX_PER_YEAR = 1;
const MAX_PER_THEME = 2;
const SESSION_KEY = 'repost:session:v1';

// ---------- types ----------
interface Post { id: number; year: number; date: string; text: string; n: number; theme: string; }
interface LogRow { id: number; post_id: number | null; action: 'reposted' | 'skipped' | 'shuffled'; acted_at: string; acted_on: string; edited_text: string | null; acted_by?: string | null; }
interface Data { me: { email: string; role: string }; refreshed_at: string; pool_count: number; pool: Post[]; log: LogRow[]; }
interface Session { access_token: string; refresh_token: string; expires_at: number; email: string; }
interface Draft { label: string; text: string; }
interface GenResult { drafts: Draft[]; reposts: Post[]; platform: string; }
type Channel = 'facebook' | 'gloo' | 'twitter';
type Tab = 'today' | 'create' | 'history';
type GenType = 'text' | 'title' | 'transcript';

// ---------- state ----------
let data: Data | null = null;
let batch: Post[] = [];
let currentFilter = 'All';
let currentTab: Tab = 'today';
let channel: Channel = 'facebook';
let gen: GenResult | null = null;
let genType: GenType = 'text';
let genInput = '';
let genBusy = false;

const app = document.getElementById('app')!;
const isAdmin = () => data?.me.role === 'admin';
const CHANNELS: { key: Channel; label: string }[] = [
  { key: 'facebook', label: 'Facebook' },
  { key: 'gloo', label: 'Gloo Text' },
  { key: 'twitter', label: 'Twitter' },
];
const CHAR_LIMIT: Record<Channel, number> = { facebook: 63206, gloo: 300, twitter: 280 };
const channelLabel = () => CHANNELS.find(c => c.key === channel)!.label;

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
function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).then(
    () => showToast('Copied to clipboard'),
    () => showToast('Copy failed, long-press to select'),
  );
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
    if (body.includes('admin only')) throw new Error('admin-only');
    if (body.includes('cooling down')) throw new Error('cooling');
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
async function generate(): Promise<GenResult> {
  const token = await freshToken();
  if (!token) throw new AuthNeeded();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/social_generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ platform: channel, input_type: genType, input: genInput.trim() }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 403) throw new NotAllowed();
  if (!res.ok) throw new Error(body.error || `generation failed (${res.status})`);
  return body as GenResult;
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
  const admin = isAdmin();
  const repostedCount = new Set(data.log.filter(r => r.action === 'reposted' && r.post_id != null).map(r => r.post_id)).size;
  const years = data.pool.map(p => p.year);
  const themes = ['All', ...[...new Set(data.pool.map(p => p.theme))].sort()];
  const refreshed = new Date(data.refreshed_at);
  const title = currentTab === 'create' ? 'Create a New Post' : currentTab === 'history' ? 'History' : (admin ? "Today's Picks" : 'Repost');
  const tabs = admin
    ? [{ k: 'today', l: "Today's Picks" }, { k: 'create', l: 'Create New Post' }, { k: 'history', l: 'History' }]
    : [{ k: 'today', l: 'Repost' }, { k: 'create', l: 'Create New Post' }];
  app.innerHTML = `
  <div class="wrap">
    <header>
      <p class="eyebrow">GC3 Voice Vault &middot; Repost Engine</p>
      <h1>${title}</h1>
      <p class="sub">Your own words, ready to send. Repost an evergreen pick, or create a fresh post in your voice for the channel you choose. Nothing repeats until it has cooled off.</p>
      <div class="stats-row">
        <div class="stat"><b>${data.pool.length.toLocaleString()}</b><span>In rotation</span></div>
        <div class="stat"><b>${repostedCount}</b><span>Reposted</span></div>
        <div class="stat"><b>${Math.min(...years)}&ndash;${Math.max(...years)}</b><span>Years covered</span></div>
      </div>
      <div class="channelbar" id="channelbar">
        ${CHANNELS.map(c => `<button data-ch="${c.key}" class="${channel === c.key ? 'active' : ''}">${c.label}</button>`).join('')}
        <span class="channel-note">Posting to <b>${channelLabel()}</b></span>
      </div>
      <div class="sync-note"><b>&#9679; Synced</b> &middot; pool refreshed ${refreshed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} &middot; signed in as ${escapeHTML(data.me.email)}${admin ? ' (admin)' : ''} &middot; <a href="#" id="signout" style="color:var(--ink-faint)">sign out</a></div>
    </header>
    <div class="controls">
      <div class="tabbar">
        ${tabs.map(t => `<button data-tab="${t.k}" class="${currentTab === t.k ? 'active' : ''}">${t.l}</button>`).join('')}
      </div>
      ${admin && currentTab === 'today' ? `<select id="tag-filter" aria-label="Theme filter">${themes.map(t =>
        `<option value="${escapeHTML(t)}" ${t === currentFilter ? 'selected' : ''}>${t === 'All' ? 'All themes' : escapeHTML(t)}</option>`).join('')}</select>` : ''}
      <div class="spacer"></div>
      ${admin && currentTab === 'today' ? `<button class="btn primary" id="btn-shuffle">New batch</button>` : ''}
    </div>
    <div id="view"></div>
  </div>
  <div class="toast" id="toast"></div>`;

  document.getElementById('signout')!.addEventListener('click', e => { e.preventDefault(); signOut(); });
  document.querySelectorAll<HTMLElement>('.tabbar button[data-tab]').forEach(b =>
    b.addEventListener('click', () => { currentTab = b.dataset.tab as Tab; renderShell(); }));
  document.querySelectorAll<HTMLElement>('#channelbar button[data-ch]').forEach(b =>
    b.addEventListener('click', () => { channel = b.dataset.ch as Channel; if (currentTab === 'create') gen = null; renderShell(); }));
  const tf = document.getElementById('tag-filter');
  if (tf) tf.addEventListener('change', e => { currentFilter = (e.target as HTMLSelectElement).value; renderView(); });
  const shuffle = document.getElementById('btn-shuffle');
  if (shuffle) shuffle.addEventListener('click', async () => {
    try {
      await logAction(null, 'shuffled');
      data = await loadData();
      computeBatch();
      renderShell();
      showToast('New batch pulled');
    } catch (e) { showToast((e as Error).message === 'admin-only' ? 'Only admin can pull a new batch' : 'Could not reach the vault, try again'); }
  });
  renderView();
}

function renderView() {
  if (currentTab === 'create') renderCreate();
  else if (currentTab === 'history') renderHistory();
  else renderToday();
}

function cardHTML(p: Post, idx: number, acted?: LogRow): string {
  const over = channel === 'twitter' && p.n > CHAR_LIMIT.twitter;
  return `
  <div class="card ${acted ? 'acted' : ''}" data-id="${p.id}">
    <div class="ghost-num">${String(idx + 1).padStart(2, '0')}</div>
    <div class="card-top">
      <span class="pill">${escapeHTML(p.theme)}</span>
      <span class="year-tag">${p.year} &middot; ${p.n} chars${over ? ' &middot; over 280' : ''}</span>
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

// wire copy / edit / repost / skip on every .card[data-id] in a container
function wireCards(container: HTMLElement, lookup: (id: number) => Post | undefined) {
  container.querySelectorAll<HTMLElement>('.card[data-id]').forEach(card => {
    const post = lookup(Number(card.dataset.id));
    if (!post) return;
    const editBox = card.querySelector<HTMLTextAreaElement>('.edit-box')!;
    const textDiv = card.querySelector<HTMLElement>('.card-text')!;
    card.querySelector('[data-action="copy"]')!.addEventListener('click', () => {
      copyToClipboard(editBox.style.display === 'block' ? editBox.value : post.text);
    });
    card.querySelector('[data-action="edit"]')!.addEventListener('click', e => {
      const editing = editBox.style.display === 'block';
      editBox.style.display = editing ? 'none' : 'block';
      textDiv.style.display = editing ? 'block' : 'none';
      (e.target as HTMLElement).textContent = editing ? 'Edit' : 'Done editing';
    });
    card.querySelector('[data-action="repost"]')!.addEventListener('click', async () => {
      const edited = editBox.style.display === 'block' && editBox.value.trim() !== post.text.trim() ? editBox.value.trim() : null;
      card.classList.add('leaving');
      try { await logAction(post.id, 'reposted', edited); data = await loadData(); showToast('Marked as reposted'); }
      catch (e) { showToast((e as Error).message === 'cooling' ? 'Still cooling off (14 months)' : 'Could not sync, try again'); }
      renderShell();
    });
    card.querySelector('[data-action="skip"]')!.addEventListener('click', async () => {
      card.classList.add('leaving');
      try { await logAction(post.id, 'skipped'); data = await loadData(); showToast('Passed, resting it for 14 days'); }
      catch { showToast('Could not sync, try again'); }
      renderShell();
    });
  });
}

function renderToday() {
  const view = document.getElementById('view')!;
  const acted = todayActions();
  let posts = batch;
  if (currentFilter !== 'All') posts = posts.filter(p => p.theme === currentFilter);
  if (posts.length === 0) {
    view.innerHTML = `<div class="empty-state"><div class="big">&#9679;</div>${isAdmin() ? 'No picks match that theme today. Try "New batch" or switch themes.' : 'No picks right now. Check back soon.'}</div>`;
    return;
  }
  view.innerHTML = `<div class="grid">${posts.map((p, i) => cardHTML(p, i, acted.get(p.id))).join('')}</div>`;
  wireCards(view, id => batch.find(p => p.id === id));
}

function renderCreate() {
  const view = document.getElementById('view')!;
  const types: GenType[] = ['text', 'title', 'transcript'];
  const ph = genType === 'title' ? 'Paste a sermon or post title...'
    : genType === 'transcript' ? 'Paste a transcript or a long passage...'
    : 'Paste the text, notes, or the thought you want to build from...';
  view.innerHTML = `
  <div class="create">
    <div class="seg" id="type-seg">
      ${types.map(t => `<button data-type="${t}" class="${genType === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
    </div>
    <textarea id="gen-input" class="gen-input" placeholder="${ph}">${escapeHTML(genInput)}</textarea>
    <button class="btn primary block" id="gen-go" ${genBusy ? 'disabled' : ''}>${genBusy ? 'Writing in your voice…' : `Create for ${channelLabel()}`}</button>
    <div id="gen-results"></div>
  </div>`;
  document.querySelectorAll<HTMLElement>('#type-seg button[data-type]').forEach(b =>
    b.addEventListener('click', () => { genType = b.dataset.type as GenType; renderCreate(); }));
  const ta = document.getElementById('gen-input') as HTMLTextAreaElement;
  ta.addEventListener('input', () => { genInput = ta.value; });
  document.getElementById('gen-go')!.addEventListener('click', runGenerate);
  renderGenResults();
}

async function runGenerate() {
  if (genBusy) return;
  if (genInput.trim().length < 8) { showToast('Give it a little more to work from'); return; }
  genBusy = true; gen = null; renderCreate();
  try { gen = await generate(); showToast('Fresh options ready'); }
  catch (e) {
    const m = (e as Error).message || '';
    showToast(e instanceof NotAllowed ? 'Your account is not on the roster' : m.includes('key not set') ? 'Generation key is not set yet' : 'Could not generate, try again');
  } finally { genBusy = false; renderCreate(); }
}

function renderGenResults() {
  const box = document.getElementById('gen-results');
  if (!box || !gen) return;
  const note = (t: string) => channel === 'twitter'
    ? `<span class="${t.length > CHAR_LIMIT.twitter ? 'warn' : 'count'}">${t.length}/280</span>`
    : channel === 'gloo' ? `<span class="${t.length > CHAR_LIMIT.gloo ? 'warn' : 'count'}">${t.length}/300</span>` : '';
  const drafts = gen.drafts.length ? `
    <div class="section-lab">New posts in your voice</div>
    <div class="grid">${gen.drafts.map((d, i) => `
      <div class="card draft">
        <div class="card-top"><span class="pill gold">${escapeHTML(d.label || 'Option')}</span> ${note(d.text)}</div>
        <div class="card-text plain">${escapeHTML(d.text)}</div>
        <div class="card-actions"><button class="copy" data-copy="${i}">Copy</button></div>
      </div>`).join('')}</div>` : '';
  const reposts = gen.reposts.length ? `
    <div class="section-lab">Evergreen posts to repost on this</div>
    <div class="grid">${gen.reposts.map((p, i) => cardHTML(p, i)).join('')}</div>` : '';
  box.innerHTML = (drafts + reposts) || `<div class="empty-state">No options came back. Try different words.</div>`;
  box.querySelectorAll<HTMLElement>('[data-copy]').forEach(b =>
    b.addEventListener('click', () => copyToClipboard(gen!.drafts[Number(b.dataset.copy)].text)));
  wireCards(box, id => gen!.reposts.find(p => p.id === id));
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
    const who = r.acted_by ? ` &middot; by ${escapeHTML(r.acted_by.split('@')[0])}` : '';
    return `
    <div class="history-item">
      <div class="h-meta">Originally ${post ? post.year : '?'} &middot; Reposted <b>${when}</b>${who}${r.edited_text ? ' &middot; edited before posting' : ''}</div>
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
    if (!isAdmin() && currentTab === 'history') currentTab = 'today';
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
