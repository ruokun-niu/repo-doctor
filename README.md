# repo-doctor

A GitHub Action that audits a repository (and optionally its org) against a set of health and governance checks. **Read-only**: `repo-doctor` never modifies repo settings, opens PRs, or attempts to fix anything. Remediation guidance is shown as human-readable text only.

## Quick start

```yaml
# .github/workflows/repo-doctor.yml
name: repo-doctor
on:
  schedule:
    - cron: '0 9 * * 1'   # Mondays 09:00 UTC
  workflow_dispatch:

permissions:
  contents: read

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: <you>/repo-doctor@v1
```

The action prints a grouped report to the job log and writes a Markdown summary visible on the workflow run page.

## Inputs

| Name | Default | Description |
|---|---|---|
| `config` | `.github/repo-doctor.yml` (auto-detected) | Path to config file. |
| `preset` | `standard` | `minimal` \| `standard` \| `strict` \| `off`. Overridden by config file. |
| `fail-on` | `error` | `error` \| `warn` \| `never` — severity that produces a non-zero exit. |
| `github-token` | `${{ github.token }}` | Token for repo-level API calls. |
| `org-token` | _none_ | Optional PAT/app token with `admin:org` read for org-level checks. |
| `format` | `text,markdown` | Comma-separated: `text`, `markdown`, `json`. |
| `output` | _none_ | Optional path to write the report file. |

## Outputs

| Name | Description |
|---|---|
| `passed` | Number of passing checks |
| `failed` | Number of failing checks |
| `errors` | Number of failures at `error` severity |
| `warnings` | Number of failures at `warn` severity |
| `report-path` | Path to the written report, if `output` was set |

## Configuration

`.github/repo-doctor.yml`:

```yaml
version: 1
preset: standard

org:
  enabled: true   # requires org-token

checks:
  branch.requires-reviews:
    severity: error
    config:
      min_approvals: 2
  files.security:
    severity: warn
  workflows.actions-pinned-to-sha:
    severity: off

branches:
  - name: main
    checks:
      branch.requires-signed-commits:
        severity: error

ignore:
  files:
    - "legacy/**"
```

### Presets

- **`minimal`** — README, LICENSE, default-branch protection.
- **`standard`** _(default)_ — all repo settings, branch protection, community files, dependency management.
- **`strict`** — adds signed commits, linear history, action SHA pinning, CodeQL, 2 reviewers required.
- **`off`** — disables all checks (use with per-check overrides).

## Check catalog

See `src/checks/` for the full list. Categories:

- `repo.*` — repository settings (description, topics, license, merge settings, security features)
- `branch.*` — branch protection / rulesets on the default branch
- `files.*` — community files (README, LICENSE, SECURITY, CONTRIBUTING, CODEOWNERS, templates, …)
- `deps.*` — Dependabot configuration & ecosystem coverage
- `workflows.*` — workflow hardening (SHA pinning, `permissions:`, CodeQL)
- `org.*` — org-level governance (2FA, default permission, rulesets)

## Permissions

All API calls are read-only. The action never requests write scopes.

Recommended job permissions:

```yaml
permissions:
  contents: read
  # add `administration: read` for deeper repo-settings introspection (branch protection, security features, etc.)
```

Org-level checks require a separate token with `admin:org` (read).

## Development

```bash
npm install
npm run typecheck
npm run build         # bundles to dist/ via @vercel/ncc
```

The `dist/` directory is committed so the action can be consumed directly from a tag.

## License

MIT
