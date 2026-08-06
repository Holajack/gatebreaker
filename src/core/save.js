// Persistent hunter profile. Small enough for localStorage; survives app restarts.

const KEY = 'gatebreaker.save.v1';

export function freshSave() {
  return {
    level: 1,
    xp: 0,
    points: 0,
    stats: { str: 0, agi: 0, vit: 0, int: 0 },
    cleared: {},        // { E: bestTimeSeconds }
    shadows: 0,         // shadow soldiers retained between runs
    totalKills: 0,
    deaths: 0,
  };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return freshSave();
    const parsed = JSON.parse(raw);
    // Merge onto a fresh object so older saves gain new fields safely.
    const base = freshSave();
    return {
      ...base,
      ...parsed,
      stats: { ...base.stats, ...(parsed.stats || {}) },
      cleared: { ...(parsed.cleared || {}) },
    };
  } catch {
    return freshSave();
  }
}

export function save(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* storage full or blocked — the run still plays, it just won't persist */
  }
}

export function wipe() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
