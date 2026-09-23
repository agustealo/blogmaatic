# Trusted release operations

Blogmaatic releases are source-bound, version-bound, reproducible from the committed dependency graph, and fail closed when platform trust material is unavailable.

## Release authority

The root `package.json` version, root `package-lock.json` version, Git tag, checked-out commit, and release source commit must agree.

A trusted release must satisfy all of the following:

1. `package.json` contains a valid SemVer version.
2. `package-lock.json` and `package-lock.json.packages[""]` contain the same version.
3. npm authority remains exactly `npm@11.19.0` unless the release contract is deliberately updated.
4. The tag is exactly `v<package-version>`.
5. The tag already exists before the release workflow starts.
6. The tag resolves to the workflow checkout commit.
7. The tagged commit is contained in `master`.
8. Every platform build succeeds before the GitHub Release is created.

The release workflow never invents or moves a tag. `gh release create --verify-tag` is the publication boundary.

## Supported release surfaces

### Linux x64

The trusted release publishes:

- `blogmaatic-<version>-amd64.deb`
- `blogmaatic-<version>-amd64.deb.sha256`
- `blogmaatic-<version>-linux-x64.tar.gz`
- `blogmaatic-<version>-linux-x64.tar.gz.sha256`

The Debian package installs the runtime under `/opt/blogmaatic` and the command wrapper at `/usr/local/bin/blogmaatic`.

### macOS Apple Silicon and Intel

The trusted release publishes only the native installer packages:

- `blogmaatic-<version>-macos-arm64.pkg`
- `blogmaatic-<version>-macos-arm64.pkg.sha256`
- `blogmaatic-<version>-macos-x64.pkg`
- `blogmaatic-<version>-macos-x64.pkg.sha256`

The portable macOS tarball remains a CI construction input and clean-extraction proof, not a consumer release asset. The published `.pkg` is the Developer ID signed, Hardened Runtime, notarized, stapled distribution surface.

The bundled Node executable is signed with only the Hardened Runtime exception required by V8 JIT execution: `com.apple.security.cs.allow-jit`. Broader executable-memory or library-validation exceptions are not granted by default.

## Apple trust material

The tagged release workflow requires all of these GitHub Actions secrets:

- `APPLE_DEVELOPER_ID_CERT_P12_BASE64`
- `APPLE_DEVELOPER_ID_CERT_PASSWORD`
- `APPLE_DEVELOPER_ID_APPLICATION`
- `APPLE_DEVELOPER_ID_INSTALLER`
- `APPLE_NOTARY_KEY_ID`
- `APPLE_NOTARY_ISSUER_ID`
- `APPLE_NOTARY_PRIVATE_KEY_BASE64`

If any value is absent, the macOS release jobs fail before signing. There is no unsigned release fallback.

`APPLE_DEVELOPER_ID_CERT_P12_BASE64` contains the exported Developer ID certificate/key bundle. The workflow imports it into an ephemeral runner keychain. The certificate bundle must contain the signing identity referenced by `APPLE_DEVELOPER_ID_APPLICATION` and the installer identity referenced by `APPLE_DEVELOPER_ID_INSTALLER`.

The notary private key is decoded into the runner temporary directory, used by `xcrun notarytool`, and deleted before the job ends.

## macOS signing and notarization

The production macOS path is:

```text
portable payload
    -> sign every Mach-O with Developer ID Application + Hardened Runtime
    -> give bundled Node the allow-jit entitlement
    -> verify Mach-O signatures
    -> build flat .pkg
    -> sign .pkg with Developer ID Installer
    -> install and burn the package
    -> submit .pkg with notarytool
    -> wait for acceptance
    -> staple ticket
    -> validate staple
    -> verify installer signature
    -> recompute final SHA-256 after stapling
    -> create GitHub/Sigstore provenance attestation
```

PR and `master` Distribution Quality use the same payload-signing implementation with ad-hoc signatures. This exercises Hardened Runtime and the Node JIT entitlement without pretending that CI has production Developer ID credentials.

## Linux package proof

Distribution Quality installs the `.deb` with `dpkg`, then runs the installed `/usr/local/bin/blogmaatic` command through first-run initialization and `doctor`. The package is subsequently removed through dpkg so package-manager state is not left behind on the runner.

The native wrapper delegates to `/opt/blogmaatic/bin/blogmaatic`; it is intentionally not a symlink. The portable launcher derives its installation root from its own executable path, so the wrapper preserves bundled Node and bundled Restate authority.

## Provenance and integrity

Platform release bytes are attested with GitHub `actions/attest`, which emits Sigstore-backed SLSA build provenance for the exact final files.

The publish job also creates:

- `SHA256SUMS`
- `release-manifest.json`

The release manifest records the product version, tag, source SHA, package manager authority, bundled Node version, bundled Restate version, and each published asset's size and SHA-256 digest. Its `generatedAt` field is derived from the tagged source commit timestamp rather than workflow wall-clock time, so rebuilding the same source does not manufacture different metadata solely because it ran later.

`SHA256SUMS`, `release-manifest.json`, and the per-asset `.sha256` sidecars are separately attested before the GitHub Release is created. Consumers can verify conventional checksums with their platform SHA-256 tool and can verify GitHub release attestations with GitHub CLI release verification.

## Release procedure

1. Land the intended release source on `master` with Core Quality and Distribution Quality green on the exact merge SHA.
2. Update `package.json` and `package-lock.json` to the release version in one change.
3. Run Core Quality and Distribution Quality again; the release contract must be green.
4. Confirm all required Apple trust secrets are configured.
5. Create the exact version tag, for example `v0.12.0`, on the green `master` commit.
6. Push the tag without moving it afterward.
7. Trusted Release validates source authority, rebuilds all platforms, signs/notarizes macOS, burns native installers, creates provenance attestations, and publishes the GitHub Release only after every platform succeeds.
8. Verify the published release and checksums before announcing it.

If a tag-triggered release fails, fix the source on `master`, advance the package version, and create a new tag. Do not retarget or rewrite a published release tag.

## Installation state and upgrades

The application installation and Blogmaatic state are separate. Replacing `/opt/blogmaatic` does not move the configured application-data directory, SQLite control-plane state, operator credential, or managed Restate state.

An automatic updater is not implemented in this slice. Until update metadata, rollback policy, and transactional replacement are proven, upgrades are explicit installer replacements.

## Windows boundary

Windows is not a trusted managed-runtime release target yet. The current architecture supports `restate.mode=external` there, but Blogmaatic does not publish a Windows managed-Restate installer until a real supported runtime path and installer burn exist.
