import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import compression from "compression";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";

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
// アップロードスタジオ(ローカル起動時のみ)。upload-studio.bat が --upload で起動する。
// Heroku本番では有効にしないこと — 認証なしの書き込みエンドポイントが公開される
const ENABLE_UPLOAD =
  process.env.ENABLE_UPLOAD === "1" || process.argv.includes("--upload");

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
  let pages = 0;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: R2_PREFIX || undefined,
        MaxKeys: 1000,
        ContinuationToken,
      })
    );
    pages += 1;
    for (const obj of res.Contents ?? []) {
      // presign側と同じ検証を通ったキーだけを一覧に載せる
      if (isValidSceneKey(obj.Key)) {
        objects.push({ key: obj.Key, size: obj.Size ?? 0 });
      }
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken && pages < 20 && objects.length < 5000);
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
    // variants/layersに含まれるキーも自動検出の重複対象から除外する
    const variants = Array.isArray(entry.variants)
      ? entry.variants.filter((v) => v && isValidSceneKey(v.key))
      : null;
    for (const v of variants ?? []) usedKeys.add(v.key);
    const layers = Array.isArray(entry.layers)
      ? entry.layers.filter((l) => l && isValidSceneKey(l.key))
      : null;
    for (const l of layers ?? []) usedKeys.add(l.key);
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
      variants: variants && variants.length > 0 ? variants : null,
      layers: layers && layers.length > 0 ? layers : null,
      viewpoints: Array.isArray(entry.viewpoints) ? entry.viewpoints : null,
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
    return res.json({ r2: false, uploadEnabled: ENABLE_UPLOAD, scenes: DEMO_SCENES });
  }
  try {
    if (!sceneListCache.data || Date.now() - sceneListCache.at > SCENE_CACHE_TTL_MS) {
      sceneListCache = { at: Date.now(), data: await buildSceneList() };
    }
    const scenes = sceneListCache.data;
    res.json({
      r2: true,
      uploadEnabled: ENABLE_UPLOAD,
      scenes: scenes.length > 0 ? scenes : DEMO_SCENES,
      empty: scenes.length === 0,
    });
  } catch (err) {
    console.error("シーン一覧の取得に失敗:", err);
    res.status(502).json({ r2: true, error: "R2からのシーン一覧取得に失敗しました", scenes: [] });
  }
});

// presigned URLの短期キャッシュ。有効期限の半分まで同じURLを返すことで、
// ブラウザのHTTPキャッシュが同一シーンの再取得に効くようにする
const presignCache = new Map(); // key -> { url, reuseUntil }

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
      // キーの各セグメントをエンコード("/"は保持、#や%を含むキーにも対応)
      const encodedKey = key.split("/").map(encodeURIComponent).join("/");
      return res.json({ url: `${R2_PUBLIC_BASE_URL}/${encodedKey}`, expiresIn: null });
    }
    const cached = presignCache.get(key);
    if (cached && Date.now() < cached.reuseUntil) {
      return res.json({ url: cached.url, expiresIn: URL_EXPIRES_SECONDS });
    }
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
      { expiresIn: URL_EXPIRES_SECONDS }
    );
    if (presignCache.size > 500) presignCache.clear();
    presignCache.set(key, {
      url,
      reuseUntil: Date.now() + (URL_EXPIRES_SECONDS * 1000) / 2,
    });
    res.json({ url, expiresIn: URL_EXPIRES_SECONDS });
  } catch (err) {
    console.error("URL発行に失敗:", err);
    res.status(502).json({ error: "URLの発行に失敗しました" });
  }
});

// ---------- アップロードスタジオ用API (ENABLE_UPLOAD=1 のローカル起動時のみ) ----------

function requireUpload(req, res, next) {
  if (!ENABLE_UPLOAD) {
    return res.status(403).json({ error: "アップロードはこのサーバでは無効です" });
  }
  if (!r2Configured) {
    return res.status(400).json({ error: "R2が設定されていません (.envを確認してください)" });
  }
  next();
}

// ファイル名をR2キー用に安全化(パス除去・危険文字置換)
function sanitizeFileName(name) {
  const base = String(name).replace(/^.*[\\/]/, "").normalize("NFC");
  const safe = base.replace(/[<>:"|?*#%\s-]/g, "_").replace(/\.\.+/g, ".");
  return safe.slice(0, 200);
}

// スプラットファイル本体をストリーミングでR2へ(マルチパート、リクエスト本文=ファイル)
app.put("/api/upload", requireUpload, async (req, res) => {
  const fileName = sanitizeFileName(req.query.filename || "");
  if (!fileName || !hasSplatExtension(fileName)) {
    return res.status(400).json({ error: "対応していないファイル形式です" });
  }
  const key = `${R2_PREFIX}${fileName}`;
  if (!isValidSceneKey(key)) {
    return res.status(400).json({ error: "不正なファイル名です" });
  }
  try {
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: R2_BUCKET,
        Key: key,
        Body: req,
        ContentType: "application/octet-stream",
      },
      queueSize: 3,
      partSize: 64 * 1024 * 1024,
    });
    await upload.done();
    sceneListCache = { at: 0, data: null };
    presignCache.delete(key);
    console.log(`アップロード完了: ${key}`);
    res.json({ key });
  } catch (err) {
    console.error("アップロードに失敗:", err);
    res.status(502).json({ error: `アップロードに失敗しました: ${err.message}` });
  }
});

