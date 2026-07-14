/* PD's Outline Builder (admin only).
   Separate page from the Repost Engine. The bones of the sermon builder:
   five formats (#MMM, 5-Day Devotional, Charisma Lesson, 10T, Full Sermon),
   PD's voice spec baked into the prompt, generation via the social_generate
   edge function (mode: 'outline'), rendered in the ember style. */

import './style.css';

const SUPABASE_URL = 'https://eibrykdamgyoylnqknao.supabase.co';
const SUPABASE_KEY = 'sb_publishable_nbdBW4joMJcL9TqYG2EKyg_L7qDSKI1';
const SESSION_KEY = 'repost:session:v1';

// ---------- session (shared with the repost engine) ----------
interface Session { access_token: string; refresh_token: string; expires_at: number; email: string; }
function getSession(): Session | null {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null'); } catch { return null; }
}
function setSession(s: Session | null) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
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

// ---------- formats ----------
const FORMATS = [
  { key: '#MMM', label: '#MMM', note: 'Short Monday message' },
  { key: '5-Day Devotional', label: '5-Day Devotional', note: 'Five daily entries' },
  { key: 'Charisma Lesson', label: 'Charisma Lesson', note: 'Teaching lesson' },
  { key: '10T', label: '10T', note: "The 10 T's outline" },
  { key: 'Full Sermon', label: 'Full Sermon', note: 'Complete manuscript' },
];
const TOPICS = [
  'Identity', 'Faith', 'Worship', 'Stewardship & Generosity',
  'Purpose & Calling', 'Grace', 'Relationships', 'Spiritual Growth',
  'Overcoming', 'Prayer', 'The Local Church', 'Hope',
];
const LENGTHS = [
  { key: 'Focused', label: 'Focused', note: '~20 min' },
  { key: 'Standard', label: 'Standard', note: '~35 min' },
  { key: 'Full', label: 'Full', note: '~45 min' },
];
const LENGTH_GUIDE: Record<string, string> = {
  Focused: 'Two main points. Tight and pointed.',
  Standard: 'Three main points.',
  Full: 'Four main points with fuller illustrations.',
};
const SHOW_LENGTH = new Set(['Full Sermon', 'Charisma Lesson']);

