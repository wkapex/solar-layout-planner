// 野立て太陽光の自動配置エンジン。
// 入力はすべて「数学座標・メートル(y上)」。パターンA(真南優先)とB(敷地なり最大枚数)を生成する。
import {
  Vec2,
  add,
  scale,
  dot,
  projectRange,
  rectInsideWithSetback,
  pointInPolygon,
} from "./geometry";
import type { PanelSpec } from "./panels";
import { moduleDimsM } from "./panels";
import type { SunPos } from "./solar";

export type Orientation = "portrait" | "landscape";

export type ColumnMode =
  | { kind: "max"; maxCols: number }
  | { kind: "specified"; cols: number[] }; // 最大3パターン想定

export interface LayoutInput {
  polygonM: Vec2[]; // 敷地多角形（数学m）
  panel: PanelSpec;
  orientation: Orientation;
  /** 陸屋根（合掌）の向き: ew=東西向き（棟は南北・現状の計算）/ ns=南北向き（棟は東西・90度回転） */
  rackDir?: "ew" | "ns";
  /** 複数区画で向きを統一するため facing を外部から固定する（指定時は候補探索せずこの向きで配置） */
  forcedFacing?: number;
  tiers: number; // 段数
  columnMode: ColumnMode;
  tiltDeg: number;
  setbackM: number;
  colGapM: number; // 列内パネル間ギャップ
  sideGapM: number; // アレイ間横ギャップ
  northAngleDeg: number; // 北方向（画像上方向から時計回り）
  sun: SunPos[]; // 冬至10-14時の太陽位置
  manualPitchM?: number; // 指定があれば前後ピッチを上書き
  /** 設置方式: tilted=野立て（傾斜＋影離隔）, rack=陸屋根合掌（東西・固定離隔）, flush=傾斜屋根フラッシュ */
  mountType: "tilted" | "rack" | "flush";
  rowGapM?: number; // flush時の行間ギャップ（既定0.02m）
  mountainGapM?: number; // rack時の山と山の離隔（既定0.25m）
  flushRows?: number; // flush時の手動指定: 縦(段数=南北方向の枚数)。空欄=自動最大
  flushCols?: number; // flush時の手動指定: 横(列数=東西方向の枚数)。空欄=自動最大
  setbackEWm?: number; // flush時の東西(列方向)の屋根端離隔。未指定はsetbackM
  setbackNSm?: number; // flush時の南北(行方向)の屋根端離隔。未指定はsetbackM
}

export interface ArrayTable {
  corners: Vec2[]; // アレイ外形の4隅（数学m）
  panelRects: Vec2[][]; // パネル1枚ごとの4隅（数学m）
  cols: number;
  rows: number; // = 段数
  panels: number;
}

/**
 * 配置グリッド（格子）情報。手動でパネルを増設する際の「吸着先」を計算するために公開する。
 * 列(u方向)は colPitch 間隔、段(アレイ)は bandPitch 間隔で並び、1アレイ内には
 * v方向に subCount 枚（各 subDepth の奥行）が積まれる。座標はすべて数学m。
 */
export interface LayoutGrid {
  uUnit: Vec2; // 列方向の単位ベクトル
  vUnit: Vec2; // 前後（段をまたぐ）方向の単位ベクトル
  uOrigin: number; // 列の基準位置（u座標）
  vOrigin: number; // 段の基準位置（v座標）
  colPitch: number; // 列ピッチ（rowWidth + 列内ギャップ）
  bandPitch: number; // 段（アレイ）ピッチ
  subDepth: number; // 1パネルのv方向奥行
  subCount: number; // 1アレイ内のv方向パネル数
  panelW: number; // 1パネルのu方向幅
}

export interface LayoutResult {
  pattern: "A" | "B" | "ROOF";
  mountType: "tilted" | "rack" | "flush";
  arrays: ArrayTable[];
  totalPanels: number;
  totalKw: number;
  pitchM: number;
  requiredGapM: number;
  groundDepthM: number;
  facingBearingDeg: number; // パネルが向く方位（北=0時計回り、南=180）
  azimuthOffsetDeg: number; // 真南からの振れ（+=西, -=東）
  azimuthOffsetLabel: string;
  colCountBreakdown: Record<number, number>;
  grid?: LayoutGrid; // 手動増設の吸着用グリッド（配置が空のときは未設定）
}

