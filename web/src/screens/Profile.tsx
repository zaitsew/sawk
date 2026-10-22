import { useEffect, useState, type FormEvent } from "react";
import { ChipInput } from "../components/ChipInput";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useData } from "../lib/data";
import { viewerTz } from "../lib/days";
import { useToast } from "../lib/toast";
import { buildPatch, toDraft, type ProfileDraft } from "../lib/profileDraft";

function zones(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    return f ? f("timeZone") : [];
  } catch { return []; }
}

export function Profile() {
  const { profile, setProfile, load, profileError, refresh, refreshing } = useData();
  const { email, signOut } = useAuth();
  const toast = useToast();
  const [draft, setDraft] = useState<ProfileDraft | null>(profile ? toDraft(profile) : null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Take the loaded profile in, unless the person has started editing.
  useEffect(() => { if (profile && !dirty) setDraft(toDraft(profile)); }, [profile, dirty]);

  const set = <K extends keyof ProfileDraft>(k: K, v: ProfileDraft[K]) => {
    setDraft((d) => (d ? { ...d, [k]: v } : d));
    setDirty(true);
  };

  async function onSave(ev: FormEvent) {
    ev.preventDefault();
    // No form without a loaded profile, and the save carries only what changed.
    if (!profile || !draft) return;
    const patch = buildPatch(profile, draft);
    if (Object.keys(patch).length === 0) { setDirty(false); return; }
    setSaving(true); setError(null);
    try {
      const saved = await api.saveProfile(patch);
      setProfile(saved);
      setDraft(toDraft(saved));
      setDirty(false);
      toast({ message: "Profile saved.", ms: 3000 });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save. Check your connection and try again.");
    } finally { setSaving(false); }
  }

  const waiting = load === "loading" || refreshing;

  // Trim a text field once the person leaves it, not on every keystroke.
  const trimOnBlur = (k: "homeCity" | "homeCountry" | "homeTz") => () => {
    setDraft((d) => (d && d[k] !== d[k].trim() ? { ...d, [k]: d[k].trim() } : d));
  };

  return (
    <section aria-labelledby="profile-h">
      <header className="screen-head"><h1 id="profile-h" className="screen-title">Profile</h1></header>
      {!profile && waiting && <div className="card skeleton" aria-busy="true" />}
      {!profile && !waiting && (
        <div className="empty" role="alert">
          <p>{profileError ?? error ?? "Could not load your profile."} Your saved preferences are untouched.</p>
          <button type="button" className="btn btn-primary" onClick={() => void refresh()}>Retry</button>
        </div>
      )}
      {profile && draft && (
        <form onSubmit={onSave} className="stack">
          <p className="caption">Your agents read this before every run. The more specific, the better the picks.</p>

          <fieldset className="group">
            <legend className="label">Where you live</legend>
            <div className="field">
              <label className="label" htmlFor="city">City</label>
              <input id="city" className="input" value={draft.homeCity} onChange={(e) => set("homeCity", e.target.value)} onBlur={trimOnBlur("homeCity")} autoComplete="address-level2" />
            </div>
            <div className="grid2">
              <div className="field">
                <label className="label" htmlFor="country">Country code</label>
                <input id="country" className="input" maxLength={2} value={draft.homeCountry} placeholder="ES" onChange={(e) => set("homeCountry", e.target.value.toUpperCase())} onBlur={trimOnBlur("homeCountry")} autoComplete="country" />
              </div>
              <div className="field">
                <label className="label" htmlFor="tz">Time zone</label>
                <input id="tz" className="input" list="tzs" value={draft.homeTz} placeholder={viewerTz()} onChange={(e) => set("homeTz", e.target.value)} onBlur={trimOnBlur("homeTz")} autoCapitalize="off" />
                <datalist id="tzs">{zones().map((z) => <option key={z} value={z} />)}</datalist>
              </div>
            </div>
          </fieldset>

          <ChipInput label="Languages" hint="Events in these languages rank higher. Use codes like en, es." values={draft.langs} onChange={(v) => set("langs", v)} placeholder="es" />
          <ChipInput label="Likes" values={draft.likes} onChange={(v) => set("likes", v)} placeholder="jazz, small rooms, markets" />
          <ChipInput label="Avoids" values={draft.avoids} onChange={(v) => set("avoids", v)} placeholder="clubs, stand-up" />

          <div className="field">
            <label className="label" htmlFor="notes">Tell your agents what you like</label>
            <textarea id="notes" className="input" rows={5} value={draft.notes} maxLength={2000}
              placeholder="Anything that helps: how far you will travel, what makes an evening good, what ruins it."
              onChange={(e) => set("notes", e.target.value)} />
          </div>

          <div className="grid2">
            <div className="field">
              <label className="label" htmlFor="cap">Price cap ({draft.currency})</label>
              <input id="cap" className="input" type="number" inputMode="decimal" min={0} step="1" value={draft.priceMax ?? ""} placeholder="No cap"
                onChange={(e) => set("priceMax", e.target.value === "" ? null : Math.max(0, Number(e.target.value)))} />
            </div>
            <div className="field">
              <label className="label" htmlFor="cur">Currency</label>
              <input id="cur" className="input" maxLength={3} value={draft.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} autoCapitalize="characters" />
            </div>
          </div>

          <div className="field">
            <label className="label" htmlFor="per">Items per day</label>
            <select id="per" className="input" value={draft.maxPerDay} onChange={(e) => set("maxPerDay", Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <p className="caption">More are one tap away under “N more”.</p>
          </div>

          {error && <p className="error" role="alert">{error}</p>}
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={saving || !dirty}>{saving ? "Saving…" : "Save profile"}</button>
          </div>
        </form>
      )}

      <div className="account">
        <p className="caption">{email ? <>Signed in as {email}.</> : "Signed in."} Same account as Loco.</p>
        <button type="button" className="btn btn-quiet" onClick={() => void signOut()}>Sign out</button>
      </div>
    </section>
  );
}
