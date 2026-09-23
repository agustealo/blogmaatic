import { createServer as createHttp2Server, type Http2Server } from "node:http2";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as restate from "@restatedev/restate-sdk";

import { createKernelAutomationPublisher } from "@blogmaatic/automation";
import {
  RestateAutomationLauncher,
  createPublicationAutomationWorkflow,
} from "@blogmaatic/automation-restate";
import { AutomationControlPlane, SqliteControlPlaneStore } from "@blogmaatic/control-plane";
import { PolicyEngine, PublicationKernel } from "@blogmaatic/core";
import {
  FACEBOOK_CONNECTION_CONTRACT,
  FacebookPagesPublisher,
} from "@blogmaatic/extension-facebook-pages";
import {
  JEKYLL_CONNECTION_CONTRACT,
  JekyllGitPublisher,
} from "@blogmaatic/extension-jekyll-git";
import {
  LINKEDIN_CONNECTION_CONTRACT,
  LinkedInRestPublisher,
} from "@blogmaatic/extension-linkedin-rest";
import { ConnectionAuthority, ExtensionRuntime } from "@blogmaatic/extension-sdk";
import {
  WORDPRESS_CONNECTION_CONTRACT,
  WordPressRestPublisher,
} from "@blogmaatic/extension-wordpress-rest";
import { StaticBearerAuthorizer, closeOperatorApi, startOperatorApi } from "@blogmaatic/operator-api";
import {
  EnvironmentSecretProvider,
  OsCredentialSecretProvider,
  SecretAuthority,
  type SecretProvider,
} from "@blogmaatic/secrets";
import { SqliteProjectionStateStore } from "@blogmaatic/state-sqlite";

import type { RuntimeConfig, RuntimePaths } from "./config.js";
import { ConnectionManager } from "./connection-manager.js";
import { ControlRoomServer } from "./control-room-server.js";
import { canonicalLoopbackHost, httpOrigin, normalizeHost } from "./network.js";
import { ManagedRestateServer, runLocalCommand, waitForTcp } from "./processes.js";
import { SchedulerLoop } from "./scheduler.js";

export interface RunningRuntime {
  readonly operatorAddress: string;
  readonly controlRoomAddress: string;
  readonly controlRoomLaunchAddress: string;
  readonly fatal: Promise<never>;
  close(): Promise<void>;
}

function controlRoomDist(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../control-room/dist");
}

function createSecretAuthority(): SecretAuthority {
  const providers: SecretProvider[] = [new EnvironmentSecretProvider()];
  if (process.platform === "darwin" || process.platform === "linux") {
    providers.push(new OsCredentialSecretProvider());
  }
  return new SecretAuthority(providers);
}

