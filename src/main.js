import "./style.css";
import { Viewer } from "./viewer.js";
import { fetchScenes, resolveSceneUrl } from "./api.js";

const $ = (id) => document.getElementById(id);

const viewer = new Viewer({ container: $("canvas-host") });
window.__viewer = viewer; // デバッグ用

const state = {
  scenes: [],
  current: null,
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

const panels = ["panel-scenes", "panel-settings"];
const panelButtons = { "panel-scenes": "btn-scenes", "panel-settings": "btn-settings" };

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

async function loadScene(scene) {
  if (state.loading === scene.id) return;
  state.loading = scene.id;
  // 最後に開始したロードだけがUIを更新できる(古いロードの進捗・エラー・完了は無視)
  const token = ++loadSeq;
  showLoading(`「${scene.name}」を読み込み中...`);
  try {
    const url = await resolveSceneUrl(scene);
    if (token !== loadSeq) return;
    const mesh = await viewer.loadScene(scene, url, {
      onProgress: (e) => {
        if (token === loadSeq) updateLoading(e);
      },
    });
    if (token !== loadSeq || !mesh) return; // 別シーンへ切り替え済み
    state.current = scene;
    $("scene-title").textContent = scene.name;
    $("scene-title").title = scene.name;
    syncSpeedSlider();
    renderSceneList();
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
    showLoadError(err.message || String(err), () => loadScene(scene));
  } finally {
    if (state.loading === scene.id) state.loading = null;
  }
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
  if (e.target.closest("input, textarea, select")) return;
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
      setPanel("panel-scenes", false);
      break;
  }
});

// ---------- 起動 ----------

async function boot() {
  // 初回訪問時はヘルプを表示
  if (!localStorage.getItem("3dgs-viewer-visited")) {
    localStorage.setItem("3dgs-viewer-visited", "1");
    setHelp(true);
  }

  try {
    const data = await fetchScenes();
    state.scenes = data.scenes || [];
    state.r2 = Boolean(data.r2);
    state.empty = Boolean(data.empty);
    renderSceneList();

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
