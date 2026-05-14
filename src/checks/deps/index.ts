import * as yaml from 'js-yaml';
import type { Check } from '../types';

const DEPS_DOCS = 'https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference';

const DEPENDABOT_PATHS = ['.github/dependabot.yml', '.github/dependabot.yaml'];

async function readDependabot(ctx: Parameters<Check['run']>[0]): Promise<{ path: string; doc: unknown } | null> {
  for (const p of DEPENDABOT_PATHS) {
    const content = await ctx.github.getFile(p);
    if (content !== null) {
      try {
        return { path: p, doc: yaml.load(content) };
      } catch (err) {
        return { path: p, doc: { __parseError: (err as Error).message } };
      }
    }
  }
  return null;
}

export const dependabotConfigExistsCheck: Check = {
  id: 'deps.dependabot-config-exists',
  category: 'deps',
  description: 'Dependabot configuration file exists.',
  docsUrl: DEPS_DOCS,
  defaultSeverity: 'warn',
  async run(ctx) {
    const found = await readDependabot(ctx);
    if (!found) {
      return {
        status: 'fail',
        message: 'No .github/dependabot.yml found.',
        remediation: 'Add .github/dependabot.yml configuring Dependabot version updates.',
      };
    }
    const doc = found.doc as { __parseError?: string };
    if (doc.__parseError) {
      return {
        status: 'fail',
        message: `Failed to parse ${found.path}: ${doc.__parseError}`,
        remediation: 'Fix YAML syntax errors in your dependabot config.',
      };
    }
    return { status: 'pass', message: `Found ${found.path}` };
  },
};

export const dependabotCoversEcosystemsCheck: Check = {
  id: 'deps.dependabot-covers-ecosystems',
  category: 'deps',
  description: 'Dependabot config covers all detected ecosystems.',
  docsUrl: DEPS_DOCS,
  defaultSeverity: 'warn',
  async run(ctx) {
    if (ctx.ecosystems.size === 0) {
      return { status: 'pass', message: 'No ecosystems detected; nothing to cover.' };
    }
    const found = await readDependabot(ctx);
    if (!found) {
      return {
        status: 'fail',
        message: `No dependabot.yml found, but detected ecosystems: ${[...ctx.ecosystems].join(', ')}`,
        remediation: 'Add .github/dependabot.yml with a "package-ecosystem" entry for each detected ecosystem.',
      };
    }
    const doc = found.doc as { updates?: Array<{ 'package-ecosystem'?: string }> };
    const configured = new Set<string>(
      (doc.updates ?? [])
        .map((u) => u['package-ecosystem'])
        .filter((v): v is string => typeof v === 'string'),
    );
    const missing = [...ctx.ecosystems].filter((e) => !configured.has(e));
    if (missing.length === 0) {
      return {
        status: 'pass',
        message: `Dependabot covers all detected ecosystems: ${[...ctx.ecosystems].join(', ')}`,
      };
    }
    return {
      status: 'fail',
      message: `Detected ecosystems not covered by Dependabot: ${missing.join(', ')}`,
      remediation: `Add an "updates" entry with package-ecosystem set to: ${missing.join(', ')}`,
    };
  },
};

export const depsChecks: Check[] = [dependabotConfigExistsCheck, dependabotCoversEcosystemsCheck];
