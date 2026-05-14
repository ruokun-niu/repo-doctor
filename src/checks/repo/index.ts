import type { Check } from '../types';
import { isStatus, isForbiddenOrUnauthorized } from '../../lib/github';

const REPO_DOCS = 'https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features';

export const hasDescriptionCheck: Check = {
  id: 'repo.has-description',
  category: 'repo',
  description: 'Repository has a description set.',
  docsUrl: `${REPO_DOCS}/customizing-your-repository`,
  defaultSeverity: 'warn',
  async run(ctx) {
    const desc = ctx.repo?.description?.trim();
    if (desc) return { status: 'pass', message: `Description: "${desc}"` };
    return {
      status: 'fail',
      message: 'No repository description set.',
      remediation: 'Set a description: Settings → General → About → Description.',
    };
  },
};

export const hasTopicsCheck: Check = {
  id: 'repo.has-topics',
  category: 'repo',
  description: 'Repository has at least N topics.',
  docsUrl: 'https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics',
  defaultSeverity: 'warn',
  async run(ctx) {
    const min = Number(ctx.config.min ?? 1);
    const topics = ctx.repo?.topics ?? [];
    if (topics.length >= min) return { status: 'pass', message: `${topics.length} topic(s): ${topics.join(', ')}` };
    return {
      status: 'fail',
      message: `Has ${topics.length} topic(s), requires ${min}.`,
      remediation: 'Add topics via Settings → General → About → Topics.',
    };
  },
};

export const hasLicenseApiCheck: Check = {
  id: 'repo.has-license',
  category: 'repo',
  description: 'Repository license is detected by GitHub.',
  docsUrl: 'https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-a-license-to-a-repository',
  defaultSeverity: 'error',
  async run(ctx) {
    const license = ctx.repo?.license;
    if (license && license.spdx_id && license.spdx_id !== 'NOASSERTION') {
      return { status: 'pass', message: `License: ${license.spdx_id}` };
    }
    return {
      status: 'fail',
      message: 'GitHub did not detect a license for this repository.',
      remediation: 'Add a recognized LICENSE file at the repo root (see https://choosealicense.com).',
    };
  },
};

export const defaultBranchIsMainCheck: Check = {
  id: 'repo.default-branch-is-main',
  category: 'repo',
  description: 'Default branch matches the expected name.',
  docsUrl: `${REPO_DOCS}/managing-branches-in-your-repository/changing-the-default-branch`,
  defaultSeverity: 'warn',
  async run(ctx) {
    const expected = String(ctx.config.expected ?? 'main');
    const actual = ctx.repo?.default_branch ?? '';
    if (actual === expected) return { status: 'pass', message: `Default branch is "${actual}".` };
    return {
      status: 'fail',
      message: `Default branch is "${actual}", expected "${expected}".`,
      remediation: `Rename the default branch via Settings → Branches → Switch to "${expected}".`,
    };
  },
};

function expectedBoolCheck(opts: {
  id: string;
  description: string;
  field: string;
  fixHint: string;
}): Check {
  return {
    id: opts.id,
    category: 'repo',
    description: opts.description,
    docsUrl: `${REPO_DOCS}/configuring-pull-request-merges`,
    defaultSeverity: 'warn',
    async run(ctx) {
      const expected = Boolean(ctx.config.expected);
      const actual = (ctx.repo as unknown as Record<string, unknown>)?.[opts.field] as boolean | undefined;
      if (actual === undefined) {
        return { status: 'skip', message: `Field "${opts.field}" not available on repo response.` };
      }
      if (actual === expected) return { status: 'pass', message: `${opts.field} = ${actual}` };
      return {
        status: 'fail',
        message: `${opts.field} = ${actual}, expected ${expected}.`,
        remediation: opts.fixHint,
      };
    },
  };
}

export const allowMergeCommitCheck = expectedBoolCheck({
  id: 'repo.allow-merge-commit',
  description: 'Allow merge commits matches policy.',
  field: 'allow_merge_commit',
  fixHint: 'Settings → General → Pull Requests → "Allow merge commits".',
});

export const allowSquashMergeCheck = expectedBoolCheck({
  id: 'repo.allow-squash-merge',
  description: 'Allow squash merging matches policy.',
  field: 'allow_squash_merge',
  fixHint: 'Settings → General → Pull Requests → "Allow squash merging".',
});

