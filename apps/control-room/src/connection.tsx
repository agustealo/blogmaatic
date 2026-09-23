import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { OperatorClient } from "@blogmaatic/operator-client";

interface OperatorSession {
  readonly client: OperatorClient;
  readonly baseUrl: string;
}

interface ConnectionContextValue {
  readonly session: OperatorSession | null;
  readonly connect: () => Promise<void>;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);
const localProxyBaseUrl = "/api";
const sessionProofStorageKey = "blogmaatic.control-room.session-proof";

function localSessionProof(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const parameters = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const fromLaunch = parameters.get("session")?.trim();
  if (fromLaunch) {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(fromLaunch)) throw new Error("Control Room launch proof is malformed");
    window.sessionStorage.setItem(sessionProofStorageKey, fromLaunch);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    return fromLaunch;
  }
  const stored = window.sessionStorage.getItem(sessionProofStorageKey)?.trim();
  return stored && /^[A-Za-z0-9_-]{32,128}$/.test(stored) ? stored : undefined;
}

export function ConnectionProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<OperatorSession | null>(null);

  const connect = useCallback(async () => {
    const client = new OperatorClient({
      baseUrl: localProxyBaseUrl,
      ...(localSessionProof() ? { sessionProof: localSessionProof() } : {}),
    });
    const health = await client.health();
    if (health.status !== "ok") throw new Error("Operator API health check did not return ok");
    await client.listAutomations({ limit: 1 });
    setSession({ client, baseUrl: client.baseUrl });
  }, []);

  const value = useMemo<ConnectionContextValue>(() => ({ session, connect }), [connect, session]);
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionContextValue {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error("Connection context is unavailable");
  return value;
}

export function ConnectScreen() {
  const { connect } = useConnection();
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setBusy(true);
    setError(null);
    void connect()
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Could not connect to the local operator runtime");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => { active = false; };
  }, [attempt, connect]);

  return (
    <main className="connect-layout">
      <section className="connect-card" aria-labelledby="connect-title">
        <div className="brand-lockup brand-lockup--large">
          <span className="brand-mark" aria-hidden="true">B</span>
          <div>
            <strong>Blogmaatic</strong>
            <span>Control Room</span>
          </div>
        </div>
        <div className="connect-copy">
          <p className="eyebrow">Local runtime</p>
          <h1 id="connect-title">{busy ? "Opening the control plane…" : error ? "The local runtime needs attention." : "Opening the control plane…"}</h1>
          <p>The bundled Control Room authenticates through Blogmaatic's loopback runtime. The Operator API bearer stays server-side; the browser keeps only an origin-scoped runtime session proof.</p>
        </div>
        {error ? (
          <>
            <div className="error-banner" role="alert">{error}</div>
            <button className="button button--primary button--wide" type="button" onClick={() => setAttempt((value) => value + 1)} disabled={busy}>
              Retry local connection
            </button>
          </>
        ) : null}
        <p className="security-note">Operator authority is injected only after the HttpOnly session cookie and the origin-bound browser proof both validate.</p>
      </section>
      <aside className="connect-aside" aria-label="Control Room capabilities">
        <div className="connect-aside__glow" />
        <p className="eyebrow">Live authority</p>
        <h2>Operate what actually exists.</h2>
        <ul className="feature-list">
          <li><span>01</span> Current Restate execution truth</li>
          <li><span>02</span> Approval and delivery attention</li>
          <li><span>03</span> Versioned automation controls</li>
          <li><span>04</span> Append-only audit evidence</li>
        </ul>
      </aside>
    </main>
  );
}
