import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  trailingSlash: "never",
  // The pages themselves live in src/pages/docs. No additional base prefix.
  build: { format: "file", assets: "docs/_astro", inlineStylesheets: "never" },
  server: { port: Number(process.env.DOCS_PORT || 3001) },
  vite: { server: { strictPort: true } },
});
