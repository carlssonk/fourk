/**
 * Bundles the sweeper (main.ts) into one Node ESM file with everything
 * inlined, the two wasm binaries copied beside it. `pnpm build:sweeper`;
 * infra/node uploads sweeper/dist to the node box.
 */

import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "dist");

export default defineConfig({
  root: here,
  // Only the real environment: app/.env.local pins developers to simnet and
  // must never leak into a deployed sweeper. Unset means testnet-10.
  envDir: here,
  mode: "production",
  define: { __COMMIT_HASH__: JSON.stringify("sweeper") },
  // The kaspa SDK recognises its own classes by constructor name; minified
  // names break it (see the app's vite.config.ts).
  esbuild: { keepNames: true },
  ssr: { target: "node", noExternal: true },
  build: {
    ssr: resolve(here, "main.ts"),
    outDir,
    emptyOutDir: true,
    target: "node22",
    minify: false,
    rollupOptions: { output: { entryFileNames: "sweeper.mjs" } },
  },
  plugins: [
    {
      name: "copy-wasm",
      closeBundle() {
        fs.copyFileSync(
          resolve(here, "../../vendor/kaspa-wasm/kaspa_bg.wasm"),
          resolve(outDir, "kaspa_bg.wasm"),
        );
        fs.copyFileSync(
          resolve(here, "../../wasm/pkg/fourk_wasm_bg.wasm"),
          resolve(outDir, "fourk_wasm_bg.wasm"),
        );
      },
    },
  ],
});
