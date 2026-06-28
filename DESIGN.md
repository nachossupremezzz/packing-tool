# Packing Tool — multi-user design

Status: **Phases 1–3 shipped** (2026-06-29). Phase 4 (optional hardening / magic-link) remains. Supersedes the single-shared-list model.

## Goal
Evolve the personal single-list app into an **invite-only multi-user** app:
- Each user logs in (Google) and has their own packing data.
- Users plan **multiple trips**, each with its own dates/details, inventory snapshot, and packing state.
- Each user has an **evolving personal default** template (new trips seed from it).
- An **admin** edits the **global app defaults** (base template + rule config) that seed new users.

## Key decisions
- **Backend: stay on Make.com** (data store `140245` + existing webhook), namespaced per user. No new service.
- **Auth: Google Sign-In** (client-side, Google Identity Services). Magic link deferred to Phase 4 — it needs email infra Make handles poorly.
- **Audience: invite-only, trusted group.** Security is trust-based (see below).
- **Admin allowlist:** `jonas.takolander@gmail.com`.

## Security posture — read this
This is a **static frontend + public webhook**, and the repo is public, so **anything in the JS bundle is public**. Implications:
- Google Sign-In gives a *verified identity* (email) we use to namespace data. Good for identity.
- The webhook itself can't verify the caller. We add a shared secret as a **speed bump**, but it lives in the public bundle — it deters casual hits, it is **not** real security.
- So an invited, technically-minded user could in principle reach another user's data, and the webhook is reachable by anyone who reads the bundle.
- **Acceptable for an invite-only trusted group.** Real per-user isolation requires verifying the Google ID token (JWT) inside the Make scenario, or moving to Supabase — tracked as **Phase 4**.

## Data model (data store `140245`, keyed records)
- `app:defaults` → `{ template, ruleConfig }` — global, admin-editable; seeds new users.
- `user:<email>` → `{ profileDefault, settings, trips: { <tripId>: Trip } }`
  - `Trip = { id, name, type:"golf"|"vacation", startDate, endDate, nights, rounds, beach, notes, inventory, checked, createdAt }`
- Each record's JSON is stored as text in the existing `value` field; the webhook reads/writes by key.

Phase 1 keeps each user's record shaped like today's blob (the four `packing:*` keys) but stored under `user:<email>`. The richer `trips` shape lands in Phase 2.

## Auth flow (Google Identity Services)
1. App loads the GIS script and renders **Sign in with Google** (`VITE_GOOGLE_CLIENT_ID`, a public value).
2. Google returns an ID token (JWT); the app decodes the payload client-side → `{ email, name, picture }`.
3. App caches the identity in localStorage (stay signed in across reloads) and loads `user:<email>`.
4. Sign out clears the cached identity.

Prereq: a Google OAuth **Client ID** with authorized JS origin `https://nachossupremezzz.github.io` (and `http://localhost:5179` for dev). Setup is guided separately.

## Make scenario (generalize `6365416`)
Today the scenario hardcodes key `shared`. Changes:
- Webhook accepts `key` and `secret` params.
- GetRecord / AddRecord use `{{1.key}}`.
- Both routes additionally require `{{1.secret}}` to equal the app secret (speed bump; fails closed).
- Webhook URL is unchanged.

## Roles
- Admin allowlist (emails) lives in the frontend. Admins get an **Admin panel** to edit `app:defaults`.
- Non-admins: normal trip planning; their personal default evolves independently of the global default.

## Phases
1. ✅ **Accounts + per-user data**: Google login, per-user key, generalized Make scenario, migrate the `shared` data into the signed-in admin's record.
2. ✅ **Multiple trips:** trips home, new-trip (dates→nights, type/details), per-trip inventory + state, trip switching, per-user default editor + save-as-default. State stored under the `v5` key; Phase-1 records auto-migrate to a first "My trip".
3. ✅ **Admin:** admin panel with **Members** (invite/remove emails, toggle admin) and **Default list** (edit the global template) tabs, backed by the `app:defaults` record. Access (admins/allowed) is data-driven, with `jonas` as a hardcoded root-owner bootstrap that can't be locked out. New users seed their personal default from `app:defaults.template`. Only the owner (`OWNER_EMAIL`) inherits the legacy `shared` record.
4. **Optional:** magic-link login, Google-token verification in Make (real isolation) or Supabase migration, data-store sharding if the 1 MB store fills.

## Config (all public, baked at build time)
- `VITE_SYNC_URL` — Make webhook (default constant in code).
- `VITE_GOOGLE_CLIENT_ID` — Google OAuth client id.
- `VITE_APP_SECRET` — webhook speed-bump secret.
