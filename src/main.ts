// UI 統合とステップ進行。各モジュールを束ねて配置図生成〜DXF出力まで行う。
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
  LayoutInput,
  LayoutResult,
  ColumnMode,
  Orientation,
} from "./layout";
import { formatResultHtml } from "./summary";
import { buildDxf, downloadDxf } from "./dxfExport";
import { Vec2 } from "./geometry";

const inp = (id: string) => document.getElementById(id) as HTMLInputElement;
const sel = (id: string) => document.getElementById(id) as HTMLSelectElement;
const el = (id: string) => document.getElementById(id)!;

type Mode = "idle" | "calib" | "poly" | "koref";

const state = {
  loaded: false,
  mPerPx: 0,
  calibPts: [] as Vec2[],
  korefPts: [] as Vec2[],
  polyPts: [] as Vec2[],
  polyClosed: false,
  hover: null as Vec2 | null,
  mode: "idle" as Mode,
  lat: NaN,
  lon: NaN,
  results: null as LayoutResult[] | null,
  previewIdx: 0,
};

const view = new CanvasView(document.getElementById("canvas") as HTMLCanvasElement);
const status = (msg: string) => (el("statusbar").innerHTML = msg);

// ---------- オーバーレイ描画 ----------
view.onOverlay = (ctx) => {
  const s = view.pxScale || 1;
  const lw = 1.5 / s;

  // 配置アレイ（プレビュー）：パネル1枚ごとに罫線（線=青・塗り=水色）
  if (state.results && state.results[state.previewIdx] && state.mPerPx > 0) {
    const r = state.results[state.previewIdx];
    ctx.fillStyle = "rgba(135,206,250,0.55)"; // 水色
    ctx.strokeStyle = "#1565d8"; // 青
    ctx.lineWidth = lw * 0.8;
    for (const a of r.arrays) {
      for (const rect of a.panelRects) {
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

  // 敷地多角形
  if (state.polyPts.length > 0) {
    ctx.strokeStyle = "#ffcf3a";
    ctx.lineWidth = lw * 1.4;
    ctx.beginPath();
    state.polyPts.forEach((p, i) =>
      i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
    );
    if (state.mode === "poly" && state.hover && !state.polyClosed)
      ctx.lineTo(state.hover.x, state.hover.y);
    if (state.polyClosed) ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = "#ffcf3a";
    for (const p of state.polyPts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 / s, 0, Math.PI * 2);
      ctx.fill();
    }
  }

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
    if (state.polyClosed) {
      state.polyPts = [];
      state.polyClosed = false;
    }
    state.polyPts.push(p);
    updatePolyStatus();
    view.render();
  }
};

// ---------- 1. 読み込み ----------
inp("fileInput").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  el("loadStatus").textContent = "読み込み中...";
  try {
    const img = await loadSiteImage(file);
    view.setImage(img);
    state.loaded = true;
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
    status("敷地を多角形で囲んでください。");
    updatePolyStatus();
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

    // 座標系番号から緯度経度を逆算（2点の中点を使用）
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
    status("校正完了（縮尺・北方向・緯度経度を自動設定）。敷地を多角形で囲んでください。");
    updatePolyStatus();
  } catch (err) {
    el("calibStatus").innerHTML = `<span class="err">${(err as Error).message}</span>`;
  }
});

// ---------- 3. 敷地多角形 ----------
el("polyStart").addEventListener("click", () => {
  if (!state.loaded) return status("先に敷地図を読み込んでください。");
  state.mode = "poly";
  state.polyPts = [];
  state.polyClosed = false;
  view.render();
  status("クリックで頂点を追加し、最後に「閉じる」を押してください。");
});
el("polyUndo").addEventListener("click", () => {
  state.polyPts.pop();
  state.polyClosed = false;
  updatePolyStatus();
  view.render();
});
el("polyClose").addEventListener("click", () => {
  if (state.polyPts.length < 3) return status("頂点が3つ以上必要です。");
  state.polyClosed = true;
  state.mode = "idle";
  updatePolyStatus();
  view.render();
});

function updatePolyStatus() {
  const n = state.polyPts.length;
  if (n === 0) return (el("polyStatus").textContent = "未作図");
  let txt = `頂点 ${n} 点${state.polyClosed ? "（閉合）" : ""}`;
  if (state.polyClosed && state.mPerPx > 0) {
    const area = polygonAreaM2(state.polyPts, state.mPerPx);
    txt += ` / 面積 ${area.toLocaleString(undefined, { maximumFractionDigits: 0 })} m²`;
  }
  el("polyStatus").innerHTML = state.polyClosed
    ? `<span class="ok">${txt}</span>`
    : txt;
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
  roof_rack: "陸屋根：合掌（東西・背中合わせ）の山型。片側1枚×2スロープ、山と山＝固定離隔、横列間＝20mm。影計算・住所は不要。屋根なり1パターン。",
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
  if (r.pattern === "A") return "パターンA（真南）";
  if (r.pattern === "B") return "パターンB（敷地/屋根なり）";
  return r.mountType === "rack" ? "陸屋根（合掌・東西）" : "傾斜屋根（フラッシュ）";
}

