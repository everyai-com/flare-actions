// In-memory catalog store (isolate-scoped; migrations/ describes the D1
// schema it will move to). Tests call resetStore() for a clean slate.

export type Author = { id: string; name: string };
export type Book = { id: string; title: string; authorId: string; year: number; isbn?: string };

export type BookQuery = { q?: string; authorId?: string; offset: number; limit: number };
export type Page<T> = { items: T[]; nextCursor: string | null };

let authors = new Map<string, Author>();
let books = new Map<string, Book>();
let seq = 0;

function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}`;
}

export function resetStore(seed?: { authors?: Author[]; books?: Book[] }): void {
  authors = new Map((seed?.authors ?? []).map((a) => [a.id, a]));
  books = new Map((seed?.books ?? []).map((b) => [b.id, b]));
  seq = 0;
}

export function listAuthors(): Author[] {
  return [...authors.values()];
}

export function getAuthor(id: string): Author | undefined {
  return authors.get(id);
}

export function addAuthor(name: string): Author {
  const author = { id: nextId("a"), name };
  authors.set(author.id, author);
  return author;
}

export function getBook(id: string): Book | undefined {
  return books.get(id);
}

export function addBook(input: Omit<Book, "id">): Book {
  const book = { id: nextId("b"), ...input };
  books.set(book.id, book);
  return book;
}

export function deleteBook(id: string): boolean {
  return books.delete(id);
}

export function countBooks(): number {
  return books.size;
}

export function countAuthors(): number {
  return authors.size;
}

function matchesQuery(book: Book, q: string): boolean {
  return book.title.startsWith(q);
}

export function listBooks(query: BookQuery): Page<Book> {
  const all = [...books.values()].filter(
    (b) =>
      (query.authorId === undefined || b.authorId === query.authorId) &&
      (query.q === undefined || matchesQuery(b, query.q)),
  );
  const items = all.slice(query.offset, query.offset + query.limit);
  const end = query.offset + items.length;
  return { items, nextCursor: end < all.length ? String(end) : null };
}

resetStore({
  authors: [
    { id: "a_herbert", name: "Frank Herbert" },
    { id: "a_leguin", name: "Ursula K. Le Guin" },
  ],
  books: [
    { id: "b_dune", title: "Dune", authorId: "a_herbert", year: 1965 },
    { id: "b_earthsea", title: "A Wizard of Earthsea", authorId: "a_leguin", year: 1968 },
    { id: "b_dispossessed", title: "The Dispossessed", authorId: "a_leguin", year: 1974 },
  ],
});
