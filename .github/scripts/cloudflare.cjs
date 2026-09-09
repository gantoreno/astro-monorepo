const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const APPS = Object.freeze({
  docs: {
    configPath: "apps/docs/wrangler.json",
    worker: "astro-monorepo-docs",
  },
  marketing: {
    configPath: "apps/marketing/wrangler.json",
    worker: "astro-monorepo-marketing",
  },
});

function app(name) {
  if (!Object.hasOwn(APPS, name)) throw new Error(`Unknown Cloudflare app: ${name}`);
  return APPS[name];
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Expected a positive ${label}`);
  return number;
}

function dnsLabel(value, label) {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value || "")) {
    throw new Error(`Expected a valid ${label}`);
  }
  return value;
}

function previewAlias(prNumber) {
  return `pr-${positiveInteger(prNumber, "PR number")}`;
}

function versionTag(repositoryId, prNumber) {
  return `ci-preview-${positiveInteger(repositoryId, "repository ID")}-${previewAlias(prNumber)}`;
}

function workerUrl({ appName, accountSubdomain, prNumber }) {
  const { worker } = app(appName);
  const subdomain = dnsLabel(accountSubdomain, "workers.dev account subdomain");
  const prefix = prNumber == null ? worker : `${previewAlias(prNumber)}-${worker}`;
  if (prefix.length > 63) throw new Error("The preview alias and Worker name exceed the DNS label limit");
  return `https://${prefix}.${subdomain}.workers.dev`;
}

function uploadCommand({ appName, production, repositoryId, prNumber }) {
  const { configPath } = app(appName);
  if (production) {
    return `deploy --config ${configPath} --tag ci-production-${positiveInteger(repositoryId, "repository ID")}`;
  }
  return `versions upload --config ${configPath} --preview-alias ${previewAlias(prNumber)} --tag ${versionTag(repositoryId, prNumber)}`;
}

function normalizeOrigin(value) {
  const origin = new URL(value);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("Expected a public HTTPS docs origin");
  }
  return origin.origin;
}

function prepare({ appName, docsOrigin, preview, root = process.cwd() }) {
  const selected = app(appName);
  const configPath = path.join(root, selected.configPath);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (
    config.name !== selected.worker ||
    config.workers_dev !== true ||
    config.preview_urls !== true ||
    config.assets?.directory !== "./dist" ||
    config.assets?.html_handling !== "drop-trailing-slash" ||
    config.assets?.not_found_handling !== "404-page"
  ) {
    throw new Error(`Unexpected ${appName} Wrangler configuration`);
  }

  if (appName === "marketing") {
    if (
      config.main !== "./cloudflare-worker.js" ||
      config.assets.binding !== "ASSETS" ||
      !config.assets.run_worker_first?.includes("/docs/*")
    ) {
      throw new Error("Marketing must proxy docs before consulting its static assets");
    }
    config.vars = { ...config.vars, DOCS_ORIGIN: normalizeOrigin(docsOrigin) };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  } else if (docsOrigin !== undefined) {
    throw new Error("Only marketing accepts a docs origin");
  }

  if (preview) {
    const headersPath = path.join(path.dirname(configPath), config.assets.directory, "_headers");
    const directive = "/*\n  X-Robots-Tag: noindex";
    let current = "";
    try {
      current = readFileSync(headersPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!current.includes(directive)) {
      appendFileSync(headersPath, `${current.endsWith("\n") || !current ? "" : "\n"}${directive}\n`);
    }
  }

  return selected.configPath;
}

function cloudflareApi({ accountId, apiToken, fetchImpl = fetch }) {
  if (!accountId || !apiToken) {
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN repository secrets");
  }
  return async (endpoint, { method = "GET", body, missingOK = false } = {}) => {
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/${endpoint}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const responseBody = await response.json();
    if (missingOK && response.status === 404) return null;
    if (!response.ok || responseBody.success !== true) {
      throw new Error(`Cloudflare ${method} failed (${response.status}): ${JSON.stringify(responseBody.errors)}`);
    }
    return responseBody;
  };
}

async function accountSubdomain(options) {
  const { result } = await cloudflareApi(options)("subdomain");
  return dnsLabel(result?.subdomain, "workers.dev account subdomain");
}

async function ensurePreviewReady({ appName, ...options }) {
  const selected = app(appName);
  const api = cloudflareApi(options);
  const deployments = await api(`scripts/${selected.worker}/deployments`, { missingOK: true });
  if (!deployments) {
    await api("workers", {
      method: "POST",
      body: { name: selected.worker },
    });
    await api(`scripts/${selected.worker}/subdomain`, {
      method: "POST",
      body: { enabled: true, previews_enabled: true },
    });
    return;
  }

  const settings = await api(`scripts/${selected.worker}/subdomain`, { missingOK: true });
  if (!settings?.result?.enabled || !settings.result.previews_enabled) {
    await api(`scripts/${selected.worker}/subdomain`, {
      method: "POST",
      body: { enabled: true, previews_enabled: true },
    });
  }
}

async function deploymentTarget({ appName, production, repositoryId, prNumber, ...options }) {
  const account = await accountSubdomain(options);
  if (!production) await ensurePreviewReady({ appName, ...options });
  const selectedPr = production ? undefined : positiveInteger(prNumber, "PR number");
  return {
    command: uploadCommand({ appName, production, repositoryId, prNumber: selectedPr }),
    url: workerUrl({ appName, accountSubdomain: account, prNumber: selectedPr }),
    docsOrigin: workerUrl({ appName: "docs", accountSubdomain: account, prNumber: selectedPr }),
  };
}

async function deletePreviewVersions({ repositoryId, prNumber, requireClosed = async () => {}, ...options }) {
  const tag = versionTag(repositoryId, prNumber);
  const api = cloudflareApi(options);
  const deleted = {};

  for (const [appName, selected] of Object.entries(APPS)) {
    const candidates = new Map();
    for (let page = 1; ; page++) {
      const body = await api(`workers/${selected.worker}/versions?page=${page}&per_page=100`);
      if (!Array.isArray(body.result)) throw new Error("Unexpected Cloudflare versions response");
      for (const version of body.result) {
        if (version.annotations?.["workers/tag"] === tag) candidates.set(version.id, version);
      }
      const totalPages = body.result_info?.total_pages;
      if (totalPages !== undefined ? page >= totalPages : body.result.length < 100) break;
    }

    const { result } = await api(`scripts/${selected.worker}/deployments`);
    if (!Array.isArray(result?.deployments)) throw new Error("Unexpected Cloudflare deployments response");
    const protectedIds = new Set(
      result.deployments.flatMap((deployment) =>
        (deployment.versions || []).map((version) => version.version_id),
      ),
    );

    for (const version of candidates.values()) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(version.id)) {
        throw new Error("Refusing to delete a version without an exact UUID");
      }
      if (protectedIds.has(version.id)) {
        throw new Error(`Preview version ${version.id} is referenced by a production deployment`);
      }
    }

    deleted[appName] = 0;
    for (const version of candidates.values()) {
      await requireClosed();
      await api(`workers/${selected.worker}/versions/${version.id}`, { method: "DELETE" });
      deleted[appName]++;
    }
  }

  return deleted;
}

module.exports = {
  APPS,
  accountSubdomain,
  deletePreviewVersions,
  deploymentTarget,
  prepare,
  previewAlias,
  uploadCommand,
  versionTag,
  workerUrl,
};
