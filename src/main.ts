// UI 統合とステップ進行。各モジュールを束ねて配置図生成〜DXF出力まで行う。
// 複数区画（最大いくつでも）を描き、各区画ごとに自動配置し、生成後は手動で
// パネルを1枚ずつ追加／削除できる。出力（PDF/DXF/結線）は全区画を統合して扱う。
import { CanvasView, ImgPoint } from "./canvas";
import { loadSiteImage } from "./imageLoader";
import { metersPerPixel, calibrateFromCoords, CoordRef } from "./calibration";
import { JPR_ORIGINS, planeToLatLon } from "./jpr";
import { imgToMeters, metersToImg, polygonAreaM2 } from "./polygon";
import { geocodeAddress } from "./geocode";
import { getWinterSunPositions } from "./solar";
import { loadHistory, saveToHistory, PanelSpec } from "./panels";
import {
  layoutPatternA,
  layoutPatternB,
  layoutRoofSingle,
  layoutFlushRoof,
  unifiedRackFacing,
  facingParallelToEdge,
  LayoutInput,
  LayoutResult,
  LayoutGrid,
  ArrayTable,
  ColumnMode,
  Orientation,
} from "./layout";
import { buildDxf, downloadDxf } from "./dxfExport";
import {
  Vec2,
  insetPolygon,
  polygonPerimeter,
  add,
  scale,
  sub,
  dot,
  normalize,
  pointInPolygon,
  distPointToSegment,
} from "./geometry";
import {
  generateStringing,
  StringingResult,
  PcsUnit,
  pcsColor,
} from "./stringing";
import { buildAndDownloadPdf } from "./pdfExport";
import {
  ProjectData,
  SavedZone,
  bitmapToDataUrl,
  loadImageFromDataUrl,
  downloadProject,
  readProjectFile,
} from "./project";

const inp = (id: string) => document.getElementById(id) as HTMLInputElement;
const sel = (id: string) => document.getElementById(id) as HTMLSelectElement;
const el = (id: string) => document.getElementById(id)!;

type Mode = "idle" | "calib" | "poly" | "koref" | "pcc" | "pole" | "padd" | "pdel" | "refedge";

/** 1区画＝1つの敷地（屋根）多角形＋その自動配置結果＋手動編集 */
interface Zone {
  polyPts: Vec2[]; // 多角形（画像px）
  polyClosed: boolean;
  result: LayoutResult | null; // 自動配置（設置タイプごとに1案）
  grid: LayoutGrid | null; // 手動増設の吸着用グリッド
  manual: Vec2[][]; // 手動追加パネル（数学m・4隅）
  deleted: string[]; // 削除キー（自動="a{ai}_{pi}" / 手動="m{idx}"）
  fenceM: Vec2[] | null; // フェンスライン（数学m・野立てのみ）
  fenceLengthM: number; // フェンス延長(周長, m)
  refEdgeIdx: number | null; // 基準辺（多角形の辺番号）。設定時はこの辺に平行配置する
}

function newZone(): Zone {
  return {
    polyPts: [],
    polyClosed: false,
    result: null,
    grid: null,
    manual: [],
    deleted: [],
    fenceM: null,
    fenceLengthM: 0,
    refEdgeIdx: null,
  };
}

const state = {
  loaded: false,
  imageName: "",
  mPerPx: 0,
  calibPts: [] as Vec2[],
  korefPts: [] as Vec2[],
  // ---- 複数区画 ----
  zones: [] as Zone[],
  activeZoneIdx: -1,
  hover: null as Vec2 | null,
  mode: "idle" as Mode,
  lat: NaN,
  lon: NaN,
  // ---- ストリング結線（全区画統合に対して引く） ----
  pccList: [] as { px: Vec2; ns: number; np: number; mppt: number }[],
  polePx: null as Vec2 | null, // 先方柱の位置（画像px）
  stringing: null as StringingResult | null,
};

const view = new CanvasView(document.getElementById("canvas") as HTMLCanvasElement);
const status = (msg: string) => (el("statusbar").innerHTML = msg);

function activeZone(): Zone | null {
  return state.activeZoneIdx >= 0 && state.activeZoneIdx < state.zones.length
    ? state.zones[state.activeZoneIdx]
    : null;
}

// ---------- 幾何ヘルパー ----------
function centroid(rect: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of rect) {
    x += p.x;
    y += p.y;
  }
  return { x: x / rect.length, y: y / rect.length };
}

/** 区画の多角形を数学m座標で返す */
function zonePolyM(z: Zone): Vec2[] {
  return imgToMeters(z.polyPts, state.mPerPx);
}

function isZoneEdited(z: Zone): boolean {
  return z.manual.length > 0 || z.deleted.length > 0;
}

/** 区画の「現在有効な」パネル矩形（自動−削除＋手動）を返す（数学m） */
function effectivePanels(z: Zone): Vec2[][] {
  const del = new Set(z.deleted);
  const out: Vec2[][] = [];
  if (z.result) {
    z.result.arrays.forEach((a, ai) =>
      a.panelRects.forEach((rect, pi) => {
        if (!del.has(`a${ai}_${pi}`)) out.push(rect);
      })
    );
  }
  z.manual.forEach((rect, mi) => {
    if (!del.has(`m${mi}`)) out.push(rect);
  });
  return out;
}

function zonePanelCount(z: Zone): number {
  return effectivePanels(z).length;
}

/** u,v 範囲からアレイ外形4隅を作る */
function boundingCorners(rects: Vec2[][], uUnit: Vec2, vUnit: Vec2): Vec2[] {
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const r of rects)
    for (const p of r) {
      const u = dot(p, uUnit), v = dot(p, vUnit);
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
  const toWorld = (u: number, v: number): Vec2 => add(scale(uUnit, u), scale(vUnit, v));
  return [toWorld(uMin, vMin), toWorld(uMax, vMin), toWorld(uMax, vMax), toWorld(uMin, vMax)];
}

/**
 * 区画の「出力・結線用」アレイ配列を返す。
 * - 手動編集なし: 自動結果の arrays をそのまま使う（従来どおりの結線品質を維持）。
 * - 手動編集あり: 有効パネルを段(v帯)ごとにまとめて再グループ化（編集後の近似結線）。
 */
function zoneEffectiveArrays(z: Zone): ArrayTable[] {
  if (!z.result) return [];
  if (!isZoneEdited(z)) return z.result.arrays;
  const rects = effectivePanels(z);
  if (rects.length === 0) return [];
  const g = z.grid;
  let uUnit: Vec2, vUnit: Vec2, subDepth: number;
  if (g) {
    uUnit = g.uUnit;
    vUnit = g.vUnit;
    subDepth = g.subDepth;
  } else if (z.result.arrays.length > 0) {
    const c = z.result.arrays[0].corners;
    uUnit = normalize(sub(c[1], c[0]));
    vUnit = normalize(sub(c[3], c[0]));
    subDepth = Math.max(z.result.groundDepthM / Math.max(1, z.result.arrays[0].rows), 0.5);
  } else {
    return rects.map((r) => ({ corners: r, panelRects: [r], cols: 1, rows: 1, panels: 1 }));
  }
  const step = Math.max(subDepth, 0.01);
  const bands = new Map<number, { rect: Vec2[]; u: number }[]>();
  for (const rect of rects) {
    const c = centroid(rect);
    const key = Math.round(dot(c, vUnit) / step);
    const arr = bands.get(key) ?? [];
    arr.push({ rect, u: dot(c, uUnit) });
    bands.set(key, arr);
  }
  const out: ArrayTable[] = [];
  for (const [, list] of [...bands.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.u - b.u);
    const panelRects = list.map((x) => x.rect);
    out.push({
      corners: boundingCorners(panelRects, uUnit, vUnit),
      panelRects,
      cols: panelRects.length,
      rows: 1,
      panels: panelRects.length,
    });
  }
  return out;
}

