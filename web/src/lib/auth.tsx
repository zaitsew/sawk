import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { setApiAuth } from "./api";
import { clearSnapshot } from "./cache";
import { CONFIGURED, MOCK } from "./env";
import { supabase } from "./supabase";

export type AuthStatus = "loading" | "signedOut" | "signedIn" | "unconfigured";

interface AuthValue {
  status: AuthStatus;
  userId: string | null;
  email: string | null;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthValue>({ status: "loading", userId: null, email: null, signOut: async () => {} });
export const useAuth = () => useContext(Ctx);

/** `?signedout=1` in mock mode shows the sign-in screen (for screenshots). */
const mockSignedOut = () => MOCK && new URLSearchParams(location.search).get("signedout") === "1";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [mockOut, setMockOut] = useState(mockSignedOut);

  useEffect(() => {
    if (!supabase) { setReady(true); return; }
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      setReady(true);
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  const signOut = useCallback(async () => {
    clearSnapshot();
    if (MOCK) { setMockOut(true); return; }
    await supabase?.auth.signOut();
    setSession(null);
  }, []);

  useEffect(() => {
    setApiAuth({
      getToken: async () => {
        if (!supabase) return null;
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token ?? null;
      },
      onUnauthorized: () => { void signOut(); },
    });
  }, [signOut]);

  const value = useMemo<AuthValue>(() => {
    if (MOCK) {
      return mockOut
        ? { status: "signedOut", userId: null, email: null, signOut }
        : { status: "signedIn", userId: "sample-user", email: "sample@example.com", signOut };
    }
    if (!CONFIGURED) return { status: "unconfigured", userId: null, email: null, signOut };
    if (!ready) return { status: "loading", userId: null, email: null, signOut };
    return session
      ? { status: "signedIn", userId: session.user.id, email: session.user.email ?? null, signOut }
      : { status: "signedOut", userId: null, email: null, signOut };
  }, [session, ready, mockOut, signOut]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
