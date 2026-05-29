// 縮尺校正：画像上の2点と実距離(m)から メートル/ピクセル を求める。
import { Vec2, len, sub } from "./geometry";

export function metersPerPixel(p1: Vec2, p2: Vec2, realMeters: number): number {
  const distPx = len(sub(p2, p1));
  if (distPx <= 0) throw new Error("2点が同一です");
  if (realMeters <= 0) throw new Error("実距離は正の値を入力してください");
  return realMeters / distPx;
}

/** 平面直角座標（公図）の基準点 */
export interface CoordRef {
  px: Vec2; // 画像ピクセル座標(x右,y下)
  xNorth: number; // X座標(北, m)
  yEast: number; // Y座標(東, m)
}

export interface CoordCalibResult {
  mPerPx: number;
  /** 北方向（画像上方向から時計回り, 度） */
  northAngleDeg: number;
}

/**
 * 公図の2基準点（画像px＋平面直角座標）から縮尺と北方向を同時に算出する。
 * 画像px(y下)を数学px(y上)に変換し、ワールド(東,北)との差分ベクトルを
 * 相似変換（回転＋等倍）で対応付ける。正しい縮尺の地図なら2点で一意。
 */
export function calibrateFromCoords(a: CoordRef, b: CoordRef): CoordCalibResult {
  // 数学px（y上）での差分
  const vPx = { x: b.px.x - a.px.x, y: -(b.px.y - a.px.y) };
  // ワールド差分（東=Y, 北=X）
  const vW = { x: b.yEast - a.yEast, y: b.xNorth - a.xNorth };
  const lenPx = len(vPx);
  const lenW = len(vW);
  if (lenPx <= 0) throw new Error("2基準点が同一です");
  if (lenW <= 0) throw new Error("2基準点の座標が同一です");
  const mPerPx = lenW / lenPx;
  // 回転θ = ワールド方位 − 数学px方位
  const theta =
    Math.atan2(vW.y, vW.x) - Math.atan2(vPx.y, vPx.x);
  let northAngleDeg = (theta * 180) / Math.PI;
  // -180..180 に正規化
  northAngleDeg = ((northAngleDeg + 540) % 360) - 180;
  return { mPerPx, northAngleDeg };
}
