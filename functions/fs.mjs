// Path rules for the group-file tree. Pure functions only: the same rules have to hold for the
// upload endpoint, the rename action and the employee tools, and a second copy of them would drift.
import { Halt } from "./util.mjs";

const SEGMENT = /^[^/\\.][^/\\]{0,63}$/;
export const MAX_DEPTH = 6;
const MAX_PATH = 200;

/** '' for the root, otherwise 'a/b' with every segment checked. Rejects '..', empty segments and
 *  anything a shell or a URL would read as a traversal. */
export function cleanDir(raw, name = "path") {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "" || value === "/") return "";
  const trimmed = value.replace(/^\/+|\/+$/g, "");
  if (trimmed.length > MAX_PATH) throw new Halt("invalid_file_path", 400, { reason: "too_long" });
  const parts = trimmed.split("/");
  if (parts.length > MAX_DEPTH) throw new Halt("invalid_file_path", 400, { reason: "too_deep" });
  for (const part of parts) {
    if (!SEGMENT.test(part) || part === "." || part === "..") {
      throw new Halt("invalid_file_path", 400, { reason: "bad_segment", name });
    }
  }
  return parts.join("/");
}

/** Directory the row lives in, plus its basename: 'a/b/c.txt' → { path: 'a/b', name: 'c.txt' }. */
export function splitFull(raw) {
  const value = String(raw ?? "").replace(/^\/+|\/+$/g, "");
  const cut = value.lastIndexOf("/");
  if (cut < 0) return { path: "", name: value };
  return { path: cleanDir(value.slice(0, cut)), name: value.slice(cut + 1) };
}

export const childPath = (dir, name) => (dir ? `${dir}/${name}` : name);

/** Is `candidate` the directory itself or below it? Used when moving a folder. */
export const isUnder = (dir, candidate) => dir === "" || candidate === dir || candidate.startsWith(`${dir}/`);

/** Rewrite the path of every descendant when a folder moves: from 'a' to 'b/c'. */
export const rebase = (from, to, path) => (from === path ? to : `${to}${path.slice(from.length)}`);
