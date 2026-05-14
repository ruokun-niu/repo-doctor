import type { FinishedCheck } from '../checks/types';
import { groupByCategory, summarize } from './common';

const CATEGORY_LABELS: Record<string, string> = {
  repo: 'Repo configuration',
  branch: 'Branch protection',
  files: 'Files present',
  deps: 'Dependency management',
  workflows: 'Workflows / CI',
  org: 'Org-level',
};

export interface MarkdownReportOptions {
  repoSlug: string;
  version: string;
  configSource: string | null;
  preset: string;
}

export function renderMarkdown(results: FinishedCheck[], opts: MarkdownReportOptions): string {
  const lines: string[] = [];
  const s = summarize(results);

  lines.push(`## repo-doctor report — \`${opts.repoSlug}\``);
  lines.push('');
  lines.push(
    `**Summary:** ${s.passed} passed · ${s.failed} failed (${s.errors} error, ${s.warnings} warning)` +
      (s.skipped ? ` · ${s.skipped} skipped` : '') +
      `  \n_version_ ${opts.version} · _preset_ \`${opts.preset}\` · _config_ \`${opts.configSource ?? 'defaults'}\``,
  );
  lines.push('');

  const groups = groupByCategory(results);
  for (const [cat, items] of groups) {
    const active = items.filter((r) => r.severity !== 'off');
    if (active.length === 0) continue;
    lines.push(`### ${CATEGORY_LABELS[cat] ?? cat}`);
    lines.push('');
    lines.push('| | Check | Severity | Status | Message |');
    lines.push('|---|---|---|---|---|');
    for (const r of active) {
      const glyph =
        r.result.status === 'pass' ? '✅' : r.result.status === 'skip' ? '⏭️' : r.severity === 'error' ? '❌' : '⚠️';
      const msg = (r.result.message ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| ${glyph} | \`${r.check.id}\` | ${r.severity} | ${r.result.status} | ${msg} |`);
    }
    lines.push('');
    const failed = active.filter((r) => r.result.status === 'fail' && r.result.remediation);
    if (failed.length > 0) {
      lines.push('<details><summary>Remediation guidance</summary>');
      lines.push('');
      for (const r of failed) {
        lines.push(`- **\`${r.check.id}\`** — ${r.result.remediation}  \n  ${r.check.docsUrl}`);
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  return lines.join('\n');
}
