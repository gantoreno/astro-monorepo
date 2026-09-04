// Astro's two dev servers have separate Vite clients and module graphs.
// Proxy pages, but load their dev modules from the docs server so CSS and HMR
// cannot accidentally use marketing's modules. Production uses hosting rules.
export function docsDevProxy(origin) {
  return {
    name: "docs-dev-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url, "http://localhost");
        if (url.pathname !== "/docs" && !url.pathname.startsWith("/docs/")) return next();
        try {
          const upstream = await fetch(new URL(url.pathname + url.search, origin), {
            method: request.method,
            redirect: "manual",
          });
          response.statusCode = upstream.status;
          for (const [key, value] of upstream.headers) {
            if (!["content-length", "content-encoding", "transfer-encoding", "connection"].includes(key)) {
              response.setHeader(key, value);
            }
          }
          if (request.method === "HEAD") return response.end();
          if (upstream.headers.get("content-type")?.includes("text/html")) {
            const html = await upstream.text();
            response.end(html.replace(/(<script\b[^>]*\bsrc=")\/(?!\/)/g, `$1${origin}/`));
          } else {
            response.end(Buffer.from(await upstream.arrayBuffer()));
          }
        } catch (error) {
          server.config.logger.error(`Docs proxy: ${error.message}`);
          response.statusCode = 502;
          response.end("Docs dev server is unavailable. Start both apps with bun run dev.");
        }
      });
    },
  };
}
