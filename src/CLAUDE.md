# Packing Tool — project context

Personal travel packing checklist web app. Two trip types (**golf**, **vacation**) share **one** item list; each item is tagged where it shows, and quantities compute from trip length. Mobile-first.

**Now an invite-only multi-user app** (accounts, per-trip lists, admin) on a **Supabase** backend — full history + data model in [DESIGN.md](../DESIGN.md).

## Stack
- Vite + React (plain JS, no TypeScript).
- All UI is inline-styled — no CSS framework. Global reset lives in `src/index.css`.
- All components live in `src/App.jsx` (default export `App`, the auth gate). UI components (PackList, Home, TripView, AdminPanel, …) stayed stable across the backend migrations.
- Lean by default; the one runtime dependency beyond React is `@supabase/supabase-js` (auth + DB).

## Data model
```
Template = { sections: [ { id, title, note?, items: [ Item ] } ] }
Item     = { id, name, scope, hint?, qty }
scope    = "all" | "golf" | "vac" | "beach"
qty      = null | { mode:"fixed", value } | { mode:"formula", n, r, c, floor }
```

## Rule engine
`compute(qty, N, R)` where N = nights, R = rounds (R = 0 on vacation):
- `fixed` → `value`
- `formula` → `max(floor, round(n*N + r*R + c))`

Default rules: everyday underwear/socks scale with nights; golf underwear/socks/polos = `rounds + 1`; towels = `rounds − 1`.

## Scope filtering
- `all` → every trip
- `golf` → golf trip only
- `vac` → vacation only
- `beach` → vacation + beach toggle on (always visible in edit mode so it can be edited)

## Backend (Supabase)
Project `gatojcysyitptaglomin`: Postgres + Auth + row-level security. Frontend uses `@supabase/supabase-js` with the public URL + publishable key (baked in; overridable via `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`).
- **Auth:** Supabase session — Google OAuth + email magic-link. `App` (auth gate) loads the session, resolves access from `members`, fetches the global template, then renders.
- **Per-user state:** one `user_data` row (`{ user_id, email, data }`) holding the whole app-state blob `{ profileDefault, trips:[…] }`. `fetchUserData` loads it; `saveUserData` debounce-upserts. **RLS isolates each user to their own row** (real isolation — not trust-based).
- **Global default:** `app_config.template` (admin-editable) seeds new users' `profileDefault`.
- **Access/roles:** `members` table (`email, is_admin, is_allowed`); `OWNER_EMAIL` is a hardcoded admin bootstrap. RLS: any authed user reads `members`; only admins write `members` / `app_config`.

## Database (`../supabase/schema.sql`)
Tables `members`, `app_config` (singleton), `user_data`; SECURITY DEFINER fns `is_member()` / `is_admin()` back the RLS policies. Run it in the Supabase SQL editor.

**Legacy Make backend — decommissioned.** The Make.com webhook/scenario/data-store (scenario `6365416`, data store `140245`) was the Phase 1–3 backend; the scenario is **deactivated**. The data store is kept as a cold backup of pre-Supabase data and can be deleted when no longer wanted.

## Deploy
- Repo `nachossupremezzz/packing-tool`; **GitHub Pages** serves `https://nachossupremezzz.github.io/packing-tool/`.
- `base: '/packing-tool/'` in `vite.config.js`. Every push to `main` auto-builds + deploys via `.github/workflows/deploy.yml`.
- Supabase **Auth → URL Configuration** must allow the Pages URL + `http://localhost:5179/packing-tool/` (OAuth/magic-link redirect targets).

## Conventions
- Don't break the rule engine or scope tags.
- Inline styles, max content width 560, large tap targets.
- Respond and comment in English.

## Run
`npm run dev` → localhost:5173 (or 5179 via `.claude/launch.json`). Live reload while editing.
