import { codeOfConductCheck, securityCheck, issueTemplatesCheck } from '../src/checks/files';
import type { CheckContext } from '../src/checks/types';

interface FakeRepoState {
  /** Map of "owner/repo:path" → exists (file). */
  files: Set<string>;
  /** Map of "owner/repo:path" → array of dir entries. */
  dirs: Map<string, Array<{ name: string; type: string; path: string }>>;
  /** Owners that have a `.github` defaults repo. */
  defaultsRepoByOwner: Map<string, string | null>;
}

function makeCtx(state: FakeRepoState, config: Record<string, unknown> = {}): CheckContext {
  const ref = { owner: 'acme', repo: 'widget' };
  const key = (o: string, r: string, p: string) => `${o}/${r}:${p}`;

  const fileExists = async (path: string) => state.files.has(key(ref.owner, ref.repo, path));
  const fileExistsInRepo = async (owner: string, repo: string, path: string) =>
    state.files.has(key(owner, repo, path));
  const listDir = async (path: string) => state.dirs.get(key(ref.owner, ref.repo, path)) ?? null;
  const listDirInRepo = async (owner: string, repo: string, path: string) =>
    state.dirs.get(key(owner, repo, path)) ?? null;
  const findOrgDefaultsRepo = async (owner: string) =>
    state.defaultsRepoByOwner.get(owner) ?? null;

  const github = {
    ref,
    fileExists,
    fileExistsInRepo,
    listDir,
    listDirInRepo,
    findOrgDefaultsRepo,
  } as unknown as CheckContext['github'];

  return {
    github,
    repo: null,
    defaultBranch: 'main',
    branch: 'main',
    config,
    ecosystems: new Set(),
    ignoreFiles: [],
  };
}

function emptyState(): FakeRepoState {
  return { files: new Set(), dirs: new Map(), defaultsRepoByOwner: new Map() };
}

describe('files checks: org-level inheritance', () => {
  test('code-of-conduct passes when present in the repo', async () => {
    const state = emptyState();
    state.files.add('acme/widget:CODE_OF_CONDUCT.md');
    const r = await codeOfConductCheck.run(makeCtx(state));
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/Found in repository: acme\/widget \(CODE_OF_CONDUCT\.md\)/);
  });

  test('code-of-conduct is inherited from acme/.github when missing in repo', async () => {
    const state = emptyState();
    state.defaultsRepoByOwner.set('acme', '.github');
    state.files.add('acme/.github:CODE_OF_CONDUCT.md');
    const r = await codeOfConductCheck.run(makeCtx(state));
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/Found in organization defaults: acme\/\.github/);
  });

  test('code-of-conduct fails when not in repo and no defaults repo exists', async () => {
    const state = emptyState();
    const r = await codeOfConductCheck.run(makeCtx(state));
    expect(r.status).toBe('fail');
  });

  test('code-of-conduct fails when defaults repo exists but does not contain the file', async () => {
    const state = emptyState();
    state.defaultsRepoByOwner.set('acme', '.github');
    const r = await codeOfConductCheck.run(makeCtx(state));
    expect(r.status).toBe('fail');
  });

  test('inheritance can be disabled via config.inherit_from_org=false', async () => {
    const state = emptyState();
    state.defaultsRepoByOwner.set('acme', '.github');
    state.files.add('acme/.github:CODE_OF_CONDUCT.md');
    const r = await codeOfConductCheck.run(makeCtx(state, { inherit_from_org: false }));
    expect(r.status).toBe('fail');
  });

  test('security inherits too', async () => {
    const state = emptyState();
    state.defaultsRepoByOwner.set('acme', '.github');
    state.files.add('acme/.github:SECURITY.md');
    const r = await securityCheck.run(makeCtx(state));
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/Found in organization defaults: acme\/\.github/);
  });

  test('issue templates: inherits a directory of templates from org defaults', async () => {
    const state = emptyState();
    state.defaultsRepoByOwner.set('acme', '.github');
    state.dirs.set('acme/.github:.github/ISSUE_TEMPLATE', [
      { name: 'bug_report.yml', type: 'file', path: '.github/ISSUE_TEMPLATE/bug_report.yml' },
    ]);
    const r = await issueTemplatesCheck.run(makeCtx(state));
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/Found in organization defaults: acme\/\.github/);
  });

  test('issue templates: fails when neither repo nor org defaults has any', async () => {
    const state = emptyState();
    state.defaultsRepoByOwner.set('acme', '.github');
    const r = await issueTemplatesCheck.run(makeCtx(state));
    expect(r.status).toBe('fail');
  });
});
