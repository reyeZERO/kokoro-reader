import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

const base = process.env.BASE_PATH ?? '/'

export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'Kokoro Reader',
        short_name: 'Kokoro',
        description: 'Offline EPUB reader with local neural multi-voice TTS',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell only. Model weights (~90MB+) are cached explicitly by modelStore via CacheStorage,
        // never by workbox precache (would blow past the precache size limit and bloat updates).
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,mjs,wasm}'],
        // The worker bundle drags a second copy of the ORT wasm into /assets; we serve ours from /ort.
        globIgnores: ['**/assets/ort-wasm-*'],
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
        navigateFallback: `${base}index.html`,
        // No runtimeCaching for huggingface.co / jsdelivr. The model weights + voices are cached
        // explicitly by transformers.js (env.useBrowserCache) and the worker's warmVoices(), and the
        // ORT wasm is self-hosted under /ort. Intercepting the ~92 MB model download with workbox
        // CacheFirst double-buffers it (SW cache + transformers cache) and hangs iOS Safari on the
        // streaming clone of a large cross-origin redirect — the model sat at 0% "Fetching manifest".
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
  ],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['kokoro-js', 'onnxruntime-web', '@huggingface/transformers'] },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  server: {
    headers: {
      // Enables multi-threaded WASM in dev. Safari iOS ignores SAB threads mostly; harmless.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
})
