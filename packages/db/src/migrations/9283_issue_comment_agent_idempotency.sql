-- SPA-9687: make an agent comment replay safe after an ambiguous failure.
--
-- `client_request_id` already existed and was already unique per
-- (issue_id, author_user_id, client_request_id), but the comments POST stripped
-- the key for every agent actor, so an agent retry after a reset, proxy 502, or
-- read timeout that landed after the server committed wrote a second comment
-- every time. This index is the constraint that makes the service-layer replay
-- lookup authoritative when two identical requests race.
--
-- Partial: agent-authored comments only, so the existing user-keyed index keeps
-- its own semantics and NULL-heavy rows stay out of the index.
--
-- Safe to build: at migration time there are 0 duplicate
-- (issue_id, author_agent_id, client_request_id) groups among the rows that carry
-- a non-null client_request_id.
--
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle
-- migrations run transactionally, so CONCURRENTLY is unavailable. This partial
-- index is also near-free to build: the agent-keyed key namespace is empty in
-- every existing deployment, because the comments POST stripped clientRequestId
-- for every agent actor, so the index has no rows to scan.
CREATE UNIQUE INDEX IF NOT EXISTS "issue_comments_agent_client_request_uq"
  ON "issue_comments" ("issue_id", "author_agent_id", "client_request_id")
  WHERE "client_request_id" IS NOT NULL AND "author_agent_id" IS NOT NULL;