const deg2rad = (d: number) => (d * Math.PI) / 180;

/** 野立て：フェンスライン（境界離隔）から内側へさらに確保するパネル配置の余白(m) */
export const FENCE_PANEL_INSET_M = 2;

/** 北方向角から north/east 単位ベクトル（数学座標）を作る */
function basis(northAngleDeg: number): { n: Vec2; e: Vec2 } {
  const a = deg2rad(northAngleDeg);
  return {
    n: { x: Math.sin(a), y: Math.cos(a) },
    e: { x: Math.cos(a), y: -Math.sin(a) },
  };
}

/** コンパス方位(度, 北=0時計回り)の単位ベクトル */
function dirFromBearing(bearingDeg: number, n: Vec2, e: Vec2): Vec2 {
  const b = deg2rad(bearingDeg);
  return add(scale(n, Math.cos(b)), scale(e, Math.sin(b)));
}

/** ベクトルのコンパス方位(度, 北=0時計回り) */
function bearingOfVector(d: Vec2, n: Vec2, e: Vec2): number {
  return ((Math.atan2(dot(d, e), dot(d, n)) * 180) / Math.PI + 360) % 360;
}

function perPanelDims(panel: PanelSpec, orientation: Orientation) {
  const { longM, shortM } = moduleDimsM(panel);
  return orientation === "portrait"
    ? { slopeLen: longM, rowWidth: shortM }
    : { slopeLen: shortM, rowWidth: longM };
}

/** facing 方位に対して、冬至10-14時で影が出ない必要ピッチを計算 */
function computePitch(
  facingBearingDeg: number,
  groundDepthM: number,
  topHeightM: number,
  vUnit: Vec2,
  sun: SunPos[],
  n: Vec2,
  e: Vec2
): { pitch: number; gap: number } {
  let gap = 0;
  for (const s of sun) {
    const L = topHeightM / Math.tan(s.altitudeRad);
    const shadowDir = dirFromBearing((s.bearingDeg + 180) % 360, n, e);
    // 行間(v軸)方向の影成分。回転配置では影は前後どちらの隣接行にも落ち得るため
    // 絶対値で評価し、10-14時を通じて最大の所要間隔を採る。
    const comp = Math.abs(L * dot(shadowDir, vUnit));
    if (comp > gap) gap = comp;
  }
  void facingBearingDeg;
  return { pitch: groundDepthM + gap, gap };
}

/** 列数候補を優先順位（降順）で返す */
function columnCandidates(mode: ColumnMode): number[] {
  if (mode.kind === "specified") {
    return [...new Set(mode.cols.filter((c) => c >= 1))].sort((a, b) => b - a);
  }
  const out: number[] = [];
  for (let c = mode.maxCols; c >= 1; c--) out.push(c);
  return out;
}

