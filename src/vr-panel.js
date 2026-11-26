// Panel ve VR na levém ovladači: kreslí se do canvasu podle EBC_UI_vibe, ovládá se paprskem z pravého ovladače.
import * as THREE from 'three';
import { t, px, font } from './theme.js';
import { QUALITY, TURN_SPEEDS } from './quality.js';
import { drawUser, ZOOM_MAX } from './map.js';
import { MOSES_RADII } from './moses.js';
import { MEASURE_TOOLS } from './measure.js';

const QUALITY_KEYS = Object.entries(QUALITY).map(([k, q]) => [k, q.label]);
/** Záložky panelu: klíč, popisek */
const TABS = [['models', 'Modely'], ['map', 'Mapa'], ['measure', 'Měření'], ['settings', 'Nastavení']];

const W = 1024;          // šířka canvasu v px
const H = 2300;          // výška canvasu v px
const S = 2.6;           // zvětšení tokenů (px EBC → px canvasu)
const WIDTH_M = 0.26;    // šířka panelu v metrech
const FPS_W = 330;       // šířka ukazatele snímků za sekundu v px canvasu
/** Rozměry karty (pro panel vybraného prvku): canvas W × H px, zvětšení tokenů S, šířka v metrech. */
export const PANEL = { W, H, S, WIDTH_M, HEIGHT_M: (WIDTH_M * H) / W };

export const HELP = [
  ['Levá páčka', 'chůze'],
  ['Pravá páčka dopředu', 'teleport, do stran otočení'],
  ['A / B', 'nahoru / dolů (bez gravitace)'],
  ['Pravá spoušť', 'vybrat prvek, tlačítko panelu'],
  ['Spoušť znovu na prvek', 'zrušit výběr (dveře: otevřít)'],
  ['Úchop (maketa)', 'posunout, oběma rukama zvětšit'],
  ['X / Y', 'skrýt panel / přepnout měřítko'],
];

