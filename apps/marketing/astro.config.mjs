import { defineConfig } from "astro/config";
import { docsDevProxy } from "./docs-dev-proxy.mjs";

export default defineConfig({
  output: "static",
  trailingSlash: "never",
  build: { format: "file", inlineStylesheets: "never" },
  server: { port: Number(process.env.PORT || 3000) },
  vite: {
    server: { strictPort: true },
    plugins: [
      docsDevProxy(`http://localhost:${process.env.DOCS_PORT || 3001}`),
    ],
  },
});
