// Ovládání ve VR / AR (Meta Quest 3): teleport, chůze, otáčení, let nahoru/dolů, výběr prvku,
// maketa (model zmenšený před uživatelem, úchop a zvětšení oběma rukama).
import * as THREE from 'three';
import { GRID_BELOW } from './viewer.js';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { VRPanel, PANEL } from './vr-panel.js';
import { InfoPanel } from './vr-info.js';
import { t } from './theme.js';

const UP = new THREE.Vector3(0, 1, 0);
const MOVE_SPEED = 2.0;      // m/s chůze
const FLY_SPEED = 1.5;       // m/s nahoru/dolů
const FLY_CLEAR = 0.15;      // odstup hlavy od stropu a nohou od podlahy při letu s kolizemi
const SNAP = THREE.MathUtils.degToRad(30);
const TURN_SPEED = THREE.MathUtils.degToRad(100);   // plynulé otáčení: výchozí rad/s při plném vychýlení páčky (volba na panelu)
const ARC_SPEED = 9;         // počáteční rychlost paraboly teleportu m/s
const MAKETA_SIZE = 1.0;     // největší rozměr makety v m
const TABLE_HEIGHT = 0.8;    // výška spodku makety nad podlahou
/**
 * Kolize: odstup hlavy od zdi (m, kolmo ke zdi – ať při chůzi podél zdi není vidět do ní) a výšky nad nohama,
 * ve kterých se zeď hlídá paprsky (hrudník, navíc výška očí). Nižší prvky (zábradlí, parapet) hlídá kvádr těla;
 * paprsek v úrovni kolen by narážel do boků sloupků zábradlí a podél něj by nešlo klouzat.
 */