/** 全区画を統合した1つの LayoutResult（PDF/DXF/結線で使用）。配置がなければ null */
function combinedResult(): LayoutResult | null {
  const zs = state.zones.filter((z) => z.result);
  if (zs.length === 0) return null;
  const base = zs[0].result!;
  let arrays: ArrayTable[] = [];
  for (const z of zs) arrays = arrays.concat(zoneEffectiveArrays(z));
  const totalPanels = arrays.reduce((s, a) => s + a.panels, 0);
  const watt = parseFloat(inp("pWatt").value) || 0;
  const breakdown: Record<number, number> = {};
  for (const a of arrays) breakdown[a.cols] = (breakdown[a.cols] ?? 0) + 1;
  return {
    ...base,
    arrays,
    totalPanels,
    totalKw: (totalPanels * watt) / 1000,
    colCountBreakdown: breakdown,
  };
}

/** 全区画の多角形（画像px）と、フェンス（数学m）を配列で返す */
function allSitePolysPx(): Vec2[][] {
  return state.zones.filter((z) => z.polyClosed).map((z) => z.polyPts);
}
function allFencesM(): (Vec2[] | null)[] {
  return state.zones.filter((z) => z.result).map((z) => z.fenceM);
}
function totalFenceLengthM(): number {
  return state.zones.filter((z) => z.result).reduce((s, z) => s + z.fenceLengthM, 0);
}

// ---------- オーバーレイ描画 ----------
view.onOverlay = (ctx) => {
  const s = view.pxScale || 1;
  const lw = 1.5 / s;

  // 各区画のパネル（自動＋手動）。線=青・塗り=水色
  if (state.mPerPx > 0) {
    ctx.fillStyle = "rgba(135,206,250,0.55)";
    ctx.strokeStyle = "#1565d8";
    ctx.lineWidth = lw * 0.8;
    for (const z of state.zones) {
      for (const rect of effectivePanels(z)) {
        ctx.beginPath();
        rect.forEach((c, i) => {
          const p = metersToImg(c, state.mPerPx);
          i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // ストリング結線（全区画統合）。PCSごとに色分けし、直列順にパネル中心を結ぶ。
  if (state.stringing && state.mPerPx > 0) {
    for (const str of state.stringing.strings) {
      ctx.strokeStyle = pcsColor(str.pcsIndex).hex;
      ctx.lineWidth = 2 / s;
      ctx.beginPath();
      str.panels.forEach((p, i) => {
        const q = metersToImg(p.center, state.mPerPx);
        i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y);
      });
      ctx.stroke();
    }
  }

  // パワコン位置マーカー（□に×）を台数分
  if (state.pccList.length > 0) {
    const sz = 9 / s;
    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = 2 / s;
    ctx.font = `${12 / s}px sans-serif`;
    ctx.fillStyle = "#dc2626";
    state.pccList.forEach((u, i) => {
      const pcc = u.px;
      ctx.strokeRect(pcc.x - sz, pcc.y - sz, sz * 2, sz * 2);
      ctx.beginPath();
      ctx.moveTo(pcc.x - sz, pcc.y - sz);
      ctx.lineTo(pcc.x + sz, pcc.y + sz);
      ctx.moveTo(pcc.x + sz, pcc.y - sz);
      ctx.lineTo(pcc.x - sz, pcc.y + sz);
      ctx.stroke();
      ctx.fillText(String(i + 1), pcc.x + sz + 2 / s, pcc.y - sz);
    });
  }

  // 先方柱（灰色の塗りつぶし丸）
  if (state.polePx) {
    ctx.fillStyle = "#9ca3af";
    ctx.beginPath();
    ctx.arc(state.polePx.x, state.polePx.y, 6 / s, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `${11 / s}px sans-serif`;
    ctx.fillText("先方柱", state.polePx.x + 8 / s, state.polePx.y - 4 / s);
  }

  // フェンスライン（緑・野立てのみ）。各区画ぶん。
  if (state.mPerPx > 0) {
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = lw * 1.2;
    for (const z of state.zones) {
      if (!z.fenceM || z.fenceM.length < 2) continue;
      ctx.beginPath();
      z.fenceM.forEach((p, i) => {
        const q = metersToImg(p, state.mPerPx);
        i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y);
      });
      ctx.closePath();
      ctx.stroke();
    }
  }

  // 各区画の多角形（アクティブ区画は明るい黄、それ以外は控えめ）
  state.zones.forEach((z, idx) => {
    if (z.polyPts.length === 0) return;
    const isActive = idx === state.activeZoneIdx;
    ctx.strokeStyle = isActive ? "#ffcf3a" : "#b89321";
    ctx.lineWidth = lw * (isActive ? 1.6 : 1.2);
    ctx.beginPath();
    z.polyPts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    if (isActive && state.mode === "poly" && state.hover && !z.polyClosed)
      ctx.lineTo(state.hover.x, state.hover.y);
    if (z.polyClosed) ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = isActive ? "#ffcf3a" : "#b89321";
    for (const p of z.polyPts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 / s, 0, Math.PI * 2);
      ctx.fill();
    }
    // 基準辺のハイライト（シアン）。配置はこの辺に平行に作られる。
    if (z.polyClosed && z.refEdgeIdx != null && z.refEdgeIdx < z.polyPts.length) {
      const a = z.polyPts[z.refEdgeIdx];
      const b = z.polyPts[(z.refEdgeIdx + 1) % z.polyPts.length];
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = lw * 2.6;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    // 区画番号ラベル
    if (z.polyPts.length > 0) {
      const c = centroid(z.polyPts);
      ctx.fillStyle = isActive ? "#ffcf3a" : "#c9a93a";
      ctx.font = `bold ${14 / s}px sans-serif`;
      ctx.fillText(`区画${idx + 1}`, c.x, c.y);
    }
  });

  // 公図基準点
  if (state.korefPts.length > 0) {
    ctx.strokeStyle = "#3ad1ff";
    ctx.fillStyle = "#3ad1ff";
    ctx.lineWidth = lw * 1.4;
    state.korefPts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5 / s, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `${14 / s}px sans-serif`;
      ctx.fillText(String(i + 1), p.x + 8 / s, p.y - 8 / s);
    });
  }

  // 校正点
  if (state.calibPts.length > 0) {
    ctx.strokeStyle = "#ff5a5a";
    ctx.fillStyle = "#ff5a5a";
    ctx.lineWidth = lw * 1.4;
    if (state.calibPts.length === 2) {
      ctx.beginPath();
      ctx.moveTo(state.calibPts[0].x, state.calibPts[0].y);
      ctx.lineTo(state.calibPts[1].x, state.calibPts[1].y);
      ctx.stroke();
    }
    for (const p of state.calibPts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5 / s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
};

view.onMove = (p: ImgPoint) => {
  if (state.mode === "poly") {
    state.hover = p;
    view.render();
  }
};

view.onClick = (p: ImgPoint) => {
  if (state.mode === "calib") {
    state.calibPts.push(p);
    if (state.calibPts.length > 2) state.calibPts = [p];
    if (state.calibPts.length === 2) {
      state.mode = "idle";
      status("2点を選択しました。実距離を入力して「この距離で校正」を押してください。");
    }
    view.render();
  } else if (state.mode === "koref") {
    state.korefPts.push(p);
    if (state.korefPts.length > 2) state.korefPts = [p];
    if (state.korefPts.length === 2) {
      state.mode = "idle";
      status("2基準点を選択しました。各点のX・Y座標と座標系番号を入力して「公図座標で校正」を押してください。");
    }
    view.render();
  } else if (state.mode === "poly") {
    const z = activeZone();
    if (!z) return;
    if (z.polyClosed) {
      // 閉合済みの区画に再クリック＝この区画を引き直す（基準辺もリセット）
      z.polyPts = [];
      z.polyClosed = false;
      z.refEdgeIdx = null;
    }
    z.polyPts.push(p);
    renderZoneList();
    view.render();
  } else if (state.mode === "refedge") {
    handleSelectRefEdge(p);
  } else if (state.mode === "pcc") {
    state.pccList.push({ px: p, ...defaultPccSpec() });
    updatePccStatus();
    renderPccList();
    status(`パワコンを${state.pccList.length}台設定しました。続けてクリックで追加／「完了」で確定。`);
    view.render();
  } else if (state.mode === "pole") {
    state.polePx = p;
    state.mode = "idle";
    status("先方柱の位置を設定しました（灰色の丸で表記されます）。");
    view.render();
  } else if (state.mode === "padd") {
    handleAddPanel(p);
  } else if (state.mode === "pdel") {
    handleDeletePanel(p);
  }
};

/** 既定のPCS諸元（入力欄から） */
function defaultPccSpec(): { ns: number; np: number; mppt: number } {
  return {
    ns: parseInt(inp("defNs").value) || 1,
    np: parseInt(inp("defNp").value) || 1,
    mppt: parseInt(inp("defMppt").value) || 1,
  };
}

/** パワコンの設定状況をUIに反映 */
function updatePccStatus() {
  el("pipeStatus").innerHTML =
    state.pccList.length > 0
      ? `パワコン<b>${state.pccList.length}</b>台`
      : `<span style="color:#f59e0b">パワコン未設定</span>`;
}

/** PCSごとの諸元編集リストを描画 */
function renderPccList() {
  const host = el("pccList");
  if (state.pccList.length === 0) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = state.pccList
    .map((u, i) => {
      const cap = (u.ns || 0) * (u.np || 0) * (u.mppt || 0);
      return (
        `<div class="pcc-row" data-i="${i}" style="display:flex;align-items:center;gap:4px;margin:3px 0;font-size:12px">` +
        `<b style="width:42px">PCS${i + 1}</b>` +
        `直列<input type="number" min="1" value="${u.ns}" data-k="ns" style="width:46px"/>` +
        `並列<input type="number" min="1" value="${u.np}" data-k="np" style="width:46px"/>` +
        `MPPT<input type="number" min="1" value="${u.mppt}" data-k="mppt" style="width:42px"/>` +
        `<span style="color:#9aa">=${cap}枚</span>` +
        `<button data-del="${i}" class="secondary" style="padding:1px 6px">×</button>` +
        `</div>`
      );
    })
    .join("");
  host.querySelectorAll<HTMLInputElement>("input[data-k]").forEach((inpEl) => {
    inpEl.addEventListener("change", () => {
      const row = inpEl.closest(".pcc-row") as HTMLElement;
      const i = parseInt(row.dataset.i!);
      const k = inpEl.dataset.k as "ns" | "np" | "mppt";
      state.pccList[i][k] = parseInt(inpEl.value) || 1;
      renderPccList();
    });
  });
  host.querySelectorAll<HTMLButtonElement>("button[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.pccList.splice(parseInt(btn.dataset.del!), 1);
      updatePccStatus();
      renderPccList();
      view.render();
    });
  });
}

// ---------- 1. 読み込み ----------
inp("fileInput").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  el("loadStatus").textContent = "読み込み中...";
  try {
    const img = await loadSiteImage(file);
    view.setImage(img);
    state.loaded = true;
    state.imageName = img.fileName;
    el("loadStatus").innerHTML = `<span class="ok">読込完了: ${img.fileName} (${img.width}×${img.height}px)</span>`;
    status("縮尺を校正してください。");
  } catch (err) {
    el("loadStatus").innerHTML = `<span class="err">${(err as Error).message}</span>`;
  }
});

