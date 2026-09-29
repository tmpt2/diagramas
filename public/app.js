(() => {
"use strict";
const MAX_LEVEL = 4;
const LEVELS = [
  {name:"Visão geral", tip:"Sistemas, pessoas e grandes blocos"},
  {name:"Processos", tip:"Processos dentro de cada bloco"},
  {name:"Atividades", tip:"Fluxo de atividades de cada processo"},
  {name:"Tarefas", tip:"Passos detalhados de cada atividade"}
];
const TYPES = {
  activity:{name:"Atividade", w:180, h:76},
  event:{name:"Início / Fim", w:150, h:52},
  decision:{name:"Decisão", w:150, h:110},
  actor:{name:"Pessoa", w:170, h:84},
  system:{name:"Sistema", w:190, h:80},
  data:{name:"Dados", w:170, h:80},
  note:{name:"Nota", w:180, h:96}
};
const GLYPH = {
  activity:'<rect x="3" y="6" width="18" height="12" rx="3"/>',
  event:'<rect x="2" y="8" width="20" height="8" rx="4"/>',
  decision:'<path d="M12 3 21 12 12 21 3 12Z"/>',
  actor:'<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.9 3.1-6.5 7-6.5s7 2.6 7 6.5"/>',
  system:'<rect x="3" y="5" width="18" height="14" rx="2" stroke-dasharray="3 2.5"/>',
  data:'<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/>',
  note:'<path d="M5 3h10l4 4v14H5Z"/><path d="M15 3v4h4"/>'
};
const COLORS = [null,"l1","l2","l3","l4","ink"];
const LS_KEY = "camadas.v1";

const $ = s => document.getElementById(s);
const app=$("app"), board=$("board"), world=$("world"), edgesEl=$("edges"), nodesEl=$("nodes");
function hyd(root){
  if(!root || !root.querySelectorAll) return;
  if(root.dataset && root.dataset.s!=null){ root.style.cssText = root.dataset.s; root.removeAttribute("data-s"); }
  root.querySelectorAll("[data-s]").forEach(x => { x.style.cssText = x.getAttribute("data-s"); x.removeAttribute("data-s"); });
}
hyd(document.body);
new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(hyd))).observe(document.body, {childList:true, subtree:true});
const uid = p => p + Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-3);
const esc = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const lvColor = l => `var(--l${Math.min(Math.max(l,1),4)})`;

/* ---------- state ---------- */
let diagrams = {};          // sheet id -> sheet of the open diagram (root + one per detailed box)
let currentId = "root";
let sel = null;             // {kind:'node'|'edge', id}
let multi = new Set();      // node ids when two or more boxes are selected (sel is null then)
const views = {};           // id -> {x,y,k}
const undo = [];            // [{id, json}]
let me = null;              // signed-in user
let appCfg = {appName:"Camadas", allowRegistration:false};
let mode = "home";          // "home" (library) | "doc" (editor)
let docMeta = null;         // open diagram: {id, name, role, folderId, ownerId}
let docRev = 0;             // last diagram revision seen from the server
let bases = {};             // sheet id -> {rev, json}: last version known to be on the server
let others = [];            // other people with this diagram open

function newRoot(){ return {id:"root", name:"Mapa principal", level:1, parentId:null, parentNodeId:null, nodes:[], edges:[], updatedAt:Date.now()}; }
function cur(){ return diagrams[currentId] || diagrams.root; }
function view(){ return views[currentId] || (views[currentId] = {x:0,y:0,k:1,fresh:true}); }
diagrams.root = newRoot();
const curKey = () => LS_KEY + ".cur." + (docMeta ? docMeta.id : "");

/* ---------- server API ---------- */
class ApiError extends Error { constructor(status, msg, data){ super(msg); this.status = status; this.data = data || {}; } }
async function api(method, url, body){
  let res;
  try{
    res = await fetch(url, {method, credentials:"same-origin",
      headers: body!==undefined ? {"Content-Type":"application/json","X-Camadas":"1"} : {"X-Camadas":"1"},
      body: body!==undefined ? JSON.stringify(body) : undefined});
  }catch(e){ throw new ApiError(0, "Sem ligação ao servidor."); }
  let data = {};
  try{ data = await res.json(); }catch(e){}
  if(res.status === 401 && !url.startsWith("api/auth/")){ sessionExpired(); }
  if(!res.ok) throw new ApiError(res.status, data.error || "Erro " + res.status, data);
  return data;
}
const docUrl = (sid) => `api/docs/${docMeta.id}` + (sid ? "/sheets/" + encodeURIComponent(sid) : "");

/* ---------- merging concurrent edits ----------
 * Each sheet remembers the last version the server had (its "base"). When someone else saved
 * the same sheet in the meantime, local changes are replayed on top of theirs, box by box and
 * field by field: what you changed wins, what you did not touch takes their version. */
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function mergeObj(b, l, r){
  const o = {...r};
  for(const k in l) if(!eq(l[k], b ? b[k] : undefined)) o[k] = l[k];
  if(b) for(const k in b) if(!(k in l) && eq(r[k], b[k])) delete o[k];
  return o;
}
function mergeList(b = [], l = [], r = []){
  const B = new Map(b.map(x => [x.id, x])), L = new Map(l.map(x => [x.id, x])), R = new Set(r.map(x => x.id)), out = [];
  for(const x of r){
    const bi = B.get(x.id), li = L.get(x.id);
    if(!li){ if(bi && eq(bi, x)) continue; out.push(x); }   // deleted here (kept if they changed it)
    else out.push(bi ? mergeObj(bi, li, x) : li);
  }
  for(const li of l){ if(R.has(li.id)) continue; const bi = B.get(li.id); if(!bi || !eq(li, bi)) out.push(li); } // added here
  return out;
}
function merge3(b, l, r){
  b = b || {};
  const o = {...r};
  for(const k of Object.keys(l)) if(k!=="nodes" && k!=="edges" && k!=="updatedAt" && !eq(l[k], b[k])) o[k] = l[k];
  o.nodes = mergeList(b.nodes, l.nodes, r.nodes);
  const ids = new Set(o.nodes.map(n => n.id));
  o.edges = mergeList(b.edges, l.edges, r.edges).filter(e => ids.has(e.from) && ids.has(e.to));
  o.updatedAt = Date.now();
  return o;
}

/* ---------- persistence ---------- */
const pending = new Set(), inflight = new Set(), deleted = new Set();
let flushTimer = null, saveError = null;
function touch(id){
  const d = diagrams[id]; if(!d || isReadOnly) return;
  d.updatedAt = Date.now();
  pending.add(id);
  clearTimeout(flushTimer); flushTimer = setTimeout(flush, 500);
  setStatus();
}
async function flush(){
  if(!me || !docMeta) return;
  const doc = docMeta;
  const ids = [...pending].filter(id => !inflight.has(id));
  await Promise.all(ids.map(async id => {
    pending.delete(id); inflight.add(id); setStatus();
    try{
      if(deleted.has(id)){ await api("DELETE", docUrl(id)); deleted.delete(id); delete bases[id]; }
      else if(diagrams[id]){
        const json = JSON.stringify(diagrams[id]);
        const r = await api("PUT", docUrl(id), {data:diagrams[id], baseRev: bases[id] ? bases[id].rev : 0});
        if(docMeta === doc) bases[id] = {rev:r.rev, json};
      }
      saveError = null;
    }catch(e){
      if(docMeta !== doc){}                                   // diagram was closed meanwhile
      else if(e.status === 409) conflict(id, e.data);
      else if(e.status === 404) lostAccess(e.message);
      else if(e.status === 403){ pending.clear(); deleted.clear(); sync(); saveError = e.message; } // now view-only
      else if(e.status === 400){ saveError = e.message; }     // invalid data: retrying won't help
      else { pending.add(id); if(e.status !== 401) saveError = e.message; }
    }
    inflight.delete(id);
  }));
  if(pending.size){ clearTimeout(flushTimer); flushTimer = setTimeout(flush, saveError ? 3000 : 150); }
  setStatus();
}
// Someone else saved this sheet first: merge our changes into theirs and save again.
function conflict(id, d){
  if(d.data == null){
    delete diagrams[id]; delete bases[id]; pending.delete(id);
    if(currentId === id) currentId = "root";
    showToast("Este nível foi apagado por outra pessoa.", [{t:"OK"}]);
  } else {
    const remote = JSON.parse(d.data), base = bases[id] ? JSON.parse(bases[id].json) : null;
    diagrams[id] = diagrams[id] ? merge3(base, diagrams[id], remote) : remote;
    bases[id] = {rev:d.rev, json:d.data};
    pending.add(id);
  }
  dropUndo(id);
  if(sel && !findSel()) sel = null;
  render();
}
let isReadOnly = false;
function setStatus(){
  const st = $("status"), busy = pending.size || inflight.size;
  st.className = "status doc-only" + (saveError ? " err" : busy ? " busy" : isReadOnly ? " local" : "");
  st.querySelector("span").textContent = saveError ? "Não guardado — a tentar de novo" : busy ? "A guardar…" : isReadOnly ? "Só leitura" : "Guardado";
  st.title = saveError || (isReadOnly ? "Tem permissão para ver este diagrama, mas não para o alterar." : "");
}
addEventListener("beforeunload", e => { if(pending.size || inflight.size){ flush(); e.preventDefault(); e.returnValue = ""; } });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function saveAll(){
  for(let i = 0; i < 40 && (pending.size || inflight.size); i++){ if(pending.size) await flush(); else await sleep(100); }
  return !pending.size && !inflight.size;
}

async function openDoc(id){
  if(docMeta && docMeta.id === id){ showDoc(); return; }
  if(docMeta && !(await closeDoc())) return;
  let r;
  try{ r = await api("GET", "api/docs/" + id); }
  catch(e){ if(e.status !== 401){ location.hash = ""; showToast(e.message, [{t:"OK"}]); } return; }
  diagrams = {}; bases = {};
  r.sheets.forEach(s => { try{ const d = JSON.parse(s.data); diagrams[s.id] = d; bases[s.id] = {rev:s.rev, json:s.data}; }catch(e){} });
  docMeta = r.doc; docRev = r.doc.rev; others = r.presence || [];
  isReadOnly = docMeta.role === "view";
  if(!diagrams.root){ diagrams.root = {...newRoot(), name:docMeta.name}; touch("root"); }
  undo.length = 0; clearSel(); for(const k in views) delete views[k];
  pending.clear(); deleted.clear(); saveError = null;
  currentId = "root";
  try{ const c = localStorage.getItem(curKey()); if(c && diagrams[c]) currentId = c; }catch(e){}
  showDoc();
}
async function closeDoc(){
  if(!docMeta) return true;
  if(!(await saveAll())){
    showToast("Há alterações por guardar. Verifique a ligação e tente de novo.", [{t:"OK"}]);
    return false;
  }
  docMeta = null; diagrams = {root:newRoot()}; bases = {}; others = []; undo.length = 0; clearSel();
  pending.clear(); deleted.clear(); isReadOnly = false;
  return true;
}
function lostAccess(msg){
  docMeta = null; diagrams = {root:newRoot()}; bases = {}; pending.clear(); deleted.clear();
  location.hash = "";
  showToast(msg || "Deixou de ter acesso a este diagrama.", [{t:"OK"}]);
}

