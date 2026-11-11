-- Group files get a directory tree. `path` is the parent directory ('' = root) and `name` is the
-- basename, so a full path is path ? path + '/' + name : name. Folders are rows with store='dir',
-- which is what makes an empty folder representable; link-only assets use store='link' with the URL
-- in `content`. Nullable with no default per the migration API; code always writes it.
ALTER TABLE app.files ADD COLUMN path text;
