# Packing Tool — project context

Personal travel packing checklist web app. Two trip types (**golf**, **vacation**) share **one** item list; each item is tagged where it shows, and quantities compute from trip length. Mobile-first.

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

## Storage (current → target)
Current: a `store` adapter — uses `window.storage` if present, else `localStorage`. Keys: `packing:v4:tpl`, `packing:v2:settings`, `packing:v4:checked`, `packing:v4:userdef`.

**Target: replace local storage with a Make.com webhook backend so state syncs across devices.**

## Make backend (partly provisioned)
- Org `7878127` "My Organization" (Pro, region **eu1.make.com**)
- Team `1837746` "My Team"
- Data store `140245` "Packing tool" (1 MB) — already created
- Needs a data structure with one text field `value` (Make write actions require in-app approval)
- Build a scenario with a **custom webhook**:
  - `GET` (or `?api=get`) → data store *get* record key `shared` → respond JSON
  - `POST ?api=set` with `text/plain` body → *upsert* record key `shared` → respond `ok`
  - Use GET + text/plain POST to dodge CORS preflight, or set `Access-Control-Allow-Origin: *` in the webhook response module.
- App loads on start (GET) and saves on change (POST) to this webhook URL instead of localStorage. Keep a localStorage fallback for offline.

## Build / deploy plan
1. Replace `src/App.jsx` and `src/index.css` (Jonas has the files). Delete unused `src/App.css`.
2. `git init`, commit.
3. Create a GitHub repo, push.
4. Enable **GitHub Pages**. Vite gotcha: for a project site set `base: '/REPO_NAME/'` in `vite.config.js` or assets 404. A `gh-pages` action or `npm run build` + deploy of `dist/` both work.
5. Add the Make webhook URL to the app (constant or `.env`), swap the `store` adapter to call it.
6. Deploy, verify sync across phone + laptop.

## Conventions
- Don't break the rule engine or scope tags.
- Inline styles, max content width 560, large tap targets.
- Respond and comment in English.

## Run
`npm run dev` → localhost:5173. Keep it running in a separate terminal while editing for live reload.
