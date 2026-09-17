import { useEffect, useMemo, useState } from "react";
import {
  registerAccount,
  signInWithUsername,
  signOutAdmin,
  createProfileRequest,
  createGameSubmission,
  listGameSubmissions,
  reviewGameSubmission,
  setProfileCustomization,
  PROFILE_ACCENTS,
} from "../authClient";

const DRAFT_KEY = "ft_guest_game_draft_v1";

function readDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { return null; }
}
function saveDraft(draft) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* shared devices may block storage */ }
}

export function AccountAuthModal({ onClose, onAuthenticated, showToast }) {
  const [mode, setMode] = useState("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault(); if (busy) return;
    setBusy(true); setError("");
    const result = mode === "signin"
      ? await signInWithUsername(username, password)
      : await registerAccount(username, password);
    setBusy(false);
    if (result.error) { setError(result.error); return; }
    onAuthenticated(result.profile);
    showToast?.(mode === "signin" ? "Signed in" : "Account created", "ok");
  }
  return <div className="account-auth">
    <div className="card-header"><h2 className="card-title">{mode === "signin" ? "Sign in" : "Create your league account"}</h2></div>
    <form onSubmit={submit} style={{padding:16}}>
      <p className="xs text-dd" style={{marginBottom:14}}>{mode === "signin" ? "Use your username and password to open your profile and submit games." : "You can browse without an account. Create one when you want to claim a profile or send a game for review."}</p>
      <div className="field"><label className="lbl" htmlFor="account-username">Username</label><input id="account-username" className="inp" autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} required /></div>
      <div className="field"><label className="lbl" htmlFor="account-password">Password</label><input id="account-password" className="inp" type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} value={password} onChange={e=>setPassword(e.target.value)} minLength={8} required /></div>
      {error && <div className="msg msg-e" role="alert">{error}</div>}
      <button className="btn btn-p w-full mt16" disabled={busy}>{busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}</button>
      <button type="button" className="btn btn-g w-full mt8" onClick={()=>{setMode(mode === "signin" ? "register" : "signin");setError("");}}>{mode === "signin" ? "Create an account" : "I already have an account"}</button>
    </form>
  </div>;
}

export function GuestAccountPrompt({ onOpenAccount, onContinue }) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem("ft_account_prompt_dismissed") === "1");
  if (dismissed) return null;
  return <aside className="account-prompt card" aria-label="Account prompt">
    <div><strong>Make this your league profile</strong><p className="xs text-dd">Claim your player, personalise your profile, and submit games for approval.</p></div>
    <div className="fac" style={{gap:8,flexWrap:"wrap"}}><button className="btn btn-p btn-sm" onClick={onOpenAccount}>Create account</button><button className="btn btn-g btn-sm" onClick={onOpenAccount}>Sign in</button><button className="btn btn-sm" onClick={()=>{localStorage.setItem("ft_account_prompt_dismissed","1");setDismissed(true);onContinue?.();}}>Continue as guest</button></div>
  </aside>;
}

const ACCENT_SWATCHES = { amber: "#e8b84a", mint: "#7cd9a5", coral: "#e08a72", violet: "#a78bd9", sky: "#6fb8d9", gold: "#d4af37" };

