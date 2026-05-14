import type { Preset, Severity } from './schema';

/**
 * Per-check default severity. Presets enable/disable subsets of these.
 */
export const ALL_CHECK_DEFAULTS: Record<string, { severity: Severity; config?: Record<string, unknown> }> = {
  // --- Repo configuration ---
  'repo.has-description': { severity: 'warn' },
  'repo.has-topics': { severity: 'warn', config: { min: 1 } },
  'repo.has-license': { severity: 'error' },
  'repo.default-branch-is-main': { severity: 'warn', config: { expected: 'main' } },
  'repo.allow-merge-commit': { severity: 'off', config: { expected: true } },
  'repo.allow-squash-merge': { severity: 'off', config: { expected: true } },
  'repo.allow-rebase-merge': { severity: 'off', config: { expected: true } },
  'repo.vulnerability-alerts-enabled': { severity: 'warn', config: { expected: true } },
  'repo.secret-scanning-enabled': { severity: 'warn', config: { expected: true } },
  'repo.secret-scanning-push-protection-enabled': { severity: 'warn', config: { expected: true } },
  'repo.dependabot-security-updates-enabled': { severity: 'warn', config: { expected: true } },

  // --- Branch protection / rulesets (apply to default branch unless overridden) ---
  'branch.protected': { severity: 'error' },
  'branch.requires-pr': { severity: 'error' },
  'branch.requires-reviews': { severity: 'warn', config: { min_approvals: 1 } },
  'branch.requires-status-checks': { severity: 'warn', config: { min_checks: 1 } },
  'branch.requires-signed-commits': { severity: 'off' },
  'branch.requires-linear-history': { severity: 'off' },
  'branch.dismiss-stale-reviews': { severity: 'off' },

  // --- Files present ---
  'files.readme': { severity: 'error' },
  'files.license': { severity: 'error' },
  'files.code-of-conduct': { severity: 'warn' },
  'files.contributing': { severity: 'warn' },
  'files.security': { severity: 'warn' },
  'files.support': { severity: 'off' },
  'files.pull-request-template': { severity: 'warn' },
  'files.issue-templates': { severity: 'warn' },
  'files.codeowners': { severity: 'warn' },

  // --- Dependencies ---
  'deps.dependabot-config-exists': { severity: 'warn' },
  'deps.dependabot-covers-ecosystems': { severity: 'warn' },

  // --- Workflows ---
  'workflows.actions-pinned-to-sha': { severity: 'warn' },
  'workflows.permissions-declared': { severity: 'warn' },
  'workflows.has-codeql': { severity: 'off' },

  // --- Org ---
  'org.two-factor-required': { severity: 'warn' },
  'org.default-repo-permission': { severity: 'warn', config: { expected: 'read' } },
  'org.rulesets-defined': { severity: 'off' },
  'org.member-privileges': { severity: 'off' },
};

const MINIMAL_ENABLED = new Set([
  'files.readme',
  'files.license',
  'repo.has-license',
  'branch.protected',
]);

const STANDARD_ENABLED = new Set([
  // repo
  'repo.has-license',
  'repo.vulnerability-alerts-enabled',
  'repo.secret-scanning-enabled',
  'repo.secret-scanning-push-protection-enabled',
  'repo.dependabot-security-updates-enabled',
  // branch
  'branch.protected',
  'branch.requires-pr',
  'branch.requires-reviews',
  'branch.requires-status-checks',
  // files
  'files.readme',
  'files.license',
  'files.code-of-conduct',
  'files.contributing',
  'files.security',
  'files.pull-request-template',
  'files.issue-templates',
  'files.codeowners',
  // deps
  'deps.dependabot-config-exists',
  'deps.dependabot-covers-ecosystems',
]);

const STRICT_ADDITIONS = new Set([
  'branch.requires-signed-commits',
  'branch.requires-linear-history',
  'branch.dismiss-stale-reviews',
  'workflows.actions-pinned-to-sha',
  'workflows.permissions-declared',
  'workflows.has-codeql',
  'repo.allow-merge-commit',
  'repo.allow-squash-merge',
]);

/**
 * Returns the per-check defaults after applying the chosen preset.
 * Checks not enabled by the preset get severity 'off'.
 */
export function applyPreset(preset: Preset): Record<string, { severity: Severity; config?: Record<string, unknown> }> {
  const out: Record<string, { severity: Severity; config?: Record<string, unknown> }> = {};
  for (const [id, def] of Object.entries(ALL_CHECK_DEFAULTS)) {
    out[id] = { severity: def.severity, config: def.config ? { ...def.config } : undefined };
  }

  if (preset === 'off') {
    for (const id of Object.keys(out)) out[id].severity = 'off';
    return out;
  }
  if (preset === 'minimal') {
    for (const id of Object.keys(out)) {
      if (!MINIMAL_ENABLED.has(id)) out[id].severity = 'off';
    }
    return out;
  }
  if (preset === 'standard') {
    for (const id of Object.keys(out)) {
      if (!STANDARD_ENABLED.has(id)) out[id].severity = 'off';
    }
    return out;
  }
  // strict: standard + strict additions; bump some severities up.
  const enabled = new Set([...STANDARD_ENABLED, ...STRICT_ADDITIONS]);
  for (const id of Object.keys(out)) {
    if (!enabled.has(id)) out[id].severity = 'off';
  }
  // strict bumps
  if (out['branch.requires-reviews']) {
    out['branch.requires-reviews'].severity = 'error';
    out['branch.requires-reviews'].config = { ...(out['branch.requires-reviews'].config ?? {}), min_approvals: 2 };
  }
  if (out['branch.requires-status-checks']) out['branch.requires-status-checks'].severity = 'error';
  if (out['workflows.actions-pinned-to-sha']) out['workflows.actions-pinned-to-sha'].severity = 'error';
  if (out['workflows.permissions-declared']) out['workflows.permissions-declared'].severity = 'error';
  return out;
}

export const DEFAULT_PRESET: Preset = 'standard';
