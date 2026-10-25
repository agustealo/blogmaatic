# WordPress REST Publisher

`@blogmaatic/extension-wordpress-rest` is Blogmaatic's first real authenticated HTTP publisher.

It deliberately uses WordPress core REST facilities rather than requiring a Blogmaatic WordPress plugin. The initial authentication contract is WordPress Application Passwords over HTTPS. Loopback HTTP is allowed only for local integration tests and development.

## Connection

Required settings:

- `siteUrl` — canonical WordPress site URL
- `username` — WordPress username associated with the Application Password

Required secret reference:

- `applicationPassword` — for example `env:WORDPRESS_APPLICATION_PASSWORD`

Optional settings:

- `apiRoot` — override the default `${siteUrl}/wp-json/wp/v2`
- `postTypeRestBase` — default `posts`
- `assetSourceRoots` — absolute directories from which local assets may be read
- `createMissingTerms` — default `true`
- `timeoutMs` — default `15000`, bounded from 1000 to 120000

## Capabilities

The extension currently declares:

- `article.create`
- `article.update`
- `article.delete`
- `article.inspect`
- `article.draft`
- `article.schedule`
- `asset.publish`
- `taxonomy.publish`

It intentionally does not claim `canonical.publish` because WordPress core does not provide a universal canonical-URL write contract independent of SEO plugins/themes.

## Compilation

Publication IR is rendered into deterministic HTML. Text is escaped by default. Explicit `embed.html` blocks remain deliberate raw HTML supplied by the publication model.

The projection fingerprint covers title, excerpt, stable slug, source-resolved desired status/schedule, HTML template, taxonomy names, featured-asset selection, source-bound WordPress author identity, and managed-asset byte fingerprints.

Local assets must resolve inside an allowlisted `assetSourceRoots` entry. Local paths are never written into WordPress content.

## Media

Local assets are uploaded through `/wp/v2/media`.

The media slug includes publication id, asset id, and a prefix of the asset-content hash. This makes retries idempotent for unchanged bytes and gives changed bytes a new remote media identity. Alt text is applied after media creation.

HTTP(S) publication assets remain external URLs and are not downloaded by Blogmaatic, avoiding an implicit server-side URL fetch surface.

A featured asset must resolve to a managed WordPress media item because WordPress `featured_media` requires an attachment id.

## Author ownership

WordPress author selection is exposed through the same provider-neutral source boundary as source content, taxonomy, and media. Control Room never calls `/wp/v2/users` directly.

Author lookup uses authenticated edit context and returns only the safe fields Blogmaatic needs for editorial selection: remote id, display name, slug, optional public author link, and optional avatar URL. Email addresses are intentionally not surfaced.

The canonical Publication stores the selected author under `PublicationIR.attributes.sourceAuthor` with:

- extension id
- connection id
- remote author id
- display name when resolved through the author picker

Imported WordPress posts preserve their existing numeric author id from the first canonical revision. Author assignment creates a new immutable Publication revision.

A source author is applied only when its extension and connection match the WordPress destination being compiled. This prevents numeric user ids from one WordPress site from leaking into another site. The resolved author id participates in the projection fingerprint, WordPress request body, verified remote-state hash, and drift inspection.

## Native WordPress publishing state

Blogmaatic workflow status and WordPress post status are deliberately separate concepts.

The canonical workspace continues to use its own lifecycle such as `idea`, `draft`, `ready`, `approved`, and `archived`. A WordPress-sourced Publication may additionally carry `PublicationIR.attributes.sourcePublishing` with source-bound WordPress state:

- extension id
- connection id
- native status: `draft`, `pending`, `private`, `publish`, or `future`
- `scheduledAt` only when status is `future`

The source-native state wins over the route's default WordPress status only when the extension and connection match the destination being compiled. This prevents a WordPress editorial choice from leaking into another WordPress site or a different publishing hub.

A `future` state requires an exact schedule instant. Non-future states reject `scheduledAt`. Control Room accepts local date/time input only as a convenience and immediately converts it to an exact ISO instant before the canonical mutation.

Imported WordPress posts preserve their native status. Scheduled imports normalize WordPress `date_gmt` into an exact UTC instant from canonical revision 1.

This state does not replace Blogmaatic Automation schedules. Automation determines when Blogmaatic runs; source-native state determines what WordPress status/date Blogmaatic asks WordPress to store when the matching route is compiled.

## Destination-scoped WordPress native metadata

WordPress-native editorial state is owned by the publishing destination, not by the Publication globally.

