import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // Must precede the react plugin: it generates routeTree.gen.ts from
    // src/routes and rewrites route files for code splitting, and react()
    // would otherwise transform them first.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      // Override to point the dev UI at a different API (e.g. a branch running
      // on another port) without editing this file.
      '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:4000',
    },
  },
})
