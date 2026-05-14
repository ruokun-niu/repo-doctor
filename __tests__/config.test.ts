import { resolveConfig } from '../src/config/loader';
import { applyPreset } from '../src/config/presets';
import { loadConfig } from '../src/config/loader';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('config resolution', () => {
  test('default preset is standard', () => {
    const r = resolveConfig(null);
    expect(r.preset).toBe('standard');
    expect(r.checks['files.readme'].severity).toBe('error');
    expect(r.checks['workflows.actions-pinned-to-sha'].severity).toBe('off');
  });

  test('strict preset bumps severities', () => {
    const r = resolveConfig({ version: 1, preset: 'strict' });
    expect(r.checks['branch.requires-reviews'].severity).toBe('error');
    expect(r.checks['branch.requires-reviews'].config.min_approvals).toBe(2);
    expect(r.checks['workflows.actions-pinned-to-sha'].severity).toBe('error');
  });

  test('per-check overrides win over preset', () => {
    const r = resolveConfig({
      version: 1,
      preset: 'standard',
      checks: {
        'files.security': { severity: 'off' },
        'branch.requires-reviews': { config: { min_approvals: 3 } },
      },
    });
    expect(r.checks['files.security'].severity).toBe('off');
    expect(r.checks['branch.requires-reviews'].config.min_approvals).toBe(3);
  });

  test('unknown check id throws', () => {
    expect(() =>
      resolveConfig({ version: 1, checks: { 'not.a.check': { severity: 'error' } } }),
    ).toThrow(/Unknown check id/);
  });

  test('preset off disables everything', () => {
    const defs = applyPreset('off');
    for (const id of Object.keys(defs)) {
      expect(defs[id].severity).toBe('off');
    }
  });
});

describe('config file loading', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-doctor-cfg-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('loads YAML config from default location', () => {
    fs.mkdirSync(path.join(tmpDir, '.github'));
    fs.writeFileSync(
      path.join(tmpDir, '.github', 'repo-doctor.yml'),
      'version: 1\npreset: strict\n',
    );
    const { config, sourcePath } = loadConfig({ cwd: tmpDir });
    expect(sourcePath).toBe('.github/repo-doctor.yml');
    expect(config.preset).toBe('strict');
  });

  test('loads YAML config from explicit path', () => {
    const p = path.join(tmpDir, 'custom.yaml');
    fs.writeFileSync(p, 'preset: minimal\n');
    const { config, sourcePath } = loadConfig({ cwd: tmpDir, explicitPath: 'custom.yaml' });
    expect(sourcePath).toBe('custom.yaml');
    expect(config.preset).toBe('minimal');
  });

  test('rejects unsupported file extensions', () => {
    const p = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(p, 'preset = "minimal"\n');
    expect(() => loadConfig({ cwd: tmpDir, explicitPath: 'config.toml' })).toThrow(
      /Unsupported config file extension/,
    );
  });
});
