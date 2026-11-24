// Měření v modelu: vzdálenost laserem, vzdálenost dvou bodů (s ΔX ΔY ΔZ), souřadnice bodu X Y Z, úhel ze tří bodů.
// Body se ukládají v souřadnicích modelRoot, takže měření platí i v maketě (zmenšený model měří skutečné rozměry).
// Souřadnice X Y Z jsou v systému IFC (Z nahoru), včetně posunu modelu k počátku (coord z web-ifc).
import * as THREE from 'three';
import { t, font } from './theme.js';

/** Nástroje měření: klíč, popisek, nápověda. */
export const MEASURE_TOOLS = [
  ['laser', 'Laser', 'Vzdálenost od ovladače k místu, kam míříte; spoušť ji uloží.'],
  ['dist', 'Dva body', 'Zvolte první a druhý bod: vzdálenost a její složky ΔX, ΔY, ΔZ.'],
  ['point', 'Bod', 'Zvolte bod: souřadnice X, Y, Z v systému IFC.'],
  ['angle', 'Úhel', 'Zvolte bod na prvním rameni, vrchol a bod na druhém rameni.'],
];
const NEED = { laser: 1, dist: 2, point: 1, angle: 3 };

/** Velikost na obrazovce (podíl vzdálenosti od kamery): výška jednořádkového štítku ~1,4°, poloměr bodu ~0,26°. */
const LABEL_K = 0.025;
const DOT_K = 0.0045;
/** Přichycení k rohu a hraně prvku: do tolika (podíl vzdálenosti), nejméně 1,5 cm. */
const SNAP_K = 0.03;
const SNAP_MIN = 0.015;
/** Mřížka pro hledání hran poblíž bodu: velikost buňky (m, v souřadnicích modelu). */
const EDGE_CELL = 0.5;

