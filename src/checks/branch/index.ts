import type { Check } from '../types';
import { isStatus, isForbiddenOrUnauthorized } from '../../lib/github';

const BP_DOCS = 'https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches';
const RS_DOCS = 'https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets';

/**
 * A single rule from a ruleset, annotated with where it came from so we can
 * surface that in check messages (e.g., "PRs required (org ruleset 'baseline')").
 */
interface AnnotatedRule {
  type: string;
  parameters?: Record<string, unknown>;
  /** Human-readable source description, e.g. "ruleset" or "org ruleset 'baseline'". */
  source?: string;
}

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
    source?: string;
  } | null;
  rulesetRules: AnnotatedRule[];
  /** True if either classic protection exists OR at least one ruleset matches the branch. */
  anyProtection: boolean;
  /** Limited capability indicator (e.g., 401/403 on protections). */
  limited: boolean;
}

const CACHE_KEY = Symbol('repo-doctor.branch-state');

/**
 * Decide whether a ruleset's `conditions.ref_name` include patterns match a
 * given branch. We support the documented special values plus simple glob
 * patterns (`*`, `?`).
 */
function refNameMatches(includes: string[], excludes: string[], branch: string, defaultBranch: string): boolean {
  const ref = `refs/heads/${branch}`;
  const matchOne = (pattern: string): boolean => {
    if (pattern === '~ALL') return true;
    if (pattern === '~DEFAULT_BRANCH') return branch === defaultBranch;
    if (pattern === ref) return true;
    if (pattern === branch) return true;
    // Glob support: treat * and ? as wildcards, otherwise literal.
    if (/[*?]/.test(pattern)) {
      const rx = new RegExp(
        '^' +
          pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') +
          '$',
      );
      return rx.test(ref) || rx.test(branch);
    }
    return false;
  };
  if (excludes.some(matchOne)) return false;
  return includes.some(matchOne);
}

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
      source: 'classic branch protection',
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

  // Primary source: effective rules for this branch. This already merges in
  // org-level rulesets — but it hides rules whose ruleset lists the caller
  // as a bypass actor. We fall back to enumerating rulesets below.
  const rulesetRules: AnnotatedRule[] = [];
  try {
    const res = await ctx.github.repoClient.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
      owner: ctx.github.ref.owner,
      repo: ctx.github.ref.repo,
      branch: ctx.branch,
    });
    const rules = (res.data as Array<{
      type: string;
      parameters?: Record<string, unknown>;
      ruleset_source_type?: string;
      ruleset_source?: string;
    }>) ?? [];
    for (const r of rules) {
      let source = 'ruleset';
      if (r.ruleset_source_type === 'Organization') {
        source = r.ruleset_source ? `org ruleset '${r.ruleset_source}'` : 'org ruleset';
      } else if (r.ruleset_source_type === 'Repository') {
        source = r.ruleset_source ? `repo ruleset '${r.ruleset_source}'` : 'repo ruleset';
      }
      rulesetRules.push({ type: r.type, parameters: r.parameters, source });
    }
  } catch (err) {
    if (isForbiddenOrUnauthorized(err)) {
      limited = true;
    } else if (!isStatus(err, 404)) {
      // best-effort
    }
  }

  // Fallback: enumerate repo + parent (org) rulesets directly. Catches the
  // common case where the caller is listed as a bypass actor and the
  // rules/branches endpoint omits the rule.
  try {
    const list = await ctx.github.repoClient.request('GET /repos/{owner}/{repo}/rulesets', {
      owner: ctx.github.ref.owner,
      repo: ctx.github.ref.repo,
      includes_parents: true,
      per_page: 100,
    });
    const summaries = (list.data as Array<{
      id: number;
      name?: string;
      enforcement?: string;
      source_type?: string;
      source?: string;
      target?: string;
    }>) ?? [];
    for (const rs of summaries) {
      if (rs.enforcement !== 'active') continue;
      if (rs.target && rs.target !== 'branch') continue;
      let detail: {
        conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
        rules?: Array<{ type: string; parameters?: Record<string, unknown> }>;
      };
      try {
        let r;
        if (rs.source_type === 'Organization' && rs.source) {
          r = await ctx.github.repoClient.request('GET /orgs/{org}/rulesets/{ruleset_id}', {
            org: rs.source,
            ruleset_id: rs.id,
          });
        } else {
          r = await ctx.github.repoClient.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
            owner: ctx.github.ref.owner,
            repo: ctx.github.ref.repo,
            ruleset_id: rs.id,
          });
        }
        detail = r.data as typeof detail;
      } catch (err) {
        if (isForbiddenOrUnauthorized(err)) {
          limited = true;
        }
        continue;
      }
      const includes = detail.conditions?.ref_name?.include ?? [];
      const excludes = detail.conditions?.ref_name?.exclude ?? [];
      if (!refNameMatches(includes, excludes, ctx.branch, ctx.defaultBranch)) continue;

      const sourceLabel =
        rs.source_type === 'Organization'
          ? `org ruleset '${rs.name ?? rs.source ?? rs.id}'`
          : `repo ruleset '${rs.name ?? rs.id}'`;
      for (const rule of detail.rules ?? []) {
        // Dedupe: skip if we already have a rule of this type from rules/branches.
        if (rulesetRules.some((r) => r.type === rule.type)) continue;
        rulesetRules.push({ type: rule.type, parameters: rule.parameters, source: sourceLabel });
      }
    }
  } catch (err) {
    if (isForbiddenOrUnauthorized(err)) {
      limited = true;
    }
    // best-effort; missing this fallback shouldn't break the run.
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

function findRule(rules: AnnotatedRule[], type: string): AnnotatedRule | undefined {
  return rules.find((r) => r.type === type);
}

function ruleParam<T = unknown>(rules: AnnotatedRule[], type: string, key?: string): T | undefined {
  const rule = findRule(rules, type);
  if (!rule) return undefined;
  if (!key) return rule as unknown as T;
  return rule.parameters?.[key] as T | undefined;
}

function distinctSources(state: BranchProtectionState): string {
  const sources = new Set<string>();
  if (state.classic?.source) sources.add(state.classic.source);
  for (const r of state.rulesetRules) {
    if (r.source) sources.add(r.source);
  }
  return Array.from(sources).join(', ');
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
    if (state.anyProtection) {
      const src = distinctSources(state);
      return {
        status: 'pass',
        message: `"${ctx.branch}" is protected${src ? ` (${src})` : ''}.`,
      };
    }
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
    const rule = findRule(state.rulesetRules, 'pull_request');
    if (rule) return { status: 'pass', message: `PRs required (${rule.source ?? 'ruleset'}).` };
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
    const rsRule = findRule(state.rulesetRules, 'pull_request');
    const rsN = Number((rsRule?.parameters as Record<string, unknown> | undefined)?.required_approving_review_count ?? 0);
    const actual = Math.max(classicN, rsN);
    const source = classicN >= rsN ? state.classic?.source ?? 'classic protection' : rsRule?.source ?? 'ruleset';
    if (actual >= min) return { status: 'pass', message: `${actual} approval(s) required (min ${min}, via ${source}).` };
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
    const rsRule = findRule(state.rulesetRules, 'required_status_checks');
    const rsParams = rsRule?.parameters as Record<string, unknown> | undefined;
    const rsChecks = Array.isArray(rsParams?.required_status_checks) ? (rsParams!.required_status_checks as unknown[]) : [];
    const total = classicChecks.length + rsChecks.length;
    if (total >= min) {
      const names = [...classicChecks, ...rsChecks.map((c) => (c as { context?: string }).context).filter(Boolean)].join(', ');
      const src = rsRule?.source ?? state.classic?.source ?? 'ruleset';
      return { status: 'pass', message: `${total} required check(s) via ${src}: ${names || '(unknown)'}` };
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
    if (state.classic?.requiresSignedCommits) {
      return { status: 'pass', message: `Signed commits required (${state.classic.source ?? 'classic protection'}).` };
    }
    const rule = findRule(state.rulesetRules, 'required_signatures');
    if (rule) return { status: 'pass', message: `Signed commits required (${rule.source ?? 'ruleset'}).` };
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
    if (state.classic?.requiresLinearHistory) {
      return { status: 'pass', message: `Linear history required (${state.classic.source ?? 'classic protection'}).` };
    }
    const rule = findRule(state.rulesetRules, 'required_linear_history');
    if (rule) return { status: 'pass', message: `Linear history required (${rule.source ?? 'ruleset'}).` };
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
    const rsRule = findRule(state.rulesetRules, 'pull_request');
    const rs = Boolean((rsRule?.parameters as Record<string, unknown> | undefined)?.dismiss_stale_reviews_on_push);
    if (classic) {
      return { status: 'pass', message: `Stale reviews are dismissed (${state.classic?.source ?? 'classic protection'}).` };
    }
    if (rs) {
      return { status: 'pass', message: `Stale reviews are dismissed (${rsRule?.source ?? 'ruleset'}).` };
    }
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

export { RS_DOCS, refNameMatches };
