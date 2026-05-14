import type { FinishedCheck } from '../checks/types';
import { groupByCategory, summarize, type ReportSummary } from './common';

const CATEGORY_LABELS: Record<string, string> = {
  repo: 'Repo configuration',
  branch: 'Branch protection',
  files: 'Files present',
  deps: 'Dependency management',
  workflows: 'Workflows / CI',
  org: 'Org-level',
};

export interface RepoSection {
  repoSlug: string;
  results: FinishedCheck[];
  summary: ReportSummary;
  error?: string;
}

export interface OrgMarkdownOptions {
  org: string;
  version: string;
  configSource: string | null;
  preset: string;
  repos: RepoSection[];
}

/** Build a single markdown document covering many repos at once. */
export function renderOrgMarkdown(opts: OrgMarkdownOptions): string {
  const lines: string[] = [];
  const totals: ReportSummary = { passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0, offCount: 0 };
  for (const r of opts.repos) {
    totals.passed += r.summary.passed;
    totals.failed += r.summary.failed;
    totals.warnings += r.summary.warnings;
    totals.errors += r.summary.errors;
    totals.skipped += r.summary.skipped;
  }
  const erroredRepos = opts.repos.filter((r) => r.error).length;

  lines.push(`# repo-doctor org report — \`${opts.org}\``);
  lines.push('');
  lines.push(
    `**Totals across ${opts.repos.length} repo(s):** ${totals.passed} passed · ${totals.failed} failed (${totals.errors} error, ${totals.warnings} warning)` +
      (totals.skipped ? ` · ${totals.skipped} skipped` : '') +
      (erroredRepos ? ` · ${erroredRepos} repo(s) errored` : '') +
      `  \n_version_ ${opts.version} · _preset_ \`${opts.preset}\` · _config_ \`${opts.configSource ?? 'defaults'}\``,
  );
  lines.push('');

  // Per-repo summary table
  lines.push('## Per-repo summary');
  lines.push('');
  lines.push('| Repo | Errors | Warnings | Passed | Skipped |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const r of opts.repos) {
    if (r.error) {
      lines.push(`| \`${r.repoSlug}\` | _error: ${r.error}_ |  |  |  |`);
      continue;
    }
    const indicator = r.summary.errors > 0 ? '❌' : r.summary.warnings > 0 ? '⚠️' : '✅';
    lines.push(
      `| ${indicator} \`${r.repoSlug}\` | ${r.summary.errors} | ${r.summary.warnings} | ${r.summary.passed} | ${r.summary.skipped} |`,
    );
  }
  lines.push('');

  // Per-repo details (collapsed) — only show repos with failures.
  for (const r of opts.repos) {
    if (r.error) continue;
    if (r.summary.failed === 0) continue;
    lines.push(`<details><summary><b>${r.repoSlug}</b> — ${r.summary.errors} error, ${r.summary.warnings} warning</summary>`);
    lines.push('');
    const groups = groupByCategory(r.results);
    for (const [cat, items] of groups) {
      const failing = items.filter((it) => it.severity !== 'off' && it.result.status === 'fail');
      if (failing.length === 0) continue;
      lines.push(`#### ${CATEGORY_LABELS[cat] ?? cat}`);
      lines.push('');
      for (const f of failing) {
        const glyph = f.severity === 'error' ? '❌' : '⚠️';
        const msg = (f.result.message ?? '').replace(/\|/g, '\\|');
        lines.push(`- ${glyph} \`${f.check.id}\` _(${f.severity})_ — ${msg}`);
        if (f.result.remediation) {
          lines.push(`  - Fix: ${f.result.remediation}`);
        }
      }
      lines.push('');
    }
    lines.push('</details>');
    lines.push('');
  }
  return lines.join('\n');
}

export function totalsFromRepos(repos: RepoSection[]): ReportSummary {
  const totals: ReportSummary = { passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0, offCount: 0 };
  for (const r of repos) {
    if (r.error) continue;
    totals.passed += r.summary.passed;
    totals.failed += r.summary.failed;
    totals.warnings += r.summary.warnings;
    totals.errors += r.summary.errors;
    totals.skipped += r.summary.skipped;
  }
  return totals;
}

// re-export to keep the import surface tidy
export { summarize };
