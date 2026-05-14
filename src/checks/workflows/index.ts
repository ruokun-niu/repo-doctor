import * as yaml from 'js-yaml';
import type { Check } from '../types';

const WF_DOCS = 'https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions';

interface WorkflowFile {
  path: string;
  content: string;
  doc: unknown;
}

async function listWorkflows(ctx: Parameters<Check['run']>[0]): Promise<WorkflowFile[]> {
  const entries = await ctx.github.listDir('.github/workflows');
  if (!entries) return [];
  const files = entries.filter((e) => e.type === 'file' && /\.ya?ml$/i.test(e.name));
  const out: WorkflowFile[] = [];
  await Promise.all(
    files.map(async (f) => {
      const content = await ctx.github.getFile(f.path);
      if (content == null) return;
      let doc: unknown;
      try {
        doc = yaml.load(content);
      } catch {
        doc = null;
      }
      out.push({ path: f.path, content, doc });
    }),
  );
  return out;
}

// `uses: owner/repo@<sha>` is pinned; `uses: owner/repo@v1` is not.
const USES_RE = /uses:\s*([^\s#]+)/g;

export const actionsPinnedToShaCheck: Check = {
  id: 'workflows.actions-pinned-to-sha',
  category: 'workflows',
  description: 'Third-party actions are pinned to a full commit SHA.',
  docsUrl: WF_DOCS + '#using-third-party-actions',
  defaultSeverity: 'warn',
  async run(ctx) {
    const wfs = await listWorkflows(ctx);
    if (wfs.length === 0) return { status: 'skip', message: 'No workflows found.' };
    const unpinned: string[] = [];
    for (const wf of wfs) {
      let m: RegExpExecArray | null;
      USES_RE.lastIndex = 0;
      while ((m = USES_RE.exec(wf.content))) {
        const ref = m[1].trim();
        // Skip local actions (./...) and docker:// references.
        if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
        const at = ref.lastIndexOf('@');
        if (at < 0) continue;
        const owner = ref.slice(0, at).split('/')[0];
        // Skip GitHub's own actions (actions/* and github/*) — common policy carve-out.
        if (owner === 'actions' || owner === 'github') continue;
        const version = ref.slice(at + 1);
        if (!/^[0-9a-f]{40}$/i.test(version)) {
          unpinned.push(`${wf.path}: ${ref}`);
        }
      }
    }
    if (unpinned.length === 0) return { status: 'pass', message: 'All third-party actions are pinned by SHA.' };
    return {
      status: 'fail',
      message: `${unpinned.length} third-party action reference(s) not pinned by SHA.`,
      remediation: 'Pin actions to full 40-character commit SHAs (e.g., `uses: org/action@<sha>  # v1.2.3`).',
      details: { unpinned: unpinned.slice(0, 20) },
    };
  },
};

export const permissionsDeclaredCheck: Check = {
  id: 'workflows.permissions-declared',
  category: 'workflows',
  description: 'Every workflow declares a top-level `permissions:` block.',
  docsUrl: WF_DOCS + '#setting-permissions-for-the-github_token',
  defaultSeverity: 'warn',
  async run(ctx) {
    const wfs = await listWorkflows(ctx);
    if (wfs.length === 0) return { status: 'skip', message: 'No workflows found.' };
    const missing: string[] = [];
    for (const wf of wfs) {
      const doc = wf.doc as { permissions?: unknown; jobs?: Record<string, { permissions?: unknown }> } | null;
      if (!doc) continue;
      const topLevel = doc.permissions !== undefined;
      // Accept a workflow that scopes permissions per-job for every job.
      const jobs = doc.jobs ?? {};
      const allJobsHave = Object.values(jobs).every((j) => j && (j as { permissions?: unknown }).permissions !== undefined);
      if (!topLevel && !(Object.keys(jobs).length > 0 && allJobsHave)) missing.push(wf.path);
    }
    if (missing.length === 0) return { status: 'pass', message: 'All workflows declare permissions.' };
    return {
      status: 'fail',
      message: `${missing.length} workflow(s) missing permissions: ${missing.join(', ')}`,
      remediation: 'Add `permissions:` at the workflow or job level (start with `contents: read`).',
    };
  },
};

export const hasCodeqlCheck: Check = {
  id: 'workflows.has-codeql',
  category: 'workflows',
  description: 'A CodeQL workflow is configured.',
  docsUrl: 'https://docs.github.com/en/code-security/code-scanning/automatically-scanning-your-code-for-vulnerabilities-and-errors/configuring-code-scanning',
  defaultSeverity: 'off',
  async run(ctx) {
    const wfs = await listWorkflows(ctx);
    const hasCodeQL = wfs.some((wf) => /github\/codeql-action/.test(wf.content));
    if (hasCodeQL) return { status: 'pass', message: 'CodeQL workflow detected.' };
    return {
      status: 'fail',
      message: 'No CodeQL workflow found.',
      remediation: 'Enable code scanning via Security → Code scanning, or add a workflow using github/codeql-action.',
    };
  },
};

export const workflowChecks: Check[] = [actionsPinnedToShaCheck, permissionsDeclaredCheck, hasCodeqlCheck];
