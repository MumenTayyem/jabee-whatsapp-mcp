/**
 * Whether this file was started, or merely imported by a test.
 *
 * Both entry points need the distinction: `main()` must run when somebody
 * starts the server and must not run when `buildServer()` is imported.
 * The obvious version of this check is the one that shipped and was
 * wrong:
 *
 *   import.meta.url.endsWith(process.argv[1].split("/").pop())
 *
 * That compares the module's URL against the *basename of argv[1]*, which
 * holds only when the file is started by its own path. npm installs a bin
 * as a symlink -- `node_modules/.bin/jabee-mcp` -> `../@jabee/mcp/dist/
 * server.js` -- and Node leaves `process.argv[1]` as the path it was
 * given, so the basename is `jabee-mcp` while the module URL ends in
 * `server.js`. The test never matched, `main()` never ran, and the
 * published 0.1.0 started, said nothing, and exited 0 for every client
 * that spawned `npx @jabee/mcp`. Which is exactly the failure the file's
 * own comment warns about: "server will not start, no reason given".
 *
 * So resolve the symlink and compare the whole path. `realpath` is
 * injectable because that is the part worth testing -- the bug lived in
 * one line of string handling and a unit test on it would have caught it
 * before npm did.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function startedDirectly(
  argv1: string | undefined,
  moduleUrl: string,
  realpath: (path: string) => string = realpathSync,
): boolean {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(realpath(argv1)).href;
  } catch {
    /**
     * argv[1] names something that is not there any more. Treated as "not
     * started directly", because the alternative is a server that throws
     * on a path question rather than starting or staying quiet.
     */
    return false;
  }
}
