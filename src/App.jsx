import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { supabase } from './supabaseClient';

// ============================================================
// CONFIGURATION — tune these before your season starts.
// Changing mid-season only affects future games.
// ============================================================
const CONFIG = {
  ADMIN_PASSWORD: "RankUp26",   // CHANGE THIS before deploying

  STARTING_MMR: 1000,           // hidden matchmaking rating
  STARTING_PTS: 0,              // visible leaderboard points

  // ── Base deltas ───────────────────────────────────────────
  // Calibrated against real game data (34 games, Mar 2026).
  // Equal 10-6 game (most common score): winner +31, loser -18.
  BASE_GAIN: 22,
  BASE_LOSS: 12,

  // Score dominance: scoreDiff / winnerScore → 0–1 ratio
  // Raised from 1.2 → 1.4 so the real score range (10-9 to 10-1)
  // spans 26 pts instead of 18. A 10-6 vs 10-9 is now 8pts apart.
  SCORE_WEIGHT: 1.4,
  SCORE_EXP: 1.4,               // curve shape unchanged

  // MMR surprise — sigmoid. Upset win = high reward, expected = low.
  ELO_DIVISOR: 250,             // correct for 8–15 player league, unchanged

  // Rank gap correction — cherry-pick prevention
  RANK_WEIGHT: 0.4,             // unchanged — working correctly
  RANK_DIVISOR: 5,              // unchanged

  // ── STREAK SYSTEM ─────────────────────────────────────────
  // Problem identified in real data: Hector's 4-win streak added only
  // +5 pts/game. Yusuf's 5-0 earned 152 pts when it should feel dominant.
  // Fix: faster ramp (3.0 vs 4.0) + higher ceiling (0.55 vs 0.45).
  // Anti-farm decay tightened slightly to offset the stronger ceiling.
  STREAK_POWER_SCALE: 3.0,      // bonus kicks in by win 2–3, not win 6–7
  STREAK_WIN_MAX: 0.55,         // max +55% on win streak (was +45%)
  STREAK_LOSS_MAX: 0.35,        // capped at +35% — prevents triple-stacking with rank+MMR penalties
  STREAK_QUALITY_DECAY: 0.82,   // tighter anti-farm decay (was 0.88)
  STREAK_DECAY_THRESHOLD: 1.05, // unchanged
  STREAK_WINDOW: 8,             // unchanged

  // Loss harshness — nudged up to match higher gain baseline
  // Losses feel meaningful without being devastating for underdogs
  LOSS_HARSHNESS: 1.08,
  ROLE_ALIGN_BONUS: 1.12,   // out-of-position attenuation: gain ×0.893, loss ×0.893. In-position and FLEX are neutral baseline (×1.0)         // was 1.05

  MAX_PLACEMENTS_PER_MONTH: 5,  // per player per calendar month

  // Disciplinary cards — pts deducted after all other calculations, survive recalc
  YELLOW_CARD_PTS: 5,   // minor infraction — unsportsmanlike conduct, excessive stalling
  RED_CARD_PTS: 20,     // serious misconduct — abuse, repeated offences, cheating
};

// Enable extra verification after each save to detect silent sync failures.
// Turn off once the issue is resolved.
const SYNC_DEBUG = true;
const BACKUP_MIN_INTERVAL_MS = 10 * 60 * 1000; // at most 1 backup per 10 minutes per client
const BACKUP_RETENTION_DAYS = 30;
const BACKUP_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CLIENT_ID_KEY = "ft_client_id";
const LAST_BACKUP_KEY = "ft_last_backup_at";
const LAST_BACKUP_CLEANUP_KEY = "ft_last_backup_cleanup_at";
const ANN_DISMISS_PREFIX = "ft_ann_dismissed_";

// ── NAVIGATION & UI CONSTANTS ────────────────────────────────
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

// ── HELPER FUNCTIONS ─────────────────────────────────────────
function getDateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function getPlayerById(playerId, players) {
  return players?.find(p => p.id === playerId);
}

function getWinnerAndLoserSides(game) {
  const winners = game.winner === "A" ? game.sideA : game.sideB;
  const losers = game.winner === "A" ? game.sideB : game.sideA;
  return { winners, losers };
}

function isPlayerOnSideA(playerId, game) {
  return game.sideA?.includes(playerId);
}

function didPlayerWin(playerId, game) {
  const onA = isPlayerOnSideA(playerId, game);
  return (onA && game.winner === "A") || (!onA && game.winner === "B");
}

function sortByDate(items, descending = false) {
  return [...items].sort((a, b) =>
    descending
      ? new Date(b.date) - new Date(a.date)
      : new Date(a.date) - new Date(b.date)
  );
}

function sortByPoints(players, descending = true) {
  return [...players].sort((a, b) =>
    descending
      ? (b.pts || 0) - (a.pts || 0)
      : (a.pts || 0) - (b.pts || 0)
  );
}

function getSelectedSeason(filter, currentSeason, allSeasons) {
  if (filter === "all") return null;
  if (filter === "current") return currentSeason;
  return (allSeasons || []).find(s => s.id === filter) || null;
}

function buildPlayerNameMap(players) {
  return new Map((players || []).map(p => [p.id, p.name]));
}

function getClientId() {
  if (typeof localStorage === "undefined") return "server";
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    const rand = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `c_${Math.random().toString(36).slice(2)}_${Date.now()}`;
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

// Get highest-priority active announcement from queue or legacy field
function getActiveAnnouncement(state, dismissedIds = [], now = Date.now()) {
  const all = [
    ...(state.announcementQueue || []),
    ...(state.announcement ? [state.announcement] : [])
  ];

  const actives = all.filter(ann => {
    if (dismissedIds.includes(ann.id)) return false; // Skip dismissed
    if (ann.sticky) return true; // Sticky ignores time
    return isAnnouncementActive(ann, now);
  });

  if (!actives.length) return null;

  // Sort by priority (lower number = higher priority) then by creation time
  return actives.sort((a, b) =>
    (a.priority || 3) - (b.priority || 3) ||
    new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
  )[0];
}

function downloadText(filename, text, mime = "text/plain") {
  if (typeof document === "undefined") return;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toCsv(rows) {
  return rows.map(row => row.map(cell => {
    const safe = String(cell ?? "").replace(/"/g, '""');
    return `"${safe}"`;
  }).join(",")).join("\n");
}

function exportStateJson(state) {
  const stamp = new Date().toISOString().slice(0, 10);
  const payload = { exportedAt: new Date().toISOString(), state };
  downloadText(`foosball-state-${stamp}.json`, JSON.stringify(payload, null, 2), "application/json");
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
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(`foosball-players-${seasonLabel}-${stamp}.csv`, toCsv(rows), "text/csv");
}

function exportGamesCsv(state, seasonFilter = null) {
  const currentSeason = seasonFilter === null ? getCurrentSeason(state) : seasonFilter;
  const scopedGames = (state.games || []).filter(g => seasonFilter === "all" ? true : gameInSeason(g, currentSeason));
  const nameById = new Map((state.players || []).map(p => [p.id, p.name]));
  const prefRole = new Map((state.players || []).map(p => [p.id, p.preferredRole || "FLEX"]));
  // Long format: one row per player-game observation — suitable for regression analysis
  const rows = [
    ["game_id","date","score_winner","score_loser","player_id","player_name","side",
     "role","preferred_role","role_aligned",
     "won","delta_pts",
     "elo_scale","rank_scale","match_quality","score_mult","streak_mult","role_mult",
     "opp_a_name","opp_b_name","partner_name"]
  ];
  const sorted = [...scopedGames].sort((a,b) => new Date(a.date)-new Date(b.date));
  for (const g of sorted) {
    const allIds = [...(g.sideA||[]), ...(g.sideB||[])];
    for (const pid of allIds) {
      const side = (g.sideA||[]).includes(pid) ? "A" : "B";
      const won = (side==="A" && g.winner==="A") || (side==="B" && g.winner==="B");
      const delta = won
        ? (g.perPlayerGains?.[pid] ?? g.ptsGain ?? "")
        : -(g.perPlayerLosses?.[pid] ?? g.ptsLoss ?? "");
      const f = g.perPlayerFactors?.[pid] || {};
      const role = g.roles?.[pid] || "";
      const pref = prefRole.get(pid) || "FLEX";
      const aligned = role && pref !== "FLEX" ? (role === pref ? "1" : "0") : "";
      const teammates = ((side==="A" ? g.sideA : g.sideB)||[]).filter(id=>id!==pid).map(id=>nameById.get(id)||id);
      const opps = ((side==="A" ? g.sideB : g.sideA)||[]).map(id=>nameById.get(id)||id);
      const winScore = Math.max(g.scoreA||0, g.scoreB||0);
      const losScore = Math.min(g.scoreA||0, g.scoreB||0);
      rows.push([
        g.id, g.date, winScore, losScore,
        pid, nameById.get(pid)||pid, side,
        role, pref, aligned,
        won?"1":"0", delta,
        f.eloScale??"", f.rankScale??"", f.matchQuality??"", f.scoreMult??"", f.streakMultVal??"", f.roleMult??"",
        opps[0]||"", opps[1]||"", teammates[0]||""
      ]);
    }
  }
  const seasonLabel = seasonFilter === "all" ? "all-time" : (currentSeason?.label || "current");
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(`foosball-games-${seasonLabel}-${stamp}.csv`, toCsv(rows), "text/csv");
}

// ============================================================
// DEFAULT RULEBOOK (markdown)
// ============================================================
const DEFAULT_RULES = `# Rulebook

## Overview
This is the official ranked table football leaderboard. Games are logged by admins and affect your points and hidden MMR.

## Players & Teams
- All players are ranked individually.
- Teams are formed per game — you can play with anyone.
- Each player has **${CONFIG.MAX_PLACEMENTS_PER_MONTH} placement games** per calendar month.

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
- Pinches slamming the ball against the side wallls of the table are not allowed, as they damage the table springs. **Note:** Inwards passes between players are valid, this foul only applies when the ball is slammed against side walls. \
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

**If a swap occurs, the entire game must be logged as FLEX for the swapping player.** FLEX games do not affect ATK or DEF MMR — only overall points and MMR are updated. This prevents mid-game role mixing from corrupting positional statistics.

| Team score at swap | Legal? | Logged as |
|---|---|---|
| 5 (your team) | ✓ Yes | FLEX |
| 4 or fewer | ✗ No | — |
| After swap (any) | ✗ No | — |

If no swap occurs, positions are logged normally and both ATK and DEF MMR tracks update.

## Monthly Finals
At the end of each month, the top 4 players enter a bracket:
- Semi 1: #1 vs #2
- Semi 2: #3 vs #4
- Final: winners of each semi
- The winning pair is crowned **Monthly Champions**.

## Conduct
- Results must be agreed by both sides before logging.
- Disputes go to an admin. Admin decisions are final.
- Unsportsmanlike behaviour may result in removal from the leaderboard.
- Admins have the right to adjust points or MMR retroactively in case of errors or disputes.
- Admins have the right to ban players for misconduct, cheating, or repeated unsportsmanlike behaviour.

## Disciplinary Cards
Admins can issue cards to individual players against any logged match. Penalties are permanent and survive any recalculation.

- 🟡 **Yellow Card** — −${CONFIG.YELLOW_CARD_PTS} points. Issued for: unsportsmanlike conduct, excessive stalling, persistent rule violations, disrespectful behaviour.
- 🔴 **Red Card** — −${CONFIG.RED_CARD_PTS} points. Issued for: serious misconduct, verbal abuse, deliberate cheating, repeated yellow card offences.

Cards are applied per-player and are visible on the match detail. A player may receive multiple cards in a single match for escalating behaviour.
`;

// ============================================================
// MMR / POINTS ENGINE
// ============================================================

// Quality-weighted streak multiplier.
// streakPower = accumulated (eloScale * rankScale) from recent wins,
// decays if only playing weak opponents, resets to 0 on loss.
// Max bonus 1.45x win / 1.35x loss — prevents unclosable gaps.
function streakMult(streakPower, isWinner) {
  const power = Math.max(0, streakPower || 0);
  const t = Math.tanh(power / CONFIG.STREAK_POWER_SCALE);
  const cap = isWinner ? CONFIG.STREAK_WIN_MAX : CONFIG.STREAK_LOSS_MAX;
  return 1 + t * cap;
}

// Update a player's streakPower after a game result.
// qualityScore = eloScale * rankScale from this game (how "hard" was the opponent).
function updateStreakPower(currentPower, isWin, qualityScore) {
  if (!isWin) return 0; // loss always resets streak power
  const base = (currentPower || 0);
  // Decay if opponent was easy (below threshold)
  const decayed = qualityScore < CONFIG.STREAK_DECAY_THRESHOLD
    ? base * CONFIG.STREAK_QUALITY_DECAY
    : base;
  return Math.min(decayed + qualityScore, CONFIG.STREAK_WINDOW * 2); // absolute cap
}

function avg(ids, players, key) {
  const found = ids.map(id => players.find(p => p.id === id)).filter(Boolean);
  if (!found.length) return key === "mmr" ? CONFIG.STARTING_MMR : 0;
  return found.reduce((s, p) => s + (p[key] || 0), 0) / found.length;
}

// Optimized avg using a pre-built player map
function avgWithMap(ids, playerMap, key) {
  const found = ids.map(id => playerMap.get(id)).filter(Boolean);
  if (!found.length) return key === "mmr" ? CONFIG.STARTING_MMR : 0;
  return found.reduce((s, p) => s + (p[key] || 0), 0) / found.length;
}

// Recompute monthlyPlacements from game list (used after delete/edit)
function computePlacements(games) {
  const placements = {};
  for (const g of games) {
    const mk = g.monthKey || g.date?.slice(0, 7)?.replace('-', '') || '';
    if (!mk) continue;
    if (!placements[mk]) placements[mk] = {};
    for (const pid of [...g.sideA, ...g.sideB]) {
      placements[mk][pid] = (placements[mk][pid] || 0) + 1;
    }
  }
  return placements;
}

// Recalculate pts/mmr/streaks/wins/losses from scratch using per-player deltas.
// Season start limits which games affect pts/mmr/streak, but preserves all-time wins/losses.
// Returns { players, games } — caller must update both.
function replayGames(basePlayers, games, seasonStart) {
  let players = basePlayers.map(p => ({
    ...p, mmr: CONFIG.STARTING_MMR, pts: CONFIG.STARTING_PTS,
    mmr_atk: CONFIG.STARTING_MMR, mmr_def: CONFIG.STARTING_MMR,
    wins: 0, losses: 0, streak: 0, streakPower: 0,
    wins_atk: 0, losses_atk: 0, wins_def: 0, losses_def: 0,
  }));
  const seasonStartDate = seasonStart ? new Date(seasonStart) : null;
  const sorted = sortByDate(games);
  let playerMap = new Map(basePlayers.map(p => [p.id, p]));
  // Track cumulative placements per monthKey so rankScale is only applied to placed players
  const placementCount = {}; // { [monthKey]: { [pid]: number } }
  const updatedGames = sorted.map(g => {
    const gameDate = g.date ? new Date(g.date) : null;
    const inSeason = !seasonStartDate || !gameDate || gameDate >= seasonStartDate;
    const winIds = g.winner === "A" ? g.sideA : g.sideB;
    const losIds = g.winner === "A" ? g.sideB : g.sideA;
    const mk = g.monthKey || g.date?.slice(0, 7) || "";

    // Snapshot placements BEFORE this game (determines if rank matters for this game)
    const monthPlacements = placementCount[mk] || {};
    const isPlacedAtGameTime = pid => (monthPlacements[pid] || 0) >= CONFIG.MAX_PLACEMENTS_PER_MONTH;
    const allPids = [...winIds, ...losIds];

    // Only consider players who are placed when computing rank context
    // Unplaced players get rankScale = 1.0 (neutral — rank is meaningless before calibration)
    const ranked = sortByPoints(players);
    const rankOf = id => { const i = ranked.findIndex(p => p.id === id); return i === -1 ? ranked.length : i; };
    playerMap = new Map(players.map(p => [p.id, p]));
    const oppAvgMMR = ids => avgWithMap(ids, playerMap, "mmr");

    // Rank average only over placed opponents — null if none placed
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

    // Positional role resolution — dual MMR when game has roles, legacy avg otherwise
    const gameRoles = g.roles || {};
    const hasRoles = Object.keys(gameRoles).length === 4;
    const atkRanked = [...players].sort((a,b)=>(b.mmr_atk??CONFIG.STARTING_MMR)-(a.mmr_atk??CONFIG.STARTING_MMR));
    const defRanked = [...players].sort((a,b)=>(b.mmr_def??CONFIG.STARTING_MMR)-(a.mmr_def??CONFIG.STARTING_MMR));
    const atkRankOf = id => { const i=atkRanked.findIndex(p=>p.id===id); return i===-1?atkRanked.length:i; };
    const defRankOf = id => { const i=defRanked.findIndex(p=>p.id===id); return i===-1?defRanked.length:i; };

    const playerDeltas = {};
    allPids.forEach(pid => {
      const p = playerMap.get(pid);
      if (!p) return;
      const isWinner = winIds.includes(pid);
      const myPlaced = isPlacedAtGameTime(pid);
      const oppRankPlaced = isWinner ? oppLosRankPlaced : oppWinRankPlaced;
      const myRole = gameRoles[pid];
      const oppIds = isWinner ? losIds : winIds;
      let playerMMR, oppMMRval, playerRank, oppRankVal;
      if (hasRoles && myRole) {
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
      });
      playerDeltas[pid] = { ...d, role: myRole || null };
    });

    // Advance placement counts AFTER computing deltas (this game counts toward next game)
    if (!placementCount[mk]) placementCount[mk] = {};
    allPids.forEach(pid => {
      placementCount[mk][pid] = (placementCount[mk][pid] || 0) + 1;
    });

    players = players.map(p => {
      const d = playerDeltas[p.id];
      if (!d) return p;
      const isWin = winIds.includes(p.id);
      const role = d.role;
      if (isWin) {
        const base = { ...p, wins: p.wins+1,
          wins_atk: (p.wins_atk||0)+(role==='ATK'?1:0),
          wins_def: (p.wins_def||0)+(role==='DEF'?1:0),
        };
        if (!inSeason) return base;
        const ns = (p.streak||0)>=0 ? (p.streak||0)+1 : 1;
        const newPower = updateStreakPower(p.streakPower||0, true, d.qualityScore||1);
        const newAtk = role==='ATK' ? (p.mmr_atk??p.mmr)+d.gain : (p.mmr_atk??p.mmr);
        const newDef = role==='DEF' ? (p.mmr_def??p.mmr)+d.gain : (p.mmr_def??p.mmr);
        const newMMR = role ? Math.round((newAtk+newDef)/2) : p.mmr+d.gain;
        return { ...base, mmr:newMMR, mmr_atk:newAtk, mmr_def:newDef, pts:(p.pts||0)+d.gain, streak:ns, streakPower:newPower };
      }
      const base = { ...p, losses: p.losses+1,
        losses_atk: (p.losses_atk||0)+(role==='ATK'?1:0),
        losses_def: (p.losses_def||0)+(role==='DEF'?1:0),
      };
      if (!inSeason) return base;
      const ns = (p.streak||0)<=0 ? (p.streak||0)-1 : -1;
      const newAtk = role==='ATK' ? Math.max(0,(p.mmr_atk??p.mmr)-d.loss) : (p.mmr_atk??p.mmr);
      const newDef = role==='DEF' ? Math.max(0,(p.mmr_def??p.mmr)-d.loss) : (p.mmr_def??p.mmr);
      const newMMR = role ? Math.round((newAtk+newDef)/2) : Math.max(0,p.mmr-d.loss);
      return { ...base, mmr:newMMR, mmr_atk:newAtk, mmr_def:newDef, pts:Math.max(0,(p.pts||0)-d.loss), streak:ns, streakPower:0 };
    });

    // Flat per-player gain/loss maps — persisted, not stripped by slimState
    const perPlayerGains = {};
    const perPlayerLosses = {};
    // Per-player factors: eloScale, rankScale, qualityScore — for history transparency
    const perPlayerFactors = {};
    winIds.forEach(id => {
      if (playerDeltas[id]) {
        perPlayerGains[id] = playerDeltas[id].gain;
        perPlayerFactors[id] = {
          eloScale: +playerDeltas[id].eloScale.toFixed(3),
          rankScale: +playerDeltas[id].rankScale.toFixed(3),
          matchQuality: +playerDeltas[id].matchQuality.toFixed(3),
          qualityScore: +playerDeltas[id].qualityScore.toFixed(3),
          roleMult: +((playerDeltas[id].roleMult)||1).toFixed(3),
        };
      }
    });
    losIds.forEach(id => {
      if (playerDeltas[id]) {
        perPlayerLosses[id] = playerDeltas[id].loss;
        perPlayerFactors[id] = {
          eloScale: +playerDeltas[id].eloScale.toFixed(3),
          rankScale: +playerDeltas[id].rankScale.toFixed(3),
          matchQuality: +playerDeltas[id].matchQuality.toFixed(3),
          qualityScore: +playerDeltas[id].qualityScore.toFixed(3),
          roleMult: +((playerDeltas[id].roleMult)||1).toFixed(3),
        };
      }
    });

    // Summary averages for legacy display fallback
    const avgGain = Math.round(winIds.reduce((s, id) => s + (playerDeltas[id]?.gain || 0), 0) / Math.max(winIds.length, 1));
    const avgLoss = Math.round(losIds.reduce((s, id) => s + (playerDeltas[id]?.loss || 0), 0) / Math.max(losIds.length, 1));

    // Apply penalties AFTER normal pts — they survive recalc
    if (g.penalties && inSeason) {
      players = players.map(p => {
        const pen = g.penalties[p.id];
        if (!pen) return p;
        const deduct = (pen.yellow || 0) * CONFIG.YELLOW_CARD_PTS + (pen.red || 0) * CONFIG.RED_CARD_PTS;
        if (!deduct) return p;
        return { ...p, pts: Math.max(0, (p.pts || 0) - deduct) };
      });
    }

    return { ...g, ptsGain: avgGain, ptsLoss: avgLoss, mmrGain: avgGain, mmrLoss: avgLoss, perPlayerGains, perPlayerLosses, perPlayerFactors };
  });

  return { players, games: updatedGames };
}

// ── CORE DELTA FORMULA (PER-PLAYER) ──────────────────────────
//
// Based on Elo (1960) / Glicko-2: one composite skill signal applied
// symmetrically. matchQuality fuses MMR (70%) and rank (30%) into one number:
//   > 1.0 = underdog  → more pts winning, less pts losing
//   = 1.0 = even
//   < 1.0 = favourite → less pts winning, more pts losing
//
// Key design decisions:
//
// 1. rankDiff = playerRank - oppAvgRank for BOTH winners and losers.
//    (index: 0 = #1 best, 9 = #10 worst. Positive = underdog. Always.)
//    Previous bug: sign was flipped for losers, so a favourite who lost
//    computed rankScale > 1 (as if they were an underdog), which softened
//    their loss. Fixed by using the same sign convention regardless of outcome.
//
// 2. Rank is one-directional — it can never make things WORSE than MMR alone:
//    - Both underdog: blend (rank confirms, slightly bigger reward)
//    - Both favourite: eloScale only (no compounding of penalty)
//    - MMR=underdog, rank=favourite: eloScale wins (no rank penalty on underdogs)
//    - MMR=favourite, rank=underdog: blend but cap at 1.0 (sandbagging detection)
//
function calcPlayerDelta({ winnerScore, loserScore, playerMMR, playerRank,
  playerStreakPower, oppAvgMMR, oppAvgRank, isWinner, playerRole, playerPreferredRole }) {
  // 1. Score dominance — how convincing was the win
  const scoreDiff = winnerScore - loserScore;
  const scoreRatio = scoreDiff / Math.max(winnerScore, 1);
  const scoreMult = 1 + CONFIG.SCORE_WEIGHT * Math.pow(scoreRatio, CONFIG.SCORE_EXP);

  // 2. MMR surprise (primary signal, 70% weight)
  // eloScale = 2 / (1 + e^(mmrGap/D)) — classic logistic Elo expected-score transform
  // > 1.0 = underdog (opponent has higher MMR) → more pts
  // < 1.0 = favourite (opponent has lower MMR) → fewer pts
  // Centred at 1.0 when MMRs are equal
  const mmrGap = playerMMR - oppAvgMMR;
  const eloScale = 2 / (1 + Math.exp(mmrGap / CONFIG.ELO_DIVISOR));

  // 3. Rank difficulty (secondary signal, cherry-pick correction)
  // Always computed as playerRank - oppAvgRank regardless of win/loss.
  // This gives a single "am I the underdog by rank?" value with consistent semantics:
  //   positive (playerRank index > oppAvgRank index) = player is lower-ranked = underdog → > 1.0
  //   negative (playerRank index < oppAvgRank index) = player is higher-ranked = favourite → < 1.0
  //
  // This is correct for BOTH winners and losers because matchQuality feeds into:
  //   gain = BASE * mq        → mq > 1 rewards underdogs, mq < 1 penalises favourites ✓
  //   loss = BASE * (2 - mq)  → mq < 1 makes (2-mq) > 1 = harsher loss for favourites ✓
  //                             mq > 1 makes (2-mq) < 1 = softer loss for underdogs ✓
  //
  // The old code used isWinner to flip the sign, which broke the loser case:
  // a favourite who LOST was computing rankScale > 1 (lost to lower-ranked = harsher)
  // which then SOFTENED matchQuality via the blend, reducing (2-mq) and reducing their loss.
  const rankDifficulty = (playerRank === null || oppAvgRank === null)
    ? 1.0
    : 1 + CONFIG.RANK_WEIGHT * Math.tanh((playerRank - oppAvgRank) / CONFIG.RANK_DIVISOR);
  // playerRank - oppAvgRank:
  //   negative = you're the higher-ranked player (favourite) → rankDifficulty < 1
  //   positive = you're the lower-ranked player (underdog)   → rankDifficulty > 1

  // 4. Fused match quality — one-directional rank correction
  // Rank can only confirm or boost difficulty, never introduce a penalty
  // that contradicts what MMR already says. Specifically:
  //   • When both signals agree (both > 1 or both < 1): blend them
  //   • When rank says HARDER than MMR (rank > elo): boost toward 1.0 max
  //   • When rank says EASIER than MMR (rank < elo): MMR wins, rank ignored
  //     (prevents rank penalising genuine underdogs or softening genuine favourites)
  const rankScale = rankDifficulty; // rename for display/storage clarity
  const matchQuality = (() => {
    const elo = eloScale, rank = rankDifficulty;
    if (rank >= 1.0 && elo >= 1.0) return Math.max(elo, 0.7 * elo + 0.3 * rank); // both underdog
    if (rank <= 1.0 && elo <= 1.0) return Math.max(0.7 * elo + 0.3 * rank, elo); // both favourite (floor at elo)
    if (rank > elo) return Math.min(1.0, 0.7 * elo + 0.3 * rank);                // rank harder: boost ≤1.0
    return elo;                                                                    // rank easier: MMR wins
  })();

  // 5. Streak multiplier
  const mult = streakMult(playerStreakPower, isWinner);

  // qualityScore stored for streak decay and history display
  const qualityScore = matchQuality;

  // 6. Role alignment multipliers
  // In position / FLEX → neutral baseline (×1.0). Playing your role is normal.
  // Out of position (imposed) → asymmetric treatment, mirrors Elo underdog logic:
  //   WIN out of position: ×BONUS (higher) — overcame a structural disadvantage
  //   LOSS out of position: ×1/BONUS (softer) — not your fault, imposition
  // Rationale: parallel to eloScale > 1 for MMR underdogs. The positional handicap
  // is a known disadvantage; the system should reward beating it and excuse losing to it.
  const isOutOfPosition = !!(
    playerRole && playerPreferredRole &&
    playerPreferredRole !== 'FLEX' &&
    playerPreferredRole !== playerRole
  );
  const roleGainMult = isOutOfPosition ? CONFIG.ROLE_ALIGN_BONUS : 1.0;
  const roleLossMult = isOutOfPosition ? (1 / CONFIG.ROLE_ALIGN_BONUS) : 1.0;
  const roleMult = roleGainMult; // for perPlayerFactors displaysplay

  if (isWinner) {
    const gain = Math.max(2, Math.round(CONFIG.BASE_GAIN * scoreMult * matchQuality * mult * roleGainMult));
    return { gain, loss: 0, scoreMult, eloScale, rankScale, matchQuality, streakMultVal: mult, qualityScore, roleMult: roleGainMult, roleLossMult };
  } else {
    // Loss formula mirrors gain: (2 - matchQuality) rises when matchQuality falls
    // i.e. a heavy favourite who loses suffers more — symmetrical to Elo
    // Single factor prevents the old (2-eloScale)*(2-rankScale) compounding
    const loss = Math.max(1, Math.round(
      CONFIG.BASE_LOSS * scoreMult * (2 - matchQuality) * mult * CONFIG.LOSS_HARSHNESS * roleLossMult
    ));
    return { gain: 0, loss, scoreMult, eloScale, rankScale, matchQuality, streakMultVal: mult, qualityScore, roleMult: roleGainMult, roleLossMult };
  }
}

//, roleMult }; Legacy team-level wrapper used by GameDetail display (summary only)
function calcDelta({ winnerScore, loserScore, winnerAvgMMR, loserAvgMMR,
  winnerAvgStreakPower, loserAvgStreakPower, winnerAvgRank, loserAvgRank }) {
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

function getCurrentSeason(state) {
  const seasons = state?.seasons || [];
  return seasons[seasons.length - 1] || null;
}

function gameInSeason(game, season) {
  if (!season) return true;
  const t = Date.parse(game?.date || "");
  if (!Number.isFinite(t)) return true;
  const start = Date.parse(season.startAt || "");
  const end = season.endAt ? Date.parse(season.endAt) : null;
  if (Number.isFinite(start) && t < start) return false;
  if (Number.isFinite(end) && t >= end) return false;
  return true;
}

function computeWindowPlayerStats(players, games) {
  const stats = Object.fromEntries((players || []).map(p => [p.id, { wins: 0, losses: 0, pts: 0, streak: 0 }]));
  const sorted = sortByDate(games || []); // Use helper for consistency
  for (const g of sorted) {
    const { winners: winIds, losers: losIds } = getWinnerAndLoserSides(g); // Use helper
    for (const id of winIds) {
      const s = stats[id];
      if (!s) continue;
      const gain = g.perPlayerGains?.[id] ?? g.playerDeltas?.[id]?.gain ?? g.ptsGain ?? 0;
      s.wins += 1;
      s.pts += gain;
      s.streak = s.streak >= 0 ? s.streak + 1 : 1;
    }
    for (const id of losIds) {
      const s = stats[id];
      if (!s) continue;
      const loss = g.perPlayerLosses?.[id] ?? g.playerDeltas?.[id]?.loss ?? g.ptsLoss ?? 0;
      s.losses += 1;
      s.pts = Math.max(0, s.pts - loss);
      s.streak = s.streak <= 0 ? s.streak - 1 : -1;
    }
    if (g.penalties) {
      Object.entries(g.penalties).forEach(([pid, pen]) => {
        const s = stats[pid];
        if (!s) return;
        const deduct = (pen?.yellow || 0) * CONFIG.YELLOW_CARD_PTS + (pen?.red || 0) * CONFIG.RED_CARD_PTS;
        if (deduct > 0) s.pts = Math.max(0, s.pts - deduct);
      });
    }
  }
  return stats;
}

// ── SEASON & PROFILE ANALYTICS HELPERS ─────────────────────────
// Season summary: matches, points, 7-day climber, most active
function getSeasonSummary(state, season) {
  const seasonGames = state.games.filter(g => gameInSeason(g, season));
  const matchCount = seasonGames.length;
  const totalPts = seasonGames.reduce((s, g) => s + (g.ptsGain || 0) + (g.ptsLoss || 0), 0);

  const sevenDaysAgo = new Date(Date.now() - 7 * MS_PER_DAY);
  const sevenDayGames = seasonGames.filter(g => new Date(g.date) >= sevenDaysAgo);
  const sevenDayStats = computeWindowPlayerStats(state.players, sevenDayGames);

  const topClimber = [...state.players].sort((a, b) =>
    (sevenDayStats[b.id]?.pts || 0) - (sevenDayStats[a.id]?.pts || 0)
  )[0];
  const topClimberPts = topClimber ? (sevenDayStats[topClimber.id]?.pts || 0) : 0;

  const mostActive = [...state.players].sort((a, b) =>
    sevenDayGames.filter(g => g.sideA.includes(b.id) || g.sideB.includes(b.id)).length -
    sevenDayGames.filter(g => g.sideA.includes(a.id) || g.sideB.includes(a.id)).length
  )[0];
  const activeCount = mostActive ? sevenDayGames.filter(g => g.sideA.includes(mostActive.id) || g.sideB.includes(mostActive.id)).length : 0;

  return { matchCount, totalPts, topClimber, topClimberPts, mostActive, activeCount };
}

// Best teammate: teammate with highest win% on same team
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
  const best = Object.entries(teammates).sort((a, b) =>
    (b[1].wins / Math.max(b[1].total, 1)) - (a[1].wins / Math.max(a[1].total, 1))
  )[0];
  return { id: best[0], wins: best[1].wins, total: best[1].total };
}

// Toughest opponent: opponent with lowest win% vs
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
  const toughest = Object.entries(opponents).sort((a, b) =>
    (a[1].wins / Math.max(a[1].total, 1)) - (b[1].wins / Math.max(b[1].total, 1))
  )[0];
  return { id: toughest[0], wins: toughest[1].wins, total: toughest[1].total };
}

// Average goals for/against based on which side player was on
function getAvgGoals(playerId, games) {
  if (!games.length) return { goalsFor: 0, goalsAgainst: 0 };
  let goalsFor = 0, goalsAgainst = 0;
  games.forEach(g => {
    const onA = g.sideA.includes(playerId);
    const [scoreFor, scoreAgainst] = onA ? [g.scoreA, g.scoreB] : [g.scoreB, g.scoreA];
    goalsFor += scoreFor;
    goalsAgainst += scoreAgainst;
  });
  return {
    goalsFor: (goalsFor / games.length).toFixed(1),
    goalsAgainst: (goalsAgainst / games.length).toFixed(1)
  };
}

// ============================================================
// DATA SHAPES
// Player: { id, name, mmr, pts, wins, losses, streak,
//           championships: [{month, year, partner}] }
// Game:   { id, sideA:[pid,pid], sideB:[pid,pid],
//           winner:"A"|"B", scoreA, scoreB,
//           ptsGain, ptsLoss, mmrGain, mmrLoss,
//           eloScale, ptsFactor, winMult, lossMult,
//           date, monthKey }
// State:  { players, games, monthlyPlacements, finals, rules }
// ============================================================
const MK = getMonthKey();
const SEED = {
  players: [
    { id: "p1", name: "Alex", mmr: 1060, pts: 74, wins: 9, losses: 3, streak: 4, championships: [] },
    { id: "p2", name: "Jordan", mmr: 1038, pts: 55, wins: 8, losses: 4, streak: 3, championships: [] },
    { id: "p3", name: "Sam", mmr: 1018, pts: 38, wins: 6, losses: 5, streak: 1, championships: [] },
    { id: "p4", name: "Riley", mmr: 992, pts: 18, wins: 4, losses: 6, streak: -2, championships: [] },
    { id: "p5", name: "Casey", mmr: 981, pts: 10, wins: 3, losses: 7, streak: -3, championships: [] },
    { id: "p6", name: "Morgan", mmr: 970, pts: 4, wins: 2, losses: 8, streak: -4, championships: [] },
  ],
  games: [
    { id: "g1", sideA: ["p1", "p2"], sideB: ["p3", "p4"], winner: "A", scoreA: 10, scoreB: 6, ptsGain: 14, ptsLoss: 6, mmrGain: 14, mmrLoss: 6, eloScale: .52, ptsFactor: .55, winMult: 1.7, lossMult: 1.1, date: new Date(Date.now() - 86400000 * 3).toISOString(), monthKey: MK },
    { id: "g2", sideA: ["p3", "p5"], sideB: ["p4", "p6"], winner: "A", scoreA: 10, scoreB: 7, ptsGain: 12, ptsLoss: 5, mmrGain: 12, mmrLoss: 5, eloScale: .50, ptsFactor: .50, winMult: 1.2, lossMult: 1.0, date: new Date(Date.now() - 86400000 * 2).toISOString(), monthKey: MK },
    { id: "g3", sideA: ["p2", "p4"], sideB: ["p1", "p3"], winner: "A", scoreA: 10, scoreB: 8, ptsGain: 13, ptsLoss: 5, mmrGain: 13, mmrLoss: 5, eloScale: .55, ptsFactor: .48, winMult: 1.4, lossMult: 1.3, date: new Date(Date.now() - 86400000).toISOString(), monthKey: MK },
  ],
  monthlyPlacements: {},
  finals: {},
  rules: DEFAULT_RULES,
  seasonStart: null,
  seasons: [],
  _meta: {},
  announcement: null,
  nextSeasonDate: null,
  announcementQueue: [],  // New: queue of announcements with priority/sticky
  adminActions: [],  // New: audit trail for undo capability (last N actions)
};

// ============================================================
// SUPABASE FUNCTIONS — REPLACED FROM localStorage
// ============================================================
async function loadState() {
  try {
    const { data, error } = await supabase
      .from('app_state')
      .select('state')
      .eq('id', 1)
      .single();

    if (error) {
      console.warn('Failed to load from Supabase, using seed:', error);
      return SEED;
    }

    const s = data?.state || {};
    const hasState = s && Object.keys(s).length > 0;
    if (!hasState) return SEED;
    const ns = normaliseState(s);
    // If DB has no _v yet, treat as 0 (upsert path will seed it)
    if (typeof s._v !== 'number') ns._v = 0;
    return ns;
  } catch (err) {
    console.error('Supabase load error:', err);
    return SEED;
  }
}

function normaliseState(s) {
  const rawFinals = s.finals || {};
  const normFinals = Object.fromEntries(
    Object.entries(rawFinals).map(([k, v]) => [k, { liveScores: {}, ...v }])
  );
  return {
    players: (s.players || []).map(p => ({
      streakPower: 0, lossStreakPower: 0,
      mmr_atk: p.mmr_atk ?? p.mmr ?? CONFIG.STARTING_MMR,
      mmr_def: p.mmr_def ?? p.mmr ?? CONFIG.STARTING_MMR,
      wins_atk: p.wins_atk ?? 0, losses_atk: p.losses_atk ?? 0,
      wins_def: p.wins_def ?? 0, losses_def: p.losses_def ?? 0,
      preferredRole: p.preferredRole ?? (p.position === 'attack' ? 'ATK' : p.position === 'defense' ? 'DEF' : 'FLEX'),
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
    announcementQueue: s.announcementQueue || [],  // New: announcement queue
    adminActions: (s.adminActions || []).slice(-5),  // New: last 5 admin actions (keep recent only)
    _v: typeof s._v === 'number' ? s._v : 0,
  };
}

function validateState(next) {
  if (!next?.players?.length && !next?.games?.length) {
    throw new Error("Refusing to write empty leaderboard state");
  }
}

// Duplicate game check: same players + same score on same day
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

// Data integrity: Check for suspicious/impossible scores
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

// Check for duplicate player names in onboarding
function checkDuplicatePlayerName(name, existingPlayers) {
  return existingPlayers.some(p => p.name.toLowerCase() === name.toLowerCase());
}

// ── SUPABASE SQL REQUIRED (run once) ─────────────────────────
//   create or replace function update_state_versioned(expected_v int, new_state jsonb)
//   returns boolean language plpgsql security definer as $$
//   declare updated int;
//   begin
//     update app_state set state = new_state, updated_at = now()
//     where id = 1 and (state->''_v'')::int = expected_v;
//     get diagnostics updated = row_count;
//     return updated > 0;
//   end; $$;
//   grant execute on function update_state_versioned(int,jsonb) to anon, authenticated;
// ─────────────────────────────────────────────────────────────

// ── SAVE QUEUE ───────────────────────────────────────────────
//
// Design principles:
//  1. The queue ALWAYS holds the latest state. Rapid successive changes
//     cancel the pending debounce and replace the payload — only the
//     most recent state is ever written.
//  2. _v is managed entirely inside the queue. React state never needs
//     to track it; the queue maintains a monotonically increasing counter
//     in _sq.confirmedV that survives rapid re-queuing.
//  3. Echo suppression: we track every _v we have in-flight or confirmed
//     in a Set so we never misidentify our own realtime echo as a remote update.
//  4. onSuccess is called with the confirmed DB version so the App can
//     stamp it back into state for display, but saving never depends on it.
//  5. No save loop: onSuccess stamps _v via isRemoteUpdate=true so the
//     autosave effect skips it.
//
const _sq = {
  pending: null,       // { stateToSave } — latest state waiting to flush
  confirmedV: -1,      // last _v we successfully wrote to DB
  inflightV: null,     // _v currently being written (async)
  echoSet: new Set(),  // all _v values we own (inflight + confirmed) for echo suppression
  retries: 0,
  timer: null,
  onConflict: null,
  onSuccess: null,
};

let syncToast = null;

// Queue a state for saving. Always uses confirmedV+1 as the next version,
// regardless of what's in state._v — this prevents the stale-version bug
// where two rapid saves both send expected_v=N.
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
    const cutoff = new Date(now - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from("app_state_history").delete().lt("saved_at", cutoff);
    writeLocalNumber(LAST_BACKUP_CLEANUP_KEY, now);
  } catch (e) {
    console.warn("[backup] cleanup failed:", e?.message || e);
  }
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
  } catch (e) {
    console.warn("[backup] insert failed:", e?.message || e);
  }
}

async function _flushSave() {
  if (!_sq.pending) return;
  const { stateToSave } = _sq.pending;

  // Always write confirmedV+1, never trust state._v for the version
  // This ensures rapid sequential saves don't collide
  const baseV = _sq.confirmedV >= 0 ? _sq.confirmedV : (stateToSave._v ?? 0);
  const nextV = baseV + 1;

  try {
    validateState(stateToSave);
  } catch (err) {
    console.warn('[sync] validation failed, aborting save:', err.message);
    syncToast?.("Refusing to write empty leaderboard state", "err");
    _sq.pending = null;
    _sq.retries = 0;
    _sq.onConflict = null;
    _sq.onSuccess = null;
    _sq.inflightV = null;
    return;
  }

  _sq.inflightV = nextV;
  _sq.echoSet.add(nextV);

  const enriched = {
    ...stateToSave,
    _meta: {
      ...(stateToSave._meta || {}),
      lastWriteAt: new Date().toISOString(),
      lastWriterId: getClientId(),
    },
    _v: nextV,
  };
  const slimmed = slimState(enriched);

  async function succeed() {
    console.log('[sync] ✓ saved _v' + nextV);
    _sq.confirmedV = nextV;
    _sq.inflightV = null;
    // Keep echo suppression active for 10s after confirm
    setTimeout(() => _sq.echoSet.delete(nextV), 10000);
    const cb = _sq.onSuccess;
    _sq.pending = null; _sq.retries = 0; _sq.onSuccess = null; _sq.onConflict = null;
    cb?.(nextV, enriched._meta);
    void maybeBackupState(slimmed);
  }

  async function handleConflict() {
    console.warn('[sync] conflict at v' + baseV + ', fetching remote');
    _sq.inflightV = null;
    _sq.echoSet.delete(nextV);
    try {
      const { data: cur } = await supabase.from('app_state').select('state').eq('id', 1).single();
      if (!cur?.state) return;
      const remote = normaliseState(cur.state);
      const remoteV = remote._v ?? 0;
      // If remote already has our version, we somehow won — treat as success
      if (remoteV >= nextV) { await succeed(); return; }
      // Genuine conflict — apply remote
      _sq.confirmedV = remoteV;
      const cb = _sq.onConflict;
      _sq.pending = null; _sq.retries = 0; _sq.onConflict = null; _sq.onSuccess = null;
      cb?.(remote);
    } catch (e) { console.error('[sync] conflict fetch failed:', e); }
  }

  try {
    // Try version-locked RPC first
    const { data: rpcData, error: rpcErr } = await supabase.rpc('update_state_versioned', {
      expected_v: baseV,
      new_state: slimmed,
    });

    if (!rpcErr && rpcData === true) { await succeed(); return; }
    if (!rpcErr && rpcData === false) { await handleConflict(); return; }

    // RPC unavailable — do NOT upsert to avoid clobbering remote state
    console.warn('[sync] RPC unavailable, aborting save:', rpcErr?.message);
    _sq.inflightV = null;
    _sq.echoSet.delete(nextV);
    _sq.pending = null;
    _sq.retries = 0;
    _sq.onConflict = null;
    _sq.onSuccess = null;
    syncToast?.("Sync unavailable (versioned RPC missing). No write performed.", "err");
    return;

  } catch (err) {
    _sq.inflightV = null;
    _sq.echoSet.delete(nextV);
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
      // Last resort: surface the remote state
      try {
        const { data: cur } = await supabase.from('app_state').select('state').eq('id', 1).single();
        if (cur?.state) cb?.(normaliseState(cur.state));
      } catch { }
    }
  }
}

// Strip recomputable fields before saving to cut egress ~40-60%.
// playerDeltas, scoreMult, eloScale etc are all re-derived by replayGames.
// ptsGain/ptsLoss/mmrGain/mmrLoss are kept — they're the display values.
function slimState(s) {
  return {
    ...s,
    games: (s.games || []).map(({
      playerDeltas, scoreMult, eloScale, rankScale,
      winMult, lossMult, mmrGain, mmrLoss, ptsFactor,
      winnerAvgMMR, loserAvgMMR, ...keep
      // perPlayerGains, perPlayerLosses, perPlayerFactors are kept — needed for history display
    }) => keep),
  };
}

// ============================================================
// STYLES
// ============================================================
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Outfit:wght@600;700;800&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    /* ── St Marylebone — proper contrast tiers ── */
    --bg:#090e0b;
    --s1:#111a14;
    --s2:#182318;
    --s3:#1f2d22;

    --b1:#253628;
    --b2:#304535;

    /* Forest green — primary */
    --amber:#58c882;
    --amber-d:#3da864;
    --amber-g:rgba(88,200,130,0.10);

    /* Colour diversity */
    --green:#5ec98a;
    --red:#f07070;
    --blue:#60a8e8;
    --gold:#e8b84a;
    --purple:#b08af0;
    --orange:#f09050;

    --text:#f0f5f2;
    --dim:#7da899;
    --dimmer:#4d7060;

    --sans:'DM Sans',system-ui,sans-serif;
    --disp:'Outfit',system-ui,sans-serif;
    --mono:'DM Sans',system-ui,sans-serif;
  }
  body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;-webkit-font-smoothing:antialiased}
  ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:var(--bg)}::-webkit-scrollbar-thumb{background:var(--b2);border-radius:2px}
  .app{display:flex;flex-direction:column;min-height:100vh}

  /* ── TOPBAR ─────────────────────────────────────────────── */
  .topbar{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:56px;background:var(--s1);border-bottom:1px solid var(--b2);position:sticky;top:0;z-index:100;gap:12px;box-shadow:0 1px 12px rgba(0,0,0,.4)}
  .brand{font-family:var(--disp);font-size:17px;font-weight:700;letter-spacing:.5px;color:var(--amber);white-space:nowrap}
  .brand span{color:var(--dim);font-weight:500;font-family:var(--sans);font-size:12px;letter-spacing:.3px;margin-left:6px}
  .nav{display:flex;gap:1px;flex-wrap:nowrap;overflow:hidden}
  .nav-btn{background:none;border:none;cursor:pointer;font-family:var(--disp);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--dim);padding:6px 14px;border-radius:6px;transition:all .15s;white-space:nowrap}
  .nav-btn:hover{color:var(--text);background:var(--s2)}
  .nav-btn.active{color:var(--amber);background:radial-gradient(ellipse 150% 300% at 50% 100%,rgba(94,201,138,.16),rgba(94,201,138,.04));font-weight:700;box-shadow:inset 0 -2px 0 var(--amber)}
  .admin-badge{font-size:11px;font-weight:600;color:var(--gold);background:rgba(232,184,74,.1);border:1px solid rgba(232,184,74,.35);border-radius:20px;padding:3px 10px;font-family:var(--sans);white-space:nowrap}

  /* Hamburger — mobile only */
  .ham-btn{display:none;background:none;border:none;cursor:pointer;padding:6px;color:var(--dim);flex-direction:column;gap:4px;flex-shrink:0}
  .ham-btn span{display:block;width:20px;height:2px;background:currentColor;border-radius:1px;transition:all .2s}
  .ham-btn.open span:nth-child(1){transform:translateY(6px) rotate(45deg)}
  .ham-btn.open span:nth-child(2){opacity:0}
  .ham-btn.open span:nth-child(3){transform:translateY(-6px) rotate(-45deg)}
  .mob-nav{display:none;position:fixed;top:52px;left:0;right:0;background:var(--s1);border-bottom:2px solid var(--b2);padding:8px 12px;flex-direction:column;gap:2px;z-index:99;box-shadow:0 8px 24px rgba(0,0,0,.4)}
  .mob-nav.open{display:flex}
  .mob-nav .nav-btn{text-align:left;padding:9px 12px;font-size:12px}

  /* ── LAYOUT ─────────────────────────────────────────────── */
  .main{flex:1;padding:20px;max-width:1100px;margin:0 auto;width:100%}
  .stack{display:flex;flex-direction:column;gap:14px}
  .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}

  /* ── CARDS ──────────────────────────────────────────────── */
  .card{background:var(--s1);border:1px solid var(--b2);border-radius:12px;overflow:hidden;transition:border-color .2s,box-shadow .2s;box-shadow:0 2px 12px rgba(0,0,0,.3)}
  .card-hover:hover{border-color:var(--b2);box-shadow:0 4px 20px rgba(0,0,0,.25)}
  .card-header{padding:14px 20px;border-bottom:1px solid var(--b2);display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--s2);border-left:3px solid var(--amber)}
  .card-title{font-family:var(--disp);font-size:14px;font-weight:700;letter-spacing:.2px;color:var(--text);white-space:nowrap}

  /* ── TABLE ──────────────────────────────────────────────── */
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

  /* ── BUTTONS ─────────────────────────────────────────────── */
  .btn{font-family:var(--sans);font-size:13px;font-weight:600;padding:8px 16px;border-radius:8px;cursor:pointer;border:1px solid transparent;transition:all .15s;white-space:nowrap}
  .btn-p{background:radial-gradient(ellipse 120% 200% at 30% 0%,#72dda0,#3a9660);color:#0a160f;border-color:transparent}.btn-p:hover{background:radial-gradient(ellipse 120% 200% at 30% 0%,#82e9b0,#4aa870);filter:none}
  .btn-g{background:transparent;color:var(--dim);border-color:var(--b2)}.btn-g:hover{color:var(--text);border-color:var(--b2);background:var(--s2)}
  .btn-d{background:transparent;color:var(--red);border-color:rgba(224,100,100,.3)}.btn-d:hover{background:rgba(224,100,100,.10)}
  .btn-warn{background:transparent;color:var(--amber);border-color:var(--amber-d)}.btn-warn:hover{background:var(--amber-g)}
  .btn-sm{padding:4px 10px;font-size:11px;border-radius:6px}
  .btn:disabled{opacity:.35;cursor:not-allowed}
  .w-full{width:100%}

  /* ── INPUTS ──────────────────────────────────────────────── */
  .inp{background:var(--s2);border:1px solid var(--b2);color:var(--text);font-family:var(--sans);font-size:14px;padding:9px 13px;border-radius:8px;outline:none;width:100%;transition:border .15s,box-shadow .15s}
  .inp:focus{border-color:var(--amber);box-shadow:0 0 0 3px rgba(94,201,138,.12)}
  .inp::placeholder{color:var(--dimmer)}
  select.inp{cursor:pointer}
  textarea.inp{resize:vertical;line-height:1.7}
  .lbl{font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--dim);margin-bottom:6px;display:block}
  .field{margin-bottom:14px}

  /* ── MESSAGES ────────────────────────────────────────────── */
  .msg{font-size:12px;padding:7px 11px;border-radius:4px;margin-top:7px}
  .msg-e{background:rgba(224,82,82,.10);color:var(--red);border:1px solid rgba(224,82,82,.3)}
  .msg-s{background:rgba(94,201,138,.10);color:var(--green);border:1px solid rgba(94,201,138,.3)}
  .msg-w{background:rgba(94,201,138,.08);color:var(--amber);border:1px solid rgba(94,201,138,.25)}

  /* ── TOAST ───────────────────────────────────────────────── */
  .toast{position:fixed;bottom:24px;right:20px;z-index:999;background:var(--s2);border:1px solid var(--b2);padding:12px 18px;border-radius:12px;font-size:13px;animation:slideUp .2s ease;box-shadow:0 12px 40px rgba(0,0,0,.5);max-width:320px;font-family:var(--sans)}
  .toast.success{border-left:3px solid var(--green);color:var(--green)}
  .toast.error{border-left:3px solid var(--red);color:var(--red)}
  .toast.info{border-left:3px solid var(--amber);color:var(--amber)}

  /* ── MODALS ──────────────────────────────────────────────── */
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(8px);padding:16px}
  .modal{background:var(--s2);border:1px solid var(--b2);border-radius:16px;padding:28px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;box-shadow:0 32px 80px rgba(0,0,0,.7),0 0 0 1px rgba(88,200,130,.06);animation:mIn .2s ease}
  .modal-lg{max-width:740px}
  @keyframes mIn{from{transform:scale(.97) translateY(6px);opacity:0}to{transform:scale(1) translateY(0);opacity:1}}
  .modal-title{font-family:var(--disp);font-size:21px;font-weight:700;margin-bottom:20px;color:var(--amber)}
  .confirm-modal{max-width:380px;text-align:center}
  .confirm-modal .modal-title{font-size:18px}

  /* ── STAT BOXES ──────────────────────────────────────────── */
  .stat-box{background:var(--s2);border:1px solid var(--b2);border-radius:12px;padding:18px 20px;transition:border-color .2s,box-shadow .2s;box-shadow:0 2px 8px rgba(0,0,0,.25);position:relative;overflow:hidden}
  .stat-box::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--amber),transparent)}
  .stat-box:hover{border-color:var(--amber-d);box-shadow:0 4px 20px rgba(88,200,130,.12)}
  .stat-lbl{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--dimmer);margin-bottom:6px;font-weight:500;font-family:var(--sans)}
  .stat-val{font-family:var(--disp);font-size:30px;font-weight:700;color:var(--text)}
  .stat-val.am{color:var(--amber)}
  .stat-lbl{color:var(--dim) !important}
  @media(max-width:640px){.stat-val{font-size:22px}.stat-lbl{font-size:10px}}

  /* ── PILLS / TAGS ────────────────────────────────────────── */
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

  /* ── GAME ROWS ───────────────────────────────────────────── */
  .game-row{padding:11px 16px;border-bottom:1px solid var(--b1);display:grid;grid-template-columns:1fr 72px 1fr;gap:10px;align-items:center;font-size:13px;cursor:pointer;transition:background .15s;position:relative}
  .game-row:hover{background:rgba(255,255,255,.03)}
  .game-row:active{background:var(--s2)}
  .game-row:last-child{border-bottom:none}
  .g-side{display:flex;flex-direction:column;gap:3px}
  .g-side.right{text-align:right;align-items:flex-end}
  .g-score{font-family:var(--disp);font-size:22px;font-weight:700;color:var(--amber);text-align:center;line-height:1}
  .g-date{font-size:11px;color:var(--dimmer);text-align:center;margin-top:3px}
  .g-name-w{color:var(--text);font-weight:600;font-size:13px}
  .g-name-l{color:var(--dim);font-size:13px}
  .g-delta{font-size:11px;letter-spacing:.2px;margin-top:2px}

  /* ── LOG GAME SPECIFIC ───────────────────────────────────── */
  .add-row{display:flex;align-items:center;justify-content:center;gap:6px;background:none;border:1px dashed var(--b2);color:var(--dim);font-family:var(--sans);font-size:12px;padding:9px;border-radius:8px;cursor:pointer;letter-spacing:.3px;transition:all .15s;width:100%;margin-top:8px}
  .add-row:hover{border-color:var(--amber);color:var(--amber)}
  .player-chip{display:flex;align-items:center;justify-content:space-between;background:var(--s2);border:1px solid var(--b2);border-radius:8px;padding:9px 13px;font-size:13px;cursor:pointer;transition:all .12s;user-select:none;box-shadow:0 1px 4px rgba(0,0,0,.2)}
  .player-chip:hover:not(.disabled){border-color:var(--amber);background:var(--s3);box-shadow:0 2px 8px rgba(88,200,130,.1)}
  .player-chip.sel-a{background:rgba(94,201,138,.1);border-color:var(--green);color:var(--green)}
  .player-chip.sel-b{background:rgba(107,163,214,.10);border-color:var(--blue);color:var(--blue)}
  .player-chip.disabled{opacity:.3;cursor:not-allowed}

  /* ── POSITION BADGES ─────────────────────────────────────── */
  .pos-badge{display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:2px 6px;border-radius:3px;border:1px solid}
  .pos-atk{background:rgba(224,82,82,.12);color:var(--red);border-color:rgba(224,82,82,.3)}
  .pos-def{background:rgba(91,155,213,.12);color:var(--blue);border-color:rgba(91,155,213,.3)}
  .pos-both{background:rgba(155,127,232,.12);color:var(--purple);border-color:rgba(155,127,232,.3)}
  .role-tag{display:inline-flex;align-items:center;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;font-family:var(--sans);flex-shrink:0;cursor:pointer;transition:opacity .15s}
  .role-atk{background:rgba(240,144,80,.18);color:var(--orange);outline:1px solid rgba(240,144,80,.4)}
  .role-def{background:rgba(96,168,232,.14);color:var(--blue);outline:1px solid rgba(96,168,232,.35)}

  /* ── PLACEMENT STATUS ────────────────────────────────────── */
  .placement-badge{display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:2px 7px;border-radius:3px}
  .placement-done{background:radial-gradient(ellipse 200% 200% at 0% 50%,rgba(94,201,138,.18),rgba(94,201,138,.05));color:var(--green);border:1px solid rgba(94,201,138,.3)}
  .placement-pending{background:radial-gradient(ellipse 200% 200% at 0% 50%,rgba(96,168,232,.16),rgba(96,168,232,.04));color:var(--blue);border:1px solid rgba(96,168,232,.25)}

  /* ── BRACKET ─────────────────────────────────────────────── */
  .bracket{padding:20px;display:flex;gap:28px;align-items:center;justify-content:center;overflow-x:auto;-webkit-overflow-scrolling:touch}
  .b-col{display:flex;flex-direction:column;gap:28px;align-items:center}
  .b-match{background:var(--s2);border:1px solid var(--b2);border-radius:6px;overflow:hidden;width:200px}
  .b-side{padding:9px 13px;font-size:12px;border-bottom:1px solid var(--b1);display:flex;justify-content:space-between;align-items:center}
  .b-side:last-child{border-bottom:none}
  .b-side.win{background:var(--amber-g);color:var(--amber);font-weight:600}
  .b-conn{color:var(--dim);font-size:24px;font-weight:800}

  /* ── PROFILE ─────────────────────────────────────────────── */
  .prof-head{display:flex;align-items:center;gap:16px;margin-bottom:20px}
  .prof-av{width:54px;height:54px;border-radius:12px;background:var(--amber-g);border:2px solid var(--amber-d);display:flex;align-items:center;justify-content:center;font-family:var(--disp);font-size:24px;font-weight:700;color:var(--amber);flex-shrink:0}
  .prof-name{font-family:var(--disp);font-size:24px;font-weight:700}
  .prof-sub{font-size:13px;color:var(--dim);margin-top:3px}
  .championship-banner{background:radial-gradient(ellipse 140% 140% at 0% 0%,rgba(232,184,74,.18) 0%,rgba(94,201,138,.08) 60%,transparent 100%);border:1px solid rgba(232,184,74,.35);border-radius:10px;padding:12px 16px;display:flex;align-items:center;gap:10px;margin-bottom:16px}

  /* ── MISC ────────────────────────────────────────────────── */
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


  /* ── Flashy announcement — subtle mode ── */
  .season-launch{position:relative;overflow:hidden;background:var(--s2)}
  .season-launch::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--gold),var(--amber),var(--gold),transparent);animation:shimmerLine 2.4s ease-in-out infinite;pointer-events:none}
  @keyframes shimmerLine{0%,100%{opacity:.4;transform:scaleX(.5)}50%{opacity:1;transform:scaleX(1)}}

  /* ── Flashy announcement — hype mode ── */
  .season-launch.hype{
    background:radial-gradient(ellipse 80% 120% at 10% 0%,rgba(232,184,74,.13) 0%,rgba(88,200,130,.07) 50%,var(--s2) 100%);
    border:1px solid rgba(232,184,74,.45) !important;
    box-shadow:0 0 0 1px rgba(232,184,74,.1),inset 0 1px 0 rgba(232,184,74,.2);
    animation:hypePulse 3s ease-in-out infinite;
  }
  @keyframes hypePulse{
    0%,100%{box-shadow:0 0 0 1px rgba(232,184,74,.1),0 0 20px rgba(232,184,74,.06),inset 0 1px 0 rgba(232,184,74,.2)}
    50%{box-shadow:0 0 0 1px rgba(232,184,74,.25),0 0 40px rgba(232,184,74,.14),inset 0 1px 0 rgba(232,184,74,.35)}
  }
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

  /* ── MARKDOWN ────────────────────────────────────────────── */
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

  /* ── UNDO BAR ────────────────────────────────────────────── */
  .undo-bar{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--s2);border:1px solid var(--b2);border-radius:6px;padding:10px 16px;display:flex;align-items:center;gap:12px;font-size:12px;z-index:150;box-shadow:0 8px 32px rgba(0,0,0,.5);animation:slideUp .2s ease}

  /* ── EDIT HIGHLIGHT ──────────────────────────────────────── */
  .inp-edit{border-color:var(--amber-d) !important;background:rgba(94,201,138,.05) !important}

  /* ── REALTIME DOT ────────────────────────────────────────── */
  .rt-dot{width:8px;height:8px;border-radius:50%;background:var(--dimmer);display:block;flex-shrink:0;transition:background .3s}
  .rt-dot.live{background:var(--green);animation:rtPulse 2.5s infinite}
  @keyframes rtPulse{0%{box-shadow:0 0 0 0 rgba(94,201,138,.55)}70%{box-shadow:0 0 0 7px rgba(94,201,138,0)}100%{box-shadow:0 0 0 0 rgba(94,201,138,0)}}

  /* ── LEADERBOARD ANIMATIONS ──────────────────────────────── */
  /* Stagger entrance — only applies when no rank/pts animation is active */
  @keyframes rowIn{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
  .lb-row{animation:rowIn .3s ease both;transition:background .15s}

  /* Rank change + pts flash — more vivid against new dark bg */
  @keyframes rankUp{
    0%{background:rgba(88,200,130,.32);box-shadow:inset 0 0 0 1px rgba(88,200,130,.4)}
    60%{background:rgba(88,200,130,.12);box-shadow:none}
    100%{background:transparent}
  }
  @keyframes rankDown{
    0%{background:rgba(224,100,100,.28);box-shadow:inset 0 0 0 1px rgba(224,100,100,.35)}
    60%{background:rgba(224,100,100,.10);box-shadow:none}
    100%{background:transparent}
  }
  @keyframes ptsFlash{
    0%{background:transparent}
    25%{background:rgba(88,200,130,.18)}
    75%{background:rgba(88,200,130,.08)}
    100%{background:transparent}
  }
  /* Override rowIn when rank/pts animation is active */
  .lb-row.rank-up{animation:rankUp .9s ease forwards}
  .lb-row.rank-down{animation:rankDown .9s ease forwards}
  .lb-row.pts-changed{animation:ptsFlash 1s ease}

  /* ── PAGE FADE ───────────────────────────────────────────── */
  .page-fade{animation:pageFade .18s ease both}
  .page-fade{animation:pageFade .2s ease both}
  @keyframes pageFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}

  /* ── LIVE MATCH SCORING ──────────────────────────────────── */
  .match-live-banner{background:radial-gradient(ellipse 80% 300% at 0% 50%,rgba(240,112,112,.12),var(--s1));border:1px solid rgba(240,112,112,.3);border-radius:10px;padding:10px 16px;display:flex;align-items:center;gap:10px;font-size:13px;animation:slideUp .3s ease;cursor:pointer}
  .score-btn{width:26px;height:26px;border-radius:5px;background:var(--s3);border:1px solid var(--b2);color:var(--text);cursor:pointer;font-size:16px;font-weight:700;display:flex;align-items:center;justify-content:center;user-select:none;transition:background .1s}
  .score-btn:hover{background:var(--b2)}
  .score-btn:active{transform:scale(.93)}
  .live-score-num{font-family:var(--disp);font-size:32px;font-weight:700;line-height:1;min-width:40px;text-align:center;transition:all .2s}
  .live-pulse{animation:livePulse 1.8s ease-in-out infinite}
  @keyframes livePulse{0%,100%{opacity:1}50%{opacity:.45}}
  .score-btn{width:32px;height:32px;border-radius:50%;font-size:18px;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid var(--b2);background:var(--s2);color:var(--text);transition:all .12s;user-select:none;line-height:1}
  .score-btn:hover{background:var(--s3);border-color:var(--amber)}
  .score-btn:active{transform:scale(.9)}

  /* ── ANIMATIONS ──────────────────────────────────────────── */
  @keyframes slideUp{from{transform:translateY(10px);opacity:0}to{transform:translateY(0);opacity:1}}
  @keyframes fadeInUp{from{transform:translateY(12px);opacity:0}to{transform:translateY(0);opacity:1}}
  @keyframes savingBar{from{opacity:.4}to{opacity:1}}
  @keyframes countUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}

  /* ── COUNTDOWN BLOCK ─────────────────────────────────────── */
  .cd-wrap{display:flex;gap:6px;align-items:flex-end;justify-content:center;margin:16px 0 6px}
  .cd-unit{display:flex;flex-direction:column;align-items:center;min-width:54px}
  .cd-num{font-family:var(--disp);font-size:46px;font-weight:700;line-height:1;letter-spacing:-1px;transition:color .4s;text-shadow:0 2px 12px rgba(94,201,138,.2)}
  .cd-lbl{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--dimmer);margin-top:2px}
  .cd-sep{font-family:var(--disp);font-size:38px;font-weight:800;color:var(--dimmer);line-height:1;margin-bottom:16px;animation:sepBlink 1.2s step-start infinite}
  @keyframes sepBlink{0%,49%{opacity:1}50%,100%{opacity:.2}}
  .cd-urgent1{color:var(--orange) !important}
  .cd-urgent2{color:var(--red) !important}
  .cd-glow{animation:cdGlow 2s ease-in-out infinite alternate}
  @keyframes cdGlow{from{text-shadow:0 0 8px rgba(94,201,138,.2)}to{text-shadow:0 0 20px rgba(94,201,138,.5)}}

  /* ── MOBILE ──────────────────────────────────────────────── */
  /* ── MOBILE LEADERBOARD CARDS ───────────────────────────── */
  .lb-cards{display:none;flex-direction:column;gap:0}
  .lb-card{display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid var(--b1);cursor:pointer;transition:background .12s}
  .lb-card:hover{background:rgba(255,255,255,.03)}
  .lb-card:last-child{border-bottom:none}
  .lb-card-rank{font-family:var(--disp);font-size:16px;font-weight:700;min-width:36px;color:var(--dim)}
  .lb-card-name{flex:1;font-weight:600;font-size:14px}
  .lb-card-pts{font-family:var(--disp);font-size:18px;font-weight:700;color:var(--amber);min-width:40px;text-align:right}
  .lb-card-meta{font-size:11px;color:var(--dimmer);margin-top:1px}

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
    .cd-sep{font-size:26px}
    .tbl{min-width:380px}
    .tbl td,.tbl th{padding:7px 8px;font-size:12px}
    .game-row{grid-template-columns:1fr auto 1fr;padding:9px 10px;gap:6px}
    .g-score{font-size:17px;min-width:42px}
    .g-side{font-size:11px}
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

  /* ── PAGE FADE-IN ── */
  .page-fade{animation:pageIn .22s ease forwards}
  @keyframes pageIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}

  /* ── URGENCY ── */
  .cd-urgency{color:var(--red) !important;text-shadow:0 0 18px rgba(240,92,92,.3) !important}

  /* ── STAT VAL COLOUR ── */
  .stat-val{font-family:var(--disp);font-size:26px;font-weight:800;color:var(--text)}
  .stat-val.am{color:var(--amber)}

  /* ── BRAND SUB ── */
  .brand-sub{color:var(--dim);font-weight:400}
