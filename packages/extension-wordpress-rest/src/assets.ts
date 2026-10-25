import { readFile } from "node:fs/promises";

import type { Publication } from "@blogmaatic/core";
import { planImageTransform, type ImageTransformSpec } from "@blogmaatic/media";

import { sha256 } from "./fingerprint.js";
import { approvedLocalPath } from "./path-safety.js";
import type { CompiledWordPressAsset, WordPressSettings } from "./types.js";

export async function compileAssets(
  publication: Publication,
  settings: WordPressSettings,
  transformSpec?: ImageTransformSpec,
  destinationConnectionId?: string,
): Promise<readonly CompiledWordPressAsset[]> {
  const compiled: CompiledWordPressAsset[] = [];
  for (const asset of publication.current.content.assets) {
    if (/^https?:\/\//i.test(asset.source)) {
      const attributes = asset.attributes;
      const sourceConnectionId =
        attributes && typeof attributes.sourceConnectionId === "string"
          ? attributes.sourceConnectionId
          : undefined;
      const legacyConnectionId =
        publication.provenance.extensionId === "blogmaatic.wordpress-rest" &&
        typeof publication.provenance.connectionId === "string"
          ? publication.provenance.connectionId
          : undefined;
      const connectionOwnsMedia =
        destinationConnectionId !== undefined &&
        (sourceConnectionId === destinationConnectionId ||
          (sourceConnectionId === undefined && legacyConnectionId === destinationConnectionId));
      const wordpressMediaId =
        connectionOwnsMedia &&
        attributes &&
        typeof attributes.wordpressMediaId === "number" &&
        Number.isSafeInteger(attributes.wordpressMediaId) &&
        attributes.wordpressMediaId > 0
          ? attributes.wordpressMediaId
          : undefined;
      compiled.push({
        assetId: asset.id,
        source: asset.source,
        ...(asset.mediaType ? { mediaType: asset.mediaType } : {}),
        ...(asset.alt ? { alt: asset.alt } : {}),
        ...(wordpressMediaId === undefined ? {} : { wordpressMediaId }),
      });
      continue;
    }
    const localPath = await approvedLocalPath(asset.source, settings.assetSourceRoots);
    const bytes = await readFile(localPath);
    let transform;
    if (asset.kind === "image" && transformSpec) {
      transform = planImageTransform({ bytes, spec: transformSpec });
      if (asset.mediaType && asset.mediaType !== transform.source.mediaType) {
        throw new Error(
          `WordPress image mediaType ${asset.mediaType} does not match detected bytes ${transform.source.mediaType}`,
        );
      }
    }
    compiled.push({
      assetId: asset.id,
      source: asset.source,
      localPath,
      fingerprint: transform?.transformationFingerprint ?? sha256(bytes),
      ...(transform ? { mediaType: transform.output.mediaType, transform } : asset.mediaType ? { mediaType: asset.mediaType } : {}),
      ...(asset.alt ? { alt: asset.alt } : {}),
    });
  }
  return compiled;
}
