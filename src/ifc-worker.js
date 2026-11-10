// Web Worker: načte IFC přes web-ifc, sloučí geometrii podle barvy a vrátí ji hlavnímu vláknu.
// Modely zůstávají otevřené, aby šly dotazovat vlastnosti vybraného prvku. Najednou jich může být víc
// (např. profese stavby). Geometrie je v souřadnicích modelu; zarovnání k prvnímu modelu dělá
// prohlížeč maticí (podle coord), aby šla geometrie uložit do mezipaměti nezávisle na pořadí.
import * as WebIFC from 'web-ifc';
import { BufferGeometry, BufferAttribute } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { cacheGet, cachePut, cacheInfo, cacheClear } from './geo-cache.js';

/** Instance web-ifc. Každá má vlastní paměť WASM s pevným stropem 4 GB; když se další model
 * do poslední instance nevejde, založí se nová (jinak by se po pár velkých modelech nenačetl už žádný). */
const apis = [];
let wasmPath = '';
let ready = null;
/** modelID → { api, local, parentOf, storeyNames }: instance a číslo modelu v ní, rodič prvku
 * (podlaží, prostor, celek) a názvy podlaží. modelID je číslo v rámci workeru, ne instance. */
const models = new Map();
let nextID = 0;
/** gid → slib otevření modelu pro vlastnosti (u modelu z mezipaměti se otevírá až po zobrazení). */
const opening = new Map();
/** poslední zápis do mezipaměti (údaj o velikosti počká, až doběhne) */
let pendingPut = Promise.resolve();

