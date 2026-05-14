import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';

import { loadConfig } from './config/loader';
import { GitHubClient, listOrgRepos, type OrgRepoSummary } from './lib/github';
import { detectEcosystems } from './lib/ecosystem-detect';
import { runChecks } from './runner';
import { renderText } from './reporters/text';
import { renderMarkdown } from './reporters/markdown';
import { renderJson } from './reporters/json';
import { summarize } from './reporters/common';
import { renderOrgMarkdown, totalsFromRepos, type RepoSection } from './reporters/org-markdown';
import type { ResolvedConfig } from './config/schema';
import type { FinishedCheck } from './checks/types';

const VERSION = '0.2.0';

type FailOn = 'error' | 'warn' | 'never';
type Target = 'repo' | 'org' | 'list';

async function auditOneRepo(
  repoToken: string,
  orgToken: string | undefined,
  owner: string,
  repo: string,
  config: ResolvedConfig,
): Promise<{ results: FinishedCheck[]; ecosystems: Set<string> } | { error: string }> {
  const gh = new GitHubClient(repoToken, { owner, repo }, orgToken);
  const repoData = await gh.tryGetRepo();
  if (!repoData) return { error: 'Not accessible with provided token' };
  const defaultBranch = repoData.default_branch ?? 'main';
  const ecosystems = await detectEcosystems(gh);
  const results = await runChecks({
    github: gh,
    config,
    ecosystems,
    defaultBranch,
    repo: repoData,
  });
  return { results, ecosystems };
}

