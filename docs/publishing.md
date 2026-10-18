# Publishing the SDKs

For maintainers. How the TypeScript SDK reaches npm and the PHP SDK reaches Packagist, what to set up once, and how to cut a release.

| Package | Registry | Source | Release tag | Workflow |
|---|---|---|---|---|
| `waas-provisioning-sdk` | npm | `sdk/typescript` | `sdk-ts-v<version>` | [`release-sdk-typescript.yml`](../.github/workflows/release-sdk-typescript.yml) |
| `otakusolutions/waas-provisioning-sdk` | Packagist | `sdk/php`, copied to [hamchowderr/waas-provisioning-sdk-php](https://github.com/hamchowderr/waas-provisioning-sdk-php) | `sdk-php-v<version>` | [`release-sdk-php.yml`](../.github/workflows/release-sdk-php.yml) |

The two SDKs are versioned separately. Both follow semantic versioning.

## One-time setup

### npm

Releases use npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers): npm trusts this repository's `release-sdk-typescript.yml` workflow through GitHub's OIDC token, so no npm token is stored anywhere. This is already set up for `waas-provisioning-sdk`.

To set it up again (for example after moving the repository), sign in with the npm account that owns the package and run:

```sh
npm trust github waas-provisioning-sdk --file release-sdk-typescript.yml --repo hamchowderr/waas-provisioning-api --allow-publish
```

`npm trust list waas-provisioning-sdk` shows what is trusted. You can also manage it on the package's npm page under **Settings**, **Trusted Publisher**.

### Packagist

Packagist reads `composer.json` from the root of a Git repository, so the release workflow copies `sdk/php` (with its history) to its own repository and tags it there. That repository is read-only: all changes happen here.

1. Create an **empty** public repository `hamchowderr/waas-provisioning-sdk-php` on GitHub: no README, license or `.gitignore`. In its settings, turn off Issues, and set the description to "Read-only copy of sdk/php from hamchowderr/waas-provisioning-api. Send issues and pull requests there."
2. Make a deploy key on your computer (no passphrase):
   ```sh
   ssh-keygen -t ed25519 -N '' -C 'waas-provisioning-sdk-php deploy' -f php-sdk-deploy-key
   ```
3. In **waas-provisioning-sdk-php**: **Settings**, **Deploy keys**, **Add deploy key**. Paste `php-sdk-deploy-key.pub` and tick **Allow write access**.
4. In **waas-provisioning-api** (this repository): **Settings**, **Secrets and variables**, **Actions**, **New repository secret**. Name `PHP_SDK_DEPLOY_KEY`, value the whole content of `php-sdk-deploy-key` (the private key). Then delete both key files from your computer.
5. Cut the first PHP release (below), so the new repository has a `main` branch and a `v0.1.0` tag.
6. On [packagist.org](https://packagist.org), sign in with GitHub, choose **Submit**, and enter `https://github.com/hamchowderr/waas-provisioning-sdk-php`. The name comes from `composer.json`: `otakusolutions/waas-provisioning-sdk`. The first account to submit an `otakusolutions/...` package owns that vendor name.
7. On the package page, check it says it is updated automatically. If it doesn't, connect your GitHub account under your Packagist profile, or add the Packagist webhook to the PHP SDK repository as Packagist's page describes.

If you ever change the repository name, change `SPLIT_REPO` in `release-sdk-php.yml` too.

## Cutting a release

### TypeScript

1. Update `version` in `sdk/typescript/package.json` and add an entry to `sdk/typescript/CHANGELOG.md`. Merge to `main`.
2. Tag the merge commit and push the tag:
   ```sh
   git checkout main && git pull
   git tag sdk-ts-v0.1.0
   git push origin sdk-ts-v0.1.0
   ```
3. The workflow checks the tag matches `package.json`, checks the generated types are current, builds, and publishes with provenance. Watch it under **Actions**.

To see what will be published, run `npm pack --dry-run` in `sdk/typescript`. It should list `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE` and `package.json`, and nothing else.

### PHP

1. Add an entry to `sdk/php/CHANGELOG.md`. Merge to `main`. (`composer.json` has no version field; the tag is the version.)
2. Tag and push:
   ```sh
   git checkout main && git pull
   git tag sdk-php-v0.1.0
   git push origin sdk-php-v0.1.0
   ```
3. The workflow validates `composer.json`, copies `sdk/php` to the PHP SDK repository's `main` branch, and tags it `v0.1.0`. Packagist picks the tag up within a minute or so.

A failed release is safe to retry once the cause is fixed: delete the tag here (`git push origin :sdk-php-v0.1.0`) and push it again. npm never accepts the same version twice, so a TypeScript release that did publish needs a new version number.
