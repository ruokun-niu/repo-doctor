import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';

import { loadConfig } from './config/loader';
import { GitHubClient } from './lib/github';
import { detectEcosystems } from './lib/ecosystem-detect';
import { runChecks } from './runner';
import { renderText } from './reporters/text';
import { renderMarkdown } from './reporters/markdown';
import { renderJson } from './reporters/json';
import { summarize } from './reporters/common';

const VERSION = '0.1.0';

type FailOn = 'error' | 'warn' | 'never';

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
      throw new Error(
        'No token available. Set the `github-token` input or pass GITHUB_TOKEN via `env:` on the step.',
      );
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

    const { owner, repo } = github.context.repo;
    const repoSlug = `${owner}/${repo}`;
    core.info(`repo-doctor v${VERSION} — auditing ${repoSlug}`);

    // 1. Load config
    const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
    const { config, sourcePath } = loadConfig({ cwd, explicitPath: configInput, presetInput });
    core.info(`preset=${config.preset} config=${sourcePath ?? '(defaults)'}`);

    // 2. GitHub client + repo facts
    const gh = new GitHubClient(repoToken, { owner, repo }, orgToken);
    const repoData = await gh.tryGetRepo();
    if (!repoData) throw new Error(`Repository ${repoSlug} not accessible with provided token.`);
    const defaultBranch = repoData.default_branch ?? 'main';

    // 3. Ecosystem detection (shallow; used by deps checks)
    const ecosystems = await detectEcosystems(gh);
    if (ecosystems.size > 0) core.info(`detected ecosystems: ${[...ecosystems].join(', ')}`);

    // 4. Run checks
    const results = await runChecks({
      github: gh,
      config,
      ecosystems,
      defaultBranch,
      repo: repoData,
    });
    const s = summarize(results);

    // 5. Render reports
    const reportMeta = {
      repoSlug,
      version: VERSION,
      configSource: sourcePath,
      preset: config.preset,
    };
    const textReport = renderText(results, { ...reportMeta, color: false });
    const markdownReport = renderMarkdown(results, reportMeta);
    const jsonReport = renderJson(results, reportMeta);

    if (formats.has('text')) {
      core.info('\n' + textReport);
    }
    if (formats.has('markdown') && process.env.GITHUB_STEP_SUMMARY) {
      try {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdownReport + '\n');
      } catch (err) {
        core.warning(`Failed to write step summary: ${(err as Error).message}`);
      }
    }

    let reportPath = '';
    if (outputPath) {
      const ext = path.extname(outputPath).toLowerCase();
      const body = ext === '.md' ? markdownReport : ext === '.json' ? jsonReport : textReport;
      fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      fs.writeFileSync(outputPath, body);
      reportPath = outputPath;
      core.info(`Wrote report to ${outputPath}`);
    }

    // 6. Outputs
    core.setOutput('passed', String(s.passed));
    core.setOutput('failed', String(s.failed));
    core.setOutput('warnings', String(s.warnings));
    core.setOutput('errors', String(s.errors));
    core.setOutput('report-path', reportPath);

    // 7. Exit decision
    const shouldFail =
      (failOn === 'error' && s.errors > 0) ||
      (failOn === 'warn' && (s.errors > 0 || s.warnings > 0));
    if (shouldFail) {
      core.setFailed(
        `repo-doctor: ${s.errors} error(s), ${s.warnings} warning(s). See report for details.`,
      );
    } else if (s.failed > 0) {
      core.warning(
        `repo-doctor: ${s.failed} check(s) failed but fail-on=${failOn} — not failing the job.`,
      );
    }
  } catch (err) {
    core.setFailed((err as Error).message ?? String(err));
  }
}

run();
