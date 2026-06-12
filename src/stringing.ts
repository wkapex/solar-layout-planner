// DCストリング結線エンジン。
// パネル配置(panelRects)を直列数(ns)ごとに区切ってストリング(=1回路)を作り、
// 各ストリングをパワコン(PCS)の「何台目・何回路目」に割り当てる。
// 同一PCSのストリングは同色で統一し、DXF/PDF/画面に結線とラベルを描く。
// たどり方の原則: アレイ(テーブル)内で完結が大前提。端数で完結できない場合のみ
// 隣のアレイへ連続させる（最大配置優先）。同一前後位置(帯)のアレイを左→右に
// 連結し、各アレイ内は段ごとに蛇行(serpentine)してから ns 枚ずつ切り出す。
// 入出力はすべて「数学座標・メートル(y上)」で既存モジュールと同一系。
import { Vec2, add, scale, sub, dot, normalize, pointInPolygon } from "./geometry";
import type { LayoutResult, ArrayTable } from "./layout";

/** パワコン(PCS)1台の諸元（位置つき） */
export interface PcsUnit {
  pos: Vec2; // 位置（数学m）
  ns: number; // 直列数（1ストリングのモジュール枚数）
  np: number; // 並列数
  mppt: number; // MPPT入力数
}

/** ストリングを構成する1枚のパネル参照 */
export interface PanelRef {
  arrayIdx: number;
  panelIdx: number;
  center: Vec2; // パネル中心（数学m）
  corners: Vec2[]; // パネル4隅（数学m）
}

/** 1ストリング（直列ns枚＝1回路） */
export interface StringRun {
  panels: PanelRef[]; // 直列順に並んだパネル
  pcsIndex: number; // 割当先PCS（0始まり, 未割当=-1）
  circuit: number; // PCS内の回路番号（1始まり, 未割当=0）
  full: boolean; // ns枚そろっているか（端数ストリング判定）
  /** 回路ラベルの推奨位置（パネルに被らないアレイ間の空白へ寄せた点・数学m） */
  labelPos: Vec2;
  /** ラベルをパネルから離す向き（±vUnit の単位ベクトル）。衝突回避はこの方向のみへずらす */
  labelDir: Vec2;
}

/** PCS1台あたりの集計 */
export interface PcsStringSummary {
  pos: Vec2;
  strings: number; // 割当ストリング数
  panels: number; // 割当パネル枚数
  capacityStrings: number; // 容量（並列×MPPT入力数 ＝ 入力できる回路数）
  ns: number;
}

export interface StringingResult {
  pccs: Vec2[]; // PCS位置（数学m, 描画用）
  strings: StringRun[];
  pccSummaries: PcsStringSummary[];
  ns: number; // 採用した直列数
  totalStrings: number;
  warnings: string[];
}

export interface StringingInput {
  layout: LayoutResult;
  pccs: PcsUnit[];
}

/**
 * PCS別カラーパレット。
 * hex=画面/PDF用, aci=DXF(AutoCAD Color Index)用。PCS番号で循環使用する。
 * 赤(=PCS記号)と被らない色を選定。
 */
export const PCS_COLORS: { hex: string; aci: number }[] = [
  { hex: "#2563eb", aci: 5 }, // 青
  { hex: "#16a34a", aci: 3 }, // 緑
  { hex: "#ea580c", aci: 30 }, // オレンジ
  { hex: "#9333ea", aci: 200 }, // 紫
  { hex: "#0891b2", aci: 4 }, // シアン
  { hex: "#db2777", aci: 6 }, // マゼンタ
  { hex: "#65a30d", aci: 50 }, // 黄緑
  { hex: "#0d9488", aci: 130 }, // 青緑
  { hex: "#a16207", aci: 40 }, // 茶
  { hex: "#4f46e5", aci: 170 }, // 藍
  { hex: "#be123c", aci: 240 }, // ローズ
  { hex: "#15803d", aci: 90 }, // 深緑
];

/** PCS番号(0始まり) → 配色（循環） */
export function pcsColor(i: number): { hex: string; aci: number } {
  if (i < 0) return { hex: "#9ca3af", aci: 8 }; // 未割当=グレー
  const n = PCS_COLORS.length;
  return PCS_COLORS[((i % n) + n) % n];
}

/**
 * 近接する点をひとまとめにする簡易クラスタリング（PCS設置位置の囲い用）。
 * いずれかの既存メンバーから maxDistM 以内なら同じクラスタに入れる。
 */
export function clusterPoints(points: Vec2[], maxDistM = 15): Vec2[][] {
  const clusters: Vec2[][] = [];
  for (const p of points) {
    let target: Vec2[] | null = null;
    for (const c of clusters) {
      if (c.some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= maxDistM)) {
        target = c;
        break;
      }
    }
    if (target) target.push(p);
    else clusters.push([p]);
  }
  return clusters;
}

/** PCS設置位置のグループ（囲い1つぶん）。arrayIdx=null はアレイ外（地上置き等） */
export interface PcsBoxGroup {
  points: Vec2[];
  arrayIdx: number | null;
}

