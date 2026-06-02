#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const cliDir = path.resolve(__dirname, "..");
const appDir = path.resolve(cliDir, "..");
const rootDir = path.resolve(appDir, "..");
const cliAppDir = path.join(cliDir, "app");
const buildHomeDir = path.join(cliDir, ".build-home");
const buildDistDirName = ".next-cli-build";
const buildDistDir = path.join(appDir, buildDistDirName);

// Exclude patterns for files/folders we don't want to copy
const EXCLUDE_PATTERNS = [
  "@img",           // Sharp image processing (not needed with unoptimized images)
  "sharp",          // Sharp core lib (not needed with unoptimized images)
  "detect-libc",    // Sharp dependency
  "logs",           // Runtime logs
  ".env",           // Environment files
  ".env.local",
  ".env.*.local",
  "*.log",          // Log files
  "tmp",            // Temp files
  ".DS_Store",      // macOS files
];

function shouldExclude(name) {
  return EXCLUDE_PATTERNS.some(pattern => {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return regex.test(name);
    }
    return name === pattern;
  });
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`Warning: Source ${src} does not exist`);
    return;
  }
  
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldExclude(entry.name)) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip broken symlinks (common in workspace setups)
    try {
      fs.accessSync(srcPath);
    } catch {
      continue;
    }

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      // Resolve and copy target (avoid linking outside bundle)
      try {
        const real = fs.realpathSync(srcPath);
        if (fs.statSync(real).isDirectory()) {
          copyRecursive(real, destPath);
        } else {
          fs.copyFileSync(real, destPath);
        }
      } catch {}
    } else {
      try {
        fs.copyFileSync(srcPath, destPath);
      } catch {}
    }
  }
}

console.log("📦 Building 9Router CLI package with Next.js...\n");

fs.mkdirSync(buildHomeDir, { recursive: true });
fs.mkdirSync(path.join(buildHomeDir, "AppData", "Roaming"), { recursive: true });
fs.mkdirSync(path.join(buildHomeDir, "AppData", "Local"), { recursive: true });

// Step 0: Sync version from app/cli/package.json to app/package.json
console.log("0️⃣  Syncing version to app/package.json...");
const cliPkg = JSON.parse(fs.readFileSync(path.join(cliDir, "package.json"), "utf8"));
const appPkgPath = path.join(appDir, "package.json");
const appPkg = JSON.parse(fs.readFileSync(appPkgPath, "utf8"));
if (appPkg.version !== cliPkg.version) {
  appPkg.version = cliPkg.version;
  fs.writeFileSync(appPkgPath, JSON.stringify(appPkg, null, 2) + "\n");
  console.log(`✅ Version synced: ${cliPkg.version}\n`);
} else {
  console.log(`✅ Version already synced: ${cliPkg.version}\n`);
}

// Step 1: Build app with Next.js (workspace tracing root → traced node_modules in standalone).
console.log("1️⃣  Building Next.js app...");
try {
  execSync("npm run build", {
    stdio: "inherit",
    cwd: appDir,
    env: {
      ...process.env,
      HOME: buildHomeDir,
      USERPROFILE: buildHomeDir,
      APPDATA: path.join(buildHomeDir, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(buildHomeDir, "AppData", "Local"),
      NEXT_DIST_DIR: buildDistDirName,
      NEXT_TRACING_ROOT_MODE: "workspace",
    }
  });
  console.log("✅ Next.js build completed\n");
} catch (error) {
  console.error("❌ Next.js build failed");
  process.exit(1);
}

// Step 2: Clean old app/cli/app if exists
console.log("2️⃣  Cleaning old app/cli/app...");
if (fs.existsSync(cliAppDir)) {
  fs.rmSync(cliAppDir, { recursive: true, force: true });
}
console.log("✅ Cleaned\n");

// Step 3: Copy Next.js standalone build to app/cli/app.
// Standalone output location depends on outputFileTracingRoot:
//   - root mode    → server.js directly under .next/standalone/
//   - older builds → nested under .next/standalone/app/
//   - workspace mode (NEXT_TRACING_ROOT_MODE=workspace, used by this build)
//     nests it under .next/standalone/<project-dir>/server.js so hoisted
//     node_modules are traced. Probe all three.
console.log("3️⃣  Copying Next.js standalone build to app/cli/app...");
const standaloneRoot = path.join(appDir, ".next", "standalone");
const standaloneRootResolved = path.join(buildDistDir, "standalone");
const standaloneRootToUse = fs.existsSync(standaloneRootResolved) ? standaloneRootResolved : standaloneRoot;
function locateStandaloneApp(root) {
  if (fs.existsSync(path.join(root, "server.js"))) return root;
  if (fs.existsSync(path.join(root, "app", "server.js"))) return path.join(root, "app");
  // workspace tracing mode: server.js sits one level deep under <project-dir>/
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "server.js"))) {
        return path.join(root, entry.name);
      }
    }
  }
  return path.join(root, "app"); // not found → error path below
}
const standaloneApp = locateStandaloneApp(standaloneRootToUse);
if (!fs.existsSync(path.join(standaloneApp, "server.js"))) {
  console.error("❌ Next.js standalone build not found under .next/standalone");
  console.error("Expected .next/standalone/server.js, /app/server.js, or /<project>/server.js");
  process.exit(1);
}
copyRecursive(standaloneApp, cliAppDir);

