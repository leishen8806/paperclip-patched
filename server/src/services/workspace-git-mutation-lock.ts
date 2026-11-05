import { realpathSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const GIT_WORKTREE_LOCK_MAX_RETRIES = 5;
export const GIT_WORKTREE_LOCK_MAX_WAIT_MS = 15_000;

export interface GitWorktreeProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
}

export interface GitWorktreeRetryResult extends GitWorktreeProcessResult {
  retries: number;
  exhausted: boolean;
}

type Sleep = (ms: number) => Promise<void>;

const repoMutationLocks = new Map<string, Promise<void>>();

function canonicalRepositoryKey(repoRoot: string): string {
  const resolved = path.resolve(repoRoot);
  try {
    return realpathSync.native(resolved).toLowerCase();
  } catch {
    return resolved.toLowerCase();
  }
}

export function isGitWorktreeLockFailure(result: GitWorktreeProcessResult): boolean {
  const output = result.stderr + "\n" + result.stdout;
  return /could not lock config file|index\.lock|cannot lock .*config|cannot lock ref|unable to create .*\.lock/i.test(output);
}

/** Serialize mutations that write a repository's shared git metadata. */
export async function withGitWorktreeMutationLock<T>(repoRoot: string, action: () => Promise<T>): Promise<T> {
  const key = canonicalRepositoryKey(repoRoot);
  const previous = repoMutationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  repoMutationLocks.set(key, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (repoMutationLocks.get(key) === queued) repoMutationLocks.delete(key);
  }
}

function retryDelayMs(retry: number, jitter: () => number): number {
  const base = Math.min(2_000, 100 * 2 ** retry);
  return Math.min(base + Math.max(0, jitter()), GIT_WORKTREE_LOCK_MAX_WAIT_MS);
}

export async function retryGitWorktreeLock(
  run: () => Promise<GitWorktreeProcessResult>,
  options: {
    maxRetries?: number;
    sleep?: Sleep;
    jitter?: () => number;
  } = {},
): Promise<GitWorktreeRetryResult> {
  const maxRetries = Math.max(0, Math.min(GIT_WORKTREE_LOCK_MAX_RETRIES, Math.floor(options.maxRetries ?? GIT_WORKTREE_LOCK_MAX_RETRIES)));
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const jitter = options.jitter ?? (() => Math.floor(Math.random() * 50));
  let retries = 0;
  let waitedMs = 0;
  while (true) {
    const result = await run();
    const lockFailure = result.code !== 0 && isGitWorktreeLockFailure(result);
    if (!lockFailure || retries >= maxRetries) {
      return { ...result, retries, exhausted: lockFailure && retries >= maxRetries };
    }
    const waitMs = retryDelayMs(retries, jitter);
    if (waitedMs + waitMs > GIT_WORKTREE_LOCK_MAX_WAIT_MS) {
      return { ...result, retries, exhausted: true };
    }
    waitedMs += waitMs;
    retries += 1;
    await sleep(waitMs);
  }
}

export function isGitWorktreeMutation(args: readonly string[]): boolean {
  const worktreeIndex = args.indexOf("worktree");
  if (worktreeIndex >= 0 && ["add", "remove", "prune"].includes(args[worktreeIndex + 1] ?? "")) return true;
  return args.includes("branch") && (args.includes("-d") || args.includes("-D") || args.includes("--delete"));
}

/** Shared execution path used by workspace-runtime and its integration tests. */
export async function runGitOperationWithLockRetry(
  args: string[],
  cwd: string,
  run: (args: string[], cwd: string) => Promise<GitWorktreeProcessResult>,
) {
  const execute = () => retryGitWorktreeLock(() => run(args, cwd));
  return isGitWorktreeMutation(args)
    ? withGitWorktreeMutationLock(cwd, execute)
    : execute();
}

export function gitLockRetryMetadata(retries: number): Record<string, number> {
  return retries > 0 ? { gitLockRetries: retries } : {};
}

// Test seams keep the concurrency and bounded-retry contract executable without
// importing the full server dependency graph.
export const withGitWorktreeMutationLockForTests = withGitWorktreeMutationLock;
export async function runGitLockRetryForTests(
  run: () => Promise<GitWorktreeProcessResult>,
  options?: Parameters<typeof retryGitWorktreeLock>[1],
) {
  const result = await retryGitWorktreeLock(run, options);
  if (result.exhausted) {
    const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    throw new Error("git worktree lock retry exhausted after " + result.retries + " retries: " + details);
  }
  return result;
}
