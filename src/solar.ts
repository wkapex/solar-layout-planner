// 太陽位置。suncalc を用いて冬至 10:00〜14:00(JST) の太陽高度・方位を求める。
// この時間帯で常に前後アレイへ影が落ちないピッチを後段(layout)で算出するための入力。
import SunCalc from "suncalc";

export interface SunPos {
  hourJst: number;
  /** 太陽高度（ラジアン, 地平線=0） */
  altitudeRad: number;
  /** 方位（度, 北=0 から時計回り。南=180, 西=270） */
  bearingDeg: number;
}

/** 対象年の冬至日（簡易に12/22固定。年により±1日ずれるが影計算への影響は無視できる） */
function winterSolsticeDate(year: number): { y: number; m: number; d: number } {
  return { y: year, m: 12, d: 22 };
}

/**
 * 冬至 10,11,12,13,14時(JST) の太陽位置を返す。地平線より上のものだけ。
 * JST = UTC+9（夏時間なし）。
 */
export function getWinterSunPositions(
  lat: number,
  lon: number,
  year = new Date().getFullYear()
): SunPos[] {
  const { y, m, d } = winterSolsticeDate(year);
  const hours = [10, 11, 12, 13, 14];
  const out: SunPos[] = [];
  for (const h of hours) {
    // h:00 JST を UTC に変換（-9時間）
    const date = new Date(Date.UTC(y, m - 1, d, h - 9, 0, 0));
    const pos = SunCalc.getPosition(date, lat, lon);
    if (pos.altitude <= 0.01) continue; // 地平線下は除外
    // suncalc: azimuth は南基準・西回りで正（南=0, 西=+π/2）
    const azFromSouthDeg = (pos.azimuth * 180) / Math.PI;
    const bearingDeg = (180 + azFromSouthDeg + 360) % 360;
    out.push({ hourJst: h, altitudeRad: pos.altitude, bearingDeg });
  }
  return out;
}
