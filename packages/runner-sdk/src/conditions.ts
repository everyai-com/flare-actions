// Bounded `if:` conditions: status functions plus comparisons over
// the needs/steps contexts. No expression engine (no arithmetic, no
// function calls beyond the four status fns, no nested template
// evaluation) — a hand-rolled tokenizer + recursive descent with
// hard budgets, shared by the worker (job-level, needs only), the
// SDK (step-level, needs + steps), and the importer (validation).
// Pure and Node-free so every lane parses the same bytes.
import { isValidOutputName } from "./outputs.ts";
import type { NeedsContext } from "./outputs.ts";

export const MAX_CONDITION_LENGTH = 512;
export const MAX_CONDITION_DEPTH = 10;
export const MAX_CONDITION_NODES = 100;

export interface ConditionState {
  anyFailed: boolean;
  jobFailed: boolean;
  // Set only by the job-level gate (from settled need results);
  // step engines leave it unset and cancelled() stays false there.
  anyCancelled?: boolean;
}

export interface ConditionContext {
  needs: NeedsContext;
  steps: Record<string, Record<string, string>>;
}

export type ConditionNode =
  | { kind: "fn"; fn: "always" | "success" | "failure" | "cancelled" }
  | { kind: "not"; expr: ConditionNode }
  | { kind: "and"; exprs: ConditionNode[] }
  | { kind: "or"; exprs: ConditionNode[] }
  | { kind: "cmp"; left: ConditionOperand; op: "==" | "!="; literal: string };

export type ConditionOperand =
  | { scope: "needs"; job: string; field: "result" }
  | { scope: "needs"; job: string; field: "output"; key: string }
  | { scope: "steps"; id: string; key: string };

type Token =
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "and" }
  | { kind: "or" }
  | { kind: "not" }
  | { kind: "eq" }
  | { kind: "ne" }
  | { kind: "literal"; value: string }
  | { kind: "word"; value: string };

const FN_NAMES = ["always", "success", "failure", "cancelled"] as const;

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (c === "&" && input[i + 1] === "&") {
      tokens.push({ kind: "and" });
      i += 2;
      continue;
    }
    if (c === "|" && input[i + 1] === "|") {
      tokens.push({ kind: "or" });
      i += 2;
      continue;
    }
    if (c === "=" && input[i + 1] === "=") {
      tokens.push({ kind: "eq" });
      i += 2;
      continue;
    }
    if (c === "!" && input[i + 1] === "=") {
      tokens.push({ kind: "ne" });
      i += 2;
      continue;
    }
    if (c === "!") {
      tokens.push({ kind: "not" });
      i++;
      continue;
    }
    if (c === "'") {
      // Single-quoted literal with '' escape (GitHub spelling).
      let value = "";
      let j = i + 1;
      let closed = false;
      while (j < input.length) {
        if (input[j] === "'") {
          if (input[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        value += input[j];
        j++;
      }
      if (!closed || value.length > 256) return null;
      tokens.push({ kind: "literal", value });
      i = j;
      continue;
    }
    // Bare word: functions, operands. Stops at whitespace and operator
    // characters (job names with spaces are unreferenceable — needs
    // gating still works, only `if:` refs cannot name them).
    if (/[A-Za-z0-9_.$-]/.test(c ?? "")) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_.$-]/.test(input[j] ?? "")) j++;
      tokens.push({ kind: "word", value: input.slice(i, j) });
      i = j;
      continue;
    }
    return null;
  }
  return tokens;
}

