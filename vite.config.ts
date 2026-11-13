import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static site: relative base so it works on GitHub Pages under /<repo>/.
export default defineConfig({
  root: "web",
  base: "./",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 2500 },
  server: { fs: { allow: [".."] } },
});