For workspace-native Publications that target one or more Publication Groups, Blogmaatic stores destination-native WordPress state under the immutable canonical `destinationOverrides` tree keyed by **Publication Group id + route id**. Group identity is part of the key because two selected groups may legitimately contain the same route id.

A WordPress route override records the route identity itself:

- extension id
- connection id
- channel / REST content type

and may independently carry:

- author
- native publishing status and schedule
- custom taxonomy selections
- REST-registered meta values
- editorial options
- hierarchical Page structure

Every route-scoped mutation requires `groupId` and `routeId` together. Before canonical persistence, the runtime verifies that the Publication targets the group, the group and route are enabled, and the route's extension, connection, and content-type channel match the requested source state. Stale workspace versions fail before mutation.

Compilation uses one precedence rule for all WordPress-native state:

1. the exact `destinationOverrides.groups[groupId].routes[routeId]` section
2. legacy singleton source metadata only when the Publication was actually imported from the same WordPress connection and imported route identity
3. otherwise no source-native value

The adapter also revalidates the stored override identity against the route being compiled. A stale or tampered override therefore fails closed rather than leaking settings to another destination.

This preserves backward compatibility for imported WordPress Publications that already use `sourceAuthor`, `sourcePublishing`, `sourceTaxonomies`, `sourceMeta`, `sourceEditorial`, and `sourcePage`, while preventing those singleton fields from acting as global defaults for workspace-native multi-destination publishing.

Control Room mirrors the same ownership model. **WordPress destination settings** renders the native controls inside each selected WordPress route card, so two sites can hold conflicting author, status, taxonomy, meta, editorial, and Page settings without overwriting one another.

Operator audit evidence includes the group and route coordinates for route-scoped native mutations, allowing an individual settings change to be traced to the exact publishing destination.

## Native WordPress editorial options

WordPress-native access, discussion, and presentation fields are modeled separately from Blogmaatic workflow status. A matching source Publication may carry `PublicationIR.attributes.sourceEditorial` with the WordPress connection, content type, post password, discussion state, sticky state, and post format.

Capability rules come from authenticated WordPress content-type discovery rather than UI assumptions:

- password protection is modeled for the source object
- comments and pingbacks/trackbacks are exposed only when the type advertises `comments` support
- post format is exposed only when the type advertises `post-formats`
- sticky state is limited to WordPress's native `post` type
- a sticky post with a non-empty password is rejected before delivery

The raw content password is intentionally absent from source-list metadata, audit evidence, and Destination Preview. Source lists expose only `passwordProtected`; the generic preview sanitizer removes password-shaped projection fields. The canonical source revision retains the password because deterministic republishing must be able to reproduce the intended WordPress access state.

Imported WordPress content preserves supported editorial values from canonical revision 1. Saving Editorial options creates a new immutable Publication revision. The source state is applied only when extension, connection, and REST content type match the publishing destination.

The semantic projection fingerprint and verified remote-state hash include password state, comment status, ping status, sticky state, and post format. Out-of-band wp-admin changes to those fields therefore become drift.

## Native WordPress Page structure

Hierarchical WordPress content types such as Pages may carry source-bound `PublicationIR.attributes.sourcePage` metadata with:

- extension id
- connection id
- WordPress REST content type
- optional parent remote id
- optional page template
- non-negative menu order

These fields are editorial properties of the matching WordPress destination. They do not alter Blogmaatic workflow status or publication-group routing.

The source-content manager validates the requested content type against live WordPress `/types?context=edit` discovery and rejects types that are unavailable or non-hierarchical. Parent selection is resolved against the same WordPress connection and REST content type. A publication cannot select its own remote object as its parent.

Imported hierarchical content preserves `parent`, `template`, and `menu_order` from canonical revision 1. Page-structure updates create immutable Publication revisions and are scoped to the exact source connection and content type.

During compile, matching source Page structure becomes WordPress `parent`, `template`, and `menu_order`. Source Page metadata is ignored for other WordPress connections or other content types. Those fields participate in the semantic projection fingerprint and verified remote-state hash, so out-of-band hierarchy, template, or ordering edits become drift.

Control Room discovers WordPress content-type capabilities and only renders the Page settings panel for hierarchical types. Parent lookup is performed through the provider-neutral source-content API, never directly from the browser to WordPress.

## Taxonomy

Tags come from Publication IR tags plus optional route tags. Categories come from `PublicationIR.attributes.categories` plus optional route categories.

Terms are looked up by stable slug. When `createMissingTerms=true`, missing terms are created. A concurrent `term_exists` response is reconciled back to the existing term id instead of failing the publication.

