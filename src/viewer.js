// 3D scéna: model, světla, podlaha, výběr a zvýraznění prvků.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshBVH, computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { t } from './theme.js';
import { QUALITY } from './quality.js';
import { Moses, setDefine } from './moses.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** Modely dál od sebe než tolik metrů mají jiný souřadnicový systém a nezarovnávají se. */
const FAR_APART = 10000;
/** Otevření dveří (90°) trvá tolik sekund. */
const DOOR_TIME = 0.8;
/** Automatické dveře se otevírají rychleji (ať jsou otevřené, než k nim uživatel dojde). */
const AUTO_DOOR_TIME = 0.4;
/** Automatické dveře: otevřou se, když je uživatel blíž než tolik metrů od středu dveří (půdorysně)… */
const AUTO_OPEN = 2.0;
/** …a zavřou se, až se vzdálí víc než tolik metrů. */
const AUTO_CLOSE = 3.0;
/**
 * Mřížka leží kousek pod podlahou 1NP: ve stejné výšce by prosvítala přes podlahové desky (z-fighting)
 * a desky s horní hranou o pár mm níž by překryla úplně.
 */
export const GRID_BELOW = 0.05;
const doorKey = (ref) => `${ref.model}:${ref.id}`;

/**
 * Zastínění koutů: hodnota z prostorové mřížky modelu (spočítal worker) v bodě kousek před plochou.
 * Zakrytí volné plochy (jedna rovina vedle bodu) je AO_BASE, ztmavuje se jen nad ním (kouty, spoje).
 */
const AO_BASE = 0.32;
const AO_STRENGTH = 1.8;
const AO_MIN = 0.4;
function shadeAO(uniforms) {
  return (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float aoOffset;\nvarying vec3 vAoPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAoPos = transformed + normalize(objectNormal) * aoOffset;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
#ifdef AO_VOLUME
uniform highp sampler3D aoTex;
#endif
uniform vec3 aoOrigin;
uniform vec3 aoSize;
varying vec3 vAoPos;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
#ifdef AO_VOLUME
float aoOcc = texture(aoTex, (vAoPos - aoOrigin) / aoSize).r;
diffuseColor.rgb *= clamp(1.0 - ${AO_STRENGTH.toFixed(2)} * max(aoOcc - ${AO_BASE.toFixed(2)}, 0.0), ${AO_MIN.toFixed(2)}, 1.0);
#endif`);
  };
}

/** Prostorová textura zastínění z výsledku workeru ({ data, dims, origin, cell }); bez něj prázdná. */
function aoUniforms(ao) {
  const [nx, ny, nz] = ao ? ao.dims : [1, 1, 1];
  const tex = new THREE.Data3DTexture(ao ? ao.data : new Uint8Array(1), nx, ny, nz);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  const cell = ao ? ao.cell : 1;
  return {
    aoTex: { value: tex },
    aoOrigin: { value: new THREE.Vector3(...(ao ? ao.origin : [0, 0, 0])) },
    aoSize: { value: new THREE.Vector3(nx * cell, ny * cell, nz * cell) },
    aoOffset: { value: cell * 0.75 },
  };
}
/** Název podlaží 1NP (přízemí): „1NP“, „1.NP“, „1 NP_SO-101“…, ne „11NP“ ani „-1.PP“. */
const FIRST_FLOOR = /(^|[^0-9])1\s*\.?\s*N\.?\s*P|přízemí|prizemi|ground\s*floor/i;