// ---------- 2. 校正 ----------
el("calibStart").addEventListener("click", () => {
  if (!state.loaded) return status("先に敷地図を読み込んでください。");
  state.mode = "calib";
  state.calibPts = [];
  view.render();
  status("実距離が分かる2点をクリックしてください。");
});

el("calibApply").addEventListener("click", () => {
  if (state.calibPts.length !== 2) return status("先に2点をクリックしてください。");
  const dist = parseFloat(inp("calibDist").value) * parseFloat(sel("calibUnit").value);
  try {
    state.mPerPx = metersPerPixel(state.calibPts[0], state.calibPts[1], dist);
    el("calibStatus").innerHTML = `<span class="ok">校正済: ${(state.mPerPx * 1000).toFixed(2)} mm/px</span>`;
    status("「区画を追加」を押して敷地（屋根）を多角形で囲んでください。");
    renderZoneList();
  } catch (err) {
    el("calibStatus").innerHTML = `<span class="err">${(err as Error).message}</span>`;
  }
});

// 校正方法の切替
sel("calibMethod").addEventListener("change", () => {
  const kouzu = sel("calibMethod").value === "kouzu";
  el("kouzuCalibBox").style.display = kouzu ? "block" : "none";
  el("distCalibBox").style.display = kouzu ? "none" : "block";
});

// 座標系番号の選択肢を生成
(() => {
  const z = sel("jprZone");
  z.innerHTML = Object.entries(JPR_ORIGINS)
    .map(([num, o]) => `<option value="${num}">${num}系（${o.area}）</option>`)
    .join("");
  z.value = "12"; // 北海道中央部を初期値
})();

el("korefStart").addEventListener("click", () => {
  if (!state.loaded) return status("先に敷地図を読み込んでください。");
  state.mode = "koref";
  state.korefPts = [];
  view.render();
  status("公図の基準点（右上→左下推奨）を2点クリックしてください。");
});

