import { useState, useEffect } from "react";

// Storage adapter: syncs all state through one Make.com webhook (data-store record "shared").
// Every logical key is held in a single JSON map; localStorage mirrors it for offline reads.
// Override the endpoint with VITE_SYNC_URL at build time if the webhook ever changes.
const SYNC_URL = import.meta.env.VITE_SYNC_URL || "https://hook.eu1.make.com/9sj1gxhjebty57hamg2a9elteipdqbvb";
const LS_MIRROR = "packing:v4:all";
const LEGACY_KEYS = ["packing:v4:tpl", "packing:v2:settings", "packing:v4:checked", "packing:v4:userdef"];

let cache = null;        // { [key]: valueString }
let cacheReady = false;  // cache has been initialised (remote or local)
let remoteOK = false;    // last remote load succeeded -> safe to push (never clobber on failure)
let syncTimer = null;

function readLocalMirror() {
  try { const m = localStorage.getItem(LS_MIRROR); if (m) return JSON.parse(m); } catch (e) {}
  const legacy = {}; // migrate from the pre-sync per-key layout if present
  for (const k of LEGACY_KEYS) { try { const v = localStorage.getItem(k); if (v != null) legacy[k] = v; } catch (e) {} }
  return legacy;
}
function writeLocalMirror() { try { localStorage.setItem(LS_MIRROR, JSON.stringify(cache || {})); } catch (e) {} }

async function ensureLoaded() {
  if (cacheReady) return cache;
  cache = readLocalMirror(); // instant/offline seed
  if (SYNC_URL) {
    try {
      const res = await fetch(SYNC_URL + "?api=get");
      if (res.ok) {
        const txt = await res.text();
        let remote = null; try { remote = txt ? JSON.parse(txt) : {}; } catch (e) { remote = {}; } // "Accepted"/empty -> {}
        if (remote && typeof remote === "object") {
          if (Object.keys(remote).length > 0) cache = remote; // remote wins when it has data; else keep local for migration
          remoteOK = true;
          writeLocalMirror();
        }
      }
    } catch (e) { /* offline: keep local mirror, stay read-only to remote */ }
  }
  cacheReady = true;
  return cache;
}

function pushNow() {
  syncTimer = null;
  if (!SYNC_URL || !remoteOK) return;
  try {
    fetch(SYNC_URL + "?api=set", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, // CORS-simple: no preflight
      body: "value=" + encodeURIComponent(JSON.stringify(cache || {})),
      keepalive: true,
    }).catch(() => {});
  } catch (e) {}
}
function scheduleSync() {
  if (!SYNC_URL || !remoteOK) return; // only push once we know remote is reachable
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(pushNow, 600);
}

