import type { FinishedCheck } from '../checks/types';
import { summarize } from './common';

export interface JsonReportOptions {
  repoSlug: string;
  version: string;
  configSource: string | null;
  preset: string;
}

export function renderJson(results: FinishedCheck[], opts: JsonReportOptions): string {
  const s = summarize(results);
  const payload = {
    tool: 'repo-doctor',
    version: opts.version,
    repo: opts.repoSlug,
    preset: opts.preset,
    configSource: opts.configSource,
    summary: s,
    results: results.map((r) => ({
      id: r.check.id,
      category: r.check.category,
      severity: r.severity,
      status: r.result.status,
      message: r.result.message,
      remediation: r.result.remediation,
      docsUrl: r.check.docsUrl,
      branch: r.branch,
      durationMs: r.durationMs,
      details: r.result.details,
    })),
  };
  return JSON.stringify(payload, null, 2);
}