class Grow {
  constructor(T, n = 1 << 16) { this.T = T; this.a = new T(n); this.n = 0; }
  reserve(k) {
    if (this.n + k <= this.a.length) return;
    let s = this.a.length * 2;
    while (s < this.n + k) s *= 2;
    const b = new this.T(s);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  result() { return this.a.slice(0, this.n); }
}

/** true = práce na pozadí (otevření modelu z mezipaměti pro vlastnosti), průběh se nehlásí */
let quiet = false;
const progress = (phase, value) => { if (!quiet) self.postMessage({ type: 'progress', phase, value }); };

async function newApi() {
  const a = new WebIFC.IfcAPI();
  a.SetWasmPath(wasmPath, true);
  await a.Init(undefined, true);
  a.SetLogLevel?.(WebIFC.LogLevel.LOG_LEVEL_OFF);
  a.open = 0; // počet otevřených modelů
  apis.push(a);
  return a;
}

function init(path) {
  if (!ready) { wasmPath = path; ready = newApi(); }
  return ready;
}

const GB = 2 ** 30;
const HEAP_LIMIT = 4 * GB;
const heapOf = (a) => a.wasmModule?.HEAPU8?.length ?? 0;
/** Odhad, kolik paměti WASM model při načtení zabere navíc (změřeno na modelech 0,5–0,8 GB). */
const needFor = (bytes) => 1.6 * bytes + 0.25 * GB;

/** Instance pro další model: poslední, pokud se do ní podle odhadu vejde, jinak nová. */
async function apiFor(bytes) {
  const a = apis[apis.length - 1];
  if (!a.open || heapOf(a) + needFor(bytes) < HEAP_LIMIT * 0.92) return a;
  return newApi();
}

/** Výjimka z WASM (typicky došlá paměť) nemá text; převede se na srozumitelnou zprávu. */
const memoryError = () => new Error('Na model nezbývá paměť. Odeberte některé načtené modely, nebo načtěte menší soubor.');

let api = null; // instance, se kterou právě pracuje load() a pomocné funkce
function idsOfType(modelID, type) {
  const out = [];
  const v = api.GetLineIDsWithType(modelID, type, true);
  for (let i = 0; i < v.size(); i++) out.push(v.get(i));
  return out;
}

const val = (x) => (x == null ? null : typeof x === 'object' && 'value' in x ? x.value : x);

/** Prvek s víc otvory se zobrazí bez vyříznutí: web-ifc odečítá otvory po jednom a u stropní desky
 * se stovkami prostupů trvá výpočet desítky minut (model se „zasekne“ na začátku geometrie). */
const MAX_OPENINGS = 100;

/** Odstraní vazby otvorů u prvků s víc než MAX_OPENINGS otvory; vrátí počet takových prvků. */
function dropHeavyOpenings(modelID) {
  const rels = api.GetLineIDsWithType(modelID, WebIFC.IFCRELVOIDSELEMENT, true);
  const byHost = new Map();
  for (let i = 0; i < rels.size(); i++) {
    const r = rels.get(i);
    const host = val(api.GetLine(modelID, r).RelatingBuildingElement);
    if (host == null) continue;
    let list = byHost.get(host);
    if (!list) byHost.set(host, (list = []));
    list.push(r);
  }
  let hosts = 0;
  for (const list of byHost.values()) {
    if (list.length <= MAX_OPENINGS) continue;
    hosts++;
    for (const r of list) api.DeleteLine(modelID, r);
  }
  return hosts;
}
/**
 * Načte model. Z mezipaměti: vrátí hotovou geometrii hned a IFC otevře (kvůli vlastnostem) až potom
 * v `after`. Jinak geometrii spočítá, uloží do mezipaměti a vrátí.
 */
async function load(buffer, key, name) {
  progress('cache', 0);
  const cached = await cacheGet(key);
  if (cached) {
    const gid = nextID++;
    const transfer = [];
    for (const b of cached.buckets) {
      transfer.push(b.position.buffer, b.normal.buffer, b.index.buffer, b.ranges.buffer);
      if (b.bvh) { transfer.push(...b.bvh.roots); if (b.bvh.indirectBuffer) transfer.push(b.bvh.indirectBuffer.buffer); }
    }
    const after = () => {
      const p = withApi(buffer.byteLength, (local) => {
        models.set(gid, { api, local, ...readStructure(local, false) });
      }).catch((e) => console.warn('Model z mezipaměti nejde otevřít pro vlastnosti', e))
        .finally(() => opening.delete(gid));
      opening.set(gid, p);
      return p;
    };
    return { result: { modelID: gid, ...cached.meta, cached: true, buckets: cached.buckets }, transfer, after };
  }
  let out = null;
  await withApi(buffer.byteLength, (local) => {
    const gid = nextID++;
    const geo = buildGeometry(local);
    const structure = readStructure(local, true);
    models.set(gid, { api, local, ...structure });
    out = { gid, ...geo };
  });
  const { gid, meta, buckets, transfer } = out;
  // pole se do mezipaměti zkopírují při zahájení zápisu; teprve potom je smí převzít hlavní vlákno
  progress('save', 0);
  pendingPut = (await cachePut(key, name, { meta, buckets })).done;
  return { result: { modelID: gid, ...meta, cached: false, buckets }, transfer };
}

/** Otevře model v instanci, kam se vejde, a spustí nad ním fn(localID); při chybě paměti zkusí novou instanci. */
async function withApi(bytes, fn) {
  const first = await apiFor(bytes);
  try {
    return openIn(first, fn);
  } catch (e) {
    // plná instance: zkusit ještě jednou v nové (jen pokud v té plné už nějaký model byl)
    if (!first.open) { dropEmpty(); throw e instanceof Error ? e : memoryError(); }
    const fresh = await newApi();
    try { return openIn(fresh, fn); } catch (e2) { dropEmpty(); throw e2 instanceof Error ? e2 : memoryError(); }
  }
}

/** Uvolní prázdné instance kromě první (paměť WASM se jinak nevrací). */
function dropEmpty() {
  for (let i = apis.length - 1; i > 0; i--) if (!apis[i].open) apis.splice(i, 1);
}

function openIn(a, fn) {
  api = a;
  progress('parse', 0);
  let modelID = -1;
  try {
    modelID = api.OpenModel(new Uint8Array(currentBuffer), { COORDINATE_TO_ORIGIN: true });
    if (modelID < 0) throw new Error('Soubor se nepodařilo otevřít jako IFC.');
    const res = fn(modelID);
    api.open++;
    return res;
  } catch (e) {
    if (modelID >= 0) try { api.CloseModel(modelID); } catch { /* instance je rozbitá */ }
    throw e;
  }
}
/** Soubor právě načítaného modelu (nastaví zpracování zprávy load). */
let currentBuffer = null;

/** Geometrie modelu sloučená podle barvy, se stromem pro výběr; meta = údaje pro prohlížeč. */
function buildGeometry(modelID) {
  const schema = api.GetModelSchema(modelID);

  const skip = new Set([...idsOfType(modelID, WebIFC.IFCSPACE), ...idsOfType(modelID, WebIFC.IFCOPENINGELEMENT)]);
  let simplified = 0;
  try { simplified = dropHeavyOpenings(modelID); } catch (e) { console.warn('Otvory nejde zjednodušit', e); }

  const buckets = new Map();
  let elements = 0;
  // průběh: web-ifc počítá index zvlášť pro každý typ prvku, proto vlastní počítadlo proti všem IfcProduct
  const expected = Math.max(api.GetLineIDsWithType(modelID, WebIFC.IFCPRODUCT, true).size(), 1);
  let streamed = 0;
  let lastPct = -1;
  progress('geometry', 0);
  api.StreamAllMeshes(modelID, (mesh) => {
    const value = Math.min(++streamed / expected, 1);
    const pct = Math.floor(value * 100);
    if (pct !== lastPct) { lastPct = pct; progress('geometry', value); }
    const id = mesh.expressID;
    if (skip.has(id)) return;
    elements++;
    const geoms = mesh.geometries;
    for (let g = 0; g < geoms.size(); g++) {
      const pg = geoms.get(g);
      const c = pg.color;
      const key = `${Math.round(c.x * 255)},${Math.round(c.y * 255)},${Math.round(c.z * 255)},${Math.round(c.w * 255)}`;
      let b = buckets.get(key);
      if (!b) {
        b = { color: [c.x, c.y, c.z, c.w], pos: new Grow(Float32Array), nrm: new Grow(Float32Array), idx: new Grow(Uint32Array), ranges: [] };
        buckets.set(key, b);
      }
      const geom = api.GetGeometry(modelID, pg.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const inds = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const m = pg.flatTransformation;
      const vCount = verts.length / 6;
      const base = b.pos.n / 3;
      b.pos.reserve(vCount * 3);
      b.nrm.reserve(vCount * 3);
      const P = b.pos.a, N = b.nrm.a;
      let o = b.pos.n;
      for (let i = 0; i < verts.length; i += 6) {
        const x = verts[i], y = verts[i + 1], z = verts[i + 2];
        P[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
        P[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        P[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        const a = verts[i + 3], bb = verts[i + 4], cc = verts[i + 5];
        let nx = m[0] * a + m[4] * bb + m[8] * cc;
        let ny = m[1] * a + m[5] * bb + m[9] * cc;
        let nz = m[2] * a + m[6] * bb + m[10] * cc;
        const l = Math.hypot(nx, ny, nz) || 1;
        N[o] = nx / l; N[o + 1] = ny / l; N[o + 2] = nz / l;
        o += 3;
      }
      b.pos.n = o; b.nrm.n = o;
      const start = b.idx.n;
      b.idx.reserve(inds.length);
      const I = b.idx.a;
      for (let i = 0; i < inds.length; i++) I[start + i] = inds[i] + base;
      b.idx.n += inds.length;
      // rozsahy indexů po prvcích: [start, počet, expressID]
      const r = b.ranges, L = r.length;
      if (L && r[L - 1] === id && r[L - 3] + r[L - 2] === start) r[L - 2] += inds.length;
      else r.push(start, inds.length, id);
      geom.delete();
    }
  });

  // posun, o který web-ifc model přesunul k počátku: podle něj prohlížeč zarovná modely mezi sebou
  const coord = Array.from(api.GetCoordinationMatrix(modelID));

  const out = [];
  const transfer = [];
  const list = [...buckets.values()].filter((b) => b.idx.n);
  const totalTris = Math.max(list.reduce((s, b) => s + b.idx.n, 0), 1);
  let doneTris = 0;
  progress('bvh', 0);
  for (const b of list) {
    const item = {
      color: b.color,
      position: b.pos.result(),
      normal: b.nrm.result(),
      index: b.idx.result(),
      ranges: Uint32Array.from(b.ranges),
      bvh: null,
    };
    transfer.push(item.position.buffer, item.normal.buffer, item.index.buffer, item.ranges.buffer);
    // strom pro výběr prvků (raycast) se staví tady, ne v hlavním vlákně: u milionů trojúhelníků trvá sekundy
    try {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(item.position, 3));
      g.setIndex(new BufferAttribute(item.index, 1));
      const s = MeshBVH.serialize(new MeshBVH(g, { indirect: true }), { cloneBuffers: false });
      item.bvh = { version: s.version, roots: s.roots, indirectBuffer: s.indirectBuffer };
      transfer.push(...s.roots);
      if (s.indirectBuffer) transfer.push(s.indirectBuffer.buffer);
    } catch (e) {
      console.warn('Strom pro výběr nejde spočítat, spočítá se v hlavním vlákně', e);
    }
    doneTris += b.idx.n;
    progress('bvh', doneTris / totalTris);
    out.push(item);
  }
  return { meta: { schema, elements, simplified, coord }, buckets: out, transfer };
}

/**
 * Struktura: jen vazby umístění a skladby (rychlé i u velkých modelů); podlaží prvku se dohledá
 * až při výběru, nahoru po rodičích. `report` = hlásit průběh (u modelu z mezipaměti běží na pozadí).
 */
function readStructure(modelID, report) {
  const parentOf = new Map();
  const storeyNames = new Map();
  if (report) progress('structure', 0);
  try {
    for (const s of idsOfType(modelID, WebIFC.IFCBUILDINGSTOREY)) {
      const line = api.GetLine(modelID, s);
      storeyNames.set(s, val(line.Name) || val(line.LongName) || `Podlaží ${s}`);
    }
    const rels = [
      ...idsOfType(modelID, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE).map((id) => [id, 'RelatingStructure', 'RelatedElements']),
      ...idsOfType(modelID, WebIFC.IFCRELAGGREGATES).map((id) => [id, 'RelatingObject', 'RelatedObjects']),
    ];
    let last = -1;
    rels.forEach(([id, from, to], i) => {
      const pct = Math.floor((i / rels.length) * 100);
      if (report && pct !== last) { last = pct; progress('structure', i / rels.length); }
      const rel = api.GetLine(modelID, id);
      const parent = val(rel[from]);
      for (const ch of rel[to] || []) { const c = val(ch); if (c != null && !parentOf.has(c)) parentOf.set(c, parent); }
    });
  } catch (e) {
    console.warn('Prostorovou strukturu nejde načíst', e);
  }
  if (report) progress('structure', 1);
  return { parentOf, storeyNames };
}

const fmtNum = (n) => {
  if (!Number.isFinite(n)) return String(n);
  const r = Math.round(n * 1000) / 1000;
  return r.toLocaleString('cs-CZ', { maximumFractionDigits: 3 });
};

function fmt(v) {
  v = val(v);
  if (v == null) return '';
  if (v === true || v === 'T' || v === '.T.') return 'Ano';
  if (v === false || v === 'F' || v === '.F.') return 'Ne';
  if (typeof v === 'number') return fmtNum(v);
  if (Array.isArray(v)) return v.map(fmt).join(', ');
  return String(v);
}

async function close(modelID) {
  await opening.get(modelID);
  const m = models.get(modelID);
  if (!m) return;
  m.api.CloseModel(m.local);
  m.api.open--;
  models.delete(modelID);
  dropEmpty();
}

async function props(modelID, id) {
  await opening.get(modelID);
  const m = models.get(modelID);
  if (!m) return null;
  const { api, local, parentOf, storeyNames } = m;
  const line = api.GetLine(local, id);
  let storey = id;
  for (let i = 0; i < 32 && storey != null && !storeyNames.has(storey); i++) storey = parentOf.get(storey);
  const out = {
    modelID,
    expressID: id,
    type: api.GetNameFromTypeCode(line.type),
    name: val(line.Name) || '',
    objectType: val(line.ObjectType) || '',
    globalId: val(line.GlobalId) || '',
    storey: storey != null ? storeyNames.get(storey) : '',
    sets: [],
  };
  // vlastnosti instance a zvlášť typu (web-ifc spadne na typu bez HasPropertySets)
  const psets = [];
  for (const withType of [false, true]) {
    try {
      const all = await api.properties.getPropertySets(local, id, true, withType);
      for (const ps of all) if (!psets.some((p) => p.expressID === ps.expressID)) psets.push(ps);
    } catch { /* typ bez vlastností */ }
  }
  try {
    for (const ps of psets) {
      const list = [];
      for (const p of ps.HasProperties || []) {
        const value = p.NominalValue ?? p.EnumerationValues ?? p.ListValues;
        list.push([val(p.Name) || '', fmt(value)]);
      }
      for (const q of ps.Quantities || []) {
        const value = q.LengthValue ?? q.AreaValue ?? q.VolumeValue ?? q.CountValue ?? q.WeightValue ?? q.TimeValue;
        list.push([val(q.Name) || '', fmt(value)]);
      }
      if (list.length) out.sets.push({ name: val(ps.Name) || '', props: list });
    }
  } catch (e) {
    console.warn('Vlastnosti nejde načíst', e);
  }
  return out;
}

// zprávy se zpracovávají po jedné za sebou: načítání a otevírání modelů sdílí proměnnou `api`
let chain = Promise.resolve();
self.onmessage = (e) => { chain = chain.then(() => handle(e.data)); };

async function handle({ id, type, payload }) {
  try {
    if (type === 'init') { await init(payload.wasmPath); self.postMessage({ id, result: true }); return; }
    await ready;
    if (type === 'load') {
      currentBuffer = payload.buffer;
      try {
        const { result, transfer, after } = await load(payload.buffer, payload.key, payload.name);
        self.postMessage({ id, result }, transfer);
        // model z mezipaměti už je vidět; teď se otevře IFC pro vlastnosti prvků (další zprávy počkají)
        if (after) { quiet = true; try { await after(); } finally { quiet = false; } }
      } finally {
        currentBuffer = null;
      }
    } else if (type === 'props') {
      self.postMessage({ id, result: await props(payload.modelID, payload.expressID) });
    } else if (type === 'close') {
      await close(payload.modelID);
      self.postMessage({ id, result: true });
    } else if (type === 'cacheInfo') {
      await pendingPut;
      self.postMessage({ id, result: await cacheInfo() });
    } else if (type === 'cacheClear') {
      await cacheClear();
      self.postMessage({ id, result: true });
    }
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
}
