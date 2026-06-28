import { useState, useEffect } from "react";

// ---- Config (all public values, baked at build; see DESIGN.md) ----
const SYNC_URL = import.meta.env.VITE_SYNC_URL || "https://hook.eu1.make.com/9sj1gxhjebty57hamg2a9elteipdqbvb";
const APP_SECRET = import.meta.env.VITE_APP_SECRET || "pktool_s3cr3t_2f8a"; // webhook speed-bump (public, not real security)
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "530393865659-hol5hh4c4vmft191fmjctkuk4fd4685b.apps.googleusercontent.com"; // public OAuth client id
const ADMIN_EMAILS = ["jonas.takolander@gmail.com"]; // root owner(s): always admin + allowed (bootstrap, can't be locked out)
const ALLOWED_EMAILS = ["jonas.takolander@gmail.com"]; // base invite list; admins add more via the panel (stored in app:defaults)
const OWNER_EMAIL = "jonas.takolander@gmail.com"; // original single-list user; only they inherit the legacy "shared" record
const lc = (x) => String(x || "").toLowerCase();

// ---- Auth helpers (Google Identity Services) ----
const AUTH_LS = "packing:auth"; // cached identity { email, name, picture }
function decodeJwt(t) { try { const p = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); return JSON.parse(decodeURIComponent(escape(atob(p)))); } catch (e) { return null; } }
function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.defer = true;
    s.onload = () => resolve(); s.onerror = () => reject(new Error("GIS load failed"));
    document.head.appendChild(s);
  });
}
function cachedIdentity() { try { const v = localStorage.getItem(AUTH_LS); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function cacheIdentity(u) { try { if (u) localStorage.setItem(AUTH_LS, JSON.stringify(u)); else localStorage.removeItem(AUTH_LS); } catch (e) {} }

// ---- Storage adapter: one record per user (user:<email>) on the Make webhook ----
// A user's whole state is one JSON map; localStorage mirrors it per user for offline reads.
// Pushes are gated on a successful remote load so a failed fetch never clobbers good data.
const LEGACY_KEYS = ["packing:v4:tpl", "packing:v2:settings", "packing:v4:checked", "packing:v4:userdef"];
let activeKey = null;      // e.g. "user:jane@x.com"
let migrateShared = false; // admin's first login seeds from the legacy single-list record
let cache = null, cacheReady = false, remoteOK = false, syncTimer = null;

const mirrorKey = () => "packing:v4:all:" + (activeKey || "anon");
function readMirror() {
  try { const m = localStorage.getItem(mirrorKey()); if (m) return JSON.parse(m); } catch (e) {}
  const legacy = {}; // one-time pickup of the old per-key layout (single-user era)
  for (const k of LEGACY_KEYS) { try { const v = localStorage.getItem(k); if (v != null) legacy[k] = v; } catch (e) {} }
  return legacy;
}
function writeMirror() { try { localStorage.setItem(mirrorKey(), JSON.stringify(cache || {})); } catch (e) {} }

async function remoteGet(key) {
  const res = await fetch(SYNC_URL + "?api=get&secret=" + encodeURIComponent(APP_SECRET) + "&key=" + encodeURIComponent(key));
  if (!res.ok) throw new Error("http " + res.status);
  const txt = await res.text();
  let obj = null; try { obj = txt ? JSON.parse(txt) : {}; } catch (e) { obj = {}; } // "Accepted"/missing -> {}
  return obj && typeof obj === "object" ? obj : {};
}

function remoteSet(key, value) {
  return fetch(SYNC_URL + "?api=set&secret=" + encodeURIComponent(APP_SECRET) + "&key=" + encodeURIComponent(key), {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "value=" + encodeURIComponent(value),
  });
}

// ---- App-wide config (admin-managed record): { template, admins, allowed } ----
const CONFIG_KEY = "app:defaults";
async function loadAppConfig() { try { const c = await remoteGet(CONFIG_KEY); if (c && typeof c === "object") return c; } catch (e) {} return {}; }
async function saveAppConfig(cfg) { try { await remoteSet(CONFIG_KEY, JSON.stringify(cfg)); return true; } catch (e) { return false; } }
function resolveIsAdmin(email, cfg) { const e = lc(email); return !!e && (ADMIN_EMAILS.includes(e) || ((cfg && cfg.admins) || []).map(lc).includes(e)); }
function resolveIsAllowed(email, cfg) { const e = lc(email); return resolveIsAdmin(email, cfg) || ALLOWED_EMAILS.includes(e) || ((cfg && cfg.allowed) || []).map(lc).includes(e); }

// Initialise the adapter for a signed-in user; resolves once the cache is ready.
async function initUser(email, isAdmin) {
  activeKey = "user:" + String(email).toLowerCase();
  migrateShared = !!isAdmin;
  cache = readMirror(); cacheReady = false; remoteOK = false;
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  if (SYNC_URL) {
    try {
      let remote = await remoteGet(activeKey);
      if (Object.keys(remote).length === 0 && migrateShared) {
        try { const legacy = await remoteGet("shared"); if (Object.keys(legacy).length > 0) remote = legacy; } catch (e) {}
      }
      if (Object.keys(remote).length > 0) cache = remote; // else keep local seed / app defaults
      remoteOK = true; writeMirror();
    } catch (e) { /* offline: keep local mirror, read-only to remote */ }
  }
  cacheReady = true;
  return cache;
}
function teardownUser() {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  if (remoteOK) pushNow(); // flush pending writes before leaving
  activeKey = null; cache = null; cacheReady = false; remoteOK = false; migrateShared = false;
}

function pushNow() {
  syncTimer = null;
  if (!SYNC_URL || !remoteOK || !activeKey) return;
  try {
    fetch(SYNC_URL + "?api=set&secret=" + encodeURIComponent(APP_SECRET) + "&key=" + encodeURIComponent(activeKey), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, // CORS-simple: no preflight
      body: "value=" + encodeURIComponent(JSON.stringify(cache || {})),
      keepalive: true,
    }).catch(() => {});
  } catch (e) {}
}
function scheduleSync() {
  if (!SYNC_URL || !remoteOK || !activeKey) return; // only push once remote is reachable
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(pushNow, 600);
}

const store = {
  async get(k) { if (!cacheReady) return null; const v = cache ? cache[k] : null; return v == null ? null : { value: v }; },
  set(k, v) { if (!activeKey) return; if (!cache) cache = {}; cache[k] = v; cacheReady = true; writeMirror(); scheduleSync(); },
};

const C = { paper:"#f4f3ee", ink:"#15211b", fairway:"#1f6f47", fairwayDk:"#155034", line:"#e2e1d8", muted:"#6c726a", card:"#ffffff", sand:"#c9a24b", danger:"#b23b3b" };
const uid = (p) => p + Math.random().toString(36).slice(2, 8);

const none = (id, name, scope = "all", hint) => ({ id, name, scope, hint, qty: null });
const fix = (id, name, scope, value, hint) => ({ id, name, scope, hint, qty: { mode: "fixed", value } });
const fml = (id, name, scope, n, r, c, floor = 1, hint) => ({ id, name, scope, hint, qty: { mode: "formula", n, r, c, floor } });

function compute(qty, N, R) {
  if (!qty) return null;
  if (qty.mode === "fixed") return qty.value;
  const v = qty.n * N + qty.r * R + qty.c;
  return Math.max(qty.floor == null ? 0 : qty.floor, Math.round(v));
}
function labelFor(item, N, R) { const v = compute(item.qty, N, R); return v == null ? item.name : item.name + " ×" + v; }
function itemVisible(item, trip, beach, mode) {
  const s = item.scope || "all";
  if (s === "all") return true;
  if (s === "golf") return trip === "golf";
  if (s === "vac") return trip === "vacation";
  if (s === "beach") return trip === "vacation" && (mode === "edit" || beach);
  return true;
}

function makeDefaults() {
  return { sections: [
    { id:"docs", title:"Documents & money", items:[ none("d1","Passport / ID"), none("d2","Boarding passes (phone + backup)"), none("d3","Wallet — cards + cash"), none("d4","EHIC / Kela card") ] },
    { id:"tech", title:"Tech", note:"Power bank (and rangefinder) ride in the cabin bag — never checked.", items:[ none("t1","Phone + charger"), none("t2","Power bank"), none("t3","Charging cables"), none("t4","Earbuds / headphones"), none("t5","Rangefinder / GPS watch + charger","golf") ] },
    { id:"toil", title:"Toiletries", note:"≤100ml each, 1L clear bag, cabin.", items:[ none("o1","Toiletry bag"), none("o2","Shaver + charger"), none("o3","Toothbrush + toothpaste"), none("o4","Deodorant"), none("o5","Sunscreen"), none("o6","Lip balm"), none("o7","Painkillers / meds") ] },
    { id:"cloth", title:"Clothing", items:[
      fml("c1","Underwear (everyday)","all",1,0,2,1), fml("c2","Socks (everyday)","all",2,0,1,1), fix("c3","Long socks","all",1),
      fml("c4","T-shirts","all",1,0,1,1), fix("c5","Smart evening shirt","all",2), fix("c6","Casual shorts","all",2),
      fix("c7","Jeans","all",1), fix("c8","Hoodie / light layer","all",1), none("c9","Belt"), none("c10","Sunglasses"),
      none("c11","Casual shoes","all","wear on travel day") ] },
    { id:"golf", title:"Golf gear", note:"Clubs, shoes, rain gear & towels pack inside the travel cover (checked).", items:[
      none("k1","Clubs in cart bag → travel cover","golf"), none("k2","Golf shoes","golf"),
      fml("k3","Golf polos","golf",0,1,1,1), fml("k4","Golf shorts","golf",0,0.5,0,1),
      fml("ku","Golf underwear","golf",0,1,1,1,"fresh pair after each round"), fml("ks","Golf socks","golf",0,1,1,1),
      none("k5","Caps — golf + casual","golf"), fix("k6","Balls","golf",12), none("k7","Tees","golf"),
      fix("k8","Gloves","golf",2), fix("k9","Wet-weather glove","golf",1), none("k10","Ball markers / pitch tool","golf"),
      fml("k11","Towels","golf",0,1,-1,1), none("k13","Rain jacket","golf"), none("k14","Rain hood","golf"),
      none("k15","Umbrella","golf"), none("k16","Blister plasters","golf"), none("k17","Water bottle","golf"), none("k18","Snacks","golf") ] },
    { id:"beach", title:"Sun / beach", items:[ fix("b1","Swimwear","beach",2), none("b2","Quick-dry / beach towel","beach"), none("b3","Flip-flops","beach"), none("b4","Sun hat","beach"), none("b5","After-sun","beach") ] },
    { id:"pre", title:"Pre-flight", items:[ none("p1","Liquids ≤100ml in 1L bag"), none("p2","Power bank in cabin bag"), none("p3","Carry-on size/weight checked"), none("p4","Golf cover booked with airline as sports item","golf"), none("p5","Loaded cover under weight limit (~20kg)","golf") ] },
  ] };
}

const btnStep = { width:40, height:42, border:"none", background:"transparent", fontSize:20, color:C.fairway, cursor:"pointer" };
const lblStyle = { fontSize:11, letterSpacing:1.5, textTransform:"uppercase", color:C.muted, margin:"10px 0 6px" };
const textInput = { width:"100%", boxSizing:"border-box", fontSize:16, padding:"10px 12px", border:"1px solid "+C.line, borderRadius:10, background:C.card, outline:"none", color:C.ink };
const rowBtn = (idx) => ({ width:"100%", display:"flex", alignItems:"center", gap:12, padding:"13px 14px", border:"none", borderTop: idx===0?"none":"1px solid "+C.line, background:"transparent", textAlign:"left", cursor:"pointer" });
const box = (on) => ({ width:22, height:22, flexShrink:0, borderRadius:6, border:"2px solid "+(on?C.fairway:C.line), background:on?C.fairway:"transparent", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, fontWeight:800 });
const linkBtn = (col) => ({ border:"none", background:"transparent", color:col, fontSize:13, textDecoration:"underline", cursor:"pointer", padding:0 });
const pill = (on) => ({ flex:1, height:34, borderRadius:9, border:"1px solid "+(on?C.fairway:C.line), background:on?C.fairway:C.card, color:on?"#fff":C.ink, fontWeight:600, fontSize:12.5, cursor:"pointer" });

function Stepper({ value, set, step=1, min=0, max=99 }) {
  return (
    <div style={{ display:"flex", alignItems:"center", border:"1px solid "+C.line, borderRadius:10, background:C.card }}>
      <button onClick={() => set(Math.max(min, +(value - step).toFixed(2)))} style={btnStep}>{"−"}</button>
      <div style={{ flex:1, textAlign:"center", fontSize:16, fontWeight:700 }}>{value}</div>
      <button onClick={() => set(Math.min(max, +(value + step).toFixed(2)))} style={btnStep}>+</button>
    </div>
  );
}
function Field({ label, children }) {
  return (<div style={{ flex:1 }}><div style={{ fontSize:10.5, color:C.muted, marginBottom:4, textAlign:"center" }}>{label}</div>{children}</div>);
}

function ItemEditor({ sid, item, nights, R, trip, updItem, updQty, delItem, close }) {
  const q = item.qty;
  const modeOf = !q ? "none" : q.mode === "fixed" ? "fixed" : "rule";
  const setQMode = (m) => {
    if (m === "none") updQty(sid, item.id, null);
    else if (m === "fixed") updQty(sid, item.id, { mode:"fixed", value: q && q.mode==="fixed" ? q.value : 1 });
    else updQty(sid, item.id, { mode:"formula", n: q&&q.mode==="formula"?q.n:0, r: q&&q.mode==="formula"?q.r:0, c: q&&q.mode==="formula"?q.c:1, floor: q&&q.mode==="formula"?q.floor:1 });
  };
  const setF = (patch) => updQty(sid, item.id, { ...q, ...patch });
  const preview = compute(q, nights, R);
  const scope = item.scope || "all";
  return (
    <div style={{ padding:"4px 14px 16px", background:"#fbfbf8" }}>
      <div style={lblStyle}>Name</div>
      <input value={item.name} onChange={(e) => updItem(sid, item.id, { name: e.target.value })} style={textInput} />
      <div style={lblStyle}>Note (optional)</div>
      <input value={item.hint || ""} onChange={(e) => updItem(sid, item.id, { hint: e.target.value })} placeholder="e.g. wear on travel day" style={textInput} />
      <div style={lblStyle}>Show on</div>
      <div style={{ display:"flex", gap:6 }}>
        {[["all","Both"],["golf","Golf"],["vac","Vacation"],["beach","Beach"]].map(([k,l]) => (
          <button key={k} onClick={() => updItem(sid, item.id, { scope: k })} style={pill(scope === k)}>{l}</button>
        ))}
      </div>
      <div style={{ fontSize:11, letterSpacing:1, textTransform:"uppercase", color:C.muted, margin:"14px 0 6px" }}>Quantity</div>
      <div style={{ display:"flex", gap:6, marginBottom:10 }}>
        {[["none","None"],["fixed","Fixed"],["rule","Rule"]].map(([k,l]) => (
          <button key={k} onClick={() => setQMode(k)} style={pill(modeOf === k)}>{l}</button>
        ))}
      </div>
      {modeOf === "fixed" && <div style={{ width:120 }}><Stepper value={q.value} set={(v) => setF({ value: v })} min={0} max={99} /></div>}
      {modeOf === "rule" && (
        <div>
          <div style={{ display:"flex", gap:8 }}>
            <Field label={"× nights"}><Stepper value={q.n} set={(v) => setF({ n: v })} step={1} min={0} max={9} /></Field>
            <Field label={"× rounds"}><Stepper value={q.r} set={(v) => setF({ r: v })} step={0.5} min={0} max={9} /></Field>
            <Field label="+ flat"><Stepper value={q.c} set={(v) => setF({ c: v })} step={1} min={-9} max={20} /></Field>
            <Field label="min"><Stepper value={q.floor} set={(v) => setF({ floor: v })} step={1} min={0} max={20} /></Field>
          </div>
          <div style={{ marginTop:8, fontSize:12.5, color:C.fairwayDk, background:"#eef5f0", borderRadius:8, padding:"7px 10px" }}>
            {q.n}{"×nights"} + {q.r}{"×rounds"} + {q.c}  {"→"}  <b>{preview}</b> {trip === "golf" ? "(this trip)" : "(vacation, rounds=0)"}
          </div>
        </div>
      )}
      <button onClick={() => { delItem(sid, item.id); close(); }} style={{ marginTop:14, border:"none", background:"transparent", color:C.danger, fontSize:13, fontWeight:600, cursor:"pointer", padding:0 }}>Delete item</button>
    </div>
  );
}

// ---- Trip helpers ----
function nightsFromDates(s, e) { if (!s || !e) return null; const ms = new Date(e) - new Date(s); if (isNaN(ms) || ms < 0) return null; return Math.round(ms / 86400000); }
function fmtDate(d) { if (!d) return ""; try { return new Date(d).toLocaleDateString(undefined, { day:"numeric", month:"short" }); } catch (e) { return d; } }
const tripIcon = (type) => (type === "vacation" ? "🏖️" : "⛳");
function tripProgress(trip) {
  const secs = (trip.inventory && trip.inventory.sections) || [];
  const ids = secs.flatMap((s) => s.items.filter((i) => itemVisible(i, trip.type, trip.beach, "pack")).map((i) => i.id));
  return { packed: ids.filter((id) => (trip.checked || {})[id]).length, total: ids.length };
}

// First-run migration of the single-list (Phase 1) layout into the multi-trip (v5) shape.
async function migrateToV5(appTemplate) {
  const getJson = async (k) => { try { const r = await store.get(k); return r && r.value ? JSON.parse(r.value) : null; } catch (e) { return null; } };
  const tpl = await getJson("packing:v4:tpl");
  const settings = await getJson("packing:v2:settings");
  const checked = await getJson("packing:v4:checked");
  const userdef = await getJson("packing:v4:userdef");
  const profileDefault = userdef || tpl || (appTemplate ? JSON.parse(JSON.stringify(appTemplate)) : makeDefaults());
  const trips = [];
  if (tpl) {
    trips.push({ id: uid("t"), name: "My trip", type: (settings && settings.trip) || "golf",
      startDate: "", endDate: "", nights: (settings && settings.nights) || 3, rounds: (settings && settings.rounds) || 4,
      beach: !!(settings && settings.beach), notes: "", inventory: tpl, checked: checked || {}, createdAt: 0 });
  }
  return { v: 5, profileDefault, trips };
}

// ---- Reusable section/item list (pack + edit), operating on one template ----
function PackList({ tpl, setTpl, mode, trip, nights, rounds, beach, checked, setChecked, expanded, setExpanded }) {
  const R = trip === "golf" ? rounds : 0;
  const mutate = (fn) => setTpl((prev) => { const next = JSON.parse(JSON.stringify(prev)); fn(next); return next; });
  const findSec = (t, sid) => t.sections.find((s) => s.id === sid);
  const updItem = (sid, iid, patch) => mutate((t) => Object.assign(findSec(t, sid).items.find((i) => i.id === iid), patch));
  const updQty = (sid, iid, qty) => mutate((t) => { findSec(t, sid).items.find((i) => i.id === iid).qty = qty; });
  const delItem = (sid, iid) => mutate((t) => { const s = findSec(t, sid); s.items = s.items.filter((i) => i.id !== iid); });
  const addItem = (sid) => { const id = uid("n"); mutate((t) => { const s = findSec(t, sid); const sc = (s.items[0] && s.items[0].scope) || "all"; s.items.push({ id, name:"New item", scope: sc, qty: null }); }); setExpanded(id); };
  const updSec = (sid, patch) => mutate((t) => Object.assign(findSec(t, sid), patch));
  const delSec = (sid) => mutate((t) => { t.sections = t.sections.filter((s) => s.id !== sid); });
  const addSec = () => mutate((t) => t.sections.push({ id: uid("s"), title:"New section", items: [] }));
  const toggle = (id) => setChecked((c) => ({ ...c, [id]: !c[id] }));

  const sectionsView = tpl.sections.map((s) => ({ ...s, vis: s.items.filter((i) => itemVisible(i, trip, beach, mode)) })).filter((s) => s.vis.length > 0);

  return (
    <>
      {sectionsView.map((sec) => (
        <div key={sec.id} style={{ marginBottom:20 }}>
          {mode === "edit" ? (
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
              <input value={sec.title} onChange={(e) => updSec(sec.id, { title: e.target.value })} style={{ flex:1, fontSize:13, fontWeight:700, color:C.fairwayDk, textTransform:"uppercase", letterSpacing:1, border:"none", borderBottom:"1px solid "+C.line, background:"transparent", padding:"4px 0", outline:"none" }} />
              <button onClick={() => delSec(sec.id)} style={{ border:"none", background:"transparent", color:C.danger, fontSize:18, cursor:"pointer", lineHeight:1 }}>{"✕"}</button>
            </div>
          ) : (
            <div style={{ fontSize:12, letterSpacing:1.5, textTransform:"uppercase", color:C.fairwayDk, fontWeight:700, marginBottom:8 }}>{sec.title}</div>
          )}
          {sec.note && mode === "pack" && <div style={{ fontSize:12.5, color:C.muted, marginBottom:8, lineHeight:1.4 }}>{sec.note}</div>}

          <div style={{ background:C.card, border:"1px solid "+C.line, borderRadius:14, overflow:"hidden" }}>
            {sec.vis.map((it, idx) => {
              const on = !!checked[it.id]; const isOpen = expanded === it.id;
              if (mode === "pack") {
                return (
                  <button key={it.id} onClick={() => toggle(it.id)} style={rowBtn(idx)}>
                    <span style={box(on)}>{on?"✓":""}</span>
                    <span style={{ flex:1 }}>
                      <span style={{ fontSize:15.5, color:on?C.muted:C.ink, textDecoration:on?"line-through":"none" }}>{labelFor(it, nights, R)}</span>
                      {it.hint && <span style={{ display:"block", fontSize:12, color:C.muted, marginTop:1 }}>{it.hint}</span>}
                    </span>
                  </button>
                );
              }
              return (
                <div key={it.id} style={{ borderTop: idx===0?"none":"1px solid "+C.line }}>
                  <button onClick={() => setExpanded(isOpen ? null : it.id)} style={{ ...rowBtn(0), borderTop:"none" }}>
                    <span style={{ flex:1, fontSize:15.5 }}>{labelFor(it, nights, R)}</span>
                    <span style={{ fontSize:11, color:C.muted, border:"1px solid "+C.line, borderRadius:6, padding:"2px 6px", marginRight:8 }}>{it.scope==="all"?"Both":it.scope==="vac"?"Vacation":it.scope==="beach"?"Beach":"Golf"}</span>
                    <span style={{ color:C.muted, fontSize:13 }}>{isOpen?"▲":"▾"}</span>
                  </button>
                  {isOpen && <ItemEditor sid={sec.id} item={it} nights={nights} R={R} trip={trip} updItem={updItem} updQty={updQty} delItem={delItem} close={() => setExpanded(null)} />}
                </div>
              );
            })}
            {mode === "edit" && (
              <button onClick={() => addItem(sec.id)} style={{ ...rowBtn(sec.vis.length?1:0), color:C.fairway, fontWeight:700, fontSize:14.5 }}>
                <span style={{ ...box(false), borderStyle:"dashed", color:C.fairway }}>+</span>Add item
              </button>
            )}
          </div>
        </div>
      ))}
      {mode === "edit" && <button onClick={addSec} style={{ width:"100%", height:46, borderRadius:12, border:"1px dashed "+C.line, background:C.card, color:C.fairway, fontWeight:700, fontSize:15, cursor:"pointer", marginTop:4 }}>+ Add section</button>}
    </>
  );
}

function Shell({ children }) {
  return (
    <div style={{ minHeight:"100vh", background:C.paper, color:C.ink, fontFamily:"ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <div style={{ maxWidth:560, margin:"0 auto", padding:"20px 16px 72px" }}>{children}</div>
    </div>
  );
}

function Home({ user, isAdmin, onSignOut, trips, onOpen, onNew, onEditDefault, onDelete, onAdmin }) {
  return (
    <Shell>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16, fontSize:12.5, color:C.muted }}>
        <span style={{ display:"flex", alignItems:"center", gap:7, minWidth:0 }}>
          {user && user.picture && <img src={user.picture} alt="" width={20} height={20} style={{ borderRadius:"50%" }} referrerPolicy="no-referrer" />}
          <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{(user && (user.name || user.email)) || ""}{isAdmin ? " · admin" : ""}</span>
        </span>
        <button onClick={onSignOut} style={linkBtn(C.muted)}>Sign out</button>
      </div>
      <h1 style={{ fontSize:24, fontWeight:800, letterSpacing:-0.5, margin:"0 0 14px" }}>Trips</h1>
      <button onClick={onNew} style={{ width:"100%", height:48, borderRadius:12, border:"none", background:C.fairway, color:"#fff", fontWeight:700, fontSize:15.5, cursor:"pointer", marginBottom:16 }}>+ New trip</button>
      {trips.length === 0 ? (
        <div style={{ textAlign:"center", color:C.muted, fontSize:14, padding:"30px 10px", lineHeight:1.5 }}>No trips yet.<br />Tap <b>+ New trip</b> to plan your first one.</div>
      ) : (
        trips.map((t) => {
          const p = tripProgress(t);
          const dates = t.startDate && t.endDate ? fmtDate(t.startDate)+" – "+fmtDate(t.endDate) : (t.nights ? t.nights+" nights" : "");
          const meta = [dates, t.type==="golf" ? ((t.rounds||0)+" rounds") : (t.beach ? "beach" : "")].filter(Boolean).join(" · ");
          return (
            <div key={t.id} style={{ display:"flex", alignItems:"center", gap:6, background:C.card, border:"1px solid "+C.line, borderRadius:14, padding:"10px 12px", marginBottom:10 }}>
              <button onClick={() => onOpen(t.id)} style={{ flex:1, display:"flex", alignItems:"center", gap:12, border:"none", background:"transparent", textAlign:"left", cursor:"pointer", minWidth:0 }}>
                <span style={{ fontSize:24 }}>{tripIcon(t.type)}</span>
                <span style={{ flex:1, minWidth:0 }}>
                  <span style={{ display:"block", fontSize:16, fontWeight:700, color:C.ink, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{t.name || (t.type==="golf"?"Golf trip":"Vacation")}</span>
                  <span style={{ display:"block", fontSize:12.5, color:C.muted, marginTop:1 }}>{meta}</span>
                </span>
                <span style={{ fontSize:12, color:C.muted, fontWeight:600 }}>{p.packed}/{p.total}</span>
              </button>
              <button onClick={() => onDelete(t.id)} title="Delete trip" style={{ border:"none", background:"transparent", color:C.muted, fontSize:17, cursor:"pointer", lineHeight:1, padding:"4px 6px" }}>{"✕"}</button>
            </div>
          );
        })
      )}
      <div style={{ marginTop:18, textAlign:"center", display:"flex", flexDirection:"column", gap:12 }}>
        <button onClick={onEditDefault} style={linkBtn(C.muted)}>Edit my default packing list</button>
        {onAdmin && <button onClick={onAdmin} style={linkBtn(C.fairwayDk)}>Admin · members &amp; global default</button>}
      </div>
    </Shell>
  );
}

function NewTripForm({ defaultProfile, onCreate, onCancel }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("golf");
  const [startDate, setStart] = useState("");
  const [endDate, setEnd] = useState("");
  const [rounds, setRounds] = useState(4);
  const [beach, setBeach] = useState(false);
  const [notes, setNotes] = useState("");
  const derived = nightsFromDates(startDate, endDate);
  const create = () => {
    onCreate({ id: uid("t"), name: name.trim(), type, startDate, endDate,
      nights: derived != null ? derived : 3, rounds, beach, notes: notes.trim(),
      inventory: JSON.parse(JSON.stringify(defaultProfile)), checked: {}, createdAt: 0 });
  };
  return (
    <Shell>
      <button onClick={onCancel} style={{ ...linkBtn(C.muted), marginBottom:14 }}>{"← Trips"}</button>
      <h1 style={{ fontSize:22, fontWeight:800, margin:"0 0 14px" }}>New trip</h1>
      <div style={lblStyle}>Trip name</div>
      <input value={name} onChange={(e)=>setName(e.target.value)} placeholder={type==="golf"?"e.g. Spain golf week":"e.g. Italy summer"} style={textInput} />
      <div style={lblStyle}>Type</div>
      <div style={{ display:"flex", gap:8 }}>
        {[["golf","⛳ Golf"],["vacation","🏖️ Vacation"]].map(([k,l]) => (
          <button key={k} onClick={()=>setType(k)} style={{ ...pill(type===k), height:44, fontSize:14 }}>{l}</button>
        ))}
      </div>
      <div style={{ display:"flex", gap:10 }}>
        <div style={{ flex:1 }}><div style={lblStyle}>Start</div><input type="date" value={startDate} onChange={(e)=>setStart(e.target.value)} style={textInput} /></div>
        <div style={{ flex:1 }}><div style={lblStyle}>End</div><input type="date" value={endDate} onChange={(e)=>setEnd(e.target.value)} style={textInput} /></div>
      </div>
      <div style={{ fontSize:12.5, color:C.muted, margin:"6px 2px 0" }}>{derived != null ? derived+" nights" : "Pick dates to set nights (defaults to 3)."}</div>
      {type==="golf" && <div style={{ marginTop:12 }}><div style={lblStyle}>Rounds</div><div style={{ width:140 }}><Stepper value={rounds} set={setRounds} min={0} max={30} /></div></div>}
      {type==="vacation" && <button onClick={()=>setBeach(b=>!b)} style={{ width:"100%", height:44, borderRadius:12, border:"1px solid "+(beach?C.sand:C.line), background:beach?"#faf3e0":C.card, color:C.ink, fontSize:14, fontWeight:600, cursor:"pointer", marginTop:12 }}>{beach?"✓ ":"+ "}Sun / beach add-on</button>}
      <div style={lblStyle}>Notes (optional)</div>
      <input value={notes} onChange={(e)=>setNotes(e.target.value)} placeholder="flight times, hotel, etc." style={textInput} />
      <button onClick={create} style={{ width:"100%", height:48, borderRadius:12, border:"none", background:C.fairway, color:"#fff", fontWeight:700, fontSize:15.5, cursor:"pointer", marginTop:20 }}>Create trip</button>
    </Shell>
  );
}

function TripView({ trip, onPatch, onSetInventory, onSetChecked, onBack, onSaveDefault }) {
  const [mode, setMode] = useState("pack");
  const [expanded, setExpanded] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const nights = trip.nights || 3;
  const p = tripProgress(trip);
  const pct = p.total ? Math.round((p.packed / p.total) * 100) : 0;
  const setDate = (patch) => { const next = { ...trip, ...patch }; const d = nightsFromDates(next.startDate, next.endDate); onPatch(d != null ? { ...patch, nights: d } : patch); };
  const saveDefault = () => { onSaveDefault(trip.inventory); setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1600); };

  return (
    <Shell>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
        <button onClick={onBack} style={linkBtn(C.muted)}>{"← Trips"}</button>
        <button onClick={() => { setMode(mode==="pack"?"edit":"pack"); setExpanded(null); }} style={{ height:36, padding:"0 16px", borderRadius:10, border:"1px solid "+(mode==="edit"?C.fairway:C.line), background: mode==="edit"?C.fairway:C.card, color: mode==="edit"?"#fff":C.ink, fontWeight:700, fontSize:14, cursor:"pointer" }}>{mode==="pack"?"Edit list":"Done"}</button>
      </div>

      {mode==="edit" ? (
        <input value={trip.name} onChange={(e)=>onPatch({ name:e.target.value })} placeholder="Trip name" style={{ ...textInput, fontSize:21, fontWeight:800, padding:"8px 10px", marginBottom:10 }} />
      ) : (
        <h1 style={{ fontSize:23, fontWeight:800, letterSpacing:-0.5, margin:"0 0 4px" }}>{trip.name || (trip.type==="golf"?"Golf trip":"Vacation")} <span style={{ fontSize:20 }}>{tripIcon(trip.type)}</span></h1>
      )}

      {mode==="pack" && (<>
        <div style={{ fontSize:12, color:C.muted, marginBottom:6 }}>{p.packed}/{p.total} packed{trip.startDate && trip.endDate ? " · "+fmtDate(trip.startDate)+" – "+fmtDate(trip.endDate) : ""}{trip.notes ? " · "+trip.notes : ""}</div>
        <div style={{ height:6, background:C.line, borderRadius:99, overflow:"hidden", marginBottom:18 }}><div style={{ width:pct+"%", height:"100%", background:C.fairway, transition:"width 200ms" }} /></div>
      </>)}

      <div style={{ display:"flex", gap:8, marginBottom:12 }}>
        {[["golf","Golf"],["vacation","Vacation"]].map(([k,l]) => (
          <button key={k} onClick={()=>{ onPatch({ type:k }); setExpanded(null); }} style={{ flex:1, height:42, borderRadius:12, border:"1px solid "+(trip.type===k?C.fairway:C.line), background:trip.type===k?C.fairway:C.card, color:trip.type===k?"#fff":C.ink, fontSize:14.5, fontWeight:700, cursor:"pointer" }}>{l}</button>
        ))}
      </div>

      {mode==="edit" && (
        <div style={{ display:"flex", gap:10, marginBottom:10 }}>
          <div style={{ flex:1 }}><div style={lblStyle}>Start</div><input type="date" value={trip.startDate||""} onChange={(e)=>setDate({ startDate:e.target.value })} style={textInput} /></div>
          <div style={{ flex:1 }}><div style={lblStyle}>End</div><input type="date" value={trip.endDate||""} onChange={(e)=>setDate({ endDate:e.target.value })} style={textInput} /></div>
        </div>
      )}

      <div style={{ display:"flex", gap:10, marginBottom:10 }}>
        <div style={{ flex:1 }}><div style={lblStyle}>Nights</div><Stepper value={nights} set={(v)=>onPatch({ nights:v })} min={1} max={60} /></div>
        {trip.type==="golf" && <div style={{ flex:1 }}><div style={lblStyle}>Rounds</div><Stepper value={trip.rounds||0} set={(v)=>onPatch({ rounds:v })} min={0} max={30} /></div>}
      </div>
      {trip.type==="vacation" && <button onClick={()=>onPatch({ beach: !trip.beach })} style={{ width:"100%", height:42, borderRadius:12, border:"1px solid "+(trip.beach?C.sand:C.line), background: trip.beach?"#faf3e0":C.card, color:C.ink, fontSize:14, fontWeight:600, cursor:"pointer", marginBottom:6 }}>{trip.beach?"✓ ":"+ "}Sun / beach add-on</button>}

      {mode==="edit" ? (
        <div style={{ background:C.card, border:"1px solid "+C.line, borderRadius:12, padding:12, margin:"12px 0 18px" }}>
          <button onClick={saveDefault} style={{ width:"100%", height:42, borderRadius:10, border:"none", background: savedFlash?C.fairwayDk:C.fairway, color:"#fff", fontWeight:700, fontSize:14.5, cursor:"pointer" }}>{savedFlash?"✓ Saved as your default":"Save this list as my default"}</button>
          <div style={{ fontSize:12, color:C.muted, marginTop:8, lineHeight:1.4 }}>Editing changes <b>this trip only</b>. Save as default to reuse it for future trips.</div>
        </div>
      ) : (
        <div style={{ display:"flex", justifyContent:"flex-end", margin:"12px 0 18px" }}>
          <button onClick={()=>onSetChecked({})} style={linkBtn(C.muted)}>Reset ticks</button>
        </div>
      )}

      <PackList tpl={trip.inventory} setTpl={onSetInventory} mode={mode} trip={trip.type} nights={nights} rounds={trip.rounds||0} beach={trip.beach} checked={trip.checked||{}} setChecked={onSetChecked} expanded={expanded} setExpanded={setExpanded} />

      {mode==="pack" && <div style={{ textAlign:"center", fontSize:11.5, color:C.muted, marginTop:8 }}>Tap <b>Edit list</b> to change items, tags, or quantity rules for this trip.</div>}
    </Shell>
  );
}

function DefaultEditor({ profile, setProfile, onBack }) {
  const [scope, setScope] = useState("golf");
  const [expanded, setExpanded] = useState(null);
  const [nights, setNights] = useState(3);
  const [rounds, setRounds] = useState(4);
  return (
    <Shell>
      <button onClick={onBack} style={{ ...linkBtn(C.muted), marginBottom:12 }}>{"← Trips"}</button>
      <h1 style={{ fontSize:22, fontWeight:800, margin:"0 0 4px" }}>Default packing list</h1>
      <p style={{ fontSize:13, color:C.muted, lineHeight:1.45, margin:"0 0 14px" }}>New trips start from this list. Items are tagged <b>Both / Golf / Vacation / Beach</b>; switch the view to edit each scope. Quantity previews use the sample nights/rounds below.</p>
      <div style={{ display:"flex", gap:8, marginBottom:10 }}>
        {[["golf","Golf view"],["vacation","Vacation view"]].map(([k,l]) => (
          <button key={k} onClick={()=>{ setScope(k); setExpanded(null); }} style={{ flex:1, height:42, borderRadius:12, border:"1px solid "+(scope===k?C.fairway:C.line), background:scope===k?C.fairway:C.card, color:scope===k?"#fff":C.ink, fontSize:14, fontWeight:700, cursor:"pointer" }}>{l}</button>
        ))}
      </div>
      <div style={{ display:"flex", gap:10, marginBottom:16 }}>
        <div style={{ flex:1 }}><div style={lblStyle}>Sample nights</div><Stepper value={nights} set={setNights} min={1} max={60} /></div>
        {scope==="golf" && <div style={{ flex:1 }}><div style={lblStyle}>Sample rounds</div><Stepper value={rounds} set={setRounds} min={0} max={30} /></div>}
      </div>
      <PackList tpl={profile} setTpl={setProfile} mode="edit" trip={scope} nights={nights} rounds={rounds} beach={true} checked={{}} setChecked={()=>{}} expanded={expanded} setExpanded={setExpanded} />
    </Shell>
  );
}

function AdminPanel({ cfg, onSave, onBack }) {
  const [tab, setTab] = useState("members");
  const [admins, setAdmins] = useState(() => ((cfg && cfg.admins) || []).slice());
  const [allowed, setAllowed] = useState(() => ((cfg && cfg.allowed) || []).slice());
  const [template, setTemplate] = useState(() => (cfg && cfg.template) ? JSON.parse(JSON.stringify(cfg.template)) : makeDefaults());
  const [newEmail, setNewEmail] = useState("");
  const [scope, setScope] = useState("golf");
  const [expanded, setExpanded] = useState(null);
  const [nights, setNights] = useState(3);
  const [rounds, setRounds] = useState(4);
  const [flash, setFlash] = useState("");

  const addEmail = () => {
    const e = lc(newEmail.trim());
    if (!e || !e.includes("@")) return;
    if (!allowed.map(lc).includes(e) && !ADMIN_EMAILS.includes(e)) setAllowed([...allowed, e]);
    setNewEmail("");
  };
  const removeEmail = (e) => { setAllowed(allowed.filter((x) => lc(x) !== lc(e))); setAdmins(admins.filter((x) => lc(x) !== lc(e))); };
  const toggleAdmin = (e) => { const le = lc(e); setAdmins(admins.map(lc).includes(le) ? admins.filter((x) => lc(x) !== le) : [...admins, e]); };
  const save = async () => { await onSave({ template, admins, allowed }); setFlash("✓ Saved"); setTimeout(() => setFlash(""), 1600); };

  const rows = [
    ...ADMIN_EMAILS.map((e) => ({ email: e, admin: true, root: true })),
    ...allowed.filter((e) => !ADMIN_EMAILS.includes(lc(e))).map((e) => ({ email: e, admin: admins.map(lc).includes(lc(e)), root: false })),
  ];

  return (
    <Shell>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
        <button onClick={onBack} style={linkBtn(C.muted)}>{"← Trips"}</button>
        <button onClick={save} style={{ height:36, padding:"0 16px", borderRadius:10, border:"none", background: flash?C.fairwayDk:C.fairway, color:"#fff", fontWeight:700, fontSize:14, cursor:"pointer" }}>{flash || "Save"}</button>
      </div>
      <h1 style={{ fontSize:22, fontWeight:800, margin:"0 0 12px" }}>Admin</h1>
      <div style={{ display:"flex", gap:8, marginBottom:16 }}>
        {[["members","Members"],["list","Default list"]].map(([k,l]) => (
          <button key={k} onClick={()=>setTab(k)} style={{ ...pill(tab===k), height:40, fontSize:13.5 }}>{l}</button>
        ))}
      </div>

      {tab==="members" && (
        <div>
          <p style={{ fontSize:13, color:C.muted, lineHeight:1.45, margin:"0 0 12px" }}>Invite people by their Google account email. Admins can edit this panel. <b>Save</b> to apply.</p>
          <div style={{ display:"flex", gap:8, marginBottom:14 }}>
            <input value={newEmail} onChange={(e)=>setNewEmail(e.target.value)} onKeyDown={(e)=>{ if (e.key==="Enter") addEmail(); }} placeholder="name@gmail.com" style={{ ...textInput, flex:1 }} />
            <button onClick={addEmail} style={{ height:42, padding:"0 16px", borderRadius:10, border:"none", background:C.fairway, color:"#fff", fontWeight:700, fontSize:14, cursor:"pointer" }}>Add</button>
          </div>
          <div style={{ background:C.card, border:"1px solid "+C.line, borderRadius:14, overflow:"hidden" }}>
            {rows.map((m, idx) => (
              <div key={m.email} style={{ display:"flex", alignItems:"center", gap:10, padding:"11px 14px", borderTop: idx===0?"none":"1px solid "+C.line }}>
                <span style={{ flex:1, minWidth:0, fontSize:14, color:C.ink, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{m.email}{m.root && <span style={{ color:C.muted, fontSize:12 }}> · owner</span>}</span>
                <button disabled={m.root} onClick={()=>toggleAdmin(m.email)} style={{ border:"1px solid "+(m.admin?C.fairway:C.line), background:m.admin?C.fairway:C.card, color:m.admin?"#fff":C.muted, borderRadius:8, padding:"4px 9px", fontSize:12, fontWeight:600, cursor:m.root?"default":"pointer", opacity:m.root?0.6:1 }}>admin</button>
                {!m.root && <button onClick={()=>removeEmail(m.email)} title="Remove" style={{ border:"none", background:"transparent", color:C.danger, fontSize:16, cursor:"pointer", lineHeight:1 }}>{"✕"}</button>}
              </div>
            ))}
          </div>
          <p style={{ fontSize:11.5, color:C.muted, marginTop:10, lineHeight:1.4 }}>Access is enforced in-app (trust-based — see DESIGN.md). The owner can't be removed.</p>
        </div>
      )}

      {tab==="list" && (
        <div>
          <p style={{ fontSize:13, color:C.muted, lineHeight:1.45, margin:"0 0 12px" }}>The starting list for <b>new members</b>. Existing members keep their own. Switch view to edit each scope; <b>Save</b> to apply.</p>
          <div style={{ display:"flex", gap:8, marginBottom:10 }}>
            {[["golf","Golf view"],["vacation","Vacation view"]].map(([k,l]) => (
              <button key={k} onClick={()=>{ setScope(k); setExpanded(null); }} style={{ flex:1, height:42, borderRadius:12, border:"1px solid "+(scope===k?C.fairway:C.line), background:scope===k?C.fairway:C.card, color:scope===k?"#fff":C.ink, fontSize:14, fontWeight:700, cursor:"pointer" }}>{l}</button>
            ))}
          </div>
          <div style={{ display:"flex", gap:10, marginBottom:16 }}>
            <div style={{ flex:1 }}><div style={lblStyle}>Sample nights</div><Stepper value={nights} set={setNights} min={1} max={60} /></div>
            {scope==="golf" && <div style={{ flex:1 }}><div style={lblStyle}>Sample rounds</div><Stepper value={rounds} set={setRounds} min={0} max={30} /></div>}
          </div>
          <PackList tpl={template} setTpl={setTemplate} mode="edit" trip={scope} nights={nights} rounds={rounds} beach={true} checked={{}} setChecked={()=>{}} expanded={expanded} setExpanded={setExpanded} />
        </div>
      )}
    </Shell>
  );
}

function PackingAppV2({ user, isAdmin, cfg, onCfgChange, onSignOut }) {
  const [data, setData] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState({ name: "home" });

  useEffect(() => { (async () => {
    let d = null;
    try { const r = await store.get("v5"); if (r && r.value) d = JSON.parse(r.value); } catch (e) {}
    if (!d) d = await migrateToV5(cfg && cfg.template);
    setData(d); setLoaded(true);
  })();
  // cfg is already loaded before this view mounts; load the user's data once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (loaded && data) store.set("v5", JSON.stringify(data)); }, [data, loaded]);

  const updateTrip = (id, patch) => setData((d) => ({ ...d, trips: d.trips.map((t) => t.id===id ? { ...t, ...patch } : t) }));
  const setTripInventory = (id, u) => setData((d) => ({ ...d, trips: d.trips.map((t) => t.id===id ? { ...t, inventory: typeof u==="function" ? u(t.inventory) : u } : t) }));
  const setTripChecked = (id, u) => setData((d) => ({ ...d, trips: d.trips.map((t) => t.id===id ? { ...t, checked: typeof u==="function" ? u(t.checked||{}) : u } : t) }));
  const addTrip = (trip) => { setData((d) => ({ ...d, trips: [trip, ...d.trips] })); setView({ name:"trip", id: trip.id }); };
  const deleteTrip = (id) => { if (typeof window !== "undefined" && !window.confirm("Delete this trip?")) return; setData((d) => ({ ...d, trips: d.trips.filter((t) => t.id!==id) })); setView({ name:"home" }); };
  const setProfile = (u) => setData((d) => ({ ...d, profileDefault: typeof u==="function" ? u(d.profileDefault) : u }));
  const saveAsDefault = (inv) => setData((d) => ({ ...d, profileDefault: JSON.parse(JSON.stringify(inv)) }));
  const saveConfig = async (next) => { await saveAppConfig(next); if (onCfgChange) onCfgChange(next); };

  if (!loaded || !data) return <Splash text={"Loading your trips…"} />;
  if (view.name === "admin") return <AdminPanel cfg={cfg} onSave={saveConfig} onBack={()=>setView({ name:"home" })} />;
  if (view.name === "new") return <NewTripForm defaultProfile={data.profileDefault} onCreate={addTrip} onCancel={()=>setView({ name:"home" })} />;
  if (view.name === "default") return <DefaultEditor profile={data.profileDefault} setProfile={setProfile} onBack={()=>setView({ name:"home" })} />;
  if (view.name === "trip") {
    const trip = data.trips.find((t) => t.id === view.id);
    if (!trip) return <Home user={user} isAdmin={isAdmin} onSignOut={onSignOut} trips={data.trips} onOpen={(id)=>setView({ name:"trip", id })} onNew={()=>setView({ name:"new" })} onEditDefault={()=>setView({ name:"default" })} onDelete={deleteTrip} onAdmin={isAdmin ? ()=>setView({ name:"admin" }) : null} />;
    return <TripView trip={trip} onPatch={(p)=>updateTrip(trip.id, p)} onSetInventory={(u)=>setTripInventory(trip.id, u)} onSetChecked={(u)=>setTripChecked(trip.id, u)} onBack={()=>setView({ name:"home" })} onSaveDefault={saveAsDefault} />;
  }
  return <Home user={user} isAdmin={isAdmin} onSignOut={onSignOut} trips={data.trips} onOpen={(id)=>setView({ name:"trip", id })} onNew={()=>setView({ name:"new" })} onEditDefault={()=>setView({ name:"default" })} onDelete={deleteTrip} onAdmin={isAdmin ? ()=>setView({ name:"admin" }) : null} />;
}

function LoginScreen({ error }) {
  return (
    <div style={{ minHeight:"100vh", background:C.paper, color:C.ink, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <div style={{ width:"100%", maxWidth:360, padding:"24px 20px", textAlign:"center" }}>
        <div style={{ fontSize:42, marginBottom:6 }}>{"🧳"}</div>
        <h1 style={{ fontSize:26, fontWeight:800, letterSpacing:-0.5, margin:"0 0 6px" }}>Packing</h1>
        <p style={{ fontSize:14, color:C.muted, lineHeight:1.5, margin:"0 0 22px" }}>Sign in to plan trips and sync your lists across every device.</p>
        <div id="gbtn" style={{ display:"flex", justifyContent:"center", minHeight:44 }} />
        {error && <p style={{ fontSize:12.5, color:C.danger, marginTop:16, lineHeight:1.4 }}>{error}</p>}
      </div>
    </div>
  );
}

function Splash({ text }) {
  return <div style={{ minHeight:"100vh", background:C.paper, color:C.muted, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"ui-sans-serif, system-ui, sans-serif", fontSize:14 }}>{text}</div>;
}

function NotInvited({ email, onSignOut }) {
  return (
    <div style={{ minHeight:"100vh", background:C.paper, color:C.ink, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <div style={{ width:"100%", maxWidth:360, padding:"24px 20px", textAlign:"center" }}>
        <div style={{ fontSize:40, marginBottom:8 }}>{"🔒"}</div>
        <h1 style={{ fontSize:22, fontWeight:800, margin:"0 0 6px" }}>You're not on the list</h1>
        <p style={{ fontSize:14, color:C.muted, lineHeight:1.5, margin:"0 0 20px" }}><b>{email}</b> hasn't been invited yet. Ask the owner to add you, then sign in again.</p>
        <button onClick={onSignOut} style={{ height:40, padding:"0 18px", borderRadius:10, border:"1px solid "+C.line, background:C.card, color:C.ink, fontWeight:600, fontSize:14, cursor:"pointer" }}>Use a different account</button>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(cachedIdentity);
  const [cfg, setCfg] = useState(null);
  const [ready, setReady] = useState(false);
  const [authMsg, setAuthMsg] = useState("");

  // Load app config + the signed-in user's data before showing the app.
  useEffect(() => {
    if (!user) { setReady(false); setCfg(null); return; }
    let alive = true;
    (async () => {
      const c = await loadAppConfig();
      if (!alive) return;
      setCfg(c);
      if (resolveIsAllowed(user.email, c)) await initUser(user.email, lc(user.email) === OWNER_EMAIL);
      if (alive) setReady(true);
    })();
    return () => { alive = false; };
  }, [user]);

  // Wire up Google sign-in while logged out.
  useEffect(() => {
    if (user) return;
    let cancelled = false;
    (async () => {
      if (!GOOGLE_CLIENT_ID) { setAuthMsg("Sign-in isn't configured yet — add a Google client ID (VITE_GOOGLE_CLIENT_ID)."); return; }
      try {
        await loadGis();
        if (cancelled || !(window.google && window.google.accounts)) return;
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (resp) => {
            const c = decodeJwt(resp.credential);
            if (c && c.email) { const u = { email: c.email, name: c.name, picture: c.picture }; cacheIdentity(u); setUser(u); }
          },
        });
        const el = document.getElementById("gbtn");
        if (el) window.google.accounts.id.renderButton(el, { theme: "filled_blue", size: "large", text: "signin_with", shape: "pill" });
        window.google.accounts.id.prompt();
      } catch (e) { setAuthMsg("Couldn't load Google sign-in. Check your connection and try again."); }
    })();
    return () => { cancelled = true; };
  }, [user]);

  const signOut = () => {
    teardownUser(); cacheIdentity(null);
    try { if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect(); } catch (e) {}
    setUser(null); setReady(false); setCfg(null);
  };

  if (!user) return <LoginScreen error={authMsg} />;
  if (!ready) return <Splash text={"Loading…"} />;
  if (!resolveIsAllowed(user.email, cfg)) return <NotInvited email={user.email} onSignOut={signOut} />;
  return <PackingAppV2 user={user} isAdmin={resolveIsAdmin(user.email, cfg)} cfg={cfg} onCfgChange={setCfg} onSignOut={signOut} />;
}