const nf = (n, d) => n.toLocaleString('cs-CZ', { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmtLen = (m) => `${nf(m, 3)} m`;
const fmtAng = (deg) => `${nf(deg, 1)}°`;

export class Measure {
  constructor(viewer) {
    this.v = viewer;
    /** nástroj (klíč z MEASURE_TOOLS) a zda se právě měří (spoušť / klik měří místo výběru prvku) */
    this.tool = 'dist';
    this.active = false;
    this.snap = true;
    /** hotová měření { type, pts, values, group } a rozpracované body */
    this.items = [];
    this.pending = [];
    this.onChange = null;
    // vlastní skupina ve scéně, matice kopíruje modelRoot (mapa kreslí jen modelRoot, měření v ní nebude)
    this.root = new THREE.Group();
    this.root.name = 'measure';
    this.root.matrixAutoUpdate = false;
    viewer.scene.add(this.root);
    this.hoverGroup = new THREE.Group();
    this.root.add(this.hoverGroup);
    const accent = t('color.accent.default');
    this.lineMat = new THREE.LineBasicMaterial({ color: accent, depthTest: false, transparent: true });
    this.hoverLineMat = new THREE.LineBasicMaterial({ color: accent, depthTest: false, transparent: true, opacity: 0.6 });
    this.dotMat = new THREE.MeshBasicMaterial({ color: accent, depthTest: false, transparent: true });
    this.snapMat = new THREE.MeshBasicMaterial({ color: t('color.status.success'), depthTest: false, transparent: true });
    this.snapLineMat = new THREE.LineBasicMaterial({ color: t('color.status.success'), depthTest: false, transparent: true });
    this.dotGeo = new THREE.SphereGeometry(1, 12, 8);
    /** objekty, které drží stálou velikost na obrazovce: { obj, k, aspect } */
    this.scaled = new Set();
    this.hoverPick = null;
    this.tmp = new THREE.Vector3();
  }

  // ---------- souřadnice ----------
  /** Bod v modelRoot → souřadnice IFC { x, y, z } (Z nahoru, bez posunu k počátku). */
  toIfc(p) {
    const inv = this.v.refMatrix ? this.v.refMatrix.clone().invert() : null;
    const r = inv ? p.clone().applyMatrix4(inv) : p.clone();
    // web-ifc převádí IFC (x, y, z nahoru) na (x, z, −y)
    return { x: r.x, y: -r.z, z: r.y };
  }

  /** Rozdíl dvou bodů v osách IFC. */
  delta(a, b) {
    const A = this.toIfc(a), B = this.toIfc(b);
    return { x: B.x - A.x, y: B.y - A.y, z: B.z - A.z };
  }

  // ---------- výběr bodu ----------
  /**
   * Bod pod paprskem (zásah z viewer.intersect, ve světě). S přichycením: nejdřív roh (vrchol zasaženého
   * trojúhelníku nebo konec hrany prvku), pak nejbližší bod na hraně prvku (obrysové hrany modelu – jen
   * skutečné hrany, ne úhlopříčky trojúhelníků), jinak bod na ploše.
   * Vrátí { local (modelRoot), world, snapped: '' | 'corner' | 'edge', edge: [a, b] (modelRoot) | null }.
   */
  pick(hit) {
    if (!hit) return null;
    const world = hit.point.clone();
    let snapped = '';
    let edge = null;
    if (this.snap && hit.face && hit.object?.geometry) {
      const pos = hit.object.geometry.attributes.position;
      const r = Math.max(SNAP_MIN * this.worldScale(), hit.distance * SNAP_K);
      let best = r;
      for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
        const c = this.tmp.fromBufferAttribute(pos, i).applyMatrix4(hit.object.matrixWorld);
        const d = c.distanceTo(hit.point);
        if (d < best) { best = d; world.copy(c); snapped = 'corner'; }
      }
      const e = this.nearEdge(hit, r);
      if (e) {
        // konec hrany je roh; bod na hraně jen tam, kde poblíž není roh
        if (e.endDist < best) { best = e.endDist; world.copy(e.end); snapped = 'corner'; }
        if (!snapped && e.dist < r) { world.copy(e.point); snapped = 'edge'; edge = [e.a, e.b]; }
      }
    }
    this.v.modelRoot.updateMatrixWorld();
    const toLocal = (p) => this.v.modelRoot.worldToLocal(p.clone());
    return { local: toLocal(world), world, snapped, edge: edge && edge.map(toLocal) };
  }

  /**
   * Nejbližší obrysová hrana modelu zasaženého prvku do vzdálenosti r (svět): bod na ní, její nejbližší konec
   * a vzdálenosti (vše ve světě), nebo null. Hrany se hledají v mřížce, která se postaví při prvním použití.
   */
  nearEdge(hit, r) {
    const lines = this.v.edgeLines.get(hit.object.userData.modelID);
    if (!lines) return null;
    const P = lines.geometry.attributes.position.array;
    const grid = lines.userData.snapGrid || (lines.userData.snapGrid = buildEdgeGrid(P));
    lines.updateMatrixWorld();
    const inv = new THREE.Matrix4().copy(lines.matrixWorld).invert();
    const p = hit.point.clone().applyMatrix4(inv);
    const s = new THREE.Vector3().setFromMatrixScale(lines.matrixWorld).x;
    const rl = r / s;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), q = new THREE.Vector3(), seg = new THREE.Line3();
    let best = null;
    const seen = new Set();
    const x0 = Math.floor((p.x - rl) / EDGE_CELL), x1 = Math.floor((p.x + rl) / EDGE_CELL);
    const y0 = Math.floor((p.y - rl) / EDGE_CELL), y1 = Math.floor((p.y + rl) / EDGE_CELL);
    const z0 = Math.floor((p.z - rl) / EDGE_CELL), z1 = Math.floor((p.z + rl) / EDGE_CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const list = grid.get(`${x},${y},${z}`);
      if (!list) continue;
      for (const i of list) {
        if (seen.has(i)) continue;
        seen.add(i);
        a.fromArray(P, i * 6);
        b.fromArray(P, i * 6 + 3);
        seg.set(a, b).closestPointToPoint(p, true, q);
        const d = q.distanceTo(p);
        if (d < rl && (!best || d < best.d)) {
          const da = a.distanceTo(p), db = b.distanceTo(p);
          best = { d, q: q.clone(), a: a.clone(), b: b.clone(), end: (da < db ? a : b).clone(), endD: Math.min(da, db) };
        }
      }
    }
    if (!best) return null;
    const w = (v) => v.applyMatrix4(lines.matrixWorld);
    return { point: w(best.q), dist: best.d * s, end: w(best.end), endDist: best.endD * s, a: w(best.a), b: w(best.b) };
  }

  worldScale() { return this.v.modelRoot.scale.x; }

  // ---------- vstupy ----------
  setTool(tool) {
    this.tool = tool;
    this.clearPending();
    this.changed();
  }

  setActive(on) {
    this.active = on;
    if (!on) { this.clearPending(); this.hover(null); }
    this.changed();
  }

  /** Spoušť / klik: přidá bod; `origin` = počátek paprsku ve světě (laser). Vrátí true, když se měřilo. */
  click(pick, origin = null) {
    if (!this.active || !pick) return false;
    if (this.tool === 'laser') {
      if (!origin) return true;
      this.v.modelRoot.updateMatrixWorld();
      this.add('dist', [this.v.modelRoot.worldToLocal(origin.clone()), pick.local]);
      return true;
    }
    this.pending.push(pick.local.clone());
    if (this.pending.length >= NEED[this.tool]) {
      this.add(this.tool === 'angle' ? 'angle' : this.tool, this.pending);
      this.pending = [];
    }
    this.hover(this.hoverPick, origin);
    this.changed();
    return true;
  }

  /** Náhled pod kurzorem: bod, rozpracovaná čára / úhel, u laseru vzdálenost od počátku paprsku. */
  hover(pick, origin = null) {
    this.hoverPick = pick;
    this.clearGroup(this.hoverGroup);
    if (!this.active || !pick) { this.v.invalidate(); return; }
    const g = this.hoverGroup;
    this.dot(g, pick.local, pick.snapped ? this.snapMat : this.dotMat);
    if (pick.edge) this.line(g, pick.edge, this.snapLineMat);
    const pts = [...this.pending, pick.local];
    if (this.tool === 'laser' && origin) {
      this.v.modelRoot.updateMatrixWorld();
      const o = this.v.modelRoot.worldToLocal(origin.clone());
      this.label(g, pick.local, [fmtLen(o.distanceTo(pick.local))]);
    } else if (this.tool === 'point') {
      this.label(g, pick.local, this.pointLines(pick.local));
    } else if (pts.length >= 2) {
      for (const p of this.pending) this.dot(g, p, this.dotMat);
      if (this.tool === 'dist') {
        this.line(g, pts, this.hoverLineMat);
        this.label(g, pts[0].clone().lerp(pts[1], 0.5), this.distLines(pts[0], pts[1]));
      } else {
        this.line(g, pts, this.hoverLineMat);
        if (pts.length === 3) this.label(g, pts[1], [fmtAng(this.angle(pts))]);
      }
    }
    this.v.invalidate();
  }

  undo() {
    if (this.pending.length) this.pending.pop();
    else {
      const it = this.items.pop();
      if (it) this.disposeGroup(it.group);
    }
    this.hover(this.hoverPick);
    this.changed();
  }

  clear() {
    for (const it of this.items) this.disposeGroup(it.group);
    this.items = [];
    this.clearPending();
    this.changed();
  }

  clearPending() {
    this.pending = [];
    this.hover(null);
  }

  // ---------- výpočty a texty ----------
  angle([a, b, c]) {
    const u = a.clone().sub(b), w = c.clone().sub(b);
    if (u.lengthSq() < 1e-12 || w.lengthSq() < 1e-12) return 0;
    return THREE.MathUtils.radToDeg(u.angleTo(w));
  }

  distLines(a, b) {
    const d = this.delta(a, b);
    return [fmtLen(a.distanceTo(b)), `ΔX ${nf(d.x, 3)}  ΔY ${nf(d.y, 3)}  ΔZ ${nf(d.z, 3)}`];
  }

  pointLines(p) {
    const q = this.toIfc(p);
    return [`X ${nf(q.x, 3)}`, `Y ${nf(q.y, 3)}`, `Z ${nf(q.z, 3)}`];
  }

  /** Řádek do seznamu výsledků. */
  summary(it) {
    if (it.type === 'dist') {
      const d = this.delta(it.pts[0], it.pts[1]);
      return { title: `Vzdálenost ${fmtLen(it.pts[0].distanceTo(it.pts[1]))}`, detail: `ΔX ${nf(d.x, 3)} · ΔY ${nf(d.y, 3)} · ΔZ ${nf(d.z, 3)} m` };
    }
    if (it.type === 'point') {
      const q = this.toIfc(it.pts[0]);
      return { title: 'Bod', detail: `X ${nf(q.x, 3)} · Y ${nf(q.y, 3)} · Z ${nf(q.z, 3)} m` };
    }
    return { title: `Úhel ${fmtAng(this.angle(it.pts))}`, detail: '' };
  }

  /** Nápověda k nástroji včetně rozpracovaných bodů. */
  get hint() {
    const tool = MEASURE_TOOLS.find(([k]) => k === this.tool);
    if (this.pending.length) {
      if (this.tool === 'angle') return this.pending.length === 1 ? 'Zvolte vrchol úhlu.' : 'Zvolte bod na druhém rameni.';
      return 'Zvolte druhý bod.';
    }
    return tool ? tool[2] : '';
  }

  // ---------- scéna ----------
  add(type, pts) {
    const group = new THREE.Group();
    const p = pts.map((x) => x.clone());
    for (const x of p) this.dot(group, x, this.dotMat);
    if (type === 'dist') {
      this.line(group, p, this.lineMat);
      this.label(group, p[0].clone().lerp(p[1], 0.5), this.distLines(p[0], p[1]));
    } else if (type === 'point') {
      this.label(group, p[0], this.pointLines(p[0]));
    } else {
      this.line(group, p, this.lineMat);
      this.label(group, p[1], [fmtAng(this.angle(p))]);
    }
    this.root.add(group);
    this.items.push({ type, pts: p, group });
    this.changed();
    this.v.invalidate();
  }

  dot(group, p, mat) {
    const m = new THREE.Mesh(this.dotGeo, mat);
    m.position.copy(p);
    m.renderOrder = 41;
    m.raycast = () => {};
    group.add(m);
    this.scaled.add({ obj: m, k: DOT_K, aspect: 0 });
  }

  line(group, pts, mat) {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
    l.renderOrder = 40;
    l.frustumCulled = false;
    l.raycast = () => {};
    group.add(l);
  }

  /** Štítek s textem (řádky) nad bodem; drží stálou velikost na obrazovce. */
  label(group, p, lines) {
    const k = 3;   // rozlišení canvasu
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const f0 = font('typography.body', k), f1 = font('typography.small', k);
    const padX = 8 * k, padY = 5 * k;
    const lh0 = 20 * k, lh1 = 17 * k;
    ctx.font = f0;
    let w = ctx.measureText(lines[0]).width;
    ctx.font = f1;
    for (const s of lines.slice(1)) w = Math.max(w, ctx.measureText(s).width);
    c.width = Math.ceil(w + 2 * padX);
    c.height = Math.ceil(lh0 + (lines.length - 1) * lh1 + 2 * padY);
    ctx.fillStyle = t('color.bg.window');
    ctx.strokeStyle = t('color.accent.default');
    ctx.lineWidth = 1.5 * k;
    ctx.beginPath();
    ctx.roundRect(ctx.lineWidth / 2, ctx.lineWidth / 2, c.width - ctx.lineWidth, c.height - ctx.lineWidth, 4 * k);
    ctx.fill();
    ctx.stroke();
    ctx.textBaseline = 'middle';
    ctx.fillStyle = t('color.text.primary');
    ctx.font = f0;
    ctx.fillText(lines[0], padX, padY + lh0 / 2);
    ctx.fillStyle = t('color.text.secondary');
    ctx.font = f1;
    lines.slice(1).forEach((s, i) => ctx.fillText(s, padX, padY + lh0 + i * lh1 + lh1 / 2));
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false }));
    s.center.set(0.5, -0.35);   // nad bodem
    s.position.copy(p);
    s.renderOrder = 42;
    s.raycast = () => {};
    group.add(s);
    // výška štítku podle počtu řádků
    this.scaled.add({ obj: s, k: LABEL_K * c.height / (lh0 + 2 * padY), aspect: c.width / c.height });
  }

  clearGroup(g) {
    for (const ch of [...g.children]) this.disposeObj(ch);
  }

  disposeGroup(g) {
    this.clearGroup(g);
    g.removeFromParent();
  }

  disposeObj(o) {
    for (const s of this.scaled) if (s.obj === o) this.scaled.delete(s);
    if (o.isLine) o.geometry.dispose();
    if (o.isSprite) { o.material.map.dispose(); o.material.dispose(); }
    o.removeFromParent();
  }

  /** Každý snímek: měření sleduje modelRoot, štítky a body drží velikost na obrazovce. */
  tick(camera) {
    if (!this.root.children.length || (!this.items.length && !this.hoverGroup.children.length)) return;
    const mr = this.v.modelRoot;
    mr.updateMatrixWorld();
    this.root.matrix.copy(mr.matrixWorld);
    this.root.matrixWorldNeedsUpdate = true;
    const cam = camera.getWorldPosition(this.tmp);
    const s = this.worldScale();
    const wp = new THREE.Vector3();
    for (const { obj, k, aspect } of this.scaled) {
      obj.getWorldPosition(wp);
      const h = Math.max(wp.distanceTo(cam), 0.05) * k / s;
      if (aspect) obj.scale.set(h * aspect, h, 1);
      else obj.scale.setScalar(h);
    }
  }

  changed() { this.onChange?.(); }
}

/**
 * Mřížka hran (souřadnice modelu): buňka → čísla úseček, které jí procházejí. Dlouhá hrana se zapíše
 * do všech buněk podél sebe (vzorkuje se po půl buňce).
 */
function buildEdgeGrid(P) {
  const grid = new Map();
  const n = P.length / 6;
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const dx = P[o + 3] - P[o], dy = P[o + 4] - P[o + 1], dz = P[o + 5] - P[o + 2];
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / (EDGE_CELL * 0.5)));
    let last = '';
    for (let k = 0; k <= steps; k++) {
      const f = k / steps;
      const key = `${Math.floor((P[o] + dx * f) / EDGE_CELL)},${Math.floor((P[o + 1] + dy * f) / EDGE_CELL)},${Math.floor((P[o + 2] + dz * f) / EDGE_CELL)}`;
      if (key === last) continue;
      last = key;
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      if (list[list.length - 1] !== i) list.push(i);
    }
  }
  return grid;
}
