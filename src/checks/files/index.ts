import type { Check, CheckCategory } from '../types';

/**
 * Build a "file exists at one of these paths" check. We accept several
 * conventional locations (root, .github/, docs/) as GitHub itself does.
 *
 * If `inheritable` is true, when no file is found in the repo we also probe
 * the org-level defaults repo (`<owner>/.github` or `<owner>/.github-private`),
 * mirroring GitHub's own community-health-file inheritance. Users can opt out
 * per-check via `config.inherit_from_org: false`.
 */
function fileExistsCheck(opts: {
  id: string;
  description: string;
  docsUrl: string;
  paths: string[];
  remediation: string;
  inheritable?: boolean;
}): Check {
  return {
    id: opts.id,
    category: 'files' as CheckCategory,
    description: opts.description,
    docsUrl: opts.docsUrl,
    defaultSeverity: 'warn',
    async run(ctx) {
      const ref = ctx.github.ref;
      for (const p of opts.paths) {
        if (await ctx.github.fileExists(p)) {
          return { status: 'pass', message: `Found in repository: ${ref.owner}/${ref.repo} (${p}).` };
        }
      }

      if (opts.inheritable && ctx.config.inherit_from_org !== false) {
        const owner = ref.owner;
        const defaultsRepo = await ctx.github.findOrgDefaultsRepo(owner);
        if (defaultsRepo) {
          for (const p of opts.paths) {
            if (await ctx.github.fileExistsInRepo(owner, defaultsRepo, p)) {
              return {
                status: 'pass',
                message: `Found in organization defaults: ${owner}/${defaultsRepo} (${p}).`,
              };
            }
          }
        }
      }

      return {
        status: 'fail',
        message: `None of the expected files exist: ${opts.paths.join(', ')}`,
        remediation: opts.remediation,
      };
    },
  };
}

export const readmeCheck = fileExistsCheck({
  id: 'files.readme',
  description: 'Repository has a README.',
  docsUrl: 'https://docs.github.com/en/repositories/creating-and-managing-repositories/about-readmes',
  paths: ['README.md', 'README.rst', 'README.txt', 'README', 'docs/README.md', '.github/README.md'],
  remediation: 'Add a README.md at the repository root describing what the project is and how to use it.',
});

export const licenseFileCheck = fileExistsCheck({
  id: 'files.license',
  description: 'Repository has a LICENSE file.',
  docsUrl: 'https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-a-license-to-a-repository',
  paths: ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'COPYING.md'],
  remediation: 'Add a LICENSE file at the repo root (use https://choosealicense.com if unsure).',
});

export const codeOfConductCheck = fileExistsCheck({
  id: 'files.code-of-conduct',
  description: 'Repository has a CODE_OF_CONDUCT (or inherits one from the org).',
  docsUrl: 'https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-a-code-of-conduct-to-your-project',
  paths: ['CODE_OF_CONDUCT.md', '.github/CODE_OF_CONDUCT.md', 'docs/CODE_OF_CONDUCT.md'],
  remediation: 'Add CODE_OF_CONDUCT.md (or place one in the org-level .github repo to inherit). The Contributor Covenant template is a common choice.',
  inheritable: true,
});

export const contributingCheck = fileExistsCheck({
  id: 'files.contributing',
  description: 'Repository has CONTRIBUTING guidance (or inherits one from the org).',
  docsUrl: 'https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors',
  paths: ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md'],
  remediation: 'Add CONTRIBUTING.md describing how to file issues, submit PRs, and run tests (or place one in the org-level .github repo).',
  inheritable: true,
});

export const securityCheck = fileExistsCheck({
  id: 'files.security',
  description: 'Repository has a SECURITY policy (or inherits one from the org).',
  docsUrl: 'https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository',
  paths: ['SECURITY.md', '.github/SECURITY.md', 'docs/SECURITY.md'],
  remediation: 'Add SECURITY.md describing how to privately report vulnerabilities (or place one in the org-level .github repo).',
  inheritable: true,
});