/* ---------- live updates: poll for changes made by other people ---------- */
let syncing = false;
async function sync(){
  if(!me || !docMeta || syncing || drag || document.hidden) return;
  syncing = true;
  const doc = docMeta;
  try{
    const r = await api("GET", `api/docs/${doc.id}/sync?since=${docRev}`);
    if(docMeta !== doc || drag) return;
    let changed = false, skipped = Infinity;
    for(const s of r.sheets){
      const b = bases[s.id];
      if(b && s.rev <= b.rev) continue;                        // our own save coming back
      if(inflight.has(s.id)){ skipped = Math.min(skipped, s.rev); continue; } // our save will get a 409 and merge
      changed = true; dropUndo(s.id);
      if(s.deleted){ delete diagrams[s.id]; delete bases[s.id]; pending.delete(s.id); deleted.delete(s.id); continue; }
      if(deleted.has(s.id)) continue;
      const remote = JSON.parse(s.data);
      diagrams[s.id] = pending.has(s.id) && diagrams[s.id] ? merge3(b ? JSON.parse(b.json) : null, diagrams[s.id], remote) : remote;
      bases[s.id] = {rev:s.rev, json:s.data};
    }
    docRev = skipped < Infinity ? Math.max(docRev, skipped - 1) : r.rev;
    if(r.role !== doc.role){
      doc.role = r.role; isReadOnly = r.role === "view"; changed = true;
      app.classList.toggle("ro", isReadOnly);
      if(isReadOnly){ pending.clear(); deleted.clear(); saveError = null; }
      showToast(isReadOnly ? "Agora só pode ver este diagrama." : "Agora pode editar este diagrama.", [{t:"OK"}]);
    }
    doc.name = r.name;
    if(!eq(others, r.presence)){ others = r.presence; renderPresence(); }
    if(changed){
      if(!diagrams.root) diagrams.root = {...newRoot(), name:doc.name};
      if(!diagrams[currentId]){ currentId = "root"; showToast("O nível que estava a ver foi apagado por outra pessoa.", [{t:"OK"}]); }
      if(sel && !findSel()) sel = null;
      render(); setStatus();
    }
  }catch(e){
    if(docMeta === doc && (e.status === 403 || e.status === 404)) lostAccess(e.message);
  }finally{ syncing = false; }
}
setInterval(sync, 4000);
addEventListener("focus", sync);
document.addEventListener("visibilitychange", () => { if(!document.hidden){ sync(); if(mode === "home" && me) loadLibrary(); } });

/* ---------- undo ---------- */
function snapshot(){
  const d = cur(); undo.push({id:d.id, json:JSON.stringify(d)});
  if(undo.length > 80) undo.shift();
  $("undoBtn").disabled = false;
}
// After someone else changed a sheet, undoing an older local snapshot would wipe their work.
function dropUndo(id){
  for(let i = undo.length - 1; i >= 0; i--){
    const u = undo[i];
    if(u.id === id || (u.id.startsWith("__multi:") && JSON.parse(u.json).some(d => d.id === id))) undo.splice(i, 1);
  }
  $("undoBtn").disabled = !undo.length;
}
function doUndo(){
  if(isReadOnly) return;
  const u = undo.pop(); if(!u) return;
  if(u.id.startsWith("__multi:")){ // restore several diagrams
    const arr = JSON.parse(u.json);
    arr.forEach(d => { diagrams[d.id] = d; deleted.delete(d.id); touch(d.id); });
    currentId = u.id.slice(8);
  } else { diagrams[u.id] = JSON.parse(u.json); deleted.delete(u.id); currentId = u.id; touch(u.id); }
  clearSel(); render();
  $("undoBtn").disabled = !undo.length;
}

/* ---------- helpers ---------- */
function nodeById(id, d=cur()){ return d.nodes.find(n=>n.id===id); }
function edgeById(id, d=cur()){ return d.edges.find(e=>e.id===id); }
function findSel(){ if(!sel) return null; return sel.kind==="node" ? nodeById(sel.id) : edgeById(sel.id); }
// Selected box ids, whether one (sel) or several (multi).
function selNodeIds(){ return multi.size ? [...multi] : sel && sel.kind==="node" ? [sel.id] : []; }
function isNodeSel(id){ return multi.has(id) || (!!sel && sel.kind==="node" && sel.id===id); }
function selectNodes(ids){
  ids = [...new Set(ids)];
  multi = ids.length > 1 ? new Set(ids) : new Set();
  sel = ids.length === 1 ? {kind:"node", id:ids[0]} : null;
}
function clearSel(){ sel = null; multi.clear(); }
// Drop selected boxes that no longer exist on the current sheet (undo, other people's edits…).
function pruneSel(){
  if(!multi.size) return;
  const d = cur(); selectNodes([...multi].filter(id => nodeById(id, d)));
}
function childOf(n){ return n && n.childId ? diagrams[n.childId] : null; }
function countDeep(d){ if(!d) return 0; let c = d.nodes.length; d.nodes.forEach(n=>{ if(n.childId) c += countDeep(diagrams[n.childId]); }); return c; }
function descendants(d, out=[]){ if(!d) return out; d.nodes.forEach(n=>{ const c = diagrams[n.childId]; if(c){ out.push(c); descendants(c,out);} }); return out; }
function pathTo(id){ const p=[]; let d = diagrams[id]; while(d){ p.unshift(d); d = d.parentId ? diagrams[d.parentId] : null; } return p; }
function diagName(d){
  if(!d.parentId) return d.name || "Mapa principal";
  const p = diagrams[d.parentId], n = p && nodeById(d.parentNodeId, p);
  return (n && n.label) || d.name || "Sem nome";
}
function nodeColor(n, d){ if(n.color==="ink") return "var(--ink)"; if(n.color) return `var(--${n.color})`; return lvColor(d.level); }

/* ---------- mutations ---------- */
function freeSpot(d, x, y, w, h){
  const hit = (px,py) => d.nodes.some(o => px < o.x+o.w+30 && px+w+30 > o.x && py < o.y+o.h+30 && py+h+30 > o.y);
  const snap = v => Math.round(v/10)*10;
  if(!hit(x,y)) return {x:snap(x), y:snap(y)};
  for(let r=1; r<40; r++){
    for(let i=0; i<8*r; i++){
      const a = i/(8*r)*Math.PI*2, px = x + Math.cos(a)*r*60, py = y + Math.sin(a)*r*45;
      if(!hit(px,py)) return {x:snap(px), y:snap(py)};
    }
  }
  return {x:snap(x), y:snap(y)};
}
function addNode(type, wx, wy){
  if(isReadOnly) return;
  snapshot();
  const d = cur(), t = TYPES[type];
  const n = {id:uid("n"), type, label: t.name + (type==="note" ? "" : " " + (d.nodes.filter(x=>x.type===type).length+1)), desc:"",
    x:0, y:0, w:t.w, h:t.h, color:null};
  const spot = freeSpot(d, wx - t.w/2, wy - t.h/2, t.w, t.h); n.x = spot.x; n.y = spot.y;
  if(type==="note") n.label = "Escreva uma nota";
  d.nodes.push(n); selectNodes([n.id]);
  touch(d.id); render();
  setTimeout(()=>{ const i=$("f-label"); if(i){ i.focus(); i.select(); } }, 30);
}
function addEdge(from, to){
  const d = cur();
  if(from===to || d.edges.some(e=>e.from===from && e.to===to)) return;
  snapshot();
  const e = {id:uid("e"), from, to, label:"", style:"solid"};
  d.edges.push(e); multi.clear(); sel = {kind:"edge", id:e.id};
  touch(d.id); render();
}
function deleteSelection(force){
  if((!sel && !multi.size) || isReadOnly) return;
  const d = cur();
  if(sel && sel.kind==="edge"){ snapshot(); d.edges = d.edges.filter(e=>e.id!==sel.id); sel=null; touch(d.id); render(); return; }
  const ns = selNodeIds().map(id => nodeById(id)).filter(Boolean); if(!ns.length) return;
  const chs = ns.map(childOf).filter(Boolean), inner = chs.reduce((a, c) => a + countDeep(c), 0);
  if(inner && !force){
    const what = ns.length === 1 ? `“${ns[0].label}”` : `as ${ns.length} caixas selecionadas`;
    showToast(`Apagar ${what} e as ${inner} caixas dos níveis interiores?`, [
      {t:"Apagar", cls:"danger", fn:()=>deleteSelection(true)}, {t:"Cancelar"}]);
    return;
  }
  const gone = chs.flatMap(ch => [ch, ...descendants(ch)]);
  undo.push({id:"__multi:"+d.id, json:JSON.stringify([JSON.parse(JSON.stringify(d)), ...gone])}); $("undoBtn").disabled=false;
  const ids = new Set(ns.map(n => n.id));
  d.nodes = d.nodes.filter(x=>!ids.has(x.id));
  d.edges = d.edges.filter(e=>!ids.has(e.from) && !ids.has(e.to));
  gone.forEach(g => { delete diagrams[g.id]; deleted.add(g.id); pending.add(g.id); });
  clearSel(); touch(d.id); render();
}
function enter(nodeId){
  const d = cur(), n = nodeById(nodeId); if(!n) return;
  if(d.level >= MAX_LEVEL){ showToast(`O nível ${MAX_LEVEL} (${LEVELS[MAX_LEVEL-1].name}) é o mais detalhado.`, [{t:"OK"}]); return; }
  if(!n.childId || !diagrams[n.childId]){
    if(isReadOnly) return;
    const c = {id:uid("d"), name:n.label, level:d.level+1, parentId:d.id, parentNodeId:n.id, nodes:[], edges:[], updatedAt:Date.now()};
    diagrams[c.id] = c; n.childId = c.id; touch(d.id); touch(c.id);
  }
  go(n.childId);
}
function go(id){
  if(!diagrams[id]) return;
  const from = currentId;
  currentId = id; clearSel();
  // when going up, select the node we came from
  const fd = diagrams[from];
  if(fd && fd.parentId === id) sel = {kind:"node", id:fd.parentNodeId};
  try{ localStorage.setItem(curKey(), id); }catch(e){}
  if(innerWidth <= 980) app.classList.add("no-tree");
  render();
}
function up(){ const d = cur(); if(d.parentId) go(d.parentId); }