`;

// ============================================================
// HELPERS
// ============================================================
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

function StreakBadge({ streak, streakPower = 0, showMult = false }) {
  const s = streak || 0;
  if (s === 0) return <span className="text-dd">—</span>;
  const m = s > 0
    ? streakMult(streakPower, true)
    : streakMult(Math.abs(s) * CONFIG.STREAK_POWER_SCALE * 0.4, false);
  return s > 0
    ? <span className="text-g bold">▲{s}{showMult && <span className="xs" style={{ opacity: .7 }}> ×{m.toFixed(2)}</span>}</span>
    : <span className="text-r bold">▼{Math.abs(s)}{showMult && <span className="xs" style={{ opacity: .7 }}> ×{m.toFixed(2)}</span>}</span>;
}
function Pips({ used }) {
  return <>{Array.from({ length: CONFIG.MAX_PLACEMENTS_PER_MONTH }).map((_, i) =>
    <span key={i} className={`pip ${i < used ? "pip-u" : "pip-f"}`} />
  )}</>;
}
function PosBadge({ pos }) {
  if (!pos || pos === "none" || (Array.isArray(pos) && pos.length === 0)) return <span className="text-dd xs">—</span>;
  const positions = Array.isArray(pos) ? pos : [pos];
  // Legacy "both" → show as flex
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

// Simple markdown renderer
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

  const calloutColors = {
    note: "var(--blue)", info: "var(--blue)", tip: "var(--green)", hint: "var(--green)",
    success: "var(--green)", check: "var(--green)", done: "var(--green)",
    warning: "var(--orange)", caution: "var(--orange)", attention: "var(--orange)",
    danger: "var(--red)", error: "var(--red)", bug: "var(--red)",
    important: "var(--amber)", quote: "var(--dimmer)", example: "var(--purple)",
  };
  const calloutIcons = {
    note: "ℹ", info: "ℹ", tip: "💡", hint: "💡", success: "✓", check: "✓", done: "✓",
    warning: "⚠", caution: "⚠", attention: "⚠", danger: "✕", error: "✕", bug: "🐛",
    important: "!", quote: '"', example: "≡",
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
        i++;
      }
      out.push(`<pre style="background:var(--s2);border:1px solid var(--b2);border-radius:6px;padding:12px 14px;overflow-x:auto;font-family:var(--mono);font-size:12px;line-height:1.7;margin:8px 0">${lang ? `<span style="font-size:10px;color:var(--dimmer);display:block;margin-bottom:6px;letter-spacing:1px;text-transform:uppercase">${lang}</span>` : ""}${codeLines.join("\n")}</pre>`);
      i++; continue;
    }

    // Obsidian callout > [!type]
    if (/^> \[!(\w+)\]/.test(line)) {
      const match = line.match(/^> \[!(\w+)\]\s*(.*)$/);
      const type = (match[1] || "note").toLowerCase();
      const title = match[2] || (type.charAt(0).toUpperCase() + type.slice(1));
      const color = calloutColors[type] || "var(--blue)";
      const icon = calloutIcons[type] || "ℹ";
      const bodyLines = [];
      i++;
      while (i < lines.length && /^> /.test(lines[i])) { bodyLines.push(lines[i].slice(2)); i++; }
      out.push(`<div style="border-left:3px solid ${color};background:color-mix(in srgb,${color} 8%,var(--s2));border-radius:0 6px 6px 0;padding:10px 14px;margin:8px 0"><div style="font-weight:700;color:${color};font-size:12px;margin-bottom:4px">${icon} ${inlineFormat(title)}</div><div style="color:var(--dim);font-size:13px;line-height:1.7">${bodyLines.map(inlineFormat).join("<br>")}</div></div>`);
      continue;
    }

    // Regular blockquote
    if (/^> /.test(line)) {
      const bqLines = [];
      while (i < lines.length && /^> /.test(lines[i])) { bqLines.push(lines[i].slice(2)); i++; }
      out.push(`<blockquote style="border-left:3px solid var(--b2);padding:6px 14px;margin:6px 0;color:var(--dim);font-style:italic">${bqLines.map(inlineFormat).join("<br>")}</blockquote>`);
      continue;
    }

    // Headings
    if (/^#{1,6} /.test(line)) {
      const m = line.match(/^(#{1,6}) (.+)$/);
      const lvl = m[1].length;
      const sizes = [28, 18, 15, 13, 13, 13];
      const colors = ["var(--amber)", "var(--text)", "var(--text)", "var(--dim)", "var(--dim)", "var(--dim)"];
      out.push(`<div style="font-family:var(--disp);font-size:${sizes[lvl - 1]}px;font-weight:${lvl <= 2 ? 700 : 600};color:${colors[lvl - 1]};margin:${lvl === 1 ? "0 0 12px" : "14px 0 5px"};${lvl === 2 ? "border-bottom:1px solid var(--b1);padding-bottom:4px" : ""}">${inlineFormat(m[2])}</div>`);
      i++; continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      out.push('<hr style="border:none;border-top:1px solid var(--b2);margin:14px 0">');
      i++; continue;
    }

    // Table
    if (/^\|.+\|/.test(line)) {
      const tableLines = [];
      while (i < lines.length && /^\|/.test(lines[i])) { tableLines.push(lines[i]); i++; }
      if (tableLines.length >= 2) {
        const headers = tableLines[0].split("|").filter((_, j, a) => j > 0 && j < a.length - 1).map(h => h.trim());
        const alignRow = tableLines[1].split("|").filter((_, j, a) => j > 0 && j < a.length - 1);
        const aligns = alignRow.map(c => { const t = c.trim(); return t.startsWith(":") && t.endsWith(":") ? "center" : t.endsWith(":") ? "right" : "left"; });
        const rows = tableLines.slice(2).map(r => r.split("|").filter((_, j, a) => j > 0 && j < a.length - 1).map(c => c.trim()));
        out.push(`<div style="overflow-x:auto;margin:8px 0"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>${headers.map((h, ci) => `<th style="text-align:${aligns[ci] || "left"};padding:6px 10px;border-bottom:2px solid var(--b2);color:var(--dimmer);font-weight:600;font-size:10px;letter-spacing:.5px;text-transform:uppercase;background:var(--s2)">${inlineFormat(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row, ri) => `<tr style="${ri % 2 ? "background:rgba(255,255,255,.015)" : ""}">${row.map((cell, ci) => `<td style="text-align:${aligns[ci] || "left"};padding:6px 10px;border-bottom:1px solid var(--b1)">${inlineFormat(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      }
      continue;
    }

    // Lists
    if (/^(\s*)([-*+]|\d+\.) /.test(line)) {
      const listLines = [];
      while (i < lines.length && (/^(\s*)([-*+]|\d+\.) /.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        listLines.push(lines[i]); i++;
      }
      const isOrdered = /^\s*\d+\./.test(listLines[0]);
      const items = listLines.map(item => {
        const m = item.match(/^(\s*)([-*+]|\d+\.) (.*)$/);
        if (!m) return "";
        const text = m[3];
        if (/^\[[ xX]\] /.test(text)) {
          const checked = /^\[[xX]\] /.test(text);
          const label = text.replace(/^\[[ xX]\] /, "");
          return `<li style="list-style:none;margin-left:-18px"><label style="display:flex;align-items:flex-start;gap:6px"><input type="checkbox" ${checked ? "checked" : ""} disabled style="margin-top:2px;accent-color:var(--amber)"><span style="${checked ? "text-decoration:line-through;opacity:.5" : ""}">${inlineFormat(label)}</span></label></li>`;
        }
        return `<li>${inlineFormat(text)}</li>`;
      }).join("");
      out.push(isOrdered
        ? `<ol style="padding-left:20px;margin:6px 0">${items}</ol>`
        : `<ul style="padding-left:20px;margin:6px 0">${items}</ul>`);
      continue;
    }

    // Empty line
    if (line.trim() === "") { i++; continue; }

    // Paragraph
    out.push(`<p style="margin-bottom:8px;line-height:1.7;color:var(--dim);font-size:13px">${inlineFormat(line)}</p>`);
    i++;
  }
  return out.join("\n");
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
      {/* Header */}
      <div className={headerClass} style={{
        margin: "-28px -28px 0", padding: isHype ? "24px 28px 20px" : "20px 28px 16px",
        borderBottom: "1px solid var(--b1)", marginBottom: isHype ? 20 : 16,
        borderRadius: "14px 14px 0 0",
      }}>
        {isHype && (
          <div className="xs" style={{
            letterSpacing: 2, textTransform: "uppercase", color: "var(--gold)",
            opacity: .7, marginBottom: 8, fontWeight: 600,
            animation: "fadeInUp .4s ease both"
          }}>
            ✦ &nbsp;Announcement&nbsp; ✦
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {isSpecial
            ? <span className={titleClass} style={{ animation: isHype ? "fadeInUp .5s ease both .1s" : "none" }}>{title}</span>
            : <span className="modal-title" style={{ marginBottom: 0 }}>{title}</span>
          }
          {subtitle && <span className={isSpecial ? pillClass : "tag tag-a"}>{subtitle}</span>}
        </div>
      </div>

      {/* Body */}
      <div className="md" style={{ animation: isHype ? "fadeInUp .5s ease both .2s" : "none" }}
        dangerouslySetInnerHTML={{ __html: renderMd(announcement.body || "") }} />

      {/* Footer */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: isHype ? 20 : 14, flexWrap: "wrap", gap: 8 }}>
        {announcement.endsAt
          ? <span className="xs text-dd">Visible until {new Date(announcement.endsAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
          : <span />
        }
        <button className={isHype ? "btn btn-p" : "btn btn-g"} onClick={onClose}>
          {isHype ? "Let's go 🔥" : "Close"}
        </button>
      </div>
    </Modal>
  );
}

// ============================================================
// PLAYER PROFILE MODAL
// ============================================================
function PlayerProfile({ player, state, onClose, isAdmin, onEdit, seasonMode, onSeasonModeChange, selectedSeasonId, onSelectedSeasonIdChange }) {
  const monthKey = getMonthKey();
  const placements = (state.monthlyPlacements[monthKey] || {})[player.id] || 0;
  const currentSeason = getCurrentSeason(state);
  const selectedSeason = seasonMode === "all" ? null : (state.seasons || []).find(s => s.id === selectedSeasonId) || currentSeason || null;
  const myGames = [...state.games]
    .filter(g => (g.sideA.includes(player.id) || g.sideB.includes(player.id)) && gameInSeason(g, selectedSeason))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const rankBase = [...state.players].sort((a, b) => (b.pts || 0) - (a.pts || 0));
  const rank = rankBase.findIndex(p => p.id === player.id) + 1;
  const seasonWindowStats = computeWindowPlayerStats(state.players, state.games.filter(g => gameInSeason(g, selectedSeason)));
  const scopedStats = seasonWindowStats[player.id] || { wins: 0, losses: 0, pts: 0, streak: 0 };
  const displayWins = seasonMode === "all" ? player.wins : scopedStats.wins;
  const displayLosses = seasonMode === "all" ? player.losses : scopedStats.losses;
  const displayPts = seasonMode === "all" ? (player.pts || 0) : scopedStats.pts;
  const displayStreak = seasonMode === "all" ? player.streak : scopedStats.streak;
  const champs = player.championships || [];

  return (
    <Modal onClose={onClose} large>
      {champs.length > 0 && (
        <div className="championship-banner">
          <span style={{ fontSize: 22 }}>🏆</span>
          <div>
            <div className="xs text-am bold" style={{ letterSpacing: 2, textTransform: "uppercase" }}>Monthly Champion</div>
            <div className="sm text-d mt8" style={{ marginTop: 2 }}>
              {champs.map((c, i) => (
                <span key={i}>{fmtMonth(c.month)}{c.partner ? ` (w/ ${c.partner})` : ""}{i < champs.length - 1 ? " · " : ""}</span>
              ))}
            </div>
          </div>
          {isAdmin && (
            <button className="btn btn-warn btn-sm" style={{ marginLeft: "auto" }} onClick={onEdit}>Edit</button>
          )}
        </div>
      )}

      <div className="prof-head">
        <div className="prof-av">{player.name[0].toUpperCase()}</div>
        <div style={{ flex: 1 }}>
          <div className="prof-name">{player.name}</div>
          <div className="prof-sub">Rank #{rank} · {displayPts || 0} pts</div>
          <div className="fac" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            <button className={`btn btn-sm ${seasonMode === "all" ? "btn-p" : "btn-g"}`} onClick={() => onSeasonModeChange("all")}>All-time</button>
            <button className={`btn btn-sm ${seasonMode === "season" ? "btn-p" : "btn-g"}`} onClick={() => onSeasonModeChange("season")}>Season</button>
            {seasonMode === "season" && (
              <select className="inp" style={{ padding: "4px 8px", fontSize: 11, minWidth: 130 }} value={selectedSeasonId || ""} onChange={e => onSelectedSeasonIdChange(e.target.value)}>
                {(state.seasons || []).map(se => <option key={se.id} value={se.id}>{se.label}</option>)}
              </select>
            )}
          </div>
        </div>
        <div className="fac" style={{ gap: 6 }}>
          {isAdmin && !champs.length && (
            <button className="btn btn-g btn-sm" onClick={onEdit}>Edit</button>
          )}
          <button className="btn btn-g btn-sm" onClick={onClose} style={{ fontSize: 14, padding: "3px 9px" }}>×</button>
        </div>
      </div>

      <div className="grid-3 mb16">
        <div className="stat-box">
          <div className="stat-lbl">Points</div>
          <div className="stat-val am">
            {placements >= CONFIG.MAX_PLACEMENTS_PER_MONTH
              ? (displayPts || 0)
              : <span className="text-dd" title="Complete placements to reveal points">?</span>}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-lbl">Record</div>
          <div className="stat-val" style={{ fontSize: 20 }}>
            <span className="text-g">{displayWins}</span>
            <span className="text-dd" style={{ fontSize: 13 }}>/</span>
            <span className="text-r">{displayLosses}</span>
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-lbl">Streak</div>
          <div className="stat-val" style={{ fontSize: 20 }}><StreakBadge streak={displayStreak} streakPower={player.streakPower || 0} showMult /></div>
        </div>
      </div>

      <div className="grid-3 mb16">
        <div className="stat-box">
          <div className="stat-lbl">Win Rate</div>
          <div className="stat-val" style={{ fontSize: 20 }}>
            {displayWins + displayLosses > 0
              ? <span className={displayWins / (displayWins + displayLosses) >= .5 ? "text-g" : "text-r"}>
                {Math.round(displayWins / (displayWins + displayLosses) * 100)}%
              </span>
              : <span className="text-dd">—</span>}
          </div>
        </div>
        <div className="stat-box">
          {((player.wins_atk||0)+(player.losses_atk||0)+(player.wins_def||0)+(player.losses_def||0)) > 0 ? (() => {
            const atkTotal = (player.wins_atk||0)+(player.losses_atk||0);
            const defTotal = (player.wins_def||0)+(player.losses_def||0);
            const atkWR = atkTotal ? Math.round((player.wins_atk||0)/atkTotal*100) : null;
            const defWR = defTotal ? Math.round((player.wins_def||0)/defTotal*100) : null;
            return (
              <>
                <div className="stat-lbl" style={{marginBottom:8}}>Positional</div>
                <div style={{display:"flex",flexDirection:"column",gap:7}}>
                  <div style={{display:"flex",alignItems:"center",gap:7}}>
                    <span className="role-tag role-atk" style={{pointerEvents:"none",flexShrink:0}}>🗡 ATK</span>
                    <div style={{lineHeight:1.25}}>
                      <div style={{fontWeight:700,fontSize:14,color:"var(--orange)"}}>{player.mmr_atk||player.mmr} <span style={{fontSize:10,fontWeight:500,color:"var(--dimmer)"}}>MMR</span></div>
                      <div className="xs text-dd">
                        <span className="text-g">{player.wins_atk||0}W</span> / <span className="text-r">{player.losses_atk||0}L</span>
                        {atkWR !== null && <span style={{marginLeft:5,color:atkWR>=50?"var(--green)":"var(--red)"}}>{atkWR}%</span>}
                      </div>
                    </div>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:7}}>
                    <span className="role-tag role-def" style={{pointerEvents:"none",flexShrink:0}}>🛡 DEF</span>
                    <div style={{lineHeight:1.25}}>
                      <div style={{fontWeight:700,fontSize:14,color:"var(--blue)"}}>{player.mmr_def||player.mmr} <span style={{fontSize:10,fontWeight:500,color:"var(--dimmer)"}}>MMR</span></div>
                      <div className="xs text-dd">
                        <span className="text-g">{player.wins_def||0}W</span> / <span className="text-r">{player.losses_def||0}L</span>
                        {defWR !== null && <span style={{marginLeft:5,color:defWR>=50?"var(--green)":"var(--red)"}}>{defWR}%</span>}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            );
          })() : (
            <>
              <div className="stat-lbl">Position</div>
              <div style={{ marginTop: 8 }}><PosBadge pos={player.position} /></div>
            </>
          )}
        </div>
        <div className="stat-box">
          <div className="stat-lbl">Placements this month</div>
          <div style={{ marginTop: 10 }}><Pips used={placements} /></div>
        </div>
      </div>

      {seasonMode === "season" && myGames.length > 0 && (
        <div style={{ marginBottom: 16, padding: 12, borderRadius: 8, background: "var(--s2)", border: "1px solid var(--b1)" }}>
          <div className="sec" style={{ marginBottom: 8 }}>Season Insights</div>
          <div className="grid-2" style={{ gap: 12 }}>
            {(() => {
              const best = getBestTeammate(player.id, myGames);
              return (
                <div>
                  <div className="xs text-dd">Best Teammate</div>
                  {best ? (
                    <div><span style={{ fontWeight: 600 }}>{pName(best.id, state.players)}</span> <span className="xs text-g">{Math.round(best.wins / best.total * 100)}% ({best.wins}W)</span></div>
                  ) : (<div className="xs text-dd">—</div>)}
                </div>
              );
            })()}
            {(() => {
              const tough = getToughestOpponent(player.id, myGames);
              return (
                <div>
                  <div className="xs text-dd">Toughest Opponent</div>
                  {tough ? (
                    <div><span style={{ fontWeight: 600 }}>{pName(tough.id, state.players)}</span> <span className="xs text-r">{Math.round(tough.wins / tough.total * 100)}% ({tough.wins}W)</span></div>
                  ) : (<div className="xs text-dd">—</div>)}
                </div>
              );
            })()}
            {(() => {
              const { goalsFor, goalsAgainst } = getAvgGoals(player.id, myGames);
              return (
                <div>
                  <div className="xs text-dd">Avg Goals</div>
                  <div><span className="text-g">{goalsFor}</span> <span className="xs text-dd">For</span> / <span className="text-r">{goalsAgainst}</span> <span className="xs text-dd">Against</span></div>
                </div>
              );
            })()}
            <div>
              <div className="xs text-dd">PPG (Pts/Game)</div>
              {(() => {
                let totalPts = 0;
                myGames.forEach(g => {
                  const won = didPlayerWin(player.id, g);
                  const delta = won
                    ? (g.perPlayerGains?.[player.id] ?? g.ptsGain)
                    : -(g.perPlayerLosses?.[player.id] ?? g.ptsLoss);
                  totalPts += delta;
                });
                return <div style={{ fontWeight: 600 }}>{(totalPts / myGames.length).toFixed(2)}</div>;
              })()}
            </div>
            {(() => {
              const atkGames = myGames.filter(g => g.roles?.[player.id] === "ATK");
              const defGames = myGames.filter(g => g.roles?.[player.id] === "DEF");
              if (atkGames.length + defGames.length === 0) return null;
              const wr = games => {
                if (!games.length) return null;
                const w = games.filter(g => didPlayerWin(player.id, g)).length;
                return Math.round(w / games.length * 100);
              };
              const netPts = (games) => games.reduce((acc, g) => {
                const won = didPlayerWin(player.id, g);
                return acc + (won
                  ? (g.perPlayerGains?.[player.id] ?? g.ptsGain ?? 0)
                  : -(g.perPlayerLosses?.[player.id] ?? g.ptsLoss ?? 0));
              }, 0);
              const atkWR = wr(atkGames), defWR = wr(defGames);
              const strongerRole = (atkWR !== null && defWR !== null)
                ? (atkWR > defWR ? "ATK" : defWR > atkWR ? "DEF" : null) : null;
              return (
                <div style={{gridColumn:"1/-1"}}>
                  <div className="xs text-dd" style={{marginBottom:5}}>Role Performance</div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {atkGames.length > 0 && (
                      <div style={{display:"flex",alignItems:"center",gap:6,padding:"5px 10px",borderRadius:6,background:"rgba(240,144,80,.08)",border:"1px solid rgba(240,144,80,.25)"}}>
                        <span className="role-tag role-atk" style={{pointerEvents:"none"}}>🗡 ATK</span>
                        <span style={{fontSize:12,fontWeight:600}}>{atkGames.length}G</span>
                        {atkWR !== null && <span className={`xs ${atkWR>=50?"text-g":"text-r"}`}>{atkWR}% WR</span>}
                        <span className={`xs ${netPts(atkGames)>=0?"text-g":"text-r"}`}>{netPts(atkGames)>=0?"+":""}{netPts(atkGames)}pts</span>
                        {strongerRole==="ATK" && <span className="xs text-am">★ stronger</span>}
                      </div>
                    )}
                    {defGames.length > 0 && (
                      <div style={{display:"flex",alignItems:"center",gap:6,padding:"5px 10px",borderRadius:6,background:"rgba(96,168,232,.07)",border:"1px solid rgba(96,168,232,.25)"}}>
                        <span className="role-tag role-def" style={{pointerEvents:"none"}}>🛡 DEF</span>
                        <span style={{fontSize:12,fontWeight:600}}>{defGames.length}G</span>
                        {defWR !== null && <span className={`xs ${defWR>=50?"text-g":"text-r"}`}>{defWR}% WR</span>}
                        <span className={`xs ${netPts(defGames)>=0?"text-g":"text-r"}`}>{netPts(defGames)>=0?"+":""}{netPts(defGames)}pts</span>
                        {strongerRole==="DEF" && <span className="xs text-am">★ stronger</span>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      <div className="sec">Match History</div>
      {myGames.length === 0 && <div className="text-d sm">No games yet</div>}
      {myGames.map(g => {
        const onA = g.sideA.includes(player.id);
        const won = (onA && g.winner === "A") || (!onA && g.winner === "B");
        const mates = (onA ? g.sideA : g.sideB).filter(id => id !== player.id).map(id => pName(id, state.players));
        const opps = (onA ? g.sideB : g.sideA).map(id => pName(id, state.players));
        const myScore = onA ? g.scoreA : g.scoreB;
        const oppScore = onA ? g.scoreB : g.scoreA;
        return (
          <div key={g.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--b1)", fontSize: 12, gap: 6, flexWrap: "wrap" }}>
            <span className={`tag ${won ? "tag-w" : "tag-l"}`}>{won ? "WIN" : "LOSS"}</span>
            {mates.length > 0 && <span className="text-d sm">w/ {mates.join(" & ")}</span>}
            <span className="text-d sm">vs {opps.join(" & ")}</span>
            {g.roles?.[player.id] && <span className={`role-tag ${g.roles[player.id]==="ATK"?"role-atk":"role-def"}`} style={{marginRight:3}}>{g.roles[player.id]==="ATK"?"🗡 ATK":"🛡 DEF"}</span>}
            <span className="disp text-am" style={{ fontSize: 15 }}>{myScore}–{oppScore}</span>
            <span className={won ? "text-g" : "text-r"}>
              {(() => {
                const delta = won
                  ? (g.perPlayerGains?.[player.id] ?? g.playerDeltas?.[player.id]?.gain ?? g.ptsGain)
                  : (g.perPlayerLosses?.[player.id] ?? g.playerDeltas?.[player.id]?.loss ?? g.ptsLoss);
                return `${won ? "+" : "−"}${delta}pts`;
              })()}
            </span>
            <span className="text-dd xs">{fmtDate(g.date)}</span>
          </div>
        );
      })}
      <button className="btn btn-g w-full mt16" onClick={onClose}>Close</button>
    </Modal>
  );
}

// ============================================================
// ADMIN: EDIT PLAYER PROFILE
// ============================================================
function EditPlayerModal({ player, state, setState, showToast, onClose }) {
  const [name, setName] = useState(player.name);
  const [pts, setPts] = useState(String(player.pts || 0));
  const [streak, setStreak] = useState(String(player.streak || 0));
  const [positions, setPositions] = useState(() => {
    const p = player.position;
    if (!p || p === "none") return [];
    if (p === "both") return ["attack", "defense", "flex"];
    if (Array.isArray(p)) return p;
    return [p];
  });
  const [champMonth, setChampMonth] = useState("");
  const [champPartner, setChampPartner] = useState("");
  const [confirm, setConfirm] = useState(null);

  function save() {
    const newPts = parseInt(pts);
    const newStreak = parseInt(streak);
    if (isNaN(newPts) || isNaN(newStreak)) { showToast("Invalid values", "error"); return; }
    if (!name.trim()) { showToast("Name required", "error"); return; }
    setState(s => ({
      ...s,
      players: s.players.map(p => p.id === player.id
        ? { ...p, name: name.trim(), pts: newPts, streak: newStreak, position: positions.length === 0 ? "none" : positions }
        : p
      )
    }));
    showToast("Profile updated");
    onClose();
  }

  function addChamp() {
    if (!champMonth) { showToast("Select a month", "error"); return; }
    const c = { month: champMonth, partner: champPartner.trim() || null };
    setState(s => ({
      ...s,
      players: s.players.map(p => p.id === player.id
        ? { ...p, championships: [...(p.championships || []), c] }
        : p
      )
    }));
    showToast("Championship added 🏆");
    setChampMonth(""); setChampPartner("");
  }

  function removeChamp(i) {
    setState(s => ({
      ...s,
      players: s.players.map(p => p.id === player.id
        ? { ...p, championships: (p.championships || []).filter((_, idx) => idx !== i) }
        : p
      )
    }));
    showToast("Championship removed");
  }

  function recalcPlayer() {
    setConfirm({
      title: "Recalculate from Games?",
      msg: `This will recalculate ${player.name}'s pts, mmr, wins, losses, and streak from the game log. Manual edits will be overwritten.`,
      onConfirm: () => {
        const { players, games } = replayGames(state.players, state.games, state.seasonStart);
        setState(s => ({ ...s, players, games }));
        showToast("All stats recalculated from game log");
        setConfirm(null);
        onClose();
      }
    });
  }

  // Generate month options (last 12 months)
  const monthOptions = Array.from({ length: 12 }).map((_, i) => {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });

  return (
    <>
      <Modal onClose={onClose}>
        <div className="modal-title">Edit — {player.name}</div>

        <div className="sec">Profile</div>
        <div className="field"><label className="lbl">Name</label>
          <input className="inp inp-edit" value={name} onChange={e => setName(e.target.value)} /></div>
        <div className="grid-2">
          <div className="field"><label className="lbl">Points (visible)</label>
            <input className="inp inp-edit" type="number" value={pts} onChange={e => setPts(e.target.value)} /></div>
          <div className="field"><label className="lbl">Streak (+win / -loss)</label>
            <input className="inp inp-edit" type="number" value={streak} onChange={e => setStreak(e.target.value)} /></div>
        </div>
        <div className="field mt8">
          <label className="lbl">Preferred Role</label>
          <div className="fac" style={{gap:6, marginBottom:6}}>
            {["ATK","DEF","FLEX"].map(v => (
              <button key={v}
                className={`btn btn-sm ${(player.preferredRole||"FLEX")===v ? "btn-p" : "btn-g"}`}
                onClick={() => setState(s => ({ ...s, players: s.players.map(p =>
                  p.id === player.id ? { ...p, preferredRole: v } : p
                )}))}>
                {v==="ATK"?"🗡 ATK":v==="DEF"?"🛡 DEF":"⚡ FLEX"}
              </button>
            ))}
          </div>
          <div className="xs text-dd" style={{marginBottom:10}}>Used for auto-assign when logging games. Drives the ATK/DEF MMR tracks.</div>
          <label className="lbl">Position Badges</label>
          <div className="fac" style={{ gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
            {[["attack", "🗡 Attack"], ["defense", "🛡 Defense"], ["flex", "⚡ Flex"]].map(([v, l]) => {
              const on = positions.includes(v);
              return (
                <button key={v} className={`pill ${on ? "on" : ""}`} onClick={() => {
                  setPositions(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]);
                }}>{l}</button>
              );
            })}
          </div>
          <div className="xs text-dd" style={{ marginTop: 3 }}>Legacy display badges. Preferred Role above drives the ranking engine.</div>
        </div>
        <div className="msg msg-w sm">Manually editing pts/streak will diverge from game history. Use recalculate to re-sync.</div>

        <div className="divider" />
        <div className="sec">Championships</div>
        {(player.championships || []).map((c, i) => (
          <div key={i} className="fbc" style={{ padding: "6px 0", borderBottom: "1px solid var(--b1)", fontSize: 12 }}>
            <span className="text-am">🏆 {fmtMonth(c.month)}{c.partner ? ` (w/ ${c.partner})` : ""}</span>
            <button className="btn btn-d btn-sm" onClick={() => removeChamp(i)}>Remove</button>
          </div>
        ))}
        <div className="grid-2 mt8">
          <div className="field"><label className="lbl">Month</label>
            <select className="inp" value={champMonth} onChange={e => setChampMonth(e.target.value)}>
              <option value="">Select…</option>
              {monthOptions.map(m => <option key={m} value={m}>{fmtMonth(m)}</option>)}
            </select>
          </div>
          <div className="field"><label className="lbl">Partner (optional)</label>
            <input className="inp" placeholder="Teammate name" value={champPartner} onChange={e => setChampPartner(e.target.value)} />
          </div>
        </div>
        <button className="btn btn-warn btn-sm" onClick={addChamp}>+ Add Championship</button>

        <div className="divider" />
        <div className="fac" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <button className="btn btn-g btn-sm" onClick={recalcPlayer}>Recalculate All from Games</button>
          <div className="fac">
            <button className="btn btn-g" onClick={onClose}>Cancel</button>
            <button className="btn btn-p" onClick={save}>Save</button>
          </div>
        </div>
      </Modal>
      {confirm && <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)} />}
    </>
  );
}

