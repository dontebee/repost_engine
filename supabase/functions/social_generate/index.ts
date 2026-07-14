// social_generate: drafts new posts in PD's voice for a channel (Facebook / Gloo Text /
// Twitter) from a title, text, or transcript, and surfaces matching evergreen posts to
// repost. Only provisioned repost users may call it.
//
// Deploy:  supabase functions deploy social_generate
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   (or set it in the dashboard)

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = "claude-sonnet-4-6";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const VOICE = `You are ghostwriting social copy in the voice of Pastor Donte Banks (P.D.), Lead Pastor of GodChasers Community Church (GC3) in San Antonio. It must sound like him from the first line.
Voice: open on the ache, not the answer. Land one idea as a reframe (what looks like X is really Y). Treat hardship as preparation, never punishment. Sticky lines are short and antithetical. Talk to the reader with heavy "you". Grace-forward, never shame doubt.
Hard rules: no em dashes, use an ellipsis for breath. Never use embark, delve, diving in, tapestry, testament to, navigate, unleash, "in today's world", or the "it's not just X, it's Y" crutch. Say "serve" not "volunteer". Keep talents (natural, practiced) and gifts (given by God) distinct. Nothing that reads as generic AI.`;

const PLATFORM: Record<string, string> = {
  facebook: "Facebook post: 2 to 5 short paragraphs, story-driven, opens on an ache and lands on a charge or a question. At most one or two hashtags, and only if they fit.",
  gloo: "Gloo text blast, an SMS to the church: warm and personal, 1 to 3 short lines, under 300 characters, one clear invite or encouragement. No links unless the source gives one.",
  twitter: "Tweet: under 280 characters, one punchy quotable idea. One option may be a 2-tweet thread.",
};

function json(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), { status, headers: { ...CORS, "content-type": "application/json" } });
}

function keywords(s: string): string[] {
  const stop = new Set(["about","would","there","their","which","because","people","every","other","these","those","after","before","still","never","always","today","going","really"]);
  const freq = new Map<string, number>();
  for (const w of (s.toLowerCase().match(/[a-z']{5,}/g) ?? [])) {
    if (stop.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map((e) => e[0]);
}

async function repostOptions(input: string) {
  const words = keywords(input);
  if (!words.length) return [];
  const orf = "or=(" + words.map((w) => `text.ilike.*${w}*`).join(",") + ")";
  const url = `${SUPABASE_URL}/rest/v1/repost_pool?select=post_id,post_year,text,theme&limit=4&${orf}`;
  const r = await fetch(url, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  if (!r.ok) return [];
  const rows = await r.json();
  return (rows as any[]).map((p) => ({ id: p.post_id, year: p.post_year, text: p.text, theme: p.theme }));
}

async function provisioned(authHeader: string): Promise<boolean> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/repost_current_user`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: authHeader, "content-type": "application/json" },
    body: "{}",
  });
  return r.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth) return json({ error: "not signed in" }, 401);
    if (!(await provisioned(auth))) return json({ error: "not allowed" }, 403);
    if (!ANTHROPIC_KEY) return json({ error: "generation key not set on the function" }, 500);

    const body = await req.json().catch(() => ({}));
    const platform = String(body.platform ?? "");
    const inputType = String(body.input_type ?? "text");
    const input = String(body.input ?? "").trim();
    if (!input || !PLATFORM[platform]) return json({ error: "platform and input are required" }, 400);

    const prompt = `${VOICE}

CHANNEL: ${PLATFORM[platform]}

The team member gives you a ${inputType} to work from. Draft in P.D.'s voice for this channel.

${inputType.toUpperCase()}:
${input.slice(0, 12000)}

Return ONLY valid JSON, no markdown, no code fences:
{"drafts": [{"label": string, "text": string}]}
Give 3 to 5 distinct options. label is a 2 to 4 word angle. text is ready-to-post copy for the channel above.`;

    const ar = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
    });
    if (!ar.ok) return json({ error: "generation failed", detail: (await ar.text()).slice(0, 300) }, 502);
    const data = await ar.json();
    let txt = ((data.content ?? []) as any[]).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    txt = txt.replace(/```json/gi, "").replace(/```/g, "").trim();
    const a = txt.indexOf("{"), z = txt.lastIndexOf("}");
    if (a >= 0 && z >= 0) txt = txt.slice(a, z + 1);
    const parsed = JSON.parse(txt);

    const reposts = await repostOptions(input);
    return json({ drafts: parsed.drafts ?? [], reposts, platform });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