el("kouzuApply").addEventListener("click", () => {
  if (state.korefPts.length !== 2) return status("先に基準点を2つクリックしてください。");
  const ref1: CoordRef = {
    px: state.korefPts[0],
    xNorth: parseFloat(inp("ref1x").value),
    yEast: parseFloat(inp("ref1y").value),
  };
  const ref2: CoordRef = {
    px: state.korefPts[1],
    xNorth: parseFloat(inp("ref2x").value),
    yEast: parseFloat(inp("ref2y").value),
  };
  if (
    [ref1.xNorth, ref1.yEast, ref2.xNorth, ref2.yEast].some((v) => !Number.isFinite(v))
  )
    return status("基準点のX・Y座標を数値で入力してください。");
  try {
    const { mPerPx, northAngleDeg } = calibrateFromCoords(ref1, ref2);
    state.mPerPx = mPerPx;
    inp("northAngle").value = northAngleDeg.toFixed(2);

    const zone = parseInt(sel("jprZone").value);
    const midX = (ref1.xNorth + ref2.xNorth) / 2;
    const midY = (ref1.yEast + ref2.yEast) / 2;
    const { lat, lon } = planeToLatLon(zone, midX, midY);
    state.lat = lat;
    state.lon = lon;
    inp("lat").value = lat.toFixed(5);
    inp("lon").value = lon.toFixed(5);
    el("geoStatus").innerHTML = `<span class="ok">公図座標から自動設定: 緯度${lat.toFixed(4)}, 経度${lon.toFixed(4)}</span>`;

    el("calibStatus").innerHTML = `<span class="ok">公図座標で校正: ${(mPerPx * 1000).toFixed(2)} mm/px / 北方向 ${northAngleDeg.toFixed(1)}°</span>`;
    status("校正完了。「区画を追加」を押して敷地（屋根）を多角形で囲んでください。");
    renderZoneList();
  } catch (err) {
    el("calibStatus").innerHTML = `<span class="err">${(err as Error).message}</span>`;
  }
});

// ---------- 3. 区画（複数の敷地多角形） ----------
el("zoneAdd").addEventListener("click", () => {
  if (!state.loaded) return status("先に敷地図を読み込んでください。");
  state.zones.push(newZone());
  state.activeZoneIdx = state.zones.length - 1;
  state.mode = "poly";
  renderZoneList();
  view.render();
  status(`区画${state.zones.length}を作図中。クリックで頂点を追加し、「この区画を閉じる」を押してください。`);
});

el("polyUndo").addEventListener("click", () => {
  const z = activeZone();
  if (!z) return;
  z.polyPts.pop();
  z.polyClosed = false;
  z.refEdgeIdx = null;
  renderZoneList();
  view.render();
});

// 基準辺の選択／クリア（選択中の区画の枠線を1本クリックして向きを決める）
el("refEdgeStart").addEventListener("click", () => {
  const z = activeZone();
  if (!z || !z.polyClosed) return status("先に対象区画を一覧で選び、閉じてください。");
  state.mode = "refedge";
  status(`区画${state.activeZoneIdx + 1}の枠線を1本クリックして基準辺を選んでください（その辺にパネル列を平行にします）。`);
});
el("refEdgeClear").addEventListener("click", () => {
  const z = activeZone();
  if (!z) return;
  z.refEdgeIdx = null;
  if (state.mode === "refedge") state.mode = "idle";
  renderZoneList();
  view.render();
  status("基準辺をクリアしました（屋根なり自動に戻ります）。");
});

el("polyClose").addEventListener("click", () => {
  const z = activeZone();
  if (!z) return status("先に「区画を追加」で区画を作成してください。");
  // 始点付近で閉じた場合の余分な終点を除去し、始点＝終点として閉じる
  const pts = z.polyPts;
  if (pts.length >= 4) {
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const first = pts[0], last = pts[pts.length - 1];
    if (Math.hypot(last.x - first.x, last.y - first.y) < diag * 0.02) pts.pop();
  }
  if (z.polyPts.length < 3) return status("頂点が3つ以上必要です。");
  z.polyClosed = true;
  state.mode = "idle";
  renderZoneList();
  view.render();
  status(`区画${state.activeZoneIdx + 1}を閉じました。別の場所も囲むなら「区画を追加」、配置するなら「配置を生成」。`);
});

/** 区画一覧を描画（選択・削除） */
function renderZoneList() {
  const host = el("zoneList");
  if (state.zones.length === 0) {
    host.innerHTML = `<div class="hint">未作図（「区画を追加」で開始）</div>`;
    return;
  }
  host.innerHTML = state.zones
    .map((z, i) => {
      const active = i === state.activeZoneIdx;
      const cnt = z.result ? zonePanelCount(z) : 0;
      let info = z.polyClosed ? "閉合" : `作図中(${z.polyPts.length}点)`;
      if (z.polyClosed && state.mPerPx > 0) {
        const area = polygonAreaM2(z.polyPts, state.mPerPx);
        info += ` / ${area.toLocaleString(undefined, { maximumFractionDigits: 0 })}m²`;
      }
      if (z.result) info += ` / ${cnt}枚`;
      if (z.refEdgeIdx != null) info += " / 基準辺✓";
      return (
        `<div style="display:flex;align-items:center;gap:6px;margin:3px 0;padding:3px 5px;border-radius:4px;${active ? "background:#2d3a66" : ""}">` +
        `<button data-sel="${i}" class="secondary" style="flex:1;text-align:left;margin:0;padding:3px 6px;font-size:12px">` +
        `区画${i + 1}${active ? "（選択中）" : ""}: ${info}</button>` +
        `<button data-del="${i}" class="secondary" style="margin:0;padding:3px 8px">×</button>` +
        `</div>`
      );
    })
    .join("");
  host.querySelectorAll<HTMLButtonElement>("button[data-sel]").forEach((b) => {
    b.addEventListener("click", () => {
      state.activeZoneIdx = parseInt(b.dataset.sel!);
      renderZoneList();
      view.render();
      status(`区画${state.activeZoneIdx + 1}を選択しました。`);
    });
  });
  host.querySelectorAll<HTMLButtonElement>("button[data-del]").forEach((b) => {
    b.addEventListener("click", () => {
      const i = parseInt(b.dataset.del!);
      state.zones.splice(i, 1);
      if (state.activeZoneIdx >= state.zones.length) state.activeZoneIdx = state.zones.length - 1;
      state.stringing = null;
      el("pipeResults").innerHTML = "";
      renderZoneList();
      refreshResultsSummary();
      view.render();
    });
  });
}

// ---------- 4. ジオコーディング ----------
el("geocodeBtn").addEventListener("click", async () => {
  const addr = inp("address").value.trim();
  if (!addr) return status("住所を入力してください。");
  el("geoStatus").textContent = "取得中...";
  try {
    const r = await geocodeAddress(addr);
    state.lat = r.lat;
    state.lon = r.lon;
    inp("lat").value = r.lat.toFixed(5);
    inp("lon").value = r.lon.toFixed(5);
    el("geoStatus").innerHTML = `<span class="ok">取得: ${r.label ?? ""} (緯度${r.lat.toFixed(4)}, 経度${r.lon.toFixed(4)})</span>`;
  } catch (err) {
    el("geoStatus").innerHTML = `<span class="warn">${(err as Error).message}／緯度経度を直接入力してください。</span>`;
  }
});
const syncLatLon = () => {
  state.lat = parseFloat(inp("lat").value);
  state.lon = parseFloat(inp("lon").value);
};
inp("lat").addEventListener("input", syncLatLon);
inp("lon").addEventListener("input", syncLatLon);

// ---------- 5. パネル履歴 ----------
function refreshHistory() {
  const histSel = sel("panelHistory");
  const list = loadHistory();
  histSel.innerHTML =
    '<option value="">―</option>' +
    list
      .map(
        (p, i) =>
          `<option value="${i}">${p.maker} ${p.model} (${p.widthMm}×${p.heightMm}, ${p.wattW}W)</option>`
      )
      .join("");
}
sel("panelHistory").addEventListener("change", () => {
  const i = parseInt(sel("panelHistory").value);
  if (Number.isNaN(i)) return;
  const p = loadHistory()[i];
  if (!p) return;
  inp("pMaker").value = p.maker;
  inp("pModel").value = p.model;
  inp("pW").value = String(p.widthMm);
  inp("pH").value = String(p.heightMm);
  inp("pWatt").value = String(p.wattW);
});
el("panelSave").addEventListener("click", () => {
  const spec = readPanel();
  saveToHistory(spec);
  refreshHistory();
  status("パネル仕様を履歴に保存しました。");
});
refreshHistory();

