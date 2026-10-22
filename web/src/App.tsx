import { Nav } from "./components/Nav";
import { AuthProvider, useAuth } from "./lib/auth";
import { DataProvider } from "./lib/data";
import { MOCK } from "./lib/env";
import { useRoute } from "./lib/route";
import { ToastProvider } from "./lib/toast";
import { Agents } from "./screens/Agents";
import { Feed } from "./screens/Feed";
import { Profile } from "./screens/Profile";
import { SignIn } from "./screens/SignIn";

function Shell() {
  const [route, go] = useRoute();
  return (
    <div className="app">
      <Nav route={route} go={go} />
      <main className="content" id="main">
        {MOCK && <p className="sample-banner" role="note"><strong>Sample</strong> data, local development only. Nothing here is real.</p>}
        {route === "feed" && <Feed goAgents={() => go("agents")} />}
        {route === "profile" && <Profile />}
        {route === "agents" && <Agents />}
      </main>
    </div>
  );
}

function Gate() {
  const { status } = useAuth();
  if (status === "loading") return <div className="boot" aria-busy="true" aria-label="Loading" />;
  if (status === "unconfigured") {
    return (
      <main className="signin">
        <h1 className="wordmark">SAWk</h1>
        <p className="error" role="alert">This build has no Supabase project set. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY and build again.</p>
      </main>
    );
  }
  if (status === "signedOut") return <SignIn />;
  return <DataProvider><Shell /></DataProvider>;
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Gate />
      </ToastProvider>
    </AuthProvider>
  );
}
