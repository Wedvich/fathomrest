import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Sim state lives in IndexedDB (persistence.ts); the SW only owns the
      // static app shell. "prompt" avoids a surprise reload mid-session that
      // would race the visibility-return clock re-anchor.
      registerType: "prompt",
      workbox: {
        globPatterns: ["**/*.{js,css,html,woff2}"],
      },
      manifest: {
        name: "Fathomrest",
        short_name: "Fathomrest",
        display: "standalone",
        background_color: "#0b1a2b",
        theme_color: "#0b1a2b",
      },
    }),
  ],
});
