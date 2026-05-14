import { resolveConfig } from '../src/config/loader';
import { applyPreset } from '../src/config/presets';

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
