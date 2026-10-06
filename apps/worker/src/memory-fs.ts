// In-memory filesystem for isomorphic-git promotion pushes, adapted
// from Cloudflare's Artifacts isomorphic-git example (docs). Workers
// have no node:fs; this is the entire disk for one promotion.
//
// isomorphic-git binds 10 commands at construction (missing ones throw
// `undefined.bind`), prefers the `promises` surface when present, and
// branches on `err.code` — every error below carries a Node-style code.
type Entry =
  | { kind: "dir"; children: Set<string>; mtimeMs: number }
  | { kind: "file"; data: Uint8Array; mtimeMs: number }
  | { kind: "symlink"; target: string; mtimeMs: number };

function fsError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

class MemoryStats {
  constructor(private entry: Entry) {}

  get size(): number {
    return this.entry.kind === "file" ? this.entry.data.byteLength : 0;
  }

  get mtimeMs(): number {
    return this.entry.mtimeMs;
  }

  get ctimeMs(): number {
    return this.entry.mtimeMs;
  }

  get mode(): number {
    return this.entry.kind === "file" ? 0o100644 : this.entry.kind === "symlink" ? 0o120000 : 0o040000;
  }

  isFile(): boolean {
    return this.entry.kind === "file";
  }

  isDirectory(): boolean {
    return this.entry.kind === "dir";
  }

  isSymbolicLink(): boolean {
    return this.entry.kind === "symlink";
  }
}

export class MemoryFS {
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private entries = new Map<string, Entry>([["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }]]);

  promises = {
    readFile: (path: string, options?: string | { encoding?: string }): Promise<Uint8Array | string> =>
      this.readFile(path, options),
    writeFile: (path: string, data: string | Uint8Array | ArrayBuffer): Promise<void> => this.writeFile(path, data),
    unlink: (path: string): Promise<void> => this.unlink(path),
    readdir: (path: string): Promise<string[]> => this.readdir(path),
    mkdir: (path: string, options?: { recursive?: boolean } | number): Promise<void> => this.mkdir(path, options),
    rmdir: (path: string): Promise<void> => this.rmdir(path),
    stat: (path: string): Promise<MemoryStats> => this.stat(path),
    lstat: (path: string): Promise<MemoryStats> => this.lstat(path),
    readlink: (path: string): Promise<string> => this.readlink(path),
    symlink: (target: string, path: string): Promise<void> => this.symlink(target, path),
  };

  private normalize(input: string): string {
    const segments: string[] = [];
    for (const part of input.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        segments.pop();
        continue;
      }
      segments.push(part);
    }
    return segments.length ? `/${segments.join("/")}` : "/";
  }

  private parent(path: string): string {
    const normalized = this.normalize(path);
    if (normalized === "/") return "/";
    const parts = normalized.split("/").filter(Boolean);
    parts.pop();
    return parts.length ? `/${parts.join("/")}` : "/";
  }

  private basename(path: string): string {
    return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
  }

  private getEntry(path: string): Entry | undefined {
    return this.entries.get(this.normalize(path));
  }

  private requireEntry(path: string): Entry {
    const entry = this.getEntry(path);
    if (!entry) throw fsError("ENOENT", path);
    return entry;
  }

  private requireDir(path: string): Extract<Entry, { kind: "dir" }> {
    const entry = this.requireEntry(path);
    if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
    return entry;
  }

  async mkdir(path: string, options?: { recursive?: boolean } | number): Promise<void> {
    const target = this.normalize(path);
    if (target === "/") return;
    const recursive = typeof options === "object" && options !== null && options.recursive;
    const parent = this.parent(target);
    if (!this.entries.has(parent)) {
      if (!recursive) throw fsError("ENOENT", parent);
      await this.mkdir(parent, { recursive: true });
    }
    if (this.entries.has(target)) return;
    this.entries.set(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
    this.requireDir(parent).children.add(this.basename(target));
  }

  async writeFile(path: string, data: string | Uint8Array | ArrayBuffer): Promise<void> {
    const target = this.normalize(path);
    await this.mkdir(this.parent(target), { recursive: true });
    const bytes = typeof data === "string" ? this.encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    this.entries.set(target, { kind: "file", data: bytes, mtimeMs: Date.now() });
    this.requireDir(this.parent(target)).children.add(this.basename(target));
  }

  async readFile(path: string, options?: string | { encoding?: string }): Promise<Uint8Array | string> {
    const entry = this.requireEntry(path);
    if (entry.kind !== "file") throw fsError("EISDIR", path);
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? this.decoder.decode(entry.data) : entry.data;
  }

  async readdir(path: string): Promise<string[]> {
    return [...this.requireDir(path).children].sort();
  }

  async unlink(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.requireEntry(target);
    if (entry.kind !== "file" && entry.kind !== "symlink") throw fsError("EISDIR", path);
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children.delete(this.basename(target));
  }

  async rmdir(path: string): Promise<void> {
    const target = this.normalize(path);
    const entry = this.requireDir(target);
    if (entry.children.size > 0) throw fsError("ENOTEMPTY", path);
    this.entries.delete(target);
    this.requireDir(this.parent(target)).children.delete(this.basename(target));
  }

  async stat(path: string): Promise<MemoryStats> {
    // Follows one link hop (ten chained); loops surface as ELOOP.
    let current = path;
    for (let hop = 0; hop < 10; hop++) {
      const entry = this.requireEntry(current);
      if (entry.kind !== "symlink") return new MemoryStats(entry);
      current = entry.target.startsWith("/") ? entry.target : `${this.parent(current)}/${entry.target}`;
    }
    throw fsError("ELOOP", path);
  }

  async lstat(path: string): Promise<MemoryStats> {
    return new MemoryStats(this.requireEntry(path));
  }

  async readlink(path: string): Promise<string> {
    const entry = this.requireEntry(path);
    if (entry.kind !== "symlink") throw fsError("EINVAL", path);
    return entry.target;
  }

  async symlink(target: string, path: string): Promise<void> {
    const resolved = this.normalize(path);
    await this.mkdir(this.parent(resolved), { recursive: true });
    if (this.entries.has(resolved)) throw fsError("EEXIST", path);
    this.entries.set(resolved, { kind: "symlink", target, mtimeMs: Date.now() });
    this.requireDir(this.parent(resolved)).children.add(this.basename(resolved));
  }
}
