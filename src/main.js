import { Viewer } from './viewer.js';
import { XRControls } from './xr.js';
import { HELP } from './vr-panel.js';

// ---------- worker ----------
const worker = new Worker(new URL('./ifc-worker.js', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map();
let onProgress = null;
worker.onmessage = (e) => {
  const d = e.data;
  if (d.type === 'progress') { onProgress?.(d); return; }
  const p = pending.get(d.id);
  if (!p) return;
  pending.delete(d.id);
  if (d.error) p.reject(new Error(d.error)); else p.resolve(d.result);
};
const call = (type, payload = {}, transfer = []) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  worker.postMessage({ id, type, payload }, transfer);
});
const ready = call('init', { wasmPath: new URL('wasm/', document.baseURI).href });

// ---------- UI ----------
const $ = (id) => document.getElementById(id);
const ui = {
  side: $('side'), drop: $('drop'), file: $('file'), dropTitle: $('drop-title'), dropProgress: $('drop-progress'),
  modelsSec: $('models-sec'), models: $('models'), status: $('status'),
  btnVR: $('btn-vr'), btnAR: $('btn-ar'), info: $('info'), infoSummary: $('info-summary'),
};

const viewer = new Viewer($('viewport'));
let modelName = '';
let loading = false;

const xr = new XRControls(viewer, {
  onSelect: (id) => select(id),
});
viewer.onBeforeRender = (dt) => xr.update(dt);

function setStatus(text, kind = '') {
  ui.status.textContent = text;
  ui.status.className = 'ebc-small side__status' + (kind ? ` is-${kind}` : '');
}

const fmtSize = (b) => b >= 1e6 ? `${(b / 1e6).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`;

function dropState(state, pct = 0) {
  ui.drop.classList.toggle('is-loaded', state === 'loaded');
  ui.drop.classList.toggle('is-error', state === 'error');
  ui.dropProgress.style.width = state === 'loading' ? `${Math.round(pct * 100)}%` : '0';
}

for (const [k, v] of HELP) {
  const tr = document.createElement('tr');
  tr.innerHTML = '<td></td><td></td>';
  tr.children[0].textContent = k;
  tr.children[1].textContent = v;
  $('help').appendChild(tr);
}

$('btn-collapse').addEventListener('click', (e) => {
  const c = ui.side.classList.toggle('is-collapsed');
  e.currentTarget.setAttribute('aria-expanded', String(!c));
  e.currentTarget.title = c ? 'Rozbalit panel' : 'Sbalit panel';
});

// ---------- načtení ----------
const PHASES = { download: 'Stahuji', parse: 'Čtu soubor', geometry: 'Zpracovávám geometrii', structure: 'Čtu strukturu modelu' };
onProgress = (d) => {
  const pct = d.phase === 'geometry' ? d.value : d.phase === 'structure' ? 1 : 0;
  dropState('loading', pct);
  setStatus(`${PHASES[d.phase]} ${modelName}${d.phase === 'geometry' ? ` – ${Math.round(d.value * 100)} %` : ''} …`);
};

async function loadBuffer(buffer, name) {
  modelName = name;
  const t0 = performance.now();
  loading = true;
  ui.btnVR.disabled = ui.btnAR.disabled = true;
  select(null);
  try {
    await ready;
    const size = buffer.byteLength;
    const res = await call('load', { buffer }, [buffer]);
    viewer.setModel(res.buckets);
    xr.panel.set({ modelName: name, info: null });
    let tris = 0;
    for (const b of res.buckets) tris += b.index.length / 3;
    const s = Math.max((performance.now() - t0) / 1000, 0.1).toLocaleString('cs-CZ', { maximumFractionDigits: 1 });
    const triText = tris >= 1e5
      ? `${(tris / 1e6).toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} mil. trojúhelníků`
      : `${tris.toLocaleString('cs-CZ')} trojúhelníků`;
    setStatus(`Načteno: ${name} (${fmtSize(size)}, ${res.elements.toLocaleString('cs-CZ')} prvků, ${triText}, ${s} s).`, 'success');
    dropState('loaded');
    ui.dropTitle.textContent = name;
    document.title = `IFC VR – ${name}`;
  } catch (err) {
    console.error(err);
    dropState('error');
    setStatus(`Soubor ${name} nejde načíst: ${err.message} Zkontrolujte, že jde o platný soubor IFC.`, 'error');
  } finally {
    loading = false;
    updateXRButtons();
  }
}

