# GC3 Repost Engine v2

Daily reposting engine for Pastor Donte Banks (PD), Lead Pastor, GodChasers
Community Church. Surfaces six evergreen picks each morning from a 16-year,
16,000-post Facebook archive. Live at https://pd-repost-engine-gc3.netlify.app

## Architecture (and why)

**Frontend: Vite + vanilla TypeScript.** The handoff recommended Vite + React
(or Svelte if leaner). Vanilla TS is leaner still for this app: two views, six
cards, no shared component state worth a framework. v1's DOM patterns were
already clean; porting them kept the approved look pixel-faithful, ships about
6 KB of JS, and makes Lighthouse 90+ automatic. If the app grows real
navigation or team features, Svelte is the upgrade path.

**Backend: Supabase (gc3-sermon-library project) as the live source of truth.**

- `repost_pool` (table): the evergreen pool, rebuilt in-database by
  `repost_rebuild_pool_v2()`. This is the Python curation pipeline ported to
  Postgres regexes (`~*` with `\y` word boundaries), plus documented v2
  pattern additions for leak classes the original list missed (live sports,
  check-ins, airlines, phone numbers, service-time hashtags, @handles, and
  more). The pool refreshes automatically whenever data is requested and the
  pool is older than 24 hours, so new Facebook posts enter rotation with no
  manual re-curation.
- `repost_log` (table): every action (`reposted` / `skipped` / `shuffled`)
  with date and optional edited text. This is what makes state sync across
  PD's phone and desktop.
- `repost_meta`: passphrase hash and pool freshness.
- RPCs `repost_data(pass)` and `repost_act(pass, ...)`: the only doors in.
  Both are SECURITY DEFINER and verify the shared passphrase server-side, so
  the tables carry RLS with no anon policies at all. The Supabase publishable
  key alone reads nothing.

**Auth: email sign-in code (Supabase OTP) + server-side allowlist.**
Users enter their email, receive a 6-digit code, and sign in. The RPCs are
granted to `authenticated` only and verify the caller's email against the
`repost_users` table on every call, so only allowlisted people can read or
write anything. Current allowlist: dontebee@gmail.com (admin),
latwanna@godchasers.church, tiffany@godchasers.church. To add someone:
`insert into repost_users (email, role) values ('name@example.com', 'user');`

One-time project setting: the sign-in email must contain the code. In the
Supabase dashboard, Authentication > Email Templates > Magic Link, make sure
the body includes `{{ .Token }}`, for example:
`<p>Your Repost Engine sign-in code: <b>{{ .Token }}</b></p>`
(The emailed magic link also works as a fallback if tapped on the same device.)

## Product law (enforced)

1. Evergreen only. Moment filter runs in Postgres; validated against the
   510-post v1 baseline (95.9 percent reproduced; every exclusion audited as a
   justified moment rejection or safe-direction tightening) and spot-checked
   until a clean 20-of-20 draw.
2. Verbatim text. The engine never rewrites; the Edit box is PD's pen, and
   edited text is logged as `edited_text`, original stays untouched.
3. Cooldowns: reposted = 90 days, skipped = 14 days, enforced at batch time
   from the log.
4. Daily batch of six, seeded deterministically by date (plus shuffle count),
   max 1 per year and 2 per theme, so every device draws the same six all day
   and eras stay mixed. "New batch" writes a `shuffled` log row, which bumps
   the seed for every device at once.

## Timestamp caveat (respected)

`social_posts.posted_at` is naive US Central time mislabeled as UTC. All SQL
uses raw values (`posted_at::date`, no `AT TIME ZONE`), per the handoff.

## Develop

```
npm install
npm run dev      # local dev server
npm run build    # typecheck + production build to dist/
```

Deploys to the existing Netlify site `pd-repost-engine-gc3`
(site id e0947373-6a40-4829-95b1-c668ec77f6b6), publish directory `dist`.
