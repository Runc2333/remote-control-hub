import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;
const hmr =
  host === undefined
    ? {}
    : {
        hmr: {
          host,
          port: 1421,
          protocol: "ws" as const,
        },
      };

export default defineConfig({
  clearScreen: false,
  plugins: [react(), tailwindcss()],
  server: {
    ...hmr,
    host: host ?? false,
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
