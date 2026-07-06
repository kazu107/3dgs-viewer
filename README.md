# 3DGS World Viewer

広域 3D Gaussian Splatting シーンをブラウザ上でフライカメラで自由に探索できるWebビューアです。

- **レンダラー**: [Spark 2.x](https://sparkjs.dev/) + Three.js(WebGL2、LoD対応で1億スプラット級の広域シーンも表示可能)
- **ホスティング**: Heroku(GitHub連携の自動デプロイ)
- **シーン保存**: Cloudflare R2(presigned URLでブラウザからR2へ直接ダウンロード)

## 機能

- WASD + マウスのフライカメラ(Shift加速 / Ctrl減速 / E・Qで上昇下降 / タッチ・ゲームパッド対応)
- ダブルクリックした地点への飛行、視点リセット(R)
- シーン一覧パネル(R2バケットから自動検出 + `scenes.json` マニフェストでメタデータ付与)
- 設定パネル(移動速度・視点感度・FOV・解像度スケール・スプラット品質・LoD詳細度)
- FPS / スプラット数 / カメラ座標のHUD、進捗バー付きローディング
- スクリーンショット保存(P)、フルスクリーン(F)、URLハッシュでのシーン共有

## アーキテクチャ

```
ブラウザ ──(静的ファイル + /api)── Express on Heroku
   │                                   │
   │  GET /api/scenes                  │ ListObjectsV2 + scenes.json
   │  GET /api/scenes/url?key=...      │ presigned URL発行 (数ms、R2への通信なし)
   │                                   ▼
   └──(スプラット本体を直接ダウンロード)──▶ Cloudflare R2
```

大きなシーンファイルはHerokuを経由せずR2から直接取得するため、Herokuの30秒タイムアウトやdynoメモリの制約を受けません。

## セットアップ

### 1. R2 バケットの作成

1. [Cloudflareダッシュボード](https://dash.cloudflare.com/) → **R2 Object Storage** → **バケットを作成**(例: `3dgs-scenes`)
2. **R2 → API → R2 APIトークンを管理** → **APIトークンを作成**
   - 権限: **オブジェクト読み取り専用**(このアプリはダウンロードURLの発行のみ行うため)
   - 必要なら対象バケットを限定
   - 作成後に表示される **アクセスキーID** と **シークレットアクセスキー** を控える(シークレットは一度しか表示されません)
3. アカウントIDは R2 概要ページ右側の「アカウントID」からコピー

### 2. R2 バケットの CORS 設定

ブラウザがpresigned URLでR2から直接ファイルを取得するため、CORS設定が**必須**です。

バケット → **設定** → **CORSポリシー** → **CORSポリシーを追加** に以下を貼り付け(オリジンは自分のHerokuアプリのURLに変更):

```json
[
  {
    "AllowedOrigins": [
      "https://<あなたのアプリ名>.herokuapp.com",
      "http://localhost:3000",
      "http://localhost:5173"
    ],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["range", "if-match", "if-none-match"],
    "ExposeHeaders": ["Content-Range", "Content-Length", "ETag", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

`AllowedOrigins` は `スキーム://ホスト` の完全一致です(パスを含めない・末尾スラッシュなし)。反映まで30秒ほどかかります。

### 3. Heroku の環境変数(config vars)

Herokuダッシュボード → アプリ → **Settings** → **Config Vars**、または CLI で設定:

```bash
heroku config:set \
  R2_ACCOUNT_ID=<アカウントID> \
  R2_ACCESS_KEY_ID=<アクセスキーID> \
  R2_SECRET_ACCESS_KEY=<シークレットアクセスキー> \
  R2_BUCKET=3dgs-scenes
```

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `R2_ACCOUNT_ID` | ✅ | CloudflareアカウントID |
| `R2_ACCESS_KEY_ID` | ✅ | R2 APIトークンのアクセスキーID |
| `R2_SECRET_ACCESS_KEY` | ✅ | R2 APIトークンのシークレット |
| `R2_BUCKET` | ✅ | バケット名 |
| `R2_PREFIX` | - | このプレフィックス配下のみ公開(例: `scenes/`) |
| `R2_URL_EXPIRES` | - | presigned URLの有効期限秒(デフォルト3600) |
| `R2_PUBLIC_BASE_URL` | - | カスタムドメイン配信時のベースURL(下記参照) |

環境変数が未設定の場合、サイトはSpark公式のデモシーンを表示します(動作確認用)。

### 4. シーンのアップロード

対応形式: `.spz` `.ply` `.splat` `.ksplat` `.sog` `.rad`(`.spz` が容量と読み込み速度のバランスで推奨)

#### 方法A: アップロードスタジオ(推奨)

**`upload-studio.bat` をダブルクリック**するだけで起動します。ブラウザが開いたら:

1. 「ファイルを選択」またはウィンドウにファイルをドラッグ&ドロップ → その場でプレビュー(3DGSも点群PLYもOK)
2. 「**+ 点群など別の表示データを追加**」で同じシーンの別バージョン(点群など)を追加できます。アップロード後は画面下部のスイッチでカメラ位置を保ったまま切り替えられます
3. フライカメラで移動して見せたい構図を決め、「**+ 現在の視点を追加**」をクリック。複数登録でき、名前も付けられます(最初の視点が開始位置。未登録ならアップロード時の視点)
4. 設定パネルで初期移動速度を調整(現在の速度がそのまま保存されます)
5. シーン名・説明を入力して「**R2 にアップロード**」

ファイル本体のアップロードと `scenes.json` への登録(視点・移動速度・表示データ・LoD設定込み)まで自動で行われ、公開サイトのシーン一覧に即反映されます。

必要な準備(初回のみ):
- `.env.example` をコピーして `.env` を作成し、R2の接続情報を記入
- APIトークンは「**オブジェクト読み取りと書き込み**」権限で作成(Heroku側は読み取り専用のままでOK)

> アップロード機能はローカル起動時のみ有効です(`--upload` フラグ)。Heroku上の公開サイトには書き込みAPIは存在しません。

#### 方法B: 手動アップロード

- **ダッシュボード**: バケットページにドラッグ&ドロップ(300MBまで)
- **rclone / wrangler**(大容量向け):

```bash
# wrangler の例
npx wrangler r2 object put 3dgs-scenes/scenes/my-city.spz --file=./my-city.spz --remote
```

アップロードしたファイルは自動的にシーン一覧へ表示されます(30秒キャッシュ)。

### 5. scenes.json マニフェスト(任意)

バケットの `R2_PREFIX` 直下に `scenes.json` を置くと、表示名・説明・初期カメラなどを指定できます:

```json
{
  "scenes": [
    {
      "id": "city",
      "name": "都市スキャン",
      "description": "ドローン撮影から生成した広域シーン",
      "key": "scenes/city.spz",
      "options": { "lod": true, "extSplats": true },
      "transform": { "rotationDeg": [180, 0, 0], "position": [0, 0, 0], "scale": 1 },
      "camera": { "position": [10, 20, 30], "target": [0, 0, 0], "fov": 65 },
      "moveSpeed": 8,
      "variants": [
        { "name": "3DGS", "key": "scenes/city.spz" },
        { "name": "点群", "key": "scenes/city-points.ply" }
      ],
      "viewpoints": [
        { "name": "全景", "position": [10, 20, 30], "target": [0, 0, 0], "fov": 65 },
        { "name": "駅前", "position": [3, 2, 5], "target": [0, 1, 0] }
      ]
    }
  ]
}
```

| フィールド | 説明 |
| --- | --- |
| `key` | バケット内のオブジェクトキー(必須) |
| `options.lod` | ランタイムLoDツリー構築(デフォルト: `.rad`以外は`true`) |
| `options.extSplats` | 32byte/スプラットの高精度座標。原点から離れる広域シーンで推奨 |
| `options.paged` | ページングストリーミング(チャンク分割`.rad`用) |
| `options.maxSplats` | 読み込むスプラット数の上限 |
| `transform.rotationDeg` | 回転(度)。3DGSデータは通常Y軸下向きのためデフォルト `[180,0,0]` |
| `camera` | 初期カメラ位置・注視点・FOV(省略時はバウンディングボックスから自動配置) |
| `moveSpeed` | 初期移動速度(省略時はシーン規模から自動計算) |
| `variants` | 同じシーンの複数の表示データ(3DGS版・点群版など)。画面下部のスイッチでカメラ位置を保ったまま切替 |
| `viewpoints` | 名前付き視点のリスト。画面下部のバー、または数字キー1〜9で移動。最初の視点が開始位置 |

マニフェストに載せていないファイルも自動検出されて一覧に表示されます。

## 広域シーンのベストプラクティス

- **〜3,000万スプラット**: そのままアップロードでOK。ビューアが読み込み時にLoDツリーを構築します(100万スプラットあたり1〜3秒)
- **それ以上 / 読み込み時間を短縮したい**: [Sparkのbuild-lod CLI](https://sparkjs.dev/docs/lod-getting-started/)で事前に `.rad` へ変換
  - `--rad-chunked` で分割した場合はHTTP Rangeでのオンデマンド読み込みになるため、presigned URLでは動きません。**カスタムドメインを接続した公開バケット**にして `R2_PUBLIC_BASE_URL` を設定してください(CloudflareのCDNキャッシュも効きます)
- 原点から数百m以上広がるシーンは `options.extSplats: true` を推奨(座標の量子化誤差を防止)

## ローカル開発

```bash
npm install
cp .env.example .env   # R2の値を記入(なくてもデモシーンで動作)
npm run build          # フロントエンドをビルド
npm start              # http://localhost:3000
```

開発時のホットリロード: `npm start` でAPIサーバを起動したまま、別ターミナルで `npm run dev`(Vite devサーバが `/api` を3000へプロキシ)。

> **注意 (Windows + OneDrive)**: OneDrive同期フォルダ内では Node の再帰的ファイル削除がクラッシュすることがあるため、`dist/` のクリーンはOSネイティブコマンドで行っています(`scripts/clean-dist.js`)。`node_modules` をOneDrive同期から除外するとインストールも高速になります。

## デプロイ

GitHubの `main` ブランチへのpushで、Herokuが自動的に `npm install` → `npm run build`(Viteビルド)→ `npm start` を実行します。追加のビルド設定は不要です。

## 操作方法

| 入力 | 動作 |
| --- | --- |
| W / A / S / D、矢印キー | 前後左右に移動 |
| E / Q | 上昇 / 下降 |
| Shift / Ctrl | 加速(5倍)/ 減速(0.2倍) |
| 左ドラッグ / 右ドラッグ | 視点回転 / パン |
| ホイール | 前進 / 後退 |
| ダブルクリック | クリック地点へ飛行 |
| R / F / P / H | 視点リセット / フルスクリーン / スクリーンショット / ヘルプ |
| タッチ | 1本指: 回転、2本指: パン、長押し: 前進 |

## トラブルシューティング

| 症状 | 原因と対処 |
| --- | --- |
| シーン読み込みで CORS エラー | R2バケットのCORSポリシー未設定 / `AllowedOrigins` がアプリのURLと不一致(上記手順2) |
| 一覧に何も表示されない | `R2_PREFIX` と実際のキーの不一致、または対応拡張子でない |
| 「R2未設定」と表示される | Herokuのconfig varsが4つとも設定されているか確認 |
| 読み込み途中で失敗する | presigned URLの期限切れ(`R2_URL_EXPIRES` を延長) |
| 広域シーンで遠景がチラつく | `scenes.json` で `options.extSplats: true` を設定 |
