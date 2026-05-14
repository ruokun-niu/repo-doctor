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
  administration: read         # for repo.secret-scanning-*, repo.dependabot-security-updates-enabled
  security-events: read        # for workflows.has-codeql
  vulnerability-alerts: read   # for repo.vulnerability-alerts-enabled

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: <you>/repo-doctor@v1
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

The action prints a grouped report to the job log and writes a Markdown summary visible on the workflow run page.

If you only care about file/branch-level checks, `contents: read` alone is
enough — security checks without the right permission will `skip` rather than
fail. See [Permissions](#permissions) for the full mapping.

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
| `target` | `repo` | `repo` (audit current repo), `org` (every repo in the org), or `list` (explicit `repos` list). Defaults to `list` when `repos` is set. |
| `org` | _repo owner_ | Org name when `target=org`. Also used as the report label for `target=list`. |
| `repos` | _none_ | Explicit list of `owner/name` repos to audit (whitespace- or comma-separated). When set, `target` defaults to `list`. |
| `include-archived` | `false` | When `target=org`, also audit archived repos. |
| `repo-filter` | _none_ | When `target=org`, regex of repo names to include (e.g. `^lib-`). |
| `max-repos` | `200` | When `target=org` or `target=list`, safety cap on how many repos to audit. |

### Audit an explicit list of repos

```yaml
- uses: <you>/repo-doctor@v0.2.0
  env:
    GITHUB_TOKEN: ${{ secrets.AUDIT_TOKEN }}   # needs read access to each listed repo
  with:
    repos: |
      my-org/repo-a
      my-org/repo-b
      another-org/repo-c
    fail-on: never
```

You can also pass them comma-separated on one line: `repos: my-org/repo-a, my-org/repo-b`.

### Org-wide audit example

```yaml
name: repo-doctor (org)
on:
  workflow_dispatch:
  schedule:
    - cron: '0 9 * * 1'

permissions:
  contents: read

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: <you>/repo-doctor@v0.2.0
        env:
          GITHUB_TOKEN: ${{ secrets.ORG_AUDIT_TOKEN }}   # PAT with repo:read on org repos
        with:
          target: org
          org: my-org
          fail-on: never
          repo-filter: '^(?!archived-).+'
```

The org report includes a single per-repo summary table at the top with totals across every audited repo, then a collapsed details block per failing repo. Org-level checks (`org.*`) still run once when `org.enabled: true`.

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

The default `GITHUB_TOKEN` from `${{ github.token }}` is scoped to the running
workflow's `permissions:` block. Different checks need different scopes; the
table below summarizes what to add to read the data they need. Missing a
permission is never fatal — the affected check will `skip` with a hint.

### Recommended workflow `permissions:`

```yaml
permissions:
  contents: read              # required for files.* / workflows.* / deps.* (reads repo contents)
  metadata: read              # implicit; needed for repo.has-license, repo.has-description, etc.
  administration: read        # repo.secret-scanning-*, repo.dependabot-security-updates-enabled
  security-events: read       # workflows.has-codeql (reads code scanning config)
  vulnerability-alerts: read  # repo.vulnerability-alerts-enabled
```

If you don't need the security-related checks, `contents: read` alone is fine
and the rest will simply `skip`.

### Per-check permission map

| Check(s) | Required permission / scope |
|---|---|
| `files.*`, `workflows.*`, `deps.*` | `contents: read` |
| `repo.has-description`, `repo.has-topics`, `repo.has-license`, `repo.default-branch-is-main`, `repo.allow-*` | none beyond default (uses repo metadata) |
| `repo.vulnerability-alerts-enabled` | `vulnerability-alerts: read` |
| `repo.secret-scanning-enabled`, `repo.secret-scanning-push-protection-enabled`, `repo.dependabot-security-updates-enabled` | `administration: read` (the `security_and_analysis` block is only returned to admins, or on public repos with GHAS) |
| `branch.*` | `contents: read` is sufficient for repo + org rulesets; reading **classic** branch protection details may additionally need `administration: read` on some repos |
| `org.*` (`org.enabled: true`) | A **separate token** with `admin:org` (read), passed as the `org-token:` input |

### Cross-repo and org-wide audits

The default `GITHUB_TOKEN` is scoped to *the repo running the workflow*. For
`target: org` or `target: list`, you need a token that can read every audited
repo. Recommended options:

- **Fine-grained PAT** with `Repository contents: Read` (and any of the
  read-only repository permissions above you want) on the target repos.
- **GitHub App installation token** with the same permissions, installed on
  the target repos.

Pass that token via `github-token:` (and `org-token:` for `org.*` checks, which
also need `admin:org` read).

## Development

```bash
npm install
npm run typecheck
npm run build         # bundles to dist/ via @vercel/ncc
```

The `dist/` directory is committed so the action can be consumed directly from a tag.

## License

MIT