const store = {
  async get(k) { const all = await ensureLoaded(); const v = all ? all[k] : null; return v == null ? null : { value: v }; },
  set(k, v) { if (!cache) cache = {}; cache[k] = v; cacheReady = true; writeLocalMirror(); scheduleSync(); },
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
function labelFor(item, N, R) { const v = compute(item.qty, N, R); return v == null ? item.name : item.name + " \u00d7" + v; }
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
    { id:"docs", title:"Documents & money", items:[ none("d1","Passport / ID"), none("d2","Boarding passes (phone + backup)"), none("d3","Wallet \u2014 cards + cash"), none("d4","EHIC / Kela card") ] },
    { id:"tech", title:"Tech", note:"Power bank (and rangefinder) ride in the cabin bag \u2014 never checked.", items:[ none("t1","Phone + charger"), none("t2","Power bank"), none("t3","Charging cables"), none("t4","Earbuds / headphones"), none("t5","Rangefinder / GPS watch + charger","golf") ] },
    { id:"toil", title:"Toiletries", note:"\u2264100ml each, 1L clear bag, cabin.", items:[ none("o1","Toiletry bag"), none("o2","Shaver + charger"), none("o3","Toothbrush + toothpaste"), none("o4","Deodorant"), none("o5","Sunscreen"), none("o6","Lip balm"), none("o7","Painkillers / meds") ] },
    { id:"cloth", title:"Clothing", items:[
      fml("c1","Underwear (everyday)","all",1,0,2,1), fml("c2","Socks (everyday)","all",2,0,1,1), fix("c3","Long socks","all",1),
      fml("c4","T-shirts","all",1,0,1,1), fix("c5","Smart evening shirt","all",2), fix("c6","Casual shorts","all",2),
      fix("c7","Jeans","all",1), fix("c8","Hoodie / light layer","all",1), none("c9","Belt"), none("c10","Sunglasses"),
      none("c11","Casual shoes","all","wear on travel day") ] },
    { id:"golf", title:"Golf gear", note:"Clubs, shoes, rain gear & towels pack inside the travel cover (checked).", items:[
      none("k1","Clubs in cart bag \u2192 travel cover","golf"), none("k2","Golf shoes","golf"),
      fml("k3","Golf polos","golf",0,1,1,1), fml("k4","Golf shorts","golf",0,0.5,0,1),
      fml("ku","Golf underwear","golf",0,1,1,1,"fresh pair after each round"), fml("ks","Golf socks","golf",0,1,1,1),
      none("k5","Caps \u2014 golf + casual","golf"), fix("k6","Balls","golf",12), none("k7","Tees","golf"),
      fix("k8","Gloves","golf",2), fix("k9","Wet-weather glove","golf",1), none("k10","Ball markers / pitch tool","golf"),
      fml("k11","Towels","golf",0,1,-1,1), none("k13","Rain jacket","golf"), none("k14","Rain hood","golf"),
      none("k15","Umbrella","golf"), none("k16","Blister plasters","golf"), none("k17","Water bottle","golf"), none("k18","Snacks","golf") ] },
    { id:"beach", title:"Sun / beach", items:[ fix("b1","Swimwear","beach",2), none("b2","Quick-dry / beach towel","beach"), none("b3","Flip-flops","beach"), none("b4","Sun hat","beach"), none("b5","After-sun","beach") ] },
    { id:"pre", title:"Pre-flight", items:[ none("p1","Liquids \u2264100ml in 1L bag"), none("p2","Power bank in cabin bag"), none("p3","Carry-on size/weight checked"), none("p4","Golf cover booked with airline as sports item","golf"), none("p5","Loaded cover under weight limit (~20kg)","golf") ] },
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
      <button onClick={() => set(Math.max(min, +(value - step).toFixed(2)))} style={btnStep}>{"\u2212"}</button>
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
            <Field label={"\u00d7 nights"}><Stepper value={q.n} set={(v) => setF({ n: v })} step={1} min={0} max={9} /></Field>
            <Field label={"\u00d7 rounds"}><Stepper value={q.r} set={(v) => setF({ r: v })} step={0.5} min={0} max={9} /></Field>
            <Field label="+ flat"><Stepper value={q.c} set={(v) => setF({ c: v })} step={1} min={-9} max={20} /></Field>
            <Field label="min"><Stepper value={q.floor} set={(v) => setF({ floor: v })} step={1} min={0} max={20} /></Field>
          </div>
          <div style={{ marginTop:8, fontSize:12.5, color:C.fairwayDk, background:"#eef5f0", borderRadius:8, padding:"7px 10px" }}>
            {q.n}{"\u00d7nights"} + {q.r}{"\u00d7rounds"} + {q.c}  {"\u2192"}  <b>{preview}</b> {trip === "golf" ? "(this trip)" : "(vacation, rounds=0)"}
          </div>
        </div>
      )}
      <button onClick={() => { delItem(sid, item.id); close(); }} style={{ marginTop:14, border:"none", background:"transparent", color:C.danger, fontSize:13, fontWeight:600, cursor:"pointer", padding:0 }}>Delete item</button>
    </div>
  );
}

