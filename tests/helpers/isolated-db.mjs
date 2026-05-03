import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function setupIsolatedDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-test-"));
  process.env.DATA_DIR = dir;
  return {
    dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}
