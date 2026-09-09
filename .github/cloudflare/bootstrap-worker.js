export default {
  fetch() {
    return new Response("This Worker is reserved for GitHub preview deployments.\n", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Robots-Tag": "noindex",
      },
    });
  },
};
