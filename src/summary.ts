// 集計表示。配置結果から枚数/kW/列数別台数などのHTMLを生成する。
import type { LayoutResult } from "./layout";

function breakdownText(b: Record<number, number>): string {
  const keys = Object.keys(b)
    .map(Number)
    .sort((a, c) => c - a);
  if (keys.length === 0) return "—";
  return keys.map((c) => `${c}列×${b[c]}台`).join(" / ");
}

export function formatResultHtml(r: LayoutResult, areaM2: number): string {
  const patternName =
    r.pattern === "A"
      ? "パターンA（真南設置優先）"
      : r.pattern === "B"
        ? "パターンB（敷地なり最大枚数）"
        : r.mountType === "rack"
          ? "陸屋根（合掌・東西設置）"
          : "傾斜屋根（フラッシュ設置）";
  const azimuth =
    r.pattern === "B"
      ? `<div>設置角度（真南=0度）: <b>${r.azimuthOffsetLabel}</b></div>`
      : r.pattern === "A"
        ? `<div>設置角度（真南=0度）: <b>真南</b></div>`
        : "";
  const areaLabel = r.pattern === "ROOF" ? "屋根面積" : "敷地面積";
  const grid = r.arrays[0];
  const pitchLine =
    r.mountType === "rack"
      ? `<div>配置: 山型（合掌・東西）／山と山の離隔 ${(r.pitchM - r.groundDepthM).toFixed(3)} m・横列間ギャップで密配置（影離隔なし）。1山奥行 ${r.groundDepthM.toFixed(2)} m</div>`
      : r.mountType === "flush"
        ? `<div>配置: 横置き・均一グリッド（東西 ${grid ? grid.cols : 0} 列 × 南北 ${grid ? grid.rows : 0} 段＝矩形・影離隔なし）</div>`
        : `<div>前後ピッチ: ${r.pitchM.toFixed(2)} m（うち影離隔 ${r.requiredGapM.toFixed(2)} m / 奥行 ${r.groundDepthM.toFixed(2)} m）</div>`;
  return `
    <div class="result-card">
      <h3>${patternName}</h3>
      <div>設置容量: <b>${r.totalKw.toFixed(1)} kW</b></div>
      <div>パネル総枚数: <b>${r.totalPanels.toLocaleString()} 枚</b></div>
      <div>アレイ台数: ${r.arrays.length} 台（${breakdownText(r.colCountBreakdown)}）</div>
      <div>${areaLabel}: ${areaM2.toLocaleString(undefined, { maximumFractionDigits: 0 })} m²</div>
      ${pitchLine}
      ${azimuth}
    </div>`;
}
