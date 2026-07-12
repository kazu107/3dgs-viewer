import "./ar-style.css";
import * as THREE from "three";
import { THREEx } from "@ar-js-org/ar.js-threejs";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { fetchScenes, resolveSceneUrl } from "./api.js";

// three が Spark と AR.js で同一インスタンスか(dedupe成功か)の保険チェック
console.log(`[AR] three r${THREE.REVISION}`);

const $ = (id) => document.getElementById(id);

// AR.jsのアセット(camera_para.dat / patt.hiro)は /data/ に配置(public/data)。
// URLは各所で絶対パス("/data/...")を明示指定するので baseURL は空にする
// (空でないと内部デフォルトURL生成時に二重付与される場合がある)。
THREEx.ArToolkitContext.baseURL = "";

const HIRO_OFFICIAL = "https://raw.githubusercontent.com/AR-js-org/AR.js/master/data/images/HIRO.jpg";
const BARCODE_COLLECTION = "https://github.com/nicolocarpignoli/artoolkit-barcode-markers-collection/tree/master/3x3_parity_65";

const state = {
  scene: null, // 選択中シーン(/api/scenes のエントリ)
  variantIndex: 0,
  markerType: "hiro",
  barcodeValue: 5,
  userScale: 1,
  userHeight: 0,
  contentBox: null, // 読み込んだシーンのバウンディングボックス(content空間)
};

// three / AR.js オブジェクト(開始後に生成)
let renderer, threeScene, camera, spark, markerRoot, content;
let arSource, arContext, running = false;

// ---------- URLハッシュ ----------

function parseHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  return {
    sceneId: params.get("scene"),
    variant: parseInt(params.get("variant") || "0", 10) || 0,
  };
}

// ---------- 起動時: シーン情報を取得してUIを用意 ----------

async function init() {
  showSupportNote();
  const { sceneId, variant } = parseHash();
  state.variantIndex = variant;
  try {
    const data = await fetchScenes();
    const scenes = data.scenes || [];
    state.scene = scenes.find((s) => s.id === sceneId) || scenes[0];
    if (!state.scene) throw new Error("表示できるシーンがありません");
    $("ar-scene-name").textContent = state.scene.name;
    $("ar-start-btn").disabled = false;
    $("ar-start-btn").textContent = "ARを開始";
  } catch (err) {
    console.error(err);
    showError(err.message || String(err));
  }
}

function showSupportNote() {
  const note = $("ar-support-note");
  const secure = window.isSecureContext;
  const hasCamera = Boolean(navigator.mediaDevices?.getUserMedia);
  if (!secure) {
    note.classList.add("warn");
    note.textContent =
      "⚠ カメラはHTTPS接続でのみ使用できます。https:// のURLで開いてください(localhostは可)。";
  } else if (!hasCamera) {
    note.classList.add("warn");
    note.textContent = "⚠ このブラウザはカメラ(getUserMedia)に対応していません。";
  } else {
    note.textContent = "対応: iOS Safari / Android Chrome。マーカーを平らな面に置いてカメラを向けてください。";
  }
}

// ---------- マーカー選択 ----------

$("ar-marker-select").addEventListener("change", (e) => {
  state.markerType = e.target.value;
  $("ar-barcode-field").classList.toggle("hidden", state.markerType !== "barcode");
});
$("ar-barcode-value").addEventListener("input", (e) => {
  state.barcodeValue = Math.max(0, Math.min(63, parseInt(e.target.value, 10) || 0));
});

// ---------- マーカー表示モーダル ----------

$("ar-print-btn").addEventListener("click", () => {
  const isHiro = state.markerType === "hiro";
  $("ar-marker-desc").textContent = isHiro
    ? "標準の Hiro マーカーです。白い枠を含めて印刷し、平らな面に置いてください。"
    : `バーコードマーカー(番号 ${state.barcodeValue})です。印刷して使用します。`;
  $("ar-marker-view").innerHTML = isHiro ? hiroMarkerSvg() : barcodeHint();
  const official = $("ar-marker-official");
  official.href = isHiro ? HIRO_OFFICIAL : BARCODE_COLLECTION;
  official.textContent = isHiro ? "公式Hiroマーカー画像を開く" : "印刷用バーコードマーカー集を開く";
  $("ar-marker-modal").classList.remove("hidden");
});
$("ar-marker-close").addEventListener("click", () => $("ar-marker-modal").classList.add("hidden"));