async function loadFile(file) {
  if (loading) return;
  if (!file.name.toLowerCase().endsWith('.ifc')) {
    dropState('error');
    setStatus(`Soubor ${file.name} není IFC. Vyberte soubor s příponou .ifc.`, 'error');
    return;
  }
  modelName = file.name;
  setStatus(`Čtu soubor ${file.name} …`);
  dropState('loading', 0);
  await loadBuffer(await file.arrayBuffer(), file.name);
}

async function loadUrl(url, name) {
  if (loading) return;
  modelName = name;
  dropState('loading', 0);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`server vrátil ${res.status}.`);
    const total = +res.headers.get('Content-Length') || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      setStatus(`Stahuji ${name} – ${total ? Math.round((got / total) * 100) + ' %' : fmtSize(got)} …`);
    }
    const buf = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    await loadBuffer(buf.buffer, name);
  } catch (err) {
    dropState('error');
    setStatus(`Model ${name} nejde stáhnout: ${err.message}`, 'error');
  }
}

ui.file.addEventListener('change', () => { const f = ui.file.files[0]; if (f) loadFile(f); ui.file.value = ''; });
ui.drop.addEventListener('dragover', (e) => { e.preventDefault(); ui.drop.classList.add('is-dragover'); ui.dropTitle.textContent = 'Vložte soubor'; });
ui.drop.addEventListener('dragleave', () => { ui.drop.classList.remove('is-dragover'); ui.dropTitle.textContent = modelName || 'Přetáhněte soubor IFC sem'; });
ui.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  ui.drop.classList.remove('is-dragover');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

// seznam modelů ze složky models/ (jen když běží dev server)
async function listModels() {
  try {
    const res = await fetch('api/models');
    if (!res.ok || !res.headers.get('Content-Type')?.includes('json')) return;
    const files = await res.json();
    ui.models.innerHTML = '';
    for (const f of files) {
      const li = document.createElement('li');
      li.tabIndex = 0;
      li.title = `Načíst ${f.name}`;
      li.innerHTML = '<span class="model__name"></span><span class="model__size"></span>';
      li.children[0].textContent = f.name;
      li.children[1].textContent = fmtSize(f.size);
      const go = () => {
        for (const x of ui.models.children) x.removeAttribute('aria-selected');
        li.setAttribute('aria-selected', 'true');
        loadUrl(`models/${encodeURIComponent(f.name)}`, f.name);
      };
      li.addEventListener('click', go);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      ui.models.appendChild(li);
    }
    ui.modelsSec.hidden = !files.length;
  } catch { /* statický hosting bez seznamu */ }
}
listModels();

const param = new URLSearchParams(location.search).get('model');
if (param) loadUrl(param, decodeURIComponent(param.split('/').pop()));

// ---------- výběr prvku ----------
let selectSeq = 0;
async function select(id) {
  const my = ++selectSeq;
  viewer.setHighlight(id);
  if (id == null) {
    ui.info.innerHTML = '<p class="ebc-small ebc-caption">Klikněte na prvek v modelu.</p>';
    ui.infoSummary.textContent = '';
    xr.panel.set({ info: null });
    return;
  }
  let info;
  try { info = await call('props', { expressID: id }); } catch (e) { console.warn(e); return; }
  if (my !== selectSeq || !info) return;
  xr.panel.set({ info });
  renderInfo(info);
}

