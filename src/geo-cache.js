// Mezipaměť zpracované geometrie v IndexedDB (běží ve workeru). Druhé otevření stejného souboru
// přeskočí výpočet geometrie z IFC (u velkých modelů minuta i víc) a vezme hotové pole vrcholů,
// indexů a stromu pro výběr. Záznam platí pro název + velikost + datum změny souboru a verzi
// zpracování; při změně výpočtu geometrie se zvedne VERSION a staré záznamy se nepoužijí.

const VERSION = 1;
const DB = 'ifc-vr-geometrie';
/** Mezipaměť nesmí zabrat víc než tolik z místa, které prohlížeč stránce dovolí. */
const SHARE = 0.5;
/** …a nikdy víc než tolik bajtů (brýle mají málo místa). */
const MAX_BYTES = 6 * 2 ** 30;

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('data');           // klíč → { meta, buckets }
        r.result.createObjectStore('index');          // klíč → { bytes, usedAt, name }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const done = (tx) => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
const fullKey = (key) => `v${VERSION}|${key}`;

/** Uložená geometrie, nebo null. */
export async function cacheGet(key) {
  if (!key) return null;
  try {
    const d = await db();
    const k = fullKey(key);
    const tx = d.transaction(['data', 'index'], 'readwrite');
    const rec = await req(tx.objectStore('data').get(k));
    const idx = await req(tx.objectStore('index').get(k));
    if (rec && idx) tx.objectStore('index').put({ ...idx, usedAt: Date.now() }, k);
    await done(tx);
    return rec || null;
  } catch (e) {
    console.warn('Mezipaměť nejde číst', e);
    return null;
  }
}

/**
 * Uloží geometrii. Až se slib splní, jsou pole zkopírovaná (structured clone při put) a volající je
 * smí předat hlavnímu vláknu (transfer) – dřív ne, jinak by se zapisovala prázdná pole.
 * Splní se objektem { done }: slib dokončení zápisu na disk.
 */
export function cachePut(key, name, record) {
  if (!key) return Promise.resolve({ done: Promise.resolve() });
  let bytes = 0;
  for (const b of record.buckets) {
    bytes += b.position.byteLength + b.normal.byteLength + b.index.byteLength + b.ranges.byteLength;
    if (b.bvh) bytes += b.bvh.roots.reduce((s, r) => s + r.byteLength, 0) + (b.bvh.indirectBuffer?.byteLength || 0);
  }
  return db().then(async (d) => {
    const k = fullKey(key);
    await trim(d, bytes);
    const tx = d.transaction(['data', 'index'], 'readwrite');
    tx.objectStore('data').put(record, k);
    tx.objectStore('index').put({ bytes, usedAt: Date.now(), name }, k);
    return { done: done(tx).catch((e) => console.warn('Mezipaměť nejde zapsat (málo místa?)', e)) };
  }).catch((e) => { console.warn('Mezipaměť nejde zapsat', e); return { done: Promise.resolve() }; });
}

/** Uvolní místo pro další záznam: nejdéle nepoužité záznamy a záznamy starší verze. */
async function trim(d, incoming) {
  let limit = MAX_BYTES;
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) limit = Math.min(limit, est.quota * SHARE);
  } catch { /* odhad místa není k dispozici */ }
  const tx = d.transaction(['data', 'index'], 'readwrite');
  const index = tx.objectStore('index');
  const keys = await req(index.getAllKeys());
  const vals = await req(index.getAll());
  const prefix = `v${VERSION}|`;
  const list = keys.map((k, i) => ({ k, ...vals[i] }));
  for (const e of list) if (!e.k.startsWith(prefix)) { index.delete(e.k); tx.objectStore('data').delete(e.k); }
  const current = list.filter((e) => e.k.startsWith(prefix)).sort((a, b) => a.usedAt - b.usedAt);
  let total = current.reduce((s, e) => s + e.bytes, 0);
  while (current.length && total + incoming > limit) {
    const e = current.shift();
    index.delete(e.k);
    tx.objectStore('data').delete(e.k);
    total -= e.bytes;
  }
  await done(tx);
}

/** Počet záznamů a jejich velikost v bajtech. */
export async function cacheInfo() {
  try {
    const d = await db();
    const tx = d.transaction('index', 'readonly');
    const vals = await req(tx.objectStore('index').getAll());
    return { count: vals.length, bytes: vals.reduce((s, v) => s + (v.bytes || 0), 0) };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

export async function cacheClear() {
  const d = await db();
  const tx = d.transaction(['data', 'index'], 'readwrite');
  tx.objectStore('data').clear();
  tx.objectStore('index').clear();
  await done(tx);
}