// Hiroマーカーの簡易再現(印刷の目安。確実な追従には公式画像の印刷を推奨)
function hiroMarkerSvg() {
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="100" height="100" fill="#000"/>
    <rect x="25" y="25" width="50" height="50" fill="#fff"/>
    <text x="50" y="58" font-family="Arial, sans-serif" font-size="20" font-weight="700"
      text-anchor="middle" fill="#000">Hiro</text>
  </svg>`;
}
function barcodeHint() {
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="100" height="100" fill="#000"/>
    <g fill="#fff">
      <rect x="20" y="20" width="20" height="20"/>
      <rect x="60" y="20" width="20" height="20"/>
      <rect x="40" y="40" width="20" height="20"/>
      <rect x="20" y="60" width="20" height="20"/>
      <rect x="60" y="60" width="20" height="20"/>
    </g>
  </svg>`;
}

// ---------- 開始 ----------

$("ar-start-btn").addEventListener("click", startAR);
$("ar-exit").addEventListener("click", () => location.reload());

async function startAR() {
  if (running) return;
  running = true;
  $("ar-start-btn").disabled = true;
  $("ar-start-btn").textContent = "カメラを起動中...";
  try {
    setupThree();
    await setupArToolkit();
    $("ar-start").classList.add("hidden");
    $("ar-hud").classList.remove("hidden");
    setStatus("シーンを読み込み中...");
    await loadSplats();
    fitContent();
    bindHudControls();
    setStatus("マーカーを探しています...");
  } catch (err) {
    console.error(err);
    showError(err.message || String(err));
  }
}

function setupThree() {
  renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(new THREE.Color(0x000000), 0); // 透過 → カメラ映像が透ける
  $("ar-root").appendChild(renderer.domElement);

  threeScene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(); // projectionMatrix は AR.js が上書き
  threeScene.add(camera);

  spark = new SparkRenderer({ renderer });
  threeScene.add(spark);

  markerRoot = new THREE.Group(); // AR.js がマーカー姿勢で駆動
  threeScene.add(markerRoot);
  content = new THREE.Group(); // シーンのフィット(スケール/位置)を担う
  markerRoot.add(content);
}

function setupArToolkit() {
  return new Promise((resolve, reject) => {
    arSource = new THREEx.ArToolkitSource({
      sourceType: "webcam",
      sourceWidth: window.innerWidth > window.innerHeight ? 640 : 480,
      sourceHeight: window.innerWidth > window.innerHeight ? 480 : 640,
    });

    arSource.init(
      () => {
        // iOSは videoWidth が確定するまで遅延させて resize
        setTimeout(onResize, 300);
        arContext = new THREEx.ArToolkitContext({
          cameraParametersUrl: "/data/camera_para.dat",
          detectionMode: state.markerType === "barcode" ? "mono_and_matrix" : "mono",
          matrixCodeType: "3x3",
          maxDetectionRate: 30,
          canvasWidth: 640,
          canvasHeight: 480,
        });
        arContext.init(() => {
          camera.projectionMatrix.copy(arContext.getProjectionMatrix());
          setupMarkerControls();
          renderer.setAnimationLoop(frame);
          resolve();
        });
      },
      (err) => reject(new Error("カメラを起動できませんでした(許可を確認してください)"))
    );

    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", () => setTimeout(onResize, 250));
  });
}

function setupMarkerControls() {
  const params =
    state.markerType === "barcode"
      ? { type: "barcode", barcodeValue: state.barcodeValue }
      : { type: "pattern", patternUrl: "/data/patt.hiro" };
  // eslint-disable-next-line no-new
  new THREEx.ArMarkerControls(arContext, markerRoot, {
    ...params,
    size: 1,
    changeMatrixMode: "modelViewMatrix", // markerRootを動かす(カメラは固定)
    smooth: true,
    smoothCount: 8,
    smoothTolerance: 0.01,
    smoothThreshold: 2,
  });
}

function onResize() {
  if (!arSource) return;
  arSource.onResizeElement();
  arSource.copyElementSizeTo(renderer.domElement);
  if (arContext && arContext.arController) {
    arSource.copyElementSizeTo(arContext.arController.canvas);
  }
}

// ---------- スプラット読み込み ----------

function applyFlip(mesh, transform) {
  const rotDeg = transform?.rotationDeg ?? [180, 0, 0];
  mesh.rotation.set(
    THREE.MathUtils.degToRad(rotDeg[0]),
    THREE.MathUtils.degToRad(rotDeg[1]),
    THREE.MathUtils.degToRad(rotDeg[2])
  );
}