function parseOperandToken(token: string, allowSteps: boolean): ConditionOperand | null {
  if (token.startsWith("needs.")) {
    // Greedy job match: `needs.my.job.result` names the job `my.job`
    // (dots backtrack to the last .result/.outputs.).
    const m = /^needs\.(.+)\.(result|outputs\.([A-Za-z_][\w-]*))$/.exec(token);
    if (!m || !m[1] || m[1].length > 128) return null;
    if (m[2] === "result") return { scope: "needs", job: m[1], field: "result" };
    if (m[3] && isValidOutputName(m[3])) return { scope: "needs", job: m[1], field: "output", key: m[3] };
    return null;
  }
  if (token.startsWith("steps.")) {
    if (!allowSteps) return null;
    const m = /^steps\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)$/.exec(token);
    if (!m || !m[1] || !m[2] || !isValidOutputName(m[1]) || !isValidOutputName(m[2])) return null;
    return { scope: "steps", id: m[1], key: m[2] };
  }
  return null;
}

class ConditionParser {
  private pos = 0;
  private nodes = 0;
  private depth = 0;
  private readonly tokens: Token[];
  private readonly allowSteps: boolean;

  // No parameter properties (strip-types compat): assign explicitly.
  constructor(tokens: Token[], allowSteps: boolean) {
    this.tokens = tokens;
    this.allowSteps = allowSteps;
  }

  parse(): ConditionNode | null {
    const node = this.parseOr();
    if (!node || this.pos !== this.tokens.length) return null;
    return node;
  }

  private count(): boolean {
    this.nodes++;
    return this.nodes <= MAX_CONDITION_NODES;
  }

  private parseOr(): ConditionNode | null {
    const exprs: ConditionNode[] = [];
    for (;;) {
      const next = this.parseAnd();
      if (!next) return null;
      exprs.push(next);
      if (this.peek()?.kind !== "or") break;
      this.pos++;
    }
    if (!this.count()) return null;
    return exprs.length === 1 ? exprs[0] : { kind: "or", exprs };
  }

  private parseAnd(): ConditionNode | null {
    const exprs: ConditionNode[] = [];
    for (;;) {
      const next = this.parseUnary();
      if (!next) return null;
      exprs.push(next);
      if (this.peek()?.kind !== "and") break;
      this.pos++;
    }
    if (!this.count()) return null;
    return exprs.length === 1 ? exprs[0] : { kind: "and", exprs };
  }

  private parseUnary(): ConditionNode | null {
    if (this.peek()?.kind === "not") {
      this.pos++;
      const expr = this.parseUnary();
      if (!expr || !this.count()) return null;
      return { kind: "not", expr };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ConditionNode | null {
    const tok = this.peek();
    if (!tok) return null;
    if (tok.kind === "lparen") {
      this.pos++;
      this.depth++;
      if (this.depth > MAX_CONDITION_DEPTH) return null;
      const inner = this.parseOr();
      this.depth--;
      if (!inner || this.peek()?.kind !== "rparen") return null;
      this.pos++;
      return inner;
    }
    if (tok.kind !== "word") return null;
    // Status function: name + `(` + `)` (case-insensitive, legacy).
    const lowered = tok.value.toLowerCase();
    if ((FN_NAMES as readonly string[]).includes(lowered)) {
      if (this.tokens[this.pos + 1]?.kind !== "lparen" || this.tokens[this.pos + 2]?.kind !== "rparen") return null;
      this.pos += 3;
      if (!this.count()) return null;
      return { kind: "fn", fn: lowered as "always" | "success" | "failure" | "cancelled" };
    }
    // Comparison: operand == 'literal'.
    const operand = parseOperandToken(tok.value, this.allowSteps);
    if (!operand) return null;
    const op = this.tokens[this.pos + 1];
    const lit = this.tokens[this.pos + 2];
    if ((op?.kind !== "eq" && op?.kind !== "ne") || lit?.kind !== "literal") return null;
    this.pos += 3;
    if (!this.count()) return null;
    return { kind: "cmp", left: operand, op: op.kind === "eq" ? "==" : "!=", literal: lit.value };
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
}

// Parse a condition, or null when it leaves the bounded subset.
// allowSteps=false rejects `steps.*` refs (job-level conditions run
// before any step exists, so same-job steps are unknowable there).
export function parseCondition(raw: unknown, opts?: { allowSteps?: boolean }): ConditionNode | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_CONDITION_LENGTH) return null;
  const tokens = tokenize(trimmed);
  if (!tokens || tokens.length === 0) return null;
  return new ConditionParser(tokens, opts?.allowSteps !== false).parse();
}

// Validate and keep the trimmed original (literals are case-sensitive,
// so unlike the legacy normalizer this never lowercases).
export function normalizeCondition(raw: unknown, opts?: { allowSteps?: boolean }): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return parseCondition(trimmed, opts) ? trimmed : null;
}

