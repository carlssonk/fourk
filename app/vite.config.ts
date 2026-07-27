import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const getCommitHash = () => {
  try {
    return execSync("git rev-parse --short=8 HEAD").toString().trim();
  } catch {
    return "unknown";
  }
};

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@shared": resolve(__dirname, "./src/shared"),
      "@modules": resolve(__dirname, "./src/modules"),
    },
  },
  define: {
    __COMMIT_HASH__: JSON.stringify(getCommitHash()),
  },
  esbuild: {
    // Strip debug-level console output from production bundles
    pure: mode === "production" ? ["console.log", "console.info", "console.debug"] : [],
  },
  server: { fs: { allow: ["../.."] } },
  optimizeDeps: { exclude: ["kaspa-wasm", "fourk-wasm"] },
  build: { target: "es2022" },
}));
