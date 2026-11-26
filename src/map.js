// Mapa: půdorys podlaží (pohled shora, řez 1,2 m nad podlahou) a přesun na místo kliknutím.
// Půdorys se kreslí do obrázku jednou pro každé podlaží a pamatuje se, dokud se nezmění modely.
import * as THREE from 'three';
import { t } from './theme.js';

/** Výška řezu nad podlahou (jako výkres půdorysu). */
const CUT = 1.2;
/** Pod podlahu se kreslí jen kousek (podlahová deska), nižší podlaží se skryje. */
const BELOW = 0.25;
/** Podlaží různých modelů blíž než tolik metrů jsou jedno podlaží. */
const SAME_LEVEL = 0.3;
/** Přesun na plochu nejvýš tolik nad podlahou podlaží (schod, práh), ne na stůl nebo parapet. */
const MAX_STEP = 0.45;
const SIZE = 1024;
/** Největší přiblížení mapy (násobek celého půdorysu). */
export const ZOOM_MAX = 12;
/** Ostrý výřez se kreslí, až se přiblížení na chvíli zastaví (do té doby zvětšený celý půdorys). */
const SHARP_AFTER = 180;

/**
 * Přiblížení mapy: k = násobek (1 = celý půdorys), u0, v0 = levý horní roh výřezu (0–1), t = čas změny.
 * Výřez má stejný poměr stran jako celý půdorys (velikost 1/k).
 */
export const fullView = () => ({ k: 1, u0: 0, v0: 0, t: 0 });

/** Přiblíží (factor > 1) / oddálí výřez tak, že bod výřezu (fu, fv v rozsahu 0–1) zůstane na místě. */
export function zoomView(view, factor, fu = 0.5, fv = 0.5) {
  const k = Math.min(ZOOM_MAX, Math.max(1, view.k * factor));
  const u = view.u0 + fu / view.k, v = view.v0 + fv / view.k;
  return clampView({ k, u0: u - fu / k, v0: v - fv / k });
}

/** Posune výřez o (dfu, dfv) jeho velikosti (tažení mapy). */
export function panView(view, dfu, dfv) {
  return clampView({ k: view.k, u0: view.u0 - dfu / view.k, v0: view.v0 - dfv / view.k });
}

function clampView({ k, u0, v0 }) {
  const m = 1 - 1 / k;
  return { k, u0: Math.min(m, Math.max(0, u0)), v0: Math.min(m, Math.max(0, v0)), t: performance.now() };
}

/** Bod výřezu (fu, fv) → bod celého půdorysu (u, v). */
export const viewToPlan = (view, fu, fv) => ({ u: view.u0 + fu / view.k, v: view.v0 + fv / view.k });
/** Bod celého půdorysu (u, v) → bod výřezu (fu, fv); mimo výřez je mimo 0–1. */
export const planToView = (view, u, v) => ({ fu: (u - view.u0) * view.k, fv: (v - view.v0) * view.k });

export class PlanMap {
  constructor(viewer) {
    this.v = viewer;
    this.cache = new Map();
    this.version = 0;
    this.ray = new THREE.Raycaster();
    this.ray.firstHitOnly = true;
  }

  /** Půdorysy se nakreslí znovu (změna modelů, viditelnosti, barvy). */
  invalidate() { this.version++; this.cache.clear(); this.zoomKey = null; this.zoomCanvas = null; }