/** 1つの facing 方位でアレイを敷地に詰める */
function placeArrays(
  input: LayoutInput,
  facingBearingDeg: number
): { arrays: ArrayTable[]; pitch: number; gap: number; groundDepth: number; grid: LayoutGrid } {
  const { n, e } = basis(input.northAngleDeg);
  const tilt = deg2rad(input.tiltDeg);
  const mode = input.mountType; // "tilted" | "rack" | "flush"
  // 野立てのみ：境界離隔=フェンスラインとし、その内側2mを配置可能ラインとする。
  const effSetback =
    mode === "tilted" ? input.setbackM + FENCE_PANEL_INSET_M : input.setbackM;
  // 陸屋根（合掌）は常に横置き（短辺を斜面に沿わせる低い山型）。向きは rackDir で東西/南北を切替える。
  const effOrientation: Orientation = mode === "rack" ? "landscape" : input.orientation;
  const { slopeLen, rowWidth } = perPanelDims(input.panel, effOrientation);

  // u: 列方向（行幅）, v: 前後（奥行）方向
  const uUnit = dirFromBearing(facingBearingDeg + 90, n, e);
  const vUnit = dirFromBearing((facingBearingDeg + 180) % 360, n, e);
  const toWorld = (u: number, v: number): Vec2 =>
    add(scale(uUnit, u), scale(vUnit, v));
  const rect = (u0: number, v0: number, w: number, d: number): Vec2[] => [
    toWorld(u0, v0),
    toWorld(u0 + w, v0),
    toWorld(u0 + w, v0 + d),
    toWorld(u0, v0 + d),
  ];

  // モード別：アレイ奥行・1列あたり枚数・パネル矩形の作り方
  let groundDepth: number;
  let panelsPerCol: number;
  let subDepth: number; // 1パネルのv方向奥行（手動グリッド用）
  let buildPanelRects: (u0: number, v0: number, c: number) => Vec2[][];

  if (mode === "rack") {
    // 陸屋根・合掌（東西背中合わせ）: 片側1枚×2スロープ。各スロープの投影 = slopeLen*cos(tilt)。
    const sd = slopeLen * Math.cos(tilt);
    groundDepth = 2 * sd;
    panelsPerCol = 2;
    subDepth = sd;
    buildPanelRects = (u0, v0, c) => {
      const rects: Vec2[][] = [];
      for (let j = 0; j < c; j++) {
        const uj = u0 + j * (rowWidth + input.colGapM);
        rects.push(rect(uj, v0, rowWidth, sd)); // 東スロープ
        rects.push(rect(uj, v0 + sd, rowWidth, sd)); // 西スロープ
      }
      return rects;
    };
  } else {
    // flush は屋根面と同一平面（cos補正なし）、tilted は地上投影（cos補正）
    const tierDepth = mode === "flush" ? slopeLen : slopeLen * Math.cos(tilt);
    groundDepth = input.tiers * tierDepth;
    panelsPerCol = input.tiers;
    subDepth = tierDepth;
    buildPanelRects = (u0, v0, c) => {
      const rects: Vec2[][] = [];
      for (let j = 0; j < c; j++) {
        const uj = u0 + j * (rowWidth + input.colGapM);
        for (let k = 0; k < input.tiers; k++) {
          rects.push(rect(uj, v0 + k * tierDepth, rowWidth, tierDepth));
        }
      }
      return rects;
    };
  }

  // 前後ピッチ
  let pitch: number;
  let gap: number;
  if (mode === "flush") {
    gap = 0;
    pitch = groundDepth + (input.rowGapM ?? 0.02);
  } else if (mode === "rack") {
    gap = 0;
    pitch = groundDepth + (input.mountainGapM ?? 0.25); // 山と山の離隔
  } else {
    const totalSlope = input.tiers * slopeLen;
    const topHeight = totalSlope * Math.sin(tilt);
    const r = computePitch(facingBearingDeg, groundDepth, topHeight, vUnit, input.sun, n, e);
    gap = r.gap;
    pitch = input.manualPitchM && input.manualPitchM > 0 ? input.manualPitchM : r.pitch;
  }

  const uRange = projectRange(input.polygonM, uUnit);
  const vRange = projectRange(input.polygonM, vUnit);

  const cands = columnCandidates(input.columnMode);
  const tableWidth = (c: number) => c * rowWidth + (c - 1) * input.colGapM;
  // 全アレイの開始位置を「単一パネル列ピッチの共通グリッド」に吸着させる。
  // アレイは整数列ぶんの幅なので、全パネルの列が uAnchor + 整数×cellPitch 上に揃い、
  // 敷地が多少傾いていても行ごとの列ズレ（ドリフト）が発生しない。
  const cellPitch = rowWidth + input.colGapM;
  const uAnchor = uRange.min;
  const snapUp = (u: number) => uAnchor + Math.ceil((u - uAnchor) / cellPitch - 1e-6) * cellPitch;

  // 行の開始位相（vRange.min からのオフセット）を複数試し、総枚数最大の案を採る。
  // 固定位相だと回転敷地で先頭行が「角の置けない領域」に浪費され枚数が伸びないため。
  const phases = [0, 0.2, 0.4, 0.6, 0.8];
  let bestArrays: ArrayTable[] = [];
  let bestPanels = -1;
  let bestPhase = 0; // 採用した行開始位相（グリッド原点の算出に使う）
  for (const ph of phases) {
    const arrays: ArrayTable[] = [];
    const maxRows = 2000;
    let rowCount = 0;
    for (
      let v = vRange.min + ph * pitch;
      v <= vRange.max && rowCount < maxRows;
      v += pitch, rowCount++
    ) {
      let u = uAnchor;
      let guard = 0;
      while (u <= uRange.max && guard < 20000) {
        guard++;
        u = snapUp(u); // 共通グリッドの列位置に揃える
        let placed = false;
        for (const c of cands) {
          const w = tableWidth(c);
          const corners = rect(u, v, w, groundDepth);
          if (rectInsideWithSetback(corners, input.polygonM, effSetback)) {
            arrays.push({
              corners,
              panelRects: buildPanelRects(u, v, c),
              cols: c,
              rows: panelsPerCol,
              panels: c * panelsPerCol,
            });
            // アレイ末尾＋横ギャップの先、次の格子列へ（隣アレイも同一グリッド上）
            u = snapUp(u + w + input.sideGapM);
            placed = true;
            break;
          }
        }
        if (!placed) u += cellPitch; // 収まらなければ次の格子列へ
      }
    }
    const panels = arrays.reduce((s, a) => s + a.panels, 0);
    if (panels > bestPanels) {
      bestPanels = panels;
      bestArrays = arrays;
      bestPhase = ph;
    }
  }
  // グリッド原点は「実際に置かれたパネル」の左下端に合わせる（手動増設が自動列と整列するように）。
  // 置けたパネルが無いときのみ走査範囲の端を使う。
  let gridU0 = uRange.min;
  let gridV0 = vRange.min + bestPhase * pitch;
  if (bestArrays.length > 0) {
    let uMin = Infinity, vMin = Infinity;
    for (const a of bestArrays)
      for (const rectP of a.panelRects)
        for (const p of rectP) {
          const u = dot(p, uUnit), v = dot(p, vUnit);
          if (u < uMin) uMin = u;
          if (v < vMin) vMin = v;
        }
    gridU0 = uMin;
    gridV0 = vMin;
  }
  const grid: LayoutGrid = {
    uUnit,
    vUnit,
    uOrigin: gridU0,
    vOrigin: gridV0,
    colPitch: rowWidth + input.colGapM,
    bandPitch: pitch,
    subDepth,
    subCount: panelsPerCol,
    panelW: rowWidth,
  };
  return { arrays: bestArrays, pitch, gap, groundDepth, grid };
}