export class Viewer {
  constructor(container) {
    this.container = container;
    // high-performance: v noteboocích se dvěma grafikami si prohlížeč vyžádá výkonnou (dedikovanou) kartu
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    /** úroveň zobrazení (quality.js); rozlišení, rubové strany, sklo, ve VR ostrost okrajů a frekvence */
    this.quality = QUALITY.balanced;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.pixelRatio));
    this.renderer.xr.enabled = true;
    container.appendChild(this.renderer.domElement);

    this.bg = new THREE.Color(t('color.log.bg'));
    this.scene = new THREE.Scene();
    this.scene.background = this.bg;

    // rig = poloha uživatele; ve VR se hýbe rigem, kamera je v něm
    this.rig = new THREE.Group();
    this.scene.add(this.rig);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 2000);
    this.camera.position.set(10, 8, 10);
    this.rig.add(this.camera);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.5, 1, 0.3);
    this.scene.add(sun);

    this.modelRoot = new THREE.Group();
    this.modelRoot.name = 'model';
    this.scene.add(this.modelRoot);
    this.meshes = [];
    /** modelID → skupina modelu (její matice zarovná model k prvnímu načtenému) */
    this.groups = new Map();
    /** posun prvního modelu k počátku (coord z web-ifc); další modely se k němu vztahují */
    this.refMatrix = null;
    this.bbox = new THREE.Box3();
    /** "model:id" → dveře s křídly z workeru ({ leaves, open }); křídla se z modelu vyjmou při prvním otevření */
    this.doors = new Map();
    /** obrysové hrany (zapínají se volbou); modelID → čáry */
    this.edgesOn = false;
    this.edgeLines = new Map();
    this.edgeMat = new THREE.LineBasicMaterial({ color: t('color.bg.deep') });
    /** dveře, jejichž křídla se právě otáčejí */
    this.swinging = new Set();
    /** automatické otevírání dveří u uživatele (volba) */
    this.autoDoors = false;
    this.autoTimer = 0;

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.ground.name = 'ground';
    this.scene.add(this.ground);
    this.grid = null;

    this.highlight = [];
    this.highlightMat = new THREE.MeshBasicMaterial({
      color: t('color.accent.default'), transparent: true, opacity: 0.55,
      depthFunc: THREE.LessEqualDepth, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      side: THREE.DoubleSide,
    });
    this.selectedId = null;
    /** Mojžíšův mód: výřez modelu kolem uživatele (shader + výběr a teleport ho respektují) */
    this.moses = new Moses();
    // po vypnutí výřezu vrátit frekvenci brýlí (při zapnutém ji mohly snížit, protože nestíhaly)
    this.moses.onCut = (on) => { if (!on) this.applyFrameRate(); };
    this.moses.patch(this.highlightMat);
    this.moses.patch(this.edgeMat);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => this.invalidate());

    // Na počítači se kreslí jen po změně (pohyb kamery, výběr, model…), jinak by grafická karta
    // stále kreslila stejný obraz. Ve VR/AR se kreslí každý snímek (hlava se hýbe pořád).
    this.dirty = true;
    this.wasPresenting = false;
    this.onBeforeRender = null;
    this.onAfterRender = null;
    const clock = new THREE.Clock();
    this.renderer.setAnimationLoop((time, frame) => {
      const dt = Math.min(clock.getDelta(), 0.1);
      const xr = this.renderer.xr.isPresenting;
      if (xr !== this.wasPresenting) { this.wasPresenting = xr; this.dirty = true; this.fpsWatch = { t: 0, n: 0, slow: 0 }; }
      if (xr) this.watchFrameRate(dt);
      if (!xr) this.controls.update(); // tlumení dobíhá přes událost change
      this.onBeforeRender?.(dt, frame);
      if (this.autoDoors) this.tickAutoDoors(dt);
      this.tickDoors(dt);
      if (!xr && this.moses.target > 0) this.updateMosesDesktop();
      if (this.moses.tick(dt)) this.dirty = true;
      if (!xr && !this.dirty) return;
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
      this.onAfterRender?.(time);
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  /** Nastaví úroveň zobrazení (prvek QUALITY). Rozlišení v brýlích platí od dalšího vstupu do VR. */
  setQuality(q) {
    this.quality = q;
    if (!this.renderer.xr.isPresenting) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
      this.resize();
    }
    this.renderer.xr.setFoveation(q.foveation);
    this.applyFrameRate();
    const done = new Set();
    for (const m of this.meshes) if (!done.has(m.material)) { done.add(m.material); this.applyMaterialQuality(m.material); }
    this.invalidate();
  }

  /**
   * Materiál podle úrovně: neprůhledné prvky jsou uzavřená tělesa, rubové strany se kreslí jen v Kvalitě
   * (pohled zevnitř zdi, plochy s obrácenou normálou); ve Výkonu je sklo neprůhledné (průhlednost je drahá).
   */
  applyMaterialQuality(mat) {
    const a = mat.userData.alpha ?? 1;
    const transparent = a < 0.99 && this.quality.glass;
    mat.transparent = transparent;
    mat.opacity = transparent ? Math.max(a, 0.15) : 1;
    mat.depthWrite = !transparent;
    mat.side = transparent || this.quality.doubleSide ? THREE.DoubleSide : THREE.FrontSide;
    // zastínění koutů (ve Výkonu ne); posun hloubky jen s obrysovými hranami (jinak zbytečná práce)
    if (mat.userData.ao) setDefine(mat, 'AO_VOLUME', this.quality.ao !== false);
    mat.polygonOffset = this.edgesOn;
    mat.needsUpdate = true;
  }

  /** Rozlišení XR vrstvy pro novou relaci (volat před renderer.xr.setSession). */
  prepareXR(session) {
    let f = this.quality.xrScale;
    if (f === 'native') f = globalThis.XRWebGLLayer?.getNativeFramebufferScaleFactor?.(session) || 1.2;
    this.renderer.xr.setFramebufferScaleFactor(Math.min(Math.max(f, 0.5), 2));
    this.renderer.xr.setFoveation(this.quality.foveation);
  }

  /**
   * Brýle nestíhají zvolenou frekvenci (dvakrát po sobě 2 s pod 85 %): přepnout na nejbližší nižší
   * podporovanou (ne pod 72 Hz). Trhaný obraz na 90 Hz vypadá hůř než plynulý na 72 Hz.
   */
  watchFrameRate(dt) {
    const w = this.fpsWatch || (this.fpsWatch = { t: 0, n: 0, slow: 0 });
    w.t += dt; w.n++;
    if (w.t < 2) return;
    const fps = w.n / w.t;
    w.t = 0; w.n = 0;
    const s = this.renderer.xr.getSession?.();
    const rate = s?.frameRate, rates = s?.supportedFrameRates;
    if (!rate || !rates?.length || !s.updateTargetFrameRate) return;
    w.slow = fps < rate * 0.85 ? w.slow + 1 : 0;
    if (w.slow < 2) return;
    w.slow = 0;
    const lower = [...rates].filter((r) => r < rate && r >= 72).sort((a, b) => b - a)[0];
    if (lower) s.updateTargetFrameRate(lower).catch((e) => console.warn('Frekvenci brýlí nejde snížit', e));
  }

  /** Obnovovací frekvence brýlí podle úrovně (nejbližší podporovaná nižší nebo stejná). */
  applyFrameRate() {
    this.fpsWatch = { t: 0, n: 0, slow: 0 };
    const s = this.renderer.xr.getSession?.();
    const rates = s?.supportedFrameRates;
    if (!s?.updateTargetFrameRate || !rates?.length) return;
    const list = [...rates].sort((a, b) => a - b);
    const rate = list.filter((r) => r <= this.quality.fps).pop() || list[0];
    s.updateTargetFrameRate(rate).catch((e) => console.warn('Frekvenci brýlí nejde nastavit', e));
  }

  /** Vyžádá nové vykreslení (na počítači se kreslí jen po změně). */
  invalidate() { this.dirty = true; }

  resize() {
    this.invalidate();
    if (this.renderer.xr.isPresenting) return;
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  disposeMesh(m) {
    this.invalidate();
    m.geometry.disposeBoundsTree();
    m.geometry.dispose();
    this.moses.forget(m.material);
    m.material.dispose();
    m.removeFromParent();
  }

  clear() {
    this.clearHighlight();
    for (const m of this.meshes) this.disposeMesh(m);
    this.meshes = [];
    for (const l of this.edgeLines.values()) { l.geometry.dispose(); l.removeFromParent(); }
    this.edgeLines.clear();
    for (const g of this.groups.values()) { g.userData.ao?.aoTex.value.dispose(); g.removeFromParent(); }
    this.groups.clear();
    this.refMatrix = null;
    this.doors.clear();
    this.swinging.clear();
    this.modelRoot.position.set(0, 0, 0);
    this.modelRoot.quaternion.identity();
    this.modelRoot.scale.setScalar(1);
    this.updateBounds();
  }

  /**
   * Přidá model z výsledku workeru (geometrie sloučená podle barvy). `fit` = pohled na celek.
   * `coord` = posun modelu k počátku z web-ifc: model se maticí umístí do souřadnic prvního modelu.
   * Vrátí false, když je model dál než FAR_APART (jiný souřadnicový systém) a zůstal v počátku.
   */
  addModel(modelID, buckets, fit = true, coord = null, doors = [], storeys = [], edges = null, ao = null) {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.userData.modelID = modelID;
    group.userData.storeys = storeys || [];
    let aligned = true;
    if (coord) {
      const C = new THREE.Matrix4().fromArray(coord);
      if (!this.refMatrix) this.refMatrix = C;
      else {
        const R = this.refMatrix.clone().multiply(C.clone().invert());
        aligned = new THREE.Vector3().setFromMatrixPosition(R).length() <= FAR_APART;
        if (aligned) group.matrix.copy(R);
      }
    }
    this.modelRoot.add(group);
    group.updateMatrixWorld(true);
    this.groups.set(modelID, group);
    group.userData.ao = aoUniforms(ao);
    const shade = shadeAO(group.userData.ao);
    // neprůhledné napřed, průhledné (okna) až po nich
    buckets.sort((a, b) => b.color[3] - a.color[3]);
    for (const b of buckets) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(b.position, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(b.normal, 3));
      g.setIndex(new THREE.BufferAttribute(b.index, 1));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      // strom pro výběr prvků spočítal worker (jinak by tu u milionů trojúhelníků hlavní vlákno zamrzlo)
      if (b.bvh) g.boundsTree = MeshBVH.deserialize({ ...b.bvh, index: b.index }, g, { setIndex: false });
      else g.computeBoundsTree({ indirect: true });
      const [r, gg, bb, a] = b.color;
      const transparent = a < 0.99;
      const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color().setRGB(r, gg, bb, THREE.SRGBColorSpace) });
      mat.userData.alpha = a;
      // s obrysovými hranami plochy kousek dál od kamery, aby na nich hrany ležely a neprobleskovaly
      mat.polygonOffsetFactor = 1;
      mat.polygonOffsetUnits = 1;
      mat.userData.ao = true;
      this.applyMaterialQuality(mat);
      this.moses.patch(mat, shade);
      const mesh = new THREE.Mesh(g, mat);
      mesh.userData.origColor = mat.color.clone();
      mesh.userData.ranges = b.ranges;
      mesh.userData.modelID = modelID;
      mesh.userData.key = b.key;
      mesh.renderOrder = transparent ? 1 : 0;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      mesh.updateMatrixWorld(true);
      this.meshes.push(mesh);
    }
    if (edges?.length) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(edges, 3));
      const lines = new THREE.LineSegments(lg, this.edgeMat);
      lines.raycast = () => {};
      lines.matrixAutoUpdate = false;
      lines.visible = this.edgesOn;
      group.add(lines);
      lines.updateMatrixWorld(true);
      this.edgeLines.set(modelID, lines);
    }
    for (const d of doors || []) {
      this.doors.set(doorKey({ model: modelID, id: d.id }), { ...d, model: modelID, open: false, box: this.doorBox(modelID, d) });
    }
    this.updateBounds();
    if (fit) this.fitView();
    this.invalidate();
    return aligned;
  }

  /** Skryje / zobrazí model (skrytý se nedá vybrat ani na něj teleportovat). */
  setModelVisible(modelID, on) {
    if (!on && this.selectedId?.model === modelID) this.clearHighlight();
    for (const m of this.meshes) if (m.userData.modelID === modelID) m.visible = on;
    const lines = this.edgeLines.get(modelID);
    if (lines) lines.visible = on && this.edgesOn;
    this.invalidate();
  }

  /** Obrysové hrany zapnout / vypnout (u skrytých modelů zůstanou skryté). */
  setEdges(on) {
    this.edgesOn = on;
    for (const m of this.meshes) m.material.polygonOffset = on;
    for (const [modelID, lines] of this.edgeLines) {
      lines.visible = on && this.meshes.some((m) => m.userData.modelID === modelID && m.visible);
    }
    this.invalidate();
  }

  /** Přebarví celý model jednou barvou (CSS barva), null = původní barvy z IFC. */
  setModelColor(modelID, color) {
    const c = color ? new THREE.Color(color) : null;
    for (const m of this.meshes) {
      if (m.userData.modelID === modelID) m.material.color.copy(c || m.userData.origColor);
    }
    this.invalidate();
  }

  get visibleMeshes() { return this.meshes.filter((m) => m.visible); }

  removeModel(modelID) {
    if (this.selectedId?.model === modelID) this.clearHighlight();
    for (const m of this.meshes) if (m.userData.modelID === modelID) this.disposeMesh(m);
    this.meshes = this.meshes.filter((m) => m.userData.modelID !== modelID);
    const lines = this.edgeLines.get(modelID);
    if (lines) { lines.geometry.dispose(); lines.removeFromParent(); this.edgeLines.delete(modelID); }
    this.groups.get(modelID)?.userData.ao?.aoTex.value.dispose();
    this.groups.get(modelID)?.removeFromParent();
    this.groups.delete(modelID);
    for (const [k, d] of this.doors) if (d.model === modelID) { this.doors.delete(k); this.swinging.delete(d); }
    if (!this.groups.size) this.refMatrix = null;
    this.updateBounds();
  }

  /** Obálka všech modelů v souřadnicích modelRoot (geometrie posunutá maticí skupiny modelu). */
  updateBounds() {
    this.bbox.makeEmpty();
    const box = new THREE.Box3();
    for (const m of this.meshes) if (!m.userData.isLeaf) this.bbox.union(box.copy(m.geometry.boundingBox).applyMatrix4(m.parent.matrix));
    this.updateGround();
  }

  get groundY() { return this.bbox.isEmpty() ? 0 : this.bbox.min.y; }

  /** Podlaží všech modelů: { name, y (výška podlahy v souřadnicích modelRoot), elev, model }, odspodu. */
  get storeys() {
    const out = [];
    for (const [model, g] of this.groups) {
      const dy = g.matrix.elements[13];
      for (const st of g.userData.storeys) out.push({ ...st, y: st.y + dy, model });
    }
    return out.sort((a, b) => a.y - b.y);
  }

  /**
   * Výchozí podlaha (start ve VR, mřížka, teleport mimo budovu): podlaží 1NP podle názvu, jinak
   * podlaží s výškou nejblíž ±0,00; bez podlaží (nebo mimo model) spodek modelu.
   */
  get floorY() {
    if (this.bbox.isEmpty()) return 0;
    const all = this.storeys.filter((st) => st.y >= this.bbox.min.y - 1 && st.y <= this.bbox.max.y);
    let base = null;
    for (const model of this.groups.keys()) {
      base = all.find((st) => st.model === model && FIRST_FLOOR.test(st.name));
      if (base) break;
    }
    if (!base) {
      const withElev = all.filter((st) => st.elev != null);
      base = withElev.sort((a, b) => Math.abs(a.elev) - Math.abs(b.elev))[0] || null;
    }
    return base ? base.y : this.groundY;
  }

  updateGround() {
    this.invalidate();
    const size = this.bbox.getSize(new THREE.Vector3());
    const c = this.bbox.getCenter(new THREE.Vector3());
    const extent = Math.max(size.x, size.z, 10) * 4;
    this.ground.scale.set(extent, 1, extent);
    const floorY = this.floorY;
    this.ground.position.set(c.x, floorY, c.z);
    this.ground.updateMatrixWorld();
    if (this.grid) { this.grid.geometry.dispose(); this.grid.removeFromParent(); }
    // buňka 1 m, u velkých modelů 5 nebo 10 m, ať mřížka nemá víc než ~150 čar
    const cell = [1, 5, 10, 50, 100].find((s) => extent / s <= 150) || 100;
    const div = Math.ceil(extent / cell);
    this.grid = new THREE.GridHelper(div * cell, div, t('color.border.default'), t('color.bg.control'));
    this.grid.position.set(Math.round(c.x / cell) * cell, floorY - GRID_BELOW, Math.round(c.z / cell) * cell);
    this.scene.add(this.grid);
  }

  /** Pohled na jeden model (klepnutí na název v seznamu načtených modelů). */
  fitModel(modelID) {
    const box = new THREE.Box3(), b = new THREE.Box3();
    for (const m of this.meshes) if (m.userData.modelID === modelID) box.union(b.copy(m.geometry.boundingBox).applyMatrix4(m.parent.matrix));
    this.fitView(box);
  }

  /** Pohled na obálku `box` (výchozí: všechny modely). */
  fitView(box = this.bbox) {
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    const d = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.camera.position.copy(c).add(new THREE.Vector3(0.7, 0.5, 0.9).normalize().multiplyScalar(d));
    this.camera.near = Math.max(d / 1000, 0.02);
    // daleká rovina podle celé scény, aby při pohledu na jeden model nezmizely ostatní
    this.camera.far = Math.max(d, this.bbox.getSize(new THREE.Vector3()).length()) * 20 + 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.controls.update();
  }

  /** Prvek z průsečíku { model, id }: rozsahy indexů jsou seřazené, hledá se půlením. */
  idFromHit(hit) {
    const ranges = hit.object.userData.ranges;
    if (!ranges || hit.faceIndex == null) return null;
    const i = hit.faceIndex * 3;
    let lo = 0, hi = ranges.length / 3 - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = ranges[mid * 3], n = ranges[mid * 3 + 1];
      if (i < s) hi = mid - 1;
      else if (i >= s + n) lo = mid + 1;
      else return { model: hit.object.userData.modelID, id: ranges[mid * 3 + 2] };
    }
    return null;
  }

  /** Průsečík paprsku s modelem: { point, distance, face, id } nebo null. */
  intersect(raycaster) {
    const h = this.raycast(raycaster, this.visibleMeshes)[0];
    return h ? { ...h, id: this.idFromHit(h) } : null;
  }

  /**
   * Průsečíky seřazené podle vzdálenosti, bez částí ve výřezu Mojžíšova módu (nejsou vidět, nejdou
   * vybrat ani na ně teleportovat). Ve výřezu je potřeba všechny zásahy, ne jen první.
   */
  raycast(raycaster, objects) {
    const near = (a, b) => a.distance - b.distance;
    if (!this.moses.active) return raycaster.intersectObjects(objects, false).sort(near);
    // zásah ve výřezu: hledat dál až za místem, kde paprsek z výřezu vyjde (ne všechny plochy po cestě –
    // to by u paprsku ovladače přes celou budovu stálo každý snímek desítky milisekund)
    const near0 = raycaster.near;
    try {
      for (let i = 0; i < 4; i++) {
        const hits = raycaster.intersectObjects(objects, false).sort(near);
        const h = hits[0];
        if (!h || !this.moses.hides(h.point)) return hits.filter((x) => !this.moses.hides(x.point));
        raycaster.near = this.moses.exitDistance(raycaster.ray, h.distance);
        if (raycaster.near >= raycaster.far) return [];
      }
      return [];
    } finally { raycaster.near = near0; }
  }

  /** Na počítači: výřez kolem středu otáčení, od podlahy podlaží, ve kterém střed leží. */
  updateMosesDesktop() {
    const c = this.controls.target;
    let feet = this.groundY;
    for (const st of this.storeys) if (st.y <= c.y + 0.1) feet = st.y;
    this.modelRoot.updateMatrixWorld();
    this.moses.setCenter(c.x, feet, c.z);
  }

  /** Mojžíšův mód: poloměr výřezu v m (0 = vypnout). */
  setMoses(r) {
    this.moses.setRadius(r);
    if (r > 0 && !this.renderer.xr.isPresenting) this.updateMosesDesktop();
    this.invalidate();
  }

  pickAtScreen(x, y) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.far = Infinity;
    return this.intersect(this.raycaster);
  }

  clearHighlight() {
    this.invalidate();
    for (const h of this.highlight) { h.geometry.dispose(); h.removeFromParent(); }
    this.highlight = [];
    this.selectedId = null;
  }

  /** Zvýrazní prvek { model, id } (nebo nic při null). */
  setHighlight(ref) {
    this.clearHighlight();
    if (ref == null) return;
    this.selectedId = ref;
    const { id } = ref;
    for (const mesh of this.meshes) {
      if (mesh.userData.modelID !== ref.model) continue;
      const ranges = mesh.userData.ranges;
      const parts = [];
      let total = 0;
      for (let i = 0; i < ranges.length; i += 3) {
        if (ranges[i + 2] === id) { parts.push(ranges[i], ranges[i + 1]); total += ranges[i + 1]; }
      }
      if (!total) continue;
      const src = mesh.geometry.index.array;
      const idx = new Uint32Array(total);
      let o = 0;
      for (let p = 0; p < parts.length; p += 2) { idx.set(src.subarray(parts[p], parts[p] + parts[p + 1]), o); o += parts[p + 1]; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', mesh.geometry.getAttribute('position'));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      const h = new THREE.Mesh(g, this.highlightMat);
      h.raycast = () => {};
      h.renderOrder = 10;
      mesh.add(h);
      this.highlight.push(h);
    }
  }

  // ---------- dveře ----------
  /** Má prvek { model, id } křídla, která jdou otevřít? */
  isDoor(ref) { return !!ref && this.doors.has(doorKey(ref)); }
  isDoorOpen(ref) { return !!ref && !!this.doors.get(doorKey(ref))?.open; }

  /**
   * Otevře / zavře dveře { model, id }. Křídlo se otočí o 90° kolem pantu, od pozorovatele (aby do něj
   * nenarazilo). Vrátí nový stav (true = otevřené), nebo null, když prvek nejsou dveře s křídly.
   * `auto` = automatické dveře; ručně otevřené / zavřené dveře automatika nechá, dokud uživatel neodejde.
   */
  toggleDoor(ref, auto = false) {
    const d = ref && this.doors.get(doorKey(ref));
    const group = d && this.groups.get(d.model);
    if (!group) return null;
    if (!d.built) this.buildLeaves(d, group);
    d.open = !d.open;
    d.auto = auto && d.open;
    d.hold = !auto;
    d.time = auto ? AUTO_DOOR_TIME : DOOR_TIME;
    if (d.open) {
      const cam = this.camera; // ve VR poloha hlavy ve světě (i s posunem rigu)
      group.updateWorldMatrix(true, false);
      const eye = group.worldToLocal(cam.getWorldPosition(new THREE.Vector3()));
      for (const l of d.leaves) {
        const [hx, hz] = l.hinge, [ux, uz] = l.u, [vx, vz] = l.v;
        const side = Math.sign((eye.x - hx) * vx + (eye.z - hz) * vz) || 1;
        // pant na straně křídla odvrácené od pozorovatele
        const px = hx - side * vx * l.half, pz = hz - side * vz * l.half;
        l.pivot.position.set(px, 0, pz);
        for (const m of l.meshes) m.position.set(-px, 0, -pz);
        // otočení o +90° kolem osy Y posune směr u na (uz, −ux); volný kraj má jít od pozorovatele (−side · v)
        l.target = (Math.PI / 2) * Math.sign(uz * vx - ux * vz) * -side;
      }
    } else for (const l of d.leaves) l.target = 0;
    this.swinging.add(d);
    this.invalidate();
    this.onDoorToggle?.({ model: d.model, id: d.id }, d.open);
    return d.open;
  }

  /** Obálka křídel dveří (souřadnice modelu) – pro automatické otevírání. */
  doorBox(modelID, d) {
    const box = new THREE.Box3();
    const byKey = new Map();
    for (const m of this.meshes) if (m.userData.modelID === modelID && !m.userData.isLeaf) byKey.set(m.userData.key, m);
    const p = new THREE.Vector3();
    for (const l of d.leaves) {
      for (const [key, start, count] of l.segs) {
        const g = byKey.get(key)?.geometry;
        if (!g) continue;
        const idx = g.index.array, P = g.getAttribute('position').array;
        for (let i = start; i < start + count; i++) box.expandByPoint(p.fromArray(P, idx[i] * 3));
      }
    }
    return box.isEmpty() ? null : box;
  }

  /** Automatické dveře zapnout / vypnout (při vypnutí se automaticky otevřené zavřou). */
  setAutoDoors(on) {
    this.autoDoors = on;
    for (const d of this.doors.values()) {
      if (!on && d.auto && d.open) this.toggleDoor({ model: d.model, id: d.id }, true);
      d.hold = false;
    }
  }

  /** Dveře u uživatele se otevřou, vzdálené automaticky otevřené zavřou (5× za sekundu, ne v maketě). */
  tickAutoDoors(dt) {
    this.autoTimer += dt;
    if (this.autoTimer < 0.2 || !this.doors.size) return;
    this.autoTimer = 0;
    if (Math.abs(this.modelRoot.scale.x - 1) > 1e-6) return; // maketa: model je zmenšený na stole
    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    const local = new THREE.Vector3(), c = new THREE.Vector3();
    for (const [model, group] of this.groups) {
      group.updateWorldMatrix(true, false);
      group.worldToLocal(local.copy(eye));
      for (const d of this.doors.values()) {
        if (d.model !== model || !d.box) continue;
        d.box.getCenter(c);
        const dist = Math.hypot(local.x - c.x, local.z - c.z);
        // oči ve výšce dveří (stejné podlaží): od spodku dveří po kousek nad nadpražím
        const level = local.y > d.box.min.y && local.y < d.box.max.y + 0.6;
        // dveře, se kterými uživatel pohnul ručně, automatika nechá, dokud neodejde
        if (d.hold) { if (dist > AUTO_CLOSE || !level) d.hold = false; continue; }
        if (!d.open && level && dist < AUTO_OPEN) this.toggleDoor({ model, id: d.id }, true);
        else if (d.open && d.auto && (dist > AUTO_CLOSE || !level)) this.toggleDoor({ model, id: d.id }, true);
      }
    }
  }

  /** Vyjme trojúhelníky křídel ze sloučené geometrie modelu do vlastních objektů s pantem. */
  buildLeaves(d, group) {
    const byKey = new Map();
    for (const m of this.meshes) if (m.userData.modelID === d.model && !m.userData.isLeaf) byKey.set(m.userData.key, m);
    for (const l of d.leaves) {
      l.pivot = new THREE.Object3D();
      l.angle = 0;
      l.target = 0;
      l.meshes = [];
      group.add(l.pivot);
      // díly křídla podle skupiny barvy (jedna skupina = jeden objekt se stejným materiálem)
      const segsBy = new Map();
      for (const [key, start, count] of l.segs) (segsBy.get(key) || segsBy.set(key, []).get(key)).push([start, count]);
      for (const [key, segs] of segsBy) {
        const src = byKey.get(key);
        if (!src) continue;
        const sg = src.geometry, idx = sg.index.array;
        const P = sg.getAttribute('position').array, N = sg.getAttribute('normal').array;
        const map = new Map();
        const total = segs.reduce((n, s) => n + s[1], 0);
        const ni = new Uint32Array(total);
        const pos = [], nrm = [];
        let o = 0;
        for (const [start, count] of segs) {
          for (let i = start; i < start + count; i++) {
            const v = idx[i];
            let k = map.get(v);
            if (k === undefined) {
              k = map.size;
              map.set(v, k);
              pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
              nrm.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
            }
            ni[o++] = k;
          }
          // ve sloučené geometrii se trojúhelníky křídla stáhnou do bodu (nekreslí se a nejdou vybrat)
          idx.fill(idx[start], start, start + count);
          sg.index.addUpdateRange(start, count);
        }
        sg.index.needsUpdate = true;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
        g.setIndex(new THREE.BufferAttribute(ni, 1));
        g.computeBoundingBox();
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, src.material);
        mesh.userData = { modelID: d.model, key, isLeaf: true, origColor: src.userData.origColor, ranges: Uint32Array.of(0, total, d.id) };
        mesh.renderOrder = src.renderOrder;
        mesh.visible = src.visible;
        l.pivot.add(mesh);
        l.meshes.push(mesh);
        this.meshes.push(mesh);
      }
    }
    d.built = true;
    // zvýraznění vybraných dveří se kreslí z indexů – po vyjmutí křídel znovu
    if (this.selectedId && doorKey(this.selectedId) === doorKey({ model: d.model, id: d.id })) this.setHighlight(this.selectedId);
  }

  /** Otáčení křídel (volá se každý snímek). */
  tickDoors(dt) {
    if (!this.swinging.size) return;
    for (const d of this.swinging) {
      const step = (Math.PI / 2) * (dt / (d.time || DOOR_TIME));
      let moving = false;
      for (const l of d.leaves) {
        if (!l.pivot) continue;
        const diff = l.target - l.angle;
        l.angle = Math.abs(diff) <= step ? l.target : l.angle + Math.sign(diff) * step;
        l.pivot.rotation.y = l.angle;
        if (l.angle !== l.target) moving = true;
      }
      if (!moving) this.swinging.delete(d);
    }
    this.invalidate();
  }

  /** AR: průhledné pozadí a bez mřížky (je vidět okolí). */
  setPassthrough(on) {
    this.invalidate();
    this.scene.background = on ? null : this.bg;
    if (this.grid) this.grid.visible = !on;
  }
}