Content also exposes deliberate source-taxonomy creation through the provider-neutral Operator API. Authors can create a WordPress category or tag before publishing, rather than depending on publish-time auto-create. A term name is required; slug and description are optional. When the slug is omitted, Blogmaatic uses the same deterministic `termSlug()` normalization as publication-time taxonomy resolution.

Creation is idempotent by stable slug. Blogmaatic first reuses an existing matching term when found, and it also recovers a concurrent WordPress `term_exists` response by fetching the winning term id. This keeps editor-time creation and publish-time resolution on one taxonomy identity contract.

Creating a remote term does not itself create a canonical Publication revision. Control Room immediately adds the returned term name to the current editor draft; the user's normal Publication Save remains the immutable canonical content boundary.

### Route-scoped standard categories and tags

Canonical Publication categories and tags remain the shared editorial base across destinations. A selected WordPress route may additionally own per-publication category/tag additions under its exact `destinationOverrides.groups[groupId].routes[routeId].standardTaxonomy` entry.

The route-scoped record freezes:

- WordPress extension id
- connection id
- REST content type
- additional categories
- additional tags

Compilation is additive and deterministic:

1. shared canonical Publication categories/tags
2. legacy `route.variant.categories` / `route.variant.tags` additions
3. route-scoped WordPress standard-taxonomy additions

The merged names are trimmed, deduplicated and sorted. Route-scoped additions never replace shared taxonomy and never leak to another group or route, even when two Publication Groups reuse the same route id.

The compiler revalidates the stored extension, connection and content type against the route being compiled. Stale or tampered destination identity fails closed.

Content Studio exposes these additions inside each selected WordPress Destination Settings card. Authors can browse/search/create WordPress categories and tags through the existing source-taxonomy boundary, add them to that destination, remove destination-only additions, and save them as an immutable canonical Publication revision. The global Categories and Tags editor remains the shared base.

### Custom taxonomies

WordPress REST-enabled custom taxonomies are discovered dynamically instead of being hard-coded by plugin name. Blogmaatic combines the selected content type's taxonomy keys from `/types?context=edit` with definitions from `/taxonomies?context=edit`.

Each discovered taxonomy keeps two identities:

- `taxonomyKey`: semantic WordPress taxonomy identity used by canonical Blogmaatic state
- `restBase`: transport field and term endpoint used by the WordPress REST API

The discovered `rest_namespace`, hierarchy flag, associated content types, and display label are retained as source metadata. Only taxonomies attached to the selected content type are exposed. Categories and tags remain on their existing canonical fields for backward compatibility; arbitrary custom taxonomies are stored under source-bound `PublicationIR.attributes.sourceTaxonomies`.

Saving custom taxonomy selections creates an immutable Publication revision. The stored state includes extension id, connection id, content type, taxonomy key, REST base/namespace, and canonical term names. Compile uses that canonical transport metadata without requiring live discovery, while the runtime validates selections against current discovery before they enter canonical history.

During import, Blogmaatic resolves the remote term ids for each REST-enabled custom taxonomy into canonical names and preserves their taxonomy identity from revision 1. During delivery, those names are resolved through the same slug and `term_exists` recovery path used by categories and tags, then written to the dynamic WordPress post field identified by the taxonomy's REST base.

Custom taxonomy term ids participate in both the projection fingerprint and verified remote-state hash. An out-of-band taxonomy change therefore becomes drift. REST-base collisions with reserved WordPress post fields are rejected before delivery. Custom REST namespaces are supported through an authenticated namespace-aware request path rather than assuming every taxonomy lives under `wp/v2`.

## Ownership and collision protection

A stable slug is useful for rediscovery after restart, but a matching slug alone is not proof that Blogmaatic owns the remote object.

Managed posts therefore contain an HTML comment marker encoding:

- marker schema version
- Blogmaatic publication id
- route id
- projection fingerprint
- hash of the last verified WordPress state

If a slug is occupied by a post without the expected marker, inspection returns `unreachable`. The control plane will not overwrite it.

## Source content ownership

The same WordPress extension also exposes authenticated source-content operations through Blogmaatic's Operator API and Control Room. The browser never talks to WordPress directly.

Supported source operations are:

- browse/list editable posts with pagination
- search existing posts
- read an existing post in `context=edit`
- inspect WordPress-native revisions
- explicitly import/adopt an existing post into Blogmaatic
- move a Blogmaatic-managed post to Trash
- restore a managed trashed post as a draft
- permanently delete only a managed post that is already in Trash

Import is route-bound. The operator selects the Publication Group route that will own the imported WordPress object. Blogmaatic creates a canonical draft Publication, preserves the imported raw WordPress HTML as an explicit `embed.html` block, resolves category/tag names, preserves featured-media identity, installs the Blogmaatic ownership marker on the existing WordPress post, seeds projection state, and appends import evidence to publication distribution history.

