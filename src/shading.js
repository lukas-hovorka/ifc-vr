// Vzhled modelu počítaný jednou při načtení (ve workeru, výsledek jde do mezipaměti):
// - zastínění koutů (ambient occlusion): prostor kolem modelu se rozdělí na kostky a u kostek
//   u ploch se zjistí, jak moc je okolí zakryté (kouty, spoje zdí s podlahou a stropem, prostor pod
//   stolem). Grafická karta pak u každého bodu plochy přečte hodnotu z kostky před ním (prostorová
//   textura) a bod úměrně ztmaví: geometrie se nemění, při kreslení to stojí jedno čtení textury;
// - obrysové hrany: hrany, kde se plochy lámou (zdi, desky, nábytek), bez úhlopříček rovných ploch.

/** Plochy svírající úhel větší než tolik stupňů mají obrysovou hranu. */
const EDGE_ANGLE = 35;
/** Velikost kostky zastínění (m). */
const AO_CELL = 0.2;
/** Nejvýš tolik kostek (1 bajt na kostku): u velkých areálů jsou kostky větší. */
const MAX_CELLS = 16e6;
/** Dosah zastínění (m): zakrytí dál než tolik metrů se nepočítá. */
const AO_RADIUS = 1.0;
/** Paprsků z každé kostky (rovnoměrně do všech stran). */
const AO_RAYS = 16;
/** Kostka s plochou: průměr jen ze sousedů nejvýš o tolik (z 255) tmavších než nejsvětlejší soused. */
const NEIGHBOUR_SPREAD = 64;
/** Volná kostka s takovým zakrytím je uzavřená mezi plochami (uvnitř zdi), ne kout v prostoru. */
const ENCLOSED = 0.8;

/**
 * Obrysové hrany dílu (P = polohy, I = indexy): hrany, kde svírají sousední plochy úhel nad EDGE_ANGLE,
 * a okraje otevřených ploch. Vrcholy se slučují podle polohy (web-ifc má vrcholy po plochách).
 * Úsečky se přidají do out (Grow s Float32Array, 6 čísel na úsečku).
 */
export function featureEdges(P, I, out) {
  const weld = new Map();
  const ids = new Int32Array(P.length / 3);
  for (let v = 0; v < ids.length; v++) {
    const key = `${Math.round(P[v * 3] * 2000)},${Math.round(P[v * 3 + 1] * 2000)},${Math.round(P[v * 3 + 2] * 2000)}`;
    let w = weld.get(key);
    if (w === undefined) { w = v; weld.set(key, w); }
    ids[v] = w;
  }
  const cos = Math.cos((EDGE_ANGLE * Math.PI) / 180);
  /** hrana → [normála první plochy x, y, z, počet, ostrá] */
  const edges = new Map();
  const nTri = I.length / 3;
  const v = (k, i) => P[ids[I[k]] * 3 + i];
  for (let t = 0; t < nTri; t++) {
    const k = t * 3;
    const ax = v(k, 0), ay = v(k, 1), az = v(k, 2);
    const ux = v(k + 1, 0) - ax, uy = v(k + 1, 1) - ay, uz = v(k + 1, 2) - az;
    const wx = v(k + 2, 0) - ax, wy = v(k + 2, 1) - ay, wz = v(k + 2, 2) - az;
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue; // zdegenerovaný trojúhelník
    nx /= l; ny /= l; nz /= l;
    for (let e = 0; e < 3; e++) {
      const a = ids[I[k + e]], b = ids[I[k + (e + 1) % 3]];
      if (a === b) continue;
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      const prev = edges.get(key);
      if (!prev) edges.set(key, [nx, ny, nz, 1, false]);
      else {
        prev[3]++;
        if (prev[0] * nx + prev[1] * ny + prev[2] * nz < cos) prev[4] = true;
      }
    }
  }
  for (const [key, e] of edges) {
    if (e[3] > 1 && !e[4]) continue;
    const a = Math.floor(key / 4294967296), b = key - a * 4294967296;
    out.reserve(6);
    const A = out.a, o = out.n;
    A[o] = P[a * 3]; A[o + 1] = P[a * 3 + 1]; A[o + 2] = P[a * 3 + 2];
    A[o + 3] = P[b * 3]; A[o + 4] = P[b * 3 + 1]; A[o + 5] = P[b * 3 + 2];
    out.n += 6;
  }
}

