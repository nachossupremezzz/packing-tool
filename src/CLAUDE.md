# Packing Tool — project context

Personal travel packing checklist web app. Two trip types (**golf**, **vacation**) share **one** item list; each item is tagged where it shows, and quantities compute from trip length. Mobile-first.

**Evolving into an invite-only multi-user app** (accounts, per-trip lists, admin) — full plan, data model, and security posture in [DESIGN.md](../DESIGN.md). Phase 1 (Google login + per-user data) in progress.

## Stack
- Vite + React (plain JS, no TypeScript).
- All UI is inline-styled — no CSS framework. Global reset lives in `src/index.css`.
- One component, default export `App`, in `src/App.jsx`.
- Keep it lean: no extra dependencies unless genuinely needed.

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

## Storage
A `store` adapter syncs all state through one Make.com webhook backed by a data-store record (`shared`). The four logical keys (`packing:v4:tpl`, `packing:v2:settings`, `packing:v4:checked`, `packing:v4:userdef`) are held together in one JSON map; `localStorage` (`packing:v4:all`) mirrors it for offline reads and migrates the old per-key layout. Loads via GET on start; saves via debounced form POST. Pushes are gated on a successful remote load so a failed fetch never clobbers good data.

## Make backend (provisioned)
- Org `7878127` (Pro, region **eu1.make.com**), Team `1837746`.
- Data store `140245` "Packing tool" (1 MB), data structure `472982` (one text field `value`), record key `shared`.
- Custom webhook hook `3308885` → URL `https://hook.eu1.make.com/9sj1gxhjebty57hamg2a9elteipdqbvb`.
- Scenario `6365416` "Packing tool sync" (active, schedule `immediately`): webhook → router →
  - `?api=set` → datastore **AddRecord** (key `shared`, `overwrite`, fields nested under `data.value`) → respond `ok`
  - else → datastore **GetRecord** (key `shared`, `returnWrapped:false`; output `value` at top level) → respond `{{value}}` as JSON
  - Both responses send `Access-Control-Allow-Origin: *`; Make Gateway also adds it automatically (even on errors).
- App POSTs `application/x-www-form-urlencoded` `value=<json>` (CORS-simple, no preflight) — chosen over the original text/plain because Make parses it into a clean `value` field. Writes via this MCP token did **not** need in-app approval.

## Build / deploy plan
1. ✅ `src/App.jsx`/`src/index.css` in place; unused `src/App.css` deleted.
2. ✅ `git init`, commits on `main`.
3. ⏳ Create GitHub repo `packing-tool` (public) + push — needs `gh auth login` (gh is installed).
4. ⏳ Enable **GitHub Pages**. `base: '/packing-tool/'` set in `vite.config.js`. Deploy via `.github/workflows/deploy.yml` (Actions builds + uploads `dist/`); set Pages source = **GitHub Actions** in repo settings.
5. ✅ Webhook wired into the `store` adapter (constant default, overridable via `VITE_SYNC_URL`).
6. ⏳ Deploy, then verify sync across phone + laptop (backend already verified in-browser: load→GET, change→POST, reload re-hydrates from server).

## Conventions
- Don't break the rule engine or scope tags.
- Inline styles, max content width 560, large tap targets.
- Respond and comment in English.

## Run
`npm run dev` → localhost:5173. Keep it running in a separate terminal while editing for live reload.
