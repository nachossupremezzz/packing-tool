import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Project site on GitHub Pages is served from /packing-tool/.
  base: '/packing-tool/',
  plugins: [react()],
})
