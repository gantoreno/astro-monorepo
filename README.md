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

Vercel's `trailingSlash: false` redirects slash-ending paths to their slashless form; `cleanUrls: true` serves the HTML files without `.html`. Marketing explicitly rewrites `/` to `/index` because Vercel's prebuilt output exposes `index.html` at `/index` when clean URLs are enabled. This keeps the homepage at `/` and avoids a root 404.

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

The `docs` and `marketing` jobs build and deploy **in parallel** using `vercel pull`, `vercel build --prod`, and `vercel deploy --prebuilt --prod`. Marketing's generated `vercel.json` points both docs rewrites at the predictable origin `https://docs-production-<repository-id>.vercel.app`; the docs job assigns that alias to its deployment. Neither app waits for the other to build or deploy. The generated config exists only in the runner; it is not committed.

Each job runs in its own app directory with a fresh checkout, project ID, `vercel.json`, `.vercel/project.json`, and `.vercel/output`. Docs checks its public alias and marketing checks its own routes independently. There is no separate integration job or automated cross-app proxy check. Production workflow runs cannot overlap, although the two apps within each run deploy concurrently.

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

For docs, disable Vercel Authentication/other Deployment Protection that restricts access to the docs origin. Both the production docs alias and PR docs aliases must be public so marketing can proxy them. See [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection). The docs job fails if its alias returns a non-200 response; marketing can still build and deploy independently.

Production updates are independent: if only one deployment succeeds, that app can already be live, and marketing's `/docs` can temporarily fail or serve a different revision. A failed deployment or route check does not roll back either deployment. Rerun failed jobs to complete the release. Marketing always follows the current docs alias, including when rolling marketing back; roll docs back separately and repoint the docs alias if both apps need to return to an earlier revision. Deployment URLs appear in the Actions run summary.

