import {
  createContext,
  type FormEvent,
  type PropsWithChildren,
  useContext,
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
  readonly connect: (baseUrl: string, token: string) => Promise<void>;
  readonly disconnect: () => void;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);
const defaultBaseUrl = import.meta.env.VITE_BLOGMAATIC_API_BASE?.trim() || "/api";

export function ConnectionProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<OperatorSession | null>(null);

  const value = useMemo<ConnectionContextValue>(() => ({
    session,
    connect: async (baseUrl, token) => {
      const client = new OperatorClient({ baseUrl, token });
      const health = await client.health();
      if (health.status !== "ok") throw new Error("Operator API health check did not return ok");
      await client.listAutomations({ limit: 1 });
      setSession({ client, baseUrl: client.baseUrl });
    },
    disconnect: () => setSession(null),
  }), [session]);

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionContextValue {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error("Connection context is unavailable");
  return value;
}

export function ConnectScreen() {
  const { connect } = useConnection();
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await connect(baseUrl, token);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect to the operator API");
    } finally {
      setBusy(false);
    }
  };

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
          <p className="eyebrow">Operator connection</p>
          <h1 id="connect-title">Open the live control plane.</h1>
          <p>Connect to the authenticated Operator API. Nothing on this screen creates demo state or substitutes for the durable backend.</p>
        </div>
        <form className="connect-form" onSubmit={submit}>
          <label>
            <span>Operator API</span>
            <input
              type="text"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              spellCheck={false}
              autoCapitalize="none"
              required
            />
          </label>
          <label>
            <span>Bearer token</span>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              required
            />
          </label>
          {error ? <div className="error-banner" role="alert">{error}</div> : null}
          <button className="button button--primary button--wide" type="submit" disabled={busy}>
            {busy ? "Verifying…" : "Connect"}
          </button>
        </form>
        <p className="security-note">The bearer token is held in memory only and is cleared on reload or disconnect.</p>
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