function ProfileCustomizationCard({ profile, showToast }) {
  const [nickname, setNickname] = useState(profile.display_nickname || "");
  const [accent, setAccent] = useState(profile.accent || "amber");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true); setSaved(false);
    const result = await setProfileCustomization(nickname.trim(), accent);
    setBusy(false);
    if (result.error) { showToast?.(result.error, "err"); return; }
    setSaved(true);
    showToast?.("Profile updated", "ok");
  }

  return (
    <section className="card account-profile-card">
      <div className="card-header">
        <h2 className="card-title">Profile</h2>
        <span className="xs text-dd">Nickname and accent color -- your canonical roster name always stays visible too.</span>
      </div>
      <div style={{ padding: 16 }}>
        <div className="profile-preview" style={{ borderColor: ACCENT_SWATCHES[accent] }}>
          <span className="profile-preview-avatar" style={{ background: ACCENT_SWATCHES[accent] }}>{(nickname || profile.username || "?").charAt(0).toUpperCase()}</span>
          <div>
            <div className="profile-preview-name">{nickname.trim() || profile.username}</div>
            <div className="xs text-dd">{profile.username}</div>
          </div>
        </div>
        <label className="field mt12">
          <span className="lbl">Nickname</span>
          <input className="inp" maxLength={24} placeholder={profile.username} value={nickname} onChange={(e) => { setNickname(e.target.value); setSaved(false); }} />
        </label>
        <div className="lbl mt12">Accent color</div>
        <div className="accent-swatches">
          {PROFILE_ACCENTS.map((a) => (
            <button
              key={a}
              type="button"
              aria-label={a}
              aria-pressed={accent === a}
              className="accent-swatch"
              style={{ background: ACCENT_SWATCHES[a] }}
              onClick={() => { setAccent(a); setSaved(false); }}
            />
          ))}
        </div>
        <button className="btn btn-p mt12" disabled={busy} onClick={save}>{busy ? "Saving…" : saved ? "Saved" : "Save profile"}</button>
      </div>
    </section>
  );
}

