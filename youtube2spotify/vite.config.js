import { defineConfig } from "vite";

export default defineConfig({
  base: "/youtube2spotify/",
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
