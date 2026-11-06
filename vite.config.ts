import { defineConfig } from "vite";

export default defineConfig({
  root: "src/client",
  publicDir: "../../public",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // three.js num arquivo próprio: o painel aparece antes da cena 3D carregar.
        manualChunks(id) {
          if (id.includes("node_modules/three")) return "three";
        },
      },
    },
  },
  server: { proxy: { "/api": { target: "http://localhost:8787", ws: true } } },
});