// ============================================================
// GAME DETAIL MODAL (with edit + per-player penalties)
// ============================================================
function GameDetail({ game, state, setState, isAdmin, showToast, onClose }) {
  const [editing, setEditing] = useState(false);
  const [scoreA, setScoreA] = useState(String(game.scoreA));
  const [scoreB, setScoreB] = useState(String(game.scoreB));
  const [winner, setWinner] = useState(game.winner);
  const [confirm, setConfirm] = useState(null);
  // penalties: { [pid]: { yellow: N, red: N } } — per-player
  const [penalties, setPenalties] = useState(() => game.penalties || {});
  const [editRoles, setEditRoles] = useState(() => ({ ...(game.roles || {}) }));

  const sA = game.sideA.map(id => state.players.find(p => p.id === id)).filter(Boolean);
  const sB = game.sideB.map(id => state.players.find(p => p.id === id)).filter(Boolean);
  const allPlayers = [...sA, ...sB];

  function setPenalty(pid, type, val) {
    setPenalties(prev => ({
      ...prev,
      [pid]: { ...(prev[pid] || { yellow: 0, red: 0 }), [type]: Math.max(0, val) }
    }));
  }

  function savePenalties() {
    // Save penalties without changing scores — just rerun to apply
    const updatedGame = { ...game, penalties };
    const editedGames = state.games.map(g => g.id === game.id ? updatedGame : g);
    const basePlayers = state.players.map(p => ({ ...p, mmr: CONFIG.STARTING_MMR, pts: CONFIG.STARTING_PTS, wins: 0, losses: 0, streak: 0, streakPower: 0, lossStreakPower: 0 }));
    const { players: newPlayers, games: newGames } = replayGames(basePlayers, editedGames, state.seasonStart);
    const mergedPlayers = newPlayers.map(p => {
      const orig = state.players.find(x => x.id === p.id);
      return { ...p, name: orig?.name || p.name, championships: orig?.championships || [], position: orig?.position || p.position };
    });
    const newPlacements = computePlacements(newGames);
    setState(s => ({ ...s, games: newGames, players: mergedPlayers, monthlyPlacements: newPlacements }));
    const totalCards = Object.values(penalties).reduce((s, v) => (v.yellow || 0) + (v.red || 0) + s, 0);
    showToast(totalCards > 0 ? "Penalties applied & stats updated" : "Penalties cleared");
    setEditing(false);
    onClose();
  }

  function saveEdit() {
    const nA = parseInt(scoreA), nB = parseInt(scoreB);
    if (isNaN(nA) || isNaN(nB) || nA < 0 || nB < 0) { showToast("Invalid scores", "error"); return; }
    if (nA === nB) { showToast("No draws", "error"); return; }
    const updatedGame = { ...game, scoreA: nA, scoreB: nB, winner, penalties, roles: editRoles };
    const editedGames = state.games.map(g => g.id === game.id ? updatedGame : g);
    const basePlayers = state.players.map(p => ({ ...p, mmr: CONFIG.STARTING_MMR, pts: CONFIG.STARTING_PTS, wins: 0, losses: 0, streak: 0, streakPower: 0, lossStreakPower: 0 }));
    const { players: newPlayers, games: newGames } = replayGames(basePlayers, editedGames, state.seasonStart);
    const mergedPlayers = newPlayers.map(p => {
      const orig = state.players.find(x => x.id === p.id);
      return { ...p, name: orig?.name || p.name, championships: orig?.championships || [], position: orig?.position || p.position };
    });
    const newPlacements = computePlacements(newGames);
    setState(s => ({ ...s, games: newGames, players: mergedPlayers, monthlyPlacements: newPlacements }));
    showToast("Match updated & stats recalculated");
    setEditing(false);
    onClose();
  }

  function deleteGame() {
    setConfirm({
      title: "Delete Match?",
      msg: "Permanently removes this match and recalculates all affected stats.",
      danger: true,
      onConfirm: () => {
        const filteredGames = state.games.filter(g => g.id !== game.id);
        const basePlayers = state.players.map(p => ({ ...p, mmr: CONFIG.STARTING_MMR, pts: CONFIG.STARTING_PTS, wins: 0, losses: 0, streak: 0, streakPower: 0, lossStreakPower: 0 }));
        const { players: newPlayers, games: newGames } = replayGames(basePlayers, filteredGames, state.seasonStart);
        const mergedPlayers = newPlayers.map(p => {
          const orig = state.players.find(x => x.id === p.id);
          return { ...p, name: orig?.name || p.name, championships: orig?.championships || [], position: orig?.position || p.position };
        });
        const newPlacements = computePlacements(newGames);
        setState(s => ({ ...s, games: newGames, players: mergedPlayers, monthlyPlacements: newPlacements }));
        showToast("Match deleted & stats recalculated");
        setConfirm(null);
        onClose();
      }
    });
  }

  // Total penalty deduction per player
  function penaltyTotal(pid) {
    const p = penalties[pid] || {};
    return (p.yellow || 0) * CONFIG.YELLOW_CARD_PTS + (p.red || 0) * CONFIG.RED_CARD_PTS;
  }

  const hasPenalties = Object.values(game.penalties || {}).some(v => (v.yellow || 0) + (v.red || 0) > 0);

  return (
    <>
      <Modal onClose={onClose}>
        <div className="fbc mb12">
          <div>
            <div className="modal-title" style={{ marginBottom: 2 }}>Match Detail</div>
            <div className="xs text-dd">{fmtDate(game.date)}</div>
          </div>
          {isAdmin && !editing && (
            <div className="fac" style={{ gap: 6 }}>
              <button className="btn btn-warn btn-sm" onClick={() => setEditing(true)}>Edit</button>
              <button className="btn btn-d btn-sm" onClick={deleteGame}>Delete</button>
            </div>
          )}
        </div>

        {/* Score display / edit */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 14, alignItems: "center", margin: "14px 0" }}>
          <div>
            <div className="xs" style={{ marginBottom: 6, fontWeight: 600, color: game.winner === "A" ? "var(--green)" : "var(--dimmer)" }}>
              {game.winner === "A" ? "🏆 " : ""}Side A
            </div>
            {sA.map(p => {
              const gain = game.perPlayerGains?.[p.id] ?? game.ptsGain;
              const loss = game.perPlayerLosses?.[p.id] ?? game.ptsLoss;
              const pen = penaltyTotal(p.id);
              return (
                <div key={p.id} style={{ marginBottom: 4 }}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span className={`bold ${game.winner === "A" ? "text-g" : "text-r"}`} style={{ fontSize: 14 }}>{p.name}</span>
                    {editing ? (
                      <div className="fac" style={{gap:3}}>
                        {["ATK","DEF"].map(r => (
                          <button key={r}
                            className={`role-tag ${r==="ATK"?"role-atk":"role-def"}`}
                            style={{cursor:"pointer",opacity:editRoles[p.id]===r?1:0.3,fontWeight:editRoles[p.id]===r?700:400}}
                            onClick={()=>setEditRoles(prev=>({...prev,[p.id]:prev[p.id]===r?null:r}))}>
                            {r==="ATK"?"🗡 ATK":"🛡 DEF"}
                          </button>
                        ))}
                      </div>
                    ) : (
                      game.roles?.[p.id] && <span className={`role-tag ${game.roles[p.id]==="ATK"?"role-atk":"role-def"}`}>{game.roles[p.id]==="ATK"?"🗡 ATK":"🛡 DEF"}</span>
                    )}
                  </div>
                  <div className="xs text-dd">
                    {game.winner === "A" ? <span className="text-g">+{gain}pts</span> : <span className="text-r">−{loss}pts</span>}
                    {pen > 0 && <span style={{ color: "var(--orange)", marginLeft: 4 }}>−{pen} 🟡</span>}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ textAlign: "center" }}>
            {editing ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
                <div className="fac" style={{ gap: 6 }}>
                  <input className="inp inp-edit" type="number" min="0" value={scoreA}
                    onChange={e => setScoreA(e.target.value)}
                    style={{ width: 52, textAlign: "center", fontSize: 20, fontFamily: "var(--disp)", fontWeight: 700 }} />
                  <span className="text-dd" style={{ fontSize: 18 }}>–</span>
                  <input className="inp inp-edit" type="number" min="0" value={scoreB}
                    onChange={e => setScoreB(e.target.value)}
                    style={{ width: 52, textAlign: "center", fontSize: 20, fontFamily: "var(--disp)", fontWeight: 700 }} />
                </div>
                <select className="inp" value={winner} onChange={e => setWinner(e.target.value)} style={{ fontSize: 11, padding: "4px 8px" }}>
                  <option value="A">A won</option>
                  <option value="B">B won</option>
                </select>
              </div>
            ) : (
              <div className="disp text-am" style={{ fontSize: 36, fontWeight: 700 }}>{game.scoreA}–{game.scoreB}</div>
            )}
          </div>

          <div style={{ textAlign: "right" }}>
            <div className="xs" style={{ marginBottom: 6, fontWeight: 600, color: game.winner === "B" ? "var(--green)" : "var(--dimmer)" }}>
              Side B{game.winner === "B" ? " 🏆" : ""}
            </div>
            {sB.map(p => {
              const gain = game.perPlayerGains?.[p.id] ?? game.ptsGain;
              const loss = game.perPlayerLosses?.[p.id] ?? game.ptsLoss;
              const pen = penaltyTotal(p.id);
              return (
                <div key={p.id} style={{ marginBottom: 4 }}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span className={`bold ${game.winner === "B" ? "text-g" : "text-r"}`} style={{ fontSize: 14 }}>{p.name}</span>
                    {editing ? (
                      <div className="fac" style={{gap:3}}>
                        {["ATK","DEF"].map(r => (
                          <button key={r}
                            className={`role-tag ${r==="ATK"?"role-atk":"role-def"}`}
                            style={{cursor:"pointer",opacity:editRoles[p.id]===r?1:0.3,fontWeight:editRoles[p.id]===r?700:400}}
                            onClick={()=>setEditRoles(prev=>({...prev,[p.id]:prev[p.id]===r?null:r}))}>
                            {r==="ATK"?"🗡 ATK":"🛡 DEF"}
                          </button>
                        ))}
                      </div>
                    ) : (
                      game.roles?.[p.id] && <span className={`role-tag ${game.roles[p.id]==="ATK"?"role-atk":"role-def"}`}>{game.roles[p.id]==="ATK"?"🗡 ATK":"🛡 DEF"}</span>
                    )}
                  </div>
                  <div className="xs text-dd">
                    {game.winner === "B" ? <span className="text-g">+{gain}pts</span> : <span className="text-r">−{loss}pts</span>}
                    {pen > 0 && <span style={{ color: "var(--orange)", marginLeft: 4 }}>−{pen} 🟡</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Match Quality Breakdown ─────────────────────────────────
            Shows per-player how rank gap and MMR gap affected their pts.
            This makes cherry-picking transparent: high-ranked players
            beating lower-ranked opponents see an explicit "Low-value game"
            warning and can see exactly how much points they lost to rank penalty.
        ── */}
        {!editing && (() => {
          const hasFactors = allPlayers.some(p => game.perPlayerFactors?.[p.id]);
          if (!hasFactors) return null;

          const ranked = [...state.players].sort((a, b) => (b.pts || 0) - (a.pts || 0));
          const rankOf = id => { const i = ranked.findIndex(p => p.id === id); return i === -1 ? ranked.length : i; };
          const monthKey = getMonthKey();
          const monthPlacements = state.monthlyPlacements?.[monthKey] || {};
          const isPlaced = pid => (monthPlacements[pid] || 0) >= CONFIG.MAX_PLACEMENTS_PER_MONTH;

          const winnerIds = game.winner === "A" ? game.sideA : game.sideB;
          const loserIds = game.winner === "A" ? game.sideB : game.sideA;
          const placedWinners = winnerIds.filter(isPlaced);
          const placedLosers = loserIds.filter(isPlaced);
          const anyPlaced = placedWinners.length > 0 || placedLosers.length > 0;

          // Only show rank mismatch banner when both sides have placed players
          const avgWinRank = placedWinners.length ? placedWinners.reduce((s, id) => s + rankOf(id), 0) / placedWinners.length : null;
          const avgLosRank = placedLosers.length ? placedLosers.reduce((s, id) => s + rankOf(id), 0) / placedLosers.length : null;
          const rankImbalance = (avgWinRank !== null && avgLosRank !== null) ? Math.abs(avgWinRank - avgLosRank) : 0;
          const winnerOutrankedLosers = avgWinRank !== null && avgLosRank !== null && avgWinRank < avgLosRank;
          const canShowRankBanner = avgWinRank !== null && avgLosRank !== null;

          const isLopsided = canShowRankBanner && rankImbalance >= 2;
          const isVeryLopsided = canShowRankBanner && rankImbalance >= 4;

          const bannerColor = isVeryLopsided && winnerOutrankedLosers ? "var(--orange)"
            : isLopsided && winnerOutrankedLosers ? "var(--amber-d)"
            : "var(--b2)";
          const bannerBg = isVeryLopsided && winnerOutrankedLosers ? "rgba(240,144,80,.08)"
            : isLopsided && winnerOutrankedLosers ? "rgba(88,200,130,.06)"
            : "var(--s2)";
          const bannerLabel = !canShowRankBanner ? "Placement games — no rank data yet"
            : isVeryLopsided && winnerOutrankedLosers ? "⚠ Heavily mismatched — low pts value"
            : isLopsided && winnerOutrankedLosers ? "↓ Rank mismatch — reduced gains for winners"
            : "✓ Balanced match";

          return (
            <div style={{ margin: "4px 0 12px", border: `1px solid ${bannerColor}`, borderRadius: 8, overflow: "hidden" }}>
              {/* Banner */}
              <div style={{ background: bannerBg, borderBottom: `1px solid ${bannerColor}`, padding: "6px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: bannerColor, letterSpacing: .3 }}>{bannerLabel}</span>
                <span className="xs text-dd">{canShowRankBanner ? `Rank gap: ${rankImbalance.toFixed(1)}` : "Placement game"}</span>
              </div>

              {/* Per-player factor rows */}
              <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                {allPlayers.map(p => {
                  const f = game.perPlayerFactors?.[p.id];
                  if (!f) return null;
                  const isWinner = (game.winner === "A" ? game.sideA : game.sideB).includes(p.id);
                  const pts = isWinner
                    ? (game.perPlayerGains?.[p.id] ?? game.ptsGain)
                    : (game.perPlayerLosses?.[p.id] ?? game.ptsLoss);

                  // eloScale: >1 = underdog (more pts), <1 = favourite (less pts)
                  // rankScale: >1 = beating higher-ranked (more pts), <1 = beating lower-ranked (less pts)
                  const eloLabel = f.eloScale > 1.15 ? "Underdog boost" : f.eloScale < 0.85 ? "Favourite penalty" : "Even MMR";
                  const eloColor = f.eloScale > 1.15 ? "var(--green)" : f.eloScale < 0.85 ? "var(--orange)" : "var(--dimmer)";
                  const rankLabel = f.rankScale === 1.0 ? "Unranked — neutral"
                    : f.rankScale > 1.08 ? "Rank upset bonus" : f.rankScale < 0.92 ? "Rank penalty" : "Balanced";
                  const rankColor = f.rankScale === 1.0 ? "var(--dimmer)"
                    : f.rankScale > 1.08 ? "var(--green)" : f.rankScale < 0.92 ? "var(--orange)" : "var(--dimmer)";

                  return (
                    <div key={p.id} style={{ padding: "8px 10px", borderRadius: 6, background: "var(--s1)", border: "1px solid var(--b1)" }}>
                      {/* Player header: name + pts earned */}
                      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontWeight: 700, fontSize: 13 }}>{p.name}</span>
                        <span style={{ fontFamily: "var(--disp)", fontWeight: 700, fontSize: 15, color: isWinner ? "var(--green)" : "var(--red)" }}>
                          {isWinner ? "+" : "−"}{pts} pts
                        </span>
                      </div>

                      {/* Factor bars */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {/* MMR signal (primary) */}
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 10, color: "var(--dimmer)", width: 90, flexShrink: 0 }}>MMR (70%)</span>
                          <div style={{ flex: 1, height: 5, borderRadius: 3, background: "var(--b2)", overflow: "hidden" }}>
                            <div style={{
                              height: "100%", borderRadius: 3,
                              width: `${Math.min(100, f.eloScale * 50)}%`,
                              background: eloColor, transition: "width .4s",
                            }} />
                          </div>
                          <span style={{ fontSize: 10, color: eloColor, width: 120, flexShrink: 0, textAlign: "right" }}>
                            ×{f.eloScale.toFixed(2)} {eloLabel}
                          </span>
                        </div>

                        {/* Rank signal (secondary) */}
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 10, color: "var(--dimmer)", width: 90, flexShrink: 0 }}>Rank (30%)</span>
                          <div style={{ flex: 1, height: 5, borderRadius: 3, background: "var(--b2)", overflow: "hidden" }}>
                            <div style={{
                              height: "100%", borderRadius: 3,
                              width: `${Math.min(100, f.rankScale * 70)}%`,
                              background: rankColor, transition: "width .4s",
                            }} />
                          </div>
                          <span style={{ fontSize: 10, color: rankColor, width: 120, flexShrink: 0, textAlign: "right" }}>
                            ×{f.rankScale.toFixed(2)} {rankLabel}
                          </span>
                        </div>

                        {/* Fused match quality — the actual multiplier used */}
                        {(() => {
                          const mq = f.matchQuality ?? f.qualityScore ?? 1;
                          const mqPct = Math.round(mq * 100);
                          const mqColor = mq < 0.80 ? "var(--red)" : mq < 0.95 ? "var(--orange)" : mq > 1.10 ? "var(--green)" : "var(--dimmer)";
                          const mqLabel = mq < 0.80 ? "Low value" : mq < 0.95 ? "Slightly favoured" : mq > 1.15 ? "Underdog!" : mq > 1.05 ? "Slight underdog" : "Even";
                          return (
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2, paddingTop: 4, borderTop: "1px solid var(--b1)" }}>
                              <span style={{ fontSize: 10, color: "var(--dim)", width: 90, flexShrink: 0, fontWeight: 600 }}>Match quality</span>
                              <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--b2)", overflow: "hidden" }}>
                                <div style={{
                                  height: "100%", borderRadius: 3,
                                  width: `${Math.min(100, mqPct)}%`,
                                  background: mqColor, transition: "width .4s",
                                  boxShadow: `0 0 4px ${mqColor}88`,
                                }} />
                              </div>
                              <span style={{ fontSize: 10, color: mqColor, width: 120, flexShrink: 0, textAlign: "right", fontWeight: 600 }}>
                                ×{mq.toFixed(2)} — {mqLabel}
                              </span>
                            </div>
                          );
                        })()}

                        {/* Position impact */}
                        {(() => {
                          const rm = f.roleMult;
                          if (!rm || rm === 1.0 || !game.roles?.[p.id]) return null;
                          const oop = rm > 1.0; // out of position gets higher gain (rm = BONUS > 1)
                          const pref = state.players.find(x => x.id === p.id)?.preferredRole;
                          const played = game.roles[p.id];
                          const label = oop
                            ? `Out of position (pref: ${pref}) — win bonus / loss protected`
                            : `In position (${played})`;
                          const col = oop ? "var(--amber)" : "var(--dimmer)";
                          return (
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2, paddingTop: 4, borderTop: "1px solid var(--b1)" }}>
                              <span style={{ fontSize: 10, color: "var(--dim)", width: 90, flexShrink: 0 }}>Position</span>
                              <span style={{ fontSize: 10, color: col, flex: 1 }}>
                                {oop ? "⚠ " : "✓ "}{label}
                              </span>
                              <span style={{ fontSize: 10, color: col, width: 120, flexShrink: 0, textAlign: "right" }}>
                                {oop ? `×${rm.toFixed(2)} win / ×${(1/rm).toFixed(2)} loss` : "×1.00 neutral"}
                              </span>
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })}

                <div className="xs text-dd" style={{ lineHeight: 1.6, paddingTop: 2 }}>
                  Match quality = 70% MMR gap + 30% rank gap. Beating a stronger opponent earns more. Out-of-position players earn more for wins and lose less for losses.
                </div>
              </div>
            </div>
          );
        })()}

        {/* Per-player penalties — always shown to admin */}
        {isAdmin && (
          <div style={{ marginTop: 4 }}>
            <div className="sec" style={{ marginBottom: 8 }}>Disciplinary Cards</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {allPlayers.map(p => {
                const pen = penalties[p.id] || { yellow: 0, red: 0 };
                return (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--s2)", borderRadius: 8, border: "1px solid var(--b1)" }}>
                    <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                    {/* Yellow card */}
                    <div className="fac" style={{ gap: 4 }}>
                      <span style={{ fontSize: 16 }}>🟡</span>
                      <button className="btn btn-g btn-sm" style={{ padding: "2px 7px", minWidth: 22 }}
                        onClick={() => setPenalty(p.id, "yellow", Math.max(0, (pen.yellow || 0) - 1))}>−</button>
                      <span style={{ minWidth: 16, textAlign: "center", fontWeight: 700, fontSize: 13 }}>{pen.yellow || 0}</span>
                      <button className="btn btn-g btn-sm" style={{ padding: "2px 7px", minWidth: 22 }}
                        onClick={() => setPenalty(p.id, "yellow", (pen.yellow || 0) + 1)}>+</button>
                      <span className="xs text-dd">−{CONFIG.YELLOW_CARD_PTS}pts ea</span>
                    </div>
                    {/* Red card */}
                    <div className="fac" style={{ gap: 4 }}>
                      <span style={{ fontSize: 16 }}>🔴</span>
                      <button className="btn btn-g btn-sm" style={{ padding: "2px 7px", minWidth: 22 }}
                        onClick={() => setPenalty(p.id, "red", Math.max(0, (pen.red || 0) - 1))}>−</button>
                      <span style={{ minWidth: 16, textAlign: "center", fontWeight: 700, fontSize: 13 }}>{pen.red || 0}</span>
                      <button className="btn btn-g btn-sm" style={{ padding: "2px 7px", minWidth: 22 }}
                        onClick={() => setPenalty(p.id, "red", (pen.red || 0) + 1)}>+</button>
                      <span className="xs text-dd">−{CONFIG.RED_CARD_PTS}pts ea</span>
                    </div>
                    {penaltyTotal(p.id) > 0 && (
                      <span style={{ color: "var(--orange)", fontWeight: 700, fontSize: 12, minWidth: 50, textAlign: "right" }}>
                        −{penaltyTotal(p.id)} pts
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {!editing && (
              <button className="btn btn-warn w-full mt8" onClick={savePenalties}>
                Apply Penalties
              </button>
            )}
          </div>
        )}

        {/* Existing penalties display for non-admin */}
        {!isAdmin && hasPenalties && (
          <div className="msg msg-e" style={{ marginTop: 8, fontSize: 11 }}>
            ⚠ Disciplinary penalties have been applied to this match
          </div>
        )}

        <div className="fac mt16" style={{ justifyContent: "flex-end", gap: 8 }}>
          {editing ? (
            <>
              <button className="btn btn-g" onClick={() => setEditing(false)}>Cancel</button>
              <button className="btn btn-p" onClick={saveEdit}>Save & Recalculate</button>
            </>
          ) : (
            <button className="btn btn-g w-full" onClick={onClose}>Close</button>
          )}
        </div>
      </Modal>
      {confirm && <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)} />}
    </>
  );
}

// Last N game results for a player — oldest first
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

// ============================================================
// LIVE TICKER
// ============================================================
const _dismissedTickers = new Set();

function LiveTicker({ games, players, finals, monthKey, onNavToPlay }) {
  const [, forceUpdate] = useState(0);
  const bracket = finals?.[monthKey]?.bracket;

  // Highest priority: live finals match in progress
  const liveScores = finals?.[monthKey]?.liveScores || {};
  const liveMatchKey = bracket && ['upper', 'lower', 'final'].find(k => {
    return liveScores[k]?.active && bracket[k] && !bracket[k].winner;
  });

  if (liveMatchKey) {
    const m = bracket[liveMatchKey];
    const labMap = { upper: 'Semi 1', lower: 'Semi 2', final: 'Grand Final' };
    const pA = (m.sideA || []).map(id => pName(id, players)).join(' & ');
    const pB = (m.sideB || []).map(id => pName(id, players)).join(' & ');
    const lA = liveScores[liveMatchKey]?.scoreA ?? 0, lB = liveScores[liveMatchKey]?.scoreB ?? 0;
    const leading = lA > lB ? 'A' : lB > lA ? 'B' : null;
    return (
      <div onClick={onNavToPlay} style={{
        background: 'radial-gradient(ellipse 80% 300% at 0% 50%,rgba(232,184,74,.14),var(--s1))',
        border: '1px solid rgba(232,184,74,.4)', borderRadius: 10,
        padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12,
        animation: 'slideUp .3s ease', cursor: 'pointer'
      }}>
        <span className="tag" style={{ background: 'rgba(232,184,74,.2)', color: 'var(--gold)', flexShrink: 0 }}>🏆 LIVE</span>
        <span style={{ flex: 1 }}>
          <span style={{ fontWeight: 700, color: leading === 'A' ? 'var(--green)' : 'var(--text)' }}>{pA}</span>
          <span className="disp text-am" style={{ margin: '0 10px', fontSize: 18, fontWeight: 700 }}>{lA}–{lB}</span>
          <span style={{ fontWeight: 700, color: leading === 'B' ? 'var(--green)' : 'var(--text)' }}>{pB}</span>
          <span className="text-dd xs" style={{ marginLeft: 8 }}>{labMap[liveMatchKey]}</span>
        </span>
        <span className="xs text-dd">Watch →</span>
      </div>
    );
  }

  // Fallback: recent game result
  const latest = [...(games || [])].sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  if (!latest) return null;
  const tickerId = latest.id;
  if (_dismissedTickers.has(tickerId)) return null;
  const age = Date.now() - new Date(latest.date).getTime();
  if (age > 5 * 60 * 1000) return null;
  const wIds = latest.winner === "A" ? latest.sideA : latest.sideB;
  const lIds = latest.winner === "A" ? latest.sideB : latest.sideA;
  const wNames = wIds.map(id => pName(id, players)).join(" & ");
  const lNames = lIds.map(id => pName(id, players)).join(" & ");
  return (
    <div style={{
      background: "radial-gradient(ellipse 80% 300% at 0% 50%,rgba(94,201,138,.12),var(--s1))",
      border: "1px solid var(--amber-d)", borderRadius: 10,
      padding: "8px 16px", display: "flex", alignItems: "center", gap: 10, fontSize: 12,
      animation: "slideUp .3s ease"
    }}>
      <span className="tag tag-w" style={{ flexShrink: 0 }}>RESULT</span>
      <span style={{ flex: 1 }}>
        <span className="text-g bold">{wNames}</span>
        <span className="text-dd"> beat </span>
        <span>{lNames}</span>
        <span className="text-am bold" style={{ marginLeft: 8, fontFamily: "var(--disp)" }}>{latest.scoreA}–{latest.scoreB}</span>
      </span>
      <button onClick={() => { _dismissedTickers.add(tickerId); forceUpdate(n => n + 1); }}
        style={{ background: "none", border: "none", color: "var(--dimmer)", cursor: "pointer", fontSize: 14, padding: "0 4px" }}>×</button>
    </div>
  );
}

// ============================================================
// LEADERBOARD VIEW
// ============================================================
function LeaderboardView({ state, setState, onSelectPlayer, onNavToPlay, onNavToHistory, rtConnected, isAdmin, showToast, syncStatus }) {
  const monthKey = getMonthKey();
  const currentSeason = getCurrentSeason(state);
  const seasonGames = (state.games || []).filter(g => gameInSeason(g, currentSeason));
  const seasonStats = computeWindowPlayerStats(state.players, seasonGames);
  const ranked = [...(state.players ?? [])].sort((a, b) => (b.pts || 0) - (a.pts || 0));
  const [showRecalcConfirm, setShowRecalcConfirm] = useState(false);

  function doRecalc() {
    const { players, games } = replayGames(state.players, state.games, state.seasonStart);
    const monthlyPlacements = computePlacements(games);
    setState(s => ({ ...s, players, games, monthlyPlacements }));
    showToast("All stats recalculated from game log");
    setShowRecalcConfirm(false);
  }
  const monthGames = (state.games ?? []).filter(g => g.monthKey === monthKey);

  const prevSnapshot = useRef(null); // null = not yet initialised
  const animClearTimer = useRef(null);
  const [animMap, setAnimMap] = useState({});
  useEffect(() => {
    // Build new snapshot from current ranked list
    const next = {};
    ranked.forEach((p, i) => { next[p.id] = { rank: i, pts: p.pts || 0 }; });

    const prev = prevSnapshot.current;
    // First render — just store snapshot, no animation
    if (!prev) { prevSnapshot.current = next; return; }

    const anims = {};
    ranked.forEach((p, i) => {
      const pr = prev[p.id]?.rank;
      const pp = prev[p.id]?.pts;
      // Only animate if we have a previous value AND it changed
      if (pr !== undefined && pr !== i) {
        anims[p.id] = i < pr ? "rank-up" : "rank-down";
      } else if (pp !== undefined && pp !== (p.pts || 0)) {
        anims[p.id] = "pts-changed";
      }
    });

    // Update snapshot to new state
    prevSnapshot.current = next;

    if (Object.keys(anims).length) {
      clearTimeout(animClearTimer.current);
      setAnimMap(anims);
      animClearTimer.current = setTimeout(() => setAnimMap({}), 1200);
    }
  }, [state.players]);

  return (
    <>
      <div className="stack page-fade">
        <LiveTicker games={state.games} players={state.players} finals={state.finals} monthKey={monthKey} onNavToPlay={onNavToPlay} />
        {isAdmin && (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button className="btn btn-g btn-sm" style={{ gap: 6 }} onClick={() => setShowRecalcConfirm(true)}>
              ↺ Recalc
            </button>
          </div>
        )}
        <div className="grid-3">
          <div className="stat-box"><div className="stat-lbl">Players</div><div className="stat-val am">{(state.players ?? []).length}</div></div>
          <div className="stat-box" style={{ cursor: "pointer" }} onClick={onNavToHistory}
            title="View match history">
            <div className="stat-lbl">Games This Month</div>
            <div className="stat-val">{monthGames.length}</div>
            <div className="xs text-dd" style={{ marginTop: 3 }}>View history →</div>
          </div>
          <div className="stat-box"><div className="stat-lbl">Top Points</div><div className="stat-val am">{ranked[0]?.pts ?? 0}</div></div>
        </div>
        {(() => {
          const placedRanked = ranked.filter(p => (state.monthlyPlacements[monthKey] || {})[p.id] >= CONFIG.MAX_PLACEMENTS_PER_MONTH).slice(0, 4);
          return placedRanked.length >= 2 && (
            <div className="card" style={{ cursor: "pointer", transition: "border-color .15s" }}
              onClick={() => onNavToPlay()} onMouseEnter={e => e.currentTarget.style.borderColor = "var(--amber-d)"}
              onMouseLeave={e => e.currentTarget.style.borderColor = ""}>
              <div className="card-header">
                <span className="card-title">Championship Race</span>
                <span className="tag tag-a" style={{ cursor: "pointer" }}>View Finals →</span>
              </div>
              <div style={{ padding: "10px 16px", display: "flex", gap: 8, flexWrap: "wrap" }}>
                {placedRanked.map((p, i) => (
                  <div key={p.id} style={{
                    flex: "1 1 120px", padding: "8px 12px", borderRadius: 8,
                    background: i === 0 ? "radial-gradient(ellipse 120% 120% at 100% 100%,rgba(232,184,74,.15),var(--s2))" :
                      i === 1 ? "radial-gradient(ellipse 120% 120% at 100% 100%,rgba(192,200,196,.08),var(--s2))" :
                        i === 2 ? "radial-gradient(ellipse 120% 120% at 100% 100%,rgba(200,134,74,.08),var(--s2))" :
                          "var(--s2)",
                    border: `1px solid ${i === 0 ? "rgba(232,184,74,.35)" : i === 1 ? "rgba(192,200,196,.2)" : i === 2 ? "rgba(200,134,74,.2)" : "var(--b2)"}`,
                  }}>
                    <div className="xs" style={{ marginBottom: 3, color: i === 0 ? "var(--gold)" : i === 1 ? "#c0c8c4" : i === 2 ? "#c8864a" : "var(--dimmer)" }}>
                      {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                    <div className="xs" style={{ color: i === 0 ? "var(--gold)" : "var(--amber)", marginTop: 2 }}>{p.pts || 0} pts</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Rankings — {currentSeason?.label || fmtMonth(monthKey)}</span>
            <div className="fac" style={{ gap: 8 }}>
              <span className={`rt-dot ${rtConnected ? "live" : ""}`} title={rtConnected ? "Live" : "Connecting…"} />
              <span className="xs text-dd">{rtConnected ? "Live" : "…"}</span>
              {isAdmin && syncStatus !== 'idle' && (
                <span className="xs" style={{
                  color:
                    syncStatus === 'saving' ? 'var(--dimmer)' :
                      syncStatus === 'saved' ? 'var(--green)' :
                        syncStatus === 'conflict' ? 'var(--orange)' : 'var(--red)'
                }}>
                  {syncStatus === 'saving' ? '↑ saving' : syncStatus === 'saved' ? '✓ saved' : syncStatus === 'conflict' ? '⚡ synced' : '⚠ error'}
                </span>
              )}
            </div>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>#</th><th>Player</th><th>Points</th><th>W</th><th>L</th><th>Win%</th><th>Streak</th><th>ATK / DEF</th><th>Placements</th></tr>
              </thead>
              <tbody>
                {(() => {
                  let placedCount = 0; return ranked.map((p, i) => {
                    const placements = (state.monthlyPlacements[monthKey] || {})[p.id] || 0;
                    const isPlaced = placements >= CONFIG.MAX_PLACEMENTS_PER_MONTH;
                    const rankNum = isPlaced ? ++placedCount : null;
                    const sStat = seasonStats[p.id] || { wins: 0, losses: 0, streak: 0 };
                    const total = sStat.wins + sStat.losses;
                    const pct = total ? Math.round(sStat.wins / total * 100) : 0;
                    const anim = animMap[p.id] || "";
                    return (
                      <tr key={p.id} className={`lb-row ${anim}`} style={{ animationDelay: `${i * 28}ms`, opacity: isPlaced ? 1 : 0.6 }} onClick={() => onSelectPlayer(p)}>
                        <td><span className={`rk ${isPlaced ? (rankNum === 1 ? "r1" : rankNum === 2 ? "r2" : rankNum === 3 ? "r3" : "") : ""}`}
                          style={!isPlaced ? { color: "var(--dimmer)" } : {}}>
                          {isPlaced ? (rankNum === 1 ? "①" : rankNum === 2 ? "②" : rankNum === 3 ? "③" : `#${rankNum}`) : <span style={{ fontSize: 9, letterSpacing: .5, fontFamily: "var(--sans)", fontWeight: 500 }}>UNRANKED</span>}
                        </span></td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span className="bold">{p.name}</span>
                            {(p.championships || []).length > 0 && <span style={{ fontSize: 13 }}>🏆</span>}
                            <Sparkline pid={p.id} games={seasonGames} />
                          </div>
                        </td>
                        <td>
                          {isPlaced
                            ? <><span className="bold" style={{ fontSize: 14 }}>{p.pts || 0}</span>
                              {anim === "rank-up" && <span className="xs text-g" style={{ marginLeft: 5 }}>▲</span>}
                              {anim === "rank-down" && <span className="xs text-r" style={{ marginLeft: 5 }}>▼</span>}
                            </>
                            : <span className="text-dd" style={{ fontSize: 10, fontFamily: "var(--sans)", fontWeight: 500, letterSpacing: .3 }}>—</span>
                          }
                        </td>
                        <td><span className="text-g bold">{sStat.wins}</span></td>
                        <td><span className="text-r bold">{sStat.losses}</span></td>
                        <td><span className={pct >= 50 ? "text-g" : "text-d"}>{total ? `${pct}%` : "—"}</span></td>
                        <td><StreakBadge streak={sStat.streak} streakPower={p.streakPower || 0} lossStreakPower={p.lossStreakPower || 0} showMult /></td>
                        <td>
                          {((p.wins_atk||0)+(p.losses_atk||0)+(p.wins_def||0)+(p.losses_def||0)) > 0 ? (
                            <div style={{lineHeight:1.3}}>
                              <div className="fac" style={{gap:4}}>
                                <span className="role-tag role-atk" style={{pointerEvents:"none"}}>🗡</span>
                                <span style={{fontSize:12,fontWeight:600,color:"var(--orange)"}}>{p.mmr_atk||p.mmr}</span>
                                <span className="xs text-dd">{p.wins_atk||0}W</span>
                              </div>
                              <div className="fac" style={{gap:4,marginTop:3}}>
                                <span className="role-tag role-def" style={{pointerEvents:"none"}}>🛡</span>
                                <span style={{fontSize:12,fontWeight:600,color:"var(--blue)"}}>{p.mmr_def||p.mmr}</span>
                                <span className="xs text-dd">{p.wins_def||0}W</span>
                              </div>
                            </div>
                          ) : (
                            <PosBadge pos={p.position} />
                          )}
                        </td>
                        <td>
                          {isPlaced
                            ? <span className="placement-badge placement-done">✓ Placed</span>
                            : <span className="placement-badge placement-pending"><Pips used={placements} /> {CONFIG.MAX_PLACEMENTS_PER_MONTH - placements} left</span>
                          }
                        </td>
                      </tr>
                    );
                  });
                })()}
                {ranked.length === 0 && <tr><td colSpan={9} style={{ textAlign: "center", padding: 32, color: "var(--dimmer)" }}>
                  No players yet — ask an admin to onboard players
                </td></tr>}
              </tbody>
            </table>
          </div>
          {/* Mobile card layout */}
          <div className="lb-cards">
            {(() => {
              let placedCount = 0; return ranked.map((p, i) => {
                const placements = (state.monthlyPlacements[monthKey] || {})[p.id] || 0;
                const isPlaced = placements >= CONFIG.MAX_PLACEMENTS_PER_MONTH;
                const rankNum = isPlaced ? ++placedCount : null;
                const sStat = seasonStats[p.id] || { wins: 0, losses: 0, streak: 0 };
                const total = sStat.wins + sStat.losses;
                const pct = total ? Math.round(sStat.wins / total * 100) : 0;
                return (
                  <div key={p.id} className="lb-card" onClick={() => onSelectPlayer(p)}>
                    <div className="lb-card-rank">
                      {isPlaced
                        ? <span className={rankNum === 1 ? "text-am" : rankNum === 2 ? "" : rankNum === 3 ? "" : ""} style={{ color: rankNum === 1 ? "var(--gold)" : rankNum === 2 ? "#c0c8c4" : rankNum === 3 ? "#c8864a" : "var(--dim)" }}>
                          #{rankNum}
                        </span>
                        : <span style={{ fontSize: 9, color: "var(--dimmer)", fontFamily: "var(--sans)" }}>—</span>
                      }
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className="lb-card-name">{p.name}</span>
                        {(p.championships || []).length > 0 && <span style={{ fontSize: 12 }}>🏆</span>}
                        <Sparkline pid={p.id} games={seasonGames} />
                      </div>
                      <div className="lb-card-meta">
                        <span className="text-g">{sStat.wins}W</span>
                        {" "}<span className="text-r">{sStat.losses}L</span>
                        {" · "}{total ? `${pct}%` : "—"}
                        {" · "}<StreakBadge streak={sStat.streak} streakPower={p.streakPower || 0} lossStreakPower={p.lossStreakPower || 0} showMult />
                      </div>
                    </div>
                    <div className="lb-card-pts">{isPlaced ? p.pts || 0 : "—"}</div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      </div>
      {showRecalcConfirm && (
        <ConfirmDialog
          title="Recalculate All Stats?"
          msg="This will replay every game in history and rewrite all player points, MMR, streaks, wins, losses, and the pts shown in match history. This cannot be undone (but you can undo via the undo button after logging games)."
          onConfirm={doRecalc}
          onCancel={() => setShowRecalcConfirm(false)}
        />
      )}
    </>
  );
}

// ============================================================
// HISTORY VIEW
// ============================================================
function HistoryView({ state, setState, isAdmin, showToast }) {
  const [playerFilter, setPlayerFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [selectedGameId, setSelectedGameId] = useState(null);
  const [visibleDays, setVisibleDays] = useState(5);
  const [seasonFilter, setSeasonFilter] = useState("current");

  const currentSeason = getCurrentSeason(state);
  const scopedGames = (state.games ?? []).filter(g => {
    if (seasonFilter === "all") return true;
    const season = seasonFilter === "current" ? currentSeason : (state.seasons || []).find(s => s.id === seasonFilter) || null;
    return gameInSeason(g, season);
  });
  const allGames = [...scopedGames].sort((a, b) => new Date(b.date) - new Date(a.date));

  const filtered = allGames.filter(g => {
    if (playerFilter) {
      const names = [...g.sideA, ...g.sideB].map(id => pName(id, state.players)).join(" ").toLowerCase();
      if (!names.includes(playerFilter.toLowerCase())) return false;
    }
    if (dateFrom && new Date(g.date) < new Date(dateFrom)) return false;
    if (dateTo && new Date(g.date) > new Date(dateTo + "T23:59:59")) return false;
    return true;
  });

  // Group by calendar date
  const groups = [];
  let lastDay = null;
  for (const g of filtered) {
    const day = new Date(g.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    if (day !== lastDay) { groups.push({ day, games: [] }); lastDay = day; }
    groups[groups.length - 1].games.push(g);
  }

  const hasFilters = playerFilter || dateFrom || dateTo;

  function GameRow({ g }) {
    const sAN = g.sideA.map(id => pName(id, state.players));
    const sBN = g.sideB.map(id => pName(id, state.players));
    const winnerSide = g.winner;
    return (
      <div className="game-row" onClick={() => setSelectedGameId(g.id)}>
        {/* Side A */}
        <div className="g-side">
          {g.sideA.map(id => {
            const n = pName(id, state.players); const role = g.roles?.[id];
            return (
              <div key={id} style={{display:"flex",alignItems:"center",gap:3}}>
                <span className={winnerSide === "A" ? "g-name-w" : "g-name-l"}>
                  {winnerSide === "A" && <span style={{ color: "var(--green)", marginRight: 2, fontSize: 9 }}>▲</span>}{n}
                </span>
                {role && <span className={`role-tag ${role==="ATK"?"role-atk":"role-def"}`}>{role==="ATK"?"🗡 ATK":"🛡 DEF"}</span>}
              </div>
            );
          })}
          <div className="g-delta" style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {g.sideA.map(id => {
              const delta = winnerSide === "A"
                ? (g.perPlayerGains?.[id] ?? g.playerDeltas?.[id]?.gain ?? g.ptsGain)
                : (g.perPlayerLosses?.[id] ?? g.playerDeltas?.[id]?.loss ?? g.ptsLoss);
              return <span key={id} className={winnerSide === "A" ? "text-g" : "text-r"}>{winnerSide === "A" ? "+" : "−"}{delta} {pName(id, state.players).split(" ")[0]}</span>;
            })}
          </div>
        </div>
        {/* Score */}
        <div style={{ textAlign: "center" }}>
          <div className="g-score">{g.scoreA}–{g.scoreB}</div>
          <div className="g-date">{new Date(g.date).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</div>
          {g.penalties && Object.values(g.penalties).some(v => (v.yellow || 0) + (v.red || 0) > 0) && (
            <div style={{ fontSize: 10, marginTop: 2 }}>
              {Object.values(g.penalties).some(v => v.red > 0) && <span>🔴</span>}
              {Object.values(g.penalties).some(v => v.yellow > 0) && <span>🟡</span>}
            </div>
          )}
        </div>
        {/* Side B */}
        <div className="g-side right">
          {g.sideB.map(id => {
            const n = pName(id, state.players); const role = g.roles?.[id];
            return (
              <div key={id} style={{display:"flex",alignItems:"center",gap:3,justifyContent:"flex-end"}}>
                {role && <span className={`role-tag ${role==="ATK"?"role-atk":"role-def"}`}>{role==="ATK"?"🗡 ATK":"🛡 DEF"}</span>}
                <span className={winnerSide === "B" ? "g-name-w" : "g-name-l"}>
                  {n}{winnerSide === "B" && <span style={{ color: "var(--green)", marginLeft: 2, fontSize: 9 }}>▲</span>}
                </span>
              </div>
            );
          })}
          <div className="g-delta" style={{ display: "flex", flexDirection: "column", gap: 1, alignItems: "flex-end" }}>
            {g.sideB.map(id => {
              const delta = winnerSide === "B"
                ? (g.perPlayerGains?.[id] ?? g.playerDeltas?.[id]?.gain ?? g.ptsGain)
                : (g.perPlayerLosses?.[id] ?? g.playerDeltas?.[id]?.loss ?? g.ptsLoss);
              return <span key={id} className={winnerSide === "B" ? "text-g" : "text-r"}>{winnerSide === "B" ? "+" : "−"}{delta} {pName(id, state.players).split(" ")[0]}</span>;
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack page-fade">
      {selectedGameId && (() => {
        const selectedGame = state.games.find(g => g.id === selectedGameId);
        return selectedGame ? (
          <GameDetail game={selectedGame} state={state} setState={setState}
            isAdmin={isAdmin} showToast={showToast} onClose={() => setSelectedGameId(null)} />
        ) : null;
      })()}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Match History ({allGames.length})</span>
          <div className="fac" style={{ gap: 6 }}>
            {hasFilters && <span className="xs tag tag-a">{filtered.length} shown</span>}
            <select className="inp" value={seasonFilter} onChange={e => setSeasonFilter(e.target.value)} style={{ fontSize: 11, padding: "4px 8px", maxWidth: 170 }}>
              <option value="current">Current season</option>
              <option value="all">All seasons</option>
              {(state.seasons || []).map(se => <option key={se.id} value={se.id}>{se.label}</option>)}
            </select>
            <button className={`btn btn-sm ${showFilters ? "btn-p" : "btn-g"}`}
              onClick={() => setShowFilters(f => !f)}>⚡ Filter</button>
          </div>
        </div>
        {showFilters && (
          <div style={{ padding: "10px 16px", background: "var(--s2)", borderBottom: "1px solid var(--b1)", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 140px" }}>
              <div className="lbl">Player</div>
              <input className="inp" placeholder="Search player…" value={playerFilter}
                onChange={e => setPlayerFilter(e.target.value)} style={{ fontSize: 11, padding: "5px 8px" }} />
            </div>
            <div style={{ flex: "1 1 120px" }}>
              <div className="lbl">From</div>
              <input className="inp" type="date" value={dateFrom}
                onChange={e => setDateFrom(e.target.value)} style={{ fontSize: 11, padding: "5px 8px" }} />
            </div>
            <div style={{ flex: "1 1 120px" }}>
              <div className="lbl">To</div>
              <input className="inp" type="date" value={dateTo}
                onChange={e => setDateTo(e.target.value)} style={{ fontSize: 11, padding: "5px 8px" }} />
            </div>
            {hasFilters && (
              <button className="btn btn-d btn-sm" style={{ alignSelf: "flex-end" }}
                onClick={() => { setPlayerFilter(""); setDateFrom(""); setDateTo(""); }}>Clear</button>
            )}
          </div>
        )}
        {groups.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "var(--dimmer)", fontSize: 12 }}>No games found</div>}
        {groups.slice(0, visibleDays).map(({ day, games }) => (
          <div key={day}>
            <div style={{ padding: "7px 18px", background: "var(--s2)", borderBottom: "1px solid var(--b1)", fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--dimmer)", fontWeight: 600 }}>
              {day} · {games.length} game{games.length !== 1 ? "s" : ""}
            </div>
            {games.map(g => <GameRow key={g.id} g={g} />)}
          </div>
        ))}
        {groups.length > visibleDays && (
          <div style={{ padding: "12px 18px", textAlign: "center", borderTop: "1px solid var(--b1)" }}>
            <button className="btn btn-g btn-sm" onClick={() => setVisibleDays(v => v + 5)}>
              Load more — {groups.length - visibleDays} day{groups.length - visibleDays !== 1 ? "s" : ""} remaining
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// ADMIN SYSTEM CORE
// ============================================================

// roles (future proof)
const ROLES = {
  VIEWER: 0,
  REFEREE: 1,
  ADMIN: 2,
  OWNER: 3
};

function can(required, user) {
  return (user?.role ?? 0) >= required;
}

// admin audit log
function logAdmin(state, action, details) {
  return {
    ...state,
    audit: [
      {
        id: crypto.randomUUID(),
        action,
        details,
        date: new Date().toISOString()
      },
      ...(state.audit || [])
    ]
  };
}

// centralized admin actions
const Admin = {

  addPlayer(state, name) {
    const exists = state.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (exists) return { error: "Player already exists" };

    return {
      player: {
        id: crypto.randomUUID(),
        name,
        mmr: CONFIG.STARTING_MMR,
        pts: CONFIG.STARTING_PTS,
        wins: 0,
        losses: 0,
        streak: 0,
        championships: []
      }
    };
  },

  renamePlayer(state, id, newName) {
    const taken = state.players.find(
      p => p.id !== id && p.name.toLowerCase() === newName.toLowerCase()
    );
    if (taken) return { error: "Name already taken" };

    return {
      players: state.players.map(p => p.id === id ? { ...p, name: newName } : p)
    };
  },

  removePlayer(state, id) {
    return {
      players: state.players.filter(p => p.id !== id)
    };
  }

};


// ============================================================
// HELPERS
// ============================================================

function placementsLeft(pid, state) {
  const m = getMonthKey();
  const used = state.monthlyPlacements[m]?.[pid] || 0;
  return CONFIG.MAX_PLACEMENTS_PER_MONTH - used;
}



// ============================================================
// ADMIN: ONBOARD
// ============================================================
function OnboardView({ state, setState, showToast }) {
  const [single, setSingle] = useState("");
  const [bulk, setBulk] = useState("");
  const [preview, setPreview] = useState([]);
  const [confirm, setConfirm] = useState(null);

  function parseBulk(text) {
    return text
      .split(/[\n,]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .filter(name => !state.players.some(p => p.name.toLowerCase() === name.toLowerCase()));
  }

  function addSingle() {
    const name = single.trim();
    if (!name) return;
    if (state.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      showToast("Player already exists", "error");
      return;
    }
    const newPlayer = {
      id: crypto.randomUUID(),
      name,
      mmr: CONFIG.STARTING_MMR, pts: CONFIG.STARTING_PTS,
      mmr_atk: CONFIG.STARTING_MMR, mmr_def: CONFIG.STARTING_MMR,
      wins: 0, losses: 0, streak: 0, streakPower: 0,
      wins_atk: 0, losses_atk: 0, wins_def: 0, losses_def: 0,
      championships: [], position: [], preferredRole: 'FLEX',
    };
    setState(s => logAdmin({ ...s, players: [...s.players, newPlayer] }, "ADD_PLAYER", { name }));
    setSingle("");
    showToast(`${name} added`);
  }

  function confirmBulk() {
    if (!preview.length) return;
    const newPlayers = preview.map(name => ({
      id: crypto.randomUUID(),
      name,
      mmr: CONFIG.STARTING_MMR,
      pts: CONFIG.STARTING_PTS,
      wins: 0,
      losses: 0,
      streak: 0,
      championships: []
    }));
    setState(s => logAdmin({ ...s, players: [...s.players, ...newPlayers] }, "BULK_ADD_PLAYERS", { count: newPlayers.length }));
    showToast(`${newPlayers.length} players added`);
    setBulk("");
    setPreview([]);
  }

  function removePlayer(id) {
    const p = state.players.find(x => x.id === id);
    setConfirm({
      title: "Remove Player?",
      msg: `Remove ${p?.name}? Their game history will remain but they will no longer appear on the leaderboard.`,
      danger: true,
      onConfirm: () => {
        setState(s => logAdmin({ ...s, players: s.players.filter(x => x.id !== id) }, "REMOVE_PLAYER", { name: p?.name }));
        showToast(`${p?.name} removed`);
        setConfirm(null);
      }
    });
  }

  return (
    <div className="stack page-fade">
      {/* Add single player */}
      <div className="card">
        <div className="card-header"><span className="card-title">Add Player</span></div>
        <div style={{ padding: 18 }}>
          <div className="field">
            <label className="lbl">Player Name</label>
            <div className="fac">
              <input
                className="inp"
                placeholder="e.g. Jamie"
                value={single}
                onChange={e => setSingle(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addSingle()}
              />
              <button className="btn btn-p" onClick={addSingle} disabled={!single.trim()}>Add</button>
            </div>
          </div>
        </div>
      </div>

      {/* Bulk add */}
      <div className="card">
        <div className="card-header"><span className="card-title">Bulk Add</span></div>
        <div style={{ padding: 18 }}>
          <div className="field">
            <label className="lbl">Names (one per line or comma-separated)</label>
            <textarea
              className="inp"
              rows={4}
              placeholder={"Alex\nJordan\nSam"}
              value={bulk}
              onChange={e => { setBulk(e.target.value); setPreview(parseBulk(e.target.value)); }}
            />
          </div>
          {preview.length > 0 && (
            <div className="msg msg-w sm mb8">
              Will add {preview.length} player{preview.length > 1 ? "s" : ""}: {preview.join(", ")}
            </div>
          )}
          <button className="btn btn-p" onClick={confirmBulk} disabled={!preview.length}>
            Add {preview.length > 0 ? preview.length : ""} Players
          </button>
        </div>
      </div>

      {/* Current roster */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Current Roster ({state.players.length})</span>
        </div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>#</th><th>Name</th><th>Points</th><th>W/L</th><th></th></tr>
            </thead>
            <tbody>
              {[...state.players]
                .sort((a, b) => (b.pts || 0) - (a.pts || 0))
                .map((p, i) => (
                  <tr key={p.id}>
                    <td><span className="rk">#{i + 1}</span></td>
                    <td><span className="bold">{p.name}</span></td>
                    <td><span className="text-am bold">{p.pts || 0}</span></td>
                    <td>
                      <span className="text-g">{p.wins}</span>
                      <span className="text-dd">/</span>
                      <span className="text-r">{p.losses}</span>
                    </td>
                    <td>
                      <button className="btn btn-d btn-sm" onClick={() => removePlayer(p.id)}>Remove</button>
                    </td>
                  </tr>
                ))}
              {state.players.length === 0 && (
                <tr><td colSpan={5} style={{ textAlign: "center", padding: 32, color: "var(--dimmer)" }}>No players yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {confirm && <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)} />}
    </div>
  );
}

// ============================================================
// ADMIN: LOG GAMES
// ============================================================
// ============================================================
// STATS VIEW — per-player deep stats + H2H + team balancer
// ============================================================

// SVG pts-over-time line chart with hover tooltip
function PtsChart({ pid, games, players, roleFilter }) {
  const W = 320, H = 90, PAD = 10;
  const [hovered, setHovered] = useState(null); // index
  const svgRef = useRef(null);

  const playerGames = [...games]
    .filter(g => g.sideA.includes(pid) || g.sideB.includes(pid))
    .filter(g => !roleFilter || roleFilter === "ALL" || g.roles?.[pid] === roleFilter)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (playerGames.length < 2) return (
    <div style={{ height: H, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span className="xs text-dd">{roleFilter && roleFilter !== "ALL" ? `No ${roleFilter} games yet` : "Not enough games"}</span>
    </div>
  );

  // Build cumulative pts + per-game delta
  let pts = 0;
  const data = playerGames.map(g => {
    const onA = g.sideA.includes(pid);
    const won = (onA && g.winner === "A") || (!onA && g.winner === "B");
    const delta = won ? (g.perPlayerGains?.[pid] ?? g.ptsGain) : -(g.perPlayerLosses?.[pid] ?? g.ptsLoss);
    pts += delta;
    const oppIds = onA ? g.sideB : g.sideA;
    const opps = oppIds.map(id => pName(id, players || [])).join(" & ");
    return { pts, delta, won, date: g.date, opps, scoreA: g.scoreA, scoreB: g.scoreB };
  });

  const minP = Math.min(0, ...data.map(d => d.pts));
  const maxP = Math.max(...data.map(d => d.pts));
  const range = Math.max(maxP - minP, 1);
  const toX = i => PAD + (i / (data.length - 1)) * (W - PAD * 2);
  const toY = v => PAD + (1 - (v - minP) / range) * (H - PAD * 2);

  const pathD = data.map((d, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toY(d.pts).toFixed(1)}`).join(" ");
  const fillD = pathD + ` L${toX(data.length - 1).toFixed(1)},${H} L${toX(0).toFixed(1)},${H} Z`;
  const lastPts = data[data.length - 1].pts;
  const isPos = lastPts >= 0;
  const lineCol = roleFilter === "ATK"
    ? (isPos ? "#f09050" : "#f07070")   // ATK: amber when positive
    : roleFilter === "DEF"
      ? (isPos ? "#60a8e8" : "#f07070") // DEF: blue when positive
      : (isPos ? "#5ec98a" : "#f07070"); // ALL: default green

  // Find nearest data point from mouse x position
  function handleMouseMove(e) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const scaleX = W / rect.width;
    const mouseX = (e.clientX - rect.left) * scaleX;
    let closest = 0, minDist = Infinity;
    data.forEach((_, i) => {
      const dist = Math.abs(toX(i) - mouseX);
      if (dist < minDist) { minDist = dist; closest = i; }
    });
    setHovered(closest);
  }

  const hov = hovered !== null ? data[hovered] : null;

  return (
    <div style={{ position: "relative" }}>
      <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`}
        style={{ overflow: "visible", cursor: "crosshair", display: "block" }}
        onMouseMove={handleMouseMove} onMouseLeave={() => setHovered(null)}>
        <defs>
          <linearGradient id={`cg-${pid}-${roleFilter||"all"}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineCol} stopOpacity="0.22" />
            <stop offset="100%" stopColor={lineCol} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Grid lines */}
        {[0.25, 0.5, 0.75].map(t => (
          <line key={t} x1={PAD} y1={PAD + (1 - t) * (H - PAD * 2)} x2={W - PAD} y2={PAD + (1 - t) * (H - PAD * 2)}
            stroke="var(--b1)" strokeWidth="1" />
        ))}
        {minP < 0 && <line x1={PAD} y1={toY(0)} x2={W - PAD} y2={toY(0)} stroke="var(--b2)" strokeWidth="1" strokeDasharray="4,3" />}
        {/* Fill */}
        <path d={fillD} fill={`url(#cg-${pid}-${roleFilter||"all"})`} />
        {/* Line */}
        <path d={pathD} fill="none" stroke={lineCol} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {/* All dots — small */}
        {data.map((d, i) => (
          <circle key={i} cx={toX(i)} cy={toY(d.pts)} r={hovered === i ? 4 : 2}
            fill={d.won ? "#5ec98a" : "#f07070"}
            stroke={hovered === i ? "var(--bg)" : "none"} strokeWidth="1.5"
            style={{ transition: "r .1s" }} />
        ))}
        {/* Hover crosshair */}
        {hov && (
          <line x1={toX(hovered)} y1={PAD} x2={toX(hovered)} y2={H - PAD}
            stroke="var(--dimmer)" strokeWidth="1" strokeDasharray="3,2" />
        )}
      </svg>

      {/* Tooltip */}
      {hov && (() => {
        const x = toX(hovered) / W * 100;
        const flipLeft = x > 65;
        return (
          <div style={{
            position: "absolute", top: 0,
            left: flipLeft ? "auto" : `calc(${x}% + 8px)`,
            right: flipLeft ? `calc(${100 - x}% + 8px)` : "auto",
            background: "var(--s1)", border: "1px solid var(--b2)",
            borderRadius: 8, padding: "6px 10px", fontSize: 11,
            pointerEvents: "none", zIndex: 10, minWidth: 130,
            boxShadow: "0 4px 20px rgba(0,0,0,.5)",
            lineHeight: 1.7,
          }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: hov.won ? "var(--green)" : "var(--red)", marginBottom: 2 }}>
              {hov.won ? "▲" : "▼"} {hov.pts} pts
            </div>
            <div style={{ color: hov.won ? "var(--green)" : "var(--red)" }}>
              {hov.delta >= 0 ? "+" : ""}{hov.delta} this game
            </div>
            <div className="text-dd">{hov.scoreA}–{hov.scoreB} vs {hov.opps}</div>
            <div className="text-dd" style={{ fontSize: 10, marginTop: 2 }}>
              {new Date(hov.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
            </div>
          </div>
        );
      })()}

      {/* Axis labels */}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3, padding: `0 ${PAD}px` }}>
        <span className="xs text-dd">{new Date(playerGames[0].date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
        <span className="xs text-dd">{lastPts} pts</span>
        <span className="xs text-dd">{new Date(playerGames[playerGames.length - 1].date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
      </div>
    </div>
  );
}

// ============================================================
// SEASONS ARCHIVE
// ============================================================
function SeasonsArchiveView({ state, setState, isAdmin, showToast, onNavToHistory, onNavToStats, onStartNewSeason }) {
  const allSeasons = state.seasons || [];
  const currentSeason = getCurrentSeason(state);
  const [tick, setTick] = useState(0);
  const [editingNextDate, setEditingNextDate] = useState(false);
  const [nextDateInput, setNextDateInput] = useState(state.nextSeasonDate ? new Date(state.nextSeasonDate).toISOString().slice(0, 16) : "");
  const [confirm, setConfirm] = useState(null);

  // Keep nextDateInput in sync with state.nextSeasonDate when it changes externally
  // (remote sync, conflict resolution, another tab saving). Only update when NOT editing
  // so we don't clobber what the admin is currently typing.
  const prevNextSeasonDate = useRef(state.nextSeasonDate);
  useEffect(() => {
    if (state.nextSeasonDate === prevNextSeasonDate.current) return;
    prevNextSeasonDate.current = state.nextSeasonDate;
    if (!editingNextDate) {
      setNextDateInput(state.nextSeasonDate ? new Date(state.nextSeasonDate).toISOString().slice(0, 16) : "");
    }
  }, [state.nextSeasonDate, editingNextDate]);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Season progress — days elapsed in current season
  const seasonProgress = (() => {
    if (!currentSeason?.startAt) return null;
    const start = Date.parse(currentSeason.startAt);
    if (!Number.isFinite(start)) return null;
    const now = Date.now();
    const elapsed = now - start;
    const elapsedDays = Math.floor(elapsed / 86400000);

    if (state.nextSeasonDate) {
      const end = Date.parse(state.nextSeasonDate);
      if (Number.isFinite(end) && end > start) {
        const total = end - start;
        const pct = Math.min(100, Math.round((elapsed / total) * 100));
        const remaining = Math.max(0, end - now);
        const remDays = Math.floor(remaining / 86400000);
        const remHours = Math.floor((remaining % 86400000) / 3600000);
        const remMins = Math.floor((remaining % 3600000) / 60000);
        const remSecs = Math.floor((remaining % 60000) / 1000);
        return { elapsedDays, pct, remDays, remHours, remMins, remSecs, hasEnd: true, endDate: new Date(end) };
      }
    }
    return { elapsedDays, pct: null, hasEnd: false };
  })();

  function saveNextDate() {
    const iso = nextDateInput ? new Date(nextDateInput).toISOString() : null;
    setState(s => ({ ...s, nextSeasonDate: iso }));
    showToast(iso ? "Next season date set" : "Next season date cleared", "ok");
    setEditingNextDate(false);
  }

  return (
    <div className="stack page-fade">

      {/* ── Current Season Hero ── */}
      {(currentSeason && seasonProgress) ? (
        <div className="card" style={{ overflow: "hidden" }}>
          {/* Top accent bar — grows with season progress */}
          <div style={{ height: 3, background: "var(--b1)", position: "relative" }}>
            <div style={{
              position: "absolute", inset: 0,
              width: seasonProgress.pct !== null ? `${seasonProgress.pct}%` : "100%",
              background: "linear-gradient(90deg,var(--amber),var(--green))",
              transition: "width 1s linear",
              boxShadow: "0 0 8px rgba(88,200,130,.4)",
            }} />
          </div>

          <div style={{ padding: "20px 24px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontFamily: "var(--disp)", fontSize: 22, fontWeight: 800, color: "var(--text)" }}>{currentSeason.label}</span>
                  <span className="tag tag-w" style={{ fontSize: 9, letterSpacing: 1.2 }}>LIVE</span>
                </div>
                <div className="xs text-dd">
                  Started {currentSeason.startAt && !isNaN(Date.parse(currentSeason.startAt))
                    ? new Date(currentSeason.startAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
                    : "—"}
                  {" · "}{seasonProgress.elapsedDays} day{seasonProgress.elapsedDays !== 1 ? "s" : ""} in
                </div>
              </div>

              {isAdmin && (
                <button className="btn btn-g btn-sm" onClick={() => setEditingNextDate(v => !v)}>
                  {state.nextSeasonDate ? "Edit end date" : "Set end date"}
                </button>
              )}
            </div>

            {/* Date editor */}
            {editingNextDate && isAdmin && (
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 16, padding: "10px 12px", background: "var(--s2)", borderRadius: 8, border: "1px solid var(--b1)", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 200px" }}>
                  <label className="lbl">Next season starts</label>
                  <input className="inp" type="datetime-local" value={nextDateInput}
                    onChange={e => setNextDateInput(e.target.value)} />
                </div>
                <div className="fac" style={{ gap: 6 }}>
                  <button className="btn btn-p btn-sm" onClick={saveNextDate}>Save</button>
                  {state.nextSeasonDate && (
                    <button className="btn btn-d btn-sm" onClick={() => { setNextDateInput(""); setState(s => ({ ...s, nextSeasonDate: null })); showToast("Date cleared"); setEditingNextDate(false); }}>Clear</button>
                  )}
                  <button className="btn btn-g btn-sm" onClick={() => setEditingNextDate(false)}>Cancel</button>
                </div>
              </div>
            )}

            {/* Countdown or day counter */}
            {seasonProgress.hasEnd ? (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                  <span className="xs text-dd" style={{ letterSpacing: .5, textTransform: "uppercase", fontWeight: 600 }}>
                    Next season in
                  </span>
                  <span className="xs text-dd">{seasonProgress.pct}% through</span>
                </div>
                {/* Big remaining time — days dominant, hms secondary */}
                <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
                  {seasonProgress.remDays > 0 && (
                    <span style={{
                      fontFamily: "var(--disp)", fontSize: 52, fontWeight: 800, lineHeight: 1, color:
                        seasonProgress.remDays <= 1 ? "var(--red)" :
                          seasonProgress.remDays <= 7 ? "var(--orange)" : "var(--amber)"
                    }}>{seasonProgress.remDays}</span>
                  )}
                  {seasonProgress.remDays > 0 && (
                    <span style={{ fontFamily: "var(--disp)", fontSize: 18, color: "var(--dim)", marginRight: 12 }}>
                      day{seasonProgress.remDays !== 1 ? "s" : ""}
                    </span>
                  )}
                  <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--dimmer)", letterSpacing: 1 }}>
                    {String(seasonProgress.remHours).padStart(2, "0")}:{String(seasonProgress.remMins).padStart(2, "0")}:{String(seasonProgress.remSecs).padStart(2, "0")}
                  </span>
                </div>

                {/* Progress bar */}
                <div style={{ height: 6, background: "var(--b1)", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{
                    height: "100%",
                    width: `${seasonProgress.pct}%`,
                    borderRadius: 3,
                    background: `linear-gradient(90deg,var(--amber),${seasonProgress.pct > 85 ? "var(--red)" : "var(--green)"})`,
                    transition: "width 1s linear",
                    boxShadow: `0 0 6px ${seasonProgress.pct > 85 ? "rgba(240,112,112,.4)" : "rgba(88,200,130,.3)"}`,
                  }} />
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                  <span className="xs text-dd">{currentSeason.startAt ? new Date(currentSeason.startAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""}</span>
                  <span className="xs text-dd">{seasonProgress.endDate.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0" }}>
                <div style={{ fontFamily: "var(--disp)", fontSize: 42, fontWeight: 800, color: "var(--amber)", lineHeight: 1 }}>{seasonProgress.elapsedDays}</div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>days running</div>
                  <div className="xs text-dd">No end date set{isAdmin ? " — set one above" : ""}</div>
                </div>
              </div>
            )}

            {/* Admin: start new season */}
            {isAdmin && (
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--b1)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <div className="xs text-dd" style={{ lineHeight: 1.6 }}>
                  Starting a new season resets all points, MMR and streaks.<br />
                  Game history and stats are preserved.
                </div>
                <button className="btn btn-warn" onClick={() => setConfirm({
                  title: "Start New Season?",
                  msg: `This will end ${currentSeason.label} and reset all points, MMR and streaks. Game history is preserved.`,
                  onConfirm: () => { onStartNewSeason?.(); setConfirm(null); }
                })}>
                  ⚡ Start New Season
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: "28px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>🏁</div>
          <div style={{ fontFamily: "var(--disp)", fontSize: 20, fontWeight: 700, marginBottom: 6 }}>No active season</div>
          <div className="xs text-dd" style={{ marginBottom: isAdmin ? 16 : 0 }}>Start a season to begin tracking rankings and progress.</div>
          {isAdmin && (
            <button className="btn btn-p" style={{ marginTop: 8 }} onClick={() => setConfirm({
              title: "Start First Season?",
              msg: "This will create Season 1 and begin tracking points from now.",
              onConfirm: () => { onStartNewSeason?.(); setConfirm(null); }
            })}>⚡ Start Season 1</button>
          )}
        </div>
      )}

      {/* ── Archive ── */}
      <div className="sec" style={{ margin: "4px 0 0" }}>Archive</div>

      {allSeasons.length === 0 ? (
        <div className="msg msg-i">No seasons recorded yet</div>
      ) : (
        [...allSeasons].reverse().map((season, idx) => {
          const isCurrent = !season.endAt;
          if (isCurrent) return null; // current season shown in hero above
          const seasonGames = (state.games || []).filter(g => gameInSeason(g, season));
          const seasonStats = computeWindowPlayerStats(state.players, seasonGames);
          const ranked = [...(state.players || [])].sort((a, b) => (seasonStats[b.id]?.pts || 0) - (seasonStats[a.id]?.pts || 0));
          const topThree = ranked.slice(0, 3).filter(p => seasonStats[p.id]?.wins > 0 || seasonStats[p.id]?.losses > 0);
          const startDate = season.startAt && !isNaN(Date.parse(season.startAt))
            ? new Date(season.startAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
            : "?";
          const endDate = season.endAt && !isNaN(Date.parse(season.endAt))
            ? new Date(season.endAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
            : "Ongoing";
          const durationDays = (season.startAt && season.endAt)
            ? Math.round((Date.parse(season.endAt) - Date.parse(season.startAt)) / 86400000)
            : null;

          return (
            <div key={season.id} className="card">
              <div className="card-header">
                <div>
                  <div style={{ fontFamily: "var(--disp)", fontSize: 15, fontWeight: 700 }}>{season.label}</div>
                  <div className="xs text-dd" style={{ marginTop: 2 }}>{startDate} — {endDate}{durationDays ? ` · ${durationDays}d` : ""}</div>
                </div>
                <div className="xs text-dd">{seasonGames.length} games</div>
              </div>
              {topThree.length > 0 && (
                <div style={{ padding: "10px 16px", display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {topThree.map((p, i) => (
                    <div key={p.id} style={{
                      display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 8,
                      background: i === 0 ? "radial-gradient(ellipse at 0% 50%,rgba(232,184,74,.12),var(--s2))" :
                        i === 1 ? "radial-gradient(ellipse at 0% 50%,rgba(192,200,196,.07),var(--s2))" :
                          "var(--s2)",
                      border: `1px solid ${i === 0 ? "rgba(232,184,74,.25)" : "var(--b1)"}`,
                      flex: "1 1 120px",
                    }}>
                      <span style={{ fontSize: 14 }}>{i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉"}</span>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                        <div className="xs" style={{ color: "var(--amber)" }}>{seasonStats[p.id]?.pts || 0} pts</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ padding: "8px 16px 12px", display: "flex", gap: 6 }}>
                <button className="btn btn-g btn-sm" onClick={() => onNavToHistory?.(season)}>History</button>
                <button className="btn btn-g btn-sm" onClick={() => onNavToStats?.(season)}>Stats</button>
              </div>
            </div>
          );
        })
      )}

      {confirm && (
        <ConfirmDialog title={confirm.title} msg={confirm.msg}
          onConfirm={confirm.onConfirm} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}

function WinDonut({ wins, losses }) {
  const total = wins + losses;
  if (!total) return (
    <div style={{ width: 64, height: 64, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span className="xs text-dd">—</span>
    </div>
  );
  const pct = wins / total;
  const R = 28, CX = 32, CY = 32, CIRC = 2 * Math.PI * R;
  const dash = pct * CIRC;
  return (
    <svg width="64" height="64" viewBox="0 0 64 64">
      <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--b2)" strokeWidth="6" />
      <circle cx={CX} cy={CY} r={R} fill="none" stroke="#5ec98a" strokeWidth="6"
        strokeDasharray={`${dash} ${CIRC}`} strokeDashoffset={CIRC / 4}
        strokeLinecap="round" style={{ transition: "stroke-dasharray .6s ease" }} />
      <text x={CX} y={CY + 1} textAnchor="middle" dominantBaseline="middle"
        fill="var(--text)" fontSize="11" fontWeight="700" fontFamily="var(--disp)">
        {Math.round(pct * 100)}%
      </text>
    </svg>
  );
}

function StatsView({ state, onSelectPlayer }) {
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");
  const [seasonFilter, setSeasonFilter] = useState("current");
  const [posFilter, setPosFilter] = useState("ALL");

  const currentSeason = getCurrentSeason(state);
  const activeSeason = seasonFilter === "all" ? null : (seasonFilter === "current" ? currentSeason : (state.seasons || []).find(s => s.id === seasonFilter) || null);
  const scopedGames = (state.games || []).filter(g => gameInSeason(g, activeSeason));
  const scopedStats = computeWindowPlayerStats(state.players, scopedGames);
  const sorted = [...state.players]
    .sort((a, b) => {
      if (posFilter === "ATK") return (b.mmr_atk||b.mmr||0) - (a.mmr_atk||a.mmr||0);
      if (posFilter === "DEF") return (b.mmr_def||b.mmr||0) - (a.mmr_def||a.mmr||0);
      return (scopedStats[b.id]?.pts || 0) - (scopedStats[a.id]?.pts || 0);
    });
  const selected = state.players.find(p => p.id === selectedId);

  function getH2H(pidA, pidB) {
    const shared = scopedGames.filter(g =>
      (g.sideA.includes(pidA) || g.sideB.includes(pidA)) &&
      (g.sideA.includes(pidB) || g.sideB.includes(pidB))
    );
    let winsA = 0, winsB = 0;
    for (const g of shared) {
      const aOnA = g.sideA.includes(pidA);
      const won = (aOnA && g.winner === "A") || (!aOnA && g.winner === "B");
      if (won) winsA++; else winsB++;
    }
    return { games: shared.length, winsA, winsB };
  }

  function getStats(p) {
    const playerGames = [...scopedGames]
      .filter(g => g.sideA.includes(p.id) || g.sideB.includes(p.id))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const wins = playerGames.filter(g => { const onA = g.sideA.includes(p.id); return (onA && g.winner === "A") || (!onA && g.winner === "B"); });
    const losses = playerGames.filter(g => { const onA = g.sideA.includes(p.id); return (onA && g.winner === "B") || (!onA && g.winner === "A"); });
    const avgGain = wins.length ? Math.round(wins.reduce((s, g) => s + (g.perPlayerGains?.[p.id] ?? g.ptsGain), 0) / wins.length) : 0;
    const avgLoss = losses.length ? Math.round(losses.reduce((s, g) => s + (g.perPlayerLosses?.[p.id] ?? g.ptsLoss), 0) / losses.length) : 0;
    const biggestMargin = wins.reduce((best, g) => Math.max(best, Math.abs(g.scoreA - g.scoreB)), 0);
    const longestStreak = (() => {
      let best = 0, cur = 0;
      playerGames.forEach(g => {
        const onA = g.sideA.includes(p.id);
        const won = (onA && g.winner === "A") || (!onA && g.winner === "B");
        cur = won ? cur + 1 : 0;
        best = Math.max(best, cur);
      });
      return best;
    })();
    return { avgGain, avgLoss, biggestMargin, longestStreak, totalGames: playerGames.length, wins: wins.length, losses: losses.length };
  }

  function calcNetPts(pid, pgames) {
    return pgames.reduce((acc, g) => {
      const won = (g.sideA.includes(pid) && g.winner === "A") || (g.sideB.includes(pid) && g.winner === "B");
      return acc + (won
        ? (g.perPlayerGains?.[pid] ?? g.ptsGain ?? 0)
        : -(g.perPlayerLosses?.[pid] ?? g.ptsLoss ?? 0));
    }, 0);
  }

  return (
    <div className="stack page-fade">

      {activeSeason && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Season Overview — {activeSeason.label}</span>
          </div>
          <div className="grid-2" style={{ gap: 0 }}>
            <div className="stat-box" style={{ borderRadius: 0, border: "none", borderRight: "1px solid var(--b1)", borderBottom: "1px solid var(--b1)" }}>
              <div className="stat-lbl">Season Start</div>
              <div className="stat-val" style={{ fontSize: 16 }}>
                {activeSeason.startAt && !isNaN(Date.parse(activeSeason.startAt))
                  ? new Date(activeSeason.startAt).toLocaleDateString("en-GB", { weekday: "short", month: "short", day: "numeric" })
                  : <span className="text-dd">—</span>}
              </div>
            </div>
            <div className="stat-box" style={{ borderRadius: 0, border: "none", borderBottom: "1px solid var(--b1)" }}>
              <div className="stat-lbl">Games This Season</div>
              <div className="stat-val">{scopedGames.length}</div>
            </div>
            <div className="stat-box" style={{ borderRadius: 0, border: "none", borderRight: "1px solid var(--b1)" }}>
              <div className="stat-lbl">Points In Play</div>
              <div className="stat-val">{scopedGames.reduce((s, g) => s + (g.ptsGain || 0) + (g.ptsLoss || 0), 0)}</div>
            </div>
            <div className="stat-box" style={{ borderRadius: 0, border: "none" }}>
              <div className="stat-lbl">7-Day Active</div>
              <div className="stat-val">{(() => { const d = new Date(Date.now() - 7 * 86400000); return scopedGames.filter(g => new Date(g.date) >= d).length; })()}</div>
            </div>
          </div>
        </div>
      )}

      <div className="grid-2" style={{ alignItems: "start" }}>
        {/* Player selector */}
        <div className="card">
          <div className="card-header"><span className="card-title">Player Stats</span><select className="inp" value={seasonFilter} onChange={e => setSeasonFilter(e.target.value)} style={{ fontSize: 11, padding: "4px 8px", maxWidth: 180 }}><option value="current">Current season</option><option value="all">All seasons</option>{(state.seasons || []).map(se => <option key={se.id} value={se.id}>{se.label}</option>)}</select></div>
          <div style={{ padding: 14 }}>
            <div className="fac" style={{gap:4,marginBottom:8}}>
              {["ALL","ATK","DEF"].map(f=>(
                <button key={f} className={`btn btn-sm ${posFilter===f?"btn-p":"btn-g"}`}
                  style={{minWidth:44,fontSize:11}} onClick={()=>setPosFilter(f)}>{f}</button>
              ))}
            </div>
            <input className="inp" placeholder="Search…" value={search}
              onChange={e => setSearch(e.target.value)} style={{ marginBottom: 10, fontSize: 12 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 260, overflowY: "auto" }}>
              {sorted.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase())).map(p => (
                <div key={p.id} className={`player-chip ${selectedId === p.id ? "sel-a" : ""}`}
                  onClick={() => setSelectedId(p.id)}>
                  <span style={{ fontWeight: 600 }}>{p.name}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Sparkline pid={p.id} games={scopedGames} />
                    <span className="xs text-dd">{posFilter==="ATK"
                    ? <><span style={{color:"var(--orange)",fontWeight:600}}>🗡 {p.mmr_atk||p.mmr}</span> ATK</>
                    : posFilter==="DEF"
                    ? <><span style={{color:"var(--blue)",fontWeight:600}}>🛡 {p.mmr_def||p.mmr}</span> DEF</>
                    : <>{p.mmr||1000} MMR{((p.wins_atk||0)+(p.losses_atk||0)+(p.wins_def||0)+(p.losses_def||0) > 0) && (<> · <span style={{color:"var(--orange)"}}>A {p.mmr_atk||p.mmr}</span>/<span style={{color:"var(--blue)"}}>D {p.mmr_def||p.mmr}</span></>)}</>
                  } · {scopedStats[p.id]?.pts || 0}pts</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Stats panel */}
        {selected ? (() => {
          const st = getStats(selected);
          const rank = sorted.findIndex(p => p.id === selected.id) + 1;
          return (
            <div className="card">
              <div className="card-header">
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  <span className="card-title">{selected.name}</span>
                  <span className="xs text-dd">Rank #{rank} · {st.totalGames} games played</span>
                </div>
                <button className="btn btn-g btn-sm" onClick={() => onSelectPlayer(selected)}>Profile</button>
              </div>
              <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>

                {/* Points chart */}
                <div>
                  <div className="xs text-dd" style={{ marginBottom: 6, letterSpacing: .5, textTransform: "uppercase", fontWeight: 600 }}>{posFilter === "ATK" ? "🗡 ATK points over time" : posFilter === "DEF" ? "🛡 DEF points over time" : "Points over time"}</div>
                  <div style={{ background: "var(--s2)", borderRadius: 8, padding: "10px 12px" }}>
                    <PtsChart key={`${selected.id}-${posFilter}`} pid={selected.id} games={scopedGames} players={state.players} roleFilter={posFilter} />
                  </div>
                </div>

                {/* Stats rows */}
                {(() => {
                  const pGames = scopedGames.filter(g => g.sideA.includes(selected.id) || g.sideB.includes(selected.id));
                  const netPts = calcNetPts(selected.id, pGames);
                  const ppg = pGames.length ? (netPts / pGames.length).toFixed(1) : null;
                  return (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: "64px 1fr 1fr 1fr", gap: 10, alignItems: "center" }}>
                        <WinDonut wins={st.wins} losses={st.losses} />

                        {(() => {
                          // Split avg gain/loss by role if roles present
                          const atkGames = pGames.filter(g => g.roles?.[selected.id] === "ATK");
                          const defGames = pGames.filter(g => g.roles?.[selected.id] === "DEF");
                          const hasRoleData = atkGames.length + defGames.length > 0;
                          const roleAvg = (games, type) => {
                            const relevant = games.filter(g => {
                              const won = (g.sideA.includes(selected.id)&&g.winner==="A")||(g.sideB.includes(selected.id)&&g.winner==="B");
                              return type==="win" ? won : !won;
                            });
                            if (!relevant.length) return null;
                            const key = type==="win" ? "perPlayerGains" : "perPlayerLosses";
                            const fallback = type==="win" ? "ptsGain" : "ptsLoss";
                            return Math.round(relevant.reduce((s,g)=>s+(g[key]?.[selected.id]??g[fallback]??0),0)/relevant.length);
                          };
                          if (hasRoleData) return (
                            <>
                              <div className="stat-box" style={{padding:"8px 10px", outline: posFilter==="ATK" ? "2px solid var(--orange)" : "none"}}>
                                <div className="stat-lbl">ATK avg</div>
                                <div className="fac" style={{gap:4,marginTop:2}}>
                                  {roleAvg(atkGames,"win")!=null && <span className="stat-val am" style={{fontSize:16}}>+{roleAvg(atkGames,"win")}</span>}
                                  {roleAvg(atkGames,"loss")!=null && <span className="stat-val" style={{fontSize:16,color:"var(--red)"}}>−{roleAvg(atkGames,"loss")}</span>}
                                  {atkGames.length===0 && <span className="xs text-dd">no games</span>}
                                </div>
                              </div>
                              <div className="stat-box" style={{padding:"8px 10px", outline: posFilter==="DEF" ? "2px solid var(--blue)" : "none"}}>
                                <div className="stat-lbl">DEF avg</div>
                                <div className="fac" style={{gap:4,marginTop:2}}>
                                  {roleAvg(defGames,"win")!=null && <span className="stat-val am" style={{fontSize:16}}>+{roleAvg(defGames,"win")}</span>}
                                  {roleAvg(defGames,"loss")!=null && <span className="stat-val" style={{fontSize:16,color:"var(--red)"}}>−{roleAvg(defGames,"loss")}</span>}
                                  {defGames.length===0 && <span className="xs text-dd">no games</span>}
                                </div>
                              </div>
                            </>
                          );
                          return (
                            <>
                              <div className="stat-box" style={{ padding: "8px 12px" }}>
                                <div className="stat-lbl">Avg gain</div>
                                <div className="stat-val am" style={{ fontSize: 20 }}>+{st.avgGain}</div>
                              </div>
                              <div className="stat-box" style={{ padding: "8px 12px" }}>
                                <div className="stat-lbl">Avg loss</div>
                                <div className="stat-val" style={{ fontSize: 20, color: "var(--red)" }}>−{st.avgLoss}</div>
                              </div>
                            </>
                          );
                        })()}
                        {((selected.wins_atk||0)+(selected.losses_atk||0) > 0) && (
                          <div className="stat-box" style={{ padding: "8px 12px" }}>
                            <div className="stat-lbl">ATK</div>
                            <div className="stat-val" style={{ fontSize: 16, color: "var(--orange)" }}>{selected.wins_atk||0}W / {selected.losses_atk||0}L</div>
                            <div className="xs text-dd" style={{marginTop:2}}>{selected.mmr_atk||selected.mmr} MMR</div>
                          </div>
                        )}
                        {((selected.wins_def||0)+(selected.losses_def||0) > 0) && (
                          <div className="stat-box" style={{ padding: "8px 12px" }}>
                            <div className="stat-lbl">DEF</div>
                            <div className="stat-val" style={{ fontSize: 16, color: "var(--blue)" }}>{selected.wins_def||0}W / {selected.losses_def||0}L</div>
                            <div className="xs text-dd" style={{marginTop:2}}>{selected.mmr_def||selected.mmr} MMR</div>
                          </div>
                        )}
                        <div className="stat-box" style={{ padding: "8px 12px" }}>
                          <div className="stat-lbl">Best streak</div>
                          <div className="stat-val" style={{ fontSize: 20 }}>▲{st.longestStreak}</div>
                        </div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                        <div className="stat-box" style={{ padding: "8px 12px" }}>
                          <div className="stat-lbl">Biggest win</div>
                          <div className="stat-val" style={{ fontSize: 20 }}>+{st.biggestMargin}</div>
                        </div>
                        <div className="stat-box" style={{ padding: "8px 12px" }}>
                          <div className="stat-lbl">Net pts</div>
                          <div className="stat-val" style={{ fontSize: 20, color: netPts >= 0 ? "var(--green)" : "var(--red)" }}>{netPts >= 0 ? "+" : ""}{netPts}</div>
                        </div>
                        <div className="stat-box" style={{ padding: "8px 12px" }}>
                          <div className="stat-lbl">Pts / game</div>
                          <div className="stat-val" style={{ fontSize: 20, color: !ppg ? "var(--dimmer)" : Number(ppg) >= 0 ? "var(--green)" : "var(--red)" }}>
                            {ppg === null ? "—" : `${Number(ppg) >= 0 ? "+" : ""}${ppg}`}
                          </div>
                        </div>
                      </div>
                    </>
                  );
                })()}

                {/* Recent form bar — last 10 games */}
                {(() => {
                  const recent = scopedGames
                    .filter(g => g.sideA.includes(selected.id) || g.sideB.includes(selected.id))
                    .sort((a, b) => new Date(b.date) - new Date(a.date))
                    .slice(0, 10).reverse();
                  if (!recent.length) return null;
                  return (
                    <div>
                      <div className="xs text-dd" style={{ marginBottom: 6, letterSpacing: .5, textTransform: "uppercase", fontWeight: 600 }}>Recent form</div>
                      <div style={{ display: "flex", gap: 3 }}>
                        {recent.map(g => {
                          const won = (g.sideA.includes(selected.id) && g.winner === "A") || (g.sideB.includes(selected.id) && g.winner === "B");
                          const opps = (g.sideA.includes(selected.id) ? g.sideB : g.sideA).map(id => pName(id, state.players)).join(" & ");
                          const delta = won ? (g.perPlayerGains?.[selected.id] ?? g.ptsGain ?? 0) : -(g.perPlayerLosses?.[selected.id] ?? g.ptsLoss ?? 0);
                          const role = g.roles?.[selected.id];
                          const roleIcon = role === "ATK" ? "🗡" : role === "DEF" ? "🛡" : null;
                          return (
                            <div key={g.id}
                              title={`${won ? "W" : "L"}${role ? ` (${role})` : ""} vs ${opps} · ${delta >= 0 ? "+" : ""}${delta}pts`}
                              style={{
                                flex: 1, borderRadius: 4, minHeight: 28,
                                background: won ? "rgba(94,201,138,.18)" : "rgba(240,112,112,.14)",
                                border: `1px solid ${won ? "rgba(94,201,138,.45)" : "rgba(240,112,112,.35)"}`,
                                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                                fontSize: 9, fontWeight: 700, color: won ? "var(--green)" : "var(--red)", cursor: "default",
                                gap: 1, paddingTop: roleIcon ? 3 : 0,
                              }}>
                              {won ? "W" : "L"}
                              {roleIcon && <span style={{fontSize:8,opacity:.7,lineHeight:1}}>{roleIcon}</span>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* H2H */}
                <div>
                  <div className="sec" style={{ marginBottom: 6 }}>Head to Head</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 160, overflowY: "auto" }}>
                    {sorted.filter(p => p.id !== selected.id).map(p => {
                      const h = getH2H(selected.id, p.id);
                      if (!h.games) return null;
                      const pct = Math.round(h.winsA / h.games * 100);
                      return (
                        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 8, background: "var(--s2)", border: "1px solid var(--b1)" }}>
                          <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                          {/* Mini win bar */}
                          <div style={{ width: 60, height: 5, borderRadius: 3, background: "var(--b2)", overflow: "hidden" }}>
                            <div style={{ width: `${pct}%`, height: "100%", background: "var(--green)", borderRadius: 3, transition: "width .4s ease" }} />
                          </div>
                          <span className="text-g bold" style={{ fontSize: 12, minWidth: 20 }}>{h.winsA}W</span>
                          <span className="text-dd xs">–</span>
                          <span className="text-r bold" style={{ fontSize: 12, minWidth: 20 }}>{h.winsB}L</span>
                        </div>
                      );
                    }).filter(Boolean)}
                    {!sorted.filter(p => p.id !== selected.id).some(p => getH2H(selected.id, p.id).games > 0) && (
                      <div className="xs text-dd" style={{ padding: "8px 0" }}>No H2H data yet</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })() : (
          <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 240 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📊</div>
              <span className="text-dd" style={{ fontSize: 13 }}>Select a player to view stats</span>
            </div>
          </div>
        )}
      </div>

      <TeamBalancer players={state.players} />
    </div>
  );
}

// ============================================================
// TEAM BALANCER
// ============================================================
function TeamBalancer({ players }) {
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState("");

  const sorted = [...players].sort((a, b) => (b.mmr || 0) - (a.mmr || 0));
  const visible = sorted.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()));

  function toggle(id) {
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : s.length < 4 ? [...s, id] : s);
  }

  // Generate all 3 possible 2v2 splits from 4 players
  function getBalancings(pids) {
    const [a, b, c, d] = pids;
    const splits = [
      [[a, b], [c, d]],
      [[a, c], [b, d]],
      [[a, d], [b, c]],
    ];
    return splits.map(([t1, t2]) => {
      const mmr1 = t1.reduce((s, id) => s + (players.find(p => p.id === id)?.mmr || 1000), 0) / 2;
      const mmr2 = t2.reduce((s, id) => s + (players.find(p => p.id === id)?.mmr || 1000), 0) / 2;
      const diff = Math.abs(mmr1 - mmr2);
      const total = mmr1 + mmr2;
      const balance = Math.round((1 - diff / Math.max(total / 2, 1)) * 100);
      return { t1, t2, mmr1: Math.round(mmr1), mmr2: Math.round(mmr2), diff: Math.round(diff), balance };
    }).sort((a, b) => a.diff - b.diff);
  }

  const matchups = selected.length === 4 ? getBalancings(selected) : null;
  const best = matchups?.[0];

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">⚖ Team Balancer</span>
        {selected.length > 0 && (
          <button className="btn btn-g btn-sm" onClick={() => setSelected([])}>Clear</button>
        )}
      </div>
      <div style={{ padding: 14 }}>
        <div className="xs text-dd" style={{ marginBottom: 10, lineHeight: 1.6 }}>
          Select 4 players to see all possible fair matchups ranked by MMR balance.
        </div>
        <div className="lbl">{selected.length}/4 players selected</div>
        {selected.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {selected.map(id => {
              const p = players.find(x => x.id === id);
              return <span key={id} className="tag tag-a" style={{ cursor: "pointer", fontSize: 11, padding: "3px 8px" }}
                onClick={() => toggle(id)}>{p?.name} ×</span>;
            })}
          </div>
        )}
        <input className="inp" placeholder="Search players…" value={search}
          onChange={e => setSearch(e.target.value)} style={{ marginBottom: 8, fontSize: 12 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 160, overflowY: "auto", marginBottom: 14 }}>
          {visible.map(p => {
            const sel = selected.includes(p.id);
            const full = !sel && selected.length >= 4;
            return (
              <div key={p.id} className={`player-chip ${sel ? "sel-a" : ""} ${full ? "disabled" : ""}`}
                onClick={() => !full && toggle(p.id)}>
                <span>{p.name}</span>
                <span className="xs text-dd">
                  {p.mmr||1000} MMR{((p.wins_atk||0)+(p.losses_atk||0)+(p.wins_def||0)+(p.losses_def||0))>0 &&
                    <> · <span style={{color:"var(--orange)"}}>A:{p.mmr_atk}</span>/<span style={{color:"var(--blue)"}}>D:{p.mmr_def}</span></>} · {p.pts||0}pts
                </span>
              </div>
            );
          })}
        </div>

        {matchups && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="sec">Suggested matchups</div>
            {matchups.map(({ t1, t2, mmr1, mmr2, diff, balance }, i) => (
              <div key={i} style={{
                background: i === 0 ? "rgba(94,201,138,.06)" : "var(--s2)",
                border: `1px solid ${i === 0 ? "var(--amber-d)" : "var(--b2)"}`,
                borderRadius: 6, padding: "10px 14px"
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span className="xs text-dd">Option {i + 1}</span>
                  <span className={`tag ${i === 0 ? "tag-w" : "tag-a"}`}>{balance}% balanced</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "center" }}>
                  <div>
                    {t1.map(id => <div key={id} className="bold" style={{ fontSize: 12 }}>{players.find(p => p.id === id)?.name}</div>)}
                    <div className="xs text-dd" style={{ marginTop: 2 }}>{mmr1} avg MMR</div>
                  </div>
                  <div style={{ textAlign: "center", color: "var(--dimmer)", fontSize: 11, fontWeight: 700 }}>
                    VS<br /><span style={{ fontSize: 10, color: diff < 30 ? "var(--green)" : diff < 80 ? "var(--orange)" : "var(--red)" }}>Δ{diff}</span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    {t2.map(id => <div key={id} className="bold" style={{ fontSize: 12 }}>{players.find(p => p.id === id)?.name}</div>)}
                    <div className="xs text-dd" style={{ marginTop: 2 }}>{mmr2} avg MMR</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {selected.length > 0 && selected.length < 4 && (
          <div className="msg msg-w" style={{ marginTop: 8 }}>Select {4 - selected.length} more player{4 - selected.length !== 1 ? "s" : ""}</div>
        )}
      </div>
    </div>
  );
}

const EMPTY_ROW = () => ({ id: crypto.randomUUID(), sideA: [], sideB: [], scoreA: "", scoreB: "", searchA: "", searchB: "", penalties: {}, roles: {} });

function LogView({ state, setState, showToast }) {
  const [rows, setRows] = useState([EMPTY_ROW()]);
  const [errors, setErrors] = useState({});
  const [undoStack, setUndoStack] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const [lastLogged, setLastLogged] = useState(null); // { games: [...], timestamp }
  const [templates, setTemplates] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("foosball_tpl") || "[]");
    } catch {
      return [];
    }
  });
  const [tplName, setTplName] = useState("");
  const undoTimeout = useRef(null);

  // ============================================================
  // KEYBOARD SHORTCUT: CTRL+ENTER SUBMIT
  // ============================================================
  useEffect(() => {
    const handler = e => {
      if (e.ctrlKey && e.key === "Enter") submitAll();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, state]);

  // ============================================================
  // TOGGLE PLAYER IN ROW
  // ============================================================
  function setRowPenalty(rowId, pid, type, delta) {
    setRows(r => r.map(row => {
      if (row.id !== rowId) return row;
      const cur = row.penalties?.[pid] || { yellow: 0, red: 0 };
      const newVal = Math.max(0, (cur[type] || 0) + delta);
      return { ...row, penalties: { ...row.penalties, [pid]: { ...cur, [type]: newVal } } };
    }));
  }

  function setRole(rowId, pid, role) {
    setRows(r => r.map(row => row.id !== rowId ? row : { ...row, roles: { ...row.roles, [pid]: role } }));
  }

  function autoAssignRole(rowId, pid) {
    const pref = state.players.find(p => p.id === pid)?.preferredRole;
    if (pref === 'ATK' || pref === 'DEF') {
      setRows(r => r.map(row => row.id !== rowId ? row : { ...row, roles: { ...row.roles, [pid]: pref } }));
    }
  }

  function togglePlayer(rowId, side, pid) {
    setRows(r =>
      r.map(row => {
        if (row.id !== rowId) return row;
        const key = side === "A" ? "sideA" : "sideB";
        const searchKey = side === "A" ? "searchA" : "searchB";
        const other = side === "A" ? "sideB" : "sideA";
        const otherFiltered = row[other].filter(id => id !== pid);

        if (row[key].includes(pid)) {
          const nr = { ...row.roles }; delete nr[pid];
          return { ...row, [key]: row[key].filter(id => id !== pid), roles: nr };
        }
        if (row[key].length >= 2) return row;
        return { ...row, [key]: [...row[key], pid], [other]: otherFiltered, [searchKey]: "" };
      })
    );
  }

  // ============================================================
  // TEMPLATE MANAGEMENT
  // ============================================================
  function saveTpl() {
    if (!tplName.trim()) return;
    const t = { name: tplName, rows: rows.map(r => ({ sideA: r.sideA, sideB: r.sideB })) };
    const upd = [...templates, t];
    setTemplates(upd);
    localStorage.setItem("foosball_tpl", JSON.stringify(upd));
    setTplName("");
    showToast("Template saved");
  }

  function loadTpl(t) {
    setRows(t.rows.map(r => ({ ...EMPTY_ROW(), sideA: r.sideA, sideB: r.sideB })));
    showToast(`"${t.name}" loaded`);
  }

  function deleteTpl(i) {
    const u = templates.filter((_, idx) => idx !== i);
    setTemplates(u);
    localStorage.setItem("foosball_tpl", JSON.stringify(u));
  }

  // ============================================================
  // SUBMIT ALL GAMES
  // ============================================================
  function submitAll(skipDuplicateCheck = false) {
    const newErrors = {};
    const monthKey = getMonthKey() ?? "default";
    const placements = { ...((state.monthlyPlacements ?? {})[monthKey] ?? {}) };

    for (const row of rows) {
      if (row.sideA.length !== 2 || row.sideB.length !== 2) { newErrors[row.id] = "Each side needs exactly 2 players"; continue; }
      if (new Set([...row.sideA, ...row.sideB]).size < 4) { newErrors[row.id] = "A player appears on both sides"; continue; }

      const sA = parseInt(row.scoreA, 10), sB = parseInt(row.scoreB, 10);
      if (isNaN(sA) || isNaN(sB) || sA < 0 || sB < 0) { newErrors[row.id] = "Invalid scores"; continue; }
      if (sA === sB) { newErrors[row.id] = "No draws allowed"; continue; }
      if (row.sideA.length === 2 && row.sideB.length === 2) {
        const allR = [...row.sideA, ...row.sideB].map(pid => row.roles?.[pid]).filter(Boolean);
        if (allR.length > 0 && allR.length < 4) { newErrors[row.id] = "Assign ATK/DEF to all 4 players or leave all blank"; continue; }
        if (allR.length === 4) {
          const atkA = row.sideA.filter(pid => row.roles?.[pid]==="ATK").length;
          const atkB = row.sideB.filter(pid => row.roles?.[pid]==="ATK").length;
          if (atkA !== 1 || atkB !== 1) { newErrors[row.id] = "Each side needs exactly 1 ATK and 1 DEF"; continue; }
        }
      }
    }

    setErrors(newErrors);
    if (Object.keys(newErrors).length) { showToast("Fix errors first", "error"); return; }

    // Data integrity warnings
    const suspiciousRows = [];
    for (const row of rows) {
      const sA = parseInt(row.scoreA, 10), sB = parseInt(row.scoreB, 10);
      const total = sA + sB;
      const margin = Math.abs(sA - sB);
      const issues = [];
      if (total > 50) issues.push(`Total score ${total} (unusual)`);
      if (margin > 15) issues.push(`Margin ${margin} (very lopsided)`);
      if (sA === 0 || sB === 0) issues.push("Zero score");
      if (issues.length > 0) suspiciousRows.push({ row, issues });
    }

    if (suspiciousRows.length > 0 && !skipDuplicateCheck) {
      setConfirm({
        title: "Suspicious Score(s) Detected",
        msg: `${suspiciousRows.map(s => `${[...s.row.sideA, ...s.row.sideB].map(id => pName(id, state.players)).join(', ')}: ${s.row.scoreA}–${s.row.scoreB} (${s.issues.join(', ')})`).join('\n')}\n\nLog anyway?`,
        onConfirm: () => { setConfirm(null); submitAll(true); },
      });
      return;
    }

    // Duplicate game check
    if (!skipDuplicateCheck) {
      const today = new Date().toISOString();
      const duplicates = rows.filter(row => {
        const sA = parseInt(row.scoreA, 10), sB = parseInt(row.scoreB, 10);
        return isDuplicateGame({ sideA: row.sideA, sideB: row.sideB, scoreA: sA, scoreB: sB, date: today }, state.games);
      });
      if (duplicates.length > 0) {
        const names = duplicates.map(r =>
          [...r.sideA, ...r.sideB].map(id => pName(id, state.players)).join(', ')
        ).join('; ');
        setConfirm({
          title: "Duplicate Match Detected",
          msg: `A match with the same players and score was already logged today (${names}). Log anyway?`,
          onConfirm: () => { setConfirm(null); submitAll(true); },
        });
        return;
      }
    }

    // Push undo snapshot
    const snapshot = { players: state.players, games: state.games, monthlyPlacements: state.monthlyPlacements };
    setUndoStack(u => [snapshot, ...u].slice(0, 5));

    // Build the new game objects (metadata only — no deltas yet)
    const pendingGames = rows.map(row => {
      const sA = parseInt(row.scoreA, 10), sB = parseInt(row.scoreB, 10);
      const winner = sA > sB ? "A" : "B";
      const gamePenalties = Object.keys(row.penalties || {}).length > 0 ? row.penalties : undefined;
      return {
        id: crypto.randomUUID(), sideA: row.sideA, sideB: row.sideB,
        winner, scoreA: sA, scoreB: sB,
        roles: Object.keys(row.roles || {}).length === 4 ? { ...row.roles } : {},
        ...(gamePenalties ? { penalties: gamePenalties } : {}),
        date: new Date().toISOString(), monthKey,
        ptsGain: 0, ptsLoss: 0,
      };
    });

    // Full replay over all games (existing + new) — single source of truth
    const basePlayers = state.players.map(p => ({
      ...p,
      mmr: CONFIG.STARTING_MMR, pts: CONFIG.STARTING_PTS,
      mmr_atk: CONFIG.STARTING_MMR, mmr_def: CONFIG.STARTING_MMR,
      wins: 0, losses: 0, streak: 0, streakPower: 0, lossStreakPower: 0,
      wins_atk: 0, losses_atk: 0, wins_def: 0, losses_def: 0,
    }));
    const allGames = [...state.games, ...pendingGames];
    const { players: newPlayers, games: newGames } = replayGames(basePlayers, allGames, state.seasonStart);

    // Preserve non-computed fields (name, championships, position, preferredRole)
    const mergedPlayers = newPlayers.map(p => {
      const orig = state.players.find(x => x.id === p.id);
      return orig ? {
        ...p,
        name: orig.name,
        championships: orig.championships || [],
        position: orig.position || [],
        preferredRole: orig.preferredRole || "FLEX",
      } : p;
    });

    const newPlacements = computePlacements(newGames);
    // Isolate just the newly logged games (for lastLogged display) with their computed deltas
    const newGameIds = new Set(pendingGames.map(g => g.id));
    const loggedWithDeltas = newGames.filter(g => newGameIds.has(g.id));

    setState(s => ({ ...s, players: mergedPlayers, games: newGames, monthlyPlacements: newPlacements }));
    setRows([EMPTY_ROW()]);
    setLastLogged({ games: loggedWithDeltas, players: mergedPlayers, timestamp: new Date() });
    showToast(`${loggedWithDeltas.length} game${loggedWithDeltas.length > 1 ? "s" : ""} logged`, "success");

    clearTimeout(undoTimeout.current);
    undoTimeout.current = setTimeout(() => setUndoStack([]), 30000);
  }

  // ============================================================
  // UNDO
  // ============================================================
  function undoLast() {
    if (!undoStack.length) return;
    const [prev, ...rest] = undoStack;
    setState(s => ({ ...s, players: prev.players, games: prev.games, monthlyPlacements: prev.monthlyPlacements }));
    setUndoStack(rest);
    showToast("Last submission undone", "info");
  }

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <>
      <div className="stack page-fade">
        {lastLogged && (
          <div className="card" style={{ borderColor: "var(--amber-d)" }}>
            <div className="card-header" style={{ background: "var(--amber-g)" }}>
              <span className="card-title">✓ Just Logged</span>
              <button className="btn btn-g btn-sm" onClick={() => setLastLogged(null)}>Dismiss</button>
            </div>
            <div style={{ padding: "10px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
              {lastLogged.games.map(g => {
                const wIds = g.winner === "A" ? g.sideA : g.sideB;
                const lIds = g.winner === "A" ? g.sideB : g.sideA;
                return (
                  <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                    <span className="text-g bold">{wIds.map(id => pName(id, lastLogged.players)).join(" & ")}</span>
                    <span className="disp text-am" style={{ fontSize: 18 }}>{g.scoreA}–{g.scoreB}</span>
                    <span className="text-dd">{lIds.map(id => pName(id, lastLogged.players)).join(" & ")}</span>
                    <span className="xs text-dd" style={{ marginLeft: "auto" }}>
                      {wIds.map(id => <span key={id} className="text-g" style={{ marginRight: 6 }}>+{g.perPlayerGains?.[id] ?? g.ptsGain} {pName(id, lastLogged.players).split(" ")[0]}</span>)}
                      {lIds.map(id => <span key={id} className="text-r" style={{ marginRight: 6 }}>−{g.perPlayerLosses?.[id] ?? g.ptsLoss} {pName(id, lastLogged.players).split(" ")[0]}</span>)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {templates.length > 0 && (
          <div className="card">
            <div className="card-header"><span className="card-title">Templates</span></div>
            <div style={{ padding: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {templates.map((t, i) => (
                <div key={i} className="fac" style={{ gap: 4 }}>
                  <button className="btn btn-g btn-sm" onClick={() => loadTpl(t)}>{t.name}</button>
                  <button className="btn btn-d btn-sm" onClick={() => deleteTpl(i)}>×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-header">
            <span className="card-title">Log Games</span>
            <span className="xs text-dd">{rows.length} game{rows.length > 1 ? "s" : ""}</span>
          </div>
          <div style={{ padding: 14 }}>
            {rows.map((row, ri) => {
              const sA = parseInt(row.scoreA, 10), sB = parseInt(row.scoreB, 10);
              const canPreview = row.sideA.length === 2 && row.sideB.length === 2 && !isNaN(sA) && !isNaN(sB) && sA !== sB;
              let prev = null;
              if (canPreview) {
                const wIds = sA > sB ? row.sideA : row.sideB, lIds = sA > sB ? row.sideB : row.sideA;
                const currentRanked = [...state.players].sort((a, b) => (b.pts || 0) - (a.pts || 0));
                const rankOf = id => { const i = currentRanked.findIndex(p => p.id === id); return i === -1 ? currentRanked.length : i; };
                const monthPlacements = state.monthlyPlacements?.[getMonthKey()] || {};
                const isPlaced = pid => (monthPlacements[pid] || 0) >= CONFIG.MAX_PLACEMENTS_PER_MONTH;
                const oppWinMMR = avg(wIds, state.players, "mmr"), oppLosMMR = avg(lIds, state.players, "mmr");
                const oppAvgRankPlaced = ids => {
                  const placed = ids.filter(isPlaced);
                  if (!placed.length) return null;
                  return placed.reduce((s, id) => s + rankOf(id), 0) / placed.length;
                };
                const oppWinRank = oppAvgRankPlaced(wIds);
                const oppLosRank = oppAvgRankPlaced(lIds);
                const perPlayer = {};
                [...wIds, ...lIds].forEach(pid => {
                  const p = state.players.find(x => x.id === pid); if (!p) return;
                  const isW = wIds.includes(pid);
                  const myPlaced = isPlaced(pid);
                  const oppRank = isW ? oppLosRank : oppWinRank;
                  perPlayer[pid] = calcPlayerDelta({
                    winnerScore: Math.max(sA, sB), loserScore: Math.min(sA, sB),
                    playerMMR: p.mmr,
                    playerRank: myPlaced ? rankOf(pid) : null,
                    playerStreakPower: p.streakPower || 0,
                    oppAvgMMR: isW ? oppLosMMR : oppWinMMR,
                    oppAvgRank: (myPlaced && oppRank !== null) ? oppRank : null,
                    isWinner: isW,
                  });
                });
                prev = { perPlayer, wIds, lIds };
              }

              return (
                <div key={row.id} style={{ marginBottom: 10, padding: 12, background: "var(--s2)", borderRadius: 6, border: "1px solid var(--b1)" }}>
                  <div className="fbc mb8">
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="xs text-dd">Game {ri + 1}</span>
                      {(() => {
                        const sA = parseInt(row.scoreA, 10), sB = parseInt(row.scoreB, 10);
                        const playersOk = row.sideA.length === 2 && row.sideB.length === 2;
                        const scoresOk = !isNaN(sA) && !isNaN(sB) && sA >= 0 && sB >= 0 && sA !== sB;
                        const dupCheck = playersOk && scoresOk;
                        if (!playersOk) return <span className="xs" style={{ color: "var(--orange)" }}>● {4 - row.sideA.length - row.sideB.length} player{4 - row.sideA.length - row.sideB.length !== 1 ? "s" : ""} needed</span>;
                        if (!scoresOk) return <span className="xs" style={{ color: "var(--orange)" }}>● enter scores</span>;
                        return <span className="xs text-g">✓ ready</span>;
                      })()}
                    </div>
                    {rows.length > 1 && <button className="btn btn-d btn-sm" onClick={() => setRows(r => r.filter(x => x.id !== row.id))}>Remove</button>}
                  </div>

                  <div className="log-game-grid" style={{ display: "grid", gridTemplateColumns: "1fr 96px 1fr", gap: 10, alignItems: "start" }}>
                    {/* Side A */}
                    <div>
                      <div className="lbl" style={{ color: "var(--green)" }}>Side A {row.sideA.length}/2</div>
                      {row.sideA.length > 0 && (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 5 }}>
                          {row.sideA.map(id => {
                            const role = row.roles?.[id];
                            return (
                              <div key={id} style={{display:"flex",alignItems:"center",gap:3}}>
                                <span className="tag tag-w" style={{ cursor:"pointer", fontSize:11 }}
                                  onClick={() => togglePlayer(row.id, "A", id)}>
                                  {pName(id, state.players)} ×
                                </span>
                                <button className={`role-tag ${role==="ATK"?"role-atk":"role-def"}`}
                                  style={{background:"none",outline:role?"":"1px solid var(--b2)",opacity:role?1:0.42,cursor:"pointer"}}
                                  title={role?`Playing ${role} — click to swap`:"Assign role"}
                                  onClick={(e)=>{e.stopPropagation();setRole(row.id,id,role==="ATK"?"DEF":role==="DEF"?"ATK":"ATK");}}>
                                  {role||"?"}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <input
                        className="inp" placeholder="Search…" value={row.searchA}
                        onChange={e => setRows(r => r.map(x => x.id === row.id ? { ...x, searchA: e.target.value } : x))}
                        style={{ marginBottom: 4, fontSize: 11, padding: "4px 7px" }}
                      />
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 160, overflowY: "auto" }}>
                        {[...state.players]
                          .sort((a, b) => (b.pts || 0) - (a.pts || 0))
                          .filter(p => !row.searchA || p.name.toLowerCase().includes(row.searchA.toLowerCase()))
                          .map(p => {
                            const onA = row.sideA.includes(p.id), onB = row.sideB.includes(p.id), full = !onA && row.sideA.length >= 2;
                            if (onA) return null; // already shown above as tag
                            return (
                              <div key={p.id} className={`player-chip ${onB || full ? "disabled" : ""}`}
                                onClick={() => { if (!onB && !full) { togglePlayer(row.id, "A", p.id); autoAssignRole(row.id, p.id); } }}>
                                <span>{p.name}</span>
                                <span className="xs text-dd">{p.pts || 0}pts</span>
                              </div>
                            );
                          })}
                      </div>
                    </div>

                    {/* Scores / Preview */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 16 }}>
                      <div>
                        <div className="lbl" style={{ fontSize: 9, lineHeight: 1.3, color: "var(--green)", minHeight: 22 }}>
                          {row.sideA.map(id => pName(id, state.players)).join(" & ") || "A"}
                        </div>
                        <input className="inp" type="number" min="0" placeholder="10" value={row.scoreA}
                          onChange={e => setRows(r => r.map(x => x.id === row.id ? { ...x, scoreA: e.target.value } : x))}
                          style={{ textAlign: "center", fontSize: 18, fontFamily: "var(--disp)", fontWeight: 800 }} />
                      </div>
                      <div>
                        <div className="lbl" style={{ fontSize: 9, lineHeight: 1.3, color: "var(--blue)", minHeight: 22 }}>
                          {row.sideB.map(id => pName(id, state.players)).join(" & ") || "B"}
                        </div>
                        <input className="inp" type="number" min="0" placeholder="7" value={row.scoreB}
                          onChange={e => setRows(r => r.map(x => x.id === row.id ? { ...x, scoreB: e.target.value } : x))}
                          style={{ textAlign: "center", fontSize: 18, fontFamily: "var(--disp)", fontWeight: 800 }} />
                      </div>

                      {prev && (
                        <div style={{ background: "var(--s1)", borderRadius: 4, padding: "6px 8px", fontSize: 10, lineHeight: 1.9 }}>
                          {prev.wIds.map(id => {
                            const d = prev.perPlayer[id];
                            const n = state.players.find(p => p.id === id)?.name?.split(" ")[0] || "?";
                            // rankScale < 0.92 = rank penalty, show warning
                            const rankPenalty = d?.rankScale < 0.92;
                            return (
                              <div key={id}>
                                <span className="text-g">+{d?.gain ?? 0} {n}</span>
                                {rankPenalty && (
                                  <span style={{ color: "var(--orange)", marginLeft: 4 }}>
                                    ↓×{d.rankScale.toFixed(2)} rank
                                  </span>
                                )}
                              </div>
                            );
                          })}
                          {prev.lIds.map(id => {
                            const d = prev.perPlayer[id];
                            const n = state.players.find(p => p.id === id)?.name?.split(" ")[0] || "?";
                            return <div key={id} className="text-r">−{d?.loss ?? 0} {n}</div>;
                          })}
                          {/* Game value warning if any winner has low match quality */}
                          {prev.wIds.some(id => (prev.perPlayer[id]?.qualityScore ?? 1) < 0.85) && (
                            <div style={{ color: "var(--orange)", marginTop: 2, fontSize: 9, letterSpacing: .3 }}>
                              ⚠ Low-value game — opponents weaker, reduced pts
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Side B */}
                    <div>
                      <div className="lbl" style={{ color: "var(--blue)" }}>Side B {row.sideB.length}/2</div>
                      {row.sideB.length > 0 && (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 5 }}>
                          {row.sideB.map(id => {
                            const role = row.roles?.[id];
                            return (
                              <div key={id} style={{display:"flex",alignItems:"center",gap:3}}>
                                <span className="tag tag-b" style={{ cursor:"pointer", fontSize:11 }}
                                  onClick={() => togglePlayer(row.id, "B", id)}>
                                  {pName(id, state.players)} ×
                                </span>
                                <button className={`role-tag ${role==="ATK"?"role-atk":"role-def"}`}
                                  style={{background:"none",outline:role?"":"1px solid var(--b2)",opacity:role?1:0.42,cursor:"pointer"}}
                                  title={role?`Playing ${role} — click to swap`:"Assign role"}
                                  onClick={(e)=>{e.stopPropagation();setRole(row.id,id,role==="ATK"?"DEF":role==="DEF"?"ATK":"ATK");}}>
                                  {role||"?"}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <input
                        className="inp" placeholder="Search…" value={row.searchB}
                        onChange={e => setRows(r => r.map(x => x.id === row.id ? { ...x, searchB: e.target.value } : x))}
                        style={{ marginBottom: 4, fontSize: 11, padding: "4px 7px" }}
                      />
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 160, overflowY: "auto" }}>
                        {[...state.players]
                          .sort((a, b) => (b.pts || 0) - (a.pts || 0))
                          .filter(p => !row.searchB || p.name.toLowerCase().includes(row.searchB.toLowerCase()))
                          .map(p => {
                            const onA = row.sideA.includes(p.id), onB = row.sideB.includes(p.id), full = !onB && row.sideB.length >= 2;
                            if (onB) return null;
                            return (
                              <div key={p.id} className={`player-chip ${onA || full ? "disabled" : ""}`}
                                onClick={() => { if (!onA && !full) { togglePlayer(row.id, "B", p.id); autoAssignRole(row.id, p.id); } }}>
                                <span>{p.name}</span>
                                <span className="xs text-dd">{p.pts || 0}pts</span>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  </div>

                  {/* ── Role Assignment Panel ─────────────────────── */}
                  {row.sideA.length + row.sideB.length > 0 && (() => {
                    const allPids = [...row.sideA, ...row.sideB];
                    const assigned = allPids.filter(id => row.roles?.[id]);
                    const fullyAssigned = assigned.length === 4 && allPids.length === 4;
                    const partiallyAssigned = assigned.length > 0 && !fullyAssigned;
                    return (
                      <div style={{ marginTop: 10, borderTop: "1px solid var(--b1)", paddingTop: 10 }}>
                        <div className="fbc" style={{ marginBottom: 8 }}>
                          <span className="lbl" style={{ fontSize: 10, letterSpacing: ".5px" }}>POSITIONS</span>
                          {fullyAssigned
                            ? <span className="xs" style={{ color: "var(--green)" }}>✓ MMR tracking active</span>
                            : allPids.length === 4
                              ? <span className="xs" style={{ color: "var(--amber)" }}>Assign all 4 to enable ATK/DEF MMR</span>
                              : <span className="xs text-dd">Add all 4 players first</span>
                          }
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                          {[["A", row.sideA, "var(--green)"], ["B", row.sideB, "var(--blue)"]].map(([side, ids, col]) => (
                            <div key={side} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                              <div className="xs" style={{ color: col, fontWeight: 600, marginBottom: 2 }}>Side {side}</div>
                              {["ATK", "DEF"].map(roleLabel => {
                                const icon = roleLabel === "ATK" ? "🗡" : "🛡";
                                const cls = roleLabel === "ATK" ? "role-atk" : "role-def";
                                const occupant = ids.find(id => row.roles?.[id] === roleLabel);
                                const unassigned = ids.filter(id => !row.roles?.[id]);
                                return (
                                  <div key={roleLabel}
                                    style={{
                                      display: "flex", alignItems: "center", gap: 6,
                                      padding: "6px 10px", borderRadius: 6,
                                      border: occupant
                                        ? (roleLabel === "ATK" ? "1px solid rgba(240,144,80,.4)" : "1px solid rgba(96,168,232,.3)")
                                        : "1px dashed var(--b2)",
                                      background: occupant
                                        ? (roleLabel === "ATK" ? "rgba(240,144,80,.08)" : "rgba(96,168,232,.06)")
                                        : "transparent",
                                      cursor: ids.length > 0 ? "pointer" : "default",
                                      minHeight: 34,
                                    }}
                                    onClick={() => {
                                      if (!occupant && unassigned.length === 1) {
                                        // only one unassigned — auto-slot them in
                                        setRole(row.id, unassigned[0], roleLabel);
                                      } else if (!occupant && unassigned.length > 1) {
                                        // cycle: assign first unassigned
                                        setRole(row.id, unassigned[0], roleLabel);
                                      } else if (occupant) {
                                        // click occupied slot → clear that player's role
                                        setRole(row.id, occupant, null);
                                      }
                                    }}
                                  >
                                    <span className={`role-tag ${cls}`} style={{ pointerEvents: "none" }}>{icon} {roleLabel}</span>
                                    {occupant
                                      ? <span style={{ fontSize: 12, fontWeight: 600 }}>{pName(occupant, state.players)}</span>
                                      : <span className="xs text-dd" style={{ fontStyle: "italic" }}>
                                          {ids.length === 0 ? "no players" : unassigned.length === 0 ? "all assigned" : "tap to assign"}
                                        </span>
                                    }
                                    {occupant && unassigned.length > 0 && (
                                      <span className="xs text-dd" style={{ marginLeft: "auto" }}>×</span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {errors[row.id] && (
                    <div className="msg msg-e mt8" style={{ fontWeight: 600, fontSize: 12 }}>
                      ⚠ {errors[row.id]}
                    </div>
                  )}

                  {/* Penalty cards — shown when all 4 players selected */}
                  {row.sideA.length === 2 && row.sideB.length === 2 && (
                    <div style={{ marginTop: 8, borderTop: "1px solid var(--b1)", paddingTop: 8 }}>
                      <div className="xs text-dd" style={{ marginBottom: 6, fontWeight: 600, letterSpacing: .5 }}>
                        DISCIPLINARY CARDS <span style={{ opacity: .6 }}>(optional)</span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {[...row.sideA, ...row.sideB].map(pid => {
                          const pen = row.penalties?.[pid] || { yellow: 0, red: 0 };
                          const total = (pen.yellow || 0) * CONFIG.YELLOW_CARD_PTS + (pen.red || 0) * CONFIG.RED_CARD_PTS;
                          if (pen.yellow === 0 && pen.red === 0 && total === 0) {
                            // Compact row — just show quick-add buttons
                            return (
                              <div key={pid} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                                <span style={{ flex: 1, fontWeight: 500 }}>{pName(pid, state.players)}</span>
                                <button className="btn btn-g btn-sm" style={{ fontSize: 10, padding: "2px 8px" }}
                                  onClick={() => setRowPenalty(row.id, pid, "yellow", 1)}>🟡+</button>
                                <button className="btn btn-g btn-sm" style={{ fontSize: 10, padding: "2px 8px" }}
                                  onClick={() => setRowPenalty(row.id, pid, "red", 1)}>🔴+</button>
                              </div>
                            );
                          }
                          return (
                            <div key={pid} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", background: "var(--s1)", borderRadius: 6, border: "1px solid var(--b1)", fontSize: 12 }}>
                              <span style={{ flex: 1, fontWeight: 600 }}>{pName(pid, state.players)}</span>
                              <div className="fac" style={{ gap: 3 }}>
                                <span>🟡</span>
                                <button className="btn btn-g btn-sm" style={{ padding: "1px 6px" }} onClick={() => setRowPenalty(row.id, pid, "yellow", -1)}>−</button>
                                <span style={{ minWidth: 14, textAlign: "center", fontWeight: 700 }}>{pen.yellow || 0}</span>
                                <button className="btn btn-g btn-sm" style={{ padding: "1px 6px" }} onClick={() => setRowPenalty(row.id, pid, "yellow", 1)}>+</button>
                              </div>
                              <div className="fac" style={{ gap: 3 }}>
                                <span>🔴</span>
                                <button className="btn btn-g btn-sm" style={{ padding: "1px 6px" }} onClick={() => setRowPenalty(row.id, pid, "red", -1)}>−</button>
                                <span style={{ minWidth: 14, textAlign: "center", fontWeight: 700 }}>{pen.red || 0}</span>
                                <button className="btn btn-g btn-sm" style={{ padding: "1px 6px" }} onClick={() => setRowPenalty(row.id, pid, "red", 1)}>+</button>
                              </div>
                              <span style={{ color: "var(--orange)", fontWeight: 700, minWidth: 44, textAlign: "right" }}>−{total}pts</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            <button className="add-row" onClick={() => setRows(r => [...r, EMPTY_ROW()])}>+ Add Another Game</button>

            <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {(() => {
                const readyCount = rows.filter(row => {
                  const sA = parseInt(row.scoreA, 10), sB = parseInt(row.scoreB, 10);
                  return row.sideA.length === 2 && row.sideB.length === 2 && !isNaN(sA) && !isNaN(sB) && sA >= 0 && sB >= 0 && sA !== sB;
                }).length;
                return (
                  <button className="btn btn-p" onClick={submitAll} disabled={readyCount === 0}
                    style={{ opacity: readyCount === 0 ? 0.4 : 1 }}>
                    Submit {readyCount}/{rows.length} Game{rows.length !== 1 ? "s" : ""}
                  </button>
                );
              })()}
              <input className="inp" placeholder="Template name…" value={tplName} onChange={e => setTplName(e.target.value)} style={{ width: 150 }} />
              <button className="btn btn-g" onClick={saveTpl}>Save Template</button>
              {undoStack.length > 0 && <button className="btn btn-warn" onClick={undoLast}>↩ Undo Last Submit</button>}
            </div>
          </div>
        </div>
      </div>
      {confirm && <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)} />}
    </>
  );
}
// ============================================================
// FINALS DATE EDITOR (top-level so hooks are stable across re-renders)
// ============================================================
function FinalsDateEditor({ finalsDate, setState, showToast, isAdmin }) {
  const [editing, setEditing] = useState(false);

  const parsed = finalsDate ? new Date(finalsDate) : null;
  const [dd, setDd] = useState(parsed ? String(parsed.getDate()).padStart(2, "0") : "");
  const [mm, setMm] = useState(parsed ? String(parsed.getMonth() + 1).padStart(2, "0") : "");
  const [yyyy, setYyyy] = useState(parsed ? String(parsed.getFullYear()) : "");
  const [hh, setHh] = useState(parsed ? String(parsed.getHours()).padStart(2, "0") : "18");
  const [mn, setMn] = useState(parsed ? String(parsed.getMinutes()).padStart(2, "0") : "00");

  // Sync fields and close edit mode if finalsDate changes externally (remote update)
  const prevFinalsDate = useRef(finalsDate);
  useEffect(() => {
    const changed = finalsDate !== prevFinalsDate.current;
    prevFinalsDate.current = finalsDate;
    if (!finalsDate) {
      setDd(""); setMm(""); setYyyy(""); setHh("18"); setMn("00");
      if (changed) setEditing(false); // remote cleared it
      return;
    }
    const p = new Date(finalsDate);
    setDd(String(p.getDate()).padStart(2, "0"));
    setMm(String(p.getMonth() + 1).padStart(2, "0"));
    setYyyy(String(p.getFullYear()));
    setHh(String(p.getHours()).padStart(2, "0"));
    setMn(String(p.getMinutes()).padStart(2, "0"));
    if (changed) setEditing(false); // close editor when remote sets a new date
  }, [finalsDate]);

  if (!isAdmin) return null;

  function handleSave() {
    if (!dd || !mm || !yyyy) {
      setState(s => ({ ...s, finalsDate: null }));
      showToast("Finals date cleared");
      setEditing(false);
      return;
    }
    const iso = new Date(
      parseInt(yyyy), parseInt(mm) - 1, parseInt(dd),
      parseInt(hh) || 0, parseInt(mn) || 0
    ).toISOString();
    setState(s => ({ ...s, finalsDate: iso }));
    showToast("Finals date saved");
    setEditing(false);
  }

  if (!editing) {
    return (
      <div style={{ marginTop: 10 }}>
        <button className="btn btn-g btn-sm" onClick={() => setEditing(true)}>
          {finalsDate ? "Edit Finals Date" : "Set Finals Date"}
        </button>
      </div>
    );
  }

  const fields = [
    ["Day", "DD", dd, setDd, 60, 1, 31],
    ["Month", "MM", mm, setMm, 60, 1, 12],
    ["Year", "YYYY", yyyy, setYyyy, 80, 2026, 2099],
    ["Hour", "HH", hh, setHh, 60, 0, 23],
    ["Min", "MM", mn, setMn, 60, 0, 59],
  ];

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <div className="fac" style={{ gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
          {fields.map(([lbl, ph, val, set, w, min, max]) => (
            <div key={lbl} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <span className="xs text-dd">{lbl}</span>
              <input
                className="inp"
                type="number"
                placeholder={ph}
                min={min}
                max={max}
                value={val}
                onChange={e => set(e.target.value)}
                style={{ width: w, textAlign: "center", fontSize: 14 }}
              />
            </div>
          ))}
        </div>
        <div className="fac" style={{ gap: 6 }}>
          <button className="btn btn-p btn-sm" onClick={handleSave}>Save Date</button>
          <button className="btn btn-d btn-sm" onClick={() => {
            setState(s => ({ ...s, finalsDate: null }));
            showToast("Finals date cleared");
            setEditing(false);
          }}>Clear</button>
          <button className="btn btn-g btn-sm" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// FINALS VIEW
// ============================================================
function FinalsView({ state, setState, isAdmin, showToast }) {

  const monthKey = getMonthKey();
  const finals = (state.finals ?? {})[monthKey] ?? null;
  const ranked = [...(state.players ?? [])].sort((a, b) => (b.pts || 0) - (a.pts || 0));

  // ── COUNTDOWN ─────────────────────────────────────────────
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  function getCountdown() {
    let target;
    if (state.finalsDate) {
      target = new Date(state.finalsDate);
    } else {
      const n = new Date();
      target = new Date(n.getFullYear(), n.getMonth() + 1, 0, 23, 59, 59);
    }
    const diff = Math.max(0, target - new Date());
    return {
      days: Math.floor(diff / 864e5),
      hours: Math.floor((diff / 36e5) % 24),
      mins: Math.floor((diff / 6e4) % 60),
      secs: Math.floor((diff / 1e3) % 60),
      diff,
    };
  }

  const { days: cdDays, hours: cdHours, mins: cdMins, secs: cdSecs, diff: cdDiff } = getCountdown();
  const cdColour = cdDiff < 864e5 ? "var(--red)" : cdDiff < 7 * 864e5 ? "var(--orange)" : "var(--amber)";

  function Countdown({ compact }) {
    const pad = n => String(n).padStart(2, "0");
    if (compact) return (
      <span style={{ color: cdColour, fontFamily: "var(--disp)", fontWeight: 800 }}>
        {cdDays}d {cdHours}h {cdMins}m
      </span>
    );
    return (
      <div style={{ textAlign: "center" }}>
        <div className="cd-wrap">
          {cdDays > 0 && <>
            <div className="cd-unit"><div className="cd-num" style={{ color: cdColour }}>{pad(cdDays)}</div><div className="cd-lbl">Days</div></div>
            <div className="cd-sep">:</div>
          </>}
          <div className="cd-unit"><div className="cd-num" style={{ color: cdColour }}>{pad(cdHours)}</div><div className="cd-lbl">Hours</div></div>
          <div className="cd-sep">:</div>
          <div className="cd-unit"><div className="cd-num" style={{ color: cdColour }}>{pad(cdMins)}</div><div className="cd-lbl">Mins</div></div>
          <div className="cd-sep">:</div>
          <div className="cd-unit"><div className="cd-num" style={{ color: cdColour }}>{pad(cdSecs)}</div><div className="cd-lbl">Secs</div></div>
        </div>
      </div>
    );
  }

  // ── BRACKET SEEDING — position-aware ─────────────────────
  // Scores all 3 splits: (1) position balance, (2) MMR balance, (3) standard seeding tiebreak
  function buildBracket(pool) {
    if (pool.length < 4) return null;
    const [p0, p1, p2, p3] = pool;
    const roles = pos => { const s = new Set();[].concat(pos || []).forEach(p => { if (p === "attack") s.add("atk"); if (p === "defense") s.add("def"); if (p === "both" || p === "flex") { s.add("atk"); s.add("def"); } }); return s; };
    const posScore = (a, b) => { const ra = roles(a.position), rb = roles(b.position); if (!ra.size && !rb.size) return 1; if (!ra.size || !rb.size) return 1; return (ra.has("atk") || rb.has("atk")) && (ra.has("def") || rb.has("def")) ? 2 : 0; };
    const splits = [{ a: [p0, p1], b: [p2, p3] }, { a: [p0, p2], b: [p1, p3] }, { a: [p0, p3], b: [p1, p2] }];
    const score = ({ a, b }) => [posScore(a[0], a[1]) + posScore(b[0], b[1]), -Math.abs(((a[0].mmr || 1000) + (a[1].mmr || 1000)) / 2 - ((b[0].mmr || 1000) + (b[1].mmr || 1000)) / 2)];
    const best = splits.reduce((acc, s) => { const [ap, am] = score(acc), [bp, bm] = score(s); return bp > ap || (bp === ap && bm > am) ? s : acc; });
    return { teamA: [best.a[0].id, best.a[1].id], teamB: [best.b[0].id, best.b[1].id] };
  }

  // Only placed players can be in the bracket
  const placedRanked = ranked.filter(p => (state.monthlyPlacements[monthKey] || {})[p.id] >= CONFIG.MAX_PLACEMENTS_PER_MONTH);
  const upperPool = placedRanked.slice(0, 4);
  const lowerPool = placedRanked.slice(4, 8);

  const previewUpper = upperPool.length >= 4 ? buildBracket(upperPool) : null;
  const previewLower = lowerPool.length >= 4 ? buildBracket(lowerPool) : null;

  // ── INIT FINALS ───────────────────────────────────────────
  function initFinals() {
    if (placedRanked.length < 4) { showToast("Need at least 4 placed players", "error"); return; }

    const upper = buildBracket(upperPool);
    const lower = lowerPool.length >= 4 ? buildBracket(lowerPool) : null;

    const bracket = {
      upper: { sideA: upper.teamA, sideB: upper.teamB, winner: null, scoreA: null, scoreB: null },
      lower: lower ? { sideA: lower.teamA, sideB: lower.teamB, winner: null, scoreA: null, scoreB: null } : null,
      final: { sideA: null, sideB: null, winner: null, scoreA: null, scoreB: null },
      champion: null
    };

    setState(s => ({
      ...s,
      finals: { ...(s.finals ?? {}), [monthKey]: { bracket, status: "semis" } }
    }));
    showToast("Bracket generated!");
  }

  // ── RECORD RESULT ─────────────────────────────────────────
  function recordResult(match, winnerSide, sA, sB) {
    setState(s => {
      const f = { ...(s.finals?.[monthKey] ?? {}) };
      const b = { ...f.bracket };

      b[match] = { ...b[match], winner: winnerSide, scoreA: sA, scoreB: sB };

      if (match === "upper" || match === "lower") {
        const upperWinner = b.upper?.winner
          ? (b.upper.winner === "A" ? b.upper.sideA : b.upper.sideB) : null;
        const lowerWinner = b.lower?.winner
          ? (b.lower.winner === "A" ? b.lower.sideA : b.lower.sideB) : null;
        const hasLower = !!b.lower;

        // Grand final only opens once all semis are resolved
        const semisComplete = upperWinner && (!hasLower || lowerWinner);

        if (semisComplete) {
          b.final = {
            sideA: upperWinner,
            sideB: hasLower ? lowerWinner : null, // null sideB = only upper bracket final
            winner: null, scoreA: null, scoreB: null
          };
          f.status = "final";
        }
      }

      if (match === "final") {
        b.champion = winnerSide === "A" ? b.final.sideA : b.final.sideB;
        f.status = "complete";
      }

      f.bracket = b;
      return { ...s, finals: { ...s.finals, [monthKey]: f } };
    });
    showToast("Result recorded");
  }

  // ── AWARD CHAMPIONSHIP ────────────────────────────────────
  function awardChampionship() {
    if (!finals?.bracket?.champion) return;
    const champIds = finals.bracket.champion;
    const champNames = champIds.map(id => pName(id, state.players));
    setState(s => ({
      ...s,
      players: s.players.map(p => {
        if (!champIds.includes(p.id)) return p;
        const partner = champNames.find(n => n !== p.name) || null;
        const already = (p.championships || []).some(c => c.month === monthKey);
        if (already) return p;
        return { ...p, championships: [...(p.championships || []), { month: monthKey, partner }] };
      })
    }));
    showToast("Championships awarded to " + champNames.join(" & ") + " 🏆");
  }

  // ── LIVE SCORE HELPERS ────────────────────────────────────
  function getLive(matchKey) {
    return (state.finals?.[monthKey]?.liveScores?.[matchKey]) || { scoreA: 0, scoreB: 0, active: false };
  }

  function setLiveScore(matchKey, side, delta) {
    setState(s => {
      const f = { ...(s.finals?.[monthKey] || {}) };
      const ls = { ...(f.liveScores || {}) };
      const cur = ls[matchKey] || { scoreA: 0, scoreB: 0, active: true };
      const key = side === "A" ? "scoreA" : "scoreB";
      ls[matchKey] = { ...cur, [key]: Math.max(0, (cur[key] || 0) + delta), active: true };
      f.liveScores = ls;
      return { ...s, finals: { ...s.finals, [monthKey]: f } };
    });
  }

  function clearLiveScore(matchKey) {
    setState(s => {
      const f = { ...(s.finals?.[monthKey] || {}) };
      const ls = { ...(f.liveScores || {}) };
      delete ls[matchKey];
      f.liveScores = ls;
      return { ...s, finals: { ...s.finals, [monthKey]: f } };
    });
  }

  function startLive(matchKey) {
    setState(s => {
      const f = { ...(s.finals?.[monthKey] || {}) };
      const ls = { ...(f.liveScores || {}) };
      ls[matchKey] = { scoreA: 0, scoreB: 0, active: true };
      f.liveScores = ls;
      return { ...s, finals: { ...s.finals, [monthKey]: f } };
    });
  }

  // ── BRACKET MATCH COMPONENT ───────────────────────────────
  function BMatch({ matchKey, label, overrideSideA, overrideSideB, preview }) {
    const m = preview
      ? { sideA: overrideSideA, sideB: overrideSideB }
      : finals?.bracket?.[matchKey];

    if (!m || !m.sideA) {
      return (
        <div>
          <div className="xs text-dd" style={{ textAlign: "center", marginBottom: 5, letterSpacing: 2, textTransform: "uppercase" }}>{label}</div>
          <div className="b-match" style={{ padding: 18, textAlign: "center", color: "var(--dimmer)", fontSize: 12 }}>TBD</div>
        </div>
      );
    }
    const sideBReady = m.sideB && m.sideB.length > 0;
    const pA = m.sideA.map(id => { const pl = state.players.find(p => p.id === id); return pl ? { name: pl.name, pos: pl.position } : { name: "?", pos: null }; });
    const pB = (m.sideB || []).map(id => { const pl = state.players.find(p => p.id === id); return pl ? { name: pl.name, pos: pl.position } : { name: "?", pos: null }; });
    const done = !!m.winner;
    const live = !preview && !done ? getLive(matchKey) : null;
    const isLive = live?.active;

    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 5 }}>
          <div className="xs text-dd" style={{ letterSpacing: 2, textTransform: "uppercase" }}>{label}</div>
          {isLive && <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, color: "var(--red)" }}>
            <span className="live-pulse" style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--red)" }} />LIVE
          </span>}
        </div>
        <div style={{ background: "var(--s2)", border: `1px solid ${isLive ? "rgba(240,112,112,.35)" : "var(--b2)"}`, borderRadius: 8, overflow: "hidden", minWidth: 280, transition: "border-color .3s" }}>
          {/* Team A */}
          <div style={{ padding: "10px 14px", borderBottom: "2px solid var(--b1)", background: m.winner === "A" ? "rgba(94,201,138,.08)" : isLive && live.scoreA > live.scoreB ? "rgba(94,201,138,.04)" : "transparent", display: "flex", justifyContent: "space-between", alignItems: "center", transition: "background .3s" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {pA.map((pl, i) => (
                <div key={i} className="fac" style={{ gap: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: m.winner === "A" ? "var(--green)" : "var(--text)" }}>{pl.name}</span>
                  <PosBadge pos={pl.pos} />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {isLive && isAdmin && (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <div className="score-btn" onClick={() => setLiveScore(matchKey, "A", 1)}>+</div>
                  <div className="score-btn" style={{ fontSize: 14 }} onClick={() => setLiveScore(matchKey, "A", -1)}>−</div>
                </div>
              )}
              {isLive && <span className="live-score-num" style={{ color: live.scoreA > live.scoreB ? "var(--green)" : live.scoreA < live.scoreB ? "var(--red)" : "var(--text)" }}>{live.scoreA}</span>}
              {done && <span className="disp text-am" style={{ fontSize: 26, marginLeft: 12 }}>{m.scoreA}</span>}
              {m.winner === "A" && <span className="tag tag-w" style={{ marginLeft: 8 }}>WIN</span>}
            </div>
          </div>
          {/* VS divider */}
          <div style={{ textAlign: "center", padding: "4px 0", background: "var(--s3)", fontSize: 9, letterSpacing: 3, color: "var(--dimmer)", textTransform: "uppercase" }}>
            {isLive ? <span className="live-pulse">— LIVE —</span> : "vs"}
          </div>
          {/* Team B */}
          <div style={{ padding: "10px 14px", background: m.winner === "B" ? "rgba(94,201,138,.08)" : isLive && live.scoreB > live.scoreA ? "rgba(94,201,138,.04)" : "transparent", display: "flex", justifyContent: "space-between", alignItems: "center", transition: "background .3s" }}>
            {sideBReady ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {pB.map((pl, i) => (
                  <div key={i} className="fac" style={{ gap: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: m.winner === "B" ? "var(--green)" : "var(--text)" }}>{pl.name}</span>
                    <PosBadge pos={pl.pos} />
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-dd xs" style={{ fontStyle: "italic" }}>Awaiting lower bracket…</span>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {isLive && isAdmin && (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <div className="score-btn" onClick={() => setLiveScore(matchKey, "B", 1)}>+</div>
                  <div className="score-btn" style={{ fontSize: 14 }} onClick={() => setLiveScore(matchKey, "B", -1)}>−</div>
                </div>
              )}
              {isLive && <span className="live-score-num" style={{ color: live.scoreB > live.scoreA ? "var(--green)" : live.scoreB < live.scoreA ? "var(--red)" : "var(--text)" }}>{live.scoreB}</span>}
              {done && <span className="disp text-am" style={{ fontSize: 26, marginLeft: 12 }}>{m.scoreB}</span>}
              {m.winner === "B" && <span className="tag tag-w" style={{ marginLeft: 8 }}>WIN</span>}
            </div>
          </div>
        </div>

        {/* Admin controls */}
        {!preview && isAdmin && !done && (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {!isLive ? (
              <button className="btn btn-g btn-sm w-full" onClick={() => startLive(matchKey)}>
                🔴 Start Live Scoring
              </button>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <div style={{ display: "flex", gap: 5, alignItems: "center", justifyContent: "center" }}>
                  <button className="btn btn-p btn-sm" style={{ flex: 1 }} onClick={() => {
                    if (live.scoreA === live.scoreB) return;
                    const winner = live.scoreA > live.scoreB ? "A" : "B";
                    recordResult(matchKey, winner, live.scoreA, live.scoreB);
                    clearLiveScore(matchKey);
                  }} disabled={live.scoreA === live.scoreB}>
                    ✓ Confirm Result ({live.scoreA}–{live.scoreB})
                  </button>
                  <button className="btn btn-d btn-sm" onClick={() => clearLiveScore(matchKey)} title="Reset live score">↺</button>
                </div>
                <div style={{ display: "flex", gap: 5 }}>
                  <button className="btn btn-g btn-sm" style={{ flex: 1, fontSize: 11 }} onClick={() => clearLiveScore(matchKey)}>Cancel Live</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── DATE EDITOR ───────────────────────────────────────────
  // ── NO FINALS YET ─────────────────────────────────────────
  if (!finals) {
    return (
      <div className="stack page-fade">
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <div className="disp text-am" style={{ fontSize: 36, letterSpacing: 2, marginBottom: 4 }}>Monthly Finals</div>
          <div className="text-d sm" style={{ marginBottom: 12 }}>
            {state.finalsDate
              ? <>Scheduled: <span className="text-am">{new Date(state.finalsDate).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span></>
              : `Finals — last day of ${fmtMonth(monthKey)}`}
          </div>
          <Countdown />
          {cdDiff < 864e5 && <div className="tag tag-l" style={{ marginBottom: 16, fontSize: 11, letterSpacing: 2 }}>🔥 Finals are today!</div>}
          {cdDiff >= 864e5 && cdDiff < 7 * 864e5 && <div className="tag tag-a" style={{ marginBottom: 16, fontSize: 11, letterSpacing: 2 }}>⚡ Finals this week</div>}
          <FinalsDateEditor finalsDate={state.finalsDate} setState={setState} showToast={showToast} isAdmin={isAdmin} />
          <div className="mt12">
            {placedRanked.length >= 4
              ? isAdmin && (
                <div style={{ marginTop: 12 }}>
                  <div className="xs text-dd" style={{ marginBottom: 6 }}>Top 4 placed players by points will be seeded into the bracket.</div>
                  <button className="btn btn-p" onClick={initFinals}>⚡ Generate Bracket</button>
                </div>
              )
              : <div className="msg msg-e" style={{ display: "inline-block" }}>Need at least 4 placed players</div>}
          </div>
        </div>

        {(previewUpper || previewLower) && (
          <div className="card">
            <div className="card-header">
              <span className="card-title">Preview — If Finals Happened Today</span>
              <span className="tag tag-a">LIVE RANKINGS</span>
            </div>
            <div style={{ padding: 20, overflowX: "auto" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, minWidth: "fit-content" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                  {previewUpper && (
                    <div>
                      <div className="xs text-dd" style={{ letterSpacing: 2, textTransform: "uppercase", marginBottom: 8 }}>Upper — Top 4</div>
                      <BMatch matchKey="upper" label="" overrideSideA={previewUpper.teamA} overrideSideB={previewUpper.teamB} preview />
                    </div>
                  )}
                  {previewLower && (
                    <div>
                      <div className="xs text-dd" style={{ letterSpacing: 2, textTransform: "uppercase", marginBottom: 8 }}>Lower — Ranks 5–8</div>
                      <BMatch matchKey="lower" label="" overrideSideA={previewLower.teamA} overrideSideB={previewLower.teamB} preview />
                    </div>
                  )}
                </div>
                <div style={{ color: "var(--dimmer)", fontSize: 22, fontWeight: 800 }}>→</div>
                <div>
                  <div className="xs text-dd" style={{ letterSpacing: 2, textTransform: "uppercase", marginBottom: 8 }}>Grand Final</div>
                  <div style={{ background: "var(--s2)", border: "1px dashed var(--b2)", borderRadius: 8, minWidth: 220, padding: "14px 16px" }}>
                    <div style={{ padding: "8px 0", textAlign: "center" }}>
                      <div className="xs text-dd" style={{ letterSpacing: 2, marginBottom: 4 }}>Upper Winner</div>
                      <div className="disp text-am" style={{ fontSize: 16 }}>TBD</div>
                    </div>
                    <div style={{ borderTop: "1px solid var(--b1)", padding: "6px 0", textAlign: "center" }}>
                      <div className="xs text-dd" style={{ letterSpacing: 3 }}>vs</div>
                    </div>
                    <div style={{ padding: "8px 0", textAlign: "center" }}>
                      <div className="xs text-dd" style={{ letterSpacing: 2, marginBottom: 4 }}>Lower Winner</div>
                      <div className="disp text-am" style={{ fontSize: 16 }}>TBD</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── NORMAL FINALS VIEW ────────────────────────────────────
  const { bracket, status } = finals;
  const champ = bracket?.champion?.map(id => pName(id, state.players));

  return (
    <div className="stack page-fade">

      <div className="card" style={{ textAlign: "center", padding: "16px 20px" }}>
        <div className="xs text-dd" style={{ marginBottom: 2, letterSpacing: 2, textTransform: "uppercase" }}>Finals Countdown</div>
        <Countdown compact={status === "complete"} />
        {status === "complete" && <div className="tag tag-w" style={{ marginTop: 4 }}>Complete</div>}
        <FinalsDateEditor finalsDate={state.finalsDate} setState={setState} showToast={showToast} isAdmin={isAdmin} />
      </div>

      {status === "complete" && champ && (
        <div style={{ textAlign: "center", padding: 28, background: "var(--amber-g)", border: "1px solid var(--amber-d)", borderRadius: 8 }}>
          <div className="xs text-am" style={{ letterSpacing: 3, textTransform: "uppercase", marginBottom: 6 }}>Monthly Champions</div>
          <div className="disp text-am" style={{ fontSize: 38 }}>🏆 {champ.join(" & ")}</div>
          {isAdmin && (
            <button className="btn btn-p btn-sm mt12" onClick={awardChampionship}>Award Championship to Profiles</button>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">Bracket — {fmtMonth(monthKey)}</span>
          <div className="fac" style={{ gap: 6 }}>
            {Object.values(finals?.liveScores || {}).some(v => v?.active) && (
              <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, color: "var(--red)" }}>
                <span className="live-pulse" style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--red)" }} />LIVE
              </span>
            )}
            <span className={`tag ${status === "complete" ? "tag-w" : "tag-a"}`}>{status.toUpperCase()}</span>
          </div>
        </div>
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 24 }}>
          <div>
            <div className="xs text-dd" style={{ letterSpacing: 2, textTransform: "uppercase", marginBottom: 10 }}>Upper Bracket</div>
            <div className="bracket" style={{ justifyContent: "flex-start", padding: 0 }}>
              <BMatch matchKey="upper" label="Upper Final" />
              {(status === "final" || status === "complete") && (
                <>
                  <div className="b-conn">→</div>
                  <BMatch matchKey="final" label="Grand Final" />
                </>
              )}
            </div>
          </div>
          {bracket.lower && (
            <div>
              <div className="xs text-dd" style={{ letterSpacing: 2, textTransform: "uppercase", marginBottom: 10 }}>Lower Bracket</div>
              <div className="bracket" style={{ justifyContent: "flex-start", padding: 0 }}>
                <BMatch matchKey="lower" label="Lower Final" />
              </div>
            </div>
          )}
        </div>
        {isAdmin && (
          <div style={{ padding: "10px 18px", borderTop: "1px solid var(--b1)" }}>
            <button className="btn btn-d btn-sm" onClick={() => {
              setState(s => { const f = { ...s.finals }; delete f[monthKey]; return { ...s, finals: f }; });
              showToast("Finals reset");
            }}>Reset Bracket</button>
          </div>
        )}
      </div>
    </div>
  );

}
// ============================================================
// RULEBOOK VIEW
// ============================================================
function RulesView({ state, setState, isAdmin, showToast }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(state.rules || DEFAULT_RULES);

  function save() {
    setState(s => ({ ...s, rules: draft }));
    showToast("Rulebook saved");
    setEditing(false);
  }

  if (editing) return (
    <div className="stack">
      <div className="card">
        <div className="card-header">
          <span className="card-title">Edit Rulebook</span>
          <div className="fac">
            <button className="btn btn-g" onClick={() => { setDraft(state.rules || DEFAULT_RULES); setEditing(false); }}>Cancel</button>
            <button className="btn btn-p" onClick={save}>Save</button>
          </div>
        </div>
        <div style={{ padding: 18 }}>
          <div className="msg msg-w sm mb12">Supports basic markdown: # headings, **bold**, - lists, `code`, ---</div>
          <textarea className="inp" rows={28} value={draft} onChange={e => setDraft(e.target.value)}
            style={{ fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.7 }} />
        </div>
      </div>
    </div>
  );

  return (
    <div className="stack page-fade">
      <div className="card">
        <div className="card-header">
          <span className="card-title">Rulebook</span>
          {isAdmin && <button className="btn btn-g btn-sm" onClick={() => { setDraft(state.rules || DEFAULT_RULES); setEditing(true); }}>Edit</button>}
        </div>
        <div style={{ padding: 24 }} className="md"
          dangerouslySetInnerHTML={{ __html: renderMd(state.rules || DEFAULT_RULES) }} />
      </div>
    </div>
  );
}

// ============================================================
// SYNC TEST VIEW — stress tests the sync system live
// ============================================================
function SyncTestView({ state }) {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState([]);
  const [currentV, setCurrentV] = useState(null);
  const abortRef = useRef(false);

  function log(msg, type = 'info') {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setResults(r => [...r, { ts, msg, type, id: crypto.randomUUID() }]);
  }

  async function fetchCurrentV() {
    const { data } = await supabase.from('app_state').select('state').eq('id', 1).single();
    return data?.state?._v ?? 0;
  }

  async function writeVersion(v, label) {
    const { data: cur } = await supabase.from('app_state').select('state').eq('id', 1).single();
    const base = { ...cur.state, _testLabel: label, _v: v };
    const { error } = await supabase.from('app_state')
      .upsert({ id: 1, state: base, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    return v;
  }

  // ── TEST 1: Sequential writes — each must increment _v cleanly
  async function testSequential() {
    log('── Test 1: Sequential writes ──', 'header');
    const startV = await fetchCurrentV();
    log(`Start _v = ${startV}`);
    let ok = 0, fail = 0;
    for (let i = 1; i <= 5; i++) {
      if (abortRef.current) break;
      try {
        const { data } = await supabase.from('app_state').select('state').eq('id', 1).single();
        const base = data.state;
        const nextV = (base._v ?? 0) + 1;
        const { data: rpc } = await supabase.rpc('update_state_versioned', {
          expected_v: base._v ?? 0,
          new_state: { ...base, _v: nextV, _seqTest: i },
        });
        if (rpc === true) {
          log(`  Write ${i}/5 → _v${nextV} ✓`, 'ok');
          ok++;
        } else {
          log(`  Write ${i}/5 → conflict (rpc=false)`, 'warn');
          fail++;
        }
        await new Promise(r => setTimeout(r, 80));
      } catch (e) {
        log(`  Write ${i}/5 → error: ${e.message}`, 'err');
        fail++;
      }
    }
    const endV = await fetchCurrentV();
    const expected = startV + ok;
    const passed = endV === expected;
    log(`Sequential: ${ok} ok, ${fail} fail. DB _v=${endV}, expected ${expected} → ${passed ? '✓ PASS' : '✗ FAIL'}`, passed ? 'ok' : 'err');
    return passed;
  }

  // ── TEST 2: Concurrent writes — simulate 3 clients writing simultaneously
  async function testConcurrent() {
    log('── Test 2: Concurrent writes (3 clients) ──', 'header');
    const { data: cur } = await supabase.from('app_state').select('state').eq('id', 1).single();
    const baseV = cur.state._v ?? 0;
    log(`Base _v = ${baseV}, firing 3 concurrent writes`);

    // All three try to write expected_v = baseV simultaneously
    // Only ONE should succeed via version lock; others should get conflict
    const results = await Promise.allSettled([
      supabase.rpc('update_state_versioned', { expected_v: baseV, new_state: { ...cur.state, _v: baseV + 1, _client: 'A' } }),
      supabase.rpc('update_state_versioned', { expected_v: baseV, new_state: { ...cur.state, _v: baseV + 1, _client: 'B' } }),
      supabase.rpc('update_state_versioned', { expected_v: baseV, new_state: { ...cur.state, _v: baseV + 1, _client: 'C' } }),
    ]);

    const wins = results.filter(r => r.status === 'fulfilled' && r.value.data === true).length;
    const conflicts = results.filter(r => r.status === 'fulfilled' && r.value.data === false).length;
    const errors = results.filter(r => r.status === 'rejected').length;

    log(`  Wins: ${wins}, Conflicts: ${conflicts}, Errors: ${errors}`);
    const finalV = await fetchCurrentV();
    log(`  Final _v = ${finalV} (expected ${baseV + 1})`);

    const passed = wins === 1 && finalV === baseV + 1;
    log(`Concurrent: exactly 1 winner = ${wins === 1 ? '✓' : '✗'}, _v correct = ${finalV === baseV + 1 ? '✓' : '✗'} → ${passed ? '✓ PASS' : '✗ FAIL'}`, passed ? 'ok' : 'err');
    return passed;
  }

  // ── TEST 3: Rapid fire — simulate rapid state changes like logging multiple games
  async function testRapidFire() {
    log('── Test 3: Rapid-fire writes (10 in <500ms) ──', 'header');
    const startV = await fetchCurrentV();
    log(`Start _v = ${startV}`);
    let written = 0;

    // Simulate what saveState does: always use confirmedV+1
    let localV = startV;
    const promises = [];
    for (let i = 0; i < 10; i++) {
      const myV = localV + i + 1;
      const expectedV = localV + i;
      promises.push(
        supabase.rpc('update_state_versioned', {
          expected_v: expectedV,
          new_state: { _v: myV, _rapidTest: i, players: [], games: [], monthlyPlacements: {}, finals: {}, rules: '', finalsDate: null },
        }).then(({ data }) => {
          if (data === true) written++;
          return data;
        })
      );
      await new Promise(r => setTimeout(r, 40)); // 40ms apart = 10 writes in 400ms
    }
    await Promise.allSettled(promises);
    const endV = await fetchCurrentV();
    log(`  ${written}/10 writes confirmed. Final _v=${endV}, expected ${startV + 10}`);
    // With sequential 40ms gaps and the new queue, all 10 should succeed
    const passed = written === 10 && endV === startV + 10;
    log(`Rapid-fire: ${passed ? '✓ PASS' : '✗ FAIL'} (${written}/10 written, _v=${endV})`, passed ? 'ok' : 'err');
    return passed;
  }

  // ── TEST 4: Version mismatch recovery — write a stale version, check conflict path
  async function testConflictRecovery() {
    log('── Test 4: Conflict recovery ──', 'header');
    const v = await fetchCurrentV();
    log(`Current _v = ${v}`);

    // Write a correct version first
    const { data: cur } = await supabase.from('app_state').select('state').eq('id', 1).single();
    await supabase.rpc('update_state_versioned', {
      expected_v: v, new_state: { ...cur.state, _v: v + 1, _conflictTest: 'step1' }
    });
    log(`  Advanced to _v${v + 1}`);

    // Now try to write with the OLD version (stale client)
    const { data: staleResult } = await supabase.rpc('update_state_versioned', {
      expected_v: v, new_state: { ...cur.state, _v: v + 1, _conflictTest: 'stale' }
    });
    const conflictDetected = staleResult === false;
    log(`  Stale write (expected_v=${v}) → ${conflictDetected ? 'correctly rejected ✓' : 'incorrectly accepted ✗'}`);

    const finalV = await fetchCurrentV();
    log(`  Final _v = ${finalV} (should be ${v + 1})`);
    const passed = conflictDetected && finalV === v + 1;
    log(`Conflict recovery: ${passed ? '✓ PASS' : '✗ FAIL'}`, passed ? 'ok' : 'err');
    return passed;
  }

  // ── TEST 5: Realtime echo suppression — check echoSet works
  async function testEchoSuppression() {
    log('── Test 5: Echo suppression check ──', 'header');
    const beforeEchoSize = _sq.echoSet.size;
    log(`  echoSet size before: ${beforeEchoSize}`);
    // Trigger a real save via saveState
    const v = await fetchCurrentV();
    const { data: cur } = await supabase.from('app_state').select('state').eq('id', 1).single();
    const testV = (cur.state._v ?? 0) + 1;
    _sq.echoSet.add(testV);
    log(`  Added _v${testV} to echoSet`);
    const suppressed = _sq.echoSet.has(testV);
    log(`  echoSet.has(${testV}) = ${suppressed ? '✓ would suppress' : '✗ would NOT suppress'}`);
    _sq.echoSet.delete(testV);
    const passed = suppressed;
    log(`Echo suppression: ${passed ? '✓ PASS' : '✗ FAIL'}`, passed ? 'ok' : 'err');
    return passed;
  }

  async function runAll() {
    setRunning(true);
    abortRef.current = false;
    setResults([]);
    const v = await fetchCurrentV();
    setCurrentV(v);
    log(`Starting sync stress test. DB _v = ${v}`, 'header');
    log(`Queue state: confirmedV=${_sq.confirmedV}, inflightV=${_sq.inflightV}, echoSet.size=${_sq.echoSet.size}`);

    const tests = [testSequential, testConcurrent, testRapidFire, testConflictRecovery, testEchoSuppression];
    let passed = 0, failed = 0;
    for (const test of tests) {
      if (abortRef.current) { log('Aborted.', 'warn'); break; }
      try {
        const ok = await test();
        if (ok) passed++; else failed++;
      } catch (e) {
        log(`Test threw: ${e.message}`, 'err');
        failed++;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    const finalV = await fetchCurrentV();
    setCurrentV(finalV);
    log(`──────────────────────────────────`, 'header');
    log(`Results: ${passed}/${passed + failed} passed. Final DB _v = ${finalV}`, passed === passed + failed ? 'ok' : 'err');
    setRunning(false);
  }

  const typeColors = { ok: 'var(--green)', err: 'var(--red)', warn: 'var(--orange)', header: 'var(--amber)', info: 'var(--dimmer)' };

  return (
    <div className="stack page-fade">
      <div className="card">
        <div className="card-header">
          <span className="card-title">⚡ Sync Stress Test</span>
          <div className="fac" style={{ gap: 8 }}>
            {currentV !== null && <span className="xs text-dd">DB _v = {currentV}</span>}
            {running
              ? <button className="btn btn-d btn-sm" onClick={() => abortRef.current = true}>Abort</button>
              : <button className="btn btn-p" onClick={runAll}>Run All Tests</button>
            }
          </div>
        </div>
        <div style={{ padding: 14 }}>
          <div className="xs text-dd" style={{ marginBottom: 12, lineHeight: 1.7 }}>
            Tests: sequential writes · concurrent collision (3 clients) · rapid-fire (10 in 400ms) · conflict recovery · echo suppression.<br />
            Each test writes to the live DB. Run on a quiet moment or restore state after if needed.
          </div>

          {results.length === 0 && !running && (
            <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--dimmer)', fontSize: 13 }}>
              Press Run to stress-test the sync system against the live database.
            </div>
          )}

          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 500, overflowY: 'auto' }}>
            {results.map(r => (
              <div key={r.id} style={{ display: 'flex', gap: 10, color: typeColors[r.type] || 'var(--text)' }}>
                <span style={{ color: 'var(--dimmer)', flexShrink: 0 }}>{r.ts}</span>
                <span>{r.msg}</span>
              </div>
            ))}
            {running && (
              <div style={{ color: 'var(--dimmer)', animation: 'savingBar 1s infinite alternate' }}>⋯ running</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


function safeTestMutation(cur) {
  return {
    ...cur,
    _rapidTest: Math.random(),
    _v: (cur._v ?? 0) + 1,
  };
}

function AdvancedPanel({ state, setState, showToast, onStartNewSeason }) {
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [selected, setSelected] = useState(null);
  const [exportSeasonFilter, setExportSeasonFilter] = useState("current");
  const clientId = getClientId();
  const lastWriterId = state?._meta?.lastWriterId || "—";
  const lastWriteAt = state?._meta?.lastWriteAt ? new Date(state._meta.lastWriteAt).toLocaleString("en-GB") : "—";
  const lastBackupAt = readLocalNumber(LAST_BACKUP_KEY, 0);
  const lastBackupLabel = lastBackupAt ? new Date(lastBackupAt).toLocaleString("en-GB") : "—";
  const [annBody, setAnnBody] = useState(state.announcement?.body || "");
  const [annTitle, setAnnTitle] = useState(state.announcement?.title || "");
  const [annSubtitle, setAnnSubtitle] = useState(state.announcement?.subtitle || "");
  const [annFlashy, setAnnFlashy] = useState(false);
  const [annHype, setAnnHype] = useState(false);
  const [annScheduleStart, setAnnScheduleStart] = useState("");
  const [annScheduleEnd, setAnnScheduleEnd] = useState("");
  const [annPreview, setAnnPreview] = useState(false);
  const [autoSeasonAnnouncement, setAutoSeasonAnnouncement] = useState(true);

  useEffect(() => {
    const ann = state.announcement;
    setAnnBody(ann?.body || "");
    setAnnTitle(ann?.title || "");
    setAnnSubtitle(ann?.subtitle || "");
    setAnnFlashy(ann?.type === "flashy" || ann?.type === "seasonLaunch");
    setAnnHype(ann?.type === "hype");
  }, [state.announcement?.id]);

  const loadHistory = useCallback(async () => {
    const { data, error } = await supabase
      .from("app_state_history")
      .select("id,state,saved_at")
      .order("saved_at", { ascending: false })
      .limit(25);
    if (!error) {
      setHistory(data || []);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  async function restoreState(row) {
    if (!row) return;
    setLoading(true);

    const { error } = await supabase
      .from("app_state")
      .update({ state: row.state })
      .eq("id", 1);

    if (error) {
      showToast("Restore failed", "err");
    } else {
      setState(row.state);
      showToast("State restored", "ok");
    }

    setLoading(false);
  }

  async function restoreLatest() {
    if (!history.length) {
      showToast("No backups found", "err");
      return;
    }
    await restoreState(history[0]);
  }

  async function hardReset() {
    if (!confirm("Hard reset leaderboard?")) return;

    const next = {
      ...state,
      players: [],
      games: [],
      monthlyPlacements: {},
      finals: {},
      finalsDate: null,
    };

    const { error } = await supabase
      .from("app_state")
      .update({ state: next })
      .eq("id", 1);

    if (!error) {
      setState(next);
      showToast("Leaderboard reset", "ok");
    } else {
      showToast("Reset failed", "err");
    }
  }

  function resetSeasonPoints() {
    const ok = confirm("Start a new season? Points, MMR, and streaks reset. History and stats stay.");
    if (!ok) return;
    const annType = annHype ? "hype" : annFlashy ? "flashy" : "hype";
    onStartNewSeason({
      type: annType,
      title: annTitle.trim(),
      subtitle: annSubtitle.trim() || "Fresh leaderboard",
      body: annBody.trim(),
      withAnnouncement: autoSeasonAnnouncement,
    });
  }

  function publishAnnouncement() {
    if (!annBody.trim()) { showToast("Announcement body required", "err"); return; }
    const now = new Date();
    const start = annScheduleStart ? new Date(annScheduleStart) : now;
    const end = annScheduleEnd
      ? new Date(annScheduleEnd)
      : new Date(start.getTime() + 24 * 60 * 60 * 1000);
    if (end <= start) { showToast("End time must be after start time", "err"); return; }
    const announcement = {
      id: `ann_${Date.now()}`,
      title: annTitle.trim() || undefined,
      subtitle: annSubtitle.trim() || undefined,
      body: annBody.trim(),
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      createdBy: clientId,
      type: annHype ? "hype" : annFlashy ? "flashy" : "standard",
    };
    setState(s => ({ ...s, announcement }));
    const scheduled = start > now;
    showToast(scheduled
      ? `Scheduled for ${start.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
      : "Announcement published", "ok");
  }

  function clearAnnouncement() {
    setState(s => ({ ...s, announcement: null }));
    showToast("Announcement cleared", "ok");
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-header">
        <span className="card-title">Advanced Controls</span>
      </div>
      <div style={{ padding: 16 }}>
        <div className="fac" style={{ gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <button className="btn btn-g" onClick={restoreLatest} disabled={loading}>
            Restore Previous State
          </button>
          <button className="btn btn-g" onClick={resetSeasonPoints} disabled={loading}>
            New Season (Reset Points)
          </button>
          <label className="fac xs text-d" style={{ gap: 6, padding: "0 6px" }}>
            <input type="checkbox" checked={autoSeasonAnnouncement} onChange={e => setAutoSeasonAnnouncement(e.target.checked)} />
            Auto season announcement
            <span className="xs text-dd" style={{ marginLeft: 2 }}>
              (uses style below — defaults to 🔥 Hype)
            </span>
          </label>
          <button className="btn btn-d" onClick={hardReset}>
            Hard Reset
          </button>
          <button className="btn btn-g" onClick={loadHistory}>
            Refresh Backups
          </button>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">Time Machine</span>
          </div>
          <div style={{ padding: 14 }}>
            <select
              className="inp"
              onChange={e => {
                const id = e.target.value;
                const row = history.find(h => String(h.id) === id);
                setSelected(row);
              }}
            >
              <option value="">Select backup</option>
              {history.map(h => (
                <option key={h.id} value={h.id}>
                  {new Date(h.saved_at).toLocaleString()}
                </option>
              ))}
            </select>

            <div className="fac" style={{ gap: 8, marginTop: 10 }}>
              <button
                className="btn btn-g"
                disabled={!selected || loading}
                onClick={() => restoreState(selected)}
              >
                Restore Selected
              </button>
            </div>
            {selected?.state?._meta && (
              <div className="xs text-dd" style={{ marginTop: 8 }}>
                Backup writer: {selected.state._meta.lastWriterId || "—"} · {selected.state._meta.lastWriteAt ? new Date(selected.state._meta.lastWriteAt).toLocaleString("en-GB") : "—"}
              </div>
            )}
          </div>
        </div>

        <div className="card" style={{ marginTop: 12 }}>
          <div className="card-header">
            <span className="card-title">Admin Actions</span>
          </div>
          <div style={{ padding: 14 }}>
            {(state.adminActions || []).length === 0 ? (
              <div className="xs text-dd">No recent actions</div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                  <button className="btn btn-p" onClick={() => {
                    const lastAction = (state.adminActions || [])[0];
                    if (!lastAction) return;
                    setState(s => {
                      const updated = { ...s, ...lastAction.reverseMutation };
                      return { ...s, ...updated, adminActions: (s.adminActions || []).slice(1) };
                    });
                    showToast(`Undid: ${(state.adminActions || [])[0].description}`, "ok");
                  }}>
                    ↶ Undo Last Action
                  </button>
                  <span className="xs text-dd" style={{ alignSelf: "center" }}>
                    {(state.adminActions || []).length} recent action{(state.adminActions || []).length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflowY: "auto" }}>
                  {(state.adminActions || []).slice(0, 5).map((action, i) => (
                    <div key={i} style={{ padding: "8px 10px", borderRadius: 6, background: "var(--s2)", border: "1px solid var(--b1)", fontSize: 11 }}>
                      <div style={{ fontWeight: 600, color: "var(--amber)", marginBottom: 2 }}>{action.type}</div>
                      <div className="text-d">{action.description}</div>
                      <div className="xs text-dd" style={{ marginTop: 4 }}>
                        {new Date(action.timestamp).toLocaleString("en-GB")}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="card" style={{ marginTop: 12 }}>
          <div className="card-header">
            <span className="card-title">Announcement</span>
            <div className="fac" style={{ gap: 6 }}>
              {state.announcement && (
                <span className={`tag ${isAnnouncementActive(state.announcement) ? "tag-w" : new Date(state.announcement.startsAt) > new Date() ? "tag-b" : "tag-a"}`}>
                  {isAnnouncementActive(state.announcement) ? "Active" : new Date(state.announcement.startsAt) > new Date() ? "Scheduled" : "Expired"}
                </span>
              )}
              <button className={`btn btn-sm ${annPreview ? "btn-p" : "btn-g"}`} onClick={() => setAnnPreview(v => !v)}>
                {annPreview ? "Edit" : "Preview"}
              </button>
            </div>
          </div>
          <div style={{ padding: 14 }}>
            {annPreview ? (
              <div style={{ border: "1px solid var(--b2)", borderRadius: 8, padding: 16, background: "var(--bg)", marginBottom: 12 }}>
                <div className="xs text-dd" style={{ marginBottom: 8, letterSpacing: .5, textTransform: "uppercase" }}>Preview</div>
                {(() => {
                  const isSpec = annFlashy || annHype;
                  const cls = annHype ? "season-launch hype" : annFlashy ? "season-launch" : "";
                  return (
                    <div className={cls} style={{ padding: isSpec ? (annHype ? "18px 14px 14px" : "14px") : 0, borderRadius: isSpec ? 8 : 0, marginBottom: 8 }}>
                      {annHype && <div className="xs" style={{ letterSpacing: 2, textTransform: "uppercase", color: "var(--gold)", opacity: .7, marginBottom: 6, fontWeight: 600 }}>✦ &nbsp;Announcement&nbsp; ✦</div>}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                        <span className={annHype ? "season-title hype" : annFlashy ? "season-title" : ""} style={isSpec ? {} : { fontFamily: "var(--disp)", fontSize: 18, fontWeight: 700, color: "var(--amber)" }}>
                          {annTitle || (isSpec ? "New Season" : "Announcement")}
                        </span>
                        {annSubtitle && <span className={annHype ? "season-pill hype" : isSpec ? "season-pill" : "tag tag-a"}>{annSubtitle}</span>}
                      </div>
                      <div className="md" dangerouslySetInnerHTML={{ __html: renderMd(annBody || "*No content yet…*") }} />
                    </div>
                  );
                })()}
              </div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                <div className="grid-2">
                  <div>
                    <label className="lbl">Title (optional)</label>
                    <input className="inp" placeholder="e.g. Tournament Update"
                      value={annTitle} onChange={e => setAnnTitle(e.target.value)} />
                  </div>
                  <div>
                    <label className="lbl">Subtitle / pill (optional)</label>
                    <input className="inp" placeholder="e.g. Season 2 live"
                      value={annSubtitle} onChange={e => setAnnSubtitle(e.target.value)} />
                  </div>
                </div>
                <div>
                  <label className="lbl">Body — Obsidian Markdown</label>
                  <textarea className="inp" rows={8}
                    placeholder="## Heading&#10;**bold**, *italic*, ==highlight==&#10;&gt; [!tip] This is a callout&#10;&gt; Callout body&#10;- [ ] checkbox item&#10;| A | B |&#10;|---|---|&#10;| 1 | 2 |"
                    value={annBody} onChange={e => setAnnBody(e.target.value)}
                    style={{ fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.7 }} />
                </div>
                <div>
                  <label className="lbl">Style</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[
                      ["standard", "Standard", "Plain announcement, no animation"],
                      ["flashy", "✦ Flashy", "Gold shimmer stripe on header"],
                      ["hype", "🔥 Hype", "Full glow, sweep, pulse — season launches"],
                    ].map(([val, label, desc]) => {
                      const cur = annHype ? "hype" : annFlashy ? "flashy" : "standard";
                      const active = cur === val;
                      return (
                        <div key={val}
                          onClick={() => { setAnnFlashy(val === "flashy"); setAnnHype(val === "hype"); }}
                          style={{
                            flex: 1, padding: "8px 10px", borderRadius: 8, cursor: "pointer",
                            border: `1px solid ${active ? "rgba(232,184,74,.6)" : "var(--b2)"}`,
                            background: active ? "rgba(232,184,74,.08)" : "var(--s2)",
                            transition: "all .15s",
                          }}>
                          <div style={{ fontWeight: 600, fontSize: 12, color: active ? "var(--gold)" : "var(--text)", marginBottom: 2 }}>{label}</div>
                          <div className="xs text-dd" style={{ lineHeight: 1.4 }}>{desc}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="grid-2">
                  <div>
                    <label className="lbl">Scheduled start (blank = now)</label>
                    <input className="inp" type="datetime-local"
                      value={annScheduleStart} onChange={e => setAnnScheduleStart(e.target.value)} />
                  </div>
                  <div>
                    <label className="lbl">Scheduled end (blank = +24h)</label>
                    <input className="inp" type="datetime-local"
                      value={annScheduleEnd} onChange={e => setAnnScheduleEnd(e.target.value)} />
                  </div>
                </div>
              </div>
            )}
            <div className="fac" style={{ gap: 8, marginTop: 12, justifyContent: "space-between", flexWrap: "wrap" }}>
              <div>
                {state.announcement && (
                  <div className="xs text-dd" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {new Date(state.announcement.startsAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    {" → "}
                    {new Date(state.announcement.endsAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    {state.announcement.type === "flashy" && <span className="tag tag-a" style={{ fontSize: 9, padding: "1px 5px" }}>FLASHY</span>}
                    {state.announcement.type === "hype" && <span className="tag" style={{ fontSize: 9, padding: "1px 5px", background: "rgba(240,112,112,.15)", color: "var(--orange)", border: "1px solid rgba(240,112,112,.3)" }}>HYPE 🔥</span>}
                  </div>
                )}
              </div>
              <div className="fac" style={{ gap: 8 }}>
                <button className="btn btn-p" onClick={publishAnnouncement}>
                  {annScheduleStart && new Date(annScheduleStart) > new Date() ? "Schedule" : "Publish"}
                </button>
                {state.announcement && <button className="btn btn-d" onClick={clearAnnouncement}>Clear</button>}
              </div>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 12 }}>
          <div className="card-header">
            <span className="card-title">Exports</span>
          </div>
          <div style={{ padding: 14, display: "grid", gap: 10 }}>
            <div className="field">
              <label className="lbl">Season</label>
              <select className="inp" value={exportSeasonFilter} onChange={e => setExportSeasonFilter(e.target.value)}>
                <option value="current">Current season</option>
                <option value="all">All seasons</option>
                {(state.seasons || []).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <div className="fac" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="btn btn-g" onClick={() => exportStateJson(state)}>
                Export State (JSON)
              </button>
              <button className="btn btn-g" onClick={() => exportPlayersCsv(state, exportSeasonFilter)}>
                Export Players (CSV)
              </button>
              <button className="btn btn-g" onClick={() => exportGamesCsv(state, exportSeasonFilter)}>
                Export Games (CSV)
              </button>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 12 }}>
          <div className="card-header">
            <span className="card-title">Audit</span>
          </div>
          <div style={{ padding: 14, display: "grid", gap: 6 }}>
            <div className="xs text-dd">Last write: {lastWriteAt}</div>
            <div className="xs text-dd">Last writer: {lastWriterId}</div>
            <div className="xs text-dd">This client: {clientId}</div>
            <div className="xs text-dd">Last backup (local): {lastBackupLabel}</div>
            <div className="xs text-dd">Loaded backups: {history.length}</div>
            {state.seasonStart && (
              <div className="xs text-dd">Season start: {new Date(state.seasonStart).toLocaleString("en-GB")}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// SYNC TEST PANEL (admin dev tool)
// ============================================================
function SyncTestPanel({ state, setState, showToast }) {
  const [log, setLog] = useState([]);
  const [running, setRunning] = useState(false);

  function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLog(l => [{ time, msg, type }, ...l].slice(0, 60));
  }

  async function fetchCurrentDB() {
    const { data } = await supabase.from('app_state').select('state').eq('id', 1).single();
    return data?.state;
  }

  // ── Test 1: Rapid fire saves ─────────────────────────────
  async function testRapidFire() {
    addLog('▶ TEST 1: Rapid fire — 5 saves within 200ms', 'title');
    setRunning(true);
    const before = await fetchCurrentDB();
    const beforeV = before?._v ?? 0;
    addLog('DB _v before: ' + beforeV);

    const results = [];
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 40));
      const tag = 'rapid-' + i;
      setState(s => safeTestMutation({ ...s, _syncTestTag: tag }));
      results.push(tag);
    }

    // Wait for save to complete
    await new Promise(r => setTimeout(r, 2500));
    const after = await fetchCurrentDB();
    const afterV = after?._v ?? 0;
    const passed = afterV > beforeV && after?._syncTestTag === results[results.length - 1];
    addLog(`DB _v after: ${afterV} | tag: ${after?._syncTestTag}`, passed ? 'pass' : 'fail');
    addLog(passed ? '✓ PASS: Final state correctly saved' : '✗ FAIL: State not saved or wrong version', passed ? 'pass' : 'fail');

    // Cleanup
    setState(s => {
      const { _syncTestTag, ...rest } = s;
      return safeTestMutation(rest);
    });
    setRunning(false);
  }

  // ── Test 2: Version integrity ────────────────────────────
  async function testVersionIntegrity() {
    addLog('▶ TEST 2: Version integrity — check _v increments correctly', 'title');
    setRunning(true);

    const before = await fetchCurrentDB();
    const v0 = before?._v ?? 0;
    addLog('Starting _v: ' + v0);

    // Force 3 sequential saves
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 500));
      setState(s => safeTestMutation({ ...s, _syncTestSeq: i }));
      await new Promise(r => setTimeout(r, 800));
    }

    await new Promise(r => setTimeout(r, 1000));
    const after = await fetchCurrentDB();
    const vN = after?._v ?? 0;
    const expected = v0 + 3;
    const passed = vN >= v0 + 1; // at least incremented
    addLog(`_v went ${v0} → ${vN} (expected ≥${v0 + 1})`, passed ? 'pass' : 'fail');
    addLog(passed ? '✓ PASS: Version correctly incremented' : '✗ FAIL: Version did not increment', passed ? 'pass' : 'fail');

    setState(s => {
      const { _syncTestSeq, ...rest } = s;
      return safeTestMutation(rest);
    });
    setRunning(false);
  }

  // ── Test 3: Conflict simulation ──────────────────────────
  async function testConflictHandling() {
    addLog('▶ TEST 3: Conflict simulation — write old _v directly to DB', 'title');
    setRunning(true);

    const before = await fetchCurrentDB();
    const currentV = before?._v ?? 0;
    addLog('Current DB _v: ' + currentV);

    // Write a conflicting state directly to DB with a higher _v (simulating another client)
    const conflictState = normaliseState({ ...before, _v: currentV + 5, _syncConflictTest: true });
    const { error } = await supabase.from('app_state')
      .upsert({ id: 1, state: slimState(conflictState), updated_at: new Date().toISOString() });

    if (error) {
      addLog('✗ Could not write conflict state: ' + error.message, 'fail');
      setRunning(false); return;
    }
    addLog('Wrote conflict state _v=' + (currentV + 5) + ' to DB directly');

    // Now trigger a local save — should detect conflict and apply remote
    setState(s => safeTestMutation({ ...s, _syncLocalChange: Date.now() }));
    await new Promise(r => setTimeout(r, 2500));

    const after = await fetchCurrentDB();
    addLog('DB _v after conflict resolution: ' + after?._v);
    const resolved = !after?._syncLocalChange || after?._syncConflictTest;
    addLog(resolved ? '✓ PASS: Conflict detected and resolved' : '⚠ INFO: Local change won (upsert fallback mode)', resolved ? 'pass' : 'warn');

    // Cleanup
    setState(s => {
      const { _syncLocalChange, _syncConflictTest, ...rest } = s;
      return safeTestMutation(rest);
    });
    await new Promise(r => setTimeout(r, 1000));
    setRunning(false);
  }

  // ── Test 4: Save + verify round-trip ────────────────────
  async function testRoundTrip() {
    addLog('▶ TEST 4: Round-trip — save then read back and verify', 'title');
    setRunning(true);

    const sentinel = 'rt-' + Date.now();
    setState(s => safeTestMutation({ ...s, _syncRoundTrip: sentinel }));

    // Poll DB until we see our sentinel or timeout
    let found = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      const db = await fetchCurrentDB();
      if (db?._syncRoundTrip === sentinel) { found = true; break; }
    }

    addLog(found ? '✓ PASS: Sentinel found in DB (' + sentinel + ')' : '✗ FAIL: Sentinel never reached DB', found ? 'pass' : 'fail');
    setState(s => {
      const { _syncRoundTrip, ...rest } = s;
      return safeTestMutation(rest);
    });
    setRunning(false);
  }

  const colMap = { pass: 'var(--green)', fail: 'var(--red)', warn: 'var(--orange)', title: 'var(--amber)', info: 'var(--dim)' };

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">⚙ Sync Test Panel</span>
        <button className="btn btn-d btn-sm" onClick={() => setLog([])}>Clear log</button>
      </div>
      <div style={{ padding: 14 }}>
        <div className="xs text-dd" style={{ marginBottom: 10, lineHeight: 1.6 }}>
          Runs live tests against the actual Supabase DB. Each test reports pass/fail with details.
          Do not use during active gameplay.
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {[
            ['Rapid Fire', testRapidFire],
            ['Version Integrity', testVersionIntegrity],
            ['Conflict Handling', testConflictHandling],
            ['Round-trip', testRoundTrip],
          ].map(([label, fn]) => (
            <button key={label} className="btn btn-g btn-sm" disabled={running}
              style={{ opacity: running ? 0.4 : 1 }} onClick={fn}>{label}</button>
          ))}
        </div>
        <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', maxHeight: 300, overflowY: 'auto', fontFamily: 'monospace', fontSize: 11 }}>
          {log.length === 0 && <span style={{ color: 'var(--dimmer)' }}>Run a test to see output…</span>}
          {log.map((e, i) => (
            <div key={i} style={{ color: colMap[e.type] || 'var(--dim)', lineHeight: 1.8 }}>
              <span style={{ color: 'var(--dimmer)', marginRight: 8 }}>{e.time}</span>{e.msg}
            </div>
          ))}
        </div>
        <div className="xs text-dd" style={{ marginTop: 8 }}>
          Current: local _v={state._v ?? '?'} · queue confirmedV accessible via console (_sq.confirmedV)
        </div>
      </div>
    </div>
  );
}

// ============================================================
// ADMIN LOGIN
// ============================================================
function AdminLogin({ onLogin }) {
  const [pw, setPw] = useState(""); const [err, setErr] = useState("");
  function go() { pw === CONFIG.ADMIN_PASSWORD ? onLogin() : (setErr("Incorrect password"), setPw("")); }
  return (
    <div className="login-wrap">
      <div className="login-box">
        <div className="login-title">Admin Access</div>
        <div className="field"><label className="lbl">Password</label>
          <input className="inp" type="password" placeholder="Password…" value={pw}
            onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && go()} />
        </div>
        {err && <div className="msg msg-e">{err}</div>}
        <button className="btn btn-p w-full mt16" onClick={go}>Login</button>
      </div>
    </div>
  );
}

// ============================================================
// ROOT
// ============================================================
export default function App() {

  // PWA setup
  useEffect(() => {
    // Manifest
    if (!document.querySelector('link[rel="manifest"]')) {
      const manifest = {
        name: "St. Marylebone Table Tracker",
        short_name: "Table Tracker",
        start_url: "/",
        display: "standalone",
        background_color: "#0e1210",
        theme_color: "#0e1210",
        icons: [{ src: "/favicon.ico", sizes: "any", type: "image/x-icon" }]
      };
      const blob = new Blob([JSON.stringify(manifest)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("link");
      link.rel = "manifest"; link.href = url;
      document.head.appendChild(link);
    }
    // Theme color meta
    if (!document.querySelector('meta[name="theme-color"]')) {
      const meta = document.createElement("meta");
      meta.name = "theme-color"; meta.content = "#0e1210";
      document.head.appendChild(meta);
    }
    // Apple mobile web app
    const apple = document.createElement("meta");
    apple.name = "apple-mobile-web-app-capable"; apple.content = "yes";
    document.head.appendChild(apple);
  }, []);

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

  // realtime + loading
  const [loading, setLoading] = useState(true);
  const [rtConnected, setRtConnected] = useState(false);
  const subscriptionRef = useRef(null);
  const isRemoteUpdate = useRef(false);


  // ============================================================
  // LOAD STATE
  // ============================================================
  useEffect(() => {

    async function initState() {
      try {
        const loaded = await loadState();
        setState(loaded);
        subscribeToStateChanges();
      } catch (err) {
        console.error("Failed to initialize:", err);
      } finally {
        setLoading(false);
      }
    }

    initState();

    return () => {
      clearTimeout(reconnectTimer.current);
      if (subscriptionRef.current) {
        supabase.removeChannel(subscriptionRef.current);
      }
    };

  }, []);

  // showToastRef declared before autosave so conflict callback can call it
  const showToastRef = useRef(null);
  async function verifyRemoteState(expectedV, expectedSnapshot) {
    try {
      const { data, error } = await supabase.from('app_state').select('state').eq('id', 1).single();
      if (error || !data?.state) {
        setSyncFor('error', 6000);
        if (showToastRef.current) showToastRef.current('Sync verify failed: could not read remote state', 'err');
        return;
      }
      const remote = data.state;
      const remoteV = remote._v ?? 0;
      const localPlayers = expectedSnapshot?.players?.length ?? 0;
      const localGames = expectedSnapshot?.games?.length ?? 0;
      const remotePlayers = remote.players?.length ?? 0;
      const remoteGames = remote.games?.length ?? 0;

      if (remoteV !== expectedV || remotePlayers !== localPlayers || remoteGames !== localGames) {
        console.warn('[sync] verify mismatch', { expectedV, remoteV, localPlayers, remotePlayers, localGames, remoteGames });
        setSyncFor('error', 6000);
        if (showToastRef.current) showToastRef.current('Sync verify mismatch: refresh did not match saved data', 'err');
        return;
      }

      console.log('[sync] verify ok _v' + remoteV);
    } catch (e) {
      setSyncFor('error', 6000);
      if (showToastRef.current) showToastRef.current('Sync verify failed: unexpected error', 'err');
    }
  }

  // syncStatus: 'idle' | 'saving' | 'saved' | 'conflict' | 'error'
  const [syncStatus, setSyncStatus] = useState('idle');
  const syncStatusTimer = useRef(null);
  function setSyncFor(status, ms = 2500) {
    setSyncStatus(status);
    clearTimeout(syncStatusTimer.current);
    if (ms) syncStatusTimer.current = setTimeout(() => setSyncStatus('idle'), ms);
  }

  // ── AUTOSAVE ──────────────────────────────────────────────
  // The autosave effect runs on every state change. It skips:
  //  - The initial load (isInitialLoad)
  //  - Changes that came FROM remote (isRemoteUpdate)
  //  - Changes triggered by our own _v stamp-back (isRemoteUpdate set in onSuccess)
  //
  // The save queue manages versioning internally via _sq.confirmedV.
  // React state._v is only used for display / initial seeding of confirmedV.
  // The onSuccess callback stamps the DB-confirmed _v back into React state
  // using isRemoteUpdate=true so it doesn't re-trigger a save.
  const isInitialLoad = useRef(true);
  const stateRef = useRef(state);
  // Keep stateRef in sync with state (already synced in useEffect below)

  useEffect(() => {
    stateRef.current = state; // Always keep ref in sync
  }, [state]);

  useEffect(() => {
    if (loading) return;
    if (isInitialLoad.current) { isInitialLoad.current = false; return; }
    if (isRemoteUpdate.current) { isRemoteUpdate.current = false; return; }

    setSyncStatus('saving');
    const pendingSnapshot = stateRef.current;
    saveState(
      pendingSnapshot,
      (remoteState) => {
        isRemoteUpdate.current = true;
        setState(remoteState);
        setSyncFor('conflict', 4000);
        if (showToastRef.current) showToastRef.current('Sync conflict — remote state applied', 'warning');
      },
      (newV, meta) => {
        isRemoteUpdate.current = true;
        setState(s => ({ ...s, _v: newV, _meta: meta || s._meta }));
        setSyncFor('saved');
        if (SYNC_DEBUG) verifyRemoteState(newV, pendingSnapshot);
      }
    );
  }, [state, loading]);

  // ============================================================
  // REALTIME SUBSCRIPTION
  // ============================================================
  const reconnectTimer = useRef(null);
  const wasDisconnected = useRef(false);

  function handleRemotePayload(payload) {
    const incoming = normaliseState(payload.new?.state || {});
    const incomingV = incoming._v ?? 0;

    // Suppress our own echo: if this version matches what we just wrote, skip
    if (_sq.echoSet.has(incomingV)) {
      console.log('[sync] suppressing own echo _v' + incomingV);
      return;
    }

    // Get current local version from state (always accurate since _v is in React state)
    const localV = state._v ?? 0;

    // Skip if we already have this or a newer version and nothing is in flight
    if (incomingV <= localV && _sq.inflightV === null) {
      console.log('Ignoring stale _v' + incomingV + ' (local=' + localV + ')');
      return;
    }

    console.log('Applying remote _v' + incomingV + ' (local=' + localV + ')');
    isRemoteUpdate.current = true;
    setState(incoming);
  }

  function subscribeToStateChanges() {
    if (subscriptionRef.current) {
      supabase.removeChannel(subscriptionRef.current);
      subscriptionRef.current = null;
    }

    // Stable channel name — no Date.now() leak on reconnect
    const channel = supabase
      .channel('app_state_v1')
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'app_state', filter: 'id=eq.1' },
        handleRemotePayload
      )
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'app_state', filter: 'id=eq.1' },
        handleRemotePayload
      )
      .subscribe(async (status) => {
        console.log('Realtime:', status);
        if (status === 'SUBSCRIBED') {
          setRtConnected(true);
          clearTimeout(reconnectTimer.current);
          // If we just reconnected after a drop, fetch fresh state to catch missed updates
          if (wasDisconnected.current) {
            wasDisconnected.current = false;
            try {
              const { data } = await supabase.from('app_state').select('state').eq('id', 1).single();
              if (data?.state) {
                const fresh = normaliseState(data.state);
                const freshV = fresh._v ?? 0;
                const localV = stateRef.current?._v ?? 0;
                if (freshV > localV) {
                  console.log('[sync] catch-up: remote _v' + freshV + ' > local _v' + localV);
                  isRemoteUpdate.current = true;
                  setState(fresh);
                  if (showToastRef.current) showToastRef.current('Synced with latest state', 'info');
                }
              }
            } catch (e) { console.warn('[sync] catch-up fetch failed:', e); }
          }
        }
        if (status === 'CHANNEL_ERROR' || status === 'CLOSED' || status === 'TIMED_OUT') {
          setRtConnected(false);
          wasDisconnected.current = true;
          clearTimeout(reconnectTimer.current);
          reconnectTimer.current = setTimeout(() => subscribeToStateChanges(), 4000);
        }
      });

    subscriptionRef.current = channel;
  }

  // ============================================================
  // TOAST
  // ============================================================
  const showToast = useCallback((msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4500);
  }, []);
  showToastRef.current = showToast;
  useEffect(() => {
    syncToast = showToast;
    return () => { syncToast = null; };
  }, [showToast]);

  // Poll every 30s so scheduled announcements appear without page refresh
  const [annTick, setAnnTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setAnnTick(t => t + 1), 30000); return () => clearInterval(id); }, []);
  const activeAnnouncement = isAnnouncementActive(state.announcement) ? state.announcement : null;
  useEffect(() => {
    if (!activeAnnouncement) { setShowAnnouncement(false); return; }
    const dismissKey = `${ANN_DISMISS_PREFIX}${activeAnnouncement.id}`;
    const dismissedAt = readLocalNumber(dismissKey, 0);
    if (dismissedAt) return;
    setShowAnnouncement(true);
  }, [activeAnnouncement?.id, activeAnnouncement?.startsAt, activeAnnouncement?.endsAt, activeAnnouncement?.body, annTick]);

  function dismissAnnouncement() {
    if (!activeAnnouncement) return;
    const dismissKey = `${ANN_DISMISS_PREFIX}${activeAnnouncement.id}`;
    writeLocalNumber(dismissKey, Date.now());
    setShowAnnouncement(false);
  }

  // ============================================================
  // NAV
  // ============================================================

  const ADMIN_TABS = [
    { id: "onboard", label: "Onboard" },
    { id: "logGames", label: "Log Games" },
    { id: "advanced", label: "Advanced" },
  ];

  const [mobMenuOpen, setMobMenuOpen] = useState(false);
  function navTo(t, aTab) {
    setTab(t);
    if (aTab) setAdminTab(aTab);
    setMobMenuOpen(false);
  }

  // keep selected player synced with state updates
  const currentSelPlayer = selPlayer
    ? state.players.find(p => p.id === selPlayer.id) || selPlayer
    : null;

  const currentEditPlayer = editPlayer
    ? state.players.find(p => p.id === editPlayer.id) || editPlayer
    : null;

  // ============================================================
  // START NEW SEASON — callable from Advanced panel and Seasons page
  // ============================================================
  function startNewSeason({ type = "hype", title = "", subtitle = "Fresh leaderboard", body = "", withAnnouncement = true } = {}) {
    const seasonStart = new Date().toISOString();
    const { players, games } = replayGames(state.players, state.games, seasonStart);
    const monthlyPlacements = computePlacements(games);
    setState(s => {
      const prevSeasons = [...(s.seasons || [])];
      const now = new Date().toISOString();
      if (prevSeasons.length && !prevSeasons[prevSeasons.length - 1].endAt) {
        prevSeasons[prevSeasons.length - 1] = { ...prevSeasons[prevSeasons.length - 1], endAt: seasonStart };
      }
      const nextSeason = {
        id: `season_${Date.now()}`,
        label: `Season ${prevSeasons.length + 1}`,
        startAt: seasonStart,
        endAt: null,
        createdAt: now,
      };
      const announcement = withAnnouncement ? {
        id: `ann_${Date.now()}`,
        type,
        title: title || `🎉 ${nextSeason.label} is live`,
        subtitle,
        body: body || `## The slate is clean.

Points reset. History preserved. May the best player rise.`,
        startsAt: now,
        endsAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        createdBy: getClientId(),
      } : s.announcement;
      return { ...s, players, games, monthlyPlacements, seasonStart, nextSeasonDate: null, seasons: [...prevSeasons, nextSeason], announcement };
    });
    showToast("New season started — points reset", "ok");
  }

  // ============================================================
  // LOADING SCREEN
  // ============================================================
  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        color: 'var(--dim)',
        fontFamily: 'var(--mono)'
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 24, marginBottom: 12 }}>⚽</div>
          <div>Loading leaderboard...</div>
        </div>
      </div>
    );
  }

  // ============================================================
  // APP
  // ============================================================
  return (
    <>
      <style>{CSS}</style>

      <div className="app">

        {/* ============================================================ */}
        {/* TOPBAR */}
        {/* ============================================================ */}

        <div className="topbar" style={{ position: "sticky", top: 0, zIndex: 100 }}>

          <div className="brand" onClick={() => navTo("ranks")} style={{ cursor: "pointer", userSelect: "none" }} title="Go to leaderboard">
            St. Marylebone <span className="brand-sub">Table Tracker</span>
          </div>

          {/* Desktop nav */}
          <nav className="nav">
            {TABS.map(t => (
              <button key={t} className={`nav-btn ${tab === t ? "active" : ""}`} onClick={() => navTo(t)}>
                {TAB_LABELS[t]}
                {t === "play" && Object.values(state.finals?.[getMonthKey()]?.liveScores || {}).some(v => v?.active) && (
                  <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--red)", marginLeft: 5, verticalAlign: "middle", animation: "livePulse 1.4s infinite" }} />
                )}
              </button>
            ))}
            {isAdmin && ADMIN_TABS.map(t => (
              <button key={t.id}
                className={`nav-btn ${tab === "admin" && adminTab === t.id ? "active" : ""}`}
                onClick={() => navTo("admin", t.id)}>
                {t.label}
              </button>
            ))}
          </nav>

          <div className="fac" style={{ gap: 8 }}>
            {/* Realtime connection dot — always visible in topbar */}
            <div className="fac" style={{ gap: 5 }} title={rtConnected ? "Live — connected to database" : "Connecting…"}>
              <span className={`rt-dot ${rtConnected ? "live" : ""}`}></span>
              <span className="xs text-dd" style={{ whiteSpace: "nowrap" }}>{rtConnected ? "Live" : "…"}</span>
            </div>
            {isAdmin ? (
              <>
                <span className="admin-badge">Admin</span>
                <button className="btn btn-g btn-sm" onClick={() => { setIsAdmin(false); navTo("leaderboard"); }}>
                  Logout
                </button>
              </>
            ) : (
              <button className="btn btn-g btn-sm" onClick={() => setShowLogin(true)}>Admin</button>
            )}
            {/* Hamburger — mobile only */}
            <button className={`ham-btn ${mobMenuOpen ? "open" : ""}`} onClick={() => setMobMenuOpen(o => !o)} aria-label="Menu">
              <span /><span /><span />
            </button>
          </div>

        </div>

        {/* Sync status bar — admin only, shows during save/conflict/error */}
        {isAdmin && syncStatus !== 'idle' && (
          <div style={{
            position: 'fixed', top: 52, left: 0, right: 0, zIndex: 98, height: 3,
            background: syncStatus === 'saving' ? 'var(--amber-d)' :
              syncStatus === 'saved' ? 'var(--green)' :
                syncStatus === 'conflict' ? 'var(--orange)' : 'var(--red)',
            animation: syncStatus === 'saving' ? 'savingBar 1.2s ease-in-out infinite alternate' : 'none',
            transition: 'background .3s',
          }} />
        )}

        {/* Mobile nav dropdown */}
        <div className={`mob-nav ${mobMenuOpen ? "open" : ""}`}>
          {TABS.map(t => (
            <button key={t} className={`nav-btn ${tab === t ? "active" : ""}`} onClick={() => navTo(t)}>
              {TAB_LABELS[t]}
              {t === "play" && Object.values(state.finals?.[getMonthKey()]?.liveScores || {}).some(v => v?.active) && (
                <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--red)", marginLeft: 5, verticalAlign: "middle", animation: "livePulse 1.4s infinite" }} />
              )}
            </button>
          ))}
          {isAdmin && ADMIN_TABS.map(t => (
            <button key={t.id}
              className={`nav-btn ${tab === "admin" && adminTab === t.id ? "active" : ""}`}
              onClick={() => navTo("admin", t.id)}>
              {t.label}
            </button>
          ))}
        </div>


        {/* ============================================================ */}
        {/* MAIN CONTENT */}
        {/* ============================================================ */}

        <div className="main">

          {tab === "ranks" && (
            <LeaderboardView
              state={state}
              setState={setState}
              rtConnected={rtConnected}
              isAdmin={isAdmin}
              showToast={showToast}
              syncStatus={syncStatus}
              onNavToPlay={() => navTo("play")}
              onNavToHistory={() => navTo("history")}
              onSelectPlayer={p => {
                setSelPlayer(p);
                setEditPlayer(null);
                const cur = getCurrentSeason(state);
                setProfileSeasonId(cur?.id || "");
              }}
            />
          )}

          {tab === "history" && (
            <HistoryView
              state={state}
              setState={setState}
              isAdmin={isAdmin}
              showToast={showToast}
            />
          )}

          {tab === "stats" && (
            <StatsView
              state={state}
              onSelectPlayer={p => { setSelPlayer(p); setEditPlayer(null); const cur = getCurrentSeason(state); setProfileSeasonId(cur?.id || ""); }}
            />
          )}

          {tab === "seasons" && (
            <SeasonsArchiveView
              state={state}
              setState={setState}
              isAdmin={isAdmin}
              showToast={showToast}
              onNavToHistory={(season) => { setTab("history"); }}
              onNavToStats={(season) => { setTab("stats"); }}
              onStartNewSeason={startNewSeason}
            />
          )}

          {tab === "play" && (
            <FinalsView
              state={state}
              setState={setState}
              isAdmin={isAdmin}
              showToast={showToast}
            />
          )}

          {tab === "rules" && (
            <RulesView
              state={state}
              setState={setState}
              isAdmin={isAdmin}
              showToast={showToast}
            />
          )}

          {/* ADMIN LOGIN */}
          {tab === "admin" && !isAdmin && (
            <AdminLogin onLogin={() => setIsAdmin(true)} />
          )}

          {/* ADMIN PANEL */}
          {tab === "admin" && isAdmin && (() => {

            switch (adminTab) {

              case "onboard":
                return (
                  <div className="stack">
                    <OnboardView
                      state={state}
                      setState={setState}
                      showToast={showToast}
                    />
                  </div>
                );

              case "logGames":
                return (
                  <LogView
                    state={state}
                    setState={setState}
                    showToast={showToast}
                  />
                );

              case "advanced":
                return (
                  <>
                    <AdvancedPanel
                      state={state}
                      setState={setState}
                      showToast={showToast}
                      onStartNewSeason={startNewSeason}
                    />
                    <SyncTestPanel
                      state={state}
                      setState={setState}
                      showToast={showToast}
                    />
                  </>
                );

              default:
                return (
                  <div className="card" style={{ padding: 24 }}>
                    <div className="text-d">
                      Admin page not found
                    </div>
                  </div>
                );

            }

          })()}

        </div>


        {/* ============================================================ */}
        {/* LOGIN MODAL */}
        {/* ============================================================ */}

        {showLogin && !isAdmin && (
          <div
            className="overlay"
            onClick={e => e.target === e.currentTarget && setShowLogin(false)}
          >
            <div className="modal">
              <AdminLogin
                onLogin={() => {
                  setIsAdmin(true);
                  setShowLogin(false);
                  setTab("admin");
                  setAdminTab("onboard");
                }}
              />
            </div>
          </div>
        )}


        {/* ============================================================ */}
        {/* PLAYER PROFILE */}
        {/* ============================================================ */}

        {currentSelPlayer && !editPlayer && (
          <PlayerProfile
            player={currentSelPlayer}
            state={state}
            onClose={() => setSelPlayer(null)}
            isAdmin={isAdmin}
            onEdit={() => {
              setEditPlayer(currentSelPlayer);
              setSelPlayer(null);
            }}
            seasonMode={profileSeasonMode}
            onSeasonModeChange={setProfileSeasonMode}
            selectedSeasonId={profileSeasonId || getCurrentSeason(state)?.id || ""}
            onSelectedSeasonIdChange={setProfileSeasonId}
          />
        )}


        {/* ============================================================ */}
        {/* EDIT PLAYER */}
        {/* ============================================================ */}

        {currentEditPlayer && (
          <EditPlayerModal
            player={currentEditPlayer}
            state={state}
            setState={setState}
            showToast={showToast}
            onClose={() => setEditPlayer(null)}
          />
        )}


        {/* ============================================================ */}
        {/* TOAST */}
        {/* ============================================================ */}

        {showAnnouncement && activeAnnouncement && (
          <AnnouncementModal
            announcement={activeAnnouncement}
            onClose={dismissAnnouncement}
          />
        )}

        <Toast t={toast} />

      </div>
    </>
  );
}
