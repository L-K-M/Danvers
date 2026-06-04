# Danvers Karakeep Extension

Danvers is an alternative Karakeep browser extension mainly aimed at mobile Firefox-based browsers like Iceraven.

<img src="screenshot.png" alt="Screenshot of Danvers extension in action." width="400">

> [!IMPORTANT]
> LLM Disclosure: This project was developed with the assistance of large language models (AI coding tools).

## Setup

0. Install the extension in your browser (see "Permanent Installation" below).
1. Open the extension settings page.
2. Set your primary Karakeep server URL. This can be the local Wi-Fi address of your Karakeep instance.
3. Optionally set a secondary Karakeep server URL. This can be a Tailscale or public address used when the primary address is unavailable.
4. Paste a Karakeep API token.
5. Use `Test Connection` to verify the token and load editable Lists.
6. Optionally choose a default List.
7. Choose where the inline popup appears: top left, top right, bottom left, or bottom right.
8. Configure how many seconds the success panel remains visible before auto-closing.

Danvers always tries the primary server first. If the primary request fails because the server cannot be reached or returns a server-side error, it retries the same request against the secondary server. Authentication and validation errors do not fall back because the same token/request is expected to fail on both addresses.

If you use an `http://` local address, enable `Allow HTTP server URLs for local/self-hosted testing`. Firefox/Iceraven may also prompt for permission to connect to the configured origin when you save settings or test the connection.

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

Before signing, set `browser_specific_settings.gecko.id` in `manifest.json` to a unique add-on id that you control.

For permanent Firefox/Iceraven installation, the extension must be signed by Mozilla. `web-ext` is Mozilla's official command-line tool for building, linting, running, and signing extensions.

Install `web-ext`:

```bash
npm install --global web-ext
```

Create or use a Mozilla Add-ons developer account, then generate API credentials at:

```text
https://addons.mozilla.org/en-US/developers/addon/api/key/
```

Store your AMO credentials in `../web-ext-credentials.env`:

```bash
WEB_EXT_API_KEY="your-api-key"
WEB_EXT_API_SECRET="your-api-secret"
```

Run `build.sh` to build and sign the extension:

```bash
chmod +x build.sh
./build.sh
```

This creates build artifacts in `web-ext-artifacts/`, including a signed `.xpi` if signing succeeds. Running `./build.sh` without `../web-ext-credentials.env` creates only the unsigned build artifact.

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
