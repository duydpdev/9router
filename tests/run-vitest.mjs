// Programmatic vitest runner. The vitest CLI bin lives under a node_modules
// path that the sandbox blocks from the shell, so we drive it via its Node API.
import { startVitest } from "vitest/node";

const filters = process.argv.slice(2);

const vitest = await startVitest("test", filters, {
  run: true,
  watch: false,
  config: new URL("./vitest.config.js", import.meta.url).pathname,
});

await vitest?.close();
const failed = vitest?.state.getFiles().some((f) => f.result?.state === "fail");
process.exit(failed ? 1 : 0);
