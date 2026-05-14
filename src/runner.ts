import type { Check, CheckContext, FinishedCheck } from './checks/types';
import type { ResolvedConfig, Severity } from './config/schema';
import { GitHubClient } from './lib/github';
import { ALL_CHECKS } from './checks/registry';

export interface RunOptions {
  github: GitHubClient;
  config: ResolvedConfig;
  ecosystems: Set<string>;
  defaultBranch: string;
  repo: Awaited<ReturnType<GitHubClient['tryGetRepo']>>;
}

/**
 * Returns the effective severity for a check, considering branch-specific overrides.
 * Branch overrides are only meaningful for `branch.*` checks.
 */
function severityFor(checkId: string, branch: string, config: ResolvedConfig): { severity: Severity; cfg: Record<string, unknown> } {
  const base = config.checks[checkId] ?? { severity: 'off', config: {} };
  const branchOverrides = config.branchOverrides[branch];
  if (branchOverrides && branchOverrides[checkId]) {
    return { severity: branchOverrides[checkId].severity, cfg: branchOverrides[checkId].config };
  }
  return { severity: base.severity, cfg: base.config };
}

export async function runChecks(opts: RunOptions): Promise<FinishedCheck[]> {
  const { github, config, ecosystems, defaultBranch, repo } = opts;
  const baseCtx: Omit<CheckContext, 'config' | 'branch'> = {
    github,
    repo,
    defaultBranch,
    ecosystems,
    ignoreFiles: config.ignoreFiles,
  };

  // For each check, figure out which branch(es) it applies to.
  // Non-`branch.*` checks run once against defaultBranch (label only).
  // `branch.*` checks run once per branch named in branchOverrides (plus default branch).
  const branchTargets = new Set<string>([defaultBranch, ...Object.keys(config.branchOverrides)]);

  // Shared mutable context object lets check helpers cache state per run.
  // We attach symbol-keyed caches on the context.
  const sharedExtras: Record<string, unknown> = {};

  const tasks: Array<{ check: Check; branch: string; severity: Severity; cfg: Record<string, unknown> }> = [];
  for (const check of ALL_CHECKS) {
    if (check.category === 'branch') {
      for (const branch of branchTargets) {
        const { severity, cfg } = severityFor(check.id, branch, config);
        if (severity === 'off') continue;
        tasks.push({ check, branch, severity, cfg });
      }
    } else if (check.category === 'org') {
      if (!config.org.enabled) continue;
      const { severity, cfg } = severityFor(check.id, defaultBranch, config);
      if (severity === 'off') continue;
      tasks.push({ check, branch: defaultBranch, severity, cfg: { ...cfg, org_name: config.org.name } });
    } else {
      const { severity, cfg } = severityFor(check.id, defaultBranch, config);
      if (severity === 'off') continue;
      tasks.push({ check, branch: defaultBranch, severity, cfg });
    }
  }

  // Run in parallel with a soft concurrency limit.
  const CONCURRENCY = 8;
  const results: FinishedCheck[] = new Array(tasks.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= tasks.length) return;
      const t = tasks[i];
      const ctx: CheckContext = {
        ...baseCtx,
        ...sharedExtras,
        branch: t.branch,
        config: t.cfg,
      };
      const started = Date.now();
      try {
        const result = await t.check.run(ctx);
        results[i] = {
          check: t.check,
          severity: t.severity,
          result,
          branch: t.check.category === 'branch' ? t.branch : undefined,
          durationMs: Date.now() - started,
        };
      } catch (err) {
        results[i] = {
          check: t.check,
          severity: t.severity,
          result: {
            status: 'skip',
            message: `Check threw: ${(err as Error).message}`,
          },
          branch: t.check.category === 'branch' ? t.branch : undefined,
          durationMs: Date.now() - started,
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker()));
  return results;
}
