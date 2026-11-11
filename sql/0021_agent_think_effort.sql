-- Thinking level per employee. The engine passes it as an optional field on the turn, the server
-- implementation maps it to its own protocol (OpenAI-compatible reasoning_effort here), and a server
-- that does not declare the level rejects the round instead of silently ignoring it.
ALTER TABLE app.agents ADD COLUMN think_effort text;
