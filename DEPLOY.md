# 配布（Web公開）手順

このツールは**ブラウザだけで動くWebアプリ**です。`npm run build` で生成される `dist/` フォルダを
静的ホスティングに置けば、リンクを共有するだけで誰でも使えます。

> **プライバシー**：公図・敷地画像はすべて利用者のブラウザ内で処理され、サーバーへ送信されません。
> **ネット接続**：住所→緯度経度の自動取得（国土地理院API）だけネットが必要。公図座標での校正・緯度経度の手入力なら不要。
> ホスティングはHTTPSになります（推奨）。

---

## 方法1：GitHub Pages（推奨・永続URL・自動更新）

GitHubアカウント（例：`wkapex`）があれば無料で永続URLが持て、コードを更新するたび自動で再公開されます。

### 初回セットアップ（PCで一度だけ）
プロジェクト直下（`C:\dev\solar-layout-planner`）で：

```bash
git init
git add .
git commit -m "初回コミット"
git branch -M main
# GitHubで空リポジトリ（例: solar-layout-planner）を作成してから↓
git remote add origin https://github.com/wkapex/solar-layout-planner.git
git push -u origin main
```

### GitHub側の設定（ブラウザで一度だけ）
1. リポジトリの **Settings → Pages** を開く
2. **Build and deployment → Source** を **「GitHub Actions」** に変更
3. 完了。`.github/workflows/deploy.yml` が自動でビルド＆公開します

### 公開URL
`https://wkapex.github.io/solar-layout-planner/`
（Actions の完了後に有効。Settings → Pages にURLが表示されます）

### 更新方法
コードを直して `git add . && git commit -m "更新" && git push` するだけで再公開されます。

---

## 方法2：Netlify ドラッグ&ドロップ（最速）

1. `npm run build` を実行（`dist/` が生成される）
2. ブラウザで <https://app.netlify.com/drop> を開く（無料アカウントでログイン）
3. `dist/` フォルダを画面にドラッグ&ドロップ
4. 即座に `https://〇〇.netlify.app` のURLが発行される

更新する場合は、再ビルドした `dist/` を同じサイトに再アップロードします。
（Cloudflare Pages / Vercel でも同様にドラッグ&ドロップ配布できます）

---

## 補足
- 社外秘の案件で使う場合でも、画像データは外部送信されないため安全ですが、URLを知っている人は誰でもアプリ自体にアクセスできます（＝アプリは公開、データは非公開）。アクセス制限したい場合は方法1のリポジトリをPrivateにしてもPages自体は公開されるため、Netlifyのパスワード保護や社内サーバ設置を検討してください。
- うまく表示されない場合：ブラウザのキャッシュを消す／HTTPSで開く／コンソールのエラーを確認。
