-- Deployment targets: one running Stream Server executor that employees can be created on.
--
-- Why a table instead of retyping the address each time: a shared executor serves many employees,
-- so the address and its bearer token are one fact owned by the box, not by each employee. The
-- employee still keeps its own copy (agents.api_base_url / api_key_cipher) so removing a server
-- never breaks an employee that already runs on it.
--
-- The token is sealed exactly like an employee's api key (AES-GCM, tail only in responses), and
-- stream_profile is the discovery result stored at add/edit time: it decides the prompt wording
-- and the tool injection before any round runs, so it cannot be asked lazily per turn.
CREATE TABLE app.servers (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  name text NOT NULL,
  base_url text NOT NULL,
  token_cipher text,
  token_tail text,
  key_source text,
  stream_profile text,
  label text,
  models text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX servers_owner_idx ON app.servers (owner_id);
