// Web Worker: načte IFC přes web-ifc, sloučí geometrii podle barvy a vrátí ji hlavnímu vláknu.
// Model zůstává otevřený, aby šly dotazovat vlastnosti vybraného prvku.
import * as WebIFC from 'web-ifc';

const api = new WebIFC.IfcAPI();
let ready = null;
let modelID = -1;
let storeyOf = new Map();
const storeyNames = new Map();

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

function idsOfType(type) {
  const out = [];
  const v = api.GetLineIDsWithType(modelID, type, true);
  for (let i = 0; i < v.size(); i++) out.push(v.get(i));
  return out;
}

const val = (x) => (x == null ? null : typeof x === 'object' && 'value' in x ? x.value : x);

async function load(buffer) {
  if (modelID >= 0) { api.CloseModel(modelID); modelID = -1; }
  storeyOf = new Map();
  storeyNames.clear();

  progress('parse', 0);
  modelID = api.OpenModel(new Uint8Array(buffer), { COORDINATE_TO_ORIGIN: true });
  if (modelID < 0) throw new Error('Soubor se nepodařilo otevřít jako IFC.');
  const schema = api.GetModelSchema(modelID);

  const skip = new Set([...idsOfType(WebIFC.IFCSPACE), ...idsOfType(WebIFC.IFCOPENINGELEMENT)]);

  const buckets = new Map();
  let elements = 0;
  let lastPct = -1;
  api.StreamAllMeshes(modelID, (mesh, index, total) => {
    const pct = Math.floor((index / Math.max(total, 1)) * 100);
    if (pct !== lastPct) { lastPct = pct; progress('geometry', index / Math.max(total, 1)); }
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

  progress('structure', 0);
  try {
    const tree = await api.properties.getSpatialStructure(modelID);
    const walk = (node, storey) => {
      const isStorey = node.type === 'IFCBUILDINGSTOREY' || node.type === WebIFC.IFCBUILDINGSTOREY;
      if (isStorey) {
        storey = node.expressID;
        const line = api.GetLine(modelID, storey);
        storeyNames.set(storey, val(line.Name) || val(line.LongName) || `Podlaží ${storey}`);
      } else if (storey != null) storeyOf.set(node.expressID, storey);
      for (const ch of node.children || []) walk(ch, storey);
    };
    walk(tree, null);
  } catch (e) {
    console.warn('Prostorovou strukturu nejde načíst', e);
  }

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
  return { result: { schema, elements, buckets: out }, transfer };
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

async function props(id) {
  if (modelID < 0) return null;
  const line = api.GetLine(modelID, id);
  const storey = storeyOf.get(id);
  const out = {
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
      self.postMessage({ id, result: await props(payload.expressID) });
    }
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
