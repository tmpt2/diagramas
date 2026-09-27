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
let diagrams = {};          // id -> diagram
let currentId = "root";
let sel = null;             // {kind:'node'|'edge', id}
const views = {};           // id -> {x,y,k}
const undo = [];            // [{id, json}]
let me = null;              // signed-in user
let appCfg = {appName:"Camadas", allowRegistration:false};

function newRoot(){ return {id:"root", name:"Mapa principal", level:1, parentId:null, parentNodeId:null, nodes:[], edges:[], updatedAt:Date.now()}; }
function cur(){ return diagrams[currentId] || diagrams.root; }
function view(){ return views[currentId] || (views[currentId] = {x:0,y:0,k:1,fresh:true}); }
diagrams.root = newRoot();
const curKey = () => LS_KEY + ".cur." + (me ? me.id : "");

/* ---------- server API ---------- */
class ApiError extends Error { constructor(status, msg){ super(msg); this.status = status; } }
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
  if(!res.ok) throw new ApiError(res.status, data.error || "Erro " + res.status);
  return data;
}

/* ---------- persistence ---------- */
const pending = new Set(), inflight = new Set(), deleted = new Set();
let flushTimer = null, saveError = null;
function touch(id){
  const d = diagrams[id]; if(!d) return;
  d.updatedAt = Date.now();
  pending.add(id);
  clearTimeout(flushTimer); flushTimer = setTimeout(flush, 500);
  setStatus();
}
async function flush(){
  if(!me) return;
  const ids = [...pending].filter(id => !inflight.has(id));
  await Promise.all(ids.map(async id => {
    pending.delete(id); inflight.add(id); setStatus();
    try{
      if(deleted.has(id)){ await api("DELETE", "api/diagrams/"+encodeURIComponent(id)); deleted.delete(id); }
      else if(diagrams[id]) await api("PUT", "api/diagrams/"+encodeURIComponent(id), diagrams[id]);
      saveError = null;
    }catch(e){
      if(e.status === 400){ saveError = e.message; }   // invalid data: retrying won't help
      else if(e.status !== 401){ pending.add(id); saveError = e.message; }
      else pending.add(id);
    }
    inflight.delete(id);
  }));
  if(pending.size){ clearTimeout(flushTimer); flushTimer = setTimeout(flush, 3000); }
  setStatus();
}
let isReadOnly = false;
function setStatus(){
  const st = $("status"), busy = pending.size || inflight.size;
  st.className = "status" + (saveError ? " err" : busy ? " busy" : "");
  st.querySelector("span").textContent = saveError ? "Não guardado — a tentar de novo" : busy ? "A guardar…" : "Guardado";
  st.title = saveError || "";
}
addEventListener("beforeunload", e => { if(pending.size || inflight.size){ flush(); e.preventDefault(); e.returnValue = ""; } });

async function loadAll(){
  const r = await api("GET", "api/diagrams");
  const map = {};
  r.diagrams.forEach(d => { if(d && d.id) map[d.id] = d; });
  return map;
}
async function openWorkspace(){
  diagrams = await loadAll();
  if(!diagrams.root){ diagrams.root = newRoot(); touch("root"); }
  undo.length = 0; sel = null; for(const k in views) delete views[k];
  currentId = "root";
  try{ const c = localStorage.getItem(curKey()); if(c && diagrams[c]) currentId = c; }catch(e){}
  showApp(); setStatus(); render();
}
// Pick up changes made on another device or tab when this window regains focus.
let refreshing = false;
async function refresh(){
  if(!me || refreshing || pending.size || inflight.size || drag) return;
  refreshing = true;
  try{
    const incoming = await loadAll();
    if(pending.size || inflight.size || drag) return;
    if(JSON.stringify(incoming) === JSON.stringify(diagrams)) return;
    diagrams = incoming;
    if(!diagrams.root) diagrams.root = newRoot();
    if(!diagrams[currentId]) currentId = "root";
    if(sel && !findSel()) sel = null;
    render();
  }catch(e){} finally{ refreshing = false; }
}
addEventListener("focus", refresh);
document.addEventListener("visibilitychange", () => { if(!document.hidden) refresh(); });

/* ---------- undo ---------- */
function snapshot(){
  const d = cur(); undo.push({id:d.id, json:JSON.stringify(d)});
  if(undo.length > 80) undo.shift();
  $("undoBtn").disabled = false;
}
function doUndo(){
  const u = undo.pop(); if(!u) return;
  if(u.id.startsWith("__multi:")){ // restore several diagrams
    const arr = JSON.parse(u.json);
    arr.forEach(d => { diagrams[d.id] = d; deleted.delete(d.id); touch(d.id); });
    currentId = u.id.slice(8);
  } else { diagrams[u.id] = JSON.parse(u.json); deleted.delete(u.id); currentId = u.id; touch(u.id); }
  sel = null; render();
  $("undoBtn").disabled = !undo.length;
}

