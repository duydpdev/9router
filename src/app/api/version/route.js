import https from "https";
import { UPDATER_CONFIG } from "@/shared/constants/config";

const CURRENT_VERSION = process.env.APP_VERSION || "0.0.0";

const NPM_PACKAGE_NAME = UPDATER_CONFIG.npmPackageName;

// Fetch latest version from npm registry
function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`,
      { timeout: 4000 },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data).version || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export async function GET() {
  const latestVersion = await fetchLatestVersion();
  const hasUpdate = latestVersion ? compareVersions(latestVersion, CURRENT_VERSION) > 0 : false;

  return Response.json({ currentVersion: CURRENT_VERSION, latestVersion, hasUpdate });
}
