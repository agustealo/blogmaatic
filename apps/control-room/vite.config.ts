import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

function defaultDataDir(environment: NodeJS.ProcessEnv = process.env): string {
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Blogmaatic");
  if (process.platform === "win32") {
    return join(environment.LOCALAPPDATA ?? environment.APPDATA ?? join(home, "AppData", "Local"), "Blogmaatic");
  }
  return join(environment.XDG_DATA_HOME ?? join(home, ".local", "share"), "blogmaatic");
}

function developmentOperatorToken(dataDir: string): string {
  const tokenPath = join(resolve(dataDir), "secrets", "operator.token");
  let token: string;
  try {
    token = readFileSync(tokenPath, "utf8").trim();
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Control Room development requires an initialized Blogmaatic runtime credential at ${tokenPath}${detail}`);
  }
  if (token.length < 32) throw new Error(`Blogmaatic operator credential is unexpectedly short: ${tokenPath}`);
  return token;
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.BLOGMAATIC_DEV_API_TARGET || "http://127.0.0.1:4317";
  const shared = {
    plugins: [react()],
    preview: { host: "127.0.0.1" },
  };

  if (command !== "serve") return shared;

  const dataDir = env.BLOGMAATIC_DEV_DATA_DIR || defaultDataDir(env);
  const operatorToken = developmentOperatorToken(dataDir);
  return {
    ...shared,
    server: {
      host: "127.0.0.1",
      proxy: {
        "/api": {
          target,
          changeOrigin: false,
          rewrite: (path: string) => path.replace(/^\/api/, ""),
          configure(proxy) {
            proxy.on("proxyReq", (proxyRequest) => {
              proxyRequest.setHeader("authorization", `Bearer ${operatorToken}`);
              proxyRequest.removeHeader("cookie");
            });
          },
        },
      },
    },
  };
});
