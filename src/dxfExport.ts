// DXF(R12 ASCII) 書き出し。内部座標は数学m(y上=CAD慣習)だが、
// JWCAD 等が mm 単位で解釈するため、出力時に mm(×1000) へ変換して原寸表示にする。
import type { Vec2 } from "./geometry";
import type { LayoutResult } from "./layout";
import type { StringingResult } from "./stringing";
import { pcsColor, groupPcsBoxes } from "./stringing";
import { arrayComposition } from "./layout";

const MM = 1000; // m → mm 変換係数

function line(buf: string[], layer: string, a: Vec2, b: Vec2) {
  buf.push(
    "0", "LINE",
    "8", layer,
    "10", (a.x * MM).toFixed(2), "20", (a.y * MM).toFixed(2), "30", "0.0",
    "11", (b.x * MM).toFixed(2), "21", (b.y * MM).toFixed(2), "31", "0.0"
  );
}

function circle(buf: string[], layer: string, c: Vec2, r: number) {
  buf.push(
    "0", "CIRCLE",
    "8", layer,
    "10", (c.x * MM).toFixed(2), "20", (c.y * MM).toFixed(2), "30", "0.0",
    "40", (r * MM).toFixed(2)
  );
}

function text(buf: string[], layer: string, p: Vec2, h: number, s: string) {
  buf.push("0", "TEXT", "8", layer, "10", (p.x * MM).toFixed(2), "20", (p.y * MM).toFixed(2), "30", "0.0", "40", (h * MM).toFixed(2), "1", s);
}

/** レイヤー定義。PCS結線は台数ぶん STRING_PCS{n} を動的に追加する。 */
function layerTable(buf: string[], pcsCount: number) {
  const layers: [string, number][] = [
    ["SITE", 2], // 黄（敷地境界線）
    ["FENCE", 3], // 緑（フェンスライン＝境界離隔）
    ["PANEL", 5], // 青
    ["NOTE", 1], // 赤
    ["STRING_TXT", 8], // グレー（回路ラベル PCSn-c）
    ["PCS_BOX", 30], // オレンジ（PCS設置位置の囲い）
    ["POLE", 8], // グレー（先方柱）
  ];
  // PCSごとの結線レイヤー（PCS色）
  for (let i = 0; i < pcsCount; i++) layers.push([`STRING_PCS${i + 1}`, pcsColor(i).aci]);
  buf.push("0", "TABLE", "2", "LAYER", "70", String(layers.length));
  for (const [name, color] of layers) {
    buf.push("0", "LAYER", "2", name, "70", "0", "62", String(color), "6", "CONTINUOUS");
  }
  buf.push("0", "ENDTAB");
}