export const supportCheck = fileExistsCheck({
  id: 'files.support',
  description: 'Repository has a SUPPORT file (or inherits one from the org).',
  docsUrl: 'https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-support-resources-to-your-project',
  paths: ['SUPPORT.md', '.github/SUPPORT.md', 'docs/SUPPORT.md'],
  remediation: 'Add SUPPORT.md to direct users to the right support channels (or place one in the org-level .github repo).',
  inheritable: true,
});

export const pullRequestTemplateCheck = fileExistsCheck({
  id: 'files.pull-request-template',
  description: 'Repository has a pull request template (or inherits one from the org).',
  docsUrl: 'https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository',
  paths: [
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/pull_request_template.md',
    'docs/PULL_REQUEST_TEMPLATE.md',
    'PULL_REQUEST_TEMPLATE.md',
  ],
  remediation: 'Add .github/PULL_REQUEST_TEMPLATE.md with a short PR checklist (or place one in the org-level .github repo).',
  inheritable: true,
});

export const codeownersCheck = fileExistsCheck({
  id: 'files.codeowners',
  description: 'Repository has a CODEOWNERS file.',
  docsUrl: 'https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners',
  paths: ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'],
  remediation: 'Add .github/CODEOWNERS to define default reviewers for parts of the codebase.',
});

export const issueTemplatesCheck: Check = {
  id: 'files.issue-templates',
  category: 'files',
  description: 'Repository has at least one issue template (or inherits one from the org).',
  docsUrl: 'https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/about-issue-and-pull-request-templates',
  defaultSeverity: 'warn',
  async run(ctx) {
    const ref = ctx.github.ref;
    // Either a directory of templates or a single legacy template file.
    const dir = await ctx.github.listDir('.github/ISSUE_TEMPLATE');
    if (dir && dir.some((e) => e.type === 'file' && /\.(md|yml|yaml)$/i.test(e.name))) {
      return {
        status: 'pass',
        message: `Found in repository: ${ref.owner}/${ref.repo} (.github/ISSUE_TEMPLATE/, ${dir.length} entries).`,
      };
    }
    const legacy = ['.github/ISSUE_TEMPLATE.md', 'ISSUE_TEMPLATE.md', 'docs/ISSUE_TEMPLATE.md'];
    for (const p of legacy) {
      if (await ctx.github.fileExists(p)) {
        return {
          status: 'pass',
          message: `Found in repository: ${ref.owner}/${ref.repo} (${p}).`,
        };
      }
    }

    if (ctx.config.inherit_from_org !== false) {
      const owner = ref.owner;
      const defaultsRepo = await ctx.github.findOrgDefaultsRepo(owner);
      if (defaultsRepo) {
        const orgDir = await ctx.github.listDirInRepo(owner, defaultsRepo, '.github/ISSUE_TEMPLATE');
        if (orgDir && orgDir.some((e) => e.type === 'file' && /\.(md|yml|yaml)$/i.test(e.name))) {
          return {
            status: 'pass',
            message: `Found in organization defaults: ${owner}/${defaultsRepo} (.github/ISSUE_TEMPLATE/, ${orgDir.length} entries).`,
          };
        }
        for (const p of legacy) {
          if (await ctx.github.fileExistsInRepo(owner, defaultsRepo, p)) {
            return {
              status: 'pass',
              message: `Found in organization defaults: ${owner}/${defaultsRepo} (${p}).`,
            };
          }
        }
      }
    }

    return {
      status: 'fail',
      message: 'No issue templates found.',
      remediation: 'Add one or more templates under .github/ISSUE_TEMPLATE/ (e.g., bug_report.yml, feature_request.yml), or place them in the org-level .github repo.',
    };
  },
};

export const filesChecks: Check[] = [
  readmeCheck,
  licenseFileCheck,
  codeOfConductCheck,
  contributingCheck,
  securityCheck,
  supportCheck,
  pullRequestTemplateCheck,
  codeownersCheck,
  issueTemplatesCheck,
];
