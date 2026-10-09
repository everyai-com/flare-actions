import { describe, expect, it } from "vitest";
import { convertActionsWorkflow, isImportSuccess, mapRunsOn, sanitizeCacheKey } from "./importActions";

const SAMPLE = `
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: actions/cache@v4
        with: { path: node_modules, key: "node-\${{ runner.os }}" }
      - run: npm ci
      - run: npm test
      - uses: actions/upload-artifact@v4
        with: { name: cov, path: coverage }
`;

describe("convertActionsWorkflow", () => {
  it("converts a node workflow", () => {
    const res = convertActionsWorkflow(SAMPLE);
    expect(isImportSuccess(res)).toBe(true);
    if (!isImportSuccess(res)) return;
    expect(res.yaml).toContain("runs-on: linux");
    expect(res.yaml).toContain("npm ci");
    expect(res.yaml).toContain("node --version");
    expect(res.yaml).toContain("key: node-expr");
    expect(res.yaml).toContain("name: cov");
    expect(res.warnings.join("\n")).toContain("checkout");
    expect(res.warnings.join("\n")).toContain("on:");
  });

  it("maps actions/cache restore-keys (multiline) with a cap", () => {
    const res = convertActionsWorkflow(`
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
        with:
          path: node_modules
          key: node-abc123
          restore-keys: |
            node-
            npm-\${{ runner.os }}-
      - run: npm test
`);
    expect(isImportSuccess(res)).toBe(true);
    if (!isImportSuccess(res)) return;
    expect(res.yaml).toContain("restore-keys:");
    expect(res.yaml).toContain("node-");
    expect(res.yaml).toContain("npm-expr-");
    const overflow = Array.from({ length: 12 }, (_, i) => `p${i}-`).join("\n            ");
    const capped = convertActionsWorkflow(`
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
        with:
          path: node_modules
          key: k
          restore-keys: |
            ${overflow}
      - run: npm test
`);
    expect(isImportSuccess(capped)).toBe(true);
    if (!isImportSuccess(capped)) return;
    expect(capped.warnings.join("\n")).toContain("trimmed restore-keys to 10");
  });

  it("keeps step ids and maps static job-output refs", () => {
    const res = convertActionsWorkflow(`
jobs:
  a:
    runs-on: ubuntu-latest
    outputs:
      image: \${{ steps.build.outputs.tag }}
      fancy: \${{ needs.other.outputs.x }}
    steps:
      - id: build
        run: echo tag=v1 >> $GITHUB_OUTPUT
      - run: npm test
`);
    expect(isImportSuccess(res)).toBe(true);
    if (!isImportSuccess(res)) return;
    expect(res.yaml).toContain("id: build");
    expect(res.yaml).toContain("image: build.tag");
    expect(res.yaml).not.toContain("fancy");
    expect(res.warnings.join("\n")).toContain("dropped job output `fancy`");
  });

  it("passes through matrix, needs, services, container", () => {
    const res = convertActionsWorkflow(`
jobs:
  a:
    runs-on: [self-hosted, gpu]
    container: node:20
    services:
      db: { image: postgres:16, ports: [5432] }
    strategy: { matrix: { node: [18, 20] } }
    steps: [{ run: echo }]
  b:
    needs: a
    concurrency: { group: main, cancel-in-progress: true }
    steps: [{ run: echo }]
`);
    expect(isImportSuccess(res)).toBe(true);
    if (!isImportSuccess(res)) return;
    expect(res.yaml).toContain("self-hosted");
    expect(res.yaml).toContain("container: node:20");
    expect(res.yaml).toContain("needs: a");
    expect(res.yaml).toContain("cancel-in-progress: true");
  });

  it("drops unsupported actions with warnings, errors when empty", () => {
    const res = convertActionsWorkflow(
      "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker/build-push-action@v5\n      - run: echo kept\n",
    );
    expect(isImportSuccess(res)).toBe(true);
    if (!isImportSuccess(res)) return;
    expect(res.warnings.join("\n")).toContain("docker/build-push-action");
    const dropped = convertActionsWorkflow("jobs:\n  a:\n    steps:\n      - uses: docker/build-push-action@v5\n");
    expect(dropped).toEqual({ error: "no convertible jobs (see warnings)" });
    expect(convertActionsWorkflow("")).toEqual({ error: "empty workflow" });
    expect(convertActionsWorkflow("{{{")).toMatchObject({ error: expect.stringContaining("invalid YAML") });
    expect(convertActionsWorkflow("on: push")).toEqual({ error: "no jobs map found" });
  });
});