export const allowRebaseMergeCheck = expectedBoolCheck({
  id: 'repo.allow-rebase-merge',
  description: 'Allow rebase merging matches policy.',
  field: 'allow_rebase_merge',
  fixHint: 'Settings → General → Pull Requests → "Allow rebase merging".',
});

export const vulnerabilityAlertsCheck: Check = {
  id: 'repo.vulnerability-alerts-enabled',
  category: 'repo',
  description: 'Vulnerability alerts (Dependabot alerts) are enabled.',
  docsUrl: 'https://docs.github.com/en/code-security/dependabot/dependabot-alerts/about-dependabot-alerts',
  defaultSeverity: 'warn',
  async run(ctx) {
    try {
      const res = await ctx.github.repoClient.rest.repos.checkVulnerabilityAlerts({ ...ctx.github.ref });
      const enabled = res.status === 204;
      const expected = Boolean(ctx.config.expected ?? true);
      if (enabled === expected) return { status: 'pass', message: `vulnerability-alerts = ${enabled}` };
      return {
        status: 'fail',
        message: `vulnerability-alerts = ${enabled}, expected ${expected}.`,
        remediation: 'Settings → Code security → Dependabot alerts.',
      };
    } catch (err) {
      if (isStatus(err, 404)) {
        return {
          status: 'fail',
          message: 'Vulnerability alerts are disabled.',
          remediation: 'Settings → Code security → Dependabot alerts → Enable.',
        };
      }
      if (isForbiddenOrUnauthorized(err)) {
        return { status: 'skip', message: 'Token lacks permission to read vulnerability alerts.' };
      }
      throw err;
    }
  },
};

function securityFeatureField(field: 'secret_scanning' | 'secret_scanning_push_protection' | 'dependabot_security_updates'): Check {
  const labels: Record<string, { id: string; desc: string; docs: string; fix: string }> = {
    secret_scanning: {
      id: 'repo.secret-scanning-enabled',
      desc: 'Secret scanning is enabled.',
      docs: 'https://docs.github.com/en/code-security/secret-scanning/about-secret-scanning',
      fix: 'Settings → Code security → Secret scanning → Enable.',
    },
    secret_scanning_push_protection: {
      id: 'repo.secret-scanning-push-protection-enabled',
      desc: 'Secret scanning push protection is enabled.',
      docs: 'https://docs.github.com/en/code-security/secret-scanning/push-protection-for-repositories-and-organizations',
      fix: 'Settings → Code security → Push protection → Enable.',
    },
    dependabot_security_updates: {
      id: 'repo.dependabot-security-updates-enabled',
      desc: 'Dependabot security updates are enabled.',
      docs: 'https://docs.github.com/en/code-security/dependabot/dependabot-security-updates/about-dependabot-security-updates',
      fix: 'Settings → Code security → Dependabot security updates → Enable.',
    },
  };
  const meta = labels[field];
  return {
    id: meta.id,
    category: 'repo',
    description: meta.desc,
    docsUrl: meta.docs,
    defaultSeverity: 'warn',
    async run(ctx) {
      const sa = (ctx.repo as unknown as { security_and_analysis?: Record<string, { status?: string } | null> } | null | undefined)?.security_and_analysis;
      if (!sa) {
        return { status: 'skip', message: 'security_and_analysis not visible (token may lack permission, or repo is public without advanced security).' };
      }
      const status = sa[field]?.status;
      if (status === undefined) {
        return { status: 'skip', message: `Field "${field}" not reported.` };
      }
      const enabled = status === 'enabled';
      const expected = Boolean(ctx.config.expected ?? true);
      if (enabled === expected) return { status: 'pass', message: `${field} = ${status}` };
      return {
        status: 'fail',
        message: `${field} = ${status}, expected ${expected ? 'enabled' : 'disabled'}.`,
        remediation: meta.fix,
      };
    },
  };
}

export const secretScanningCheck = securityFeatureField('secret_scanning');
export const secretScanningPushProtectionCheck = securityFeatureField('secret_scanning_push_protection');
export const dependabotSecurityUpdatesCheck = securityFeatureField('dependabot_security_updates');

export const repoChecks: Check[] = [
  hasDescriptionCheck,
  hasTopicsCheck,
  hasLicenseApiCheck,
  defaultBranchIsMainCheck,
  allowMergeCommitCheck,
  allowSquashMergeCheck,
  allowRebaseMergeCheck,
  vulnerabilityAlertsCheck,
  secretScanningCheck,
  secretScanningPushProtectionCheck,
  dependabotSecurityUpdatesCheck,
];
