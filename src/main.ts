/* GC3 Repost Engine v4
   The engine now runs on THIS WEEK'S SERMON, not the old-post pool.
   - Today's Picks: 5-10 suggested posts pre-generated weekly from the sermon pull
     (sticky lines crystallized, three channel versions each).
   - Create New Post: paste anything (text, title, transcript) -> 5-7 clean options
     for the selected channel, in PD's voice via the social_generate function.
   - History: semantic search over everything already posted (16k FB posts, texts
     corpus when loaded), strongest first, load more.
   Channel toggle (Facebook / Gloo Text / Twitter) reformats everywhere.
   Sign-in: email code (Supabase OTP), roster enforced server-side.
   PD's outline builder lives on its own page: /outline.html (admin only). */

import './style.css';

// ---------- config ----------
const SUPABASE_URL = 'https://eibrykdamgyoylnqknao.supabase.co';
const SUPABASE_KEY = 'sb_publishable_nbdBW4joMJcL9TqYG2EKyg_L7qDSKI1';
const SESSION_KEY = 'repost:session:v1';
const PAGE = 7; // history page size

// ---------- types ----------
interface Pick {
  id: number; rank: number; hook: string; source_line: string; sermon_title: string;
  fb: string; gloo: string; tw: string;
  posted: { channel: string; by: string; on: string }[];
}
interface LogRow { id: number; post_id: number | null; action: string; acted_at: string; acted_on: string; edited_text: string | null; acted_by?: string | null; }
interface Data { me: { email: string; role: string }; week_of: string | null; picks: Pick[]; log: LogRow[]; }
interface Session { access_token: string; refresh_token: string; expires_at: number; email: string; }
interface GenOption { hook: string; text: string; }
interface HistoryRow { id: number; post_year: number; posted_at: string; n_chars: number; text: string; similarity: number; }
type Channel = 'facebook' | 'gloo' | 'twitter';
type Tab = 'picks' | 'create' | 'history';

// ---------- state ----------
let data: Data | null = null;
let currentTab: Tab = 'picks';
let channel: Channel = 'facebook';
let genInput = '';
let genOptions: GenOption[] | null = null;
let genBusy = false;
let histTopic = '';
let histRows: HistoryRow[] = [];
let histSkip = 0;
let histBusy = false;
let histDone = false;

const app = document.getElementById('app')!;
const isAdmin = () => data?.me.role === 'admin';
const CHANNELS: { key: Channel; label: string }[] = [
  { key: 'facebook', label: 'Facebook' },
  { key: 'gloo', label: 'Gloo Text' },
  { key: 'twitter', label: 'Twitter' },
];
const channelLabel = () => CHANNELS.find(c => c.key === channel)!.label;
const pickText = (p: Pick) => channel === 'gloo' ? p.gloo : channel === 'twitter' ? p.tw : p.fb;

// ---------- utils ----------
function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
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
function charNote(text: string): string {
  const n = text.length;
  if (channel === 'gloo') return `<span class="${n > 180 ? 'warn' : 'count'}">${n}/160</span>`;
  if (channel === 'twitter') return `<span class="${n > 280 ? 'warn' : 'count'}">${n}/280</span>`;
  return '';
}

