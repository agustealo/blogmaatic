# Extension Runtime and Connection Authority

Blogmaatic integrations are extensions. The core publication kernel never branches on WordPress, Jekyll, Facebook, LinkedIn, or another provider name.

## Runtime boundary

`@blogmaatic/extension-sdk` adds the managed runtime around the core publisher contract.

A managed publisher declares a namespaced extension id, semantic version, extension API version, connection schema version, capabilities, connection validation, health checks, and compile/inspect/deliver behavior.

The runtime rejects duplicate extensions, malformed manifests, duplicate capabilities, disabled connections, and connections owned by another extension.

## Connection authority

Connections are configuration records, not credential bags.

A connection contains a stable connection id, owning extension id, display name, active/disabled state, extension-specific JSON settings, secret references, and timestamps. Extension ownership is immutable.

Raw credentials must not be stored in publication groups, routes, connection settings, projection payloads, receipts, or health evidence.

## Secrets authority

`@blogmaatic/secrets` resolves opaque secret references through registered provider schemes.

The initial production provider is `env:VARIABLE_NAME`. Environment storage is not hard-coded into extensions: additional providers can implement the same `SecretProvider` contract for OS keychains, cloud secret managers, vault products, or hosted Blogmaatic infrastructure.

Plaintext secret values are scoped to an async callback and the provider byte buffer is overwritten afterward. Unavailable-secret errors redact the locator.

Connections therefore carry references such as:

```text
secretRefs.applicationPassword = env:WORDPRESS_APPLICATION_PASSWORD
```

not the credential itself.

## Jekyll/Git proof extension

`@blogmaatic/extension-jekyll-git` exercises file, asset, Git, build, and remote-branch semantics.

It compiles Publication IR into deterministic Markdown/front matter, restricts local asset reads to configured roots, fingerprints document and asset bytes, refuses uncommitted human conflicts, commits managed paths, optionally verifies a Jekyll build, can push to a configured remote, and confirms that the remote branch contains the publication commits.

A push failure leaves the local commit intact for a safe retry. A failure before commit restores managed file snapshots.

## WordPress REST proof extension

`@blogmaatic/extension-wordpress-rest` exercises authenticated HTTP publication semantics.

It uses WordPress Application Passwords through the secrets authority, compiles Publication IR into HTML, resolves categories/tags, uploads managed media, supports featured media, drafts and future publication status, creates or updates posts, and verifies the observed remote state after delivery.

The connector never adopts a same-slug post blindly. Blogmaatic-managed posts carry an ownership marker with publication id, route id, desired projection fingerprint, and the hash of the last verified WordPress state. An unmanaged collision fails closed.

Remote-state verification covers title, excerpt, slug, status, schedule, body, categories, tags, and featured media. This detects out-of-band edits even when the WordPress post id remains unchanged.

Managed media uses content-derived stable slugs. Repeated delivery reuses identical uploaded media, while changed local bytes create a new media identity rather than silently pointing at stale content.

## Current safety invariants

- core contains no provider-name branching
- extension ids are namespaced and versioned
- connections cannot cross extension ownership
- disabled connections fail closed
- raw credentials are not connection settings
- secret locators are redacted from unavailable-secret errors
- provider mutations remain inspect-first
- synchronized projections are no-ops
- committed/remote drift updates the existing projection
- unmanaged remote collisions are not overwritten
- local asset reads are allowlisted by real path
- local source filesystem paths are not emitted into published content
- provider receipts contain operational evidence but not credentials

## Deliberately deferred

Connection persistence, encrypted at-rest secret storage, OS/cloud secret-provider implementations, durable workflow execution, CloudEvents, CEL policy expressions, extension sandboxing, MCP, marketplace packaging, and provider analytics remain later slices.

The next provider proof should exercise a constrained social API so projection adaptation and partial-capability publishing are tested against a destination that cannot accept a full article model.
