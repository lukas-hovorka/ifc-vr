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
// pád workeru (např. málo paměti v brýlích): rozpracované požadavky skončí chybou, ne čekáním navždy
const failAll = (msg) => {
  for (const p of pending.values()) p.reject(new Error(msg));
  pending.clear();
};
worker.onerror = (e) => { e.preventDefault?.(); failAll(`Zpracování selhalo${e.message ? ` (${e.message})` : ''}. Model může být na zařízení příliš velký.`); };
worker.onmessageerror = () => failAll('Výsledek zpracování nejde přenést.');
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
  progressSec: $('progress-sec'), progressName: $('progress-name'), progressCount: $('progress-count'), progressPhase: $('progress-phase'),
  btnVR: $('btn-vr'), btnAR: $('btn-ar'), info: $('info'), infoSummary: $('info-summary'),
};

const viewer = new Viewer($('viewport'));

/** Název grafické karty, na které aplikace kreslí (kontrola, že běží na dedikované, ne integrované). */
function gpuName() {
  try {
    const gl = viewer.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    // Chrome/Edge: „ANGLE (Intel, Intel(R) UHD Graphics 770 (0x0000A780) Direct3D11 …)“ → jen název karty
    const m = /^ANGLE \([^,]*,\s*(.*?)(?:\s*\(0x[0-9a-f]+\))?(?:\s+Direct3D.*|\s+OpenGL.*|,.*|\))?$/i.exec(raw);
    const name = (m ? m[1] : raw).trim();
    // Firefox (a prohlížeče s ochranou proti otiskům) místo skutečné karty hlásí zástupnou stejného výrobce
    // („NVIDIA GeForce GTX 980, or similar“): pak spolehlivě platí jen výrobce
    if (/or similar/i.test(raw) || /Firefox\//.test(navigator.userAgent)) {
      const vendor = /NVIDIA|AMD|Radeon|Intel|Apple|Qualcomm|Adreno|Mali/i.exec(raw)?.[0];
      if (vendor) return { name: /Radeon/i.test(vendor) ? 'AMD' : vendor, exact: false, raw };
    }
    return { name, exact: true, raw };
  } catch { return null; }
}
/** Integrovaná grafika v procesoru (Intel UHD/Iris, AMD Radeon Graphics bez řady RX) nebo softwarové kreslení. */
const isIntegrated = (name) => /Intel(?!.*\bArc\b)|Radeon\(TM\) Graphics|Radeon Graphics|Microsoft Basic|SwiftShader|llvmpipe/i.test(name);
{
  const info = gpuName();
  const gpu = info?.name;
  if (gpu) {
    // výběr karty na Windows řídí systém, ne stránka: při integrované poradit, kde přepnout
    $('gpu').textContent = `Grafika: ${gpu}` + (info.exact ? '' : ' (přesný model prohlížeč neuvádí)') + (isIntegrated(gpu)
      ? ' – integrovaná. Pro dedikovanou kartu nastavte ve Windows: Nastavení › Systém › Obrazovka › Grafika › prohlížeč › Vysoký výkon, pak prohlížeč restartujte.'
      : '');
    $('gpu').hidden = false;
  }
}
let modelName = '';
let loading = false;

const xr = new XRControls(viewer, {
  onSelect: (id) => select(id),
});
viewer.onBeforeRender = (dt) => xr.update(dt);

