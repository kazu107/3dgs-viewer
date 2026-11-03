import * as THREE from "three";

/**
 * SplatMesh のローカル座標でのバウンディングボックス(スプラット中心ベース)。
 * Spark の getBoundingBox() は mesh.splats しか走査しないため、LoD有効時は
 * データが lodSplats 側へ移って空のボックスを返す。その場合は lodSplats から求める。
 * いずれの場合も新しい Box3 を返すので、呼び出し側でそのまま変換してよい。
 */
export function splatLocalBounds(mesh) {
  const box = mesh.getBoundingBox();
  if (!box.isEmpty()) return box;
  const lod = mesh.packedSplats?.lodSplats ?? mesh.extSplats?.lodSplats;
  const out = new THREE.Box3();
  lod?.forEachSplat?.((_index, center) => out.expandByPoint(center));
  return out;
}
