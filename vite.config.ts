import { defineConfig } from "vite";

// pdfjs-dist のワーカーは ?url import で読み込むため特別な設定は不要。
// base を相対パスにしておくと、ビルド成果物をファイルサーバー無しでも開きやすい。
export default defineConfig({
  base: "./",
  build: {
    target: "es2020",
  },
});
