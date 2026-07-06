/** サーバAPIクライアント */

export async function fetchScenes() {
  const res = await fetch("/api/scenes");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `シーン一覧の取得に失敗しました (${res.status})`);
  }
  return res.json();
}

/**
 * シーンのダウンロードURLを解決する。
 * デモシーンは直接URL、R2のシーンはpresigned URLをサーバから取得。
 */
export async function resolveSceneUrl(scene) {
  if (scene.url) return scene.url;
  const res = await fetch(`/api/scenes/url?key=${encodeURIComponent(scene.key)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `シーンURLの取得に失敗しました (${res.status})`);
  }
  const data = await res.json();
  return data.url;
}
