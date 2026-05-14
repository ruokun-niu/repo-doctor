# `repo-doctor` — Plan

A GitHub Action that audits a repo (and optionally its org) against a set of health/governance checks. Ships with sensible defaults, fully overridable via a config file.

**`repo-doctor` is read-only.** It checks and reports status only — it never modifies repo settings, opens PRs, or attempts to fix anything. Remediation guidance is shown as human-readable text in the report.

---

## 1. Goals & non-goals

**Goals**
- One-line drop-in: `uses: <you>/repo-doctor@v1` runs default checks
- Configurable via `.github/repo-doctor.yml` (or `.toml`) in the consuming repo
- Clear, actionable output: which checks failed, why, how to fix (as guidance only)
- Exit non-zero on failures (configurable severity: `error` / `warn` / `off` per check)
- Works on a single repo by default; optional org-wide mode

**Non-goals**
- Auto-fixing problems (no `--fix`, no auto-PRs — ever)
- Modifying any repo or org settings
- Replacing OpenSSF Scorecard (we complement it; users can run both)
- Being a generic policy engine like OPA

---

## 2. What it checks (default rule set)

Each check has an ID, severity default, and a short doc link.

### Repo configuration (via REST API)
- `repo.has-description` — description is set
- `repo.has-topics` — at least N topics
- `repo.has-license` — LICENSE file exists, or license detected via API
- `repo.default-branch-is-main` — default branch matches expected name
- `repo.delete-branch-on-merge` — enabled
- `repo.allow-merge-commit` / `allow-squash` / `allow-rebase` — match policy
- `repo.vulnerability-alerts-enabled`
- `repo.secret-scanning-enabled`
- `repo.secret-scanning-push-protection-enabled`
- `repo.dependabot-security-updates-enabled`

### Branch protection / rulesets
- `branch.protected` — default branch is protected (classic or via ruleset)
- `branch.requires-pr` — direct push to default blocked
- `branch.requires-reviews` — N approvals required
- `branch.requires-status-checks` — at least one required check
- `branch.requires-signed-commits` — optional, off by default
- `branch.requires-linear-history` — optional
- `branch.dismiss-stale-reviews` — optional

### Files present (community standards)
- `files.readme`
- `files.license`
- `files.code-of-conduct`
- `files.contributing`
- `files.security` — `SECURITY.md`
- `files.support`
- `files.pull-request-template`
- `files.issue-templates` — at least one in `.github/ISSUE_TEMPLATE/`
- `files.codeowners`

### Dependency management
- `deps.dependabot-config-exists` — `.github/dependabot.yml`
- `deps.dependabot-covers-ecosystems` — auto-detects ecosystems in repo (cargo, npm, pip, go, actions, docker) and verifies each is configured

### Workflows / CI
- `workflows.actions-pinned-to-sha` — third-party actions pinned (warn by default)
- `workflows.permissions-declared` — every workflow declares `permissions:`
- `workflows.has-codeql` — CodeQL workflow present (warn)

### Org-level (optional, requires org token)
- `org.two-factor-required`
- `org.default-repo-permission` — matches policy
- `org.rulesets-defined` — at least one org-level ruleset targets this repo
- `org.member-privileges` — fork creation, repo creation restrictions

---

## 3. Configuration

### Resolution order
1. Explicit `config` input to the action
2. `.github/repo-doctor.yml` (or `.yaml` / `.toml`) in the repo
3. Built-in defaults

### Format (YAML primary, TOML supported later)

```yaml
# .github/repo-doctor.yml
version: 1

# Apply a preset, then override individual checks
preset: standard   # one of: minimal | standard | strict | off

# Optional: include org-level checks
org:
  enabled: true
  name: my-org   # defaults to repo owner

# Per-check overrides
checks:
  branch.requires-reviews:
    severity: error
    config:
      min_approvals: 2
  files.security:
    severity: warn
  workflows.actions-pinned-to-sha:
    severity: off            # disable entirely
  repo.allow-merge-commit:
    severity: error
    config:
      expected: false

# Apply different rules to different branches
branches:
  - name: main
    checks:
      branch.requires-signed-commits:
        severity: error

# Glob-based file exemptions
ignore:
  files:
    - "legacy/**"
```

### Action inputs

```yaml
inputs:
  config:        # path to config file, default '.github/repo-doctor.yml'
  preset:        # override preset without a config file
  fail-on:       # error | warn | never — default 'error'
  github-token:  # default ${{ github.token }}
  org-token:     # optional, for org-level checks (needs admin:org)
  format:        # text | json | sarif | markdown — default 'text'
  output:        # path to write report; also always prints to log
```

### Outputs

```yaml
outputs:
  passed:       # count
  failed:       # count
  warnings:     # count
  report-path:  # path to written report
```

---

## 4. Architecture

**Language: TypeScript** (best Action ecosystem support; `@actions/core`, `@actions/github`, Octokit are first-class)

