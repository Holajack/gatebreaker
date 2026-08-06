// CSS-sprite lookup for the packed item icon atlas.
//
// 107 source PNGs at 1000x1000 (31 MB) collapse to one 1408x1280 WebP (~310 KB)
// plus a JSON index, built by tools/pack-icons.mjs. The inventory and loot UI
// therefore cost exactly one image and one request, which matters more on
// Android than the byte count does.
//
// EVERY KEY IS LOWERCASE, on both sides of the lookup. The pack's icon
// filenames disagree with its model filenames by case only — Axe_Small.png vs
// Axe_small.fbx, Fishbone.png vs FishBone.fbx, Sword_Big.png vs Sword_big.fbx.
// macOS APFS is case-insensitive, so a naive lookup works flawlessly in
// development on the one Mac that has the pack and then silently returns
// nothing on-device. Normalising on both sides makes that class of bug
// unrepresentable rather than merely unlikely.

export const ATLAS_URL = 'models/icons.webp';

let _index = null;
let _loading = null;

const EMPTY = { cell: 128, cols: 1, rows: 1, width: 128, height: 128, icons: {} };

/**
 * Load the atlas index. Resolves TRUE on success, FALSE on any failure —
 * a missing atlas must degrade to grey placeholder cells, never to a thrown
 * error that takes the inventory screen down with it.
 */
export async function loadIconIndex(url = 'models/icons.json') {
  if (_index) return true;
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) return false;
      const data = await res.json();
      if (!data || typeof data.icons !== 'object') return false;
      // Defensive re-lowercasing: if someone regenerates the index with a
      // future tool that forgets, the runtime still cannot break.
      const icons = {};
      for (const [k, v] of Object.entries(data.icons)) icons[k.toLowerCase()] = v;
      _index = { ...EMPTY, ...data, icons };
      return true;
    } catch {
      return false;
    }
  })();
  return _loading;
}

export function hasIcon(name) {
  return Boolean(_index && name && _index.icons[String(name).toLowerCase()]);
}

function cellOf(name) {
  if (!_index || !name) return null;
  return _index.icons[String(name).toLowerCase()] || null;
}

/**
 * Inline style string positioning the atlas so `name`'s cell fills a
 * `size` x `size` box. An unknown name yields a neutral grey square: a missing
 * icon must be a grey square, never a broken layout.
 */
export function iconStyle(name, size = 48) {
  const cell = cellOf(name);
  const base = `width:${size}px;height:${size}px;display:inline-block;` +
    'background-repeat:no-repeat;border-radius:6px;';
  if (!cell) {
    return `${base}background-color:rgba(150,160,190,0.16);` +
      'box-shadow:inset 0 0 0 1px rgba(180,190,220,0.22);';
  }
  const k = size / _index.cell;
  const [col, row] = cell;
  return `${base}background-image:url(${ATLAS_URL});` +
    `background-size:${(_index.width * k).toFixed(2)}px ${(_index.height * k).toFixed(2)}px;` +
    `background-position:${(-col * size).toFixed(2)}px ${(-row * size).toFixed(2)}px;`;
}

export function iconEl(name, size = 48) {
  const el = document.createElement('span');
  el.className = 'itemIcon';
  el.setAttribute('style', iconStyle(name, size));
  el.title = name ? String(name).replace(/_/g, ' ') : '';
  return el;
}
