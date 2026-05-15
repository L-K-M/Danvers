# Danvers Karakeep Extension

Danvers is an alternative Karakeep browser extension mainly aimed at mobile Firefox-based browsers like Iceraven.

## Configure

1. Open the extension settings page.
2. Set your Karakeep server URL.
3. Paste a Karakeep API token.
4. Use `Test Connection` to verify the token and load editable Lists.
5. Optionally choose a default List.

## Build

Run a syntax check:

```bash
npm run check
```

Create a local unsigned XPI package:

```bash
npm run package
```

The package is written to:

```text
dist/danvers-karakeep.xpi
```

## Temporary Installation

Desktop Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose `Load Temporary Add-on...`.
3. Select `manifest.json` from this repository.

Iceraven:

1. Package the repository as a `.zip` or `.xpi` containing `manifest.json` at the archive root.
2. Install it using Iceraven's extension/developer workflow for local add-ons.
3. Configure the extension settings before saving pages.

## Permanent Installation

For permanent Firefox/Iceraven installation, the extension must be signed by Mozilla. `web-ext` is Mozilla's official command-line tool for building, linting, running, and signing extensions.

Install `web-ext`:

```bash
npm install --global web-ext
```

Create or use a Mozilla Add-ons developer account, then generate API credentials at:

```text
https://addons.mozilla.org/en-US/developers/addon/api/key/
```

Before signing, set `browser_specific_settings.gecko.id` in `manifest.json` to a unique add-on id that you control.

Build with `web-ext`:

```bash
web-ext build --overwrite-dest
```

Sign an unlisted build:

```bash
web-ext sign \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET" \
  --channel="unlisted"
```

This creates build artifacts in `web-ext-artifacts/`, including a signed `.xpi` if signing succeeds.

## Development

Run the extension in a temporary Firefox profile:

```bash
web-ext run
```

Check for common extension packaging issues:

```bash
web-ext lint
```

The local `npm run package` command is useful when `web-ext` is not installed, but `web-ext` is still the preferred tool for AMO-compatible builds and signing.
