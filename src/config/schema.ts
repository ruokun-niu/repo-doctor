import { z } from 'zod';

export const severitySchema = z.enum(['error', 'warn', 'off']);
export type Severity = z.infer<typeof severitySchema>;

export const presetSchema = z.enum(['minimal', 'standard', 'strict', 'off']);
export type Preset = z.infer<typeof presetSchema>;

export const checkOverrideSchema = z
  .object({
    severity: severitySchema.optional(),
    config: z.record(z.unknown()).optional(),
  })
  .strict();
export type CheckOverride = z.infer<typeof checkOverrideSchema>;

export const branchOverrideSchema = z
  .object({
    name: z.string().min(1),
    checks: z.record(checkOverrideSchema).optional(),
  })
  .strict();

export const orgConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    name: z.string().optional(),
  })
  .strict();

export const ignoreSchema = z
  .object({
    files: z.array(z.string()).optional(),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1).default(1),
    preset: presetSchema.optional(),
    org: orgConfigSchema.optional(),
    checks: z.record(checkOverrideSchema).optional(),
    branches: z.array(branchOverrideSchema).optional(),
    ignore: ignoreSchema.optional(),
  })
  .strict();

export type RepoDoctorConfig = z.infer<typeof configSchema>;

/**
 * The fully resolved view that the runner consumes. Every known check
 * has a final severity and (optional) config map.
 */
export interface ResolvedCheckConfig {
  severity: Severity;
  config: Record<string, unknown>;
}

export interface ResolvedConfig {
  preset: Preset;
  org: { enabled: boolean; name?: string };
  ignoreFiles: string[];
  /** check id -> resolved settings */
  checks: Record<string, ResolvedCheckConfig>;
  /** branch name -> map of check id -> override */
  branchOverrides: Record<string, Record<string, ResolvedCheckConfig>>;
}