/* ---------- geometry ---------- */
function center(n){ return {x:n.x+n.w/2, y:n.y+n.h/2}; }
function port(n, toward){
  const c = center(n), dx = toward.x-c.x, dy = toward.y-c.y;
  const shrink = n.type==="decision" ? .82 : 1;
  if(Math.abs(dx)*n.h > Math.abs(dy)*n.w){
    return {x: c.x + Math.sign(dx)*n.w/2*shrink, y:c.y, dir:[Math.sign(dx),0]};
  }
  return {x:c.x, y:c.y + Math.sign(dy||1)*n.h/2*shrink, dir:[0,Math.sign(dy||1)]};
}
function curve(a, b){
  const dist = Math.hypot(b.x-a.x, b.y-a.y), k = Math.min(90, Math.max(30, dist*.4));
  const c1 = {x:a.x + a.dir[0]*k, y:a.y + a.dir[1]*k};
  const c2 = b.dir ? {x:b.x + b.dir[0]*k, y:b.y + b.dir[1]*k} : {x:b.x, y:b.y};
  const mid = {x:.125*a.x+.375*c1.x+.375*c2.x+.125*b.x, y:.125*a.y+.375*c1.y+.375*c2.y+.125*b.y};
  return {d:`M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`, mid};
}
function edgeGeom(e, d){
  const A = nodeById(e.from,d), B = nodeById(e.to,d); if(!A||!B) return null;
  const a = port(A, center(B)), b = port(B, center(A));
  return curve(a, b);
}

