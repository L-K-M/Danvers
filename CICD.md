# CI/CD

Danvers is a Manifest V3 browser extension (Firefox/Gecko, via `browser_specific_settings`) that saves the current page to [Karakeep](https://karakeep.app) from an inline Iceraven-friendly overlay. This repository uses GitHub Actions to validate the extension on every change and to package a downloadable build whenever a version tag is pushed.

## Workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/ci.yml` | PRs + pushes to `main` | Lint/validate the extension |
| `.github/workflows/release.yml` | Pushing a `v*` tag | Package the extension and attach it to a GitHub Release |

## Continuous integration (`ci.yml`)

On every pull request and every push to `main`, the workflow:

1. Checks out the repository.
2. Sets up Node.js 20.
3. Runs `npm run check`, which performs `node --check` on the extension's JavaScript entry points (`src/background.js`, `src/content/overlay.js`, `src/options/options.js`) to catch syntax errors before they ship.

The project has no runtime dependencies and no lockfile, so there is no `npm ci` / install step and npm caching is intentionally omitted. A `concurrency` group cancels superseded runs when a branch is pushed again.

### Running locally

```bash
npm run check
```

## Releases (`release.yml`)

Releases are cut by pushing a version tag:

```bash
git tag v1.2.3
git push origin v1.2.3
```

The workflow runs `npm run package` (which executes `scripts/package-xpi.js`) to produce **`dist/danvers-karakeep.xpi`** — a zip archive containing `manifest.json`, `README.md`, `LICENSE`, `src/`, and `icons/`. That `.xpi` is attached to a new GitHub Release created via [`softprops/action-gh-release`](https://github.com/softprops/action-gh-release), with auto-generated release notes.

This artifact is an **unsigned** package suitable for self-distribution or temporary installation. To load it in Firefox/Iceraven, open `about:debugging` → **This Firefox** → **Load Temporary Add-on…** and select the `.xpi`. (Permanent installation of an unsigned add-on requires a build that is signed through Mozilla Add-ons — see Secrets.)

## Secrets

No secrets are required. Both workflows run entirely with the default `GITHUB_TOKEN`; `release.yml` requests `contents: write` so it can create releases.

Store publishing is out of scope. As a future option, signing for permanent Firefox installation (a signed `.xpi`) would require [Mozilla Add-ons (AMO) API credentials](https://addons.mozilla.org/developers/addon/api/key/) (`web-ext sign` with `--api-key` / `--api-secret`), supplied as repository secrets.
