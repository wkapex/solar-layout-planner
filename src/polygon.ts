// 敷地多角形と座標変換。
// 画像ピクセル座標(x右,y下) と 数学メートル座標(x右,y上) を相互変換する。
import { Vec2, polygonArea } from "./geometry";

/** 画像px多角形 → 数学m多角形 */
export function imgToMeters(pts: Vec2[], mPerPx: number): Vec2[] {
  return pts.map((p) => ({ x: p.x * mPerPx, y: -p.y * mPerPx }));
}

/** 数学m点 → 画像px点 */
export function metersToImg(p: Vec2, mPerPx: number): Vec2 {
  return { x: p.x / mPerPx, y: -p.y / mPerPx };
}

/** 敷地面積(m²) */
export function polygonAreaM2(ptsPx: Vec2[], mPerPx: number): number {
  return polygonArea(ptsPx) * mPerPx * mPerPx;
}
