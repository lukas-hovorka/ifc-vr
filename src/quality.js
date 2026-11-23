// Úrovně zobrazení: Kvalita / Vyvážené / Výkon. Mění jen to, co je vidět (rozlišení, ostrost okrajů
// v brýlích, frekvence, rubové strany ploch, průhledné sklo). Úspory, které nejsou vidět (kreslení jen
// po změně, strom pro výběr ve workeru, mezipaměť geometrie…), platí ve všech úrovních.

export const QUALITY = {
  quality: {
    label: 'Kvalita',
    hint: 'Nejvyšší rozlišení a ostré i okraje zorného pole. Na Questu 3 doporučeno.',
    pixelRatio: 2,       // na počítači: násobek rozlišení displeje (strop)
    xrScale: 'native',   // v brýlích: plné rozlišení displeje Questu
    foveation: 0,        // 0 = okraje zorného pole v plném rozlišení
    fps: 90,
    doubleSide: true,    // kreslit i rubové strany (pohled zevnitř zdi, plochy s otočenou normálou)
    glass: true,         // průhledná okna a sklo
    ao: true,            // zastínění koutů
  },
  balanced: {
    label: 'Vyvážené',
    hint: 'Výchozí: dobrý obraz při plynulém pohybu i u velkých modelů.',
    pixelRatio: 1.5,
    xrScale: 1,
    foveation: 1,        // jako před úpravami výkonu (výchozí three.js): okraje, které čočky stejně rozmazávají
    fps: 72,             // výchozí frekvence prohlížeče na Questu 3 a 3S
    doubleSide: true,
    glass: true,
    ao: true,
  },
  performance: {
    label: 'Výkon',
    hint: 'Pro velké modely: nižší rozlišení, rozmazanější okraje v brýlích, okna neprůhledná, bez zastínění koutů.',
    pixelRatio: 1,
    xrScale: 0.8,
    foveation: 1,
    fps: 72,
    doubleSide: false,
    glass: false,
    ao: false,
  },
};

const KEY = 'ifcvr.quality';

export function loadQuality() {
  try { const q = localStorage.getItem(KEY); if (q in QUALITY) return q; } catch { /* bez úložiště */ }
  return 'balanced';
}

export function saveQuality(q) {
  try { localStorage.setItem(KEY, q); } catch { /* bez úložiště */ }
}

const EDGES_KEY = 'ifcvr.edges';

/** Obrysové hrany zapnuté (zapamatovaná volba, výchozí vypnuto). */
export function loadEdges() {
  try { return localStorage.getItem(EDGES_KEY) === '1'; } catch { return false; }
}

export function saveEdges(on) {
  try { localStorage.setItem(EDGES_KEY, on ? '1' : '0'); } catch { /* bez úložiště */ }
}

/** Zapamatovaná volba zapnuto / vypnuto (výchozí vypnuto), např. 'collide', 'gravity'. */
export function loadFlag(name) {
  try { return localStorage.getItem(`ifcvr.${name}`) === '1'; } catch { return false; }
}

export function saveFlag(name, on) {
  try { localStorage.setItem(`ifcvr.${name}`, on ? '1' : '0'); } catch { /* bez úložiště */ }
}

const DOORS_KEY = 'ifcvr.autodoors';

/** Automatické otevírání dveří (zapamatovaná volba, výchozí vypnuto). */
export function loadAutoDoors() {
  try { return localStorage.getItem(DOORS_KEY) === '1'; } catch { return false; }
}

export function saveAutoDoors(on) {
  try { localStorage.setItem(DOORS_KEY, on ? '1' : '0'); } catch { /* bez úložiště */ }
}