// Older nested-app layout stores traced node_modules at standalone root.
const standaloneNodeModules = path.join(standaloneRootToUse, "node_modules");
if (standaloneApp !== standaloneRootToUse && fs.existsSync(standaloneNodeModules)) {
  copyRecursive(standaloneNodeModules, path.join(cliAppDir, "node_modules"));
}
console.log("✅ Copied standalone build\n");

// Step 3b: Ensure sql.js (pure JS fallback) bundled in app/cli/app/node_modules.
// Strip better-sqlite3 (native) — it lives in ~/.9router/runtime to avoid
// Windows EBUSY during global CLI updates. node:sqlite (Node ≥22.5) is also
// available as a no-install middle tier.
console.log("3️⃣ b Configuring SQLite drivers...");
function ensureModuleInBundle(pkg) {
  const dest = path.join(cliAppDir, "node_modules", pkg);
  if (fs.existsSync(dest)) {
    console.log(`✅ ${pkg} already bundled`);
    return;
  }
  const candidates = [
    path.join(appDir, "node_modules", pkg),
    path.join(rootDir, "node_modules", pkg),
  ];
  const src = candidates.find((p) => fs.existsSync(p));
  if (!src) {
    console.warn(`⚠️  ${pkg} not found locally — bundle will rely on node:sqlite or runtime install`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  copyRecursive(src, dest);
  console.log(`✅ Bundled ${pkg}`);
}
ensureModuleInBundle("sql.js");
const betterDir = path.join(cliAppDir, "node_modules", "better-sqlite3");
if (fs.existsSync(betterDir)) {
  fs.rmSync(betterDir, { recursive: true, force: true });
  console.log("✅ Stripped better-sqlite3 (lives in ~/.9router/runtime)");
}
console.log("");

// Step 4: Copy static files
console.log("4️⃣  Copying static files...");
const staticSrc = path.join(appDir, ".next", "static");
const staticSrcResolved = path.join(buildDistDir, "static");
const staticDest = path.join(cliAppDir, buildDistDirName, "static");
if (fs.existsSync(staticSrcResolved) || fs.existsSync(staticSrc)) {
  copyRecursive(fs.existsSync(staticSrcResolved) ? staticSrcResolved : staticSrc, staticDest);
  console.log("✅ Copied static files\n");
} else {
  console.log("⏭️  No static files found\n");
}

// Step 5: Copy public folder if exists
console.log("5️⃣  Copying public folder...");
const publicSrc = path.join(appDir, "public");
const publicDest = path.join(cliAppDir, "public");
if (fs.existsSync(publicSrc)) {
  copyRecursive(publicSrc, publicDest);
  console.log("✅ Copied public folder\n");
} else {
  console.log("⏭️  No public folder found\n");
}

// Step 6: Copy vendor-chunks (required for production)
console.log("6️⃣  Copying vendor-chunks...");
const vendorChunksSrc = path.join(appDir, ".next", "server", "vendor-chunks");
const vendorChunksSrcResolved = path.join(buildDistDir, "server", "vendor-chunks");
const vendorChunksDest = path.join(cliAppDir, buildDistDirName, "server", "vendor-chunks");
if (fs.existsSync(vendorChunksSrcResolved) || fs.existsSync(vendorChunksSrc)) {
  copyRecursive(fs.existsSync(vendorChunksSrcResolved) ? vendorChunksSrcResolved : vendorChunksSrc, vendorChunksDest);
  console.log("✅ Copied vendor-chunks\n");
} else {
  console.log("⏭️  No vendor-chunks found\n");
}

// Step 7: Copy MITM server files (not bundled by Next.js standalone)
console.log("7️⃣  Copying MITM server files...");
const mitmSrc = path.join(appDir, "src", "mitm");
const mitmDest = path.join(cliAppDir, "src", "mitm");
if (fs.existsSync(mitmSrc)) {
  copyRecursive(mitmSrc, mitmDest);
  console.log("✅ Copied MITM files\n");
} else {
  console.log("⏭️  No MITM files found\n");
}

// Step 7b: Copy standalone updater (headless Node process for install progress)
console.log("7️⃣ b Copying updater files...");
const updaterSrc = path.join(appDir, "src", "lib", "updater");
const updaterDest = path.join(cliAppDir, "src", "lib", "updater");
if (fs.existsSync(updaterSrc)) {
  copyRecursive(updaterSrc, updaterDest);
  console.log("✅ Copied updater files\n");
} else {
  console.log("⏭️  No updater files found\n");
}

// Step 7c: Copy MCP control-plane source closure (not bundled by Next.js —
// the McpServer is run in-process by the 9router-mcp bin, not imported by the
// app). Mirrors the updater/MITM precedent: loose relative-import files under
// the bundle resolve under plain node. Closure = mcp + db layer + dataDir + the
// 3 leaf shared utils the db repos reach for.
console.log("7️⃣ c Copying MCP server source closure...");
function copyFileInBundle(relPath) {
  const src = path.join(appDir, relPath);
  const dest = path.join(cliAppDir, relPath);
  if (!fs.existsSync(src)) {
    console.warn(`⚠️  MCP closure file missing: ${relPath}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
copyRecursive(path.join(appDir, "src", "lib", "mcp"), path.join(cliAppDir, "src", "lib", "mcp"));
copyRecursive(path.join(appDir, "src", "lib", "db"), path.join(cliAppDir, "src", "lib", "db"));
copyFileInBundle(path.join("src", "lib", "dataDir.js"));
copyFileInBundle(path.join("src", "shared", "utils", "get-effective-status.js"));
copyFileInBundle(path.join("src", "shared", "constants", "pricing.js"));
copyFileInBundle(path.join("src", "shared", "utils", "apiKey.js"));
// Packages the closure needs that the app-traced node_modules may not include
// (zod + the MCP SDK are MCP-only; uuid is used by connectionsRepo). The SDK
// has a deep prod-dependency tree the Next trace never sees, so walk and bundle
// the full production closure of each, not just the top-level package dir.
function ensureModuleClosureInBundle(pkg, seen) {
  if (seen.has(pkg)) return;
  seen.add(pkg);
  ensureModuleInBundle(pkg);
  const srcPkg = [
    path.join(appDir, "node_modules", pkg),
    path.join(rootDir, "node_modules", pkg),
  ].find((p) => fs.existsSync(path.join(p, "package.json")));
  if (!srcPkg) return;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(srcPkg, "package.json"), "utf8"));
  } catch {
    return;
  }
  for (const dep of Object.keys(manifest.dependencies || {})) {
    ensureModuleClosureInBundle(dep, seen);
  }
}
const bundledClosure = new Set();
for (const pkg of ["uuid", "zod", "@modelcontextprotocol/sdk"]) {
  ensureModuleClosureInBundle(pkg, bundledClosure);
}
console.log(`✅ Copied MCP server closure (${bundledClosure.size} packages)\n`);

// Step 8: Build MITM server (config driven - see app/cli/scripts/buildMitm.js)
console.log("8️⃣  Building MITM server...");
try {
  execSync("node scripts/buildMitm.js", { stdio: "inherit", cwd: cliDir });
  console.log("✅ MITM server build completed\n");
} catch (error) {
  console.error("❌ MITM build failed");
  process.exit(1);
}

console.log("✨ CLI package build completed!");
console.log(`📁 Output: ${cliAppDir}`);

try {
  const { execSync: exec } = require("child_process");
  const size = exec(`du -sh "${cliAppDir}"`, { encoding: "utf8" }).trim();
  console.log(`📊 Package size: ${size.split("\t")[0]}`);
} catch (e) {
  // Silent fail on size check
}