This uses [Vercel's CLI deployment flow for GitHub Actions](https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel). No Vercel GitHub integration, deploy hook, or extra GitHub token is required. The separate preview workflow below handles pull requests.

### Pull-request previews from GitHub Actions

[`.github/workflows/deploy-preview.yml`](.github/workflows/deploy-preview.yml) creates previews when a PR targeting `main` is opened or reopened, and updates them whenever new commits are pushed. Draft PRs are included. It reuses the same four repository secrets and the same two Vercel projects; no extra Vercel projects or secrets are needed.

Each run checks out the same PR merge commit in both jobs:

1. Independently in each app, pull Vercel's **Preview** settings (including overrides for the PR branch), build, and deploy without `--prod`.
2. Marketing fills both docs rewrites with the known origin `https://docs-pr-<number>-<repository-id>.vercel.app` before building. Docs assigns that alias after deploying. Each job checks its own routes.
3. After marketing deploys and its own route checks pass, point `marketing-pr-<number>-<repository-id>.vercel.app` at the new marketing deployment using `vercel alias set`. Marketing creates or updates a single bot comment on the PR with that stable address and its `/docs` link, without waiting for docs. The Actions summary also includes these links.

Both aliases stay the same across updates, so their addresses are known before either deployment exists. The repository ID prevents naming collisions between repositories. No extra domain, DNS configuration, or secret is required. Vercel still creates deployment-specific URLs underneath, visible in deployment logs. Marketing follows the latest deployment assigned to that PR's docs alias. Shared preview links continue to use the marketing alias and its `/docs` path. Production domains remain unchanged. See [Vercel aliases](https://vercel.com/docs/cli/alias).

The docs project's Deployment Protection must allow public access to **preview docs aliases**, just as it does for the production workflow's docs origin. Configure any app environment variables under **Preview** in the appropriate Vercel project. Keep the four credentials as repository secrets so they are available to both jobs. The comment uses the automatic `GITHUB_TOKEN` with `pull-requests: write`; no additional token or secret is needed. The workflow does not create GitHub deployment records or environments. Any records from earlier runs remain in GitHub history.

Runs for the same PR are serialized so alias updates cannot overlap; different PRs deploy independently. Before moving either alias, the workflow checks that the PR is still open and the deployment matches its current head commit. Outdated reruns and runs for closed PRs fail that check without moving the alias. Closing or merging a PR runs the separate cleanup workflow described below. A failed marketing build or marketing route check leaves the previous marketing alias target and preview comment unchanged. Docs failures do not prevent marketing from publishing its link. Docs can update independently, so an existing preview may serve newer docs even when marketing fails. The preview link can be published before docs is available; check the docs job for its deployment status.

To block merges until the preview is healthy, configure a `main` branch ruleset or branch protection rule to require the preview workflow's `docs` and `marketing` checks. The required deployment checks block merging if either app fails. Workflow YAML does not enable required checks by itself. Fork and Dependabot previews remain skipped, so use an appropriate separate CI policy for those contributions. See [GitHub required status checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging).

Only PRs with branches in this repository deploy automatically. Fork PRs and Dependabot PRs are skipped because their workflows do not receive the Vercel repository secrets. The deployment workflow uses `pull_request` to avoid executing fork code with deployment credentials. See [GitHub's pull-request workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request) and [Vercel's preview settings command](https://vercel.com/docs/cli/pull).

### Cleaning up closed PR previews

[`.github/workflows/cleanup-preview.yml`](.github/workflows/cleanup-preview.yml) runs only on `pull_request_target: closed`, which includes merging a PR. It runs trusted inline code from `main`, with no checkout or execution of PR code. It does not add cleanup jobs to the preview workflow that runs when a PR is opened or updated. The cleanup workflow must reach `main` before it can handle closures. See [GitHub's event behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target).

Both preview deploy commands tag Vercel deployments with `ciRepositoryId` and `ciPullRequest`. Cleanup validates ownership and removes both of the PR's permanent aliases (marketing and docs), then deletes matching preview deployments from both configured projects, including previous runs. It checks both metadata fields and the project ID, excludes production/promoted deployments, and updates the existing bot comment to **Preview closed**. It uses the same four repository secrets; no GitHub environment or deployment record is created.

Cleanup and deployment share the same per-PR concurrency group. Cleanup rechecks that the PR is closed before deleting, while preview runs reject closed or outdated PRs before deploying. Reopening the PR creates a new pair at the same permanent URL. Rerunning cleanup tolerates an alias or deployment that has already been removed; other API errors fail the run so it can be retried. Deployments created before the tags were added remain untouched, as do historical GitHub deployment records.

### Deployment labels in Vercel

Both workflows pass explicit [GitHub metadata to Vercel](https://vercel.com/kb/guide/branch-variables-and-domains-not-linked-to-cli-deployments). Preview deployments show only the head commit subject, with the actual PR branch and head commit, instead of the generated merge message and detached `HEAD`. Production deployments show only the commit subject, with `main` and its deployed commit. The branch label comes from explicit metadata, independently of whether the checkout is detached.

Preview builds still use GitHub's PR merge commit to test the change together with the base branch. The displayed head commit identifies the contributor's change; `ciBuildSha` records the exact commit that was built, and `ciRunUrl` links to the Actions run attempt. Existing deployments keep their original labels; new deployments receive these fields.

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

After both deployment jobs succeed, manually check the combined site using the routes below. Publishing the marketing preview link does not imply that docs is ready.

On marketing's domain, test `/`, `/about`, `/pricing`, `/docs`, `/docs/getting-started`, and `/docs/guides/deployment`. Open a nested docs URL directly and refresh it. Check that its generated `/docs/_astro/*.css` stylesheet loads through marketing. A missing docs page should return a docs 404.

Also verify that `/about/` and `/docs/getting-started/` redirect to the corresponding slashless URL on the marketing domain.

```sh
curl -i https://YOUR-MARKETING-DOMAIN/docs
curl -i https://YOUR-MARKETING-DOMAIN/docs/guides/deployment
curl -i https://YOUR-MARKETING-DOMAIN/docs/not-a-real-page
```

Expect 200 for existing canonical pages and 404 for the missing page. No response should redirect to the docs hostname.

Both GitHub Actions workflows build docs and marketing from the same commit and connect them through a predictable docs alias. Each app can update independently. Manual deployments use the hostname in marketing's `vercel.json`, so update it yourself when deploying manually.