/** Směry paprsků rovnoměrně po kouli (Fibonacciho spirála). */
const DIRS = (() => {
  const out = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < AO_RAYS; i++) {
    const y = 1 - ((i + 0.5) / AO_RAYS) * 2, r = Math.sqrt(1 - y * y), phi = i * golden;
    out.push([r * Math.cos(phi), y, r * Math.sin(phi)]);
  }
  return out;
})();

/**
 * Zastínění koutů jako prostorová mřížka (buckets: { position, index, color }; zakrývají jen
 * neprůhledné plochy). Vrátí { data (Uint8Array, 0 = volno, 255 = zcela zakryto), dims [nx, ny, nz],
 * origin [x, y, z] (roh mřížky), cell (m) }, nebo null bez neprůhledných ploch.
 * Pořadí v data: x nejrychleji, pak y, pak z (jako prostorová textura).
 */
export function aoVolume(buckets, onProgress) {
  const opaque = buckets.filter((b) => b.color[3] >= 0.99 && b.index.length);
  if (!opaque.length) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const b of opaque) {
    const P = b.position;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
  }
  const cs = Math.max(AO_CELL, Math.cbrt(((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1)) / MAX_CELLS));
  // okraj dvě kostky (plocha na kraji modelu má kostku před sebou)
  x0 -= cs * 2; y0 -= cs * 2; z0 -= cs * 2;
  const nx = Math.ceil((x1 - x0) / cs) + 3, ny = Math.ceil((y1 - y0) / cs) + 3, nz = Math.ceil((z1 - z0) / cs) + 3;
  const nxy = nx * ny, N = nxy * nz;
  const inv = 1 / cs;
  const cellOf = (x, y, z) => (Math.floor((z - z0) * inv) * ny + Math.floor((y - y0) * inv)) * nx + Math.floor((x - x0) * inv);

  // 1) kostky, kterými prochází plocha: trojúhelník se projde mřížkou bodů v jeho rovině (krok půl kostky)
  const solid = new Uint8Array(N);
  const h = cs * 0.5;
  let doneTris = 0;
  const allTris = opaque.reduce((s, b) => s + b.index.length / 3, 0) || 1;
  for (const b of opaque) {
    const P = b.position, I = b.index;
    for (let t = 0; t < I.length; t += 3) {
      let a = I[t] * 3, bb = I[t + 1] * 3, c = I[t + 2] * 3;
      const l0 = (P[bb] - P[a]) ** 2 + (P[bb + 1] - P[a + 1]) ** 2 + (P[bb + 2] - P[a + 2]) ** 2;
      const l1 = (P[c] - P[bb]) ** 2 + (P[c + 1] - P[bb + 1]) ** 2 + (P[c + 2] - P[bb + 2]) ** 2;
      const l2 = (P[a] - P[c]) ** 2 + (P[a + 1] - P[c + 1]) ** 2 + (P[a + 2] - P[c + 2]) ** 2;
      // nejdelší hrana jako (a, b): bodů je pak podle plochy trojúhelníku, ne podle délky hran
      if (l1 >= l0 && l1 >= l2) [a, bb, c] = [bb, c, a];
      else if (l2 >= l0 && l2 >= l1) [a, bb, c] = [c, a, bb];
      const ax = P[a], ay = P[a + 1], az = P[a + 2];
      const ux = P[bb] - ax, uy = P[bb + 1] - ay, uz = P[bb + 2] - az;
      const L = Math.hypot(ux, uy, uz);
      if (L < h) { solid[cellOf(ax, ay, az)] = 1; solid[cellOf(P[c], P[c + 1], P[c + 2])] = 1; continue; }
      const e1x = ux / L, e1y = uy / L, e1z = uz / L;
      const wx = P[c] - ax, wy = P[c + 1] - ay, wz = P[c + 2] - az;
      const cu = wx * e1x + wy * e1y + wz * e1z;
      let e2x = wx - cu * e1x, e2y = wy - cu * e1y, e2z = wz - cu * e1z;
      const H = Math.hypot(e2x, e2y, e2z);
      if (H > 1e-9) { e2x /= H; e2y /= H; e2z /= H; }
      const nv = Math.ceil(H / h);
      for (let j = 0; j <= nv; j++) {
        const v = nv ? (H * j) / nv : 0, f = H > 1e-9 ? v / H : 0;
        const uL = cu * f, uR = L + (cu - L) * f;
        const nu = Math.ceil(Math.abs(uR - uL) / h);
        for (let k = 0; k <= nu; k++) {
          const u = nu ? uL + ((uR - uL) * k) / nu : uL;
          solid[cellOf(ax + e1x * u + e2x * v, ay + e1y * u + e2y * v, az + e1z * u + e2z * v)] = 1;
        }
      }
    }
    doneTris += I.length / 3;
    onProgress?.(0.2 * (doneTris / allTris));
  }

  // 2) volné kostky u ploch (sousedí s plochou): z jejich středu paprsky do všech stran
  const data = new Uint8Array(N);
  const near = new Uint8Array(N);
  for (let z = 1; z < nz - 1; z++) {
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1, i = (z * ny + y) * nx + 1; x < nx - 1; x++, i++) {
        if (!solid[i]) continue;
        for (let dz = -nxy; dz <= nxy; dz += nxy) {
          for (let dy = -nx; dy <= nx; dy += nx) {
            near[i + dz + dy - 1] = 1; near[i + dz + dy] = 1; near[i + dz + dy + 1] = 1;
          }
        }
      }
    }
  }
  const step = cs * 0.5;
  const steps = Math.ceil(AO_RADIUS / step);
  const isSolid = (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return false;
    return solid[(iz * ny + iy) * nx + ix] === 1;
  };
  const stepCells = step * inv;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0, i = (z * ny + y) * nx; x < nx; x++, i++) {
        if (!near[i] || solid[i]) continue;
        // v jednotkách kostek: střed kostky je (x + 0,5, …)
        const ox = x + 0.5, oy = y + 0.5, oz = z + 0.5;
        let occ = 0;
        for (const [dx, dy, dz] of DIRS) {
          for (let s = 1; s <= steps; s++) {
            const t = s * stepCells;
            if (isSolid(ox + dx * t, oy + dy * t, oz + dz * t)) { occ += 1 - (s * step) / AO_RADIUS; break; }
          }
        }
        data[i] = Math.round((occ / AO_RAYS) * 255);
      }
    }
    if ((z & 7) === 0) onProgress?.(0.2 + 0.75 * (z / nz));
  }

  // 3) kostky s plochou dostanou průměr volných sousedů: textura se čte s plynulým přechodem mezi
  // sousedními kostkami a hodnota „uvnitř zdi“ by jinak ztmavila nebo zesvětlila okraj plochy.
  // Do průměru jen sousedé nejvýš o NEIGHBOUR_SPREAD tmavší než nejsvětlejší soused: volné kostky uvnitř
  // silné zdi (uzavřené, skoro černé) a kout z druhé strany tenké příčky by jinak prosvítaly na plochu.
  // Volné kostky uzavřené mezi plochami (uvnitř silné zdi nebo desky) se berou jako plné: jsou skoro
  // černé a textura by je jinak přimíchala do bodů u spoje (podlaha u zdi).
  const enclosedAt = Math.round(ENCLOSED * 255);
  for (let i = 0; i < N; i++) if (!solid[i] && near[i] && data[i] >= enclosedAt) solid[i] = 2;
  const pick = [];
  for (let z = 1; z < nz - 1; z++) {
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1, i = (z * ny + y) * nx + 1; x < nx - 1; x++, i++) {
        if (!solid[i]) continue;
        pick.length = 0;
        let lo = 255;
        for (let dz = -nxy; dz <= nxy; dz += nxy) {
          for (let dy = -nx; dy <= nx; dy += nx) {
            for (let dx = -1; dx <= 1; dx++) {
              const j = i + dz + dy + dx;
              if (!solid[j]) { pick.push(data[j]); if (data[j] < lo) lo = data[j]; }
            }
          }
        }
        let sum = 0, n = 0;
        for (const d of pick) if (d <= lo + NEIGHBOUR_SPREAD) { sum += d; n++; }
        data[i] = n ? Math.round(sum / n) : 0;
      }
    }
  }
  onProgress?.(1);
  return { data, dims: [nx, ny, nz], origin: [x0, y0, z0], cell: cs };
}
