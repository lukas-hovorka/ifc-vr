// Web Worker: načte IFC přes web-ifc, sloučí geometrii podle barvy a vrátí ji hlavnímu vláknu.
// Modely zůstávají otevřené, aby šly dotazovat vlastnosti vybraného prvku. Najednou jich může být víc
// (např. profese stavby): všechny se umístí do souřadnic prvního načteného modelu.
import * as WebIFC from 'web-ifc';

const api = new WebIFC.IfcAPI();
let ready = null;
/** modelID → { parentOf, storeyNames }: rodič prvku (podlaží, prostor, celek) a názvy podlaží */
const models = new Map();
/** Matice posunu k počátku prvního modelu; další modely se k ní vztahují. */
let refMatrix = null;

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

const progress = (phase, value) => self.postMessage({ type: 'progress', phase, value });

function init(wasmPath) {
  if (!ready) {
    api.SetWasmPath(wasmPath, true);
    ready = api.Init(undefined, true).then(() => api.SetLogLevel?.(WebIFC.LogLevel.LOG_LEVEL_OFF));
  }
  return ready;
}

function idsOfType(modelID, type) {
  const out = [];
  const v = api.GetLineIDsWithType(modelID, type, true);
  for (let i = 0; i < v.size(); i++) out.push(v.get(i));
  return out;
}

const val = (x) => (x == null ? null : typeof x === 'object' && 'value' in x ? x.value : x);

// 4×4 matice po sloupcích (jako v three.js / web-ifc)
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
/** Inverze afinní matice (rotace/měřítko + posun). */
function invAffine(m) {
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  const k = 1 / det;
  const r = [
    (e * i - f * h) * k, (c * h - b * i) * k, (b * f - c * e) * k, 0,
    (f * g - d * i) * k, (a * i - c * g) * k, (c * d - a * f) * k, 0,
    (d * h - e * g) * k, (b * g - a * h) * k, (a * e - b * d) * k, 0,
    0, 0, 0, 1,
  ];
  const tx = m[12], ty = m[13], tz = m[14];
  r[12] = -(r[0] * tx + r[4] * ty + r[8] * tz);
  r[13] = -(r[1] * tx + r[5] * ty + r[9] * tz);
  r[14] = -(r[2] * tx + r[6] * ty + r[10] * tz);
  return r;
}
const FAR_APART = 10000; // m
const isIdentity = (m) => m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9);

async function load(buffer) {
  progress('parse', 0);
  const modelID = api.OpenModel(new Uint8Array(buffer), { COORDINATE_TO_ORIGIN: true });
  if (modelID < 0) throw new Error('Soubor se nepodařilo otevřít jako IFC.');
  const parentOf = new Map();
  const storeyNames = new Map();
  models.set(modelID, { parentOf, storeyNames });
  const schema = api.GetModelSchema(modelID);

  const skip = new Set([...idsOfType(modelID, WebIFC.IFCSPACE), ...idsOfType(modelID, WebIFC.IFCOPENINGELEMENT)]);

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

  // každý model posune web-ifc k vlastnímu počátku; další modely se vrátí do souřadnic prvního
  // (dál než FAR_APART od sebe = jiný souřadnicový systém, model zůstane v počátku)
  const coord = api.GetCoordinationMatrix(modelID);
  let aligned = true;
  if (!refMatrix) refMatrix = coord;
  else {
    const R = mul(refMatrix, invAffine(coord));
    aligned = Math.hypot(R[12], R[13], R[14]) <= FAR_APART;
    if (aligned && !isIdentity(R)) {
      for (const b of buckets.values()) {
        const P = b.pos.a, N = b.nrm.a;
        for (let o = 0; o < b.pos.n; o += 3) {
          const x = P[o], y = P[o + 1], z = P[o + 2];
          P[o] = R[0] * x + R[4] * y + R[8] * z + R[12];
          P[o + 1] = R[1] * x + R[5] * y + R[9] * z + R[13];
          P[o + 2] = R[2] * x + R[6] * y + R[10] * z + R[14];
          const a = N[o], bb = N[o + 1], cc = N[o + 2];
          N[o] = R[0] * a + R[4] * bb + R[8] * cc;
          N[o + 1] = R[1] * a + R[5] * bb + R[9] * cc;
          N[o + 2] = R[2] * a + R[6] * bb + R[10] * cc;
        }
      }
    }
  }

  // struktura: jen vazby umístění a skladby (rychlé i u velkých modelů, s průběhem);
  // podlaží prvku se dohledá až při výběru, nahoru po rodičích
  progress('structure', 0);
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
      if (pct !== last) { last = pct; progress('structure', i / rels.length); }
      const rel = api.GetLine(modelID, id);
      const parent = val(rel[from]);
      for (const ch of rel[to] || []) { const c = val(ch); if (c != null && !parentOf.has(c)) parentOf.set(c, parent); }
    });
  } catch (e) {
    console.warn('Prostorovou strukturu nejde načíst', e);
  }
  progress('structure', 1);

  const out = [];
  const transfer = [];
  for (const b of buckets.values()) {
    if (!b.idx.n) continue;
    const item = {
      color: b.color,
      position: b.pos.result(),
      normal: b.nrm.result(),
      index: b.idx.result(),
      ranges: Uint32Array.from(b.ranges),
    };
    transfer.push(item.position.buffer, item.normal.buffer, item.index.buffer, item.ranges.buffer);
    out.push(item);
  }
  return { result: { modelID, schema, elements, aligned, buckets: out }, transfer };
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

function close(modelID) {
  if (!models.has(modelID)) return;
  api.CloseModel(modelID);
  models.delete(modelID);
  if (!models.size) refMatrix = null;
}

async function props(modelID, id) {
  const m = models.get(modelID);
  if (!m) return null;
  const { parentOf, storeyNames } = m;
  const line = api.GetLine(modelID, id);
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
      const all = await api.properties.getPropertySets(modelID, id, true, withType);
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

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    if (type === 'init') { await init(payload.wasmPath); self.postMessage({ id, result: true }); return; }
    await ready;
    if (type === 'load') {
      const { result, transfer } = await load(payload.buffer);
      self.postMessage({ id, result }, transfer);
    } else if (type === 'props') {
      self.postMessage({ id, result: await props(payload.modelID, payload.expressID) });
    } else if (type === 'close') {
      close(payload.modelID);
      self.postMessage({ id, result: true });
    }
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
