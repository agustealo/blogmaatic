export function normalizeHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1);
  return trimmed;
}

export function canonicalLoopbackHost(host: string): "127.0.0.1" | "::1" {
  const normalized = normalizeHost(host).toLowerCase();
  if (normalized === "localhost" || normalized === "127.0.0.1") return "127.0.0.1";
  if (normalized === "::1") return "::1";
  throw new Error(`Host must be loopback: ${host}`);
}

export function socketAddress(host: string, port: number): string {
  const normalized = normalizeHost(host);
  return normalized.includes(":") ? `[${normalized}]:${port}` : `${normalized}:${port}`;
}

export function httpOrigin(host: string, port: number): string {
  return `http://${socketAddress(host, port)}`;
}