/* ---------- render ---------- */
function applyView(){
  const v = view();
  world.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.k})`;
  const s = 22*v.k;
  board.style.backgroundSize = `${s}px ${s}px`;
  board.style.backgroundPosition = `${v.x}px ${v.y}px`;
  $("zVal").textContent = Math.round(v.k*100) + "%";
}
function render(){
  const d = cur();
  document.documentElement.style.setProperty("--accent", lvColor(d.level));
  pruneSel();
  if(view().fresh){ view().fresh = false; fit(true); }
  applyView();
  renderEdges(); renderNodes(); renderCrumbs(); renderTree(); renderInside(); renderInspector();
  $("empty").classList.toggle("hide", d.nodes.length>0);
  $("undoBtn").disabled = !undo.length;
}
function renderNodes(){
  const d = cur();
  nodesEl.innerHTML = d.nodes.map(n => {
    const ch = childOf(n), cnt = ch ? ch.nodes.length : 0;
    const selc = isNodeSel(n.id) ? " sel" : "";
    const glyph = n.type==="actor" ? `<svg class="glyph" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${GLYPH.actor}</svg>`
               : n.type==="data" ? "" : "";
    const sub = n.type==="system" ? "Sistema externo" : n.type==="data" ? "Dados" : "";
    return `<div class="node t-${n.type}${selc}" data-node="${n.id}" data-s="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;--nc:${nodeColor(n,d)}">
      ${glyph}<div class="lbl">${esc(n.label)}</div>${sub?`<div class="sub">${sub}</div>`:""}
      <span class="stripe"></span>
      ${cnt ? `<span class="deep" data-deep="${n.id}" title="Abrir nível ${d.level+1}: ${cnt} caixas"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="m3 8 9 4.5L21 8M3 13l9 4.5 9-4.5"/></svg>${cnt}</span>` : ""}
      ${n.type!=="note" ? `<span class="port" data-port="${n.id}" title="Arraste para ligar"></span>` : ""}
    </div>`;
  }).join("");
}
function renderEdges(temp){
  const d = cur();
  let h = `<defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 Z"/></marker>
    <marker id="arrSel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 Z"/></marker></defs>`;
  const labels = [];
  d.edges.forEach(e => {
    const g = edgeGeom(e, d); if(!g) return;
    const s = sel && sel.kind==="edge" && sel.id===e.id;
    h += `<g class="${s?"sel":""}" data-edge="${e.id}"><path class="hit" d="${g.d}" data-edge="${e.id}"/><path class="vis ${e.style==="dashed"?"dashed":""}" d="${g.d}" marker-end="url(#${s?"arrSel":"arr"})"/></g>`;
    if(e.label) labels.push(`<div class="elabel${s?" sel":""}" data-edge="${e.id}" data-s="left:${g.mid.x}px;top:${g.mid.y}px">${esc(e.label)}</div>`);
  });
  if(temp) h += `<path class="temp" d="${temp}"/>`;
  edgesEl.innerHTML = h;
  let lw = $("elabels"); if(!lw){ lw = document.createElement("div"); lw.id="elabels"; world.appendChild(lw); }
  lw.innerHTML = labels.join("");
}
function renderCrumbs(){
  const p = pathTo(currentId);
  $("crumbs").innerHTML = p.map((d,i) => `${i?'<span class="sep">›</span>':""}<button class="crumb${d.id===currentId?" here":""}" data-go="${d.id}"><span class="lv" data-s="--lc:${lvColor(d.level)}">N${d.level}</span>${esc(diagName(d))}</button>`).join("");
  const c = $("crumbs"); c.scrollLeft = c.scrollWidth;
}
function renderTree(){
  const item = d => {
    const kids = d.nodes.filter(n=>n.childId && diagrams[n.childId]).map(n=>diagrams[n.childId]);
    return `<li><button class="titem${d.id===currentId?" here":""}" data-go="${d.id}" data-s="--lc:${lvColor(d.level)}"><span class="lv" data-s="--lc:${lvColor(d.level)}">N${d.level}</span><span class="nm">${esc(diagName(d))}</span><span class="ct">${d.nodes.length}</span></button>${kids.length?`<ul>${kids.map(item).join("")}</ul>`:""}</li>`;
  };
  $("treeList").innerHTML = item(diagrams.root);
  $("legend").innerHTML = LEVELS.map((l,i)=>`<div><span class="lv" data-s="--lc:${lvColor(i+1)}">N${i+1}</span><span><span data-s="color:var(--ink)">${l.name}</span><br>${l.tip}</span></div>`).join("");
}
function renderInside(){
  const d = cur(), el = $("inside");
  if(!d.parentId){ el.classList.add("hide"); return; }
  const p = diagrams[d.parentId], n = p && nodeById(d.parentNodeId, p);
  el.classList.remove("hide");
  el.innerHTML = `<span class="lv" data-s="--lc:${lvColor(d.level)}">N${d.level}</span><span class="d">Dentro de <b>${esc(n?n.label:diagName(d))}</b>${n&&n.desc?" · "+esc(n.desc):""}</span>`;
}
function renderInspector(){
  const d = cur(), el = $("insp"), s = findSel();
  const focused = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : null;
  const dis = isReadOnly ? " disabled" : "";
  if(multi.size){
    const ns = selNodeIds().map(id => nodeById(id)).filter(Boolean), c0 = ns[0].color || null;
    const same = ns.every(n => (n.color || null) === c0);
    el.innerHTML = `<h2>${ns.length} caixas selecionadas · nível ${d.level}</h2>
      <p data-s="color:var(--muted);font-size:12.5px;line-height:1.5;margin:0 0 14px">Arraste uma das caixas para mover todas. Shift+clique junta ou retira caixas da seleção.</p>
      <div class="field"><label>Cor</label><div class="swatches" id="f-color">${COLORS.map(c=>`<button class="sw${same && c0===c?" on":""}"${dis} data-color="${c||""}" aria-label="${c?"Cor "+c:"Cor do nível"}" data-s="background:${c==="ink"?"var(--ink)":c?`var(--${c})`:`linear-gradient(135deg,${lvColor(d.level)} 50%,var(--surface) 50%)`}"></button>`).join("")}</div></div>
      ${isReadOnly ? "" : `<button class="dbtn" id="f-del">Apagar ${ns.length} caixas</button>`}`;
  } else if(s && sel.kind==="node"){
    const n = s, ch = childOf(n), canDeep = d.level < MAX_LEVEL && (!isReadOnly || (ch && ch.nodes.length));
    el.innerHTML = `<h2>${TYPES[n.type].name} · nível ${d.level}</h2>
      <div class="field"><label for="f-label">Nome</label><input id="f-label" value="${esc(n.label)}" maxlength="120"${dis}></div>
      <div class="field"><label for="f-desc">Descrição</label><textarea id="f-desc" placeholder="Responsável, entradas, saídas, regras…"${dis}>${esc(n.desc)}</textarea></div>
      <div class="field"><label>Tipo</label><div class="seg" id="f-type">${Object.entries(TYPES).map(([k,t])=>`<button data-type="${k}" class="${k===n.type?"on":""}"${dis}>${t.name}</button>`).join("")}</div></div>
      <div class="field"><label>Cor</label><div class="swatches" id="f-color">${COLORS.map(c=>`<button class="sw${(n.color||null)===c?" on":""}"${dis} data-color="${c||""}" aria-label="${c?"Cor "+c:"Cor do nível"}" data-s="background:${c==="ink"?"var(--ink)":c?`var(--${c})`:`linear-gradient(135deg,${lvColor(d.level)} 50%,var(--surface) 50%)`}"></button>`).join("")}</div></div>
      ${canDeep ? `<div class="drill"><div class="row"><span class="lv" data-s="--lc:${lvColor(d.level+1)}">N${d.level+1}</span>${LEVELS[d.level].name}</div>
        <p>${ch && ch.nodes.length ? `Este elemento tem ${ch.nodes.length} caixas e ${ch.edges.length} ligações no nível ${d.level+1}.` : `Ainda sem detalhe. Entre para desenhar o fluxo interno deste elemento.`}</p>
        <button class="pbig" id="f-enter">${ch && ch.nodes.length ? "Abrir nível "+(d.level+1) : "Detalhar no nível "+(d.level+1)} <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></div>`
      : d.level >= MAX_LEVEL ? `<div class="drill"><p>Nível ${MAX_LEVEL} é o mais detalhado. Use a descrição para registar os passos.</p></div>` : ""}
      ${isReadOnly ? "" : `<button class="dbtn" id="f-del">Apagar caixa</button>`}`;
  } else if(s && sel.kind==="edge"){
    const e = s, A = nodeById(e.from), B = nodeById(e.to);
    el.innerHTML = `<h2>Ligação</h2>
      <div class="meta">${esc(A&&A.label)} → ${esc(B&&B.label)}</div>
      <div class="field"><label for="f-elabel">Texto da ligação</label><input id="f-elabel" value="${esc(e.label)}" placeholder="ex.: envia pedido, sim, não" maxlength="80"${dis}></div>
      <div class="field"><label>Traço</label><div class="seg" id="f-style"><button data-style="solid" class="${e.style!=="dashed"?"on":""}"${dis}>Contínuo</button><button data-style="dashed" class="${e.style==="dashed"?"on":""}"${dis}>Tracejado</button></div></div>
      <div class="field"><label>Sentido</label><div class="seg"><button id="f-flip"${dis}>Inverter sentido</button></div></div>
      ${isReadOnly ? "" : `<button class="dbtn" id="f-del">Apagar ligação</button>`}`;
  } else {
    const deep = countDeep(d) - d.nodes.length;
    el.innerHTML = `<h2>Diagrama · nível ${d.level}</h2>
      <div class="field"><label for="f-dname">Nome</label><input id="f-dname" value="${esc(diagName(d))}" maxlength="120"${dis}></div>
      <div class="meta">${LEVELS[d.level-1].name} — ${LEVELS[d.level-1].tip}</div>
      <div class="stats"><div><b>${d.nodes.length}</b><span>caixas</span></div><div><b>${d.edges.length}</b><span>ligações</span></div>
        <div><b>${d.nodes.filter(n=>childOf(n)&&childOf(n).nodes.length).length}</b><span>com detalhe</span></div><div><b>${deep}</b><span>caixas abaixo</span></div></div>
      ${d.parentId ? `<button class="tbtn" id="f-up" data-s="width:100%;justify-content:center">Subir para o nível ${d.level-1}</button>` : `<p data-s="color:var(--muted);font-size:12.5px;line-height:1.5;margin:0">Selecione uma caixa para a editar. Faça duplo clique numa caixa para descer ao nível seguinte (até ao nível ${MAX_LEVEL}).</p>`}`;
  }
  if(focused && $(focused)){ const f=$(focused); f.focus(); if(f.setSelectionRange && f.value!=null){ try{ const L=f.value.length; f.setSelectionRange(L,L);}catch(e){} } }
  const hasSel = !!s || multi.size > 0;
  if(innerWidth <= 980) app.classList.toggle("no-insp", !hasSel);
  else app.classList.toggle("no-insp", false);
}

/* ---------- inspector events ---------- */
let editSnap = null;
$("insp").addEventListener("focusin", e => { if(e.target.matches("input,textarea")) editSnap = JSON.stringify(cur()); });
$("insp").addEventListener("input", e => {
  if(isReadOnly) return;
  const d = cur(), t = e.target;
  if(editSnap){ undo.push({id:d.id, json:editSnap}); editSnap=null; }
  if(t.id==="f-label"){ const n=findSel(); n.label=t.value; const c=childOf(n); if(c){ c.name=t.value; touch(c.id);} }
  else if(t.id==="f-desc"){ findSel().desc=t.value; }
  else if(t.id==="f-elabel"){ findSel().label=t.value; }
  else if(t.id==="f-dname"){
    if(!d.parentId){ d.name=t.value; document.title = `${t.value} · ${appCfg.appName || "Camadas"}`; }
    else { const p=diagrams[d.parentId], n=nodeById(d.parentNodeId,p); if(n){ n.label=t.value; touch(p.id);} d.name=t.value; }
  } else return;
  touch(d.id);
  renderNodes(); renderEdges(); renderCrumbs(); renderTree(); renderInside();
});
$("insp").addEventListener("click", e => {
  const d = cur(), b = e.target.closest("button"); if(!b) return;
  if(b.id==="f-enter") return enter(sel.id);
  if(b.id==="f-up") return up();
  if(b.id==="f-del") return deleteSelection();
  if(isReadOnly) return;
  if(b.dataset.type){ snapshot(); const n=findSel(), t=TYPES[b.dataset.type]; const cx=n.x+n.w/2, cy=n.y+n.h/2; n.type=b.dataset.type; n.w=t.w; n.h=t.h; n.x=Math.round((cx-t.w/2)/10)*10; n.y=Math.round((cy-t.h/2)/10)*10; touch(d.id); render(); }
  else if(b.dataset.color!==undefined){ snapshot(); selNodeIds().forEach(id => { const n = nodeById(id); if(n) n.color = b.dataset.color||null; }); touch(d.id); render(); }
  else if(b.dataset.style){ snapshot(); findSel().style=b.dataset.style; touch(d.id); render(); }
  else if(b.id==="f-flip"){ snapshot(); const x=findSel(); [x.from,x.to]=[x.to,x.from]; touch(d.id); render(); }
});

/* ---------- palette ---------- */
$("palette").innerHTML = `<div class="ph">Adicionar</div>` + Object.entries(TYPES).map(([k,t]) =>
  `<button class="pbtn" data-add="${k}" title="Adicionar ${t.name}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">${GLYPH[k]}</svg><span>${t.name}</span></button>`).join("");
let addOffset = 0;
$("palette").addEventListener("click", e => {
  const b = e.target.closest("[data-add]"); if(!b) return;
  const r = board.getBoundingClientRect(), v = view();
  addNode(b.dataset.add, (r.width/2 - v.x)/v.k, (r.height/2 - v.y)/v.k);
});

/* ---------- board pointer handling ---------- */
let drag = null;             // {kind:'move'|'pan'|'link'|'pinch'|'marquee', ...}
const pointers = new Map();
let lastTap = {t:0, id:null, x:0, y:0};
function toWorld(cx, cy){ const r = board.getBoundingClientRect(), v = view(); return {x:(cx-r.left-v.x)/v.k, y:(cy-r.top-v.y)/v.k}; }

// Selection rectangle, drawn in screen coordinates over the board.
const marqueeEl = document.createElement("div");
marqueeEl.className = "marquee hide";
board.appendChild(marqueeEl);
let spaceDown = false;       // Space held: dragging the background with the mouse selects instead of panning
let noCtxMenu = false;       // the right button was just used to pan
function startPan(e){
  const v = view();
  drag = {kind:"pan", sx:e.clientX, sy:e.clientY, vx:v.x, vy:v.y, moved:false, button:e.button};
  board.classList.add("panning");
}
function renderSelOnly(){ renderNodes(); renderEdges(); renderInspector(); }

board.addEventListener("pointerdown", e => {
  const mouse = e.pointerType === "mouse";
  if(mouse && e.button > 2) return;
  if(mouse && e.button === 1) e.preventDefault();          // no auto-scroll on middle click
  pointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
  board.setPointerCapture(e.pointerId);
  if(pointers.size === 2){
    const [a,b] = [...pointers.values()], v = view();
    drag = {kind:"pinch", dist:Math.hypot(a.x-b.x,a.y-b.y), k:v.k, mid:{x:(a.x+b.x)/2,y:(a.y+b.y)/2}, vx:v.x, vy:v.y};
    return;
  }
  // middle or right button: pan the board
  if(mouse && e.button !== 0){ startPan(e); return; }
  const t = e.target;
  const portEl = t.closest("[data-port]"), deepEl = t.closest("[data-deep]"), nodeEl = t.closest("[data-node]"), edgeEl = t.closest("[data-edge]");
  const now = performance.now();
  if(deepEl){ enter(deepEl.dataset.deep); drag=null; return; }
  if(portEl && !isReadOnly){
    const n = nodeById(portEl.dataset.port);
    drag = {kind:"link", from:n.id, diagram:currentId};
    return;
  }
  if(nodeEl){
    const id = nodeEl.dataset.node, n = nodeById(id);
    if(e.shiftKey || e.ctrlKey || e.metaKey){ // add the box to the selection, or take it out
      const ids = selNodeIds();
      selectNodes(ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
      lastTap = {t:0, id:null, x:0, y:0}; drag = null;
      renderSelOnly(); return;
    }
    const dbl = lastTap.id===id && now-lastTap.t < 380 && Math.hypot(e.clientX-lastTap.x, e.clientY-lastTap.y) < 12;
    lastTap = {t:now, id, x:e.clientX, y:e.clientY};
    if(dbl){ drag=null; if(n.type!=="note") enter(id); return; }
    if(!isNodeSel(id)){ selectNodes([id]); renderSelOnly(); }
    // every selected box moves together, keeping the grabbed one on the grid
    const items = selNodeIds().map(i => nodeById(i)).filter(Boolean).map(m => ({id:m.id, ox:m.x, oy:m.y}));
    drag = {kind:"move", lead:id, items, w0:toWorld(e.clientX, e.clientY), sx:e.clientX, sy:e.clientY, moved:false, diagram:currentId};
    return;
  }
  if(edgeEl){ multi.clear(); sel = {kind:"edge", id:edgeEl.dataset.edge}; renderSelOnly(); drag=null; return; }
  // background
  const dbl = lastTap.id==="__bg" && now-lastTap.t < 380 && Math.hypot(e.clientX-lastTap.x, e.clientY-lastTap.y) < 12;
  lastTap = {t:now, id:"__bg", x:e.clientX, y:e.clientY};
  if(dbl){ const w = toWorld(e.clientX, e.clientY); addNode("activity", w.x, w.y); drag=null; return; }
  // dragging the background pans; with Space held, the mouse draws a selection rectangle instead
  if(!mouse || !spaceDown){ startPan(e); return; }
  const add = e.shiftKey || e.ctrlKey || e.metaKey;
  drag = {kind:"marquee", sx:e.clientX, sy:e.clientY, w0:toWorld(e.clientX, e.clientY), add, base:add ? selNodeIds() : [], ids:null, moved:false};
});
board.addEventListener("pointermove", e => {
  if(pointers.has(e.pointerId)) pointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
  if(!drag) return;
  const v = view();
  if(drag.kind==="pinch" && pointers.size>=2){
    const [a,b] = [...pointers.values()];
    const k = clampK(drag.k * Math.hypot(a.x-b.x,a.y-b.y)/drag.dist);
    const r = board.getBoundingClientRect(), mx = drag.mid.x - r.left, my = drag.mid.y - r.top;
    v.x = mx - (mx - drag.vx) * k/drag.k; v.y = my - (my - drag.vy) * k/drag.k; v.k = k;
    applyView(); return;
  }
  if(drag.kind==="pan"){
    v.x = drag.vx + e.clientX - drag.sx; v.y = drag.vy + e.clientY - drag.sy;
    if(Math.hypot(e.clientX-drag.sx, e.clientY-drag.sy) > 3) drag.moved = true;
    applyView(); return;
  }
  if(drag.kind==="move"){
    if(isReadOnly) return;
    if(!drag.moved && Math.hypot(e.clientX-drag.sx, e.clientY-drag.sy) < 4) return;
    if(!drag.moved){ snapshot(); drag.moved = true; }
    const lead = drag.items.find(it => it.id===drag.lead); if(!lead) return;
    const w = toWorld(e.clientX, e.clientY);
    const dx = Math.round((lead.ox + w.x - drag.w0.x)/10)*10 - lead.ox, dy = Math.round((lead.oy + w.y - drag.w0.y)/10)*10 - lead.oy;
    drag.items.forEach(it => {
      const n = nodeById(it.id); if(!n) return;
      n.x = it.ox + dx; n.y = it.oy + dy;
      const el = nodesEl.querySelector(`[data-node="${n.id}"]`);
      if(el){ el.style.left=n.x+"px"; el.style.top=n.y+"px"; el.classList.add("dragging"); }
    });
    renderEdges(); return;
  }
  if(drag.kind==="marquee"){
    if(!drag.moved && Math.hypot(e.clientX-drag.sx, e.clientY-drag.sy) < 4) return;
    drag.moved = true;
    const r = board.getBoundingClientRect();
    Object.assign(marqueeEl.style, {left:Math.min(drag.sx, e.clientX)-r.left+"px", top:Math.min(drag.sy, e.clientY)-r.top+"px",
      width:Math.abs(e.clientX-drag.sx)+"px", height:Math.abs(e.clientY-drag.sy)+"px"});
    marqueeEl.classList.remove("hide");
    const w = toWorld(e.clientX, e.clientY);
    const x0 = Math.min(w.x, drag.w0.x), x1 = Math.max(w.x, drag.w0.x), y0 = Math.min(w.y, drag.w0.y), y1 = Math.max(w.y, drag.w0.y);
    const hit = cur().nodes.filter(n => n.x < x1 && n.x+n.w > x0 && n.y < y1 && n.y+n.h > y0).map(n => n.id);
    const ids = new Set([...drag.base, ...hit]);
    drag.ids = [...ids];
    nodesEl.querySelectorAll("[data-node]").forEach(el => el.classList.toggle("sel", ids.has(el.dataset.node)));
    return;
  }
  if(drag.kind==="link"){
    const A = nodeById(drag.from), w = toWorld(e.clientX, e.clientY);
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const tgtEl = over && over.closest("[data-node]");
    nodesEl.querySelectorAll(".drop").forEach(x=>x.classList.remove("drop"));
    let B = null;
    if(tgtEl && tgtEl.dataset.node!==drag.from){ tgtEl.classList.add("drop"); B = nodeById(tgtEl.dataset.node); }
    const a = port(A, B ? center(B) : w), b = B ? port(B, center(A)) : {x:w.x, y:w.y};
    renderEdges(curve(a,b).d);
  }
});
function endPointer(e){
  pointers.delete(e.pointerId);
  if(!drag) return;
  const d = drag;
  if(d.kind==="pinch"){ if(pointers.size<2) drag=null; return; }
  drag = null;
  board.classList.remove("panning");
  if(d.kind==="pan"){
    if(d.button === 2 && d.moved) noCtxMenu = true;
    if(!d.moved && e.type==="pointerup" && d.button === 0 && (sel || multi.size)){ clearSel(); renderSelOnly(); }
  }
  if(d.kind==="marquee"){
    marqueeEl.classList.add("hide");
    if(e.type !== "pointerup"){ renderSelOnly(); }
    else if(d.moved){ selectNodes(d.ids || d.base); renderSelOnly(); }
    else if(!d.add && (sel || multi.size)){ clearSel(); renderSelOnly(); }  // plain click on the background
  }
  if(d.kind==="move"){
    if(d.moved){ touch(currentId); render(); }
    else if(d.items.length > 1 && e.type==="pointerup"){ selectNodes([d.lead]); renderSelOnly(); } // click inside a group: keep just that box
  }
  if(d.kind==="link"){
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const tgt = over && over.closest("[data-node]");
    if(tgt && tgt.dataset.node!==d.from && e.type==="pointerup") addEdge(d.from, tgt.dataset.node);
    else render();
  }
}
board.addEventListener("pointerup", endPointer);
board.addEventListener("pointercancel", endPointer);
board.addEventListener("contextmenu", e => { if(noCtxMenu){ e.preventDefault(); noCtxMenu = false; } });

/* ---------- zoom ---------- */
function clampK(k){ return Math.min(2.5, Math.max(.2, k)); }
function zoomAt(k, cx, cy){
  const v = view(), nk = clampK(k);
  v.x = cx - (cx - v.x) * nk/v.k; v.y = cy - (cy - v.y) * nk/v.k; v.k = nk; applyView();
}
board.addEventListener("wheel", e => {
  e.preventDefault();
  const r = board.getBoundingClientRect(), v = view();
  if(e.ctrlKey || e.metaKey){ zoomAt(v.k * Math.exp(-e.deltaY*0.0022), e.clientX-r.left, e.clientY-r.top); }
  else { v.x -= e.deltaX; v.y -= e.deltaY; applyView(); }
}, {passive:false});
function zoomCenter(f){ const r = board.getBoundingClientRect(); zoomAt(view().k*f, r.width/2, r.height/2); }
$("zIn").onclick = () => zoomCenter(1.2);
$("zOut").onclick = () => zoomCenter(1/1.2);
$("zFit").onclick = () => fit();
function fit(quiet){
  const d = cur(), r = board.getBoundingClientRect(), v = view();
  if(!r.width){ return; }
  if(!d.nodes.length){ v.k=1; v.x=r.width/2-200; v.y=r.height/2-150; applyView(); return; }
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  d.nodes.forEach(n=>{ x0=Math.min(x0,n.x); y0=Math.min(y0,n.y); x1=Math.max(x1,n.x+n.w); y1=Math.max(y1,n.y+n.h); });
  const padL = innerWidth>640 ? 150 : 30, pad = 30;
  const k = clampK(Math.min((r.width-padL-pad)/(x1-x0), (r.height-pad*2-40)/(y1-y0), 1.15));
  v.k = k; v.x = padL + (r.width-padL-pad - (x1-x0)*k)/2 - x0*k; v.y = pad+30 + (r.height-pad*2-40 - (y1-y0)*k)/2 - y0*k;
  applyView();
}

/* ---------- navigation clicks ---------- */
document.addEventListener("click", e => {
  const g = e.target.closest("[data-go]"); if(g) go(g.dataset.go);
});
$("toggleTree").onclick = () => app.classList.toggle("no-tree");
$("undoBtn").onclick = doUndo;

/* ---------- keyboard ---------- */
document.addEventListener("keydown", e => {
  if(!$("modal").classList.contains("hide")){ if(e.key==="Escape") closeModal(); return; }
  if(e.key === "Escape") closePop();
  if(!me || app.classList.contains("hide") || mode !== "doc") return;
  const typing = e.target.matches("input,textarea,select");
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="z" && !typing){ e.preventDefault(); doUndo(); return; }
  if(typing){ if(e.key==="Escape") e.target.blur(); return; }
  if(e.key===" " && !e.target.closest("button")){ e.preventDefault(); if(!spaceDown){ spaceDown = true; board.classList.add("grab"); } return; }
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="a"){ e.preventDefault(); selectNodes(cur().nodes.map(n => n.id)); renderSelOnly(); return; }
  if(e.key==="Delete" || e.key==="Backspace"){ if(sel || multi.size){ e.preventDefault(); deleteSelection(); } }
  else if(e.key==="Enter"){ if(sel && sel.kind==="node") enter(sel.id); }
  else if(e.key==="Escape"){ if(sel || multi.size){ clearSel(); render(); } else up(); }
  else if(e.key==="+"||e.key==="="){ zoomCenter(1.2); }
  else if(e.key==="-"){ zoomCenter(1/1.2); }
});

document.addEventListener("keyup", e => { if(e.key===" "){ spaceDown = false; board.classList.remove("grab"); } });
addEventListener("blur", () => { spaceDown = false; board.classList.remove("grab"); });

/* ---------- toast ---------- */
function showToast(msg, actions){
  const t = $("toast");
  t.innerHTML = `<span>${esc(msg)}</span>` + actions.map((a,i)=>`<button data-i="${i}" class="${a.cls||""}">${esc(a.t)}</button>`).join("");
  t.classList.remove("hide");
  t.onclick = ev => { const b = ev.target.closest("button"); if(!b) return; t.classList.add("hide"); const a = actions[+b.dataset.i]; a.fn && a.fn(); };
}

/* ---------- export / import ---------- */
function saveFile(name, text){
  const url = URL.createObjectURL(new Blob([text], {type:"application/json"}));
  const a = document.createElement("a"); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const fileSlug = s => String(s || "diagrama").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 60) || "diagrama";
function exportSheets(name, sheets){
  const data = JSON.stringify({app:"camadas", version:1, name, exportedAt:new Date().toISOString(), diagrams:sheets}, null, 2);
  saveFile(`${fileSlug(name)}-${new Date().toISOString().slice(0,10)}.json`, data);
}
function doExport(){ if(docMeta) exportSheets(diagName(diagrams.root), diagrams); }
async function exportDoc(id){
  try{
    const r = await api("GET", "api/docs/" + id), sheets = {};
    r.sheets.forEach(s => { sheets[s.id] = JSON.parse(s.data); });
    exportSheets(r.doc.name, sheets);
  }catch(e){ showToast(e.message, [{t:"OK"}]); }
}
$("exportBtn").onclick = doExport;
// Importing always creates a new diagram (in the project being viewed, when possible).
$("importFile").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if(!f) return;
  closeMenu();
  let o;
  try{ o = JSON.parse(await f.text()); if(!o.diagrams || !o.diagrams.root) throw 0; }
  catch(_){ showToast("Esse ficheiro não é uma exportação válida do Camadas.", [{t:"OK"}]); return; }
  try{
    const folder = mode === "home" ? currentFolder() : null;
    const r = await api("POST", "api/docs", {name:o.name || o.diagrams.root.name, sheets:o.diagrams,
      folderId: folder && folder.role !== "view" ? folder.id : null});
    location.hash = "#/d/" + r.id;
    showToast(`“${f.name}” importado como um diagrama novo.`, [{t:"OK"}]);
  }catch(err){ showToast("Não foi possível importar: " + err.message, [{t:"OK"}]); }
});

/* ---------- library: projects and diagrams ---------- */
let lib = {folders:[], docs:[]};
let homeView = "recent";     // recent | none | shared | p<ID>
const ROLE_TXT = {owner:"Dono", edit:"Pode editar", view:"Só pode ver"};
const who = u => u ? (u.name || u.email) : "";
function currentFolder(){ return homeView[0] === "p" ? lib.folders.find(f => "p" + f.id === homeView) || null : null; }
function ago(t){
  const s = (Date.now() - t) / 1000;
  if(s < 60) return "agora mesmo";
  if(s < 3600) return `há ${Math.round(s/60)} min`;
  if(s < 86400) return `há ${Math.round(s/3600)} h`;
  if(s < 86400*7) return `há ${Math.round(s/86400)} dias`;
  return new Date(t).toLocaleDateString("pt-PT", {day:"2-digit", month:"short", year:"numeric"});
}
async function loadLibrary(){
  try{ lib = await api("GET", "api/library"); }
  catch(e){ if(e.status !== 401) showToast(e.message, [{t:"OK"}]); return; }
  if(homeView[0] === "p" && !currentFolder()) homeView = "recent";
  renderHome();
}
function sharedDocs(){ return lib.docs.filter(d => d.role !== "owner" && !lib.folders.some(f => f.id === d.folderId)); }
function viewDocs(){
  if(homeView === "recent") return lib.docs;
  if(homeView === "none") return lib.docs.filter(d => d.role === "owner" && !d.folderId);
  if(homeView === "shared") return sharedDocs();
  const f = currentFolder(); return f ? lib.docs.filter(d => d.folderId === f.id) : [];
}
const ICON = {
  folder:'<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.2h9A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z"/>',
  clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  inbox:'<path d="M3 13.5 5.5 5h13l2.5 8.5V19H3Z"/><path d="M3 13.5h5l1.5 2.5h5l1.5-2.5h5"/>',
  share:'<circle cx="17.5" cy="6" r="2.5"/><circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="18" r="2.5"/><path d="m8.7 10.8 6.6-3.6M8.7 13.2l6.6 3.6"/>',
  users:'<circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M15.5 5.2a3.2 3.2 0 0 1 0 6M17.5 13.8c2 .7 3.5 2.6 3.5 5.2"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  dots:'<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
};
const ico = (k, sz = 16) => `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;
function navItem(v, icon, label, count, extra = ""){
  return `<button class="hitem${homeView===v?" on":""}" data-view="${v}">${ico(icon)}<span class="nm">${esc(label)}</span>${extra}<span class="ct">${count}</span></button>`;
}
function renderHome(){
  const mine = lib.folders.filter(f => f.role === "owner"), theirs = lib.folders.filter(f => f.role !== "owner");
  const cnt = f => lib.docs.filter(d => d.folderId === f.id).length;
  $("hnav").innerHTML =
    navItem("recent", "clock", "Recentes", lib.docs.length) +
    navItem("none", "inbox", "Sem projeto", lib.docs.filter(d => d.role === "owner" && !d.folderId).length) +
    `<div class="hsec">Projetos</div>` +
    mine.map(f => navItem("p"+f.id, "folder", f.name, cnt(f), f.shares ? `<span class="shr" title="Partilhado com ${f.shares} ${f.shares>1?"pessoas":"pessoa"}">${ico("users",13)}</span>` : "")).join("") +
    `<button class="hitem add" id="hNewFolder">${ico("plus")}<span class="nm">Novo projeto</span></button>` +
    (theirs.length || sharedDocs().length ? `<div class="hsec">Partilhados comigo</div>` +
      (sharedDocs().length ? navItem("shared", "share", "Diagramas", sharedDocs().length) : "") +
      theirs.map(f => navItem("p"+f.id, "folder", f.name, cnt(f), `<span class="from">${esc(who(f.owner))}</span>`)).join("") : "");

  const f = currentFolder();
  if(homeView[0] === "p" && !f){ $("hmain").innerHTML = `<p class="muted">A carregar…</p>`; return; }
  const title = homeView === "recent" ? "Recentes" : homeView === "none" ? "Sem projeto" : homeView === "shared" ? "Partilhados comigo" : f.name;
  const sub = homeView === "recent" ? "Todos os diagramas a que tem acesso, do mais recente para o mais antigo."
    : homeView === "none" ? "Os seus diagramas que não estão em nenhum projeto."
    : homeView === "shared" ? "Diagramas que outras pessoas partilharam consigo."
    : f.role === "owner" ? (f.shares ? `Projeto partilhado com ${f.shares} ${f.shares>1?"pessoas":"pessoa"}.` : "Projeto só seu.")
    : `Projeto de ${esc(who(f.owner))} · ${ROLE_TXT[f.role].toLowerCase()}`;
  const canCreate = homeView !== "shared" && (!f || f.role !== "view");
  const docs = viewDocs();
  $("hmain").innerHTML = `
    <div class="hhead">
      <div class="htitle"><h1>${esc(title)}</h1><p>${sub}</p></div>
      <div class="hacts">
        ${f ? `<button class="tbtn" id="hShareFolder">${ico("users")}${f.role === "owner" ? "Partilhar" : "Pessoas"}</button>` : ""}
        ${f ? `<button class="tbtn icon-only" id="hFolderMenu" title="Mais opções" aria-label="Mais opções do projeto">${ico("dots")}</button>` : ""}
        ${canCreate ? `<button class="tbtn primary" id="hNewDoc">${ico("plus")}Novo diagrama</button>` : ""}
      </div>
    </div>
    ${docs.length ? `<div class="cards">${docs.map(card).join("")}</div>`
      : `<div class="hempty"><b>${homeView === "shared" ? "Ainda ninguém partilhou diagramas consigo" : "Nenhum diagrama aqui"}</b>
          ${canCreate ? `Crie um diagrama novo ou importe um ficheiro exportado.<div class="row"><button class="tbtn primary" data-act="new">${ico("plus")}Novo diagrama</button><label class="tbtn" for="importFile" tabindex="0">Importar ficheiro</label></div>` : ""}</div>`}`;
}
function card(d){
  const folder = lib.folders.find(f => f.id === d.folderId);
  const tags = [];
  if(d.role !== "owner") tags.push(`<span class="tag">de ${esc(who(d.owner))}</span>`, d.role === "view" ? `<span class="tag">só ver</span>` : "");
  else if(d.shares) tags.push(`<span class="tag shared">${ico("users",11)} ${d.shares}</span>`);
  if(folder && homeView === "recent") tags.push(`<span class="tag">${ico("folder",11)} ${esc(folder.name)}</span>`);
  const by = d.updatedBy && d.updatedBy.id !== me.id ? ` por ${esc(who(d.updatedBy))}` : "";
  return `<div class="card" data-doc="${d.id}">
    <a class="copen" href="#/d/${d.id}" aria-label="Abrir ${esc(d.name)}"></a>
    <div class="cthumb"><span></span><span></span><span></span></div>
    <div class="cbody">
      <b class="cname">${esc(d.name)}</b>
      <span class="cmeta">${d.sheets} ${d.sheets === 1 ? "nível" : "níveis"} · editado ${ago(d.updatedAt)}${by}</span>
      ${tags.length ? `<span class="ctags">${tags.join("")}</span>` : ""}
    </div>
    <button class="cmenu" data-docmenu="${d.id}" title="Opções" aria-label="Opções de ${esc(d.name)}">${ico("dots")}</button>
  </div>`;
}
async function newDoc(){
  const f = currentFolder();
  try{
    const r = await api("POST", "api/docs", {name:"Novo diagrama", folderId: f && f.role !== "view" ? f.id : null});
    location.hash = "#/d/" + r.id;
  }catch(e){ showToast(e.message, [{t:"OK"}]); }
}
$("home").addEventListener("click", async e => {
  const t = e.target;
  const v = t.closest("[data-view]"); if(v){ location.hash = v.dataset.view === "recent" ? "#/" : "#/" + (v.dataset.view[0] === "p" ? "p/" + v.dataset.view.slice(1) : v.dataset.view); return; }
  if(t.closest("#hNewDoc") || t.closest('[data-act="new"]')) return newDoc();
  if(t.closest("#hNewFolder")){
    const name = await askText("Novo projeto", "Nome do projeto", "", "Criar");
    if(name == null) return;
    try{ const r = await api("POST", "api/folders", {name}); await loadLibrary(); location.hash = "#/p/" + r.id; }
    catch(err){ showToast(err.message, [{t:"OK"}]); }
    return;
  }
  const f = currentFolder();
  if(t.closest("#hShareFolder") && f) return openShare("folder", f.id, f.name);
  const fm = t.closest("#hFolderMenu");
  if(fm && f){
    popMenu(fm, f.role === "owner" ? [
      {t:"Mudar o nome", fn: async () => { const n = await askText("Mudar o nome do projeto", "Nome", f.name, "Guardar"); if(n != null) act(() => api("PATCH", "api/folders/"+f.id, {name:n})); }},
      {t:"Partilhar", fn: () => openShare("folder", f.id, f.name)},
      {t:"Apagar projeto", cls:"danger", fn: async () => {
        if(await askConfirm("Apagar projeto", `Apagar o projeto “${f.name}”? Os diagramas não são apagados: passam para “Sem projeto”. Quem tinha acesso pelo projeto deixa de o ter.`, "Apagar projeto"))
          act(() => api("DELETE", "api/folders/"+f.id), "#/");
      }},
    ] : [
      {t:"Ver quem tem acesso", fn: () => openShare("folder", f.id, f.name)},
      {t:"Sair deste projeto", cls:"danger", fn: async () => {
        if(await askConfirm("Sair do projeto", `Deixar de ter acesso ao projeto “${f.name}” de ${who(f.owner)}?`, "Sair"))
          act(() => api("DELETE", `api/shares/folder/${f.id}/${me.id}`), "#/");
      }},
    ]);
    return;
  }
  const dm = t.closest("[data-docmenu]");
  if(dm){ e.preventDefault(); docMenu(dm, lib.docs.find(d => d.id === +dm.dataset.docmenu)); }
});
async function act(fn, hash){
  try{ await fn(); if(hash != null && location.hash !== hash) location.hash = hash; await loadLibrary(); }
  catch(e){ showToast(e.message, [{t:"OK"}]); }
}
function docMenu(anchor, d){
  if(!d) return;
  const direct = d.role !== "owner" && !lib.folders.some(f => f.id === d.folderId);
  const items = [{t:"Abrir", fn: () => { location.hash = "#/d/" + d.id; }}];
  if(d.role !== "view") items.push({t:"Mudar o nome", fn: async () => {
    const n = await askText("Mudar o nome do diagrama", "Nome", d.name, "Guardar"); if(n != null) act(() => api("PATCH", "api/docs/"+d.id, {name:n}));
  }});
  if(d.role === "owner"){
    items.push({t:"Mover para projeto…", fn: () => moveDoc(d)});
    items.push({t:"Partilhar", fn: () => openShare("doc", d.id, d.name)});
  } else items.push({t:"Ver quem tem acesso", fn: () => openShare("doc", d.id, d.name)});
  items.push({t:"Duplicar", fn: () => act(() => api("POST", `api/docs/${d.id}/duplicate`))});
  items.push({t:"Exportar (JSON)", fn: () => exportDoc(d.id)});
  if(d.role === "owner") items.push({t:"Apagar", cls:"danger", fn: async () => {
    if(await askConfirm("Apagar diagrama", `Apagar “${d.name}” e todos os seus níveis?${d.shares ? " As pessoas com quem está partilhado deixam de o ver." : ""} Não é possível desfazer.`, "Apagar"))
      act(() => api("DELETE", "api/docs/"+d.id));
  }});
  else if(direct) items.push({t:"Sair da partilha", cls:"danger", fn: async () => {
    if(await askConfirm("Sair da partilha", `Deixar de ter acesso a “${d.name}”?`, "Sair")) act(() => api("DELETE", `api/shares/doc/${d.id}/${me.id}`));
  }});
  popMenu(anchor, items);
}
async function moveDoc(d){
  const mine = lib.folders.filter(f => f.role === "owner");
  openModal(`<h3>Mover “${esc(d.name)}”</h3>
    <form id="mvForm" class="mform">
      <div class="field"><label for="mv-f">Projeto</label><select id="mv-f">
        <option value="">Sem projeto</option>
        ${mine.map(f => `<option value="${f.id}"${f.id === d.folderId ? " selected" : ""}>${esc(f.name)}</option>`).join("")}
        <option value="__new">+ Novo projeto…</option>
      </select></div>
      <div class="field hide" id="mv-new-row"><label for="mv-new">Nome do novo projeto</label><input id="mv-new" maxlength="120"></div>
      <p class="muted small">Quem tem acesso ao projeto de destino passa a ter acesso a este diagrama.</p>
      <p class="ferr" id="mv-err"></p>
      <div class="mactions"><button type="button" class="tbtn" data-close>Cancelar</button><button class="pbig" type="submit">Mover</button></div>
    </form>`);
  $("mv-f").onchange = () => $("mv-new-row").classList.toggle("hide", $("mv-f").value !== "__new");
  $("mvForm").onsubmit = async e => {
    e.preventDefault();
    try{
      let v = $("mv-f").value;
      if(v === "__new") v = (await api("POST", "api/folders", {name:$("mv-new").value})).id;
      await api("PATCH", "api/docs/"+d.id, {folderId: v ? +v : null});
      closeModal(); await loadLibrary();
    }catch(ex){ $("mv-err").textContent = ex.message; }
  };
}

