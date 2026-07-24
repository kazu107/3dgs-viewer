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

    // 全レイヤーの親。シーン全体の位置/回転/倍率(world transform)を担う
    this.sceneRoot = new THREE.Group();
    this.scene.add(this.sceneRoot);

    this.layers = []; // [{ mesh, group }] — 合成ワールドでは複数レイヤーを同時表示
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

  #meshSplatCount(m) {
    // LoD有効時はpackedSplatsが0になり、実数はlastSplatsに入る
    let count = 0;
    for (const source of [m.packedSplats, m.extSplats, m.splats, m.lastSplats]) {
      count = Math.max(count, source?.numSplats ?? 0);
    }
    return count;
  }

  splatCount() {
    return this.layers.reduce((sum, l) => sum + this.#meshSplatCount(l.mesh), 0);
  }

  /**
   * シーンをロードして表示する。既存シーンは破棄。
   * @param {object} sceneInfo /api/scenes のシーンエントリ
   * @param {string|Array} sources 単一URL、または
   *   [{url?, fileBytes?, fileName?, layer?}] の配列(合成ワールドは複数要素)。
   *   layer = scenes.json の layers エントリ ({name, key, transform, options})
   * @returns ロードしたメッシュ配列(切替済みならnull)
   */
  async loadScene(sceneInfo, sources, { onProgress, keepCamera = false } = {}) {
    const list = typeof sources === "string" ? [{ url: sources }] : sources;
    return this.#load(sceneInfo, list, onProgress, keepCamera);
  }

  /** ローカルファイル(アップロードスタジオ)からシーンをロードする */
  async loadSceneFromBytes(sceneInfo, fileBytes, fileName, { onProgress, keepCamera = false } = {}) {
    return this.#load(
      sceneInfo,
      [{ fileBytes, fileName }],
      onProgress ? (_i, e) => onProgress(e) : undefined,
      keepCamera
    );
  }

  async #load(sceneInfo, sources, onProgress, keepCamera = false) {
    const id = ++this.loadId;
    this.#disposeCurrent();

    const globalOptions = sceneInfo.options || {};
    const created = [];
    let meshes;
    try {
      meshes = await Promise.all(
        sources.map(async (source, index) => {
          const options = source.layer?.options ?? globalOptions;
          const keyName =
            source.layer?.key ||
            sceneInfo.key ||
            source.fileName ||
            (source.url ? source.url.split("?")[0] : "");
          const isRad = /\.rad$/i.test(keyName);
          const mesh = new SplatMesh({
            url: source.url,
            fileBytes: source.fileBytes,
            fileName: source.fileName,
            onProgress: onProgress ? (e) => onProgress(index, e) : undefined,
            // 広域シーン向け: .rad以外はデフォルトでランタイムLoDツリーを構築
            lod: options.lod ?? (isRad ? undefined : true),
            // 原点から離れた座標での量子化誤差を防ぐ(広域シーン向け)
            extSplats: options.extSplats ?? undefined,
            paged: options.paged ?? undefined,
            maxSplats: options.maxSplats ?? undefined,
          });
          created.push(mesh);
          await mesh.initialized;
          return mesh;
        })
      );
    } catch (err) {
      for (const m of created) m.dispose();
      throw err;
    }

    if (id !== this.loadId) {
      // ロード中に別シーンへ切り替わった
      for (const m of meshes) m.dispose();
      return null;
    }

    meshes.forEach((mesh, index) => {
      const group = new THREE.Group();
      group.add(mesh);
      this.sceneRoot.add(group);
      const layerDef = sources[index].layer;
      if (layerDef) {
        this.#applyLayerTransform(mesh, group, layerDef.transform);
      } else {
        this.#applyTransform(mesh, sceneInfo.transform);
      }
      this.layers.push({ mesh, group });
    });

    // シーン全体の位置/回転/倍率を適用(カメラ自動配置より前に反映)
    this.#applyWorldTransform(sceneInfo.world);
    this.sceneRoot.updateMatrixWorld(true);

    // 表示データ切替時はカメラを動かさない
    if (!keepCamera) this.#setupCamera(sceneInfo);
    return meshes;
  }

  // シーン全体を包む sceneRoot への world transform(位置/回転XYZ/倍率)
  #applyWorldTransform(world) {
    const pos = world?.position ?? [0, 0, 0];
    const rot = world?.rotationDeg ?? [0, 0, 0];
    const scale = Number.isFinite(world?.scale) && world.scale > 0 ? world.scale : 1;
    this.sceneRoot.position.fromArray(pos);
    this.sceneRoot.rotation.set(
      THREE.MathUtils.degToRad(rot[0]),
      THREE.MathUtils.degToRad(rot[1]),
      THREE.MathUtils.degToRad(rot[2])
    );
    this.sceneRoot.scale.setScalar(scale);
  }

  /** シーン全体の world transform をライブ更新する(アップロードスタジオ用) */
  setWorldTransform(world) {
    this.#applyWorldTransform(world);
    this.sceneRoot.updateMatrixWorld(true);
  }

  /** レイヤーの配置をライブ更新する(合成ワールドの位置合わせ用) */
  setLayerTransform(index, transform) {
    const layer = this.layers[index];
    if (!layer) return;
    this.#applyLayerTransform(layer.mesh, layer.group, transform);
    layer.group.updateMatrixWorld(true);
  }

  /** レイヤーの表示/非表示を切り替える */
  setLayerVisible(index, visible) {
    const layer = this.layers[index];
    if (layer) layer.group.visible = visible;
  }

  /** 名前付き視点へスムーズに移動する ({position, target?, fov?}) */
  applyViewpoint(vp, durationMs = 900) {
    if (!Array.isArray(vp?.position) || vp.position.length !== 3) return;
    const toPos = new THREE.Vector3().fromArray(vp.position);
    let toQuat = this.camera.quaternion.clone();
    if (Array.isArray(vp.target) && vp.target.length === 3) {
      const target = new THREE.Vector3().fromArray(vp.target);
      const m = new THREE.Matrix4().lookAt(toPos, target, this.camera.up);
      toQuat = new THREE.Quaternion().setFromRotationMatrix(m);
    }
    if (Number.isFinite(vp.fov)) {
      this.camera.fov = vp.fov;
      this.camera.updateProjectionMatrix();
    }
    this.#startFlight(toPos, toQuat, durationMs);
  }

  /**
   * COLMAPのworld-to-cameraポーズ(images.txtの1行)をビューア座標系の視点に変換する。
   * カメラ中心 C = -R^T t、視線方向 = R^T (0,0,1)。その後、シーンに適用している
   * 変換(デフォルト: X軸180°回転)と同じ行列を適用して表示座標に合わせる。
   */
  colmapPoseToViewpoint({ qw, qx, qy, qz, tx, ty, tz, name }) {
    const qInv = new THREE.Quaternion(qx, qy, qz, qw).invert();
    const center = new THREE.Vector3(tx, ty, tz).applyQuaternion(qInv).negate();
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(qInv);
    const m = this.layers[0]
      ? this.layers[0].mesh.matrixWorld
      : new THREE.Matrix4().makeRotationX(Math.PI);
    const pos = center.clone().applyMatrix4(m);
    const target = center.clone().add(dir).applyMatrix4(m);
    const round = (v) => Math.round(v * 1000) / 1000;
    return {
      name,
      position: [round(pos.x), round(pos.y), round(pos.z)],
      target: [round(target.x), round(target.y), round(target.z)],
    };
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
    for (const { mesh, group } of this.layers) {
      this.sceneRoot.remove(group);
      mesh.dispose();
    }
    this.layers = [];
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

  // レイヤー配置: 内側のmeshにY下→Y上の反転回転、外側のgroupに
  // 位置・方位(ワールドY軸回り)・スケールを適用する
  #applyLayerTransform(mesh, group, transform) {
    const rotDeg = transform?.rotationDeg ?? [180, 0, 0];
    mesh.rotation.set(
      THREE.MathUtils.degToRad(rotDeg[0]),
      THREE.MathUtils.degToRad(rotDeg[1]),
      THREE.MathUtils.degToRad(rotDeg[2])
    );
    group.position.set(0, 0, 0);
    if (transform?.position) group.position.fromArray(transform.position);
    group.rotation.set(0, THREE.MathUtils.degToRad(transform?.headingDeg ?? 0), 0);
    const scale = Number.isFinite(transform?.scale) && transform.scale > 0 ? transform.scale : 1;
    group.scale.setScalar(scale);
  }

  #setupCamera(sceneInfo) {
    const cam = sceneInfo.camera;
    let center = new THREE.Vector3();
    let diag = 10;

    try {
      // 全レイヤーのバウンディングボックスを統合
      const box = new THREE.Box3();
      for (const { mesh } of this.layers) {
        const b = mesh.getBoundingBox().clone();
        b.applyMatrix4(mesh.matrixWorld);
        box.union(b);
      }
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
    const meshes = this.layers.filter((l) => l.group.visible).map((l) => l.mesh);
    if (meshes.length === 0) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(meshes, false);
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