// ---------- auth (email code via Supabase OTP, no SDK needed) ----------
function getSession(): Session | null {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null'); } catch { return null; }
}
function setSession(s: Session | null) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}
async function sendCode(email: string): Promise<void> {
  // The Supabase project is shared with GrowthTrack, so without an explicit
  // redirect_to the emailed magic link falls back to the project Site URL
  // (GrowthTrack). Point it back to this app.
  const res = await fetch(`${SUPABASE_URL}/auth/v1/otp?redirect_to=${encodeURIComponent(location.origin)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
    body: JSON.stringify({ email, create_user: true }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.msg ?? 'Could not send the code.');
}
async function verifyCode(email: string, code: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
    body: JSON.stringify({ type: 'email', email, token: code.trim() }),
  });
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
async function generatePosts(): Promise<GenOption[]> {
  const token = await freshToken();
  if (!token) throw new AuthNeeded();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/social_generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ mode: 'posts', channel, input: genInput.trim() }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 403) throw new NotAllowed();
  if (!res.ok) throw new Error(body.error || `generation failed (${res.status})`);
  return (body.options ?? []) as GenOption[];
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
  app.innerHTML = `<div class="loading"><div class="flame">🔥</div>Pulling this week from the archive…</div>`;
}

function renderShell() {
  if (!data) return;
  const admin = isAdmin();
  const week = data.week_of
    ? new Date(data.week_of + 'T12:00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
    : null;
  const sermon = data.picks[0]?.sermon_title?.split('|')[0].trim();
  const titles: Record<Tab, string> = {
    picks: "This Week's Picks", create: 'Create a New Post', history: 'History',
  };
  const subs: Record<Tab, string> = {
    picks: sermon
      ? `Because of what we said on Sunday: <b>${escapeHTML(sermon)}</b>${week ? ` &middot; week of ${week}` : ''}. Post these this week.`
      : 'Suggested posts land here after each week’s sermon pull.',
    create: 'Paste anything: a thought, a title, notes, a whole transcript. Get back clean, ready-to-post options in P.D.’s voice.',
    history: 'Everything we’ve already put out that fits your topic, strongest first.',
  };
  app.innerHTML = `
  <div class="wrap">
    <header>
      <p class="eyebrow">GC3 Voice Vault &middot; Repost Engine</p>
      <h1>${titles[currentTab]}</h1>
      <p class="sub">${subs[currentTab]}</p>
      <div class="channelbar" id="channelbar">
        ${CHANNELS.map(c => `<button data-ch="${c.key}" class="${channel === c.key ? 'active' : ''}">${c.label}</button>`).join('')}
        <span class="channel-note">Posting to <b>${channelLabel()}</b></span>
      </div>
      <div class="sync-note"><b>&#9679; Synced</b> &middot; signed in as ${escapeHTML(data.me.email)}${admin ? ' (admin)' : ''}${admin ? ' &middot; <a href="/outline.html" style="color:var(--gold)">Outline Builder</a>' : ''} &middot; <a href="#" id="signout" style="color:var(--ink-faint)">sign out</a></div>
    </header>
    <div class="controls">
      <div class="tabbar">
        <button data-tab="picks" class="${currentTab === 'picks' ? 'active' : ''}">This Week</button>
        <button data-tab="create" class="${currentTab === 'create' ? 'active' : ''}">Create New Post</button>
        <button data-tab="history" class="${currentTab === 'history' ? 'active' : ''}">History</button>
      </div>
    </div>
    <div id="view"></div>
  </div>
  <div class="toast" id="toast"></div>`;

  document.getElementById('signout')!.addEventListener('click', e => { e.preventDefault(); signOut(); });
  document.querySelectorAll<HTMLElement>('.tabbar button[data-tab]').forEach(b =>
    b.addEventListener('click', () => { currentTab = b.dataset.tab as Tab; renderShell(); }));
  document.querySelectorAll<HTMLElement>('#channelbar button[data-ch]').forEach(b =>
    b.addEventListener('click', () => { channel = b.dataset.ch as Channel; genOptions = null; renderShell(); }));
  renderView();
}

function renderView() {
  if (currentTab === 'create') renderCreate();
  else if (currentTab === 'history') renderHistory();
  else renderPicks();
}

// ---------- This Week's Picks ----------
function pickCard(p: Pick, idx: number): string {
  const text = pickText(p);
  const done = p.posted.some(x => x.channel === channel);
  return `
  <div class="card ${done ? 'acted' : ''}" data-pick="${p.id}">
    <div class="ghost-num">${String(idx + 1).padStart(2, '0')}</div>
    <div class="card-top">
      <span class="pill">${escapeHTML(p.hook)}</span>
      ${charNote(text)}
      ${done ? `<span class="acted-tag">&#10003; Posted</span>` : ''}
    </div>
    <div class="card-text">${escapeHTML(text)}</div>
    <textarea class="edit-box" aria-label="Edit before copying">${escapeHTML(text)}</textarea>
    <div class="from-line">From the sermon: &ldquo;${escapeHTML(p.source_line)}&rdquo;</div>
    <div class="card-actions">
      <button class="copy" data-action="copy">Copy</button>
      <button data-action="edit">Edit</button>
      <button class="repost" data-action="posted" ${done ? 'disabled' : ''}>Mark posted</button>
    </div>
  </div>`;
}

function renderPicks() {
  const view = document.getElementById('view')!;
  if (!data || data.picks.length === 0) {
    view.innerHTML = `<div class="empty-state"><div class="big">&#9679;</div>No picks yet for this week. They generate automatically after each sermon pull.</div>`;
    return;
  }
  view.innerHTML = `<div class="grid">${data.picks.map((p, i) => pickCard(p, i)).join('')}</div>`;
  view.querySelectorAll<HTMLElement>('.card[data-pick]').forEach(card => {
    const pick = data!.picks.find(p => p.id === Number(card.dataset.pick))!;
    const editBox = card.querySelector<HTMLTextAreaElement>('.edit-box')!;
    const textDiv = card.querySelector<HTMLElement>('.card-text')!;
    card.querySelector('[data-action="copy"]')!.addEventListener('click', () => {
      copyToClipboard(editBox.style.display === 'block' ? editBox.value : pickText(pick));
    });
    card.querySelector('[data-action="edit"]')!.addEventListener('click', e => {
      const editing = editBox.style.display === 'block';
      editBox.style.display = editing ? 'none' : 'block';
      textDiv.style.display = editing ? 'block' : 'none';
      (e.target as HTMLElement).textContent = editing ? 'Edit' : 'Done editing';
    });
    card.querySelector('[data-action="posted"]')!.addEventListener('click', async () => {
      try {
        await rpc('pick_posted', { p_pick_id: pick.id, p_channel: channel });
        data = await loadData();
        showToast(`Marked posted to ${channelLabel()}`);
      } catch { showToast('Could not sync, try again'); }
      renderShell();
    });
  });
}