const BODY_RADIUS = 0.4;
const BODY_HEIGHTS = [1.2];
/** Šikmý pohyb ke zdi: paprsek se hledá až do BODY_RADIUS / MIN_COS (úhel ke zdi asi do 80°). */
const MIN_COS = 0.17;
/** Tělo jako kvádr (zábradlí, sloupky – mezi paprsky by prošly): polovina šířky = 0,7 × odstup, od výšky schodu po oči. */
/** Ve dveřích (u dveří s křídly, do DOOR_ZONE m od křídla) menší odstup, ať se projde i úzkými dveřmi bez zadrhávání. */
const DOOR_RADIUS = 0.15;
const DOOR_ZONE = 0.8;
/** Gravitace: podlaha se hledá pod středem a v tolika m kolem (otevřené schody, mezery mezi stupni). */
const FOOT = 0.12;
/** Gravitace: nejvyšší schod, na který se vystoupá (m), rychlost výstupu (m/s), zrychlení pádu (m/s²). */
const STEP_UP = 0.45;
const STEP_SPEED = 2.5;
const GRAVITY = 9.81;
const HUD_SIDE = 0.03;       // karta začíná tolik vpravo od levého ovladače (m)
const HUD_LIFT = 0.03;       // …a tolik nad ním
const HUD_GAP = 0.015;       // mezera mezi hlavní kartou a kartou vybraného prvku

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
    // kolize se zdmi a gravitace (volby na panelu)
    this.collide = false;
    this.gravity = false;
    this.smoothTurn = false;
    this.turnSpeed = TURN_SPEED;
    this.fallSpeed = 0;
    this.bodyBox = new THREE.Box3();
    this.boxInv = new THREE.Matrix4();
    this.bodyRay = new THREE.Raycaster();
    this.bodyRay.firstHitOnly = true;
    this.bodyR = BODY_RADIUS;

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
    // panel vybraného prvku vpravo vedle hlavního
    this.info = new InfoPanel();
    // obě karty drží levá ruka za levý dolní roh (ovladač je vedle karty, ne pod ní)
    this.hud = new THREE.Group();
    this.hud.name = 'vr-hud';
    this.hud.rotation.set(-0.9, -0.3, 0, 'XYZ');
    const w = PANEL.WIDTH_M, h = PANEL.HEIGHT_M;
    this.panel.mesh.position.set(HUD_SIDE + w / 2, HUD_LIFT + h / 2, 0);
    this.info.mesh.position.set(HUD_SIDE + w + HUD_GAP + w / 2, HUD_LIFT + h / 2, 0);
    this.hud.add(this.panel.mesh, this.info.mesh);
    this.passthrough = false;
  }

  /** Karty, na které jde mířit (viditelné). */
  get panels() {
    if (!this.hud.visible || !this.hud.parent) return [];
    return [this.panel, this.info].filter((p) => p.mesh.visible);
  }

  attachHandUI(entry) {
    if (entry.hand === 'left') {
      // karty u levého ovladače, nakloněné k uživateli
      entry.grip.add(this.hud);
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
    this.fullPose = null;
    this.panel.set({ ar: passthrough, mode: this.mode });
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
    if (mode === this.mode) return;
    this.releaseAll();
    // z 1:1 do makety si zapamatovat, kde uživatel stál; po návratu do 1:1 tam zase bude
    const rig = this.v.rig;
    if (this.mode === 'full') this.fullPose = { pos: rig.position.clone(), quat: rig.quaternion.clone() };
    const back = mode === 'full' ? this.fullPose : null;
    this.mode = mode;
    this.panel.set({ mode });
    this.fallSpeed = 0;
    this.resetPose(back);
  }

  /**
   * Výchozí pozice: 1:1 – před jižní stranou modelu čelem k němu; maketa – model před uživatelem.
   * `back` = poloha rigu v 1:1 před přepnutím do makety (návrat na stejné místo).
   */
  resetPose(back = null) {
    const v = this.v;
    const bb = v.bbox;
    if (bb.isEmpty()) return;
    const c = bb.getCenter(new THREE.Vector3());
    const size = bb.getSize(new THREE.Vector3());
    const cam = v.camera;
    if (this.mode === 'full') {
      this.resetModelTransform();
      if (back) {
        v.rig.position.copy(back.pos);
        v.rig.quaternion.copy(back.quat);
      } else {
        v.rig.quaternion.identity();
        // kamera má v rigu offset (poloha hlavy v místnosti) – kompenzovat ho v rovině
        const off = this.tmp.v.copy(cam.position); off.y = 0;
        // na podlaze 1NP (ne na spodku modelu – u budovy se suterénem by uživatel stál pod terénem)
        v.rig.position.set(c.x - off.x, v.floorY, bb.max.z + 3 - off.z);
      }
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
    // podlaha (teleport a mřížka): u 1:1 podlaha 1NP, u makety podlaha místnosti
    const floorY = this.mode === 'full' ? v.floorY : 0;
    v.ground.position.y = floorY;
    v.ground.updateMatrixWorld();
    if (v.grid) v.grid.position.y = floorY - GRID_BELOW;
    v.rig.updateMatrixWorld(true);
    v.modelRoot.updateMatrixWorld(true);
  }

  // ---------- vstupy ----------
  onTrigger(entry) {
    if (entry.hand !== 'right') return;
    const p = this.panels.find((x) => x.hover);
    if (p) { p.click(); return; }
    this.setRayFrom(entry.controller);
    const hit = this.v.intersect(this.raycaster);
    // záložka Měření: spoušť měří místo výběru prvku
    if (this.measure?.active) { this.measure.click(this.measure.pick(hit), this.raycaster.ray.origin.clone()); return; }
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
  /** První zásah paprsku do viditelného modelu (bez výřezu Mojžíšova módu), nebo null. */
  bodyHit(origin, dir, far, withGround = false) {
    const r = this.bodyRay;
    r.set(origin, dir);
    r.near = 0;
    r.far = far;
    const targets = withGround ? [...this.v.visibleMeshes, this.v.ground] : this.v.visibleMeshes;
    return this.v.raycast(r, targets)[0] || null;
  }

  /**
   * Kolize se zdmi: pohyb (svět, vodorovný) se zastaví před zdí, podél zdi se dá klouzat.
   * Paprsky v úrovni hrudníku a očí (odstup od zdi kolmo ke zdi), kvádr těla od výšky schodu po oči.
   * Teleport kolize nehlídá.
   */
  collideMove(move) {
    const head = this.v.camera.getWorldPosition(new THREE.Vector3());
    let feet = this.v.rig.position.y;
    // bez gravitace stojí nohy tam, kam je dal start nebo teleport (výška podlaží z IFC bývá pod povrchem
    // podlahy): kvádr těla by vězel v podlaze a kolize s nízkými prvky (zábradlí) by nefungovala.
    // Proto skutečná podlaha pod hlavou, když je výš než nohy (nejvýš o výšku schodu).
    if (!this.gravity) {
      const h = this.bodyHit(head, new THREE.Vector3(0, -1, 0), Math.max(head.y - feet, 0) + 0.05);
      if (h && h.point.y > feet && h.point.y <= feet + STEP_UP) feet = h.point.y;
    }
    this.bodyR = this.inDoorway(head) ? DOOR_RADIUS : BODY_RADIUS;
    this.sweepMove(move, head, feet);
    this.keepClear(move, head, feet);
    this.blockBody(move, head, feet);
  }

  /**
   * Kolize při letu nahoru / dolů (bez gravitace): hlava se zastaví pod stropem, nohy na podlaze.
   * Paprsek svisle z hlavy (nahoru) nebo kousek nad nohama (dolů); vrátí povolený posun.
   */
  collideFly(dy) {
    if (this.v.moses.active) return dy;
    const head = this.v.camera.getWorldPosition(new THREE.Vector3());
    if (dy > 0) {
      const h = this.bodyHit(head, new THREE.Vector3(0, 1, 0), dy + FLY_CLEAR);
      return h ? Math.max(0, Math.min(dy, h.distance - FLY_CLEAR)) : dy;
    }
    const feet = this.v.rig.position.y;
    const o = new THREE.Vector3(head.x, feet + FLY_CLEAR, head.z);
    const h = this.bodyHit(o, new THREE.Vector3(0, -1, 0), -dy + FLY_CLEAR);
    return h ? Math.min(0, Math.max(dy, -(h.distance - FLY_CLEAR))) : dy;
  }

  /** Je hlava u dveří s křídly (půdorysně do DOOR_ZONE od zavřeného křídla, ve výšce dveří)? */
  inDoorway(head) {
    const v = this.v;
    const p = new THREE.Vector3();
    for (const d of v.doors.values()) {
      if (!d.box) continue;
      const g = v.groups.get(d.model);
      if (!g) continue;
      g.worldToLocal(p.copy(head));
      const b = d.box;
      if (p.y < b.min.y || p.y > b.max.y + 0.6) continue;
      if (p.x > b.min.x - DOOR_ZONE && p.x < b.max.x + DOOR_ZONE && p.z > b.min.z - DOOR_ZONE && p.z < b.max.z + DOOR_ZONE) return true;
    }
    return false;
  }

  /**
   * Tělo (kvádr od výšky schodu po oči) nesmí vejít do geometrie: zachytí zábradlí, sloupky a tenké
   * prvky, mezi kterými by paprsky prošly. Když by vešlo, zkusí se pohyb jen v ose X nebo Z (klouzání).
   * V Mojžíšově módu se nehlídá (výřez kolem hlavy je větší než tělo, paprsky ho respektují).
   */
  blockBody(move, head, feet) {
    if (move.lengthSq() < 1e-12 || this.v.moses.active) return;
    if (this.bodyInside(head.x, head.z, head.y, feet)) return;   // už uvnitř (fyzická chůze): pustit ven
    if (!this.bodyInside(head.x + move.x, head.z + move.z, head.y, feet)) return;
    const okX = !this.bodyInside(head.x + move.x, head.z, head.y, feet);
    const okZ = !this.bodyInside(head.x, head.z + move.z, head.y, feet);
    if (okX && (!okZ || Math.abs(move.x) >= Math.abs(move.z))) move.z = 0;
    else if (okZ) move.x = 0;
    else move.set(0, 0, 0);
  }

  bodyInside(x, z, headY, feet) {
    const b = this.bodyBox;
    b.min.set(x - (this.bodyR * 0.7), feet + STEP_UP, z - (this.bodyR * 0.7));
    b.max.set(x + (this.bodyR * 0.7), Math.max(headY, feet + 1.3), z + (this.bodyR * 0.7));
    for (const m of this.v.visibleMeshes) {
      const tree = m.geometry.boundsTree;
      if (!tree) continue;
      this.boxInv.copy(m.matrixWorld).invert();
      if (tree.intersectsBox(b, this.boxInv)) return true;
    }
    return false;
  }

  /** Pohyb proti zdi: zastavit v odstupu this.bodyR, zbytek pohybu podél zdi. */
  sweepMove(move, head, feet) {
    for (let pass = 0; pass < 2; pass++) {
      const len = move.length();
      if (len < 1e-6) return;
      const dir = move.clone().divideScalar(len);
      // nejbližší zeď ze všech výšek: kolik se dá jít, než bude hlava blíž ke zdi než this.bodyR (kolmo)
      let go = len, n = null;
      for (const hgt of [...BODY_HEIGHTS, Math.max(head.y - feet, 1.3)]) {
        const h = this.bodyHit(new THREE.Vector3(head.x, feet + hgt, head.z), dir, len + this.bodyR / MIN_COS);
        if (!h?.face) continue;
        // normála zdi ve vodorovné rovině, otočená proti pohybu
        const hn = h.face.normal.clone().transformDirection(h.object.matrixWorld);
        hn.y = 0;
        if (hn.lengthSq() < 1e-6) continue;
        hn.normalize();
        if (hn.dot(dir) > 0) hn.negate();
        const cos = Math.max(-hn.dot(dir), MIN_COS);
        const g = Math.max(0, h.distance - this.bodyR / cos);
        if (g < go) { go = g; n = hn; }
      }
      if (!n) return;
      // až k odstupu od zdi; zbytek pohybu podél zdi (napoprvé, podruhé už jen ke zdi)
      const rest = move.clone().multiplyScalar(1 - go / len);
      rest.addScaledVector(n, -rest.dot(n));
      move.copy(dir).multiplyScalar(go);
      if (pass === 1) return;
      move.add(rest);
    }
  }

  /**
   * Odstup do stran: při chůzi skoro podél zdi ji paprsek ve směru pohybu nenajde včas. Z cílového místa se
   * proto hledá zeď všemi směry do this.bodyR a ruší se ta část pohybu, která by k ní hlavu přiblížila.
   */
  keepClear(move, head, feet) {
    if (move.lengthSq() < 1e-12) return;
    const dir = new THREE.Vector3();
    for (const hgt of [...BODY_HEIGHTS, Math.max(head.y - feet, 1.3)]) {
      const o = new THREE.Vector3(head.x + move.x, feet + hgt, head.z + move.z);
      for (let a = 0; a < 8; a++) {
        const ang = a * Math.PI / 4;
        dir.set(Math.cos(ang), 0, Math.sin(ang));
        const h = this.bodyHit(o, dir, this.bodyR);
        if (!h?.face) continue;
        const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
        n.y = 0;
        if (n.lengthSq() < 1e-6) continue;
        n.normalize();
        if (n.dot(dir) > 0) n.negate();
        const into = -move.dot(n);              // kolik se pohyb přibližuje ke zdi
        const gap = this.bodyR - h.distance * -n.dot(dir);   // o kolik je hlava blíž, než má
        if (into > 0 && gap > 0) {
          move.addScaledVector(n, Math.min(into, gap));
          o.set(head.x + move.x, feet + hgt, head.z + move.z);
        }
      }
    }
  }

  /**
   * Gravitace: pod hlavou se hledá podlaha. Do STEP_UP nad nohama se na ni vystoupá (schod, rampa),
   * níž se padá se zrychlením (ze schodů, do otvoru). Mimo model drží podlaha 1NP (mřížka).
   */
  applyGravity(dt) {
    const v = this.v, rig = v.rig;
    const head = v.camera.getWorldPosition(new THREE.Vector3());
    const feet = rig.position.y;
    // nejvyšší podlaha modelu pod chodidly (střed a čtyři body kolem): mezera mezi stupni neprovalí.
    // Podlaha 1NP (mřížka) drží jen tam, kde pod nohama žádný model není (mimo budovu) – v budově se
    // po schodech dá sejít do suterénu.
    const down = new THREE.Vector3(0, -1, 0);
    let floor = -Infinity;
    for (const [dx, dz] of [[0, 0], [FOOT, 0], [-FOOT, 0], [0, FOOT], [0, -FOOT]]) {
      const hit = this.bodyHit(new THREE.Vector3(head.x + dx, feet + STEP_UP, head.z + dz), down, 200);
      if (hit) floor = Math.max(floor, hit.point.y);
    }
    if (floor === -Infinity) {
      const hit = this.bodyHit(new THREE.Vector3(head.x, feet + STEP_UP, head.z), down, 200, true);
      if (hit) floor = hit.point.y;
    }
    if (floor === -Infinity) { this.fallSpeed = 0; return; }
    if (floor > feet + 0.005) {
      rig.position.y = Math.min(floor, feet + STEP_SPEED * dt);
      this.fallSpeed = 0;
    } else if (floor < feet - 0.005) {
      this.fallSpeed += GRAVITY * dt;
      rig.position.y = Math.max(floor, feet - this.fallSpeed * dt);
      if (rig.position.y === floor) this.fallSpeed = 0;
    } else this.fallSpeed = 0;
  }

  /** Je pod bodem (do 200 m) nějaká geometrie modelu? */
  modelBelow(point) {
    return !!this.bodyHit(point.clone().setY(point.y + 0.01), new THREE.Vector3(0, -1, 0), 200);
  }

  turn(angle) {
    const rig = this.v.rig;
    const pivot = this.v.camera.getWorldPosition(new THREE.Vector3());
    rig.position.sub(pivot).applyAxisAngle(UP, angle).add(pivot);
    rig.rotateOnWorldAxis(UP, angle);
  }

  /** Přesun z mapy: bod podlahy v souřadnicích modelu (maketa se přepne na 1:1). */
  goTo(point) {
    if (this.mode !== 'full') this.setMode('full');
    this.v.modelRoot.updateMatrixWorld(true);
    this.teleportTo(this.v.modelRoot.localToWorld(point.clone()));
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
    const targets = this.mode === 'full' ? [...this.v.visibleMeshes, this.v.ground] : [this.v.ground];
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
      let hits = this.v.raycast(this.raycaster, targets);
      // podlaha 1NP nad modelem (schodiště do suterénu, otvor) neplatí: parabola letí dál k modelu pod ní
      if (hits.length && hits[0].object === this.v.ground && this.mode === 'full' && this.modelBelow(hits[0].point)) {
        hits = this.v.raycast(this.raycaster, this.v.visibleMeshes);
      }
      if (hits.length) {
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
    // Mojžíšův mód: výřez kolem hlavy od podlahy pod nohama (u makety ne – model je zmenšený na stole)
    if (v.moses.target > 0 || v.moses.active) {
      if (this.mode === 'full') {
        // kamera v rigu (xr.getCamera() má polohu bez posunu rigu, tj. bez teleportu a chůze)
        const head = v.camera.getWorldPosition(this.tmp.v);
        v.moses.setCenter(head.x, v.rig.position.y, head.z);
      } else v.moses.setCenter(1e9, 0, 1e9);
    }
    // snímky za sekundu na panelu (jednou za sekundu)
    this.fpsT = (this.fpsT || 0) + dt;
    this.fpsN = (this.fpsN || 0) + 1;
    if (this.fpsT >= 1) {
      this.panel.setFps(this.fpsN / this.fpsT, session.frameRate);
      this.fpsT = 0; this.fpsN = 0;
    }
    // mapa na panelu: poloha uživatele se překresluje dvakrát za sekundu
    if (this.panel.state.tab === 'map' && this.hud.visible) {
      this.mapTimer = (this.mapTimer || 0) + dt;
      if (this.mapTimer > 0.5) { this.mapTimer = 0; this.panel.draw(); }
    }

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
        const move = new THREE.Vector3().addScaledVector(fwd, -y * MOVE_SPEED * dt).addScaledVector(right, x * MOVE_SPEED * dt);
        if (this.collide && this.mode === 'full') this.collideMove(move);
        v.rig.position.add(move);
      }
      if (this.pressedEdge('left', lgp, 4)) this.hud.visible = !this.hud.visible;
      if (this.pressedEdge('left', lgp, 5)) this.setMode(this.mode === 'full' ? 'mini' : 'full');
    }

    // pravá: teleport / otočení, A = nahoru, B = dolů
    if (rgp) {
      const [x, y] = this.axes(rgp);
      // paprsek míří do mapy na panelu: páčka nahoru / dolů přibližuje k tomu místu (ne teleport ani otočení)
      const onMap = !this.teleporting && this.hud.visible && this.panel.hover === 'map';
      if (onMap) { if (Math.abs(y) > 0.2) this.panel.zoomMap(Math.exp(-Math.sign(y) * (Math.abs(y) - 0.2) * 3 * dt), true); }
      else if (!this.teleporting && y < -0.6 && Math.abs(x) < 0.6) this.teleporting = true;
      if (onMap) { /* páčka patří mapě */ } else if (this.teleporting) {
        if (y > -0.25) {
          if (this.teleportHit) this.teleportTo(this.teleportHit);
          this.teleporting = false;
          this.teleportHit = null;
          this.arc.visible = this.marker.visible = false;
        } else this.computeArc(R.controller);
      } else {
        if (this.smoothTurn) {
          // plynulé otáčení podle vychýlení páčky (mrtvá zóna kolem středu)
          if (Math.abs(x) > 0.2) this.turn(-Math.sign(x) * (Math.abs(x) - 0.2) / 0.8 * this.turnSpeed * dt);
        } else {
          if (!this.turnLatched && Math.abs(x) > 0.7) { this.turn(x > 0 ? -SNAP : SNAP); this.turnLatched = true; }
          if (Math.abs(x) < 0.3) this.turnLatched = false;
        }
      }
      // nahoru / dolů jen bez gravitace (s ní se chodí po schodech)
      if (!this.gravity || this.mode !== 'full') {
        let dy = 0;
        if (rgp.buttons[4]?.pressed) dy += FLY_SPEED * dt;
        if (rgp.buttons[5]?.pressed) dy -= FLY_SPEED * dt;
        if (dy && this.collide && this.mode === 'full') dy = this.collideFly(dy);
        v.rig.position.y += dy;
      }
    } else {
      this.arc.visible = this.marker.visible = false;
    }

    this.updateTwoHand();
    if (this.gravity && this.mode === 'full' && !this.needsInitialPose) this.applyGravity(dt);

    // paprsek pravé ruky: panel má přednost před modelem
    if (R && !this.teleporting) {
      this.setRayFrom(R.controller);
      let dist = 5;
      let onPanel = false;
      let best = null;
      for (const p of this.panels) {
        const ph = this.raycaster.intersectObject(p.mesh, false)[0];
        if (ph && (!best || ph.distance < best.ph.distance)) best = { p, ph };
      }
      for (const p of [this.panel, this.info]) if (p !== best?.p) p.clearHover();
      if (best) { best.p.pointAt(best.ph.uv); onPanel = true; dist = best.ph.distance; this.cursor.position.copy(best.ph.point); }
      let hit = null;
      if (!onPanel) {
        hit = v.intersect(this.raycaster);
        if (hit) { dist = hit.distance; this.cursor.position.copy(hit.point); }
        this.cursor.visible = !!hit;
      } else this.cursor.visible = true;
      // náhled měření (štítek se překresluje nejvýš 15× za sekundu)
      const m = this.measure;
      if (m?.active) {
        this.measureT = (this.measureT || 0) + dt;
        if (this.measureT > 1 / 15) {
          this.measureT = 0;
          m.hover(m.pick(hit), this.raycaster.ray.origin.clone());
        }
      }
      this.ray.scale.z = dist;
      this.ray.visible = true;
    } else {
      this.ray.visible = false;
      this.cursor.visible = false;
    }
  }
}