const FORMAT_SPECS: Record<string, string> = {
  'Full Sermon': `Produce a full sermon manuscript. Use these sections in order:
1) {label:"Introduction", type:"prose"} open on the ache before any answer... name the tension the room walked in carrying.
2) {label:"Irreducible Idea", type:"callout"} one unforgettable sentence, phrased as a reframe (what looks like X is really Y).
3) {label:"Main Points", type:"points"} each point title uses alliteration, contrast, or parallel structure. Each item carries point, explanation, stickyThought (short and antithetical), illustration (everyday: family, sports, food, San Antonio... set it fast, then bring it home to the text), and application.
4) {label:"Powerful Statements", type:"list"} a few standalone quotable lines, short and contrast-driven.
5) {label:"Practical Application", type:"steps"} concrete moves for the week.
6) {label:"Conclusion", type:"prose"} make the Turn from problem to gospel, bring the tension home, land on the idea one more time, and call for a decision.`,

  '5-Day Devotional': `Produce a five day devotional series on the theme. One unifying title and a primary scripture for the week. Keep the sticky thoughts short and antithetical, and reframe any hardship as preparation, not punishment. Sections in order:
1) {label:"The Week Ahead", type:"prose"} two or three sentences framing the five days.
2) Then five group sections, one per day. Each is {label:"Day 1 ... [short day title]", type:"group", blocks:[ {label:"Scripture", type:"prose"}, {label:"Reflection", type:"prose"}, {label:"Sticky Thought", type:"sticky"}, {label:"Today", type:"prose"}, {label:"Prayer", type:"prose"} ]}. Give each day its own title and its own scripture. Keep each day to about a three minute read. Repeat for Day 2 through Day 5.`,

  'Charisma Lesson': `Produce one teaching lesson in the Charisma Class style. This teaches and disciples, it is not preached... clear, ordered, and checkable, lighter on the whoop. Greek or Hebrew word work is welcome where it opens the point, kept accurate to the lemma. Sections in order:
1) {label:"Lesson Focus", type:"prose"} what this lesson is and why it matters.
2) {label:"Big Idea", type:"callout"} one sentence.
3) {label:"Teaching", type:"points"} two to four teaching moves, each with point, explanation, stickyThought, illustration, application.
4) {label:"Fill In The Blank", type:"list"} four to six review statements, each showing a blank as ______ with at least twenty characters of context around it.
5) {label:"Discussion Questions", type:"steps"} four to six open questions.
6) {label:"Take It Home", type:"steps"} concrete steps for the week.`,

  '#MMM': `Produce a short Monday message... Monday Morning Manna. One controlling thought to start the week, punchy and quotable, built to be read fast and remembered. Sections in order:
1) {label:"The Hook", type:"prose"} two short paragraphs that name a Monday-morning ache or question before any answer.
2) {label:"One Thought", type:"callout"} the single controlling idea, phrased as a reframe (not X, it's Y).
3) {label:"Say It Plain", type:"prose"} two or three short paragraphs that unpack the one thought and bring it home to the text.
4) {label:"Sticky Thought", type:"sticky"} one short antithetical line worth quoting.
5) {label:"This Week", type:"prose"} one concrete move to carry into the week.`,

  '10T': `Produce a preachable OUTLINE using PD's 10 T's framework. This is a teaching scaffold another preacher could pick up cold, NOT a finished sermon. Keep jokes, personal stories, and specific illustrations OUT... those lock it to one mouth and get filled in live. Title and Text ride in the slate, so begin the sections at Thesis. Sections in order:
1) {label:"Thesis", type:"callout"} the one claim of the message in a single sentence.
2) {label:"Theme / Tenor", type:"prose"} one or two sentences on how it should move and the emotional register it lives in.
3) {label:"Tension", type:"prose"} the problem or question the text presses on the room. Open the ache, do not resolve it yet.
4) {label:"Type", type:"prose"} the pattern, the typology, the shape of the truth underneath the text.
5) {label:"Truths", type:"points"} three to five teaching points. Each item carries point (alliterated, contrast, or parallel), explanation, and stickyThought (a short quotable line). Leave illustration and application empty... this is an outline, the filling is done live.
6) {label:"Touch", type:"prose"} name the spot where the "I see you" pastoral moment should land, as a slot, not a scripted scene.
7) {label:"Turn", type:"prose"} the pivot from problem to gospel. Name the move, do not rush it.
8) {label:"Takeaway", type:"sticky"} the one line they leave holding.`,
};

