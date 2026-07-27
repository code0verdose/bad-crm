-- 01-extensions.sql · PostgreSQL extensions Bad CRM depends on.
--
-- Runs as the superuser on first initialisation of the data directory, right after
-- 00-bootstrap-roles.sh, against POSTGRES_DB. `vector` is not a trusted extension, so it can only
-- be created by a superuser — which is exactly why this is a bootstrap step and not a migration.
--
-- The application refuses to start when one of these is missing (ADR-0020, preflight checks), so
-- adding a new extension here means adding it to the preflight list in the same change.

\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;      -- User.email, case-insensitive uniqueness
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- trigram search, the PostgreSQL FTS fallback
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- exclusion constraints on scalar + range columns
CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector: embeddings for the AI features
