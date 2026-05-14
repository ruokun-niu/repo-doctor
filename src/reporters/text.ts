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

export interface TextReportOptions {
  repoSlug: string;
  version: string;
  configSource: string | null;
  preset: string;
  color?: boolean;
}

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
};

export function renderText(results: FinishedCheck[], opts: TextReportOptions): string {
  const useColor = opts.color ?? false;
  const c = (code: string, s: string) => (useColor ? `${code}${s}${ANSI.reset}` : s);

  const lines: string[] = [];
  lines.push(c(ANSI.bold, `repo-doctor v${opts.version}`) + `  —  ${opts.repoSlug}`);
  lines.push(
    c(
      ANSI.dim,
      `preset: ${opts.preset}  config: ${opts.configSource ?? '(none — using defaults)'}`,
    ),
  );
  lines.push('');

  const groups = groupByCategory(results);
  for (const [cat, items] of groups) {
    // Don't render categories where every check is off.
    const active = items.filter((r) => r.severity !== 'off');
    if (active.length === 0) continue;

    const passed = active.filter((r) => r.result.status === 'pass').length;
    const total = active.filter((r) => r.result.status !== 'skip').length;
    const skipped = active.length - total;
    const allOk = passed === total;
    const head = `${allOk ? c(ANSI.green, '✓') : c(ANSI.red, '✗')} ${c(ANSI.bold, CATEGORY_LABELS[cat] ?? cat)}`;
    const stats = total === 0
      ? c(ANSI.dim, `(${skipped} skipped)`)
      : c(ANSI.dim, `(${passed}/${total}${skipped ? `, ${skipped} skipped` : ''})`);
    lines.push(`${head.padEnd(48)} ${stats}`);

    for (const r of active) {
      if (r.result.status === 'pass') continue;
      const sevColor = r.severity === 'error' ? ANSI.red : r.severity === 'warn' ? ANSI.yellow : ANSI.gray;
      const sevTag = c(sevColor, `[${r.severity}]`);
      const statusGlyph = r.result.status === 'skip' ? c(ANSI.gray, '○') : c(ANSI.red, '✗');
      lines.push(`  ${statusGlyph} ${c(ANSI.cyan, r.check.id.padEnd(48))} ${sevTag}`);
      lines.push(`      ${r.result.message}`);
      if (r.result.status === 'fail' && r.result.remediation) {
        lines.push(c(ANSI.dim, `      Fix: ${r.result.remediation}`));
      }
    }
    lines.push('');
  }

  const s = summarize(results);
  const summary = `Summary: ${s.passed} passed, ${s.failed} failed (${s.errors} error, ${s.warnings} warning)${
    s.skipped ? `, ${s.skipped} skipped` : ''
  }`;
  lines.push(c(ANSI.bold, summary));
  return lines.join('\n');
}