async function run(): Promise<void> {
  try {
    const configInput = core.getInput('config') || undefined;
    const presetInput = core.getInput('preset') || undefined;
    const failOn = (core.getInput('fail-on') || 'error').toLowerCase() as FailOn;
    if (!['error', 'warn', 'never'].includes(failOn)) {
      throw new Error(`Invalid fail-on value: ${failOn}`);
    }
    const repoToken = core.getInput('github-token') || process.env.GITHUB_TOKEN;
    if (!repoToken) {
      throw new Error('No token available. Set the `github-token` input or pass GITHUB_TOKEN via `env:` on the step.');
    }
    const orgToken = core.getInput('org-token') || undefined;
    const formatInput = core.getInput('format') || 'text,markdown';
    const formats = new Set(
      formatInput
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    const outputPath = core.getInput('output') || undefined;

    const targetInput = (core.getInput('target') || '').toLowerCase();
    const reposInput = core.getInput('repos') || '';
    let target: Target;
    if (targetInput) {
      if (!['repo', 'org', 'list'].includes(targetInput)) {
        throw new Error(`Invalid target value: ${targetInput} (expected "repo", "org", or "list")`);
      }
      target = targetInput as Target;
    } else {
      // Default: if `repos` was provided, treat as a list; otherwise audit current repo.
      target = reposInput.trim() ? 'list' : 'repo';
    }
    const orgInput = core.getInput('org') || undefined;
    const includeArchived = (core.getInput('include-archived') || 'false').toLowerCase() === 'true';
    const repoFilter = core.getInput('repo-filter') || undefined;
    const maxRepos = Number(core.getInput('max-repos') || '200');

    const explicitRepos = parseRepoList(reposInput);
    if (target === 'list' && explicitRepos.length === 0) {
      throw new Error('target=list requires the "repos" input (whitespace- or comma-separated "owner/name" entries).');
    }

    const { owner, repo } = github.context.repo;

    const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
    const { config, sourcePath } = loadConfig({ cwd, explicitPath: configInput, presetInput });
    core.info(`repo-doctor v${VERSION}  preset=${config.preset} config=${sourcePath ?? '(defaults)'}`);

    if (target === 'repo') {
      await runSingleRepo({
        owner,
        repo,
        repoToken,
        orgToken,
        config,
        sourcePath,
        formats,
        outputPath,
        failOn,
      });
    } else if (target === 'org') {
      await runOrg({
        org: orgInput ?? owner,
        repoToken,
        orgToken,
        config,
        sourcePath,
        formats,
        outputPath,
        failOn,
        includeArchived,
        repoFilter,
        maxRepos,
      });
    } else {
      // target === 'list'
      await runRepoList({
        label: orgInput ?? owner,
        repos: explicitRepos,
        repoToken,
        orgToken,
        config,
        sourcePath,
        formats,
        outputPath,
        failOn,
        maxRepos,
      });
    }
  } catch (err) {
    core.setFailed((err as Error).message ?? String(err));
  }
}

interface SingleArgs {
  owner: string;
  repo: string;
  repoToken: string;
  orgToken?: string;
  config: ResolvedConfig;
  sourcePath: string | null;
  formats: Set<string>;
  outputPath?: string;
  failOn: FailOn;
}

async function runSingleRepo(args: SingleArgs): Promise<void> {
  const repoSlug = `${args.owner}/${args.repo}`;
  core.info(`auditing ${repoSlug}`);
  const audit = await auditOneRepo(args.repoToken, args.orgToken, args.owner, args.repo, args.config);
  if ('error' in audit) throw new Error(`Repository ${repoSlug} not accessible: ${audit.error}`);
  if (audit.ecosystems.size > 0) core.info(`detected ecosystems: ${[...audit.ecosystems].join(', ')}`);
  const { results } = audit;
  const s = summarize(results);

  const reportMeta = {
    repoSlug,
    version: VERSION,
    configSource: args.sourcePath,
    preset: args.config.preset,
  };
  const textReport = renderText(results, { ...reportMeta, color: false });
  const markdownReport = renderMarkdown(results, reportMeta);
  const jsonReport = renderJson(results, reportMeta);

  if (args.formats.has('text')) core.info('\n' + textReport);
  writeStepSummary(markdownReport, args.formats);
  const reportPath = writeOutput(args.outputPath, { textReport, markdownReport, jsonReport });
  setOutputs(s, reportPath);
  decideExit(args.failOn, s.errors, s.warnings, s.failed);
}

interface OrgArgs {
  org: string;
  repoToken: string;
  orgToken?: string;
  config: ResolvedConfig;
  sourcePath: string | null;
  formats: Set<string>;
  outputPath?: string;
  failOn: FailOn;
  includeArchived: boolean;
  repoFilter?: string;
  maxRepos: number;
}

async function runOrg(args: OrgArgs): Promise<void> {
  core.info(`target=org org=${args.org} include-archived=${args.includeArchived}`);
  let repos: OrgRepoSummary[];
  try {
    repos = await listOrgRepos(args.repoToken, args.org, {
      orgToken: args.orgToken,
      includeArchived: args.includeArchived,
    });
  } catch (err) {
    throw new Error(`Failed to list repos for org "${args.org}": ${(err as Error).message}`);
  }

  if (args.repoFilter) {
    const re = new RegExp(args.repoFilter);
    repos = repos.filter((r) => re.test(r.name));
  }
  if (repos.length === 0) {
    core.warning(`No repos to audit in org "${args.org}" (after filters).`);
  }
  if (repos.length > args.maxRepos) {
    core.warning(`Org has ${repos.length} repos; truncating to max-repos=${args.maxRepos}.`);
    repos = repos.slice(0, args.maxRepos);
  }
  core.info(`auditing ${repos.length} repo(s) in ${args.org}`);

  const CONCURRENCY = 4;
  const sections: RepoSection[] = [];
  let i = 0;
  async function worker() {
    while (i < repos.length) {
      const idx = i++;
      const r = repos[idx];
      core.info(`  [${idx + 1}/${repos.length}] ${r.full_name}`);
      const [orgOwner, orgRepo] = r.full_name.split('/');
      const audit = await auditOneRepo(args.repoToken, args.orgToken, orgOwner, orgRepo, args.config);
      if ('error' in audit) {
        sections.push({
          repoSlug: r.full_name,
          results: [],
          summary: { passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0, offCount: 0 },
          error: audit.error,
        });
        continue;
      }
      sections.push({
        repoSlug: r.full_name,
        results: audit.results,
        summary: summarize(audit.results),
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, repos.length || 1) }, () => worker()));

  sections.sort((a, b) => {
    if (b.summary.errors !== a.summary.errors) return b.summary.errors - a.summary.errors;
    if (b.summary.warnings !== a.summary.warnings) return b.summary.warnings - a.summary.warnings;
    return a.repoSlug.localeCompare(b.repoSlug);
  });

  const totals = totalsFromRepos(sections);
  const markdownReport = renderOrgMarkdown({
    org: args.org,
    version: VERSION,
    configSource: args.sourcePath,
    preset: args.config.preset,
    repos: sections,
  });
  const textReport = [
    `repo-doctor v${VERSION} — org audit of ${args.org}`,
    `preset=${args.config.preset} config=${args.sourcePath ?? '(defaults)'}  repos=${sections.length}`,
    '',
    ...sections.map((sec) => {
      if (sec.error) return `  - ${sec.repoSlug}  ERROR: ${sec.error}`;
      return `  - ${sec.repoSlug.padEnd(50)} ${sec.summary.errors}E ${sec.summary.warnings}W ${sec.summary.passed}P ${sec.summary.skipped}S`;
    }),
    '',
    `Totals: ${totals.passed} passed, ${totals.failed} failed (${totals.errors} error, ${totals.warnings} warning), ${totals.skipped} skipped`,
  ].join('\n');
  const jsonReport = JSON.stringify(
    {
      tool: 'repo-doctor',
      version: VERSION,
      target: 'org',
      org: args.org,
      preset: args.config.preset,
      configSource: args.sourcePath,
      totals,
      repos: sections.map((sec) => ({
        repo: sec.repoSlug,
        summary: sec.summary,
        error: sec.error,
        results: sec.results.map((r) => ({
          id: r.check.id,
          category: r.check.category,
          severity: r.severity,
          status: r.result.status,
          message: r.result.message,
          remediation: r.result.remediation,
        })),
      })),
    },
    null,
    2,
  );

  if (args.formats.has('text')) core.info('\n' + textReport);
  writeStepSummary(markdownReport, args.formats);
  const reportPath = writeOutput(args.outputPath, { textReport, markdownReport, jsonReport });
  setOutputs(totals, reportPath);
  decideExit(args.failOn, totals.errors, totals.warnings, totals.failed);
}

interface ListArgs {
  label: string; // shown in the report header (typically the org/owner)
  repos: Array<{ owner: string; name: string }>;
  repoToken: string;
  orgToken?: string;
  config: ResolvedConfig;
  sourcePath: string | null;
  formats: Set<string>;
  outputPath?: string;
  failOn: FailOn;
  maxRepos: number;
}

async function runRepoList(args: ListArgs): Promise<void> {
  let repos = args.repos;
  if (repos.length > args.maxRepos) {
    core.warning(`Got ${repos.length} repos; truncating to max-repos=${args.maxRepos}.`);
    repos = repos.slice(0, args.maxRepos);
  }
  core.info(`target=list  auditing ${repos.length} repo(s): ${repos.map((r) => `${r.owner}/${r.name}`).join(', ')}`);

  const CONCURRENCY = 4;
  const sections: RepoSection[] = [];
  let i = 0;
  async function worker() {
    while (i < repos.length) {
      const idx = i++;
      const r = repos[idx];
      const slug = `${r.owner}/${r.name}`;
      core.info(`  [${idx + 1}/${repos.length}] ${slug}`);
      const audit = await auditOneRepo(args.repoToken, args.orgToken, r.owner, r.name, args.config);
      if ('error' in audit) {
        sections.push({
          repoSlug: slug,
          results: [],
          summary: { passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0, offCount: 0 },
          error: audit.error,
        });
        continue;
      }
      sections.push({ repoSlug: slug, results: audit.results, summary: summarize(audit.results) });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, repos.length || 1) }, () => worker()));

  sections.sort((a, b) => {
    if (b.summary.errors !== a.summary.errors) return b.summary.errors - a.summary.errors;
    if (b.summary.warnings !== a.summary.warnings) return b.summary.warnings - a.summary.warnings;
    return a.repoSlug.localeCompare(b.repoSlug);
  });

  const totals = totalsFromRepos(sections);
  const markdownReport = renderOrgMarkdown({
    org: args.label,
    version: VERSION,
    configSource: args.sourcePath,
    preset: args.config.preset,
    repos: sections,
  });
  const textReport = [
    `repo-doctor v${VERSION} — list audit (${sections.length} repo${sections.length === 1 ? '' : 's'})`,
    `preset=${args.config.preset} config=${args.sourcePath ?? '(defaults)'}`,
    '',
    ...sections.map((sec) =>
      sec.error
        ? `  - ${sec.repoSlug}  ERROR: ${sec.error}`
        : `  - ${sec.repoSlug.padEnd(50)} ${sec.summary.errors}E ${sec.summary.warnings}W ${sec.summary.passed}P ${sec.summary.skipped}S`,
    ),
    '',
    `Totals: ${totals.passed} passed, ${totals.failed} failed (${totals.errors} error, ${totals.warnings} warning), ${totals.skipped} skipped`,
  ].join('\n');
  const jsonReport = JSON.stringify(
    {
      tool: 'repo-doctor',
      version: VERSION,
      target: 'list',
      preset: args.config.preset,
      configSource: args.sourcePath,
      totals,
      repos: sections.map((sec) => ({
        repo: sec.repoSlug,
        summary: sec.summary,
        error: sec.error,
        results: sec.results.map((r) => ({
          id: r.check.id,
          category: r.check.category,
          severity: r.severity,
          status: r.result.status,
          message: r.result.message,
          remediation: r.result.remediation,
        })),
      })),
    },
    null,
    2,
  );

  if (args.formats.has('text')) core.info('\n' + textReport);
  writeStepSummary(markdownReport, args.formats);
  const reportPath = writeOutput(args.outputPath, { textReport, markdownReport, jsonReport });
  setOutputs(totals, reportPath);
  decideExit(args.failOn, totals.errors, totals.warnings, totals.failed);
}

