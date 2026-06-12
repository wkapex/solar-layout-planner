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

/** 多角形の周長（閉路・全辺の長さ合計） */
export function polygonPerimeter(poly: Vec2[]): number {
  if (poly.length < 2) return 0;
  let s = 0;
  for (let i = 0; i < poly.length; i++) s += len(sub(poly[(i + 1) % poly.length], poly[i]));
  return s;
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

/** 2直線（点＋方向ベクトル）の交点。平行ならnull。 */
function lineLineIntersect(p1: Vec2, d1: Vec2, p2: Vec2, d2: Vec2): Vec2 | null {
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / denom;
  return { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
}

/** 連続するほぼ重複頂点を除去し、始点≒終点の重複も畳む（オフセットの破綻防止） */
export function cleanPolygon(poly: Vec2[], eps = 1e-6): Vec2[] {
  const clean: Vec2[] = [];
  for (const p of poly) {
    const prev = clean[clean.length - 1];
    if (!prev || len(sub(p, prev)) > eps) clean.push(p);
  }
  while (clean.length >= 2 && len(sub(clean[0], clean[clean.length - 1])) <= eps) clean.pop();
  return clean;
}

/**
 * 多角形を内側へ d メートルだけオフセットした多角形を返す（凸〜単純な敷地向け）。
 * 各辺を内向き法線方向に d 平行移動し、隣り合う辺の交点を新頂点とする。
 * 退化辺・鋭角/凹角で交点が外側へ飛ぶ（スパイク化する）場合は法線二等分線へクランプし、
 * 元多角形の外へはみ出さないようにする。
 */
export function insetPolygon(poly: Vec2[], d: number): Vec2[] {
  const clean = cleanPolygon(poly);
  const n = clean.length;
  if (n < 3 || d <= 0) return clean.slice();
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = clean[i],
      b = clean[(i + 1) % n];
    area2 += a.x * b.y - b.x * a.y;
  }
  const ccw = area2 > 0; // 数学座標(y上)で正=反時計回り
  const lines: { p: Vec2; dir: Vec2; nrm: Vec2 }[] = [];
  for (let i = 0; i < n; i++) {
    const a = clean[i],
      b = clean[(i + 1) % n];
    const dir = normalize(sub(b, a));
    // 内向き法線（CCWなら進行方向の左が内側、CWなら右が内側）
    const nrm = ccw ? { x: -dir.y, y: dir.x } : { x: dir.y, y: -dir.x };
    lines.push({ p: add(a, scale(nrm, d)), dir, nrm });
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i - 1 + n) % n];
    const L2 = lines[i];
    const v = clean[i];
    let pt = lineLineIntersect(L1.p, L1.dir, L2.p, L2.dir);
    // 交点なし・遠すぎる(スパイク)・元多角形の外側 → 内向き二等分線でクランプ
    const bad = !pt || len(sub(pt, v)) > d * 6 || !pointInPolygon(pt, clean);
    if (bad) {
      const bis = normalize(add(L1.nrm, L2.nrm));
      pt = bis.x === 0 && bis.y === 0 ? add(v, scale(L2.nrm, d)) : add(v, scale(bis, d));
    }
    out.push(pt!);
  }
  return out;
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
