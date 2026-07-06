import "./style.css";
import { Viewer } from "./viewer.js";
import { fetchScenes, resolveSceneUrl } from "./api.js";

const $ = (id) => document.getElementById(id);

const viewer = new Viewer({ container: $("canvas-host") });
window.__viewer = viewer; // デバッグ用

const state = {
  scenes: [],
  current: null,
  variantIndex: 0,
  r2: false,
};

// ---------- トースト ----------

function toast(message, { error = false, duration = 3500 } = {}) {
  const el = document.createElement("div");
  el.className = `toast${error ? " error" : ""}`;
  el.textContent = message;
  $("toast-container").appendChild(el);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 350);
  }, duration);
}

// ---------- パネル ----------

const panels = ["panel-scenes", "panel-settings", "panel-upload"];
const panelButtons = {
  "panel-scenes": "btn-scenes",
  "panel-settings": "btn-settings",
  "panel-upload": "btn-upload",
};

function setPanel(id, open) {
  for (const p of panels) {
    const isTarget = p === id;
    const shouldOpen = isTarget && open;
    $(p).classList.toggle("open", shouldOpen);
    $(p).setAttribute("aria-hidden", String(!shouldOpen));
    $(panelButtons[p]).classList.toggle("active", shouldOpen);
  }
}

function togglePanel(id) {
  setPanel(id, !$(id).classList.contains("open"));
}

$("btn-scenes").addEventListener("click", () => togglePanel("panel-scenes"));
$("btn-settings").addEventListener("click", () => togglePanel("panel-settings"));
$("btn-upload").addEventListener("click", () => togglePanel("panel-upload"));
document.querySelectorAll(".panel-close").forEach((btn) => {
  btn.addEventListener("click", () => setPanel(btn.dataset.close, false));
});

// ---------- ローディング ----------

function showLoading(title) {
  const overlay = $("loading-overlay");
  overlay.querySelector(".loading-card").classList.remove("error");
  overlay.querySelector(".retry-btn")?.remove();
  $("loading-title").textContent = title;
  $("loading-bar").style.width = "0%";
  $("loading-bar").classList.add("indeterminate");
  $("loading-detail").textContent = "";
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
}

let lastLoadingUpdate = 0;

function updateLoading(event) {
  // 進捗イベントは高頻度で発火するため、DOM更新は10Hzに抑える(完了時は即時)
  const now = performance.now();
  const finished = event.lengthComputable && event.loaded >= event.total;
  if (!finished && now - lastLoadingUpdate < 100) return;
  lastLoadingUpdate = now;

  const bar = $("loading-bar");
  if (event.lengthComputable && event.total > 0) {
    bar.classList.remove("indeterminate");
    const pct = Math.min(100, (event.loaded / event.total) * 100);
    bar.style.width = `${pct}%`;
    $("loading-detail").textContent = `${formatBytes(event.loaded)} / ${formatBytes(event.total)} (${pct.toFixed(0)}%)`;
    if (event.loaded >= event.total) {
      $("loading-title").textContent = "スプラットを構築中...";
    }
  } else {
    bar.classList.add("indeterminate");
    $("loading-detail").textContent = formatBytes(event.loaded);
  }
}

function hideLoading() {
  const overlay = $("loading-overlay");
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
}

