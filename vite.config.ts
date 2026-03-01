import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import viteReact from "@vitejs/plugin-react";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { fileURLToPath, URL } from "url";

import tailwindcss from "@tailwindcss/vite";

const config = defineConfig({
  server: {
    host: true,
  },
  define: {
    "import.meta.env.VITE_NAVER_MAP_CLIENT_ID": JSON.stringify(
      process.env.VITE_NAVER_MAP_CLIENT_ID || "bduquac5yn",
    ),
    "import.meta.env.VITE_DEFAULT_ZOOM": JSON.stringify(
      process.env.VITE_DEFAULT_ZOOM || "14",
    ),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    devtools(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
