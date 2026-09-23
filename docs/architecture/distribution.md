# Consumer Distribution Contract

Slice 12 makes Blogmaatic installable without a repository checkout, a system Node.js installation, or npm on the target machine.

## Release authority

A release artifact is produced only from the committed dependency graph:

- root `package.json` declares the product version, supported Node major/minor floor, and exact npm major;
- `package-lock.json` is the committed dependency authority;
- CI installs with `npm ci`, which must agree with the manifests and never repairs the lockfile;
- build/test and distribution jobs use Node.js `24.21.0`;
- managed Restate packages are pinned at `1.7.10`.

The release path does not use floating `latest` tags.

## Supported portable targets

Slice 12 publishes and burns three managed-runtime targets:

| Target | CI image | Managed Restate |
| --- | --- | --- |
| Linux x64 | `ubuntu-24.04` | bundled |
| macOS Apple Silicon | `macos-15` | bundled |
| macOS Intel | `macos-15-intel` | bundled |

Windows remains supported only through `restate.mode=external` until Restate provides a supported local Windows binary path. Blogmaatic does not label an unverified Windows managed-runtime path as supported.

## Artifact layout

Each archive is named:

```text
blogmaatic-<version>-<platform>-<arch>.tar.gz
```

The extracted root contains:

```text
bin/
  blogmaatic        consumer launcher
  node              pinned Node.js runtime
apps/
  runtime/dist/     compiled runtime
  control-room/dist compiled Control Room
packages/
  */dist/           compiled Blogmaatic packages
node_modules/       locked production dependency graph
package.json
package-lock.json
manifest.json
README.md
```

The artifact preserves the same workspace/module layout exercised by the source test suite. Packaging is not a second implementation of the runtime.

`manifest.json` records the product version, target OS/architecture, Node version, package-manager authority, managed Restate version, entrypoint, and principal packaged authorities.

## Integrity

Every archive is accompanied by a SHA-256 sidecar:

```text
blogmaatic-<version>-<platform>-<arch>.tar.gz.sha256
```

Verify the archive before extraction with the platform's SHA-256 utility. A checksum proves artifact integrity against the published digest; Slice 12 does not claim code-signing or notarization.

Signing, notarization, signed update metadata, and a native installer belong to a later release-hardening slice and must not be implied by these portable archives.

## Consumer commands

After extraction, no npm command is required:

```bash
./blogmaatic-<version>-<platform>-<arch>/bin/blogmaatic version
./blogmaatic-<version>-<platform>-<arch>/bin/blogmaatic init --jekyll-repo /absolute/path/to/site
./blogmaatic-<version>-<platform>-<arch>/bin/blogmaatic doctor
./blogmaatic-<version>-<platform>-<arch>/bin/blogmaatic start
```

Retrieve the local operator credential deliberately when the Control Room needs it:

```bash
./blogmaatic-<version>-<platform>-<arch>/bin/blogmaatic token
```

The credential is stored in the platform application-data directory and is never written into the artifact, runtime configuration, browser bundle, or command URLs.

## Persistent state versus installation

The installation directory is replaceable. Durable state lives outside it in the platform-specific Blogmaatic data directory:

- `runtime.json` — non-secret runtime configuration;
- `control-plane.sqlite` — automation, run, schedule, lease, and audit authority;
- `projection-state.sqlite` — verified remote projection identity;
- `restate/` — durable Restate execution state;
- `secrets/operator.token` — local operator bearer credential.

Replacing an application archive must not require copying or rewriting these stores.

## Configuration compatibility

The current public runtime configuration schema is `schemaVersion: 1`.

Blogmaatic parses and validates the full configuration before startup. A configuration with an unsupported schema version fails closed. No historical public schema exists yet, so Slice 12 does not invent a fake migration. Future schema changes must add explicit migration or compatibility handling before the version can be considered upgrade-safe.

The same rule applies to persistent database evolution: schema changes must be implemented by the owning store with deterministic migration behavior before release. Distribution packaging never rewrites domain state by itself.

## Managed Restate networking

Managed Restate is configured by Blogmaatic to:

- bind ingress/admin/query surfaces to loopback only;
- use TCP listeners only;
- persist durable state under the Blogmaatic data directory;
- refuse to attach to unknown processes already occupying its managed ports.

TCP-only listener mode is deliberate. Restate otherwise enables Unix-domain sockets by default, and long macOS application-data paths can exceed the operating system's Unix socket pathname limit even though Blogmaatic never consumes those sockets.

## Clean-install release proof

The distribution quality matrix does not merely inspect archive contents. Each target:

1. installs the exact locked build graph;
2. builds production workspaces;
3. reinstalls the exact production-only graph;
4. creates the target archive and checksum;
5. extracts it into a temporary directory outside the repository;
6. executes only the packaged `bin/blogmaatic` launcher;
7. verifies `help`, `version`, and `doctor`;
8. initializes a real Git/Jekyll repository;
9. starts the bundled managed Restate runtime;
10. reaches the packaged Control Room and Operator API;
11. registers and launches an automation over the authenticated API;
12. publishes a real Jekyll post and Git commit;
13. shuts the packaged runtime down;
14. restarts against the same external state directory;
15. verifies the completed run and confirms no duplicate Git commit was created.

An archive is not considered verified unless this installed-product path succeeds on its target runner.

## Update posture

Slice 12 establishes replaceable versioned archives and state separation. It does **not** implement an automatic updater.

A future updater must, at minimum:

- verify signed release metadata rather than trusting a mutable URL;
- validate artifact integrity before activation;
- check configuration/store compatibility before replacing the running version;
- retain a rollback path for the application binary set;
- never roll durable state backward with an older binary that cannot understand it.