// ---------- 7. 生成 ----------
el("generateBtn").addEventListener("click", () => {
  if (!state.loaded) return status("敷地図を読み込んでください。");
  if (state.mPerPx <= 0) return status("縮尺を校正してください。");
  if (!state.polyClosed || state.polyPts.length < 3)
    return status("敷地（屋根）多角形を閉じてください。");

  const mountType = engineMountType(); // tilted | rack | flush

  syncLatLon();
  // tilted（野立て）のみ影離隔に緯度経度が必要。rack/flush（屋根）は不要。
  if (mountType === "tilted" && (!Number.isFinite(state.lat) || !Number.isFinite(state.lon)))
    return status("緯度経度（または住所）を設定してください。");

  const panel = readPanel();
  if (!Number.isFinite(panel.widthMm) || !Number.isFinite(panel.heightMm) || !Number.isFinite(panel.wattW))
    return status("パネル寸法・出力を正しく入力してください。");
  const mode = readColumnMode();
  if (mode.kind === "specified" && mode.cols.length === 0)
    return status("指定列数を1つ以上入力してください。");

  const sun =
    mountType === "tilted" ? getWinterSunPositions(state.lat, state.lon) : [];
  if (mountType === "tilted" && sun.length === 0)
    status("注意: 冬至10-14時に太陽が地平線上に出ません（高緯度）。離隔は0で計算します。");

  const manualPitchRaw = parseFloat(inp("manualPitch").value);
  const input: LayoutInput = {
    polygonM: imgToMeters(state.polyPts, state.mPerPx),
    panel,
    orientation: sel("orientation").value as Orientation,
    tiers: parseInt(inp("tiers").value) || 1,
    columnMode: mode,
    tiltDeg: parseFloat(inp("tilt").value) || 0,
    setbackM: parseFloat(inp("setback").value) || 0,
    colGapM: parseFloat(inp("colGap").value) || 0,
    sideGapM: parseFloat(inp("sideGap").value) || 0,
    northAngleDeg: parseFloat(inp("northAngle").value) || 0,
    sun,
    manualPitchM: Number.isFinite(manualPitchRaw) ? manualPitchRaw : undefined,
    mountType,
    rowGapM: parseFloat(inp("roofRowGap").value) || 0.02,
    mountainGapM: parseFloat(inp("mountainGap").value) || 0.25,
    flushRows: parseInt(inp("flushRows").value) || undefined,
    flushCols: parseInt(inp("flushCols").value) || undefined,
    setbackEWm: parseFloat(inp("flushSetbackEW").value) || 0,
    setbackNSm: parseFloat(inp("flushSetbackNS").value) || 0,
  };

  status("配置を計算中...");
  setTimeout(() => {
    const list: LayoutResult[] =
      mountType === "tilted"
        ? [layoutPatternA(input), layoutPatternB(input)]
        : mountType === "rack"
          ? [layoutRoofSingle(input)]
          : [layoutFlushRoof(input)];
    showResults(list);
    status("生成完了: " + list.map((r) => `${patternLabel(r)}=${r.totalPanels}枚(${r.totalKw.toFixed(1)}kW)`).join(" / "));
  }, 20);
});

function showResults(list: LayoutResult[]) {
  state.results = list;
  state.previewIdx = 0;
  const area = polygonAreaM2(state.polyPts, state.mPerPx);
  el("results").innerHTML = list.map((r) => formatResultHtml(r, area)).join("");

  // プレビュー切替（結果が2つ以上のときだけ表示）
  const seg = el("previewSeg") as HTMLElement;
  if (list.length > 1) {
    seg.innerHTML = list
      .map((r, i) => `<button data-i="${i}" class="${i === 0 ? "active" : ""}">${patternLabel(r)}</button>`)
      .join("");
    seg.style.display = "flex";
    seg.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => setPreview(parseInt((b as HTMLElement).dataset.i!)))
    );
  } else {
    seg.innerHTML = "";
    seg.style.display = "none";
  }

  // DXF出力の対象選択肢
  sel("exportPattern").innerHTML = list
    .map((r, i) => `<option value="${i}">${patternLabel(r)}</option>`)
    .join("");

  view.render();
}

function setPreview(idx: number) {
  state.previewIdx = idx;
  document.querySelectorAll("#previewSeg button").forEach((b) => {
    b.classList.toggle("active", parseInt((b as HTMLElement).dataset.i!) === idx);
  });
  view.render();
}

// ---------- 8. DXF出力 ----------
el("exportDxf").addEventListener("click", () => {
  if (!state.results) return status("先に配置を生成してください。");
  const idx = parseInt(sel("exportPattern").value) || 0;
  const result = state.results[idx];
  if (!result) return status("出力対象を選択してください。");
  const siteM = imgToMeters(state.polyPts, state.mPerPx);
  const dxf = buildDxf(siteM, result, {
    northAngleDeg: parseFloat(inp("northAngle").value) || 0,
  });
  const date = new Date().toISOString().slice(0, 10);
  downloadDxf(`solar_layout_${result.pattern}_${date}.dxf`, dxf);
  status(`DXFを出力しました（${patternLabel(result)}）。`);
});
