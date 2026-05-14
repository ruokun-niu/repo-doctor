import type { FinishedCheck } from '../checks/types';

export interface ReportSummary {
  passed: number;
  failed: number;
  warnings: number;
  errors: number;
  skipped: number;
  offCount: number;
}

export function summarize(results: FinishedCheck[]): ReportSummary {
  let passed = 0,
    failed = 0,
    warnings = 0,
    errors = 0,
    skipped = 0,
    offCount = 0;
  for (const r of results) {
    if (r.severity === 'off') {
      offCount++;
      continue;
    }
    if (r.result.status === 'skip') {
      skipped++;
      continue;
    }
    if (r.result.status === 'pass') {
      passed++;
      continue;
    }
    failed++;
    if (r.severity === 'error') errors++;
    else if (r.severity === 'warn') warnings++;
  }
  return { passed, failed, warnings, errors, skipped, offCount };
}

export function groupByCategory(results: FinishedCheck[]): Map<string, FinishedCheck[]> {
  const map = new Map<string, FinishedCheck[]>();
  for (const r of results) {
    const key = r.check.category;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  return map;
}