/** Stavový řádek. Úspěšné načtení se neukazuje (model je vidět v seznamu), chyby a upozornění ano. */
function setStatus(text, kind = '') {
  ui.status.textContent = text;
  ui.status.className = 'ebc-small side__status' + (kind ? ` is-${kind}` : '');
  ui.status.hidden = kind === 'success';
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
// barva modelu: null = původní z IFC, 1–6 = barva palety, '#rrggbb' = vlastní barva uživatele
const colorHex = (c) => (c == null ? null : typeof c === 'number' ? MODEL_COLORS[c - 1] : c);
const colorCss = (c) => (c == null ? '' : typeof c === 'number' ? `var(--ebc-color-data-category-${c})` : c);
const colorName = (c) => (c == null ? 'původní barvy z IFC' : typeof c === 'number' ? `barva ${c} z palety` : `vlastní ${c.toUpperCase()}`);
const queue = [];
/** Modely, které nesedí na souřadnice prvního (jiný souřadnicový systém). */
const notes = [];
const MISALIGNED = 'Souřadnice jsou dál než 10 km od prvního modelu, model je umístěný do počátku.';
const simplifiedText = (n) => `${n === 1 ? 'U 1 prvku' : `U ${n.toLocaleString('cs-CZ')} prvků`} s víc než 100 otvory`
  + ' (např. stropní deska s prostupy) se otvory nevyřezávají, jinak by načítání trvalo desítky minut.';

const plural = (n, one, few, many) => `${n.toLocaleString('cs-CZ')} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
const fmtTris = (tris) => tris >= 1e5
  ? `${(tris / 1e6).toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} mil. trojúhelníků`
  : `${tris.toLocaleString('cs-CZ')} trojúhelníků`;
const isLoaded = (name, size) => loaded.some((m) => m.name === name && (size == null || m.size === size));

// ---------- průběh ----------
// Jeden pruh pro právě načítaný soubor (fáze mají pevné úseky), nad ním název a pořadí v dávce.
const PHASES = {
  read: 'Čtu soubor', download: 'Stahuji', parse: 'Otevírám model',
  geometry: 'Zpracovávám geometrii', structure: 'Čtu strukturu modelu',
};
const RANGES = {
  file: { read: [0, 0.1], parse: [0.1, 0.2], geometry: [0.2, 0.95], structure: [0.95, 1] },
  url: { download: [0, 0.4], parse: [0.4, 0.48], geometry: [0.48, 0.96], structure: [0.96, 1] },
};
const batch = { done: 0, total: 0, kind: 'file' };
const queueText = () => (queue.length ? ` (ve frontě ${queue.length})` : '');

function showProgress(phase, value = 0) {
  const [a, b] = RANGES[batch.kind][phase] || [0, 1];
  const pct = Math.round((a + (b - a) * Math.min(Math.max(value, 0), 1)) * 100);
  ui.progressSec.hidden = false;
  ui.progressName.textContent = modelName;
  ui.progressCount.textContent = batch.total > 1 ? `soubor ${batch.done + 1} z ${batch.total}` : '';
  ui.progressPhase.textContent = `${PHASES[phase]} – ${pct} %`;
  // pruh je výplň drop zóny, tady jen text
  dropState('loading', pct / 100);
}
const hideProgress = () => { ui.progressSec.hidden = true; };

onProgress = (d) => {
  showProgress(d.phase, d.value);
  setStatus(`${PHASES[d.phase]} ${modelName}${queueText()} …`);
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
    sw.setAttribute('aria-haspopup', 'menu');
    sw.classList.toggle('is-original', m.color == null);
    if (m.color != null) sw.style.setProperty('--swatch', colorCss(m.color));
    sw.addEventListener('click', (e) => { e.stopPropagation(); openColorMenu(m.modelID, sw); });
    li.querySelector('.model__size').textContent = fmtSize(m.size);
    li.querySelector('.model__remove').addEventListener('click', () => removeModel(m.modelID));
    ui.loaded.appendChild(li);
  }
  xr.panel.set({
    models: loaded.map((m) => ({ id: m.modelID, name: m.name, visible: m.visible, color: colorHex(m.color) })),
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

function setColor(modelID, color) {
  const m = loaded.find((x) => x.modelID === modelID);
  if (!m) return;
  m.color = color;
  if (typeof color === 'string') m.custom = color;
  viewer.setModelColor(modelID, colorHex(color));
  updateLoaded();
}

/** VR (bez výběru barvy): původní → paleta 1 … 6 → vlastní (pokud byla zvolená) → původní. */
function cycleColor(modelID) {
  const m = loaded.find((x) => x.modelID === modelID);
  if (!m) return;
  const order = [null, 1, 2, 3, 4, 5, 6, ...(m.custom ? [m.custom] : [])];
  const i = order.indexOf(m.color);
  setColor(modelID, order[(i + 1) % order.length]);
}

// ---------- nabídka barvy modelu (paleta, vlastní barva, původní z IFC) ----------
const colorMenu = $('color-menu');
const colorInput = $('color-input');
let colorFor = null;
for (let i = 1; i <= MODEL_COLORS.length; i++) {
  const b = document.createElement('button');
  b.className = 'model__color';
  b.dataset.color = String(i);
  b.title = `Barva ${i} z palety`;
  b.setAttribute('role', 'menuitemradio');
  b.style.setProperty('--swatch', colorCss(i));
  $('color-palette').appendChild(b);
}

function openColorMenu(modelID, anchor) {
  const m = loaded.find((x) => x.modelID === modelID);
  if (!m) return;
  if (colorFor === modelID && !colorMenu.hidden) { closeColorMenu(); return; }
  colorFor = modelID;
  for (const b of colorMenu.querySelectorAll('[data-color]')) b.setAttribute('aria-checked', String(+b.dataset.color === m.color));
  const own = colorMenu.querySelector('[data-act="custom"]');
  own.setAttribute('aria-checked', String(typeof m.color === 'string'));
  own.querySelector('.model__color').style.setProperty('--swatch', m.custom || 'transparent');
  colorMenu.querySelector('[data-act="orig"]').setAttribute('aria-checked', String(m.color == null));
  colorMenu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = colorMenu.offsetWidth, h = colorMenu.offsetHeight;
  colorMenu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  colorMenu.style.top = `${r.bottom + 4 + h > innerHeight ? r.top - h - 4 : r.bottom + 4}px`;
  // výběr barvy prohlížeče se otevře u kolečka
  colorInput.style.left = `${r.left}px`;
  colorInput.style.top = `${r.bottom}px`;
  colorMenu.querySelector('[aria-checked="true"]')?.focus();
}
const closeColorMenu = () => { colorMenu.hidden = true; };

colorMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const b = e.target.closest('button');
  if (!b || colorFor == null) return;
  if (b.dataset.color) { setColor(colorFor, +b.dataset.color); closeColorMenu(); }
  else if (b.dataset.act === 'orig') { setColor(colorFor, null); closeColorMenu(); }
  else if (b.dataset.act === 'custom') {
    const m = loaded.find((x) => x.modelID === colorFor);
    colorInput.value = m?.custom || colorHex(m?.color) || MODEL_COLORS[0];
    closeColorMenu();
    colorInput.click();
  }
});
// vlastní barva: náhled hned při posouvání ve výběru
colorInput.addEventListener('input', () => { if (colorFor != null) setColor(colorFor, colorInput.value.toLowerCase()); });
document.addEventListener('click', (e) => { if (!colorMenu.hidden && !colorMenu.contains(e.target)) closeColorMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeColorMenu(); });
ui.side.querySelector('.side__body').addEventListener('scroll', closeColorMenu);

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
    loaded.push({ modelID: res.modelID, name, size, elements: res.elements, tris, visible: true, color: null, custom: null });
    const s = Math.max((performance.now() - t0) / 1000, 0.1).toLocaleString('cs-CZ', { maximumFractionDigits: 1 });
    const warn = [...(res.aligned ? [] : [MISALIGNED]), ...(res.simplified ? [simplifiedText(res.simplified)] : [])].join(' ');
    if (warn) notes.push(`${name}: ${warn}`);
    setStatus(`Načteno: ${name} (${fmtSize(size)}, ${plural(res.elements, 'prvek', 'prvky', 'prvků')}, ${fmtTris(tris)}, ${s} s).`
      + (warn ? ` ${warn}` : ''), warn ? '' : 'success');
    dropState('loaded');
    return true;
  } catch (err) {
    console.error(err);
    dropState('error');
    lastError = err.message;
    setStatus(`Soubor ${name} nejde načíst: ${err.message}`
      + (/paměť/.test(err.message) ? '' : ' Zkontrolujte, že jde o platný soubor IFC.'), 'error');
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
  batch.kind = 'file';
  setStatus(`Čtu soubor ${file.name}${queueText()} …`);
  showProgress('read', 0);
  let buffer;
  try {
    buffer = await readWithProgress(file, (v) => showProgress('read', v));
  } catch (err) {
    dropState('error');
    setStatus(`Soubor ${file.name} nejde přečíst: ${err.message}`, 'error');
    return false;
  }
  return loadBuffer(buffer, file.name);
}

/** Přečte soubor z disku s průběhem (velké soubory v brýlích chvíli trvají). */
function readWithProgress(file, onValue) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onprogress = (e) => { if (e.lengthComputable) onValue(e.loaded / e.total); };
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('čtení selhalo.'));
    r.readAsArrayBuffer(file);
  });
}

async function readUrl(url, name) {
  if (isLoaded(name)) { setStatus(`Model ${name} už je načtený.`); return true; }
  modelName = name;
  batch.kind = 'url';
  showProgress('download', 0);
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
      if (total) showProgress('download', got / total);
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
let lastError = ''; // poslední chyba zpracování, do souhrnu dávky
async function enqueue(jobs) {
  queue.push(...jobs);
  batch.total += jobs.length;
  if (running) return;
  running = true;
  let ok = 0;
  const failed = [];
  notes.length = 0;
  lastError = '';
  try {
    while (queue.length) {
      const { name, run } = queue.shift();
      let res = false;
      try { res = await run(); } catch (err) { console.error(err); dropState('error'); }
      if (res) ok++; else failed.push(name);
      batch.done++;
    }
  } finally {
    // průběh zmizí vždy, i po chybě, a další soubory jde načíst
    running = false;
    batch.done = batch.total = 0;
    hideProgress();
  }
  const fail = failed.length;
  if (ok + fail > 1) {
    const list = failed.slice(0, 5).join(', ') + (fail > 5 ? ` a ${fail - 5} další` : '');
    setStatus(fail
      ? `Načteno ${plural(ok, 'soubor', 'soubory', 'souborů')}, ${plural(fail, 'soubor', 'soubory', 'souborů')} nejde načíst: ${list}.`
        + (lastError ? ` ${lastError}` : '')
      : `Načteno ${plural(ok, 'soubor', 'soubory', 'souborů')}, celkem ${plural(loaded.length, 'model', 'modely', 'modelů')}.`
        + (notes.length ? ` ${notes.join(' ')}` : ''), fail ? 'error' : notes.length ? '' : 'success');
  }
}
const loadFiles = (files) => enqueue([...files].map((f) => ({ name: f.name, run: () => readFile(f) })));
const loadUrl = (url, name) => enqueue([{ name, run: () => readUrl(url, name) }]);

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