function readPanel(): PanelSpec {
  return {
    maker: inp("pMaker").value || "(未入力)",
    model: inp("pModel").value || "(未入力)",
    widthMm: parseFloat(inp("pW").value),
    heightMm: parseFloat(inp("pH").value),
    wattW: parseFloat(inp("pWatt").value),
  };
}

// ---------- 6. 設置タイプ切替 ----------
const mountHints: Record<string, string> = {
  ground: "野立て：傾斜角＋冬至の影離隔で配置（A=真南／B=敷地なり）。",
  roof_rack: "陸屋根：合掌（背中合わせ）の山型。常に横置き・片側1枚×2スロープ。「合掌の向き」で東西向き／南北向き（90度回転）を選択。影計算・住所は不要。",
  roof_flush: "傾斜屋根：パネルを寝かせ影離隔なしで密に配置。屋根なり1パターン。傾斜角・住所は不要。",
};
/** UI選択 → エンジンの設置方式 */
function engineMountType(): "tilted" | "rack" | "flush" {
  const v = sel("mountType").value;
  return v === "roof_flush" ? "flush" : v === "roof_rack" ? "rack" : "tilted";
}
sel("mountType").addEventListener("change", () => {
  el("mountHint").textContent = mountHints[sel("mountType").value] ?? "";
  const mt = engineMountType();
  el("roofFlushBox").style.display = mt === "flush" ? "block" : "none";
  el("roofRackBox").style.display = mt === "rack" ? "block" : "none";
  el("groundPatternBox").style.display = mt === "tilted" ? "block" : "none";
  // 陸屋根はパネル向き（縦/横）の代わりに「合掌の向き」を使うため、向き・段数の行を隠す。
  el("orientTierRow").style.display = mt === "rack" ? "none" : "flex";
});

// ---------- 6. 列数モード切替 ----------
sel("colMode").addEventListener("change", () => {
  const spec = sel("colMode").value === "specified";
  el("specColBox").style.display = spec ? "block" : "none";
  el("maxColBox").style.display = spec ? "none" : "block";
});

function readColumnMode(): ColumnMode {
  if (sel("colMode").value === "specified") {
    const cols = ["spec1", "spec2", "spec3"]
      .map((id) => parseInt(inp(id).value))
      .filter((v) => Number.isFinite(v) && v >= 1);
    return { kind: "specified", cols };
  }
  return { kind: "max", maxCols: parseInt(inp("maxCols").value) || 1 };
}

function patternLabel(r: LayoutResult): string {
  if (r.pattern === "A") return "真南設置";
  if (r.pattern === "B") return "敷地なり";
  return r.mountType === "rack" ? "陸屋根（合掌）" : "傾斜屋根（フラッシュ）";
}

/** 共有設定から、指定多角形（数学m）に対する LayoutInput を組む */
function buildLayoutInput(polygonM: Vec2[], sun: ReturnType<typeof getWinterSunPositions>): LayoutInput {
  const manualPitchRaw = parseFloat(inp("manualPitch").value);
  return {
    polygonM,
    panel: readPanel(),
    orientation: sel("orientation").value as Orientation,
    rackDir: (sel("rackDir").value as "ew" | "ns") || "ew",
    tiers: parseInt(inp("tiers").value) || 1,
    columnMode: readColumnMode(),
    tiltDeg: parseFloat(inp("tilt").value) || 0,
    setbackM: parseFloat(inp("setback").value) || 0,
    colGapM: parseFloat(inp("colGap").value) || 0,
    sideGapM: parseFloat(inp("sideGap").value) || 0,
    northAngleDeg: parseFloat(inp("northAngle").value) || 0,
    sun,
    manualPitchM: Number.isFinite(manualPitchRaw) ? manualPitchRaw : undefined,
    mountType: engineMountType(),
    rowGapM: parseFloat(inp("roofRowGap").value) || 0.02,
    mountainGapM: parseFloat(inp("mountainGap").value) || 0.25,
    flushRows: parseInt(inp("flushRows").value) || undefined,
    flushCols: parseInt(inp("flushCols").value) || undefined,
    setbackEWm: parseFloat(inp("flushSetbackEW").value) || 0,
    setbackNSm: parseFloat(inp("flushSetbackNS").value) || 0,
  };
}

// ---------- 7. 生成（全区画） ----------
el("generateBtn").addEventListener("click", () => {
  if (!state.loaded) return status("敷地図を読み込んでください。");
  if (state.mPerPx <= 0) return status("縮尺を校正してください。");
  const closed = state.zones.filter((z) => z.polyClosed && z.polyPts.length >= 3);
  if (closed.length === 0) return status("区画を1つ以上、多角形で閉じてください。");

  const mountType = engineMountType();
  syncLatLon();
  if (mountType === "tilted" && (!Number.isFinite(state.lat) || !Number.isFinite(state.lon)))
    return status("野立ては緯度経度（または住所）を設定してください。");

  const panel = readPanel();
  if (!Number.isFinite(panel.widthMm) || !Number.isFinite(panel.heightMm) || !Number.isFinite(panel.wattW))
    return status("パネル寸法・出力を正しく入力してください。");
  const mode = readColumnMode();
  if (mode.kind === "specified" && mode.cols.length === 0)
    return status("指定列数を1つ以上入力してください。");

  const sun = mountType === "tilted" ? getWinterSunPositions(state.lat, state.lon) : [];
  if (mountType === "tilted" && sun.length === 0)
    status("注意: 冬至10-14時に太陽が地平線上に出ません（高緯度）。離隔は0で計算します。");

  const groundPat = sel("groundPattern").value; // "B" | "A"
  status("配置を計算中...");
  setTimeout(() => {
    const targets = state.zones.filter((z) => z.polyClosed && z.polyPts.length >= 3);
    const inputs = targets.map((z) => buildLayoutInput(zonePolyM(z), sun));
    // 複数区画の陸屋根は、既定では「区画ごと（屋根なり）」。
    // 「全区画で統一」を選んだ場合のみ、東西の振れ（合掌の向き）を全区画で統一する。
    let unifiedFacing: number | null = null;
    if (mountType === "rack" && inputs.length > 1 && sel("rackUnify").value === "unify") {
      unifiedFacing = unifiedRackFacing(inputs);
    }
    const northDeg = parseFloat(inp("northAngle").value) || 0;
    targets.forEach((z, i) => {
      const input = inputs[i];
      // 屋根モードで基準辺が設定されていれば最優先（その辺に平行配置）。次に全区画統一。
      const useRefEdge =
        (mountType === "rack" || mountType === "flush") &&
        z.refEdgeIdx != null &&
        z.refEdgeIdx < z.polyPts.length;
      if (useRefEdge) {
        const pm = zonePolyM(z);
        const a = pm[z.refEdgeIdx!];
        const b = pm[(z.refEdgeIdx! + 1) % pm.length];
        input.forcedFacing = facingParallelToEdge(sub(b, a), northDeg);
      } else if (mountType === "rack" && unifiedFacing != null) {
        input.forcedFacing = unifiedFacing;
      }
      const res =
        mountType === "tilted"
          ? groundPat === "A"
            ? layoutPatternA(input)
            : layoutPatternB(input)
          : mountType === "rack"
            ? layoutRoofSingle(input)
            : layoutFlushRoof(input);
      z.result = res;
      z.grid = res.grid ?? null;
      z.fenceM =
        mountType === "tilted" && input.setbackM > 0
          ? insetPolygon(input.polygonM, input.setbackM)
          : null;
      z.fenceLengthM = z.fenceM ? polygonPerimeter(z.fenceM) : 0;
      // 既存の手動編集は保持（同条件の再生成ならグリッドが一致するため整合する）
    });
    // 配置が変わったので結線はクリア（再生成を促す）
    state.stringing = null;
    el("pipeResults").innerHTML = "";
    refreshResultsSummary();
    renderZoneList();
    view.render();
    const fence = totalFenceLengthM();
    const total = state.zones.reduce((s, z) => s + (z.result ? zonePanelCount(z) : 0), 0);
    status(
      `生成完了: ${closed.length}区画 / 合計 ${total}枚` +
        (fence > 0 ? ` ／ フェンス延長 計${fence.toFixed(1)}m` : "")
    );
  }, 20);
});

