// Úrovně zobrazení: Kvalita / Vyvážené / Výkon. Mění jen to, co je vidět (rozlišení, ostrost okrajů
// v brýlích, frekvence, rubové strany ploch, průhledné sklo). Úspory, které nejsou vidět (kreslení jen
// po změně, strom pro výběr ve workeru, mezipaměť geometrie…), platí ve všech úrovních.

export const QUALITY = {
  quality: {
    label: 'Kvalita',
    hint: 'Nejvyšší rozlišení, ostré i okraje zorného pole, viditelné i rubové strany ploch.',
    pixelRatio: 2,       // na počítači: násobek rozlišení displeje (strop)
    xrScale: 'native',   // v brýlích: plné rozlišení displeje Questu
    foveation: 0,        // 0 = okraje zorného pole v plném rozlišení
    fps: 90,
    doubleSide: true,    // kreslit i rubové strany (pohled zevnitř zdi, plochy s otočenou normálou)
    glass: true,         // průhledná okna a sklo
  },
  balanced: {
    label: 'Vyvážené',
    hint: 'Výchozí: dobrý obraz při plynulém pohybu i u velkých modelů.',
    pixelRatio: 1.5,
    xrScale: 1,
    foveation: 0.5,
    fps: 72,
    doubleSide: false,
    glass: true,
  },
  performance: {
    label: 'Výkon',
    hint: 'Pro velké modely: nižší rozlišení, rozmazanější okraje v brýlích, okna neprůhledná.',
    pixelRatio: 1,
    xrScale: 0.8,
    foveation: 1,
    fps: 72,
    doubleSide: false,
    glass: false,
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
