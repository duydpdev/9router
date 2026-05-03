import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");
const srcDir = path.join(projectRoot, "src");

function tryFile(p) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return p;
    if (st.isDirectory()) {
      const idx = path.join(p, "index.js");
      if (fs.statSync(idx).isFile()) return idx;
    }
  } catch {}
  return null;
}

function resolveAlias(specifier, baseDir) {
  const base = path.join(baseDir, specifier);
  const candidates = [
    tryFile(base),
    tryFile(base + ".js"),
    tryFile(base + ".mjs"),
    tryFile(path.join(base, "index.js")),
  ];
  for (const c of candidates) {
    if (c) return c;
  }
  return null;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const found = resolveAlias(specifier.slice(2), srcDir);
    if (found) return nextResolve(pathToFileURL(found).href, context);
  }
  if (specifier === "open-sse") {
    const found = tryFile(path.join(projectRoot, "open-sse", "index.js"));
    if (found) return nextResolve(pathToFileURL(found).href, context);
  }
  if (specifier.startsWith("open-sse/")) {
    const found = resolveAlias(specifier.slice("open-sse/".length), path.join(projectRoot, "open-sse"));
    if (found) return nextResolve(pathToFileURL(found).href, context);
  }
  return nextResolve(specifier, context);
}
