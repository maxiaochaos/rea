import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";

import { reconstructJavaScriptArtifact } from "../../support/javascriptApplicationScope.js";
import { writeJavaScriptArtifactFixture } from "../../fixtures/javascriptArtifactApplication.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("JavaScript artifact input path resolution diagnostics", () => {
  it("succeeds for an existing directory", async () => {
    const root = await fixtureDirectory();
    const result = await reconstructJavaScriptArtifact({
      input_path: root,
    });
    expect(result.input_path).toBe(root);
    expect(result.format).toBe("directory");
  });

  it("reports the caller-provided path in ENOENT errors", async () => {
    const nonexistentPath = "/nonexistent/path/to/artifact";
    await expect(
      reconstructJavaScriptArtifact({ input_path: nonexistentPath }),
    ).rejects.toMatchObject({
      _tag: "AnalysisInputError",
      issues: [
        {
          path: ["input_path"],
          reason: "invalid_value",
          message: expect.stringContaining(
            "caller path: /nonexistent/path/to/artifact",
          ),
        },
      ],
    });
  });

  it("includes the error code in ENOENT diagnostics", async () => {
    const nonexistentPath = "/nonexistent/path/to/artifact.asar";
    await expect(
      reconstructJavaScriptArtifact({ input_path: nonexistentPath }),
    ).rejects.toMatchObject({
      _tag: "AnalysisInputError",
      issues: [
        {
          path: ["input_path"],
          reason: "invalid_value",
          message: expect.stringMatching(/\(ENOENT\)/),
        },
      ],
    });
  });

  it("includes syscall information when available in ENOENT diagnostics", async () => {
    const nonexistentPath = "/nonexistent/path/to/artifact";
    await expect(
      reconstructJavaScriptArtifact({ input_path: nonexistentPath }),
    ).rejects.toMatchObject({
      _tag: "AnalysisInputError",
      issues: [
        {
          path: ["input_path"],
          reason: "invalid_value",
          message: expect.stringMatching(/syscall:/),
        },
      ],
    });
  });

  it("reports ENOTDIR for a non-directory parent", async () => {
    const root = await fixtureDirectory();
    const packageJsonPath = join(root, "package.json");
    const invalidPath = join(packageJsonPath, "nested", "file");
    await expect(
      reconstructJavaScriptArtifact({ input_path: invalidPath }),
    ).rejects.toMatchObject({
      _tag: "AnalysisInputError",
      issues: [
        {
          path: ["input_path"],
          reason: "invalid_value",
          message: expect.stringMatching(/\(ENOTDIR\)/),
        },
      ],
    });
  });

  it("preserves the original Error as cause for diagnosis", async () => {
    const nonexistentPath = "/nonexistent/path/to/artifact";
    let caughtError: Error | undefined;
    try {
      await reconstructJavaScriptArtifact({ input_path: nonexistentPath });
    } catch (error) {
      caughtError = error as Error;
    }
    expect(caughtError).toBeDefined();
    expect(caughtError).toHaveProperty("cause");
    const cause = (caughtError as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    expect(cause).toHaveProperty("code", "ENOENT");
  });

  it("includes resolved path when different from caller path", async () => {
    const relativePath = "nonexistent-relative-path";
    await expect(
      reconstructJavaScriptArtifact({ input_path: relativePath }),
    ).rejects.toMatchObject({
      _tag: "AnalysisInputError",
      issues: [
        {
          path: ["input_path"],
          reason: "invalid_value",
          message: expect.stringMatching(/resolved path:/),
        },
      ],
    });
  });
});

const fixtureDirectory = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-input-path-diag-");
  await writeJavaScriptArtifactFixture(root);
  return root;
};
