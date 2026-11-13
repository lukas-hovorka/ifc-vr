// Křídla dveří: z dílů geometrie jednoho IfcDoor (zárubeň, obložky, křídlo, kliky…) najde křídla,
// aby se v prohlížeči dala otočit kolem pantu. IFC křídlo jako samostatný prvek nemá (Revit exportuje
// dveře jako jeden prvek), proto se pozná podle tvaru:
//   křídlo = tenká deska (≤ 12 cm) přes většinu výšky dveří, užší než celé dveře (obložky jsou širší);
//   ke křídlu patří díly uvnitř jeho obrysu (klika, štítek, sklo, kopací plech);
//   pant je na straně proti klice, u dvoukřídlých dveří u kraje dveří.
// Souřadnice jsou souřadnice modelu (osa Y nahoru).

const MAX_LEAF_THICKNESS = 0.12;
const MIN_LEAF_HEIGHT = 1.0;
const ATTACH_DEPTH = 0.12; // klika přesahuje křídlo do stran
const HARDWARE_SIZE = 0.3;

/** Typy otevírání, u kterých se křídlo neotáčí kolem svislého pantu. */
export const NOT_SWINGING = /SLIDING|FOLDING|ROLLING|REVOLVING|LIFTING/i;

/**
 * parts: [{ pos: Float32Array (x,y,z…), alpha }] – díly jednoho prvku dveří, op = OperationType.
 * Vrátí null (křídlo nejde spolehlivě poznat), nebo { leaves: [{ parts: [indexy dílů], u, v, hinge, width }] }:
 * u = jednotkový vodorovný směr od pantu k volnému kraji, v = kolmo na křídlo, hinge = [x, z] pantu
 * ve středu tloušťky křídla, half = polovina tloušťky, y0 = spodek křídla.
 */
