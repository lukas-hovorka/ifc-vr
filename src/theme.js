// Hodnoty z EBC_UI_vibe (dist/json/ebc-tokens.dark.json, zkopírováno – needitovat).
// Pro 3D scénu a panel ve VR, kde nejde použít CSS proměnné.
import tokens from './ebc/ebc-tokens.dark.json';

export const EBC_VERSION = (tokens.$description.match(/\d+\.\d+\.\d+/) || ['?'])[0];

/** Hodnota tokenu, např. t('color.accent.default'). */
export function t(key) {
  const v = tokens[key];
  if (v === undefined) throw new Error(`Chybí token ${key}`);
  return v;
}

/** Číselná hodnota tokenu v px ('space.16' → 16). */
export const px = (key) => parseFloat(t(key));

/** Písmo pro canvas z tokenu typografie, zvětšené koeficientem (panel ve VR se kreslí ve vyšším rozlišení). */
export function font(key, scale = 1) {
  return t(key).replace(/(\d+(?:\.\d+)?)px/, (_, n) => `${parseFloat(n) * scale}px`);
}