export class VRPanel {
  /** fps: false = bez ukazatele snímků za sekundu (panel vybraného prvku) */
  constructor({ fps = true } = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const h = (WIDTH_M * H) / W;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(WIDTH_M, h),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false }),
    );
    this.mesh.name = 'vr-panel';
    this.mesh.renderOrder = 20;
    // snímky za sekundu: vlastní malý obrázek v záhlaví (překresluje se každou sekundu, celý panel ne)
    if (fps) this.addFps(h);
    this.init();
  }

  addFps(h) {
    this.fpsCanvas = document.createElement('canvas');
    this.fpsCanvas.width = FPS_W;
    this.fpsCanvas.height = Math.round(px('size.titlebar.height') * S);
    this.fpsTexture = new THREE.CanvasTexture(this.fpsCanvas);
    this.fpsTexture.colorSpace = THREE.SRGBColorSpace;
    const k = WIDTH_M / W;
    this.fpsMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(FPS_W * k, this.fpsCanvas.height * k),
      new THREE.MeshBasicMaterial({ map: this.fpsTexture, transparent: true, toneMapped: false }),
    );
    this.fpsMesh.position.set(WIDTH_M / 2 - (FPS_W / 2 + px('space.20') * S * 0.5) * k, h / 2 - (this.fpsCanvas.height / 2) * k, 0.0005);
    this.fpsMesh.renderOrder = 21;
    this.fpsMesh.raycast = () => {};
    this.mesh.add(this.fpsMesh);
    this.setFps(0, 0);
  }

  init() {
    this.regions = [];
    this.hover = null;
    this.state = { modelName: '', mode: 'full', page: 0, message: '', tab: 'models', models: [], mpage: 0 };
    this.actions = {};
    /** Akce s modelem: (op 'vis' | 'col' | 'del', modelID) */
    this.onModel = null;
    /** Volba úrovně zobrazení (klíč z QUALITY) */
    this.onQuality = null;
    /** Mapa: { levels(), plan(level) → { canvas }, user() → { u, v, dx, dy } | null } a přesun (index podlaží, u, v) */
    this.mapSource = null;
    this.onMap = null;
    this.pointer = { x: 0, y: 0 };
    this.draw();
  }

  /** Snímky za sekundu v záhlaví; žlutě, když brýle nestíhají frekvenci displeje (rate). */
  setFps(fps, rate) {
    if (!this.fpsCanvas) return;
    const c = this.fpsCanvas.getContext('2d');
    const w = this.fpsCanvas.width, h = this.fpsCanvas.height;
    c.clearRect(0, 0, w, h);
    c.fillStyle = t('color.bg.chrome');
    c.fillRect(0, 0, w, h);
    if (fps > 0) {
      c.font = font('typography.caption-bar', S);
      c.textAlign = 'right';
      c.textBaseline = 'middle';
      c.fillStyle = rate && fps < rate * 0.9 ? t('color.text.warning') : t('color.text.secondary');
      c.fillText(`${Math.round(fps)}${rate ? ` / ${Math.round(rate)}` : ''} snímků/s`, w, h / 2);
    }
    this.fpsTexture.needsUpdate = true;
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.draw();
  }

  /** Souřadnice UV průsečíku → oblast tlačítka. */
  pointAt(uv) {
    const x = uv.x * W, y = (1 - uv.y) * H;
    this.pointer.x = x; this.pointer.y = y;
    const r = this.regions.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h && !r.disabled);
    const key = r ? r.key : null;
    if (key !== this.hover) { this.hover = key; this.draw(); }
    return r;
  }

  /**
   * Přiblížení mapy (factor > 1 přiblíží, 0 = celý půdorys). `atPointer` = kolem místa, kam se míří
   * (páčka), jinak kolem středu výřezu (tlačítka).
   */
  zoomMap(factor, atPointer = false) {
    const z = this.mapZoom;
    if (!z) return;
    const r = atPointer && this.regions.find((x) => x.key === 'map');
    const fu = r ? (this.pointer.x - r.x) / r.w : 0.5, fv = r ? (this.pointer.y - r.y) / r.h : 0.5;
    this.mapView = factor ? z.zoom(this.mapView, factor, fu, fv) : z.full();
    // při plynulém přibližování páčkou se panel překresluje nejvýš 15× za sekundu
    const now = performance.now();
    if (!atPointer || now - (this.mapDrawn || 0) > 66) { this.mapDrawn = now; this.draw(); }
  }

  clearHover() { if (this.hover) { this.hover = null; this.draw(); } }

  click() {
    const r = this.regions.find((r) => r.key === this.hover);
    if (!r) return false;
    const pg = this.state.tab === 'models' ? 'mpage' : this.state.tab === 'measure' ? 'mlpage' : 'page';
    if (r.key === 'next') { this.state[pg]++; this.draw(); return true; }
    if (r.key === 'prev') { this.state[pg] = Math.max(0, this.state[pg] - 1); this.draw(); return true; }
    if (r.key.startsWith('tab-')) {
      this.state.colorFor = null; this.state.tab = r.key.slice(4); this.state.mapMsg = ''; this.onTab?.(this.state.tab); this.draw(); return true; }
    if (r.key.startsWith('mz:')) { this.zoomMap(r.key === 'mz:in' ? 2 : r.key === 'mz:out' ? 0.5 : 0); return true; }
    if (r.key.startsWith('lvl:')) { this.state.mapLevel = +r.key.slice(4); this.state.mapMsg = ''; this.draw(); return true; }
    if (r.key === 'map') {
      this.onMap?.(this.state.mapLevel ?? 0, (this.pointer.x - r.x) / r.w, (this.pointer.y - r.y) / r.h);
      return true;
    }
    if (r.key.startsWith('pal:')) {
      const v = r.key.slice(4);
      if (v === 'close') { this.state.colorFor = null; this.draw(); return true; }
      const m = this.state.models.find((x) => x.id === this.state.colorFor);
      if (m) this.onColor?.(m.id, v === 'orig' ? null : v === 'custom' ? m.custom : v);
      return true;
    }
    if (r.key.startsWith('mt:')) { this.onMeasure?.('tool', r.key.slice(3)); return true; }
    if (r.key.startsWith('mdel:')) { this.onMeasure?.('remove', +r.key.slice(5)); return true; }
    if (r.key === 'msnap' || r.key === 'mundo' || r.key === 'mclear') { this.onMeasure?.(r.key.slice(1)); return true; }
    if (r.key.startsWith('q:')) { this.onQuality?.(r.key.slice(2)); return true; }
    if (r.key.startsWith('moses:')) { this.onMoses?.(+r.key.slice(6)); return true; }
    if (r.key === 'edges') { this.onEdges?.(); return true; }
    if (r.key === 'unhide') { this.onUnhide?.(); return true; }
    if (r.key.startsWith('tw:')) { this.onTweak?.(r.key.slice(3)); return true; }
    if (r.key === 'blocks') { this.onBlocks?.(this.state.blocks === false); return true; }
    if (r.key === 'doors') { this.onAutoDoors?.(!this.state.autoDoors); return true; }
    if (r.key.startsWith('turn:')) { this.onTurnSpeed?.(r.key.slice(5)); return true; }
    if (r.key === 'collide' || r.key === 'gravity' || r.key === 'smoothTurn') { this.onMotion?.(r.key, !this.state[r.key]); return true; }
    const m = /^(vis|col|del):(\d+)$/.exec(r.key);
    if (m) { this.onModel?.(m[1], +m[2]); return true; }
    this.actions[r.key]?.();
    return true;
  }

  // ---------- kreslení ----------
  rr(x, y, w, h, r) {
    const c = this.ctx;
    c.beginPath();
    c.roundRect(x, y, w, h, r);
  }

  button(key, label, x, y, w, { primary = false, active = false, disabled = false } = {}) {
    const c = this.ctx;
    const h = (px('size.button.padding-y') * 2 + 18) * S;
    const hover = this.hover === key;
    this.rr(x, y, w, h, px('radius.lg') * S);
    if (primary || active) {
      c.fillStyle = hover ? t('color.accent.hover') : t('color.accent.default');
      c.fill();
      c.lineWidth = 2 * S;
      c.strokeStyle = hover ? t('color.bg.muted') : t('color.accent.default');
    } else {
      c.fillStyle = hover ? t('color.list.hover') : t('color.bg.window');
      c.fill();
      c.lineWidth = 1.5 * S;
      c.strokeStyle = hover ? t('color.bg.muted') : t('color.border.default');
    }
    c.stroke();
    c.globalAlpha = disabled ? parseFloat(t('opacity.disabled')) : 1;
    c.fillStyle = t('color.text.primary');
    c.font = font(primary || active ? 'typography.button-primary' : 'typography.button', S);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(label, x + w / 2, y + h / 2);
    c.globalAlpha = 1;
    c.textAlign = 'left';
    this.regions.push({ key, x, y, w, h, disabled });
    return h;
  }

  sectionLabel(text, x, y) {
    const c = this.ctx;
    c.fillStyle = t('color.text.accent');
    c.font = font('typography.caption', S * 1.15);
    c.textBaseline = 'top';
    c.fillText(text.toLocaleUpperCase('cs-CZ'), x, y);
    return 16 * S;
  }

  ellipsize(text, maxW) {
    const c = this.ctx;
    if (c.measureText(text).width <= maxW) return text;
    let s = text;
    while (s.length > 1 && c.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  /** Zkrácení uprostřed: začátek i konec názvu zůstanou vidět (soubory se často liší až na konci). */
  ellipsizeMiddle(text, maxW) {
    const c = this.ctx;
    if (c.measureText(text).width <= maxW) return text;
    let a = Math.ceil(text.length / 2), b = text.length - a;
    while (a + b > 1 && c.measureText(`${text.slice(0, a)}…${text.slice(text.length - b)}`).width > maxW) {
      if (a >= b) a--; else b--;
    }
    return `${text.slice(0, a)}…${text.slice(text.length - b)}`;
  }

  /**
   * Název souboru do nejvýš `maxLines` řádků: láme se přednostně za _ - . nebo mezerou; co se nevejde,
   * zkrátí se na posledním řádku zepředu (konec názvu, typicky profese, zůstane vidět).
   */
  breakName(text, maxW, maxLines = 2) {
    const c = this.ctx;
    const out = [];
    let rest = text;
    while (rest && out.length < maxLines - 1 && c.measureText(rest).width > maxW) {
      let n = 1;
      while (n < rest.length && c.measureText(rest.slice(0, n + 1)).width <= maxW) n++;
      const sep = Math.max(...['_', '-', '.', ' '].map((ch) => rest.lastIndexOf(ch, n - 1)));
      if (sep >= n * 0.4) n = sep + 1;
      out.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    if (rest) {
      if (c.measureText(rest).width <= maxW) out.push(rest);
      else {
        let k = rest.length;
        while (k > 1 && c.measureText(`…${rest.slice(rest.length - k)}`).width > maxW) k--;
        out.push(`…${rest.slice(rest.length - k)}`);
      }
    }
    return out;
  }

  /** Text zalomený do šířky maxW (aktuálním písmem). */
  wrap(text, maxW) {
    const c = this.ctx;
    const out = [];
    let line = '';
    for (const w of text.split(' ')) {
      const next = line ? `${line} ${w}` : w;
      if (line && c.measureText(next).width > maxW) { out.push(line); line = w; } else line = next;
    }
    if (line) out.push(line);
    return out;
  }

  /** Měření: nástroj, přichycení, zpět / smazat, nápověda a výsledky (nejnovější nahoře). */
  drawMeasure(y, bottom, { pad, gap, inner, bh, third, q4 }) {
    const c = this.ctx;
    const st = this.state;
    MEASURE_TOOLS.forEach(([key, label], i) => {
      this.button(`mt:${key}`, label, pad + i * (q4 + gap), y, q4, { active: st.mTool === key });
    });
    y += bh + gap;
    this.button('msnap', 'Přichytit', pad, y, third, { active: !!st.mSnap });
    this.button('mundo', 'Zpět', pad + third + gap, y, third, { disabled: !st.mCanUndo });
    this.button('mclear', 'Smazat vše', pad + 2 * (third + gap), y, third, { disabled: !st.mItems?.length });
    y += bh + gap * 1.5;
    c.textBaseline = 'top';
    c.font = font('typography.small', S);
    c.fillStyle = t('color.text.secondary');
    for (const line of this.wrap(st.mHint || '', inner)) { c.fillText(line, pad, y); y += 17 * S; }
    y += gap;
    const items = st.mItems || [];
    // řádky: text vlevo, vpravo tlačítko Smazat (jen toto měření); co se nevejde, je na dalších stránkách
    const rowH = 46 * S;
    const delW = inner * 0.22;
    const textW = inner - delW - gap;
    let perPage = Math.max(1, Math.floor((bottom - y) / rowH));
    if (items.length > perPage) perPage = Math.max(1, Math.floor((bottom - y - bh - gap) / rowH));
    const pages = Math.max(1, Math.ceil(items.length / perPage));
    st.mlpage = Math.min(st.mlpage || 0, pages - 1);
    for (const it of items.slice(st.mlpage * perPage, (st.mlpage + 1) * perPage)) {
      c.strokeStyle = t('color.list.separator');
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(pad, y); c.lineTo(pad + inner, y); c.stroke();
      c.textBaseline = 'top';
      c.font = font('typography.body', S);
      c.fillStyle = t('color.text.primary');
      const ty = it.detail ? y + 4 * S : y + 13 * S;
      c.fillText(this.ellipsize(it.title, textW), pad, ty);
      if (it.detail) {
        c.font = font('typography.small', S);
        c.fillStyle = t('color.text.secondary');
        c.fillText(this.ellipsize(it.detail, textW), pad, y + 24 * S);
      }
      this.button(`mdel:${it.id}`, 'Smazat', pad + inner - delW, y + (rowH - bh) / 2, delW);
      y += rowH;
    }
    if (pages > 1) this.pager(bottom - bh, st.mlpage, pages, { pad, gap, inner, bh });
    if (!items.length) {
      c.font = font('typography.body', S);
      c.fillStyle = t('color.text.secondary');
      c.fillText('Zatím nic není změřeno.', pad, y + 4 * S);
    }
  }

  /** Nastavení: úroveň zobrazení, pohyb, Mojžíšův mód. */
  drawSettings(y, { pad, gap, inner, bh, half, third }) {
    const st = this.state;
    const c0 = this.ctx;
    // úroveň zobrazení (rozlišení se změní až po dalším vstupu do VR)
    y += this.sectionLabel('Zobrazení', pad, y);
    QUALITY_KEYS.forEach(([key, label], i) => {
      this.button(`q:${key}`, label, pad + i * (third + gap), y, third, { active: st.quality === key });
    });
    y += bh + pad;

    // ladění výkonu: jednotlivé položky úrovně zvlášť (přepnutí úrovně je vrátí), kreslení po blocích
    const look = st.look || {};
    y += this.sectionLabel('Ladění výkonu', pad, y);
    const rows = [
      [['tw:ao', 'Stíny v koutech', look.ao !== false], ['tw:doubleSide', 'Rubové strany', !!look.doubleSide], ['tw:glass', 'Průhledné sklo', !!look.glass]],
      [['tw:foveation', 'Ostré okraje', look.foveation === 0], ['tw:xrScale', 'Rozlišení 100 %', look.xrScale !== 0.8], ['blocks', 'Jen zorné pole', st.blocks !== false]],
    ];
    for (const row of rows) {
      row.forEach(([key, label, active], i) => this.button(key, label, pad + i * (third + gap), y, third, { active }));
      y += bh + gap;
    }
    c0.textBaseline = 'top';
    c0.font = font('typography.small', S);
    c0.fillStyle = t('color.text.secondary');
    for (const line of this.wrap('Rozlišení platí po dalším vstupu do VR. Přepnutí úrovně ruční změny zruší.', inner)) {
      c0.fillText(line, pad, y);
      y += 17 * S;
    }
    y += pad - gap;

    // pohyb: kolize se zdmi, gravitace (schody, rampy), automatické dveře jen ve skutečném měřítku
    // (v maketě se v modelu nechodí); plynulé otáčení platí v obou
    const full = st.mode !== 'mini';
    y += this.sectionLabel('Pohyb', pad, y);
    if (full) {
      this.button('collide', 'Kolize', pad, y, half, { active: !!st.collide });
      this.button('gravity', 'Gravitace', pad + half + gap, y, half, { active: !!st.gravity });
      y += bh + gap;
      this.button('doors', 'Automatické dveře', pad, y, half, { active: !!st.autoDoors });
    }
    this.button('smoothTurn', 'Plynulé otáčení', full ? pad + half + gap : pad, y, half, { active: !!st.smoothTurn });
    y += bh + pad;

    // rychlost plynulého otáčení (bez plynulého otáčení se neuplatní)
    y += this.sectionLabel('Rychlost plynulého otáčení', pad, y);
    Object.entries(TURN_SPEEDS).forEach(([key, sp], i) => {
      this.button(`turn:${key}`, `${sp.label} (${sp.deg}°/s)`, pad + i * (third + gap), y, third, { active: st.turnSpeed === key, disabled: !st.smoothTurn });
    });
    y += bh + pad;

    // Mojžíšův mód: model kolem uživatele ustoupí (poloměr výřezu) – jen ve skutečném měřítku
    if (full) {
      y += this.sectionLabel('Mojžíšův mód', pad, y);
      const w = (inner - (MOSES_RADII.length - 1) * gap) / MOSES_RADII.length;
      MOSES_RADII.forEach((r, i) => {
        this.button(`moses:${r}`, r ? `${r} m` : 'Vyp.', pad + i * (w + gap), y, w, { active: (st.moses || 0) === r });
      });
    } else {
      const c = this.ctx;
      c.textBaseline = 'top';
      c.font = font('typography.small', S);
      c.fillStyle = t('color.text.secondary');
      for (const line of this.wrap('Kolize, gravitace, automatické dveře a Mojžíšův mód jsou jen ve skutečném měřítku 1:1.', inner)) {
        c.fillText(line, pad, y);
        y += 17 * S;
      }
    }
  }

  /** Mapa: tlačítka podlaží, půdorys se značkou uživatele; klepnutím do půdorysu přesun. */
  drawMap(y, bottom, { pad, gap, inner, bh }) {
    const c = this.ctx;
    const st = this.state;
    const src = this.mapSource;
    const levels = src?.levels() || [];
    if (!levels.length) {
      c.font = font('typography.body', S);
      c.fillStyle = t('color.text.secondary');
      c.fillText('Model nemá podlaží, mapa není k dispozici.', pad, y + 4 * S, inner);
      return;
    }
    st.mapLevel = Math.min(Math.max(st.mapLevel ?? 0, 0), levels.length - 1);
    // podlaží odshora, nejvýš 4 v řádku
    const perRow = Math.min(4, levels.length);
    const bw = (inner - (perRow - 1) * gap) / perRow;
    const order = levels.map((l, i) => i).reverse();
    order.forEach((i, k) => {
      const col = k % perRow, row = Math.floor(k / perRow);
      c.font = font('typography.button', S);
      this.button(`lvl:${i}`, this.ellipsize(levels[i].label, bw - 16 * S), pad + col * (bw + gap), y + row * (bh + gap), bw, { active: i === st.mapLevel });
    });
    y += Math.ceil(levels.length / perRow) * (bh + gap);
    // úplné názvy zvoleného podlaží (popisek na tlačítku je zkrácený)
    const lv = levels[st.mapLevel];
    if (lv.name !== lv.label) {
      c.font = font('typography.small', S);
      c.textBaseline = 'top';
      c.fillStyle = t('color.text.secondary');
      c.fillText(this.ellipsizeMiddle(lv.name, inner), pad, y);
      y += 22 * S;
    }
    // přiblížení: oddálit, přiblížit, celý půdorys (víc i páčkou při míření do mapy)
    const view = this.mapView || { k: 1 };
    const zw = (inner - 2 * gap) / 3;
    this.button('mz:out', 'Oddálit', pad, y, zw, { disabled: view.k <= 1 });
    this.button('mz:in', 'Přiblížit', pad + zw + gap, y, zw, { disabled: view.k >= ZOOM_MAX });
    this.button('mz:all', 'Celý půdorys', pad + 2 * (zw + gap), y, zw, { disabled: view.k <= 1 });
    y += bh + gap;
    // zpráva dole
    const msgH = 22 * S;
    const areaH = bottom - y - msgH;
    const plan = src.plan(levels[st.mapLevel]);
    const pw = plan.canvas.width, ph = plan.canvas.height;
    const k = Math.min(inner / pw, areaH / ph);
    const w = pw * k, h = ph * k, x = pad + (inner - w) / 2;
    src.draw(c, levels[st.mapLevel], view, x, y, w, h);
    c.strokeStyle = t('color.border.default');
    c.lineWidth = 1.5 * S;
    c.strokeRect(x, y, w, h);
    this.regions.push({ key: 'map', x, y, w, h, disabled: false });
    const me = src.user();
    const at = me && { fu: (me.u - (view.u0 || 0)) * view.k, fv: (me.v - (view.v0 || 0)) * view.k };
    if (at && at.fu >= 0 && at.fu <= 1 && at.fv >= 0 && at.fv <= 1) drawUser(c, x + at.fu * w, y + at.fv * h, me.dx, me.dy, 7 * S);
    c.font = font('typography.small', S);
    c.textBaseline = 'top';
    c.fillStyle = st.mapMsg ? t('color.text.error') : t('color.text.secondary');
    const hint = (st.mode === 'mini' ? 'Spoušť do půdorysu: vstup do modelu 1:1 na tom místě.' : 'Spoušť do půdorysu: přesun na místo.')
      + ' Pravá páčka nahoru / dolů: přiblížit / oddálit.';
    c.fillText(st.mapMsg || hint, pad, y + h + 6 * S, inner);
  }

  /** Barva modelu: paleta jako na počítači, vlastní barva (zvolená na počítači) a původní barvy z IFC. */
  drawPalette(y, bottom, m, { pad, gap, inner, bh, half }) {
    const c = this.ctx;
    const st = this.state;
    c.textBaseline = 'top';
    c.font = font('typography.body', S);
    c.fillStyle = t('color.text.primary');
    c.fillText(this.ellipsizeMiddle(`Barva modelu ${m.name}`, inner), pad, y);
    y += 26 * S;
    const pal = st.palette || [];
    const cols = 6;
    const sw = (inner - (cols - 1) * gap) / cols;
    const sh = sw * 0.62;
    pal.forEach((p, i) => {
      const x = pad + (i % cols) * (sw + gap), yy = y + Math.floor(i / cols) * (sh + gap);
      const key = `pal:${p.hex}`;
      const on = m.color === p.hex;
      this.rr(x, yy, sw, sh, px('radius.lg') * S);
      c.fillStyle = p.hex;
      c.fill();
      c.lineWidth = (on || this.hover === key ? 3 : 1.5) * S;
      c.strokeStyle = on ? t('color.accent.default') : this.hover === key ? t('color.text.primary') : t('color.border.default');
      c.stroke();
      this.regions.push({ key, x, y: yy, w: sw, h: sh });
    });
    y += Math.ceil(pal.length / cols) * (sh + gap) + gap;
    // název barvy pod kurzorem (jinak zvolené)
    const hov = pal.find((p) => `pal:${p.hex}` === this.hover) || pal.find((p) => p.hex === m.color);
    c.font = font('typography.small', S);
    c.fillStyle = t('color.text.secondary');
    c.fillText(hov ? hov.name : '', pad, y);
    y += 22 * S;
    const custom = m.custom && !pal.some((p) => p.hex === m.custom);
    if (custom) {
      this.button('pal:custom', 'Vlastní barva', pad, y, half, { active: m.color === m.custom });
      this.button('pal:orig', 'Původní z IFC', pad + half + gap, y, half, { active: m.color == null });
    } else this.button('pal:orig', 'Původní barvy z IFC', pad, y, inner, { active: m.color == null });
    y += bh + gap;
    this.button('pal:close', 'Zpět na seznam modelů', pad, Math.min(y + gap, bottom - bh), inner);
  }

  /** Seznam načtených modelů: zapnout/vypnout, barva, odebrat; dole přidání dalšího souboru. */
  drawModels(y, bottom, opts) {
    const { pad, gap, inner, bh } = opts;
    const c = this.ctx;
    const st = this.state;
    const pm = st.colorFor != null && st.models.find((x) => x.id === st.colorFor);
    if (pm) { this.drawPalette(y, bottom, pm, opts); return; }
    const box = px('size.check') * S;
    const delW = inner * 0.18;
    // šířka názvu a počet řádků: dlouhé názvy souborů až na tři řádky (výška řádku podle nejdelšího)
    const lineH = 17 * S;
    const baseH = px('size.table.row-height') * S * 1.15;
    const nameW = inner - delW - baseH - gap * 2 - (gap + box + gap) - gap;
    c.font = font('typography.table-cell', S);
    const maxLines = Math.max(1, ...st.models.map((m) => this.breakName(m.name, nameW, 3).length));
    const rowH = Math.max(baseH, maxLines * lineH + 14 * S);
    let addY = bottom - bh;
    this.button('add', 'Přidat soubor (ukončí VR)', pad, addY, inner);
    // skryté prvky: tlačítko nad přidáním souboru
    if (st.hidden) {
      addY -= bh + gap;
      this.button('unhide', `Zobrazit skryté prvky (${st.hidden})`, pad, addY, inner, { primary: true });
    }
    const navH = bh + gap;
    let perPage = Math.max(1, Math.floor((addY - gap - y) / rowH));
    if (st.models.length > perPage) perPage = Math.max(1, Math.floor((addY - gap - navH - y) / rowH));
    const pages = Math.max(1, Math.ceil(st.models.length / perPage));
    st.mpage = Math.min(st.mpage, pages - 1);
    if (!st.models.length) {
      c.font = font('typography.body', S);
      c.fillStyle = t('color.text.secondary');
      c.fillText('Žádný model není načtený.', pad, y + 4 * S, inner);
    }
    const sw = baseH * 0.5;
    const bhh = (px('size.button.padding-y') * 2 + 18) * S;
    for (const m of st.models.slice(st.mpage * perPage, (st.mpage + 1) * perPage)) {
      const cy = y + rowH / 2;
      c.strokeStyle = t('color.list.separator');
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(pad, y + rowH); c.lineTo(pad + inner, y + rowH); c.stroke();

      // zapnout / vypnout (checkbox + název)
      const visKey = `vis:${m.id}`;
      const visW = inner - delW - baseH - gap * 2;
      if (this.hover === visKey) { c.fillStyle = t('color.list.hover'); c.fillRect(pad, y, visW, rowH); }
      const bx = pad + gap;
      this.rr(bx, cy - box / 2, box, box, px('radius.sm') * S);
      if (m.visible) {
        c.fillStyle = t('color.accent.default'); c.fill();
        c.strokeStyle = t('color.text.primary'); c.lineWidth = 1.8 * S;
        c.beginPath();
        c.moveTo(bx + box * 0.25, cy); c.lineTo(bx + box * 0.43, cy + box * 0.18); c.lineTo(bx + box * 0.76, cy - box * 0.2);
        c.stroke();
      } else {
        c.strokeStyle = t('color.text.accent'); c.lineWidth = 1.5 * S; c.stroke();
      }
      c.font = font('typography.table-cell', S);
      c.textBaseline = 'middle';
      c.fillStyle = m.visible ? t('color.text.primary') : t('color.text.secondary');
      const nx = bx + box + gap;
      const lines = this.breakName(m.name, nameW, 3);
      lines.forEach((ln, i) => c.fillText(ln, nx, cy + (i - (lines.length - 1) / 2) * lineH));
      this.regions.push({ key: visKey, x: pad, y, w: visW, h: rowH });

      // barva (kolečko; prázdné = původní barvy z IFC)
      const colKey = `col:${m.id}`;
      const sx = pad + visW + gap;
      if (this.hover === colKey) { c.fillStyle = t('color.list.hover'); c.fillRect(sx, y, baseH, rowH); }
      c.beginPath(); c.arc(sx + baseH / 2, cy, sw / 2, 0, Math.PI * 2);
      if (m.color) { c.fillStyle = m.color; c.fill(); }
      c.strokeStyle = t('color.border.default'); c.lineWidth = 1.5 * S; c.stroke();
      if (!m.color) {
        c.font = font('typography.caption', S * 0.8);
        c.fillStyle = t('color.text.secondary');
        c.textAlign = 'center';
        c.fillText('IFC', sx + baseH / 2, cy);
        c.textAlign = 'left';
      }
      this.regions.push({ key: colKey, x: sx, y, w: baseH, h: rowH });

      // odebrat
      this.button(`del:${m.id}`, 'Odebrat', pad + inner - delW, cy - bhh / 2, delW);
      y += rowH;
    }
    if (pages > 1) this.pager(addY - gap - bh, st.mpage, pages, { pad, gap, inner, bh });
  }

  pager(ny, page, pages, { pad, gap, inner, bh }) {
    const c = this.ctx;
    const bw = (inner - 2 * gap) / 3;
    this.button('prev', 'Předchozí', pad, ny, bw, { disabled: page === 0 });
    c.font = font('typography.body', S);
    c.fillStyle = t('color.text.secondary');
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(`${page + 1} / ${pages}`, pad + bw * 1.5 + gap, ny + bh / 2);
    c.textAlign = 'left';
    this.button('next', 'Další', pad + 2 * (bw + gap), ny, bw, { disabled: page >= pages - 1 });
  }

  draw() {
    const c = this.ctx;
    const st = this.state;
    this.regions = [];
    const pad = px('space.20') * S;
    const gap = px('space.10') * S;
    const inner = W - 2 * pad;
    c.clearRect(0, 0, W, H);

    // rám karty
    this.rr(0, 0, W, H, px('radius.xl') * S);
    c.fillStyle = t('color.bg.window');
    c.fill();
    c.lineWidth = 2;
    c.strokeStyle = t('color.border.default');
    c.stroke();

    // záhlaví
    const headH = px('size.titlebar.height') * S;
    c.save();
    this.rr(0, 0, W, headH, [px('radius.xl') * S, px('radius.xl') * S, 0, 0]);
    c.fillStyle = t('color.bg.chrome');
    c.fill();
    c.restore();
    c.textBaseline = 'middle';
    c.font = font('typography.subtitle', S * 1.1);
    c.fillStyle = t('color.text.accent');
    c.fillText('ifc', pad, headH / 2);
    const wIfc = c.measureText('ifc').width;
    c.fillStyle = t('color.text.primary');
    c.fillText('.vr', pad + wIfc, headH / 2);
    c.font = font('typography.caption-bar', S);
    c.fillStyle = t('color.text.secondary');
    const x0 = pad + wIfc + c.measureText('.vr').width + gap * 2;
    c.fillText(this.ellipsizeMiddle(st.modelName || 'Žádný model', W - x0 - pad - FPS_W), x0, headH / 2);

    let y = headH + pad;

    // nahoře měřítko a pohled (v záložce Mapa ne – víc místa pro půdorys), pod nimi záložky
    const third = (inner - 2 * gap) / 3;
    const half = (inner - gap) / 2;
    const q4 = (inner - 3 * gap) / 4;
    const bh = (px('size.button.padding-y') * 2 + 18) * S;
    if (st.tab !== 'map') {
      y += this.sectionLabel('Měřítko', pad, y);
      this.button('mode-full', 'Skutečné 1:1', pad, y, half, { active: st.mode === 'full' });
      this.button('mode-mini', 'Maketa', pad + half + gap, y, half, { active: st.mode === 'mini' });
      y += bh + pad;

      y += this.sectionLabel('Pohled', pad, y);
      // v AR je místo mřížky skutečná podlaha (průhled kamer): tlačítko Mřížka chybí
      const view = [['reset', 'Na začátek'], ...(st.ar ? [] : [['grid', 'Mřížka', st.grid !== false]]), ['edges', 'Hrany', !!st.edges], ['exit', st.ar ? 'Ukončit AR' : 'Ukončit VR']];
      const vw = (inner - (view.length - 1) * gap) / view.length;
      view.forEach(([key, label, active], i) => this.button(key, label, pad + i * (vw + gap), y, vw, { active: !!active }));
      y += bh + pad;
    }
    // záložky (vybraný prvek má vlastní panel vpravo)
    const tw = (inner - (TABS.length - 1) * gap) / TABS.length;
    TABS.forEach(([key, label], i) => {
      const text = key === 'models' ? `${label} (${st.models.length})` : label;
      this.button(`tab-${key}`, text, pad + i * (tw + gap), y, tw, { active: st.tab === key });
    });
    y += bh + gap * 1.5;
    const footerH = HELP.length * 17 * S + pad * 1.4;
    const infoBottom = H - footerH - pad;
    c.textBaseline = 'top';
    const box = { pad, gap, inner, bh, half, third, q4 };
    if (st.tab === 'models') this.drawModels(y, infoBottom, box);
    else if (st.tab === 'map') this.drawMap(y, infoBottom, box);
    else if (st.tab === 'measure') this.drawMeasure(y, infoBottom, box);
    else if (st.tab === 'settings') this.drawSettings(y, box);

    // nápověda k ovládání
    let fy = H - footerH;
    c.fillStyle = t('color.bg.control');
    c.fillRect(0, fy, W, footerH - px('radius.xl') * S);
    this.rr(0, fy, W, footerH, [0, 0, px('radius.xl') * S, px('radius.xl') * S]);
    c.fill();
    fy += pad * 0.7;
    c.font = font('typography.small', S);
    c.textBaseline = 'top';
    const col = inner * 0.42;
    for (const [k, v] of HELP) {
      c.fillStyle = t('color.text.primary');
      c.fillText(k, pad, fy);
      c.fillStyle = t('color.text.secondary');
      c.fillText(v, pad + col, fy);
      fy += 17 * S;
    }

    this.texture.needsUpdate = true;
  }
}
