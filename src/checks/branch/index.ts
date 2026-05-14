import type { Check } from '../types';
import { isStatus, isForbiddenOrUnauthorized } from '../../lib/github';

const BP_DOCS = 'https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches';
const RS_DOCS = 'https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets';

/**
 * Lazily-evaluated cache that fetches both classic branch protection and
 * applicable rulesets for the active branch exactly once per run.
 */
interface BranchProtectionState {
  classic: {
    enabled: boolean;
    requiredApprovingReviewCount?: number;
    dismissStaleReviews?: boolean;
    requiredStatusChecks?: string[];
    requiresPr?: boolean;
    requiresLinearHistory?: boolean;
    requiresSignedCommits?: boolean;
  } | null;
  rulesetRules: Array<{ type: string; parameters?: Record<string, unknown> }>;
  /** True if either classic protection exists OR at least one ruleset matches the branch. */
  anyProtection: boolean;
  /** Limited capability indicator (e.g., 401/403 on protections). */
  limited: boolean;
}

const CACHE_KEY = Symbol('repo-doctor.branch-state');

async function getBranchState(ctx: Parameters<Check['run']>[0]): Promise<BranchProtectionState> {
  const cache = (ctx as unknown as { [CACHE_KEY]?: Map<string, BranchProtectionState> });
  if (!cache[CACHE_KEY]) cache[CACHE_KEY] = new Map<string, BranchProtectionState>();
  const existing = cache[CACHE_KEY]!.get(ctx.branch);
  if (existing) return existing;

  let limited = false;
  let classic: BranchProtectionState['classic'] = null;
  try {
    const res = await ctx.github.repoClient.rest.repos.getBranchProtection({
      ...ctx.github.ref,
      branch: ctx.branch,
    });
    const d = res.data as unknown as {
      required_pull_request_reviews?: {
        required_approving_review_count?: number;
        dismiss_stale_reviews?: boolean;
      };
      required_status_checks?: { contexts?: string[]; checks?: Array<{ context: string }> };
      required_linear_history?: { enabled?: boolean };
      required_signatures?: { enabled?: boolean };
    };
    const prReviews = d.required_pull_request_reviews;
    const contexts =
      d.required_status_checks?.contexts ??
      d.required_status_checks?.checks?.map((c) => c.context) ??
      [];
    classic = {
      enabled: true,
      requiredApprovingReviewCount: prReviews?.required_approving_review_count,
      dismissStaleReviews: prReviews?.dismiss_stale_reviews,
      requiredStatusChecks: contexts,
      requiresPr: prReviews !== undefined,
      requiresLinearHistory: d.required_linear_history?.enabled,
      requiresSignedCommits: d.required_signatures?.enabled,
    };
  } catch (err) {
    if (isStatus(err, 404)) {
      classic = null;
    } else if (isForbiddenOrUnauthorized(err)) {
      limited = true;
    } else {
      throw err;
    }
  }

  let rulesetRules: Array<{ type: string; parameters?: Record<string, unknown> }> = [];
  try {
    const res = await ctx.github.repoClient.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
      owner: ctx.github.ref.owner,
      repo: ctx.github.ref.repo,
      branch: ctx.branch,
    });
    rulesetRules = (res.data as Array<{ type: string; parameters?: Record<string, unknown> }>) ?? [];
  } catch (err) {
    if (isForbiddenOrUnauthorized(err)) {
      limited = true;
    } else if (!isStatus(err, 404)) {
      // best-effort
    }
  }

  const state: BranchProtectionState = {
    classic,
    rulesetRules,
    anyProtection: !!classic || rulesetRules.length > 0,
    limited,
  };
  cache[CACHE_KEY]!.set(ctx.branch, state);
  return state;
}

function ruleParam<T = unknown>(rules: BranchProtectionState['rulesetRules'], type: string, key?: string): T | undefined {
  const rule = rules.find((r) => r.type === type);
  if (!rule) return undefined;
  if (!key) return rule as unknown as T;
  return rule.parameters?.[key] as T | undefined;
}

export const branchProtectedCheck: Check = {
  id: 'branch.protected',
  category: 'branch',
  description: 'Default branch is protected (classic protection or applicable ruleset).',
  docsUrl: BP_DOCS,
  defaultSeverity: 'error',
  async run(ctx) {
    const state = await getBranchState(ctx);
    if (state.limited && !state.anyProtection) {
      return { status: 'skip', message: 'Token lacks permission to read branch protection/rulesets (needs admin/maintain).' };
    }
    if (state.anyProtection) return { status: 'pass', message: `"${ctx.branch}" is protected.` };
    return {
      status: 'fail',
      message: `"${ctx.branch}" has no branch protection or applicable ruleset.`,
      remediation: 'Settings → Branches → Add branch protection rule, or Settings → Rules → New ruleset.',
    };
  },
};

export const requiresPrCheck: Check = {
  id: 'branch.requires-pr',
  category: 'branch',
  description: 'Direct pushes to the branch are blocked (PR required).',
  docsUrl: BP_DOCS,
  defaultSeverity: 'error',
  async run(ctx) {
    const state = await getBranchState(ctx);
    if (state.limited && !state.anyProtection) {
      return { status: 'skip', message: 'Token lacks permission to read branch protection/rulesets.' };
    }
    if (state.classic?.requiresPr) return { status: 'pass', message: 'PRs required (classic protection).' };
    if (ruleParam(state.rulesetRules, 'pull_request')) return { status: 'pass', message: 'PRs required (ruleset).' };
    return {
      status: 'fail',
      message: 'Direct pushes are not blocked.',
      remediation: 'Require pull requests before merging via branch protection or a ruleset.',
    };
  },
};

