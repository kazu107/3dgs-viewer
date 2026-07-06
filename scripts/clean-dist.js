// dist/ を削除する。
// OneDrive同期フォルダ内ではNodeのfs.rmSync(recursive)がクラッシュすることがあるため、
// OSネイティブの削除コマンドを使う。
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

if (existsSync(dist)) {
  if (process.platform === "win32") {
    execSync(`rmdir /s /q "${dist}"`, { shell: "cmd.exe", stdio: "inherit" });
  } else {
    execSync(`rm -rf "${dist}"`, { stdio: "inherit" });
  }
}