// ---------- Create New Post ----------
function renderCreate() {
  const view = document.getElementById('view')!;
  view.innerHTML = `
  <div class="create">
    <textarea id="gen-input" class="gen-input" placeholder="Text, a title, sermon notes, a whole transcript... paste it and let the engine work.">${escapeHTML(genInput)}</textarea>
    <button class="btn primary block" id="gen-go" ${genBusy ? 'disabled' : ''}>${genBusy ? 'Writing in P.D.’s voice…' : `Create for ${channelLabel()}`}</button>
    <div id="gen-results"></div>
  </div>`;
  const ta = document.getElementById('gen-input') as HTMLTextAreaElement;
  ta.addEventListener('input', () => { genInput = ta.value; });
  document.getElementById('gen-go')!.addEventListener('click', runGenerate);
  renderGenResults();
}

async function runGenerate() {
  if (genBusy) return;
  if (genInput.trim().length < 8) { showToast('Give it a little more to work from'); return; }
  genBusy = true; genOptions = null; renderCreate();
  try { genOptions = await generatePosts(); showToast('Fresh options ready'); }
  catch (e) {
    const m = (e as Error).message || '';
    showToast(e instanceof NotAllowed ? 'Your account is not on the roster'
      : m.includes('key not set') ? 'Generation key is not set yet'
      : 'Could not generate, try again');
  } finally { genBusy = false; renderCreate(); }
}

