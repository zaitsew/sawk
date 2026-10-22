import { useEffect, useState, type FormEvent } from "react";
import { ChipInput } from "../components/ChipInput";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useData } from "../lib/data";
import { viewerTz } from "../lib/days";
import { useToast } from "../lib/toast";
import type { Profile as ProfileT } from "../types";

const EMPTY: ProfileT = {
  homeCity: null, homeCountry: null, homeTz: null, langs: [], likes: [], avoids: [],
  notes: "", priceMax: null, currency: "EUR", maxPerDay: 3,
};

function zones(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    return f ? f("timeZone") : [];
  } catch { return []; }
}

export function Profile() {
  const { profile, setProfile, load } = useData();
  const { email, signOut } = useAuth();
  const toast = useToast();
  const [draft, setDraft] = useState<ProfileT>(profile ?? EMPTY);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Take the loaded profile in, unless the person has started editing.
  useEffect(() => { if (profile && !dirty) setDraft(profile); }, [profile, dirty]);

  const set = <K extends keyof ProfileT>(k: K, v: ProfileT[K]) => { setDraft((d) => ({ ...d, [k]: v })); setDirty(true); };

  async function onSave(ev: FormEvent) {
    ev.preventDefault();
    setSaving(true); setError(null);
    try {
      const { updatedAt: _u, ...body } = draft;
      const saved = await api.saveProfile(body);
      setProfile(saved);
      setDraft(saved);
      setDirty(false);
      toast({ message: "Profile saved.", ms: 3000 });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save. Check your connection and try again.");
    } finally { setSaving(false); }
  }

  const text = (v: string | null) => v ?? "";
  const orNull = (v: string) => (v.trim() === "" ? null : v.trim());

  return (
    <section aria-labelledby="profile-h">
      <header className="screen-head"><h1 id="profile-h" className="screen-title">Profile</h1></header>
      {load === "loading" && !profile ? <div className="card skeleton" aria-busy="true" /> : (
        <form onSubmit={onSave} className="stack">
          <p className="caption">Your agents read this before every run. The more specific, the better the picks.</p>

          <fieldset className="group">
            <legend className="label">Where you live</legend>
            <div className="field">
              <label className="label" htmlFor="city">City</label>
              <input id="city" className="input" value={text(draft.homeCity)} onChange={(e) => set("homeCity", orNull(e.target.value))} autoComplete="address-level2" />
            </div>
            <div className="grid2">
              <div className="field">
                <label className="label" htmlFor="country">Country code</label>
                <input id="country" className="input" maxLength={2} value={text(draft.homeCountry)} placeholder="ES" onChange={(e) => set("homeCountry", orNull(e.target.value.toUpperCase()))} autoComplete="country" />
              </div>
              <div className="field">
                <label className="label" htmlFor="tz">Time zone</label>
                <input id="tz" className="input" list="tzs" value={text(draft.homeTz)} placeholder={viewerTz()} onChange={(e) => set("homeTz", orNull(e.target.value))} autoCapitalize="off" />
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
