import type { GitHubClient } from '../lib/github';
import type { Severity } from '../config/schema';

export type CheckStatus = 'pass' | 'fail' | 'skip';
export type CheckCategory =
  | 'repo'
  | 'branch'
  | 'files'
  | 'deps'
  | 'workflows'
  | 'org';

export interface CheckResult {
  status: CheckStatus;
  message: string;
  /** Human-readable remediation text. NEVER executed. */
  remediation?: string;
  details?: unknown;
}

export interface CheckContext {
  github: GitHubClient;
  /** Repo metadata (the result of repos.get), fetched once and shared. */
  repo: Awaited<ReturnType<GitHubClient['tryGetRepo']>>;
  /** The default branch name, resolved from repo metadata. */
  defaultBranch: string;
  /** The branch this check is evaluating (defaults to defaultBranch for non-branch checks). */
  branch: string;
  /** Per-check resolved configuration. */
  config: Record<string, unknown>;
  /** Detected ecosystems present in the repo (populated by ecosystem-detect). */
  ecosystems: Set<string>;
  /** Glob patterns of paths to ignore. */
  ignoreFiles: string[];
}

export interface Check {
  id: string;
  category: CheckCategory;
  description: string;
  docsUrl: string;
  /** Default severity used if no preset/config touches this check. */
  defaultSeverity: Severity;
  run(ctx: CheckContext): Promise<CheckResult>;
}

/** A check result decorated with the resolved severity and check metadata. */
export interface FinishedCheck {
  check: Check;
  severity: Severity;
  result: CheckResult;
  /** Which branch this check ran against (for branch.* checks). */
  branch?: string;
  /** Duration in ms. */
  durationMs: number;
}
