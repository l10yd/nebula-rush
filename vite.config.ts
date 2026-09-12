import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5178,
    strictPort: false,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
  preview: {
    port: 5179,
    host: '127.0.0.1',
  },
});