function azimuthLabel(facingBearingDeg: number): { offset: number; label: string } {
  // 南=180 基準。+ = 西寄り, - = 東寄り
  const offset = facingBearingDeg - 180;
  if (Math.abs(offset) < 0.5) return { offset: 0, label: "真南" };
  const dir = offset > 0 ? "西" : "東";
  return { offset, label: `真南より${dir}に${Math.abs(offset).toFixed(0)}度` };
}

function buildResult(
  pattern: "A" | "B" | "ROOF",
  input: LayoutInput,
  facingBearingDeg: number,
  placed: { arrays: ArrayTable[]; pitch: number; gap: number; groundDepth: number; grid?: LayoutGrid }
): LayoutResult {
  const totalPanels = placed.arrays.reduce((s, a) => s + a.panels, 0);
  const breakdown: Record<number, number> = {};
  for (const a of placed.arrays) breakdown[a.cols] = (breakdown[a.cols] ?? 0) + 1;
  // ROOF(傾斜屋根)は真南基準の振れ角は意味を持たないため屋根なり表記とする。
  const { offset, label } =
    pattern === "ROOF"
      ? { offset: 0, label: "屋根なり配置" }
      : azimuthLabel(facingBearingDeg);
  return {
    pattern,
    mountType: input.mountType,
    arrays: placed.arrays,
    totalPanels,
    totalKw: (totalPanels * input.panel.wattW) / 1000,
    pitchM: placed.pitch,
    requiredGapM: placed.gap,
    groundDepthM: placed.groundDepth,
    facingBearingDeg,
    azimuthOffsetDeg: offset,
    azimuthOffsetLabel: label,
    colCountBreakdown: breakdown,
    grid: placed.grid,
  };
}

