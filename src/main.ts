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
import { Vec2, insetPolygon, polygonPerimeter } from "./geometry";
import {
  generateStringing,
  StringingResult,
  PcsUnit,
  pcsColor,
} from "./stringing";
import { buildAndDownloadPdf } from "./pdfExport";
import {
  ProjectData,
  bitmapToDataUrl,
  loadImageFromDataUrl,
  downloadProject,
  readProjectFile,
} from "./project";

const inp = (id: string) => document.getElementById(id) as HTMLInputElement;
const sel = (id: string) => document.getElementById(id) as HTMLSelectElement;
const el = (id: string) => document.getElementById(id)!;

type Mode = "idle" | "calib" | "poly" | "koref" | "pcc" | "pole";

const state = {
  loaded: false,
  imageName: "",
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
  // ---- ストリング結線 ----
  // パワコン（画像px位置＋諸元）。直列/並列/MPPTは台ごとに保持。
  pccList: [] as { px: Vec2; ns: number; np: number; mppt: number }[],
  polePx: null as Vec2 | null, // 先方柱の位置（画像px）
  stringing: null as StringingResult | null,
  // フェンスライン（数学m・閉ポリゴン／野立てのみ。境界離隔ぶん内側）。
  fencePolyM: null as Vec2[] | null,
  fenceLengthM: 0, // フェンス延長(周長, m)
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

  // ストリング結線（プレビュー）。PCSごとに色分けし、直列順にパネル中心を結ぶ。
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

  // フェンスライン（緑・野立てのみ）。境界離隔ぶん内側の閉ポリゴン。
  if (state.fencePolyM && state.fencePolyM.length >= 2 && state.mPerPx > 0) {
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = lw * 1.2;
    ctx.beginPath();
    state.fencePolyM.forEach((p, i) => {
      const q = metersToImg(p, state.mPerPx);
      i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y);
    });
    ctx.closePath();
    ctx.stroke();
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
  } else if (state.mode === "pcc") {
    // クリックごとにパワコンを追加（複数台対応）。既定の直列/並列/MPPTを付与。
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
  // 入力変更
  host.querySelectorAll<HTMLInputElement>("input[data-k]").forEach((inpEl) => {
    inpEl.addEventListener("change", () => {
      const row = inpEl.closest(".pcc-row") as HTMLElement;
      const i = parseInt(row.dataset.i!);
      const k = inpEl.dataset.k as "ns" | "np" | "mppt";
      state.pccList[i][k] = parseInt(inpEl.value) || 1;
      renderPccList();
    });
  });
  // 個別削除
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
  // 始点付近で閉じた場合の余分な終点を除去し、始点＝終点として閉じる
  // （残すとフェンスライン等の内側オフセットがスパイク化するため）。
  const pts = state.polyPts;
  if (pts.length >= 4) {
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const first = pts[0], last = pts[pts.length - 1];
    if (Math.hypot(last.x - first.x, last.y - first.y) < diag * 0.02) pts.pop();
  }
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

  // フェンスライン（野立てのみ）：敷地境界から境界離隔ぶん内側の閉ポリゴン。
  state.fencePolyM =
    mountType === "tilted" && input.setbackM > 0
      ? insetPolygon(input.polygonM, input.setbackM)
      : null;
  state.fenceLengthM = state.fencePolyM ? polygonPerimeter(state.fencePolyM) : 0;

  status("配置を計算中...");
  setTimeout(() => {
    const list: LayoutResult[] =
      mountType === "tilted"
        ? [layoutPatternA(input), layoutPatternB(input)]
        : mountType === "rack"
          ? [layoutRoofSingle(input)]
          : [layoutFlushRoof(input)];
    showResults(list);
    const fenceMsg = state.fenceLengthM > 0 ? ` ／ フェンス延長 ${state.fenceLengthM.toFixed(1)}m` : "";
    status("生成完了: " + list.map((r) => `${patternLabel(r)}=${r.totalPanels}枚(${r.totalKw.toFixed(1)}kW)`).join(" / ") + fenceMsg);
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
  // 結線を含めるか（生成済みかつチェックON）
  const includeStr =
    !!(document.getElementById("dxfIncludePipe") as HTMLInputElement)?.checked && !!state.stringing;
  const dxf = buildDxf(siteM, result, {
    northAngleDeg: parseFloat(inp("northAngle").value) || 0,
    stringing: includeStr ? state.stringing! : undefined,
    fence: state.fencePolyM,
    fenceLengthM: state.fenceLengthM,
    moduleLabel: moduleLabel(),
    pole: state.polePx ? imgToMeters([state.polePx], state.mPerPx)[0] : null,
  });
  const date = new Date().toISOString().slice(0, 10);
  downloadDxf(`solar_layout_${result.pattern}_${date}.dxf`, dxf);
  status(`DXFを出力しました（${patternLabel(result)}${includeStr ? " + 結線" : ""}）。`);
});

// ========== 9. 配管 ==========
// パワコン位置の指定（複数台。クリックごとに追加）
el("pccStart").addEventListener("click", () => {
  if (!state.loaded) return status("先に敷地図を読み込んでください。");
  state.mode = "pcc";
  status("パワコン位置を図面上でクリックしてください（複数台は続けてクリック）。");
});
// パワコン追加完了
el("pccDone").addEventListener("click", () => {
  state.mode = "idle";
  updatePccStatus();
  status(`パワコン ${state.pccList.length}台で確定しました。`);
});
// パワコンをすべてクリア
el("pccClear").addEventListener("click", () => {
  state.pccList = [];
  state.mode = "idle";
  updatePccStatus();
  renderPccList();
  view.render();
  status("パワコンをクリアしました。");
});

// 先方柱の指定／クリア
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

// ストリング結線を生成（アレイ内完結優先・蛇行・PCS別色分け）
el("pipeGenerate").addEventListener("click", () => {
  if (!state.results || !state.results[state.previewIdx])
    return status("先にパネル配置を生成してください（結線はプレビュー中の配置に対して引きます）。");
  if (state.mPerPx <= 0) return status("縮尺が未校正です。");
  if (state.pccList.length === 0) return status("パワコン位置を1台以上指定してください。");

  // px → 数学m。PCSは諸元つき。
  const pccs: PcsUnit[] = state.pccList.map((u) => ({
    pos: imgToMeters([u.px], state.mPerPx)[0],
    ns: u.ns,
    np: u.np,
    mppt: u.mppt,
  }));
  const layout = state.results[state.previewIdx];

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
  if (!state.results || !state.results[state.previewIdx])
    return status("先にパネル配置を生成してください。");
  const result = state.results[state.previewIdx];
  const includeStr =
    !!(document.getElementById("pdfIncludePipe") as HTMLInputElement)?.checked && !!state.stringing;
  status("PDFを生成中...");
  try {
    const date = new Date().toISOString().slice(0, 10);
    await buildAndDownloadPdf(
      {
        background: view.imageCanvas,
        sitePolyPx: state.polyPts,
        result,
        stringing: includeStr ? state.stringing : null,
        fenceM: state.fencePolyM,
        fenceLengthM: state.fenceLengthM,
        moduleLabel: moduleLabel(),
        poleM: state.polePx ? imgToMeters([state.polePx], state.mPerPx)[0] : null,
        mPerPx: state.mPerPx,
        title: `太陽光配置図 ${patternLabel(result)}${includeStr ? " + ストリング結線" : ""}  ${date}`,
      },
      `solar_plan_${result.pattern}_${date}.pdf`
    );
    status("PDFを出力しました。");
  } catch (err) {
    status(`<span class="err">PDF出力エラー: ${(err as Error).message}</span>`);
  }
});

// ========== 11. プロジェクト保存／再開 ==========
// 背景画像・校正・敷地・入力条件・PCSを1つのJSONに保存し、後日読み込んで編集を再開する。

/** 保存対象の input / select の id（画面の入力条件すべて） */
const PROJ_INPUT_IDS = [
  // 校正
  "calibMethod", "calibDist", "calibUnit",
  "ref1x", "ref1y", "ref2x", "ref2y", "jprZone",
  // 設置場所
  "address", "lat", "lon",
  // パネル仕様
  "pMaker", "pModel", "pW", "pH", "pWatt",
  // 配置の制約
  "mountType", "orientation", "tiers", "colMode", "maxCols",
  "spec1", "spec2", "spec3",
  "tilt", "setback", "colGap", "sideGap", "northAngle", "manualPitch",
  "roofRowGap", "flushSetbackEW", "flushSetbackNS", "flushRows", "flushCols",
  "mountainGap",
  // 結線
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
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    imageDataUrl: view.imageCanvas ? bitmapToDataUrl(view.imageCanvas) : null,
    imageFileName: state.imageName,
    mPerPx: state.mPerPx,
    lat: Number.isFinite(state.lat) ? state.lat : null,
    lon: Number.isFinite(state.lon) ? state.lon : null,
    polyPts: state.polyPts,
    polyClosed: state.polyClosed,
    pccList: state.pccList,
    polePx: state.polePx,
    inputs,
    checks,
  };
}

