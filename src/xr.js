// Ovládání ve VR / AR (Meta Quest 3): teleport, chůze, otáčení, let nahoru/dolů, výběr prvku,
// maketa (model zmenšený před uživatelem, úchop a zvětšení oběma rukama).
import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { VRPanel } from './vr-panel.js';
import { t } from './theme.js';

const UP = new THREE.Vector3(0, 1, 0);
const MOVE_SPEED = 2.0;      // m/s chůze
const FLY_SPEED = 1.5;       // m/s nahoru/dolů
const SNAP = THREE.MathUtils.degToRad(30);
const ARC_SPEED = 9;         // počáteční rychlost paraboly teleportu m/s
const MAKETA_SIZE = 1.0;     // největší rozměr makety v m
const TABLE_HEIGHT = 0.8;    // výška spodku makety nad podlahou

export class XRControls {
  constructor(viewer, { onSelect, onExit }) {
    this.v = viewer;
    this.onSelect = onSelect;
    this.onExit = onExit;
    this.mode = 'full';
    this.hands = { left: null, right: null };
    this.prev = { left: [], right: [] };
    this.turnLatched = false;
    this.teleporting = false;
    this.teleportHit = null;
    this.grabs = new Set();
    this.two = null;
    this.tmp = { v: new THREE.Vector3(), v2: new THREE.Vector3(), q: new THREE.Quaternion(), m: new THREE.Matrix4() };
    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;

    const r = viewer.renderer;
    const factory = new XRControllerModelFactory();
    this.controllers = [0, 1].map((i) => {
      const controller = r.xr.getController(i);
      const grip = r.xr.getControllerGrip(i);
      grip.add(factory.createControllerModel(grip));
      viewer.rig.add(controller, grip);
      const entry = { controller, grip, source: null, hand: null };
      controller.addEventListener('connected', (e) => {
        entry.source = e.data;
        entry.hand = e.data.handedness;
        if (entry.hand === 'left' || entry.hand === 'right') this.hands[entry.hand] = entry;
        this.attachHandUI(entry);
      });
      controller.addEventListener('disconnected', () => {
        if (entry.hand && this.hands[entry.hand] === entry) this.hands[entry.hand] = null;
        this.onSqueezeEnd(entry);
        entry.source = null; entry.hand = null;
      });
      controller.addEventListener('selectstart', () => this.onTrigger(entry));
      controller.addEventListener('squeezestart', () => this.onSqueezeStart(entry));
      controller.addEventListener('squeezeend', () => this.onSqueezeEnd(entry));
      return entry;
    });

    // paprsek pravé ruky
    const accent = new THREE.Color(t('color.accent.default'));
    this.ray = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.8 }),
    );
    this.ray.name = 'ray';
    this.ray.visible = false;
    this.cursor = new THREE.Mesh(
      new THREE.SphereGeometry(0.006, 12, 8),
      new THREE.MeshBasicMaterial({ color: accent, depthTest: false }),
    );
    this.cursor.renderOrder = 30;
    this.cursor.visible = false;
    viewer.scene.add(this.cursor);

    // parabola teleportu a značka dopadu
    this.arcPoints = 48;
    this.arc = new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.arcPoints * 3), 3)),
      new THREE.LineBasicMaterial({ color: accent }),
    );
    this.arc.frustumCulled = false;
    this.arc.visible = false;
    viewer.scene.add(this.arc);
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.22, 0.3, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: accent, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
    );
    this.marker.visible = false;
    viewer.scene.add(this.marker);
    this.colOk = accent;
    this.colBad = new THREE.Color(t('color.status.error'));

    // panel
    this.panel = new VRPanel();
    this.panel.actions = {
      'mode-full': () => this.setMode('full'),
      'mode-mini': () => this.setMode('mini'),
      reset: () => this.resetPose(),
      grid: () => { const on = !this.panel.state.grid; this.panel.set({ grid: on }); if (this.v.grid) this.v.grid.visible = on && !this.passthrough; },
      exit: () => this.v.renderer.xr.getSession()?.end(),
    };
    this.panel.set({ grid: true });
    this.passthrough = false;
  }

  attachHandUI(entry) {
    if (entry.hand === 'left') {
      // panel nad levým ovladačem, nakloněný k uživateli
      entry.grip.add(this.panel.mesh);
      this.panel.mesh.position.set(0.0, 0.07, -0.16);
      this.panel.mesh.rotation.set(-0.9, 0, 0);
    }
    if (entry.hand === 'right') entry.controller.add(this.ray);
  }

  // ---------- relace ----------
  start(passthrough) {
    this.passthrough = passthrough;
    this.v.setPassthrough(passthrough);
    if (this.v.grid) this.v.grid.visible = !passthrough && this.panel.state.grid;
    this.v.controls.enabled = false;
    this.desktopCam = { pos: this.v.camera.position.clone(), quat: this.v.camera.quaternion.clone() };
    this.v.camera.position.set(0, 0, 0);
    this.v.camera.quaternion.identity();
    this.mode = passthrough ? 'mini' : 'full';
    // pozice se nastaví až v prvním snímku, kdy je známá poloha hlavy
    this.needsInitialPose = 3;   // pár snímků, než je známá poloha hlavy
  }

  end() {
    this.releaseAll();
    this.v.setPassthrough(false);
    this.v.rig.position.set(0, 0, 0);
    this.v.rig.quaternion.identity();
    this.resetModelTransform();
    this.v.updateGround();
    if (this.v.grid) this.v.grid.visible = this.panel.state.grid;
    if (this.desktopCam) {
      this.v.camera.position.copy(this.desktopCam.pos);
      this.v.camera.quaternion.copy(this.desktopCam.quat);
    }
    this.v.controls.enabled = true;
    this.v.controls.update();
    this.arc.visible = this.marker.visible = this.cursor.visible = false;
    this.v.resize();
  }

  resetModelTransform() {
    const m = this.v.modelRoot;
    m.position.set(0, 0, 0);
    m.quaternion.identity();
    m.scale.setScalar(1);
  }

  setMode(mode) {
    this.releaseAll();
    this.mode = mode;
    this.panel.set({ mode });
    this.resetPose();
  }

  /** Výchozí pozice: 1:1 – před jižní stranou modelu čelem k němu; maketa – model před uživatelem. */
  resetPose() {
    const v = this.v;
    const bb = v.bbox;
    if (bb.isEmpty()) return;
    const c = bb.getCenter(new THREE.Vector3());
    const size = bb.getSize(new THREE.Vector3());
    const cam = v.camera;
    if (this.mode === 'full') {
      this.resetModelTransform();
      v.rig.quaternion.identity();
      // kamera má v rigu offset (poloha hlavy v místnosti) – kompenzovat ho v rovině
      const off = this.tmp.v.copy(cam.position); off.y = 0;
      v.rig.position.set(c.x - off.x, v.groundY, bb.max.z + 3 - off.z);
    } else {
      v.rig.position.y = 0;
      v.rig.updateMatrixWorld(true);
      const s = MAKETA_SIZE / Math.max(size.x, size.z, 0.01);
      const head = cam.getWorldPosition(new THREE.Vector3());
      const fwd = cam.getWorldDirection(new THREE.Vector3()); fwd.y = 0;
      if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
      fwd.normalize();
      const target = head.clone().addScaledVector(fwd, 0.9);
      target.y = v.rig.position.y + TABLE_HEIGHT;
      const m = v.modelRoot;
      m.quaternion.identity();
      m.scale.setScalar(s);
      m.position.set(target.x - c.x * s, target.y - bb.min.y * s, target.z - c.z * s);
    }
    // podlaha (teleport a mřížka): u 1:1 spodek modelu, u makety podlaha místnosti
    const floorY = this.mode === 'full' ? v.groundY : 0;
    v.ground.position.y = floorY;
    v.ground.updateMatrixWorld();
    if (v.grid) v.grid.position.y = floorY - 0.005;
    v.rig.updateMatrixWorld(true);
    v.modelRoot.updateMatrixWorld(true);
  }

  // ---------- vstupy ----------
  onTrigger(entry) {
    if (entry.hand !== 'right') return;
    if (this.panel.mesh.visible && this.panel.hover) { this.panel.click(); return; }
    this.setRayFrom(entry.controller);
    const hit = this.v.intersect(this.raycaster);
    this.onSelect(hit ? hit.id : null);
  }

  onSqueezeStart(entry) {
    if (this.mode !== 'mini' || !entry.hand) return;
    this.grabs.add(entry);
    this.updateGrabParent();
  }

  onSqueezeEnd(entry) {
    if (!this.grabs.has(entry)) return;
    this.grabs.delete(entry);
    this.updateGrabParent();
  }

  releaseAll() { this.grabs.clear(); this.updateGrabParent(); }

  updateGrabParent() {
    const m = this.v.modelRoot;
    const scene = this.v.scene;
    scene.attach(m);
    this.two = null;
    if (this.grabs.size === 1) {
      [...this.grabs][0].controller.attach(m);
    } else if (this.grabs.size === 2) {
      const [a, b] = [...this.grabs];
      const pa = a.controller.getWorldPosition(new THREE.Vector3());
      const pb = b.controller.getWorldPosition(new THREE.Vector3());
      const d = pb.clone().sub(pa);
      this.two = {
        a, b,
        d0: Math.max(d.length(), 0.01),
        ang0: Math.atan2(d.x, d.z),
        mid0: pa.clone().add(pb).multiplyScalar(0.5),
        pos0: m.position.clone(), quat0: m.quaternion.clone(), scale0: m.scale.x,
      };
    }
  }

  updateTwoHand() {
    const tw = this.two;
    if (!tw) return;
    const m = this.v.modelRoot;
    const pa = tw.a.controller.getWorldPosition(this.tmp.v);
    const pb = tw.b.controller.getWorldPosition(this.tmp.v2);
    const d = new THREE.Vector3().subVectors(pb, pa);
    const k = Math.max(d.length(), 0.01) / tw.d0;
    const dAng = Math.atan2(d.x, d.z) - tw.ang0;
    const mid = pa.clone().add(pb).multiplyScalar(0.5);
    m.scale.setScalar(tw.scale0 * k);
    m.position.copy(tw.pos0).sub(tw.mid0).applyAxisAngle(UP, dAng).multiplyScalar(k).add(mid);
    m.quaternion.setFromAxisAngle(UP, dAng).multiply(tw.quat0);
  }

  setRayFrom(controller) {
    controller.updateMatrixWorld(true);
    this.tmp.m.identity().extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tmp.m).normalize();
    this.raycaster.far = 200;
  }

  // ---------- pohyb ----------
  turn(angle) {
    const rig = this.v.rig;
    const pivot = this.v.camera.getWorldPosition(new THREE.Vector3());
    rig.position.sub(pivot).applyAxisAngle(UP, angle).add(pivot);
    rig.rotateOnWorldAxis(UP, angle);
  }

  teleportTo(point) {
    const rig = this.v.rig;
    const head = this.v.camera.getWorldPosition(new THREE.Vector3());
    rig.position.x += point.x - head.x;
    rig.position.z += point.z - head.z;
    rig.position.y = point.y;
  }

  /** Parabola z ovladače, hledá vodorovnou plochu (podlaha, deska, schod). */
  computeArc(controller) {
    this.setRayFrom(controller);
    const o = this.raycaster.ray.origin.clone();
    const vel = this.raycaster.ray.direction.clone().multiplyScalar(ARC_SPEED);
    const g = new THREE.Vector3(0, -9.8, 0);
    const pos = this.arc.geometry.attributes.position;
    const targets = this.mode === 'full' ? [...this.v.meshes, this.v.ground] : [this.v.ground];
    const dt = 0.04;
    let p = o.clone();
    let hit = null;
    let n = 0;
    pos.setXYZ(n++, p.x, p.y, p.z);
    for (; n < this.arcPoints; n++) {
      const next = p.clone().addScaledVector(vel, dt).addScaledVector(g, 0.5 * dt * dt);
      vel.addScaledVector(g, dt);
      const seg = next.clone().sub(p);
      const len = seg.length();
      this.raycaster.set(p, seg.normalize());
      this.raycaster.far = len;
      const hits = this.raycaster.intersectObjects(targets, false);
      if (hits.length) {
        hits.sort((a, b) => a.distance - b.distance);
        hit = hits[0];
        pos.setXYZ(n, hit.point.x, hit.point.y, hit.point.z);
        n++;
        break;
      }
      pos.setXYZ(n, next.x, next.y, next.z);
      p = next;
    }
    for (let i = n; i < this.arcPoints; i++) pos.setXYZ(i, p.x, p.y, p.z);
    pos.needsUpdate = true;
    this.arc.geometry.computeBoundingSphere();

    let ok = false;
    if (hit) {
      const nrm = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : UP.clone();
      ok = Math.abs(nrm.y) > 0.7;   // geometrie je oboustranná, normála může mířit dolů
    }
    const col = ok ? this.colOk : this.colBad;
    this.arc.material.color.copy(col);
    this.marker.material.color.copy(col);
    this.marker.visible = !!hit;
    if (hit) this.marker.position.copy(hit.point).addScaledVector(UP, 0.01);
    this.arc.visible = true;
    this.teleportHit = ok ? hit.point.clone() : null;
  }

  axes(gp) {
    const a = gp.axes;
    return a.length >= 4 ? [a[2], a[3]] : [a[0] || 0, a[1] || 0];
  }

  pressedEdge(hand, gp, i) {
    const now = !!gp.buttons[i]?.pressed;
    const was = !!this.prev[hand][i];
    this.prev[hand][i] = now;
    return now && !was;
  }

  update(dt) {
    const session = this.v.renderer.xr.getSession();
    if (!session) return;
    const v = this.v;

    if (this.needsInitialPose && --this.needsInitialPose === 0) {
      this.panel.set({ mode: this.mode });
      this.resetPose();
    }

    const L = this.hands.left, R = this.hands.right;
    const lgp = L?.source?.gamepad, rgp = R?.source?.gamepad;

    // levá: chůze, X = panel, Y = měřítko
    if (lgp) {
      const [x, y] = this.axes(lgp);
      if (Math.hypot(x, y) > 0.15) {
        const fwd = v.camera.getWorldDirection(this.tmp.v); fwd.y = 0; fwd.normalize();
        const right = this.tmp.v2.crossVectors(fwd, UP).normalize();
        v.rig.position.addScaledVector(fwd, -y * MOVE_SPEED * dt).addScaledVector(right, x * MOVE_SPEED * dt);
      }
      if (this.pressedEdge('left', lgp, 4)) this.panel.mesh.visible = !this.panel.mesh.visible;
      if (this.pressedEdge('left', lgp, 5)) this.setMode(this.mode === 'full' ? 'mini' : 'full');
    }

    // pravá: teleport / otočení, A = nahoru, B = dolů
    if (rgp) {
      const [x, y] = this.axes(rgp);
      if (!this.teleporting && y < -0.6 && Math.abs(x) < 0.6) this.teleporting = true;
      if (this.teleporting) {
        if (y > -0.25) {
          if (this.teleportHit) this.teleportTo(this.teleportHit);
          this.teleporting = false;
          this.teleportHit = null;
          this.arc.visible = this.marker.visible = false;
        } else this.computeArc(R.controller);
      } else {
        if (!this.turnLatched && Math.abs(x) > 0.7) { this.turn(x > 0 ? -SNAP : SNAP); this.turnLatched = true; }
        if (Math.abs(x) < 0.3) this.turnLatched = false;
      }
      if (rgp.buttons[4]?.pressed) v.rig.position.y += FLY_SPEED * dt;
      if (rgp.buttons[5]?.pressed) v.rig.position.y -= FLY_SPEED * dt;
    } else {
      this.arc.visible = this.marker.visible = false;
    }

    this.updateTwoHand();

    // paprsek pravé ruky: panel má přednost před modelem
    if (R && !this.teleporting) {
      this.setRayFrom(R.controller);
      let dist = 5;
      let onPanel = false;
      if (this.panel.mesh.visible && this.panel.mesh.parent) {
        const ph = this.raycaster.intersectObject(this.panel.mesh, false)[0];
        if (ph) { this.panel.pointAt(ph.uv); onPanel = true; dist = ph.distance; this.cursor.position.copy(ph.point); }
      }
      if (!onPanel) {
        this.panel.clearHover();
        const hit = v.intersect(this.raycaster);
        if (hit) { dist = hit.distance; this.cursor.position.copy(hit.point); }
        this.cursor.visible = !!hit;
      } else this.cursor.visible = true;
      this.ray.scale.z = dist;
      this.ray.visible = true;
    } else {
      this.ray.visible = false;
      this.cursor.visible = false;
    }
  }
}
