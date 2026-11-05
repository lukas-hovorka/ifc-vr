import { Viewer } from './viewer.js';
import { XRControls } from './xr.js';
import { HELP } from './vr-panel.js';
import { t } from './theme.js';

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
  loadedSec: $('loaded-sec'), loaded: $('loaded'), loadedCount: $('loaded-count'),
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
// Modelů může být víc (profese stavby); zobrazí se spolu v souřadnicích prvního.
/** @type {{ modelID:number, name:string, size:number, elements:number, tris:number, visible:boolean, color:number }[]} */
const loaded = [];
/** Barvy pro přebarvení modelu (kategorie z EBC_UI_vibe); color 0 = původní barvy z IFC. */
const MODEL_COLORS = [1, 2, 3, 4, 5, 6].map((i) => t(`color.data.category-${i}`));
const colorName = (c) => (c ? `barva ${c}` : 'původní barvy z IFC');
const queue = [];
/** Modely, které nesedí na souřadnice prvního (jiný souřadnicový systém). */
const notes = [];
const MISALIGNED = 'Souřadnice jsou dál než 10 km od prvního modelu, model je umístěný do počátku.';

const plural = (n, one, few, many) => `${n.toLocaleString('cs-CZ')} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
const fmtTris = (tris) => tris >= 1e5
  ? `${(tris / 1e6).toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} mil. trojúhelníků`
  : `${tris.toLocaleString('cs-CZ')} trojúhelníků`;
const isLoaded = (name, size) => loaded.some((m) => m.name === name && (size == null || m.size === size));

const PHASES = { download: 'Stahuji', parse: 'Čtu soubor', geometry: 'Zpracovávám geometrii', structure: 'Čtu strukturu modelu' };
const queueText = () => (queue.length ? ` (ve frontě ${queue.length})` : '');
onProgress = (d) => {
  const pct = d.phase === 'geometry' ? d.value : d.phase === 'structure' ? 1 : 0;
  dropState('loading', pct);
  setStatus(`${PHASES[d.phase]} ${modelName}${d.phase === 'geometry' ? ` – ${Math.round(d.value * 100)} %` : ''}${queueText()} …`);
};

function updateLoaded() {
  ui.loaded.replaceChildren();
  for (const m of loaded) {
    const li = document.createElement('li');
    li.classList.toggle('is-hidden', !m.visible);
    li.title = `${m.name} – ${fmtSize(m.size)}, ${plural(m.elements, 'prvek', 'prvky', 'prvků')}, ${fmtTris(m.tris)}`;
    li.innerHTML = '<label class="ebc-choice model__toggle"><input type="checkbox"><span class="model__name"></span></label>'
      + '<button class="model__color"></button><span class="model__size"></span>'
      + '<button class="ebc-icon-btn model__remove" title="Odebrat model"><svg class="ebc-icon"><use href="./ebc/ebc-icons.svg#ebc-icon-delete"/></svg></button>';
    const check = li.querySelector('input');
    check.checked = m.visible;
    check.title = m.visible ? 'Skrýt model' : 'Zobrazit model';
    check.addEventListener('change', () => setVisible(m.modelID, check.checked));
    li.querySelector('.model__name').textContent = m.name;
    const sw = li.querySelector('.model__color');
    sw.title = `Barva modelu: ${colorName(m.color)}. Kliknutím změníte.`;
    sw.classList.toggle('is-original', !m.color);
    if (m.color) sw.style.setProperty('--swatch', `var(--ebc-color-data-category-${m.color})`);
    sw.addEventListener('click', () => cycleColor(m.modelID));
    li.querySelector('.model__size').textContent = fmtSize(m.size);
    li.querySelector('.model__remove').addEventListener('click', () => removeModel(m.modelID));
    ui.loaded.appendChild(li);
  }
  xr.panel.set({
    models: loaded.map((m) => ({ id: m.modelID, name: m.name, visible: m.visible, color: m.color ? MODEL_COLORS[m.color - 1] : null })),
  });
  ui.loadedSec.hidden = !loaded.length;
  ui.loadedCount.textContent = loaded.length > 1 ? plural(loaded.length, 'model', 'modely', 'modelů') : '';
  const label = loaded.length === 1 ? loaded[0].name : loaded.length ? plural(loaded.length, 'model', 'modely', 'modelů') : '';
  xr.panel.set({ modelName: label });
  document.title = label ? `IFC VR – ${label}` : 'IFC VR';
  ui.dropTitle.textContent = loaded.length ? 'Přidejte další soubory IFC' : 'Přetáhněte soubory IFC sem';
  for (const li of ui.models.children) {
    if (isLoaded(li.dataset.name)) li.setAttribute('aria-selected', 'true'); else li.removeAttribute('aria-selected');
  }
  updateXRButtons();
}

function setVisible(modelID, on) {
  const m = loaded.find((x) => x.modelID === modelID);
  if (!m) return;
  m.visible = on;
  if (!on && viewer.selectedId?.model === modelID) select(null);
  viewer.setModelVisible(modelID, on);
  updateLoaded();
}

/** Původní → barva 1 … 6 → původní. */
function cycleColor(modelID) {
  const m = loaded.find((x) => x.modelID === modelID);
  if (!m) return;
  m.color = (m.color + 1) % (MODEL_COLORS.length + 1);
  viewer.setModelColor(modelID, m.color ? MODEL_COLORS[m.color - 1] : null);
  updateLoaded();
}

xr.panel.onModel = (op, modelID) => {
  if (op === 'vis') setVisible(modelID, !loaded.find((x) => x.modelID === modelID)?.visible);
  else if (op === 'col') cycleColor(modelID);
  else if (op === 'del') removeModel(modelID);
};
// výběr souboru jde otevřít jen mimo VR: otevře se výběr a VR se ukončí
xr.panel.actions.add = () => {
  try { ui.file.click(); } catch { /* bez aktivace uživatelem */ }
  viewer.renderer.xr.getSession()?.end();
  setStatus('Vyberte další soubory IFC. Když se výběr neotevře, klepněte na drop zónu.');
};

async function removeModel(modelID) {
  if (loading) return;
  const i = loaded.findIndex((m) => m.modelID === modelID);
  if (i < 0) return;
  const [m] = loaded.splice(i, 1);
  if (viewer.selectedId?.model === modelID) select(null);
  viewer.removeModel(modelID);
  try { await call('close', { modelID }); } catch (e) { console.warn(e); }
  if (!loaded.length) { viewer.clear(); dropState(''); }
  setStatus(`Model ${m.name} je odebraný.`);
  updateLoaded();
}

async function loadBuffer(buffer, name) {
  modelName = name;
  const t0 = performance.now();
  loading = true;
  ui.btnVR.disabled = ui.btnAR.disabled = true;
  try {
    await ready;
    const size = buffer.byteLength;
    const res = await call('load', { buffer }, [buffer]);
    viewer.addModel(res.modelID, res.buckets, true);
    let tris = 0;
    for (const b of res.buckets) tris += b.index.length / 3;
    loaded.push({ modelID: res.modelID, name, size, elements: res.elements, tris, visible: true, color: 0 });
    const s = Math.max((performance.now() - t0) / 1000, 0.1).toLocaleString('cs-CZ', { maximumFractionDigits: 1 });
    if (!res.aligned) notes.push(name);
    setStatus(`Načteno: ${name} (${fmtSize(size)}, ${plural(res.elements, 'prvek', 'prvky', 'prvků')}, ${fmtTris(tris)}, ${s} s).`
      + (res.aligned ? '' : ` ${MISALIGNED}`), res.aligned ? 'success' : '');
    dropState('loaded');
    return true;
  } catch (err) {
    console.error(err);
    dropState('error');
    setStatus(`Soubor ${name} nejde načíst: ${err.message} Zkontrolujte, že jde o platný soubor IFC.`, 'error');
    return false;
  } finally {
    loading = false;
    updateLoaded();
  }
}

async function readFile(file) {
  if (!file.name.toLowerCase().endsWith('.ifc')) {
    dropState('error');
    setStatus(`Soubor ${file.name} není IFC. Vyberte soubor s příponou .ifc.`, 'error');
    return false;
  }
  if (isLoaded(file.name, file.size)) {
    setStatus(`Model ${file.name} už je načtený.`);
    return true;
  }
  modelName = file.name;
  setStatus(`Čtu soubor ${file.name}${queueText()} …`);
  dropState('loading', 0);
  return loadBuffer(await file.arrayBuffer(), file.name);
}

async function readUrl(url, name) {
  if (isLoaded(name)) { setStatus(`Model ${name} už je načtený.`); return true; }
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
      setStatus(`Stahuji ${name} – ${total ? Math.round((got / total) * 100) + ' %' : fmtSize(got)}${queueText()} …`);
    }
    const buf = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    return loadBuffer(buf.buffer, name);
  } catch (err) {
    dropState('error');
    setStatus(`Model ${name} nejde stáhnout: ${err.message}`, 'error');
    return false;
  }
}

/** Soubory se načítají postupně za sebou; chyba jednoho nezastaví ostatní. */
let running = false;
async function enqueue(jobs) {
  queue.push(...jobs);
  if (running) return;
  running = true;
  let ok = 0, fail = 0;
  notes.length = 0;
  while (queue.length) {
    const job = queue.shift();
    if (await job()) ok++; else fail++;
  }
  running = false;
  if (ok + fail > 1) {
    setStatus(fail
      ? `Načteno ${plural(ok, 'soubor', 'soubory', 'souborů')}, ${plural(fail, 'soubor', 'soubory', 'souborů')} nejde načíst.`
      : `Načteno ${plural(ok, 'soubor', 'soubory', 'souborů')}, celkem ${plural(loaded.length, 'model', 'modely', 'modelů')}.`
        + (notes.length ? ` ${notes.join(', ')}: ${MISALIGNED}` : ''), fail ? 'error' : notes.length ? '' : 'success');
  }
}
const loadFiles = (files) => enqueue([...files].map((f) => () => readFile(f)));
const loadUrl = (url, name) => enqueue([() => readUrl(url, name)]);

ui.file.addEventListener('change', () => { loadFiles(ui.file.files); ui.file.value = ''; });
ui.drop.addEventListener('dragover', (e) => { e.preventDefault(); ui.drop.classList.add('is-dragover'); ui.dropTitle.textContent = 'Vložte soubory'; });
ui.drop.addEventListener('dragleave', () => { ui.drop.classList.remove('is-dragover'); updateLoaded(); });
ui.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  ui.drop.classList.remove('is-dragover');
  updateLoaded();
  if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
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
      li.dataset.name = f.name;
      li.title = `Přidat ${f.name}`;
      li.innerHTML = '<span class="model__name"></span><span class="model__size"></span>';
      li.children[0].textContent = f.name;
      li.children[1].textContent = fmtSize(f.size);
      const go = () => loadUrl(`models/${encodeURIComponent(f.name)}`, f.name);
      li.addEventListener('click', go);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      ui.models.appendChild(li);
    }
    ui.modelsSec.hidden = !files.length;
    updateLoaded();
  } catch { /* statický hosting bez seznamu */ }
}
listModels();

// ?model=a.ifc&model=b.ifc
for (const param of new URLSearchParams(location.search).getAll('model')) {
  loadUrl(param, decodeURIComponent(param.split('/').pop()));
}

// ---------- výběr prvku ----------
let selectSeq = 0;
/** Výběr prvku { model, id } nebo null. */
async function select(ref) {
  const my = ++selectSeq;
  viewer.setHighlight(ref);
  if (ref == null) {
    ui.info.innerHTML = '<p class="ebc-small ebc-caption">Klikněte na prvek v modelu.</p>';
    ui.infoSummary.textContent = '';
    xr.panel.set({ info: null });
    return;
  }
  let info;
  try { info = await call('props', { modelID: ref.model, expressID: ref.id }); } catch (e) { console.warn(e); return; }
  if (my !== selectSeq || !info) return;
  if (loaded.length > 1) info.model = loaded.find((m) => m.modelID === ref.model)?.name || '';
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
  if (info.model) row('Model', info.model);
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

setStatus('Vyberte jeden nebo více souborů IFC.');

if (import.meta.env.DEV) window.__ifcvr = { viewer, xr, select };

// offline režim a instalace jako aplikace (jen v buildu, v dev serveru by mezipaměť překážela)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Offline režim není dostupný', e));
}
