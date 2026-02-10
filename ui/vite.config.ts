import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:18789',
      '/ws/canvas': { target: 'ws://127.0.0.1:18789', ws: true },
      '/ws': { target: 'ws://127.0.0.1:18789', ws: true },
    },
  },
})
