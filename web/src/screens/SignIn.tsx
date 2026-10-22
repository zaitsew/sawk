import { useState, type FormEvent } from "react";
import { OAUTH } from "../lib/env";
import { supabase } from "../lib/supabase";

type Stage = { kind: "email" } | { kind: "code"; email: string };

export function SignIn() {
  const [stage, setStage] = useState<Stage>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAgain, setSentAgain] = useState(false);

  const say = (m: string) => (/rate|limit|seconds/i.test(m) ? "Too many tries. Wait a minute, then try again." : m);

  async function sendCode(address: string) {
    if (!supabase) return;
    setBusy(true); setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({ email: address, options: { shouldCreateUser: true } });
    setBusy(false);
    if (err) { setError(say(err.message)); return false; }
    return true;
  }

  async function onEmail(ev: FormEvent) {
    ev.preventDefault();
    const address = email.trim().toLowerCase();
    if (!address) return;
    if (await sendCode(address)) { setStage({ kind: "code", email: address }); setCode(""); }
  }

  async function verify(token: string, address: string) {
    if (!supabase) return;
    setBusy(true); setError(null);
    const { error: err } = await supabase.auth.verifyOtp({ email: address, token, type: "email" });
    setBusy(false);
    if (err) setError("That code did not work. Check it, or send a new one.");
  }

  async function onCode(ev: FormEvent) {
    ev.preventDefault();
    if (stage.kind === "code" && code.length === 6) await verify(code, stage.email);
  }

  async function oauth(provider: "google" | "apple") {
    if (!supabase) return;
    setError(null);
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider, options: { redirectTo: `${location.origin}${import.meta.env.BASE_URL}` },
    });
    if (err) setError(err.message);
  }

  return (
    <main className="signin">
      <h1 className="wordmark">SAWk</h1>
      <p className="tagline">For the socially awkward: what's on, offline, where you'll be — picked for you.</p>

      {stage.kind === "email" ? (
        <form onSubmit={onEmail} className="stack" noValidate>
          <div className="field">
            <label htmlFor="email" className="label">Email</label>
            <input
              id="email" className="input" type="email" inputMode="email" autoComplete="email" autoFocus required
              value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || !email.trim()}>{busy ? "Sending…" : "Send code"}</button>
          {OAUTH && (
            <>
              <p className="divider"><span>or</span></p>
              <button type="button" className="btn" onClick={() => oauth("google")}>Continue with Google</button>
              <button type="button" className="btn" onClick={() => oauth("apple")}>Continue with Apple</button>
            </>
          )}
        </form>
      ) : (
        <form onSubmit={onCode} className="stack">
          <p>We sent a 6-digit code to <strong>{stage.email}</strong>.</p>
          <div className="field">
            <label htmlFor="code" className="label">Code</label>
            <input
              id="code" className="input input-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} autoFocus
              value={code}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                setCode(v);
                if (v.length === 6) void verify(v, stage.email);
              }}
              placeholder="123456"
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Sign in"}</button>
          <div className="row">
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={async () => { if (await sendCode(stage.email)) setSentAgain(true); }}>Send new code</button>
            <button type="button" className="btn btn-quiet" onClick={() => { setStage({ kind: "email" }); setError(null); setSentAgain(false); }}>Change email</button>
          </div>
          {sentAgain && <p className="caption" role="status">New code sent.</p>}
        </form>
      )}

      {error && <p className="error" role="alert">{error}</p>}

      <p className="caption note">SAWk uses your Loco account. Same email, same account: if you already use Loco, you are already in. New here? We make one for you.</p>
    </main>
  );
}
