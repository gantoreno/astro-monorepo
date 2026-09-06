import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const readWorkflow = (name) => Bun.YAML.parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
const workflow = readWorkflow("cleanup-preview");
const script = workflow.jobs.cleanup.steps[0].with.script;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction("github", "context", "core", "process", "fetch", script);
const env = {
  VERCEL_TOKEN: "test-token",
  VERCEL_ORG_ID: "team-test",
  VERCEL_DOCS_PROJECT_ID: "prj-docs",
  VERCEL_MARKETING_PROJECT_ID: "prj-marketing",
  REPOSITORY_ID: "1234",
};
const host = "marketing-pr-7-1234.vercel.app";
const marker = "<!-- vercel-pr-preview -->";
const deployment = (uid, projectId, overrides = {}) => ({
  uid, projectId, target: null,
  meta: { ciRepositoryId: "1234", ciPullRequest: "7" },
  ...overrides,
});
const marketing = deployment("dpl-marketing", "prj-marketing");
const docs = deployment("dpl-docs", "prj-docs");

function harness(options = {}) {
  const requests = [], updates = [], summaries = [];
  let prReads = 0;
  const comments = options.comments ?? [{ id: 42, user: { login: "github-actions[bot]" }, body: marker }];
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { state: options.prState?.(++prReads) ?? "closed" } }) },
      issues: {
        listComments: () => {},
        updateComment: async (args) => updates.push(args),
      },
    },
    paginate: async (method, args) => {
      expect(method).toBe(github.rest.issues.listComments);
      expect(args.issue_number).toBe(7);
      return comments;
    },
  };
  const core = { info: () => {}, summary: { addRaw: (text) => { summaries.push(text); return { write: async () => {} }; } } };
  const pages = options.pages ?? { "prj-marketing": [[marketing]], "prj-docs": [[docs]] };
  const fetch = async (url, request) => {
    expect(url.origin).toBe("https://api.vercel.com");
    expect(url.searchParams.get("teamId")).toBe("team-test");
    expect(request.headers.Authorization).toBe("Bearer test-token");
    requests.push({ method: request.method, path: url.pathname, query: url.searchParams });
    const forcedStatus = options.status?.(url, request);
    if (forcedStatus) return new Response(null, { status: forcedStatus });
    if (request.method === "DELETE") return Response.json({ status: "SUCCESS" });
    if (url.pathname === "/v7/deployments") {
      const projectPages = pages[url.searchParams.get("projectId")];
      const index = url.searchParams.has("until") ? 1 : 0;
      return Response.json({ deployments: projectPages[index], pagination: { next: index === 0 && projectPages.length > 1 ? 100 : null } });
    }
    if (url.pathname.startsWith("/v4/aliases/")) {
      const isDocs = url.pathname.includes("docs-pr-");
      return Response.json((isDocs ? options.docsAlias : options.alias) ?? {
        uid: isDocs ? "alias-docs-7" : "alias-7",
        alias: isDocs ? "docs-pr-7-1234.vercel.app" : host,
        projectId: isDocs ? "prj-docs" : "prj-marketing",
      });
    }
    if (url.pathname.startsWith("/v13/deployments/")) {
      const id = url.pathname.split("/").at(-1);
      const original = Object.values(pages).flat(2).find((item) => item.uid === id);
      return Response.json(options.detail?.(original) ?? original);
    }
    throw new Error(`Unexpected request ${request.method} ${url}`);
  };
  return {
    requests, updates, summaries,
    deletes: () => requests.filter((request) => request.method === "DELETE").map((request) => request.path),
    run: () => execute(github, { repo: { owner: "test", repo: "repo" }, issue: { number: 7 } }, core, { env }, fetch),
  };
}

