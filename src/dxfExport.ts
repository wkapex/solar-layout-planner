// DXF(R12 ASCII) 書き出し。内部座標は数学m(y上=CAD慣習)だが、
// JWCAD 等が mm 単位で解釈するため、出力時に mm(×1000) へ変換して原寸表示にする。
import type { Vec2 } from "./geometry";
import type { LayoutResult } from "./layout";

const MM = 1000; // m → mm 変換係数

function line(buf: string[], layer: string, a: Vec2, b: Vec2) {
  buf.push(
    "0", "LINE",
    "8", layer,
    "10", (a.x * MM).toFixed(2), "20", (a.y * MM).toFixed(2), "30", "0.0",
    "11", (b.x * MM).toFixed(2), "21", (b.y * MM).toFixed(2), "31", "0.0"
  );
}

function text(buf: string[], layer: string, p: Vec2, h: number, s: string) {
  buf.push("0", "TEXT", "8", layer, "10", (p.x * MM).toFixed(2), "20", (p.y * MM).toFixed(2), "30", "0.0", "40", (h * MM).toFixed(2), "1", s);
}

function layerTable(buf: string[]) {
  buf.push("0", "TABLE", "2", "LAYER", "70", "3");
  const add = (name: string, color: number) =>
    buf.push("0", "LAYER", "2", name, "70", "0", "62", String(color), "6", "CONTINUOUS");
  add("SITE", 2); // 黄
  add("PANEL", 5); // 青
  add("NOTE", 1); // 赤
  buf.push("0", "ENDTAB");
}

export function buildDxf(
  siteM: Vec2[],
  result: LayoutResult,
  opts: { northAngleDeg: number }
): string {
  const buf: string[] = [];
  // 単位をミリメートルと宣言（$INSUNITS=4=mm, $MEASUREMENT=1=metric）
  buf.push(
    "0", "SECTION", "2", "HEADER",
    "9", "$INSUNITS", "70", "4",
    "9", "$MEASUREMENT", "70", "1",
    "0", "ENDSEC"
  );
  buf.push("0", "SECTION", "2", "TABLES");
  layerTable(buf);
  buf.push("0", "ENDSEC");
  buf.push("0", "SECTION", "2", "ENTITIES");

  // 敷地外形
  for (let i = 0; i < siteM.length; i++) {
    line(buf, "SITE", siteM[i], siteM[(i + 1) % siteM.length]);
  }

  // パネル（1枚ごとに4辺を罫線として出力）
  for (const arr of result.arrays) {
    for (const rect of arr.panelRects) {
      for (let i = 0; i < 4; i++) line(buf, "PANEL", rect[i], rect[(i + 1) % 4]);
    }
  }

  // バウンディングボックス（注記・方位マーク配置用）
  const xs = siteM.map((p) => p.x);
  const ys = siteM.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const diag = Math.hypot(maxX - minX, maxY - minY);
  const th = diag * 0.02; // テキスト高さ

  // 方位マーク（北矢印）
  const a = (opts.northAngleDeg * Math.PI) / 180;
  const nvec: Vec2 = { x: Math.sin(a), y: Math.cos(a) };
  const arrowStart: Vec2 = { x: minX, y: maxY + th * 2 };
  const arrowEnd: Vec2 = {
    x: arrowStart.x + nvec.x * diag * 0.1,
    y: arrowStart.y + nvec.y * diag * 0.1,
  };
  line(buf, "NOTE", arrowStart, arrowEnd);
  text(buf, "NOTE", { x: arrowEnd.x, y: arrowEnd.y }, th, "N");

  // 注記
  let ty = maxY + th * 4;
  const put = (s: string) => {
    text(buf, "NOTE", { x: minX, y: ty }, th, s);
    ty += th * 1.6;
  };
  put(`PATTERN ${result.pattern}  PANELS=${result.totalPanels}  ${result.totalKw.toFixed(1)}kW`);
  put(`ARRAYS=${result.arrays.length}  PITCH=${result.pitchM.toFixed(2)}m`);
  if (result.pattern === "B") {
    const dir = result.azimuthOffsetDeg > 0 ? "WEST" : "EAST";
    put(
      result.azimuthOffsetDeg === 0
        ? "AZIMUTH: DUE SOUTH"
        : `AZIMUTH: ${Math.abs(result.azimuthOffsetDeg).toFixed(0)}deg ${dir} of SOUTH  (${result.azimuthOffsetLabel})`
    );
  }

  buf.push("0", "ENDSEC", "0", "EOF");
  return buf.join("\n");
}

export function downloadDxf(filename: string, content: string) {
  const blob = new Blob([content], { type: "application/dxf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
