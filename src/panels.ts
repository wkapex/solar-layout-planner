// パネル仕様の手動入力と履歴（localStorage）。製品は年々変わるため固定プリセットは持たない。

export interface PanelSpec {
  maker: string;
  model: string;
  widthMm: number;
  heightMm: number;
  wattW: number;
}

const STORE_KEY = "solar-layout-panel-history";

/** 入力寸法から長辺/短辺(m)を導出（向き判定を入力順に依存させない） */
export function moduleDimsM(spec: PanelSpec): { longM: number; shortM: number } {
  const a = spec.widthMm / 1000;
  const b = spec.heightMm / 1000;
  return { longM: Math.max(a, b), shortM: Math.min(a, b) };
}

export function loadHistory(): PanelSpec[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as PanelSpec[]) : [];
  } catch {
    return [];
  }
}

export function saveToHistory(spec: PanelSpec): void {
  const key = (s: PanelSpec) => `${s.maker}|${s.model}|${s.widthMm}x${s.heightMm}`;
  const list = loadHistory().filter((s) => key(s) !== key(spec));
  list.unshift(spec);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 20)));
  } catch {
    /* localStorage 不可環境は無視 */
  }
}
