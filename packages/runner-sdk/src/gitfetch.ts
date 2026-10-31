// Checkout fetch plan, shared by BYO runners (checkout.ts, argv) and
// seats (seat.ts, an `sh -s` script), so both fetch the same history.
// Dependency-free: seats and the worker parser import it.
//
// `fetch-depth: 1` (the default) is a single-sha shallow fetch, the
// fastest checkout when nothing reads history. Anything else is for
// history readers (nx/turbo affected, merge-base, changesets, git
// describe): fetch the sha plus every branch head, so `origin/main`
// exists, and add tags for `fetch-depth: 0` (actions/checkout parity).
// When the executor can fetch file contents lazily later, skip blobs
// (`--filter=blob:none`): history needs commits and trees, and only the
// checked-out tree needs contents. A blobless clone keeps history cheap
// where a shallow clone would break the tools above.

export const DEFAULT_FETCH_DEPTH = 1;
export const MAX_FETCH_DEPTH = 10000;

export function isValidFetchDepth(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_FETCH_DEPTH;
}

export const BRANCH_HEADS_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

export function gitFetchArgs(opts: { remote: string; sha: string; depth?: number; blobless: boolean }): string[] {
  const depth = opts.depth ?? DEFAULT_FETCH_DEPTH;
  if (depth === 1) return ["fetch", "-q", "--depth", "1", opts.remote, opts.sha];
  const args = ["fetch", "-q"];
  if (depth > 1) args.push("--depth", String(depth));
  if (opts.blobless) args.push("--filter=blob:none");
  if (depth === 0) args.push("--tags");
  args.push(opts.remote, opts.sha, BRANCH_HEADS_REFSPEC);
  return args;
}

// Join argv for an `sh -s` script, POSIX single-quoting anything beyond
// plain word characters (the refspec's `*` must never glob).
export function shellJoin(args: string[]): string {
  return args.map((a) => (/^[\w@%=:,./-]+$/.test(a) ? a : `'${a.split("'").join(`'\\''`)}'`)).join(" ");
}
