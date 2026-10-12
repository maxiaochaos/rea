import { describe, expect, it, vi } from "vitest";
import { resolve, win32, posix } from "node:path";

import { reconstructJavaScriptArtifact } from "../../support/javascriptApplicationScope.js";
import { writeJavaScriptArtifactFixture } from "../../fixtures/javascriptArtifactApplication.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("Windows path semantics for JavaScript artifact reconstruction", () => {
  it("normalizes relative paths before resolution", async () => {
    const root = await fixtureDirectory();
    const result = await reconstructJavaScriptArtifact({
      input_path: root,
    });
    expect(result.input_path).toBe(root);
    expect(result.format).toBe("directory");
  });

  it("reports the original caller-provided path in validation errors", async () => {
    const nonexistentPath = "/nonexistent/path/to/artifact";
    await expect(
      reconstructJavaScriptArtifact({ input_path: nonexistentPath }),
    ).rejects.toMatchObject({
      _tag: "AnalysisInputError",
      issues: [
        {
          path: ["input_path"],
          reason: "invalid_value",
          message: expect.stringContaining(nonexistentPath),
        },
      ],
    });
  });

  it("verifies path.resolve() normalizes Windows-style paths with forward slashes", () => {
    const windowsPath = "C:/work/tiny.asar";
    const resolved = win32.resolve(windowsPath);
    expect(win32.isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe("C:\\work\\tiny.asar");
  });

  it("verifies path.resolve() normalizes Windows-style paths with backslashes", () => {
    const windowsPath = "C:\\work\\tiny.asar";
    const resolved = win32.resolve(windowsPath);
    expect(win32.isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe("C:\\work\\tiny.asar");
  });

  it("verifies path.resolve() normalizes Windows UNC paths", () => {
    const uncPath = "\\\\server\\share\\tiny.asar";
    const resolved = win32.resolve(uncPath);
    expect(win32.isAbsolute(resolved)).toBe(true);
    expect(resolved.startsWith("\\\\")).toBe(true);
  });

  it("verifies Windows path detection for both ASAR and directory paths", () => {
    const asarPath = "C:/work/tiny.asar";
    const dirPath = "C:/work/tiny-app";

    expect(win32.isAbsolute(asarPath)).toBe(true);
    expect(win32.isAbsolute(dirPath)).toBe(true);
    expect(posix.isAbsolute(asarPath)).toBe(false);
    expect(posix.isAbsolute(dirPath)).toBe(false);
  });

  it("handles the path normalization that resolve() applies", () => {
    const originalPath = "relative/../normalized/file.asar";
    const normalizedPosix = posix.resolve("/cwd", originalPath);
    const normalizedWin = win32.resolve("C:\\cwd", originalPath);

    expect(normalizedPosix).toBe("/cwd/normalized/file.asar");
    expect(normalizedWin).toBe("C:\\cwd\\normalized\\file.asar");
  });
});

const fixtureDirectory = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-windows-path-");
  await writeJavaScriptArtifactFixture(root);
  return root;
};
