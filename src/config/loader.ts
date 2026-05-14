import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { configSchema, type RepoDoctorConfig, type ResolvedCheckConfig, type ResolvedConfig } from './schema';
import { ALL_CHECK_DEFAULTS, applyPreset, DEFAULT_PRESET } from './presets';

const CANDIDATE_PATHS = [
  '.github/repo-doctor.yml',
  '.github/repo-doctor.yaml',
  '.repo-doctor.yml',
  '.repo-doctor.yaml',
];

export interface LoadOptions {
  /** Working directory to resolve relative paths against. */
  cwd: string;
  /** Explicit config path from the action input. */
  explicitPath?: string;
  /** Preset from the action input (used only when no config file is present). */
  presetInput?: string;
}

export interface LoadResult {
  config: ResolvedConfig;
  sourcePath: string | null;
}

export function loadConfig(opts: LoadOptions): LoadResult {
  const { cwd, explicitPath, presetInput } = opts;
  let raw: RepoDoctorConfig | null = null;
  let sourcePath: string | null = null;

  if (explicitPath) {
    const abs = path.resolve(cwd, explicitPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`Config file not found: ${explicitPath}`);
    }
    raw = parseConfigFile(abs);
    sourcePath = explicitPath;
  } else {
    for (const candidate of CANDIDATE_PATHS) {
      const abs = path.resolve(cwd, candidate);
      if (fs.existsSync(abs)) {
        raw = parseConfigFile(abs);
        sourcePath = candidate;
        break;
      }
    }
  }

  const resolved = resolveConfig(raw, presetInput);
  return { config: resolved, sourcePath };
}

function parseConfigFile(absPath: string): RepoDoctorConfig {
  const content = fs.readFileSync(absPath, 'utf8');
  let parsed: unknown;
  if (absPath.endsWith('.yml') || absPath.endsWith('.yaml')) {
    parsed = yaml.load(content);
  } else {
    throw new Error(`Unsupported config file extension: ${absPath}`);
  }
  const result = configSchema.safeParse(parsed ?? {});
  if (!result.success) {
    throw new Error(`Invalid repo-doctor config (${absPath}):\n${result.error.toString()}`);
  }
  return result.data;
}

export function resolveConfig(raw: RepoDoctorConfig | null, presetInput?: string): ResolvedConfig {
  const presetFromConfig = raw?.preset;
  const presetFromInput = normalizePreset(presetInput);
  const preset = presetFromConfig ?? presetFromInput ?? DEFAULT_PRESET;

  const presetDefaults = applyPreset(preset);

  // Start from preset defaults
  const checks: Record<string, ResolvedCheckConfig> = {};
  for (const [id, def] of Object.entries(presetDefaults)) {
    checks[id] = { severity: def.severity, config: { ...(def.config ?? {}) } };
  }

  // Apply per-check overrides
  if (raw?.checks) {
    for (const [id, override] of Object.entries(raw.checks)) {
      if (!(id in ALL_CHECK_DEFAULTS)) {
        throw new Error(`Unknown check id in config: ${id}`);
      }
      const current = checks[id] ?? { severity: 'off', config: {} };
      checks[id] = {
        severity: override.severity ?? current.severity,
        config: { ...current.config, ...(override.config ?? {}) },
      };
    }
  }

  // Branch overrides
  const branchOverrides: Record<string, Record<string, ResolvedCheckConfig>> = {};
  if (raw?.branches) {
    for (const branch of raw.branches) {
      const map: Record<string, ResolvedCheckConfig> = {};
      for (const [id, override] of Object.entries(branch.checks ?? {})) {
        if (!(id in ALL_CHECK_DEFAULTS)) {
          throw new Error(`Unknown check id in branch override for "${branch.name}": ${id}`);
        }
        const base = checks[id] ?? { severity: 'off', config: {} };
        map[id] = {
          severity: override.severity ?? base.severity,
          config: { ...base.config, ...(override.config ?? {}) },
        };
      }
      branchOverrides[branch.name] = map;
    }
  }

  return {
    preset,
    org: { enabled: raw?.org?.enabled ?? false, name: raw?.org?.name },
    ignoreFiles: raw?.ignore?.files ?? [],
    checks,
    branchOverrides,
  };
}

function normalizePreset(value: string | undefined): RepoDoctorConfig['preset'] | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'minimal' || v === 'standard' || v === 'strict' || v === 'off') return v;
  throw new Error(`Invalid preset input: ${value}`);
}