/* ---------- sharing ---------- */
async function openShare(kind, id, name){
  closeMenu();
  openModal(`<h3>${kind === "folder" ? "Partilhar projeto" : "Partilhar diagrama"} “${esc(name)}”</h3><div id="shBody"><p class="muted">A carregar…</p></div>`);
  let data;
  try{ data = await api("GET", `api/shares/${kind}/${id}`); }
  catch(e){ $("shBody").innerHTML = `<p class="ferr">${esc(e.message)}</p>`; return; }
  const owner = data.role === "owner";
  if(!owner) $("modalBody").querySelector("h3").textContent = `Pessoas com acesso a “${name}”`;
  const link = `${location.origin}${location.pathname}#/${kind === "folder" ? "p" : "d"}/${id}`;
  const draw = () => {
    const rows = [{...data.owner, role:"owner"}, ...data.shares];
    $("shBody").innerHTML = `
      <p class="muted small">${kind === "folder"
        ? "Quem tiver acesso ao projeto vê todos os diagramas que ele contém, incluindo os que forem criados depois."
        : "As pessoas com acesso veem as alterações umas das outras em poucos segundos."} Só pode partilhar com utilizadores já registados.</p>
      ${owner ? `<form id="shForm" class="shform">
        <input id="sh-email" type="email" placeholder="Email da pessoa" required autocomplete="off">
        <select id="sh-role"><option value="edit">Pode editar</option><option value="view">Só pode ver</option></select>
        <button class="pbig" type="submit">Partilhar</button>
      </form><p class="ferr" id="sh-err"></p>` : ""}
      <div class="shlist">${rows.map(u => `<div class="shrow">
        <span class="avatar sm" data-s="background:${avColor(u.userId)}">${esc(initials(u))}</span>
        <div class="shwho"><b>${esc(u.name || u.email)}</b>${u.userId === me.id ? ' <span class="tag you">você</span>' : ""}<br><span class="muted">${esc(u.email)}</span></div>
        ${u.role === "owner" ? `<span class="muted">Dono</span>`
          : owner ? `<select data-role="${u.userId}"><option value="edit"${u.role==="edit"?" selected":""}>Pode editar</option><option value="view"${u.role==="view"?" selected":""}>Só pode ver</option></select>
                     <button class="tbtn danger" data-unshare="${u.userId}" title="Retirar acesso">Retirar</button>`
          : u.userId === me.id ? `<span class="muted">${ROLE_TXT[u.role]}</span><button class="tbtn danger" data-unshare="${u.userId}">Sair</button>`
          : `<span class="muted">${ROLE_TXT[u.role]}</span>`}
      </div>`).join("")}</div>
      ${!owner && !data.shares.some(s => s.userId === me.id) && kind === "doc" ? `<p class="muted small">Tem acesso a este diagrama através do projeto onde ele está.</p>` : ""}
      <div class="mactions shacts"><button type="button" class="tbtn" id="shCopy">Copiar link</button><span class="grow"></span><button type="button" class="tbtn" data-close>Fechar</button></div>`;
    if(owner){
      $("shForm").onsubmit = async e => {
        e.preventDefault(); $("sh-err").textContent = "";
        try{ data.shares = (await api("POST", `api/shares/${kind}/${id}`, {email:$("sh-email").value.trim(), role:$("sh-role").value})).shares; draw(); changed(); $("sh-email").focus(); }
        catch(ex){ $("sh-err").textContent = ex.message; }
      };
    }
  };
  const changed = () => { if(mode === "home") loadLibrary(); };
  draw();
  $("shBody").onchange = async e => {
    const s = e.target.closest("[data-role]"); if(!s) return;
    const u = data.shares.find(x => x.userId === +s.dataset.role);
    try{ data.shares = (await api("POST", `api/shares/${kind}/${id}`, {email:u.email, role:s.value})).shares; draw(); }
    catch(ex){ showToast(ex.message, [{t:"OK"}]); }
  };
  $("shBody").onclick = async e => {
    if(e.target.closest("#shCopy")){
      try{ await navigator.clipboard.writeText(link); showToast("Link copiado. Só funciona para quem tem acesso.", [{t:"OK"}]); }
      catch(_){ showToast(link, [{t:"OK"}]); }
      return;
    }
    const b = e.target.closest("[data-unshare]"); if(!b) return;
    const uid = +b.dataset.unshare;
    try{
      data.shares = (await api("DELETE", `api/shares/${kind}/${id}/${uid}`)).shares;
      if(uid === me.id){ closeModal(); location.hash = "#/"; loadLibrary(); return; }
      draw(); changed();
    }catch(ex){ showToast(ex.message, [{t:"OK"}]); }
  };
}

