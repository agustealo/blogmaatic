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
- `article.inspect`
- `article.draft`
- `article.schedule`
- `asset.publish`
- `taxonomy.publish`

It intentionally does not claim `canonical.publish` because WordPress core does not provide a universal canonical-URL write contract independent of SEO plugins/themes.

## Compilation

Publication IR is rendered into deterministic HTML. Text is escaped by default. Explicit `embed.html` blocks remain deliberate raw HTML supplied by the publication model.

The projection fingerprint covers title, excerpt, stable slug, desired status/schedule, HTML template, taxonomy names, featured-asset selection, and managed-asset byte fingerprints.

Local assets must resolve inside an allowlisted `assetSourceRoots` entry. Local paths are never written into WordPress content.

## Media

Local assets are uploaded through `/wp/v2/media`.

The media slug includes publication id, asset id, and a prefix of the asset-content hash. This makes retries idempotent for unchanged bytes and gives changed bytes a new remote media identity. Alt text is applied after media creation.

HTTP(S) publication assets remain external URLs and are not downloaded by Blogmaatic, avoiding an implicit server-side URL fetch surface.

A featured asset must resolve to a managed WordPress media item because WordPress `featured_media` requires an attachment id.

## Taxonomy

Tags come from Publication IR tags plus optional route tags. Categories come from `PublicationIR.attributes.categories` plus optional route categories.

Terms are looked up by stable slug. When `createMissingTerms=true`, missing terms are created. A concurrent `term_exists` response is reconciled back to the existing term id instead of failing the publication.

## Ownership and collision protection

A stable slug is useful for rediscovery after restart, but a matching slug alone is not proof that Blogmaatic owns the remote object.

Managed posts therefore contain an HTML comment marker encoding:

- marker schema version
- Blogmaatic publication id
- route id
- projection fingerprint
- hash of the last verified WordPress state

If a slug is occupied by a post without the expected marker, inspection returns `unreachable`. The control plane will not overwrite it.

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

A future WordPress slice may add explicit support for plugin-specific SEO metadata, custom taxonomies, custom post-type schemas, comment/engagement retrieval, deletion/trash policies, and WordPress multisite routing. Those capabilities should be negotiated explicitly rather than assumed by the base REST publisher.
