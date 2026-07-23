import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { getAuthEntry, getAuthEntryFilePath, saveAuthEntry } from "../mcp-auth.ts";

describe("mcp-auth storage paths", () => {
  const originalOAuthDir = process.env.MCP_OAUTH_DIR;
  let authDir: string;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-mcp-auth-storage-"));
    process.env.MCP_OAUTH_DIR = authDir;
  });

  afterEach(() => {
    if (originalOAuthDir === undefined) {
      delete process.env.MCP_OAUTH_DIR;
    } else {
      process.env.MCP_OAUTH_DIR = originalOAuthDir;
    }
    rmSync(authDir, { recursive: true, force: true });
  });

  it("stores arbitrary configured server names under safe hashed paths", () => {
    const names = ["Cloudflare Workers", "сервер", "../escape", "@scope/name", ""];

    for (const [index, name] of names.entries()) {
      const token = `token-${index}`;
      saveAuthEntry(name, { tokens: { accessToken: token } }, "https://example.com/mcp");

      expect(getAuthEntry(name)?.tokens?.accessToken).toBe(token);
      const filePath = getAuthEntryFilePath(name);
      const rel = relative(authDir, filePath);
      expect(rel.startsWith("..")).toBe(false);
      expect(isAbsolute(rel)).toBe(false);
      expect(rel).toMatch(/^sha256-[a-f0-9]{64}\/tokens\.json$/);
      expect(existsSync(filePath)).toBe(true);
    }

    expect(existsSync(join(authDir, "..", "escape", "tokens.json"))).toBe(false);
  });

  it("rejects non-string names at the storage boundary", () => {
    expect(() => getAuthEntryFilePath(undefined as unknown as string)).toThrow(/Invalid MCP server name/);
  });
});