function renderInfo(info) {
  ui.infoSummary.textContent = info.name || info.type;
  const root = document.createElement('div');
  root.className = 'info';
  root.style.display = 'contents';
  const h = document.createElement('p');
  h.className = 'info__name';
  h.textContent = info.name || info.type;
  const sub = document.createElement('p');
  sub.className = 'ebc-small info__sub';
  sub.textContent = [info.type, info.storey].filter(Boolean).join(' · ');
  const wrap = document.createElement('div');
  wrap.className = 'ebc-table-wrap';
  const table = document.createElement('table');
  table.className = 'ebc-table';
  const tb = document.createElement('tbody');
  const row = (k, v, cls) => {
    const tr = document.createElement('tr');
    if (cls) tr.className = cls;
    const a = document.createElement('td'); a.textContent = k;
    tr.appendChild(a);
    if (cls) a.colSpan = 2;
    else { const b = document.createElement('td'); b.textContent = v; tr.appendChild(b); }
    tb.appendChild(tr);
  };
  if (info.objectType) row('Typ objektu', info.objectType);
  row('GlobalId', info.globalId);
  for (const s of info.sets) {
    row(s.name, '', 'info__set');
    for (const [k, v] of s.props) row(k, v);
  }
  table.appendChild(tb);
  wrap.appendChild(table);
  root.append(h, sub, wrap);
  ui.info.replaceChildren(root);
}

// klik na prvek (bez tažení)
let down = null;
const canvas = viewer.renderer.domElement;
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
  down = null;
  const hit = viewer.pickAtScreen(e.clientX, e.clientY);
  select(hit ? hit.id : null);
});

// ---------- WebXR ----------
const support = { vr: false, ar: false };
async function detectXR() {
  if (!navigator.xr) return;
  try { support.vr = await navigator.xr.isSessionSupported('immersive-vr'); } catch { /* */ }
  try { support.ar = await navigator.xr.isSessionSupported('immersive-ar'); } catch { /* */ }
  updateXRButtons();
}

function updateXRButtons() {
  const hasModel = viewer.meshes.length > 0;
  const why = !window.isSecureContext ? 'VR vyžaduje zabezpečené připojení (https:// nebo localhost).'
    : !navigator.xr ? 'Prohlížeč nepodporuje WebXR. Otevřete stránku v prohlížeči Meta Quest.'
    : !hasModel ? 'Nejdřív načtěte model.' : '';
  ui.btnVR.disabled = loading || !hasModel || !support.vr;
  ui.btnAR.disabled = loading || !hasModel || !support.ar;
  ui.btnVR.title = why || (!support.vr ? 'Zařízení nepodporuje VR.' : 'Prohlížet model v brýlích ve skutečné velikosti');
  ui.btnAR.title = why || (!support.ar ? 'Zařízení nepodporuje AR s průhledem.' : 'Model jako maketa v reálném prostoru (průhled kamer)');
}
detectXR();
navigator.xr?.addEventListener?.('devicechange', detectXR);

async function enterXR(mode) {
  const ar = mode === 'immersive-ar';
  try {
    const session = await navigator.xr.requestSession(mode, {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['bounded-floor', 'hand-tracking'],
    });
    viewer.renderer.xr.setReferenceSpaceType('local-floor');
    await viewer.renderer.xr.setSession(session);
    xr.start(ar);
    session.addEventListener('end', () => xr.end(), { once: true });
  } catch (err) {
    setStatus(`Režim ${ar ? 'AR' : 'VR'} nejde spustit: ${err.message}`, 'error');
  }
}
ui.btnVR.addEventListener('click', () => enterXR('immersive-vr'));
ui.btnAR.addEventListener('click', () => enterXR('immersive-ar'));

setStatus('Vyberte model IFC.');

if (import.meta.env.DEV) window.__ifcvr = { viewer, xr, select };

// offline režim a instalace jako aplikace (jen v buildu, v dev serveru by mezipaměť překážela)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Offline režim není dostupný', e));
}