function renderGenResults() {
  const box = document.getElementById('gen-results');
  if (!box || !genOptions) return;
  if (genOptions.length === 0) {
    box.innerHTML = `<div class="empty-state">Nothing came back. Try different words.</div>`;
    return;
  }
  box.innerHTML = `
    <div class="section-lab">${genOptions.length} options for ${channelLabel()}</div>
    <div class="grid">${genOptions.map((o, i) => `
      <div class="card draft">
        <div class="card-top"><span class="pill gold">${escapeHTML(o.hook || 'Option')}</span> ${charNote(o.text)}</div>
        <div class="card-text">${escapeHTML(o.text)}</div>
        <div class="card-actions"><button class="copy" data-copy="${i}">Copy</button></div>
      </div>`).join('')}</div>
    <button class="btn block" id="gen-again">Give me more options</button>`;
  box.querySelectorAll<HTMLElement>('[data-copy]').forEach(b =>
    b.addEventListener('click', () => copyToClipboard(genOptions![Number(b.dataset.copy)].text)));
  document.getElementById('gen-again')!.addEventListener('click', runGenerate);
}

// ---------- History ----------
function renderHistory() {
  const view = document.getElementById('view')!;
  view.innerHTML = `
  <div class="create">
    <div class="hist-bar">
      <input id="hist-topic" class="gen-input slim" placeholder="Topic or topics... e.g. purpose, isolation, favor" value="${escapeHTML(histTopic)}" />
      <button class="btn primary" id="hist-go" ${histBusy ? 'disabled' : ''}>${histBusy ? 'Searching…' : 'Search'}</button>
    </div>
    <div id="hist-results"></div>
  </div>`;
  const input = document.getElementById('hist-topic') as HTMLInputElement;
  input.addEventListener('input', () => { histTopic = input.value; });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') startHistory(); });
  document.getElementById('hist-go')!.addEventListener('click', startHistory);
  renderHistResults();
}

async function startHistory() {
  if (histBusy) return;
  if (histTopic.trim().length < 3) { showToast('Give me a topic to search'); return; }
  histRows = []; histSkip = 0; histDone = false;
  await loadMoreHistory();
}

async function loadMoreHistory() {
  histBusy = true; renderHistory();
  try {
    const rows = await rpc<HistoryRow[]>('history_search', { topic: histTopic.trim(), k: PAGE, skip: histSkip });
    histRows = histRows.concat(rows);
    histSkip += rows.length;
    if (rows.length < PAGE) histDone = true;
  } catch (e) {
    showToast(e instanceof NotAllowed ? 'Your account is not on the roster' : 'Search failed, try again');
  } finally { histBusy = false; renderHistory(); }
}

function renderHistResults() {
  const box = document.getElementById('hist-results');
  if (!box) return;
  if (histRows.length === 0) {
    box.innerHTML = histSkip > 0
      ? `<div class="empty-state">Nothing matched. Try different words.</div>`
      : `<div class="empty-state"><div class="big">&#9711;</div>Search a topic and I’ll pull the strongest things we’ve already posted on it.</div>`;
    return;
  }
  box.innerHTML = `
    <div class="section-lab">Already posted &middot; strongest first</div>
    ${histRows.map(r => `
    <div class="history-item" data-hid="${r.id}">
      <div class="h-meta">${r.post_year} &middot; ${r.n_chars} chars &middot; match ${(r.similarity * 100).toFixed(0)}%</div>
      <div class="h-text">${escapeHTML(r.text)}</div>
      <div class="card-actions slim"><button class="copy" data-hcopy="${r.id}">Copy</button></div>
    </div>`).join('')}
    ${histDone ? '' : `<button class="btn block" id="hist-more" ${histBusy ? 'disabled' : ''}>${histBusy ? 'Loading…' : 'Load more'}</button>`}`;
  box.querySelectorAll<HTMLElement>('[data-hcopy]').forEach(b =>
    b.addEventListener('click', () => {
      const row = histRows.find(r => r.id === Number(b.dataset.hcopy));
      if (row) copyToClipboard(row.text);
    }));
  const more = document.getElementById('hist-more');
  if (more) more.addEventListener('click', loadMoreHistory);
}

// ---------- boot ----------
async function boot() {
  if (!getSession()) { renderGate(); return; }
  renderLoading();
  try {
    data = await loadData();
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
