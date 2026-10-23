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

Future WordPress slices may add explicit support for plugin-specific SEO metadata, custom taxonomies, richer custom post-type schemas, comment/engagement retrieval, and WordPress multisite routing. Those capabilities should be negotiated explicitly rather than assumed by the base REST publisher.