/* ---------- small dialogs and menus ---------- */
function askText(title, label, value, ok){
  return new Promise(resolve => {
    openModal(`<h3>${esc(title)}</h3><form id="askForm" class="mform">
      <div class="field"><label for="ask-v">${esc(label)}</label><input id="ask-v" maxlength="120" value="${esc(value)}"></div>
      <div class="mactions"><button type="button" class="tbtn" data-close>Cancelar</button><button class="pbig" type="submit">${esc(ok)}</button></div></form>`, () => resolve(null));
    setTimeout(() => $("ask-v") && $("ask-v").select(), 40);
    $("askForm").onsubmit = e => { e.preventDefault(); const v = $("ask-v").value.trim(); if(!v) return; closeModal(true); resolve(v); };
  });
}
function askConfirm(title, text, ok){
  return new Promise(resolve => {
    openModal(`<h3>${esc(title)}</h3><p class="mtext">${esc(text)}</p>
      <div class="mactions"><button type="button" class="tbtn" data-close>Cancelar</button><button class="pbig danger" id="askOk">${esc(ok)}</button></div>`, () => resolve(false));
    $("askOk").onclick = () => { closeModal(true); resolve(true); };
    setTimeout(() => $("askOk") && $("askOk").focus(), 40);
  });
}
function popMenu(anchor, items){
  const p = $("pop");
  p.innerHTML = items.map((it, i) => `<button role="menuitem" data-i="${i}" class="${it.cls||""}">${esc(it.t)}</button>`).join("");
  p.classList.remove("hide");
  const r = anchor.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight;
  p.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + "px";
  p.style.top = (r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6) + "px";
  p.onclick = e => { const b = e.target.closest("[data-i]"); if(!b) return; closePop(); items[+b.dataset.i].fn(); };
}
function closePop(){ $("pop").classList.add("hide"); }
document.addEventListener("pointerdown", e => { if(!e.target.closest("#pop") && !e.target.closest("[data-docmenu],#hFolderMenu")) closePop(); });