export default function App() {
  const [tpl, setTpl] = useState(makeDefaults);
  const [trip, setTrip] = useState("golf");
  const [nights, setNights] = useState(3);
  const [rounds, setRounds] = useState(4);
  const [beach, setBeach] = useState(false);
  const [mode, setMode] = useState("pack");
  const [checked, setChecked] = useState({});
  const [expanded, setExpanded] = useState(null);
  const [userDef, setUserDef] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => { (async () => {
    try { const t = await store.get("packing:v4:tpl"); if (t && t.value) setTpl(JSON.parse(t.value)); } catch (e) {}
    try { const s = await store.get("packing:v2:settings"); if (s && s.value) { const v = JSON.parse(s.value); if (v.trip) setTrip(v.trip); if (typeof v.nights==="number") setNights(v.nights); if (typeof v.rounds==="number") setRounds(v.rounds); if (typeof v.beach==="boolean") setBeach(v.beach); } } catch (e) {}
    try { const c = await store.get("packing:v4:checked"); if (c && c.value) setChecked(JSON.parse(c.value)); } catch (e) {}
    try { const u = await store.get("packing:v4:userdef"); if (u && u.value) setUserDef(JSON.parse(u.value)); } catch (e) {}
    setLoaded(true);
  })(); }, []);

  useEffect(() => { if (loaded) store.set("packing:v4:tpl", JSON.stringify(tpl)); }, [tpl, loaded]);
  useEffect(() => { if (loaded) store.set("packing:v2:settings", JSON.stringify({ trip, nights, rounds, beach })); }, [trip, nights, rounds, beach, loaded]);
  useEffect(() => { if (loaded) store.set("packing:v4:checked", JSON.stringify(checked)); }, [checked, loaded]);
  useEffect(() => { if (loaded && userDef) store.set("packing:v4:userdef", JSON.stringify(userDef)); }, [userDef, loaded]);

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
  const resetTpl = () => setTpl(JSON.parse(JSON.stringify(userDef || makeDefaults())));
  const factoryReset = () => setTpl(makeDefaults());
  const saveDefault = () => { setUserDef(JSON.parse(JSON.stringify(tpl))); setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1600); };

  const sectionsView = tpl.sections.map((s) => ({ ...s, vis: s.items.filter((i) => itemVisible(i, trip, beach, mode)) })).filter((s) => s.vis.length > 0);
  const allIds = sectionsView.flatMap((s) => s.vis.map((i) => i.id));
  const packed = allIds.filter((id) => checked[id]).length;
  const total = allIds.length;
  const pct = total ? Math.round((packed / total) * 100) : 0;
  const toggle = (id) => setChecked((c) => ({ ...c, [id]: !c[id] }));

  return (
    <div style={{ minHeight:"100vh", background:C.paper, color:C.ink, fontFamily:"ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <div style={{ maxWidth:560, margin:"0 auto", padding:"20px 16px 72px" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
          <h1 style={{ fontSize:24, fontWeight:800, letterSpacing:-0.5, margin:0 }}>Pack</h1>
          <button onClick={() => { setMode(mode==="pack"?"edit":"pack"); setExpanded(null); }} style={{ height:36, padding:"0 16px", borderRadius:10, border:"1px solid "+(mode==="edit"?C.fairway:C.line), background: mode==="edit"?C.fairway:C.card, color: mode==="edit"?"#fff":C.ink, fontWeight:700, fontSize:14, cursor:"pointer" }}>{mode==="pack"?"Edit":"Done"}</button>
        </div>

        {mode === "pack" && (<>
          <div style={{ fontSize:12, color:C.muted, marginBottom:6 }}>{packed}/{total} packed</div>
          <div style={{ height:6, background:C.line, borderRadius:99, overflow:"hidden", marginBottom:18 }}><div style={{ width:pct+"%", height:"100%", background:C.fairway, transition:"width 200ms" }} /></div>
        </>)}
        {mode === "edit" && (
          <div style={{ fontSize:13, color:C.muted, lineHeight:1.45, marginBottom:16 }}>
            One shared list. Each item is tagged <b>Show on: Both / Golf / Vacation / Beach</b> \u2014 a <i>Both</i> item edited once updates every trip. Use the toggle to view a trip while editing. Tap <b>Save as my default</b> to lock the setup.
          </div>
        )}

        <div style={{ display:"flex", gap:8, marginBottom:14 }}>
          {[["golf","Golf trip"],["vacation","Vacation"]].map(([key,lbl]) => { const on = trip===key;
            return <button key={key} onClick={() => { setTrip(key); setExpanded(null); }} style={{ flex:1, height:46, borderRadius:12, border:"1px solid "+(on?C.fairway:C.line), background:on?C.fairway:C.card, color:on?"#fff":C.ink, fontSize:15, fontWeight:700, cursor:"pointer" }}>{lbl}</button>; })}
        </div>

        <div style={{ display:"flex", gap:10, marginBottom:10 }}>
          <div style={{ flex:1 }}><div style={lblStyle}>Nights</div><Stepper value={nights} set={setNights} min={1} max={60} /></div>
          {trip === "golf" && <div style={{ flex:1 }}><div style={lblStyle}>Rounds</div><Stepper value={rounds} set={setRounds} min={0} max={30} /></div>}
        </div>

        {trip === "vacation" && <button onClick={() => setBeach((b) => !b)} style={{ width:"100%", height:42, borderRadius:12, border:"1px solid "+(beach?C.sand:C.line), background: beach?"#faf3e0":C.card, color:C.ink, fontSize:14, fontWeight:600, cursor:"pointer", marginBottom:6 }}>{beach?"\u2713 ":"+ "}Sun / beach add-on</button>}

        {mode === "edit" ? (
          <div style={{ background:C.card, border:"1px solid "+C.line, borderRadius:12, padding:12, margin:"12px 0 18px" }}>
            <button onClick={saveDefault} style={{ width:"100%", height:42, borderRadius:10, border:"none", background: savedFlash?C.fairwayDk:C.fairway, color:"#fff", fontWeight:700, fontSize:14.5, cursor:"pointer" }}>{savedFlash?"\u2713 Saved as your default":"Save as my default"}</button>
            <div style={{ display:"flex", justifyContent:"space-between", marginTop:11 }}>
              <button onClick={resetTpl} style={linkBtn(C.muted)}>Reset to my default</button>
              <button onClick={factoryReset} style={linkBtn(C.danger)}>Factory reset</button>
            </div>
          </div>
        ) : (
          <div style={{ display:"flex", justifyContent:"flex-end", margin:"12px 0 18px" }}>
            <button onClick={() => setChecked({})} style={linkBtn(C.muted)}>Reset ticks</button>
          </div>
        )}

        {sectionsView.map((sec) => (
          <div key={sec.id} style={{ marginBottom:20 }}>
            {mode === "edit" ? (
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                <input value={sec.title} onChange={(e) => updSec(sec.id, { title: e.target.value })} style={{ flex:1, fontSize:13, fontWeight:700, color:C.fairwayDk, textTransform:"uppercase", letterSpacing:1, border:"none", borderBottom:"1px solid "+C.line, background:"transparent", padding:"4px 0", outline:"none" }} />
                <button onClick={() => delSec(sec.id)} style={{ border:"none", background:"transparent", color:C.danger, fontSize:18, cursor:"pointer", lineHeight:1 }}>{"\u2715"}</button>
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
                      <span style={box(on)}>{on?"\u2713":""}</span>
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
                      <span style={{ color:C.muted, fontSize:13 }}>{isOpen?"\u25b2":"\u25be"}</span>
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
        {mode === "pack" && <div style={{ textAlign:"center", fontSize:11.5, color:C.muted, marginTop:8 }}>Tap <b>Edit</b> to change items, tags, or quantity rules.</div>}
      </div>
    </div>
  );
}