  /**
   * Podlaží všech modelů sloučená podle výšky: [{ name (všechny názvy), label (krátký popisek), y }] odspodu.
   * Popisek bez společné předpony a přípony v modelu („SO101_1NP“, „SO101_2NP“ → „1NP“, „2NP“); když se
   * podlaží v modelech jmenuje různě, vezme se nejčastější název. Stejné popisky různých výšek (podlaží
   * dvou objektů) dostanou předponu objektu, nebo výšku. Podlaží mimo geometrii (výškový bod „0,000 m n. m.“) se vynechají.
   */
  levels() {
    const bb = this.v.bbox;
    const storeys = this.v.storeys.filter((st) => bb.isEmpty() || (st.y >= bb.min.y - 1 && st.y <= bb.max.y));
    const short = new Map();
    const prefix = new Map(); // odříznutá předpona bez oddělovače („SO101“): odliší stejná podlaží dvou objektů
    for (const model of new Set(storeys.map((st) => st.model))) {
      const names = [...new Set(storeys.filter((st) => st.model === model).map((st) => st.name))];
      const pre = commonPrefix(names), suf = commonSuffix(names.map((n) => n.slice(pre)));
      for (const n of names) {
        short.set(`${model}|${n}`, n.slice(pre, n.length - suf).trim() || n);
        prefix.set(`${model}|${n}`, n.slice(0, pre).replace(/[_\s\-–]+$/, ''));
      }
    }
    // jeden model jen s jedním podlažím nemá s čím porovnat: zkrátit podle popisků ostatních („SO101_1NP“ → „1NP“)
    const known = new Set(short.values());
    for (const [k, label] of short) {
      const m = label.match(/^.+?[_\s\-–]+(.+)$/);
      if (m && known.has(m[1]) && !known.has(label)) { short.set(k, m[1]); prefix.set(k, label.slice(0, -m[1].length).replace(/[_\s\-–]+$/, '')); }
    }
    const out = [];
    for (const st of storeys) {
      let l = out.find((x) => Math.abs(x.y - st.y) < SAME_LEVEL);
      if (!l) out.push((l = { names: [], counts: new Map(), pre: new Map(), y: st.y, elev: st.elev }));
      const label = short.get(`${st.model}|${st.name}`);
      const pr = prefix.get(`${st.model}|${st.name}`);
      if (pr) (l.pre.get(label) || l.pre.set(label, new Set()).get(label)).add(pr);
      if (!l.names.includes(st.name)) l.names.push(st.name);
      l.counts.set(label, (l.counts.get(label) || 0) + 1);
      // výška vůči ±0,00 budovy (modely území mají výšky nad mořem)
      if (st.elev != null && (l.elev == null || Math.abs(st.elev) < Math.abs(l.elev))) l.elev = st.elev;
    }
    const res = out.map((l) => {
      const label = [...l.counts].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
      const pre = l.pre.get(label);
      return { name: l.names.join(' / '), label, y: l.y, elev: l.elev, pre: pre?.size === 1 ? [...pre][0] : '' };
    });
    // stejný popisek u víc výšek: předpona objektu („SO102 1PP“), když je u každé jiná, jinak výška
    const groups = new Map();
    for (const l of res) (groups.get(l.label) || groups.set(l.label, []).get(l.label)).push(l);
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const byPre = g.every((l) => l.pre) && new Set(g.map((l) => l.pre)).size === g.length;
      for (const l of g) {
        if (byPre) l.label = `${l.pre} ${l.label}`;
        else if (l.elev != null) l.label = `${l.label} ${fmtElev(l.elev)}`;
      }
    }
    return res.map(({ name, label, y }) => ({ name, label, y }));
  }

  /** Index podlaží, na kterém je výška y (podlaha pod ní). */
  levelAt(y) {
    const ls = this.levels();
    let i = 0;
    for (let k = 0; k < ls.length; k++) if (ls[k].y <= y + 0.3) i = k;
    return i;
  }

  /** Obálka půdorysu (v souřadnicích modelu): minX, minZ, w, d. */
  bounds() {
    const bb = this.v.bbox;
    const m = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.03 + 1;
    return { minX: bb.min.x - m, minZ: bb.min.z - m, w: bb.max.x - bb.min.x + 2 * m, d: bb.max.z - bb.min.z + 2 * m };
  }

  /** Obrázek půdorysu podlaží (canvas); sever = −Z nahoře. */
  plan(level) {
    const key = `${level.y.toFixed(2)}|${this.version}`;
    let c = this.cache.get(key);
    if (!c) { c = this.render(level); this.cache.set(key, c); }
    return c;
  }

  /**
   * Nakreslí půdorys podlaží ve výřezu `view` do obdélníku (x, y, w, h). Přiblížený výřez se vykreslí
   * znovu ostře (pamatuje se jeden), během přibližování se kreslí zvětšený celý půdorys.
   * Vrátí true, když je výřez zatím neostrý (volající ho má za chvíli překreslit).
   */
  draw(ctx, level, view, x, y, w, h) {
    const full = this.plan(level).canvas;
    if (view.k <= 1) { ctx.drawImage(full, x, y, w, h); return false; }
    const key = `${level.y.toFixed(2)}|${this.version}|${view.k.toFixed(4)}|${view.u0.toFixed(5)}|${view.v0.toFixed(5)}`;
    if (key !== this.zoomKey && performance.now() - view.t >= SHARP_AFTER) {
      const b = this.bounds();
      this.zoomCanvas = this.render(level, { minX: b.minX + view.u0 * b.w, minZ: b.minZ + view.v0 * b.d, w: b.w / view.k, d: b.d / view.k }).canvas;
      this.zoomKey = key;
    }
    if (key === this.zoomKey) { ctx.drawImage(this.zoomCanvas, x, y, w, h); return false; }
    ctx.drawImage(full, view.u0 * full.width, view.v0 * full.height, full.width / view.k, full.height / view.k, x, y, w, h);
    return true;
  }

  render(level, b = this.bounds()) {
    const v = this.v, r = v.renderer;
    const scale = SIZE / Math.max(b.w, b.d);
    const W = Math.max(1, Math.round(b.w * scale)), H = Math.max(1, Math.round(b.d * scale));
    const top = level.y + CUT;
    const cam = new THREE.OrthographicCamera(-b.w / 2, b.w / 2, b.d / 2, -b.d / 2, 0.1, top - v.bbox.min.y + 20);
    cam.position.set(b.minX + b.w / 2, top + 10, b.minZ + b.d / 2);
    cam.up.set(0, 0, -1);
    cam.lookAt(b.minX + b.w / 2, level.y, b.minZ + b.d / 2);
    cam.updateMatrixWorld();

    // dočasně: jen modely v souřadnicích modelu, řez, oboustranné plochy (řezané zdi jsou tmavé)
    const saved = {
      xr: r.xr.enabled, target: r.getRenderTarget(), clip: r.clippingPlanes, bg: v.scene.background,
      root: v.modelRoot.matrix.clone(), rootAuto: v.modelRoot.matrixAutoUpdate,
      hidden: v.scene.children.filter((o) => o !== v.modelRoot && !o.isLight && o.visible),
      sides: new Map(),
    };
    for (const o of saved.hidden) o.visible = false;
    saved.moses = v.moses.uniforms.mosesRadius.value;
    v.moses.uniforms.mosesRadius.value = 0;
    for (const m of v.meshes) if (!saved.sides.has(m.material)) { saved.sides.set(m.material, m.material.side); m.material.side = THREE.DoubleSide; }
    v.modelRoot.matrixAutoUpdate = false;
    v.modelRoot.matrix.identity();
    v.modelRoot.updateMatrixWorld(true);
    r.xr.enabled = false;
    r.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), top), new THREE.Plane(new THREE.Vector3(0, 1, 0), -(level.y - BELOW))];
    v.scene.background = new THREE.Color(t('color.bg.window'));
    const rt = new THREE.WebGLRenderTarget(W, H, { samples: 4 });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const px = new Uint8Array(W * H * 4);
    try {
      r.setRenderTarget(rt);
      r.clear();
      r.render(v.scene, cam);
      r.readRenderTargetPixels(rt, 0, 0, W, H, px);
    } finally {
      r.setRenderTarget(saved.target);
      r.clippingPlanes = saved.clip;
      r.xr.enabled = saved.xr;
      v.scene.background = saved.bg;
      v.moses.uniforms.mosesRadius.value = saved.moses;
      for (const o of saved.hidden) o.visible = true;
      for (const [mat, side] of saved.sides) mat.side = side;
      v.modelRoot.matrix.copy(saved.root);
      v.modelRoot.matrixAutoUpdate = saved.rootAuto;
      v.modelRoot.updateMatrixWorld(true);
      rt.dispose();
      v.invalidate();
    }
    // pixely z grafické karty jsou odspodu: obrátit řádky
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const img = canvas.getContext('2d').createImageData(W, H);
    for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    canvas.getContext('2d').putImageData(img, 0, 0);
    return { canvas, bounds: b };
  }

  /** Bod obrázku (u, v v rozsahu 0–1) → souřadnice modelu x, z. */
  toModel(u, w) {
    const b = this.bounds();
    return { x: b.minX + u * b.w, z: b.minZ + w * b.d };
  }

  /** Souřadnice modelu → bod obrázku (u, v). */
  toMap(x, z) {
    const b = this.bounds();
    return { u: (x - b.minX) / b.w, v: (z - b.minZ) / b.d };
  }

  /**
   * Místo pro přesun na podlaží: podlaha pod bodem (x, z) mezi řezem a kouskem pod podlahou.
   * Vrátí bod podlahy v souřadnicích modelu, nebo null (mimo budovu, ve zdi, bez podlahy).
   */
  floorAt(level, x, z) {
    const v = this.v;
    // oboustranné plochy: když bod leží uvnitř zdi, první zásah je rub její spodní plochy (normála dolů)
    const sides = new Map();
    for (const m of v.meshes) if (!sides.has(m.material)) { sides.set(m.material, m.material.side); m.material.side = THREE.DoubleSide; }
    const root = v.modelRoot.matrix.clone(), auto = v.modelRoot.matrixAutoUpdate;
    v.modelRoot.matrixAutoUpdate = false;
    v.modelRoot.matrix.identity();
    v.modelRoot.updateMatrixWorld(true);
    let hit = null;
    const mosesR = v.moses.uniforms.mosesRadius.value;
    v.moses.uniforms.mosesRadius.value = 0;
    try {
      this.ray.set(new THREE.Vector3(x, level.y + CUT, z), new THREE.Vector3(0, -1, 0));
      this.ray.far = CUT + BELOW + 0.6;
      hit = this.v.intersect(this.ray);
    } finally {
      for (const [mat, side] of sides) mat.side = side;
      v.moses.uniforms.mosesRadius.value = mosesR;
      v.modelRoot.matrix.copy(root);
      v.modelRoot.matrixAutoUpdate = auto;
      v.modelRoot.updateMatrixWorld(true);
    }
    if (!hit?.face) return null;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (n.y < 0.7) return null; // uvnitř zdi (rub její spodní plochy), strmá plocha
    // podlaha podlaží nebo schod; výš je nábytek nebo parapet, níž díra v podlaze
    if (hit.point.y > level.y + MAX_STEP || hit.point.y < level.y - BELOW - 0.5) return null;
    return hit.point;
  }
}