function resolveOperand(operand: ConditionOperand, ctx: ConditionContext): string {
  if (operand.scope === "steps") return ctx.steps[operand.id]?.[operand.key] ?? "";
  const need = ctx.needs[operand.job];
  if (!need) return "";
  if (operand.field === "result") return need.result;
  return need.outputs[operand.key] ?? "";
}

function evaluateNode(node: ConditionNode, state: ConditionState, ctx: ConditionContext): boolean {
  switch (node.kind) {
    case "fn":
      if (node.fn === "always") return true;
      if (node.fn === "success") return !state.jobFailed;
      if (node.fn === "failure") return state.anyFailed;
      return state.anyCancelled ?? false;
    case "not":
      return !evaluateNode(node.expr, state, ctx);
    case "and":
      return node.exprs.every((e) => evaluateNode(e, state, ctx));
    case "or":
      return node.exprs.some((e) => evaluateNode(e, state, ctx));
    case "cmp": {
      const value = resolveOperand(node.left, ctx);
      return node.op === "==" ? value === node.literal : value !== node.literal;
    }
  }
}

// Evaluate a validated condition. Unparseable input fails closed
// (false): stored conditions were validated at dispatch, so this only
// trips on tampered definitions — which must never run steps.
export function evaluateCondition(
  condition: string,
  state: ConditionState,
  ctx: ConditionContext = { needs: {}, steps: {} },
): boolean {
  const node = parseCondition(condition, { allowSteps: true });
  if (!node) return false;
  return evaluateNode(node, state, ctx);
}

// Job-level gate over settled needs (worker promote + fan-out, local
// runner). Per-need results discriminate skipped/cancelled from failed
// (GitHub truth table: success() needs all-success, failure() needs a
// real failure, cancelled() needs a cancellation, always() proceeds),
// so a skipped need cascade-skips default dependents without tripping
// failure() handlers. The coarse flag rules only when there are no
// needs to read (root jobs). Results always survive needs capping, so
// this stays exact under truncation. Unparseable input fails closed.
export function jobConditionSatisfied(
  condition: string | undefined,
  needsFailed: boolean,
  needs?: NeedsContext,
): boolean {
  const results = Object.values(needs ?? {}).map((n) => n.result);
  const readResults = results.length > 0;
  const jobFailed = readResults ? results.some((r) => r !== "success") : needsFailed;
  if (condition === undefined || condition === "") return !jobFailed; // default = success()
  return evaluateCondition(
    condition,
    {
      anyFailed: readResults ? results.some((r) => r === "failure") : needsFailed,
      jobFailed,
      anyCancelled: results.some((r) => r === "cancelled"),
    },
    { needs: needs ?? {}, steps: {} },
  );
}

// Fan-out verdict for one job: needs park it, an active same-group job
// parks it, otherwise a root `if:` that is already false (e.g.
// `failure()` with nothing to fail from) skips it instead of queueing.
// Shared by dispatch and the dry-run mirror so both agree.
export function initialJobStatus(
  job: { needs?: string[]; if?: string },
  groupBlocked: boolean,
): { status: "queued" | "blocked" | "skipped"; blockedReason: "needs" | "group" | "if" | null } {
  if ((job.needs?.length ?? 0) > 0) return { status: "blocked", blockedReason: "needs" };
  if (groupBlocked) return { status: "blocked", blockedReason: "group" };
  if (!jobConditionSatisfied(job.if, false, {})) return { status: "skipped", blockedReason: "if" };
  return { status: "queued", blockedReason: null };
}
