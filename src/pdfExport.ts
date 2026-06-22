// PDF出力。配置図＋DCストリング結線を1枚のラスター画像としてPDFに埋め込む。
// 外部ライブラリに依存せず、最小限のPDF(1ページ・JPEG埋め込み)を自前生成する。
// 描画は <canvas> に行い、JPEGへエンコードして配置する。
import type { Vec2 } from "./geometry";
import type { LayoutResult } from "./layout";
import type { StringingResult } from "./stringing";
import { pcsColor, groupPcsBoxes } from "./stringing";
import { arrayComposition } from "./layout";
import { metersToImg } from "./polygon";

export interface PdfRenderInput {
  /** 元敷地図のビットマップ（任意。背景に薄く敷く） */
  background?: HTMLCanvasElement | null;
  /** 敷地多角形（画像px座標）。区画ごとに1つ。 */
  sitePolysPx: Vec2[][];
  /** 配置結果（全区画を統合した1つの結果） */
  result: LayoutResult;
  /** ストリング結線結果（任意） */
  stringing?: StringingResult | null;
  /** フェンスライン（数学m・閉ポリゴン／野立てのみ・区画ごと）。緑で描画。 */
  fencesM?: (Vec2[] | null)[];
  /** フェンス延長（周長, m）。凡例に表記。 */
  fenceLengthM?: number;
  /** モジュール型番（メーカー＋型式）。凡例に表記。 */
  moduleLabel?: string | null;
  /** 先方柱の位置（数学m）。灰色の塗りつぶし丸で表記。 */
  poleM?: Vec2 | null;
  /** m→px 変換係数（mPerPx） */
  mPerPx: number;
  /** タイトル文字列 */
  title: string;
}

/** 数学m座標を画像px座標へ（既存 metersToImg を利用） */
function mToPx(p: Vec2, mPerPx: number): Vec2 {
  return metersToImg(p, mPerPx);
}