**Layout:**
```
repo-doctor/
├── action.yml                 # action metadata
├── package.json
├── tsconfig.json
├── src/
│   ├── main.ts                # entry point
│   ├── config/
│   │   ├── loader.ts          # find + parse yaml/toml
│   │   ├── schema.ts          # zod schema for config
│   │   └── presets.ts         # minimal / standard / strict
│   ├── checks/
│   │   ├── types.ts           # Check interface
│   │   ├── registry.ts        # all checks registered here
│   │   ├── repo/
│   │   │   ├── has-description.ts
│   │   │   ├── delete-branch-on-merge.ts
│   │   │   └── ...
│   │   ├── branch/
│   │   ├── files/
│   │   ├── deps/
│   │   ├── workflows/
│   │   └── org/
│   ├── reporters/
│   │   ├── text.ts
│   │   ├── markdown.ts
│   │   ├── json.ts
│   │   └── sarif.ts
│   └── lib/
│       ├── github.ts          # Octokit wrapper
│       └── ecosystem-detect.ts
├── dist/                      # bundled (ncc) output, committed
├── __tests__/
└── README.md
```

**Check interface (shape):**
```
interface Check {
  id: string;
  category: string;
  description: string;
  docsUrl: string;
  defaultSeverity: 'error' | 'warn' | 'off';
  run(ctx): Promise<CheckResult>;
}

interface CheckResult {
  status: 'pass' | 'fail' | 'skip';
  message: string;
  remediation?: string;     // human-readable guidance only; not executed
  details?: unknown;
}
```

**Runner flow:**
1. Parse inputs
2. Load config → merge with preset → merge with defaults
3. Detect repo facts (ecosystems present, default branch, etc.) once, share via context
4. Run checks in parallel (read-only API calls), respecting per-check severity
5. Aggregate results → reporter → write output → set action outputs → exit code

---

## 5. Presets

- **`minimal`** — license, README, default-branch protection only
- **`standard`** (default) — everything in "Repo configuration", "Branch protection", "Files present", "Dependency management"
- **`strict`** — adds signed commits, linear history, action SHA pinning, CodeQL required, 2 reviewers

---

## 6. Output formats

- **`text`** (default for logs): grouped by category, color-coded, with remediation tips
- **`markdown`**: posted as a job summary via `$GITHUB_STEP_SUMMARY` automatically
- **`json`**: machine-readable, for downstream tooling
- **`sarif`**: uploads to GitHub's Security/Code Scanning tab via `upload-sarif`

Example text output sketch:
```
repo-doctor v1.0.0  —  owner/repo

✓ Repo configuration                       (5/6)
  ✗ repo.delete-branch-on-merge   [error]
    Branches are not auto-deleted after merge.
    Fix: Settings → General → "Automatically delete head branches"

✓ Branch protection                        (4/4)
✗ Files present                            (5/7)
  ✗ files.security                [warn]   SECURITY.md missing
  ✗ files.codeowners              [warn]   CODEOWNERS missing

Summary: 14 passed, 3 failed (1 error, 2 warnings)
```

---

## 7. Auth & permissions

All API calls are **read-only**. The action never requests write scopes.

| Scope | Token | Permissions needed |
|---|---|---|
| Repo checks | `${{ github.token }}` | `contents: read`, `metadata: read`, `administration: read` (only if checking repo settings/protections deeply) |
| Org checks | PAT or App token | `admin:org` read |

Document clearly which checks need elevated tokens; gracefully skip with `status: skip` and a reason when token lacks permission.

---

## 8. Milestones (one-day scope)

**Hour 1–2: Scaffolding**
- Init TS project, `action.yml`, `@vercel/ncc` bundling, basic CI
- Octokit client + auth handling

**Hour 3–4: Config + 3 checks end-to-end**
- Config loader (YAML only first, TOML later) + zod schema
- Preset system
- Implement: `files.license`, `repo.delete-branch-on-merge`, `branch.requires-pr`
- Text reporter

**Hour 5–6: Fill out check coverage**
- All "Files present" checks (cheap, same pattern)
- Remaining repo settings checks
- Branch protection / ruleset checks (this is the meaty API exploration)

**Hour 7: Dependency checks**
- Ecosystem auto-detection
- Dependabot config parsing + coverage check

**Hour 8: Polish**
- Markdown reporter → step summary
- README with examples
- Tag `v0.1.0`, test on 1–2 of your own repos

**Stretch (v0.2):**
- SARIF reporter
- Workflow checks (action pinning, permissions)
- Org-level checks
- TOML support

---

## 9. Open questions to decide before coding

1. **Config filename**: `repo-doctor.yml` or `.repo-doctor.yml`? (Recommend `.github/repo-doctor.yml` for discoverability.)
2. **Severity vocabulary**: `error/warn/off` vs `required/recommended/disabled`?
3. **Default for `fail-on`**: `error` (strict) or `never` (advisory first run)?
4. **Should the action auto-post a PR comment** when run on `pull_request`, or only log? (Recommend log + step summary only in v1.)
5. **Ruleset vs branch protection**: rulesets are newer and increasingly preferred. Check both; if a ruleset covers the requirement, it counts.
6. **TOML support in v1 or punt to v2?** (Recommend punt — adds dep, low real-world demand.)