export function buildDxf(
  sitesM: Vec2[][],
  result: LayoutResult,
  opts: {
    northAngleDeg: number;
    stringing?: StringingResult;
    fences?: (Vec2[] | null)[];
    fenceLengthM?: number;
    moduleLabel?: string | null;
    pole?: Vec2 | null;
  }
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
  layerTable(buf, opts.stringing ? opts.stringing.pccSummaries.length : 0);
  buf.push("0", "ENDSEC");
  buf.push("0", "SECTION", "2", "ENTITIES");

  // 敷地外形（オレンジ/黄）。区画ごとに閉ポリゴンを描く。
  for (const siteM of sitesM) {
    for (let i = 0; i < siteM.length; i++) {
      line(buf, "SITE", siteM[i], siteM[(i + 1) % siteM.length]);
    }
  }

  // フェンスライン（緑・野立てのみ）。境界離隔ぶん内側の閉ポリゴン・区画ごと。
  for (const f of opts.fences ?? []) {
    if (!f || f.length < 2) continue;
    for (let i = 0; i < f.length; i++) line(buf, "FENCE", f[i], f[(i + 1) % f.length]);
  }

  // パネル（1枚ごとに4辺を罫線として出力）
  for (const arr of result.arrays) {
    for (const rect of arr.panelRects) {
      for (let i = 0; i < 4; i++) line(buf, "PANEL", rect[i], rect[(i + 1) % 4]);
    }
  }

  // バウンディングボックス（注記・方位マーク・文字サイズ用）。全区画の頂点から。
  const allSitePts = sitesM.flat();
  const xs = allSitePts.map((p) => p.x);
  const ys = allSitePts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const diag = Math.hypot(maxX - minX, maxY - minY);
  const th = diag * 0.02; // 注記テキスト高さ
  const cth = diag * 0.006; // 回路ラベルの文字高さ

  // ラベルの重なり回避用ボックス（段列ラベル・PCS囲み・回路ラベルで共有）
  type Box = { x0: number; x1: number; y0: number; y1: number };
  const lblBoxes: Box[] = [];
  const lblHit = (b: Box) =>
    lblBoxes.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);

  // ストリング結線（オプション）。PCSごとに色分けし、回路ラベル PCSn-c を付す。
  if (opts.stringing) {
    const st = opts.stringing;
    // 直列パネル中心を結ぶ結線
    for (const s of st.strings) {
      const layer = s.pcsIndex >= 0 ? `STRING_PCS${s.pcsIndex + 1}` : "STRING_TXT";
      for (let i = 0; i < s.panels.length - 1; i++)
        line(buf, layer, s.panels[i].center, s.panels[i + 1].center);
    }
    // 回路ラベル（PCS何台目-何回路目）はストリングにつき1個。横は主要段のパネル中央、
    // 縦は段のすぐ上（上段）／すぐ下（下段）の空白(labelPos)。
    // 他ラベルと重なる場合のみ labelDir（パネルから離れる垂直方向）へ1行ぶんずつ逃がす。
    for (const s of st.strings) {
      if (s.pcsIndex < 0 || s.panels.length === 0) continue;
      const tag = `PCS${s.pcsIndex + 1}-${s.circuit}`;
      const tw = tag.length * cth * 0.62;
      let cx = s.labelPos.x,
        cy = s.labelPos.y;
      const mkBox = (): Box => ({ x0: cx - tw / 2, x1: cx + tw / 2, y0: cy - cth / 2, y1: cy + cth / 2 });
      let box = mkBox();
      let guard = 0;
      while (lblHit(box) && guard < 30) {
        cx += s.labelDir.x * cth * 1.6;
        cy += s.labelDir.y * cth * 1.6;
        box = mkBox();
        guard++;
      }
      lblBoxes.push(box);
      // DXFテキストは左下基準のため中央へ補正
      text(buf, "STRING_TXT", { x: cx - tw / 2, y: cy - cth / 2 }, cth, tag);
    }
    // ② PCS設置位置。ストリング表記を最優先とし（先に配置済み）、後から置く。
    //    アレイ上のPCSは【アレイの下辺(南側)にくっつけた小さめの四角】で表す。
    //    横位置はPCS実位置に近い側の端へ寄せ、「PCS xN」は四角の右側へ。
    //    回路ラベルと被る場合は四角は下へ・ラベルは右へ逃がす。
    for (const g of groupPcsBoxes(st.pccs, result.arrays)) {
      const boxW = 2.6; // 囲い 約2.6m×1.3m（小さめ固定）
      const boxH = 1.3;
      let bx0: number, by0: number, bw: number, bh: number;
      if (g.arrayIdx != null) {
        const axs = result.arrays[g.arrayIdx].corners.map((c) => c.x);
        const ays = result.arrays[g.arrayIdx].corners.map((c) => c.y);
        const ax0 = Math.min(...axs);
        const ax1 = Math.max(...axs);
        const ay0 = Math.min(...ays);
        // PCS実位置の平均xに近い側の端へ寄せ、下辺(南側)にくっつける
        const meanX = g.points.reduce((s, p) => s + p.x, 0) / g.points.length;
        const leftEnd = Math.abs(meanX - ax0) <= Math.abs(meanX - ax1);
        bw = boxW;
        bh = boxH;
        bx0 = leftEnd ? ax0 : ax1 - boxW;
        by0 = ay0 - 0.3 - boxH; // 下辺のすぐ下（y上向きのため負方向）
        // 回路ラベル等と被る場合はさらに下へ逃がす
        let bRect: Box = { x0: bx0, x1: bx0 + bw, y0: by0, y1: by0 + bh };
        let bGuard = 0;
        while (lblHit(bRect) && bGuard < 30) {
          by0 -= bh * 0.8;
          bRect = { x0: bx0, x1: bx0 + bw, y0: by0, y1: by0 + bh };
          bGuard++;
        }
        lblBoxes.push(bRect);
      } else {
        const cxs = g.points.map((p) => p.x);
        const cys = g.points.map((p) => p.y);
        const ex = 0.4;
        bx0 = Math.min(...cxs) - ex;
        by0 = Math.min(...cys) - ex;
        bw = Math.max(...cxs) + ex - bx0;
        bh = Math.max(...cys) + ex - by0;
      }
      const r = [
        { x: bx0, y: by0 },
        { x: bx0 + bw, y: by0 },
        { x: bx0 + bw, y: by0 + bh },
        { x: bx0, y: by0 + bh },
      ];
      for (let i = 0; i < 4; i++) line(buf, "PCS_BOX", r[i], r[(i + 1) % 4]);
      // ラベルは四角の右側。回路ラベルと被る場合はさらに右へずらす。
      const tag = g.points.length > 1 ? `PCS x${g.points.length}` : "PCS";
      const tw = tag.length * cth * 0.62;
      let lx = bx0 + bw + cth * 0.6;
      const lyC = by0 + bh / 2;
      const mkBox = (): Box => ({ x0: lx, x1: lx + tw, y0: lyC - cth, y1: lyC + cth });
      let box = mkBox();
      let guard = 0;
      while (lblHit(box) && guard < 30) {
        lx += tw * 0.6 + cth;
        box = mkBox();
        guard++;
      }
      lblBoxes.push(box);
      text(buf, "PCS_BOX", { x: lx, y: lyC - cth / 2 }, cth, tag);
    }
    // ※パワコン1台ごとの記号は出力しない（囲み「PCS xN」で表す）。
  }

  // ※アレイごとの段列表記は廃止（注記の「ARRAYS:」行に集約）。

  // ④ 先方柱（灰色・二重円＝塗りつぶし相当の表現）＋ラベル
  if (opts.pole) {
    const r = Math.max(0.3, diag * 0.004);
    circle(buf, "POLE", opts.pole, r);
    circle(buf, "POLE", opts.pole, r * 0.55);
    circle(buf, "POLE", opts.pole, r * 0.15);
    text(buf, "POLE", { x: opts.pole.x + r * 1.4, y: opts.pole.y - cth / 2 }, cth, "先方柱");
  }

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
  if (opts.moduleLabel) put(`MODULE: ${opts.moduleLabel}`);
  put(`ARRAYS=${result.arrays.length}  PITCH=${result.pitchM.toFixed(2)}m`);
  if (result.arrays.length > 0) put(`ARRAYS: ${arrayComposition(result)}`);
  if (result.mountType === "tilted")
    put(`ARRAY GAP(N-S) = ${Math.max(0, result.pitchM - result.groundDepthM).toFixed(2)} m`);
  if (opts.fenceLengthM && opts.fenceLengthM > 0)
    put(`FENCE LENGTH = ${opts.fenceLengthM.toFixed(1)} m`);
  // 設置角度（真南=0度・東西の振れ）。パターンB(土地なり)で意味を持つ。
  if (result.pattern === "B") {
    const dir = result.azimuthOffsetDeg > 0 ? "WEST" : "EAST";
    put(
      result.azimuthOffsetDeg === 0
        ? "AZIMUTH: DUE SOUTH (0deg)"
        : `AZIMUTH: ${Math.abs(result.azimuthOffsetDeg).toFixed(1)}deg ${dir} of SOUTH  (${result.azimuthOffsetLabel})`
    );
  }
  if (opts.stringing) {
    const st = opts.stringing;
    put(`STRINGING  Ns=${st.ns}  STRINGS=${st.totalStrings}  PCS=${st.pccSummaries.length}`);
    st.pccSummaries.forEach((s, i) => {
      put(`  PCS${i + 1}: ${s.strings}circuit / ${s.panels}panel  (cap ${s.capacityStrings}circuit)`);
    });
    for (const w of st.warnings) put(`! ${w}`);
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
