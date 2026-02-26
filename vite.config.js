import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    outDir: "dist",
  },
  // Prevent HMR loop: limit what triggers full CSS rebuild
  server: {
    watch: {
      // Don't watch node_modules
      ignored: ["**/node_modules/**"],
    },
  },
})
