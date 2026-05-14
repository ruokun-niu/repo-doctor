import type { Check } from './types';
import { filesChecks } from './files';
import { repoChecks } from './repo';
import { branchChecks } from './branch';
import { depsChecks } from './deps';
import { workflowChecks } from './workflows';
import { orgChecks } from './org';

export const ALL_CHECKS: Check[] = [
  ...repoChecks,
  ...branchChecks,
  ...filesChecks,
  ...depsChecks,
  ...workflowChecks,
  ...orgChecks,
];

export function getCheckById(id: string): Check | undefined {
  return ALL_CHECKS.find((c) => c.id === id);
}