/** 配置＋結線を1枚のcanvasに描画して返す */
function renderToCanvas(input: PdfRenderInput): HTMLCanvasElement {
  const { result, stringing, mPerPx } = input;

  // 描画対象の全点から境界ボックスを求める（px座標）
  const pts: Vec2[] = [];
  for (const poly of input.sitePolysPx) for (const c of poly) pts.push(c);
  for (const arr of result.arrays)
    for (const rect of arr.panelRects)
      for (const c of rect) pts.push(mToPx(c, mPerPx));
  if (input.poleM) pts.push(mToPx(input.poleM, mPerPx)); // 先方柱（敷地外でも収める）

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  // A4横の比率に固定した論理キャンバスへ、敷地＋パネルの内容を
  // 「はみ出さない最大スケール」で拡大し、中央(センター)に配置する。
  const logicalW = 1684; // A4横(842pt)の2倍解像度
  const logicalH = 1190;
  const pad = 36; // 図面まわりの余白
  const availW = logicalW - pad * 2;

  // 凡例（下部帯）の内容を先に組み立て、行数からバンド高さを決める。
  // フォントはタイトルと同じ26px（太字なし）。幅を超える場合は「｜」区切りで自動改行。
  const segs: string[] = [];
  segs.push(`パネル ${result.totalPanels.toLocaleString()}枚 / ${result.totalKw.toFixed(1)}kW`);
  if (result.arrays.length > 0) segs.push(`アレイ構成: ${arrayComposition(result)}`);
  if (input.moduleLabel) segs.push(`モジュール: ${input.moduleLabel}`);
  if (result.pattern === "B")
    segs.push(`設置角度: ${result.azimuthOffsetLabel}（真南=0度）`);
  if (result.mountType === "tilted")
    segs.push(`南北アレイ間離隔: ${Math.max(0, result.pitchM - result.groundDepthM).toFixed(2)}m`);
  if (input.fenceLengthM && input.fenceLengthM > 0)
    segs.push(`フェンス延長: ${input.fenceLengthM.toFixed(1)}m`);
  if (stringing)
    segs.push(
      `結線: ${stringing.ns}直列 / ${stringing.totalStrings}ストリング / PCS${stringing.pccSummaries.length}台`
    );
  const meas = document.createElement("canvas").getContext("2d")!;
  meas.font = "26px sans-serif";
  const legendLines: string[] = [];
  {
    let cur = "";
    for (const s of segs) {
      const cand = cur ? `${cur}　|　${s}` : s;
      if (cur && meas.measureText(cand).width > availW) {
        legendLines.push(cur);
        cur = s;
      } else cur = cand;
    }
    if (cur) legendLines.push(cur);
  }
  const bandH = 84 + legendLines.length * 34; // タイトル行＋凡例行
  const availH = logicalH - bandH - pad * 2;
  const cw = Math.max(maxX - minX, 1);
  const ch = Math.max(maxY - minY, 1);
  const fit = Math.min(availW / cw, availH / ch); // 内容→キャンバスの拡大率
  const offX = pad + (availW - cw * fit) / 2;
  const offY = pad + (availH - ch * fit) / 2;

  // スーパーサンプリング：長辺が約3600pxになるよう拡大して埋め込み解像度を上げる（拡大時もくっきり）。
  const ss = Math.min(4, Math.max(1.5, 3600 / Math.max(logicalW, logicalH)));

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(logicalW * ss);
  canvas.height = Math.round(logicalH * ss);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(ss, ss); // 以降は論理px座標で描画（実ピクセルはss倍）
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, logicalW, logicalH);

  ctx.save();
  // 図面領域でクリップし（背景図が凡例帯や余白へはみ出さない）、内容を中央へ最大表示
  ctx.beginPath();
  ctx.rect(pad, pad, availW, availH);
  ctx.clip();
  ctx.translate(offX, offY);
  ctx.scale(fit, fit);
  ctx.translate(-minX, -minY);
  // 以降の線幅・文字は内容と一緒に fit 倍へ拡大される（図面全体のズームとして自然）

  // 背景図（薄く）
  if (input.background) {
    ctx.globalAlpha = 0.35;
    ctx.drawImage(input.background, 0, 0);
    ctx.globalAlpha = 1;
  }

  // 敷地境界線（オレンジ）。区画ごとに描く。
  ctx.strokeStyle = "#caa21a";
  ctx.lineWidth = 2;
  for (const poly of input.sitePolysPx) {
    if (poly.length < 2) continue;
    ctx.beginPath();
    poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
  }

  // フェンスライン（緑・野立てのみ）。区画ごとに描く。
  ctx.strokeStyle = "#1f9d4d";
  ctx.lineWidth = 2;
  for (const fence of input.fencesM ?? []) {
    if (!fence || fence.length < 2) continue;
    ctx.beginPath();
    fence.forEach((p, i) => {
      const q = mToPx(p, mPerPx);
      i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y);
    });
    ctx.closePath();
    ctx.stroke();
  }

  // パネル
  ctx.fillStyle = "rgba(135,206,250,0.45)";
  ctx.strokeStyle = "#1565d8";
  ctx.lineWidth = 1;
  for (const arr of result.arrays) {
    for (const rect of arr.panelRects) {
      ctx.beginPath();
      rect.forEach((c, i) => {
        const p = mToPx(c, mPerPx);
        i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  // ラベルの重なり回避用ボックス（段列ラベル・PCS囲み・回路ラベルで共有）
  type Box = { x0: number; x1: number; y0: number; y1: number };
  const placedBoxes: Box[] = [];
  const hit = (b: Box) =>
    placedBoxes.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);

  // ストリング結線（PCSごとに色分け。各パネル中心を直列順に結ぶ＋回路ラベル）
  if (stringing) {
    for (const s of stringing.strings) {
      const col = pcsColor(s.pcsIndex).hex;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      s.panels.forEach((p, i) => {
        const q = mToPx(p.center, mPerPx);
        i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y);
      });
      ctx.stroke();
      // 結線の起点に小さな丸（接続点）
      if (s.panels.length > 0) {
        const q0 = mToPx(s.panels[0].center, mPerPx);
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(q0.x, q0.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // 回路ラベル PCSn-c は「ストリングにつき1個」。横は主要段のパネル中央、
    // 縦は段のすぐ上（上段）／すぐ下（下段）の空白に置く。
    // 他ラベルと重なる場合のみ、labelDir（パネルから離れる垂直方向）へ1行ぶんずつ逃がす。
    ctx.font = "bold 8px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const fh = 8;
    for (const s of stringing.strings) {
      if (s.pcsIndex < 0 || s.panels.length === 0) continue;
      const col = pcsColor(s.pcsIndex).hex;
      const tag = `PCS${s.pcsIndex + 1}-${s.circuit}`;
      const w = ctx.measureText(tag).width;
      const c = mToPx(s.labelPos, mPerPx);
      // labelDir(数学m) を px 方向へ変換（y軸反転を吸収）して単位化
      const dpx = mToPx({ x: s.labelPos.x + s.labelDir.x, y: s.labelPos.y + s.labelDir.y }, mPerPx);
      let dx = dpx.x - c.x,
        dy = dpx.y - c.y;
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl;
      dy /= dl;
      let x = c.x,
        y = c.y;
      const mkBox = (): Box => ({ x0: x - w / 2 - 1, x1: x + w / 2 + 1, y0: y - fh / 2 - 1, y1: y + fh / 2 + 1 });
      let box = mkBox();
      let guard = 0;
      while (hit(box) && guard < 30) {
        x += dx * (fh + 1.5);
        y += dy * (fh + 1.5);
        box = mkBox();
        guard++;
      }
      placedBoxes.push(box);
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.strokeText(tag, x, y);
      ctx.fillStyle = col;
      ctx.fillText(tag, x, y);
    }
    // ② PCS設置位置。ストリング表記を最優先とし（先に配置済み）、後から置く。
    //    アレイ上のPCSは【アレイの下辺にくっつけた小さめの四角】で表す。
    //    横位置はPCS実位置に近い側の端（左端/右端）へ寄せ、「PCS×n」は四角の右側へ。
    //    回路ラベルと被る場合は四角は下へ・ラベルは右へ逃がす。
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const g of groupPcsBoxes(stringing.pccs, result.arrays)) {
      const boxW = 2.6 / mPerPx; // 囲い 約2.6m×1.3m（小さめ固定）
      const boxH = 1.3 / mPerPx;
      let bx0: number, by0: number, bw: number, bh: number;
      if (g.arrayIdx != null) {
        const q = result.arrays[g.arrayIdx].corners.map((c) => mToPx(c, mPerPx));
        const ax0 = Math.min(...q.map((p) => p.x));
        const ax1 = Math.max(...q.map((p) => p.x));
        const ay1 = Math.max(...q.map((p) => p.y));
        // PCS実位置の平均xに近い側の端へ寄せ、下辺にくっつける
        const meanX =
          g.points.reduce((s, p) => s + mToPx(p, mPerPx).x, 0) / g.points.length;
        const leftEnd = Math.abs(meanX - ax0) <= Math.abs(meanX - ax1);
        bw = boxW;
        bh = boxH;
        bx0 = leftEnd ? ax0 : ax1 - boxW;
        by0 = ay1 + 0.3 / mPerPx;
        // 回路ラベル等と被る場合は下へ逃がす
        let bRect: Box = { x0: bx0 - 1, x1: bx0 + bw + 1, y0: by0 - 1, y1: by0 + bh + 1 };
        let bGuard = 0;
        while (hit(bRect) && bGuard < 30) {
          by0 += bh * 0.8;
          bRect = { x0: bx0 - 1, x1: bx0 + bw + 1, y0: by0 - 1, y1: by0 + bh + 1 };
          bGuard++;
        }
        placedBoxes.push(bRect);
      } else {
        // アレイ外（地上置き）はPCS位置を小さめに囲う
        const qs = g.points.map((p) => mToPx(p, mPerPx));
        const ex = 0.4 / mPerPx;
        bx0 = Math.min(...qs.map((q) => q.x)) - ex;
        by0 = Math.min(...qs.map((q) => q.y)) - ex;
        bw = Math.max(...qs.map((q) => q.x)) + ex - bx0;
        bh = Math.max(...qs.map((q) => q.y)) + ex - by0;
      }
      ctx.strokeStyle = "#ea580c";
      ctx.lineWidth = 2;
      ctx.strokeRect(bx0, by0, bw, bh);
      // ラベルは四角の右側。ストリング表記と被る場合はさらに右へずらす。
      const tag = g.points.length > 1 ? `PCS×${g.points.length}` : "PCS";
      const w = ctx.measureText(tag).width;
      let lx = bx0 + bw + 3;
      const ly = by0 + bh / 2;
      const mkBox = (): Box => ({ x0: lx - 1, x1: lx + w + 1, y0: ly - 5.5, y1: ly + 5.5 });
      let box = mkBox();
      let guard = 0;
      while (hit(box) && guard < 30) {
        lx += w * 0.6 + 4;
        box = mkBox();
        guard++;
      }
      placedBoxes.push(box);
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.strokeText(tag, lx, ly);
      ctx.fillStyle = "#ea580c";
      ctx.fillText(tag, lx, ly);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    // ※パワコン1台ごとの記号は描画しない（囲み「PCS×n」で表す）。
  }

  // ※アレイごとの段列表記は廃止（凡例の「アレイ構成」に集約）。

  // ④ 先方柱（電柱に合わせた灰色・塗りつぶしの丸）
  if (input.poleM) {
    const q = mToPx(input.poleM, mPerPx);
    const r = Math.max(3, 0.4 / mPerPx); // 半径 約0.4m相当（最低3px）
    ctx.fillStyle = "#6b7280";
    ctx.beginPath();
    ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.strokeText("先方柱", q.x + r + 3, q.y);
    ctx.fillStyle = "#4b5563";
    ctx.fillText("先方柱", q.x + r + 3, q.y);
    ctx.textBaseline = "alphabetic";
  }

  ctx.restore();

  // 凡例・タイトル帯（論理座標で配置）。凡例はタイトルと同サイズ26px（太字なし）。
  ctx.fillStyle = "#111827";
  ctx.font = "bold 26px sans-serif";
  const titleY = logicalH - bandH + 40;
  ctx.fillText(input.title, pad, titleY);
  ctx.font = "26px sans-serif";
  legendLines.forEach((ln, i) => ctx.fillText(ln, pad, titleY + 40 + i * 34));

  return canvas;
}

/** canvas → JPEG bytes（Uint8Array） */
async function canvasToJpegBytes(canvas: HTMLCanvasElement, quality = 0.95): Promise<Uint8Array> {
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPEG変換失敗"))), "image/jpeg", quality)
  );
  return new Uint8Array(await blob.arrayBuffer());
}

/** 最小PDF(1ページ・JPEG1枚)を組み立てる */
function assemblePdf(jpeg: Uint8Array, imgW: number, imgH: number): Uint8Array {
  // A4横向きに収まるよう画像をスケール（72dpi基準, A4=842x595pt 横）
  const pageW = 842, pageH = 595;
  const margin = 24;
  const availW = pageW - margin * 2;
  const availH = pageH - margin * 2;
  const scale = Math.min(availW / imgW, availH / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const offX = (pageW - drawW) / 2;
  const offY = (pageH - drawH) / 2;

  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (data: Uint8Array | string) => {
    const u = typeof data === "string" ? enc.encode(data) : data;
    parts.push(u);
    pos += u.length;
  };
  const startObj = () => offsets.push(pos);

  push("%PDF-1.4\n");

  // 1: カタログ
  startObj();
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  // 2: ページツリー
  startObj();
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  // 3: ページ
  startObj();
  push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      `/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`
  );
  // 4: コンテンツ（画像配置）
  const content =
    `q\n${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${offX.toFixed(2)} ${offY.toFixed(2)} cm\n/Im0 Do\nQ\n`;
  const contentBytes = enc.encode(content);
  startObj();
  push(`4 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
  push(contentBytes);
  push("\nendstream\nendobj\n");
  // 5: 画像XObject（JPEG=DCTDecode）
  startObj();
  push(
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
  );
  push(jpeg);
  push("\nendstream\nendobj\n");

  // xref
  const xrefStart = pos;
  const objCount = offsets.length + 1; // +free
  let xref = `xref\n0 ${objCount}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, "0") + " 00000 n \n";
  push(xref);
  push(`trailer\n<< /Size ${objCount} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  // 結合
  const total = parts.reduce((s, p) => s + p.length, 0);
  const buffer = new ArrayBuffer(total);
  const out = new Uint8Array(buffer);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function buildAndDownloadPdf(input: PdfRenderInput, filename: string): Promise<void> {
  const canvas = renderToCanvas(input);
  const jpeg = await canvasToJpegBytes(canvas);
  const pdf = assemblePdf(jpeg, canvas.width, canvas.height);
  const blob = new Blob([pdf.buffer as ArrayBuffer], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
