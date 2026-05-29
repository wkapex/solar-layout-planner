// 敷地図の読込。PDF は pdfjs-dist で1ページ目を高解像度ラスタライズ、
// 画像（JPG/PNG/BMP 等）はそのまま <img> 経由で Canvas へ描く。
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface LoadedImage {
  /** 元画像を描いた offscreen canvas（基準ピクセル） */
  bitmap: HTMLCanvasElement;
  width: number;
  height: number;
  fileName: string;
}

/** PDF を指定スケールでラスタライズして canvas に描く（1ページ目） */
async function loadPdf(file: File, renderScale = 2.5): Promise<HTMLCanvasElement> {
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: renderScale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d")!;
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

/** 画像ファイル（JPG/PNG/BMP/GIF/WebP）を canvas に描く */
function loadRaster(file: File): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")!.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像の読み込みに失敗しました: " + file.name));
    };
    img.src = url;
  });
}

export async function loadSiteImage(file: File): Promise<LoadedImage> {
  const isPdf =
    file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const bitmap = isPdf ? await loadPdf(file) : await loadRaster(file);
  return {
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
    fileName: file.name,
  };
}
