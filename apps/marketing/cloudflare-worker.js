function docsOrigin(value) {
  const origin = new URL(value);
  const local = origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname);
  if (
    (!local && origin.protocol !== "https:") ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("DOCS_ORIGIN must be an HTTPS origin (or localhost during development)");
  }
  return origin;
}

function rewriteLocation(response, publicOrigin, upstreamOrigin) {
  const location = response.headers.get("location");
  if (!location) return response;

  const target = new URL(location, upstreamOrigin);
  if (target.origin !== upstreamOrigin.origin) return response;

  const headers = new Headers(response.headers);
  headers.set("location", `${publicOrigin}${target.pathname}${target.search}${target.hash}`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleRequest(request, env, fetchImpl = globalThis.fetch) {
  const url = new URL(request.url);
  if (url.pathname === "/docs" || url.pathname.startsWith("/docs/")) {
    const origin = docsOrigin(env.DOCS_ORIGIN);
    if (origin.origin === url.origin) throw new Error("DOCS_ORIGIN must not point back to marketing");

    const upstream = new URL(`${url.pathname}${url.search}`, origin);
    const response = await fetchImpl(new Request(upstream, request));
    return rewriteLocation(response, url.origin, origin);
  }

  return env.ASSETS.fetch(request);
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
