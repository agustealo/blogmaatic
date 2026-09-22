# Facebook Pages Extension

`@blogmaatic/extension-facebook-pages` is Blogmaatic's fourth real publishing-hub proof and the first Meta Graph API publisher.

## API contract

The connector pins Graph API `v26.0` by default. The version is explicit connection configuration so deployments do not silently float when Meta changes defaults.

A connection contains a numeric Page id and an opaque `pageAccessToken` secret reference. Raw Page access tokens never live in connection settings, publication groups, projections, receipts, or health evidence.

Production Graph roots must use HTTPS. Loopback HTTP is accepted only for local integration tests and development.

## Publication modes

The extension consumes the provider-neutral `@blogmaatic/variants` result and supports three Page projection modes:

- `text` — commentary-only Page feed post
- `link` — commentary plus the canonical URL as the Page feed link
- `image` — commentary plus one or more uploaded images attached to one Page feed post

Image mode uses unpublished Page photo uploads followed by `attached_media` assembly on the Page feed. Remote HTTP(S) images use Meta's URL upload path. Managed local images are read only from configured real-path roots.

Supported local media types are JPEG, PNG, GIF, BMP, and TIFF, with a 10 MB file-size ceiling. Local source-machine paths are represented as managed asset identities in projection semantics and are never emitted into public post content.

## Scheduling

A route may set `variant.scheduledAt`. Scheduled feed posts are created unpublished with `scheduled_publish_time` and `unpublished_content_type=SCHEDULED`. Images used by a scheduled post are uploaded as temporary unpublished Page photos.

## Identity and verification

Facebook supplies the Page Post id after creation. Blogmaatic stores that id through the canonical `ProjectionStateStore`; the connector never searches the feed and adopts a similar post heuristically.

The stored remote identity also carries a Blogmaatic verification baseline containing both:

- the desired projection fingerprint at successful delivery
- the hash of the observed remote Page Post state immediately after delivery

Later inspection re-reads the exact recorded Page Post. Changes to message, link, attached-media identities, scheduled state, or the desired Blogmaatic projection produce `drifted` rather than being silently accepted.

## Immutable drift policy

Meta's current Graph API Post reference does not expose a safe general in-place update contract for Page Post projections. Blogmaatic therefore does not treat Facebook drift as automatically repairable.

The core now offers an optional provider-neutral `planDriftReconciliation()` hook. Facebook returns `blocked` for drift with an explicit reason. This keeps reconciliation honest and prevents hidden delete/recreate behavior that could reset engagement or create duplicates if a replacement workflow crashes between operations.

Future replacement behavior, if added, must be an explicit policy with approval and crash-safe compensation rather than an implicit update.

## Health

Health checks validate the secret reference, resolve the Page identity, and confirm that the Page feed is readable with the configured Page token. Publish-time authorization failures still fail closed because Meta app review, Page tasks, and permission grants remain external authority.

## Fidelity

The extension inherits the shared social fidelity engine. Unsupported or flattened content, dropped images, and commentary truncation remain visible in the fidelity report, and routes can enforce a minimum fidelity threshold before any Graph mutation occurs.
