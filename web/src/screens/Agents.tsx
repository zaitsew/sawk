import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { MCP_URL } from "../lib/env";
import { useToast } from "../lib/toast";
import type { Run, TokenCreated, TokenRow } from "../types";

type Tab = "claude-code" | "codex" | "connector";

const TABS: { id: Tab; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "connector", label: "ChatGPT · Claude.ai · Grok" },
];

export function snippet(tab: Tab, token: string | null): string {
  const t = token ?? "<your-token>";
  if (tab === "claude-code") {
    return `claude mcp add --transport http --scope user sawk ${MCP_URL} --header "Authorization: Bearer ${t}"`;
  }
  if (tab === "codex") {
    return `# ~/.codex/config.toml\n[mcp_servers.sawk]\nurl = "${MCP_URL}"\nbearer_token_env_var = "SAWK_TOKEN"\n\n# in your shell profile\nexport SAWK_TOKEN="${t}"`;
  }
  return MCP_URL;
}

function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const toast = useToast();
  return (
    <button type="button" className="btn" onClick={async () => toast({ message: (await copyText(text)) ? "Copied." : "Could not copy. Select the text and copy it.", ms: 2500 })}>
      {label}
    </button>
  );
}

function Code({ text }: { text: string }) {
  return (
    <div className="code-block">
      <pre tabIndex={0}><code>{text}</code></pre>
      <Copy text={text} />
    </div>
  );
}

function Connect() {
  const [tab, setTab] = useState<Tab>("claude-code");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<TokenCreated | null>(null);
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const toast = useToast();

  const loadTokens = useCallback(async () => {
    try { setTokens(await api.tokens()); } catch (e) { setError(e instanceof ApiError ? e.message : "Could not load tokens."); setTokens([]); }
  }, []);
  useEffect(() => { void loadTokens(); }, [loadTokens]);

  async function create(ev: FormEvent) {
    ev.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError(null);
    try {
      const t = await api.createToken(name.trim());
      setFresh(t);
      setName("");
      await loadTokens();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not create the token. Try again."); }
    finally { setBusy(false); }
  }

  async function revoke(t: TokenRow) {
    try {
      await api.revokeToken(t.id);
      if (fresh?.id === t.id) setFresh(null);
      setRevoking(null);
      toast({ message: `Revoked ${t.name}.`, ms: 3000 });
      await loadTokens();
    } catch (e) { toast({ message: e instanceof ApiError ? e.message : "Could not revoke. Try again.", ms: 4000 }); }
  }

  return (
    <>
      <h2 className="section-title">Connect an agent</h2>
      <p className="caption">Agents run on your own subscription, usually overnight. They read your profile, find events and rank them for you.</p>

      <div className="seg" role="tablist" aria-label="Agent">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls="agent-panel" className="seg-btn" onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div id="agent-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="stack">
        {tab === "connector" ? (
          <>
            <p>Add a custom connector with this address, then sign in with your Loco account. No token needed.</p>
            <Code text={MCP_URL} />
            <p className="caption">ChatGPT: Settings, Connectors, add custom. Claude.ai: Settings, Connectors, add custom. Grok: Connectors, add MCP server.</p>
          </>
        ) : (
          <>
            <p>{tab === "claude-code" ? "Run this once in a terminal." : "Add this to Codex, then export the token."} You need a token first.</p>
            <Code text={snippet(tab, fresh?.token ?? null)} />
          </>
        )}
      </div>

      {tab !== "connector" && (
        <form onSubmit={create} className="stack token-form">
          <div className="field">
            <label className="label" htmlFor="tname">Token name</label>
            <div className="row">
              <input id="tname" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Laptop, nightly run" maxLength={60} />
              <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create token"}</button>
            </div>
          </div>
        </form>
      )}

      {fresh && (
        <div className="notice" role="status">
          <p><strong>Copy this token now.</strong> It is shown once. The snippet above already has it.</p>
          <Code text={fresh.token} />
          <button type="button" className="btn btn-quiet" onClick={() => setFresh(null)}>I have copied it</button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      <h3 className="label list-label">Your tokens</h3>
      {tokens == null ? <div className="card skeleton short" aria-busy="true" /> : tokens.length === 0 ? (
        <p className="caption">No tokens yet. Connectors that sign in with Loco do not need one.</p>
      ) : (
        <ul className="rows">
          {tokens.map((t) => (
            <li key={t.id} className="row-item">
              <div>
                <p className="row-title">{t.name}</p>
                <p className="caption">{t.prefix}… · created {ago(t.createdAt)} · {t.lastUsedAt ? `used ${ago(t.lastUsedAt)}` : "never used"}</p>
              </div>
              {revoking === t.id ? (
                <div className="row">
                  <button type="button" className="btn btn-danger" onClick={() => void revoke(t)}>Revoke {t.name}</button>
                  <button type="button" className="btn btn-quiet" onClick={() => setRevoking(null)}>Keep</button>
                </div>
              ) : (
                <button type="button" className="btn btn-quiet" onClick={() => setRevoking(t.id)} aria-label={`Revoke ${t.name}`}>Revoke</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const STATUS: Record<Run["status"], string> = { ok: "OK", partial: "Partial", failed: "Failed", running: "Running" };

function Runs() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setRuns(await api.runs(20)); } catch (e) { setError(e instanceof ApiError ? e.message : "Could not load runs."); setRuns((r) => r ?? []); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const last = runs?.find((r) => r.agent !== "ingest") ?? null;

  return (
    <>
      <h2 className="section-title">Runs</h2>
      {runs == null ? <div className="card skeleton short" aria-busy="true" /> : (
        <>
          <p className="caption" role="status">
            {last
              ? `Last agent run: ${ago(last.startedAt)}, ${STATUS[last.status].toLowerCase()}.`
              : "No agent has run yet. Connect one above; the first run adds events and ranks them."}
          </p>
          {error && <p className="error" role="alert">{error} <button type="button" className="link" onClick={() => void load()}>Retry</button></p>}
          {runs.length > 0 && (
            <ul className="rows">
              {runs.map((r) => (
                <li key={r.id} className="row-item run">
                  <div>
                    <p className="row-title">
                      {r.agent}{r.model ? <span className="muted"> · {r.model}</span> : null}
                    </p>
                    <p className="caption">
                      <time dateTime={r.startedAt} title={new Date(r.startedAt).toLocaleString()}>{ago(r.startedAt)}</time>
                      {" · "}+{r.eventsAdded} events · {r.ranked} ranked{r.cities.length ? ` · ${r.cities.join(", ")}` : ""}
                    </p>
                    {r.notes && <p className="caption">{r.notes}</p>}
                  </div>
                  <span className={`status status-${r.status}`}>{STATUS[r.status]}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

export function Agents() {
  return (
    <section aria-labelledby="agents-h">
      <header className="screen-head"><h1 id="agents-h" className="screen-title">Agents</h1></header>
      <Connect />
      <Runs />
    </section>
  );
}
