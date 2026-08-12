import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: here('src/renderer'),
  // Les fichiers sont chargés via file:// dans l'app packagée : les chemins doivent être relatifs.
  base: './',
  build: {
    outDir: here('dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // La fenêtre principale, et celle des agents — rapport, question,
        // discussion. Une entrée à part plutôt qu'une route : ces fenêtres ne
        // partagent ni l'état, ni le pont IPC de la première.
        main: here('src/renderer/index.html'),
        agent: here('src/renderer/agent.html'),
      },
    },
  },
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
  },
})
