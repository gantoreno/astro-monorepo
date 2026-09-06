import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const readWorkflow = (name) => Bun.YAML.parse(readFileSync(new URL(`../.github/workflows/deploy-${name}.yml`, import.meta.url), "utf8"));

for (const kind of ["preview", "production"]) {
  describe(`${kind} parallel deployment`, () => {
    const workflow = readWorkflow(kind);
    const { docs, marketing, integration } = workflow.jobs;

    test("both apps can deploy independently, with the same eligibility guard", () => {
      expect(docs.needs).toBeUndefined();
      expect(marketing.needs).toBeUndefined();
      expect(marketing.if).toBe(docs.if);
      expect(integration.needs).toEqual(["docs", "marketing"]);
      // Default needs behavior runs integration only after both deployments succeed.
      expect(integration.if).toBeUndefined();
      expect(marketing.env.DOCS_URL).toBeUndefined();
      expect(workflow.env.DOCS_URL).toContain("${{ github.repository_id }}");
      expect(workflow.env.DOCS_URL.includes("pull_request.number")).toBe(kind === "preview");
      expect(marketing.steps.some(step => step.name === "Check marketing and proxied docs")).toBe(false);
    });

    test("marketing rewrites use the known alias without contacting docs", () => {
      const dir = mkdtempSync(join(tmpdir(), "deploy-rewrite-"));
      try {
        const configPath = join(dir, "vercel.json");
        const original = JSON.parse(readFileSync(new URL("../apps/marketing/vercel.json", import.meta.url), "utf8"));
        writeFileSync(configPath, JSON.stringify(original));
        const script = marketing.steps.find(step => step.name === "Point marketing at the predictable docs URL").run;
        const docsUrl = kind === "preview" ? "https://docs-pr-7-1234.vercel.app" : "https://docs-production-1234.vercel.app";
        const result = spawnSync("bash", ["-e", "-c", script], { cwd: dir, env: { ...process.env, DOCS_URL: docsUrl }, encoding: "utf8" });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        expect(config).toEqual({ ...original, rewrites: original.rewrites.map(rule => rule.source.startsWith("/docs") ? { ...rule, destination: `${docsUrl}${rule.source}` } : rule) });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("docs assigns the same alias that marketing builds against", () => {
      const alias = docs.steps.find(step => step.name === "Update predictable docs URL");
      expect(alias.env.DEPLOYMENT_URL).toBe("${{ steps.deploy.outputs.url }}");
      expect(alias.run).toContain('vercel alias set "$DEPLOYMENT_URL" "${DOCS_URL#https://}"');
      expect(docs.steps.findIndex(step => step.id === "deploy")).toBeLessThan(docs.steps.indexOf(alias));
      if (kind === "preview") {
        expect(docs.steps[docs.steps.indexOf(alias) - 1].name).toBe("Recheck PR before updating docs URL");
        const checks = integration.steps.findIndex(step => step.name === "Check marketing and proxied docs");
        expect(checks).toBeLessThan(integration.steps.findIndex(step => step.id === "alias"));
        expect(integration.steps.findIndex(step => step.id === "alias")).toBeLessThan(integration.steps.findIndex(step => step.name === "Publish preview comment"));
      }
    });
  });
}