export async function inspectConfiguredConnections(
  extensions: ExtensionRuntime,
  connections: ConnectionAuthority,
  logger: Pick<Console, "info" | "error">,
): Promise<void> {
  for (const connection of connections.list()) {
    try {
      const validation = await extensions.validateConnection(connection.id);
      if (!validation.valid) {
        logger.error(`Connection ${connection.id} is invalid: ${validation.errors.join("; ")}`);
        continue;
      }
      if (connection.status !== "active") continue;
      const health = await extensions.checkHealth(connection.id);
      if (health.state === "unhealthy") {
        logger.error(`Connection ${connection.id} is unhealthy: ${health.detail}`);
      } else if (health.state === "degraded") {
        logger.info(`Connection ${connection.id} is degraded: ${health.detail}`);
      }
    } catch (error) {
      logger.error(`Connection ${connection.id} could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function startWorkflowEndpoint(workflow: ReturnType<typeof createPublicationAutomationWorkflow>, host: string, port: number): Promise<Http2Server> {
  const handler = restate.createEndpointHandler({ services: [workflow] });
  const server = createHttp2Server(handler);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  return server;
}

async function closeHttp2(server: Http2Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

function managedRestateAddresses(config: RuntimeConfig): { ingressHost: string; ingressPort: number; adminHost: string; adminPort: number } {
  const ingress = new URL(config.restate.ingressUrl);
  const admin = new URL(config.restate.adminUrl);
  if (ingress.protocol !== "http:" || admin.protocol !== "http:") {
    throw new Error("managed-local Restate URLs must use plain HTTP loopback endpoints");
  }
  const ingressPort = Number(ingress.port || "80");
  const adminPort = Number(admin.port || "80");
  const ingressHost = canonicalLoopbackHost(normalizeHost(ingress.hostname));
  const adminHost = canonicalLoopbackHost(normalizeHost(admin.hostname));
  if (ingressPort !== 8080 || adminPort !== 9070) {
    throw new Error("managed-local Restate currently owns canonical ports 8080 and 9070; use restate.mode=external for custom ports");
  }
  return { ingressHost, ingressPort, adminHost, adminPort };
}

async function registerManagedDeployment(config: RuntimeConfig): Promise<void> {
  const deploymentUrl = httpOrigin(config.restate.workflowHost, config.restate.workflowPort);
  await runLocalCommand("restate", ["deployments", "register", deploymentUrl, "--yes"]);
}

export async function startRuntime(options: {
  readonly config: RuntimeConfig;
  readonly paths: RuntimePaths;
  readonly operatorToken: string;
  readonly controlRoomRoot?: string;
  readonly logger?: Pick<Console, "info" | "error">;
}): Promise<RunningRuntime> {
  const { config, paths } = options;
  const logger = options.logger ?? console;
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.restateDataDir, { recursive: true, mode: 0o700 });

  let managedRestate: ManagedRestateServer | undefined;
  let workflowServer: Http2Server | undefined;
  let operator: Awaited<ReturnType<typeof startOperatorApi>> | undefined;
  let controlRoom: ControlRoomServer | undefined;
  let scheduler: SchedulerLoop | undefined;
  let controlPlaneStore: SqliteControlPlaneStore | undefined;
  let projectionState: SqliteProjectionStateStore | undefined;

  try {
    if (config.restate.mode === "managed-local") {
      const addresses = managedRestateAddresses(config);
      managedRestate = await ManagedRestateServer.start({ dataDir: paths.restateDataDir, ...addresses });
    } else {
      const ingress = new URL(config.restate.ingressUrl);
      const port = Number(ingress.port || (ingress.protocol === "https:" ? "443" : "80"));
      await waitForTcp(normalizeHost(ingress.hostname), port, 5000);
    }

    const connections = new ConnectionAuthority(config.connections);
    const secrets = createSecretAuthority();
    const extensions = new ExtensionRuntime(connections);
    extensions.registerPublisher(new JekyllGitPublisher(connections), JEKYLL_CONNECTION_CONTRACT);
    extensions.registerPublisher(
      new WordPressRestPublisher(connections, secrets),
      WORDPRESS_CONNECTION_CONTRACT,
    );
    extensions.registerPublisher(
      new LinkedInRestPublisher(connections, secrets),
      LINKEDIN_CONNECTION_CONTRACT,
    );
    extensions.registerPublisher(
      new FacebookPagesPublisher(connections, secrets),
      FACEBOOK_CONNECTION_CONTRACT,
    );
    await inspectConfiguredConnections(extensions, connections, logger);
    const connectionManager = new ConnectionManager({
      config,
      configPath: paths.configPath,
      connections,
      extensions,
      secrets,
      logger,
    });

    projectionState = new SqliteProjectionStateStore(paths.projectionStatePath);
    const kernel = new PublicationKernel(
      extensions.publishers,
      new PolicyEngine(config.policies),
      undefined,
      projectionState,
    );
    const workflow = createPublicationAutomationWorkflow({
      publisher: createKernelAutomationPublisher(kernel),
    });
    workflowServer = await startWorkflowEndpoint(workflow, config.restate.workflowHost, config.restate.workflowPort);
    if (config.restate.mode === "managed-local") await registerManagedDeployment(config);

    const runtime = new RestateAutomationLauncher({ url: config.restate.ingressUrl });
    controlPlaneStore = new SqliteControlPlaneStore(paths.controlPlanePath);
    const controlPlane = new AutomationControlPlane({ store: controlPlaneStore, launcher: runtime });
    operator = await startOperatorApi({
      controlPlane,
      store: controlPlaneStore,
      runtime,
      connections: connectionManager,
      authorizer: new StaticBearerAuthorizer([{
        id: config.operator.principalId,
        token: options.operatorToken,
        permissions: ["*"],
        roles: ["*"],
      }]),
      logger: false,
    }, config.operator);

    scheduler = new SchedulerLoop({
      controlPlane,
      pollMs: config.scheduler.pollMs,
      batchSize: config.scheduler.batchSize,
      onError: (error) => logger.error(`Scheduler dispatch failed: ${error.message}`),
    });

    controlRoom = await ControlRoomServer.start({
      root: options.controlRoomRoot ?? controlRoomDist(),
      host: config.controlRoom.host,
      port: config.controlRoom.port,
      operatorOrigin: operator.address.replace(/\/$/, ""),
      operatorToken: options.operatorToken,
    });

    // Startup becomes externally active only after every fallible listener is ready.
    // This prevents due schedules from publishing during a startup that later fails.
    scheduler.start();

    const fatal = managedRestate?.fatal ?? new Promise<never>(() => undefined);
    let closed = false;
    return {
      operatorAddress: operator.address,
      controlRoomAddress: controlRoom.address,
      controlRoomLaunchAddress: controlRoom.launchAddress,
      fatal,
      close: async () => {
        if (closed) return;
        closed = true;
        await scheduler?.close();
        if (controlRoom) await controlRoom.close();
        if (operator) await closeOperatorApi(operator.app);
        if (workflowServer) await closeHttp2(workflowServer);
        if (managedRestate) await managedRestate.close();
        projectionState?.close();
        controlPlaneStore?.close();
      },
    };
  } catch (error) {
    await scheduler?.close().catch(() => undefined);
    if (controlRoom) await controlRoom.close().catch(() => undefined);
    if (operator) await closeOperatorApi(operator.app).catch(() => undefined);
    if (workflowServer) await closeHttp2(workflowServer).catch(() => undefined);
    if (managedRestate) await managedRestate.close().catch(() => undefined);
    projectionState?.close();
    controlPlaneStore?.close();
    throw error;
  }
}
