// Panel ve VR na levém ovladači: kreslí se do canvasu podle EBC_UI_vibe, ovládá se paprskem z pravého ovladače.
import * as THREE from 'three';
import { t, px, font } from './theme.js';
import { QUALITY } from './quality.js';
import { drawUser } from './map.js';
import { MOSES_RADII } from './moses.js';

const QUALITY_KEYS = Object.entries(QUALITY).map(([k, q]) => [k, q.label]);

const W = 1024;          // šířka canvasu v px
const H = 1700;          // výška canvasu v px
const S = 2.6;           // zvětšení tokenů (px EBC → px canvasu)
const WIDTH_M = 0.26;    // šířka panelu v metrech
const FPS_W = 330;       // šířka ukazatele snímků za sekundu v px canvasu

export const HELP = [
  ['Levá páčka', 'chůze'],
  ['Pravá páčka dopředu', 'teleport, do stran otočení'],
  ['A / B', 'nahoru / dolů'],
  ['Pravá spoušť', 'vybrat prvek, tlačítko panelu'],
  ['Spoušť znovu na dveře', 'otevřít / zavřít'],
  ['Úchop (maketa)', 'posunout, oběma rukama zvětšit'],
  ['X / Y', 'skrýt panel / přepnout měřítko'],
];

export class VRPanel {
  constructor() {
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
    this.regions = [];
    this.hover = null;
    this.state = { modelName: '', mode: 'full', info: null, page: 0, message: '', tab: 'info', models: [], mpage: 0 };
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
    if ('info' in patch) { this.state.page = 0; if (patch.info) this.state.tab = 'info'; }
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

  clearHover() { if (this.hover) { this.hover = null; this.draw(); } }

  click() {
    const r = this.regions.find((r) => r.key === this.hover);
    if (!r) return false;
    const pg = this.state.tab === 'models' ? 'mpage' : 'page';
    if (r.key === 'next') { this.state[pg]++; this.draw(); return true; }
    if (r.key === 'prev') { this.state[pg] = Math.max(0, this.state[pg] - 1); this.draw(); return true; }
    if (r.key === 'tab-info' || r.key === 'tab-models' || r.key === 'tab-map') { this.state.tab = r.key.slice(4); this.state.mapMsg = ''; this.onTab?.(this.state.tab); this.draw(); return true; }
    if (r.key.startsWith('lvl:')) { this.state.mapLevel = +r.key.slice(4); this.state.mapMsg = ''; this.draw(); return true; }
    if (r.key === 'map') {
      this.onMap?.(this.state.mapLevel ?? 0, (this.pointer.x - r.x) / r.w, (this.pointer.y - r.y) / r.h);
      return true;
    }
    if (r.key.startsWith('q:')) { this.onQuality?.(r.key.slice(2)); return true; }
    if (r.key.startsWith('moses:')) { this.onMoses?.(+r.key.slice(6)); return true; }
    if (r.key === 'edges') { this.onEdges?.(); return true; }
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
    y += Math.ceil(levels.length / perRow) * (bh + gap) + gap;
    // zpráva dole
    const msgH = 22 * S;
    const areaH = bottom - y - msgH;
    const plan = src.plan(levels[st.mapLevel]);
    const pw = plan.canvas.width, ph = plan.canvas.height;
    const k = Math.min(inner / pw, areaH / ph);
    const w = pw * k, h = ph * k, x = pad + (inner - w) / 2;
    c.drawImage(plan.canvas, x, y, w, h);
    c.strokeStyle = t('color.border.default');
    c.lineWidth = 1.5 * S;
    c.strokeRect(x, y, w, h);
    this.regions.push({ key: 'map', x, y, w, h, disabled: false });
    const me = src.user();
    if (me && me.u >= 0 && me.u <= 1 && me.v >= 0 && me.v <= 1) drawUser(c, x + me.u * w, y + me.v * h, me.dx, me.dy, 7 * S);
    c.font = font('typography.small', S);
    c.textBaseline = 'top';
    c.fillStyle = st.mapMsg ? t('color.text.error') : t('color.text.secondary');
    c.fillText(st.mapMsg || 'Namiřte do půdorysu a stiskněte spoušť: přesun na místo.', pad, y + h + 6 * S, inner);
  }

  /** Seznam načtených modelů: zapnout/vypnout, barva, odebrat; dole přidání dalšího souboru. */
  drawModels(y, bottom, { pad, gap, inner, bh }) {
    const c = this.ctx;
    const st = this.state;
    const rowH = px('size.table.row-height') * S * 1.15;
    const addY = bottom - bh;
    this.button('add', 'Přidat soubor (ukončí VR)', pad, addY, inner);
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
    const box = px('size.check') * S;
    const delW = inner * 0.24;
    const sw = rowH * 0.5;
    const bhh = (px('size.button.padding-y') * 2 + 18) * S;
    for (const m of st.models.slice(st.mpage * perPage, (st.mpage + 1) * perPage)) {
      const cy = y + rowH / 2;
      c.strokeStyle = t('color.list.separator');
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(pad, y + rowH); c.lineTo(pad + inner, y + rowH); c.stroke();

      // zapnout / vypnout (checkbox + název)
      const visKey = `vis:${m.id}`;
      const visW = inner - delW - rowH - gap * 2;
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
      c.fillText(this.ellipsize(m.name, visW - (nx - pad) - gap), nx, cy);
      this.regions.push({ key: visKey, x: pad, y, w: visW, h: rowH });

      // barva (kolečko; prázdné = původní barvy z IFC)
      const colKey = `col:${m.id}`;
      const sx = pad + visW + gap;
      if (this.hover === colKey) { c.fillStyle = t('color.list.hover'); c.fillRect(sx, y, rowH, rowH); }
      c.beginPath(); c.arc(sx + rowH / 2, cy, sw / 2, 0, Math.PI * 2);
      if (m.color) { c.fillStyle = m.color; c.fill(); }
      c.strokeStyle = t('color.border.default'); c.lineWidth = 1.5 * S; c.stroke();
      if (!m.color) {
        c.font = font('typography.caption', S * 0.8);
        c.fillStyle = t('color.text.secondary');
        c.textAlign = 'center';
        c.fillText('IFC', sx + rowH / 2, cy);
        c.textAlign = 'left';
      }
      this.regions.push({ key: colKey, x: sx, y, w: rowH, h: rowH });

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
    c.fillText(this.ellipsize(st.modelName || 'Žádný model', W - x0 - pad - FPS_W), x0, headH / 2);

    let y = headH + pad;

    // v záložce Mapa jen záložky a mapa (víc místa pro půdorys)
    const third = (inner - 2 * gap) / 3;
    const half = (inner - gap) / 2;
    const bh = (px('size.button.padding-y') * 2 + 18) * S;
    if (st.tab !== 'map') {
      // měřítko
      y += this.sectionLabel('Měřítko', pad, y);
      this.button('mode-full', 'Skutečné 1:1', pad, y, half, { active: st.mode === 'full' });
      this.button('mode-mini', 'Maketa', pad + half + gap, y, half, { active: st.mode === 'mini' });
      y += bh + pad;

      // akce
      y += this.sectionLabel('Pohled', pad, y);
      const q4 = (inner - 3 * gap) / 4;
      this.button('reset', 'Na začátek', pad, y, q4);
      this.button('grid', 'Mřížka', pad + q4 + gap, y, q4, { active: st.grid !== false });
      this.button('edges', 'Hrany', pad + 2 * (q4 + gap), y, q4, { active: !!st.edges });
      this.button('exit', 'Ukončit VR', pad + 3 * (q4 + gap), y, q4);
      y += bh + pad;

      // úroveň zobrazení (rozlišení se změní až po dalším vstupu do VR)
      y += this.sectionLabel('Zobrazení', pad, y);
      QUALITY_KEYS.forEach(([key, label], i) => {
        this.button(`q:${key}`, label, pad + i * (third + gap), y, third, { active: st.quality === key });
      });
      y += bh + pad;

      // Mojžíšův mód: model kolem uživatele ustoupí (poloměr výřezu)
      y += this.sectionLabel('Mojžíšův mód', pad, y);
      const quarter = (inner - (MOSES_RADII.length - 1) * gap) / MOSES_RADII.length;
      MOSES_RADII.forEach((r, i) => {
        this.button(`moses:${r}`, r ? `${r} m` : 'Vyp.', pad + i * (quarter + gap), y, quarter, { active: (st.moses || 0) === r });
      });
      y += bh + pad;
    }
    // záložky: vybraný prvek / modely / mapa
    this.button('tab-info', 'Vybraný prvek', pad, y, third, { active: st.tab === 'info' });
    this.button('tab-models', `Modely (${st.models.length})`, pad + third + gap, y, third, { active: st.tab === 'models' });
    this.button('tab-map', 'Mapa', pad + 2 * (third + gap), y, third, { active: st.tab === 'map' });
    y += bh + gap * 1.5;
    const footerH = HELP.length * 17 * S + pad * 1.4;
    const infoBottom = H - footerH - pad;
    c.textBaseline = 'top';
    const lineH = 20 * S;
    if (st.tab === 'models') {
      this.drawModels(y, infoBottom, { pad, gap, inner, bh });
    } else if (st.tab === 'map') {
      this.drawMap(y, infoBottom, { pad, gap, inner, bh });
    } else if (!st.info) {
      c.font = font('typography.body', S);
      c.fillStyle = t('color.text.secondary');
      c.fillText(st.message || 'Namiřte pravým ovladačem na prvek a stiskněte spoušť.', pad, y + 4 * S, inner);
    } else {
      const inf = st.info;
      c.font = font('typography.subtitle', S);
      c.fillStyle = t('color.text.primary');
      c.fillText(this.ellipsize(inf.name || inf.type, inner), pad, y);
      y += lineH;
      c.font = font('typography.small', S);
      c.fillStyle = t('color.text.secondary');
      const sub = [inf.type, inf.storey].filter(Boolean).join(' · ');
      c.fillText(this.ellipsize(sub, inner), pad, y);
      y += lineH * 1.1;

      // řádky vlastností (stránkované)
      const rows = [];
      if (inf.model) rows.push(['Model', inf.model, false]);
      if (inf.objectType) rows.push(['Typ objektu', inf.objectType, false]);
      if (inf.globalId) rows.push(['GlobalId', inf.globalId, false]);
      for (const s of inf.sets) {
        rows.push([s.name, '', true]);
        for (const [k, v] of s.props) rows.push([k, v, false]);
      }
      const rowH = px('size.table.row-height') * S * 0.85;
      const navH = bh + gap;
      const perPage = Math.max(1, Math.floor((infoBottom - y - navH) / rowH));
      const pages = Math.max(1, Math.ceil(rows.length / perPage));
      st.page = Math.min(st.page, pages - 1);
      const slice = rows.slice(st.page * perPage, (st.page + 1) * perPage);
      const colK = inner * 0.48;
      for (const [k, v, head] of slice) {
        c.strokeStyle = t('color.list.separator');
        c.lineWidth = 1;
        c.beginPath(); c.moveTo(pad, y + rowH); c.lineTo(pad + inner, y + rowH); c.stroke();
        c.textBaseline = 'middle';
        if (head) {
          c.font = font('typography.table-header', S);
          c.fillStyle = t('color.text.accent');
          c.fillText(this.ellipsize(k, inner), pad, y + rowH / 2);
        } else {
          c.font = font('typography.table-cell', S);
          c.fillStyle = t('color.text.secondary');
          c.fillText(this.ellipsize(k, colK - gap), pad, y + rowH / 2);
          c.fillStyle = t('color.text.primary');
          c.fillText(this.ellipsize(v, inner - colK), pad + colK, y + rowH / 2);
        }
        y += rowH;
      }
      if (pages > 1) this.pager(infoBottom - bh, st.page, pages, { pad, gap, inner, bh });
    }

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
