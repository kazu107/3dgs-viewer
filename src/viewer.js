import * as THREE from "three";
import { SparkRenderer, SplatMesh, SparkControls } from "@sparkjsdev/spark";

const QUALITY_MAX_STD_DEV = [2.0, 2.4, Math.sqrt(8)];

/**
 * Three.js + Spark によるスプラットビューア本体。
 * シーンのロード/破棄、フライカメラ、フライトアニメーション、統計を担当する。
 */
export class Viewer {
  constructor({ container }) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // スプラットにMSAAは効果がなく性能だけ落ちる
      powerPreference: "high-performance",
    });
    this.basePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.resolutionScale = 1;
    this.renderer.setPixelRatio(this.basePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07090f);

    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);

    this.camera = new THREE.PerspectiveCamera(65, 1, 0.05, 4000);
    this.camera.position.set(0, 1.6, 5);

    this.controls = new SparkControls({ canvas: this.renderer.domElement });
    this.baseRotateSpeed = this.controls.fpsMovement.rotateSpeed;
    this.basePointerRotateSpeed = this.controls.pointerControls.rotateSpeed;

    this.mesh = null;
    this.loadId = 0;
    this.homePose = null; // { position, quaternion }
    this.flight = null; // 進行中のフライトアニメーション
    this.screenshotName = null;

    this.fpsEma = 0;
    this.lastFrameTime = 0;
    this.statsAccumMs = 0;
    this.onStats = null; // ({fps, splats, position, speed}) => void

    this.raycaster = new THREE.Raycaster();

    window.addEventListener("resize", () => this.#resize());
    this.#resize();

    // フライト中にユーザー操作があればアニメーションを中断
    const cancelFlight = () => {
      this.flight = null;
    };
    this.renderer.domElement.addEventListener("pointerdown", cancelFlight);
    this.renderer.domElement.addEventListener("wheel", cancelFlight, { passive: true });
    document.addEventListener("keydown", (e) => {
      if (!e.target.closest?.("input, textarea")) cancelFlight();
    });

    this.renderer.domElement.addEventListener("dblclick", (e) => this.#onDoubleClick(e));

    this.renderer.domElement.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.onContextLost?.();
    });

    this.renderer.setAnimationLoop((t) => this.#frame(t));
  }

  #resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  #frame(timeMs) {
    const dt = this.lastFrameTime ? (timeMs - this.lastFrameTime) / 1000 : 0;
    this.lastFrameTime = timeMs;

    if (this.flight) {
      this.#advanceFlight(timeMs);
    } else {
      this.controls.update(this.camera);
    }

    this.renderer.render(this.scene, this.camera);

    if (this.screenshotName) {
      const name = this.screenshotName;
      this.screenshotName = null;
      this.renderer.domElement.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }, "image/png");
    }

    // 統計は250ms間隔でUIへ通知
    if (dt > 0) {
      const fps = 1 / dt;
      this.fpsEma = this.fpsEma ? this.fpsEma * 0.9 + fps * 0.1 : fps;
      this.statsAccumMs += dt * 1000;
      if (this.statsAccumMs > 250 && this.onStats) {
        this.statsAccumMs = 0;
        this.onStats({
          fps: Math.round(this.fpsEma),
          splats: this.splatCount(),
          position: this.camera.position,
          speed: this.controls.fpsMovement.moveSpeed,
        });
      }
    }
  }

  splatCount() {
    const m = this.mesh;
    if (!m) return 0;
    // LoD有効時はpackedSplatsが0になり、実数はlastSplatsに入る
    let count = 0;
    for (const source of [m.packedSplats, m.extSplats, m.splats, m.lastSplats]) {
      count = Math.max(count, source?.numSplats ?? 0);
    }
    return count;
  }

  /**
   * シーンをロードして表示する。既存シーンは破棄。
   * @param {object} sceneInfo /api/scenes のシーンエントリ
   * @param {string} url スプラットファイルのURL
   */
  async loadScene(sceneInfo, url, { onProgress } = {}) {
    return this.#load(sceneInfo, { url }, onProgress);
  }

  /** ローカルファイル(アップロードスタジオ)からシーンをロードする */
  async loadSceneFromBytes(sceneInfo, fileBytes, fileName, { onProgress } = {}) {
    return this.#load(sceneInfo, { fileBytes, fileName }, onProgress);
  }

  async #load(sceneInfo, source, onProgress) {
    const id = ++this.loadId;
    this.#disposeCurrent();

    const options = sceneInfo.options || {};
    const keyName =
      sceneInfo.key || source.fileName || (source.url ? source.url.split("?")[0] : "");
    const isRad = /\.rad$/i.test(keyName);

    const mesh = new SplatMesh({
      ...source,
      onProgress,
      // 広域シーン向け: .rad以外はデフォルトでランタイムLoDツリーを構築
      lod: options.lod ?? (isRad ? undefined : true),
      // 原点から離れた座標での量子化誤差を防ぐ(広域シーン向け)
      extSplats: options.extSplats ?? undefined,
      paged: options.paged ?? undefined,
      maxSplats: options.maxSplats ?? undefined,
    });

    try {
      await mesh.initialized;
    } catch (err) {
      mesh.dispose();
      throw err;
    }
    if (id !== this.loadId) {
      // ロード中に別シーンへ切り替わった
      mesh.dispose();
      return null;
    }

    this.#applyTransform(mesh, sceneInfo.transform);
    this.mesh = mesh;
    this.scene.add(mesh);

    this.#setupCamera(sceneInfo);
    return mesh;
  }

  /** 現在のカメラ姿勢を scenes.json の camera フィールド形式で返す */
  captureCameraPose() {
    const round = (v) => Math.round(v * 1000) / 1000;
    const pos = this.camera.position;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const target = pos
      .clone()
      .add(dir.multiplyScalar(Math.max(1, this.controls.fpsMovement.moveSpeed * 2)));
    return {
      position: [round(pos.x), round(pos.y), round(pos.z)],
      target: [round(target.x), round(target.y), round(target.z)],
      fov: Math.round(this.camera.fov),
    };
  }

  #disposeCurrent() {
    this.flight = null;
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
    }
  }

  #applyTransform(mesh, transform) {
    // 3DGSの学習データは通常Y軸が下向きなので、デフォルトでX軸180°回転
    const rotDeg = transform?.rotationDeg ?? [180, 0, 0];
    mesh.rotation.set(
      THREE.MathUtils.degToRad(rotDeg[0]),
      THREE.MathUtils.degToRad(rotDeg[1]),
      THREE.MathUtils.degToRad(rotDeg[2])
    );
    if (transform?.position) mesh.position.fromArray(transform.position);
    if (transform?.scale) mesh.scale.setScalar(transform.scale);
    mesh.updateMatrixWorld(true);
  }

  #setupCamera(sceneInfo) {
    const cam = sceneInfo.camera;
    let center = new THREE.Vector3();
    let diag = 10;

    try {
      const box = this.mesh.getBoundingBox().clone();
      box.applyMatrix4(this.mesh.matrixWorld);
      if (!box.isEmpty()) {
        center = box.getCenter(new THREE.Vector3());
        diag = Math.max(box.getSize(new THREE.Vector3()).length(), 0.1);
      }
    } catch {
      /* バウンディングボックスが取れない形式でも続行 */
    }

    // シーン規模に応じてクリップ面と移動速度を調整
    this.camera.near = Math.max(0.01, diag * 0.001);
    this.camera.far = Math.max(1000, diag * 25);
    this.camera.updateProjectionMatrix();

    const autoSpeed = THREE.MathUtils.clamp(diag / 15, 0.5, 40);
    this.controls.fpsMovement.moveSpeed = sceneInfo.moveSpeed ?? autoSpeed;

    if (cam?.position) {
      this.camera.position.fromArray(cam.position);
      const target = cam.target ? new THREE.Vector3().fromArray(cam.target) : center;
      this.camera.lookAt(target);
      if (cam.fov) {
        this.camera.fov = cam.fov;
        this.camera.updateProjectionMatrix();
      }
    } else {
      const offset = new THREE.Vector3(0.55, 0.35, 0.75).normalize().multiplyScalar(diag * 0.55);
      this.camera.position.copy(center).add(offset);
      this.camera.lookAt(center);
    }

    this.homePose = {
      position: this.camera.position.clone(),
      quaternion: this.camera.quaternion.clone(),
    };
  }

  /** ホーム視点へスムーズに戻る */
  resetView() {
    if (!this.homePose) return;
    this.#startFlight(this.homePose.position, this.homePose.quaternion, 900);
  }

  #onDoubleClick(event) {
    if (!this.mesh) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.mesh, false);
    if (hits.length === 0) return;

    const point = hits[0].point;
    const dir = point.clone().sub(this.camera.position);
    const dist = dir.length();
    if (dist < 0.01) return;
    // 対象の少し手前まで飛行し、対象を向く
    const toPos = this.camera.position.clone().add(dir.multiplyScalar(0.75));
    const lookMatrix = new THREE.Matrix4().lookAt(toPos, point, this.camera.up);
    const toQuat = new THREE.Quaternion().setFromRotationMatrix(lookMatrix);
    this.#startFlight(toPos, toQuat, 800);
  }

  #startFlight(toPos, toQuat, durationMs) {
    this.flight = {
      fromPos: this.camera.position.clone(),
      fromQuat: this.camera.quaternion.clone(),
      toPos: toPos.clone(),
      toQuat: toQuat.clone(),
      start: performance.now(),
      duration: durationMs,
    };
  }

  #advanceFlight(_timeMs) {
    const f = this.flight;
    const t = Math.min(1, (performance.now() - f.start) / f.duration);
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; // easeInOutCubic
    this.camera.position.lerpVectors(f.fromPos, f.toPos, e);
    this.camera.quaternion.slerpQuaternions(f.fromQuat, f.toQuat, e);
    if (t >= 1) this.flight = null;
  }

  screenshot(baseName = "3dgs") {
    const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    this.screenshotName = `${baseName}-${ts}.png`;
  }

  // ---------- 設定 ----------

  setMoveSpeed(speed) {
    this.controls.fpsMovement.moveSpeed = speed;
  }

  setSensitivity(factor) {
    this.controls.fpsMovement.rotateSpeed = this.baseRotateSpeed * factor;
    this.controls.pointerControls.rotateSpeed = this.basePointerRotateSpeed * factor;
  }

  setFov(fov) {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  setResolutionScale(scale) {
    this.resolutionScale = scale;
    this.renderer.setPixelRatio(this.basePixelRatio * scale);
    this.#resize();
  }

  /** 品質プリセット 0=低 / 1=中 / 2=高 */
  setQuality(level) {
    this.spark.maxStdDev = QUALITY_MAX_STD_DEV[level] ?? QUALITY_MAX_STD_DEV[2];
  }

  setLodEnabled(enabled) {
    this.spark.enableLod = enabled;
  }

  setLodScale(scale) {
    this.spark.lodSplatScale = scale;
  }

  /** UIの入力にフォーカスがある間、キーボード移動を止める */
  setKeyboardEnabled(enabled) {
    this.controls.fpsMovement.enable = enabled;
  }
}
