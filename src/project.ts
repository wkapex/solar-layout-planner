// プロジェクトの保存／読み込み。
// 背景画像（公図/航空写真）・縮尺校正・敷地多角形・入力条件・PCSリストを
// 1つのJSONファイルに保存し、後日読み込んで編集を再開できるようにする。
// localStorage は容量制限（約5MB）で航空写真が入らないため、ファイル方式とする。
import type { Vec2 } from "./geometry";
import type { LoadedImage } from "./imageLoader";

export interface ProjectData {
  /** フォーマット版数（将来の互換用） */
  version: 1;
  savedAt: string;
  /** 背景画像（dataURL）。未読込なら null */
  imageDataUrl: string | null;
  imageFileName: string;
  /** 縮尺（m/px）。未校正は 0 */
  mPerPx: number;
  lat: number | null;
  lon: number | null;
  /** 敷地多角形（画像px） */
  polyPts: Vec2[];
  polyClosed: boolean;
  /** パワコン（画像px位置＋諸元） */
  pccList: { px: Vec2; ns: number; np: number; mppt: number }[];
  /** 先方柱の位置（画像px・任意） */
  polePx?: Vec2 | null;
  /** input/select の id → 値（パネル仕様・配置条件など画面の入力全般） */
  inputs: Record<string, string>;
  /** checkbox の id → チェック状態 */
  checks: Record<string, boolean>;
}

/**
 * 背景canvas → dataURL。
 * 公図など線画はPNG（劣化なし）を優先し、巨大になる航空写真はJPEGへフォールバック。
 */
export function bitmapToDataUrl(bitmap: HTMLCanvasElement): string {
  const png = bitmap.toDataURL("image/png");
  if (png.length <= 8_000_000) return png; // ~6MB実データまでPNG
  return bitmap.toDataURL("image/jpeg", 0.92);
}

/** dataURL → LoadedImage（読み込み時の復元） */
export function loadImageFromDataUrl(
  dataUrl: string,
  fileName: string
): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")!.drawImage(img, 0, 0);
      resolve({ bitmap: canvas, width: canvas.width, height: canvas.height, fileName });
    };
    img.onerror = () => reject(new Error("保存された背景画像の復元に失敗しました。"));
    img.src = dataUrl;
  });
}

/** プロジェクトJSONをダウンロード保存 */
export function downloadProject(data: ProjectData, filename: string) {
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** プロジェクトJSONを読み込み（最低限の検証つき） */
export async function readProjectFile(file: File): Promise<ProjectData> {
  const text = await file.text();
  const data = JSON.parse(text) as ProjectData;
  if (!data || data.version !== 1 || !Array.isArray(data.polyPts) || typeof data.inputs !== "object")
    throw new Error("プロジェクトファイルの形式が正しくありません。");
  return data;
}
