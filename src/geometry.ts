// 2D 幾何ユーティリティ。
// 座標系は「数学座標（y が上方向・単位はメートル）」を基本とする。
// 画像ピクセル座標（y が下方向）との変換は呼び出し側で行う。

export interface Vec2 {
  x: number;
  y: number;
}

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);

/** 単位ベクトル化（長さ0なら(0,0)） */
export function normalize(a: Vec2): Vec2 {
  const l = len(a);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** 多角形面積（シューレース公式・絶対値） */
export function polygonArea(poly: Vec2[]): number {
  if (poly.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** 点が多角形の内部にあるか（レイキャスティング法） */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y;
    const xj = poly[j].x,
      yj = poly[j].y;
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 点から線分への最短距離 */
export function distPointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const t = ab.x === 0 && ab.y === 0 ? 0 : dot(sub(p, a), ab) / dot(ab, ab);
  const tc = Math.max(0, Math.min(1, t));
  const proj = add(a, scale(ab, tc));
  return len(sub(p, proj));
}

/** 点から多角形の境界（全辺）への最短距離 */
export function distPointToPolygonBoundary(p: Vec2, poly: Vec2[]): number {
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    min = Math.min(min, distPointToSegment(p, a, b));
  }
  return min;
}

/**
 * 矩形（4隅）が敷地多角形の内側にあり、かつ境界から離隔距離 setback 以上離れているか。
 * 凸〜単純な敷地を想定。4隅＋中心が内側、各隅と中心が境界から setback 以上離れていれば可とする。
 */
export function rectInsideWithSetback(
  corners: Vec2[],
  poly: Vec2[],
  setback: number
): boolean {
  const center: Vec2 = {
    x: (corners[0].x + corners[2].x) / 2,
    y: (corners[0].y + corners[2].y) / 2,
  };
  const pts = [...corners, center];
  for (const pt of pts) {
    if (!pointInPolygon(pt, poly)) return false;
    if (setback > 0 && distPointToPolygonBoundary(pt, poly) < setback)
      return false;
  }
  return true;
}

/** 多角形の各頂点を u 軸・v 軸へ射影した範囲を返す */
export function projectRange(
  poly: Vec2[],
  axis: Vec2
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const p of poly) {
    const d = dot(p, axis);
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { min, max };
}
