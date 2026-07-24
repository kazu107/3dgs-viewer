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

/**
 * スプラットのダウンロードURLを事前検査し、Sparkの復号前に具体的な原因を検出する。
 * 問題があれば分かりやすいErrorをthrowする。ネットワーク系の失敗はSpark本体に委ねる。
 * @param {string} url  ダウンロードURL(presignedまたは公開URL)
 * @param {string} [keyOrName]  形式判定用のキー/ファイル名
 */
export async function preflightSceneUrl(url, keyOrName) {
  let resp;
  try {
    // 先頭数十バイトだけ取得(Range非対応でも下でストリームを即キャンセルするので軽い)
    resp = await fetch(url, { headers: { Range: "bytes=0-255" } });
  } catch {
    return; // CORS/ネットワークはSpark側のエラーに任せる(friendlyLoadErrorで案内)
  }
  if (resp.status >= 400) {
    throw new Error(`ダウンロードに失敗しました (HTTP ${resp.status})`);
  }
  let buf = new Uint8Array();
  try {
    const reader = resp.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    if (value) buf = value;
  } catch {
    return;
  }
  if (buf.length < 4) return;

  // 先頭(最大256バイト)を文字列化。R2のXMLエラーは <Code> が先頭付近に入る
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf).trim();
  const head = text.slice(0, 40);
  // R2/サーバがファイル本体ではなくXML/JSON/HTMLのエラー応答を返しているケース
  if (
    head.startsWith("<?xml") ||
    head.startsWith("<") ||
    /<Error>|AccessDenied|NoSuchKey|SignatureDoesNotMatch|InvalidAccessKeyId/i.test(text)
  ) {
    const code = text.match(/<Code>([^<]+)<\/Code>/i)?.[1] || "";
    const hints = {
      AccessDenied:
        "APIトークンにオブジェクトの読み取り権限があるか、対象バケットが権限範囲に含まれているか確認してください。",
      InvalidAccessKeyId: "R2_ACCESS_KEY_ID が正しいか確認してください。",
      SignatureDoesNotMatch:
        "R2_SECRET_ACCESS_KEY が正しいか、PCの時計が大きくずれていないか確認してください。",
      NoSuchKey:
        "指定したキーのファイルがバケットに存在しません(scenes.json のキーと実ファイル名の不一致、またはアップロード未完了)。",
      NoSuchBucket: "R2_BUCKET のバケット名が正しいか確認してください。",
    };
    const detail = code
      ? `R2エラー: ${code}。${hints[code] || "R2の設定を確認してください。"}`
      : head.toLowerCase().startsWith("<!doctype") || /<html/i.test(head)
        ? "取得先がR2ではなくHTMLページを返しました。R2_PUBLIC_BASE_URL の設定を確認してください。"
        : "R2のCORS設定・APIトークンの権限・オブジェクトキーを確認してください。";
    throw new Error("サーバがファイル本体ではなくエラー応答を返しました。" + detail);
  }

  const name = (keyOrName || url.split("?")[0]).toLowerCase();
  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
  const isPly = head.startsWith("ply");
  if (name.endsWith(".spz") && !isGzip) {
    throw new Error(
      "有効な .spz(gzip圧縮)ファイルではありません。" +
        (isPly
          ? "中身は .ply のようです。拡張子を .ply にするか、正しいSPZに変換してください。"
          : "アップロード元のファイルが本当にSPZか確認してください。")
    );
  }
  if ((name.endsWith(".sog") || name.endsWith(".zip")) && !isZip && !isGzip) {
    throw new Error("有効な .sog / .zip アーカイブではありません。ファイルを確認してください。");
  }
}