function buildPrompt(format: string, topics: string, scripture: string, seed: string, length: string): string {
  const lengthLine = SHOW_LENGTH.has(format) ? `\nDepth: ${LENGTH_GUIDE[length]}` : '';
  return `You are ghostwriting in the authentic voice of Pastor Donte Banks, who goes by P.D., the Lead Pastor of GodChasers Community Church (GC3) in San Antonio, Texas. GC3 is a multi-ethnic, non-denominational church of about six hundred people. This is a starting draft his team will pray over and make his own, so it must sound like him from the first line.

DROP-IN VOICE SPEC (obey every line)
- Open on the ache, not the answer. Name the tension, the question, the thing they walked in carrying, before you offer any relief.
- Land one controlling idea and phrase it as a reframe: what they think is X is really Y. Shapes he uses... "it wasn't a loss, it was a lesson"... "the pit doesn't cancel the promise, it confirms you're carrying one".
- Reframe every hardship as preparation, never punishment. Pit, crushing, wilderness, fire, delay, detour... all of it is qualifying them, not rejecting them. "Delays are not denials." "The burden qualified me for the blessing."
- Build points with alliteration, acrostics, or parallel triads. Real ones... Delays, Detours, Distractions... Prove, Perfect, Point... conditioning, crushing, character... FOG means the Favor Of God.
- Make sticky thoughts short, antithetical, and quotable. Lean on contrast (not X but Y), homophone wordplay (beLIEf, response-ability), and a hard stop. Keep them under about twelve words.
- Repeat the key phrase. Say it, then say it again, three to six times, and let it come back changed.
- Talk to the room, not at it. Heavy "you." Pull them in... "somebody say"... "look at your neighbor"... "hear me right here". Use "we" for the family. Use "I" only to confess or testify, never to boast.
- Anchor every move in the text. Retell the story with live, dramatized dialogue, do not lecture verse by verse. Reach for a Greek or Hebrew word or a Jehovah name when it opens the point, and keep it accurate.
- Illustrate from the everyday: family (mama, grandma, Tab, the kids), sports, food, San Antonio, aviation, nature. Set the scene fast, then bring it straight home to the text. In an outline, name the illustration slot but do not script it.
- Cadence: short sentences hit, long sentences build, stack them. Escalate a triad to a fourth beat when you want the room to rise. Use an ellipsis for breath.
- Grace-forward, always. Never shame doubt... Thomas is the hero. Never shame the struggler. Never moralize. God is still coming their direction.
- Land on a charge and a decision. Make the Turn from problem to gospel, then call the room to act or believe, and say the one idea one more time.

HARD RULES (non negotiable)
- No em dashes anywhere. Use an ellipsis for breath and pacing.
- Never use: embark, delve, diving in, tapestry, testament to, navigate, unleash, "in today's world", the "it's not just X, it's Y" crutch, or any stock Christian cliche. Nothing that reads as generic AI writing.
- Use "serve" not "volunteer".
- Keep talents and gifts distinct. Talents are natural abilities developed through practice. Gifts are spiritual abilities given by God.
- Signature phrases exist ("delay is not denial", "I didn't lose, I learned", "not today Satan", "whatever God has for you is for you"). Use at most one or two, only where they land naturally. Never stack them.

OUTLINE TYPE: ${format}
${FORMAT_SPECS[format]}

INPUTS
Topic(s): ${topics || 'choose the most resonant angle'}
Primary Scripture: ${scripture || 'choose the strongest text'}
On his heart / the tension: ${seed || 'develop the most resonant angle for the topic(s)'}${lengthLine}

OUTPUT
Return ONLY valid JSON, no markdown, no code fences, no text before or after:
{"format": string, "title": string, "scripture": string, "sections": [Section]}
A Section is one of:
{"label": string, "type": "prose", "body": string}
{"label": string, "type": "callout", "body": string}
{"label": string, "type": "sticky", "body": string}
{"label": string, "type": "list", "items": [string]}
{"label": string, "type": "steps", "items": [string]}
{"label": string, "type": "points", "items": [{"point": string, "explanation": string, "stickyThought": string, "illustration": string, "application": string}]}
{"label": string, "type": "group", "blocks": [Block]}  where each Block is a prose, callout, sticky, list, or steps object.
Use only the section types named in the outline above. Escape all quotes and newlines so the JSON parses.`;
}

// ---------- state ----------
interface PointItem { point: string; explanation?: string; stickyThought?: string; illustration?: string; application?: string; }
interface Section { label?: string; type: string; body?: string; items?: (string | PointItem)[]; blocks?: Section[]; }
interface Doc { format?: string; title: string; scripture?: string; sections: Section[]; }

let format = 'Full Sermon';
let topics: string[] = [];
let customTopic = '';
let scripture = '';
let seed = '';
let length = 'Standard';
let busy = false;
let doc: Doc | null = null;

const app = document.getElementById('app')!;

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

