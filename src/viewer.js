// 3D scéna: model, světla, podlaha, výběr a zvýraznění prvků.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshBVH, computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { t } from './theme.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** Modely dál od sebe než tolik metrů mají jiný souřadnicový systém a nezarovnávají se. */
const FAR_APART = 10000;
/** Otevření dveří (90°) trvá tolik sekund. */
const DOOR_TIME = 0.8;
const doorKey = (ref) => `${ref.model}:${ref.id}`;

export class Viewer {
  constructor(container) {
    this.container = container;
    // high-performance: v noteboocích se dvěma grafikami si prohlížeč vyžádá výkonnou (dedikovanou) kartu
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    // strop 1,5: na displejích s vysokým rozlišením by 2× znamenalo skoro dvojnásobek pixelů (s vyhlazováním)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
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
    /** dveře, jejichž křídla se právě otáčejí */
    this.swinging = new Set();

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
      if (xr !== this.wasPresenting) { this.wasPresenting = xr; this.dirty = true; }
      if (!xr) this.controls.update(); // tlumení dobíhá přes událost change
      this.onBeforeRender?.(dt, frame);
      this.tickDoors(dt);
      if (!xr && !this.dirty) return;
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
      this.onAfterRender?.(time);
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
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
    m.material.dispose();
    m.removeFromParent();
  }

  clear() {
    this.clearHighlight();
    for (const m of this.meshes) this.disposeMesh(m);
    this.meshes = [];
    for (const g of this.groups.values()) g.removeFromParent();
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
  addModel(modelID, buckets, fit = true, coord = null, doors = []) {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.userData.modelID = modelID;
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
      // neprůhledné prvky jsou uzavřená tělesa: zadní strany nejsou vidět a kreslit je je zbytečná práce
      // (pohled zevnitř zdi/desky v VR je ukáže průhledně, jako běžné prohlížeče IFC)
      const mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color().setRGB(r, gg, bb, THREE.SRGBColorSpace),
        transparent, opacity: transparent ? Math.max(a, 0.15) : 1, depthWrite: !transparent,
        side: transparent ? THREE.DoubleSide : THREE.FrontSide,
      });
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
    for (const d of doors || []) this.doors.set(doorKey({ model: modelID, id: d.id }), { ...d, model: modelID, open: false });
    this.updateBounds();
    if (fit) this.fitView();
    this.invalidate();
    return aligned;
  }

  /** Skryje / zobrazí model (skrytý se nedá vybrat ani na něj teleportovat). */
  setModelVisible(modelID, on) {
    if (!on && this.selectedId?.model === modelID) this.clearHighlight();
    for (const m of this.meshes) if (m.userData.modelID === modelID) m.visible = on;
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

  updateGround() {
    this.invalidate();
    const size = this.bbox.getSize(new THREE.Vector3());
    const c = this.bbox.getCenter(new THREE.Vector3());
    const extent = Math.max(size.x, size.z, 10) * 4;
    this.ground.scale.set(extent, 1, extent);
    this.ground.position.set(c.x, this.groundY, c.z);
    this.ground.updateMatrixWorld();
    if (this.grid) { this.grid.geometry.dispose(); this.grid.removeFromParent(); }
    // buňka 1 m, u velkých modelů 5 nebo 10 m, ať mřížka nemá víc než ~150 čar
    const cell = [1, 5, 10, 50, 100].find((s) => extent / s <= 150) || 100;
    const div = Math.ceil(extent / cell);
    this.grid = new THREE.GridHelper(div * cell, div, t('color.border.default'), t('color.bg.control'));
    this.grid.position.set(Math.round(c.x / cell) * cell, this.groundY - 0.005, Math.round(c.z / cell) * cell);
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
    const hits = raycaster.intersectObjects(this.visibleMeshes, false);
    if (!hits.length) return null;
    hits.sort((a, b) => a.distance - b.distance);
    const h = hits[0];
    return { ...h, id: this.idFromHit(h) };
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
   */
  toggleDoor(ref) {
    const d = ref && this.doors.get(doorKey(ref));
    const group = d && this.groups.get(d.model);
    if (!group) return null;
    if (!d.built) this.buildLeaves(d, group);
    d.open = !d.open;
    if (d.open) {
      const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
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
    return d.open;
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
    const step = (Math.PI / 2) * (dt / DOOR_TIME);
    for (const d of this.swinging) {
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
