export interface SecretProvider {
  readonly scheme: string;
  resolve(locator: string): Promise<Uint8Array | undefined>;
}

export interface MutableSecretProvider extends SecretProvider {
  store(locator: string, material: Uint8Array): Promise<void>;
  delete(locator: string): Promise<boolean>;
}

function parseReference(reference: string): { scheme: string; locator: string } {
  const separator = reference.indexOf(":");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error("Invalid secret reference format");
  }
  const scheme = reference.slice(0, separator);
  const locator = reference.slice(separator + 1);
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
    throw new Error(`Invalid secret reference scheme: ${scheme}`);
  }
  return { scheme, locator };
}

function isMutable(provider: SecretProvider): provider is MutableSecretProvider {
  const candidate = provider as Partial<MutableSecretProvider>;
  return typeof candidate.store === "function" && typeof candidate.delete === "function";
}

export class SecretAuthority {
  readonly #providers = new Map<string, SecretProvider>();

  constructor(providers: readonly SecretProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: SecretProvider): void {
    if (!/^[a-z][a-z0-9+.-]*$/.test(provider.scheme)) {
      throw new Error(`Invalid secret provider scheme: ${provider.scheme}`);
    }
    if (this.#providers.has(provider.scheme)) {
      throw new Error(`Secret provider already registered: ${provider.scheme}`);
    }
    this.#providers.set(provider.scheme, provider);
  }

  hasProvider(scheme: string): boolean {
    return this.#providers.has(scheme);
  }

  validateReference(reference: string): void {
    const { scheme } = parseReference(reference);
    if (!this.#providers.has(scheme)) {
      throw new Error(`No secret provider registered for scheme: ${scheme}`);
    }
  }

  async withUtf8<T>(reference: string, callback: (value: string) => Promise<T> | T): Promise<T> {
    const { scheme, locator } = parseReference(reference);
    const provider = this.#providers.get(scheme);
    if (!provider) throw new Error(`No secret provider registered for scheme: ${scheme}`);
    const material = await provider.resolve(locator);
    if (!material || material.byteLength === 0) {
      throw new Error(`Secret is unavailable for reference: ${scheme}:[redacted]`);
    }
    try {
      const value = new TextDecoder().decode(material);
      return await callback(value);
    } finally {
      material.fill(0);
    }
  }

  async storeUtf8(reference: string, value: string): Promise<void> {
    const { scheme, locator } = parseReference(reference);
    const provider = this.#providers.get(scheme);
    if (!provider) throw new Error(`No secret provider registered for scheme: ${scheme}`);
    if (!isMutable(provider)) throw new Error(`Secret provider is read-only: ${scheme}`);
    const material = new TextEncoder().encode(value);
    if (material.byteLength === 0) throw new Error("Secret value must not be empty");
    try {
      await provider.store(locator, material);
    } finally {
      material.fill(0);
    }
  }

  async delete(reference: string): Promise<boolean> {
    const { scheme, locator } = parseReference(reference);
    const provider = this.#providers.get(scheme);
    if (!provider) throw new Error(`No secret provider registered for scheme: ${scheme}`);
    if (!isMutable(provider)) throw new Error(`Secret provider is read-only: ${scheme}`);
    return provider.delete(locator);
  }
}

export class EnvironmentSecretProvider implements SecretProvider {
  readonly scheme = "env";
  readonly #environment: NodeJS.ProcessEnv;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.#environment = environment;
  }

  async resolve(locator: string): Promise<Uint8Array | undefined> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(locator)) {
      throw new Error("Environment secret locator must be a valid environment variable name");
    }
    const value = this.#environment[locator];
    return value === undefined ? undefined : new TextEncoder().encode(value);
  }
}

export * from "./os-vault.js";
