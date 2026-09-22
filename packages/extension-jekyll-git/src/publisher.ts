import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type {
  CompiledProjection,
  DeliveryRequest,
  DeliveryResult,
  InspectProjectionInput,
  JsonValue,
  ObservedProjection,
  Publication,
  PublicationRoute,
  RemoteIdentity,
} from "@blogmaatic/core";
import {
  ConnectionAuthority,
  type ConnectionRecord,
  type ConnectionValidation,
  type ExtensionHealth,
  type ManagedPublisherExtension,
} from "@blogmaatic/extension-sdk";

import { assetOperations } from "./assets.js";
import {
  combinedFingerprint,
  documentWithFingerprint,
  fingerprint,
  stripFingerprint,
} from "./fingerprint.js";
import {
  atomicCopy,
  atomicWrite,
  exists,
  git,
  remoteContainsProjectionCommits,
  restoreSnapshots,
  runJekyllBuild,
  snapshot,
  targetDirty,
} from "./git-repository.js";
import {
  canonicalDocument,
  projectionPublicUrl,
  relativeDocumentPath,
} from "./markdown.js";
import { safeRepositoryPath } from "./path-safety.js";
import { parsePayload } from "./payload.js";
import { JEKYLL_GIT_EXTENSION_ID, parseSettings } from "./settings.js";
import type { AssetOperation } from "./types.js";

export class JekyllGitPublisher implements ManagedPublisherExtension {
  readonly manifest = {
    apiVersion: 1,
    kind: "publisher",
    connectionSchemaVersion: 1,
    id: JEKYLL_GIT_EXTENSION_ID,
    displayName: "Jekyll / Git",
    version: "0.1.0",
    capabilities: [
      "article.create",
      "article.update",
      "article.inspect",
      "article.draft",
      "asset.publish",
      "taxonomy.publish",
      "canonical.publish",
    ],
  } as const;

  readonly #connections: ConnectionAuthority;

  constructor(connections: ConnectionAuthority) {
    this.#connections = connections;
  }

