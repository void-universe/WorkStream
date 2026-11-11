-- AI stand-in: a hidden agent bound to a human account, enabled by one switch.
--
-- kind marks the row so the employee list can hide it (it is not one of your employees; it is you,
-- answering while you are away). standin_enabled is the switch; the optional window reuses
-- users.delegate_start_at / delegate_end_at, and the routing itself stays in delegate.mjs so a
-- stand-in and a manually appointed employee take the same delivery path.
ALTER TABLE app.agents ADD COLUMN kind text;
ALTER TABLE app.users ADD COLUMN standin_enabled boolean;