export const requiresReviewsCheck: Check = {
  id: 'branch.requires-reviews',
  category: 'branch',
  description: 'At least N approving reviews are required.',
  docsUrl: BP_DOCS,
  defaultSeverity: 'warn',
  async run(ctx) {
    const min = Number(ctx.config.min_approvals ?? 1);
    const state = await getBranchState(ctx);
    if (state.limited && !state.anyProtection) {
      return { status: 'skip', message: 'Token lacks permission to read branch protection/rulesets.' };
    }
    const classicN = state.classic?.requiredApprovingReviewCount ?? 0;
    const rsParams = ruleParam<Record<string, unknown>>(state.rulesetRules, 'pull_request');
    const rsN = Number(rsParams?.required_approving_review_count ?? 0);
    const actual = Math.max(classicN, rsN);
    if (actual >= min) return { status: 'pass', message: `${actual} approval(s) required (min ${min}).` };
    return {
      status: 'fail',
      message: `${actual} approval(s) required, expected ≥ ${min}.`,
      remediation: `Set "Required approving reviews" to at least ${min}.`,
    };
  },
};

export const requiresStatusChecksCheck: Check = {
  id: 'branch.requires-status-checks',
  category: 'branch',
  description: 'At least N required status checks configured.',
  docsUrl: BP_DOCS,
  defaultSeverity: 'warn',
  async run(ctx) {
    const min = Number(ctx.config.min_checks ?? 1);
    const state = await getBranchState(ctx);
    if (state.limited && !state.anyProtection) {
      return { status: 'skip', message: 'Token lacks permission to read branch protection/rulesets.' };
    }
    const classicChecks = state.classic?.requiredStatusChecks ?? [];
    const rsParams = ruleParam<Record<string, unknown>>(state.rulesetRules, 'required_status_checks');
    const rsChecks = Array.isArray(rsParams?.required_status_checks) ? (rsParams!.required_status_checks as unknown[]) : [];
    const total = classicChecks.length + rsChecks.length;
    if (total >= min) {
      const names = [...classicChecks, ...rsChecks.map((c) => (c as { context?: string }).context).filter(Boolean)].join(', ');
      return { status: 'pass', message: `${total} required check(s): ${names || '(unknown)'}` };
    }
    return {
      status: 'fail',
      message: `${total} required status check(s), expected ≥ ${min}.`,
      remediation: 'Configure required status checks under branch protection or a ruleset.',
    };
  },
};

export const requiresSignedCommitsCheck: Check = {
  id: 'branch.requires-signed-commits',
  category: 'branch',
  description: 'Signed commits are required.',
  docsUrl: BP_DOCS,
  defaultSeverity: 'off',
  async run(ctx) {
    const state = await getBranchState(ctx);
    if (state.limited && !state.anyProtection) {
      return { status: 'skip', message: 'Token lacks permission to read branch protection/rulesets.' };
    }
    if (state.classic?.requiresSignedCommits || ruleParam(state.rulesetRules, 'required_signatures')) {
      return { status: 'pass', message: 'Signed commits required.' };
    }
    return {
      status: 'fail',
      message: 'Signed commits are not required.',
      remediation: 'Enable "Require signed commits" in branch protection or a ruleset.',
    };
  },
};

export const requiresLinearHistoryCheck: Check = {
  id: 'branch.requires-linear-history',
  category: 'branch',
  description: 'Linear history is required.',
  docsUrl: BP_DOCS,
  defaultSeverity: 'off',
  async run(ctx) {
    const state = await getBranchState(ctx);
    if (state.limited && !state.anyProtection) {
      return { status: 'skip', message: 'Token lacks permission to read branch protection/rulesets.' };
    }
    if (state.classic?.requiresLinearHistory || ruleParam(state.rulesetRules, 'required_linear_history')) {
      return { status: 'pass', message: 'Linear history required.' };
    }
    return {
      status: 'fail',
      message: 'Linear history is not required.',
      remediation: 'Enable "Require linear history" in branch protection or a ruleset.',
    };
  },
};

export const dismissStaleReviewsCheck: Check = {
  id: 'branch.dismiss-stale-reviews',
  category: 'branch',
  description: 'Stale reviews are dismissed on new commits.',
  docsUrl: BP_DOCS,
  defaultSeverity: 'off',
  async run(ctx) {
    const state = await getBranchState(ctx);
    if (state.limited && !state.anyProtection) {
      return { status: 'skip', message: 'Token lacks permission to read branch protection/rulesets.' };
    }
    const classic = state.classic?.dismissStaleReviews ?? false;
    const rsParams = ruleParam<Record<string, unknown>>(state.rulesetRules, 'pull_request');
    const rs = Boolean(rsParams?.dismiss_stale_reviews_on_push);
    if (classic || rs) return { status: 'pass', message: 'Stale reviews are dismissed.' };
    return {
      status: 'fail',
      message: 'Stale reviews are not dismissed on new commits.',
      remediation: 'Enable "Dismiss stale pull request approvals when new commits are pushed".',
    };
  },
};

export const branchChecks: Check[] = [
  branchProtectedCheck,
  requiresPrCheck,
  requiresReviewsCheck,
  requiresStatusChecksCheck,
  requiresSignedCommitsCheck,
  requiresLinearHistoryCheck,
  dismissStaleReviewsCheck,
];

export { RS_DOCS };
