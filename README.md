# Astro + Bun: marketing and docs

Two independently deployable Astro 7 applications in a Bun workspace. Both prerender their pages at build time using Astro's static output; no SSR adapter is needed for Netlify or Vercel. Pages are authored as `.astro` components with a shared layout and stylesheet within each app.

```text
apps/
  marketing/
    astro.config.mjs
    netlify.toml
    vercel.json
    src/pages/           # /, /about, /pricing, custom 404
    src/layouts/
    src/styles/
  docs/
    astro.config.mjs
    netlify.toml
    vercel.json
    src/pages/docs/      # /docs, /docs/getting-started, /docs/guides/deployment
    src/pages/404.astro
    src/layouts/
    src/styles/
scripts/
  preview.js             # Preview both built apps behind one local URL
  preview.test.js        # Build-output, link, asset, and routing checks
```

## Develop and build

Use Node.js 24 and Bun 1.3.10. Bun manages the workspace and scripts; Astro's CLI runs on Node.js.

```sh
bun install
bun run dev
```

- Marketing: <http://localhost:3000>
- Docs through marketing: <http://localhost:3000/docs>
- Docs directly: <http://localhost:3001/docs>

Both Astro dev servers start together. Marketing proxies the docs namespace locally; development scripts load from the docs server to keep its Vite modules and hot reload separate. `PORT` and `DOCS_PORT` override the defaults if occupied. For example:

```sh
PORT=4400 DOCS_PORT=4401 bun run dev
```

You can also run `bun run dev` from either app directory, or use `bun run dev:marketing` / `bun run dev:docs` at the repository root. When developing only marketing, start docs separately to use the docs proxy.

```sh
bun run build             # Build both apps
bun run build:marketing   # Build only marketing
bun run build:docs        # Build only docs
bun run test              # Build, then run all tests
bun run preview           # Serve both existing builds with the docs proxy
```

`bun run preview` defaults to ports 3000 and 3001 and accepts the same port environment variables. Stop the dev servers first or select different ports. This preview serves the generated files and models slashless routing; it is not a full Netlify/Vercel emulator. Each app also supports `bun run preview` for its own Astro preview server.

## Routes without trailing slashes

Both Astro configs use:

```js
output: "static",
trailingSlash: "never",
build: { format: "file" }
```

This generates `about.html`, `docs.html`, and `docs/getting-started.html`, rather than nested `index.html` files. Page links use `/about`, `/docs`, and `/docs/getting-started`. The homepage remains `/`.

Docs pages explicitly live in `src/pages/docs`; an extra `base: "/docs"` setting would duplicate the prefix. Docs uses `build.assets: "docs/_astro"` to keep Astro's generated CSS/JS within the proxied namespace. Place additional public docs assets under `apps/docs/public/docs/` and link to them with `/docs/...` URLs. See [Astro's build configuration](https://docs.astro.build/en/reference/configuration-reference/#buildformat).

Vercel's `trailingSlash: false` redirects slash-ending paths to their slashless form; `cleanUrls: true` serves the HTML files without `.html`. Netlify's Pretty URLs processing is disabled so it does not add trailing slashes. Netlify may still accept slash-ending aliases: its redirect engine normalizes paths before matching and cannot safely enforce slash removal with a `/path/ → /path` rule. Do not add those rules, which can loop. See [Netlify's trailing-slash behavior](https://docs.netlify.com/manage/routing/redirects/redirect-options/#trailing-slash).

## Deploy to Netlify

Create two projects from this repository in the same Netlify team. Set the package directory for each project so Netlify finds its `netlify.toml`:

| Setting | Docs | Marketing |
| --- | --- | --- |
| Package directory | `apps/docs` | `apps/marketing` |
| Base directory | Repository root | Repository root |
| Build command | `bun run build:docs` | `bun run build:marketing` |
| Publish directory | `apps/docs/dist` | `apps/marketing/dist` |

The configs explicitly select the repository root for installation/builds, preserving the shared Bun lockfile. They also select Node.js 24 and Bun 1.3.10. See [Netlify's monorepo configuration](https://docs.netlify.com/build/configure-builds/monorepos/).

Deploy docs first, then marketing. The existing docs hostname in marketing's TOML has been preserved. Update both proxy destinations if you create a different docs project.

```toml
[[redirects]]
  from = "/docs"
  to = "https://YOUR-DOCS-SITE.netlify.app/docs"
  status = 200
  force = true

[[redirects]]
  from = "/docs/*"
  to = "https://YOUR-DOCS-SITE.netlify.app/docs/:splat"
  status = 200
  force = true
```

These are rewrites: the browser stays on marketing's domain. The docs domain's `/` redirects to `/docs` as a convenience. Both sites must be in the same team, and the docs target must be accessible to the proxy. See [Netlify proxy limitations](https://docs.netlify.com/manage/routing/redirects/rewrites-proxies/).

## Deploy to Vercel

Create two projects from this repository:

| Setting | Docs | Marketing |
| --- | --- | --- |
| Root Directory | `apps/docs` | `apps/marketing` |
| Framework Preset | Astro | Astro |
| Install Command | `bun install --frozen-lockfile` | `bun install --frozen-lockfile` |
| Build Command | `bun run build` | `bun run build` |
| Output Directory | `dist` | `dist` |

The app's `vercel.json` supplies its framework, commands, output, and routing settings. Keep **Include source files outside of the Root Directory in the Build Step** enabled to make the workspace manifest and lockfile available. The apps now build with `astro build` directly and no longer need the old parent `scripts/build.js`.

For CLI deployment with these project settings, run from the repository root:

```sh
vercel link --project docs
vercel --prod
```

Verify the docs production domain at `/docs`. Marketing's JSON preserves the previously configured docs hostname; update both rewrite destinations if the docs domain changes. Then select and deploy marketing from the same directory:

```sh
vercel link --project marketing
vercel --prod
```

Add `--scope YOUR-TEAM` if needed. If your terminal is inside an app, use `--cwd ../..` on both commands. The repository root has one active project link, so relink before switching apps. See [Vercel's monorepo CLI instructions](https://vercel.com/docs/monorepos#add-a-monorepo-through-vercel-cli).

Use a docs production URL accessible without a Vercel login. Protected previews can return an authentication page. Standard Vercel rewrites also give existing files precedence, so keep the `/docs` namespace out of marketing's pages and public directory.

## Verify the deployed sites

Redeploy **docs first**, then marketing: older docs deployments still have the previous directory output and slash-ending paths.

On marketing's domain, test `/`, `/about`, `/pricing`, `/docs`, `/docs/getting-started`, and `/docs/guides/deployment`. Open a nested docs URL directly and refresh it. Check that its generated `/docs/_astro/*.css` stylesheet loads through marketing. A missing docs page should return a docs 404.

For Vercel, also verify that `/about/` and `/docs/getting-started/` redirect to the corresponding slashless URL on the marketing domain. For Netlify, verify the canonical slashless pages load without being redirected to slash-ending URLs.

```sh
curl -i https://YOUR-MARKETING-DOMAIN/docs
curl -i https://YOUR-MARKETING-DOMAIN/docs/guides/deployment
curl -i https://YOUR-MARKETING-DOMAIN/docs/not-a-real-page
```

Expect 200 for existing canonical pages and 404 for the missing page. No response should redirect to the docs hostname.

Preview deployments currently use the docs hostname committed in the platform config. They do not automatically pair docs and marketing previews for a PR. A CI workflow can deploy docs first and inject its deployment URL into marketing's configuration before deploying marketing.