/* ---------- helpers ---------- */
function nodeById(id, d=cur()){ return d.nodes.find(n=>n.id===id); }
function edgeById(id, d=cur()){ return d.edges.find(e=>e.id===id); }
function findSel(){ if(!sel) return null; return sel.kind==="node" ? nodeById(sel.id) : edgeById(sel.id); }
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
  d.nodes.push(n); sel = {kind:"node", id:n.id};
  touch(d.id); render();
  setTimeout(()=>{ const i=$("f-label"); if(i){ i.focus(); i.select(); } }, 30);
}
function addEdge(from, to){
  const d = cur();
  if(from===to || d.edges.some(e=>e.from===from && e.to===to)) return;
  snapshot();
  const e = {id:uid("e"), from, to, label:"", style:"solid"};
  d.edges.push(e); sel = {kind:"edge", id:e.id};
  touch(d.id); render();
}
function deleteSelection(force){
  if(!sel || isReadOnly) return;
  const d = cur();
  if(sel.kind==="edge"){ snapshot(); d.edges = d.edges.filter(e=>e.id!==sel.id); sel=null; touch(d.id); render(); return; }
  const n = nodeById(sel.id); if(!n) return;
  const ch = childOf(n), inner = countDeep(ch);
  if(inner && !force){
    showToast(`Apagar “${n.label}” e as ${inner} caixas dos níveis interiores?`, [
      {t:"Apagar", cls:"danger", fn:()=>deleteSelection(true)}, {t:"Cancelar"}]);
    return;
  }
  const gone = ch ? [ch, ...descendants(ch)] : [];
  undo.push({id:"__multi:"+d.id, json:JSON.stringify([JSON.parse(JSON.stringify(d)), ...gone])}); $("undoBtn").disabled=false;
  d.nodes = d.nodes.filter(x=>x.id!==n.id);
  d.edges = d.edges.filter(e=>e.from!==n.id && e.to!==n.id);
  gone.forEach(g => { delete diagrams[g.id]; deleted.add(g.id); pending.add(g.id); });
  sel = null; touch(d.id); render();
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
  currentId = id; sel = null;
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
    const selc = sel && sel.kind==="node" && sel.id===n.id ? " sel" : "";
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
  if(s && sel.kind==="node"){
    const n = s, ch = childOf(n), canDeep = d.level < MAX_LEVEL;
    el.innerHTML = `<h2>${TYPES[n.type].name} · nível ${d.level}</h2>
      <div class="field"><label for="f-label">Nome</label><input id="f-label" value="${esc(n.label)}" maxlength="120"></div>
      <div class="field"><label for="f-desc">Descrição</label><textarea id="f-desc" placeholder="Responsável, entradas, saídas, regras…">${esc(n.desc)}</textarea></div>
      <div class="field"><label>Tipo</label><div class="seg" id="f-type">${Object.entries(TYPES).map(([k,t])=>`<button data-type="${k}" class="${k===n.type?"on":""}">${t.name}</button>`).join("")}</div></div>
      <div class="field"><label>Cor</label><div class="swatches" id="f-color">${COLORS.map(c=>`<button class="sw${(n.color||null)===c?" on":""}" data-color="${c||""}" aria-label="${c?"Cor "+c:"Cor do nível"}" data-s="background:${c==="ink"?"var(--ink)":c?`var(--${c})`:`linear-gradient(135deg,${lvColor(d.level)} 50%,var(--surface) 50%)`}"></button>`).join("")}</div></div>
      ${canDeep ? `<div class="drill"><div class="row"><span class="lv" data-s="--lc:${lvColor(d.level+1)}">N${d.level+1}</span>${LEVELS[d.level].name}</div>
        <p>${ch && ch.nodes.length ? `Este elemento tem ${ch.nodes.length} caixas e ${ch.edges.length} ligações no nível ${d.level+1}.` : `Ainda sem detalhe. Entre para desenhar o fluxo interno deste elemento.`}</p>
        <button class="pbig" id="f-enter">${ch && ch.nodes.length ? "Abrir nível "+(d.level+1) : "Detalhar no nível "+(d.level+1)} <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></div>`
      : `<div class="drill"><p>Nível ${MAX_LEVEL} é o mais detalhado. Use a descrição para registar os passos.</p></div>`}
      <button class="dbtn" id="f-del">Apagar caixa</button>`;
  } else if(s && sel.kind==="edge"){
    const e = s, A = nodeById(e.from), B = nodeById(e.to);
    el.innerHTML = `<h2>Ligação</h2>
      <div class="meta">${esc(A&&A.label)} → ${esc(B&&B.label)}</div>
      <div class="field"><label for="f-elabel">Texto da ligação</label><input id="f-elabel" value="${esc(e.label)}" placeholder="ex.: envia pedido, sim, não" maxlength="80"></div>
      <div class="field"><label>Traço</label><div class="seg" id="f-style"><button data-style="solid" class="${e.style!=="dashed"?"on":""}">Contínuo</button><button data-style="dashed" class="${e.style==="dashed"?"on":""}">Tracejado</button></div></div>
      <div class="field"><label>Sentido</label><div class="seg"><button id="f-flip">Inverter sentido</button></div></div>
      <button class="dbtn" id="f-del">Apagar ligação</button>`;
  } else {
    const deep = countDeep(d) - d.nodes.length;
    el.innerHTML = `<h2>Diagrama · nível ${d.level}</h2>
      <div class="field"><label for="f-dname">Nome</label><input id="f-dname" value="${esc(diagName(d))}" maxlength="120"></div>
      <div class="meta">${LEVELS[d.level-1].name} — ${LEVELS[d.level-1].tip}</div>
      <div class="stats"><div><b>${d.nodes.length}</b><span>caixas</span></div><div><b>${d.edges.length}</b><span>ligações</span></div>
        <div><b>${d.nodes.filter(n=>childOf(n)&&childOf(n).nodes.length).length}</b><span>com detalhe</span></div><div><b>${deep}</b><span>caixas abaixo</span></div></div>
      ${d.parentId ? `<button class="tbtn" id="f-up" data-s="width:100%;justify-content:center">Subir para o nível ${d.level-1}</button>` : `<p data-s="color:var(--muted);font-size:12.5px;line-height:1.5;margin:0">Selecione uma caixa para a editar. Faça duplo clique numa caixa para descer ao nível seguinte (até ao nível ${MAX_LEVEL}).</p>`}`;
  }
  if(focused && $(focused)){ const f=$(focused); f.focus(); if(f.setSelectionRange && f.value!=null){ try{ const L=f.value.length; f.setSelectionRange(L,L);}catch(e){} } }
  const hasSel = !!s;
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
    if(!d.parentId) d.name=t.value;
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
  else if(b.dataset.color!==undefined){ snapshot(); findSel().color=b.dataset.color||null; touch(d.id); render(); }
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
let drag = null;             // {kind:'move'|'pan'|'link'|'pinch', ...}
const pointers = new Map();
let lastTap = {t:0, id:null, x:0, y:0};
function toWorld(cx, cy){ const r = board.getBoundingClientRect(), v = view(); return {x:(cx-r.left-v.x)/v.k, y:(cy-r.top-v.y)/v.k}; }

board.addEventListener("pointerdown", e => {
  if(e.button !== 0 && e.pointerType==="mouse") return;
  pointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
  board.setPointerCapture(e.pointerId);
  if(pointers.size === 2){
    const [a,b] = [...pointers.values()], v = view();
    drag = {kind:"pinch", dist:Math.hypot(a.x-b.x,a.y-b.y), k:v.k, mid:{x:(a.x+b.x)/2,y:(a.y+b.y)/2}, vx:v.x, vy:v.y};
    return;
  }
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
    const dbl = lastTap.id===id && now-lastTap.t < 380 && Math.hypot(e.clientX-lastTap.x, e.clientY-lastTap.y) < 12;
    lastTap = {t:now, id, x:e.clientX, y:e.clientY};
    if(dbl){ drag=null; if(n.type!=="note") enter(id); return; }
    if(!(sel && sel.kind==="node" && sel.id===id)){ sel = {kind:"node", id}; renderNodes(); renderEdges(); renderInspector(); }
    const w = toWorld(e.clientX, e.clientY);
    drag = {kind:"move", id, dx:w.x-n.x, dy:w.y-n.y, sx:e.clientX, sy:e.clientY, moved:false, diagram:currentId};
    return;
  }
  if(edgeEl){ sel = {kind:"edge", id:edgeEl.dataset.edge}; renderEdges(); renderNodes(); renderInspector(); drag=null; return; }
  // background
  const dbl = lastTap.id==="__bg" && now-lastTap.t < 380 && Math.hypot(e.clientX-lastTap.x, e.clientY-lastTap.y) < 12;
  lastTap = {t:now, id:"__bg", x:e.clientX, y:e.clientY};
  if(dbl){ const w = toWorld(e.clientX, e.clientY); addNode("activity", w.x, w.y); drag=null; return; }
  const v = view();
  drag = {kind:"pan", sx:e.clientX, sy:e.clientY, vx:v.x, vy:v.y, moved:false};
  board.classList.add("panning");
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
    const n = nodeById(drag.id); if(!n) return;
    const w = toWorld(e.clientX, e.clientY);
    n.x = Math.round((w.x-drag.dx)/10)*10; n.y = Math.round((w.y-drag.dy)/10)*10;
    const el = nodesEl.querySelector(`[data-node="${n.id}"]`);
    if(el){ el.style.left=n.x+"px"; el.style.top=n.y+"px"; el.classList.add("dragging"); }
    renderEdges(); return;
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
  if(d.kind==="pan" && !d.moved && e.type==="pointerup"){ if(sel){ sel=null; renderNodes(); renderEdges(); renderInspector(); } }
  if(d.kind==="move"){ if(d.moved){ touch(currentId); render(); } }
  if(d.kind==="link"){
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const tgt = over && over.closest("[data-node]");
    if(tgt && tgt.dataset.node!==d.from && e.type==="pointerup") addEdge(d.from, tgt.dataset.node);
    else render();
  }
}
board.addEventListener("pointerup", endPointer);
board.addEventListener("pointercancel", endPointer);

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
  if(!me || app.classList.contains("hide")) return;
  const typing = e.target.matches("input,textarea,select");
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="z" && !typing){ e.preventDefault(); doUndo(); return; }
  if(typing){ if(e.key==="Escape") e.target.blur(); return; }
  if(e.key==="Delete" || e.key==="Backspace"){ if(sel){ e.preventDefault(); deleteSelection(); } }
  else if(e.key==="Enter"){ if(sel && sel.kind==="node") enter(sel.id); }
  else if(e.key==="Escape"){ if(sel){ sel=null; render(); } else up(); }
  else if(e.key==="+"||e.key==="="){ zoomCenter(1.2); }
  else if(e.key==="-"){ zoomCenter(1/1.2); }
});

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
function doExport(){
  const data = JSON.stringify({app:"camadas", version:1, exportedAt:new Date().toISOString(), diagrams}, null, 2);
  saveFile(`camadas-${new Date().toISOString().slice(0,10)}.json`, data);
}
$("exportBtn").onclick = doExport;
$("importFile").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if(!f) return;
  closeMenu();
  let o;
  try{ o = JSON.parse(await f.text()); if(!o.diagrams || !o.diagrams.root) throw 0; }
  catch(_){ showToast("Esse ficheiro não é uma exportação válida do Camadas.", [{t:"OK"}]); return; }
  showToast(`Substituir todos os seus diagramas por “${f.name}”?`, [{t:"Substituir", cls:"danger", fn: async ()=>{
    try{
      await flush();
      await api("POST", "api/diagrams/import", {diagrams:o.diagrams});
      pending.clear(); deleted.clear();
      await openWorkspace();
      showToast("Diagramas importados.", [{t:"OK"}]);
    }catch(err){ showToast("Não foi possível importar: " + err.message, [{t:"OK"}]); }
  }}, {t:"Cancelar"}]);
});

