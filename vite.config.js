import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Cloudflare Pages: build command `npm run build`, output dir `dist`.
// Routing is client-side (react-router BrowserRouter); Pages supports SPA
// fallback via the included `public/_redirects` + Pages Functions note below.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'es2018', // broad Smart-TV browser support (older webviews without modules)
  },
  server: {
    port: 5173,
  },
  esbuild: {
    // hls.js ships prebuilt ESM; keep even older TV/webview syntax in check.
    target: 'es2018',
  },
});
