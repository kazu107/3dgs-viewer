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
 * シーン(またはバリアント)のダウンロードURLを解決する。
 * デモシーンは直接URL、R2のシーンはpresigned URLをサーバから取得。
 * @param {{url?: string, key?: string}} source
 */
export async function resolveSceneUrl(source) {
  if (source.url) return source.url;
  const res = await fetch(`/api/scenes/url?key=${encodeURIComponent(source.key)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `シーンURLの取得に失敗しました (${res.status})`);
  }
  const data = await res.json();
  return data.url;
}
