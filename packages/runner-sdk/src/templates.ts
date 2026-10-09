// Bundled pipeline template gallery: one starter flare.yml per stack.
// Single source of truth for the API (`GET /v1/templates`), the
// dashboard gallery, and `cli init --template`. Every template is a
// valid pipeline (single `verify` job); the gallery test pins that the
// YAML parses to a jobs map with runnable steps.

export interface TemplateMeta {
  id: string;
  name: string;
  stack: string;
  description: string;
}

export interface PipelineTemplate extends TemplateMeta {
  yaml: string;
}

const NODE_YAML = `# flare.yml — Node.js starter from the template gallery.
# Detected from package.json; swap npm for yarn/pnpm/bun to match your lockfile.
jobs:
  verify:
    cache:
      key: node-modules
      paths: [node_modules]
    steps:
      - run: npm ci
      - run: npm test
`;

const PYTHON_YAML = `# flare.yml — Python starter from the template gallery.
jobs:
  verify:
    steps:
      - run: pip install -r requirements.txt
      - run: python -m pytest
`;

const GO_YAML = `# flare.yml — Go starter from the template gallery.
jobs:
  verify:
    cache:
      key: go-build
      paths: [~/.cache/go-build]
    steps:
      - run: go build ./...
      - run: go test ./...
`;

const RUST_YAML = `# flare.yml — Rust starter from the template gallery.
jobs:
  verify:
    cache:
      key: cargo-target
      paths: [target]
    steps:
      - run: cargo build
      - run: cargo test
`;

const JAVA_YAML = `# flare.yml — Java (Maven) starter from the template gallery.
# Gradle repos: replace the step with ./gradlew test.
jobs:
  verify:
    cache:
      key: maven-repo
      paths: [~/.m2/repository]
    steps:
      - run: mvn -q test
`;

const GENERIC_YAML = `# flare.yml — generic starter from the template gallery.
jobs:
  verify:
    steps:
      - run: ./run-tests.sh # TODO: replace with your build/test commands
`;

export const TEMPLATES: PipelineTemplate[] = [
  {
    id: "node",
    name: "Node.js",
    stack: "node",
    description: "npm ci plus npm test with a warm node_modules cache.",
    yaml: NODE_YAML,
  },
  {
    id: "python",
    name: "Python",
    stack: "python",
    description: "pip install plus pytest for requirements.txt repos.",
    yaml: PYTHON_YAML,
  },
  {
    id: "go",
    name: "Go",
    stack: "go",
    description: "go build plus go test with a warm build cache.",
    yaml: GO_YAML,
  },
  {
    id: "rust",
    name: "Rust",
    stack: "rust",
    description: "cargo build plus cargo test with a warm target dir.",
    yaml: RUST_YAML,
  },
  {
    id: "java",
    name: "Java (Maven)",
    stack: "java",
    description: "mvn test with a warm local repository cache.",
    yaml: JAVA_YAML,
  },
  {
    id: "generic",
    name: "Generic",
    stack: "generic",
    description: "Placeholder steps for stacks without a matched template.",
    yaml: GENERIC_YAML,
  },
];

export function listTemplateMeta(): TemplateMeta[] {
  return TEMPLATES.map((t) => ({ id: t.id, name: t.name, stack: t.stack, description: t.description }));
}

export function getTemplate(id: string): PipelineTemplate | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}

export function templateIds(): string[] {
  return TEMPLATES.map((t) => t.id);
}