/**
 * アレイ構成の表記文字列（例: "2段18列×10アレイ / 2段9列×1アレイ"）。
 * 段×列の組み合わせごとに台数を集計し、列数の多い順に並べる。
 */
export function arrayComposition(result: LayoutResult): string {
  const counts = new Map<string, { rows: number; cols: number; n: number }>();
  for (const a of result.arrays) {
    const key = `${a.rows}x${a.cols}`;
    const e = counts.get(key);
    if (e) e.n++;
    else counts.set(key, { rows: a.rows, cols: a.cols, n: 1 });
  }
  return [...counts.values()]
    .sort((p, q) => q.cols - p.cols || q.rows - p.rows)
    .map((e) => `${e.rows}段${e.cols}列×${e.n}アレイ`)
    .join(" / ");
}

/** パターンA：真南固定 */
export function layoutPatternA(input: LayoutInput): LayoutResult {
  const placed = placeArrays(input, 180);
  return buildResult("A", input, 180, placed);
}

/**
 * 敷地の各辺方向から「行を辺に平行に並べる」向き（facing=辺方向±90）を候補にする。
 * 南±60°以内のものに限定し、真南(180)も必ず候補に含める。
 */
function candidateFacingsFromEdges(input: LayoutInput): number[] {
  const { n, e } = basis(input.northAngleDeg);
  const set = new Set<number>([180]);
  const poly = input.polygonM;
  for (let i = 0; i < poly.length; i++) {
    const d = { x: poly[(i + 1) % poly.length].x - poly[i].x, y: poly[(i + 1) % poly.length].y - poly[i].y };
    const eb = bearingOfVector(d, n, e);
    for (const f of [(eb + 90) % 360, (eb + 270) % 360]) {
      // 南半球側（panelが南向き寄り）に正規化し、南±60°のみ採用
      const offset = ((f - 180 + 540) % 360) - 180; // -180..180
      if (Math.abs(offset) <= 60) set.add((180 + offset + 360) % 360);
    }
  }
  return [...set];
}

/** パターンB：敷地の辺方向に沿った向きの中から総枚数最大を採用（同数なら南に近い向き） */
export function layoutPatternB(input: LayoutInput): LayoutResult {
  // 基準辺などで向きが固定されている場合はその向きで配置する。
  if (input.forcedFacing != null)
    return buildResult("B", input, input.forcedFacing, placeArrays(input, input.forcedFacing));
  let best: { facing: number; placed: ReturnType<typeof placeArrays>; panels: number } | null =
    null;
  for (const facing of candidateFacingsFromEdges(input)) {
    const placed = placeArrays(input, facing);
    const panels = placed.arrays.reduce((s, a) => s + a.panels, 0);
    if (
      !best ||
      panels > best.panels ||
      (panels === best.panels && Math.abs(facing - 180) < Math.abs(best.facing - 180))
    ) {
      best = { facing, placed, panels };
    }
  }
  return buildResult("B", input, best!.facing, best!.placed);
}

/** 屋根の各辺方向に沿った全ての向きを候補にする（南制約なし・純粋に詰め込み最大） */
function candidateFacingsRoof(input: LayoutInput): number[] {
  const { n, e } = basis(input.northAngleDeg);
  const set = new Set<number>();
  const poly = input.polygonM;
  for (let i = 0; i < poly.length; i++) {
    const d = { x: poly[(i + 1) % poly.length].x - poly[i].x, y: poly[(i + 1) % poly.length].y - poly[i].y };
    const eb = bearingOfVector(d, n, e);
    // u軸(列方向)を辺に平行 or 直交させる2通り
    set.add(((eb - 90) % 360 + 360) % 360);
    set.add((eb % 360 + 360) % 360);
  }
  if (set.size === 0) set.add(0);
  return [...set];
}

