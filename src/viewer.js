// 3D scéna: model, světla, podlaha, výběr a zvýraznění prvků.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { t } from './theme.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
    this.bbox = new THREE.Box3();

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

    this.onBeforeRender = null;
    const clock = new THREE.Clock();
    this.renderer.setAnimationLoop((time, frame) => {
      const dt = Math.min(clock.getDelta(), 0.1);
      if (!this.renderer.xr.isPresenting) this.controls.update();
      this.onBeforeRender?.(dt, frame);
      this.renderer.render(this.scene, this.camera);
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  resize() {
    if (this.renderer.xr.isPresenting) return;
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    this.clearHighlight();
    for (const m of this.meshes) {
      m.geometry.disposeBoundsTree();
      m.geometry.dispose();
      m.material.dispose();
      m.removeFromParent();
    }
    this.meshes = [];
    this.modelRoot.position.set(0, 0, 0);
    this.modelRoot.quaternion.identity();
    this.modelRoot.scale.setScalar(1);
  }

  /** Vloží model z výsledku workeru (geometrie sloučená podle barvy). */
  setModel(buckets) {
    this.clear();
    // neprůhledné napřed, průhledné (okna) až po nich
    buckets.sort((a, b) => b.color[3] - a.color[3]);
    for (const b of buckets) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(b.position, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(b.normal, 3));
      g.setIndex(new THREE.BufferAttribute(b.index, 1));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      g.computeBoundsTree({ indirect: true });
      const [r, gg, bb, a] = b.color;
      const transparent = a < 0.99;
      const mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color().setRGB(r, gg, bb, THREE.SRGBColorSpace),
        transparent, opacity: transparent ? Math.max(a, 0.15) : 1, depthWrite: !transparent,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.userData.ranges = b.ranges;
      mesh.matrixAutoUpdate = false;
      this.modelRoot.add(mesh);
      this.meshes.push(mesh);
    }
    this.bbox.makeEmpty();
    for (const m of this.meshes) this.bbox.union(m.geometry.boundingBox);
    this.updateGround();
    this.fitView();
  }

  get groundY() { return this.bbox.isEmpty() ? 0 : this.bbox.min.y; }

  updateGround() {
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

  fitView() {
    if (this.bbox.isEmpty()) return;
    const c = this.bbox.getCenter(new THREE.Vector3());
    const r = this.bbox.getSize(new THREE.Vector3()).length() / 2;
    const d = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.camera.position.copy(c).add(new THREE.Vector3(0.7, 0.5, 0.9).normalize().multiplyScalar(d));
    this.camera.near = Math.max(d / 1000, 0.02);
    this.camera.far = d * 20 + 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.controls.update();
  }

  /** expressID z průsečíku: rozsahy indexů jsou seřazené, hledá se půlením. */
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
      else return ranges[mid * 3 + 2];
    }
    return null;
  }

  /** Průsečík paprsku s modelem: { point, distance, face, id } nebo null. */
  intersect(raycaster) {
    const hits = raycaster.intersectObjects(this.meshes, false);
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
    for (const h of this.highlight) { h.geometry.dispose(); h.removeFromParent(); }
    this.highlight = [];
    this.selectedId = null;
  }

  setHighlight(id) {
    this.clearHighlight();
    if (id == null) return;
    this.selectedId = id;
    for (const mesh of this.meshes) {
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

  /** AR: průhledné pozadí a bez mřížky (je vidět okolí). */
  setPassthrough(on) {
    this.scene.background = on ? null : this.bg;
    if (this.grid) this.grid.visible = !on;
  }
}