function makeSplat(url, options = {}) {
  const isRad = /\.rad$/i.test(url.split("?")[0]);
  return new SplatMesh({
    url,
    lod: options.lod ?? (isRad ? undefined : true),
    extSplats: options.extSplats ?? undefined,
    paged: options.paged ?? undefined,
  });
}

async function loadSplats() {
  const scene = state.scene;
  const created = [];
  if (Array.isArray(scene.layers) && scene.layers.length > 0) {
    // 合成ワールド: 全レイヤーを配置込みで読み込む
    const urls = await Promise.all(scene.layers.map((l) => resolveSceneUrl({ key: l.key })));
    await Promise.all(
      scene.layers.map(async (layer, i) => {
        const mesh = makeSplat(urls[i], layer.options || {});
        await mesh.initialized;
        applyFlip(mesh, layer.transform);
        const g = new THREE.Group();
        const t = layer.transform || {};
        if (t.position) g.position.fromArray(t.position);
        g.rotation.set(0, THREE.MathUtils.degToRad(t.headingDeg ?? 0), 0);
        if (Number.isFinite(t.scale) && t.scale > 0) g.scale.setScalar(t.scale);
        g.add(mesh);
        content.add(g);
        created.push(mesh);
      })
    );
  } else {
    const variants = scene.variants?.length ? scene.variants : [{ key: scene.key, url: scene.url, options: scene.options }];
    const v = variants[Math.min(state.variantIndex, variants.length - 1)] || variants[0];
    const url = await resolveSceneUrl(v.url ? { url: v.url } : { key: v.key });
    const mesh = makeSplat(url, v.options || scene.options || {});
    await mesh.initialized;
    applyFlip(mesh, scene.transform);
    content.add(mesh);
    created.push(mesh);
  }
  threeScene.updateMatrixWorld(true);

  // content空間でのバウンディングボックスを計算
  const box = new THREE.Box3();
  const inv = new THREE.Matrix4().copy(content.matrixWorld).invert();
  for (const mesh of created) {
    try {
      const b = mesh.getBoundingBox().clone();
      b.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
      if (!b.isEmpty()) box.union(b);
    } catch {
      /* bboxが取れない形式は無視 */
    }
  }
  state.contentBox = box.isEmpty() ? null : box;
}

// シーンをマーカーサイズにフィット(scale/heightスライダーも反映)
function fitContent() {
  const box = state.contentBox;
  if (!box) {
    content.scale.setScalar(state.userScale);
    content.position.set(0, state.userHeight, 0);
    return;
  }
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1e-3);
  // マーカー1辺(=1ユニット)の約1.2倍に収める基準スケール
  const fit = 1.2 / maxDim;
  const scale = fit * state.userScale;
  content.scale.setScalar(scale);
  // X/Z中心をマーカー原点へ、底面(min.y)をマーカー面へ
  content.position.set(
    -center.x * scale,
    -box.min.y * scale + state.userHeight,
    -center.z * scale
  );
}

// ---------- HUD操作 ----------

function bindHudControls() {
  $("ar-scale").addEventListener("input", (e) => {
    state.userScale = 10 ** Number(e.target.value); // 対数スライダー
    $("ar-scale-out").textContent = state.userScale.toFixed(2);
    fitContent();
  });
  $("ar-height").addEventListener("input", (e) => {
    state.userHeight = Number(e.target.value);
    $("ar-height-out").textContent = state.userHeight.toFixed(2);
    fitContent();
  });
  $("ar-recenter").addEventListener("click", () => {
    state.userScale = 1;
    state.userHeight = 0;
    $("ar-scale").value = "0";
    $("ar-height").value = "0";
    $("ar-scale-out").textContent = "1.00";
    $("ar-height-out").textContent = "0.00";
    fitContent();
  });
}

// ---------- ループ ----------

let markerVisible = null;
function frame() {
  if (arSource && arSource.ready && arContext) {
    arContext.update(arSource.domElement);
    const visible = markerRoot.visible;
    if (visible !== markerVisible) {
      markerVisible = visible;
      setStatus(visible ? "表示中" : "マーカーを探しています...", visible);
    }
  }
  renderer.render(threeScene, camera);
}

// ---------- UI補助 ----------

function setStatus(text, found = false) {
  const el = $("ar-status");
  el.textContent = text;
  el.classList.toggle("found", found);
}

function showError(msg) {
  $("ar-error-msg").textContent = msg;
  $("ar-error").classList.remove("hidden");
  $("ar-start").classList.add("hidden");
  $("ar-hud").classList.add("hidden");
}

init();
