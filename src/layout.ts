// 野立て太陽光の自動配置エンジン。
// 入力はすべて「数学座標・メートル(y上)」。パターンA(真南優先)とB(敷地なり最大枚数)を生成する。
import {
  Vec2,
  add,
  scale,
  dot,
  projectRange,
  rectInsideWithSetback,
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
}

export interface ArrayTable {
  corners: Vec2[]; // アレイ外形の4隅（数学m）
  panelRects: Vec2[][]; // パネル1枚ごとの4隅（数学m）
  cols: number;
  rows: number; // = 段数
  panels: number;
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
}

const deg2rad = (d: number) => (d * Math.PI) / 180;

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
): { arrays: ArrayTable[]; pitch: number; gap: number; groundDepth: number } {
  const { n, e } = basis(input.northAngleDeg);
  const tilt = deg2rad(input.tiltDeg);
  const mode = input.mountType; // "tilted" | "rack" | "flush"
  const { slopeLen, rowWidth } = perPanelDims(input.panel, input.orientation);

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
  let buildPanelRects: (u0: number, v0: number, c: number) => Vec2[][];

  if (mode === "rack") {
    // 陸屋根・合掌（東西背中合わせ）: 片側1枚×2スロープ。各スロープの投影 = slopeLen*cos(tilt)。
    const sd = slopeLen * Math.cos(tilt);
    groundDepth = 2 * sd;
    panelsPerCol = 2;
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
  const probeStep = rowWidth + input.colGapM; // 何も置けない時の走査ステップ

  const arrays: ArrayTable[] = [];
  const maxRows = 2000;
  let rowCount = 0;
  for (let v = vRange.min; v <= vRange.max && rowCount < maxRows; v += pitch, rowCount++) {
    let u = uRange.min;
    let guard = 0;
    while (u <= uRange.max && guard < 5000) {
      guard++;
      let placed = false;
      for (const c of cands) {
        const w = tableWidth(c);
        const corners = rect(u, v, w, groundDepth);
        if (rectInsideWithSetback(corners, input.polygonM, input.setbackM)) {
          arrays.push({
            corners,
            panelRects: buildPanelRects(u, v, c),
            cols: c,
            rows: panelsPerCol,
            panels: c * panelsPerCol,
          });
          u += w + input.sideGapM;
          placed = true;
          break;
        }
      }
      if (!placed) u += probeStep;
    }
  }
  return { arrays, pitch, gap, groundDepth };
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
  placed: ReturnType<typeof placeArrays>
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
  };
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

/** 屋根（傾斜屋根フラッシュ／陸屋根合掌）：屋根なりに密に配置し、枚数最大の向きを採用 */
export function layoutRoofSingle(input: LayoutInput): LayoutResult {
  let best: { facing: number; placed: ReturnType<typeof placeArrays>; panels: number } | null =
    null;
  for (const facing of candidateFacingsRoof(input)) {
    const placed = placeArrays(input, facing);
    const panels = placed.arrays.reduce((s, a) => s + a.panels, 0);
    if (!best || panels > best.panels) best = { facing, placed, panels };
  }
  return buildResult("ROOF", input, best!.facing, best!.placed);
}
