import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { startedDirectly } from "../src/entry.js";

/**
 * The check that decides whether `main()` runs.
 *
 * It had been a string comparison on the basename of argv[1], which is
 * true when a file is started by its own path and false through a symlink
 * -- and npm installs every bin as a symlink. So the published 0.1.0
 * started, printed nothing and exited 0 for every client that spawned
 * `npx @jabee/mcp`. These are the cases that would have caught it.
 */
const MODULE = "file:///pkg/dist/server.js";

describe("deciding whether this was started or imported", () => {
  it("says yes when started by its own path", () => {
    expect(startedDirectly("/pkg/dist/server.js", MODULE, (p) => p)).toBe(true);
  });

  /** The regression: npm's bin is a symlink, and argv[1] is the link. */
  it("says yes when started through a bin symlink", () => {
    const realpath = (p: string) =>
      p === "/project/node_modules/.bin/jabee-mcp" ? "/pkg/dist/server.js" : p;

    expect(startedDirectly("/project/node_modules/.bin/jabee-mcp", MODULE, realpath)).toBe(true);
  });

  it("says no when some other file is the one that was started", () => {
    expect(startedDirectly("/project/test/server.test.js", MODULE, (p) => p)).toBe(false);
  });

  /** A test importing `buildServer` must not start a transport. */
  it("says no when there is no argv[1] at all", () => {
    expect(startedDirectly(undefined, MODULE, (p) => p)).toBe(false);
  });

  /**
   * A basename comparison passed this, which is the whole bug in one
   * case: a different file whose name merely ends the same way.
   */
  it("is not fooled by a path that merely ends with the same name", () => {
    expect(startedDirectly("/elsewhere/also-server.js", MODULE, (p) => p)).toBe(false);
  });

  it("says no rather than throwing when argv[1] has gone", () => {
    expect(
      startedDirectly("/gone", MODULE, () => {
        throw new Error("ENOENT");
      }),
    ).toBe(false);
  });
});

/**
 * And the same thing end to end, because the unit test above is only as
 * good as its idea of what npm does.
 *
 * Builds nothing: it runs against `dist/`, and skips when that is absent
 * so `npm test` on a fresh clone is not a build step. The publish path
 * runs the build first, which is when this matters.
 */
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const built = existsSync(path.join(dist, "server.js"));

describe.skipIf(!built)("the built binary, started the way npm starts it", () => {
  const initialize = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  })}\n`;

  function handshake(command: string) {
    return spawnSync(process.execPath, [command], {
      input: initialize,
      encoding: "utf8",
      env: { ...process.env, JABEE_API_KEY: "jak_test" },
      timeout: 10_000,
    });
  }

  it("answers through a symlink, as `npx` and every MCP client reach it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jabee-bin-"));
    const link = path.join(dir, "jabee-mcp");
    symlinkSync(path.join(dist, "server.js"), link);

    const result = handshake(link);

    expect(result.stdout).toContain('"serverInfo"');
    expect(result.stdout).toContain('"jabee"');
  });

  it("answers when started by its own path too", () => {
    const result = handshake(path.join(dist, "server.js"));

    expect(result.stdout).toContain('"serverInfo"');
  });

  it("declares the channel capabilities from the channel entry point", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jabee-bin-"));
    const link = path.join(dir, "jabee-channel");
    symlinkSync(path.join(dist, "channel.js"), link);

    const result = handshake(link);

    expect(result.stdout).toContain("claude/channel");
    expect(result.stdout).toContain("claude/channel/permission");
  });

  /** The module URL check must not fire when a test imports the file. */
  it("stays quiet when the file is imported rather than started", () => {
    const importer = `import("${pathToFileURL(path.join(dist, "server.js")).href}").then(() => process.stdout.write("imported, nothing sent"))`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", importer], {
      encoding: "utf8",
      env: { ...process.env, JABEE_API_KEY: "jak_test" },
      timeout: 10_000,
    });

    expect(out).toBe("imported, nothing sent");
  });
});