/**
 * Délka společné přípony názvů podlaží, kterou jde odříznout (od oddělovače „_“, mezery, „-“, „(“),
 * nebo 0. Jeden název nic neodřízne.
 */
/** Délka společné předpony názvů, jen do oddělovače („SO101_“); u jednoho názvu 0. */
function commonPrefix(names) {
  if (names.length < 2) return 0;
  const ref = names[0];
  let k = 0;
  while (k < ref.length && names.every((n) => n.length > k && n[k] === ref[k])) k++;
  const m = ref.slice(0, k).match(/^.*[_\s\-–]/);
  const n = m ? m[0].length : 0;
  return n && names.every((x) => x.length > n) ? n : 0;
}

/** Výška podlaží v m se znaménkem a čárkou („+4,50“, „−3,90“). */
function fmtElev(e) {
  const r = Math.round(e * 100) / 100;
  return `${r < 0 ? '−' : '+'}${Math.abs(r).toFixed(2).replace('.', ',')}`;
}

function commonSuffix(names) {
  if (names.length < 2) return 0;
  const ref = names[0];
  let k = 0;
  while (k < ref.length && names.every((n) => n.length > k && n[n.length - 1 - k] === ref[ref.length - 1 - k])) k++;
  const suffix = ref.slice(ref.length - k).replace(/^[^_\s\-–(]*/, '');
  return suffix.length >= 2 && names.every((n) => n.length > suffix.length) ? suffix.length : 0;
}

/** Značka uživatele v mapě: kolečko a výseč pohledu (dx, dy = směr pohledu v rovině obrázku). */
export function drawUser(ctx, x, y, dx, dy, r) {
  const a = Math.atan2(dy, dx);
  ctx.save();
  ctx.fillStyle = t('color.accent.default');
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.arc(x, y, r * 3.2, a - 0.55, a + 0.55);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.35);
  ctx.strokeStyle = t('color.text.primary');
  ctx.stroke();
  ctx.restore();
}