/* ---------- accounts: sign in / register ---------- */
let authMode = "login";
function initials(u){ const n = (u.name || u.email || "?").trim(); const p = n.split(/[\s@.]+/).filter(Boolean); return ((p[0]||"?")[0] + (p[1]? p[1][0] : "")).toUpperCase(); }
function showApp(){
  $("boot").classList.add("hide"); $("auth").classList.add("hide"); app.classList.remove("hide");
  $("avatar").textContent = initials(me);
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
    if(lastUserId === me.id && (pending.size || deleted.size)){ showApp(); render(); flush(); }
    else { pending.clear(); deleted.clear(); await openWorkspace(); }
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
  if(pending.size || inflight.size) await flush();
  try{ await api("POST", "api/auth/logout"); }catch(e){}
  me = null; lastUserId = null; diagrams = {root:newRoot()}; pending.clear(); deleted.clear(); undo.length = 0;
  showAuth("login");
};
$("mPass").onclick = () => { closeMenu(); openProfile(); };
$("mUsers").onclick = () => { closeMenu(); openUsers(); };

/* ---------- modal ---------- */
function openModal(html){ $("modalBody").innerHTML = html; $("modal").classList.remove("hide"); const f = $("modalBody").querySelector("input"); if(f) setTimeout(()=>f.focus(), 30); }
function closeModal(){ $("modal").classList.add("hide"); $("modalBody").innerHTML = ""; }
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
addEventListener("resize", () => { if(me) renderInspector(); });
if(innerWidth <= 980) app.classList.add("no-tree");
(async function boot(){
  try{ appCfg = await api("GET", "api/config"); }catch(e){}
  document.title = appCfg.appName || "Camadas";
  $("authBrand").textContent = appCfg.appName || "Camadas";
  try{
    const r = await api("GET", "api/auth/me");
    me = r.user; lastUserId = me.id;
    await openWorkspace();
  }catch(e){
    if(e.status === 401) showAuth("login");
    else { $("boot").textContent = "Não foi possível ligar ao servidor. " + e.message; }
  }
})();
})();