export function findLeaves(parts, op = '') {
  // vodorovné osy dveří: obdélník nejmenší plochy kolem všech vrcholů (půdorys), delší strana = šířka
  let best = null;
  for (let deg = 0; deg < 180; deg += 1) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of parts) {
      const P = p.pos;
      for (let i = 0; i < P.length; i += 3) {
        const u = P[i] * c + P[i + 2] * s, v = -P[i] * s + P[i + 2] * c;
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area - 1e-9) best = { area, c, s, w: u1 - u0, d: v1 - v0 };
  }
  if (!best) return null;
  // u = podél šířky dveří
  let ux = best.c, uz = best.s;
  if (best.d > best.w) { ux = -best.s; uz = best.c; }
  const vx = -uz, vz = ux;

  // obálky dílů v osách dveří (u, y, v)
  const boxes = parts.map((p) => {
    const b = { u0: Infinity, u1: -Infinity, y0: Infinity, y1: -Infinity, v0: Infinity, v1: -Infinity };
    const P = p.pos;
    for (let i = 0; i < P.length; i += 3) {
      const u = P[i] * ux + P[i + 2] * uz, v = P[i] * vx + P[i + 2] * vz, y = P[i + 1];
      if (u < b.u0) b.u0 = u; if (u > b.u1) b.u1 = u;
      if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
      if (v < b.v0) b.v0 = v; if (v > b.v1) b.v1 = v;
    }
    return b;
  });
  const all = boxes.reduce((a, b) => ({
    u0: Math.min(a.u0, b.u0), u1: Math.max(a.u1, b.u1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1),
  }), { u0: Infinity, u1: -Infinity, y0: Infinity, y1: -Infinity });
  const W = all.u1 - all.u0, H = all.y1 - all.y0;
  if (!(W > 0.3 && H > MIN_LEAF_HEIGHT)) return null;

  // kandidáti na desku křídla: tenké neprůhledné desky přes většinu výšky (sklo se přidá až jako díl uvnitř)
  const MIN_T = 0.035; // obložky zárubně bývají 2–3 cm, křídlo 4–11 cm
  const cand = [];
  boxes.forEach((b, i) => {
    const w = b.u1 - b.u0, h = b.y1 - b.y0, t = b.v1 - b.v0;
    if (parts[i].alpha < 0.99 || t < MIN_T || t > MAX_LEAF_THICKNESS || h < Math.max(MIN_LEAF_HEIGHT, 0.5 * H) || w < 0.25) return;
    cand.push({ ...b, w, i });
  });
  const within = (a, b) => a.u0 >= b.u0 - 0.02 && a.u1 <= b.u1 + 0.02;
  // deska, ve které leží jiná užší deska, je rám / zárubeň (obepíná křídla), ne křídlo
  const leafs = cand.filter((c) => !cand.some((o) => o !== c && o.w < c.w - 0.04 && within(o, c)));
  const groups = [];
  for (const c of leafs) {
    // stejně široké desky (dvě vrstvy jednoho křídla) patří k jednomu křídlu
    const g = groups.find((x) => Math.abs(x.u0 - c.u0) < 0.03 && Math.abs(x.u1 - c.u1) < 0.03);
    if (g) {
      g.parts.push(c.i);
      Object.assign(g, { y0: Math.min(g.y0, c.y0), y1: Math.max(g.y1, c.y1), v0: Math.min(g.v0, c.v0), v1: Math.max(g.v1, c.v1) });
    } else groups.push({ u0: c.u0, u1: c.u1, y0: c.y0, y1: c.y1, v0: c.v0, v1: c.v1, parts: [c.i], hw: [] });
  }
  if (!groups.length || groups.length > 2) return null;
  // dvě křídla se nesmí překrývat (např. kastlové dveře mají dvě řady křídel za sebou)
  if (groups.length === 2 && Math.min(groups[0].u1, groups[1].u1) - Math.max(groups[0].u0, groups[1].u0) > 0.02) return null;

  // ostatní díly uvnitř obrysu křídla (klika, štítek, sklo…) patří ke křídlu
  boxes.forEach((b, i) => {
    if (groups.some((g) => g.parts.includes(i))) return;
    const g = groups.find((x) => b.u0 >= x.u0 - 0.01 && b.u1 <= x.u1 + 0.01 && b.y0 >= x.y0 - 0.01
      && b.y1 <= x.y1 + 0.01 && b.v0 >= x.v0 - ATTACH_DEPTH && b.v1 <= x.v1 + ATTACH_DEPTH);
    if (!g) return;
    g.parts.push(i);
    if (Math.max(b.u1 - b.u0, b.y1 - b.y0) < HARDWARE_SIZE) g.hw.push((b.u0 + b.u1) / 2);
  });

  // jednokřídlé dveře se dvěma deskami (pevný boční díl příčky): otevírá se ta s klikou, jinak širší
  if (groups.length === 2 && /^SINGLE_SWING/i.test(op)) {
    const score = (g) => (g.hw.length ? 10 : 0) + (g.u1 - g.u0);
    groups.sort((a, b) => score(b) - score(a));
    groups.length = 1;
  }
  const mid = (all.u0 + all.u1) / 2;
  const leaves = groups.map((g) => {
    // pant: u dvoukřídlých dveří u kraje dveří, jinak na straně proti klice (bez kliky u kraje blíž zárubni)
    let hingeAtMin;
    if (groups.length === 2) hingeAtMin = (g.u0 + g.u1) / 2 < mid;
    else if (g.hw.length) hingeAtMin = g.hw.reduce((s, x) => s + x, 0) / g.hw.length > (g.u0 + g.u1) / 2;
    else hingeAtMin = g.u0 - all.u0 <= all.u1 - g.u1;
    const hu = hingeAtMin ? g.u0 : g.u1, sgn = hingeAtMin ? 1 : -1;
    const vc = (g.v0 + g.v1) / 2;
    return {
      parts: g.parts,
      u: [ux * sgn, uz * sgn],
      v: [vx, vz],
      hinge: [hu * ux + vc * vx, hu * uz + vc * vz],
      half: Math.max((g.v1 - g.v0) / 2, 0.01),
      width: g.u1 - g.u0,
    };
  });
  return { leaves };
}