/** パネルの向き（facing方位）の、最寄り90°基準からの振れ角（度・(-45,45]）。区画間で一致＝角度統一。 */
function gridAngleDev(r: LayoutResult): number {
  let d = ((r.facingBearingDeg % 90) + 90) % 90;
  if (d > 45) d -= 90;
  return d;
}

/** 結果サマリ（区画別＋合計）を描画 */
function refreshResultsSummary() {
  const zs = state.zones.filter((z) => z.result);
  if (zs.length === 0) {
    el("results").innerHTML = "";
    return;
  }
  const watt = parseFloat(inp("pWatt").value) || 0;
  let totalPanels = 0;
  let body = "";
  const devs: number[] = [];
  state.zones.forEach((z, i) => {
    if (!z.result) return;
    const cnt = zonePanelCount(z);
    totalPanels += cnt;
    const kw = (cnt * watt) / 1000;
    const area = polygonAreaM2(z.polyPts, state.mPerPx);
    const dev = gridAngleDev(z.result);
    devs.push(dev);
    const edited = isZoneEdited(z)
      ? ` <span class="warn">(手動調整あり)</span>`
      : "";
    body +=
      `<div class="result-card"><h3>区画${i + 1}：${patternLabel(z.result)}</h3>` +
      `<div>パネル: <b>${cnt.toLocaleString()}枚</b> / <b>${kw.toFixed(1)}kW</b>${edited}</div>` +
      `<div>配置角度: 基準から <b>${dev >= 0 ? "+" : ""}${dev.toFixed(1)}°</b></div>` +
      `<div>面積: ${area.toLocaleString(undefined, { maximumFractionDigits: 0 })} m²</div>` +
      `</div>`;
  });
  const totalKw = (totalPanels * watt) / 1000;
  // 配置角度の表示。「全区画で統一」選択時だけ一致チェック（✓/⚠）、
  // 既定（区画ごと=屋根なり）では区画ごとに角度が異なるのが正常なので中立表示にする。
  let angleLine = "";
  if (devs.length > 1) {
    const span = Math.max(...devs) - Math.min(...devs);
    const unified = engineMountType() === "rack" && sel("rackUnify").value === "unify";
    if (unified) {
      angleLine =
        span < 0.05
          ? `<div class="ok">東西の振れ: 全区画一致 ✓（基準から${devs[0] >= 0 ? "+" : ""}${devs[0].toFixed(1)}°）</div>`
          : `<div class="warn">⚠ 統一が効いていません（差 ${span.toFixed(1)}°）。再生成してください。</div>`;
    } else {
      angleLine = `<div class="hint">配置角度は区画ごと（屋根なり）。各区画は自分の屋根の辺に沿って配置しています。</div>`;
    }
  }
  const head =
    `<div class="result-card" style="border-color:#3a6df0">` +
    `<h3>合計（${zs.length}区画）</h3>` +
    `<div>パネル総数: <b>${totalPanels.toLocaleString()}枚</b> / <b>${totalKw.toFixed(1)}kW</b></div>` +
    angleLine +
    `</div>`;
  el("results").innerHTML = head + body;
}

// ---------- 7.5 手動でパネル調整 ----------
el("panelAddMode").addEventListener("click", () => {
  if (state.zones.every((z) => !z.result)) return status("先に「配置を生成」してください。");
  if (!activeZone()?.result)
    return status("対象区画を一覧から選択してください（その区画にパネルを追加します）。");
  state.mode = "padd";
  setManualButtons();
  status(`【追加モード】区画${state.activeZoneIdx + 1}の空きマスをクリックでパネル追加。`);
});
el("panelDelMode").addEventListener("click", () => {
  if (state.zones.every((z) => !z.result)) return status("先に「配置を生成」してください。");
  if (!activeZone()?.result)
    return status("対象区画を一覧から選択してください（その区画のパネルを削除します）。");
  state.mode = "pdel";
  setManualButtons();
  status(`【削除モード】区画${state.activeZoneIdx + 1}のパネルをクリックで削除。`);
});
el("manualDone").addEventListener("click", () => {
  state.mode = "idle";
  setManualButtons();
  status("手動編集を終了しました。");
});
el("manualReset").addEventListener("click", () => {
  const z = activeZone();
  if (!z) return status("対象区画を選択してください。");
  z.manual = [];
  z.deleted = [];
  state.stringing = null;
  el("pipeResults").innerHTML = "";
  refreshResultsSummary();
  renderZoneList();
  view.render();
  status(`区画${state.activeZoneIdx + 1}の手動編集をリセットしました。`);
});

/** 追加/削除モードのボタン見た目を更新 */
function setManualButtons() {
  el("panelAddMode").classList.toggle("active-mode", state.mode === "padd");
  el("panelDelMode").classList.toggle("active-mode", state.mode === "pdel");
}

/** クリック地点（画像px）にグリッド吸着でパネルを1枚追加 */
function handleAddPanel(p: ImgPoint) {
  const z = activeZone();
  if (!z || !z.result || !z.grid) return status("対象区画を生成してから追加してください。");
  const click = imgToMeters([p], state.mPerPx)[0];
  const rect = snapPanelRect(z.grid, click, zonePolyM(z));
  if (!rect) return status("この位置には配置できません（区画の外側です）。");
  if (effectivePanels(z).some((r) => pointInPolygon(centroid(rect), r)))
    return status("すでにパネルがあります。");
  z.manual.push(rect);
  onPanelsChanged();
  status(`区画${state.activeZoneIdx + 1}にパネルを追加（計${zonePanelCount(z)}枚）。続けてクリックで追加。`);
}

/** クリック地点のパネルを削除（自動・手動どちらも） */
function handleDeletePanel(p: ImgPoint) {
  const z = activeZone();
  if (!z) return;
  const click = imgToMeters([p], state.mPerPx)[0];
  const key = findPanelKeyAt(z, click);
  if (!key) return status("パネルがありません（パネルの上をクリックしてください）。");
  if (!z.deleted.includes(key)) z.deleted.push(key);
  onPanelsChanged();
  status(`区画${state.activeZoneIdx + 1}のパネルを削除（計${zonePanelCount(z)}枚）。続けてクリックで削除。`);
}

