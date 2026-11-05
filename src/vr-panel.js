// Panel ve VR na levém ovladači: kreslí se do canvasu podle EBC_UI_vibe, ovládá se paprskem z pravého ovladače.
import * as THREE from 'three';
import { t, px, font } from './theme.js';

const W = 1024;          // šířka canvasu v px
const H = 1700;          // výška canvasu v px
const S = 2.6;           // zvětšení tokenů (px EBC → px canvasu)
const WIDTH_M = 0.26;    // šířka panelu v metrech

export const HELP = [
  ['Levá páčka', 'chůze'],
  ['Pravá páčka dopředu', 'teleport, do stran otočení'],
  ['A / B', 'nahoru / dolů'],
  ['Pravá spoušť', 'vybrat prvek, tlačítko panelu'],
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
    this.regions = [];
    this.hover = null;
    this.state = { modelName: '', mode: 'full', info: null, page: 0, message: '' };
    this.actions = {};
    this.draw();
  }

  set(patch) {
    Object.assign(this.state, patch);
    if ('info' in patch) this.state.page = 0;
    this.draw();
  }

  /** Souřadnice UV průsečíku → oblast tlačítka. */
  pointAt(uv) {
    const x = uv.x * W, y = (1 - uv.y) * H;
    const r = this.regions.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h && !r.disabled);
    const key = r ? r.key : null;
    if (key !== this.hover) { this.hover = key; this.draw(); }
    return r;
  }

  clearHover() { if (this.hover) { this.hover = null; this.draw(); } }

  click() {
    const r = this.regions.find((r) => r.key === this.hover);
    if (!r) return false;
    if (r.key === 'next') { this.state.page++; this.draw(); return true; }
    if (r.key === 'prev') { this.state.page = Math.max(0, this.state.page - 1); this.draw(); return true; }
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
    c.fillText(this.ellipsize(st.modelName || 'Žádný model', W - x0 - pad), x0, headH / 2);

    let y = headH + pad;

    // měřítko
    y += this.sectionLabel('Měřítko', pad, y);
    const half = (inner - gap) / 2;
    const bh = this.button('mode-full', 'Skutečné 1:1', pad, y, half, { active: st.mode === 'full' });
    this.button('mode-mini', 'Maketa', pad + half + gap, y, half, { active: st.mode === 'mini' });
    y += bh + pad;

    // akce
    y += this.sectionLabel('Pohled', pad, y);
    const third = (inner - 2 * gap) / 3;
    this.button('reset', 'Na začátek', pad, y, third);
    this.button('grid', 'Mřížka', pad + third + gap, y, third, { active: st.grid !== false });
    this.button('exit', 'Ukončit VR', pad + 2 * (third + gap), y, third);
    y += bh + pad;

    // vybraný prvek
    y += this.sectionLabel('Vybraný prvek', pad, y);
    const footerH = HELP.length * 17 * S + pad * 1.4;
    const infoBottom = H - footerH - pad;
    c.textBaseline = 'top';
    const lineH = 20 * S;
    if (!st.info) {
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
      if (pages > 1) {
        const ny = infoBottom - bh;
        const bw = (inner - 2 * gap) / 3;
        this.button('prev', 'Předchozí', pad, ny, bw, { disabled: st.page === 0 });
        c.font = font('typography.body', S);
        c.fillStyle = t('color.text.secondary');
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(`${st.page + 1} / ${pages}`, pad + bw * 1.5 + gap, ny + bh / 2);
        c.textAlign = 'left';
        this.button('next', 'Další', pad + 2 * (bw + gap), ny, bw, { disabled: st.page >= pages - 1 });
      }
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
