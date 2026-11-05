import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  runGitLockRetryForTests,
  withGitWorktreeMutationLockForTests,
} from "../services/workspace-git-mutation-lock.ts";

const execFileAsync = promisify(execFile);

async function createRepo() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-lock-test-"));
  await execFileAsync("git", ["init", "--initial-branch", "master"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "paperclip@example.com"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Paperclip Test"], { cwd: repo });
  await fs.writeFile(path.join(repo, "README.md"), "test\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "test"], { cwd: repo });
  return repo;
}

describe("same-repository git worktree mutation lock", () => {
  it("serializes eight concurrent worktree creates and deletes", async () => {
    const repo = await createRepo();
    const root = path.join(repo, ".paperclip", "worktrees");
    await fs.mkdir(root, { recursive: true });
    const paths = Array.from({ length: 8 }, (_, index) => path.join(root, `w-${index}`));
    let active = 0;
    let maxActive = 0;
    try {
      const created = await Promise.all(paths.map((worktreePath) => withGitWorktreeMutationLockForTests(repo, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], { cwd: repo });
          return worktreePath;
        } finally {
          active -= 1;
        }
      })));
      expect(created).toEqual(paths);
      expect(maxActive).toBe(1);
      const listed = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repo });
      expect((listed.stdout.match(/^worktree /gm) ?? []).length).toBe(9);
    } finally {
      await Promise.all(paths.map((worktreePath) => withGitWorktreeMutationLockForTests(repo, async () => {
        await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repo });
      })));
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("does not block a different repository", async () => {
    const [repoA, repoB] = await Promise.all([createRepo(), createRepo()]);
    let active = 0;
    let maxActive = 0;
    try {
      await Promise.all([repoA, repoB].map((repo) => withGitWorktreeMutationLockForTests(repo, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
      })));
      expect(maxActive).toBe(2);
    } finally {
      await Promise.all([repoA, repoB].map((repo) => fs.rm(repo, { recursive: true, force: true })));
    }
  });
});

describe("git lock retry", () => {
  it("retries transient config locks and preserves the raw final output", async () => {
    let attempts = 0;
    const result = await runGitLockRetryForTests(async () => {
      attempts += 1;
      return attempts < 3
        ? { stdout: "", stderr: "error: could not lock config file .git/config: File exists", code: 1 }
        : { stdout: "ok\n", stderr: "", code: 0 };
    }, { sleep: async () => {}, jitter: () => 0 });
    expect(attempts).toBe(3);
    expect(result.stdout).toBe("ok\n");
    expect(result.retries).toBe(2);
  });

  it("stops after the bounded retry budget and reports the retry count", async () => {
    await expect(runGitLockRetryForTests(async () => ({
      stdout: "",
      stderr: "fatal: Unable to create '.git/index.lock': File exists",
      code: 1,
    }), { sleep: async () => {}, jitter: () => 0 })).rejects.toThrow(/5 retries.*index\.lock/);
  });
});