The source identity `extensionId + connectionId + remoteId` is stored in publication provenance. Retrying an interrupted import recovers the same canonical publication rather than creating a second one.

Unmanaged WordPress content remains read-only until explicit import. Destructive source operations fail closed when the ownership marker is absent or belongs to another publication/route.

WordPress-native revisions are exposed as remote evidence only. They do not replace Blogmaatic's canonical immutable Publication revisions.

### Revision recovery

A WordPress-native revision may be explicitly recovered into Blogmaatic, but recovery never mutates canonical history in place and never writes back to WordPress automatically.

The restore flow is:

1. verify the canonical Publication is bound to the exact WordPress extension, connection, and remote post id
2. enforce the caller's exact workspace version before remote revision retrieval
3. fetch the selected WordPress revision in edit context
4. create a new immutable Blogmaatic Publication revision
5. replace only the recoverable editorial fields: title, excerpt/summary, and raw editable HTML body
6. preserve canonical assets, tags, taxonomy metadata, source author, native publishing state, and other provider metadata
7. record the remote post/revision identity in `PublicationIR.attributes.sourceRevisionRecovery`
8. require an explicit later publish action before WordPress is changed

Recovered WordPress HTML remains an explicit `embed.html` block so recovery does not perform a lossy HTML-to-block conversion. The Operator API audit ledger records both the remote revision identity and the resulting canonical revision/version.

## REST-registered post meta

Richer WordPress content-type fields are discovered from the authenticated REST contract rather than from plugin names.

For the selected content type, Blogmaatic requests the route with `OPTIONS` using the type's discovered REST namespace and REST base. Only writable properties exposed under the post schema's `meta.properties` object are eligible. Read-only fields are ignored.

Supported schema types are:

- string
- integer
- number
- boolean
- array
- object

Nullable unions, JSON-safe defaults, descriptions, titles, and enums are retained when WordPress exposes them. Content renders native controls for safe primitive values and explicit validated JSON editors for arrays and objects.

Blogmaatic also applies a defensive field-name filter to password, secret, token, credential, API-key, access-key, private-key, and authentication-token patterns. Those fields are not returned by source-schema discovery, are not imported, and cannot be injected into a WordPress projection through canonical `sourceMeta` state.

Selected values are stored on immutable Publication revisions under source-bound `PublicationIR.attributes.sourceMeta` with:

- extension id
- connection id
- WordPress REST content type
- managed field values

The runtime validates every requested field and value against the current authenticated WordPress schema before canonical persistence. Unknown fields, cross-site or cross-content-type state, type mismatches, and invalid enum values fail closed.

Imported WordPress content preserves only the currently eligible REST meta fields from canonical revision 1. Generic source-list responses do not expose arbitrary WordPress meta.

Compilation writes managed values through the WordPress post endpoint's `meta` object. Managed REST meta participates in the semantic projection fingerprint and verified remote-state hash. Drift compares only the keys Blogmaatic manages, so unrelated plugin or administrator meta does not create false drift.

Operator audit records field keys and resulting canonical revision identity, never field values. This base capability is plugin-neutral: ACF, Pods, Meta Box, or custom code may participate only when their values are actually registered into the ordinary authenticated WordPress REST `meta` schema.

## Drift verification

Authenticated inspection uses `context=edit` so raw editable content can be observed.

The verified remote-state hash includes:

- title
- excerpt
- slug
- status
- GMT schedule value
- body without the ownership marker
- category ids
- tag ids
- featured media id
- post author id
- parent page id
- page template
- menu order
- password state
- comment status
- ping status
- sticky state
- post format

An out-of-band edit therefore becomes drift even if the post id and ownership marker remain present.

WordPress may normalize/sanitize submitted HTML. After delivery, Blogmaatic re-reads the stored post and records the stable server representation in the marker. The receipt reports whether server normalization occurred. Subsequent edits are compared against that verified state.

## Health

Connection health verifies:

1. settings and secret-reference shape
2. secret-provider availability
3. authenticated `/users/me?context=edit`
4. authenticated edit-context access to the configured post REST base

Credentials never appear in health evidence.

## Deferred WordPress-specific work

Future WordPress slices may add explicit support for plugin-specific SEO metadata, richer relationship/media widgets for REST meta, arbitrary top-level custom REST fields, comment/engagement retrieval, and WordPress multisite routing. Those capabilities should be negotiated explicitly rather than assumed by the base REST publisher.