describe("import helpers", () => {
  it("maps hosted labels", () => {
    expect(mapRunsOn("ubuntu-latest")).toEqual(["linux"]);
    expect(mapRunsOn("macos-14")).toEqual(["macos"]);
    expect(mapRunsOn(["windows-2022", "gpu"])).toEqual(["windows", "gpu"]);
    expect(mapRunsOn(42)).toBeNull();
  });

  it("staticizes expression keys", () => {
    expect(sanitizeCacheKey("node-${{ runner.os }}-${{ hashFiles('x') }}")).toBe("node-expr-expr");
    expect(sanitizeCacheKey("plain/key.1")).toBe("plain/key.1");
  });

  it("preserves continue-on-error on run steps", () => {
    const res = convertActionsWorkflow(
      "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: flaky\n        continue-on-error: true\n      - run: hard\n",
    );
    if (!isImportSuccess(res)) throw new Error(res.error);
    expect(res.yaml).toContain("continue-on-error: true");
    expect(res.yaml).toContain("run: hard");
  });

  it("warns on non-boolean continue-on-error", () => {
    const res = convertActionsWorkflow(
      "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n        continue-on-error: always()\n",
    );
    if (!isImportSuccess(res)) throw new Error(res.error);
    expect(res.warnings.join("\n")).toContain("continue-on-error");
  });

  it("translates supported step conditions and warns on expression soup", () => {
    const res = convertActionsWorkflow(
      "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: cleanup\n        if: always()\n      - run: notify\n        if: failure()\n      - run: x\n        if: github.ref == 'refs/heads/main'\n",
    );
    if (!isImportSuccess(res)) throw new Error(res.error);
    expect(res.yaml).toContain("if: always()");
    expect(res.yaml).toContain("if: failure()");
    expect(res.warnings.join("\n")).toContain("unsupported step condition");
  });

  it("translates supported job conditions and warns on expression soup", () => {
    const ok = convertActionsWorkflow("jobs:\n  a:\n    if: always()\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n");
    if (!isImportSuccess(ok)) throw new Error(ok.error);
    expect(ok.yaml).toContain("if: always()");
    const soup = convertActionsWorkflow(
      "jobs:\n  a:\n    if: ${{ github.ref == 'refs/heads/main' }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
    );
    if (!isImportSuccess(soup)) throw new Error(soup.error);
    expect(soup.warnings.join("\n")).toContain("unsupported job condition");
  });

  it("translates step shell and timeout, warning on unsupported shells", () => {
    const res = convertActionsWorkflow(
      "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n        shell: bash\n        timeout-minutes: 5\n      - run: y\n        shell: python\n",
    );
    if (!isImportSuccess(res)) throw new Error(res.error);
    expect(res.yaml).toContain("shell: bash");
    expect(res.yaml).toContain("timeout-minutes: 5");
    expect(res.warnings.join("\n")).toContain("unsupported step shell");
  });

  it("points scheduled workflows at the dashboard schedules", () => {
    const res = convertActionsWorkflow(
      "on:\n  schedule:\n    - cron: '0 3 * * *'\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n",
    );
    if (!isImportSuccess(res)) throw new Error(res.error);
    expect(res.warnings.join("\n")).toContain("Settings → Schedules");
  });
});