/** クリック地点に最も近い区画の辺を基準辺に設定する */
function handleSelectRefEdge(p: ImgPoint) {
  const z = activeZone();
  if (!z || !z.polyClosed || z.polyPts.length < 3)
    return status("先に対象区画を閉じてから基準辺を選んでください。");
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < z.polyPts.length; i++) {
    const a = z.polyPts[i];
    const b = z.polyPts[(i + 1) % z.polyPts.length];
    const d = distPointToSegment(p, a, b);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  z.refEdgeIdx = best;
  state.mode = "idle";
  renderZoneList();
  view.render();
  status(
    `区画${state.activeZoneIdx + 1}の基準辺を設定しました（シアンの辺）。配置はこの辺に平行になります。「配置を生成」で反映。`
  );
}

/** クリック地点にあるパネルのキー（"a{ai}_{pi}" / "m{idx}"）を返す */
function findPanelKeyAt(z: Zone, c: Vec2): string | null {
  const del = new Set(z.deleted);
  if (z.result) {
    for (let ai = 0; ai < z.result.arrays.length; ai++) {
      const rects = z.result.arrays[ai].panelRects;
      for (let pi = 0; pi < rects.length; pi++) {
        const k = `a${ai}_${pi}`;
        if (!del.has(k) && pointInPolygon(c, rects[pi])) return k;
      }
    }
  }
  for (let mi = 0; mi < z.manual.length; mi++) {
    const k = `m${mi}`;
    if (!del.has(k) && pointInPolygon(c, z.manual[mi])) return k;
  }
  return null;
}

/** グリッドへ吸着した1パネルの矩形を返す（区画外なら null） */
function snapPanelRect(g: LayoutGrid, click: Vec2, polyM: Vec2[]): Vec2[] | null {
  const u = dot(click, g.uUnit);
  const v = dot(click, g.vUnit);
  const col = Math.round((u - g.uOrigin - g.panelW / 2) / g.colPitch);
  const uLeft = g.uOrigin + col * g.colPitch;
  const toWorld = (uu: number, vv: number): Vec2 => add(scale(g.uUnit, uu), scale(g.vUnit, vv));
  const bandEst = Math.round((v - g.vOrigin) / g.bandPitch);
  let best: { rect: Vec2[]; d: number } | null = null;
  for (let band = bandEst - 1; band <= bandEst + 1; band++) {
    for (let s = 0; s < g.subCount; s++) {
      const vBottom = g.vOrigin + band * g.bandPitch + s * g.subDepth;
      const vCenter = vBottom + g.subDepth / 2;
      const d = Math.abs(vCenter - v);
      if (!best || d < best.d) {
        best = {
          d,
          rect: [
            toWorld(uLeft, vBottom),
            toWorld(uLeft + g.panelW, vBottom),
            toWorld(uLeft + g.panelW, vBottom + g.subDepth),
            toWorld(uLeft, vBottom + g.subDepth),
          ],
        };
      }
    }
  }
  if (!best) return null;
  // 手動追加は「セル中心が区画内」なら許可（端の列をそろえやすくする。多少のはみ出しは手動判断に委ねる）。
  if (!pointInPolygon(centroid(best.rect), polyM)) return null;
  return best.rect;
}

/** パネル集合が変わったときの共通処理（結線クリア＋再描画） */
function onPanelsChanged() {
  state.stringing = null;
  el("pipeResults").innerHTML = "";
  refreshResultsSummary();
  renderZoneList();
  view.render();
}

// ---------- 8. DXF出力 ----------
el("exportDxf").addEventListener("click", () => {
  const result = combinedResult();
  if (!result) return status("先に配置を生成してください。");
  const includeStr =
    !!(document.getElementById("dxfIncludePipe") as HTMLInputElement)?.checked && !!state.stringing;
  const dxf = buildDxf(allSitePolysPx().map((poly) => imgToMeters(poly, state.mPerPx)), result, {
    northAngleDeg: parseFloat(inp("northAngle").value) || 0,
    stringing: includeStr ? state.stringing! : undefined,
    fences: allFencesM(),
    fenceLengthM: totalFenceLengthM(),
    moduleLabel: moduleLabel(),
    pole: state.polePx ? imgToMeters([state.polePx], state.mPerPx)[0] : null,
  });
  const date = new Date().toISOString().slice(0, 10);
  downloadDxf(`solar_layout_${date}.dxf`, dxf);
  status(`DXFを出力しました（${state.zones.filter((z) => z.result).length}区画${includeStr ? " + 結線" : ""}）。`);
});

// ========== 9. 結線 ==========
el("pccStart").addEventListener("click", () => {
  if (!state.loaded) return status("先に敷地図を読み込んでください。");
  state.mode = "pcc";
  status("パワコン位置を図面上でクリックしてください（複数台は続けてクリック）。");
});
el("pccDone").addEventListener("click", () => {
  state.mode = "idle";
  updatePccStatus();
  status(`パワコン ${state.pccList.length}台で確定しました。`);
});
el("pccClear").addEventListener("click", () => {
  state.pccList = [];
  state.mode = "idle";
  updatePccStatus();
  renderPccList();
  view.render();
  status("パワコンをクリアしました。");
});

el("poleStart").addEventListener("click", () => {
  if (!state.loaded) return status("先に敷地図を読み込んでください。");
  state.mode = "pole";
  status("先方柱の位置を図面上でクリックしてください。");
});
el("poleClear").addEventListener("click", () => {
  state.polePx = null;
  state.mode = "idle";
  view.render();
  status("先方柱をクリアしました。");
});

/** モジュール型番ラベル（メーカー＋型式。両方未入力なら null） */
function moduleLabel(): string | null {
  const s = `${inp("pMaker").value} ${inp("pModel").value}`.trim();
  return s ? s : null;
}

el("pipeGenerate").addEventListener("click", () => {
  const layout = combinedResult();
  if (!layout) return status("先にパネル配置を生成してください。");
  if (state.mPerPx <= 0) return status("縮尺が未校正です。");
  if (state.pccList.length === 0) return status("パワコン位置を1台以上指定してください。");

  const pccs: PcsUnit[] = state.pccList.map((u) => ({
    pos: imgToMeters([u.px], state.mPerPx)[0],
    ns: u.ns,
    np: u.np,
    mppt: u.mppt,
  }));

  state.stringing = generateStringing({ layout, pccs });
  showStringingResults();
  status(
    `結線生成完了: ${state.stringing.ns}直列 / ${state.stringing.totalStrings}ストリング / PCS${state.stringing.pccSummaries.length}台` +
      (state.stringing.warnings.length ? ` ⚠${state.stringing.warnings.length}件` : "")
  );
});