// scenes.json マニフェストのエントリを追加/更新
app.post("/api/manifest", requireUpload, express.json({ limit: "64kb" }), async (req, res) => {
  const entry = req.body || {};
  if (!isValidSceneKey(entry.key)) {
    return res.status(400).json({ error: "不正なキーです" });
  }
  if (typeof entry.name !== "string" || !entry.name.trim()) {
    return res.status(400).json({ error: "シーン名を入力してください" });
  }
  // 既知フィールドだけを保存する
  const clean = {
    id: String(entry.id || entry.key).slice(0, 200),
    name: entry.name.trim().slice(0, 100),
    description: String(entry.description || "").slice(0, 500),
    key: entry.key,
  };
  if (entry.options && typeof entry.options === "object") clean.options = entry.options;
  if (entry.transform && typeof entry.transform === "object") clean.transform = entry.transform;
  if (entry.camera && typeof entry.camera === "object") clean.camera = entry.camera;
  if (Number.isFinite(entry.moveSpeed)) clean.moveSpeed = entry.moveSpeed;

  // 表示データ(3DGS/点群など)。キーは通常のシーンキーと同じ検証を通す
  if (Array.isArray(entry.variants)) {
    const variants = entry.variants
      .filter((v) => v && typeof v === "object" && isValidSceneKey(v.key))
      .slice(0, 8)
      .map((v) => {
        const out = {
          name: String(v.name || "").trim().slice(0, 50) || "データ",
          key: v.key,
        };
        if (v.options && typeof v.options === "object") out.options = v.options;
        return out;
      });
    if (variants.length > 0) clean.variants = variants;
  }

  // 合成ワールドのレイヤー(複数ファイルを同時表示、各レイヤーに配置情報)
  const isVec3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  const sanitizeLayerTransform = (t) => {
    if (!t || typeof t !== "object") return undefined;
    const out = {};
    if (isVec3(t.position)) out.position = t.position.map((n) => Math.round(n * 1000) / 1000);
    if (isVec3(t.rotationDeg)) out.rotationDeg = t.rotationDeg.map((n) => Math.round(n * 100) / 100);
    if (Number.isFinite(t.headingDeg)) out.headingDeg = Math.round(t.headingDeg * 100) / 100;
    if (Number.isFinite(t.scale) && t.scale > 0) out.scale = Math.round(t.scale * 10000) / 10000;
    return Object.keys(out).length > 0 ? out : undefined;
  };
  if (Array.isArray(entry.layers)) {
    const layers = entry.layers
      .filter((l) => l && typeof l === "object" && isValidSceneKey(l.key))
      .slice(0, 16)
      .map((l, i) => {
        const out = {
          name: String(l.name || "").trim().slice(0, 50) || `レイヤー${i + 1}`,
          key: l.key,
        };
        if (l.options && typeof l.options === "object") out.options = l.options;
        const transform = sanitizeLayerTransform(l.transform);
        if (transform) out.transform = transform;
        return out;
      });
    if (layers.length > 0) clean.layers = layers;
  }

  // 名前付き視点のリスト
  if (Array.isArray(entry.viewpoints)) {
    const viewpoints = entry.viewpoints
      .filter((vp) => vp && typeof vp === "object" && isVec3(vp.position))
      .slice(0, 20)
      .map((vp, i) => {
        const out = {
          name: String(vp.name || "").trim().slice(0, 50) || `視点${i + 1}`,
          position: vp.position.map((n) => Math.round(n * 1000) / 1000),
        };
        if (isVec3(vp.target)) out.target = vp.target.map((n) => Math.round(n * 1000) / 1000);
        if (Number.isFinite(vp.fov)) out.fov = Math.min(120, Math.max(20, Math.round(vp.fov)));
        return out;
      });
    if (viewpoints.length > 0) clean.viewpoints = viewpoints;
  }

  try {
    const manifest = (await fetchManifest()) ?? [];
    const scenes = manifest.filter((s) => s && s.key !== clean.key);
    scenes.push(clean);
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: MANIFEST_KEY,
        Body: JSON.stringify({ scenes }, null, 2),
        ContentType: "application/json",
      })
    );
    sceneListCache = { at: 0, data: null };
    console.log(`マニフェスト更新: ${clean.key} (${clean.name})`);
    res.json({ ok: true, scene: clean });
  } catch (err) {
    console.error("マニフェスト更新に失敗:", err);
    res.status(502).json({ error: `マニフェストの更新に失敗しました: ${err.message}` });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "not found" });
  }
  next();
});

// ビルド済みフロントエンド(ハッシュ付きアセットは長期キャッシュ、index.htmlは毎回検証)
app.use(
  express.static(DIST_DIR, {
    setHeaders(res, filePath) {
      if (/\.(js|css|wasm|woff2?)$/.test(filePath) && /-[\w-]{8,}\./.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  })
);

// SPAフォールバック
app.use((_req, res) => {
  res.sendFile(path.join(DIST_DIR, "index.html"), {
    headers: { "Cache-Control": "no-cache" },
  });
});

app.listen(PORT, () => {
  console.log(`3DGS viewer server listening on port ${PORT}`);
  console.log(`R2: ${r2Configured ? `configured (bucket=${R2_BUCKET}, prefix="${R2_PREFIX}")` : "未設定 — デモシーンのみ"}`);
});
