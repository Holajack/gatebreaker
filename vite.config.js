import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the bundle works when Capacitor serves it from the APK.
  base: './',
  // The parent directory is a Next.js site with its own Tailwind PostCSS config.
  // Pinning an empty config stops Vite walking up and inheriting it.
  css: { postcss: { plugins: [] } },
  build: {
    outDir: 'dist',
    target: 'es2019',
    assetsInlineLimit: 8192,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Split three.js out so the engine caches separately from game logic.
        manualChunks: { three: ['three'] },
      },
    },
  },
  server: { host: true, port: 5173 },
});
