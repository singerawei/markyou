# Contributing

This document covers development, testing and release maintenance. The READMEs describe the extension for its users.

## Build and test

Use Node.js 22 or newer (`.nvmrc` selects 22).

```sh
git clone https://github.com/singerawei/markyou.git
cd markyou
npm ci
npx playwright install chromium chromium-headless-shell
npm run check        # lint, typecheck, core tests and build
npm run test:ui      # browser UI tests
npm run test:host    # real VS Code host tests
npm run bench       # performance measurements
npm run package     # Windows x64 VSIX, including the offline PDF engine
```

Packaging bundles the installed Chromium headless shell. Set `MARKYOU_PRE_RELEASE=true` when packaging a preview. The generated VSIX can be installed with VS Code's **Install from VSIX…** action.

Never regenerate untouched Markdown blocks or flatten included content into the root file. Include regression coverage for ownership, data loss, conflicts and security fixes. Preserve unsupported syntax.

Performance reports must identify the machine, VS Code version and measurement scope. Headless browser or model timings alone cannot certify installed-package performance, real IME, screen-reader accessibility or user-task acceptance. Store generated reports locally or in Actions artifacts, not in source commits.

## Publishing

The Marketplace extension identity is **singeraw.markyou**. Marketplace installations receive published stable updates through VS Code's normal extension updates; GitHub uploads alone do not update Marketplace. Earlier local test packages using `markyou.markyou` have a different identity and should be uninstalled when installing this publisher's package.

1. Under the `singeraw` publisher's **Trusted Publishing**, create a GitHub policy for owner `singerawei`, repository `markyou`, workflow `ci.yml`, environment `marketplace`. Actions requests an OIDC token with `id-token: write` and publishes with `vsce publish --oidc`. No stored publishing token is required. See the [official publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing).
2. Update `package.json`, `package-lock.json`, README versions and the changelog together. Push a matching tag: `v1.1.1-preview.1` publishes numeric version `1.1.1` as a Marketplace pre-release. A later stable release must use a different numeric version, such as `1.2.0`, and a matching stable tag. Do not reuse an already published preview version for stable. Pre-release VSIX packages are marked before they are tested.
3. Actions runs Linux/Windows checks and UI tests, packages Windows x64, audits the VSIX, and tests the installed package in isolated VS Code. GitHub Release and Marketplace receive the same tested VSIX. Only VSIX and README files are attached to Releases; generated reports stay in short-lived Actions artifacts.
4. Stable tags additionally require real-user/IME/PDF/recovery/performance acceptance for the exact VSIX. Download the `markyou-vsix` artifact, test it, attach the completed `acceptance.json` to a draft Release for that tag, then rerun the failed **acceptance** job. `scripts/check-release.mjs` validates hashes and evidence; missing or stale evidence blocks stable publishing. Pre-release tags still require all automated checks.
5. If Marketplace publishing fails after the GitHub Release is created, verify the publisher policy's exact repository, workflow and environment names and rerun only the failed job. Source commits exclude VSIX, Chromium, dependencies, local reviews, reports and credentials through `.gitignore`.

To recover a successful preview whose Marketplace job was skipped, manually run `ci.yml` with `publish_preview_run` set to that successful release run's numeric ID. The workflow verifies the repository, preview tag, tested commit and successful Linux/Windows/release jobs, then checksums and publishes the original artifact. This recovery mode cannot publish stable releases.

Preview publishing does not complete the manual stable-release acceptance gates. See `scripts/check-release.mjs` for the required evidence and validation.