/**
 * PCS設置位置の囲い単位を決める。
 * アレイ上に乗っているPCSは【アレイごと】に分けて囲い（複数アレイをまたぐ囲いを作らない）、
 * どのアレイにも乗っていないPCS（地上置き等）は近接クラスタ(15m)でまとめる。
 */
export function groupPcsBoxes(pccs: Vec2[], arrays: ArrayTable[]): PcsBoxGroup[] {
  const byArray = new Map<number, Vec2[]>();
  const loose: Vec2[] = [];
  for (const p of pccs) {
    let found = -1;
    for (let i = 0; i < arrays.length && found < 0; i++)
      if (pointInPolygon(p, arrays[i].corners)) found = i;
    if (found >= 0) {
      const g = byArray.get(found);
      if (g) g.push(p);
      else byArray.set(found, [p]);
    } else loose.push(p);
  }
  return [
    ...[...byArray.entries()].map(([i, points]) => ({ points, arrayIdx: i })),
    ...clusterPoints(loose, 15).map((points) => ({ points, arrayIdx: null })),
  ];
}

function centroid(q: Vec2[]): Vec2 {
  let x = 0,
    y = 0;
  for (const p of q) {
    x += p.x;
    y += p.y;
  }
  return { x: x / q.length, y: y / q.length };
}

/** アレイ内のパネルを段(v)ごとに蛇行(serpentine)した直列順で返す */
function arrayPanelOrder(
  arr: ArrayTable,
  ai: number,
  uUnit: Vec2,
  vUnit: Vec2
): PanelRef[] {
  type R = PanelRef & { u: number; v: number };
  const refs: R[] = arr.panelRects.map((corners, panelIdx) => {
    const c = centroid(corners);
    return {
      arrayIdx: ai,
      panelIdx,
      center: c,
      corners,
      u: dot(c, uUnit),
      v: dot(c, vUnit),
    };
  });
  // グリッド(rows×cols)前提：v昇順に並べ cols 枚ずつを1段として取り出す。
  refs.sort((a, b) => a.v - b.v);
  const cols = Math.max(1, arr.cols);
  const rows = Math.max(1, arr.rows);
  const order: PanelRef[] = [];
  for (let r = 0; r < rows; r++) {
    const rowRefs = refs.slice(r * cols, (r + 1) * cols).sort((a, b) => a.u - b.u);
    if (r % 2 === 1) rowRefs.reverse(); // 段ごとに折り返して蛇行
    for (const x of rowRefs) order.push({ arrayIdx: x.arrayIdx, panelIdx: x.panelIdx, center: x.center, corners: x.corners });
  }
  return order;
}

/**
 * ストリング結線を生成する。
 * - アレイを「前後位置(帯)→左右(u)」の読み順に並べ、各アレイ内を蛇行で連結。
 * - 連結した1本のパネル列を ns 枚ずつ区切ってストリングにする
 *   （アレイ枚数が ns の倍数なら各ストリングはアレイ内で完結、端数のみ次アレイへ連続）。
 * - ストリングを空間順のままPCSへ詰める（PCS容量＝並列×MPPT入力数の回路数）。
 */
