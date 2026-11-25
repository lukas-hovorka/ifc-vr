// Web Worker: načte IFC přes web-ifc, sloučí geometrii podle barvy a vrátí ji hlavnímu vláknu spolu
// s vlastnostmi všech prvků. IFC se hned potom zavře a prohlížeč worker ukončí: web-ifc drží celý model
// v paměti WASM (nejméně 133 MB i u malého souboru, u 0,5 GB souboru kolem 1 GB), což by u víc modelů
// najednou brýle nezvládly. Geometrie je v souřadnicích modelu; zarovnání k prvnímu modelu dělá
// prohlížeč maticí (podle coord), aby šla geometrie uložit do mezipaměti nezávisle na pořadí.
import * as WebIFC from 'web-ifc';
import { BufferGeometry, BufferAttribute, Matrix4 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { cacheGet, cachePut, cacheInfo, cacheClear } from './geo-cache.js';
import { findLeaves, NOT_SWINGING } from './doors.js';
import { featureEdges, aoVolume } from './shading.js';
import { MeshoptSimplifier } from 'meshoptimizer';

/** Prostorové bloky: nejmenší hrana bloku v m; hrana se zvětšuje, dokud bloků není nejvýš MAX_BLOCKS
 * (každý blok je jedno volání kreslení, těch brýle zvládnou jen stovky). */
const BLOCK_MIN = 4;
const MAX_BLOCKS = 240;
/** Blok má průměrně aspoň tolik trojúhelníků: menší by ušetřily méně, než stojí volání kreslení navíc. */
const BLOCK_TRIS = 40000;
/** Skupina barvy s méně indexy se nedělí. */
const MIN_SPLIT = 2 * BLOCK_TRIS * 3;

/**
 * Zjednodušení těžkých dílů (výtahy, armatury, zařizovací předměty od výrobců mívají statisíce
 * trojúhelníků na kus): díl s aspoň SIMPLIFY_MIN trojúhelníky se zjednoduší tak, aby se tvar
 * nikde neodchýlil o víc než SIMPLIFY_ERROR metrů. Normály zůstávají původní, hrany ploch se drží.
 */
const SIMPLIFY_MIN = 100;
const SIMPLIFY_ERROR = 0.002;

/** Instance web-ifc. Každá má vlastní paměť WASM s pevným stropem 4 GB; když se další model
 * do poslední instance nevejde, založí se nová (jinak by se po pár velkých modelech nenačetl už žádný). */
const apis = [];
let wasmPath = '';
let ready = null;
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

/** Cesta k WASM; web-ifc se spustí až s prvním modelem (worker mezipaměti ho nepotřebuje). */
function init(path) { wasmPath = path; }
const start = () => ready || (ready = Promise.all([newApi(), MeshoptSimplifier.ready]).then(([a]) => a));

/** Hrana ostřejší než tento úhel zůstane po zjednodušení ostrá (normály se přes ni nevyhlazují). */
const CREASE_COS = Math.cos((35 * Math.PI) / 180);

/**
 * Zjednoduší díl (P = polohy, inds = indexy); vrátí { P, N, inds }, nebo null, když by se ušetřilo
 * málo. Těžké díly z web-ifc mívají každý trojúhelník s vlastními vrcholy: pro zjednodušení se vrcholy
 * na stejném místě sloučí a normály se pak spočítají znovu ze zjednodušené sítě (rovné plochy ploché,
 * oblé hladké, hrany ostřejší než 35° ostré). mirrored = zrcadlený díl (pořadí vrcholů se pak obrátí).
 */
function simplifyPart(P, inds, mirrored) {
  const remap = MeshoptSimplifier.generatePositionRemap(P, 3);
  const W = new Uint32Array(inds.length);
  for (let i = 0; i < inds.length; i++) W[i] = remap[inds[i]];
  // Permissive: díly od výrobců bývají nevodotěsné (pláty přes sebe), bez něj se skoro nic nezjednoduší;
  // odchylka tvaru zůstává hlídaná (SIMPLIFY_ERROR). LockBorder: okraje otevřených ploch zůstanou na místě,
  // aby na sebe navazující díly (jiná barva, jiný díl) neměly mezery a zuby
  const [out] = MeshoptSimplifier.simplify(W, P, 3, 0, SIMPLIFY_ERROR, ['ErrorAbsolute', 'Prune', 'Permissive', 'LockBorder']);
  if (!out.length || out.length > inds.length * 0.8) return null;
  const T = out.length / 3, vc = P.length / 3;
  // normály trojúhelníků (délka = 2× plocha) a trojúhelníky u každého vrcholu
  const F = new Float32Array(T * 3), deg = new Uint32Array(vc + 1);
  const sg = mirrored ? -1 : 1;
  for (let t = 0; t < T; t++) {
    const a = out[t * 3] * 3, b = out[t * 3 + 1] * 3, c = out[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    F[t * 3] = sg * (uy * vz - uz * vy); F[t * 3 + 1] = sg * (uz * vx - ux * vz); F[t * 3 + 2] = sg * (ux * vy - uy * vx);
    deg[out[t * 3] + 1]++; deg[out[t * 3 + 1] + 1]++; deg[out[t * 3 + 2] + 1]++;
  }
  for (let v = 0; v < vc; v++) deg[v + 1] += deg[v];
  const inc = new Uint32Array(out.length), fill = deg.slice(0, vc);
  for (let i = 0; i < out.length; i++) inc[fill[out[i]]++] = (i / 3) | 0;
  const len = (t) => Math.hypot(F[t * 3], F[t * 3 + 1], F[t * 3 + 2]) || 1;
  // každý roh: součet normál sousedních trojúhelníků, které s ním nesvírají ostrou hranu;
  // stejné normály u jednoho vrcholu sdílejí jeden výstupní vrchol
  const P2 = new Grow(Float32Array, out.length * 3), N2 = new Grow(Float32Array, out.length * 3);
  const I2 = new Uint32Array(out.length);
  const made = new Map(); // vrchol → [nx, ny, nz, index, …]
  for (let i = 0; i < out.length; i++) {
    const v = out[i], t = (i / 3) | 0, lt = len(t);
    let nx = 0, ny = 0, nz = 0;
    for (let k = deg[v]; k < deg[v + 1]; k++) {
      const u = inc[k];
      const d = (F[t * 3] * F[u * 3] + F[t * 3 + 1] * F[u * 3 + 1] + F[t * 3 + 2] * F[u * 3 + 2]) / (lt * len(u));
      if (d >= CREASE_COS) { nx += F[u * 3]; ny += F[u * 3 + 1]; nz += F[u * 3 + 2]; }
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    let list = made.get(v), idx = -1;
    if (list) for (let k = 0; k < list.length; k += 4) {
      if (list[k] * nx + list[k + 1] * ny + list[k + 2] * nz > 0.9999) { idx = list[k + 3]; break; }
    }
    if (idx < 0) {
      idx = P2.n / 3;
      P2.reserve(3); N2.reserve(3);
      P2.a[P2.n++] = P[v * 3]; P2.a[P2.n++] = P[v * 3 + 1]; P2.a[P2.n++] = P[v * 3 + 2];
      N2.a[N2.n++] = nx; N2.a[N2.n++] = ny; N2.a[N2.n++] = nz;
      if (!list) made.set(v, (list = []));
      list.push(nx, ny, nz, idx);
    }
    I2[i] = idx;
  }
  return { P: P2.result(), N: N2.result(), inds: I2 };
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
 * Načte model: z mezipaměti hotovou geometrii i vlastnosti (IFC se vůbec neotevře), jinak spočítá
 * geometrii, vytáhne vlastnosti všech prvků, IFC zavře a výsledek uloží do mezipaměti.
 */
async function load(buffer, key, name) {
  progress('cache', 0);
  const cached = await cacheGet(key);
  if (cached) {
    const transfer = [];
    if (cached.edges) transfer.push(cached.edges.buffer);
    if (cached.ao) transfer.push(cached.ao.data.buffer);
    for (const b of cached.buckets) {
      transfer.push(b.position.buffer, b.normal.buffer, b.index.buffer, b.ranges.buffer);
      if (b.bvh) { transfer.push(...b.bvh.roots); if (b.bvh.indirectBuffer) transfer.push(b.bvh.indirectBuffer.buffer); }
      if (b.blocks) transfer.push(b.blocks.buffer);
    }
    return { result: { ...cached.meta, cached: true, buckets: cached.buckets, edges: cached.edges, ao: cached.ao, props: cached.props }, transfer };
  }
  await start();
  let out = null;
  await withApi(buffer.byteLength, (local) => {
    const geo = buildGeometry(local);
    progress('props', 0);
    let props = null;
    try { props = extractProps(local, geo.ids, readStructure(local, true)); } catch (e) { console.warn('Vlastnosti nejde načíst', e); }
    out = { ...geo, props };
  }, true);
  currentBuffer = null;
  const { meta, buckets, edges, ao, props, transfer } = out;
  // pole se do mezipaměti zkopírují při zahájení zápisu; teprve potom je smí převzít hlavní vlákno
  progress('save', 0);
  pendingPut = (await cachePut(key, name, { meta, buckets, edges, ao, props })).done;
  return { result: { ...meta, cached: false, buckets, edges, ao, props }, transfer };
}

/**
 * Vlastnosti všech prvků s geometrií jedním průchodem vazeb (u 0,5 GB souboru kolem sekundy):
 * { ids: [expressID], head: [[typ, název, typ objektu, GlobalId, podlaží]], sets: [[čísla sad]],
 *   psets: [[název sady, [název, hodnota, název, hodnota…]]] }. Sady se sdílejí (typ prvku).
 */
function extractProps(modelID, ids, { parentOf, storeyNames }) {
  const elems = [...ids];
  const has = new Set(elems);
  const own = new Map(), typed = new Map();
  const add = (map, e, p) => { const a = map.get(e); if (a) a.push(p); else map.set(e, [p]); };
  for (const id of idsOfType(modelID, WebIFC.IFCRELDEFINESBYPROPERTIES)) {
    const r = api.GetLine(modelID, id);
    const p = val(r.RelatingPropertyDefinition);
    for (const o of r.RelatedObjects || []) { const e = val(o); if (has.has(e)) add(own, e, p); }
  }
  for (const id of idsOfType(modelID, WebIFC.IFCRELDEFINESBYTYPE)) {
    const r = api.GetLine(modelID, id);
    let t;
    try { t = api.GetLine(modelID, val(r.RelatingType)); } catch { continue; }
    const hs = (t.HasPropertySets || []).map(val);
    if (!hs.length) continue;
    for (const o of r.RelatedObjects || []) { const e = val(o); if (has.has(e)) for (const p of hs) add(typed, e, p); }
  }
  const psets = [];
  const psetIndex = new Map(); // expressID sady → pořadí v psets (−1 = prázdná / nečitelná)
  const psetOf = (p) => {
    let i = psetIndex.get(p);
    if (i !== undefined) return i;
    i = -1;
    try {
      const ps = api.GetLine(modelID, p);
      const list = [];
      for (const ref of ps.HasProperties || []) {
        const q = api.GetLine(modelID, val(ref));
        list.push(val(q.Name) || '', fmt(q.NominalValue ?? q.EnumerationValues ?? q.ListValues));
      }
      for (const ref of ps.Quantities || []) {
        const q = api.GetLine(modelID, val(ref));
        list.push(val(q.Name) || '', fmt(q.LengthValue ?? q.AreaValue ?? q.VolumeValue ?? q.CountValue ?? q.WeightValue ?? q.TimeValue));
      }
      if (list.length) { i = psets.length; psets.push([val(ps.Name) || '', list]); }
    } catch { /* sada, kterou web-ifc nepřečte */ }
    psetIndex.set(p, i);
    return i;
  };
  const head = [], sets = [];
  elems.forEach((e, n) => {
    if (n % 500 === 0) progress('props', n / elems.length);
    let line = null;
    try { line = api.GetLine(modelID, e); } catch { /* prvek bez řádku */ }
    let storey = e;
    for (let i = 0; i < 32 && storey != null && !storeyNames.has(storey); i++) storey = parentOf.get(storey);
    head.push([line ? api.GetNameFromTypeCode(line.type) : '', val(line?.Name) || '', val(line?.ObjectType) || '', val(line?.GlobalId) || '', storey != null ? storeyNames.get(storey) || '' : '']);
    // vlastnosti instance, potom typu (bez opakování stejné sady)
    const idx = [];
    for (const p of [...(own.get(e) || []), ...(typed.get(e) || [])]) {
      const i = psetOf(p);
      if (i >= 0 && !idx.includes(i)) idx.push(i);
    }
    sets.push(idx);
  });
  progress('props', 1);
  return { ids: elems, head, sets, psets };
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
    return fn(modelID);
  } finally {
    // geometrie i vlastnosti jsou venku: IFC už není potřeba (paměť uvolní ukončení workeru)
    if (modelID >= 0) try { api.CloseModel(modelID); } catch { /* instance je rozbitá */ }
  }
}
/** Soubor právě načítaného modelu (nastaví zpracování zprávy load). */
let currentBuffer = null;

/** Vrcholy z web-ifc (x, y, z, nx, ny, nz…) převedené maticí m do polí P (polohy) a N (normály) od indexu o. */
function transform(verts, m, P, N, o) {
  for (let i = 0; i < verts.length; i += 6) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    P[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
    P[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    P[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (N) {
      const a = verts[i + 3], bb = verts[i + 4], cc = verts[i + 5];
      const nx = m[0] * a + m[4] * bb + m[8] * cc;
      const ny = m[1] * a + m[5] * bb + m[9] * cc;
      const nz = m[2] * a + m[6] * bb + m[10] * cc;
      const l = Math.hypot(nx, ny, nz) || 1;
      N[o] = nx / l; N[o + 1] = ny / l; N[o + 2] = nz / l;
    }
    o += 3;
  }
}

/**
 * Podlaží: název, výška podlahy v souřadnicích geometrie (y) a Elevation v metrech (elev, výška vůči ±0,00).
 * G = převod z umístění IFC do souřadnic geometrie. Seřazeno odspodu.
 */
function readStoreys(modelID, G) {
  const out = [];
  const scale = Math.hypot(G.elements[0], G.elements[1], G.elements[2]) || 1;
  for (const s of idsOfType(modelID, WebIFC.IFCBUILDINGSTOREY)) {
    try {
      const line = api.GetLine(modelID, s);
      const W = new Matrix4().fromArray(api.GetWorldTransformMatrix(modelID, line.ObjectPlacement.value));
      const y = new Matrix4().multiplyMatrices(G, W).elements[13];
      const elev = val(line.Elevation);
      out.push({ id: s, name: String(val(line.Name) || val(line.LongName) || `Podlaží ${s}`), y, elev: elev == null ? null : Number(elev) * scale });
    } catch (e) { console.warn('Podlaží nejde přečíst', s, e); }
  }
  return out.sort((a, b) => a.y - b.y);
}

/** Typ otevírání dveří (OperationType z dveří, v IFC2X3 z jejich typu / stylu). */
function doorOps(modelID, doorIds) {
  const ops = new Map();
  if (!doorIds.size) return ops;
  try {
    for (const r of idsOfType(modelID, WebIFC.IFCRELDEFINESBYTYPE)) {
      const l = api.GetLine(modelID, r);
      const objs = (l.RelatedObjects || []).filter((o) => doorIds.has(o.value));
      if (!objs.length || !l.RelatingType) continue;
      const op = val(api.GetLine(modelID, l.RelatingType.value).OperationType);
      if (op) for (const o of objs) ops.set(o.value, String(op));
    }
    for (const d of doorIds) {
      const op = val(api.GetLine(modelID, d).OperationType);
      if (op && op !== 'NOTDEFINED') ops.set(d, String(op));
    }
  } catch (e) { console.warn('Typ otevírání dveří nejde přečíst', e); }
  return ops;
}

/** Geometrie modelu sloučená podle barvy, se stromem pro výběr; meta = údaje pro prohlížeč. */
function buildGeometry(modelID) {
  const schema = api.GetModelSchema(modelID);

  const skip = new Set([...idsOfType(modelID, WebIFC.IFCSPACE), ...idsOfType(modelID, WebIFC.IFCOPENINGELEMENT)]);
  let simplified = 0;
  try { simplified = dropHeavyOpenings(modelID); } catch (e) { console.warn('Otvory nejde zjednodušit', e); }

  const buckets = new Map();
  let elements = 0;
  /** prvky s geometrií (pro vlastnosti) */
  const ids = new Set();
  /** počet zrcadlených dílů (obrácené pořadí vrcholů) */
  let mirrored = 0;
  /** zjednodušené díly: počet, trojúhelníky před a po */
  const reduced = { parts: 0, before: 0, after: 0 };
  /** obrysové hrany celého modelu (úsečky, 6 čísel na úsečku) */
  const edges = new Grow(Float32Array);
  /** úseky hran podle prvku [začátek, počet čísel, id] (skrytý prvek nemá nechat hrany ve vzduchu) */
  const edgeRanges = [];
  // dveře: díly se před zápisem roztřídí na zárubeň a křídla (křídla jdou v prohlížeči otočit)
  const doorIds = new Set(idsOfType(modelID, WebIFC.IFCDOOR));
  const ops = doorOps(modelID, doorIds);
  const doors = [];

  const bucketFor = (c) => {
    const key = `${Math.round(c.x * 255)},${Math.round(c.y * 255)},${Math.round(c.z * 255)},${Math.round(c.w * 255)}`;
    let b = buckets.get(key);
    if (!b) {
      b = { key, color: [c.x, c.y, c.z, c.w], pos: new Grow(Float32Array), nrm: new Grow(Float32Array), idx: new Grow(Uint32Array), ranges: [] };
      buckets.set(key, b);
    }
    return b;
  };
  /**
   * Zapíše díl do skupiny podle barvy; vrátí [klíč skupiny, začátek, počet indexů].
   * `outline` = obrysové hrany (ne u křídel dveří: otáčí se).
   */
  const append = (id, b, verts, m, inds, outline = true) => {
    let vCount = verts.length / 6;
    let P = new Float32Array(vCount * 3), N = new Float32Array(vCount * 3);
    transform(verts, m, P, N, 0);
    // zrcadlené umístění (záporný determinant, např. kolena a odbočky potrubí): pořadí vrcholů se obrátí,
    // jinak by byl díl rubem ven (osvětlený zevnitř, s kreslením jen předních stran by zmizel)
    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
    if (inds.length >= SIMPLIFY_MIN * 3) {
      let s = null;
      try { s = simplifyPart(P, inds, det < 0); } catch (e) { console.warn('Díl nejde zjednodušit', id, e); }
      if (s) {
        reduced.parts++; reduced.before += inds.length / 3; reduced.after += s.inds.length / 3;
        ({ P, N, inds } = s);
        vCount = P.length / 3;
      }
    }
    if (outline) {
      const e0 = edges.n;
      featureEdges(P, inds, edges);
      if (edges.n > e0) edgeRanges.push(e0, edges.n - e0, id);
    }
    const base = b.pos.n / 3;
    b.pos.reserve(vCount * 3);
    b.nrm.reserve(vCount * 3);
    b.pos.a.set(P, b.pos.n);
    b.nrm.a.set(N, b.pos.n);
    b.pos.n += vCount * 3; b.nrm.n = b.pos.n;
    const start = b.idx.n;
    b.idx.reserve(inds.length);
    const I = b.idx.a;
    if (det < 0) {
      mirrored++;
      for (let i = 0; i < inds.length; i += 3) {
        I[start + i] = inds[i] + base;
        I[start + i + 1] = inds[i + 2] + base;
        I[start + i + 2] = inds[i + 1] + base;
      }
    } else for (let i = 0; i < inds.length; i++) I[start + i] = inds[i] + base;
    b.idx.n += inds.length;
    // rozsahy indexů po prvcích: [start, počet, expressID]
    const r = b.ranges, L = r.length;
    if (L && r[L - 1] === id && r[L - 3] + r[L - 2] === start) r[L - 2] += inds.length;
    else r.push(start, inds.length, id);
    return [b.key, start, inds.length];
  };

  // převod z umístění IFC (jednotky souboru, osa Z nahoru) do souřadnic geometrie: natočení a měřítko
  // z G = F · W⁻¹ (F = matice dílu z web-ifc, W = umístění prvku), nejčastější z prvních prvků
  const samples = new Map();
  const sampleFrame = (id, flat) => {
    try {
      const pl = api.GetLine(modelID, id).ObjectPlacement;
      if (!pl) return;
      const W = new Matrix4().fromArray(api.GetWorldTransformMatrix(modelID, pl.value));
      const G = new Matrix4().fromArray(flat).multiply(W.invert());
      // jen natočení a měřítko (posun dílu vůči umístění prvku se liší, posun modelu je coord níže)
      const key = G.elements.slice(0, 12).map((x) => x.toFixed(6)).join(',');
      const e = samples.get(key);
      if (e) e.n++; else samples.set(key, { n: 1, G });
    } catch { samples.set(`chyba${samples.size}`, { n: 0, G: null }); }
  };

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
    ids.add(id);
    const geoms = mesh.geometries;
    if (samples.size < 400 && geoms.size()) sampleFrame(id, geoms.get(0).flatTransformation);
    if (doorIds.has(id)) {
      try { addDoor(id, geoms); return; } catch (e) { console.warn('Dveře nejde rozdělit na křídla', id, e); }
    }
    for (let g = 0; g < geoms.size(); g++) {
      const pg = geoms.get(g);
      const geom = api.GetGeometry(modelID, pg.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const inds = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      append(id, bucketFor(pg.color), verts, pg.flatTransformation, inds);
      geom.delete();
    }
  });

  /** Dveře: napřed díly zárubně, potom každé křídlo zvlášť (souvislé rozsahy, prohlížeč je vyjme). */
  function addDoor(id, geoms) {
    const parts = [];
    for (let g = 0; g < geoms.size(); g++) {
      const pg = geoms.get(g);
      const geom = api.GetGeometry(modelID, pg.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize()).slice();
      const inds = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize()).slice();
      geom.delete();
      const pos = new Float32Array(verts.length / 2);
      transform(verts, pg.flatTransformation, pos, null, 0);
      parts.push({ pg: { color: { x: pg.color.x, y: pg.color.y, z: pg.color.z, w: pg.color.w }, m: Array.from(pg.flatTransformation) }, verts, inds, pos, alpha: pg.color.w });
    }
    const op = ops.get(id) || '';
    const found = NOT_SWINGING.test(op) ? null : findLeaves(parts, op);
    const inLeaf = new Set(found ? found.leaves.flatMap((l) => l.parts) : []);
    for (let i = 0; i < parts.length; i++) {
      if (!inLeaf.has(i)) append(id, bucketFor(parts[i].pg.color), parts[i].verts, parts[i].pg.m, parts[i].inds);
    }
    if (!found) return;
    doors.push({
      id,
      leaves: found.leaves.map((l) => ({
        segs: l.parts.map((i) => append(id, bucketFor(parts[i].pg.color), parts[i].verts, parts[i].pg.m, parts[i].inds, false)),
        u: l.u, v: l.v, hinge: l.hinge, half: l.half,
      })),
    });
  }

  // posun, o který web-ifc model přesunul k počátku: podle něj prohlížeč zarovná modely mezi sebou
  const coord = Array.from(api.GetCoordinationMatrix(modelID));
  let G = null, best = 0;
  for (const e of samples.values()) if (e.G && e.n > best) { best = e.n; G = e.G; }
  // posun = posun modelu k počátku z web-ifc (u prvků s posunutou geometrií by F · W⁻¹ dal jiný)
  if (G) { G = G.clone(); G.elements[12] = coord[12]; G.elements[13] = coord[13]; G.elements[14] = coord[14]; }
  const storeys = G ? readStoreys(modelID, G) : [];

  const out = [];
  const transfer = [];
  const list = [...buckets.values()].filter((b) => b.idx.n);
  spatialBlocks(list, doors);
  const totalTris = Math.max(list.reduce((s, b) => s + b.idx.n, 0), 1);
  let doneTris = 0;
  // zastínění koutů (prostorová mřížka kolem ploch); výsledek jde do mezipaměti, podruhé se nepočítá
  progress('ao', 0);
  let ao = null;
  try {
    ao = aoVolume(list.map((b) => ({ position: b.pos.a.subarray(0, b.pos.n), index: b.idx.a.subarray(0, b.idx.n), color: b.color })), (v) => progress('ao', v));
  } catch (e) { console.warn('Zastínění koutů nejde spočítat', e); }
  if (ao) transfer.push(ao.data.buffer);
  progress('bvh', 0);
  for (const b of list) {
    const item = {
      key: b.key,
      color: b.color,
      position: b.pos.result(),
      normal: b.nrm.result(),
      index: b.idx.result(),
      ranges: Uint32Array.from(b.ranges),
      blocks: b.blocks || null,
      bvh: null,
    };
    transfer.push(item.position.buffer, item.normal.buffer, item.index.buffer, item.ranges.buffer);
    if (item.blocks) transfer.push(item.blocks.buffer);
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
  const edgeArr = edges.result();
  transfer.push(edgeArr.buffer);
  if (reduced.parts) console.info(`Zjednodušeno ${reduced.parts} dílů: ${reduced.before} → ${reduced.after} trojúhelníků`);
  return { meta: { schema, elements, simplified, mirrored, reduced, coord, doors, storeys, edgeRanges: Uint32Array.from(edgeRanges) }, buckets: out, edges: edgeArr, ao, transfer, ids };
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

// zprávy se zpracovávají po jedné za sebou: načítání a otevírání modelů sdílí proměnnou `api`
let chain = Promise.resolve();
self.onmessage = (e) => { chain = chain.then(() => handle(e.data)); };

async function handle({ id, type, payload }) {
  try {
    if (type === 'init') { init(payload.wasmPath); self.postMessage({ id, result: true }); return; }
    if (type === 'load') {
      currentBuffer = payload.buffer;
      try {
        const { result, transfer } = await load(payload.buffer, payload.key, payload.name);
        self.postMessage({ id, result }, transfer);
      } finally {
        currentBuffer = null;
      }
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

/**
 * Rozdělí neprůhledné skupiny barvy na prostorové bloky: prvky (celé, nerozřezané) se podle středu
 * roztřídí do krychlí a v indexech se seřadí po blocích. Prohlížeč pak kreslí každý blok zvlášť
 * (stejné pole vrcholů a indexů, jen jiný rozsah) a bloky mimo zorné pole vynechá.
 * b.blocks = Float64Array [začátek, počet indexů, minX, minY, minZ, maxX, maxY, maxZ] po blocích.
 * Rozsahy prvků (ranges) a díly křídel dveří (segs) se přepočítají na nové pořadí.
 */
function spatialBlocks(list, doors) {
  const info = [];
  for (const b of list) {
    if (b.color[3] < 0.99 || b.idx.n < MIN_SPLIT) continue; // průhledné (řazení skel) a malé skupiny celé
    const R = b.ranges, P = b.pos.a, I = b.idx.a;
    const n = R.length / 3;
    const C = new Float32Array(n * 3);
    for (let r = 0; r < n; r++) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = R[r * 3], e = i + R[r * 3 + 1]; i < e; i++) {
        const v = I[i] * 3, x = P[v], y = P[v + 1], z = P[v + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      C[r * 3] = (x0 + x1) / 2; C[r * 3 + 1] = (y0 + y1) / 2; C[r * 3 + 2] = (z0 + z1) / 2;
    }
    info.push({ b, n, C });
  }
  if (!info.length) return;
  const cellKey = (C, r, s) => `${Math.floor(C[r * 3] / s)},${Math.floor(C[r * 3 + 1] / s)},${Math.floor(C[r * 3 + 2] / s)}`;
  // bloků (= volání kreslení) na skupinu podle počtu trojúhelníků, za celý model nejvýš MAX_BLOCKS
  const tris = info.reduce((t, { b }) => t + b.idx.n / 3, 0);
  const budget = Math.min(MAX_BLOCKS - (list.length - info.length), tris / BLOCK_TRIS);
  const remap = new Map(); // klíč skupiny → { oldStart, newStart } (pro díly křídel dveří)
  for (const { b, n, C } of info) {
    const limit = Math.max(1, Math.floor(budget * (b.idx.n / 3) / tris));
    if (limit < 2) continue;
    // hrana bloku: od BLOCK_MIN zvětšovat, dokud je bloků moc
    let s = BLOCK_MIN;
    for (;;) {
      const cells = new Set();
      for (let r = 0; r < n; r++) cells.add(cellKey(C, r, s));
      if (cells.size <= limit || s > 500) break;
      s *= 1.25;
    }
    const byCell = new Map();
    for (let r = 0; r < n; r++) {
      const k = cellKey(C, r, s);
      (byCell.get(k) || byCell.set(k, []).get(k)).push(r);
    }
    if (byCell.size < 2) continue;
    const R = b.ranges, P = b.pos.a, I = b.idx.a;
    const NI = new Uint32Array(b.idx.n);
    const NR = new Array(R.length);
    const oldStart = new Uint32Array(n), newStart = new Uint32Array(n);
    const blocks = new Float64Array(byCell.size * 8);
    let o = 0, bi = 0, ri = 0;
    for (const rs of byCell.values()) {
      const start = o;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (const r of rs) {
        const st = R[r * 3], cnt = R[r * 3 + 1];
        oldStart[ri] = st; newStart[ri] = o;
        NR[ri * 3] = o; NR[ri * 3 + 1] = cnt; NR[ri * 3 + 2] = R[r * 3 + 2];
        ri++;
        for (let i = st, e = st + cnt; i < e; i++) {
          const v = I[i];
          NI[o++] = v;
          const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
          if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
      }
      blocks.set([start, o - start, x0, y0, z0, x1, y1, z1], bi * 8);
      bi++;
    }
    b.idx.a = NI;
    b.ranges = NR;
    b.blocks = blocks;
    // převod starého začátku indexu na nový: rozsahy seřazené podle starého začátku
    const order = Array.from(oldStart.keys()).sort((x, y) => oldStart[x] - oldStart[y]);
    remap.set(b.key, { starts: order.map((i) => oldStart[i]), news: order.map((i) => newStart[i]) });
  }
  // díly křídel dveří ukazují do indexů skupiny: posunout na nové místo (díl leží uvnitř rozsahu prvku)
  for (const d of doors) {
    for (const l of d.leaves) {
      for (const seg of l.segs) {
        const m = remap.get(seg[0]);
        if (!m) continue;
        let lo = 0, hi = m.starts.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (m.starts[mid] <= seg[1]) lo = mid; else hi = mid - 1; }
        seg[1] = m.news[lo] + (seg[1] - m.starts[lo]);
      }
    }
  }
}
