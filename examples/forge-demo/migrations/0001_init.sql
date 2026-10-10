-- Target D1 schema for the Bookshelf store (src/lib/store.ts is in-memory
-- until this lands). Protected path: changes need plan approval.
CREATE TABLE IF NOT EXISTS authors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES authors(id),
  year INTEGER NOT NULL,
  isbn TEXT
);

CREATE INDEX IF NOT EXISTS books_author ON books(author_id);