/**
 * 基準辺（数学m方向ベクトル）に「列方向(u軸)を平行」にする facing を返す。
 * これを forcedFacing に渡すと、選んだ辺にパネル列が平行・行方向は厳密に90度で配置される
 * （多角形の角が直角でなくても、選んだ辺にはきっちり揃う）。
 */
export function facingParallelToEdge(edgeDirM: Vec2, northAngleDeg: number): number {
  const { n, e } = basis(northAngleDeg);
  const b = bearingOfVector(edgeDirM, n, e); // 辺方向の方位（北=0時計回り）
  // uUnit = dirFromBearing(facing+90) を辺方向に一致させる → facing = 辺方位 - 90
  return (((b - 90) % 360) + 360) % 360;
}

/**
 * 陸屋根（合掌）：屋根なりに密に配置し、指定向き（東西/南北）の中から枚数最大を採用。
 * 合掌の傾斜面は v 軸（=dirFromBearing(facing+180)）方向。東西向き=v軸が東西寄り、
 * 南北向き=v軸が南北寄り（東西向きを90度回転した形）。
 */
export function layoutRoofSingle(input: LayoutInput): LayoutResult {
  // 向きが外部指定されている場合（複数区画の統一）は、その facing で固定配置する。
  if (input.forcedFacing != null) {
    return buildResult("ROOF", input, input.forcedFacing, placeArrays(input, input.forcedFacing));
  }
  const { n, e } = basis(input.northAngleDeg);
  const dir = input.rackDir ?? "ew";
  const isEW = (f: number): boolean => {
    const v = dirFromBearing((f + 180) % 360, n, e);
    return Math.abs(dot(v, e)) >= Math.abs(dot(v, n));
  };
  const all = candidateFacingsRoof(input);
  const filtered = all.filter((f) => (dir === "ew" ? isEW(f) : !isEW(f)));
  const cands = filtered.length > 0 ? filtered : all;
  let best: { facing: number; placed: ReturnType<typeof placeArrays>; panels: number } | null =
    null;
  for (const facing of cands) {
    const placed = placeArrays(input, facing);
    const panels = placed.arrays.reduce((s, a) => s + a.panels, 0);
    if (!best || panels > best.panels) best = { facing, placed, panels };
  }
  return buildResult("ROOF", input, best!.facing, best!.placed);
}

/**
 * 複数区画で「合掌の向き(facing)」を統一するための共通向きを決める。
 * 各区画の候補facing（rackDirで東西/南北に絞り込み）の和集合から、
 * 全区画合計の配置枚数が最大になる1つの向きを返す（区画が無ければ null）。
 * 返した facing を各区画の forcedFacing に渡せば全区画の振れ角が一致する。
 */
export function unifiedRackFacing(inputs: LayoutInput[]): number | null {
  if (inputs.length === 0) return null;
  const candSet = new Set<number>();
  const addFor = (input: LayoutInput, filterDir: boolean) => {
    const { n, e } = basis(input.northAngleDeg);
    const dir = input.rackDir ?? "ew";
    const isEW = (f: number) => {
      const v = dirFromBearing((f + 180) % 360, n, e);
      return Math.abs(dot(v, e)) >= Math.abs(dot(v, n));
    };
    for (const f of candidateFacingsRoof(input)) {
      const keep = !filterDir || (dir === "ew" ? isEW(f) : !isEW(f));
      if (keep) candSet.add(Math.round(f * 10) / 10);
    }
  };
  for (const input of inputs) addFor(input, true);
  if (candSet.size === 0) for (const input of inputs) addFor(input, false);
  let best: { facing: number; total: number } | null = null;
  for (const facing of candSet) {
    let total = 0;
    for (const input of inputs)
      total += placeArrays(input, facing).arrays.reduce((s, a) => s + a.panels, 0);
    if (!best || total > best.total) best = { facing, total };
  }
  return best ? best.facing : null;
}

