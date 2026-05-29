// 平面直角座標系（日本・JGD2011）。公図に記載の座標値・座標系番号から
// 縮尺校正・北方向・緯度経度を求めるためのユーティリティ。
// X = 北方向(縦), Y = 東方向(横)。

/** 各系の原点（緯度経度, 度） */
export const JPR_ORIGINS: Record<number, { latDeg: number; lonDeg: number; area: string }> = {
  1: { latDeg: 33, lonDeg: 129.5, area: "長崎・鹿児島の一部" },
  2: { latDeg: 33, lonDeg: 131.0, area: "福岡・佐賀・熊本・大分・宮崎・鹿児島" },
  3: { latDeg: 36, lonDeg: 132 + 10 / 60, area: "山口・島根・広島" },
  4: { latDeg: 33, lonDeg: 133.5, area: "香川・愛媛・徳島・高知" },
  5: { latDeg: 36, lonDeg: 134 + 20 / 60, area: "兵庫・鳥取・岡山" },
  6: { latDeg: 36, lonDeg: 136.0, area: "京都・大阪・福井・滋賀・三重・奈良・和歌山" },
  7: { latDeg: 36, lonDeg: 137 + 10 / 60, area: "石川・富山・岐阜・愛知" },
  8: { latDeg: 36, lonDeg: 138.5, area: "新潟・長野・山梨・静岡" },
  9: { latDeg: 36, lonDeg: 139 + 50 / 60, area: "東京・福島・栃木・茨城・埼玉・千葉・群馬・神奈川" },
  10: { latDeg: 40, lonDeg: 140 + 50 / 60, area: "青森・秋田・山形・岩手・宮城" },
  11: { latDeg: 44, lonDeg: 140 + 15 / 60, area: "北海道(西部)" },
  12: { latDeg: 44, lonDeg: 142 + 15 / 60, area: "北海道(中央部)" },
  13: { latDeg: 44, lonDeg: 144 + 15 / 60, area: "北海道(東部)" },
  14: { latDeg: 26, lonDeg: 142.0, area: "東京(小笠原)" },
  15: { latDeg: 26, lonDeg: 127.5, area: "沖縄本島" },
  16: { latDeg: 26, lonDeg: 124.0, area: "沖縄(先島)" },
  17: { latDeg: 26, lonDeg: 131.0, area: "沖縄(大東)" },
  18: { latDeg: 20, lonDeg: 136.0, area: "東京(沖ノ鳥島)" },
  19: { latDeg: 26, lonDeg: 154.0, area: "東京(南鳥島)" },
};

/**
 * 平面直角座標(X=北, Y=東, m) → 緯度経度(度)。
 * 太陽高度計算が目的のため、球面近似（平均半径）で十分な精度（誤差は系内で <0.05°）。
 * スケール係数 m0=0.9999 の影響(0.01%)は無視。
 */
export function planeToLatLon(
  zone: number,
  xNorth: number,
  yEast: number
): { lat: number; lon: number } {
  const o = JPR_ORIGINS[zone];
  if (!o) throw new Error(`座標系番号 ${zone} は範囲外です（1〜19）`);
  const R = 6371000; // 平均地球半径(m)
  const lat = o.latDeg + (xNorth / R) * (180 / Math.PI);
  const lon =
    o.lonDeg +
    (yEast / (R * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
  return { lat, lon };
}