// ---------- generation ----------
async function generateOutline(): Promise<Doc> {
  const token = await freshToken();
  if (!token) throw new Error('auth');
  const all = [...topics, ...customTopic.split(',').map(t => t.trim()).filter(Boolean)];
  const prompt = buildPrompt(format, all.join(', '), scripture.trim(), seed.trim(), length);
  const res = await fetch(`${SUPABASE_URL}/functions/v1/social_generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ mode: 'outline', prompt }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `build failed (${res.status})`);
  const d = body.doc as Doc;
  if (!d?.title || !Array.isArray(d.sections) || !d.sections.length) throw new Error('Could not read the draft. Build it again.');
  return d;
}

// ---------- copy to plain text ----------
function blockText(b: Section): string {
  if (b.type === 'prose' || b.type === 'callout' || b.type === 'sticky') return b.body || '';
  if (b.type === 'list') return (b.items || []).map(x => '• ' + x).join('\n');
  if (b.type === 'steps') return (b.items || []).map((x, i) => (i + 1) + '. ' + x).join('\n');
  if (b.type === 'points')
    return ((b.items || []) as PointItem[]).map((p, i) =>
      (i + 1) + '. ' + p.point +
      (p.explanation ? '\nExplanation: ' + p.explanation : '') +
      (p.stickyThought ? '\nSticky Thought: ' + p.stickyThought : '') +
      (p.illustration ? '\nIllustration: ' + p.illustration : '') +
      (p.application ? '\nApplication: ' + p.application : '')).join('\n\n');
  return '';
}
function docToText(d: Doc): string {
  const L = [d.title.toUpperCase()];
  if (d.scripture) L.push('Text: ' + d.scripture);
  L.push('');
  d.sections.forEach(s => {
    if (s.type === 'group') {
      L.push((s.label || '').toUpperCase());
      (s.blocks || []).forEach(b => L.push((b.label ? b.label + ': ' : '') + blockText(b)));
    } else {
      L.push((s.label || '').toUpperCase());
      L.push(blockText(s));
    }
    L.push('');
  });
  return L.join('\n').trim();
}

// ---------- render ----------
function splitP(text?: string): string {
  if (!text) return '';
  return String(text).split(/\n{2,}|\n/).map(s => s.trim()).filter(Boolean).map(s => `<p>${escapeHTML(s)}</p>`).join('');
}
function contentHTML(b: Section): string {
  switch (b.type) {
    case 'prose': return `<div class="o-prose">${splitP(b.body)}</div>`;
    case 'callout': return `<div class="o-idea">${escapeHTML(b.body || '')}</div>`;
    case 'sticky': return `<div class="o-sticky">${escapeHTML(b.body || '')}</div>`;
    case 'list': return `<ul class="o-stmts">${(b.items || []).map(x => `<li>${escapeHTML(String(x))}</li>`).join('')}</ul>`;
    case 'steps': return `<ol class="o-steps">${(b.items || []).map(x => `<li>${escapeHTML(String(x))}</li>`).join('')}</ol>`;
    case 'points':
      return ((b.items || []) as PointItem[]).map((p, i) => `
        <div class="o-point">
          <div class="o-point-head"><span class="o-point-num">${String(i + 1).padStart(2, '0')}</span><span class="o-point-title">${escapeHTML(p.point)}</span></div>
          ${p.explanation ? `<div class="o-sub"><div class="o-sub-lab">Explanation</div><div class="o-prose">${splitP(p.explanation)}</div></div>` : ''}
          ${p.stickyThought ? `<div class="o-sub"><div class="o-sub-lab">Sticky Thought</div><div class="o-sticky">${escapeHTML(p.stickyThought)}</div></div>` : ''}
          ${p.illustration ? `<div class="o-sub"><div class="o-sub-lab">Illustration</div><div class="o-prose">${splitP(p.illustration)}</div></div>` : ''}
          ${p.application ? `<div class="o-sub"><div class="o-sub-lab">Application</div><div class="o-prose">${splitP(p.application)}</div></div>` : ''}
        </div>`).join('');
    default: return '';
  }
}
function sectionHTML(s: Section): string {
  if (s.type === 'group') {
    return `<div class="o-group">
      <div class="o-group-head">${escapeHTML(s.label || '')}</div>
      ${(s.blocks || []).map(b => `<div class="o-sub">${b.label ? `<div class="o-sub-lab">${escapeHTML(b.label)}</div>` : ''}${contentHTML(b)}</div>`).join('')}
    </div>`;
  }
  return `<section class="o-sec">${s.label ? `<div class="o-sec-lab">${escapeHTML(s.label)}</div>` : ''}${contentHTML(s)}</section>`;
}

function render() {
  const canBuild = topics.length > 0 || customTopic.trim().length > 0 || seed.trim().length > 0;
  app.innerHTML = `
  <div class="wrap">
    <header>
      <p class="eyebrow">GC3 Voice Vault &middot; Outline Builder</p>
      <h1>The pulpit is ready</h1>
      <p class="sub">Pick a format, set the topics, name the tension. A full draft lands in your voice.</p>
      <div class="sync-note"><a href="/" style="color:var(--gold)">&larr; Back to the Repost Engine</a></div>
    </header>

    <div class="o-config">
      <div class="o-field">
        <div class="o-eyebrow">Outline type</div>
        <div class="o-fmt">
          ${FORMATS.map(f => `<button data-fmt="${f.key}" class="${format === f.key ? 'on' : ''}"><span class="fl">${f.label}</span><span class="fn">${f.note}</span></button>`).join('')}
        </div>
      </div>
      <div class="o-field">
        <div class="o-eyebrow">Topics <span class="opt">(choose any)</span></div>
        <div class="o-chips">
          ${TOPICS.map(t => `<button data-topic="${t}" class="chip ${topics.includes(t) ? 'on' : ''}">${t}</button>`).join('')}
        </div>
        <input id="custom-topic" class="gen-input slim" style="margin-top:10px" placeholder="Add your own, separate with commas..." value="${escapeHTML(customTopic)}" />
      </div>
      <div class="o-field">
        <div class="o-eyebrow">Scripture <span class="opt">(optional)</span></div>
        <input id="scripture" class="gen-input slim" placeholder="e.g. 1 Chronicles 29:2 ... or leave it to the build" value="${escapeHTML(scripture)}" />
      </div>
      <div class="o-field">
        <div class="o-eyebrow">What's on your heart</div>
        <textarea id="seed" class="gen-input" placeholder="The tension, the angle, the occasion... whatever this should preach into.">${escapeHTML(seed)}</textarea>
      </div>
      ${SHOW_LENGTH.has(format) ? `
      <div class="o-field">
        <div class="o-eyebrow">Depth</div>
        <div class="o-seg">
          ${LENGTHS.map(l => `<button data-len="${l.key}" class="${length === l.key ? 'on' : ''}"><span class="lab">${l.label}</span><span class="note">${l.note}</span></button>`).join('')}
        </div>
      </div>` : ''}
      <button class="btn primary block" id="build" ${(!canBuild || busy) ? 'disabled' : ''}>${busy ? 'Building…' : 'Build it'}</button>
      ${!canBuild ? `<div class="o-hint">Pick a topic or add some context to begin.</div>` : ''}
    </div>

    <div id="result"></div>
  </div>
  <div class="toast" id="toast"></div>`;

  document.querySelectorAll<HTMLElement>('[data-fmt]').forEach(b =>
    b.addEventListener('click', () => { format = b.dataset.fmt!; render(); }));
  document.querySelectorAll<HTMLElement>('[data-topic]').forEach(b =>
    b.addEventListener('click', () => {
      const t = b.dataset.topic!;
      topics = topics.includes(t) ? topics.filter(x => x !== t) : [...topics, t];
      render();
    }));
  document.querySelectorAll<HTMLElement>('[data-len]').forEach(b =>
    b.addEventListener('click', () => { length = b.dataset.len!; render(); }));
  (document.getElementById('custom-topic') as HTMLInputElement).addEventListener('input', e => { customTopic = (e.target as HTMLInputElement).value; });
  (document.getElementById('scripture') as HTMLInputElement).addEventListener('input', e => { scripture = (e.target as HTMLInputElement).value; });
  (document.getElementById('seed') as HTMLTextAreaElement).addEventListener('input', e => { seed = (e.target as HTMLTextAreaElement).value; });
  document.getElementById('build')!.addEventListener('click', build);
  renderResult();
}

async function build() {
  if (busy) return;
  busy = true; doc = null; render();
  try { doc = await generateOutline(); }
  catch (e) {
    const m = (e as Error).message;
    showToast(m.includes('key not set') ? 'Generation key is not set yet' : m.includes('admin') ? 'This page is admin only' : 'That build stalled, try again');
  } finally { busy = false; render(); }
}

function renderResult() {
  const box = document.getElementById('result');
  if (!box) return;
  if (busy) { box.innerHTML = `<div class="loading"><div class="flame">🔥</div>Searching the text… shaping the structure…</div>`; return; }
  if (!doc) return;
  const topicLine = [...topics, ...customTopic.split(',').map(t => t.trim()).filter(Boolean)].join(' · ') || 'Message';
  box.innerHTML = `
    <div class="o-tools">
      <button class="btn primary" id="copy-doc">Copy</button>
      <button class="btn" id="rebuild">Rebuild</button>
      <button class="btn" id="clear">New</button>
    </div>
    <article class="o-doc">
      <div class="o-slate">
        <div class="o-kicker">${escapeHTML(doc.format || format)} &middot; ${escapeHTML(topicLine)}</div>
        <h2 class="o-title">${escapeHTML(doc.title)}</h2>
        ${doc.scripture ? `<div class="o-rule"></div><div class="o-ref">${escapeHTML(doc.scripture)}</div>` : ''}
      </div>
      <div class="o-body">${doc.sections.map(sectionHTML).join('')}</div>
    </article>
    <div class="o-footnote">Every draft is a starting point. Pray it through and make it yours.</div>`;
  document.getElementById('copy-doc')!.addEventListener('click', () => {
    navigator.clipboard.writeText(docToText(doc!)).then(() => showToast('Copied'), () => showToast('Copy failed'));
  });
  document.getElementById('rebuild')!.addEventListener('click', build);
  document.getElementById('clear')!.addEventListener('click', () => { doc = null; render(); });
}

// ---------- boot: admin gate ----------
async function boot() {
  const s = getSession();
  if (!s) {
    app.innerHTML = `<div class="gate"><div class="flame">🔒</div><h2>Sign in first</h2><p>Sign in on the Repost Engine, then come back here.</p><button id="go">Go to the Repost Engine</button><div class="err"></div></div>`;
    document.getElementById('go')!.addEventListener('click', () => { location.href = '/'; });
    return;
  }
  app.innerHTML = `<div class="loading"><div class="flame">🔥</div>Checking the study door…</div>`;
  try {
    const token = await freshToken();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/repost_current_user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
      body: '{}',
    });
    const me = await res.json().catch(() => null);
    if (!res.ok || !me?.email) throw new Error('not allowed');
    if (me.role !== 'admin') {
      app.innerHTML = `<div class="gate"><div class="flame">🚪</div><h2>PD's study</h2><p>This page is just for PD. The Repost Engine is where your tools live.</p><button id="go">Back to the Repost Engine</button><div class="err"></div></div>`;
      document.getElementById('go')!.addEventListener('click', () => { location.href = '/'; });
      return;
    }
    render();
  } catch {
    app.innerHTML = `<div class="gate"><div class="flame">🔒</div><h2>Sign in first</h2><p>Your session needs a refresh. Sign in on the Repost Engine, then come back.</p><button id="go">Go to the Repost Engine</button><div class="err"></div></div>`;
    document.getElementById('go')!.addEventListener('click', () => { location.href = '/'; });
  }
}
boot();