function showStringingResults() {
  const p = state.stringing;
  if (!p) return;
  const rows = p.pccSummaries
    .map((s, i) => {
      const col = pcsColor(i).hex;
      return (
        `<tr><td><span style="display:inline-block;width:10px;height:10px;background:${col};border-radius:2px;margin-right:4px"></span>PCS${i + 1}</td>` +
        `<td>${s.strings}回路</td><td>${s.panels}枚</td>` +
        `<td style="color:#9aa">${s.capacityStrings}回路</td></tr>`
      );
    })
    .join("");
  const warn = p.warnings.length
    ? `<div style="color:#f59e0b;margin-top:6px">⚠ ${p.warnings.join("<br>⚠ ")}</div>`
    : "";
  el("pipeResults").innerHTML =
    `<div class="result-card"><h3>DCストリング結線</h3>` +
    `<div>直列数: <b>${p.ns}</b>　総ストリング: <b>${p.totalStrings}</b></div>` +
    `<table style="width:100%;margin-top:6px;font-size:12px;border-collapse:collapse">` +
    `<tr style="color:#9aa"><th align="left">PCS</th><th align="left">回路数</th><th align="left">枚数</th><th align="left">容量</th></tr>` +
    rows +
    `</table>${warn}</div>`;
  view.render();
}

// ---------- 10. PDF出力 ----------
el("exportPdf").addEventListener("click", async () => {
  const result = combinedResult();
  if (!result) return status("先にパネル配置を生成してください。");
  const includeStr =
    !!(document.getElementById("pdfIncludePipe") as HTMLInputElement)?.checked && !!state.stringing;
  status("PDFを生成中...");
  try {
    const date = new Date().toISOString().slice(0, 10);
    await buildAndDownloadPdf(
      {
        background: view.imageCanvas,
        sitePolysPx: allSitePolysPx(),
        result,
        stringing: includeStr ? state.stringing : null,
        fencesM: allFencesM(),
        fenceLengthM: totalFenceLengthM(),
        moduleLabel: moduleLabel(),
        poleM: state.polePx ? imgToMeters([state.polePx], state.mPerPx)[0] : null,
        mPerPx: state.mPerPx,
        title: `太陽光配置図（${state.zones.filter((z) => z.result).length}区画）${includeStr ? " + ストリング結線" : ""}  ${date}`,
      },
      `solar_plan_${date}.pdf`
    );
    status("PDFを出力しました。");
  } catch (err) {
    status(`<span class="err">PDF出力エラー: ${(err as Error).message}</span>`);
  }
});

// ========== 11. プロジェクト保存／再開 ==========
const PROJ_INPUT_IDS = [
  "calibMethod", "calibDist", "calibUnit",
  "ref1x", "ref1y", "ref2x", "ref2y", "jprZone",
  "address", "lat", "lon",
  "pMaker", "pModel", "pW", "pH", "pWatt",
  "mountType", "orientation", "rackDir", "rackUnify", "tiers", "colMode", "maxCols",
  "spec1", "spec2", "spec3",
  "tilt", "setback", "colGap", "sideGap", "northAngle", "manualPitch",
  "roofRowGap", "flushSetbackEW", "flushSetbackNS", "flushRows", "flushCols",
  "mountainGap", "groundPattern",
  "defNs", "defNp", "defMppt",
];
const PROJ_CHECK_IDS = ["dxfIncludePipe", "pdfIncludePipe"];

function gatherProject(): ProjectData {
  const inputs: Record<string, string> = {};
  for (const id of PROJ_INPUT_IDS) {
    const e = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (e) inputs[id] = e.value;
  }
  const checks: Record<string, boolean> = {};
  for (const id of PROJ_CHECK_IDS) {
    const e = document.getElementById(id) as HTMLInputElement | null;
    if (e) checks[id] = e.checked;
  }
  const zones: SavedZone[] = state.zones.map((z) => ({
    polyPts: z.polyPts,
    polyClosed: z.polyClosed,
    manual: z.manual,
    deleted: z.deleted,
    refEdgeIdx: z.refEdgeIdx,
  }));
  return {
    version: 2,
    savedAt: new Date().toISOString(),
    imageDataUrl: view.imageCanvas ? bitmapToDataUrl(view.imageCanvas) : null,
    imageFileName: state.imageName,
    mPerPx: state.mPerPx,
    lat: Number.isFinite(state.lat) ? state.lat : null,
    lon: Number.isFinite(state.lon) ? state.lon : null,
    zones,
    pccList: state.pccList,
    polePx: state.polePx,
    inputs,
    checks,
  };
}

async function applyProject(data: ProjectData) {
  if (data.imageDataUrl) {
    const img = await loadImageFromDataUrl(data.imageDataUrl, data.imageFileName || "(保存済み画像)");
    view.setImage(img);
    state.loaded = true;
    state.imageName = img.fileName;
    el("loadStatus").innerHTML = `<span class="ok">プロジェクトから復元: ${img.fileName} (${img.width}×${img.height}px)</span>`;
  }
  for (const [id, val] of Object.entries(data.inputs)) {
    const e = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (e) e.value = val;
  }
  for (const [id, on] of Object.entries(data.checks ?? {})) {
    const e = document.getElementById(id) as HTMLInputElement | null;
    if (e) e.checked = on;
  }
  sel("mountType").dispatchEvent(new Event("change"));
  sel("colMode").dispatchEvent(new Event("change"));
  sel("calibMethod").dispatchEvent(new Event("change"));

  state.mPerPx = data.mPerPx || 0;
  state.lat = data.lat ?? NaN;
  state.lon = data.lon ?? NaN;
  // 区画の復元：v2 は zones、v1（旧）は単一 polyPts を1区画へ変換
  if (data.zones && data.zones.length > 0) {
    state.zones = data.zones.map((sz) => {
      const z = newZone();
      z.polyPts = sz.polyPts ?? [];
      z.polyClosed = !!sz.polyClosed;
      z.manual = sz.manual ?? [];
      z.deleted = sz.deleted ?? [];
      z.refEdgeIdx = sz.refEdgeIdx ?? null;
      return z;
    });
  } else if (data.polyPts && data.polyPts.length > 0) {
    const z = newZone();
    z.polyPts = data.polyPts;
    z.polyClosed = !!data.polyClosed;
    state.zones = [z];
  } else {
    state.zones = [];
  }
  state.activeZoneIdx = state.zones.length - 1;
  state.pccList = data.pccList ?? [];
  state.polePx = data.polePx ?? null;
  state.calibPts = [];
  state.korefPts = [];
  state.stringing = null;
  state.mode = "idle";
  el("results").innerHTML = "";
  el("pipeResults").innerHTML = "";
  el("calibStatus").innerHTML =
    state.mPerPx > 0
      ? `<span class="ok">校正済: ${(state.mPerPx * 1000).toFixed(2)} mm/px（プロジェクトから復元）</span>`
      : "未校正";
  renderZoneList();
  updatePccStatus();
  renderPccList();
  setManualButtons();
  view.render();
  status("プロジェクトを読み込みました。「配置を生成」を押すと各区画を再配置します（手動追加パネルは保持されます）。");
}

el("projSave").addEventListener("click", () => {
  if (!state.loaded) return status("保存する内容がありません。先に敷地図を読み込んでください。");
  const date = new Date().toISOString().slice(0, 10);
  const base = (state.imageName || "project").replace(/\.[^.]+$/, "");
  downloadProject(gatherProject(), `${base}_${date}.solarproj.json`);
  status("プロジェクトを保存しました（.solarproj.json）。");
});

inp("projLoad").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  status("プロジェクトを読み込み中...");
  try {
    await applyProject(await readProjectFile(file));
  } catch (err) {
    status(`<span class="err">読み込みエラー: ${(err as Error).message}</span>`);
  } finally {
    (e.target as HTMLInputElement).value = "";
  }
});

// 初期表示
renderZoneList();
