import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const getCommitHash = () => {
  // Deploy override for checkouts where git can't answer: shallow clones,
  // tarball builds. CI usually has the sha in hand anyway — see DEPLOY.md.
  const override = process.env.VITE_COMMIT_SHA;
  if (override) return override.slice(0, 8);
  try {
    return execSync("git rev-parse --short=8 HEAD").toString().trim();
  } catch {
    return "unknown";
  }
};

// Every network the app (and the kaspa SDK) understands. A build with any
// other id — a typo like "mainet" — could never connect to anything, so it
// must die at build time, not in a deployed bundle.
const KNOWN_NETWORKS = ["mainnet", "testnet-10", "testnet-11", "devnet", "simnet"];

export default defineConfig(({ mode, command }) => {
  // .env / .env.local / .env.[mode] plus the real environment; process.env
  // wins, matching Vite's own precedence for import.meta.env.
  const env = { ...loadEnv(mode, __dirname, "VITE_"), ...process.env };

  // The default mirrors NETWORK_ID in src/shared/lib/match.ts — the one
  // place the network is otherwise named.
  const networkId = env.VITE_NETWORK_ID || "testnet-10";
  if (!KNOWN_NETWORKS.includes(networkId)) {
    throw new Error(
      `VITE_NETWORK_ID="${networkId}" is not a Kaspa network this app knows. ` +
        `Valid values: ${KNOWN_NETWORKS.join(" | ")}.`,
    );
  }

  // Test-network production builds are the norm today (mainnet is future),
  // so a non-mainnet `vite build` warns loudly rather than failing: the
  // point is that a public deploy on a test network is a choice, not an
  // accident of the testnet-10 default.
  if (command === "build" && mode === "production" && networkId !== "mainnet") {
    const bar = "!".repeat(72);
    console.warn(
      `\n${bar}\n` +
        `!!  Production build targets TEST network "${networkId}".\n` +
        `!!  Expected for today's testnet deploys — but this is NOT a mainnet\n` +
        `!!  build. Set VITE_NETWORK_ID=mainnet when that day comes.\n` +
        `${bar}\n`,
    );
  }

  return {
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
  };
});
