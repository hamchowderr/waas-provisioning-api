# Pins

Every AnyPress repository lists the versions it pins in `.github/pins.json`: the theme and AnyPress Blocks a template
installs, the wordpress.org plugins and WordPress release it builds on, the zips a Playground preview loads. Two things
keep them current:

- **CI** runs this folder's action (`uses: hamchowderr/waas-provisioning-api/.github/pins@main`). It fails when a pin is
  behind one of our own releases (`github:hamchowderr/...`) and warns when a third-party pin is behind.
- **Update pins** (`.github/workflows/pins.yml`, every hour) moves every pin to its newest release, with its checksum,
  opens a pull request, starts CI on it and merges it once CI passes.

So a release reaches everything that points at it within the hour, and nobody has to remember to bump it.

To run it by hand (needs the GitHub CLI signed in):

```sh
node .github/pins/pins.mjs check    # list each pin and its newest release
node .github/pins/pins.mjs update   # move them
```

## `.github/pins.json`

```json
{
  "pins": [
    {
      "name": "AnyPress Blocks",
      "source": "github:hamchowderr/anypress-blocks",
      "asset": "anypress-blocks.zip",
      "places": [
        { "file": "templates/anypress-store/build.sh", "match": "BLOCKS_VERSION=\\$\\{BLOCKS_VERSION:-(?<version>[^}]+)\\}\\nBLOCKS_SHA256=\\$\\{BLOCKS_SHA256:-(?<sha>[0-9a-f]{64})\\}" }
      ]
    }
  ]
}
```

| Field | What it is |
|---|---|
| `name` | Shown in the check and in the pull request |
| `source` | `github:<owner>/<repo>` (its releases), `wordpress-plugin:<slug>` or `wordpress-core:wordpress` |
| `tagPrefix` | For `github:`, the part of the tag before the version (default `v`; e.g. `anypress-client-v`) |
| `prerelease` | For `github:`, also take pre-releases |
| `line` | For `wordpress-core:`, stay on this release line (e.g. `7.1`) |
| `asset` | For `github:`, the release file the checksum (or `download`) is for |
| `places` | Each file and regular expression where the pin is written. The `version` group is replaced with the new version, and a `sha` group, when there is one, with the SHA-256 of the new release's file (checked against the release's `SHA256SUMS`) |
| `download` | Also save the newest release's file at this path (for zips kept in the repository) |
| `run` | Shell commands to run after a move, with `PIN_VERSION` and `PIN_TAG` set (e.g. to regenerate a file) |

Demo and preview links that need no fixed version should load the latest release instead
(`releases/latest/download/...`), and need no pin at all.