/** Accepts whitespace- or comma-separated "owner/name" entries. */
function parseRepoList(raw: string): Array<{ owner: string; name: string }> {
  if (!raw.trim()) return [];
  const tokens = raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const out: Array<{ owner: string; name: string }> = [];
  for (const tok of tokens) {
    const m = tok.match(/^([A-Za-z0-9_.\-]+)\/([A-Za-z0-9_.\-]+)$/);
    if (!m) throw new Error(`Invalid repo entry: "${tok}" (expected "owner/name").`);
    out.push({ owner: m[1], name: m[2] });
  }
  return out;
}

function writeStepSummary(markdown: string, formats: Set<string>): void {  if (!formats.has('markdown')) return;
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  try {
    fs.appendFileSync(summaryFile, markdown + '\n');
  } catch (err) {
    core.warning(`Failed to write step summary: ${(err as Error).message}`);
  }
}

function writeOutput(
  outputPath: string | undefined,
  bodies: { textReport: string; markdownReport: string; jsonReport: string },
): string {
  if (!outputPath) return '';
  const ext = path.extname(outputPath).toLowerCase();
  const body = ext === '.md' ? bodies.markdownReport : ext === '.json' ? bodies.jsonReport : bodies.textReport;
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, body);
  core.info(`Wrote report to ${outputPath}`);
  return outputPath;
}

function setOutputs(
  s: { passed: number; failed: number; warnings: number; errors: number },
  reportPath: string,
): void {
  core.setOutput('passed', String(s.passed));
  core.setOutput('failed', String(s.failed));
  core.setOutput('warnings', String(s.warnings));
  core.setOutput('errors', String(s.errors));
  core.setOutput('report-path', reportPath);
}

function decideExit(failOn: FailOn, errors: number, warnings: number, failed: number): void {
  const shouldFail = (failOn === 'error' && errors > 0) || (failOn === 'warn' && (errors > 0 || warnings > 0));
  if (shouldFail) {
    core.setFailed(`repo-doctor: ${errors} error(s), ${warnings} warning(s). See report for details.`);
  } else if (failed > 0) {
    core.warning(`repo-doctor: ${failed} check(s) failed but fail-on=${failOn} — not failing the job.`);
  }
}

run();
