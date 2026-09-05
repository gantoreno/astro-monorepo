# Astro + Bun: marketing and docs

Two independently deployable Astro 7 applications in a Bun workspace. Both prerender their pages at build time using Astro's static output; no SSR adapter is needed for Vercel. Pages are authored as `.astro` components with a shared layout and stylesheet within each app.

```text
apps/
  marketing/
    astro.config.mjs
    vercel.json
    src/pages/           # /, /about, /pricing, custom 404
    src/layouts/
    src/styles/
  docs/
    astro.config.mjs
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

`bun run preview` defaults to ports 3000 and 3001 and accepts the same port environment variables. Stop the dev servers first or select different ports. This preview serves the generated files and models slashless routing; it is not a full Vercel emulator. Each app also supports `bun run preview` for its own Astro preview server.

## Routes without trailing slashes

Both Astro configs use:

```js
output: "static",
trailingSlash: "never",
build: { format: "file" }
```

This generates `about.html`, `docs.html`, and `docs/getting-started.html`, rather than nested `index.html` files. Page links use `/about`, `/docs`, and `/docs/getting-started`. The homepage remains `/`.

Docs pages explicitly live in `src/pages/docs`; an extra `base: "/docs"` setting would duplicate the prefix. Docs uses `build.assets: "docs/_astro"` to keep Astro's generated CSS/JS within the proxied namespace. Place additional public docs assets under `apps/docs/public/docs/` and link to them with `/docs/...` URLs. See [Astro's build configuration](https://docs.astro.build/en/reference/configuration-reference/#buildformat).

Vercel's `trailingSlash: false` redirects slash-ending paths to their slashless form; `cleanUrls: true` serves the HTML files without `.html`.

## Deploy to Vercel

Create or reuse two Vercel projects in the same account/team. No Git repository connection is required:

| Setting | Docs | Marketing |
| --- | --- | --- |
| Root Directory | Leave empty (`./`) | Leave empty (`./`) |
| Framework Preset | Astro | Astro |
| Install Command | `bun install --frozen-lockfile` | `bun install --frozen-lockfile` |
| Build Command | `bun run build` | `bun run build` |
| Output Directory | `dist` | `dist` |

Each app's `vercel.json` supplies its framework, commands, output, and routing settings. Each deployment runs inside its app directory, so leave the Vercel project's **Root Directory empty (`./`)**. If you previously set it to `apps/docs` or `apps/marketing`, clear it: otherwise Vercel would append that path again. The workflow checks this before building. The full repository is checked out in GitHub Actions, so Bun can access the parent workspace manifest and lockfile while building locally; only the built artifacts are uploaded to Vercel.

### Production from GitHub Actions

[`.github/workflows/deploy-production.yml`](.github/workflows/deploy-production.yml) deploys both apps whenever a commit is pushed or merged to `main`. It can also be started manually from the Actions tab with `main` selected; other branches are skipped.

The workflow builds docs in GitHub Actions using `vercel pull` and `vercel build --prod`, then uploads the build with `vercel deploy --prebuilt --prod`. After confirming the docs URL responds with HTTP 200, it fills both docs rewrite destinations in marketing's `vercel.json` with that deployment's exact URL, builds marketing, and deploys it to production. The generated config exists only in the runner; it is not committed. The docs job runs in `apps/docs` and the marketing job runs in `apps/marketing`. Each has its own project ID, `vercel.json`, `.vercel/project.json`, and `.vercel/output` in its app directory, plus a fresh checkout of the full repository. Production runs cannot overlap.

In GitHub, open **Settings → Secrets and variables → Actions → New repository secret** and add:

| Repository secret | Value |
| --- | --- |
| `VERCEL_TOKEN` | A [Vercel access token](https://vercel.com/account/tokens) with access to both projects. |
| `VERCEL_ORG_ID` | The shared Vercel account/team ID (`orgId` in `.vercel/project.json`). |
| `VERCEL_DOCS_PROJECT_ID` | The docs project's ID (`projectId` in its link file). |
| `VERCEL_MARKETING_PROJECT_ID` | The marketing project's ID (`projectId` in its link file). |

Retrieve the IDs from the Vercel dashboard or run these commands **from the repository root** to link each app independently:

```sh
vercel login
vercel link --cwd apps/docs --project docs
cat apps/docs/.vercel/project.json
vercel link --cwd apps/marketing --project marketing
cat apps/marketing/.vercel/project.json
```

Add `--scope YOUR-TEAM` to the link commands if necessary. Linking the CLI does not require connecting the GitHub repository. For new projects, you can create them first with `vercel project add docs` and `vercel project add marketing`. Set their Root Directories and build settings as listed above before the first workflow run.

Leave both projects disconnected under Vercel's **Settings → Git**. Both app configs also set `git.deploymentEnabled: false` to prevent automatic Git deployments if a connection is added later; CLI deployments still work.

For docs, disable Vercel Authentication/other Deployment Protection that restricts deployment URLs. The proxy uses the unique deployment URL, which [Standard Protection can restrict even when the production domain is public](https://vercel.com/docs/deployment-protection). Public access to only the stable docs domain is insufficient. The workflow stops before deploying marketing if docs returns a non-200 response.

Keep docs deployments that are still referenced by active or rollback marketing deployments; deleting one breaks its paired marketing deployment. If marketing fails, its current production deployment remains active, while docs may already have been deployed. Rerun the workflow to retry the pair. Deployment URLs appear in the Actions run summary.

This uses [Vercel's CLI deployment flow for GitHub Actions](https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel). No Vercel GitHub integration, deploy hook, or extra GitHub token is required. The separate preview workflow below handles pull requests.

### Pull-request previews from GitHub Actions

[`.github/workflows/deploy-preview.yml`](.github/workflows/deploy-preview.yml) creates previews when a PR targeting `main` is opened or reopened, and updates them whenever new commits are pushed. Draft PRs are included. It reuses the same four repository secrets and the same two Vercel projects; no extra Vercel projects or secrets are needed.

Each run checks out the same PR merge commit in both jobs and follows this sequence:

1. In `apps/docs`, pull Vercel's **Preview** settings (including overrides for the PR branch), build, and deploy without `--prod`.
2. Confirm the docs preview responds publicly at `/docs`.
3. In `apps/marketing`, fill both docs rewrites with that exact docs preview URL, then build and deploy using marketing's Preview settings.
4. Publish marketing's URL through the GitHub environment `preview-pr-<number>` and list both URLs in the Actions summary. Visiting `/docs` on that marketing preview serves the matching docs preview.

Each successful update creates new Vercel deployment URLs. The GitHub environment keeps the same name and its deployment link points to the latest successful preview; there is no permanent Vercel hostname per PR. Production domains remain unchanged. Older marketing previews keep pointing to their original docs deployments.

The docs project's Deployment Protection must allow public access to **preview deployment URLs**, just as it does for the production workflow's docs origin. Configure any app environment variables under **Preview** in the appropriate Vercel project. GitHub creates the per-PR environment automatically; keep the four credentials as repository secrets so they are available to both jobs. Environment rules, if added, must permit PR refs.

New commits cancel older workflow runs for the same PR; different PRs deploy independently. Closing or merging the PR cancels an in-flight preview run without creating another preview. Existing GitHub environments and Vercel deployments are retained after closure; cleanup is not configured. A failed update does not remove the previous successful deployment.

Only PRs with branches in this repository deploy automatically. Fork PRs and Dependabot PRs are skipped because their workflows do not receive the Vercel repository secrets. The workflow uses `pull_request`, never `pull_request_target`, to avoid executing fork code with deployment credentials. See [GitHub's pull-request workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request) and [Vercel's preview settings command](https://vercel.com/docs/cli/pull).

### Manual CLI deployment

Use the same local-build/prebuilt-deploy flow as CI. Starting at the repository root:

```sh
cd apps/docs
vercel link --project docs
vercel pull --yes --environment=production
vercel build --prod
vercel deploy --prebuilt --prod
```

Copy the resulting docs deployment URL into both rewrite destinations in `apps/marketing/vercel.json`, preserving `/docs` and `/docs/:path*`. Then switch from the docs directory to marketing:

```sh
cd ../marketing
vercel link --project marketing
vercel pull --yes --environment=production
vercel build --prod
vercel deploy --prebuilt --prod
```

Add `--scope YOUR-TEAM` to linking commands if needed. Each app keeps its own project link, so switching directories selects the corresponding project. Keep the entire monorepo on disk for Bun's workspace dependencies. These commands build locally before upload; a plain `vercel --prod` source upload from one app directory would omit the parent workspace files.

Use a docs production URL accessible without a Vercel login. Protected previews can return an authentication page. Standard Vercel rewrites also give existing files precedence, so keep the `/docs` namespace out of marketing's pages and public directory.

## Verify the deployed sites

Redeploy **docs first**, then marketing: older docs deployments still have the previous directory output and slash-ending paths.

On marketing's domain, test `/`, `/about`, `/pricing`, `/docs`, `/docs/getting-started`, and `/docs/guides/deployment`. Open a nested docs URL directly and refresh it. Check that its generated `/docs/_astro/*.css` stylesheet loads through marketing. A missing docs page should return a docs 404.

Also verify that `/about/` and `/docs/getting-started/` redirect to the corresponding slashless URL on the marketing domain.

```sh
curl -i https://YOUR-MARKETING-DOMAIN/docs
curl -i https://YOUR-MARKETING-DOMAIN/docs/guides/deployment
curl -i https://YOUR-MARKETING-DOMAIN/docs/not-a-real-page
```

Expect 200 for existing canonical pages and 404 for the missing page. No response should redirect to the docs hostname.

Both GitHub Actions workflows pair docs and marketing from the same run. Manual deployments use the hostname in marketing's `vercel.json`, so update it yourself when deploying manually.
