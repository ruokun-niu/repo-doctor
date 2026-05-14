import type { Check } from '../types';
import { isForbiddenOrUnauthorized } from '../../lib/github';

const ORG_DOCS = 'https://docs.github.com/en/organizations';

interface OrgState {
  data?: {
    two_factor_requirement_enabled?: boolean;
    default_repository_permission?: string;
    members_can_create_repositories?: boolean;
    members_can_fork_private_repositories?: boolean;
  };
  fetched: boolean;
  limited: boolean;
}

const CACHE = Symbol('repo-doctor.org-state');

async function getOrg(ctx: Parameters<Check['run']>[0]): Promise<OrgState> {
  const cache = ctx as unknown as { [CACHE]?: OrgState };
  if (cache[CACHE]) return cache[CACHE]!;
  const client = ctx.github.orgClient ?? ctx.github.repoClient;
  const orgName = (ctx.config.org_name as string | undefined) ?? ctx.github.ref.owner;
  try {
    const res = await client.rest.orgs.get({ org: orgName });
    cache[CACHE] = { data: res.data as OrgState['data'], fetched: true, limited: false };
  } catch (err) {
    cache[CACHE] = { fetched: true, limited: isForbiddenOrUnauthorized(err) };
  }
  return cache[CACHE]!;
}

export const twoFactorRequiredCheck: Check = {
  id: 'org.two-factor-required',
  category: 'org',
  description: 'Organization requires two-factor authentication for members.',
  docsUrl: `${ORG_DOCS}/keeping-your-organization-secure/managing-two-factor-authentication-for-your-organization/requiring-two-factor-authentication-in-your-organization`,
  defaultSeverity: 'warn',
  async run(ctx) {
    const state = await getOrg(ctx);
    if (state.limited || state.data === undefined) {
      return { status: 'skip', message: 'Token lacks permission to read org settings (needs admin:org read).' };
    }
    if (state.data.two_factor_requirement_enabled) {
      return { status: 'pass', message: '2FA is required for members.' };
    }
    return {
      status: 'fail',
      message: '2FA is not required for org members.',
      remediation: 'Org → Settings → Authentication security → Require two-factor authentication.',
    };
  },
};

export const defaultRepoPermissionCheck: Check = {
  id: 'org.default-repo-permission',
  category: 'org',
  description: 'Org default repository permission matches policy.',
  docsUrl: `${ORG_DOCS}/managing-organization-settings/setting-base-permissions-for-an-organization`,
  defaultSeverity: 'warn',
  async run(ctx) {
    const expected = String(ctx.config.expected ?? 'read');
    const state = await getOrg(ctx);
    if (state.limited || state.data === undefined) {
      return { status: 'skip', message: 'Token lacks permission to read org settings.' };
    }
    const actual = state.data.default_repository_permission ?? 'unknown';
    if (actual === expected) return { status: 'pass', message: `default_repository_permission = ${actual}` };
    return {
      status: 'fail',
      message: `default_repository_permission = ${actual}, expected ${expected}.`,
      remediation: 'Org → Settings → Member privileges → Base permissions.',
    };
  },
};

export const orgRulesetsDefinedCheck: Check = {
  id: 'org.rulesets-defined',
  category: 'org',
  description: 'Org-level rulesets exist that target this repository.',
  docsUrl: 'https://docs.github.com/en/organizations/managing-organization-settings/managing-rulesets-for-repositories-in-your-organization',
  defaultSeverity: 'off',
  async run(ctx) {
    const client = ctx.github.orgClient ?? ctx.github.repoClient;
    const orgName = ctx.github.ref.owner;
    try {
      const res = await client.request('GET /orgs/{org}/rulesets', { org: orgName });
      const rulesets = (res.data as unknown[]) ?? [];
      if (rulesets.length > 0) return { status: 'pass', message: `${rulesets.length} org ruleset(s) defined.` };
      return {
        status: 'fail',
        message: 'No org-level rulesets defined.',
        remediation: 'Org → Settings → Repository → Rulesets → New ruleset.',
      };
    } catch (err) {
      if (isForbiddenOrUnauthorized(err)) {
        return { status: 'skip', message: 'Token lacks permission to read org rulesets.' };
      }
      throw err;
    }
  },
};

export const memberPrivilegesCheck: Check = {
  id: 'org.member-privileges',
  category: 'org',
  description: 'Org member privileges (repo creation, forking) match policy.',
  docsUrl: `${ORG_DOCS}/managing-organization-settings/restricting-repository-creation-in-your-organization`,
  defaultSeverity: 'off',
  async run(ctx) {
    const state = await getOrg(ctx);
    if (state.limited || state.data === undefined) {
      return { status: 'skip', message: 'Token lacks permission to read org settings.' };
    }
    const expectedCreate = ctx.config.members_can_create_repositories !== undefined
      ? Boolean(ctx.config.members_can_create_repositories)
      : false;
    const expectedFork = ctx.config.members_can_fork_private_repositories !== undefined
      ? Boolean(ctx.config.members_can_fork_private_repositories)
      : false;
    const issues: string[] = [];
    if (state.data.members_can_create_repositories !== undefined && state.data.members_can_create_repositories !== expectedCreate) {
      issues.push(`members_can_create_repositories=${state.data.members_can_create_repositories} (expected ${expectedCreate})`);
    }
    if (state.data.members_can_fork_private_repositories !== undefined && state.data.members_can_fork_private_repositories !== expectedFork) {
      issues.push(`members_can_fork_private_repositories=${state.data.members_can_fork_private_repositories} (expected ${expectedFork})`);
    }
    if (issues.length === 0) return { status: 'pass', message: 'Member privileges match policy.' };
    return {
      status: 'fail',
      message: issues.join('; '),
      remediation: 'Org → Settings → Member privileges.',
    };
  },
};

export const orgChecks: Check[] = [
  twoFactorRequiredCheck,
  defaultRepoPermissionCheck,
  orgRulesetsDefinedCheck,
  memberPrivilegesCheck,
];