/* ---------- presence: who else has this diagram open ---------- */
const AV_COLORS = ["var(--l1)","var(--l2)","var(--l3)","var(--l4)"];
const avColor = id => AV_COLORS[(Number(id) || 0) % AV_COLORS.length];
function renderPresence(){
  const el = $("presence");
  el.innerHTML = others.slice(0, 4).map(u => `<span class="avatar sm2" title="${esc(who(u))} também está aqui" data-s="background:${avColor(u.id)}">${esc(initials(u))}</span>`).join("")
    + (others.length > 4 ? `<span class="avatar sm2 more">+${others.length - 4}</span>` : "");
  el.title = others.length ? others.map(who).join(", ") + (others.length > 1 ? " também estão" : " também está") + " a ver este diagrama" : "";
}

/* ---------- screens and routing ---------- */
function showHome(){
  mode = "home";
  $("boot").classList.add("hide"); $("auth").classList.add("hide"); app.classList.remove("hide");
  app.classList.add("mode-home"); app.classList.remove("ro");
  document.title = appCfg.appName || "Camadas";
  $("crumbs").innerHTML = ""; $("presence").innerHTML = "";
  renderHome();
}
function showDoc(){
  mode = "doc";
  app.classList.remove("mode-home"); app.classList.toggle("ro", isReadOnly);
  document.title = `${diagName(diagrams.root)} · ${appCfg.appName || "Camadas"}`;
  $("shareBtn").querySelector("span").textContent = docMeta.role === "owner" ? "Partilhar" : "Pessoas";
  renderPresence(); setStatus(); render();
}
let routing = Promise.resolve();
function route(){ routing = routing.then(doRoute, doRoute); }
async function doRoute(){
  if(!me) return;
  const h = location.hash;
  const m = h.match(/^#\/d\/(\d+)/);
  if(m){ await openDoc(+m[1]); return; }
  if(docMeta && !(await closeDoc())){ history.replaceState(null, "", "#/d/" + docMeta.id); return; }
  const p = h.match(/^#\/(p\/(\d+)|none|shared)/);
  homeView = !p ? "recent" : p[2] ? "p" + p[2] : p[1];
  showHome();
  await loadLibrary();
}
addEventListener("hashchange", route);
$("homeBtn").onclick = () => { location.hash = docMeta && docMeta.folderId && lib.folders.some(f => f.id === docMeta.folderId) ? "#/p/" + docMeta.folderId : "#/"; };
$("brandBtn").onclick = () => { location.hash = "#/"; };
$("brandBtn").onkeydown = e => { if(e.key === "Enter") location.hash = "#/"; };
$("shareBtn").onclick = () => { if(docMeta) openShare("doc", docMeta.id, diagName(diagrams.root)); };

/* ---------- accounts: sign in / register ---------- */
let authMode = "login";
function initials(u){ const n = (u.name || u.email || "?").trim(); const p = n.split(/[\s@.]+/).filter(Boolean); return ((p[0]||"?")[0] + (p[1]? p[1][0] : "")).toUpperCase(); }
function showApp(){
  $("boot").classList.add("hide"); $("auth").classList.add("hide"); app.classList.remove("hide");
  $("avatar").textContent = initials(me);
  $("avatar").style.background = avColor(me.id);
  $("userName").textContent = me.name || me.email;
  $("menuWho").textContent = me.email;
  $("mUsers").classList.toggle("hide", !me.isAdmin);
}
function showAuth(mode, note){
  authMode = mode === "register" && appCfg.allowRegistration ? "register" : "login";
  $("boot").classList.add("hide"); app.classList.add("hide"); closeMenu(); closeModal();
  $("auth").classList.remove("hide");
  $("authTitle").textContent = authMode === "login" ? "Entrar" : "Criar conta";
  $("authSubmit").textContent = authMode === "login" ? "Entrar" : "Criar conta";
  $("nameRow").classList.toggle("hide", authMode === "login");
  $("authSwitch").classList.toggle("hide", !appCfg.allowRegistration);
  $("authSwitch").innerHTML = authMode === "login"
    ? `Ainda não tem conta? <button type="button" class="linkbtn" data-auth="register">Criar conta</button>`
    : `Já tem conta? <button type="button" class="linkbtn" data-auth="login">Entrar</button>`;
  $("a-pass").autocomplete = authMode === "login" ? "current-password" : "new-password";
  $("authNote").textContent = note || "";
  $("authNote").classList.toggle("hide", !note);
  $("authErr").textContent = "";
  setTimeout(() => ($("a-email").value ? $("a-pass") : $("a-email")).focus(), 30);
}
let lastUserId = null;
function sessionExpired(){
  if(!me) return;
  lastUserId = me.id; me = null;
  showAuth("login", "A sessão terminou. Entre de novo para continuar — as alterações por guardar ficam à espera.");
}
$("auth").addEventListener("click", e => { const b = e.target.closest("[data-auth]"); if(b) showAuth(b.dataset.auth); });
$("authForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("authSubmit"); btn.disabled = true; $("authErr").textContent = "";
  try{
    const body = {email:$("a-email").value.trim(), password:$("a-pass").value};
    if(authMode === "register") body.name = $("a-name").value.trim();
    const r = await api("POST", authMode === "login" ? "api/auth/login" : "api/auth/register", body);
    $("a-pass").value = "";
    me = r.user;
    showApp();
    if(lastUserId === me.id && docMeta){ showDoc(); flush(); }   // same person again: keep unsaved edits
    else { docMeta = null; pending.clear(); deleted.clear(); route(); }
    lastUserId = me.id;
  }catch(err){ $("authErr").textContent = err.message; }
  finally{ btn.disabled = false; }
});

/* ---------- user menu ---------- */
function closeMenu(){ $("userDrop").classList.add("hide"); $("userBtn").setAttribute("aria-expanded","false"); }
$("userBtn").onclick = e => { e.stopPropagation(); const h = $("userDrop").classList.toggle("hide"); $("userBtn").setAttribute("aria-expanded", String(!h)); };
document.addEventListener("pointerdown", e => { if(!e.target.closest(".umenu")) closeMenu(); });
$("mExport").onclick = () => { closeMenu(); doExport(); };
$("mLogout").onclick = async () => {
  closeMenu();
  await saveAll();
  try{ await api("POST", "api/auth/logout"); }catch(e){}
  me = null; lastUserId = null; docMeta = null; diagrams = {root:newRoot()}; bases = {}; pending.clear(); deleted.clear(); undo.length = 0;
  lib = {folders:[], docs:[]};
  showAuth("login");
};
$("mPass").onclick = () => { closeMenu(); openProfile(); };
$("mUsers").onclick = () => { closeMenu(); openUsers(); };

/* ---------- modal ---------- */
let modalCancel = null;
function openModal(html, onCancel){
  if(modalCancel){ const c = modalCancel; modalCancel = null; c(); }
  closePop();
  $("modalBody").innerHTML = html; $("modal").classList.remove("hide"); modalCancel = onCancel || null;
  const f = $("modalBody").querySelector("input:not([disabled])"); if(f) setTimeout(()=>f.focus(), 30);
}
function closeModal(silent){
  const c = modalCancel; modalCancel = null;
  $("modal").classList.add("hide"); $("modalBody").innerHTML = "";
  if(c && silent !== true) c();
}
$("modal").addEventListener("pointerdown", e => { if(e.target === $("modal")) closeModal(); });
$("modal").addEventListener("click", e => { if(e.target.closest("[data-close]")) closeModal(); });

function openProfile(){
  openModal(`<h3>Perfil e password</h3>
    <form id="profForm" class="mform">
      <div class="field"><label for="p-name">Nome</label><input id="p-name" value="${esc(me.name)}" maxlength="120" autocomplete="name"></div>
      <div class="field"><label>Email</label><input value="${esc(me.email)}" disabled></div>
      <div class="sub-h">Mudar password <span>(deixe em branco para manter)</span></div>
      <div class="field"><label for="p-cur">Password atual</label><input id="p-cur" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="p-new">Nova password</label><input id="p-new" type="password" autocomplete="new-password" minlength="8" placeholder="Pelo menos 8 caracteres"></div>
      <div class="field"><label for="p-new2">Repetir nova password</label><input id="p-new2" type="password" autocomplete="new-password"></div>
      <p class="ferr" id="p-err"></p>
      <div class="mactions"><button type="button" class="tbtn" data-close>Cancelar</button><button class="pbig" type="submit" id="p-save">Guardar</button></div>
    </form>`);
  $("profForm").addEventListener("submit", async e => {
    e.preventDefault(); const err = $("p-err"); err.textContent = "";
    const name = $("p-name").value.trim(), cur = $("p-cur").value, n1 = $("p-new").value, n2 = $("p-new2").value;
    if(n1 || cur){
      if(n1 !== n2){ err.textContent = "As duas passwords novas não são iguais."; return; }
      if(n1.length < 8){ err.textContent = "A nova password tem de ter pelo menos 8 caracteres."; return; }
    }
    try{
      if(name !== (me.name||"")){ const r = await api("PATCH", "api/auth/profile", {name}); me = r.user; showApp(); }
      if(n1){ await api("POST", "api/auth/password", {current:cur, password:n1}); }
      closeModal(); showToast(n1 ? "Password alterada. As outras sessões foram terminadas." : "Perfil guardado.", [{t:"OK"}]);
    }catch(ex){ err.textContent = ex.message; }
  });
}

/* ---------- admin: users ---------- */
let usersCache = [], userAction = null;
const fmtDate = d => d ? new Date(d).toLocaleDateString("pt-PT", {day:"2-digit", month:"short", year:"numeric"}) : "—";
async function openUsers(){
  openModal(`<h3>Utilizadores</h3><div id="uList" class="ulist"><p class="muted">A carregar…</p></div>
    <form id="uNew" class="mform unew">
      <div class="sub-h">Criar conta</div>
      <div class="grid2">
        <div class="field"><label for="u-email">Email</label><input id="u-email" type="email" required autocomplete="off"></div>
        <div class="field"><label for="u-name">Nome</label><input id="u-name" maxlength="120" autocomplete="off"></div>
        <div class="field"><label for="u-pass">Password inicial</label><input id="u-pass" type="text" required minlength="8" autocomplete="off" placeholder="Pelo menos 8 caracteres"></div>
        <div class="field chk"><label><input id="u-admin" type="checkbox"> Administrador</label></div>
      </div>
      <p class="ferr" id="u-err"></p>
      <div class="mactions"><button type="button" class="tbtn" data-close>Fechar</button><button class="pbig" type="submit">Criar conta</button></div>
    </form>`);
  userAction = null;
  await loadUsers();
  $("uNew").addEventListener("submit", async e => {
    e.preventDefault(); $("u-err").textContent = "";
    try{
      await api("POST", "api/admin/users", {email:$("u-email").value.trim(), name:$("u-name").value.trim(), password:$("u-pass").value, isAdmin:$("u-admin").checked});
      showToast(`Conta criada para ${$("u-email").value.trim()}. Envie-lhe a password inicial.`, [{t:"OK"}]);
      $("u-email").value = $("u-name").value = $("u-pass").value = ""; $("u-admin").checked = false;
      await loadUsers();
    }catch(ex){ $("u-err").textContent = ex.message; }
  });
  $("uList").addEventListener("click", onUserClick);
}
async function loadUsers(){
  try{ usersCache = (await api("GET", "api/admin/users")).users; renderUsers(); }
  catch(e){ $("uList").innerHTML = `<p class="ferr">${esc(e.message)}</p>`; }
}
function renderUsers(){
  const el = $("uList"); if(!el) return;
  el.innerHTML = `<div class="utable" role="table">` + usersCache.map(u => {
    const self = u.id === me.id, act = userAction && userAction.id === u.id ? userAction.kind : null;
    return `<div class="urow" role="row">
      <div class="uwho"><span class="avatar sm">${esc(initials(u))}</span><div><b>${esc(u.name || "—")}</b>${u.isAdmin?' <span class="tag">admin</span>':""}${self?' <span class="tag you">você</span>':""}<br><span class="muted">${esc(u.email)}</span></div></div>
      <div class="umeta muted">${u.diagrams} diagramas · criado ${fmtDate(u.createdAt)} · último acesso ${fmtDate(u.lastLoginAt)}</div>
      <div class="uacts">
        ${act === "pass" ? `<input id="ra-pass" type="text" placeholder="Nova password" minlength="8" autocomplete="off"><button class="tbtn" data-ua="savepass" data-id="${u.id}">Guardar</button><button class="tbtn" data-ua="cancel">Cancelar</button>`
        : act === "del" ? `<span class="warn">Apagar a conta e ${u.diagrams} diagramas?</span><button class="tbtn danger" data-ua="confirmdel" data-id="${u.id}">Apagar</button><button class="tbtn" data-ua="cancel">Cancelar</button>`
        : `<button class="tbtn" data-ua="pass" data-id="${u.id}">Nova password</button>
           ${self ? "" : `<button class="tbtn" data-ua="admin" data-id="${u.id}">${u.isAdmin ? "Tirar admin" : "Tornar admin"}</button>
           <button class="tbtn danger" data-ua="del" data-id="${u.id}">Apagar</button>`}`}
      </div></div>`;
  }).join("") + `</div>`;
  if(userAction && userAction.kind === "pass" && $("ra-pass")) $("ra-pass").focus();
}
async function onUserClick(e){
  const b = e.target.closest("[data-ua]"); if(!b) return;
  const id = +b.dataset.id, k = b.dataset.ua, u = usersCache.find(x => x.id === id);
  try{
    if(k === "cancel"){ userAction = null; renderUsers(); }
    else if(k === "pass" || k === "del"){ userAction = {id, kind:k}; renderUsers(); }
    else if(k === "savepass"){
      await api("PATCH", "api/admin/users/"+id, {password:$("ra-pass").value});
      userAction = null; renderUsers(); showToast(`Password de ${u.email} alterada.`, [{t:"OK"}]);
    }
    else if(k === "admin"){ await api("PATCH", "api/admin/users/"+id, {isAdmin:!u.isAdmin}); await loadUsers(); }
    else if(k === "confirmdel"){ await api("DELETE", "api/admin/users/"+id); userAction = null; await loadUsers(); showToast(`Conta ${u.email} apagada.`, [{t:"OK"}]); }
  }catch(ex){ showToast(ex.message, [{t:"OK"}]); }
}

/* ---------- start ---------- */
addEventListener("resize", () => { if(me && mode === "doc") renderInspector(); });
if(innerWidth <= 980) app.classList.add("no-tree");
(async function boot(){
  try{ appCfg = await api("GET", "api/config"); }catch(e){}
  document.title = appCfg.appName || "Camadas";
  $("authBrand").textContent = appCfg.appName || "Camadas";
  try{
    const r = await api("GET", "api/auth/me");
    me = r.user; lastUserId = me.id;
    showApp();
    route();
  }catch(e){
    if(e.status === 401) showAuth("login");
    else { $("boot").textContent = "Não foi possível ligar ao servidor. " + e.message; }
  }
})();
})();
