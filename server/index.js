import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import compression from "compression";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// ローカル開発用に .env があれば読み込む(Heroku本番ではconfig varsを使用)
try {
  process.loadEnvFile();
} catch {
  /* .env が無ければ環境変数のみ使用 */
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "..", "dist");
const PORT = process.env.PORT || 3000;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
// 例: "scenes/"。バケット内のこのプレフィックス配下だけを公開対象にする
const R2_PREFIX = normalizePrefix(process.env.R2_PREFIX || "");
// カスタムドメイン/公開バケットを使う場合のみ設定(例: https://assets.example.com)
// 設定時はpresigned URLの代わりに公開URLを返す(チャンク分割.radはこちらが必須)
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const URL_EXPIRES_SECONDS = clampInt(process.env.R2_URL_EXPIRES, 60, 604800, 3600);

const r2Configured = Boolean(
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET
);

const s3 = r2Configured
  ? new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
      // R2はAWS SDK v3.729+のデフォルトチェックサムと相性が悪いため必須
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    })
  : null;

// Sparkが読み込めるスプラット形式(.radcは.radのチャンクなので一覧からは除外)
const SPLAT_EXTENSIONS = [".ply", ".spz", ".splat", ".ksplat", ".sog", ".rad", ".zip"];
const MANIFEST_KEY = `${R2_PREFIX}scenes.json`;

// R2未設定でも動作確認できるように、Spark公式のデモアセットを用意
const DEMO_SCENES = [
  {
    id: "demo-butterfly",
    name: "バタフライ(デモ)",
    description: "Spark公式のサンプルシーン。R2を設定すると自分のシーンが表示されます。",
    url: "https://sparkjs.dev/assets/splats/butterfly.spz",
    demo: true,
  },
];

function normalizePrefix(prefix) {
  const p = prefix.replace(/^\/+/, "");
  if (p === "") return "";
  return p.endsWith("/") ? p : `${p}/`;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function hasSplatExtension(key) {
  const lower = key.toLowerCase();
  return SPLAT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// presign対象のキーを厳密に検証する(パストラバーサル・プレフィックス外を拒否)
function isValidSceneKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false;
  if (key.includes("..") || key.startsWith("/") || key.includes("\\")) return false;
  if (R2_PREFIX && !key.startsWith(R2_PREFIX)) return false;
  return hasSplatExtension(key);
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

// scenes.json マニフェスト(任意)を取得。無ければnull
async function fetchManifest() {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: MANIFEST_KEY })
    );
    const text = await streamToString(res.Body);
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : parsed.scenes || [];
  } catch (err) {
    if (err?.name !== "NoSuchKey" && err?.$metadata?.httpStatusCode !== 404) {
      console.warn("scenes.json の読み込みに失敗:", err.message);
    }
    return null;
  }
}

// プレフィックス配下のスプラットファイルを列挙
async function discoverSceneFiles() {
  const objects = [];
  let ContinuationToken;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: R2_PREFIX || undefined,
        MaxKeys: 1000,
        ContinuationToken,
      })
    );
    for (const obj of res.Contents ?? []) {
      if (hasSplatExtension(obj.Key)) {
        objects.push({ key: obj.Key, size: obj.Size ?? 0 });
      }
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken && objects.length < 5000);
  return objects;
}

function fileNameToSceneName(key) {
  const base = key.slice(key.lastIndexOf("/") + 1);
  return base.replace(/\.[a-z0-9]+$/i, "");
}

// マニフェスト + 自動検出をマージしてシーン一覧を組み立てる
async function buildSceneList() {
  const [manifest, files] = await Promise.all([fetchManifest(), discoverSceneFiles()]);
  const sizeByKey = new Map(files.map((f) => [f.key, f.size]));
  const scenes = [];
  const usedKeys = new Set();

  for (const entry of manifest ?? []) {
    if (!entry || typeof entry.key !== "string" || !isValidSceneKey(entry.key)) continue;
    usedKeys.add(entry.key);
    scenes.push({
      id: entry.id || entry.key,
      name: entry.name || fileNameToSceneName(entry.key),
      description: entry.description || "",
      key: entry.key,
      size: sizeByKey.get(entry.key) ?? null,
      options: entry.options || {},
      transform: entry.transform || null,
      camera: entry.camera || null,
      moveSpeed: entry.moveSpeed ?? null,
    });
  }

  for (const file of files) {
    if (usedKeys.has(file.key)) continue;
    scenes.push({
      id: file.key,
      name: fileNameToSceneName(file.key),
      description: "",
      key: file.key,
      size: file.size,
      options: {},
      transform: null,
      camera: null,
      moveSpeed: null,
    });
  }
  return scenes;
}

// シーン一覧の短期キャッシュ(R2のClass Bオペレーション節約)
let sceneListCache = { at: 0, data: null };
const SCENE_CACHE_TTL_MS = 30_000;

const app = express();
app.disable("x-powered-by");
app.use(compression());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/scenes", async (_req, res) => {
  if (!r2Configured) {
    return res.json({ r2: false, scenes: DEMO_SCENES });
  }
  try {
    if (!sceneListCache.data || Date.now() - sceneListCache.at > SCENE_CACHE_TTL_MS) {
      sceneListCache = { at: Date.now(), data: await buildSceneList() };
    }
    const scenes = sceneListCache.data;
    res.json({
      r2: true,
      scenes: scenes.length > 0 ? scenes : DEMO_SCENES,
      empty: scenes.length === 0,
    });
  } catch (err) {
    console.error("シーン一覧の取得に失敗:", err);
    res.status(502).json({ r2: true, error: "R2からのシーン一覧取得に失敗しました", scenes: [] });
  }
});

// スプラットファイルの取得用URLを発行(ブラウザはR2から直接ダウンロードする)
app.get("/api/scenes/url", async (req, res) => {
  const key = req.query.key;
  if (!r2Configured) {
    return res.status(400).json({ error: "R2が設定されていません" });
  }
  if (!isValidSceneKey(key)) {
    return res.status(400).json({ error: "不正なキーです" });
  }
  try {
    if (R2_PUBLIC_BASE_URL) {
      const url = `${R2_PUBLIC_BASE_URL}/${encodeURI(key)}`;
      return res.json({ url, expiresIn: null });
    }
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
      { expiresIn: URL_EXPIRES_SECONDS }
    );
    res.json({ url, expiresIn: URL_EXPIRES_SECONDS });
  } catch (err) {
    console.error("URL発行に失敗:", err);
    res.status(502).json({ error: "URLの発行に失敗しました" });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "not found" });
  }
  next();
});

// ビルド済みフロントエンド(ハッシュ付きアセットは長期キャッシュ)
app.use(
  express.static(DIST_DIR, {
    setHeaders(res, filePath) {
      if (/\.(js|css|wasm|woff2?)$/.test(filePath) && /-[\w-]{8,}\./.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  })
);

// SPAフォールバック
app.use((_req, res) => {
  res.sendFile(path.join(DIST_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`3DGS viewer server listening on port ${PORT}`);
  console.log(`R2: ${r2Configured ? `configured (bucket=${R2_BUCKET}, prefix="${R2_PREFIX}")` : "未設定 — デモシーンのみ"}`);
});
