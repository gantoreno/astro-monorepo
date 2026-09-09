import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { handleRequest } from "../apps/marketing/cloudflare-worker.js";

const require = createRequire(import.meta.url);
const lifecycle = require("../.github/scripts/cloudflare.cjs");
const root = new URL("..", import.meta.url);
const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, root), "utf8"));
const readWorkflow = (name) =>
  Bun.YAML.parse(
    readFileSync(new URL(`.github/workflows/cloudflare-${name}.yml`, root), "utf8"),
  );

describe("Cloudflare static asset configuration", () => {
  test("uses two long-lived Workers with matching URL behavior", () => {
    const docs = readJson("apps/docs/wrangler.json");
    const marketing = readJson("apps/marketing/wrangler.json");

    expect(docs.name).toBe(lifecycle.APPS.docs.worker);
    expect(marketing.name).toBe(lifecycle.APPS.marketing.worker);
    for (const config of [docs, marketing]) {
      expect(config.compatibility_date).toBe("2026-09-04");
      expect(config.workers_dev).toBe(true);
      expect(config.preview_urls).toBe(true);
      expect(config.assets.directory).toBe("./dist");
      expect(config.assets.html_handling).toBe("drop-trailing-slash");
      expect(config.assets.not_found_handling).toBe("404-page");
    }
    expect(marketing.compatibility_flags).toContain("global_fetch_strictly_public");
    expect(marketing.assets.binding).toBe("ASSETS");
    expect(marketing.assets.run_worker_first).toEqual(["/docs", "/docs/*"]);
  });

  test("prepares version-specific docs origins and noindex headers", () => {
    const directory = mkdtempSync(join(tmpdir(), "cloudflare-prepare-"));
    try {
      for (const appName of ["docs", "marketing"]) {
        const appDirectory = join(directory, "apps", appName);
        mkdirSync(join(appDirectory, "dist"), { recursive: true });
        copyFileSync(
          new URL(`apps/${appName}/wrangler.json`, root),
          join(appDirectory, "wrangler.json"),
        );
      }

      lifecycle.prepare({ appName: "docs", preview: true, root: directory });
      lifecycle.prepare({
        appName: "marketing",
        docsOrigin: "https://pr-7-astro-monorepo-docs.example.workers.dev",
        preview: true,
        root: directory,
      });

      const marketing = JSON.parse(
        readFileSync(join(directory, "apps/marketing/wrangler.json"), "utf8"),
      );
      expect(marketing.vars.DOCS_ORIGIN).toBe(
        "https://pr-7-astro-monorepo-docs.example.workers.dev",
      );
      for (const appName of ["docs", "marketing"]) {
        expect(readFileSync(join(directory, `apps/${appName}/dist/_headers`), "utf8"))
          .toContain("X-Robots-Tag: noindex");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("marketing Worker", () => {
  test("serves marketing assets without invoking the docs origin", async () => {
    let assetRequest;
    const response = await handleRequest(
      new Request("https://marketing.example/about"),
      {
        DOCS_ORIGIN: "https://docs.example",
        ASSETS: {
          fetch: async (request) => {
            assetRequest = request;
            return new Response("marketing");
          },
        },
      },
      async () => {
        throw new Error("Unexpected docs fetch");
      },
    );

    expect(await response.text()).toBe("marketing");
    expect(new URL(assetRequest.url).pathname).toBe("/about");
  });

  test("proxies docs paths and keeps redirects on the marketing origin", async () => {
    let upstreamRequest;
    const response = await handleRequest(
      new Request("https://marketing.example/docs/getting-started/?source=preview", {
        headers: { "cf-workers-preview-token": "marketing-preview" },
      }),
      {
        DOCS_ORIGIN: "https://pr-7-docs.example.workers.dev",
        ASSETS: { fetch: async () => new Response("unexpected") },
      },
      async (request) => {
        upstreamRequest = request;
        return new Response(null, {
          status: 307,
          headers: { location: "https://pr-7-docs.example.workers.dev/docs/getting-started" },
        });
      },
    );

    expect(upstreamRequest.url).toBe(
      "https://pr-7-docs.example.workers.dev/docs/getting-started/?source=preview",
    );
    expect(upstreamRequest.headers.has("cf-workers-preview-token")).toBe(false);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://marketing.example/docs/getting-started",
    );
  });
});

describe("Cloudflare deployment lifecycle", () => {
  test("uses paired stable aliases and tagged versions", () => {
    expect(lifecycle.previewAlias(7)).toBe("pr-7");
    expect(
      lifecycle.workerUrl({
        appName: "marketing",
        accountSubdomain: "example-account",
        prNumber: 7,
      }),
    ).toBe("https://pr-7-astro-monorepo-marketing.example-account.workers.dev");
    expect(
      lifecycle.uploadCommand({
        appName: "docs",
        production: false,
        repositoryId: 1234,
        prNumber: 7,
      }),
    ).toBe(
      "versions upload --config apps/docs/wrangler.json --preview-alias pr-7 --tag ci-preview-1234-pr-7",
    );
    expect(lifecycle.bootstrapCommand("docs")).toBe(
      "deploy --config .github/cloudflare/bootstrap-docs.json --tag ci-bootstrap",
    );
  });

  test("creates and bootstraps a Worker before the first preview upload", async () => {
    const requests = [];
    const fetchImpl = async (url, options) => {
      const parsed = new URL(url);
      requests.push({
        method: options.method,
        path: parsed.pathname,
        body: options.body && JSON.parse(options.body),
      });
      if (parsed.pathname.endsWith("/workers/subdomain")) {
        return Response.json({ success: true, result: { subdomain: "example-account" } });
      }
      if (parsed.pathname.endsWith("/scripts/astro-monorepo-docs/deployments")) {
        return Response.json(
          { success: false, errors: [{ code: 10007, message: "Worker not found" }] },
          { status: 404 },
        );
      }
      return Response.json({ success: true, result: {} });
    };

    const target = await lifecycle.deploymentTarget({
      appName: "docs",
      production: false,
      repositoryId: 1234,
      prNumber: 7,
      accountId: "account",
      apiToken: "token",
      fetchImpl,
    });

    expect(target.url).toBe(
      "https://pr-7-astro-monorepo-docs.example-account.workers.dev",
    );
    expect(target.bootstrapCommand).toBe(
      "deploy --config .github/cloudflare/bootstrap-docs.json --tag ci-bootstrap",
    );
    expect(requests).toEqual([
      {
        method: "GET",
        path: "/client/v4/accounts/account/workers/subdomain",
        body: undefined,
      },
      {
        method: "GET",
        path: "/client/v4/accounts/account/workers/scripts/astro-monorepo-docs/deployments",
        body: undefined,
      },
      {
        method: "POST",
        path: "/client/v4/accounts/account/workers/workers",
        body: { name: "astro-monorepo-docs" },
      },
      {
        method: "POST",
        path: "/client/v4/accounts/account/workers/scripts/astro-monorepo-docs/subdomain",
        body: { enabled: true, previews_enabled: true },
      },
    ]);
  });

  test("bootstraps an existing Worker that has never been deployed", async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/workers/subdomain")) {
        return Response.json({ success: true, result: { subdomain: "example-account" } });
      }
      if (parsed.pathname.endsWith("/deployments")) {
        return Response.json({ success: true, result: { deployments: [] } });
      }
      if (parsed.pathname.endsWith("/subdomain")) {
        return Response.json({
          success: true,
          result: { enabled: true, previews_enabled: true },
        });
      }
      throw new Error(`Unexpected Cloudflare request: ${url}`);
    };

    const target = await lifecycle.deploymentTarget({
      appName: "marketing",
      production: false,
      repositoryId: 1234,
      prNumber: 7,
      accountId: "account",
      apiToken: "token",
      fetchImpl,
    });

    expect(target.bootstrapCommand).toBe(
      "deploy --config .github/cloudflare/bootstrap-marketing.json --tag ci-bootstrap",
    );
  });

  test("production and preview jobs remain independent", () => {
    const preview = readWorkflow("preview");
    const production = readWorkflow("production");
    const cleanup = readWorkflow("cleanup");

    for (const workflow of [preview, production]) {
      expect(Object.keys(workflow.jobs)).toEqual(["docs", "marketing"]);
      expect(workflow.jobs.docs.needs).toBeUndefined();
      expect(workflow.jobs.marketing.needs).toBeUndefined();
      expect(workflow.jobs.marketing.if).toBe(workflow.jobs.docs.if);
      for (const appName of ["docs", "marketing"]) {
        expect(workflow.jobs[appName].steps.some((step) =>
          step.uses === "cloudflare/wrangler-action@v4"
        )).toBe(true);
      }
    }
    expect(cleanup.concurrency).toEqual(preview.concurrency);
    expect(cleanup.on).toEqual({
      pull_request_target: { branches: ["main"], types: ["closed"] },
    });
  });

  test("deletes matching versions from both Workers without touching deployments", async () => {
    const ids = {
      docs: "11111111-1111-4111-8111-111111111111",
      marketing: "22222222-2222-4222-8222-222222222222",
    };
    const requests = [];
    const fetchImpl = async (url, options) => {
      const parsed = new URL(url);
      requests.push({ method: options.method, path: parsed.pathname });
      if (options.method === "DELETE") {
        return Response.json({ success: true, result: null });
      }
      if (parsed.pathname.endsWith("/versions")) {
        const appName = parsed.pathname.includes("astro-monorepo-docs") ? "docs" : "marketing";
        return Response.json({
          success: true,
          result: [{
            id: ids[appName],
            annotations: { "workers/tag": "ci-preview-1234-pr-7" },
          }],
          result_info: { total_pages: 1 },
        });
      }
      if (parsed.pathname.endsWith("/deployments")) {
        return Response.json({
          success: true,
          result: { deployments: [{ versions: [] }] },
        });
      }
      throw new Error(`Unexpected Cloudflare request: ${url}`);
    };
    let closedChecks = 0;

    const deleted = await lifecycle.deletePreviewVersions({
      repositoryId: 1234,
      prNumber: 7,
      accountId: "account",
      apiToken: "token",
      fetchImpl,
      requireClosed: async () => closedChecks++,
    });

    expect(deleted).toEqual({ docs: 1, marketing: 1 });
    expect(closedChecks).toBe(2);
    expect(requests.filter(({ method }) => method === "DELETE").map(({ path }) => path))
      .toEqual([
        `/client/v4/accounts/account/workers/workers/${lifecycle.APPS.docs.worker}/versions/${ids.docs}`,
        `/client/v4/accounts/account/workers/workers/${lifecycle.APPS.marketing.worker}/versions/${ids.marketing}`,
      ]);
  });
});