export function generateStringing(input: StringingInput): StringingResult {
  const warnings: string[] = [];
  const arrays = input.layout.arrays;
  const pccs = input.pccs;

  const empty = (ns: number): StringingResult => ({
    pccs: pccs.map((u) => u.pos),
    strings: [],
    pccSummaries: [],
    ns,
    totalStrings: 0,
    warnings,
  });

  if (arrays.length === 0) {
    warnings.push("パネル配置がありません。先に配置を生成してください。");
    return empty(1);
  }
  if (pccs.length === 0) {
    warnings.push("パワコンが未設定です。位置を1台以上指定してください。");
    return empty(1);
  }

  // 直列数は原則サイト共通（PCSごとに異なる場合は警告し先頭値を採用）
  const ns = Math.max(1, pccs[0].ns);
  if (pccs.some((u) => Math.max(1, u.ns) !== ns))
    warnings.push(`PCSごとに直列数が異なります。先頭の ${ns} 直列で結線します。`);

  // 列の軸（アレイ角から導出）: u=列方向(東西/段内), v=段をまたぐ前後方向
  const a0 = arrays[0].corners;
  const uUnit = normalize(sub(a0[1], a0[0]));
  const vUnit = normalize(sub(a0[3], a0[0]));
  const pitch = input.layout.pitchM > 0 ? input.layout.pitchM : 1;

  // アレイを 帯(v) → 左右(u) の読み順に並べる
  const arrInfo = arrays.map((arr, ai) => {
    const c = centroid(arr.corners);
    return { ai, band: Math.round(dot(c, vUnit) / pitch), u: dot(c, uUnit) };
  });
  arrInfo.sort((a, b) => a.band - b.band || a.u - b.u);

  // 全パネルを1本のパネル列に連結（アレイ内は蛇行）
  const path: PanelRef[] = [];
  for (const info of arrInfo)
    path.push(...arrayPanelOrder(arrays[info.ai], info.ai, uUnit, vUnit));

  // ns 枚ずつストリングに切り出す
  const strings: StringRun[] = [];
  for (let i = 0; i < path.length; i += ns) {
    const panels = path.slice(i, i + ns);
    strings.push({
      panels,
      pcsIndex: -1,
      circuit: 0,
      full: panels.length === ns,
      labelPos: panels[0]?.center ?? { x: 0, y: 0 },
      labelDir: { x: 0, y: 1 },
    });
  }

  // 回路ラベルの位置決め（PNG指示の体裁）：
  //  - ストリングが属する「主要段」（パネルが最も多く乗っている段＝同一v）を特定し、
  //    その段のパネル群の横中央 × 段のすぐ外側（上段なら真上、下段なら真下の空白）に置く。
  //  - こうするとアレイをまたぐストリングでも、ラベルは自分のパネルの直上/直下に出る。
  //  - 衝突回避用に「離す向き(labelDir=±vUnit)」も保存し、ずらすのは垂直方向のみとする。
  {
    const groundDepth = input.layout.groundDepthM > 0 ? input.layout.groundDepthM : 1;
    const gap = Math.max(0, pitch - groundDepth);
    // アレイ端からの離し量：離隔の3割（0.25〜0.8mにクランプ）。ラベルは自段のすぐ外側に出す。
    const pad = Math.min(Math.max(gap * 0.3, 0.25), 0.8);
    for (const s of strings) {
      if (s.panels.length === 0) continue;
      // 段ごとにパネルをグループ化（同一段は v がほぼ一致する）
      const tiers = new Map<number, PanelRef[]>();
      for (const p of s.panels) {
        const key = Math.round(dot(p.center, vUnit) * 100); // 1cm 精度で量子化
        const g = tiers.get(key);
        if (g) g.push(p);
        else tiers.set(key, [p]);
      }
      // パネルが最も多い段を主要段とする（同数なら先頭）
      let major: PanelRef[] = s.panels;
      let best = -1;
      for (const g of tiers.values()) {
        if (g.length > best) {
          best = g.length;
          major = g;
        }
      }
      // 主要段の横中央
      let minU = Infinity,
        maxU = -Infinity;
      for (const p of major) {
        const u = dot(p.center, uUnit);
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
      }
      const uCenter = (minU + maxU) / 2;
      // 主要段が属するアレイの中心と比較し、上段なら+v(真上)、下段なら-v(真下)へ
      const tierV = dot(major[0].center, vUnit);
      const arrCv = dot(centroid(arrays[major[0].arrayIdx].corners), vUnit);
      const sign = tierV >= arrCv ? 1 : -1;
      const labelV = arrCv + sign * (groundDepth / 2 + pad);
      s.labelPos = add(scale(uUnit, uCenter), scale(vUnit, labelV));
      s.labelDir = scale(vUnit, sign);
    }
  }
  const remainder = path.length % ns;
  if (remainder !== 0)
    warnings.push(`端数 ${remainder} 枚が ns(${ns}) に満たない不完全ストリングになっています。`);

  // PCSを空間順（帯→u）に並べ、容量(並列×MPPT)ぶんの回路を順に詰める
  const cap = pccs.map((u) => Math.max(1, u.np) * Math.max(1, u.mppt));
  const pcsOrder = pccs
    .map((u, i) => ({ i, band: Math.round(dot(u.pos, vUnit) / pitch), u: dot(u.pos, uUnit) }))
    .sort((a, b) => a.band - b.band || a.u - b.u)
    .map((o) => o.i);

  let k = 0;
  let used = 0;
  let overflow = false;
  for (const s of strings) {
    while (k < pcsOrder.length && used >= cap[pcsOrder[k]]) {
      k++;
      used = 0;
    }
    if (k >= pcsOrder.length) {
      overflow = true;
      break;
    }
    s.pcsIndex = pcsOrder[k];
    s.circuit = used + 1;
    used++;
  }
  if (overflow)
    warnings.push(
      "容量超過: PCSの回路数（並列×MPPT合計）よりストリングが多く、割当できないストリングがあります。"
    );

  // PCSごと集計
  const summaries: PcsStringSummary[] = pccs.map((u, i) => ({
    pos: u.pos,
    strings: 0,
    panels: 0,
    capacityStrings: cap[i],
    ns,
  }));
  for (const s of strings) {
    if (s.pcsIndex >= 0) {
      summaries[s.pcsIndex].strings++;
      summaries[s.pcsIndex].panels += s.panels.length;
    }
  }
  for (let i = 0; i < pccs.length; i++)
    if (summaries[i].strings === 0)
      warnings.push(`PCS${i + 1} に回路が割り当てられていません（台数・容量・配置を確認）。`);

  return {
    pccs: pccs.map((u) => u.pos),
    strings,
    pccSummaries: summaries,
    ns,
    totalStrings: strings.length,
    warnings,
  };
}