/** 2値行列内の「全セルが有効な最大の長方形」を返す（ヒストグラム法） */
function maxRectangle(
  valid: boolean[][],
  rows: number,
  cols: number
): { r0: number; c0: number; h: number; w: number; area: number } {
  const heights = new Array<number>(cols).fill(0);
  let best = { r0: 0, c0: 0, h: 0, w: 0, area: 0 };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) heights[c] = valid[r][c] ? heights[c] + 1 : 0;
    const stack: number[] = [];
    for (let c = 0; c <= cols; c++) {
      const hc = c === cols ? 0 : heights[c];
      while (stack.length && heights[stack[stack.length - 1]] >= hc) {
        const top = stack.pop()!;
        const height = heights[top];
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const width = c - 1 - left + 1;
        const area = height * width;
        if (area > best.area) best = { r0: r - height + 1, c0: left, h: height, w: width, area };
      }
      stack.push(c);
    }
  }
  return best;
}

/**
 * 傾斜屋根（フラッシュ）専用：常に横置き・影離隔なしの均一グリッドで、
 * 「全セルが屋根内に収まる最大の長方形」を配置する（東西の列数が全行で揃う＝ガタつき防止）。
 * flushRows/flushCols 指定時はその枚数まで縮小（手動調整）。
 */
export function layoutFlushRoof(input: LayoutInput): LayoutResult {
  const { n, e } = basis(input.northAngleDeg);
  const { longM, shortM } = moduleDimsM(input.panel);
  // 常に横置き: 東西(u)=長辺, 南北(v)=短辺
  const panelU = longM;
  const panelV = shortM;
  const cellU = longM + input.colGapM;
  const cellV = shortM + (input.rowGapM ?? 0.02);
  const CAP = 60000; // セル数の安全弁
  // 屋根端離隔（東西/南北 個別）。未指定は一律 setbackM。
  const sEW = input.setbackEWm ?? input.setbackM;
  const sNS = input.setbackNSm ?? input.setbackM;
  const EPS = 1e-4;
  const FRAC = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

  type Best = { facing: number; u0: number; v0: number; r0: number; c0: number; h: number; w: number; count: number };
  let best: Best | null = null;

  // 【絶対条件】常に横置き：パネル長辺(u軸)が画面で水平寄り（|x|≥|y|）の向きのみ採用する。
  // u軸 = dirFromBearing(facing+90)。屋根が回転していても、より水平な屋根辺に長辺を沿わせる。
  const allFacings = candidateFacingsRoof(input);
  const uHoriz = (f: number) => {
    const u = dirFromBearing(f + 90, n, e);
    return Math.abs(u.x) >= Math.abs(u.y);
  };
  let facings = allFacings.filter(uHoriz);
  if (facings.length === 0) {
    // どの辺も水平寄りにならない場合は、最も水平に近い向きを1つ採用
    facings = [
      allFacings.reduce((b, f) =>
        Math.abs(dirFromBearing(f + 90, n, e).x) > Math.abs(dirFromBearing(b + 90, n, e).x) ? f : b
      ),
    ];
  }
  // 基準辺などで向きが固定されている場合はその向きのみを採用する。
  if (input.forcedFacing != null) facings = [input.forcedFacing];

  for (const facing of facings) {
    const uUnit = dirFromBearing(facing + 90, n, e);
    const vUnit = dirFromBearing((facing + 180) % 360, n, e);
    const toWorld = (u: number, v: number): Vec2 => add(scale(uUnit, u), scale(vUnit, v));
    const uR = projectRange(input.polygonM, uUnit);
    const vR = projectRange(input.polygonM, vUnit);
    // 1パネルを東西sEW・南北sNSだけ拡げた矩形が屋根内に収まるか（方向別離隔）
    const cellFits = (u: number, v: number): boolean => {
      const c = [
        toWorld(u - sEW, v - sNS),
        toWorld(u + panelU + sEW, v - sNS),
        toWorld(u + panelU + sEW, v + panelV + sNS),
        toWorld(u - sEW, v + panelV + sNS),
      ];
      return c.every((p) => pointInPolygon(p, input.polygonM));
    };

    // 位置候補: 屋根端に寄せる「左詰め/上詰めアンカー」＋粗い位相。
    // アンカーにより、収まる最大列数/段数を確実に拾う。
    const u0List = [uR.min + sEW + EPS, ...FRAC.map((f) => uR.min + f * cellU)];
    const v0List = [vR.min + sNS + EPS, ...FRAC.map((f) => vR.min + f * cellV)];

    for (const u0 of u0List) {
      for (const v0 of v0List) {
        const ncols = Math.floor((uR.max - u0 - panelU) / cellU) + 1;
        const nrows = Math.floor((vR.max - v0 - panelV) / cellV) + 1;
        if (ncols < 1 || nrows < 1 || ncols * nrows > CAP) continue;

        const valid: boolean[][] = [];
        for (let j = 0; j < nrows; j++) {
          const row: boolean[] = [];
          const v = v0 + j * cellV;
          for (let i = 0; i < ncols; i++) row.push(cellFits(u0 + i * cellU, v));
          valid.push(row);
        }

        // 向き・位置は「自動最大（クランプなし）」で決める。手動指定はループ後に適用。
        const r = maxRectangle(valid, nrows, ncols);
        if (r.area > 0 && (!best || r.area > best.count)) {
          best = { facing, u0, v0, r0: r.r0, c0: r.c0, h: r.h, w: r.w, count: r.area };
        }
      }
    }
  }

  // 手動指定（縦=段数, 横=列数）があれば、確定した向きの中で枚数を縮小
  if (best) {
    if (input.flushRows && input.flushRows > 0) best.h = Math.min(best.h, input.flushRows);
    if (input.flushCols && input.flushCols > 0) best.w = Math.min(best.w, input.flushCols);
    best.count = best.h * best.w;
  }

  const arrays: ArrayTable[] = [];
  let groundDepth = panelV;
  let facingUsed = 180;
  let grid: LayoutGrid | undefined;
  if (best && best.count > 0) {
    facingUsed = best.facing;
    const uUnit = dirFromBearing(best.facing + 90, n, e);
    const vUnit = dirFromBearing((best.facing + 180) % 360, n, e);
    const toWorld = (u: number, v: number): Vec2 => add(scale(uUnit, u), scale(vUnit, v));
    grid = {
      uUnit,
      vUnit,
      uOrigin: best.u0 + best.c0 * cellU,
      vOrigin: best.v0 + best.r0 * cellV,
      colPitch: cellU,
      bandPitch: cellV,
      subDepth: panelV,
      subCount: 1,
      panelW: panelU,
    };
    const panelRects: Vec2[][] = [];
    for (let j = 0; j < best.h; j++) {
      for (let i = 0; i < best.w; i++) {
        const u = best.u0 + (best.c0 + i) * cellU;
        const v = best.v0 + (best.r0 + j) * cellV;
        panelRects.push([
          toWorld(u, v),
          toWorld(u + panelU, v),
          toWorld(u + panelU, v + panelV),
          toWorld(u, v + panelV),
        ]);
      }
    }
    const u0 = best.u0 + best.c0 * cellU;
    const v0 = best.v0 + best.r0 * cellV;
    const blockW = (best.w - 1) * cellU + panelU;
    const blockV = (best.h - 1) * cellV + panelV;
    const corners = [
      toWorld(u0, v0),
      toWorld(u0 + blockW, v0),
      toWorld(u0 + blockW, v0 + blockV),
      toWorld(u0, v0 + blockV),
    ];
    arrays.push({ corners, panelRects, cols: best.w, rows: best.h, panels: best.count });
    groundDepth = blockV;
  }
  return buildResult("ROOF", input, facingUsed, { arrays, pitch: cellV, gap: 0, groundDepth, grid });
}
