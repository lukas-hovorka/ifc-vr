// Mojžíšův mód: model kolem uživatele „ustoupí“ – ve válci kolem něj se nad úrovní jeho nohou
// nekreslí nic (zdi, stropy, nábytek), podlaha pod ním zůstane. Okraj výřezu je zvýrazněný.
// Řeší se v shaderu (discard), geometrie se nemění: zapnutí i pohyb jsou okamžité a nic nestojí.
import * as THREE from 'three';
import { t } from './theme.js';

/** Poloměry výřezu v metrech, které jde zvolit (0 = vypnuto). */
export const MOSES_RADII = [0, 3, 6, 10];
/** Šířka zvýrazněného okraje výřezu v metrech. */
const RIM = 0.08;
/** Výřez začíná kousek nad nohama, aby podlaha (i s nášlapnou vrstvou) zůstala. */
const FLOOR_KEEP = 0.05;
/** Doba, za kterou výřez naroste na zvolený poloměr (s). */
const GROW_TIME = 0.6;

export class Moses {
  constructor() {
    /** sdílené uniformy všech materiálů modelu */
    this.uniforms = {
      mosesRadius: { value: 0 },
      mosesCenter: { value: new THREE.Vector3() },  // x, z = osa válce, y = úroveň nohou (svět)
      mosesRim: { value: new THREE.Color(t('color.accent.default')) },
    };
    this.target = 0;
    /** materiály s výřezem; `discard` v shaderu je jen při zapnutém módu (MOSES_CUT) */
    this.mats = new Set();
    this.cut = false;
  }

  get active() { return this.uniforms.mosesRadius.value > 0.001; }

  /** Zvolený poloměr (0 = vypnout); výřez se rozevře / zavře plynule. */
  setRadius(r) { this.target = r; }

  /** Osa výřezu (svět): x, z a úroveň nohou y. */
  setCenter(x, feetY, z) { this.uniforms.mosesCenter.value.set(x, feetY + FLOOR_KEEP, z); }

  /** Rozevírání; vrátí true, když se poloměr změnil (je potřeba překreslit). */
  tick(dt) {
    const u = this.uniforms.mosesRadius;
    this.setCut(this.target > 0 || this.active);
    if (u.value === this.target) return false;
    const step = (Math.max(this.target, u.value, 1) / GROW_TIME) * dt;
    u.value = Math.abs(this.target - u.value) <= step ? this.target : u.value + Math.sign(this.target - u.value) * step;
    return true;
  }

  /**
   * Výřez do shaderů přidat / odebrat. Samotný příkaz discard v shaderu (i když se nikdy neprovede)
   * vypne na grafice brýlí včasné zahazování zakrytých bodů: bez módu by se počítala barva i všech zdí
   * za sebou. Proto je jen v shaderech, když je mód zapnutý (přepnutí shadery jednou přeloží).
   */
  setCut(on) {
    if (on === this.cut) return;
    this.cut = on;
    for (const m of this.mats) setDefine(m, 'MOSES_CUT', on);
  }

  /** Materiál se ruší: přestat ho sledovat. */
  forget(mat) { this.mats.delete(mat); }

  /** Je bod (svět) ve výřezu, tedy nekreslí se a nejde vybrat? */
  hides(p) {
    const u = this.uniforms;
    if (u.mosesRadius.value <= 0.001) return false;
    const c = u.mosesCenter.value;
    return p.y > c.y && Math.hypot(p.x - c.x, p.z - c.z) < u.mosesRadius.value;
  }

  /** Doplní do materiálu výřez (shader). Materiál si drží sdílené uniformy. `extra(shader)` = další úprava shaderu. */
  patch(mat, extra = null) {
    const uniforms = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vMosesPos;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvMosesPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vMosesPos;\nuniform float mosesRadius;\nuniform vec3 mosesCenter;\nuniform vec3 mosesRim;')
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          #ifdef MOSES_CUT
          float mosesD = length(vMosesPos.xz - mosesCenter.xz);
          bool mosesAbove = vMosesPos.y > mosesCenter.y;
          if (mosesRadius > 0.001 && mosesAbove && mosesD < mosesRadius) discard;
          #endif`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
          #ifdef MOSES_CUT
          if (mosesRadius > 0.001 && mosesAbove && mosesD < mosesRadius + ${RIM.toFixed(3)}) gl_FragColor.rgb = mosesRim;
          #endif`);
      extra?.(shader);
    };
    mat.customProgramCacheKey = () => (extra ? 'moses+' : 'moses');
    this.mats.add(mat);
    setDefine(mat, 'MOSES_CUT', this.cut);
  }
}

/** Zapne / vypne define materiálu (shader se při další kresbě přeloží jen při změně). */
export function setDefine(mat, name, on) {
  mat.defines = mat.defines || {};
  if (on === (name in mat.defines)) return;
  if (on) mat.defines[name] = ''; else delete mat.defines[name];
  mat.needsUpdate = true;
}
