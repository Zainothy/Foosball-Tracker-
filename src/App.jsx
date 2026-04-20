import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { supabase } from './supabaseClient';

const CONFIG = {
  ADMIN_PASSWORD: "RankUp26",
  STARTING_MMR: 1000,
  STARTING_PTS: 0,
  BASE_GAIN: 22,
  BASE_LOSS: 12,
  SCORE_WEIGHT: 1.4,
  SCORE_EXP: 1.4,
  ELO_DIVISOR: 250,
  RANK_WEIGHT: 0.4,
  RANK_DIVISOR: 5,
  STREAK_POWER_SCALE: 3.0,
  STREAK_WIN_MAX: 0.55,
  STREAK_LOSS_MAX: 0.35,
  STREAK_QUALITY_DECAY: 0.82,
  STREAK_DECAY_THRESHOLD: 1.05,
  STREAK_WINDOW: 8,
  LOSS_HARSHNESS: 1.08,
  ROLE_ALIGN_BONUS: 1.12,
  MAX_PLACEMENTS_PER_MONTH: 5,
  YELLOW_CARD_PTS: 5,
  RED_CARD_PTS: 20,
};

const SYNC_DEBUG = true;
const BACKUP_MIN_INTERVAL_MS = 10 * 60 * 1000;
const BACKUP_RETENTION_DAYS = 30;
const BACKUP_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CLIENT_ID_KEY = "ft_client_id";
const LAST_BACKUP_KEY = "ft_last_backup_at";
const LAST_BACKUP_CLEANUP_KEY = "ft_last_backup_cleanup_at";
const ANN_DISMISS_PREFIX = "ft_ann_dismissed_";

const TABS = ["ranks", "history", "stats", "seasons", "play", "rules"];
const TAB_LABELS = { ranks: "Ranks", history: "History", stats: "Stats", seasons: "Seasons", play: "Champions", rules: "Rules" };
const LOCALE = "en-GB";
const MS_PER_DAY = 86400000;

function readLocalNumber(key, fallback = 0) {
  if (typeof localStorage === "undefined") return fallback;
  const raw = localStorage.getItem(key);
  const n = raw ? Number(raw) : fallback;
  return Number.isFinite(n) ? n : fallback;
}
function writeLocalNumber(key, value) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, String(value));
}
function getDateStamp() { return new Date().toISOString().slice(0, 10); }
function getPlayerById(playerId, players) { return players?.find(p => p.id === playerId); }
function getWinnerAndLoserSides(game) {
  const winners = game.winner === "A" ? game.sideA : game.sideB;
  const losers = game.winner === "A" ? game.sideB : game.sideA;
  return { winners, losers };
}
function isPlayerOnSideA(playerId, game) { return game.sideA?.includes(playerId); }
function didPlayerWin(playerId, game) {
  const onA = isPlayerOnSideA(playerId, game);
  return (onA && game.winner === "A") || (!onA && game.winner === "B");
}
function sortByDate(items, descending = false) {
  return [...items].sort((a, b) => descending ? new Date(b.date) - new Date(a.date) : new Date(a.date) - new Date(b.date));
}
function sortByPoints(players, descending = true) {
  return [...players].sort((a, b) => descending ? (b.pts || 0) - (a.pts || 0) : (a.pts || 0) - (b.pts || 0));
}
function getSelectedSeason(filter, currentSeason, allSeasons) {
  if (filter === "all") return null;
  if (filter === "current") return currentSeason;
  return (allSeasons || []).find(s => s.id === filter) || null;
}
function buildPlayerNameMap(players) { return new Map((players || []).map(p => [p.id, p.name])); }
function getClientId() {
  if (typeof localStorage === "undefined") return "server";
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    const rand = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `c_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    id = rand;
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}
function isAnnouncementActive(ann, now = Date.now()) {
  if (!ann?.body || !ann?.startsAt || !ann?.endsAt) return false;
  const start = Date.parse(ann.startsAt);
  const end = Date.parse(ann.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return now >= start && now <= end;
}
function getActiveAnnouncement(state, dismissedIds = [], now = Date.now()) {
  const all = [...(state.announcementQueue || []), ...(state.announcement ? [state.announcement] : [])];
  const actives = all.filter(ann => {
    if (dismissedIds.includes(ann.id)) return false;
    if (ann.sticky) return true;
    return isAnnouncementActive(ann, now);
  });
  if (!actives.length) return null;
  return actives.sort((a, b) => (a.priority || 3) - (b.priority || 3) || new Date(a.createdAt || 0) - new Date(b.createdAt || 0))[0];
}
function downloadText(filename, text, mime = "text/plain") {
  if (typeof document === "undefined") return;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function toCsv(rows) {
  return rows.map(row => row.map(cell => { const safe = String(cell ?? "").replace(/"/g, '""'); return `"${safe}"`; }).join(",")).join("\n");
}
function exportStateJson(state) {
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(`foosball-state-${stamp}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), state }, null, 2), "application/json");
}
function exportPlayersCsv(state, seasonFilter = null) {
  const currentSeason = seasonFilter === null ? getCurrentSeason(state) : seasonFilter;
  const scopedGames = (state.games || []).filter(g => seasonFilter === "all" ? true : gameInSeason(g, currentSeason));
  const scopedStats = computeWindowPlayerStats(state.players, scopedGames);
  const rows = [
    ["id", "name", "pts", "mmr", "mmr_atk", "mmr_def", "preferredRole", "wins", "losses", "wins_atk", "losses_atk", "wins_def", "losses_def", "streak"],
    ...(state.players || []).map(p => {
      const stats = scopedStats[p.id] || { wins: 0, losses: 0, streak: 0, pts: 0 };
      return [p.id, p.name, stats.pts||0, p.mmr??CONFIG.STARTING_MMR, p.mmr_atk??p.mmr??CONFIG.STARTING_MMR, p.mmr_def??p.mmr??CONFIG.STARTING_MMR, p.preferredRole??"FLEX", stats.wins||0, stats.losses||0, p.wins_atk??0, p.losses_atk??0, p.wins_def??0, p.losses_def??0, stats.streak||0];
    })
  ];
  const seasonLabel = seasonFilter === "all" ? "all-time" : (currentSeason?.label || "current");
  downloadText(`foosball-players-${seasonLabel}-${new Date().toISOString().slice(0,10)}.csv`, toCsv(rows), "text/csv");
}
function exportGamesCsv(state, seasonFilter = null) {
  const currentSeason = seasonFilter === null ? getCurrentSeason(state) : seasonFilter;
  const scopedGames = (state.games || []).filter(g => seasonFilter === "all" ? true : gameInSeason(g, currentSeason));
  const nameById = new Map((state.players || []).map(p => [p.id, p.name]));
  const prefRole = new Map((state.players || []).map(p => [p.id, p.preferredRole || "FLEX"]));
  const rows = [
    ["game_id","date","score_winner","score_loser","player_id","player_name","side","role","preferred_role","role_aligned","won","delta_pts","elo_scale","rank_scale","match_quality","score_mult","streak_mult","role_mult","opp_a_name","opp_b_name","partner_name"]
  ];
  const sorted = [...scopedGames].sort((a,b) => new Date(a.date)-new Date(b.date));
  for (const g of sorted) {
    const allIds = [...(g.sideA||[]), ...(g.sideB||[])];
    for (const pid of allIds) {
      const side = (g.sideA||[]).includes(pid) ? "A" : "B";
      const won = (side==="A" && g.winner==="A") || (side==="B" && g.winner==="B");
      const delta = won ? (g.perPlayerGains?.[pid] ?? g.ptsGain ?? "") : -(g.perPlayerLosses?.[pid] ?? g.ptsLoss ?? "");
      const f = g.perPlayerFactors?.[pid] || {};
      const role = g.roles?.[pid] || "";
      const pref = prefRole.get(pid) || "FLEX";
      const aligned = role && pref !== "FLEX" ? (role === pref ? "1" : "0") : "";
      const teammates = ((side==="A" ? g.sideA : g.sideB)||[]).filter(id=>id!==pid).map(id=>nameById.get(id)||id);
      const opps = ((side==="A" ? g.sideB : g.sideA)||[]).map(id=>nameById.get(id)||id);
      const winScore = Math.max(g.scoreA||0, g.scoreB||0);
      const losScore = Math.min(g.scoreA||0, g.scoreB||0);
      rows.push([g.id, g.date, winScore, losScore, pid, nameById.get(pid)||pid, side, role, pref, aligned, won?"1":"0", delta, f.eloScale??"", f.rankScale??"", f.matchQuality??"", f.scoreMult??"", f.streakMultVal??"", f.roleMult??"", opps[0]||"", opps[1]||"", teammates[0]||""]);
    }
  }
  const seasonLabel = seasonFilter === "all" ? "all-time" : (currentSeason?.label || "current");
  downloadText(`foosball-games-${seasonLabel}-${new Date().toISOString().slice(0,10)}.csv`, toCsv(rows), "text/csv");
}

const DEFAULT_RULES = `# Rulebook

## Overview
This is the official ranked table football leaderboard. Games are logged by admins and affect your points and hidden MMR.

## Players & Teams
- All players are ranked individually.
- Teams are formed per game — you can play with anyone.
- Each player has **${CONFIG.MAX_PLACEMENTS_PER_MONTH} placement games** per season.

## Scoring
- A standard game is played to **10 goals**.
- No draws — there must be a winner.
- Score is logged by an admin immediately after the game.
- A 9-9 outcome **must** be resolved in *deuce* 
### Deuce: 
- Players continue until one team leads by 2 goals (e.g. 11-9, 12-10).
## Gameplay Nuances: 
- The ball may not be blown during play. Dead balls must be resolved through a new serve. 
- Unsportsmanlike conduct (e.g. intentional stalling, disrespect) may lead to penalties or disqualification at the admin's discretion. 
- Pinches slamming the ball against the side walls of the table are not allowed, as they damage the table springs. **Note:** Inwards passes between players are valid, this foul only applies when the ball is slammed against side walls.
- No spins. 
- Intentional stalling (e.g. holding the ball without playing, excessively delaying serves) is not allowed and may be penalized by admins.

## Points
- **Points** are your visible leaderboard score. Everyone starts at 0.
- Points gained depend on the score difference and the hidden MMR gap between sides.
- Points lost depend on the score difference and the points gap between you and your opponent.
- Winning streaks amplify gains. Losing streaks amplify losses.

## Positions (ATK / DEF)
Each player is assigned a position for every game: **Attacker** or **Defender**.

- **Attacker (🗡 ATK)** — controls the 3-bar (strikers) and 5-bar (midfield). Primary role: score goals.
- **Defender (🛡 DEF)** — controls the 2-bar (defence) and 1-bar (goalkeeper). Primary role: prevent goals.

Positions are logged by an admin when the game is recorded. Each side must have exactly one ATK and one DEF.

### Position Swapping
A player may only swap position **once per game**, and only at the **halfway point** — when their team has scored **5 goals** (half of the 10-goal win condition).

> **Example:** Your team leads 5–3. You and your teammate swap bars. This is permitted. You may not swap again.

**If a swap occurs, the entire game must be logged as FLEX for both players on the swapping side.** FLEX games do not affect ATK or DEF MMR — only overall points and MMR are updated. This prevents mid-game role mixing from corrupting positional statistics. Both players are marked FLEX because each accumulated a mixed observation — playing one role for the first half and the other for the second half.

| Team score at swap | Legal? | Logged as |
|---|---|---|
| 5 (your team) | ✓ Yes | FLEX (both players on that side) |
| 4 or fewer | ✗ No | — |
| After swap (any) | ✗ No | — |

If no swap occurs, positions are logged normally and both ATK and DEF MMR tracks update.

## Monthly Finals
At the end of each month, the top 4 players enter a bracket:
- Semi 1: mixed seeding — #1 + #4 vs #2 + #3
- Semi 2 (if 8+ placed players): #5 + #8 vs #6 + #7
- Final: winners of each semi
- The winning pair is crowned **Monthly Champions**.

## Conduct
- Results must be agreed by both sides before logging.
- Disputes go to an admin. Admin decisions are final.
- Unsportsmanlike behaviour may result in removal from the leaderboard.

## Disciplinary Cards
Admins can issue cards to individual players against any logged match. Penalties are permanent and survive any recalculation.

- 🟡 **Yellow Card** — −${CONFIG.YELLOW_CARD_PTS} points.
- 🔴 **Red Card** — −${CONFIG.RED_CARD_PTS} points.
`;

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Outfit:wght@600;700;800&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#090e0b; --s1:#111a14; --s2:#182318; --s3:#1f2d22;
    --b1:#253628; --b2:#304535;
    --amber:#58c882; --amber-d:#3da864; --amber-g:rgba(88,200,130,0.10);
    --green:#5ec98a; --red:#f07070; --blue:#60a8e8; --gold:#e8b84a;
    --purple:#b08af0; --orange:#f09050;
    --text:#f0f5f2; --dim:#7da899; --dimmer:#4d7060;
    --sans:'DM Sans',system-ui,sans-serif;
    --disp:'Outfit',system-ui,sans-serif;
    --mono:'DM Sans',system-ui,sans-serif;
  }
  body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;-webkit-font-smoothing:antialiased}
  ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:var(--bg)}::-webkit-scrollbar-thumb{background:var(--b2);border-radius:2px}
  .app{display:flex;flex-direction:column;min-height:100vh}
  .topbar{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:56px;background:var(--s1);border-bottom:1px solid var(--b2);position:sticky;top:0;z-index:100;gap:12px;box-shadow:0 1px 12px rgba(0,0,0,.4)}
  .brand{font-family:var(--disp);font-size:17px;font-weight:700;letter-spacing:.5px;color:var(--amber);white-space:nowrap}
  .brand span{color:var(--dim);font-weight:500;font-family:var(--sans);font-size:12px;letter-spacing:.3px;margin-left:6px}
  .nav{display:flex;gap:1px;flex-wrap:nowrap;overflow:hidden}
  .nav-btn{background:none;border:none;cursor:pointer;font-family:var(--disp);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--dim);padding:6px 14px;border-radius:6px;transition:all .15s;white-space:nowrap}
  .nav-btn:hover{color:var(--text);background:var(--s2)}
  .nav-btn.active{color:var(--amber);background:radial-gradient(ellipse 150% 300% at 50% 100%,rgba(94,201,138,.16),rgba(94,201,138,.04));font-weight:700;box-shadow:inset 0 -2px 0 var(--amber)}
  .admin-badge{font-size:11px;font-weight:600;color:var(--gold);background:rgba(232,184,74,.1);border:1px solid rgba(232,184,74,.35);border-radius:20px;padding:3px 10px;font-family:var(--sans);white-space:nowrap}
  .ham-btn{display:none;background:none;border:none;cursor:pointer;padding:6px;color:var(--dim);flex-direction:column;gap:4px;flex-shrink:0}
  .ham-btn span{display:block;width:20px;height:2px;background:currentColor;border-radius:1px;transition:all .2s}
  .ham-btn.open span:nth-child(1){transform:translateY(6px) rotate(45deg)}
  .ham-btn.open span:nth-child(2){opacity:0}
  .ham-btn.open span:nth-child(3){transform:translateY(-6px) rotate(-45deg)}
  .mob-nav{display:none;position:fixed;top:52px;left:0;right:0;background:var(--s1);border-bottom:2px solid var(--b2);padding:8px 12px;flex-direction:column;gap:2px;z-index:99;box-shadow:0 8px 24px rgba(0,0,0,.4)}
  .mob-nav.open{display:flex}
  .mob-nav .nav-btn{text-align:left;padding:9px 12px;font-size:12px}
  .main{flex:1;padding:20px;max-width:1100px;margin:0 auto;width:100%}
  .stack{display:flex;flex-direction:column;gap:14px}
  .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
  .card{background:var(--s1);border:1px solid var(--b2);border-radius:12px;overflow:hidden;transition:border-color .2s,box-shadow .2s;box-shadow:0 2px 12px rgba(0,0,0,.3)}
  .card-hover:hover{border-color:var(--b2);box-shadow:0 4px 20px rgba(0,0,0,.25)}
  .card-header{padding:14px 20px;border-bottom:1px solid var(--b2);display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--s2);border-left:3px solid var(--amber)}
  .card-title{font-family:var(--disp);font-size:14px;font-weight:700;letter-spacing:.2px;color:var(--text);white-space:nowrap}
  .tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
  .tbl{width:100%;border-collapse:collapse;min-width:520px}
  .tbl th{font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--dimmer);padding:10px 16px;text-align:left;border-bottom:1px solid var(--b1);background:var(--s2)}
  .tbl td{padding:11px 14px;border-bottom:1px solid var(--b1);font-size:13px;color:var(--text);transition:background .1s}
  .tbl tr:last-child td{border-bottom:none}
  .tbl tbody tr{transition:background .12s;cursor:pointer;position:relative}
  .tbl tbody tr:hover{background:rgba(255,255,255,.03)}
  .tbl tbody tr:hover td:first-child{box-shadow:inset 3px 0 0 var(--green)}
  .tbl tbody tr.rank-1 td:first-child{box-shadow:inset 3px 0 0 var(--gold)}
  .rk{font-family:var(--disp);font-size:17px;font-weight:700;color:var(--dim);min-width:26px;display:inline-block}
  .rk.r1{color:var(--gold)}.rk.r2{color:#c0c8c4}.rk.r3{color:#c8864a}
  .btn{font-family:var(--sans);font-size:13px;font-weight:600;padding:8px 16px;border-radius:8px;cursor:pointer;border:1px solid transparent;transition:all .15s;white-space:nowrap}
  .btn-p{background:radial-gradient(ellipse 120% 200% at 30% 0%,#72dda0,#3a9660);color:#0a160f;border-color:transparent}.btn-p:hover{background:radial-gradient(ellipse 120% 200% at 30% 0%,#82e9b0,#4aa870)}
  .btn-g{background:transparent;color:var(--dim);border-color:var(--b2)}.btn-g:hover{color:var(--text);border-color:var(--b2);background:var(--s2)}
  .btn-d{background:transparent;color:var(--red);border-color:rgba(224,100,100,.3)}.btn-d:hover{background:rgba(224,100,100,.10)}
  .btn-warn{background:transparent;color:var(--amber);border-color:var(--amber-d)}.btn-warn:hover{background:var(--amber-g)}
  .btn-sm{padding:4px 10px;font-size:11px;border-radius:6px}
  .btn:disabled{opacity:.35;cursor:not-allowed}
  .w-full{width:100%}
  .inp{background:var(--s2);border:1px solid var(--b2);color:var(--text);font-family:var(--sans);font-size:14px;padding:9px 13px;border-radius:8px;outline:none;width:100%;transition:border .15s,box-shadow .15s}
  .inp:focus{border-color:var(--amber);box-shadow:0 0 0 3px rgba(94,201,138,.12)}
  .inp::placeholder{color:var(--dimmer)}
  select.inp{cursor:pointer}
  textarea.inp{resize:vertical;line-height:1.7}
  .lbl{font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--dim);margin-bottom:6px;display:block}
  .field{margin-bottom:14px}
  .msg{font-size:12px;padding:7px 11px;border-radius:4px;margin-top:7px}
  .msg-e{background:rgba(224,82,82,.10);color:var(--red);border:1px solid rgba(224,82,82,.3)}
  .msg-s{background:rgba(94,201,138,.10);color:var(--green);border:1px solid rgba(94,201,138,.3)}
  .msg-w{background:rgba(94,201,138,.08);color:var(--amber);border:1px solid rgba(94,201,138,.25)}
  .toast{position:fixed;bottom:24px;right:20px;z-index:999;background:var(--s2);border:1px solid var(--b2);padding:12px 18px;border-radius:12px;font-size:13px;animation:slideUp .2s ease;box-shadow:0 12px 40px rgba(0,0,0,.5);max-width:320px;font-family:var(--sans)}
  .toast.success{border-left:3px solid var(--green);color:var(--green)}
  .toast.error{border-left:3px solid var(--red);color:var(--red)}
  .toast.info{border-left:3px solid var(--amber);color:var(--amber)}
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(8px);padding:16px}
  .modal{background:var(--s2);border:1px solid var(--b2);border-radius:16px;padding:28px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;box-shadow:0 32px 80px rgba(0,0,0,.7),0 0 0 1px rgba(88,200,130,.06);animation:mIn .2s ease}
  .modal-lg{max-width:740px}
  @keyframes mIn{from{transform:scale(.97) translateY(6px);opacity:0}to{transform:scale(1) translateY(0);opacity:1}}
  .modal-title{font-family:var(--disp);font-size:21px;font-weight:700;margin-bottom:20px;color:var(--amber)}
  .confirm-modal{max-width:380px;text-align:center}
  .confirm-modal .modal-title{font-size:18px}
  .stat-box{background:var(--s2);border:1px solid var(--b2);border-radius:12px;padding:18px 20px;transition:border-color .2s,box-shadow .2s;box-shadow:0 2px 8px rgba(0,0,0,.25);position:relative;overflow:hidden}
  .stat-box::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--amber),transparent)}
  .stat-box:hover{border-color:var(--amber-d);box-shadow:0 4px 20px rgba(88,200,130,.12)}
  .stat-lbl{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--dimmer);margin-bottom:6px;font-weight:500;font-family:var(--sans)}
  .stat-val{font-family:var(--disp);font-size:30px;font-weight:700;color:var(--text)}
  .stat-val.am{color:var(--amber)}
  @media(max-width:640px){.stat-val{font-size:22px}.stat-lbl{font-size:10px}}
  .pills{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap}
  .pill{font-family:var(--sans);font-size:12px;font-weight:500;padding:6px 14px;border-radius:20px;cursor:pointer;border:1px solid var(--b2);background:none;color:var(--dim);transition:all .15s}
  .pill.on{background:var(--amber);color:#0d1a12;border-color:var(--amber);font-weight:600}
  .pill:hover:not(.on){color:var(--text);border-color:var(--dim)}
  .tag{display:inline-block;font-size:11px;letter-spacing:.4px;text-transform:uppercase;padding:2px 8px;border-radius:20px;font-weight:600;font-family:var(--sans)}
  .tag-w{background:radial-gradient(ellipse 200% 200% at 0% 50%,rgba(94,201,138,.22),rgba(94,201,138,.06));color:var(--green)}
  .tag-l{background:rgba(224,100,100,.12);color:var(--red)}
  .tag-a{background:var(--amber-g);color:var(--amber)}
  .tag-b{background:rgba(107,163,214,.12);color:var(--blue)}
  .tag-p{background:rgba(165,133,232,.12);color:var(--purple)}
  .game-row{padding:11px 16px;border-bottom:1px solid var(--b1);display:grid;grid-template-columns:1fr 72px 1fr;gap:10px;align-items:center;font-size:13px;cursor:pointer;transition:background .15s;position:relative}
  .game-row:hover{background:rgba(255,255,255,.03)}
  .game-row:last-child{border-bottom:none}
  .g-side{display:flex;flex-direction:column;gap:3px}
  .g-side.right{text-align:right;align-items:flex-end}
  .g-score{font-family:var(--disp);font-size:22px;font-weight:700;color:var(--amber);text-align:center;line-height:1}
  .g-date{font-size:11px;color:var(--dimmer);text-align:center;margin-top:3px}
  .g-name-w{color:var(--text);font-weight:600;font-size:13px}
  .g-name-l{color:var(--dim);font-size:13px}
  .g-delta{font-size:11px;letter-spacing:.2px;margin-top:2px}
  .add-row{display:flex;align-items:center;justify-content:center;gap:6px;background:none;border:1px dashed var(--b2);color:var(--dim);font-family:var(--sans);font-size:12px;padding:9px;border-radius:8px;cursor:pointer;letter-spacing:.3px;transition:all .15s;width:100%;margin-top:8px}
  .add-row:hover{border-color:var(--amber);color:var(--amber)}
  .player-chip{display:flex;align-items:center;justify-content:space-between;background:var(--s2);border:1px solid var(--b2);border-radius:8px;padding:9px 13px;font-size:13px;cursor:pointer;transition:all .12s;user-select:none;box-shadow:0 1px 4px rgba(0,0,0,.2)}
  .player-chip:hover:not(.disabled){border-color:var(--amber);background:var(--s3);box-shadow:0 2px 8px rgba(88,200,130,.1)}
  .player-chip.sel-a{background:rgba(94,201,138,.1);border-color:var(--green);color:var(--green)}
  .player-chip.sel-b{background:rgba(107,163,214,.10);border-color:var(--blue);color:var(--blue)}
  .player-chip.disabled{opacity:.3;cursor:not-allowed}
  .pos-badge{display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:2px 6px;border-radius:3px;border:1px solid}
  .pos-atk{background:rgba(224,82,82,.12);color:var(--red);border-color:rgba(224,82,82,.3)}
  .pos-def{background:rgba(91,155,213,.12);color:var(--blue);border-color:rgba(91,155,213,.3)}
  .pos-both{background:rgba(155,127,232,.12);color:var(--purple);border-color:rgba(155,127,232,.3)}
  .role-tag{display:inline-flex;align-items:center;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;font-family:var(--sans);flex-shrink:0;cursor:pointer;transition:opacity .15s}
  .role-atk{background:rgba(240,144,80,.18);color:var(--orange);outline:1px solid rgba(240,144,80,.4)}
  .role-def{background:rgba(96,168,232,.14);color:var(--blue);outline:1px solid rgba(96,168,232,.35)}
  .role-flex{background:rgba(176,133,232,.14);color:var(--purple);outline:1px solid rgba(176,133,232,.35)}
  .placement-badge{display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:2px 7px;border-radius:3px}
  .placement-done{background:radial-gradient(ellipse 200% 200% at 0% 50%,rgba(94,201,138,.18),rgba(94,201,138,.05));color:var(--green);border:1px solid rgba(94,201,138,.3)}
  .placement-pending{background:radial-gradient(ellipse 200% 200% at 0% 50%,rgba(96,168,232,.16),rgba(96,168,232,.04));color:var(--blue);border:1px solid rgba(96,168,232,.25)}
  .bracket{padding:20px;display:flex;gap:28px;align-items:center;justify-content:center;overflow-x:auto;-webkit-overflow-scrolling:touch}
  .b-col{display:flex;flex-direction:column;gap:28px;align-items:center}
  .b-match{background:var(--s2);border:1px solid var(--b2);border-radius:6px;overflow:hidden;width:200px}
  .b-side{padding:9px 13px;font-size:12px;border-bottom:1px solid var(--b1);display:flex;justify-content:space-between;align-items:center}
  .b-side:last-child{border-bottom:none}
  .b-side.win{background:var(--amber-g);color:var(--amber);font-weight:600}
  .b-conn{color:var(--dim);font-size:24px;font-weight:800}
  .prof-head{display:flex;align-items:center;gap:16px;margin-bottom:20px}
  .prof-av{width:54px;height:54px;border-radius:12px;background:var(--amber-g);border:2px solid var(--amber-d);display:flex;align-items:center;justify-content:center;font-family:var(--disp);font-size:24px;font-weight:700;color:var(--amber);flex-shrink:0}
  .prof-name{font-family:var(--disp);font-size:24px;font-weight:700}
  .prof-sub{font-size:13px;color:var(--dim);margin-top:3px}
  .championship-banner{background:radial-gradient(ellipse 140% 140% at 0% 0%,rgba(232,184,74,.18) 0%,rgba(94,201,138,.08) 60%,transparent 100%);border:1px solid rgba(232,184,74,.35);border-radius:10px;padding:12px 16px;display:flex;align-items:center;gap:10px;margin-bottom:16px}
  .login-wrap{display:flex;align-items:center;justify-content:center;min-height:60vh}
  .login-box{background:var(--s1);border:1px solid var(--b1);border-radius:16px;padding:32px;width:100%;max-width:320px}
  .login-title{font-family:var(--disp);font-size:22px;font-weight:700;color:var(--amber);margin-bottom:20px}
  .sec{font-family:var(--sans);font-size:11px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:var(--dimmer);margin-bottom:12px;display:flex;align-items:center;gap:10px}
  .sec::after{content:'';flex:1;height:1px;background:var(--b1)}
  .fac{display:flex;align-items:center;gap:8px}
  .fbc{display:flex;justify-content:space-between;align-items:center}
  .mt8{margin-top:8px}.mt12{margin-top:12px}.mt16{margin-top:16px}.mb8{margin-bottom:8px}.mb12{margin-bottom:12px}.mb16{margin-bottom:16px}
  .text-am{color:var(--amber)}.text-g{color:var(--green)}.text-r{color:var(--red)}.text-d{color:var(--dim)}.text-dd{color:var(--dimmer)}
  .bold{font-weight:600}.sm{font-size:12px}.xs{font-size:11px}
  .disp{font-family:var(--disp);font-weight:700}
  .pip{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:3px}
  .pip-u{background:var(--dimmer)}.pip-f{background:var(--amber)}
  .divider{height:1px;background:var(--b1);margin:16px 0}
  .season-launch{position:relative;overflow:hidden;background:var(--s2)}
  .season-launch::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--gold),var(--amber),var(--gold),transparent);animation:shimmerLine 2.4s ease-in-out infinite;pointer-events:none}
  @keyframes shimmerLine{0%,100%{opacity:.4;transform:scaleX(.5)}50%{opacity:1;transform:scaleX(1)}}
  .season-launch.hype{background:radial-gradient(ellipse 80% 120% at 10% 0%,rgba(232,184,74,.13) 0%,rgba(88,200,130,.07) 50%,var(--s2) 100%);border:1px solid rgba(232,184,74,.45) !important;box-shadow:0 0 0 1px rgba(232,184,74,.1),inset 0 1px 0 rgba(232,184,74,.2);animation:hypePulse 3s ease-in-out infinite}
  @keyframes hypePulse{0%,100%{box-shadow:0 0 0 1px rgba(232,184,74,.1),0 0 20px rgba(232,184,74,.06),inset 0 1px 0 rgba(232,184,74,.2)}50%{box-shadow:0 0 0 1px rgba(232,184,74,.25),0 0 40px rgba(232,184,74,.14),inset 0 1px 0 rgba(232,184,74,.35)}}
  .season-launch.hype::before{height:3px;background:linear-gradient(90deg,transparent 0%,var(--gold) 20%,#fff8e0 50%,var(--gold) 80%,transparent 100%);animation:hypeSweep 2s ease-in-out infinite;filter:blur(.4px)}
  @keyframes hypeSweep{0%{opacity:0;transform:translateX(-100%)}30%{opacity:1}70%{opacity:1}100%{opacity:0;transform:translateX(100%)}}
  .season-launch.hype::after{content:"";position:absolute;inset:0;background:radial-gradient(ellipse 40% 60% at 90% 100%,rgba(232,184,74,.08),transparent 60%);pointer-events:none;animation:hypeCorner 4s ease-in-out infinite alternate}
  @keyframes hypeCorner{0%{opacity:.4}100%{opacity:1}}
  .season-title{display:inline-flex;align-items:center;gap:8px;font-family:var(--disp);font-size:22px;font-weight:800;color:var(--gold)}
  .season-title.hype{font-size:26px;letter-spacing:.5px;text-shadow:0 0 20px rgba(232,184,74,.4),0 2px 4px rgba(0,0,0,.5)}
  .season-pill{display:inline-flex;padding:3px 10px;border-radius:999px;border:1px solid rgba(232,184,74,.4);background:rgba(232,184,74,.1);font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--gold);font-family:var(--sans)}
  .season-pill.hype{background:rgba(232,184,74,.18);border-color:rgba(232,184,74,.6);animation:pillPop .6s cubic-bezier(.34,1.56,.64,1) both .3s}
  @keyframes pillPop{from{transform:scale(.7);opacity:0}to{transform:scale(1);opacity:1}}
  .season-msg{margin-top:10px}
  .md h1{font-family:var(--disp);font-size:28px;font-weight:800;color:var(--amber);margin-bottom:14px}
  .md h2{font-family:var(--disp);font-size:18px;font-weight:700;color:var(--text);margin:18px 0 8px;border-bottom:1px solid var(--b1);padding-bottom:5px}
  .md h3{font-family:var(--disp);font-size:15px;font-weight:700;color:var(--text);margin:12px 0 5px}
  .md h4,.md h5,.md h6{font-family:var(--disp);font-size:13px;font-weight:600;color:var(--dim);margin:10px 0 4px}
  .md p{line-height:1.7;color:var(--dim);margin-bottom:8px;font-size:13px}
  .md ul,.md ol{padding-left:20px;margin-bottom:8px}
  .md li{line-height:1.7;color:var(--dim);font-size:13px;margin-bottom:2px}
  .md strong{color:var(--text);font-weight:600}
  .md em{font-style:italic;color:var(--dim)}
  .md del{text-decoration:line-through;opacity:.5}
  .md code{background:var(--s2);border:1px solid var(--b2);padding:1px 5px;border-radius:3px;font-size:11px;color:var(--amber);font-family:var(--mono)}
  .md pre{background:var(--s2);border:1px solid var(--b2);border-radius:6px;padding:12px 14px;overflow-x:auto;margin:8px 0}
  .md blockquote{border-left:3px solid var(--b2);padding:6px 14px;color:var(--dim);font-style:italic;margin:6px 0}
  .md hr{border:none;border-top:1px solid var(--b2);margin:14px 0}
  .md table{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0}
  .md mark{background:rgba(232,184,74,.25);color:var(--gold);padding:1px 3px;border-radius:3px}
  .md a{color:var(--amber);text-decoration:underline}
  .undo-bar{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--s2);border:1px solid var(--b2);border-radius:6px;padding:10px 16px;display:flex;align-items:center;gap:12px;font-size:12px;z-index:150;box-shadow:0 8px 32px rgba(0,0,0,.5);animation:slideUp .2s ease}
  .inp-edit{border-color:var(--amber-d) !important;background:rgba(94,201,138,.05) !important}
  .rt-dot{width:8px;height:8px;border-radius:50%;background:var(--dimmer);display:block;flex-shrink:0;transition:background .3s}
  .rt-dot.live{background:var(--green);animation:rtPulse 2.5s infinite}
  @keyframes rtPulse{0%{box-shadow:0 0 0 0 rgba(94,201,138,.55)}70%{box-shadow:0 0 0 7px rgba(94,201,138,0)}100%{box-shadow:0 0 0 0 rgba(94,201,138,0)}}
  @keyframes rowIn{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
  .lb-row{animation:rowIn .3s ease both;transition:background .15s}
  @keyframes rankUp{0%{background:rgba(88,200,130,.32);box-shadow:inset 0 0 0 1px rgba(88,200,130,.4)}60%{background:rgba(88,200,130,.12);box-shadow:none}100%{background:transparent}}
  @keyframes rankDown{0%{background:rgba(224,100,100,.28);box-shadow:inset 0 0 0 1px rgba(224,100,100,.35)}60%{background:rgba(224,100,100,.10);box-shadow:none}100%{background:transparent}}
  @keyframes ptsFlash{0%{background:transparent}25%{background:rgba(88,200,130,.18)}75%{background:rgba(88,200,130,.08)}100%{background:transparent}}
  .lb-row.rank-up{animation:rankUp .9s ease forwards}
  .lb-row.rank-down{animation:rankDown .9s ease forwards}
  .lb-row.pts-changed{animation:ptsFlash 1s ease}
  .page-fade{animation:pageFade .18s ease both}
  @keyframes pageFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
  .match-live-banner{background:radial-gradient(ellipse 80% 300% at 0% 50%,rgba(240,112,112,.12),var(--s1));border:1px solid rgba(240,112,112,.3);border-radius:10px;padding:10px 16px;display:flex;align-items:center;gap:10px;font-size:13px;animation:slideUp .3s ease;cursor:pointer}
  .score-btn{width:32px;height:32px;border-radius:50%;font-size:18px;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid var(--b2);background:var(--s2);color:var(--text);transition:all .12s;user-select:none;line-height:1}
  .score-btn:hover{background:var(--s3);border-color:var(--amber)}
  .score-btn:active{transform:scale(.9)}
  .live-score-num{font-family:var(--disp);font-size:32px;font-weight:700;line-height:1;min-width:40px;text-align:center;transition:all .2s}
  .live-pulse{animation:livePulse 1.8s ease-in-out infinite}
  @keyframes livePulse{0%,100%{opacity:1}50%{opacity:.45}}
  @keyframes slideUp{from{transform:translateY(10px);opacity:0}to{transform:translateY(0);opacity:1}}
  @keyframes fadeInUp{from{transform:translateY(12px);opacity:0}to{transform:translateY(0);opacity:1}}
  @keyframes savingBar{from{opacity:.4}to{opacity:1}}
  .cd-wrap{display:flex;gap:6px;align-items:flex-end;justify-content:center;margin:16px 0 6px}
  .cd-unit{display:flex;flex-direction:column;align-items:center;min-width:54px}
  .cd-num{font-family:var(--disp);font-size:46px;font-weight:700;line-height:1;letter-spacing:-1px;transition:color .4s;text-shadow:0 2px 12px rgba(94,201,138,.2)}
  .cd-lbl{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--dimmer);margin-top:2px}
  .cd-sep{font-family:var(--disp);font-size:38px;font-weight:800;color:var(--dimmer);line-height:1;margin-bottom:16px;animation:sepBlink 1.2s step-start infinite}
  @keyframes sepBlink{0%,49%{opacity:1}50%,100%{opacity:.2}}
  .lb-cards{display:none;flex-direction:column;gap:0}
  .lb-card{display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid var(--b1);cursor:pointer;transition:background .12s}
  .lb-card:hover{background:rgba(255,255,255,.03)}
  .lb-card:last-child{border-bottom:none}
  .lb-card-rank{font-family:var(--disp);font-size:16px;font-weight:700;min-width:36px;color:var(--dim)}
  .lb-card-name{flex:1;font-weight:600;font-size:14px}
  .lb-card-pts{font-family:var(--disp);font-size:18px;font-weight:700;color:var(--amber);min-width:40px;text-align:right}
  .lb-card-meta{font-size:11px;color:var(--dimmer);margin-top:1px}

  /* ── TROPHY TIERS ──────────────────────────────────────────── */
  .trophy-runner{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex-shrink:0}
  .trophy-third{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex-shrink:0}
  .trophy-diamond{display:inline-flex;align-items:center;gap:3px;background:linear-gradient(135deg,rgba(96,168,232,.18),rgba(165,133,232,.20));color:#a8d8f8;border:1px solid rgba(96,168,232,.38);border-radius:4px;font-size:9px;padding:2px 6px;letter-spacing:.4px;font-weight:700;font-family:var(--sans);flex-shrink:0}

  /* ── TREND INDICATOR ──────────────────────────────────────── */
  .trend-hot{display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;background:color-mix(in srgb,var(--green) 11%,transparent);border:1px solid color-mix(in srgb,var(--green) 30%,transparent);color:var(--green);flex-shrink:0}
  .trend-cold{display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;background:color-mix(in srgb,var(--blue) 10%,transparent);border:1px solid color-mix(in srgb,var(--blue) 28%,transparent);color:var(--blue);flex-shrink:0}
  .trend-label{font-size:8px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;line-height:1;font-family:var(--sans)}

  /* ── BRACKET SLOTS ────────────────────────────────────────── */
  .bslot{border-radius:8px;padding:10px 12px;min-height:56px;transition:border-color .2s,background .2s,box-shadow .2s;cursor:default}
  .bslot-empty{border:1px dashed var(--b2);background:transparent}
  .bslot-active{border:1px solid var(--amber) !important;background:rgba(94,201,138,.04) !important;animation:slotBreath 2s ease-in-out infinite}
  .bslot-filled{border:1px solid var(--b2);background:var(--s2)}
  .bslot-flex{border:1px solid rgba(176,133,232,.38);background:rgba(176,133,232,.05)}
  @keyframes slotBreath{0%,100%{box-shadow:0 0 0 3px rgba(94,201,138,.07)}50%{box-shadow:0 0 0 7px rgba(94,201,138,.03)}}
  .picking-label{display:inline-block;background:var(--amber);color:#0d1a12;font-size:8px;font-weight:700;padding:1px 6px;border-radius:6px;letter-spacing:.6px;text-transform:uppercase;margin-bottom:5px;font-family:var(--sans)}

  /* ── ROLE PANEL ───────────────────────────────────────────── */
  .role-slot{border-radius:7px;padding:8px 11px;min-height:48px;display:flex;flex-direction:column;justify-content:center;gap:3px;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .15s;user-select:none}
  .role-slot:hover{box-shadow:0 0 0 2px rgba(94,201,138,.15)}
  .role-slot-empty{border:1px dashed var(--b2);background:transparent}
  .role-slot-atk{border:1px solid rgba(240,144,80,.4);background:rgba(240,144,80,.07)}
  .role-slot-def{border:1px solid rgba(96,168,232,.35);background:rgba(96,168,232,.06)}
  .role-slot-flex{border:1px solid rgba(176,133,232,.38);background:rgba(176,133,232,.05)}

  @media(max-width:980px){
    .tbl-wrap{display:none}
    .lb-cards{display:flex}
    .topbar{padding:0 14px;gap:8px;height:52px}
    .brand{font-size:14px;letter-spacing:1px}
    .brand span{display:none}
    .nav{display:none}
    .ham-btn{display:flex}
    .main{padding:10px 8px}
    .grid-3{grid-template-columns:1fr 1fr 1fr}
    .grid-2{grid-template-columns:1fr}
    .stat-val{font-size:20px}
    .modal{padding:14px 12px;max-height:92vh;max-width:100%;margin:0;border-radius:8px 8px 0 0;position:fixed;bottom:0;left:0;right:0;overflow-y:auto}
    .overlay{align-items:flex-end;padding:0}
    .cd-num{font-size:32px}
    .cd-unit{min-width:38px}
    .tbl{min-width:380px}
    .tbl td,.tbl th{padding:7px 8px;font-size:12px}
    .game-row{grid-template-columns:1fr auto 1fr;padding:9px 10px;gap:6px}
    .g-score{font-size:17px;min-width:42px}
    .modal-lg{max-width:100%}
    .stack{gap:10px}
    .card-header{padding:10px 12px}
    .bracket{padding:12px;gap:12px}
    .b-match{width:160px}
    .player-chip{padding:12px;min-height:48px}
    .btn{padding:10px 16px;min-height:48px}
    .tbl td,.tbl th{padding:10px 10px;min-height:48px}
  }
  @media(max-width:380px){
    .grid-3{grid-template-columns:1fr}
    .brand{font-size:13px}
  }
  @keyframes pageIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
  .stat-val{font-family:var(--disp);font-size:26px;font-weight:800;color:var(--text)}
  .stat-val.am{color:var(--amber)}
  .brand-sub{color:var(--dim);font-weight:400}
`;

// ── MMR ENGINE ─────────────────────────────────────────────────────────────

function streakMult(streakPower, isWinner) {
  const power = Math.max(0, streakPower || 0);
  const t = Math.tanh(power / CONFIG.STREAK_POWER_SCALE);
  const cap = isWinner ? CONFIG.STREAK_WIN_MAX : CONFIG.STREAK_LOSS_MAX;
  return 1 + t * cap;
}

function updateStreakPower(currentPower, isWin, qualityScore) {
  if (!isWin) return 0;
  const base = (currentPower || 0);
  const decayed = qualityScore < CONFIG.STREAK_DECAY_THRESHOLD ? base * CONFIG.STREAK_QUALITY_DECAY : base;
  return Math.min(decayed + qualityScore, CONFIG.STREAK_WINDOW * 2);
}

function avg(ids, players, key) {
  const found = ids.map(id => players.find(p => p.id === id)).filter(Boolean);
  if (!found.length) return key === "mmr" ? CONFIG.STARTING_MMR : 0;
  return found.reduce((s, p) => s + (p[key] || 0), 0) / found.length;
}

function avgWithMap(ids, playerMap, key) {
  const found = ids.map(id => playerMap.get(id)).filter(Boolean);
  if (!found.length) return key === "mmr" ? CONFIG.STARTING_MMR : 0;
  return found.reduce((s, p) => s + (p[key] || 0), 0) / found.length;
}

function computePlacements(games, seasons) {
  const placements = {};
  for (const g of games) {
    const mk = getGamePlacementKey(g, seasons);
    if (!mk) continue;
    if (!placements[mk]) placements[mk] = {};
    for (const pid of [...g.sideA, ...g.sideB]) {
      placements[mk][pid] = (placements[mk][pid] || 0) + 1;
    }
  }
  return placements;
}

function replayGames(basePlayers, games, seasonStart, seasons) {
  let players = basePlayers.map(p => ({
    ...p, mmr: CONFIG.STARTING_MMR, pts: CONFIG.STARTING_PTS,
    mmr_atk: CONFIG.STARTING_MMR, mmr_def: CONFIG.STARTING_MMR,
    wins: 0, losses: 0, streak: 0, streakPower: 0,
    wins_atk: 0, losses_atk: 0, wins_def: 0, losses_def: 0,
  }));
  const seasonStartDate = seasonStart ? new Date(seasonStart) : null;
  const sorted = sortByDate(games);
  let playerMap = new Map(basePlayers.map(p => [p.id, p]));
  const placementCount = {};
  const updatedGames = sorted.map(g => {
    const gameDate = g.date ? new Date(g.date) : null;
    const inSeason = !seasonStartDate || !gameDate || gameDate >= seasonStartDate;
    const winIds = g.winner === "A" ? g.sideA : g.sideB;
    const losIds = g.winner === "A" ? g.sideB : g.sideA;
    const mk = getGamePlacementKey(g, seasons);
    const monthPlacements = placementCount[mk] || {};
    const isPlacedAtGameTime = pid => (monthPlacements[pid] || 0) >= CONFIG.MAX_PLACEMENTS_PER_MONTH;
    const allPids = [...winIds, ...losIds];
    const ranked = sortByPoints(players);
    const rankOf = id => { const i = ranked.findIndex(p => p.id === id); return i === -1 ? ranked.length : i; };
    playerMap = new Map(players.map(p => [p.id, p]));
    const oppAvgMMR = ids => avgWithMap(ids, playerMap, "mmr");
    const oppAvgRankPlaced = ids => {
      const placed = ids.filter(isPlacedAtGameTime);
      if (!placed.length) return null;
      return placed.reduce((s, id) => s + rankOf(id), 0) / placed.length;
    };
    const winnerScore = Math.max(g.scoreA, g.scoreB);
    const loserScore = Math.min(g.scoreA, g.scoreB);
    const oppWinMMR = oppAvgMMR(winIds);
    const oppLosMMR = oppAvgMMR(losIds);
    const oppWinRankPlaced = oppAvgRankPlaced(winIds);
    const oppLosRankPlaced = oppAvgRankPlaced(losIds);
    const gameRoles = g.roles || {};
    const hasRoles = Object.keys(gameRoles).length === 4;
    const atkRanked = [...players].sort((a,b)=>(b.mmr_atk??CONFIG.STARTING_MMR)-(a.mmr_atk??CONFIG.STARTING_MMR));
    const defRanked = [...players].sort((a,b)=>(b.mmr_def??CONFIG.STARTING_MMR)-(a.mmr_def??CONFIG.STARTING_MMR));
    const atkRankOf = id => { const i=atkRanked.findIndex(p=>p.id===id); return i===-1?atkRanked.length:i; };
    const defRankOf = id => { const i=defRanked.findIndex(p=>p.id===id); return i===-1?defRanked.length:i; };
    const playerDeltas = {};
    allPids.forEach(pid => {
      const p = playerMap.get(pid); if (!p) return;
      const isWinner = winIds.includes(pid);
      const myPlaced = isPlacedAtGameTime(pid);
      const oppRankPlaced = isWinner ? oppLosRankPlaced : oppWinRankPlaced;
      const myRole = gameRoles[pid];
      const oppIds = isWinner ? losIds : winIds;
      let playerMMR, oppMMRval, playerRank, oppRankVal;
      if (hasRoles && myRole && myRole !== 'FLEX') {
        const oppRole = myRole === 'ATK' ? 'DEF' : 'ATK';
        const oppMatchId = oppIds.find(id => gameRoles[id] === oppRole);
        const oppMatch = oppMatchId ? playerMap.get(oppMatchId) : null;
        if (myRole === 'ATK') {
          playerMMR = p.mmr_atk ?? p.mmr;
          oppMMRval = oppMatch ? (oppMatch.mmr_def ?? oppMatch.mmr) : (isWinner ? oppLosMMR : oppWinMMR);
          playerRank = myPlaced ? atkRankOf(pid) : null;
          oppRankVal = (myPlaced && oppMatchId && isPlacedAtGameTime(oppMatchId)) ? defRankOf(oppMatchId) : null;
        } else {
          playerMMR = p.mmr_def ?? p.mmr;
          oppMMRval = oppMatch ? (oppMatch.mmr_atk ?? oppMatch.mmr) : (isWinner ? oppLosMMR : oppWinMMR);
          playerRank = myPlaced ? defRankOf(pid) : null;
          oppRankVal = (myPlaced && oppMatchId && isPlacedAtGameTime(oppMatchId)) ? atkRankOf(oppMatchId) : null;
        }
      } else {
        playerMMR = p.mmr;
        oppMMRval = isWinner ? oppLosMMR : oppWinMMR;
        playerRank = myPlaced ? rankOf(pid) : null;
        oppRankVal = (myPlaced && oppRankPlaced !== null) ? oppRankPlaced : null;
      }
      const d = calcPlayerDelta({
        winnerScore, loserScore, playerMMR, playerRank,
        playerStreakPower: p.streakPower || 0,
        oppAvgMMR: oppMMRval, oppAvgRank: oppRankVal, isWinner,
        playerRole: myRole, playerPreferredRole: p.preferredRole,
      });
      playerDeltas[pid] = { ...d, role: myRole || null };
    });
    if (!placementCount[mk]) placementCount[mk] = {};
    allPids.forEach(pid => { placementCount[mk][pid] = (placementCount[mk][pid] || 0) + 1; });
    players = players.map(p => {
      const d = playerDeltas[p.id]; if (!d) return p;
      const isWin = winIds.includes(p.id);
      const role = d.role;
      if (isWin) {
        const base = { ...p, wins: p.wins+1, wins_atk: (p.wins_atk||0)+(role==='ATK'?1:0), wins_def: (p.wins_def||0)+(role==='DEF'?1:0) };
        if (!inSeason) return base;
        const ns = (p.streak||0)>=0 ? (p.streak||0)+1 : 1;
        const newPower = updateStreakPower(p.streakPower||0, true, d.qualityScore||1);
        const newAtk = role==='ATK' ? (p.mmr_atk??p.mmr)+d.gain : (p.mmr_atk??p.mmr);
        const newDef = role==='DEF' ? (p.mmr_def??p.mmr)+d.gain : (p.mmr_def??p.mmr);
        const newMMR = (role && role !== 'FLEX') ? Math.round((newAtk+newDef)/2) : p.mmr+d.gain;
        return { ...base, mmr:newMMR, mmr_atk:newAtk, mmr_def:newDef, pts:(p.pts||0)+d.gain, streak:ns, streakPower:newPower };
      }
      const base = { ...p, losses: p.losses+1, losses_atk: (p.losses_atk||0)+(role==='ATK'?1:0), losses_def: (p.losses_def||0)+(role==='DEF'?1:0) };
      if (!inSeason) return base;
      const ns = (p.streak||0)<=0 ? (p.streak||0)-1 : -1;
      const newAtk = role==='ATK' ? Math.max(0,(p.mmr_atk??p.mmr)-d.loss) : (p.mmr_atk??p.mmr);
      const newDef = role==='DEF' ? Math.max(0,(p.mmr_def??p.mmr)-d.loss) : (p.mmr_def??p.mmr);
      const newMMR = (role && role !== 'FLEX') ? Math.round((newAtk+newDef)/2) : Math.max(0,p.mmr-d.loss);
      return { ...base, mmr:newMMR, mmr_atk:newAtk, mmr_def:newDef, pts:Math.max(0,(p.pts||0)-d.loss), streak:ns, streakPower:0 };
    });
    if (g.penalties && inSeason) {
      players = players.map(p => {
        const pen = g.penalties[p.id]; if (!pen) return p;
        const deduct = (pen.yellow || 0) * CONFIG.YELLOW_CARD_PTS + (pen.red || 0) * CONFIG.RED_CARD_PTS;
        if (!deduct) return p;
        return { ...p, pts: Math.max(0, (p.pts || 0) - deduct) };
      });
    }
    const perPlayerGains = {}, perPlayerLosses = {}, perPlayerFactors = {};
    winIds.forEach(id => {
      if (playerDeltas[id]) {
        perPlayerGains[id] = playerDeltas[id].gain;
        perPlayerFactors[id] = { eloScale: +playerDeltas[id].eloScale.toFixed(3), rankScale: +playerDeltas[id].rankScale.toFixed(3), matchQuality: +playerDeltas[id].matchQuality.toFixed(3), qualityScore: +playerDeltas[id].qualityScore.toFixed(3), roleMult: +((playerDeltas[id].roleMult)||1).toFixed(3) };
      }
    });
    losIds.forEach(id => {
      if (playerDeltas[id]) {
        perPlayerLosses[id] = playerDeltas[id].loss;
        perPlayerFactors[id] = { eloScale: +playerDeltas[id].eloScale.toFixed(3), rankScale: +playerDeltas[id].rankScale.toFixed(3), matchQuality: +playerDeltas[id].matchQuality.toFixed(3), qualityScore: +playerDeltas[id].qualityScore.toFixed(3), roleMult: +((playerDeltas[id].roleMult)||1).toFixed(3) };
      }
    });
    const avgGain = Math.round(winIds.reduce((s, id) => s + (playerDeltas[id]?.gain || 0), 0) / Math.max(winIds.length, 1));
    const avgLoss = Math.round(losIds.reduce((s, id) => s + (playerDeltas[id]?.loss || 0), 0) / Math.max(losIds.length, 1));
    return { ...g, ptsGain: avgGain, ptsLoss: avgLoss, mmrGain: avgGain, mmrLoss: avgLoss, perPlayerGains, perPlayerLosses, perPlayerFactors };
  });
  return { players, games: updatedGames };
}

function calcPlayerDelta({ winnerScore, loserScore, playerMMR, playerRank, playerStreakPower, oppAvgMMR, oppAvgRank, isWinner, playerRole, playerPreferredRole }) {
  const scoreDiff = winnerScore - loserScore;
  const scoreRatio = scoreDiff / Math.max(winnerScore, 1);
  const scoreMult = 1 + CONFIG.SCORE_WEIGHT * Math.pow(scoreRatio, CONFIG.SCORE_EXP);
  const mmrGap = playerMMR - oppAvgMMR;
  const eloScale = 2 / (1 + Math.exp(mmrGap / CONFIG.ELO_DIVISOR));
  const rankDifficulty = (playerRank === null || oppAvgRank === null) ? 1.0 : 1 + CONFIG.RANK_WEIGHT * Math.tanh((playerRank - oppAvgRank) / CONFIG.RANK_DIVISOR);
  const rankScale = rankDifficulty;
  const matchQuality = (() => {
    const elo = eloScale, rank = rankDifficulty;
    if (rank >= 1.0 && elo >= 1.0) return Math.max(elo, 0.7 * elo + 0.3 * rank);
    if (rank <= 1.0 && elo <= 1.0) return Math.max(0.7 * elo + 0.3 * rank, elo);
    if (rank > elo) return Math.min(1.0, 0.7 * elo + 0.3 * rank);
    return elo;
  })();
  const mult = streakMult(playerStreakPower, isWinner);
  const qualityScore = matchQuality;
  // FLEX is neutral (§3.6 — in position or FLEX = 1.0). Out-of-position = asymmetric bonus.
  const isOutOfPosition = !!(playerRole && playerRole !== 'FLEX' && playerPreferredRole && playerPreferredRole !== 'FLEX' && playerPreferredRole !== playerRole);
  const roleGainMult = isOutOfPosition ? CONFIG.ROLE_ALIGN_BONUS : 1.0;
  const roleLossMult = isOutOfPosition ? (1 / CONFIG.ROLE_ALIGN_BONUS) : 1.0;
  const roleMult = roleGainMult;
  if (isWinner) {
    const gain = Math.max(2, Math.round(CONFIG.BASE_GAIN * scoreMult * matchQuality * mult * roleGainMult));
    return { gain, loss: 0, scoreMult, eloScale, rankScale, matchQuality, streakMultVal: mult, qualityScore, roleMult: roleGainMult, roleLossMult };
  } else {
    const loss = Math.max(1, Math.round(CONFIG.BASE_LOSS * scoreMult * (2 - matchQuality) * mult * CONFIG.LOSS_HARSHNESS * roleLossMult));
    return { gain: 0, loss, scoreMult, eloScale, rankScale, matchQuality, streakMultVal: mult, qualityScore, roleMult: roleGainMult, roleLossMult };
  }
}

function calcDelta({ winnerScore, loserScore, winnerAvgMMR, loserAvgMMR, winnerAvgStreakPower, loserAvgStreakPower, winnerAvgRank, loserAvgRank }) {
  const scoreDiff = winnerScore - loserScore;
  const scoreRatio = scoreDiff / Math.max(winnerScore, 1);
  const scoreMult = 1 + CONFIG.SCORE_WEIGHT * Math.pow(scoreRatio, CONFIG.SCORE_EXP);
  const mmrGap = winnerAvgMMR - loserAvgMMR;
  const eloScale = 2 / (1 + Math.exp(mmrGap / CONFIG.ELO_DIVISOR));
  const rankDiff = (loserAvgRank ?? 0) - (winnerAvgRank ?? 0);
  const rankScale = 1 + CONFIG.RANK_WEIGHT * Math.tanh(rankDiff / CONFIG.RANK_DIVISOR);
  const winMult = streakMult(winnerAvgStreakPower ?? 0, true);
  const lossMult = streakMult(loserAvgStreakPower ?? 0, false);
  const gain = Math.max(2, Math.round(CONFIG.BASE_GAIN * scoreMult * eloScale * rankScale * winMult));
  const loss = Math.max(1, Math.round(CONFIG.BASE_LOSS * scoreMult * (2 - eloScale) * (2 - rankScale) * lossMult * CONFIG.LOSS_HARSHNESS));
  return { gain, loss, eloScale, rankScale, winMult, lossMult, scoreMult };
}

function getMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Returns the placement bucket key for a specific game.
// Season-based: if the game date falls within a known season, returns "season_<id>".
// Legacy fallback: games before any season use their month key so old data is preserved.
function getGamePlacementKey(game, seasons) {
  if (!seasons?.length) return game.monthKey || game.date?.slice(0, 7) || '';
  const gameDate = game.date ? new Date(game.date) : null;
  if (!gameDate) return game.monthKey || '';
  // Walk seasons newest-first, find the one that contains this game's date
  const season = [...seasons]
    .sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt))
    .find(s => {
      const start = Date.parse(s.startAt);
      const end = s.endAt ? Date.parse(s.endAt) : Infinity;
      return Number.isFinite(start) && gameDate >= new Date(start) && gameDate < new Date(end);
    });
  if (season) return `season_${season.id}`;
  // Pre-season game — use month key so historical data is unaffected
  return game.monthKey || game.date?.slice(0, 7) || '';
}

// Returns the placement bucket key to use for display/checks in the current moment.
// If there is an active season, returns its key; otherwise falls back to calendar month.
function getCurrentPlacementKey(state) {
  const currentSeason = getCurrentSeason(state);
  if (currentSeason?.id) return `season_${currentSeason.id}`;
  return getMonthKey();
}

function getCurrentSeason(state) { const seasons = state?.seasons || []; return seasons[seasons.length - 1] || null; }
function gameInSeason(game, season) {
  if (!season) return true;
  const t = Date.parse(game?.date || ""); if (!Number.isFinite(t)) return true;
  const start = Date.parse(season.startAt || "");
  const end = season.endAt ? Date.parse(season.endAt) : null;
  if (Number.isFinite(start) && t < start) return false;
  if (Number.isFinite(end) && t >= end) return false;
  return true;
}
function computeWindowPlayerStats(players, games) {
  const stats = Object.fromEntries((players || []).map(p => [p.id, { wins: 0, losses: 0, pts: 0, streak: 0 }]));
  const sorted = sortByDate(games || []);
  for (const g of sorted) {
    const { winners: winIds, losers: losIds } = getWinnerAndLoserSides(g);
    for (const id of winIds) {
      const s = stats[id]; if (!s) continue;
      const gain = g.perPlayerGains?.[id] ?? g.playerDeltas?.[id]?.gain ?? g.ptsGain ?? 0;
      s.wins += 1; s.pts += gain; s.streak = s.streak >= 0 ? s.streak + 1 : 1;
    }
    for (const id of losIds) {
      const s = stats[id]; if (!s) continue;
      const loss = g.perPlayerLosses?.[id] ?? g.playerDeltas?.[id]?.loss ?? g.ptsLoss ?? 0;
      s.losses += 1; s.pts = Math.max(0, s.pts - loss); s.streak = s.streak <= 0 ? s.streak - 1 : -1;
    }
    if (g.penalties) {
      Object.entries(g.penalties).forEach(([pid, pen]) => {
        const s = stats[pid]; if (!s) return;
        const deduct = (pen?.yellow || 0) * CONFIG.YELLOW_CARD_PTS + (pen?.red || 0) * CONFIG.RED_CARD_PTS;
        if (deduct > 0) s.pts = Math.max(0, s.pts - deduct);
      });
    }
  }
  return stats;
}

// ── CHAMPIONSHIP BRACKET SEEDING ──────────────────────────────────────────
//
// Mixed seeding (#1+#4 vs #2+#3) is used as the MMR-balance foundation.
// Both options ([p0,p3] vs [p1,p2]) and ([p0,p2] vs [p1,p3]) produce
// identical average MMR when rankings are linear. The role-compatibility
// check chooses the option where each team has complementary role preferences
// (one ATK-preference + one DEF-preference player), without sacrificing
// balance. This makes both semis competitive AND natural to play.
function buildBracket(pool) {
  if (pool.length < 4) return null;
  const [p0, p1, p2, p3] = pool;

  const hasAtkPref = p => ['ATK', 'attack'].includes(p.preferredRole || p.position);
  const hasDefPref = p => ['DEF', 'defense'].includes(p.preferredRole || p.position);

  // Scores a two-player team on role complementarity (ATK+DEF = 2, same = 1)
  const teamRoleScore = (a, b) => {
    const teamHasAtk = hasAtkPref(a) || hasAtkPref(b);
    const teamHasDef = hasDefPref(a) || hasDefPref(b);
    return (teamHasAtk && teamHasDef) ? 2 : 1;
  };

  // Both are valid balanced splits — pick the one with better role pairing
  const scoreA = teamRoleScore(p0, p3) + teamRoleScore(p1, p2);
  const scoreB = teamRoleScore(p0, p2) + teamRoleScore(p1, p3);

  return scoreB > scoreA
    ? { teamA: [p0.id, p2.id], teamB: [p1.id, p3.id] }
    : { teamA: [p0.id, p3.id], teamB: [p1.id, p2.id] };
}

// ── RUNNER-UP ALGORITHM ────────────────────────────────────────────────────
//
// Score-weighted, stage-adjusted ranking of all losing teams.
// Performance = stage_bonus + (loser_goals / total_goals)
// Stage bonus (0.2) rewards the finalist for having won a semi.
// At the empirical modal score (10-6), the finalist wins runner-up in ~90%
// of cases. The algorithm only overrides when the finalist scored ≤3 goals
// (convincing collapse) and a semi-loser lost narrowly (≥8 goals scored).
// Returns { runnerUp: [id,id]|null, thirdPlace: [id,id]|null }
function resolveRunnerUp(bracket) {
  if (!bracket) return { runnerUp: null, thirdPlace: null };
  const FINALIST_STAGE_BONUS = 0.2;

  const calcPerf = (loserGoals, totalGoals, isFinalist) => {
    if (totalGoals === 0) return isFinalist ? FINALIST_STAGE_BONUS : 0.0;
    return (isFinalist ? FINALIST_STAGE_BONUS : 0.0) + (loserGoals / totalGoals);
  };

  const candidates = [];

  if (bracket.upper?.winner) {
    const loserSide = bracket.upper.winner === 'A' ? 'B' : 'A';
    const loserGoals = loserSide === 'A' ? bracket.upper.scoreA : bracket.upper.scoreB;
    candidates.push({ ids: loserSide === 'A' ? bracket.upper.sideA : bracket.upper.sideB, performance: calcPerf(loserGoals, (bracket.upper.scoreA||0) + (bracket.upper.scoreB||0), false) });
  }
  if (bracket.lower?.winner) {
    const loserSide = bracket.lower.winner === 'A' ? 'B' : 'A';
    const loserGoals = loserSide === 'A' ? bracket.lower.scoreA : bracket.lower.scoreB;
    candidates.push({ ids: loserSide === 'A' ? bracket.lower.sideA : bracket.lower.sideB, performance: calcPerf(loserGoals, (bracket.lower.scoreA||0) + (bracket.lower.scoreB||0), false) });
  }
  if (bracket.final?.winner) {
    const loserSide = bracket.final.winner === 'A' ? 'B' : 'A';
    const loserGoals = loserSide === 'A' ? bracket.final.scoreA : bracket.final.scoreB;
    candidates.push({ ids: loserSide === 'A' ? bracket.final.sideA : bracket.final.sideB, performance: calcPerf(loserGoals, (bracket.final.scoreA||0) + (bracket.final.scoreB||0), true) });
  }

  if (!candidates.length) return { runnerUp: null, thirdPlace: null };
  candidates.sort((a, b) => b.performance - a.performance);
  return { runnerUp: candidates[0]?.ids ?? null, thirdPlace: candidates[1]?.ids ?? null };
}

// ── SEASON & PROFILE ANALYTICS ────────────────────────────────────────────

function getSeasonSummary(state, season) {
  const seasonGames = state.games.filter(g => gameInSeason(g, season));
  const matchCount = seasonGames.length;
  const totalPts = seasonGames.reduce((s, g) => s + (g.ptsGain || 0) + (g.ptsLoss || 0), 0);
  const sevenDaysAgo = new Date(Date.now() - 7 * MS_PER_DAY);
  const sevenDayGames = seasonGames.filter(g => new Date(g.date) >= sevenDaysAgo);
  const sevenDayStats = computeWindowPlayerStats(state.players, sevenDayGames);
  const topClimber = [...state.players].sort((a, b) => (sevenDayStats[b.id]?.pts || 0) - (sevenDayStats[a.id]?.pts || 0))[0];
  const topClimberPts = topClimber ? (sevenDayStats[topClimber.id]?.pts || 0) : 0;
  const mostActive = [...state.players].sort((a, b) => sevenDayGames.filter(g => g.sideA.includes(b.id) || g.sideB.includes(b.id)).length - sevenDayGames.filter(g => g.sideA.includes(a.id) || g.sideB.includes(a.id)).length)[0];
  const activeCount = mostActive ? sevenDayGames.filter(g => g.sideA.includes(mostActive.id) || g.sideB.includes(mostActive.id)).length : 0;
  return { matchCount, totalPts, topClimber, topClimberPts, mostActive, activeCount };
}
function getBestTeammate(playerId, games) {
  if (!games.length) return null;
  const teammates = {};
  games.forEach(g => {
    const onA = g.sideA.includes(playerId);
    const teamIds = onA ? g.sideA : g.sideB;
    const won = (onA && g.winner === "A") || (!onA && g.winner === "B");
    teamIds.forEach(tid => {
      if (tid === playerId) return;
      if (!teammates[tid]) teammates[tid] = { wins: 0, total: 0 };
      teammates[tid].total++;
      if (won) teammates[tid].wins++;
    });
  });
  if (!Object.keys(teammates).length) return null;
  const best = Object.entries(teammates).sort((a, b) => (b[1].wins / Math.max(b[1].total, 1)) - (a[1].wins / Math.max(a[1].total, 1)))[0];
  return { id: best[0], wins: best[1].wins, total: best[1].total };
}
function getToughestOpponent(playerId, games) {
  if (!games.length) return null;
  const opponents = {};
  games.forEach(g => {
    const onA = g.sideA.includes(playerId);
    const oppIds = onA ? g.sideB : g.sideA;
    const won = (onA && g.winner === "A") || (!onA && g.winner === "B");
    oppIds.forEach(oid => {
      if (!opponents[oid]) opponents[oid] = { wins: 0, total: 0 };
      opponents[oid].total++;
      if (won) opponents[oid].wins++;
    });
  });
  if (!Object.keys(opponents).length) return null;
  const toughest = Object.entries(opponents).sort((a, b) => (a[1].wins / Math.max(a[1].total, 1)) - (b[1].wins / Math.max(b[1].total, 1)))[0];
  return { id: toughest[0], wins: toughest[1].wins, total: toughest[1].total };
}
function getAvgGoals(playerId, games) {
  if (!games.length) return { goalsFor: 0, goalsAgainst: 0 };
  let goalsFor = 0, goalsAgainst = 0;
  games.forEach(g => {
    const onA = g.sideA.includes(playerId);
    const [scoreFor, scoreAgainst] = onA ? [g.scoreA, g.scoreB] : [g.scoreB, g.scoreA];
    goalsFor += scoreFor; goalsAgainst += scoreAgainst;
  });
  return { goalsFor: (goalsFor / games.length).toFixed(1), goalsAgainst: (goalsAgainst / games.length).toFixed(1) };
}

// ── ROLE LOGGING HELPERS (LogView) ────────────────────────────────────────

// Cycles ATK↔DEF for a two-player side. First click: p[0]=ATK, p[1]=DEF.
// Subsequent clicks: swap. This is a single-operation swap — no partial states.
function cycleRoleForSide(rows, rowId, sideIds) {
  return rows.map(row => {
    if (row.id !== rowId) return row;
    const [p1, p2] = sideIds;
    if (!p1 || !p2) return row;
    const currentAtk = sideIds.find(id => row.roles?.[id] === 'ATK');
    if (!currentAtk) {
      // Initial assignment: first player ATK, second DEF
      return { ...row, roles: { ...row.roles, [p1]: 'ATK', [p2]: 'DEF' } };
    }
    // Swap ATK↔DEF
    const other = sideIds.find(id => id !== currentAtk);
    return { ...row, roles: { ...row.roles, [currentAtk]: 'DEF', [other]: 'ATK' } };
  });
}

// Sets both players on a side to FLEX (mid-game swap at 5-goal mark).
// Per §3.7 of research: both players on the swapping side are logged FLEX
// because each accumulated a mixed ATK+DEF observation in the same game.
function setFlexForSide(rows, rowId, sideIds) {
  return rows.map(row => {
    if (row.id !== rowId) return row;
    const newRoles = { ...row.roles };
    sideIds.forEach(id => { newRoles[id] = 'FLEX'; });
    return { ...row, roles: newRoles };
  });
}

// Clears role assignment for a side (undo flex or full clear)
function clearRolesForSide(rows, rowId, sideIds) {
  return rows.map(row => {
    if (row.id !== rowId) return row;
    const newRoles = { ...row.roles };
    sideIds.forEach(id => { delete newRoles[id]; });
    return { ...row, roles: newRoles };
  });
}

const MK = getMonthKey();
const SEED = {
  players: [
    { id: "p1", name: "Alex", mmr: 1060, pts: 74, wins: 9, losses: 3, streak: 4, championships: [], runnerUps: [], thirdPlaces: [] },
    { id: "p2", name: "Jordan", mmr: 1038, pts: 55, wins: 8, losses: 4, streak: 3, championships: [], runnerUps: [], thirdPlaces: [] },
    { id: "p3", name: "Sam", mmr: 1018, pts: 38, wins: 6, losses: 5, streak: 1, championships: [], runnerUps: [], thirdPlaces: [] },
    { id: "p4", name: "Riley", mmr: 992, pts: 18, wins: 4, losses: 6, streak: -2, championships: [], runnerUps: [], thirdPlaces: [] },
    { id: "p5", name: "Casey", mmr: 981, pts: 10, wins: 3, losses: 7, streak: -3, championships: [], runnerUps: [], thirdPlaces: [] },
    { id: "p6", name: "Morgan", mmr: 970, pts: 4, wins: 2, losses: 8, streak: -4, championships: [], runnerUps: [], thirdPlaces: [] },
  ],
  games: [
    { id: "g1", sideA: ["p1", "p2"], sideB: ["p3", "p4"], winner: "A", scoreA: 10, scoreB: 6, ptsGain: 14, ptsLoss: 6, mmrGain: 14, mmrLoss: 6, date: new Date(Date.now() - 86400000 * 3).toISOString(), monthKey: MK },
    { id: "g2", sideA: ["p3", "p5"], sideB: ["p4", "p6"], winner: "A", scoreA: 10, scoreB: 7, ptsGain: 12, ptsLoss: 5, mmrGain: 12, mmrLoss: 5, date: new Date(Date.now() - 86400000 * 2).toISOString(), monthKey: MK },
    { id: "g3", sideA: ["p2", "p4"], sideB: ["p1", "p3"], winner: "A", scoreA: 10, scoreB: 8, ptsGain: 13, ptsLoss: 5, mmrGain: 13, mmrLoss: 5, date: new Date(Date.now() - 86400000).toISOString(), monthKey: MK },
  ],
  monthlyPlacements: {}, finals: {}, rules: DEFAULT_RULES, finalsDate: null,
  seasonStart: null, seasons: [], _meta: {}, announcement: null, nextSeasonDate: null,
  announcementQueue: [], adminActions: [],
};

async function loadState() {
  try {
    const { data, error } = await supabase.from('app_state').select('state').eq('id', 1).single();
    if (error) { console.warn('Failed to load from Supabase, using seed:', error); return SEED; }
    const s = data?.state || {};
    const hasState = s && Object.keys(s).length > 0;
    if (!hasState) return SEED;
    const ns = normaliseState(s);
    if (typeof s._v !== 'number') ns._v = 0;
    return ns;
  } catch (err) { console.error('Supabase load error:', err); return SEED; }
}

function normaliseState(s) {
  const rawFinals = s.finals || {};
  const normFinals = Object.fromEntries(Object.entries(rawFinals).map(([k, v]) => [k, { liveScores: {}, ...v }]));
  return {
    players: (s.players || []).map(p => ({
      streakPower: 0, lossStreakPower: 0,
      mmr_atk: p.mmr_atk ?? p.mmr ?? CONFIG.STARTING_MMR,
      mmr_def: p.mmr_def ?? p.mmr ?? CONFIG.STARTING_MMR,
      wins_atk: p.wins_atk ?? 0, losses_atk: p.losses_atk ?? 0,
      wins_def: p.wins_def ?? 0, losses_def: p.losses_def ?? 0,
      preferredRole: p.preferredRole ?? (p.position === 'attack' ? 'ATK' : p.position === 'defense' ? 'DEF' : 'FLEX'),
      runnerUps: p.runnerUps ?? [],
      thirdPlaces: p.thirdPlaces ?? [],
      ...p,
    })),
    games: (s.games || []).map(g => ({ penalties: {}, ...g })),
    monthlyPlacements: s.monthlyPlacements || {},
    finals: normFinals,
    rules: s.rules || DEFAULT_RULES,
    finalsDate: s.finalsDate || null,
    seasonStart: s.seasonStart || null,
    seasons: s.seasons || (s.seasonStart ? [{ id: "season_1", label: "Season 1", startAt: s.seasonStart, endAt: null, createdAt: s.seasonStart }] : []),
    _meta: s._meta || {},
    announcement: s.announcement || null,
    nextSeasonDate: s.nextSeasonDate || null,
    announcementQueue: s.announcementQueue || [],
    adminActions: (s.adminActions || []).slice(-5),
    _v: typeof s._v === 'number' ? s._v : 0,
  };
}

function validateState(next) {
  if (!next?.players?.length && !next?.games?.length) throw new Error("Refusing to write empty leaderboard state");
}

function isDuplicateGame(candidate, existing) {
  const day = candidate.date.slice(0, 10);
  const cSet = new Set([...candidate.sideA, ...candidate.sideB]);
  return existing.some(g => {
    if (g.date.slice(0, 10) !== day) return false;
    const gSet = new Set([...g.sideA, ...g.sideB]);
    if (gSet.size !== cSet.size) return false;
    for (const id of cSet) if (!gSet.has(id)) return false;
    return g.scoreA === candidate.scoreA && g.scoreB === candidate.scoreB;
  });
}

function checkSuspiciousGame(game) {
  const total = game.scoreA + game.scoreB;
  const margin = Math.abs(game.scoreA - game.scoreB);
  const warnings = [];
  if (total > 50) warnings.push({ type: "totalScore", value: total, msg: "Total score unusually high (>50)" });
  if (margin > 15) warnings.push({ type: "margin", value: margin, msg: "Score margin unusually large (>15)" });
  if (total === 0) warnings.push({ type: "zeroScore", msg: "Both teams scored 0" });
  if (game.scoreA === game.scoreB) warnings.push({ type: "draw", msg: "Draw - game should have a winner" });
  return warnings;
}

const _sq = {
  pending: null, confirmedV: -1, inflightV: null, echoSet: new Set(),
  retries: 0, timer: null, onConflict: null, onSuccess: null,
};
let syncToast = null;

function saveState(s, onConflict, onSuccess) {
  clearTimeout(_sq.timer);
  _sq.pending = { stateToSave: s };
  _sq.onConflict = onConflict || null;
  _sq.onSuccess = onSuccess || null;
  _sq.retries = 0;
  _sq.timer = setTimeout(_flushSave, 350);
}

async function cleanupBackupsIfNeeded() {
  try {
    const now = Date.now();
    const last = readLocalNumber(LAST_BACKUP_CLEANUP_KEY, 0);
    if (now - last < BACKUP_CLEANUP_INTERVAL_MS) return;
    await supabase.from("app_state_history").delete().lt("saved_at", new Date(now - BACKUP_RETENTION_DAYS * 86400000).toISOString());
    writeLocalNumber(LAST_BACKUP_CLEANUP_KEY, now);
  } catch (e) { console.warn("[backup] cleanup failed:", e?.message || e); }
}

async function maybeBackupState(stateToBackup) {
  try {
    const hasData = (stateToBackup?.players?.length || 0) > 0 || (stateToBackup?.games?.length || 0) > 0;
    if (!hasData) return;
    const now = Date.now();
    const last = readLocalNumber(LAST_BACKUP_KEY, 0);
    if (now - last < BACKUP_MIN_INTERVAL_MS) return;
    await supabase.from("app_state_history").insert({ state: stateToBackup });
    writeLocalNumber(LAST_BACKUP_KEY, now);
    await cleanupBackupsIfNeeded();
  } catch (e) { console.warn("[backup] insert failed:", e?.message || e); }
}

async function _flushSave() {
  if (!_sq.pending) return;
  const { stateToSave } = _sq.pending;
  const baseV = _sq.confirmedV >= 0 ? _sq.confirmedV : (stateToSave._v ?? 0);
  const nextV = baseV + 1;
  try { validateState(stateToSave); } catch (err) {
    console.warn('[sync] validation failed:', err.message);
    syncToast?.("Refusing to write empty leaderboard state", "err");
    _sq.pending = null; _sq.retries = 0; _sq.onConflict = null; _sq.onSuccess = null; _sq.inflightV = null;
    return;
  }
  _sq.inflightV = nextV;
  _sq.echoSet.add(nextV);
  const enriched = { ...stateToSave, _meta: { ...(stateToSave._meta || {}), lastWriteAt: new Date().toISOString(), lastWriterId: getClientId() }, _v: nextV };
  const slimmed = slimState(enriched);
  async function succeed() {
    console.log('[sync] ✓ saved _v' + nextV);
    _sq.confirmedV = nextV; _sq.inflightV = null;
    setTimeout(() => _sq.echoSet.delete(nextV), 10000);
    const cb = _sq.onSuccess;
    _sq.pending = null; _sq.retries = 0; _sq.onSuccess = null; _sq.onConflict = null;
    cb?.(nextV, enriched._meta);
    void maybeBackupState(slimmed);
  }
  async function handleConflict() {
    console.warn('[sync] conflict at v' + baseV);
    _sq.inflightV = null; _sq.echoSet.delete(nextV);
    try {
      const { data: cur } = await supabase.from('app_state').select('state').eq('id', 1).single();
      if (!cur?.state) return;
      const remote = normaliseState(cur.state);
      const remoteV = remote._v ?? 0;
      if (remoteV >= nextV) { await succeed(); return; }
      _sq.confirmedV = remoteV;
      const cb = _sq.onConflict;
      _sq.pending = null; _sq.retries = 0; _sq.onConflict = null; _sq.onSuccess = null;
      cb?.(remote);
    } catch (e) { console.error('[sync] conflict fetch failed:', e); }
  }
  try {
    const { data: rpcData, error: rpcErr } = await supabase.rpc('update_state_versioned', { expected_v: baseV, new_state: slimmed });
    if (!rpcErr && rpcData === true) { await succeed(); return; }
    if (!rpcErr && rpcData === false) { await handleConflict(); return; }
    console.warn('[sync] RPC unavailable:', rpcErr?.message);
    _sq.inflightV = null; _sq.echoSet.delete(nextV);
    _sq.pending = null; _sq.retries = 0; _sq.onConflict = null; _sq.onSuccess = null;
    syncToast?.("Sync unavailable (versioned RPC missing).", "err");
    return;
  } catch (err) {
    _sq.inflightV = null; _sq.echoSet.delete(nextV);
    const MAX = 6;
    if (_sq.retries < MAX) {
      _sq.retries++;
      const delay = Math.min(500 * Math.pow(2, _sq.retries), 20000);
      console.warn('[sync] retry ' + _sq.retries + '/' + MAX + ' in ' + delay + 'ms:', err.message);
      _sq.timer = setTimeout(_flushSave, delay);
    } else {
      console.error('[sync] failed after ' + MAX + ' retries:', err.message);
      const cb = _sq.onConflict;
      _sq.pending = null; _sq.retries = 0; _sq.onConflict = null; _sq.onSuccess = null;
      try {
        const { data: cur } = await supabase.from('app_state').select('state').eq('id', 1).single();
        if (cur?.state) cb?.(normaliseState(cur.state));
      } catch { }
    }
  }
}

function slimState(s) {
  return {
    ...s,
    games: (s.games || []).map(({ playerDeltas, scoreMult, eloScale, rankScale, winMult, lossMult, mmrGain, mmrLoss, ptsFactor, winnerAvgMMR, loserAvgMMR, ...keep }) => keep),
  };
}

function safeTestMutation(cur) {
  return { ...cur, _rapidTest: Math.random(), _v: (cur._v ?? 0) + 1 };
}

// ── UI HELPERS ────────────────────────────────────────────────────────────

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
function fmtMonth(key) {
  if (!key) return "";
  const [y, m] = key.split("-");
  return new Date(y, m - 1).toLocaleString("en-GB", { month: "long", year: "numeric" });
}
function pName(id, players) { return players.find(p => p.id === id)?.name || "?"; }

// ── SHARED SMALL COMPONENTS ───────────────────────────────────────────────

function StreakBadge({ streak, streakPower = 0, showMult = false }) {
  const s = streak || 0;
  if (s === 0) return <span className="text-dd">—</span>;
  const m = s > 0 ? streakMult(streakPower, true) : streakMult(Math.abs(s) * CONFIG.STREAK_POWER_SCALE * 0.4, false);
  return s > 0
    ? <span className="text-g bold">▲{s}{showMult && <span className="xs" style={{ opacity: .7 }}> ×{m.toFixed(2)}</span>}</span>
    : <span className="text-r bold">▼{Math.abs(s)}{showMult && <span className="xs" style={{ opacity: .7 }}> ×{m.toFixed(2)}</span>}</span>;
}

function Pips({ used }) {
  return <>{Array.from({ length: CONFIG.MAX_PLACEMENTS_PER_MONTH }).map((_, i) => <span key={i} className={`pip ${i < used ? "pip-u" : "pip-f"}`} />)}</>;
}

function PosBadge({ pos }) {
  if (!pos || pos === "none" || (Array.isArray(pos) && pos.length === 0)) return <span className="text-dd xs">—</span>;
  const positions = Array.isArray(pos) ? pos : [pos];
  const badges = positions.map(p => {
    if (p === "attack") return <span key="atk" className="pos-badge pos-atk">🗡 ATK</span>;
    if (p === "defense") return <span key="def" className="pos-badge pos-def">🛡 DEF</span>;
    if (p === "both" || p === "flex") return <span key="flex" className="pos-badge pos-both">⚡ FLEX</span>;
    return null;
  }).filter(Boolean);
  return <div className="fac" style={{ gap: 3, flexWrap: "wrap" }}>{badges}</div>;
}

function Toast({ t }) {
  if (!t) return null;
  return <div className={`toast ${t.type || "info"}`}>{t.msg}</div>;
}

function Modal({ onClose, children, large = false }) {
  return createPortal(
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${large ? "modal-lg" : ""}`}>{children}</div>
    </div>,
    document.body
  );
}

// ── TREND INDICATOR — SVG bar chart, no emoji ─────────────────────────────
// Per ui-ux-pro-max §Icons: no emoji as structural icons.
// Uses ascending/descending bar SVG with design-token colors.
// aria-label for accessibility. Minimum 4-game window to avoid noise.

function HotBadge() {
  return (
    <span
      className="trend-hot"
      aria-label="Hot form — 4 or more wins in last 5 games"
      title="4+ wins in last 5 games"
    >
      <svg width="9" height="9" viewBox="0 0 9 9" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
        <rect x="0" y="6" width="2.2" height="3" opacity="0.45" rx="0.5"/>
        <rect x="3.4" y="3" width="2.2" height="6" opacity="0.72" rx="0.5"/>
        <rect x="6.8" y="0" width="2.2" height="9" rx="0.5"/>
      </svg>
      <span className="trend-label">HOT</span>
    </span>
  );
}

function ColdBadge() {
  return (
    <span
      className="trend-cold"
      aria-label="Cold form — 1 or fewer wins in last 5 games"
      title="0–1 wins in last 5 games"
    >
      <svg width="9" height="9" viewBox="0 0 9 9" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
        <rect x="0" y="0" width="2.2" height="9" rx="0.5"/>
        <rect x="3.4" y="3" width="2.2" height="6" opacity="0.72" rx="0.5"/>
        <rect x="6.8" y="6" width="2.2" height="3" opacity="0.45" rx="0.5"/>
      </svg>
      <span className="trend-label">COLD</span>
    </span>
  );
}

function TrendIndicator({ pid, games }) {
  const results = lastNResults(pid, games, 5);
  if (results.length < 4) return null;
  const wins = results.filter(r => r === 'W').length;
  if (wins >= 4) return <HotBadge />;
  if (wins <= 1) return <ColdBadge />;
  return null;
}

// ── PLACEMENT PROGRESS ────────────────────────────────────────────────────
// Per ui-ux-pro-max §Accessibility: role=progressbar with aria attributes.
// No emoji. Narrow 3px track so it fits in table column without dominating.
// Colour transitions amber → green as completion nears.

function PlacementProgress({ used, total }) {
  const pct = Math.round((used / total) * 100);
  const fillColor = pct >= 80
    ? 'var(--green)'
    : 'linear-gradient(90deg, var(--amber), color-mix(in srgb, var(--amber) 55%, var(--green)))';
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 4, lineHeight: 1 }}>
        {used}<span style={{ color: 'var(--dimmer)' }}>/{total}</span>
        <span style={{ marginLeft: 4, color: 'var(--dimmer)', fontSize: 10 }}>placed</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={used}
        aria-valuemax={total}
        aria-label={`${used} of ${total} placement games completed`}
        style={{ width: 38, height: 3, borderRadius: 2, background: 'var(--b2)', overflow: 'hidden' }}
      >
        <div style={{
          height: '100%', borderRadius: 2, width: `${pct}%`,
          background: fillColor,
          transition: 'width .5s ease, background .5s ease',
        }} />
      </div>
    </div>
  );
}

// ── TROPHY TIER COMPONENTS ─────────────────────────────────────────────────

// Diamond: 3+ undefeated championship wins — blue/purple gradient badge
function DiamondBadge({ count }) {
  return (
    <span
      className="trophy-diamond"
      title={`${count}× Monthly Champion — undefeated`}
      aria-label={`Diamond champion — ${count} titles`}
    >
      <svg width="8" height="9" viewBox="0 0 8 9" fill="currentColor" aria-hidden="true">
        <polygon points="4,0 7,3 4,9 1,3" opacity="0.7"/>
        <polygon points="4,0 7,3 4,5 1,3" opacity="1"/>
      </svg>
      ×{count}
    </span>
  );
}

// Silver runner-up: SVG medal silhouette in silver tone
function RunnerUpBadge() {
  return (
    <span
      className="trophy-runner"
      title="Monthly Runner-Up"
      aria-label="Runner-up"
    >
      <svg width="13" height="15" viewBox="0 0 13 15" fill="none" aria-hidden="true">
        <circle cx="6.5" cy="5.5" r="4.5" stroke="#b0c8c0" strokeWidth="1.5" fill="none"/>
        <path d="M3.5 10 L2 15 L6.5 12.5 L11 15 L9.5 10" fill="#b0c8c0" opacity="0.6"/>
      </svg>
    </span>
  );
}

// Bronze third-place: same silhouette in amber-brown tone
function ThirdPlaceBadge() {
  return (
    <span
      className="trophy-third"
      title="Monthly Third Place"
      aria-label="Third place"
    >
      <svg width="13" height="15" viewBox="0 0 13 15" fill="none" aria-hidden="true">
        <circle cx="6.5" cy="5.5" r="4.5" stroke="#c8864a" strokeWidth="1.5" fill="none"/>
        <path d="M3.5 10 L2 15 L6.5 12.5 L11 15 L9.5 10" fill="#c8864a" opacity="0.55"/>
      </svg>
    </span>
  );
}

function Sparkline({ pid, games }) {
  const results = lastNResults(pid, games, 5);
  if (!results.length) return null;
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
      {results.map((r, i) => (
        <div key={i} style={{
          width: 5, height: 5, borderRadius: "50%",
          background: r === "W" ? "var(--green)" : "var(--red)",
          opacity: 0.5 + (i / results.length) * 0.5,
        }} />
      ))}
    </div>
  );
}

// Last N game results for sparkline/trend
function lastNResults(pid, games, n = 5) {
  return [...games]
    .filter(g => g.sideA.includes(pid) || g.sideB.includes(pid))
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(-n)
    .map(g => {
      const onA = g.sideA.includes(pid);
      return (onA && g.winner === "A") || (!onA && g.winner === "B") ? "W" : "L";
    });
}

function ConfirmDialog({ title, msg, onConfirm, onCancel, danger = false }) {
  return (
    <Modal onClose={onCancel}>
      <div className="confirm-modal">
        <div className="modal-title" style={{ color: danger ? "var(--red)" : "var(--amber)" }}>{title}</div>
        <p className="text-d sm mb16">{msg}</p>
        <div className="fac" style={{ justifyContent: "center", gap: 10 }}>
          <button className="btn btn-g" onClick={onCancel}>Cancel</button>
          <button className={`btn ${danger ? "btn-d" : "btn-p"}`} onClick={onConfirm}>Confirm</button>
        </div>
      </div>
    </Modal>
  );
}

// ── MARKDOWN RENDERER ─────────────────────────────────────────────────────

function renderMd(md) {
  if (!md) return "";
  const lines = md.split("\n");
  const out = [];
  let i = 0;
  function inlineFormat(text) {
    return text
      .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/___(.+?)___/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__(.+?)__/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+?)\*/g, "<em>$1</em>")
      .replace(/_([^_\n]+?)_/g, "<em>$1</em>")
      .replace(/~~(.+?)~~/g, "<del>$1</del>")
      .replace(/==(.+?)==/g, "<mark style='background:rgba(232,184,74,.25);color:var(--gold);padding:1px 3px;border-radius:3px'>$1</mark>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href='$2' target='_blank' rel='noopener' style='color:var(--amber);text-decoration:underline'>$1</a>")
      .replace(/\[\[([^\]]+)\]\]/g, "<span style='color:var(--amber)'>$1</span>");
  }
  const calloutColors = { note:"var(--blue)",info:"var(--blue)",tip:"var(--green)",hint:"var(--green)",success:"var(--green)",check:"var(--green)",done:"var(--green)",warning:"var(--orange)",caution:"var(--orange)",attention:"var(--orange)",danger:"var(--red)",error:"var(--red)",bug:"var(--red)",important:"var(--amber)",quote:"var(--dimmer)",example:"var(--purple)" };
  const calloutIcons = { note:"ℹ",info:"ℹ",tip:"💡",hint:"💡",success:"✓",check:"✓",done:"✓",warning:"⚠",caution:"⚠",attention:"⚠",danger:"✕",error:"✕",bug:"🐛",important:"!",quote:'"',example:"≡" };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim(); const codeLines = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { codeLines.push(lines[i].replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")); i++; }
      out.push(`<pre style="background:var(--s2);border:1px solid var(--b2);border-radius:6px;padding:12px 14px;overflow-x:auto;font-family:var(--mono);font-size:12px;line-height:1.7;margin:8px 0">${lang?`<span style="font-size:10px;color:var(--dimmer);display:block;margin-bottom:6px;letter-spacing:1px;text-transform:uppercase">${lang}</span>`:""}${codeLines.join("\n")}</pre>`);
      i++; continue;
    }
    if (/^> \[!(\w+)\]/.test(line)) {
      const match = line.match(/^> \[!(\w+)\]\s*(.*)$/);
      const type = (match[1]||"note").toLowerCase();
      const title = match[2]||(type.charAt(0).toUpperCase()+type.slice(1));
      const color = calloutColors[type]||"var(--blue)"; const icon = calloutIcons[type]||"ℹ";
      const bodyLines = []; i++;
      while (i < lines.length && /^> /.test(lines[i])) { bodyLines.push(lines[i].slice(2)); i++; }
      out.push(`<div style="border-left:3px solid ${color};background:color-mix(in srgb,${color} 8%,var(--s2));border-radius:0 6px 6px 0;padding:10px 14px;margin:8px 0"><div style="font-weight:700;color:${color};font-size:12px;margin-bottom:4px">${icon} ${inlineFormat(title)}</div><div style="color:var(--dim);font-size:13px;line-height:1.7">${bodyLines.map(inlineFormat).join("<br>")}</div></div>`);
      continue;
    }
    if (/^> /.test(line)) {
      const bqLines = [];
      while (i < lines.length && /^> /.test(lines[i])) { bqLines.push(lines[i].slice(2)); i++; }
      out.push(`<blockquote style="border-left:3px solid var(--b2);padding:6px 14px;margin:6px 0;color:var(--dim);font-style:italic">${bqLines.map(inlineFormat).join("<br>")}</blockquote>`);
      continue;
    }
    if (/^#{1,6} /.test(line)) {
      const m = line.match(/^(#{1,6}) (.+)$/);
      const lvl = m[1].length;
      const sizes = [28,18,15,13,13,13]; const colors = ["var(--amber)","var(--text)","var(--text)","var(--dim)","var(--dim)","var(--dim)"];
      out.push(`<div style="font-family:var(--disp);font-size:${sizes[lvl-1]}px;font-weight:${lvl<=2?700:600};color:${colors[lvl-1]};margin:${lvl===1?"0 0 12px":"14px 0 5px"};${lvl===2?"border-bottom:1px solid var(--b1);padding-bottom:4px":""}">${inlineFormat(m[2])}</div>`);
      i++; continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { out.push('<hr style="border:none;border-top:1px solid var(--b2);margin:14px 0">'); i++; continue; }
    if (/^\|.+\|/.test(line)) {
      const tableLines = [];
      while (i < lines.length && /^\|/.test(lines[i])) { tableLines.push(lines[i]); i++; }
      if (tableLines.length >= 2) {
        const headers = tableLines[0].split("|").filter((_,j,a)=>j>0&&j<a.length-1).map(h=>h.trim());
        const alignRow = tableLines[1].split("|").filter((_,j,a)=>j>0&&j<a.length-1);
        const aligns = alignRow.map(c=>{const t=c.trim();return t.startsWith(":")&&t.endsWith(":")?"center":t.endsWith(":")?"right":"left";});
        const rows = tableLines.slice(2).map(r=>r.split("|").filter((_,j,a)=>j>0&&j<a.length-1).map(c=>c.trim()));
        out.push(`<div style="overflow-x:auto;margin:8px 0"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>${headers.map((h,ci)=>`<th style="text-align:${aligns[ci]||"left"};padding:6px 10px;border-bottom:2px solid var(--b2);color:var(--dimmer);font-weight:600;font-size:10px;letter-spacing:.5px;text-transform:uppercase;background:var(--s2)">${inlineFormat(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row,ri)=>`<tr style="${ri%2?"background:rgba(255,255,255,.015)":""}">${row.map((cell,ci)=>`<td style="text-align:${aligns[ci]||"left"};padding:6px 10px;border-bottom:1px solid var(--b1)">${inlineFormat(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      }
      continue;
    }
    if (/^(\s*)([-*+]|\d+\.) /.test(line)) {
      const listLines = [];
      while (i < lines.length && (/^(\s*)([-*+]|\d+\.) /.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) { listLines.push(lines[i]); i++; }
      const isOrdered = /^\s*\d+\./.test(listLines[0]);
      const items = listLines.map(item=>{
        const m = item.match(/^(\s*)([-*+]|\d+\.) (.*)$/); if(!m) return "";
        const text = m[3];
        if(/^\[[ xX]\] /.test(text)){const checked=/^\[[xX]\] /.test(text);const label=text.replace(/^\[[ xX]\] /,"");return `<li style="list-style:none;margin-left:-18px"><label style="display:flex;align-items:flex-start;gap:6px"><input type="checkbox" ${checked?"checked":""} disabled style="margin-top:2px;accent-color:var(--amber)"><span style="${checked?"text-decoration:line-through;opacity:.5":""}">${inlineFormat(label)}</span></label></li>`;}
        return `<li>${inlineFormat(text)}</li>`;
      }).join("");
      out.push(isOrdered?`<ol style="padding-left:20px;margin:6px 0">${items}</ol>`:`<ul style="padding-left:20px;margin:6px 0">${items}</ul>`);
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    out.push(`<p style="margin-bottom:8px;line-height:1.7;color:var(--dim);font-size:13px">${inlineFormat(line)}</p>`);
    i++;
  }
  return out.join("\n");
}

function AnnouncementModal({ announcement, onClose }) {
  if (!announcement) return null;
  const isFlashy = announcement.type === "seasonLaunch" || announcement.type === "flashy";
  const isHype = announcement.type === "hype";
  const isSpecial = isFlashy || isHype;
  const title = announcement.title || (isSpecial ? "New Season" : "Announcement");
  const subtitle = announcement.subtitle || (announcement.type === "seasonLaunch" ? "Fresh leaderboard" : null);
  const headerClass = isHype ? "season-launch hype" : isFlashy ? "season-launch" : "";
  const titleClass = isHype ? "season-title hype" : isFlashy ? "season-title" : "";
  const pillClass = isHype ? "season-pill hype" : "season-pill";
  return (
    <Modal onClose={onClose} large>
      <div className={headerClass} style={{ margin:"-28px -28px 0",padding:isHype?"24px 28px 20px":"20px 28px 16px",borderBottom:"1px solid var(--b1)",marginBottom:isHype?20:16,borderRadius:"14px 14px 0 0" }}>
        {isHype && <div className="xs" style={{ letterSpacing:2,textTransform:"uppercase",color:"var(--gold)",opacity:.7,marginBottom:8,fontWeight:600,animation:"fadeInUp .4s ease both" }}>✦ &nbsp;Announcement&nbsp; ✦</div>}
        <div style={{ display:"flex",alignItems:"center",gap:10,flexWrap:"wrap" }}>
          {isSpecial?<span className={titleClass} style={{ animation:isHype?"fadeInUp .5s ease both .1s":"none" }}>{title}</span>:<span className="modal-title" style={{ marginBottom:0 }}>{title}</span>}
          {subtitle&&<span className={isSpecial?pillClass:"tag tag-a"}>{subtitle}</span>}
        </div>
      </div>
      <div className="md" style={{ animation:isHype?"fadeInUp .5s ease both .2s":"none" }} dangerouslySetInnerHTML={{ __html: renderMd(announcement.body || "") }} />
      <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:isHype?20:14,flexWrap:"wrap",gap:8 }}>
        {announcement.endsAt?<span className="xs text-dd">Visible until {new Date(announcement.endsAt).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</span>:<span/>}
        <button className={isHype?"btn btn-p":"btn btn-g"} onClick={onClose}>{isHype?"Let's go 🔥":"Close"}</button>
      </div>
    </Modal>
  );
}

// ── PLAYER PROFILE ─────────────────────────────────────────────────────────

function PlayerProfile({ player, state, onClose, isAdmin, onEdit, seasonMode, onSeasonModeChange, selectedSeasonId, onSelectedSeasonIdChange }) {
  const placementKey = getCurrentPlacementKey(state);
  const placements = (state.monthlyPlacements[placementKey] || {})[player.id] || 0;
  const currentSeason = getCurrentSeason(state);
  const selectedSeason = seasonMode === "all" ? null : (state.seasons || []).find(s => s.id === selectedSeasonId) || currentSeason || null;
  const myGames = [...state.games].filter(g => (g.sideA.includes(player.id) || g.sideB.includes(player.id)) && gameInSeason(g, selectedSeason)).sort((a,b)=>new Date(b.date)-new Date(a.date));
  const rankBase = [...state.players].sort((a,b)=>(b.pts||0)-(a.pts||0));
  const rank = rankBase.findIndex(p=>p.id===player.id)+1;
  const seasonWindowStats = computeWindowPlayerStats(state.players, state.games.filter(g=>gameInSeason(g,selectedSeason)));
  const scopedStats = seasonWindowStats[player.id] || { wins:0,losses:0,pts:0,streak:0 };
  const displayWins = seasonMode==="all"?player.wins:scopedStats.wins;
  const displayLosses = seasonMode==="all"?player.losses:scopedStats.losses;
  const displayPts = seasonMode==="all"?(player.pts||0):scopedStats.pts;
  const displayStreak = seasonMode==="all"?player.streak:scopedStats.streak;
  const champs = player.championships || [];
  const runnerUps = player.runnerUps || [];
  const thirdPlaces = player.thirdPlaces || [];

  // Diamond: 3+ championship wins
  const isDiamond = champs.length >= 3;

  return (
    <Modal onClose={onClose} large>

      {/* Diamond banner — 3+ champs */}
      {isDiamond && (
        <div className="championship-banner" style={{ background:'radial-gradient(ellipse 140% 140% at 0% 0%,rgba(96,168,232,.16) 0%,rgba(165,133,232,.11) 50%,transparent 100%)',borderColor:'rgba(96,168,232,.38)',marginBottom:8 }}>
          <svg width="24" height="26" viewBox="0 0 24 26" fill="none" aria-hidden="true" style={{ flexShrink:0 }}>
            <polygon points="12,0 22,8 12,26 2,8" fill="rgba(96,168,232,.18)" stroke="#a8d8f8" strokeWidth="1.2"/>
            <polygon points="12,0 22,8 12,13 2,8" fill="rgba(165,133,232,.35)"/>
          </svg>
          <div style={{ flex:1 }}>
            <div className="xs bold" style={{ letterSpacing:2,textTransform:"uppercase",color:'#a8d8f8',marginBottom:3 }}>
              Triple Champion — {champs.length}× Title
            </div>
            <div className="sm text-d">
              {champs.map((c,i)=><span key={i}>{fmtMonth(c.month)}{c.partner?` (w/ ${c.partner})`:""}{i<champs.length-1?" · ":""}</span>)}
            </div>
          </div>
          {isAdmin && <button className="btn btn-warn btn-sm" onClick={onEdit}>Edit</button>}
        </div>
      )}

      {/* Standard champion banner — 1-2 champs */}
      {champs.length > 0 && !isDiamond && (
        <div className="championship-banner">
          <svg width="22" height="20" viewBox="0 0 22 20" fill="none" aria-hidden="true" style={{ flexShrink:0 }}>
            <path d="M11 1L14 7L20 8L15.5 12.5L16.5 19L11 16L5.5 19L6.5 12.5L2 8L8 7Z" fill="rgba(232,184,74,.2)" stroke="var(--gold)" strokeWidth="1.2"/>
          </svg>
          <div style={{ flex:1 }}>
            <div className="xs text-am bold" style={{ letterSpacing:2,textTransform:"uppercase" }}>Monthly Champion</div>
            <div className="sm text-d" style={{ marginTop:2 }}>
              {champs.map((c,i)=><span key={i}>{fmtMonth(c.month)}{c.partner?` (w/ ${c.partner})`:""}{i<champs.length-1?" · ":""}</span>)}
            </div>
          </div>
          {isAdmin && !isDiamond && <button className="btn btn-warn btn-sm" onClick={onEdit}>Edit</button>}
        </div>
      )}

      {/* Runner-up banner */}
      {runnerUps.length > 0 && (
        <div className="championship-banner" style={{ background:'radial-gradient(ellipse 140% 140% at 0% 0%,rgba(176,200,192,.10) 0%,var(--s2) 100%)',borderColor:'rgba(176,200,192,.32)',marginBottom:8 }}>
          <svg width="22" height="20" viewBox="0 0 22 20" fill="none" aria-hidden="true" style={{ flexShrink:0 }}>
            <path d="M11 1L14 7L20 8L15.5 12.5L16.5 19L11 16L5.5 19L6.5 12.5L2 8L8 7Z" fill="rgba(176,200,192,.12)" stroke="#b0c8c0" strokeWidth="1.2"/>
          </svg>
          <div>
            <div className="xs bold" style={{ letterSpacing:2,textTransform:"uppercase",color:'#b0c8c0' }}>Runner-Up</div>
            <div className="sm text-d" style={{ marginTop:2 }}>
              {runnerUps.map((c,i)=><span key={i}>{fmtMonth(c.month)}{c.partner?` (w/ ${c.partner})`:""}{i<runnerUps.length-1?" · ":""}</span>)}
            </div>
          </div>
        </div>
      )}

      {/* Third-place banner */}
      {thirdPlaces.length > 0 && (
        <div className="championship-banner" style={{ background:'radial-gradient(ellipse 140% 140% at 0% 0%,rgba(200,134,74,.09) 0%,var(--s2) 100%)',borderColor:'rgba(200,134,74,.28)',marginBottom:8 }}>
          <svg width="22" height="20" viewBox="0 0 22 20" fill="none" aria-hidden="true" style={{ flexShrink:0 }}>
            <path d="M11 1L14 7L20 8L15.5 12.5L16.5 19L11 16L5.5 19L6.5 12.5L2 8L8 7Z" fill="rgba(200,134,74,.10)" stroke="#c8864a" strokeWidth="1.2"/>
          </svg>
          <div>
            <div className="xs bold" style={{ letterSpacing:2,textTransform:"uppercase",color:'#c8864a' }}>Third Place</div>
            <div className="sm text-d" style={{ marginTop:2 }}>
              {thirdPlaces.map((c,i)=><span key={i}>{fmtMonth(c.month)}{c.partner?` (w/ ${c.partner})`:""}{i<thirdPlaces.length-1?" · ":""}</span>)}
            </div>
          </div>
        </div>
      )}

      <div className="prof-head">
        <div className="prof-av">{player.name[0].toUpperCase()}</div>
        <div style={{ flex:1 }}>
          <div className="prof-name">{player.name}</div>
          <div className="prof-sub">Rank #{rank} · {displayPts || 0} pts</div>
          <div className="fac" style={{ gap:6,marginTop:8,flexWrap:"wrap" }}>
            <button className={`btn btn-sm ${seasonMode==="all"?"btn-p":"btn-g"}`} onClick={()=>onSeasonModeChange("all")}>All-time</button>
            <button className={`btn btn-sm ${seasonMode==="season"?"btn-p":"btn-g"}`} onClick={()=>onSeasonModeChange("season")}>Season</button>
            {seasonMode==="season"&&(<select className="inp" style={{ padding:"4px 8px",fontSize:11,minWidth:130 }} value={selectedSeasonId||""} onChange={e=>onSelectedSeasonIdChange(e.target.value)}>{(state.seasons||[]).map(se=><option key={se.id} value={se.id}>{se.label}</option>)}</select>)}
          </div>
        </div>
        <div className="fac" style={{ gap:6 }}>
          {isAdmin&&champs.length===0&&<button className="btn btn-g btn-sm" onClick={onEdit}>Edit</button>}
          <button className="btn btn-g btn-sm" onClick={onClose} style={{ fontSize:14,padding:"3px 9px" }}>×</button>
        </div>
      </div>

      <div className="grid-3 mb16">
        <div className="stat-box">
          <div className="stat-lbl">Points</div>
          <div className="stat-val am">
            {placements>=CONFIG.MAX_PLACEMENTS_PER_MONTH?(displayPts||0):<span className="text-dd" title="Complete placements to reveal points">?</span>}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-lbl">Record</div>
          <div className="stat-val" style={{ fontSize:20 }}>
            <span className="text-g">{displayWins}</span>
            <span className="text-dd" style={{ fontSize:13 }}>/</span>
            <span className="text-r">{displayLosses}</span>
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-lbl">Streak</div>
          <div className="stat-val" style={{ fontSize:20 }}><StreakBadge streak={displayStreak} streakPower={player.streakPower||0} showMult /></div>
        </div>
      </div>

      <div className="grid-3 mb16">
        <div className="stat-box">
          <div className="stat-lbl">Win Rate</div>
          <div className="stat-val" style={{ fontSize:20 }}>
            {displayWins+displayLosses>0?<span className={displayWins/(displayWins+displayLosses)>=.5?"text-g":"text-r"}>{Math.round(displayWins/(displayWins+displayLosses)*100)}%</span>:<span className="text-dd">—</span>}
          </div>
        </div>
        <div className="stat-box">
          {((player.wins_atk||0)+(player.losses_atk||0)+(player.wins_def||0)+(player.losses_def||0))>0?(() => {
            const atkTotal=(player.wins_atk||0)+(player.losses_atk||0);
            const defTotal=(player.wins_def||0)+(player.losses_def||0);
            const atkWR=atkTotal?Math.round((player.wins_atk||0)/atkTotal*100):null;
            const defWR=defTotal?Math.round((player.wins_def||0)/defTotal*100):null;
            return (
              <>
                <div className="stat-lbl" style={{ marginBottom:8 }}>Positional</div>
                <div style={{ display:"flex",flexDirection:"column",gap:7 }}>
                  <div style={{ display:"flex",alignItems:"center",gap:7 }}>
                    <span className="role-tag role-atk" style={{ pointerEvents:"none",flexShrink:0 }}>🗡 ATK</span>
                    <div style={{ lineHeight:1.25 }}>
                      <div style={{ fontWeight:700,fontSize:14,color:"var(--orange)" }}>{player.mmr_atk||player.mmr} <span style={{ fontSize:10,fontWeight:500,color:"var(--dimmer)" }}>MMR</span></div>
                      <div className="xs text-dd"><span className="text-g">{player.wins_atk||0}W</span> / <span className="text-r">{player.losses_atk||0}L</span>{atkWR!==null&&<span style={{ marginLeft:5,color:atkWR>=50?"var(--green)":"var(--red)" }}>{atkWR}%</span>}</div>
                    </div>
                  </div>
                  <div style={{ display:"flex",alignItems:"center",gap:7 }}>
                    <span className="role-tag role-def" style={{ pointerEvents:"none",flexShrink:0 }}>🛡 DEF</span>
                    <div style={{ lineHeight:1.25 }}>
                      <div style={{ fontWeight:700,fontSize:14,color:"var(--blue)" }}>{player.mmr_def||player.mmr} <span style={{ fontSize:10,fontWeight:500,color:"var(--dimmer)" }}>MMR</span></div>
                      <div className="xs text-dd"><span className="text-g">{player.wins_def||0}W</span> / <span className="text-r">{player.losses_def||0}L</span>{defWR!==null&&<span style={{ marginLeft:5,color:defWR>=50?"var(--green)":"var(--red)" }}>{defWR}%</span>}</div>
                    </div>
                  </div>
                </div>
              </>
            );
          })():(
            <><div className="stat-lbl">Position</div><div style={{ marginTop:8 }}><PosBadge pos={player.position}/></div></>
          )}
        </div>
        <div className="stat-box">
          <div className="stat-lbl">Placements this month</div>
          <div style={{ marginTop:10 }}>
            {placements>=CONFIG.MAX_PLACEMENTS_PER_MONTH
              ? <span className="placement-badge placement-done">✓ Placed</span>
              : <PlacementProgress used={placements} total={CONFIG.MAX_PLACEMENTS_PER_MONTH} />
            }
          </div>
        </div>
      </div>

      {seasonMode==="season"&&myGames.length>0&&(
        <div style={{ marginBottom:16,padding:12,borderRadius:8,background:"var(--s2)",border:"1px solid var(--b1)" }}>
          <div className="sec" style={{ marginBottom:8 }}>Season Insights</div>
          <div className="grid-2" style={{ gap:12 }}>
            {(()=>{const best=getBestTeammate(player.id,myGames);return(<div><div className="xs text-dd">Best Teammate</div>{best?<div><span style={{ fontWeight:600 }}>{pName(best.id,state.players)}</span> <span className="xs text-g">{Math.round(best.wins/best.total*100)}% ({best.wins}W)</span></div>:<div className="xs text-dd">—</div>}</div>);})()}
            {(()=>{const tough=getToughestOpponent(player.id,myGames);return(<div><div className="xs text-dd">Toughest Opponent</div>{tough?<div><span style={{ fontWeight:600 }}>{pName(tough.id,state.players)}</span> <span className="xs text-r">{Math.round(tough.wins/tough.total*100)}% ({tough.wins}W)</span></div>:<div className="xs text-dd">—</div>}</div>);})()}
            {(()=>{const {goalsFor,goalsAgainst}=getAvgGoals(player.id,myGames);return(<div><div className="xs text-dd">Avg Goals</div><div><span className="text-g">{goalsFor}</span> <span className="xs text-dd">For</span> / <span className="text-r">{goalsAgainst}</span> <span className="xs text-dd">Against</span></div></div>);})()}
            <div>
              <div className="xs text-dd">PPG (Pts/Game)</div>
              {(()=>{let totalPts=0;myGames.forEach(g=>{const won=didPlayerWin(player.id,g);const delta=won?(g.perPlayerGains?.[player.id]??g.ptsGain):-(g.perPlayerLosses?.[player.id]??g.ptsLoss);totalPts+=delta;});return<div style={{ fontWeight:600 }}>{(totalPts/myGames.length).toFixed(2)}</div>;})()}
            </div>
          </div>
        </div>
      )}

      <div className="sec">Match History</div>
      {myGames.length===0&&<div className="text-d sm">No games yet</div>}
      {myGames.map(g=>{
        const onA=g.sideA.includes(player.id);
        const won=(onA&&g.winner==="A")||(!onA&&g.winner==="B");
        const mates=(onA?g.sideA:g.sideB).filter(id=>id!==player.id).map(id=>pName(id,state.players));
        const opps=(onA?g.sideB:g.sideA).map(id=>pName(id,state.players));
        const myScore=onA?g.scoreA:g.scoreB;
        const oppScore=onA?g.scoreB:g.scoreA;
        return(
          <div key={g.id} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:"1px solid var(--b1)",fontSize:12,gap:6,flexWrap:"wrap" }}>
            <span className={`tag ${won?"tag-w":"tag-l"}`}>{won?"WIN":"LOSS"}</span>
            {mates.length>0&&<span className="text-d sm">w/ {mates.join(" & ")}</span>}
            <span className="text-d sm">vs {opps.join(" & ")}</span>
            {g.roles?.[player.id]&&<span className={`role-tag ${g.roles[player.id]==="ATK"?"role-atk":g.roles[player.id]==="FLEX"?"role-flex":"role-def"}`} style={{ marginRight:3 }}>{g.roles[player.id]==="ATK"?"🗡 ATK":g.roles[player.id]==="FLEX"?"⚡ FLEX":"🛡 DEF"}</span>}
            <span className="disp text-am" style={{ fontSize:15 }}>{myScore}–{oppScore}</span>
            <span className={won?"text-g":"text-r"}>
              {(()=>{const delta=won?(g.perPlayerGains?.[player.id]??g.playerDeltas?.[player.id]?.gain??g.ptsGain):(g.perPlayerLosses?.[player.id]??g.playerDeltas?.[player.id]?.loss??g.ptsLoss);return`${won?"+":"−"}${delta}pts`;})()}
            </span>
            <span className="text-dd xs">{fmtDate(g.date)}</span>
          </div>
        );
      })}
      <button className="btn btn-g w-full mt16" onClick={onClose}>Close</button>
    </Modal>
  );
}

// ── EDIT PLAYER MODAL ──────────────────────────────────────────────────────

function EditPlayerModal({ player, state, setState, showToast, onClose }) {
  const [name, setName] = useState(player.name);
  const [pts, setPts] = useState(String(player.pts || 0));
  const [streak, setStreak] = useState(String(player.streak || 0));
  const [positions, setPositions] = useState(() => {
    const p = player.position;
    if (!p || p === "none") return [];
    if (p === "both") return ["attack","defense","flex"];
    if (Array.isArray(p)) return p;
    return [p];
  });
  const [champMonth, setChampMonth] = useState("");
  const [champPartner, setChampPartner] = useState("");
  const [confirm, setConfirm] = useState(null);

  function save() {
    const newPts = parseInt(pts), newStreak = parseInt(streak);
    if (isNaN(newPts)||isNaN(newStreak)) { showToast("Invalid values","error"); return; }
    if (!name.trim()) { showToast("Name required","error"); return; }
    setState(s=>({ ...s, players:s.players.map(p=>p.id===player.id?{ ...p,name:name.trim(),pts:newPts,streak:newStreak,position:positions.length===0?"none":positions }:p) }));
    showToast("Profile updated"); onClose();
  }

  function addChamp() {
    if (!champMonth) { showToast("Select a month","error"); return; }
    const c = { month:champMonth,partner:champPartner.trim()||null };
    setState(s=>({ ...s,players:s.players.map(p=>p.id===player.id?{ ...p,championships:[...(p.championships||[]),c] }:p) }));
    showToast("Championship added 🏆"); setChampMonth(""); setChampPartner("");
  }

  function removeChamp(i) {
    setState(s=>({ ...s,players:s.players.map(p=>p.id===player.id?{ ...p,championships:(p.championships||[]).filter((_,idx)=>idx!==i) }:p) }));
    showToast("Championship removed");
  }

  function recalcPlayer() {
    setConfirm({ title:"Recalculate from Games?",msg:`This will recalculate ${player.name}'s pts, mmr, wins, losses, and streak from the game log. Manual edits will be overwritten.`,onConfirm:()=>{
      const { players,games }=replayGames(state.players,state.games,state.seasonStart,state.seasons);
      setState(s=>({ ...s,players,games })); showToast("All stats recalculated"); setConfirm(null); onClose();
    }});
  }

  const monthOptions = Array.from({ length:12 }).map((_,i)=>{
    const d=new Date(); d.setMonth(d.getMonth()-i);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  });

  return (
    <>
      <Modal onClose={onClose}>
        <div className="modal-title">Edit — {player.name}</div>
        <div className="sec">Profile</div>
        <div className="field"><label className="lbl">Name</label><input className="inp inp-edit" value={name} onChange={e=>setName(e.target.value)}/></div>
        <div className="grid-2">
          <div className="field"><label className="lbl">Points (visible)</label><input className="inp inp-edit" type="number" value={pts} onChange={e=>setPts(e.target.value)}/></div>
          <div className="field"><label className="lbl">Streak (+win / -loss)</label><input className="inp inp-edit" type="number" value={streak} onChange={e=>setStreak(e.target.value)}/></div>
        </div>
        <div className="field mt8">
          <label className="lbl">Preferred Role</label>
          <div className="fac" style={{ gap:6,marginBottom:6 }}>
            {["ATK","DEF","FLEX"].map(v=>(
              <button key={v} className={`btn btn-sm ${(player.preferredRole||"FLEX")===v?"btn-p":"btn-g"}`}
                onClick={()=>setState(s=>({ ...s,players:s.players.map(p=>p.id===player.id?{ ...p,preferredRole:v }:p) }))}>
                {v==="ATK"?"🗡 ATK":v==="DEF"?"🛡 DEF":"⚡ FLEX"}
              </button>
            ))}
          </div>
          <label className="lbl">Position Badges</label>
          <div className="fac" style={{ gap:6,flexWrap:"wrap",marginBottom:4 }}>
            {[["attack","🗡 Attack"],["defense","🛡 Defense"],["flex","⚡ Flex"]].map(([v,l])=>{
              const on=positions.includes(v);
              return <button key={v} className={`pill ${on?"on":""}`} onClick={()=>setPositions(prev=>prev.includes(v)?prev.filter(x=>x!==v):[...prev,v])}>{l}</button>;
            })}
          </div>
        </div>
        <div className="msg msg-w sm">Manually editing pts/streak will diverge from game history. Use recalculate to re-sync.</div>
        <div className="divider"/>
        <div className="sec">Championships</div>
        {(player.championships||[]).map((c,i)=>(
          <div key={i} className="fbc" style={{ padding:"6px 0",borderBottom:"1px solid var(--b1)",fontSize:12 }}>
            <span className="text-am">🏆 {fmtMonth(c.month)}{c.partner?` (w/ ${c.partner})`:""}</span>
            <button className="btn btn-d btn-sm" onClick={()=>removeChamp(i)}>Remove</button>
          </div>
        ))}
        <div className="grid-2 mt8">
          <div className="field"><label className="lbl">Month</label><select className="inp" value={champMonth} onChange={e=>setChampMonth(e.target.value)}><option value="">Select…</option>{monthOptions.map(m=><option key={m} value={m}>{fmtMonth(m)}</option>)}</select></div>
          <div className="field"><label className="lbl">Partner (optional)</label><input className="inp" placeholder="Teammate name" value={champPartner} onChange={e=>setChampPartner(e.target.value)}/></div>
        </div>
        <button className="btn btn-warn btn-sm" onClick={addChamp}>+ Add Championship</button>
        <div className="divider"/>
        <div className="fac" style={{ justifyContent:"space-between",flexWrap:"wrap",gap:8 }}>
          <button className="btn btn-g btn-sm" onClick={recalcPlayer}>Recalculate All from Games</button>
          <div className="fac">
            <button className="btn btn-g" onClick={onClose}>Cancel</button>
            <button className="btn btn-p" onClick={save}>Save</button>
          </div>
        </div>
      </Modal>
      {confirm&&<ConfirmDialog {...confirm} onCancel={()=>setConfirm(null)}/>}
    </>
  );
}

// ── GAME DETAIL ────────────────────────────────────────────────────────────

function GameDetail({ game, state, setState, isAdmin, showToast, onClose }) {
  const [editing, setEditing] = useState(false);
  const [scoreA, setScoreA] = useState(String(game.scoreA));
  const [scoreB, setScoreB] = useState(String(game.scoreB));
  const [winner, setWinner] = useState(game.winner);
  const [confirm, setConfirm] = useState(null);
  const [penalties, setPenalties] = useState(() => game.penalties || {});
  const [editRoles, setEditRoles] = useState(() => ({ ...(game.roles || {}) }));

  const sA = game.sideA.map(id => state.players.find(p => p.id === id)).filter(Boolean);
  const sB = game.sideB.map(id => state.players.find(p => p.id === id)).filter(Boolean);
  const allPlayers = [...sA, ...sB];

  function setPenalty(pid, type, val) {
    setPenalties(prev => ({ ...prev, [pid]: { ...(prev[pid] || { yellow:0,red:0 }), [type]: Math.max(0, val) } }));
  }

  function savePenalties() {
    const updatedGame = { ...game, penalties };
    const editedGames = state.games.map(g => g.id === game.id ? updatedGame : g);
    const basePlayers = state.players.map(p => ({ ...p, mmr:CONFIG.STARTING_MMR, pts:CONFIG.STARTING_PTS, wins:0, losses:0, streak:0, streakPower:0, lossStreakPower:0 }));
    const { players:newPlayers, games:newGames } = replayGames(basePlayers, editedGames, state.seasonStart, state.seasons);
    const mergedPlayers = newPlayers.map(p => { const orig = state.players.find(x=>x.id===p.id); return { ...p, name:orig?.name||p.name, championships:orig?.championships||[], runnerUps:orig?.runnerUps||[], thirdPlaces:orig?.thirdPlaces||[], position:orig?.position||p.position }; });
    const newPlacements = computePlacements(newGames, state.seasons);
    setState(s => ({ ...s, games:newGames, players:mergedPlayers, monthlyPlacements:newPlacements }));
    const totalCards = Object.values(penalties).reduce((s,v) => (v.yellow||0)+(v.red||0)+s, 0);
    showToast(totalCards > 0 ? "Penalties applied & stats updated" : "Penalties cleared");
    setEditing(false); onClose();
  }

  function saveEdit() {
    const nA=parseInt(scoreA), nB=parseInt(scoreB);
    if (isNaN(nA)||isNaN(nB)||nA<0||nB<0) { showToast("Invalid scores","error"); return; }
    if (nA===nB) { showToast("No draws","error"); return; }
    const updatedGame = { ...game, scoreA:nA, scoreB:nB, winner, penalties, roles:editRoles };
    const editedGames = state.games.map(g => g.id===game.id ? updatedGame : g);
    const basePlayers = state.players.map(p => ({ ...p, mmr:CONFIG.STARTING_MMR, pts:CONFIG.STARTING_PTS, wins:0, losses:0, streak:0, streakPower:0, lossStreakPower:0 }));
    const { players:newPlayers, games:newGames } = replayGames(basePlayers, editedGames, state.seasonStart, state.seasons);
    const mergedPlayers = newPlayers.map(p => { const orig = state.players.find(x=>x.id===p.id); return { ...p, name:orig?.name||p.name, championships:orig?.championships||[], runnerUps:orig?.runnerUps||[], thirdPlaces:orig?.thirdPlaces||[], position:orig?.position||p.position }; });
    const newPlacements = computePlacements(newGames, state.seasons);
    setState(s => ({ ...s, games:newGames, players:mergedPlayers, monthlyPlacements:newPlacements }));
    showToast("Match updated & stats recalculated"); setEditing(false); onClose();
  }

  function deleteGame() {
    setConfirm({ title:"Delete Match?",msg:"Permanently removes this match and recalculates all affected stats.",danger:true,onConfirm:()=>{
      const filteredGames = state.games.filter(g=>g.id!==game.id);
      const basePlayers = state.players.map(p => ({ ...p, mmr:CONFIG.STARTING_MMR, pts:CONFIG.STARTING_PTS, wins:0, losses:0, streak:0, streakPower:0, lossStreakPower:0 }));
      const { players:newPlayers, games:newGames } = replayGames(basePlayers, filteredGames, state.seasonStart, state.seasons);
      const mergedPlayers = newPlayers.map(p => { const orig = state.players.find(x=>x.id===p.id); return { ...p, name:orig?.name||p.name, championships:orig?.championships||[], runnerUps:orig?.runnerUps||[], thirdPlaces:orig?.thirdPlaces||[], position:orig?.position||p.position }; });
      const newPlacements = computePlacements(newGames, state.seasons);
      setState(s => ({ ...s, games:newGames, players:mergedPlayers, monthlyPlacements:newPlacements }));
      showToast("Match deleted & stats recalculated"); setConfirm(null); onClose();
    }});
  }

  function penaltyTotal(pid) {
    const p = penalties[pid] || {};
    return (p.yellow||0)*CONFIG.YELLOW_CARD_PTS + (p.red||0)*CONFIG.RED_CARD_PTS;
  }

  const hasPenalties = Object.values(game.penalties||{}).some(v=>(v.yellow||0)+(v.red||0)>0);

  return (
    <>
      <Modal onClose={onClose}>
        <div className="fbc mb12">
          <div>
            <div className="modal-title" style={{ marginBottom:2 }}>Match Detail</div>
            <div className="xs text-dd">{fmtDate(game.date)}</div>
          </div>
          {isAdmin&&!editing&&(
            <div className="fac" style={{ gap:6 }}>
              <button className="btn btn-warn btn-sm" onClick={()=>setEditing(true)}>Edit</button>
              <button className="btn btn-d btn-sm" onClick={deleteGame}>Delete</button>
            </div>
          )}
        </div>

        <div style={{ display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:14,alignItems:"center",margin:"14px 0" }}>
          <div>
            <div className="xs" style={{ marginBottom:6,fontWeight:600,color:game.winner==="A"?"var(--green)":"var(--dimmer)" }}>{game.winner==="A"?"🏆 ":""}Side A</div>
            {sA.map(p=>{
              const gain=game.perPlayerGains?.[p.id]??game.ptsGain;
              const loss=game.perPlayerLosses?.[p.id]??game.ptsLoss;
              const pen=penaltyTotal(p.id);
              return(
                <div key={p.id} style={{ marginBottom:4 }}>
                  <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                    <span className={`bold ${game.winner==="A"?"text-g":"text-r"}`} style={{ fontSize:14 }}>{p.name}</span>
                    {editing?(
                      <div className="fac" style={{ gap:3 }}>
                        {["ATK","DEF","FLEX"].map(r=>(
                          <button key={r} className={`role-tag ${r==="ATK"?"role-atk":r==="FLEX"?"role-flex":"role-def"}`}
                            style={{ cursor:"pointer",opacity:editRoles[p.id]===r?1:0.3,fontWeight:editRoles[p.id]===r?700:400 }}
                            onClick={()=>setEditRoles(prev=>({ ...prev,[p.id]:prev[p.id]===r?null:r }))}>
                            {r==="ATK"?"🗡 ATK":r==="FLEX"?"⚡ FLEX":"🛡 DEF"}
                          </button>
                        ))}
                      </div>
                    ):(
                      game.roles?.[p.id]&&<span className={`role-tag ${game.roles[p.id]==="ATK"?"role-atk":game.roles[p.id]==="FLEX"?"role-flex":"role-def"}`}>{game.roles[p.id]==="ATK"?"🗡 ATK":game.roles[p.id]==="FLEX"?"⚡ FLEX":"🛡 DEF"}</span>
                    )}
                  </div>
                  <div className="xs text-dd">{game.winner==="A"?<span className="text-g">+{gain}pts</span>:<span className="text-r">−{loss}pts</span>}{pen>0&&<span style={{ color:"var(--orange)",marginLeft:4 }}>−{pen} 🟡</span>}</div>
                </div>
              );
            })}
          </div>
          <div style={{ textAlign:"center" }}>
            {editing?(
              <div style={{ display:"flex",flexDirection:"column",gap:6,alignItems:"center" }}>
                <div className="fac" style={{ gap:6 }}>
                  <input className="inp inp-edit" type="number" min="0" value={scoreA} onChange={e=>setScoreA(e.target.value)} style={{ width:52,textAlign:"center",fontSize:20,fontFamily:"var(--disp)",fontWeight:700 }}/>
                  <span className="text-dd" style={{ fontSize:18 }}>–</span>
                  <input className="inp inp-edit" type="number" min="0" value={scoreB} onChange={e=>setScoreB(e.target.value)} style={{ width:52,textAlign:"center",fontSize:20,fontFamily:"var(--disp)",fontWeight:700 }}/>
                </div>
                <select className="inp" value={winner} onChange={e=>setWinner(e.target.value)} style={{ fontSize:11,padding:"4px 8px" }}>
                  <option value="A">A won</option>
                  <option value="B">B won</option>
                </select>
              </div>
            ):(
              <div className="disp text-am" style={{ fontSize:36,fontWeight:700 }}>{game.scoreA}–{game.scoreB}</div>
            )}
          </div>
          <div style={{ textAlign:"right" }}>
            <div className="xs" style={{ marginBottom:6,fontWeight:600,color:game.winner==="B"?"var(--green)":"var(--dimmer)" }}>Side B{game.winner==="B"?" 🏆":""}</div>
            {sB.map(p=>{
              const gain=game.perPlayerGains?.[p.id]??game.ptsGain;
              const loss=game.perPlayerLosses?.[p.id]??game.ptsLoss;
              const pen=penaltyTotal(p.id);
              return(
                <div key={p.id} style={{ marginBottom:4 }}>
                  <div style={{ display:"flex",alignItems:"center",gap:6,justifyContent:"flex-end" }}>
                    <span className={`bold ${game.winner==="B"?"text-g":"text-r"}`} style={{ fontSize:14 }}>{p.name}</span>
                    {editing?(
                      <div className="fac" style={{ gap:3 }}>
                        {["ATK","DEF","FLEX"].map(r=>(
                          <button key={r} className={`role-tag ${r==="ATK"?"role-atk":r==="FLEX"?"role-flex":"role-def"}`}
                            style={{ cursor:"pointer",opacity:editRoles[p.id]===r?1:0.3,fontWeight:editRoles[p.id]===r?700:400 }}
                            onClick={()=>setEditRoles(prev=>({ ...prev,[p.id]:prev[p.id]===r?null:r }))}>
                            {r==="ATK"?"🗡 ATK":r==="FLEX"?"⚡ FLEX":"🛡 DEF"}
                          </button>
                        ))}
                      </div>
                    ):(
                      game.roles?.[p.id]&&<span className={`role-tag ${game.roles[p.id]==="ATK"?"role-atk":game.roles[p.id]==="FLEX"?"role-flex":"role-def"}`}>{game.roles[p.id]==="ATK"?"🗡 ATK":game.roles[p.id]==="FLEX"?"⚡ FLEX":"🛡 DEF"}</span>
                    )}
                  </div>
                  <div className="xs text-dd">{game.winner==="B"?<span className="text-g">+{gain}pts</span>:<span className="text-r">−{loss}pts</span>}{pen>0&&<span style={{ color:"var(--orange)",marginLeft:4 }}>−{pen} 🟡</span>}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Match quality breakdown — unchanged from original */}
        {!editing&&(()=>{
          const hasFactors = allPlayers.some(p=>game.perPlayerFactors?.[p.id]);
          const hasRoles = game.roles&&Object.keys(game.roles).length>0;
          if (!hasFactors&&!hasRoles) return null;
          const ranked = [...state.players].sort((a,b)=>(b.pts||0)-(a.pts||0));
          const rankOf = id=>{const i=ranked.findIndex(p=>p.id===id);return i===-1?ranked.length:i;};
          const monthPlacements = state.monthlyPlacements?.[getCurrentPlacementKey(state)]||{};
          const isPlaced = pid=>(monthPlacements[pid]||0)>=CONFIG.MAX_PLACEMENTS_PER_MONTH;
          const winnerIds = game.winner==="A"?game.sideA:game.sideB;
          const loserIds = game.winner==="A"?game.sideB:game.sideA;
          const placedWinners = winnerIds.filter(isPlaced);
          const placedLosers = loserIds.filter(isPlaced);
          const avgWinRank = placedWinners.length?placedWinners.reduce((s,id)=>s+rankOf(id),0)/placedWinners.length:null;
          const avgLosRank = placedLosers.length?placedLosers.reduce((s,id)=>s+rankOf(id),0)/placedLosers.length:null;
          const rankImbalance = (avgWinRank!==null&&avgLosRank!==null)?Math.abs(avgWinRank-avgLosRank):0;
          const winnerOutrankedLosers = avgWinRank!==null&&avgLosRank!==null&&avgWinRank<avgLosRank;
          const canShowRankBanner = avgWinRank!==null&&avgLosRank!==null;
          const isLopsided = canShowRankBanner&&rankImbalance>=2;
          const isVeryLopsided = canShowRankBanner&&rankImbalance>=4;
          const bannerColor = isVeryLopsided&&winnerOutrankedLosers?"var(--orange)":isLopsided&&winnerOutrankedLosers?"var(--amber-d)":"var(--b2)";
          const bannerBg = isVeryLopsided&&winnerOutrankedLosers?"rgba(240,144,80,.08)":isLopsided&&winnerOutrankedLosers?"rgba(88,200,130,.06)":"var(--s2)";
          const bannerLabel = !canShowRankBanner?"Placement games — no rank data yet":isVeryLopsided&&winnerOutrankedLosers?"⚠ Heavily mismatched — low pts value":isLopsided&&winnerOutrankedLosers?"↓ Rank mismatch — reduced gains for winners":"✓ Balanced match";
          return(
            <div style={{ margin:"4px 0 12px",border:`1px solid ${bannerColor}`,borderRadius:8,overflow:"hidden" }}>
              <div style={{ background:bannerBg,borderBottom:`1px solid ${bannerColor}`,padding:"6px 12px",display:"flex",alignItems:"center",justifyContent:"space-between" }}>
                <span style={{ fontSize:11,fontWeight:700,color:bannerColor,letterSpacing:.3 }}>{bannerLabel}</span>
                <span className="xs text-dd">{canShowRankBanner?`Rank gap: ${rankImbalance.toFixed(1)}`:"Placement game"}</span>
              </div>
              <div style={{ padding:"8px 12px",display:"flex",flexDirection:"column",gap:8 }}>
                {allPlayers.map(p=>{
                  const f=game.perPlayerFactors?.[p.id]; if(!f) return null;
                  const isWinner=(game.winner==="A"?game.sideA:game.sideB).includes(p.id);
                  const pts=isWinner?(game.perPlayerGains?.[p.id]??game.ptsGain):(game.perPlayerLosses?.[p.id]??game.ptsLoss);
                  const eloLabel=f.eloScale>1.15?"Underdog boost":f.eloScale<0.85?"Favourite penalty":"Even MMR";
                  const eloColor=f.eloScale>1.15?"var(--green)":f.eloScale<0.85?"var(--orange)":"var(--dimmer)";
                  const rankLabel=f.rankScale===1.0?"Unranked — neutral":f.rankScale>1.08?"Rank upset bonus":f.rankScale<0.92?"Rank penalty":"Balanced";
                  const rankColor=f.rankScale===1.0?"var(--dimmer)":f.rankScale>1.08?"var(--green)":f.rankScale<0.92?"var(--orange)":"var(--dimmer)";
                  return(
                    <div key={p.id} style={{ padding:"8px 10px",borderRadius:6,background:"var(--s1)",border:"1px solid var(--b1)" }}>
                      <div style={{ display:"flex",alignItems:"baseline",justifyContent:"space-between",marginBottom:6 }}>
                        <span style={{ fontWeight:700,fontSize:13 }}>{p.name}</span>
                        <span style={{ fontFamily:"var(--disp)",fontWeight:700,fontSize:15,color:isWinner?"var(--green)":"var(--red)" }}>{isWinner?"+":"−"}{pts} pts</span>
                      </div>
                      <div style={{ display:"flex",flexDirection:"column",gap:4 }}>
                        <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                          <span style={{ fontSize:10,color:"var(--dimmer)",width:90,flexShrink:0 }}>MMR (70%)</span>
                          <div style={{ flex:1,height:5,borderRadius:3,background:"var(--b2)",overflow:"hidden" }}><div style={{ height:"100%",borderRadius:3,width:`${Math.min(100,f.eloScale*50)}%`,background:eloColor,transition:"width .4s" }}/></div>
                          <span style={{ fontSize:10,color:eloColor,width:120,flexShrink:0,textAlign:"right" }}>×{f.eloScale.toFixed(2)} {eloLabel}</span>
                        </div>
                        <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                          <span style={{ fontSize:10,color:"var(--dimmer)",width:90,flexShrink:0 }}>Rank (30%)</span>
                          <div style={{ flex:1,height:5,borderRadius:3,background:"var(--b2)",overflow:"hidden" }}><div style={{ height:"100%",borderRadius:3,width:`${Math.min(100,f.rankScale*70)}%`,background:rankColor,transition:"width .4s" }}/></div>
                          <span style={{ fontSize:10,color:rankColor,width:120,flexShrink:0,textAlign:"right" }}>×{f.rankScale.toFixed(2)} {rankLabel}</span>
                        </div>
                        {(()=>{
                          const mq=f.matchQuality??f.qualityScore??1;
                          const mqPct=Math.round(mq*100);
                          const mqColor=mq<0.80?"var(--red)":mq<0.95?"var(--orange)":mq>1.10?"var(--green)":"var(--dimmer)";
                          const mqLabel=mq<0.80?"Low value":mq<0.95?"Slightly favoured":mq>1.15?"Underdog!":mq>1.05?"Slight underdog":"Even";
                          return(
                            <div style={{ display:"flex",alignItems:"center",gap:8,marginTop:2,paddingTop:4,borderTop:"1px solid var(--b1)" }}>
                              <span style={{ fontSize:10,color:"var(--dim)",width:90,flexShrink:0,fontWeight:600 }}>Match quality</span>
                              <div style={{ flex:1,height:6,borderRadius:3,background:"var(--b2)",overflow:"hidden" }}><div style={{ height:"100%",borderRadius:3,width:`${Math.min(100,mqPct)}%`,background:mqColor,transition:"width .4s",boxShadow:`0 0 4px ${mqColor}88` }}/></div>
                              <span style={{ fontSize:10,color:mqColor,width:120,flexShrink:0,textAlign:"right",fontWeight:600 }}>×{mq.toFixed(2)} — {mqLabel}</span>
                            </div>
                          );
                        })()}
                        {(()=>{
                          const played=game.roles?.[p.id]; if(!played) return null;
                          const pref=state.players.find(x=>x.id===p.id)?.preferredRole;
                          const oop=pref&&pref!=="FLEX"&&pref!==played&&played!=="FLEX";
                          const col=oop?"var(--amber)":"var(--dimmer)";
                          const label=played==="FLEX"?"FLEX — mid-game swap, neutral":oop?`Out of position — pref ${pref}, played ${played}`:`${played} — in position`;
                          return(
                            <div style={{ display:"flex",alignItems:"center",gap:8,marginTop:2,paddingTop:4,borderTop:"1px solid var(--b1)" }}>
                              <span style={{ fontSize:10,color:"var(--dim)",width:90,flexShrink:0 }}>Position</span>
                              <span style={{ fontSize:10,color:col,flex:1 }}>{oop?"⚠ ":played==="FLEX"?"↕ ":"✓ "}{label}</span>
                              <span style={{ fontSize:10,color:col,width:120,flexShrink:0,textAlign:"right" }}>{played==="FLEX"?"×1.00 neutral":oop?"×1.12 win · ×0.89 loss":"×1.00 neutral"}</span>
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })}
                <div className="xs text-dd" style={{ lineHeight:1.6,paddingTop:2 }}>Match quality = 70% MMR gap + 30% rank gap. FLEX = mid-game swap, neutral on all tracks.</div>
              </div>
            </div>
          );
        })()}

        {isAdmin&&(
          <div style={{ marginTop:4 }}>
            <div className="sec" style={{ marginBottom:8 }}>Disciplinary Cards</div>
            <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
              {allPlayers.map(p=>{
                const pen=penalties[p.id]||{ yellow:0,red:0 };
                return(
                  <div key={p.id} style={{ display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:"var(--s2)",borderRadius:8,border:"1px solid var(--b1)" }}>
                    <span style={{ flex:1,fontWeight:600,fontSize:13 }}>{p.name}</span>
                    <div className="fac" style={{ gap:4 }}>
                      <span style={{ fontSize:16 }}>🟡</span>
                      <button className="btn btn-g btn-sm" style={{ padding:"2px 7px",minWidth:22 }} onClick={()=>setPenalty(p.id,"yellow",Math.max(0,(pen.yellow||0)-1))}>−</button>
                      <span style={{ minWidth:16,textAlign:"center",fontWeight:700,fontSize:13 }}>{pen.yellow||0}</span>
                      <button className="btn btn-g btn-sm" style={{ padding:"2px 7px",minWidth:22 }} onClick={()=>setPenalty(p.id,"yellow",(pen.yellow||0)+1)}>+</button>
                      <span className="xs text-dd">−{CONFIG.YELLOW_CARD_PTS}pts ea</span>
                    </div>
                    <div className="fac" style={{ gap:4 }}>
                      <span style={{ fontSize:16 }}>🔴</span>
                      <button className="btn btn-g btn-sm" style={{ padding:"2px 7px",minWidth:22 }} onClick={()=>setPenalty(p.id,"red",Math.max(0,(pen.red||0)-1))}>−</button>
                      <span style={{ minWidth:16,textAlign:"center",fontWeight:700,fontSize:13 }}>{pen.red||0}</span>
                      <button className="btn btn-g btn-sm" style={{ padding:"2px 7px",minWidth:22 }} onClick={()=>setPenalty(p.id,"red",(pen.red||0)+1)}>+</button>
                      <span className="xs text-dd">−{CONFIG.RED_CARD_PTS}pts ea</span>
                    </div>
                    {penaltyTotal(p.id)>0&&<span style={{ color:"var(--orange)",fontWeight:700,fontSize:12,minWidth:50,textAlign:"right" }}>−{penaltyTotal(p.id)} pts</span>}
                  </div>
                );
              })}
            </div>
            {!editing&&<button className="btn btn-warn w-full mt8" onClick={savePenalties}>Apply Penalties</button>}
          </div>
        )}

        {!isAdmin&&hasPenalties&&<div className="msg msg-e" style={{ marginTop:8,fontSize:11 }}>⚠ Disciplinary penalties have been applied to this match</div>}

        <div className="fac mt16" style={{ justifyContent:"flex-end",gap:8 }}>
          {editing?(<><button className="btn btn-g" onClick={()=>setEditing(false)}>Cancel</button><button className="btn btn-p" onClick={saveEdit}>Save & Recalculate</button></>):(<button className="btn btn-g w-full" onClick={onClose}>Close</button>)}
        </div>
      </Modal>
      {confirm&&<ConfirmDialog {...confirm} onCancel={()=>setConfirm(null)}/>}
    </>
  );
}

// ── LIVE TICKER ────────────────────────────────────────────────────────────

const _dismissedTickers = new Set();

function LiveTicker({ games, players, finals, monthKey, onNavToPlay }) {
  const [, forceUpdate] = useState(0);
  const bracket = finals?.[monthKey]?.bracket;
  const liveScores = finals?.[monthKey]?.liveScores || {};
  const liveMatchKey = bracket && ['upper','lower','final'].find(k => liveScores[k]?.active && bracket[k] && !bracket[k].winner);
  if (liveMatchKey) {
    const m = bracket[liveMatchKey];
    const labMap = { upper:'Semi 1', lower:'Semi 2', final:'Grand Final' };
    const pA = (m.sideA||[]).map(id=>pName(id,players)).join(' & ');
    const pB = (m.sideB||[]).map(id=>pName(id,players)).join(' & ');
    const lA=liveScores[liveMatchKey]?.scoreA??0, lB=liveScores[liveMatchKey]?.scoreB??0;
    const leading=lA>lB?'A':lB>lA?'B':null;
    return(
      <div onClick={onNavToPlay} style={{ background:'radial-gradient(ellipse 80% 300% at 0% 50%,rgba(232,184,74,.14),var(--s1))',border:'1px solid rgba(232,184,74,.4)',borderRadius:10,padding:'8px 16px',display:'flex',alignItems:'center',gap:10,fontSize:12,animation:'slideUp .3s ease',cursor:'pointer' }}>
        <span className="tag" style={{ background:'rgba(232,184,74,.2)',color:'var(--gold)',flexShrink:0 }}>🏆 LIVE</span>
        <span style={{ flex:1 }}>
          <span style={{ fontWeight:700,color:leading==='A'?'var(--green)':'var(--text)' }}>{pA}</span>
          <span className="disp text-am" style={{ margin:'0 10px',fontSize:18,fontWeight:700 }}>{lA}–{lB}</span>
          <span style={{ fontWeight:700,color:leading==='B'?'var(--green)':'var(--text)' }}>{pB}</span>
          <span className="text-dd xs" style={{ marginLeft:8 }}>{labMap[liveMatchKey]}</span>
        </span>
        <span className="xs text-dd">Watch →</span>
      </div>
    );
  }
  const latest = [...(games||[])].sort((a,b)=>new Date(b.date)-new Date(a.date))[0];
  if (!latest) return null;
  const tickerId = latest.id;
  if (_dismissedTickers.has(tickerId)) return null;
  const age = Date.now() - new Date(latest.date).getTime();
  if (age > 5*60*1000) return null;
  const wIds = latest.winner==="A"?latest.sideA:latest.sideB;
  const lIds = latest.winner==="A"?latest.sideB:latest.sideA;
  return(
    <div style={{ background:"radial-gradient(ellipse 80% 300% at 0% 50%,rgba(94,201,138,.12),var(--s1))",border:"1px solid var(--amber-d)",borderRadius:10,padding:"8px 16px",display:"flex",alignItems:"center",gap:10,fontSize:12,animation:"slideUp .3s ease" }}>
      <span className="tag tag-w" style={{ flexShrink:0 }}>RESULT</span>
      <span style={{ flex:1 }}>
        <span className="text-g bold">{wIds.map(id=>pName(id,players)).join(" & ")}</span>
        <span className="text-dd"> beat </span>
        <span>{lIds.map(id=>pName(id,players)).join(" & ")}</span>
        <span className="text-am bold" style={{ marginLeft:8,fontFamily:"var(--disp)" }}>{latest.scoreA}–{latest.scoreB}</span>
      </span>
      <button onClick={()=>{ _dismissedTickers.add(tickerId); forceUpdate(n=>n+1); }} style={{ background:"none",border:"none",color:"var(--dimmer)",cursor:"pointer",fontSize:14,padding:"0 4px" }}>×</button>
    </div>
  );
}

// ── LEADERBOARD VIEW ───────────────────────────────────────────────────────

function LeaderboardView({ state, setState, onSelectPlayer, onNavToPlay, onNavToHistory, rtConnected, isAdmin, showToast, syncStatus }) {
  const monthKey = getMonthKey();
  const placementKey = getCurrentPlacementKey(state);
  const currentSeason = getCurrentSeason(state);
  const seasonGames = (state.games||[]).filter(g=>gameInSeason(g,currentSeason));
  const seasonStats = computeWindowPlayerStats(state.players, seasonGames);
  const ranked = [...(state.players??[])].sort((a,b)=>(b.pts||0)-(a.pts||0));
  const [showRecalcConfirm, setShowRecalcConfirm] = useState(false);

  function doRecalc() {
    const { players,games } = replayGames(state.players,state.games,state.seasonStart,state.seasons);
    const monthlyPlacements = computePlacements(games, state.seasons);
    setState(s=>({ ...s,players,games,monthlyPlacements }));
    showToast("All stats recalculated from game log"); setShowRecalcConfirm(false);
  }

  const monthGames = (state.games??[]).filter(g=>g.monthKey===monthKey);
  const prevSnapshot = useRef(null);
  const animClearTimer = useRef(null);
  const [animMap, setAnimMap] = useState({});

  useEffect(()=>{
    const next = {};
    ranked.forEach((p,i)=>{ next[p.id]={ rank:i,pts:p.pts||0 }; });
    const prev = prevSnapshot.current;
    if (!prev) { prevSnapshot.current=next; return; }
    const anims = {};
    ranked.forEach((p,i)=>{
      const pr=prev[p.id]?.rank, pp=prev[p.id]?.pts;
      if (pr!==undefined&&pr!==i) anims[p.id]=i<pr?"rank-up":"rank-down";
      else if (pp!==undefined&&pp!==(p.pts||0)) anims[p.id]="pts-changed";
    });
    prevSnapshot.current=next;
    if (Object.keys(anims).length) { clearTimeout(animClearTimer.current); setAnimMap(anims); animClearTimer.current=setTimeout(()=>setAnimMap({}),1200); }
  },[state.players]);

  return (
    <>
      <div className="stack page-fade">
        <LiveTicker games={state.games} players={state.players} finals={state.finals} monthKey={monthKey} onNavToPlay={onNavToPlay}/>
        {isAdmin&&(
          <div style={{ display:"flex",justifyContent:"flex-end" }}>
            <button className="btn btn-g btn-sm" onClick={()=>setShowRecalcConfirm(true)}>↺ Recalc</button>
          </div>
        )}
        <div className="grid-3">
          <div className="stat-box"><div className="stat-lbl">Players</div><div className="stat-val am">{(state.players??[]).length}</div></div>
          <div className="stat-box" style={{ cursor:"pointer" }} onClick={onNavToHistory}>
            <div className="stat-lbl">Games This Month</div>
            <div className="stat-val">{monthGames.length}</div>
            <div className="xs text-dd" style={{ marginTop:3 }}>View history →</div>
          </div>
          <div className="stat-box"><div className="stat-lbl">Top Points</div><div className="stat-val am">{ranked[0]?.pts??0}</div></div>
        </div>

        {(()=>{
          const placedRanked=ranked.filter(p=>(state.monthlyPlacements[placementKey]||{})[p.id]>=CONFIG.MAX_PLACEMENTS_PER_MONTH).slice(0,4);
          return placedRanked.length>=2&&(
            <div className="card" style={{ cursor:"pointer",transition:"border-color .15s" }} onClick={()=>onNavToPlay()} onMouseEnter={e=>e.currentTarget.style.borderColor="var(--amber-d)"} onMouseLeave={e=>e.currentTarget.style.borderColor=""}>
              <div className="card-header"><span className="card-title">Championship Race</span><span className="tag tag-a" style={{ cursor:"pointer" }}>View Finals →</span></div>
              <div style={{ padding:"10px 16px",display:"flex",gap:8,flexWrap:"wrap" }}>
                {placedRanked.map((p,i)=>(
                  <div key={p.id} style={{ flex:"1 1 120px",padding:"8px 12px",borderRadius:8,background:i===0?"radial-gradient(ellipse 120% 120% at 100% 100%,rgba(232,184,74,.15),var(--s2))":i===1?"radial-gradient(ellipse 120% 120% at 100% 100%,rgba(192,200,196,.08),var(--s2))":i===2?"radial-gradient(ellipse 120% 120% at 100% 100%,rgba(200,134,74,.08),var(--s2))":"var(--s2)",border:`1px solid ${i===0?"rgba(232,184,74,.35)":i===1?"rgba(192,200,196,.2)":i===2?"rgba(200,134,74,.2)":"var(--b2)"}`}}>
                    <div className="xs" style={{ marginBottom:3,color:i===0?"var(--gold)":i===1?"#c0c8c4":i===2?"#c8864a":"var(--dimmer)" }}>{i===0?"🥇":i===1?"🥈":i===2?"🥉":`#${i+1}`}</div>
                    <div style={{ fontWeight:600,fontSize:13 }}>{p.name}</div>
                    <div className="xs" style={{ color:i===0?"var(--gold)":"var(--amber)",marginTop:2 }}>{p.pts||0} pts</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        <div className="card">
          <div className="card-header">
            <span className="card-title">Rankings — {currentSeason?.label||fmtMonth(monthKey)}</span>
            <div className="fac" style={{ gap:8 }}>
              <span className={`rt-dot ${rtConnected?"live":""}`} title={rtConnected?"Live":"Connecting…"}/>
              <span className="xs text-dd">{rtConnected?"Live":"…"}</span>
              {isAdmin&&syncStatus!=='idle'&&(
                <span className="xs" style={{ color:syncStatus==='saving'?'var(--dimmer)':syncStatus==='saved'?'var(--green)':syncStatus==='conflict'?'var(--orange)':'var(--red)' }}>
                  {syncStatus==='saving'?'↑ saving':syncStatus==='saved'?'✓ saved':syncStatus==='conflict'?'⚡ synced':'⚠ error'}
                </span>
              )}
            </div>
          </div>

          {/* Desktop table */}
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>#</th><th>Player</th><th>Points</th><th>W</th><th>L</th><th>Win%</th><th>Streak</th><th>ATK / DEF</th><th>Status</th></tr>
              </thead>
              <tbody>
                {(()=>{
                  let placedCount=0;
                  return ranked.map((p,i)=>{
                    const placements=(state.monthlyPlacements[placementKey]||{})[p.id]||0;
                    const isPlaced=placements>=CONFIG.MAX_PLACEMENTS_PER_MONTH;
                    const rankNum=isPlaced?++placedCount:null;
                    const sStat=seasonStats[p.id]||{ wins:0,losses:0,streak:0 };
                    const total=sStat.wins+sStat.losses;
                    const pct=total?Math.round(sStat.wins/total*100):0;
                    const anim=animMap[p.id]||"";
                    const champCount=(p.championships||[]).length;
                    return(
                      <tr key={p.id} className={`lb-row ${anim}`} style={{ animationDelay:`${i*28}ms`,opacity:isPlaced?1:0.6 }} onClick={()=>onSelectPlayer(p)}>
                        <td><span className={`rk ${isPlaced?(rankNum===1?"r1":rankNum===2?"r2":rankNum===3?"r3":""):""}` } style={!isPlaced?{ color:"var(--dimmer)" }:{}}>
                          {isPlaced?(rankNum===1?"①":rankNum===2?"②":rankNum===3?"③":`#${rankNum}`):<span style={{ fontSize:9,letterSpacing:.5,fontFamily:"var(--sans)",fontWeight:500 }}>UNRANKED</span>}
                        </span></td>

                        {/* Name cell — trophy tiers + trend indicator */}
                        <td>
                          <div style={{ display:"flex",alignItems:"center",gap:6,flexWrap:"wrap" }}>
                            <span className="bold">{p.name}</span>
                            {champCount>=3
                              ? <DiamondBadge count={champCount}/>
                              : champCount>0
                                ? <svg width="13" height="13" viewBox="0 0 22 20" fill="none" aria-label="Monthly Champion" title="Monthly Champion" style={{ flexShrink:0 }}><path d="M11 1L14 7L20 8L15.5 12.5L16.5 19L11 16L5.5 19L6.5 12.5L2 8L8 7Z" fill="rgba(232,184,74,.22)" stroke="var(--gold)" strokeWidth="1.4"/></svg>
                                : null}
                            {(p.runnerUps||[]).length>0&&<RunnerUpBadge/>}
                            {(p.thirdPlaces||[]).length>0&&<ThirdPlaceBadge/>}
                            <Sparkline pid={p.id} games={seasonGames}/>
                            <TrendIndicator pid={p.id} games={seasonGames}/>
                          </div>
                        </td>

                        <td>
                          {isPlaced
                            ? <><span className="bold" style={{ fontSize:14 }}>{p.pts||0}</span>{anim==="rank-up"&&<span className="xs text-g" style={{ marginLeft:5 }}>▲</span>}{anim==="rank-down"&&<span className="xs text-r" style={{ marginLeft:5 }}>▼</span>}</>
                            : <span className="text-dd" style={{ fontSize:10,fontFamily:"var(--sans)",fontWeight:500,letterSpacing:.3 }}>—</span>
                          }
                        </td>
                        <td><span className="text-g bold">{sStat.wins}</span></td>
                        <td><span className="text-r bold">{sStat.losses}</span></td>
                        <td><span className={pct>=50?"text-g":"text-d"}>{total?`${pct}%`:"—"}</span></td>
                        <td><StreakBadge streak={sStat.streak} streakPower={p.streakPower||0} showMult/></td>
                        <td>
                          {((p.wins_atk||0)+(p.losses_atk||0)+(p.wins_def||0)+(p.losses_def||0))>0?(
                            <div style={{ lineHeight:1.3 }}>
                              <div className="fac" style={{ gap:4 }}>
                                <span className="role-tag role-atk" style={{ pointerEvents:"none" }}>🗡</span>
                                <span style={{ fontSize:12,fontWeight:600,color:"var(--orange)" }}>{p.mmr_atk||p.mmr}</span>
                                <span className="xs text-dd">{p.wins_atk||0}W</span>
                              </div>
                              <div className="fac" style={{ gap:4,marginTop:3 }}>
                                <span className="role-tag role-def" style={{ pointerEvents:"none" }}>🛡</span>
                                <span style={{ fontSize:12,fontWeight:600,color:"var(--blue)" }}>{p.mmr_def||p.mmr}</span>
                                <span className="xs text-dd">{p.wins_def||0}W</span>
                              </div>
                            </div>
                          ):<PosBadge pos={p.position}/>}
                        </td>

                        {/* Placement status — progress bar for unranked */}
                        <td>
                          {isPlaced
                            ? <span className="placement-badge placement-done">✓ Placed</span>
                            : <PlacementProgress used={placements} total={CONFIG.MAX_PLACEMENTS_PER_MONTH}/>
                          }
                        </td>
                      </tr>
                    );
                  });
                })()}
                {ranked.length===0&&<tr><td colSpan={9} style={{ textAlign:"center",padding:32,color:"var(--dimmer)" }}>No players yet — ask an admin to onboard players</td></tr>}
              </tbody>
            </table>
          </div>

          {/* Mobile card layout */}
          <div className="lb-cards">
            {(()=>{
              let placedCount=0;
              return ranked.map((p,i)=>{
                const placements=(state.monthlyPlacements[placementKey]||{})[p.id]||0;
                const isPlaced=placements>=CONFIG.MAX_PLACEMENTS_PER_MONTH;
                const rankNum=isPlaced?++placedCount:null;
                const sStat=seasonStats[p.id]||{ wins:0,losses:0,streak:0 };
                const total=sStat.wins+sStat.losses;
                const pct=total?Math.round(sStat.wins/total*100):0;
                const champCount=(p.championships||[]).length;
                return(
                  <div key={p.id} className="lb-card" onClick={()=>onSelectPlayer(p)}>
                    <div className="lb-card-rank">
                      {isPlaced?<span style={{ color:rankNum===1?"var(--gold)":rankNum===2?"#c0c8c4":rankNum===3?"#c8864a":"var(--dim)" }}>#{rankNum}</span>:<span style={{ fontSize:9,color:"var(--dimmer)",fontFamily:"var(--sans)" }}>—</span>}
                    </div>
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ display:"flex",alignItems:"center",gap:5,flexWrap:"wrap" }}>
                        <span className="lb-card-name">{p.name}</span>
                        {champCount>=3?<DiamondBadge count={champCount}/>:champCount>0?<svg width="11" height="11" viewBox="0 0 22 20" fill="none" aria-hidden="true"><path d="M11 1L14 7L20 8L15.5 12.5L16.5 19L11 16L5.5 19L6.5 12.5L2 8L8 7Z" fill="rgba(232,184,74,.22)" stroke="var(--gold)" strokeWidth="1.4"/></svg>:null}
                        {(p.runnerUps||[]).length>0&&<RunnerUpBadge/>}
                        <Sparkline pid={p.id} games={seasonGames}/>
                      </div>
                      <div className="lb-card-meta">
                        <span className="text-g">{sStat.wins}W</span>{" "}<span className="text-r">{sStat.losses}L</span>{" · "}{total?`${pct}%`:"—"}{" · "}<StreakBadge streak={sStat.streak} streakPower={p.streakPower||0} showMult/>
                        {" · "}<TrendIndicator pid={p.id} games={seasonGames}/>
                      </div>
                    </div>
                    <div className="lb-card-pts">{isPlaced?p.pts||0:"—"}</div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      </div>
      {showRecalcConfirm&&(
        <ConfirmDialog title="Recalculate All Stats?" msg="This will replay every game in history and rewrite all player points, MMR, streaks, wins, losses, and the pts shown in match history." onConfirm={doRecalc} onCancel={()=>setShowRecalcConfirm(false)}/>
      )}
    </>
  );
}

// ── HISTORY VIEW ───────────────────────────────────────────────────────────

function HistoryView({ state, setState, isAdmin, showToast }) {
  const [playerFilter, setPlayerFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [selectedGameId, setSelectedGameId] = useState(null);
  const [visibleDays, setVisibleDays] = useState(5);
  const [seasonFilter, setSeasonFilter] = useState("current");

  const currentSeason = getCurrentSeason(state);
  const scopedGames = (state.games??[]).filter(g => {
    if (seasonFilter==="all") return true;
    const season = seasonFilter==="current" ? currentSeason : (state.seasons||[]).find(s=>s.id===seasonFilter)||null;
    return gameInSeason(g, season);
  });
  const allGames = [...scopedGames].sort((a,b)=>new Date(b.date)-new Date(a.date));
  const filtered = allGames.filter(g => {
    if (playerFilter) {
      const names = [...g.sideA,...g.sideB].map(id=>pName(id,state.players)).join(" ").toLowerCase();
      if (!names.includes(playerFilter.toLowerCase())) return false;
    }
    if (dateFrom&&new Date(g.date)<new Date(dateFrom)) return false;
    if (dateTo&&new Date(g.date)>new Date(dateTo+"T23:59:59")) return false;
    return true;
  });

  const groups = [];
  let lastDay = null;
  for (const g of filtered) {
    const day = new Date(g.date).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short",year:"numeric"});
    if (day!==lastDay) { groups.push({ day,games:[] }); lastDay=day; }
    groups[groups.length-1].games.push(g);
  }

  const hasFilters = playerFilter||dateFrom||dateTo;

  function GameRow({ g }) {
    const winnerSide = g.winner;
    return(
      <div className="game-row" onClick={()=>setSelectedGameId(g.id)}>
        <div className="g-side">
          {g.sideA.map(id=>{
            const n=pName(id,state.players); const role=g.roles?.[id];
            return(
              <div key={id} style={{ display:"flex",alignItems:"center",gap:3 }}>
                <span className={winnerSide==="A"?"g-name-w":"g-name-l"}>{winnerSide==="A"&&<span style={{ color:"var(--green)",marginRight:2,fontSize:9 }}>▲</span>}{n}</span>
                {role&&<span className={`role-tag ${role==="ATK"?"role-atk":role==="FLEX"?"role-flex":"role-def"}`} style={{ fontSize:9 }}>{role==="ATK"?"🗡":role==="FLEX"?"↕":"🛡"}</span>}
              </div>
            );
          })}
          <div className="g-delta" style={{ display:"flex",flexDirection:"column",gap:1 }}>
            {g.sideA.map(id=>{
              const delta=winnerSide==="A"?(g.perPlayerGains?.[id]??g.playerDeltas?.[id]?.gain??g.ptsGain):(g.perPlayerLosses?.[id]??g.playerDeltas?.[id]?.loss??g.ptsLoss);
              return<span key={id} className={winnerSide==="A"?"text-g":"text-r"}>{winnerSide==="A"?"+":"−"}{delta} {pName(id,state.players).split(" ")[0]}</span>;
            })}
          </div>
        </div>
        <div style={{ textAlign:"center" }}>
          <div className="g-score">{g.scoreA}–{g.scoreB}</div>
          <div className="g-date">{new Date(g.date).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}</div>
          {g.penalties&&Object.values(g.penalties).some(v=>(v.yellow||0)+(v.red||0)>0)&&(
            <div style={{ fontSize:10,marginTop:2 }}>
              {Object.values(g.penalties).some(v=>v.red>0)&&<span>🔴</span>}
              {Object.values(g.penalties).some(v=>v.yellow>0)&&<span>🟡</span>}
            </div>
          )}
        </div>
        <div className="g-side right">
          {g.sideB.map(id=>{
            const n=pName(id,state.players); const role=g.roles?.[id];
            return(
              <div key={id} style={{ display:"flex",alignItems:"center",gap:3,justifyContent:"flex-end" }}>
                {role&&<span className={`role-tag ${role==="ATK"?"role-atk":role==="FLEX"?"role-flex":"role-def"}`} style={{ fontSize:9 }}>{role==="ATK"?"🗡":role==="FLEX"?"↕":"🛡"}</span>}
                <span className={winnerSide==="B"?"g-name-w":"g-name-l"}>{n}{winnerSide==="B"&&<span style={{ color:"var(--green)",marginLeft:2,fontSize:9 }}>▲</span>}</span>
              </div>
            );
          })}
          <div className="g-delta" style={{ display:"flex",flexDirection:"column",gap:1,alignItems:"flex-end" }}>
            {g.sideB.map(id=>{
              const delta=winnerSide==="B"?(g.perPlayerGains?.[id]??g.playerDeltas?.[id]?.gain??g.ptsGain):(g.perPlayerLosses?.[id]??g.playerDeltas?.[id]?.loss??g.ptsLoss);
              return<span key={id} className={winnerSide==="B"?"text-g":"text-r"}>{winnerSide==="B"?"+":"−"}{delta} {pName(id,state.players).split(" ")[0]}</span>;
            })}
          </div>
        </div>
      </div>
    );
  }

  return(
    <div className="stack page-fade">
      {selectedGameId&&(()=>{
        const selectedGame = state.games.find(g=>g.id===selectedGameId);
        return selectedGame?<GameDetail game={selectedGame} state={state} setState={setState} isAdmin={isAdmin} showToast={showToast} onClose={()=>setSelectedGameId(null)}/>:null;
      })()}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Match History ({allGames.length})</span>
          <div className="fac" style={{ gap:6 }}>
            {hasFilters&&<span className="xs tag tag-a">{filtered.length} shown</span>}
            <select className="inp" value={seasonFilter} onChange={e=>setSeasonFilter(e.target.value)} style={{ fontSize:11,padding:"4px 8px",maxWidth:170 }}>
              <option value="current">Current season</option>
              <option value="all">All seasons</option>
              {(state.seasons||[]).map(se=><option key={se.id} value={se.id}>{se.label}</option>)}
            </select>
            <button className={`btn btn-sm ${showFilters?"btn-p":"btn-g"}`} onClick={()=>setShowFilters(f=>!f)}>⚡ Filter</button>
          </div>
        </div>
        {showFilters&&(
          <div style={{ padding:"10px 16px",background:"var(--s2)",borderBottom:"1px solid var(--b1)",display:"flex",gap:8,flexWrap:"wrap",alignItems:"flex-end" }}>
            <div style={{ flex:"1 1 140px" }}><div className="lbl">Player</div><input className="inp" placeholder="Search player…" value={playerFilter} onChange={e=>setPlayerFilter(e.target.value)} style={{ fontSize:11,padding:"5px 8px" }}/></div>
            <div style={{ flex:"1 1 120px" }}><div className="lbl">From</div><input className="inp" type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} style={{ fontSize:11,padding:"5px 8px" }}/></div>
            <div style={{ flex:"1 1 120px" }}><div className="lbl">To</div><input className="inp" type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} style={{ fontSize:11,padding:"5px 8px" }}/></div>
            {hasFilters&&<button className="btn btn-d btn-sm" style={{ alignSelf:"flex-end" }} onClick={()=>{ setPlayerFilter(""); setDateFrom(""); setDateTo(""); }}>Clear</button>}
          </div>
        )}
        {groups.length===0&&<div style={{ padding:32,textAlign:"center",color:"var(--dimmer)",fontSize:12 }}>No games found</div>}
        {groups.slice(0,visibleDays).map(({ day,games })=>(
          <div key={day}>
            <div style={{ padding:"7px 18px",background:"var(--s2)",borderBottom:"1px solid var(--b1)",fontSize:10,letterSpacing:1.5,textTransform:"uppercase",color:"var(--dimmer)",fontWeight:600 }}>
              {day} · {games.length} game{games.length!==1?"s":""}
            </div>
            {games.map(g=><GameRow key={g.id} g={g}/>)}
          </div>
        ))}
        {groups.length>visibleDays&&(
          <div style={{ padding:"12px 18px",textAlign:"center",borderTop:"1px solid var(--b1)" }}>
            <button className="btn btn-g btn-sm" onClick={()=>setVisibleDays(v=>v+5)}>
              Load more — {groups.length-visibleDays} day{groups.length-visibleDays!==1?"s":""} remaining
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ADMIN HELPERS ──────────────────────────────────────────────────────────

const ROLES = { VIEWER:0, REFEREE:1, ADMIN:2, OWNER:3 };
function can(required, user) { return (user?.role??0)>=required; }
function logAdmin(state, action, details) {
  return { ...state, audit:[{ id:crypto.randomUUID(),action,details,date:new Date().toISOString() },...(state.audit||[])] };
}
const Admin = {
  addPlayer(state, name) {
    const exists = state.players.find(p=>p.name.toLowerCase()===name.toLowerCase());
    if (exists) return { error:"Player already exists" };
    return { player:{ id:crypto.randomUUID(),name,mmr:CONFIG.STARTING_MMR,pts:CONFIG.STARTING_PTS,wins:0,losses:0,streak:0,championships:[],runnerUps:[],thirdPlaces:[] } };
  },
  renamePlayer(state, id, newName) {
    const taken = state.players.find(p=>p.id!==id&&p.name.toLowerCase()===newName.toLowerCase());
    if (taken) return { error:"Name already taken" };
    return { players:state.players.map(p=>p.id===id?{ ...p,name:newName }:p) };
  },
  removePlayer(state, id) { return { players:state.players.filter(p=>p.id!==id) }; }
};
function placementsLeft(pid, state) {
  const key = getCurrentPlacementKey(state);
  const used = state.monthlyPlacements[key]?.[pid] || 0;
  return CONFIG.MAX_PLACEMENTS_PER_MONTH - used;
}

// ── ONBOARD VIEW ───────────────────────────────────────────────────────────

function OnboardView({ state, setState, showToast }) {
  const [single, setSingle] = useState("");
  const [bulk, setBulk] = useState("");
  const [preview, setPreview] = useState([]);
  const [confirm, setConfirm] = useState(null);

  function parseBulk(text) {
    return text.split(/[\n,]+/).map(s=>s.trim()).filter(Boolean)
      .filter(name=>!state.players.some(p=>p.name.toLowerCase()===name.toLowerCase()));
  }

  function addSingle() {
    const name=single.trim(); if (!name) return;
    if (state.players.some(p=>p.name.toLowerCase()===name.toLowerCase())) { showToast("Player already exists","error"); return; }
    const newPlayer = { id:crypto.randomUUID(),name,mmr:CONFIG.STARTING_MMR,pts:CONFIG.STARTING_PTS,mmr_atk:CONFIG.STARTING_MMR,mmr_def:CONFIG.STARTING_MMR,wins:0,losses:0,streak:0,streakPower:0,wins_atk:0,losses_atk:0,wins_def:0,losses_def:0,championships:[],runnerUps:[],thirdPlaces:[],position:[],preferredRole:'FLEX' };
    setState(s=>logAdmin({ ...s,players:[...s.players,newPlayer] },"ADD_PLAYER",{ name }));
    setSingle(""); showToast(`${name} added`);
  }

  function confirmBulk() {
    if (!preview.length) return;
    const newPlayers = preview.map(name=>({ id:crypto.randomUUID(),name,mmr:CONFIG.STARTING_MMR,pts:CONFIG.STARTING_PTS,wins:0,losses:0,streak:0,championships:[],runnerUps:[],thirdPlaces:[] }));
    setState(s=>logAdmin({ ...s,players:[...s.players,...newPlayers] },"BULK_ADD_PLAYERS",{ count:newPlayers.length }));
    showToast(`${newPlayers.length} players added`); setBulk(""); setPreview([]);
  }

  function removePlayer(id) {
    const p=state.players.find(x=>x.id===id);
    setConfirm({ title:"Remove Player?",msg:`Remove ${p?.name}? Their game history will remain but they will no longer appear on the leaderboard.`,danger:true,
      onConfirm:()=>{ setState(s=>logAdmin({ ...s,players:s.players.filter(x=>x.id!==id) },"REMOVE_PLAYER",{ name:p?.name })); showToast(`${p?.name} removed`); setConfirm(null); }
    });
  }

  return(
    <div className="stack page-fade">
      <div className="card">
        <div className="card-header"><span className="card-title">Add Player</span></div>
        <div style={{ padding:18 }}>
          <div className="field">
            <label className="lbl">Player Name</label>
            <div className="fac">
              <input className="inp" placeholder="e.g. Jamie" value={single} onChange={e=>setSingle(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addSingle()}/>
              <button className="btn btn-p" onClick={addSingle} disabled={!single.trim()}>Add</button>
            </div>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-header"><span className="card-title">Bulk Add</span></div>
        <div style={{ padding:18 }}>
          <div className="field">
            <label className="lbl">Names (one per line or comma-separated)</label>
            <textarea className="inp" rows={4} placeholder={"Alex\nJordan\nSam"} value={bulk} onChange={e=>{ setBulk(e.target.value); setPreview(parseBulk(e.target.value)); }}/>
          </div>
          {preview.length>0&&<div className="msg msg-w sm mb8">Will add {preview.length} player{preview.length>1?"s":""}: {preview.join(", ")}</div>}
          <button className="btn btn-p" onClick={confirmBulk} disabled={!preview.length}>Add {preview.length>0?preview.length:""} Players</button>
        </div>
      </div>
      <div className="card">
        <div className="card-header"><span className="card-title">Current Roster ({state.players.length})</span></div>
        <div style={{ padding:"8px 14px 14px" }}>
          {state.players.length===0&&<div style={{ textAlign:"center",padding:24,color:"var(--dimmer)",fontSize:12 }}>No players yet</div>}
          {[...state.players].sort((a,b)=>(b.pts||0)-(a.pts||0)).map((p,i)=>(
            <div key={p.id} style={{ display:"flex",alignItems:"center",gap:10,padding:"9px 4px",borderBottom:"1px solid var(--b1)" }}>
              <span className="rk" style={{ minWidth:28,flexShrink:0 }}>#{i+1}</span>
              <span className="bold" style={{ flex:1,fontSize:13 }}>{p.name}</span>
              <span className="text-am bold" style={{ fontSize:13,minWidth:36,textAlign:"right" }}>{p.pts||0}</span>
              <span style={{ fontSize:12,color:"var(--dimmer)",minWidth:44,textAlign:"right" }}><span className="text-g">{p.wins}</span>/<span className="text-r">{p.losses}</span></span>
              <button className="btn btn-d btn-sm" style={{ flexShrink:0 }} onClick={()=>removePlayer(p.id)}>Remove</button>
            </div>
          ))}
        </div>
      </div>
      {confirm&&<ConfirmDialog {...confirm} onCancel={()=>setConfirm(null)}/>}
    </div>
  );
}

// ── LOG VIEW ───────────────────────────────────────────────────────────────
// Role assignment redesign (per plan §5):
// - Inline role buttons next to player name chips: REMOVED
// - New panel: click ATK/DEF slot to cycle (first click assigns, subsequent clicks swap)
// - FLEX button sets both side players to FLEX (mid-game swap at 5-goal mark)
// - Both players on swapping side are FLEX per §3.7 of research
// - Helpers extracted: cycleRoleForSide, setFlexForSide, clearRolesForSide

const EMPTY_ROW = () => ({ id:crypto.randomUUID(), sideA:[], sideB:[], scoreA:"", scoreB:"", searchA:"", searchB:"", penalties:{}, roles:{} });

function LogView({ state, setState, showToast }) {
  const [rows, setRows] = useState([EMPTY_ROW()]);
  const [errors, setErrors] = useState({});
  const [undoStack, setUndoStack] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const [lastLogged, setLastLogged] = useState(null);
  const [templates, setTemplates] = useState(() => {
    try { return JSON.parse(localStorage.getItem("foosball_tpl")||"[]"); }
    catch { return []; }
  });
  const [tplName, setTplName] = useState("");
  const undoTimeout = useRef(null);

  useEffect(()=>{
    const handler = e => { if (e.ctrlKey&&e.key==="Enter") submitAll(); };
    window.addEventListener("keydown", handler);
    return ()=>window.removeEventListener("keydown", handler);
  }, [rows, state]);

  function setRowPenalty(rowId, pid, type, delta) {
    setRows(r=>r.map(row=>{
      if (row.id!==rowId) return row;
      const cur=row.penalties?.[pid]||{ yellow:0,red:0 };
      const newVal=Math.max(0,(cur[type]||0)+delta);
      return { ...row, penalties:{ ...row.penalties,[pid]:{ ...cur,[type]:newVal } } };
    }));
  }

  function togglePlayer(rowId, side, pid) {
    setRows(r=>r.map(row=>{
      if (row.id!==rowId) return row;
      const key=side==="A"?"sideA":"sideB";
      const searchKey=side==="A"?"searchA":"searchB";
      const other=side==="A"?"sideB":"sideA";
      const otherFiltered=row[other].filter(id=>id!==pid);
      if (row[key].includes(pid)) {
        // Remove player — also clear their role
        const nr={ ...row.roles }; delete nr[pid];
        return { ...row,[key]:row[key].filter(id=>id!==pid),roles:nr };
      }
      if (row[key].length>=2) return row;
      // Auto-assign role from preferredRole on selection
      const pref=state.players.find(p=>p.id===pid)?.preferredRole;
      let newRoles={ ...row.roles };
      if (pref==='ATK'||pref==='DEF') {
        // Only auto-assign if that role isn't already taken on this side
        const sideIds=[...(key==="sideA"?row.sideA:row.sideB), pid];
        const alreadyHasRole = sideIds.filter(id=>id!==pid).some(id=>newRoles[id]===pref);
        if (!alreadyHasRole) newRoles[pid]=pref;
      }
      return { ...row,[key]:[...row[key],pid],[other]:otherFiltered,[searchKey]:"",roles:newRoles };
    }));
  }

  function saveTpl() {
    if (!tplName.trim()) return;
    const t={ name:tplName,rows:rows.map(r=>({ sideA:r.sideA,sideB:r.sideB })) };
    const upd=[...templates,t];
    setTemplates(upd); localStorage.setItem("foosball_tpl",JSON.stringify(upd));
    setTplName(""); showToast("Template saved");
  }
  function loadTpl(t) { setRows(t.rows.map(r=>({ ...EMPTY_ROW(),sideA:r.sideA,sideB:r.sideB }))); showToast(`"${t.name}" loaded`); }
  function deleteTpl(i) { const u=templates.filter((_,idx)=>idx!==i); setTemplates(u); localStorage.setItem("foosball_tpl",JSON.stringify(u)); }

  function submitAll(skipDuplicateCheck=false) {
    const newErrors={};
    const monthKey=getMonthKey()??"default";

    for (const row of rows) {
      if (row.sideA.length!==2||row.sideB.length!==2) { newErrors[row.id]="Each side needs exactly 2 players"; continue; }
      if (new Set([...row.sideA,...row.sideB]).size<4) { newErrors[row.id]="A player appears on both sides"; continue; }
      const sA=parseInt(row.scoreA,10), sB=parseInt(row.scoreB,10);
      if (isNaN(sA)||isNaN(sB)||sA<0||sB<0) { newErrors[row.id]="Invalid scores"; continue; }
      if (sA===sB) { newErrors[row.id]="No draws allowed"; continue; }

      // Role validation — all 4, or all empty. FLEX is valid as a role.
      // A mix of one side FLEX and other side ATK/DEF is also valid (one team swapped).
      const allPids=[...row.sideA,...row.sideB];
      const assignedRoles=allPids.filter(pid=>row.roles?.[pid]);
      if (assignedRoles.length>0&&assignedRoles.length<4) {
        newErrors[row.id]="Assign roles to all 4 players, or leave all blank. Use FLEX for mid-game swaps.";
        continue;
      }
      // Validate ATK/DEF balance per side (FLEX bypasses this)
      if (assignedRoles.length===4) {
        const sideAHasFlex=row.sideA.some(pid=>row.roles?.[pid]==="FLEX");
        const sideBHasFlex=row.sideB.some(pid=>row.roles?.[pid]==="FLEX");
        if (!sideAHasFlex) {
          const atkA=row.sideA.filter(pid=>row.roles?.[pid]==="ATK").length;
          if (atkA!==1) { newErrors[row.id]="Side A needs exactly 1 ATK and 1 DEF (or use FLEX for a swap)"; continue; }
        }
        if (!sideBHasFlex) {
          const atkB=row.sideB.filter(pid=>row.roles?.[pid]==="ATK").length;
          if (atkB!==1) { newErrors[row.id]="Side B needs exactly 1 ATK and 1 DEF (or use FLEX for a swap)"; continue; }
        }
      }
    }

    setErrors(newErrors);
    if (Object.keys(newErrors).length) { showToast("Fix errors first","error"); return; }

    // Suspicious score check
    const suspiciousRows=[];
    for (const row of rows) {
      const sA=parseInt(row.scoreA,10), sB=parseInt(row.scoreB,10);
      const issues=[];
      if (sA+sB>50) issues.push(`Total score ${sA+sB} (unusual)`);
      if (Math.abs(sA-sB)>15) issues.push(`Margin ${Math.abs(sA-sB)} (very lopsided)`);
      if (sA===0||sB===0) issues.push("Zero score");
      if (issues.length>0) suspiciousRows.push({ row,issues });
    }
    if (suspiciousRows.length>0&&!skipDuplicateCheck) {
      setConfirm({ title:"Suspicious Score(s) Detected",msg:`${suspiciousRows.map(s=>`${[...s.row.sideA,...s.row.sideB].map(id=>pName(id,state.players)).join(', ')}: ${s.row.scoreA}–${s.row.scoreB} (${s.issues.join(', ')})`).join('\n')}\n\nLog anyway?`,onConfirm:()=>{ setConfirm(null); submitAll(true); } });
      return;
    }

    // Duplicate check
    if (!skipDuplicateCheck) {
      const today=new Date().toISOString();
      const duplicates=rows.filter(row=>{
        const sA=parseInt(row.scoreA,10), sB=parseInt(row.scoreB,10);
        return isDuplicateGame({ sideA:row.sideA,sideB:row.sideB,scoreA:sA,scoreB:sB,date:today },state.games);
      });
      if (duplicates.length>0) {
        const names=duplicates.map(r=>[...r.sideA,...r.sideB].map(id=>pName(id,state.players)).join(', ')).join('; ');
        setConfirm({ title:"Duplicate Match Detected",msg:`A match with the same players and score was already logged today (${names}). Log anyway?`,onConfirm:()=>{ setConfirm(null); submitAll(true); } });
        return;
      }
    }

    const snapshot={ players:state.players,games:state.games,monthlyPlacements:state.monthlyPlacements };
    setUndoStack(u=>[snapshot,...u].slice(0,5));

    const pendingGames=rows.map(row=>{
      const sA=parseInt(row.scoreA,10), sB=parseInt(row.scoreB,10);
      const winner=sA>sB?"A":"B";
      const gamePenalties=Object.keys(row.penalties||{}).length>0?row.penalties:undefined;
      const allPids=[...row.sideA,...row.sideB];
      const assignedRoles=allPids.filter(pid=>row.roles?.[pid]);
      return {
        id:crypto.randomUUID(), sideA:row.sideA, sideB:row.sideB, winner, scoreA:sA, scoreB:sB,
        roles:assignedRoles.length===4?{ ...row.roles }:{},
        ...(gamePenalties?{ penalties:gamePenalties }:{}),
        date:new Date().toISOString(), monthKey,
        ptsGain:0, ptsLoss:0,
      };
    });

    const basePlayers=state.players.map(p=>({ ...p,mmr:CONFIG.STARTING_MMR,pts:CONFIG.STARTING_PTS,mmr_atk:CONFIG.STARTING_MMR,mmr_def:CONFIG.STARTING_MMR,wins:0,losses:0,streak:0,streakPower:0,lossStreakPower:0,wins_atk:0,losses_atk:0,wins_def:0,losses_def:0 }));
    const allGames=[...state.games,...pendingGames];
    const { players:newPlayers,games:newGames }=replayGames(basePlayers,allGames,state.seasonStart,state.seasons);
    const mergedPlayers=newPlayers.map(p=>{
      const orig=state.players.find(x=>x.id===p.id);
      return orig?{ ...p,name:orig.name,championships:orig.championships||[],runnerUps:orig.runnerUps||[],thirdPlaces:orig.thirdPlaces||[],position:orig.position||[],preferredRole:orig.preferredRole||"FLEX" }:p;
    });
    const newPlacements=computePlacements(newGames,state.seasons);
    const newGameIds=new Set(pendingGames.map(g=>g.id));
    const loggedWithDeltas=newGames.filter(g=>newGameIds.has(g.id));

    setState(s=>({ ...s,players:mergedPlayers,games:newGames,monthlyPlacements:newPlacements }));
    setRows([EMPTY_ROW()]);
    setLastLogged({ games:loggedWithDeltas,players:mergedPlayers,timestamp:new Date() });
    showToast(`${loggedWithDeltas.length} game${loggedWithDeltas.length>1?"s":""} logged`,"success");
    clearTimeout(undoTimeout.current);
    undoTimeout.current=setTimeout(()=>setUndoStack([]),30000);
  }

  function undoLast() {
    if (!undoStack.length) return;
    const [prev,...rest]=undoStack;
    setState(s=>({ ...s,players:prev.players,games:prev.games,monthlyPlacements:prev.monthlyPlacements }));
    setUndoStack(rest); showToast("Last submission undone","info");
  }

  return (
    <>
      <div className="stack page-fade">
        {lastLogged&&(
          <div className="card" style={{ borderColor:"var(--amber-d)" }}>
            <div className="card-header" style={{ background:"var(--amber-g)" }}>
              <span className="card-title">✓ Just Logged</span>
              <button className="btn btn-g btn-sm" onClick={()=>setLastLogged(null)}>Dismiss</button>
            </div>
            <div style={{ padding:"10px 16px",display:"flex",flexDirection:"column",gap:8 }}>
              {lastLogged.games.map(g=>{
                const wIds=g.winner==="A"?g.sideA:g.sideB;
                const lIds=g.winner==="A"?g.sideB:g.sideA;
                return(
                  <div key={g.id} style={{ display:"flex",alignItems:"center",gap:10,fontSize:13 }}>
                    <span className="text-g bold">{wIds.map(id=>pName(id,lastLogged.players)).join(" & ")}</span>
                    <span className="disp text-am" style={{ fontSize:18 }}>{g.scoreA}–{g.scoreB}</span>
                    <span className="text-dd">{lIds.map(id=>pName(id,lastLogged.players)).join(" & ")}</span>
                    <span className="xs text-dd" style={{ marginLeft:"auto" }}>
                      {wIds.map(id=><span key={id} className="text-g" style={{ marginRight:6 }}>+{g.perPlayerGains?.[id]??g.ptsGain} {pName(id,lastLogged.players).split(" ")[0]}</span>)}
                      {lIds.map(id=><span key={id} className="text-r" style={{ marginRight:6 }}>−{g.perPlayerLosses?.[id]??g.ptsLoss} {pName(id,lastLogged.players).split(" ")[0]}</span>)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {templates.length>0&&(
          <div className="card">
            <div className="card-header"><span className="card-title">Templates</span></div>
            <div style={{ padding:14,display:"flex",gap:8,flexWrap:"wrap" }}>
              {templates.map((t,i)=>(
                <div key={i} className="fac" style={{ gap:4 }}>
                  <button className="btn btn-g btn-sm" onClick={()=>loadTpl(t)}>{t.name}</button>
                  <button className="btn btn-d btn-sm" onClick={()=>deleteTpl(i)}>×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-header">
            <span className="card-title">Log Games</span>
            <span className="xs text-dd">{rows.length} game{rows.length>1?"s":""}</span>
          </div>
          <div style={{ padding:14 }}>
            {rows.map((row, ri) => {
              const sA=parseInt(row.scoreA,10), sB=parseInt(row.scoreB,10);
              const canPreview=row.sideA.length===2&&row.sideB.length===2&&!isNaN(sA)&&!isNaN(sB)&&sA!==sB;
              let prev=null;
              if (canPreview) {
                const wIds=sA>sB?row.sideA:row.sideB, lIds=sA>sB?row.sideB:row.sideA;
                const currentRanked=[...state.players].sort((a,b)=>(b.pts||0)-(a.pts||0));
                const rankOf=id=>{const i=currentRanked.findIndex(p=>p.id===id);return i===-1?currentRanked.length:i;};
                const monthPlacements=state.monthlyPlacements?.[getCurrentPlacementKey(state)]||{};
                const isPlaced=pid=>(monthPlacements[pid]||0)>=CONFIG.MAX_PLACEMENTS_PER_MONTH;
                const oppWinMMR=avg(wIds,state.players,"mmr"), oppLosMMR=avg(lIds,state.players,"mmr");
                const oppAvgRankPlaced=ids=>{const placed=ids.filter(isPlaced);if(!placed.length)return null;return placed.reduce((s,id)=>s+rankOf(id),0)/placed.length;};
                const oppWinRank=oppAvgRankPlaced(wIds); const oppLosRank=oppAvgRankPlaced(lIds);
                const perPlayer={};
                [...wIds,...lIds].forEach(pid=>{
                  const p=state.players.find(x=>x.id===pid); if(!p) return;
                  const isW=wIds.includes(pid);
                  const myPlaced=isPlaced(pid);
                  const oppRank=isW?oppLosRank:oppWinRank;
                  perPlayer[pid]=calcPlayerDelta({ winnerScore:Math.max(sA,sB),loserScore:Math.min(sA,sB),playerMMR:p.mmr,playerRank:myPlaced?rankOf(pid):null,playerStreakPower:p.streakPower||0,oppAvgMMR:isW?oppLosMMR:oppWinMMR,oppAvgRank:(myPlaced&&oppRank!==null)?oppRank:null,isWinner:isW });
                });
                prev={ perPlayer,wIds,lIds };
              }

              return(
                <div key={row.id} style={{ marginBottom:10,padding:12,background:"var(--s2)",borderRadius:6,border:"1px solid var(--b1)" }}>
                  <div className="fbc mb8">
                    <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                      <span className="xs text-dd">Game {ri+1}</span>
                      {(()=>{
                        const playersOk=row.sideA.length===2&&row.sideB.length===2;
                        const sAv=parseInt(row.scoreA,10), sBv=parseInt(row.scoreB,10);
                        const scoresOk=!isNaN(sAv)&&!isNaN(sBv)&&sAv>=0&&sBv>=0&&sAv!==sBv;
                        if (!playersOk) return<span className="xs" style={{ color:"var(--orange)" }}>● {4-row.sideA.length-row.sideB.length} player{4-row.sideA.length-row.sideB.length!==1?"s":""} needed</span>;
                        if (!scoresOk) return<span className="xs" style={{ color:"var(--orange)" }}>● enter scores</span>;
                        return<span className="xs text-g">✓ ready</span>;
                      })()}
                    </div>
                    {rows.length>1&&<button className="btn btn-d btn-sm" onClick={()=>setRows(r=>r.filter(x=>x.id!==row.id))}>Remove</button>}
                  </div>

                  <div style={{ display:"grid",gridTemplateColumns:"1fr 96px 1fr",gap:10,alignItems:"start" }}>
                    {/* Side A player picker */}
                    <div>
                      <div className="lbl" style={{ color:"var(--green)" }}>Side A {row.sideA.length}/2</div>
                      {row.sideA.length>0&&(
                        <div style={{ display:"flex",gap:4,flexWrap:"wrap",marginBottom:5 }}>
                          {row.sideA.map(id=>(
                            <span key={id} className="tag tag-w" style={{ cursor:"pointer",fontSize:11 }} onClick={()=>togglePlayer(row.id,"A",id)}>
                              {pName(id,state.players)} ×
                            </span>
                          ))}
                        </div>
                      )}
                      <input className="inp" placeholder="Search…" value={row.searchA} onChange={e=>setRows(r=>r.map(x=>x.id===row.id?{ ...x,searchA:e.target.value }:x))} style={{ marginBottom:4,fontSize:11,padding:"4px 7px" }}/>
                      <div style={{ display:"flex",flexDirection:"column",gap:3,maxHeight:160,overflowY:"auto" }}>
                        {[...state.players].sort((a,b)=>(b.pts||0)-(a.pts||0)).filter(p=>!row.searchA||p.name.toLowerCase().includes(row.searchA.toLowerCase())).map(p=>{
                          const onA=row.sideA.includes(p.id), onB=row.sideB.includes(p.id), full=!onA&&row.sideA.length>=2;
                          if (onA) return null;
                          return<div key={p.id} className={`player-chip ${onB||full?"disabled":""}`} onClick={()=>{ if(!onB&&!full) togglePlayer(row.id,"A",p.id); }}><span>{p.name}</span><span className="xs text-dd">{p.pts||0}pts</span></div>;
                        })}
                      </div>
                    </div>

                    {/* Score inputs + preview */}
                    <div style={{ display:"flex",flexDirection:"column",gap:6,paddingTop:16 }}>
                      <div>
                        <div className="lbl" style={{ fontSize:9,lineHeight:1.3,color:"var(--green)",minHeight:22 }}>{row.sideA.map(id=>pName(id,state.players)).join(" & ")||"A"}</div>
                        <input className="inp" type="number" min="0" placeholder="10" value={row.scoreA} onChange={e=>setRows(r=>r.map(x=>x.id===row.id?{ ...x,scoreA:e.target.value }:x))} style={{ textAlign:"center",fontSize:18,fontFamily:"var(--disp)",fontWeight:800 }}/>
                      </div>
                      <div>
                        <div className="lbl" style={{ fontSize:9,lineHeight:1.3,color:"var(--blue)",minHeight:22 }}>{row.sideB.map(id=>pName(id,state.players)).join(" & ")||"B"}</div>
                        <input className="inp" type="number" min="0" placeholder="7" value={row.scoreB} onChange={e=>setRows(r=>r.map(x=>x.id===row.id?{ ...x,scoreB:e.target.value }:x))} style={{ textAlign:"center",fontSize:18,fontFamily:"var(--disp)",fontWeight:800 }}/>
                      </div>
                      {prev&&(
                        <div style={{ background:"var(--s1)",borderRadius:4,padding:"6px 8px",fontSize:10,lineHeight:1.9 }}>
                          {prev.wIds.map(id=>{const d=prev.perPlayer[id];const n=state.players.find(p=>p.id===id)?.name?.split(" ")[0]||"?";const rankPenalty=d?.rankScale<0.92;return<div key={id}><span className="text-g">+{d?.gain??0} {n}</span>{rankPenalty&&<span style={{ color:"var(--orange)",marginLeft:4 }}>↓×{d.rankScale.toFixed(2)} rank</span>}</div>;})}
                          {prev.lIds.map(id=>{const d=prev.perPlayer[id];const n=state.players.find(p=>p.id===id)?.name?.split(" ")[0]||"?";return<div key={id} className="text-r">−{d?.loss??0} {n}</div>;})}
                          {prev.wIds.some(id=>(prev.perPlayer[id]?.qualityScore??1)<0.85)&&<div style={{ color:"var(--orange)",marginTop:2,fontSize:9,letterSpacing:.3 }}>⚠ Low-value game</div>}
                        </div>
                      )}
                    </div>

                    {/* Side B player picker */}
                    <div>
                      <div className="lbl" style={{ color:"var(--blue)" }}>Side B {row.sideB.length}/2</div>
                      {row.sideB.length>0&&(
                        <div style={{ display:"flex",gap:4,flexWrap:"wrap",marginBottom:5 }}>
                          {row.sideB.map(id=>(
                            <span key={id} className="tag tag-b" style={{ cursor:"pointer",fontSize:11 }} onClick={()=>togglePlayer(row.id,"B",id)}>
                              {pName(id,state.players)} ×
                            </span>
                          ))}
                        </div>
                      )}
                      <input className="inp" placeholder="Search…" value={row.searchB} onChange={e=>setRows(r=>r.map(x=>x.id===row.id?{ ...x,searchB:e.target.value }:x))} style={{ marginBottom:4,fontSize:11,padding:"4px 7px" }}/>
                      <div style={{ display:"flex",flexDirection:"column",gap:3,maxHeight:160,overflowY:"auto" }}>
                        {[...state.players].sort((a,b)=>(b.pts||0)-(a.pts||0)).filter(p=>!row.searchB||p.name.toLowerCase().includes(row.searchB.toLowerCase())).map(p=>{
                          const onA=row.sideA.includes(p.id), onB=row.sideB.includes(p.id), full=!onB&&row.sideB.length>=2;
                          if (onB) return null;
                          return<div key={p.id} className={`player-chip ${onA||full?"disabled":""}`} onClick={()=>{ if(!onA&&!full) togglePlayer(row.id,"B",p.id); }}><span>{p.name}</span><span className="xs text-dd">{p.pts||0}pts</span></div>;
                        })}
                      </div>
                    </div>
                  </div>

                  {/* ── ROLE ASSIGNMENT PANEL ─────────────────────────────────
                      Redesigned per plan §5:
                      - No inline buttons on player chips (removed)
                      - Click ATK/DEF slot to assign/swap — single operation
                      - FLEX button for entire side (mid-game swap per §3.7 research)
                      - Clear button to reset
                  ── */}
                  {row.sideA.length+row.sideB.length>0&&(()=>{
                    const allPids=[...row.sideA,...row.sideB];
                    const assignedCount=allPids.filter(id=>row.roles?.[id]).length;
                    const fullyAssigned=assignedCount===4&&allPids.length===4;
                    const partiallyAssigned=assignedCount>0&&!fullyAssigned;
                    const bothSidesFull=row.sideA.length===2&&row.sideB.length===2;

                    const RoleSlot = ({ sideIds, roleToShow, label, icon, slotClass, onClickSlot }) => {
                      const occupant = sideIds.find(id=>row.roles?.[id]===roleToShow);
                      const isFlex = sideIds.every(id=>row.roles?.[id]==="FLEX");
                      if (isFlex) return(
                        <div className="role-slot role-slot-flex" onClick={onClickSlot} title="Click to re-assign">
                          <div className="xs" style={{ color:"var(--purple)",fontWeight:700,fontSize:9,letterSpacing:.5,textTransform:"uppercase",marginBottom:2 }}>⚡ FLEX</div>
                          <div className="xs text-dd" style={{ fontSize:10 }}>Mid-game swap</div>
                        </div>
                      );
                      return(
                        <div className={`role-slot ${occupant?"role-slot-"+roleToShow.toLowerCase():"role-slot-empty"}`} onClick={onClickSlot}
                          title={occupant?`${pName(occupant,state.players)} — click to swap`:"Click to assign"}>
                          <div className="xs" style={{ color:roleToShow==="ATK"?"var(--orange)":"var(--blue)",fontWeight:700,fontSize:9,letterSpacing:.5,textTransform:"uppercase",marginBottom:2 }}>
                            {icon} {label}
                          </div>
                          {occupant
                            ? <div style={{ fontWeight:600,fontSize:12 }}>{pName(occupant,state.players)} <span className="xs text-dd">↕ click to swap</span></div>
                            : <div className="xs text-dd" style={{ fontStyle:"italic" }}>
                                {sideIds.length<2?"add players first":assignedCount===0?"click to assign":"—"}
                              </div>
                          }
                        </div>
                      );
                    };

                    return(
                      <div style={{ marginTop:12,borderTop:"1px solid var(--b1)",paddingTop:10 }}>
                        {/* Header */}
                        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10 }}>
                          <span className="lbl" style={{ margin:0,fontSize:10,letterSpacing:".5px" }}>POSITIONS</span>
                          <div className="fac" style={{ gap:6 }}>
                            {fullyAssigned
                              ? <span className="xs" style={{ color:"var(--green)" }}>✓ Positional MMR active</span>
                              : bothSidesFull
                                ? <span className="xs" style={{ color:"var(--amber)" }}>Assign all 4 to enable ATK/DEF MMR</span>
                                : <span className="xs text-dd">Add all players first</span>
                            }
                            {assignedCount>0&&<button className="btn btn-g btn-sm" style={{ fontSize:10,padding:"2px 7px" }}
                              onClick={()=>setRows(r=>clearRolesForSide(clearRolesForSide(r,row.id,row.sideA),row.id,row.sideB))}>
                              Clear
                            </button>}
                          </div>
                        </div>

                        {/* Two-column grid: Side A and Side B */}
                        {bothSidesFull&&(
                          <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10 }}>
                            {/* Side A */}
                            <div>
                              <div className="xs" style={{ color:"var(--green)",fontWeight:700,marginBottom:5,letterSpacing:.3 }}>Side A</div>
                              <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
                                <RoleSlot sideIds={row.sideA} roleToShow="ATK" label="ATK" icon="🗡"
                                  slotClass="role-slot-atk"
                                  onClickSlot={()=>setRows(r=>cycleRoleForSide(r,row.id,row.sideA))}/>
                                <RoleSlot sideIds={row.sideA} roleToShow="DEF" label="DEF" icon="🛡"
                                  slotClass="role-slot-def"
                                  onClickSlot={()=>setRows(r=>cycleRoleForSide(r,row.id,row.sideA))}/>
                              </div>
                              <button className="btn btn-g btn-sm w-full" style={{ marginTop:6,fontSize:10 }}
                                onClick={()=>setRows(r=>setFlexForSide(r,row.id,row.sideA))}
                                title="Team swapped positions at the 5-goal mark (§3.7)">
                                ↕ FLEX (swap at 5 goals)
                              </button>
                            </div>
                            {/* Side B */}
                            <div>
                              <div className="xs" style={{ color:"var(--blue)",fontWeight:700,marginBottom:5,letterSpacing:.3 }}>Side B</div>
                              <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
                                <RoleSlot sideIds={row.sideB} roleToShow="ATK" label="ATK" icon="🗡"
                                  slotClass="role-slot-atk"
                                  onClickSlot={()=>setRows(r=>cycleRoleForSide(r,row.id,row.sideB))}/>
                                <RoleSlot sideIds={row.sideB} roleToShow="DEF" label="DEF" icon="🛡"
                                  slotClass="role-slot-def"
                                  onClickSlot={()=>setRows(r=>cycleRoleForSide(r,row.id,row.sideB))}/>
                              </div>
                              <button className="btn btn-g btn-sm w-full" style={{ marginTop:6,fontSize:10 }}
                                onClick={()=>setRows(r=>setFlexForSide(r,row.id,row.sideB))}
                                title="Team swapped positions at the 5-goal mark (§3.7)">
                                ↕ FLEX (swap at 5 goals)
                              </button>
                            </div>
                          </div>
                        )}

                        {partiallyAssigned&&!bothSidesFull&&(
                          <div className="xs text-dd" style={{ fontStyle:"italic" }}>Finish adding players to assign roles</div>
                        )}
                      </div>
                    );
                  })()}

                  {errors[row.id]&&<div className="msg msg-e mt8" style={{ fontWeight:600,fontSize:12 }}>⚠ {errors[row.id]}</div>}

                  {/* Penalty cards */}
                  {row.sideA.length===2&&row.sideB.length===2&&(
                    <div style={{ marginTop:8,borderTop:"1px solid var(--b1)",paddingTop:8 }}>
                      <div className="xs text-dd" style={{ marginBottom:6,fontWeight:600,letterSpacing:.5 }}>DISCIPLINARY CARDS <span style={{ opacity:.6 }}>(optional)</span></div>
                      <div style={{ display:"flex",flexDirection:"column",gap:4 }}>
                        {[...row.sideA,...row.sideB].map(pid=>{
                          const pen=row.penalties?.[pid]||{ yellow:0,red:0 };
                          const total=(pen.yellow||0)*CONFIG.YELLOW_CARD_PTS+(pen.red||0)*CONFIG.RED_CARD_PTS;
                          if (pen.yellow===0&&pen.red===0) return(
                            <div key={pid} style={{ display:"flex",alignItems:"center",gap:8,fontSize:12 }}>
                              <span style={{ flex:1,fontWeight:500 }}>{pName(pid,state.players)}</span>
                              <button className="btn btn-g btn-sm" style={{ fontSize:10,padding:"2px 8px" }} onClick={()=>setRowPenalty(row.id,pid,"yellow",1)}>🟡+</button>
                              <button className="btn btn-g btn-sm" style={{ fontSize:10,padding:"2px 8px" }} onClick={()=>setRowPenalty(row.id,pid,"red",1)}>🔴+</button>
                            </div>
                          );
                          return(
                            <div key={pid} style={{ display:"flex",alignItems:"center",gap:8,padding:"5px 8px",background:"var(--s1)",borderRadius:6,border:"1px solid var(--b1)",fontSize:12 }}>
                              <span style={{ flex:1,fontWeight:600 }}>{pName(pid,state.players)}</span>
                              <div className="fac" style={{ gap:3 }}><span>🟡</span><button className="btn btn-g btn-sm" style={{ padding:"1px 6px" }} onClick={()=>setRowPenalty(row.id,pid,"yellow",-1)}>−</button><span style={{ minWidth:14,textAlign:"center",fontWeight:700 }}>{pen.yellow||0}</span><button className="btn btn-g btn-sm" style={{ padding:"1px 6px" }} onClick={()=>setRowPenalty(row.id,pid,"yellow",1)}>+</button></div>
                              <div className="fac" style={{ gap:3 }}><span>🔴</span><button className="btn btn-g btn-sm" style={{ padding:"1px 6px" }} onClick={()=>setRowPenalty(row.id,pid,"red",-1)}>−</button><span style={{ minWidth:14,textAlign:"center",fontWeight:700 }}>{pen.red||0}</span><button className="btn btn-g btn-sm" style={{ padding:"1px 6px" }} onClick={()=>setRowPenalty(row.id,pid,"red",1)}>+</button></div>
                              <span style={{ color:"var(--orange)",fontWeight:700,minWidth:44,textAlign:"right" }}>−{total}pts</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            <button className="add-row" onClick={()=>setRows(r=>[...r,EMPTY_ROW()])}>+ Add Another Game</button>

            <div style={{ marginTop:14,display:"flex",gap:8,flexWrap:"wrap",alignItems:"center" }}>
              {(()=>{
                const readyCount=rows.filter(row=>{
                  const sA=parseInt(row.scoreA,10), sB=parseInt(row.scoreB,10);
                  return row.sideA.length===2&&row.sideB.length===2&&!isNaN(sA)&&!isNaN(sB)&&sA>=0&&sB>=0&&sA!==sB;
                }).length;
                return<button className="btn btn-p" onClick={submitAll} disabled={readyCount===0} style={{ opacity:readyCount===0?0.4:1 }}>Submit {readyCount}/{rows.length} Game{rows.length!==1?"s":""}</button>;
              })()}
              <input className="inp" placeholder="Template name…" value={tplName} onChange={e=>setTplName(e.target.value)} style={{ width:150 }}/>
              <button className="btn btn-g" onClick={saveTpl}>Save Template</button>
              {undoStack.length>0&&<button className="btn btn-warn" onClick={undoLast}>↩ Undo Last Submit</button>}
            </div>
          </div>
        </div>
      </div>
      {confirm&&<ConfirmDialog {...confirm} onCancel={()=>setConfirm(null)}/>}
    </>
  );
}

// ── FINALS DATE EDITOR ─────────────────────────────────────────────────────

function FinalsDateEditor({ finalsDate, setState, showToast, isAdmin }) {
  const [editing, setEditing] = useState(false);
  const parsed = finalsDate ? new Date(finalsDate) : null;
  const [dd, setDd] = useState(parsed ? String(parsed.getDate()).padStart(2,"0") : "");
  const [mm, setMm] = useState(parsed ? String(parsed.getMonth()+1).padStart(2,"0") : "");
  const [yyyy, setYyyy] = useState(parsed ? String(parsed.getFullYear()) : "");
  const [hh, setHh] = useState(parsed ? String(parsed.getHours()).padStart(2,"0") : "18");
  const [mn, setMn] = useState(parsed ? String(parsed.getMinutes()).padStart(2,"0") : "00");

  const prevFinalsDate = useRef(finalsDate);
  useEffect(()=>{
    const changed = finalsDate!==prevFinalsDate.current;
    prevFinalsDate.current=finalsDate;
    if (!finalsDate) { setDd(""); setMm(""); setYyyy(""); setHh("18"); setMn("00"); if(changed) setEditing(false); return; }
    const p=new Date(finalsDate);
    setDd(String(p.getDate()).padStart(2,"0")); setMm(String(p.getMonth()+1).padStart(2,"0")); setYyyy(String(p.getFullYear())); setHh(String(p.getHours()).padStart(2,"0")); setMn(String(p.getMinutes()).padStart(2,"0"));
    if(changed) setEditing(false);
  },[finalsDate]);

  if (!isAdmin) return null;

  function handleSave() {
    if (!dd||!mm||!yyyy) { setState(s=>({ ...s,finalsDate:null })); showToast("Finals date cleared"); setEditing(false); return; }
    const iso=new Date(parseInt(yyyy),parseInt(mm)-1,parseInt(dd),parseInt(hh)||0,parseInt(mn)||0).toISOString();
    setState(s=>({ ...s,finalsDate:iso })); showToast("Finals date saved"); setEditing(false);
  }

  if (!editing) return<div style={{ marginTop:10 }}><button className="btn btn-g btn-sm" onClick={()=>setEditing(true)}>{finalsDate?"Edit Finals Date":"Set Finals Date"}</button></div>;

  const fields=[["Day","DD",dd,setDd,60,1,31],["Month","MM",mm,setMm,60,1,12],["Year","YYYY",yyyy,setYyyy,80,2026,2099],["Hour","HH",hh,setHh,60,0,23],["Min","MM",mn,setMn,60,0,59]];
  return(
    <div style={{ marginTop:10 }}>
      <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:10 }}>
        <div className="fac" style={{ gap:8,flexWrap:"wrap",justifyContent:"center" }}>
          {fields.map(([lbl,ph,val,set,w,min,max])=>(
            <div key={lbl} style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:3 }}>
              <span className="xs text-dd">{lbl}</span>
              <input className="inp" type="number" placeholder={ph} min={min} max={max} value={val} onChange={e=>set(e.target.value)} style={{ width:w,textAlign:"center",fontSize:14 }}/>
            </div>
          ))}
        </div>
        <div className="fac" style={{ gap:6 }}>
          <button className="btn btn-p btn-sm" onClick={handleSave}>Save Date</button>
          <button className="btn btn-d btn-sm" onClick={()=>{ setState(s=>({ ...s,finalsDate:null })); showToast("Finals date cleared"); setEditing(false); }}>Clear</button>
          <button className="btn btn-g btn-sm" onClick={()=>setEditing(false)}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── FINALS VIEW ─────────────────────────────────────────────────────────────

function FinalsView({ state, setState, isAdmin, showToast }) {
  const monthKey = getMonthKey();
  const finals = (state.finals??{})[monthKey]??null;
  const ranked = [...(state.players??[])].sort((a,b)=>(b.pts||0)-(a.pts||0));
  const [tick, setTick] = useState(0);
  const [manualMode, setManualMode] = useState(false);
  const [wantLower, setWantLower] = useState(false);
  const EMPTY_SLOTS = { upperA:[], upperB:[], lowerA:[], lowerB:[] };
  const [slots, setSlots] = useState(EMPTY_SLOTS);
  const [bracketSearch, setBracketSearch] = useState('');

  useEffect(()=>{ const id=setInterval(()=>setTick(t=>t+1),1000); return()=>clearInterval(id); },[]);

  function getCountdown() {
    const pad=n=>String(Math.max(0,Math.floor(n))).padStart(2,"0");
    let target;
    if (state.finalsDate) { target=new Date(state.finalsDate); }
    else { const now=new Date(); target=new Date(now.getFullYear(),now.getMonth()+1,0,23,59,59); }
    const diff=target-Date.now();
    if (diff<=0) return{ days:"00",hours:"00",mins:"00",secs:"00",diff:0 };
    return{ days:pad(Math.floor(diff/86400000)),hours:pad(Math.floor((diff%86400000)/3600000)),mins:pad(Math.floor((diff%3600000)/60000)),secs:pad(Math.floor((diff%60000)/1000)),diff };
  }
  const { days:cdDays,hours:cdHours,mins:cdMins,secs:cdSecs,diff:cdDiff }=getCountdown();
  const cdColour=cdDiff<86400000?"var(--red)":cdDiff<7*86400000?"var(--orange)":"var(--green)";

  function Countdown({ compact }) {
    if (compact) return<div className="xs text-dd" style={{ marginTop:4 }}>{cdDays}d {cdHours}h {cdMins}m</div>;
    return(
      <div className="cd-wrap">
        {[["Days",cdDays],["Hours",cdHours],["Mins",cdMins],["Secs",cdSecs]].map(([lbl,val])=>(
          <div key={lbl} className="cd-unit"><div className="cd-num" style={{ color:cdColour }}>{val}</div><div className="cd-lbl">{lbl}</div></div>
        ))}
      </div>
    );
  }

  // Sequential slot picking order
  const pickingTeam = (()=>{
    if (slots.upperA.length<2) return 'upperA';
    if (slots.upperB.length<2) return 'upperB';
    if (wantLower&&slots.lowerA.length<2) return 'lowerA';
    if (wantLower&&slots.lowerB.length<2) return 'lowerB';
    return null;
  })();

  function pickPlayer(pid) { if (!pickingTeam) return; setSlots(prev=>({ ...prev,[pickingTeam]:[...prev[pickingTeam],pid] })); }
  function removeFromSlot(team, pid) {
    const clears={ upperA:{ ...EMPTY_SLOTS,upperA:slots.upperA.filter(x=>x!==pid) },upperB:{ ...slots,upperB:slots.upperB.filter(x=>x!==pid),lowerA:[],lowerB:[] },lowerA:{ ...slots,lowerA:slots.lowerA.filter(x=>x!==pid),lowerB:[] },lowerB:{ ...slots,lowerB:slots.lowerB.filter(x=>x!==pid) } };
    setSlots(clears[team]||slots);
  }

  function confirmManual() {
    if (slots.upperA.length!==2||slots.upperB.length!==2) { showToast('Semi 1 needs 2 players per side','error'); return; }
    if (wantLower&&(slots.lowerA.length!==2||slots.lowerB.length!==2)) { showToast('Semi 2 needs 2 players per side','error'); return; }
    const hasLower=wantLower&&slots.lowerA.length===2&&slots.lowerB.length===2;
    const bracket={ upper:{ sideA:slots.upperA,sideB:slots.upperB,winner:null,scoreA:null,scoreB:null },lower:hasLower?{ sideA:slots.lowerA,sideB:slots.lowerB,winner:null,scoreA:null,scoreB:null }:null,final:{ sideA:null,sideB:null,winner:null,scoreA:null,scoreB:null },champion:null,runnerUp:null,thirdPlace:null };
    setState(s=>({ ...s,finals:{ ...(s.finals??{}),[monthKey]:{ bracket,status:'semis' } } }));
    showToast('Bracket set!'); setManualMode(false); setSlots(EMPTY_SLOTS); setBracketSearch(''); setWantLower(false);
  }

  function recordResult(match, winnerSide, sA, sB) {
    setState(s=>{
      const f={ ...(s.finals?.[monthKey]??{}) };
      const b={ ...f.bracket };
      b[match]={ ...b[match],winner:winnerSide,scoreA:sA,scoreB:sB };
      if (match==="upper"||match==="lower") {
        const upperWinner=b.upper?.winner?(b.upper.winner==="A"?b.upper.sideA:b.upper.sideB):null;
        const lowerWinner=b.lower?.winner?(b.lower.winner==="A"?b.lower.sideA:b.lower.sideB):null;
        const hasLower=!!b.lower;
        const semisComplete=upperWinner&&(!hasLower||lowerWinner);
        if (semisComplete) { b.final={ sideA:upperWinner,sideB:hasLower?lowerWinner:null,winner:null,scoreA:null,scoreB:null }; f.status="final"; }
      }
      if (match==="final") {
        b.champion=winnerSide==="A"?b.final.sideA:b.final.sideB;
        // Resolve runner-up algorithmically using score-weighted, stage-adjusted formula
        const resolved=resolveRunnerUp(b);
        b.runnerUp=resolved.runnerUp;
        b.thirdPlace=resolved.thirdPlace;
        f.status="complete";
      }
      f.bracket=b;
      return{ ...s,finals:{ ...s.finals,[monthKey]:f } };
    });
    showToast("Result recorded");
  }

  function awardChampionship() {
    if (!finals?.bracket?.champion) return;
    const champIds=finals.bracket.champion;
    const runnerUpIds=finals.bracket.runnerUp||[];
    const thirdPlaceIds=finals.bracket.thirdPlace||[];
    const champNames=champIds.map(id=>pName(id,state.players));
    const ruNames=runnerUpIds.map(id=>pName(id,state.players));
    const tpNames=thirdPlaceIds.map(id=>pName(id,state.players));

    // Detect undefeated championship (won both matches without dropping)
    // A champion is undefeated if they won both their semi AND the final
    const bracket=finals.bracket;
    const champWonSemi=(bracket.upper?.winner&&(bracket.upper.winner==="A"?bracket.upper.sideA:bracket.upper.sideB).every(id=>champIds.includes(id)))||(bracket.lower?.winner&&(bracket.lower.winner==="A"?bracket.lower.sideA:bracket.lower.sideB).every(id=>champIds.includes(id)));
    const isUndefeated=!!champWonSemi;

    setState(s=>({
      ...s,
      players:s.players.map(p=>{
        const isChamp=champIds.includes(p.id);
        const isRunnerUp=runnerUpIds.includes(p.id);
        const isThird=thirdPlaceIds.includes(p.id);
        if (!isChamp&&!isRunnerUp&&!isThird) return p;
        if (isChamp) {
          const partner=champNames.find(n=>n!==p.name)||null;
          const already=(p.championships||[]).some(c=>c.month===monthKey);
          if (already) return p;
          return{ ...p,championships:[...(p.championships||[]),{ month:monthKey,partner,undefeated:isUndefeated }] };
        }
        if (isRunnerUp) {
          const partner=ruNames.find(n=>n!==p.name)||null;
          const already=(p.runnerUps||[]).some(c=>c.month===monthKey);
          if (already) return p;
          return{ ...p,runnerUps:[...(p.runnerUps||[]),{ month:monthKey,partner }] };
        }
        // Third place
        const partner=tpNames.find(n=>n!==p.name)||null;
        const already=(p.thirdPlaces||[]).some(c=>c.month===monthKey);
        if (already) return p;
        return{ ...p,thirdPlaces:[...(p.thirdPlaces||[]),{ month:monthKey,partner }] };
      })
    }));
    const ruStr=ruNames.length?" · "+ruNames.join(" & ")+" 🥈":"";
    const tpStr=tpNames.length?" · "+tpNames.join(" & ")+" 🥉":"";
    showToast("Awarded: "+champNames.join(" & ")+" 🏆"+ruStr+tpStr);
  }

  function getLive(matchKey) { return (state.finals?.[monthKey]?.liveScores?.[matchKey])||{ scoreA:0,scoreB:0,active:false }; }
  function setLiveScore(matchKey, side, delta) {
    setState(s=>{
      const f={ ...(s.finals?.[monthKey]||{}) };
      const ls={ ...(f.liveScores||{}) };
      const cur=ls[matchKey]||{ scoreA:0,scoreB:0,active:true };
      const key=side==="A"?"scoreA":"scoreB";
      ls[matchKey]={ ...cur,[key]:Math.max(0,(cur[key]||0)+delta),active:true };
      f.liveScores=ls;
      return{ ...s,finals:{ ...s.finals,[monthKey]:f } };
    });
  }
  function clearLiveScore(matchKey) {
    setState(s=>{ const f={ ...(s.finals?.[monthKey]||{}) }; const ls={ ...(f.liveScores||{}) }; delete ls[matchKey]; f.liveScores=ls; return{ ...s,finals:{ ...s.finals,[monthKey]:f } }; });
  }
  function startLive(matchKey) {
    setState(s=>{ const f={ ...(s.finals?.[monthKey]||{}) }; const ls={ ...(f.liveScores||{}) }; ls[matchKey]={ scoreA:0,scoreB:0,active:true }; f.liveScores=ls; return{ ...s,finals:{ ...s.finals,[monthKey]:f } }; });
  }

  function BMatch({ matchKey, label, overrideSideA, overrideSideB, preview }) {
    const m=preview?{ sideA:overrideSideA,sideB:overrideSideB }:finals?.bracket?.[matchKey];
    if (!m||!m.sideA) return(
      <div><div className="xs text-dd" style={{ textAlign:"center",marginBottom:5,letterSpacing:2,textTransform:"uppercase" }}>{label}</div><div className="b-match" style={{ padding:18,textAlign:"center",color:"var(--dimmer)",fontSize:12 }}>TBD</div></div>
    );
    const sideBReady=m.sideB&&m.sideB.length>0;
    const pA=m.sideA.map(id=>{ const pl=state.players.find(p=>p.id===id); return pl?{ name:pl.name,pos:pl.position }:{ name:"?",pos:null }; });
    const pB=(m.sideB||[]).map(id=>{ const pl=state.players.find(p=>p.id===id); return pl?{ name:pl.name,pos:pl.position }:{ name:"?",pos:null }; });
    const done=!!m.winner;
    const live=!preview&&!done?getLive(matchKey):null;
    const isLive=live?.active;
    return(
      <div>
        <div style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:6,marginBottom:5 }}>
          <div className="xs text-dd" style={{ letterSpacing:2,textTransform:"uppercase" }}>{label}</div>
          {isLive&&<span style={{ display:"flex",alignItems:"center",gap:4,fontSize:10,fontWeight:700,color:"var(--red)" }}><span className="live-pulse" style={{ display:"inline-block",width:6,height:6,borderRadius:"50%",background:"var(--red)" }}/>LIVE</span>}
        </div>
        <div style={{ background:"var(--s2)",border:`1px solid ${isLive?"rgba(240,112,112,.35)":"var(--b2)"}`,borderRadius:8,overflow:"hidden",minWidth:280,transition:"border-color .3s" }}>
          <div style={{ padding:"10px 14px",borderBottom:"2px solid var(--b1)",background:m.winner==="A"?"rgba(94,201,138,.08)":isLive&&live.scoreA>live.scoreB?"rgba(94,201,138,.04)":"transparent",display:"flex",justifyContent:"space-between",alignItems:"center",transition:"background .3s" }}>
            <div style={{ display:"flex",flexDirection:"column",gap:4 }}>
              {pA.map((pl,i)=><div key={i} className="fac" style={{ gap:6 }}><span style={{ fontWeight:600,fontSize:13,color:m.winner==="A"?"var(--green)":"var(--text)" }}>{pl.name}</span><PosBadge pos={pl.pos}/></div>)}
            </div>
            <div style={{ display:"flex",alignItems:"center",gap:6 }}>
              {isLive&&isAdmin&&<div style={{ display:"flex",flexDirection:"column",gap:3 }}><div className="score-btn" onClick={()=>setLiveScore(matchKey,"A",1)}>+</div><div className="score-btn" style={{ fontSize:14 }} onClick={()=>setLiveScore(matchKey,"A",-1)}>−</div></div>}
              {isLive&&<span className="live-score-num" style={{ color:live.scoreA>live.scoreB?"var(--green)":live.scoreA<live.scoreB?"var(--red)":"var(--text)" }}>{live.scoreA}</span>}
              {done&&<span className="disp text-am" style={{ fontSize:26,marginLeft:12 }}>{m.scoreA}</span>}
              {m.winner==="A"&&<span className="tag tag-w" style={{ marginLeft:8 }}>WIN</span>}
            </div>
          </div>
          <div style={{ textAlign:"center",padding:"4px 0",background:"var(--s3)",fontSize:9,letterSpacing:3,color:"var(--dimmer)",textTransform:"uppercase" }}>{isLive?<span className="live-pulse">— LIVE —</span>:"vs"}</div>
          <div style={{ padding:"10px 14px",background:m.winner==="B"?"rgba(94,201,138,.08)":isLive&&live.scoreB>live.scoreA?"rgba(94,201,138,.04)":"transparent",display:"flex",justifyContent:"space-between",alignItems:"center",transition:"background .3s" }}>
            {sideBReady?(
              <div style={{ display:"flex",flexDirection:"column",gap:4 }}>
                {pB.map((pl,i)=><div key={i} className="fac" style={{ gap:6 }}><span style={{ fontWeight:600,fontSize:13,color:m.winner==="B"?"var(--green)":"var(--text)" }}>{pl.name}</span><PosBadge pos={pl.pos}/></div>)}
              </div>
            ):<span className="text-dd xs" style={{ fontStyle:"italic" }}>Awaiting other semi…</span>}
            <div style={{ display:"flex",alignItems:"center",gap:6 }}>
              {isLive&&isAdmin&&<div style={{ display:"flex",flexDirection:"column",gap:3 }}><div className="score-btn" onClick={()=>setLiveScore(matchKey,"B",1)}>+</div><div className="score-btn" style={{ fontSize:14 }} onClick={()=>setLiveScore(matchKey,"B",-1)}>−</div></div>}
              {isLive&&<span className="live-score-num" style={{ color:live.scoreB>live.scoreA?"var(--green)":live.scoreB<live.scoreA?"var(--red)":"var(--text)" }}>{live.scoreB}</span>}
              {done&&<span className="disp text-am" style={{ fontSize:26,marginLeft:12 }}>{m.scoreB}</span>}
              {m.winner==="B"&&<span className="tag tag-w" style={{ marginLeft:8 }}>WIN</span>}
            </div>
          </div>
        </div>
        {!preview&&isAdmin&&!done&&(
          <div style={{ marginTop:8,display:"flex",flexDirection:"column",gap:6 }}>
            {!isLive?(
              <button className="btn btn-g btn-sm w-full" onClick={()=>startLive(matchKey)}>🔴 Start Live Scoring</button>
            ):(
              <div style={{ display:"flex",flexDirection:"column",gap:5 }}>
                <div style={{ display:"flex",gap:5,alignItems:"center",justifyContent:"center" }}>
                  <button className="btn btn-p btn-sm" style={{ flex:1 }} onClick={()=>{ if(live.scoreA===live.scoreB)return; const winner=live.scoreA>live.scoreB?"A":"B"; recordResult(matchKey,winner,live.scoreA,live.scoreB); clearLiveScore(matchKey); }} disabled={live.scoreA===live.scoreB}>✓ Confirm ({live.scoreA}–{live.scoreB})</button>
                  <button className="btn btn-d btn-sm" onClick={()=>clearLiveScore(matchKey)} title="Reset">↺</button>
                </div>
                <button className="btn btn-g btn-sm" style={{ fontSize:11 }} onClick={()=>clearLiveScore(matchKey)}>Cancel Live</button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const placedRanked=ranked.filter(p=>(state.monthlyPlacements?.[getCurrentPlacementKey(state)]||{})[p.id]>=CONFIG.MAX_PLACEMENTS_PER_MONTH);
  const upperPool=placedRanked.slice(0,4);
  const lowerPool=placedRanked.slice(4,8);
  const previewUpper=upperPool.length>=4?buildBracket(upperPool):null;
  const previewLower=lowerPool.length>=4?buildBracket(lowerPool):null;

  function initFinals() {
    if (placedRanked.length<4) { showToast("Need at least 4 placed players","error"); return; }
    const upper=buildBracket(upperPool);
    const lower=lowerPool.length>=4?buildBracket(lowerPool):null;
    const bracket={ upper:{ sideA:upper.teamA,sideB:upper.teamB,winner:null,scoreA:null,scoreB:null },lower:lower?{ sideA:lower.teamA,sideB:lower.teamB,winner:null,scoreA:null,scoreB:null }:null,final:{ sideA:null,sideB:null,winner:null,scoreA:null,scoreB:null },champion:null,runnerUp:null,thirdPlace:null };
    setState(s=>({ ...s,finals:{ ...(s.finals??{}),[monthKey]:{ bracket,status:"semis" } } }));
    showToast("Bracket generated!");
  }

  // No finals yet
  if (!finals) {
    const slotLabel=key=>({ upperA:'Semi 1 · Team A',upperB:'Semi 1 · Team B',lowerA:'Semi 2 · Team A',lowerB:'Semi 2 · Team B' })[key]||key;
    const allSlotKeys=wantLower?['upperA','upperB','lowerA','lowerB']:['upperA','upperB'];
    const usedIds=allSlotKeys.flatMap(k=>slots[k]);
    const unassigned=ranked.filter(p=>!usedIds.includes(p.id));
    const filteredUnassigned=!bracketSearch?unassigned:unassigned.filter(p=>p.name.toLowerCase().includes(bracketSearch.toLowerCase()));
    const upperDone=slots.upperA.length===2&&slots.upperB.length===2;
    const lowerDone=!wantLower||(slots.lowerA.length===2&&slots.lowerB.length===2);
    const allDone=upperDone&&lowerDone;

    return(
      <div className="stack page-fade">
        <div className="card" style={{ padding:32,textAlign:"center" }}>
          <div className="disp text-am" style={{ fontSize:36,letterSpacing:2,marginBottom:4 }}>Monthly Finals</div>
          <div className="text-d sm" style={{ marginBottom:12 }}>
            {state.finalsDate?<>Scheduled: <span className="text-am">{new Date(state.finalsDate).toLocaleString("en-GB",{ day:"numeric",month:"short",hour:"2-digit",minute:"2-digit" })}</span></>:`Finals — last day of ${fmtMonth(monthKey)}`}
          </div>
          <Countdown/>
          {cdDiff<864e5&&<div className="tag tag-l" style={{ marginBottom:16,fontSize:11,letterSpacing:2 }}>🔥 Finals are today!</div>}
          {cdDiff>=864e5&&cdDiff<7*864e5&&<div className="tag tag-a" style={{ marginBottom:16,fontSize:11,letterSpacing:2 }}>⚡ Finals this week</div>}
          <FinalsDateEditor finalsDate={state.finalsDate} setState={setState} showToast={showToast} isAdmin={isAdmin}/>
          {isAdmin&&(
            <div style={{ marginTop:12,display:'flex',flexDirection:'column',gap:10 }}>
              {placedRanked.length>=4&&(
                <div>
                  <div className="xs text-dd" style={{ marginBottom:6,lineHeight:1.6 }}>
                    Mixed seeding (#1+#4 vs #2+#3) — both semis are equally balanced by average MMR.<br/>
                    <span style={{ color:'var(--dimmer)',fontSize:10 }}>Role compatibility is used as a tie-break for complementary pairings.</span>
                  </div>
                  <button className="btn btn-p" onClick={initFinals}>⚡ Generate Bracket</button>
                </div>
              )}
              <div>
                <div className="xs text-dd" style={{ marginBottom:6 }}>Custom: hand-pick players for each semi-final.</div>
                <button className="btn btn-g" onClick={()=>{ setManualMode(m=>!m); setSlots(EMPTY_SLOTS); setBracketSearch(''); }}>{manualMode?'✕ Cancel':'✏ Custom Bracket'}</button>
              </div>
              {!placedRanked.length&&!manualMode&&<div className="msg msg-e" style={{ display:'inline-block' }}>No placed players yet</div>}
            </div>
          )}

          {/* ── REDESIGNED MANUAL BRACKET BUILDER ───────────────────────────
              Per plan §5 UX redesign:
              - Persistent visual slot cards showing all 4 positions
              - Active slot has breathing animation + "Picking now" label
              - Searchable unassigned player list below
              - Clear entry point via header instruction text
          ── */}
          {manualMode&&isAdmin&&(
            <div style={{ marginTop:12,padding:14,background:'var(--s2)',borderRadius:10,border:'1px solid var(--b2)',textAlign:'left' }}>
              <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14 }}>
                <span style={{ fontFamily:'var(--disp)',fontSize:14,fontWeight:700 }}>Custom Bracket</span>
                <div className="fac" style={{ gap:10 }}>
                  <label className="fac xs text-dd" style={{ gap:5,cursor:'pointer' }}>
                    <input type="checkbox" checked={wantLower} onChange={()=>{ setWantLower(v=>!v); setSlots(prev=>({ ...prev,lowerA:[],lowerB:[] })); }}/>
                    Include Semi 2
                  </label>
                  <button className="btn btn-g btn-sm" onClick={()=>{ setManualMode(false); setSlots(EMPTY_SLOTS); setBracketSearch(''); }}>Cancel</button>
                </div>
              </div>

              {/* Visual bracket slots */}
              <div style={{ display:'grid',gridTemplateColumns:wantLower?'1fr 24px 1fr':'1fr',gap:10,marginBottom:14 }}>
                {/* Semi 1 */}
                <div>
                  <div className="xs" style={{ color:'var(--green)',fontWeight:700,letterSpacing:1,textTransform:'uppercase',marginBottom:8 }}>Semi 1</div>
                  {(['upperA','upperB']).map((slotKey,idx)=>{
                    const isActive=pickingTeam===slotKey;
                    const isFull=slots[slotKey].length===2;
                    const cls=isActive?'bslot bslot-active':isFull?'bslot bslot-filled':'bslot bslot-empty';
                    const accent=idx===0?'var(--green)':'var(--blue)';
                    return(
                      <div key={slotKey} className={cls} style={{ marginBottom:idx===0?6:0 }}>
                        {isActive&&<div className="picking-label">Picking now</div>}
                        <div className="xs" style={{ color:accent,fontWeight:700,marginBottom:4,fontSize:9,letterSpacing:.5,textTransform:'uppercase' }}>
                          {idx===0?'Team A':'Team B'}
                        </div>
                        {slots[slotKey].length===0?(
                          <div className="xs text-dd" style={{ fontStyle:'italic' }}>{isActive?'← select from list below':'empty'}</div>
                        ):(
                          <div style={{ display:'flex',gap:4,flexWrap:'wrap' }}>
                            {slots[slotKey].map(id=>(
                              <span key={id} className="tag tag-w" style={{ cursor:'pointer',fontSize:10 }} onClick={()=>removeFromSlot(slotKey,id)}>
                                {pName(id,state.players)} ×
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Arrow */}
                {wantLower&&<div style={{ display:'flex',alignItems:'center',justifyContent:'center',paddingTop:24,color:'var(--dimmer)',fontSize:14 }}>→</div>}

                {/* Semi 2 */}
                {wantLower&&(
                  <div>
                    <div className="xs" style={{ color:'var(--orange)',fontWeight:700,letterSpacing:1,textTransform:'uppercase',marginBottom:8 }}>Semi 2</div>
                    {(['lowerA','lowerB']).map((slotKey,idx)=>{
                      const isActive=pickingTeam===slotKey;
                      const isFull=slots[slotKey].length===2;
                      const cls=isActive?'bslot bslot-active':isFull?'bslot bslot-filled':'bslot bslot-empty';
                      const accent=idx===0?'var(--green)':'var(--blue)';
                      return(
                        <div key={slotKey} className={cls} style={{ marginBottom:idx===0?6:0 }}>
                          {isActive&&<div className="picking-label">Picking now</div>}
                          <div className="xs" style={{ color:accent,fontWeight:700,marginBottom:4,fontSize:9,letterSpacing:.5,textTransform:'uppercase' }}>{idx===0?'Team A':'Team B'}</div>
                          {slots[slotKey].length===0?(
                            <div className="xs text-dd" style={{ fontStyle:'italic' }}>{isActive?'← select from list below':'empty'}</div>
                          ):(
                            <div style={{ display:'flex',gap:4,flexWrap:'wrap' }}>
                              {slots[slotKey].map(id=>(<span key={id} className="tag tag-w" style={{ cursor:'pointer',fontSize:10 }} onClick={()=>removeFromSlot(slotKey,id)}>{pName(id,state.players)} ×</span>))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Active slot instruction */}
              {pickingTeam&&!allDone&&(
                <div style={{ background:'rgba(94,201,138,.07)',border:'1px solid var(--amber-d)',borderRadius:6,padding:'7px 12px',fontSize:12,color:'var(--amber)',fontWeight:600,marginBottom:10 }}>
                  Picking for <strong>{slotLabel(pickingTeam)}</strong> — {2-slots[pickingTeam].length} more player{2-slots[pickingTeam].length!==1?'s':''} needed
                </div>
              )}

              {/* Searchable player pool */}
              {!allDone&&(
                <>
                  <input className="inp" placeholder="Search players…" value={bracketSearch} onChange={e=>setBracketSearch(e.target.value)} style={{ marginBottom:8,fontSize:12 }}/>
                  <div style={{ display:'flex',flexDirection:'column',gap:3,maxHeight:200,overflowY:'auto' }}>
                    {filteredUnassigned.map(p=>(
                      <div key={p.id} className={`player-chip ${!pickingTeam?'disabled':''}`}
                        style={{ cursor:pickingTeam?'pointer':'not-allowed',opacity:pickingTeam?1:0.5 }}
                        onClick={()=>pickingTeam&&pickPlayer(p.id)}>
                        <span style={{ fontWeight:600 }}>{p.name}</span>
                        <span className="xs text-dd">{p.pts||0}pts · {p.mmr||1000} MMR</span>
                      </div>
                    ))}
                    {filteredUnassigned.length===0&&(
                      <div className="xs text-dd" style={{ padding:'6px 0' }}>
                        {unassigned.length===0?'All players assigned':`No matches for "${bracketSearch}"`}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Confirm / reset */}
              <div className="fac" style={{ gap:8,marginTop:12 }}>
                {allDone&&<button className="btn btn-p" onClick={()=>{ confirmManual(); setBracketSearch(''); }}>✓ Confirm Bracket</button>}
                <button className="btn btn-g btn-sm" onClick={()=>{ setSlots(EMPTY_SLOTS); setBracketSearch(''); }}>{allDone?'Start Over':'Clear'}</button>
              </div>
            </div>
          )}
        </div>

        {/* Preview */}
        {(previewUpper||previewLower)&&(
          <div className="card">
            <div className="card-header"><span className="card-title">Preview — If Finals Happened Today</span><span className="tag tag-a">LIVE RANKINGS</span></div>
            <div style={{ padding:20,overflowX:"auto" }}>
              <div style={{ display:"flex",alignItems:"center",gap:16,minWidth:"fit-content" }}>
                <div style={{ display:"flex",flexDirection:"column",gap:20 }}>
                  {previewUpper&&<BMatch matchKey="upper" label="Semi 1 — Top 4" overrideSideA={previewUpper.teamA} overrideSideB={previewUpper.teamB} preview/>}
                  {previewLower&&<BMatch matchKey="lower" label="Semi 2 — Ranks 5–8" overrideSideA={previewLower.teamA} overrideSideB={previewLower.teamB} preview/>}
                </div>
                <div style={{ color:"var(--dimmer)",fontSize:22,fontWeight:800 }}>→</div>
                <div>
                  <div className="xs text-dd" style={{ letterSpacing:2,textTransform:"uppercase",marginBottom:8 }}>Grand Final</div>
                  <div style={{ background:"var(--s2)",border:"1px dashed var(--b2)",borderRadius:8,minWidth:220,padding:"14px 16px" }}>
                    <div style={{ padding:"8px 0",textAlign:"center" }}><div className="xs text-dd" style={{ letterSpacing:2,marginBottom:4 }}>Semi 1 Winner</div><div className="disp text-am" style={{ fontSize:16 }}>TBD</div></div>
                    <div style={{ borderTop:"1px solid var(--b1)",padding:"6px 0",textAlign:"center" }}><div className="xs text-dd" style={{ letterSpacing:3 }}>vs</div></div>
                    <div style={{ padding:"8px 0",textAlign:"center" }}><div className="xs text-dd" style={{ letterSpacing:2,marginBottom:4 }}>Semi 2 Winner</div><div className="disp text-am" style={{ fontSize:16 }}>TBD</div></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Bracket in progress / complete
  const { bracket,status }=finals??{};
  const champ=bracket?.champion?.map(id=>pName(id,state.players));
  const runnerUpNames=bracket?.runnerUp?.map(id=>pName(id,state.players));
  const thirdPlaceNames=bracket?.thirdPlace?.map(id=>pName(id,state.players));

  return(
    <div className="stack page-fade">
      <div className="card" style={{ textAlign:"center",padding:"16px 20px" }}>
        <div className="xs text-dd" style={{ marginBottom:2,letterSpacing:2,textTransform:"uppercase" }}>Finals Countdown</div>
        <Countdown compact={status==="complete"}/>
        {status==="complete"&&<div className="tag tag-w" style={{ marginTop:4 }}>Complete</div>}
        <FinalsDateEditor finalsDate={state.finalsDate} setState={setState} showToast={showToast} isAdmin={isAdmin}/>
      </div>

      {status==="complete"&&champ&&(
        <div style={{ textAlign:"center",padding:28,background:"var(--amber-g)",border:"1px solid var(--amber-d)",borderRadius:8 }}>
          <div className="xs text-am" style={{ letterSpacing:3,textTransform:"uppercase",marginBottom:6 }}>Monthly Champions</div>
          <div className="disp text-am" style={{ fontSize:38 }}>🏆 {champ.join(" & ")}</div>
          {runnerUpNames?.length>0&&<div className="xs" style={{ color:'#b0c8c0',marginTop:8 }}>🥈 Runner-Up: {runnerUpNames.join(" & ")}</div>}
          {thirdPlaceNames?.length>0&&<div className="xs" style={{ color:'#c8864a',marginTop:4 }}>🥉 Third Place: {thirdPlaceNames.join(" & ")}</div>}
          {isAdmin&&(
            <button className="btn btn-p btn-sm mt12" onClick={awardChampionship}>Award to Profiles</button>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">Bracket — {fmtMonth(monthKey)}</span>
          <div className="fac" style={{ gap:6 }}>
            {Object.values(finals?.liveScores||{}).some(v=>v?.active)&&(
              <span style={{ display:"flex",alignItems:"center",gap:4,fontSize:10,fontWeight:700,color:"var(--red)" }}>
                <span className="live-pulse" style={{ display:"inline-block",width:6,height:6,borderRadius:"50%",background:"var(--red)" }}/>LIVE
              </span>
            )}
            <span className={`tag ${status==="complete"?"tag-w":"tag-a"}`}>{status?.toUpperCase()}</span>
          </div>
        </div>
        <div style={{ padding:20,display:"flex",flexDirection:"column",gap:24 }}>
          <div>
            <div className="xs text-dd" style={{ letterSpacing:2,textTransform:"uppercase",marginBottom:10 }}>Semi 1</div>
            <div className="bracket" style={{ justifyContent:"flex-start",padding:0 }}>
              <BMatch matchKey="upper" label="Semi 1"/>
              {(status==="final"||status==="complete")&&(<><div className="b-conn">→</div><BMatch matchKey="final" label="Grand Final"/></>)}
            </div>
          </div>
          {bracket?.lower&&(
            <div>
              <div className="xs text-dd" style={{ letterSpacing:2,textTransform:"uppercase",marginBottom:10 }}>Semi 2</div>
              <div className="bracket" style={{ justifyContent:"flex-start",padding:0 }}><BMatch matchKey="lower" label="Semi 2"/></div>
            </div>
          )}
        </div>
        {isAdmin&&(
          <div style={{ padding:"10px 18px",borderTop:"1px solid var(--b1)" }}>
            <button className="btn btn-d btn-sm" onClick={()=>{ setState(s=>{ const f={ ...s.finals }; delete f[monthKey]; return{ ...s,finals:f }; }); showToast("Finals reset"); }}>Reset Bracket</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── PTS CHART ──────────────────────────────────────────────────────────────

function PtsChart({ pid, games, players, roleFilter }) {
  const W=320, H=90, PAD=10;
  const [hovered, setHovered] = useState(null);
  const svgRef = useRef(null);
  const playerGames=[...games].filter(g=>g.sideA.includes(pid)||g.sideB.includes(pid)).filter(g=>!roleFilter||roleFilter==="ALL"||g.roles?.[pid]===roleFilter).sort((a,b)=>new Date(a.date)-new Date(b.date));
  if (playerGames.length<2) return<div style={{ height:H,display:"flex",alignItems:"center",justifyContent:"center" }}><span className="xs text-dd">{roleFilter&&roleFilter!=="ALL"?`No ${roleFilter} games yet`:"Not enough games"}</span></div>;
  let pts=0;
  const data=playerGames.map(g=>{ const onA=g.sideA.includes(pid); const won=(onA&&g.winner==="A")||(!onA&&g.winner==="B"); const delta=won?(g.perPlayerGains?.[pid]??g.ptsGain):-(g.perPlayerLosses?.[pid]??g.ptsLoss); pts+=delta; const oppIds=onA?g.sideB:g.sideA; const opps=oppIds.map(id=>pName(id,players||[])).join(" & "); return{ pts,delta,won,date:g.date,opps,scoreA:g.scoreA,scoreB:g.scoreB }; });
  const minP=Math.min(0,...data.map(d=>d.pts)); const maxP=Math.max(...data.map(d=>d.pts)); const range=Math.max(maxP-minP,1);
  const toX=i=>PAD+(i/(data.length-1))*(W-PAD*2); const toY=v=>PAD+(1-(v-minP)/range)*(H-PAD*2);
  const pathD=data.map((d,i)=>`${i===0?"M":"L"}${toX(i).toFixed(1)},${toY(d.pts).toFixed(1)}`).join(" ");
  const fillD=pathD+` L${toX(data.length-1).toFixed(1)},${H} L${toX(0).toFixed(1)},${H} Z`;
  const lastPts=data[data.length-1].pts; const isPos=lastPts>=0;
  const lineCol=roleFilter==="ATK"?(isPos?"#f09050":"#f07070"):roleFilter==="DEF"?(isPos?"#60a8e8":"#f07070"):(isPos?"#5ec98a":"#f07070");
  function handleMouseMove(e) { const svg=svgRef.current; if(!svg) return; const rect=svg.getBoundingClientRect(); const scaleX=W/rect.width; const mouseX=(e.clientX-rect.left)*scaleX; let closest=0,minDist=Infinity; data.forEach((_,i)=>{ const dist=Math.abs(toX(i)-mouseX); if(dist<minDist){ minDist=dist; closest=i; } }); setHovered(closest); }
  const hov=hovered!==null?data[hovered]:null;
  return(
    <div style={{ position:"relative" }}>
      <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow:"visible",cursor:"crosshair",display:"block" }} onMouseMove={handleMouseMove} onMouseLeave={()=>setHovered(null)}>
        <defs><linearGradient id={`cg-${pid}-${roleFilter||"all"}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={lineCol} stopOpacity="0.22"/><stop offset="100%" stopColor={lineCol} stopOpacity="0"/></linearGradient></defs>
        {[0.25,0.5,0.75].map(t=>(<line key={t} x1={PAD} y1={PAD+(1-t)*(H-PAD*2)} x2={W-PAD} y2={PAD+(1-t)*(H-PAD*2)} stroke="var(--b1)" strokeWidth="1"/>))}
        {minP<0&&<line x1={PAD} y1={toY(0)} x2={W-PAD} y2={toY(0)} stroke="var(--b2)" strokeWidth="1" strokeDasharray="4,3"/>}
        <path d={fillD} fill={`url(#cg-${pid}-${roleFilter||"all"})`}/>
        <path d={pathD} fill="none" stroke={lineCol} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        {data.map((d,i)=>(<circle key={i} cx={toX(i)} cy={toY(d.pts)} r={hovered===i?4:2} fill={d.won?"#5ec98a":"#f07070"} stroke={hovered===i?"var(--bg)":"none"} strokeWidth="1.5" style={{ transition:"r .1s" }}/>))}
        {hov&&<line x1={toX(hovered)} y1={PAD} x2={toX(hovered)} y2={H-PAD} stroke="var(--dimmer)" strokeWidth="1" strokeDasharray="3,2"/>}
      </svg>
      {hov&&(()=>{ const x=toX(hovered)/W*100; const flipLeft=x>65; return(<div style={{ position:"absolute",top:0,left:flipLeft?"auto":`calc(${x}% + 8px)`,right:flipLeft?`calc(${100-x}% + 8px)`:"auto",background:"var(--s1)",border:"1px solid var(--b2)",borderRadius:8,padding:"6px 10px",fontSize:11,pointerEvents:"none",zIndex:10,minWidth:130,boxShadow:"0 4px 20px rgba(0,0,0,.5)",lineHeight:1.7 }}>
        <div style={{ fontWeight:700,fontSize:13,color:hov.won?"var(--green)":"var(--red)",marginBottom:2 }}>{hov.won?"▲":"▼"} {hov.pts} pts</div>
        <div style={{ color:hov.won?"var(--green)":"var(--red)" }}>{hov.delta>=0?"+":""}{hov.delta} this game</div>
        <div className="text-dd">{hov.scoreA}–{hov.scoreB} vs {hov.opps}</div>
        <div className="text-dd" style={{ fontSize:10,marginTop:2 }}>{new Date(hov.date).toLocaleDateString("en-GB",{ day:"numeric",month:"short" })}</div>
      </div>)})()}
      <div style={{ display:"flex",justifyContent:"space-between",marginTop:3,padding:`0 ${PAD}px` }}>
        <span className="xs text-dd">{new Date(playerGames[0].date).toLocaleDateString("en-GB",{ day:"numeric",month:"short" })}</span>
        <span className="xs text-dd">{lastPts} pts</span>
        <span className="xs text-dd">{new Date(playerGames[playerGames.length-1].date).toLocaleDateString("en-GB",{ day:"numeric",month:"short" })}</span>
      </div>
    </div>
  );
}

function WinDonut({ wins, losses }) {
  const total=wins+losses; if(!total) return<div style={{ width:64,height:64,display:"flex",alignItems:"center",justifyContent:"center" }}><span className="xs text-dd">—</span></div>;
  const pct=wins/total; const R=28,CX=32,CY=32,CIRC=2*Math.PI*R; const dash=pct*CIRC;
  return(<svg width="64" height="64" viewBox="0 0 64 64"><circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--b2)" strokeWidth="6"/><circle cx={CX} cy={CY} r={R} fill="none" stroke="#5ec98a" strokeWidth="6" strokeDasharray={`${dash} ${CIRC}`} strokeDashoffset={CIRC/4} strokeLinecap="round" style={{ transition:"stroke-dasharray .6s ease" }}/><text x={CX} y={CY+1} textAnchor="middle" dominantBaseline="middle" fill="var(--text)" fontSize="11" fontWeight="700" fontFamily="var(--disp)">{Math.round(pct*100)}%</text></svg>);
}

// ── STATS VIEW ─────────────────────────────────────────────────────────────

function StatsView({ state, onSelectPlayer }) {
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");
  const [seasonFilter, setSeasonFilter] = useState("current");
  const [posFilter, setPosFilter] = useState("ALL");
  const currentSeason=getCurrentSeason(state);
  const activeSeason=seasonFilter==="all"?null:seasonFilter==="current"?currentSeason:(state.seasons||[]).find(s=>s.id===seasonFilter)||null;
  const scopedGames=(state.games||[]).filter(g=>gameInSeason(g,activeSeason));
  const scopedStats=computeWindowPlayerStats(state.players,scopedGames);
  const sorted=[...state.players].sort((a,b)=>{ if(posFilter==="ATK") return(b.mmr_atk||b.mmr||0)-(a.mmr_atk||a.mmr||0); if(posFilter==="DEF") return(b.mmr_def||b.mmr||0)-(a.mmr_def||a.mmr||0); return(scopedStats[b.id]?.pts||0)-(scopedStats[a.id]?.pts||0); });
  const selected=state.players.find(p=>p.id===selectedId);
  function getH2H(pidA,pidB) { const shared=scopedGames.filter(g=>(g.sideA.includes(pidA)||g.sideB.includes(pidA))&&(g.sideA.includes(pidB)||g.sideB.includes(pidB))); let winsA=0,winsB=0; for(const g of shared){ const aOnA=g.sideA.includes(pidA); const won=(aOnA&&g.winner==="A")||(!aOnA&&g.winner==="B"); if(won) winsA++; else winsB++; } return{ games:shared.length,winsA,winsB }; }
  function getStats(p) {
    const playerGames=[...scopedGames].filter(g=>g.sideA.includes(p.id)||g.sideB.includes(p.id)).sort((a,b)=>new Date(a.date)-new Date(b.date));
    const wins=playerGames.filter(g=>{ const onA=g.sideA.includes(p.id); return(onA&&g.winner==="A")||(!onA&&g.winner==="B"); });
    const losses=playerGames.filter(g=>{ const onA=g.sideA.includes(p.id); return(onA&&g.winner==="B")||(!onA&&g.winner==="A"); });
    const avgGain=wins.length?Math.round(wins.reduce((s,g)=>s+(g.perPlayerGains?.[p.id]??g.ptsGain),0)/wins.length):0;
    const avgLoss=losses.length?Math.round(losses.reduce((s,g)=>s+(g.perPlayerLosses?.[p.id]??g.ptsLoss),0)/losses.length):0;
    const biggestMargin=wins.reduce((best,g)=>Math.max(best,Math.abs(g.scoreA-g.scoreB)),0);
    const longestStreak=(()=>{ let best=0,cur=0; playerGames.forEach(g=>{ const onA=g.sideA.includes(p.id); const won=(onA&&g.winner==="A")||(!onA&&g.winner==="B"); cur=won?cur+1:0; best=Math.max(best,cur); }); return best; })();
    return{ avgGain,avgLoss,biggestMargin,longestStreak,totalGames:playerGames.length,wins:wins.length,losses:losses.length };
  }
  function calcNetPts(pid,pgames) { return pgames.reduce((acc,g)=>{ const won=(g.sideA.includes(pid)&&g.winner==="A")||(g.sideB.includes(pid)&&g.winner==="B"); return acc+(won?(g.perPlayerGains?.[pid]??g.ptsGain??0):-(g.perPlayerLosses?.[pid]??g.ptsLoss??0)); },0); }

  return(
    <div className="stack page-fade">
      {activeSeason&&(
        <div className="card">
          <div className="card-header"><span className="card-title">Season Overview — {activeSeason.label}</span></div>
          <div className="grid-2" style={{ gap:0 }}>
            <div className="stat-box" style={{ borderRadius:0,border:"none",borderRight:"1px solid var(--b1)",borderBottom:"1px solid var(--b1)" }}><div className="stat-lbl">Season Start</div><div className="stat-val" style={{ fontSize:16 }}>{activeSeason.startAt&&!isNaN(Date.parse(activeSeason.startAt))?new Date(activeSeason.startAt).toLocaleDateString("en-GB",{ weekday:"short",month:"short",day:"numeric" }):<span className="text-dd">—</span>}</div></div>
            <div className="stat-box" style={{ borderRadius:0,border:"none",borderBottom:"1px solid var(--b1)" }}><div className="stat-lbl">Games This Season</div><div className="stat-val">{scopedGames.length}</div></div>
            <div className="stat-box" style={{ borderRadius:0,border:"none",borderRight:"1px solid var(--b1)" }}><div className="stat-lbl">Points In Play</div><div className="stat-val">{scopedGames.reduce((s,g)=>s+(g.ptsGain||0)+(g.ptsLoss||0),0)}</div></div>
            <div className="stat-box" style={{ borderRadius:0,border:"none" }}><div className="stat-lbl">7-Day Active</div><div className="stat-val">{(()=>{ const d=new Date(Date.now()-7*86400000); return scopedGames.filter(g=>new Date(g.date)>=d).length; })()}</div></div>
          </div>
        </div>
      )}
      <div className="grid-2" style={{ alignItems:"start" }}>
        <div className="card">
          <div className="card-header"><span className="card-title">Player Stats</span><select className="inp" value={seasonFilter} onChange={e=>setSeasonFilter(e.target.value)} style={{ fontSize:11,padding:"4px 8px",maxWidth:180 }}><option value="current">Current season</option><option value="all">All seasons</option>{(state.seasons||[]).map(se=><option key={se.id} value={se.id}>{se.label}</option>)}</select></div>
          <div style={{ padding:14 }}>
            <div className="fac" style={{ gap:4,marginBottom:8 }}>
              {["ALL","ATK","DEF"].map(f=>(<button key={f} className={`btn btn-sm ${posFilter===f?"btn-p":"btn-g"}`} style={{ minWidth:44,fontSize:11 }} onClick={()=>setPosFilter(f)}>{f}</button>))}
            </div>
            <input className="inp" placeholder="Search…" value={search} onChange={e=>setSearch(e.target.value)} style={{ marginBottom:10,fontSize:12 }}/>
            <div style={{ display:"flex",flexDirection:"column",gap:3,maxHeight:260,overflowY:"auto" }}>
              {sorted.filter(p=>!search||p.name.toLowerCase().includes(search.toLowerCase())).map(p=>(
                <div key={p.id} className={`player-chip ${selectedId===p.id?"sel-a":""}`} onClick={()=>setSelectedId(p.id)}>
                  <span style={{ fontWeight:600 }}>{p.name}</span>
                  <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                    <Sparkline pid={p.id} games={scopedGames}/>
                    <span className="xs text-dd">{posFilter==="ATK"?<><span style={{ color:"var(--orange)",fontWeight:600 }}>🗡 {p.mmr_atk||p.mmr}</span> ATK</>:posFilter==="DEF"?<><span style={{ color:"var(--blue)",fontWeight:600 }}>🛡 {p.mmr_def||p.mmr}</span> DEF</>:<>{p.mmr||1000} MMR{((p.wins_atk||0)+(p.losses_atk||0)+(p.wins_def||0)+(p.losses_def||0)>0)&&(<> · <span style={{ color:"var(--orange)" }}>A {p.mmr_atk||p.mmr}</span>/<span style={{ color:"var(--blue)" }}>D {p.mmr_def||p.mmr}</span></>)}</>} · {scopedStats[p.id]?.pts||0}pts</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        {selected?(()=>{
          const st=getStats(selected); const rank=sorted.findIndex(p=>p.id===selected.id)+1;
          const pGames=scopedGames.filter(g=>g.sideA.includes(selected.id)||g.sideB.includes(selected.id));
          const netPts=calcNetPts(selected.id,pGames); const ppg=pGames.length?(netPts/pGames.length).toFixed(1):null;
          return(
            <div className="card">
              <div className="card-header">
                <div style={{ display:"flex",flexDirection:"column",gap:1 }}><span className="card-title">{selected.name}</span><span className="xs text-dd">Rank #{rank} · {st.totalGames} games played</span></div>
                <button className="btn btn-g btn-sm" onClick={()=>onSelectPlayer(selected)}>Profile</button>
              </div>
              <div style={{ padding:16,display:"flex",flexDirection:"column",gap:14 }}>
                <div>
                  <div className="xs text-dd" style={{ marginBottom:6,letterSpacing:.5,textTransform:"uppercase",fontWeight:600 }}>{posFilter==="ATK"?"🗡 ATK points over time":posFilter==="DEF"?"🛡 DEF points over time":"Points over time"}</div>
                  <div style={{ background:"var(--s2)",borderRadius:8,padding:"10px 12px" }}><PtsChart key={`${selected.id}-${posFilter}`} pid={selected.id} games={scopedGames} players={state.players} roleFilter={posFilter}/></div>
                </div>
                {(()=>{
                  const atkGames=pGames.filter(g=>g.roles?.[selected.id]==="ATK"); const defGames=pGames.filter(g=>g.roles?.[selected.id]==="DEF"); const hasRoleData=atkGames.length+defGames.length>0;
                  const roleAvg=(games,type)=>{ const relevant=games.filter(g=>{ const won=(g.sideA.includes(selected.id)&&g.winner==="A")||(g.sideB.includes(selected.id)&&g.winner==="B"); return type==="win"?won:!won; }); if(!relevant.length) return null; const key=type==="win"?"perPlayerGains":"perPlayerLosses"; const fallback=type==="win"?"ptsGain":"ptsLoss"; return Math.round(relevant.reduce((s,g)=>s+(g[key]?.[selected.id]??g[fallback]??0),0)/relevant.length); };
                  return(
                    <>
                      <div style={{ display:"grid",gridTemplateColumns:"64px 1fr 1fr 1fr",gap:10,alignItems:"center" }}>
                        <WinDonut wins={st.wins} losses={st.losses}/>
                        {hasRoleData?(
                          <>
                            <div className="stat-box" style={{ padding:"8px 10px",outline:posFilter==="ATK"?"2px solid var(--orange)":"none" }}><div className="stat-lbl">ATK avg</div><div className="fac" style={{ gap:4,marginTop:2 }}>{roleAvg(atkGames,"win")!=null&&<span className="stat-val am" style={{ fontSize:16 }}>+{roleAvg(atkGames,"win")}</span>}{roleAvg(atkGames,"loss")!=null&&<span className="stat-val" style={{ fontSize:16,color:"var(--red)" }}>−{roleAvg(atkGames,"loss")}</span>}{atkGames.length===0&&<span className="xs text-dd">no games</span>}</div></div>
                            <div className="stat-box" style={{ padding:"8px 10px",outline:posFilter==="DEF"?"2px solid var(--blue)":"none" }}><div className="stat-lbl">DEF avg</div><div className="fac" style={{ gap:4,marginTop:2 }}>{roleAvg(defGames,"win")!=null&&<span className="stat-val am" style={{ fontSize:16 }}>+{roleAvg(defGames,"win")}</span>}{roleAvg(defGames,"loss")!=null&&<span className="stat-val" style={{ fontSize:16,color:"var(--red)" }}>−{roleAvg(defGames,"loss")}</span>}{defGames.length===0&&<span className="xs text-dd">no games</span>}</div></div>
                          </>
                        ):(
                          <>
                            <div className="stat-box" style={{ padding:"8px 12px" }}><div className="stat-lbl">Avg gain</div><div className="stat-val am" style={{ fontSize:20 }}>+{st.avgGain}</div></div>
                            <div className="stat-box" style={{ padding:"8px 12px" }}><div className="stat-lbl">Avg loss</div><div className="stat-val" style={{ fontSize:20,color:"var(--red)" }}>−{st.avgLoss}</div></div>
                          </>
                        )}
                        <div className="stat-box" style={{ padding:"8px 12px" }}><div className="stat-lbl">Best streak</div><div className="stat-val" style={{ fontSize:20 }}>▲{st.longestStreak}</div></div>
                      </div>
                      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10 }}>
                        <div className="stat-box" style={{ padding:"8px 12px" }}><div className="stat-lbl">Biggest win</div><div className="stat-val" style={{ fontSize:20 }}>+{st.biggestMargin}</div></div>
                        <div className="stat-box" style={{ padding:"8px 12px" }}><div className="stat-lbl">Net pts</div><div className="stat-val" style={{ fontSize:20,color:netPts>=0?"var(--green)":"var(--red)" }}>{netPts>=0?"+":""}{netPts}</div></div>
                        <div className="stat-box" style={{ padding:"8px 12px" }}><div className="stat-lbl">Pts / game</div><div className="stat-val" style={{ fontSize:20,color:!ppg?"var(--dimmer)":Number(ppg)>=0?"var(--green)":"var(--red)" }}>{ppg===null?"—":`${Number(ppg)>=0?"+":""}${ppg}`}</div></div>
                      </div>
                    </>
                  );
                })()}
                {(()=>{
                  const recent=scopedGames.filter(g=>g.sideA.includes(selected.id)||g.sideB.includes(selected.id)).sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,10).reverse();
                  if(!recent.length) return null;
                  return(
                    <div>
                      <div className="xs text-dd" style={{ marginBottom:6,letterSpacing:.5,textTransform:"uppercase",fontWeight:600 }}>Recent form</div>
                      <div style={{ display:"flex",gap:3 }}>
                        {recent.map(g=>{ const won=(g.sideA.includes(selected.id)&&g.winner==="A")||(g.sideB.includes(selected.id)&&g.winner==="B"); const role=g.roles?.[selected.id]; const roleIcon=role==="ATK"?"🗡":role==="DEF"?"🛡":role==="FLEX"?"↕":null; const delta=won?(g.perPlayerGains?.[selected.id]??g.ptsGain??0):-(g.perPlayerLosses?.[selected.id]??g.ptsLoss??0); const opps=(g.sideA.includes(selected.id)?g.sideB:g.sideA).map(id=>pName(id,state.players)).join(" & ");
                          return<div key={g.id} title={`${won?"W":"L"}${role?` (${role})`:""}  vs ${opps} · ${delta>=0?"+":""}${delta}pts`} style={{ flex:1,borderRadius:4,minHeight:28,background:won?"rgba(94,201,138,.18)":"rgba(240,112,112,.14)",border:`1px solid ${won?"rgba(94,201,138,.45)":"rgba(240,112,112,.35)"}`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,color:won?"var(--green)":"var(--red)",cursor:"default",gap:1,paddingTop:roleIcon?3:0 }}>{won?"W":"L"}{roleIcon&&<span style={{ fontSize:8,opacity:.7,lineHeight:1 }}>{roleIcon}</span>}</div>; })}
                      </div>
                    </div>
                  );
                })()}
                <div>
                  <div className="sec" style={{ marginBottom:6 }}>Head to Head</div>
                  <div style={{ display:"flex",flexDirection:"column",gap:4,maxHeight:160,overflowY:"auto" }}>
                    {sorted.filter(p=>p.id!==selected.id).map(p=>{ const h=getH2H(selected.id,p.id); if(!h.games) return null; const pct=Math.round(h.winsA/h.games*100); return(<div key={p.id} style={{ display:"flex",alignItems:"center",gap:8,padding:"6px 10px",borderRadius:8,background:"var(--s2)",border:"1px solid var(--b1)" }}><span style={{ flex:1,fontWeight:600,fontSize:13 }}>{p.name}</span><div style={{ width:60,height:5,borderRadius:3,background:"var(--b2)",overflow:"hidden" }}><div style={{ width:`${pct}%`,height:"100%",background:"var(--green)",borderRadius:3,transition:"width .4s ease" }}/></div><span className="text-g bold" style={{ fontSize:12,minWidth:20 }}>{h.winsA}W</span><span className="text-dd xs">–</span><span className="text-r bold" style={{ fontSize:12,minWidth:20 }}>{h.winsB}L</span></div>); }).filter(Boolean)}
                    {!sorted.filter(p=>p.id!==selected.id).some(p=>getH2H(selected.id,p.id).games>0)&&<div className="xs text-dd" style={{ padding:"8px 0" }}>No H2H data yet</div>}
                  </div>
                </div>
              </div>
            </div>
          );
        })():(
          <div className="card" style={{ display:"flex",alignItems:"center",justifyContent:"center",minHeight:240 }}>
            <div style={{ textAlign:"center" }}><div style={{ fontSize:28,marginBottom:8 }}>📊</div><span className="text-dd" style={{ fontSize:13 }}>Select a player to view stats</span></div>
          </div>
        )}
      </div>
      <TeamBalancer players={state.players}/>
    </div>
  );
}

// ── TEAM BALANCER ──────────────────────────────────────────────────────────

function TeamBalancer({ players }) {
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState("");
  const sorted=[...players].sort((a,b)=>(b.mmr||0)-(a.mmr||0));
  const visible=sorted.filter(p=>!search||p.name.toLowerCase().includes(search.toLowerCase()));
  function toggle(id) { setSelected(s=>s.includes(id)?s.filter(x=>x!==id):s.length<4?[...s,id]:s); }
  function getBalancings(pids) {
    const [a,b,c,d]=pids;
    return [[[a,b],[c,d]],[[a,c],[b,d]],[[a,d],[b,c]]].map(([t1,t2])=>{
      const mmr1=t1.reduce((s,id)=>s+(players.find(p=>p.id===id)?.mmr||1000),0)/2;
      const mmr2=t2.reduce((s,id)=>s+(players.find(p=>p.id===id)?.mmr||1000),0)/2;
      const diff=Math.abs(mmr1-mmr2); const total=mmr1+mmr2; const balance=Math.round((1-diff/Math.max(total/2,1))*100);
      return{ t1,t2,mmr1:Math.round(mmr1),mmr2:Math.round(mmr2),diff:Math.round(diff),balance };
    }).sort((a,b)=>a.diff-b.diff);
  }
  const matchups=selected.length===4?getBalancings(selected):null;
  return(
    <div className="card">
      <div className="card-header"><span className="card-title">⚖ Team Balancer</span>{selected.length>0&&<button className="btn btn-g btn-sm" onClick={()=>setSelected([])}>Clear</button>}</div>
      <div style={{ padding:14 }}>
        <div className="xs text-dd" style={{ marginBottom:10,lineHeight:1.6 }}>Select 4 players to see all possible fair matchups ranked by MMR balance.</div>
        <div className="lbl">{selected.length}/4 players selected</div>
        {selected.length>0&&<div style={{ display:"flex",gap:6,flexWrap:"wrap",marginBottom:10 }}>{selected.map(id=>{ const p=players.find(x=>x.id===id); return<span key={id} className="tag tag-a" style={{ cursor:"pointer",fontSize:11,padding:"3px 8px" }} onClick={()=>toggle(id)}>{p?.name} ×</span>; })}</div>}
        <input className="inp" placeholder="Search players…" value={search} onChange={e=>setSearch(e.target.value)} style={{ marginBottom:8,fontSize:12 }}/>
        <div style={{ display:"flex",flexDirection:"column",gap:3,maxHeight:160,overflowY:"auto",marginBottom:14 }}>
          {visible.map(p=>{ const sel=selected.includes(p.id); const full=!sel&&selected.length>=4; return<div key={p.id} className={`player-chip ${sel?"sel-a":""} ${full?"disabled":""}`} onClick={()=>!full&&toggle(p.id)}><span>{p.name}</span><span className="xs text-dd">{p.mmr||1000} MMR · {p.pts||0}pts</span></div>; })}
        </div>
        {matchups&&(
          <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
            <div className="sec">Suggested matchups</div>
            {matchups.map(({ t1,t2,mmr1,mmr2,diff,balance },i)=>(
              <div key={i} style={{ background:i===0?"rgba(94,201,138,.06)":"var(--s2)",border:`1px solid ${i===0?"var(--amber-d)":"var(--b2)"}`,borderRadius:6,padding:"10px 14px" }}>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6 }}>
                  <span className="xs text-dd">Option {i+1}</span>
                  <span className={`tag ${i===0?"tag-w":"tag-a"}`}>{balance}% balanced</span>
                </div>
                <div style={{ display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:10,alignItems:"center" }}>
                  <div>{t1.map(id=><div key={id} className="bold" style={{ fontSize:12 }}>{players.find(p=>p.id===id)?.name}</div>)}<div className="xs text-dd" style={{ marginTop:2 }}>{mmr1} avg MMR</div></div>
                  <div style={{ textAlign:"center",color:"var(--dimmer)",fontSize:11,fontWeight:700 }}>VS<br/><span style={{ fontSize:10,color:diff<30?"var(--green)":diff<80?"var(--orange)":"var(--red)" }}>Δ{diff}</span></div>
                  <div style={{ textAlign:"right" }}>{t2.map(id=><div key={id} className="bold" style={{ fontSize:12 }}>{players.find(p=>p.id===id)?.name}</div>)}<div className="xs text-dd" style={{ marginTop:2 }}>{mmr2} avg MMR</div></div>
                </div>
              </div>
            ))}
          </div>
        )}
        {selected.length>0&&selected.length<4&&<div className="msg msg-w" style={{ marginTop:8 }}>Select {4-selected.length} more player{4-selected.length!==1?"s":""}</div>}
      </div>
    </div>
  );
}

// ── SEASONS ARCHIVE VIEW ───────────────────────────────────────────────────

function SeasonsArchiveView({ state, setState, isAdmin, showToast, onNavToHistory, onNavToStats, onStartNewSeason }) {
  const allSeasons=state.seasons||[]; const currentSeason=getCurrentSeason(state);
  const [tick, setTick] = useState(0);
  const [editingNextDate, setEditingNextDate] = useState(false);
  const [nextDateInput, setNextDateInput] = useState(state.nextSeasonDate?new Date(state.nextSeasonDate).toISOString().slice(0,16):"");
  const [confirm, setConfirm] = useState(null);
  const prevNextSeasonDate=useRef(state.nextSeasonDate);
  useEffect(()=>{ if(state.nextSeasonDate===prevNextSeasonDate.current) return; prevNextSeasonDate.current=state.nextSeasonDate; if(!editingNextDate) setNextDateInput(state.nextSeasonDate?new Date(state.nextSeasonDate).toISOString().slice(0,16):""); },[state.nextSeasonDate,editingNextDate]);
  useEffect(()=>{ const id=setInterval(()=>setTick(t=>t+1),1000); return()=>clearInterval(id); },[]);
  const seasonProgress=(()=>{
    if(!currentSeason?.startAt) return null;
    const start=Date.parse(currentSeason.startAt); if(!Number.isFinite(start)) return null;
    const now=Date.now(); const elapsed=now-start; const elapsedDays=Math.floor(elapsed/86400000);
    if(state.nextSeasonDate){ const end=Date.parse(state.nextSeasonDate); if(Number.isFinite(end)&&end>start){ const total=end-start; const pct=Math.min(100,Math.round((elapsed/total)*100)); const remaining=Math.max(0,end-now); const remDays=Math.floor(remaining/86400000); const remHours=Math.floor((remaining%86400000)/3600000); const remMins=Math.floor((remaining%3600000)/60000); const remSecs=Math.floor((remaining%60000)/1000); return{ elapsedDays,pct,remDays,remHours,remMins,remSecs,hasEnd:true,endDate:new Date(end) }; }}
    return{ elapsedDays,pct:null,hasEnd:false };
  })();
  function saveNextDate() { const iso=nextDateInput?new Date(nextDateInput).toISOString():null; setState(s=>({ ...s,nextSeasonDate:iso })); showToast(iso?"Next season date set":"Next season date cleared"); setEditingNextDate(false); }

  return(
    <div className="stack page-fade">
      {(currentSeason&&seasonProgress)?(
        <div className="card" style={{ overflow:"hidden" }}>
          <div style={{ height:3,background:"var(--b1)",position:"relative" }}>
            <div style={{ position:"absolute",inset:0,width:seasonProgress.pct!==null?`${seasonProgress.pct}%`:"100%",background:"linear-gradient(90deg,var(--amber),var(--green))",transition:"width 1s linear",boxShadow:"0 0 8px rgba(88,200,130,.4)" }}/>
          </div>
          <div style={{ padding:"20px 24px" }}>
            <div style={{ display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,flexWrap:"wrap",marginBottom:16 }}>
              <div>
                <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:4 }}><span style={{ fontFamily:"var(--disp)",fontSize:22,fontWeight:800,color:"var(--text)" }}>{currentSeason.label}</span><span className="tag tag-w" style={{ fontSize:9,letterSpacing:1.2 }}>LIVE</span></div>
                <div className="xs text-dd">Started {currentSeason.startAt&&!isNaN(Date.parse(currentSeason.startAt))?new Date(currentSeason.startAt).toLocaleDateString("en-GB",{ day:"numeric",month:"long",year:"numeric" }):"—"}{" · "}{seasonProgress.elapsedDays} day{seasonProgress.elapsedDays!==1?"s":""} in</div>
              </div>
              {isAdmin&&<button className="btn btn-g btn-sm" onClick={()=>setEditingNextDate(v=>!v)}>{state.nextSeasonDate?"Edit end date":"Set end date"}</button>}
            </div>
            {editingNextDate&&isAdmin&&(
              <div style={{ display:"flex",gap:8,alignItems:"flex-end",marginBottom:16,padding:"10px 12px",background:"var(--s2)",borderRadius:8,border:"1px solid var(--b1)",flexWrap:"wrap" }}>
                <div style={{ flex:"1 1 200px" }}><label className="lbl">Next season starts</label><input className="inp" type="datetime-local" value={nextDateInput} onChange={e=>setNextDateInput(e.target.value)}/></div>
                <div className="fac" style={{ gap:6 }}><button className="btn btn-p btn-sm" onClick={saveNextDate}>Save</button>{state.nextSeasonDate&&<button className="btn btn-d btn-sm" onClick={()=>{ setNextDateInput(""); setState(s=>({ ...s,nextSeasonDate:null })); showToast("Date cleared"); setEditingNextDate(false); }}>Clear</button>}<button className="btn btn-g btn-sm" onClick={()=>setEditingNextDate(false)}>Cancel</button></div>
              </div>
            )}
            {seasonProgress.hasEnd?(
              <div>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:6 }}><span className="xs text-dd" style={{ letterSpacing:.5,textTransform:"uppercase",fontWeight:600 }}>Next season in</span><span className="xs text-dd">{seasonProgress.pct}% through</span></div>
                <div style={{ display:"flex",alignItems:"baseline",gap:4,marginBottom:12,flexWrap:"wrap" }}>
                  {seasonProgress.remDays>0&&<><span style={{ fontFamily:"var(--disp)",fontSize:52,fontWeight:800,lineHeight:1,color:seasonProgress.remDays<=1?"var(--red)":seasonProgress.remDays<=7?"var(--orange)":"var(--amber)" }}>{seasonProgress.remDays}</span><span style={{ fontFamily:"var(--disp)",fontSize:18,color:"var(--dim)",marginRight:12 }}>day{seasonProgress.remDays!==1?"s":""}</span></>}
                  <span style={{ fontFamily:"var(--mono)",fontSize:13,color:"var(--dimmer)",letterSpacing:1 }}>{String(seasonProgress.remHours).padStart(2,"0")}:{String(seasonProgress.remMins).padStart(2,"0")}:{String(seasonProgress.remSecs).padStart(2,"0")}</span>
                </div>
                <div style={{ height:6,background:"var(--b1)",borderRadius:3,overflow:"hidden" }}><div style={{ height:"100%",width:`${seasonProgress.pct}%`,borderRadius:3,background:`linear-gradient(90deg,var(--amber),${seasonProgress.pct>85?"var(--red)":"var(--green)"})`,transition:"width 1s linear" }}/></div>
                <div style={{ display:"flex",justifyContent:"space-between",marginTop:4 }}><span className="xs text-dd">{currentSeason.startAt?new Date(currentSeason.startAt).toLocaleDateString("en-GB",{ day:"numeric",month:"short" }):""}</span><span className="xs text-dd">{seasonProgress.endDate.toLocaleDateString("en-GB",{ day:"numeric",month:"short",year:"numeric" })}</span></div>
              </div>
            ):(
              <div style={{ display:"flex",alignItems:"center",gap:12,padding:"10px 0" }}>
                <div style={{ fontFamily:"var(--disp)",fontSize:42,fontWeight:800,color:"var(--amber)",lineHeight:1 }}>{seasonProgress.elapsedDays}</div>
                <div><div style={{ fontWeight:600,fontSize:14 }}>days running</div><div className="xs text-dd">No end date set{isAdmin?" — set one above":""}</div></div>
              </div>
            )}
            {isAdmin&&(
              <div style={{ marginTop:16,paddingTop:14,borderTop:"1px solid var(--b1)",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap" }}>
                <div className="xs text-dd" style={{ lineHeight:1.6 }}>Starting a new season resets all points, MMR and streaks.<br/>Game history and stats are preserved.</div>
                <button className="btn btn-warn" onClick={()=>setConfirm({ title:"Start New Season?",msg:`This will end ${currentSeason.label} and reset all points, MMR and streaks. Game history is preserved.`,onConfirm:()=>{ onStartNewSeason?.(); setConfirm(null); } })}>⚡ Start New Season</button>
              </div>
            )}
          </div>
        </div>
      ):(
        <div className="card" style={{ padding:"28px 24px",textAlign:"center" }}>
          <div style={{ fontSize:32,marginBottom:10 }}>🏁</div>
          <div style={{ fontFamily:"var(--disp)",fontSize:20,fontWeight:700,marginBottom:6 }}>No active season</div>
          <div className="xs text-dd" style={{ marginBottom:isAdmin?16:0 }}>Start a season to begin tracking rankings and progress.</div>
          {isAdmin&&<button className="btn btn-p" style={{ marginTop:8 }} onClick={()=>setConfirm({ title:"Start First Season?",msg:"This will create Season 1 and begin tracking points from now.",onConfirm:()=>{ onStartNewSeason?.(); setConfirm(null); } })}>⚡ Start Season 1</button>}
        </div>
      )}

      <div className="sec" style={{ margin:"4px 0 0" }}>Archive</div>
      {allSeasons.length===0?<div className="msg msg-i">No seasons recorded yet</div>:([...allSeasons].reverse().map((season,idx)=>{
        const isCurrent=!season.endAt; if(isCurrent) return null;
        const seasonGames=(state.games||[]).filter(g=>gameInSeason(g,season));
        const seasonStats=computeWindowPlayerStats(state.players,seasonGames);
        const ranked=[...(state.players||[])].sort((a,b)=>(seasonStats[b.id]?.pts||0)-(seasonStats[a.id]?.pts||0));
        const topThree=ranked.slice(0,3).filter(p=>seasonStats[p.id]?.wins>0||seasonStats[p.id]?.losses>0);
        const startDate=season.startAt&&!isNaN(Date.parse(season.startAt))?new Date(season.startAt).toLocaleDateString("en-GB",{ day:"numeric",month:"short",year:"numeric" }):"?";
        const endDate=season.endAt&&!isNaN(Date.parse(season.endAt))?new Date(season.endAt).toLocaleDateString("en-GB",{ day:"numeric",month:"short",year:"numeric" }):"Ongoing";
        const durationDays=(season.startAt&&season.endAt)?Math.round((Date.parse(season.endAt)-Date.parse(season.startAt))/86400000):null;
        return(
          <div key={season.id} className="card">
            <div className="card-header">
              <div><div style={{ fontFamily:"var(--disp)",fontSize:15,fontWeight:700 }}>{season.label}</div><div className="xs text-dd" style={{ marginTop:2 }}>{startDate} — {endDate}{durationDays?` · ${durationDays}d`:""}</div></div>
              <div className="xs text-dd">{seasonGames.length} games</div>
            </div>
            {topThree.length>0&&(<div style={{ padding:"10px 16px",display:"flex",gap:6,flexWrap:"wrap" }}>{topThree.map((p,i)=>(<div key={p.id} style={{ display:"flex",alignItems:"center",gap:8,padding:"6px 12px",borderRadius:8,background:i===0?"radial-gradient(ellipse at 0% 50%,rgba(232,184,74,.12),var(--s2))":i===1?"radial-gradient(ellipse at 0% 50%,rgba(192,200,196,.07),var(--s2))":"var(--s2)",border:`1px solid ${i===0?"rgba(232,184,74,.25)":"var(--b1)"}`,flex:"1 1 120px" }}><span style={{ fontSize:14 }}>{i===0?"🥇":i===1?"🥈":"🥉"}</span><div><div style={{ fontWeight:600,fontSize:13 }}>{p.name}</div><div className="xs" style={{ color:"var(--amber)" }}>{seasonStats[p.id]?.pts||0} pts</div></div></div>))}</div>)}
            <div style={{ padding:"8px 16px 12px",display:"flex",gap:6 }}>
              <button className="btn btn-g btn-sm" onClick={()=>onNavToHistory?.(season)}>History</button>
              <button className="btn btn-g btn-sm" onClick={()=>onNavToStats?.(season)}>Stats</button>
            </div>
          </div>
        );
      }))}
      {confirm&&<ConfirmDialog title={confirm.title} msg={confirm.msg} onConfirm={confirm.onConfirm} onCancel={()=>setConfirm(null)}/>}
    </div>
  );
}

// ── RULES VIEW ─────────────────────────────────────────────────────────────

function RulesView({ state, setState, isAdmin, showToast }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(state.rules||DEFAULT_RULES);
  function save() { setState(s=>({ ...s,rules:draft })); showToast("Rulebook saved"); setEditing(false); }
  if (editing) return(
    <div className="stack">
      <div className="card">
        <div className="card-header"><span className="card-title">Edit Rulebook</span><div className="fac"><button className="btn btn-g" onClick={()=>{ setDraft(state.rules||DEFAULT_RULES); setEditing(false); }}>Cancel</button><button className="btn btn-p" onClick={save}>Save</button></div></div>
        <div style={{ padding:18 }}>
          <div className="msg msg-w sm mb12">Supports Obsidian markdown: # headings, **bold**, - lists, `code`, ---</div>
          <textarea className="inp" rows={28} value={draft} onChange={e=>setDraft(e.target.value)} style={{ fontFamily:"var(--mono)",fontSize:12,lineHeight:1.7 }}/>
        </div>
      </div>
    </div>
  );
  return(
    <div className="stack page-fade">
      <div className="card">
        <div className="card-header"><span className="card-title">Rulebook</span>{isAdmin&&<button className="btn btn-g btn-sm" onClick={()=>{ setDraft(state.rules||DEFAULT_RULES); setEditing(true); }}>Edit</button>}</div>
        <div style={{ padding:24 }} className="md" dangerouslySetInnerHTML={{ __html:renderMd(state.rules||DEFAULT_RULES) }}/>
      </div>
    </div>
  );
}

// ── ADVANCED PANEL ─────────────────────────────────────────────────────────

function AdvancedPanel({ state, setState, showToast, onStartNewSeason }) {
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [selected, setSelected] = useState(null);
  const [exportSeasonFilter, setExportSeasonFilter] = useState("current");
  const clientId=getClientId(); const lastWriterId=state?._meta?.lastWriterId||"—"; const lastWriteAt=state?._meta?.lastWriteAt?new Date(state._meta.lastWriteAt).toLocaleString("en-GB"):"—";
  const lastBackupAt=readLocalNumber(LAST_BACKUP_KEY,0); const lastBackupLabel=lastBackupAt?new Date(lastBackupAt).toLocaleString("en-GB"):"—";
  const [annBody, setAnnBody] = useState(state.announcement?.body||""); const [annTitle, setAnnTitle] = useState(state.announcement?.title||""); const [annSubtitle, setAnnSubtitle] = useState(state.announcement?.subtitle||""); const [annFlashy, setAnnFlashy] = useState(false); const [annHype, setAnnHype] = useState(false); const [annScheduleStart, setAnnScheduleStart] = useState(""); const [annScheduleEnd, setAnnScheduleEnd] = useState(""); const [annPreview, setAnnPreview] = useState(false); const [autoSeasonAnnouncement, setAutoSeasonAnnouncement] = useState(true);
  useEffect(()=>{ const ann=state.announcement; setAnnBody(ann?.body||""); setAnnTitle(ann?.title||""); setAnnSubtitle(ann?.subtitle||""); setAnnFlashy(ann?.type==="flashy"||ann?.type==="seasonLaunch"); setAnnHype(ann?.type==="hype"); },[state.announcement?.id]);
  const loadHistory=useCallback(async()=>{ const { data,error }=await supabase.from("app_state_history").select("id,state,saved_at").order("saved_at",{ ascending:false }).limit(25); if(!error) setHistory(data||[]); },[]);
  useEffect(()=>{ loadHistory(); },[loadHistory]);
  async function restoreState(row) { if(!row) return; setLoading(true); const { error }=await supabase.from("app_state").update({ state:row.state }).eq("id",1); if(error) showToast("Restore failed","err"); else { setState(row.state); showToast("State restored","ok"); } setLoading(false); }
  async function restoreLatest() { if(!history.length) { showToast("No backups found","err"); return; } await restoreState(history[0]); }
  async function hardReset() { if(!confirm("Hard reset leaderboard?")) return; const next={ ...state,players:[],games:[],monthlyPlacements:{},finals:{},finalsDate:null }; const { error }=await supabase.from("app_state").update({ state:next }).eq("id",1); if(!error) { setState(next); showToast("Leaderboard reset","ok"); } else showToast("Reset failed","err"); }
  function resetSeasonPoints() { const ok=confirm("Start a new season? Points, MMR, and streaks reset. History and stats stay."); if(!ok) return; const annType=annHype?"hype":annFlashy?"flashy":"hype"; onStartNewSeason({ type:annType,title:annTitle.trim(),subtitle:annSubtitle.trim()||"Fresh leaderboard",body:annBody.trim(),withAnnouncement:autoSeasonAnnouncement }); }
  function publishAnnouncement() { if(!annBody.trim()) { showToast("Announcement body required","err"); return; } const now=new Date(); const start=annScheduleStart?new Date(annScheduleStart):now; const end=annScheduleEnd?new Date(annScheduleEnd):new Date(start.getTime()+24*60*60*1000); if(end<=start) { showToast("End time must be after start time","err"); return; } const announcement={ id:`ann_${Date.now()}`,title:annTitle.trim()||undefined,subtitle:annSubtitle.trim()||undefined,body:annBody.trim(),startsAt:start.toISOString(),endsAt:end.toISOString(),createdBy:clientId,type:annHype?"hype":annFlashy?"flashy":"standard" }; setState(s=>({ ...s,announcement })); showToast(start>now?`Scheduled for ${start.toLocaleString("en-GB",{ day:"numeric",month:"short",hour:"2-digit",minute:"2-digit" })}`:"Announcement published","ok"); }
  function clearAnnouncement() { setState(s=>({ ...s,announcement:null })); showToast("Announcement cleared","ok"); }

  return(
    <div className="card" style={{ marginBottom:12 }}>
      <div className="card-header"><span className="card-title">Advanced Controls</span></div>
      <div style={{ padding:16 }}>
        <div className="fac" style={{ gap:8,flexWrap:"wrap",marginBottom:12 }}>
          <button className="btn btn-g" onClick={restoreLatest} disabled={loading}>Restore Previous State</button>
          <button className="btn btn-g" onClick={resetSeasonPoints} disabled={loading}>New Season (Reset Points)</button>
          <label className="fac xs text-d" style={{ gap:6,padding:"0 6px" }}><input type="checkbox" checked={autoSeasonAnnouncement} onChange={e=>setAutoSeasonAnnouncement(e.target.checked)}/>Auto season announcement <span className="xs text-dd" style={{ marginLeft:2 }}>(defaults to 🔥 Hype)</span></label>
          <button className="btn btn-d" onClick={hardReset}>Hard Reset</button>
          <button className="btn btn-g" onClick={loadHistory}>Refresh Backups</button>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Time Machine</span></div>
          <div style={{ padding:14 }}>
            <select className="inp" onChange={e=>{ const id=e.target.value; const row=history.find(h=>String(h.id)===id); setSelected(row); }}><option value="">Select backup</option>{history.map(h=><option key={h.id} value={h.id}>{new Date(h.saved_at).toLocaleString()}</option>)}</select>
            <div className="fac" style={{ gap:8,marginTop:10 }}><button className="btn btn-g" disabled={!selected||loading} onClick={()=>restoreState(selected)}>Restore Selected</button></div>
            {selected?.state?._meta&&<div className="xs text-dd" style={{ marginTop:8 }}>Backup writer: {selected.state._meta.lastWriterId||"—"} · {selected.state._meta.lastWriteAt?new Date(selected.state._meta.lastWriteAt).toLocaleString("en-GB"):"—"}</div>}
          </div>
        </div>

        <div className="card" style={{ marginTop:12 }}>
          <div className="card-header"><span className="card-title">Announcement</span>
            <div className="fac" style={{ gap:6 }}>
              {state.announcement&&<span className={`tag ${isAnnouncementActive(state.announcement)?"tag-w":new Date(state.announcement.startsAt)>new Date()?"tag-b":"tag-a"}`}>{isAnnouncementActive(state.announcement)?"Active":new Date(state.announcement.startsAt)>new Date()?"Scheduled":"Expired"}</span>}
              <button className={`btn btn-sm ${annPreview?"btn-p":"btn-g"}`} onClick={()=>setAnnPreview(v=>!v)}>{annPreview?"Edit":"Preview"}</button>
            </div>
          </div>
          <div style={{ padding:14 }}>
            {annPreview?(
              <div style={{ border:"1px solid var(--b2)",borderRadius:8,padding:16,background:"var(--bg)",marginBottom:12 }}>
                <div className="xs text-dd" style={{ marginBottom:8,letterSpacing:.5,textTransform:"uppercase" }}>Preview</div>
                {(()=>{ const isSpec=annFlashy||annHype; const cls=annHype?"season-launch hype":annFlashy?"season-launch":""; return(<div className={cls} style={{ padding:isSpec?(annHype?"18px 14px 14px":"14px"):0,borderRadius:isSpec?8:0,marginBottom:8 }}>{annHype&&<div className="xs" style={{ letterSpacing:2,textTransform:"uppercase",color:"var(--gold)",opacity:.7,marginBottom:6,fontWeight:600 }}>✦ &nbsp;Announcement&nbsp; ✦</div>}<div style={{ display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:8 }}><span className={annHype?"season-title hype":annFlashy?"season-title":""} style={isSpec?{}:{ fontFamily:"var(--disp)",fontSize:18,fontWeight:700,color:"var(--amber)" }}>{annTitle||(isSpec?"New Season":"Announcement")}</span>{annSubtitle&&<span className={annHype?"season-pill hype":isSpec?"season-pill":"tag tag-a"}>{annSubtitle}</span>}</div><div className="md" dangerouslySetInnerHTML={{ __html:renderMd(annBody||"*No content yet…*") }}/></div>); })()}
              </div>
            ):(
              <div style={{ display:"grid",gap:10 }}>
                <div className="grid-2"><div><label className="lbl">Title (optional)</label><input className="inp" placeholder="e.g. Tournament Update" value={annTitle} onChange={e=>setAnnTitle(e.target.value)}/></div><div><label className="lbl">Subtitle / pill (optional)</label><input className="inp" placeholder="e.g. Season 2 live" value={annSubtitle} onChange={e=>setAnnSubtitle(e.target.value)}/></div></div>
                <div><label className="lbl">Body — Obsidian Markdown</label><textarea className="inp" rows={8} placeholder="## Heading&#10;**bold**, *italic*, ==highlight==&#10;&gt; [!tip] This is a callout" value={annBody} onChange={e=>setAnnBody(e.target.value)} style={{ fontFamily:"var(--mono)",fontSize:12,lineHeight:1.7 }}/></div>
                <div><label className="lbl">Style</label><div style={{ display:"flex",gap:6 }}>{[["standard","Standard","Plain announcement"],["flashy","✦ Flashy","Gold shimmer stripe"],["hype","🔥 Hype","Full glow + sweep"]].map(([val,label,desc])=>{ const cur=annHype?"hype":annFlashy?"flashy":"standard"; const active=cur===val; return(<div key={val} onClick={()=>{ setAnnFlashy(val==="flashy"); setAnnHype(val==="hype"); }} style={{ flex:1,padding:"8px 10px",borderRadius:8,cursor:"pointer",border:`1px solid ${active?"rgba(232,184,74,.6)":"var(--b2)"}`,background:active?"rgba(232,184,74,.08)":"var(--s2)",transition:"all .15s" }}><div style={{ fontWeight:600,fontSize:12,color:active?"var(--gold)":"var(--text)",marginBottom:2 }}>{label}</div><div className="xs text-dd" style={{ lineHeight:1.4 }}>{desc}</div></div>); })}</div></div>
                <div className="grid-2"><div><label className="lbl">Scheduled start (blank = now)</label><input className="inp" type="datetime-local" value={annScheduleStart} onChange={e=>setAnnScheduleStart(e.target.value)}/></div><div><label className="lbl">Scheduled end (blank = +24h)</label><input className="inp" type="datetime-local" value={annScheduleEnd} onChange={e=>setAnnScheduleEnd(e.target.value)}/></div></div>
              </div>
            )}
            <div className="fac" style={{ gap:8,marginTop:12,justifyContent:"space-between",flexWrap:"wrap" }}>
              <div>{state.announcement&&<div className="xs text-dd" style={{ display:"flex",alignItems:"center",gap:6 }}>{new Date(state.announcement.startsAt).toLocaleString("en-GB",{ day:"numeric",month:"short",hour:"2-digit",minute:"2-digit" })}{" → "}{new Date(state.announcement.endsAt).toLocaleString("en-GB",{ day:"numeric",month:"short",hour:"2-digit",minute:"2-digit" })}</div>}</div>
              <div className="fac" style={{ gap:8 }}><button className="btn btn-p" onClick={publishAnnouncement}>{annScheduleStart&&new Date(annScheduleStart)>new Date()?"Schedule":"Publish"}</button>{state.announcement&&<button className="btn btn-d" onClick={clearAnnouncement}>Clear</button>}</div>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop:12 }}>
          <div className="card-header"><span className="card-title">Exports</span></div>
          <div style={{ padding:14,display:"grid",gap:10 }}>
            <div className="field"><label className="lbl">Season</label><select className="inp" value={exportSeasonFilter} onChange={e=>setExportSeasonFilter(e.target.value)}><option value="current">Current season</option><option value="all">All seasons</option>{(state.seasons||[]).map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></div>
            <div className="fac" style={{ gap:8,flexWrap:"wrap" }}>
              <button className="btn btn-g" onClick={()=>exportStateJson(state)}>Export State (JSON)</button>
              <button className="btn btn-g" onClick={()=>exportPlayersCsv(state,exportSeasonFilter)}>Export Players (CSV)</button>
              <button className="btn btn-g" onClick={()=>exportGamesCsv(state,exportSeasonFilter)}>Export Games (CSV)</button>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop:12 }}>
          <div className="card-header"><span className="card-title">Audit</span></div>
          <div style={{ padding:14,display:"grid",gap:6 }}>
            <div className="xs text-dd">Last write: {lastWriteAt}</div>
            <div className="xs text-dd">Last writer: {lastWriterId}</div>
            <div className="xs text-dd">This client: {clientId}</div>
            <div className="xs text-dd">Last backup (local): {lastBackupLabel}</div>
            <div className="xs text-dd">Loaded backups: {history.length}</div>
            {state.seasonStart&&<div className="xs text-dd">Season start: {new Date(state.seasonStart).toLocaleString("en-GB")}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── SYNC TEST PANEL ────────────────────────────────────────────────────────

function SyncTestPanel({ state, setState, showToast }) {
  const [log, setLog] = useState([]); const [running, setRunning] = useState(false);
  function addLog(msg,type='info') { const time=new Date().toLocaleTimeString('en-GB',{ hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit' }); setLog(l=>[{ time,msg,type },...l].slice(0,60)); }
  async function fetchCurrentDB() { const { data }=await supabase.from('app_state').select('state').eq('id',1).single(); return data?.state; }
  async function testRoundTrip() { addLog('▶ Round-trip — save then read back','title'); setRunning(true); const sentinel='rt-'+Date.now(); setState(s=>safeTestMutation({ ...s,_syncRoundTrip:sentinel })); let found=false; for(let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,250)); const db=await fetchCurrentDB(); if(db?._syncRoundTrip===sentinel){ found=true; break; } } addLog(found?'✓ PASS: Sentinel found in DB ('+sentinel+')':'✗ FAIL: Sentinel never reached DB',found?'pass':'fail'); setState(s=>{ const{ _syncRoundTrip,...rest }=s; return safeTestMutation(rest); }); setRunning(false); }
  const colMap={ pass:'var(--green)',fail:'var(--red)',warn:'var(--orange)',title:'var(--amber)',info:'var(--dim)' };
  return(
    <div className="card">
      <div className="card-header"><span className="card-title">⚙ Sync Test Panel</span><button className="btn btn-d btn-sm" onClick={()=>setLog([])}>Clear log</button></div>
      <div style={{ padding:14 }}>
        <div className="fac" style={{ gap:6,flexWrap:'wrap',marginBottom:12 }}><button className="btn btn-g btn-sm" disabled={running} onClick={testRoundTrip}>Round-trip</button></div>
        <div style={{ background:'var(--bg)',borderRadius:8,padding:'10px 12px',maxHeight:200,overflowY:'auto',fontFamily:'monospace',fontSize:11 }}>
          {log.length===0&&<span style={{ color:'var(--dimmer)' }}>Run a test to see output…</span>}
          {log.map((e,i)=>(<div key={i} style={{ color:colMap[e.type]||'var(--dim)',lineHeight:1.8 }}><span style={{ color:'var(--dimmer)',marginRight:8 }}>{e.time}</span>{e.msg}</div>))}
          {running&&<div style={{ color:'var(--dimmer)',animation:'savingBar 1s infinite alternate' }}>⋯ running</div>}
        </div>
        <div className="xs text-dd" style={{ marginTop:8 }}>Local _v={state._v??'?'}</div>
      </div>
    </div>
  );
}

// ── ADMIN LOGIN ────────────────────────────────────────────────────────────

function AdminLogin({ onLogin }) {
  const [pw, setPw] = useState(""); const [err, setErr] = useState("");
  function go() { pw===CONFIG.ADMIN_PASSWORD?onLogin():(setErr("Incorrect password"),setPw("")); }
  return(
    <div className="login-wrap">
      <div className="login-box">
        <div className="login-title">Admin Access</div>
        <div className="field"><label className="lbl">Password</label><input className="inp" type="password" placeholder="Password…" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()}/></div>
        {err&&<div className="msg msg-e">{err}</div>}
        <button className="btn btn-p w-full mt16" onClick={go}>Login</button>
      </div>
    </div>
  );
}

// ── ROOT APP ───────────────────────────────────────────────────────────────

export default function App() {
  useEffect(()=>{
    if(!document.querySelector('link[rel="manifest"]')){ const manifest={ name:"St. Marylebone Table Tracker",short_name:"Table Tracker",start_url:"/",display:"standalone",background_color:"#0e1210",theme_color:"#0e1210",icons:[{ src:"/favicon.ico",sizes:"any",type:"image/x-icon" }] }; const blob=new Blob([JSON.stringify(manifest)],{ type:"application/json" }); const url=URL.createObjectURL(blob); const link=document.createElement("link"); link.rel="manifest"; link.href=url; document.head.appendChild(link); }
    if(!document.querySelector('meta[name="theme-color"]')){ const meta=document.createElement("meta"); meta.name="theme-color"; meta.content="#0e1210"; document.head.appendChild(meta); }
    const apple=document.createElement("meta"); apple.name="apple-mobile-web-app-capable"; apple.content="yes"; document.head.appendChild(apple);
  },[]);

  const [state, setState] = useState(SEED);
  const [isAdmin, setIsAdmin] = useState(false);
  const [tab, setTab] = useState("ranks");
  const [adminTab, setAdminTab] = useState("onboard");
  const [showLogin, setShowLogin] = useState(false);
  const [toast, setToast] = useState(null);
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [selPlayer, setSelPlayer] = useState(null);
  const [editPlayer, setEditPlayer] = useState(null);
  const [profileSeasonMode, setProfileSeasonMode] = useState("all");
  const [profileSeasonId, setProfileSeasonId] = useState("");
  const [loading, setLoading] = useState(true);
  const [rtConnected, setRtConnected] = useState(false);
  const subscriptionRef = useRef(null);
  const isRemoteUpdate = useRef(false);

  useEffect(()=>{
    async function initState() { try { const loaded=await loadState(); setState(loaded); subscribeToStateChanges(); } catch(err) { console.error("Failed to initialize:",err); } finally { setLoading(false); } }
    initState();
    return()=>{ clearTimeout(reconnectTimer.current); if(subscriptionRef.current) supabase.removeChannel(subscriptionRef.current); };
  },[]);

  const showToastRef = useRef(null);
  const [syncStatus, setSyncStatus] = useState('idle');
  const syncStatusTimer = useRef(null);
  function setSyncFor(status,ms=2500) { setSyncStatus(status); clearTimeout(syncStatusTimer.current); if(ms) syncStatusTimer.current=setTimeout(()=>setSyncStatus('idle'),ms); }

  const isInitialLoad = useRef(true);
  const stateRef = useRef(state);
  useEffect(()=>{ stateRef.current=state; },[state]);

  useEffect(()=>{
    if(loading) return;
    if(isInitialLoad.current) { isInitialLoad.current=false; return; }
    if(isRemoteUpdate.current) { isRemoteUpdate.current=false; return; }
    setSyncStatus('saving');
    const pendingSnapshot=stateRef.current;
    saveState(pendingSnapshot,(remoteState)=>{ isRemoteUpdate.current=true; setState(remoteState); setSyncFor('conflict',4000); if(showToastRef.current) showToastRef.current('Sync conflict — remote state applied','warning'); },(newV,meta)=>{ isRemoteUpdate.current=true; setState(s=>({ ...s,_v:newV,_meta:meta||s._meta })); setSyncFor('saved'); });
  },[state,loading]);

  const reconnectTimer = useRef(null);
  const wasDisconnected = useRef(false);

  function handleRemotePayload(payload) {
    const incoming=normaliseState(payload.new?.state||{}); const incomingV=incoming._v??0;
    if(_sq.echoSet.has(incomingV)) { console.log('[sync] suppressing own echo _v'+incomingV); return; }
    const localV=state._v??0;
    if(incomingV<=localV&&_sq.inflightV===null) return;
    console.log('Applying remote _v'+incomingV); isRemoteUpdate.current=true; setState(incoming);
  }

  function subscribeToStateChanges() {
    if(subscriptionRef.current) { supabase.removeChannel(subscriptionRef.current); subscriptionRef.current=null; }
    const channel=supabase.channel('app_state_v1').on('postgres_changes',{ event:'UPDATE',schema:'public',table:'app_state',filter:'id=eq.1' },handleRemotePayload).on('postgres_changes',{ event:'INSERT',schema:'public',table:'app_state',filter:'id=eq.1' },handleRemotePayload).subscribe(async(status)=>{
      console.log('Realtime:',status);
      if(status==='SUBSCRIBED'){ setRtConnected(true); clearTimeout(reconnectTimer.current); if(wasDisconnected.current){ wasDisconnected.current=false; try{ const { data }=await supabase.from('app_state').select('state').eq('id',1).single(); if(data?.state){ const fresh=normaliseState(data.state); const freshV=fresh._v??0; const localV=stateRef.current?._v??0; if(freshV>localV){ isRemoteUpdate.current=true; setState(fresh); } } }catch(e){ console.warn('[sync] catch-up failed:',e); } } }
      if(status==='CHANNEL_ERROR'||status==='CLOSED'||status==='TIMED_OUT'){ setRtConnected(false); wasDisconnected.current=true; clearTimeout(reconnectTimer.current); reconnectTimer.current=setTimeout(()=>subscribeToStateChanges(),4000); }
    });
    subscriptionRef.current=channel;
  }

  const showToast = useCallback((msg,type="success")=>{ setToast({ msg,type }); setTimeout(()=>setToast(null),4500); },[]);
  showToastRef.current=showToast;
  useEffect(()=>{ syncToast=showToast; return()=>{ syncToast=null; }; },[showToast]);

  const [annTick, setAnnTick] = useState(0);
  useEffect(()=>{ const id=setInterval(()=>setAnnTick(t=>t+1),30000); return()=>clearInterval(id); },[]);
  const activeAnnouncement=isAnnouncementActive(state.announcement)?state.announcement:null;
  useEffect(()=>{
    if(!activeAnnouncement) { setShowAnnouncement(false); return; }
    const dismissKey=`${ANN_DISMISS_PREFIX}${activeAnnouncement.id}`;
    const dismissedAt=readLocalNumber(dismissKey,0);
    if(dismissedAt) return;
    setShowAnnouncement(true);
  },[activeAnnouncement?.id,activeAnnouncement?.startsAt,activeAnnouncement?.endsAt,activeAnnouncement?.body,annTick]);

  function dismissAnnouncement() { if(!activeAnnouncement) return; writeLocalNumber(`${ANN_DISMISS_PREFIX}${activeAnnouncement.id}`,Date.now()); setShowAnnouncement(false); }

  const ADMIN_TABS=[{ id:"onboard",label:"Onboard" },{ id:"logGames",label:"Log Games" },{ id:"advanced",label:"Advanced" }];
  const [mobMenuOpen, setMobMenuOpen] = useState(false);
  function navTo(t,aTab) { setTab(t); if(aTab) setAdminTab(aTab); setMobMenuOpen(false); }

  const currentSelPlayer=selPlayer?state.players.find(p=>p.id===selPlayer.id)||selPlayer:null;
  const currentEditPlayer=editPlayer?state.players.find(p=>p.id===editPlayer.id)||editPlayer:null;

  function startNewSeason({ type="hype",title="",subtitle="Fresh leaderboard",body="",withAnnouncement=true }={}) {
    const seasonStart=new Date().toISOString();
    // Build the updated seasons list now so replayGames can key placements against it
    const prevSeasons=[...(state.seasons||[])];
    if(prevSeasons.length&&!prevSeasons[prevSeasons.length-1].endAt)
      prevSeasons[prevSeasons.length-1]={ ...prevSeasons[prevSeasons.length-1],endAt:seasonStart };
    const nextSeason={ id:`season_${Date.now()}`,label:`Season ${prevSeasons.length+1}`,startAt:seasonStart,endAt:null,createdAt:seasonStart };
    const newSeasons=[...prevSeasons,nextSeason];
    const { players,games }=replayGames(state.players,state.games,seasonStart,newSeasons);
    const monthlyPlacements=computePlacements(games,newSeasons);
    setState(s=>{
      const now=new Date().toISOString();
      const announcement=withAnnouncement?{ id:`ann_${Date.now()}`,type,title:title||`🎉 ${nextSeason.label} is live`,subtitle,body:body||`## The slate is clean.\n\nPoints reset. History preserved. May the best player rise.`,startsAt:now,endsAt:new Date(Date.now()+48*60*60*1000).toISOString(),createdBy:getClientId() }:s.announcement;
      return{ ...s,players,games,monthlyPlacements,seasonStart,nextSeasonDate:null,seasons:newSeasons,announcement };
    });
    showToast("New season started — points reset","ok");
  }

  if (loading) return(
    <div style={{ display:'flex',alignItems:'center',justifyContent:'center',minHeight:'100vh',color:'var(--dim)',fontFamily:'var(--mono)' }}>
      <div style={{ textAlign:'center' }}><div style={{ fontSize:24,marginBottom:12 }}>⚽</div><div>Loading leaderboard...</div></div>
    </div>
  );

  return(
    <>
      <style>{CSS}</style>
      <div className="app">
        {/* TOPBAR */}
        <div className="topbar" style={{ position:"sticky",top:0,zIndex:100 }}>
          <div className="brand" onClick={()=>navTo("ranks")} style={{ cursor:"pointer",userSelect:"none" }} title="Go to leaderboard">
            St. Marylebone <span className="brand-sub">Table Tracker</span>
          </div>
          <nav className="nav">
            {TABS.map(t=>(<button key={t} className={`nav-btn ${tab===t?"active":""}`} onClick={()=>navTo(t)}>{TAB_LABELS[t]}{t==="play"&&Object.values(state.finals?.[getMonthKey()]?.liveScores||{}).some(v=>v?.active)&&(<span style={{ display:"inline-block",width:6,height:6,borderRadius:"50%",background:"var(--red)",marginLeft:5,verticalAlign:"middle",animation:"livePulse 1.4s infinite" }}/>)}</button>))}
            {isAdmin&&ADMIN_TABS.map(t=>(<button key={t.id} className={`nav-btn ${tab==="admin"&&adminTab===t.id?"active":""}`} onClick={()=>navTo("admin",t.id)}>{t.label}</button>))}
          </nav>
          <div className="fac" style={{ gap:8 }}>
            <div className="fac" style={{ gap:5 }} title={rtConnected?"Live — connected to database":"Connecting…"}><span className={`rt-dot ${rtConnected?"live":""}`}></span><span className="xs text-dd" style={{ whiteSpace:"nowrap" }}>{rtConnected?"Live":"…"}</span></div>
            {isAdmin?(<><span className="admin-badge">Admin</span><button className="btn btn-g btn-sm" onClick={()=>{ setIsAdmin(false); navTo("ranks"); }}>Logout</button></>):(<button className="btn btn-g btn-sm" onClick={()=>setShowLogin(true)}>Admin</button>)}
            <button className={`ham-btn ${mobMenuOpen?"open":""}`} onClick={()=>setMobMenuOpen(o=>!o)} aria-label="Menu"><span/><span/><span/></button>
          </div>
        </div>

        {isAdmin&&syncStatus!=='idle'&&(
          <div style={{ position:'fixed',top:52,left:0,right:0,zIndex:98,height:3,background:syncStatus==='saving'?'var(--amber-d)':syncStatus==='saved'?'var(--green)':syncStatus==='conflict'?'var(--orange)':'var(--red)',animation:syncStatus==='saving'?'savingBar 1.2s ease-in-out infinite alternate':'none',transition:'background .3s' }}/>
        )}

        <div className={`mob-nav ${mobMenuOpen?"open":""}`}>
          {TABS.map(t=>(<button key={t} className={`nav-btn ${tab===t?"active":""}`} onClick={()=>navTo(t)}>{TAB_LABELS[t]}</button>))}
          {isAdmin&&ADMIN_TABS.map(t=>(<button key={t.id} className={`nav-btn ${tab==="admin"&&adminTab===t.id?"active":""}`} onClick={()=>navTo("admin",t.id)}>{t.label}</button>))}
        </div>

        {/* MAIN */}
        <div className="main">
          {tab==="ranks"&&(<LeaderboardView state={state} setState={setState} rtConnected={rtConnected} isAdmin={isAdmin} showToast={showToast} syncStatus={syncStatus} onNavToPlay={()=>navTo("play")} onNavToHistory={()=>navTo("history")} onSelectPlayer={p=>{ setSelPlayer(p); setEditPlayer(null); const cur=getCurrentSeason(state); setProfileSeasonId(cur?.id||""); }}/>)}
          {tab==="history"&&(<HistoryView state={state} setState={setState} isAdmin={isAdmin} showToast={showToast}/>)}
          {tab==="stats"&&(<StatsView state={state} onSelectPlayer={p=>{ setSelPlayer(p); setEditPlayer(null); const cur=getCurrentSeason(state); setProfileSeasonId(cur?.id||""); }}/>)}
          {tab==="seasons"&&(<SeasonsArchiveView state={state} setState={setState} isAdmin={isAdmin} showToast={showToast} onNavToHistory={()=>setTab("history")} onNavToStats={()=>setTab("stats")} onStartNewSeason={startNewSeason}/>)}
          {tab==="play"&&(<FinalsView state={state} setState={setState} isAdmin={isAdmin} showToast={showToast}/>)}
          {tab==="rules"&&(<RulesView state={state} setState={setState} isAdmin={isAdmin} showToast={showToast}/>)}
          {tab==="admin"&&!isAdmin&&(<AdminLogin onLogin={()=>setIsAdmin(true)}/>)}
          {tab==="admin"&&isAdmin&&(()=>{
            switch(adminTab){
              case"onboard": return<div className="stack"><OnboardView state={state} setState={setState} showToast={showToast}/></div>;
              case"logGames": return<LogView state={state} setState={setState} showToast={showToast}/>;
              case"advanced": return<><AdvancedPanel state={state} setState={setState} showToast={showToast} onStartNewSeason={startNewSeason}/><SyncTestPanel state={state} setState={setState} showToast={showToast}/></>;
              default: return<div className="card" style={{ padding:24 }}><div className="text-d">Admin page not found</div></div>;
            }
          })()}
        </div>

        {/* MODALS */}
        {showLogin&&!isAdmin&&(<div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowLogin(false)}><div className="modal"><AdminLogin onLogin={()=>{ setIsAdmin(true); setShowLogin(false); setTab("admin"); setAdminTab("onboard"); }}/></div></div>)}
        {currentSelPlayer&&!editPlayer&&(<PlayerProfile player={currentSelPlayer} state={state} onClose={()=>setSelPlayer(null)} isAdmin={isAdmin} onEdit={()=>{ setEditPlayer(currentSelPlayer); setSelPlayer(null); }} seasonMode={profileSeasonMode} onSeasonModeChange={setProfileSeasonMode} selectedSeasonId={profileSeasonId||getCurrentSeason(state)?.id||""} onSelectedSeasonIdChange={setProfileSeasonId}/>)}
        {currentEditPlayer&&(<EditPlayerModal player={currentEditPlayer} state={state} setState={setState} showToast={showToast} onClose={()=>setEditPlayer(null)}/>)}
        {showAnnouncement&&activeAnnouncement&&(<AnnouncementModal announcement={activeAnnouncement} onClose={dismissAnnouncement}/>)}
        <Toast t={toast}/>
      </div>
    </>
  );
}