export function AccountWorkspace({ profile, state, showToast, onSignOut, showSubmit = false }) {
  const isStaff = ["referee", "gameadmin", "sysadmin"].includes(profile?.role);
  const [requestType, setRequestType] = useState(profile?.player_id ? "none" : "claim");
  const [selectedPlayer, setSelectedPlayer] = useState("");
  const [canonicalName, setCanonicalName] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(() => readDraft() || { sideA: [], sideB: [], scoreA: 0, scoreB: 0, playedAt: new Date().toISOString().slice(0,16) });
  const [submitMessage, setSubmitMessage] = useState("");
  const players = state?.players || [];
  const available = useMemo(() => players.filter(p => !draft.sideA.includes(p.id) && !draft.sideB.includes(p.id)), [players, draft.sideA, draft.sideB]);
  function updateDraft(next) { setDraft(next); saveDraft(next); }
  async function sendRequest() {
    if (requestType === "claim" && !selectedPlayer) return showToast?.("Choose the player profile you want to claim", "err");
    if (requestType === "create" && !canonicalName.trim()) return showToast?.("Enter the name for the new player profile", "err");
    setBusy(true);
    const result = await createProfileRequest({ type: requestType === "claim" ? "profile_claim" : "onboarding_creation", playerId: selectedPlayer || null, canonicalName: canonicalName.trim() || null });
    setBusy(false); if (result.error) return showToast?.(result.error, "err");
    showToast?.("Request sent for staff approval", "ok");
  }
  async function sendGame() {
    if (!profile?.player_id) { setSubmitMessage("Link your account to a player profile before sending a game."); return; }
    if (draft.sideA.length !== 2 || draft.sideB.length !== 2) { setSubmitMessage("Choose two players for each side."); return; }
    setBusy(true); setSubmitMessage("");
    const result = await createGameSubmission({ ...draft, playedAt: new Date(draft.playedAt).toISOString() });
    setBusy(false); if (result.error) return setSubmitMessage(result.error);
    localStorage.removeItem(DRAFT_KEY); setSubmitMessage("Game sent. It will appear in official history after review.");
    updateDraft({ sideA: [], sideB: [], scoreA: 0, scoreB: 0, playedAt: new Date().toISOString().slice(0,16) });
  }
  function addPlayer(side, id) { if (!id) return; updateDraft({...draft, [side]: [...draft[side], id]}); }
  function removePlayer(side, id) { updateDraft({...draft, [side]: draft[side].filter(x=>x!==id)}); }
  return <div className="account-workspace stack">
    <div className="page-heading"><div><h1>My account</h1><p className="xs text-dd">{profile.username}</p></div><button className="btn btn-g" onClick={onSignOut}>Sign out</button></div>
    <ProfileCustomizationCard profile={profile} showToast={showToast} />
    {!profile.player_id && <section className="card account-claim"><div className="card-header"><h2 className="card-title">Link your player profile</h2></div><div style={{padding:16}}><p className="xs text-dd">Staff approve the link so league history stays attached to the right person.</p><div className="segmented" role="group" aria-label="Profile request type"><button aria-pressed={requestType === "claim"} onClick={()=>setRequestType("claim")}>Claim existing</button><button aria-pressed={requestType === "create"} onClick={()=>setRequestType("create")}>Request new</button></div>{requestType === "claim" ? <select className="inp mt12" value={selectedPlayer} onChange={e=>setSelectedPlayer(e.target.value)}><option value="">Choose your player profile…</option>{players.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select> : <input className="inp mt12" placeholder="Canonical player name" value={canonicalName} onChange={e=>setCanonicalName(e.target.value)} />}<button className="btn btn-p mt12" disabled={busy} onClick={sendRequest}>Send for approval</button></div></section>}
    {showSubmit && !isStaff && <section className="card account-submit"><div className="card-header"><h2 className="card-title">Log game</h2><span className="tag">Staff approval</span></div><div style={{padding:16}}><p className="xs text-dd">Pending games never change the leaderboard until a Game Admin or Admin approves them.</p><div className="grid-2"><div><label className="lbl">Team A</label>{draft.sideA.map(id=><button key={id} className="player-chip" onClick={()=>removePlayer("sideA",id)}>{players.find(p=>p.id===id)?.name} ×</button>)}{draft.sideA.length < 2 && <select className="inp" value="" onChange={e=>addPlayer("sideA",e.target.value)}><option value="">Add player…</option>{available.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>}</div><div><label className="lbl">Team B</label>{draft.sideB.map(id=><button key={id} className="player-chip" onClick={()=>removePlayer("sideB",id)}>{players.find(p=>p.id===id)?.name} ×</button>)}{draft.sideB.length < 2 && <select className="inp" value="" onChange={e=>addPlayer("sideB",e.target.value)}><option value="">Add player…</option>{available.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>}</div></div><div className="grid-2 mt12"><label className="field"><span className="lbl">Team A score</span><input className="inp" type="number" min="0" max="99" value={draft.scoreA} onChange={e=>updateDraft({...draft,scoreA:Number(e.target.value)})}/></label><label className="field"><span className="lbl">Team B score</span><input className="inp" type="number" min="0" max="99" value={draft.scoreB} onChange={e=>updateDraft({...draft,scoreB:Number(e.target.value)})}/></label></div><label className="field mt12"><span className="lbl">Played at</span><input className="inp" type="datetime-local" value={draft.playedAt} onChange={e=>updateDraft({...draft,playedAt:e.target.value})}/></label>{submitMessage && <div className="msg msg-s mt12">{submitMessage}</div>}<button className="btn btn-p mt12" disabled={busy || !profile.player_id} onClick={sendGame}>{busy ? "Sending…" : "Log game"}</button></div></section>}</div>;
}

export function SubmissionReviewPanel({ showToast }) {
  const [items, setItems] = useState(null); const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  async function load() { const r = await listGameSubmissions(); if (r.error) { setError(r.error); setItems([]); } else { setError(""); setItems(r.submissions); } }
  useEffect(()=>{ load(); }, []);
  async function review(id, status) { setBusy(id); const r = await reviewGameSubmission(id, status); setBusy(""); if (r.error) showToast?.(r.error,"err"); else { showToast?.(`Game ${status}`,"ok"); load(); } }
  return <div className="card" style={{marginTop:12}}><div className="card-header"><h2 className="card-title">Game submissions</h2><button className="btn btn-sm btn-g" onClick={load}>Refresh</button></div><div style={{padding:16}}>{error && <div className="msg msg-e">{error}</div>}{items === null && <div className="xs text-dd">Loading…</div>}{items?.length === 0 && !error && <div className="xs text-dd">No pending submissions.</div>}{items?.map(item=><div className="submission-row" key={item.id}><div><strong>{item.submitter_username || "Player"}</strong><div className="xs text-dd">{new Date(item.played_at).toLocaleString()} · {item.payload?.scoreA}–{item.payload?.scoreB}</div></div><div className="fac"><button className="btn btn-sm btn-p" disabled={busy===item.id} onClick={()=>review(item.id,"approved")}>Approve</button><button className="btn btn-sm btn-d" disabled={busy===item.id} onClick={()=>review(item.id,"rejected")}>Reject</button></div></div>)}</div></div>;
}







