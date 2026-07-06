/**
 * COLMAP images.txt のパーサ。
 * 形式: 2行で1画像。1行目 = IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME、
 * 2行目 = POINTS2D(読み飛ばす)。#始まりはコメント。
 * RealityScanのRegistration→Colmapエクスポート(ASCII)で得られる。
 */
export function parseColmapImagesText(text) {
  const lines = text.split(/\r?\n/);
  const poses = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 10) continue;
    const imageId = Number(parts[0]);
    const cameraId = Number(parts[8]);
    const nums = parts.slice(1, 8).map(Number);
    if (!Number.isFinite(imageId) || !Number.isFinite(cameraId) || nums.some((n) => !Number.isFinite(n))) {
      continue;
    }
    const [qw, qx, qy, qz, tx, ty, tz] = nums;
    poses.push({ qw, qx, qy, qz, tx, ty, tz, name: parts.slice(9).join(" ") });
    i++; // 次の行はPOINTS2Dなので読み飛ばす
  }
  // ファイル名順(数値対応)に並べると撮影順に近くなる
  poses.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return poses;
}
