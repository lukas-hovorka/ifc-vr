// Panel vybraného prvku ve VR: samostatná karta vpravo vedle hlavního panelu (víc místa pro vlastnosti).
// Ukáže se po výběru prvku, zavře se tlačítkem Zrušit výběr. Kreslí se jako hlavní panel (EBC_UI_vibe).
import { t, px, font } from './theme.js';
import { VRPanel, PANEL } from './vr-panel.js';

const { W, H, S } = PANEL;

export class InfoPanel extends VRPanel {
  constructor() {
    super({ fps: false });
    this.mesh.name = 'vr-info';
    this.mesh.visible = false;
    this.state = { info: null, page: 0, door: null };
    /** zrušit výběr prvku */
    this.onDeselect = null;
    /** otevřít / zavřít vybrané dveře */
    this.onDoor = null;
    this.ready = true;
    this.draw();
  }

  /** info = vlastnosti prvku (null = nic vybráno, panel se skryje); door = null | 'open' | 'closed'. */
  set(patch) {
    if ('info' in patch) this.state.page = 0;
    Object.assign(this.state, patch);
    this.mesh.visible = !!this.state.info;
    this.draw();
  }

  click() {
    const r = this.regions.find((x) => x.key === this.hover);
    if (!r) return false;
    if (r.key === 'next') this.state.page++;
    else if (r.key === 'prev') this.state.page = Math.max(0, this.state.page - 1);
    else if (r.key === 'deselect') { this.onDeselect?.(); return true; }
    else if (r.key === 'door') { this.onDoor?.(); return true; }
    this.draw();
    return true;
  }

  draw() {
    if (!this.ready) return;
    const c = this.ctx;
    const st = this.state;
    this.regions = [];
    const pad = px('space.20') * S;
    const gap = px('space.10') * S;
    const inner = W - 2 * pad;
    const bh = (px('size.button.padding-y') * 2 + 18) * S;
    const half = (inner - gap) / 2;
    c.clearRect(0, 0, W, H);

    // rám karty a záhlaví
    this.rr(0, 0, W, H, px('radius.xl') * S);
    c.fillStyle = t('color.bg.window');
    c.fill();
    c.lineWidth = 2;
    c.strokeStyle = t('color.border.default');
    c.stroke();
    const headH = px('size.titlebar.height') * S;
    c.save();
    this.rr(0, 0, W, headH, [px('radius.xl') * S, px('radius.xl') * S, 0, 0]);
    c.fillStyle = t('color.bg.chrome');
    c.fill();
    c.restore();
    c.textBaseline = 'middle';
    c.font = font('typography.caption-bar', S);
    c.fillStyle = t('color.text.secondary');
    c.fillText('Vybraný prvek', pad, headH / 2);

    const inf = st.info;
    if (!inf) { this.texture.needsUpdate = true; return; }
    let y = headH + pad;
    const lineH = 20 * S;
    c.textBaseline = 'top';
    c.font = font('typography.subtitle', S);
    c.fillStyle = t('color.text.primary');
    c.fillText(this.ellipsize(inf.name || inf.type, inner), pad, y);
    y += lineH;
    c.font = font('typography.small', S);
    c.fillStyle = t('color.text.secondary');
    c.fillText(this.ellipsize([inf.type, inf.storey].filter(Boolean).join(' · '), inner), pad, y);
    y += lineH * 1.1;

    // tlačítka dole: dveře (u dveří s křídly) a zrušení výběru
    const btnY = H - pad - bh;
    if (st.door) {
      this.button('door', st.door === 'open' ? 'Zavřít dveře' : 'Otevřít dveře', pad, btnY, half);
      this.button('deselect', 'Zrušit výběr', pad + half + gap, btnY, half, { primary: true });
    } else this.button('deselect', 'Zrušit výběr', pad, btnY, inner, { primary: true });

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
    const bottom = btnY - gap;
    const navH = bh + gap;
    let perPage = Math.max(1, Math.floor((bottom - y) / rowH));
    if (rows.length > perPage) perPage = Math.max(1, Math.floor((bottom - y - navH) / rowH));
    const pages = Math.max(1, Math.ceil(rows.length / perPage));
    st.page = Math.min(st.page, pages - 1);
    const colK = inner * 0.42;
    for (const [k, v, head] of rows.slice(st.page * perPage, (st.page + 1) * perPage)) {
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
    if (pages > 1) this.pager(bottom - bh, st.page, pages, { pad, gap, inner, bh });
    this.texture.needsUpdate = true;
  }
}
