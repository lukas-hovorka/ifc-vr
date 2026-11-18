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

export class PlanMap {
  constructor(viewer) {
    this.v = viewer;
    this.cache = new Map();
    this.version = 0;
    this.ray = new THREE.Raycaster();
    this.ray.firstHitOnly = true;
  }

  /** Půdorysy se nakreslí znovu (změna modelů, viditelnosti, barvy). */
  invalidate() { this.version++; this.cache.clear(); }

  /** Podlaží všech modelů sloučená podle výšky: [{ name, label (krátký popisek), y }] odspodu. */
  levels() {
    const out = [];
    for (const st of this.v.storeys) {
      const same = out.find((l) => Math.abs(l.y - st.y) < SAME_LEVEL);
      if (!same) out.push({ name: st.name, label: st.name, y: st.y });
    }
    // krátké popisky: bez společné přípony („1.NP_SO-101“, „2.NP_SO-101“ → „1.NP“, „2.NP“)
    if (out.length > 1) {
      let k = 0;
      const ref = out[0].name;
      while (k < ref.length && out.every((l) => l.name.length > k && l.name[l.name.length - 1 - k] === ref[ref.length - 1 - k])) k++;
      const suffix = ref.slice(ref.length - k).replace(/^[^_\s\-–(]*/, '');
      if (suffix.length >= 2 && out.every((l) => l.name.length > suffix.length)) {
        for (const l of out) l.label = l.name.slice(0, l.name.length - suffix.length).trim();
      }
    }
    return out;
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

  render(level) {
    const v = this.v, r = v.renderer, b = this.bounds();
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