async function applyProject(data: ProjectData) {
  // 背景画像
  if (data.imageDataUrl) {
    const img = await loadImageFromDataUrl(data.imageDataUrl, data.imageFileName || "(保存済み画像)");
    view.setImage(img);
    state.loaded = true;
    state.imageName = img.fileName;
    el("loadStatus").innerHTML = `<span class="ok">プロジェクトから復元: ${img.fileName} (${img.width}×${img.height}px)</span>`;
  }
  // 入力欄
  for (const [id, val] of Object.entries(data.inputs)) {
    const e = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (e) e.value = val;
  }
  for (const [id, on] of Object.entries(data.checks ?? {})) {
    const e = document.getElementById(id) as HTMLInputElement | null;
    if (e) e.checked = on;
  }
  // 表示切替（設置タイプ・列数モード・校正方法）を入力値に追従させる
  sel("mountType").dispatchEvent(new Event("change"));
  sel("colMode").dispatchEvent(new Event("change"));
  sel("calibMethod").dispatchEvent(new Event("change"));
  // 状態
  state.mPerPx = data.mPerPx || 0;
  state.lat = data.lat ?? NaN;
  state.lon = data.lon ?? NaN;
  state.polyPts = data.polyPts ?? [];
  state.polyClosed = !!data.polyClosed;
  state.pccList = data.pccList ?? [];
  state.polePx = data.polePx ?? null;
  state.calibPts = [];
  state.korefPts = [];
  // 生成物はクリア（条件から再生成してもらう）
  state.results = null;
  state.stringing = null;
  state.fencePolyM = null;
  state.fenceLengthM = 0;
  state.previewIdx = 0;
  el("results").innerHTML = "";
  el("pipeResults").innerHTML = "";
  el("previewSeg").innerHTML = "";
  (el("previewSeg") as HTMLElement).style.display = "none";
  sel("exportPattern").innerHTML = "";
  // ステータス表示
  el("calibStatus").innerHTML =
    state.mPerPx > 0
      ? `<span class="ok">校正済: ${(state.mPerPx * 1000).toFixed(2)} mm/px（プロジェクトから復元）</span>`
      : "未校正";
  updatePolyStatus();
  updatePccStatus();
  renderPccList();
  view.render();
  status("プロジェクトを読み込みました。条件を調整して「配置を生成」を押すと再生成できます。");
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
    (e.target as HTMLInputElement).value = ""; // 同じファイルの再選択を可能に
  }
});
