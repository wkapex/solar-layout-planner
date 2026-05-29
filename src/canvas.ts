// Canvas 表示。画像をズーム/パンで表示し、オーバーレイ（校正点・敷地多角形・
// 配置アレイ）を画像ピクセル座標で描く。左クリックは画像座標へ変換してハンドラへ渡す。
import type { LoadedImage } from "./imageLoader";
import type { Vec2 } from "./geometry";

export type ImgPoint = Vec2; // 画像ピクセル座標（x:右, y:下）

export class CanvasView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private image: LoadedImage | null = null;
  private scale = 1;
  private offset: Vec2 = { x: 0, y: 0 };
  private dragging = false;
  private lastDrag: Vec2 = { x: 0, y: 0 };

  /** オーバーレイ描画コールバック（画像ピクセル座標系で描けるよう変換済みの ctx を渡す） */
  onOverlay: ((ctx: CanvasRenderingContext2D) => void) | null = null;
  /** 左クリック時に画像座標を通知 */
  onClick: ((p: ImgPoint) => void) | null = null;
  /** マウス移動時に画像座標を通知（プレビュー線用） */
  onMove: ((p: ImgPoint) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.bindEvents();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  setImage(image: LoadedImage) {
    this.image = image;
    this.fitToView();
  }

  /** 画像全体が収まるように初期スケール/オフセットを設定 */
  fitToView() {
    if (!this.image) return;
    const rect = this.canvas.getBoundingClientRect();
    const s = Math.min(
      rect.width / this.image.width,
      rect.height / this.image.height
    );
    this.scale = s * 0.95;
    this.offset = {
      x: (rect.width - this.image.width * this.scale) / 2,
      y: (rect.height - this.image.height * this.scale) / 2,
    };
    this.render();
  }

  screenToImage(sx: number, sy: number): ImgPoint {
    return {
      x: (sx - this.offset.x) / this.scale,
      y: (sy - this.offset.y) / this.scale,
    };
  }

  /** 画像ピクセル長を画面ピクセル長へ */
  get pxScale() {
    return this.scale;
  }

  private bindEvents() {
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const before = this.screenToImage(mx, my);
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.scale *= factor;
      // カーソル位置を中心にズーム
      this.offset.x = mx - before.x * this.scale;
      this.offset.y = my - before.y * this.scale;
      this.render();
    });

    this.canvas.addEventListener("mousedown", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // 右クリック/中ボタン/Shift+左 でパン、それ以外は選択クリック
      if (e.button === 2 || e.button === 1 || e.shiftKey) {
        this.dragging = true;
        this.lastDrag = { x: mx, y: my };
      } else if (e.button === 0) {
        this.onClick?.(this.screenToImage(mx, my));
      }
    });

    this.canvas.addEventListener("mousemove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (this.dragging) {
        this.offset.x += mx - this.lastDrag.x;
        this.offset.y += my - this.lastDrag.y;
        this.lastDrag = { x: mx, y: my };
        this.render();
      } else {
        this.onMove?.(this.screenToImage(mx, my));
      }
    });

    window.addEventListener("mouseup", () => (this.dragging = false));
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  render() {
    const rect = this.canvas.getBoundingClientRect();
    this.ctx.clearRect(0, 0, rect.width, rect.height);
    this.ctx.fillStyle = "#1e1e22";
    this.ctx.fillRect(0, 0, rect.width, rect.height);
    if (!this.image) return;

    this.ctx.save();
    this.ctx.translate(this.offset.x, this.offset.y);
    this.ctx.scale(this.scale, this.scale);
    this.ctx.drawImage(this.image.bitmap, 0, 0);
    // オーバーレイは画像座標系のまま描く（線幅はスケールで割って一定見た目に）
    this.onOverlay?.(this.ctx);
    this.ctx.restore();
  }
}