  async validateConnection(connection: ConnectionRecord): Promise<ConnectionValidation> {
    const errors: string[] = [];
    try {
      const settings = parseSettings(connection);
      if (!(await exists(settings.repositoryPath))) {
        errors.push("repositoryPath does not exist");
      }
      if (settings.assetSourceRoots.some((root) => !isAbsolute(root))) {
        errors.push("assetSourceRoots must contain only absolute paths");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return { valid: errors.length === 0, errors };
  }

  async checkHealth(connection: ConnectionRecord): Promise<ExtensionHealth> {
    const checkedAt = new Date().toISOString();
    const validation = await this.validateConnection(connection);
    if (!validation.valid) {
      return { state: "unhealthy", checkedAt, detail: validation.errors.join("; ") };
    }
    const settings = parseSettings(connection);
    try {
      const inside = await git(settings.repositoryPath, ["rev-parse", "--is-inside-work-tree"]);
      if (inside !== "true") {
        return { state: "unhealthy", checkedAt, detail: "repositoryPath is not a Git work tree" };
      }
      if (!(await exists(join(settings.repositoryPath, "_config.yml")))) {
        return { state: "unhealthy", checkedAt, detail: "Jekyll _config.yml is missing" };
      }
      const branch = await git(settings.repositoryPath, ["branch", "--show-current"]);
      if (branch !== settings.branch) {
        return {
          state: "unhealthy",
          checkedAt,
          detail: `Expected Git branch ${settings.branch}, found ${branch || "detached HEAD"}`,
        };
      }
      if (settings.push) {
        const remotes = (await git(settings.repositoryPath, ["remote"])).split("\n").filter(Boolean);
        if (!remotes.includes(settings.remote)) {
          return {
            state: "unhealthy",
            checkedAt,
            detail: `Git remote is missing: ${settings.remote}`,
          };
        }
      }
      const dirty = (await git(settings.repositoryPath, ["status", "--porcelain"])).length > 0;
      return {
        state: dirty ? "degraded" : "healthy",
        checkedAt,
        detail: dirty
          ? "Git work tree has uncommitted changes"
          : "Jekyll repository and Git branch are ready",
        evidence: {
          branch,
          push: settings.push,
          buildVerification: settings.buildVerification,
        },
      };
    } catch (error) {
      return {
        state: "unhealthy",
        checkedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async compile({
    publication,
    route,
  }: {
    publication: Publication;
    route: PublicationRoute;
  }): Promise<CompiledProjection> {
    const connection = this.#connections.requireActive(
      JEKYLL_GIT_EXTENSION_ID,
      route.destination.connectionId,
    );
    const settings = parseSettings(connection);
    const assets = await assetOperations(publication, settings);
    const publishedAssets = new Map(
      assets.map((asset) => [asset.assetId, `/${asset.relativePath}`] as const),
    );
    const canonical = canonicalDocument(publication, route, publishedAssets);
    const documentFingerprint = fingerprint(canonical);
    const hash = combinedFingerprint(documentFingerprint, assets);
    const relativePath = relativeDocumentPath(publication, route, settings);
    const url = projectionPublicUrl(route, settings);
    const payload: Readonly<Record<string, JsonValue>> = {
      relativePath,
      content: documentWithFingerprint(canonical, hash),
      assets: assets.map((asset) => ({
        assetId: asset.assetId,
        sourcePath: asset.sourcePath,
        relativePath: asset.relativePath,
        fingerprint: asset.fingerprint,
      })),
      ...(url ? { publicUrl: url } : {}),
    };
    return {
      projectionId: `${publication.id}:${route.id}`,
      publicationId: publication.id,
      sourceRevisionId: publication.current.id,
      routeId: route.id,
      destination: route.destination,
      payload,
      fingerprint: hash,
    };
  }

  async inspect(input: InspectProjectionInput): Promise<ObservedProjection> {
    const connection = this.#connections.requireActive(
      JEKYLL_GIT_EXTENSION_ID,
      input.projection.destination.connectionId,
    );
    const settings = parseSettings(connection);
    const payload = parsePayload(input.projection);
    const relativePath = input.remote?.id ?? payload.relativePath;
    const target = safeRepositoryPath(settings.repositoryPath, relativePath);
    const observedAt = new Date().toISOString();

    try {
      const health = await this.checkHealth(connection);
      if (health.state === "unhealthy") {
        return { state: "unreachable", observedAt, detail: health.detail };
      }
      if (!(await exists(target))) return { state: "missing", observedAt };

      const projectionPaths = [relativePath, ...payload.assets.map((asset) => asset.relativePath)];
      if (await targetDirty(settings.repositoryPath, projectionPaths)) {
        return {
          state: "unreachable",
          observedAt,
          detail: `Target has uncommitted local changes: ${relativePath}`,
        };
      }

      const content = await readFile(target, "utf8");
      const documentFingerprint = fingerprint(stripFingerprint(content));
      const actualAssets: AssetOperation[] = [];
      for (const asset of payload.assets) {
        const assetTarget = safeRepositoryPath(settings.repositoryPath, asset.relativePath);
        if (!(await exists(assetTarget))) {
          return {
            state: "drifted",
            observedAt,
            detail: `Published asset is missing: ${asset.relativePath}`,
          };
        }
        actualAssets.push({
          ...asset,
          fingerprint: fingerprint(await readFile(assetTarget)),
        });
      }
      const actualFingerprint = combinedFingerprint(documentFingerprint, actualAssets);

      let version: string | undefined;
      try {
        version = await git(settings.repositoryPath, ["log", "-1", "--format=%H", "--", relativePath]);
      } catch {
        version = undefined;
      }

      if (settings.push) {
        try {
          const remoteState = await remoteContainsProjectionCommits(
            settings.repositoryPath,
            settings.remote,
            settings.branch,
            projectionPaths,
          );
          if (!remoteState.synced) {
            return {
              state: "drifted",
              observedAt,
              fingerprint: actualFingerprint,
              remote: {
                id: relativePath,
                ...(payload.publicUrl ? { url: payload.publicUrl } : {}),
                version: remoteState.remoteSha,
              },
              detail: "Local Jekyll projection has not reached the configured Git remote branch",
            };
          }
          version = remoteState.remoteSha;
        } catch (error) {
          return {
            state: "unreachable",
            observedAt,
            detail: `Cannot verify Git remote: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      const remote: RemoteIdentity = {
        id: relativePath,
        ...(payload.publicUrl ? { url: payload.publicUrl } : {}),
        ...(version ? { version } : {}),
      };
      return {
        state:
          actualFingerprint === input.projection.fingerprint ? "synchronized" : "drifted",
        observedAt,
        fingerprint: actualFingerprint,
        remote,
      };
    } catch (error) {
      return {
        state: "unreachable",
        observedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async deliver(request: DeliveryRequest): Promise<DeliveryResult> {
    const connection = this.#connections.requireActive(
      JEKYLL_GIT_EXTENSION_ID,
      request.projection.destination.connectionId,
    );
    const settings = parseSettings(connection);
    const payload = parsePayload(request.projection);
    const target = safeRepositoryPath(settings.repositoryPath, payload.relativePath);
    const assetTargets = payload.assets.map((asset) => ({
      ...asset,
      target: safeRepositoryPath(settings.repositoryPath, asset.relativePath),
    }));
    const changedPaths = [payload.relativePath, ...assetTargets.map((asset) => asset.relativePath)];

    const health = await this.checkHealth(connection);
    if (health.state === "unhealthy") {
      throw new Error(`Jekyll/Git connection is unhealthy: ${health.detail}`);
    }
    if (await targetDirty(settings.repositoryPath, changedPaths)) {
      throw new Error("Delivery refused because a target path has uncommitted local changes");
    }

    const snapshots = await Promise.all(
      [target, ...assetTargets.map((asset) => asset.target)].map(snapshot),
    );
    let committed = false;
    try {
      await atomicWrite(target, payload.content);
      for (const asset of assetTargets) {
        await atomicCopy(asset.sourcePath, asset.target);
      }

      if (settings.buildVerification === "bundle") {
        await runJekyllBuild(settings.repositoryPath);
      }

      await git(settings.repositoryPath, ["add", "--", ...changedPaths]);
      let hasStagedChanges = true;
      try {
        await git(settings.repositoryPath, ["diff", "--cached", "--quiet", "--", ...changedPaths]);
        hasStagedChanges = false;
      } catch {
        hasStagedChanges = true;
      }

      if (hasStagedChanges) {
        const env = {
          GIT_AUTHOR_NAME: settings.authorName,
          GIT_AUTHOR_EMAIL: settings.authorEmail,
          GIT_COMMITTER_NAME: settings.authorName,
          GIT_COMMITTER_EMAIL: settings.authorEmail,
        };
        await git(
          settings.repositoryPath,
          [
            "commit",
            "-m",
            `Blogmaatic: publish ${request.projection.publicationId}`,
            "--",
            ...changedPaths,
          ],
          env,
        );
        committed = true;
      }
    } catch (error) {
      if (!committed) {
        try {
          await git(settings.repositoryPath, ["reset", "--quiet", "HEAD", "--", ...changedPaths]);
        } catch {
          // Snapshot restoration remains authoritative when HEAD does not yet exist.
        }
        await restoreSnapshots(snapshots);
      }
      throw error;
    }

    if (settings.push) {
      await git(settings.repositoryPath, ["push", settings.remote, settings.branch]);
    }

    const commitSha = await git(settings.repositoryPath, ["rev-parse", "HEAD"]);
    return {
      remote: {
        id: payload.relativePath,
        ...(payload.publicUrl ? { url: payload.publicUrl } : {}),
        version: commitSha,
      },
      acceptedAt: new Date().toISOString(),
      evidence: {
        commitSha,
        relativePath: payload.relativePath,
        pushed: settings.push,
        idempotencyKey: request.idempotencyKey,
      },
    };
  }
}
