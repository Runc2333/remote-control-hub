import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, type ProxyOptions } from "vite";

const createProxy = (target: string): ProxyOptions => ({
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on("proxyReq", (proxyRequest) => {
      proxyRequest.setHeader("origin", target);
    });
  },
  target,
});

export default defineConfig(() => {
  const DEV_API_ORIGIN = process.env.RCH_DEV_API_ORIGIN;
  const DEV_API_TARGET =
    DEV_API_ORIGIN === undefined ? undefined : new URL(DEV_API_ORIGIN).origin;
  if (DEV_API_TARGET !== undefined && !DEV_API_TARGET.startsWith("https://")) {
    throw new Error("RCH_DEV_API_ORIGIN must use HTTPS");
  }
  return {
    build: {
      rollupOptions: {
        input: {
          app: resolve(import.meta.dirname, "index.html"),
          sw: resolve(import.meta.dirname, "src/sw.ts"),
        },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
        },
      },
    },
    plugins: [react(), tailwindcss()],
    ...(DEV_API_TARGET === undefined
      ? {}
      : {
          server: {
            proxy: {
              "/api": createProxy(DEV_API_TARGET),
              "/healthz": createProxy(DEV_API_TARGET),
            },
          },
        }),
  };
});
