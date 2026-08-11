-- FTS5 virtual tables. Hand-written because Drizzle has no way to express
-- `CREATE VIRTUAL TABLE ... USING fts5`, so `drizzle-kit generate` will never
-- produce these and never drop them either.
--
-- `porter` stems the index, so a query for "refund" also hits "refundable".
-- The default unicode61 tokenizer would miss it.

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  chunk_id    UNINDEXED,
  document_id UNINDEXED,
  tokenize = 'porter'
);
--> statement-breakpoint
-- Schema search. Same `porter` reasoning: a search for "refund" should reach a
-- table called `refunds`.
CREATE VIRTUAL TABLE IF NOT EXISTS db_schema_fts USING fts5(
  text,
  object_id     UNINDEXED,
  connection_id UNINDEXED,
  kind          UNINDEXED,
  tokenize = 'porter'
);