describe("preview cleanup", () => {
  test("separate close-only trusted workflow shares concurrency and tags both apps", () => {
    const preview = readWorkflow("deploy-preview");
    expect(workflow.on).toEqual({ pull_request_target: { branches: ["main"], types: ["closed"] } });
    expect(preview.on.pull_request.types).not.toContain("closed");
    expect(workflow.concurrency).toEqual(preview.concurrency);
    expect(workflow.jobs.cleanup.steps.some((step) => step.uses?.startsWith("actions/checkout"))).toBe(false);
    for (const name of ["docs", "marketing"]) {
      const deploy = preview.jobs[name].steps.find((step) => step.id === "deploy").run;
      expect(deploy).toContain('--meta "ciRepositoryId=$GITHUB_REPOSITORY_ID"');
      expect(deploy).toContain('--meta "ciPullRequest=$PR_NUMBER"');
    }
    expect(preview.jobs.docs.steps[0].name).toBe("Check PR is still open and current");
  });

  test("preview preflight rejects closed PRs and outdated reruns before deploying", async () => {
    const preview = readWorkflow("deploy-preview");
    for (const job of ["docs", "marketing"]) {
      const preflight = new AsyncFunction("github", "context", "process", preview.jobs[job].steps[0].with.script);
      for (const [state, sha, allowed] of [["open", "current", true], ["closed", "current", false], ["open", "outdated", false]]) {
        const run = preflight(
          { rest: { pulls: { get: async () => ({ data: { state, head: { sha } } }) } } },
          { repo: { owner: "test", repo: "repo" }, issue: { number: 7 } },
          { env: { PR_HEAD_SHA: "current" } },
        );
        if (allowed) await run;
        else await expect(run).rejects.toThrow("skipping deployment");
      }
    }
  });

  test("removes alias and matching deployments from both projects, updates existing comment", async () => {
    const h = harness();
    await h.run();
    expect(h.deletes()).toEqual(["/v2/aliases/alias-7", "/v2/aliases/alias-docs-7", "/v13/deployments/dpl-marketing", "/v13/deployments/dpl-docs"]);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].comment_id).toBe(42);
    expect(h.updates[0].body).toContain("**Preview closed.**");
    expect(h.summaries[0]).toContain("2 tagged deployments");
  });

  test("paginates and excludes other PRs, repos, projects, production and untagged deployments", async () => {
    const older = deployment("dpl-older", "prj-marketing", { target: "preview" });
    const h = harness({ pages: {
      "prj-marketing": [[marketing,
        deployment("production", "prj-marketing", { target: "production" }),
        deployment("promoted", "prj-marketing", { readySubstate: "PROMOTED" }),
        deployment("other-pr", "prj-marketing", { meta: { ciRepositoryId: "1234", ciPullRequest: "8" } }),
        deployment("other-repo", "prj-marketing", { meta: { ciRepositoryId: "5678", ciPullRequest: "7" } }),
        deployment("untagged", "prj-marketing", { meta: {} }),
        deployment("wrong-project", "prj-other"),
      ], [older]],
      "prj-docs": [[docs]],
    } });
    await h.run();
    expect(h.deletes()).toEqual(["/v2/aliases/alias-7", "/v2/aliases/alias-docs-7", "/v13/deployments/dpl-marketing", "/v13/deployments/dpl-older", "/v13/deployments/dpl-docs"]);
    const lists = h.requests.filter((r) => r.path === "/v7/deployments");
    expect(lists).toHaveLength(3);
    expect(lists[1].query.get("until")).toBe("100");
    expect(h.requests.findIndex((r) => r.method === "DELETE")).toBeGreaterThan(h.requests.findLastIndex((r) => r.path === "/v7/deployments"));
  });

  test("reruns tolerate missing alias and deployments", async () => {
    const h = harness({ status: (url) => url.pathname.startsWith("/v4/") || url.pathname.startsWith("/v13/") ? 404 : undefined });
    await h.run();
    expect(h.deletes()).toEqual([]);
    expect(h.updates).toHaveLength(1);
  });

  test("never treats authentication errors as successful cleanup", async () => {
    const h = harness({ status: () => 403 });
    await expect(h.run()).rejects.toThrow("HTTP 403");
    expect(h.deletes()).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  test("does not publish a closed comment after deletion fails", async () => {
    const h = harness({ status: (url, req) => url.pathname.startsWith("/v13/") && req.method === "DELETE" ? 500 : undefined });
    await expect(h.run()).rejects.toThrow("HTTP 500");
    expect(h.updates).toEqual([]);
  });

  test("reopened PR skips all Vercel calls", async () => {
    const h = harness({ prState: () => "open" });
    await h.run();
    expect(h.requests).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  test("PR reopening during enumeration stops before deletion", async () => {
    const h = harness({ prState: (read) => read === 1 ? "closed" : "open" });
    await expect(h.run()).rejects.toThrow("PR was reopened");
    expect(h.deletes()).toEqual([]);
    expect(h.updates).toEqual([]);
  });

  test("refuses an alias owned by another project", async () => {
    const h = harness({ alias: { uid: "alias-7", alias: host, projectId: "prj-other" } });
    await expect(h.run()).rejects.toThrow("expected marketing project");
    expect(h.deletes()).toEqual([]);
  });

  test("validates docs alias ownership before deleting either alias", async () => {
    const h = harness({ docsAlias: { uid: "alias-docs-7", alias: "docs-pr-7-1234.vercel.app", projectId: "prj-other" } });
    await expect(h.run()).rejects.toThrow("expected docs project");
    expect(h.deletes()).toEqual([]);
  });

  test("cleans older previews that have no docs alias", async () => {
    const h = harness({ status: (url) => url.pathname.includes("/v4/aliases/docs-pr-") ? 404 : undefined });
    await h.run();
    expect(h.deletes()).toEqual(["/v2/aliases/alias-7", "/v13/deployments/dpl-marketing", "/v13/deployments/dpl-docs"]);
  });

  test("rechecks each deployment before deleting to protect promotions", async () => {
    const h = harness({ detail: (deployment) => ({ ...deployment, target: "production" }) });
    await expect(h.run()).rejects.toThrow("no longer matches");
    expect(h.deletes()).toEqual(["/v2/aliases/alias-7", "/v2/aliases/alias-docs-7"]);
    expect(h.updates).toEqual([]);
  });

  test("preserves human and unrelated bot comments", async () => {
    const h = harness({ comments: [
      { id: 1, user: { login: "human" }, body: marker },
      { id: 2, user: { login: "github-actions[bot]" }, body: "Other status" },
    ] });
    await h.run();
    expect(h.updates).toEqual([]);
  });
});