function showLoadError(message, retry) {
  const overlay = $("loading-overlay");
  // 起動失敗時などshowLoadingを経由しない経路でも必ず表示する
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  overlay.querySelector(".loading-card").classList.add("error");
  $("loading-title").textContent = "読み込みに失敗しました";
  $("loading-bar").classList.remove("indeterminate");
  $("loading-bar").style.width = "0%";
  $("loading-detail").textContent = message;
  if (!overlay.querySelector(".retry-btn")) {
    const btn = document.createElement("button");
    btn.className = "retry-btn";
    btn.textContent = "再試行";
    btn.addEventListener("click", retry);
    overlay.querySelector(".loading-card").appendChild(btn);
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "--";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

// ---------- シーン一覧 ----------

function sceneFormat(scene) {
  const key = scene.key || scene.url || "";
  const m = key.split("?")[0].match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toUpperCase() : "";
}

function renderSceneList() {
  const list = $("scene-list");
  list.innerHTML = "";

  if (!state.r2) {
    const note = document.createElement("div");
    note.className = "panel-note";
    note.textContent =
      "R2が未設定のためデモシーンを表示しています。Herokuの環境変数にR2の接続情報を設定すると、自分のシーンが一覧に表示されます(READMEを参照)。";
    list.appendChild(note);
  } else if (state.empty) {
    const note = document.createElement("div");
    note.className = "panel-note";
    note.textContent =
      "R2バケットにシーンが見つかりません。バケットに .spz / .ply / .splat / .ksplat / .sog / .rad をアップロードしてください。";
    list.appendChild(note);
  }

  for (const scene of state.scenes) {
    const card = document.createElement("button");
    card.className = "scene-card";
    card.type = "button";
    if (state.current && scene.id === state.current.id) card.classList.add("active");

    const name = document.createElement("div");
    name.className = "scene-card-name";
    name.textContent = scene.name;
    card.appendChild(name);

    if (scene.description) {
      const desc = document.createElement("div");
      desc.className = "scene-card-desc";
      desc.textContent = scene.description;
      card.appendChild(desc);
    }

    const meta = document.createElement("div");
    meta.className = "scene-card-meta";
    const fmt = sceneFormat(scene);
    if (fmt) meta.appendChild(badge(fmt, true));
    if (scene.size) meta.appendChild(badge(formatBytes(scene.size)));
    if (scene.options?.lod || fmt === "RAD") meta.appendChild(badge("LoD"));
    if (scene.variants?.length > 1) meta.appendChild(badge(`${scene.variants.length}データ`));
    if (scene.viewpoints?.length > 0) meta.appendChild(badge(`視点×${scene.viewpoints.length}`));
    if (scene.demo) meta.appendChild(badge("デモ"));
    card.appendChild(meta);

    card.addEventListener("click", () => {
      setPanel("panel-scenes", false);
      loadScene(scene);
    });
    list.appendChild(card);
  }
}

function badge(text, accent = false) {
  const el = document.createElement("span");
  el.className = `badge${accent ? " accent" : ""}`;
  el.textContent = text;
  return el;
}

// ---------- シーンロード ----------

let loadSeq = 0;

// シーンの表示データ一覧(バリアント未定義なら本体キーのみ)
function sceneVariants(scene) {
  if (scene.variants?.length) return scene.variants;
  return [{ name: "3DGS", key: scene.key, url: scene.url, options: scene.options }];
}

async function loadScene(scene, { variant = 0, keepCamera = false } = {}) {
  if (state.loading === scene.id) return;
  state.loading = scene.id;
  // 最後に開始したロードだけがUIを更新できる(古いロードの進捗・エラー・完了は無視)
  const token = ++loadSeq;
  const variants = sceneVariants(scene);
  const variantIndex = Math.min(Math.max(0, variant), variants.length - 1);
  const v = variants[variantIndex];
  showLoading(`「${scene.name}」を読み込み中...`);
  try {
    const url = await resolveSceneUrl(v.url ? v : { key: v.key });
    if (token !== loadSeq) return;
    // バリアント側のキー/オプションでロード(transform等はシーン共通)
    const sceneInfo = { ...scene, key: v.key ?? scene.key, options: v.options ?? scene.options };
    const mesh = await viewer.loadScene(sceneInfo, url, {
      keepCamera,
      onProgress: (e) => {
        if (token === loadSeq) updateLoading(e);
      },
    });
    if (token !== loadSeq || !mesh) return; // 別シーンへ切り替え済み
    state.current = scene;
    state.variantIndex = variantIndex;
    $("scene-title").textContent = scene.name;
    $("scene-title").title = scene.name;
    syncSpeedSlider();
    renderSceneList();
    renderSceneControls();
    hideLoading();
    const count = viewer.splatCount();
    toast(
      count > 0
        ? `「${scene.name}」を読み込みました (${(count / 1e6).toFixed(1)}Mスプラット)`
        : `「${scene.name}」を読み込みました`
    );
    const hash = `#scene=${encodeURIComponent(scene.id)}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
  } catch (err) {
    if (token !== loadSeq) return; // 古いロードのエラーは表示しない
    console.error(err);
    showLoadError(err.message || String(err), () => loadScene(scene, { variant, keepCamera }));
  } finally {
    if (state.loading === scene.id) state.loading = null;
  }
}

// 表示データ(3DGS/点群など)をカメラ位置を維持したまま切り替える
async function switchVariant(index) {
  if (state.current?.local) {
    if (index !== upload.previewIndex) await previewLocalVariant(index, { keepCamera: true });
    return;
  }
  if (!state.current || index === state.variantIndex) return;
  await loadScene(state.current, { variant: index, keepCamera: true });
}

// 現在のシーンの視点リスト(ローカルプレビュー中は記録途中のものを表示)
function currentViewpoints() {
  if (state.current?.local) return upload.viewpoints;
  return state.current?.viewpoints || [];
}

// 画面下部の表示データ・視点切替バーを描画
function renderSceneControls() {
  const variantSwitch = $("variant-switch");
  const viewpointBar = $("viewpoint-bar");
  const scene = state.current;

  const variants = scene?.local
    ? upload.variants.map((v) => ({ name: v.label.trim() || "データ" }))
    : scene?.variants || [];
  variantSwitch.innerHTML = "";
  if (variants.length > 1) {
    variants.forEach((v, i) => {
      const b = document.createElement("button");
      b.className = `pill${i === state.variantIndex ? " active" : ""}`;
      b.textContent = v.name;
      b.addEventListener("click", () => switchVariant(i));
      variantSwitch.appendChild(b);
    });
  }
  variantSwitch.classList.toggle("hidden", variants.length <= 1);

  const viewpoints = currentViewpoints();
  viewpointBar.innerHTML = "";
  viewpoints.forEach((vp, i) => {
    const b = document.createElement("button");
    b.className = "pill";
    const num = document.createElement("span");
    num.className = "pill-num";
    num.textContent = String(i + 1);
    b.appendChild(num);
    b.appendChild(document.createTextNode(vp.name || `視点${i + 1}`));
    b.addEventListener("click", () => viewer.applyViewpoint(vp));
    viewpointBar.appendChild(b);
  });
  viewpointBar.classList.toggle("hidden", viewpoints.length === 0);
}

function sceneFromHash() {
  const m = location.hash.match(/scene=([^&]+)/);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  return state.scenes.find((s) => s.id === id) || null;
}

window.addEventListener("hashchange", () => {
  const scene = sceneFromHash();
  if (scene && scene.id !== state.current?.id) loadScene(scene);
});

// ---------- 設定 ----------

function syncSpeedSlider() {
  const speed = viewer.controls.fpsMovement.moveSpeed;
  $("set-speed").value = String(Math.log10(Math.max(0.1, Math.min(100, speed))));
  $("out-speed").textContent = speed.toFixed(1);
}

$("set-speed").addEventListener("input", (e) => {
  const speed = 10 ** Number(e.target.value);
  viewer.setMoveSpeed(speed);
  $("out-speed").textContent = speed.toFixed(1);
});

$("set-sensitivity").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  viewer.setSensitivity(v);
  $("out-sensitivity").textContent = v.toFixed(2);
});

$("set-fov").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  viewer.setFov(v);
  $("out-fov").textContent = `${v}°`;
});

$("set-resolution").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  viewer.setResolutionScale(v);
  $("out-resolution").textContent = `${Math.round(v * 100)}%`;
});

const QUALITY_LABELS = ["低", "中", "高"];
$("set-quality").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  viewer.setQuality(v);
  $("out-quality").textContent = QUALITY_LABELS[v];
});

$("set-lod").addEventListener("change", (e) => {
  viewer.setLodEnabled(e.target.checked);
});

$("set-lodscale").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  viewer.setLodScale(v);
  $("out-lodscale").textContent = v.toFixed(2);
});

$("set-hud").addEventListener("change", (e) => {
  $("hud").classList.toggle("hidden", !e.target.checked);
});

// 入力欄フォーカス中はWASD移動を止める(矢印キーとスライダーの衝突回避)
document.addEventListener("focusin", (e) => {
  if (e.target.matches("input, textarea, select")) viewer.setKeyboardEnabled(false);
});
document.addEventListener("focusout", () => viewer.setKeyboardEnabled(true));

// ---------- HUD ----------

viewer.onStats = ({ fps, splats, position, speed }) => {
  $("hud-fps").textContent = String(fps);
  $("hud-splats").textContent =
    splats >= 1e6 ? `${(splats / 1e6).toFixed(1)}M` : splats > 0 ? splats.toLocaleString() : "--";
  $("hud-pos").textContent = `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`;
  $("hud-speed").textContent = speed.toFixed(1);
  $("upload-speed-value").textContent = `現在の設定 (${speed.toFixed(1)})`;
};

viewer.onContextLost = () => {
  toast("WebGLコンテキストが失われました。ページを再読み込みしてください。", {
    error: true,
    duration: 10000,
  });
};

// ---------- ヘルプ / その他ボタン ----------

function setHelp(open) {
  $("help-modal").classList.toggle("hidden", !open);
  $("help-modal").setAttribute("aria-hidden", String(!open));
}

$("btn-help").addEventListener("click", () => setHelp(true));
$("btn-help-close").addEventListener("click", () => setHelp(false));
$("help-modal").addEventListener("click", (e) => {
  if (e.target === $("help-modal")) setHelp(false);
});

$("btn-screenshot").addEventListener("click", () => takeScreenshot());
$("btn-fullscreen").addEventListener("click", toggleFullscreen);

function takeScreenshot() {
  const base = (state.current?.name || "3dgs").replace(/[\\/:*?"<>|\s]+/g, "_");
  viewer.screenshot(base);
  toast("スクリーンショットを保存しました");
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen?.();
  }
}

document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, select")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.code) {
    case "KeyH":
      setHelp($("help-modal").classList.contains("hidden"));
      break;
    case "KeyR":
      viewer.resetView();
      break;
    case "KeyF":
      toggleFullscreen();
      break;
    case "KeyP":
      takeScreenshot();
      break;
    case "Escape":
      setHelp(false);
      for (const p of panels) setPanel(p, false);
      break;
    default: {
      // 数字キー1〜9で登録視点へ移動
      const m = e.code.match(/^Digit([1-9])$/);
      if (m) {
        const vp = currentViewpoints()[Number(m[1]) - 1];
        if (vp) viewer.applyViewpoint(vp);
      }
    }
  }
});

// ---------- アップロードスタジオ ----------

// variants: [{file, label}] / viewpoints: [{name, position, target, fov}]
const upload = { variants: [], viewpoints: [], previewIndex: -1 };
const SPLAT_EXTS = [".spz", ".ply", ".splat", ".ksplat", ".sog", ".rad", ".zip"];

const stemOf = (name) => name.replace(/\.[^.]+$/, "");

$("upload-drop").addEventListener("click", () => $("upload-file").click());
$("upload-file").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) addLocalFile(file);
  e.target.value = "";
});
$("upload-add-variant").addEventListener("click", () => $("upload-file-variant").click());
$("upload-file-variant").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) addLocalFile(file);
  e.target.value = "";
});

// ファイルを表示データとして追加(1つ目=3DGS、2つ目以降=点群などのバリアント)
async function addLocalFile(file) {
  if (!SPLAT_EXTS.some((ext) => file.name.toLowerCase().endsWith(ext))) {
    toast("対応していないファイル形式です (.spz / .ply / .splat / .ksplat / .sog / .rad)", {
      error: true,
    });
    return;
  }
  if (upload.variants.some((v) => v.file.name === file.name)) {
    toast("同名のファイルが既に追加されています", { error: true });
    return;
  }
  const isFirst = upload.variants.length === 0;
  const isPly = file.name.toLowerCase().endsWith(".ply");
  upload.variants.push({ file, label: isFirst ? "3DGS" : isPly ? "点群" : `データ${upload.variants.length + 1}` });
  if (isFirst && !$("upload-name").value.trim()) {
    $("upload-name").value = stemOf(file.name);
  }
  $("upload-form").classList.remove("hidden");
  $("upload-status").textContent = "";
  $("upload-status").classList.remove("error");
  setPanel("panel-upload", true);
  renderUploadVariants();
  await previewLocalVariant(upload.variants.length - 1, { keepCamera: !isFirst });
  if (isFirst) {
    toast("プレビュー中 — 視点と速度を決めてアップロードしてください", { duration: 5000 });
  }
}

function currentUploadOptions() {
  return {
    lod: $("upload-lod").checked,
    extSplats: $("upload-ext").checked || undefined,
  };
}

function localSceneInfo() {
  const base = upload.variants[0];
  return {
    id: "local",
    name: base ? stemOf(base.file.name) : "ローカル",
    local: true,
    options: currentUploadOptions(),
  };
}

// ローカルファイルをビューアでプレビュー(サーバを経由しない)
async function previewLocalVariant(index, { keepCamera = false } = {}) {
  const variant = upload.variants[index];
  if (!variant) return;
  const token = ++loadSeq;
  showLoading(`「${variant.file.name}」をプレビュー中...`);
  try {
    const buf = await variant.file.arrayBuffer();
    if (token !== loadSeq) return;
    const scene = localSceneInfo();
    const mesh = await viewer.loadSceneFromBytes(scene, buf, variant.file.name, {
      keepCamera,
      onProgress: (e) => {
        if (token === loadSeq) updateLoading(e);
      },
    });
    if (token !== loadSeq || !mesh) return;
    upload.previewIndex = index;
    state.current = scene;
    state.variantIndex = index;
    $("scene-title").textContent = `${scene.name}(ローカルプレビュー)`;
    $("scene-title").title = variant.file.name;
    syncSpeedSlider();
    renderSceneList();
    renderUploadVariants();
    renderSceneControls();
    hideLoading();
  } catch (err) {
    if (token !== loadSeq) return;
    console.error(err);
    showLoadError(err.message || String(err), () => previewLocalVariant(index, { keepCamera }));
  }
}

function renderUploadVariants() {
  const list = $("upload-variants");
  list.innerHTML = "";
  upload.variants.forEach((v, i) => {
    const item = document.createElement("div");
    item.className = "variant-item";
    if (i === upload.previewIndex && state.current?.local) item.classList.add("previewing");

    const top = document.createElement("div");
    top.className = "variant-item-top";
    const label = document.createElement("input");
    label.className = "variant-label-input";
    label.value = v.label;
    label.maxLength = 50;
    label.title = "表示データの名前 (例: 3DGS、点群)";
    label.addEventListener("input", () => {
      v.label = label.value;
      renderSceneControls();
    });
    const fname = document.createElement("span");
    fname.className = "variant-file-name";
    fname.textContent = `${v.file.name} (${formatBytes(v.file.size)})`;
    fname.title = v.file.name;
    top.append(label, fname);

    const actions = document.createElement("div");
    actions.className = "variant-item-actions";
    if (!(i === upload.previewIndex && state.current?.local)) {
      const previewBtn = document.createElement("button");
      previewBtn.className = "mini-btn";
      previewBtn.textContent = "プレビュー";
      previewBtn.addEventListener("click", () => previewLocalVariant(i, { keepCamera: true }));
      actions.appendChild(previewBtn);
    }
    const removeBtn = document.createElement("button");
    removeBtn.className = "mini-btn";
    removeBtn.textContent = "削除";
    removeBtn.addEventListener("click", () => {
      upload.variants.splice(i, 1);
      if (upload.variants.length === 0) {
        upload.previewIndex = -1;
        $("upload-form").classList.add("hidden");
      } else if (upload.previewIndex >= upload.variants.length) {
        upload.previewIndex = upload.variants.length - 1;
      }
      renderUploadVariants();
      renderSceneControls();
    });
    actions.appendChild(removeBtn);

    item.append(top, actions);
    list.appendChild(item);
  });
}

// LoD/extSplatsの切替はプレビューの構築方法に影響するため再読み込み
const reloadPreview = () => {
  if (upload.previewIndex >= 0) previewLocalVariant(upload.previewIndex, { keepCamera: true });
};
$("upload-lod").addEventListener("change", reloadPreview);
$("upload-ext").addEventListener("change", reloadPreview);

$("upload-capture").addEventListener("click", () => {
  const pose = viewer.captureCameraPose();
  upload.viewpoints.push({ name: `視点${upload.viewpoints.length + 1}`, ...pose });
  renderUploadViewpoints();
  renderSceneControls();
  toast(`視点${upload.viewpoints.length}を追加しました(下のバーで確認できます)`);
});

function renderUploadViewpoints() {
  const list = $("upload-viewpoints");
  list.innerHTML = "";
  upload.viewpoints.forEach((vp, i) => {
    const item = document.createElement("div");
    item.className = "viewpoint-item";

    const num = document.createElement("span");
    num.className = "viewpoint-index";
    num.textContent = String(i + 1);

    const name = document.createElement("input");
    name.className = "viewpoint-name-input";
    name.value = vp.name;
    name.maxLength = 50;
    name.addEventListener("input", () => {
      vp.name = name.value;
      renderSceneControls();
    });

    const goBtn = document.createElement("button");
    goBtn.className = "mini-btn";
    goBtn.textContent = "移動";
    goBtn.addEventListener("click", () => viewer.applyViewpoint(vp));

    const removeBtn = document.createElement("button");
    removeBtn.className = "mini-btn";
    removeBtn.textContent = "削除";
    removeBtn.addEventListener("click", () => {
      upload.viewpoints.splice(i, 1);
      renderUploadViewpoints();
      renderSceneControls();
    });

    item.append(num, name, goBtn, removeBtn);
    list.appendChild(item);
  });
  $("upload-pose-hint").textContent =
    upload.viewpoints.length > 0
      ? "最初の視点が開始位置になります。数字キーでも移動できます。"
      : "最初の視点が開始位置になります。未追加の場合はアップロード時の視点を使います。";
}

function uploadFileWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/upload?filename=${encodeURIComponent(file.name)}`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100, e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response?.key) {
        resolve(xhr.response);
      } else {
        reject(new Error(xhr.response?.error || `アップロードに失敗しました (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("ネットワークエラーでアップロードに失敗しました"));
    xhr.send(file);
  });
}

$("upload-submit").addEventListener("click", async () => {
  if (upload.variants.length === 0) return;
  const name = $("upload-name").value.trim();
  if (!name) {
    toast("シーン名を入力してください", { error: true });
    $("upload-name").focus();
    return;
  }
  const btn = $("upload-submit");
  const statusEl = $("upload-status");
  btn.disabled = true;
  statusEl.classList.remove("error");
  $("upload-progress-track").classList.remove("hidden");
  $("upload-progress").style.width = "0%";
  try {
    // 全ファイルを順番にアップロード
    const total = upload.variants.length;
    const keys = [];
    for (let i = 0; i < total; i++) {
      const v = upload.variants[i];
      const prefix = total > 1 ? `ファイル ${i + 1}/${total}: ` : "";
      const { key } = await uploadFileWithProgress(v.file, (pct, loaded, totalBytes) => {
        $("upload-progress").style.width = `${(i * 100 + pct) / total}%`;
        statusEl.textContent = `${prefix}アップロード中... ${formatBytes(loaded)} / ${formatBytes(totalBytes)} (${pct.toFixed(0)}%)`;
      });
      keys.push(key);
    }

    statusEl.textContent = "シーン情報を保存中...";
    // 視点が未登録ならアップロード時の視点を開始位置として使う
    const viewpoints =
      upload.viewpoints.length > 0
        ? upload.viewpoints
        : [{ name: "開始位置", ...viewer.captureCameraPose() }];
    const entry = {
      id: keys[0],
      name,
      description: $("upload-desc").value.trim(),
      key: keys[0],
      options: currentUploadOptions(),
      // プレビューと同じ向きで表示されるように明示的に保存
      transform: { rotationDeg: [180, 0, 0] },
      camera: {
        position: viewpoints[0].position,
        target: viewpoints[0].target,
        fov: viewpoints[0].fov,
      },
      moveSpeed: Math.round(viewer.controls.fpsMovement.moveSpeed * 100) / 100,
      viewpoints,
    };
    if (keys.length > 1) {
      entry.variants = keys.map((key, i) => ({
        name: upload.variants[i].label.trim() || `データ${i + 1}`,
        key,
      }));
    }
    const res = await fetch("/api/manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `シーン情報の保存に失敗しました (${res.status})`);
    }
    statusEl.textContent = "完了しました ✓";
    toast(`「${name}」をR2にアップロードしました`);
    await refreshScenes();
    const uploaded = state.scenes.find((s) => s.key === keys[0]);
    if (uploaded) {
      state.current = uploaded;
      state.variantIndex = Math.min(state.variantIndex ?? 0, keys.length - 1);
      renderSceneList();
      renderSceneControls();
      history.replaceState(null, "", `#scene=${encodeURIComponent(uploaded.id)}`);
      $("scene-title").textContent = uploaded.name;
    }
  } catch (err) {
    console.error(err);
    statusEl.classList.add("error");
    statusEl.textContent = err.message || String(err);
    toast("アップロードに失敗しました", { error: true, duration: 6000 });
  } finally {
    btn.disabled = false;
  }
});

// ウィンドウ全体へのドラッグ&ドロップ
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!state.uploadEnabled || !e.dataTransfer?.types?.includes("Files")) return;
  e.preventDefault();
  dragDepth += 1;
  $("drop-overlay").classList.remove("hidden");
});
window.addEventListener("dragover", (e) => {
  if (!state.uploadEnabled) return;
  e.preventDefault();
});
window.addEventListener("dragleave", () => {
  if (!state.uploadEnabled) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $("drop-overlay").classList.add("hidden");
});
window.addEventListener("drop", (e) => {
  if (!state.uploadEnabled) return;
  e.preventDefault();
  dragDepth = 0;
  $("drop-overlay").classList.add("hidden");
  const file = e.dataTransfer?.files?.[0];
  if (file) addLocalFile(file);
});

// ---------- 起動 ----------

async function refreshScenes() {
  const data = await fetchScenes();
  state.scenes = data.scenes || [];
  state.r2 = Boolean(data.r2);
  state.empty = Boolean(data.empty);
  state.uploadEnabled = Boolean(data.uploadEnabled);
  $("btn-upload").classList.toggle("hidden", !state.uploadEnabled);
  renderSceneList();
}

async function boot() {
  // 初回訪問時はヘルプを表示
  if (!localStorage.getItem("3dgs-viewer-visited")) {
    localStorage.setItem("3dgs-viewer-visited", "1");
    setHelp(true);
  }

  try {
    await refreshScenes();

    if (state.uploadEnabled) {
      setPanel("panel-upload", true);
      toast("アップロードスタジオ: ファイルを選択してプレビューできます", { duration: 6000 });
    }

    if (state.scenes.length === 0) {
      toast("表示できるシーンがありません", { error: true, duration: 8000 });
      return;
    }
    const initial = sceneFromHash() || state.scenes[0];
    await loadScene(initial);
  } catch (err) {
    console.error(err);
    showLoadError(err.message || String(err), boot);
  }
}

boot();
