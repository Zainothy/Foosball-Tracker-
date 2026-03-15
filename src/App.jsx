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

  // Base deltas — before all modifiers
  BASE_GAIN: 18,
  BASE_LOSS: 11,                 // slightly above base — losses proportionally meaningful

  // Score dominance: scoreDiff / winnerScore gives 0→1 ratio
  // Multiplier: 1 + SCORE_WEIGHT * ratio^SCORE_EXP
  SCORE_WEIGHT: 1.2,            // max ~2.2× at perfect shutout
  SCORE_EXP: 1.4,               // curve shape — >1 = punishes blowouts more

  // MMR (elo) gap: sigmoid. Upset win (low MMR beats high) = high reward.
  // Expected win (high MMR beats low) = low reward.
  ELO_DIVISOR: 250,             // steepness — lower = sharper curve

  // Rank gap: beating someone ranked much higher = bonus
  RANK_WEIGHT: 0.4,             // 0 = ignore rank, 1 = double at max gap
  RANK_DIVISOR: 5,              // rank diff normaliser (field of ~10)

  // ── STREAK SYSTEM (quality-weighted, convergence-safe) ────
  // Streak power accumulates quality (eloScale * rankScale) per win,
  // resets to 0 on loss. Prevents unclosable gaps from weak-opponent farming.
  STREAK_POWER_SCALE: 4.0,      // tanh half-point (higher = slower ramp)
  STREAK_WIN_MAX: 0.45,         // max bonus for win streak (+45% = 1.45x cap)
  STREAK_LOSS_MAX: 0.35,        // max amplifier for loss streak (1.35x cap)
  STREAK_QUALITY_DECAY: 0.88,   // per-game decay if opponent eloScale < 1.1
  STREAK_DECAY_THRESHOLD: 1.05, // eloScale below this = "easy" opponent
  STREAK_WINDOW: 8,             // rolling quality window (games)

  // Loss harshness scalar — multiplied into every loss, >1 = harsher
  // 1.15 means losses are ~15% larger across the board after other factors
  LOSS_HARSHNESS: 1.05,

  MAX_PLACEMENTS_PER_MONTH: 5,  // per player per calendar month

  // Disciplinary cards — pts deducted after all other calculations, survive recalc
  YELLOW_CARD_PTS: 5,   // minor infraction — unsportsmanlike conduct, excessive stalling
  RED_CARD_PTS: 20,     // serious misconduct — abuse, repeated offences, cheating
};

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

// Recompute monthlyPlacements from game list (used after delete/edit)
function computePlacements(games) {
  const placements = {};
  for (const g of games) {
    const mk = g.monthKey || g.date?.slice(0,7)?.replace('-','') || '';
    if (!mk) continue;
    if (!placements[mk]) placements[mk] = {};
    for (const pid of [...g.sideA, ...g.sideB]) {
      placements[mk][pid] = (placements[mk][pid] || 0) + 1;
    }
  }
  return placements;
}

// Recalculate pts/mmr/streaks/wins/losses from scratch using per-player deltas.
// Returns { players, games } — caller must update both.
function replayGames(basePlayers, games) {
  let players = basePlayers.map(p => ({
    ...p, mmr: CONFIG.STARTING_MMR, pts: CONFIG.STARTING_PTS,
    wins: 0, losses: 0, streak: 0, streakPower: 0,
  }));
  const sorted = [...games].sort((a, b) => new Date(a.date) - new Date(b.date));
  const updatedGames = sorted.map(g => {
    const winIds = g.winner === "A" ? g.sideA : g.sideB;
    const losIds = g.winner === "A" ? g.sideB : g.sideA;
    const ranked = [...players].sort((a,b)=>(b.pts||0)-(a.pts||0));
    const rankOf = id => { const i = ranked.findIndex(p=>p.id===id); return i === -1 ? ranked.length : i; };
    const oppAvgMMR  = ids => avg(ids, players, "mmr");
    const oppAvgRank = ids => ids.reduce((s,id)=>s+rankOf(id),0)/ids.length;
    const winnerScore = Math.max(g.scoreA, g.scoreB);
    const loserScore  = Math.min(g.scoreA, g.scoreB);
    const oppWinMMR  = oppAvgMMR(winIds);
    const oppLosMMR  = oppAvgMMR(losIds);
    const oppWinRank = oppAvgRank(winIds);
    const oppLosRank = oppAvgRank(losIds);

    // Per-player deltas
    const playerDeltas = {};
    [...winIds, ...losIds].forEach(pid => {
      const p = players.find(x => x.id === pid);
      if (!p) return;
      const isWinner = winIds.includes(pid);
      const d = calcPlayerDelta({
        winnerScore, loserScore,
        playerMMR:          p.mmr,
        playerRank:         rankOf(pid),
        playerStreakPower:  p.streakPower || 0,
        oppAvgMMR:    isWinner ? oppLosMMR  : oppWinMMR,
        oppAvgRank:   isWinner ? oppLosRank : oppWinRank,
        isWinner,
      });
      playerDeltas[pid] = d;
    });

    players = players.map(p => {
      const d = playerDeltas[p.id];
      if (!d) return p;
      const isWin = winIds.includes(p.id);
      if (isWin) {
        const ns = (p.streak||0) >= 0 ? (p.streak||0)+1 : 1;
        const newPower = updateStreakPower(p.streakPower||0, true, d.qualityScore||1);
        return { ...p, mmr: p.mmr+d.gain, pts: (p.pts||0)+d.gain, wins: p.wins+1, streak: ns, streakPower: newPower };
      }
      const ns = (p.streak||0) <= 0 ? (p.streak||0)-1 : -1;
      return { ...p, mmr: Math.max(0,p.mmr-d.loss), pts: Math.max(0,(p.pts||0)-d.loss), losses: p.losses+1, streak: ns, streakPower: 0 };
    });

    // Flat per-player gain/loss maps — persisted, not stripped by slimState
    const perPlayerGains  = {};
    const perPlayerLosses = {};
    winIds.forEach(id => { if (playerDeltas[id]) perPlayerGains[id]  = playerDeltas[id].gain; });
    losIds.forEach(id => { if (playerDeltas[id]) perPlayerLosses[id] = playerDeltas[id].loss; });

    // Summary averages for legacy display fallback
    const avgGain = Math.round(winIds.reduce((s,id)=>s+(playerDeltas[id]?.gain||0),0)/Math.max(winIds.length,1));
    const avgLoss = Math.round(losIds.reduce((s,id)=>s+(playerDeltas[id]?.loss||0),0)/Math.max(losIds.length,1));

    // Apply penalties AFTER normal pts — they survive recalc
    if (g.penalties) {
      players = players.map(p => {
        const pen = g.penalties[p.id];
        if (!pen) return p;
        const deduct = (pen.yellow||0) * CONFIG.YELLOW_CARD_PTS + (pen.red||0) * CONFIG.RED_CARD_PTS;
        if (!deduct) return p;
        return { ...p, pts: Math.max(0, (p.pts||0) - deduct) };
      });
    }

    return { ...g, ptsGain: avgGain, ptsLoss: avgLoss, mmrGain: avgGain, mmrLoss: avgLoss, perPlayerGains, perPlayerLosses };
  });

  return { players, games: updatedGames };
}

// ── CORE DELTA FORMULA (PER-PLAYER) ──────────────────────────
// Each player receives their own individual gain/loss based on:
//   1. SCORE DOMINANCE  — scoreMult shared (same game for everyone)
//   2. MMR SURPRISE     — each player's MMR vs average opponent MMR
//   3. RANK GAP         — each player's rank vs average opponent rank
//   4. STREAK           — each player's own streak
//
// This means two players on the same winning team can receive
// different gains if one is heavily favoured and the other is an underdog.
//
function calcPlayerDelta({ winnerScore, loserScore, playerMMR, playerRank,
                           playerStreakPower, oppAvgMMR, oppAvgRank, isWinner }) {
  // 1. Score dominance
  const scoreDiff  = winnerScore - loserScore;
  const scoreRatio = scoreDiff / Math.max(winnerScore, 1);
  const scoreMult  = 1 + CONFIG.SCORE_WEIGHT * Math.pow(scoreRatio, CONFIG.SCORE_EXP);

  // 2. MMR surprise
  const mmrGap   = playerMMR - oppAvgMMR;
  const eloScale = 2 / (1 + Math.exp(mmrGap / CONFIG.ELO_DIVISOR));

  // 3. Rank gap
  const rankDiff  = isWinner
    ? (oppAvgRank - playerRank)
    : (playerRank - oppAvgRank);
  const rankScale = 1 + CONFIG.RANK_WEIGHT * Math.tanh(rankDiff / CONFIG.RANK_DIVISOR);

  // 4. Quality-weighted streak (capped, convergence-safe)
  const mult = streakMult(playerStreakPower, isWinner);

  // Quality score this game = how "hard" was the opponent
  const qualityScore = eloScale * rankScale;

  if (isWinner) {
    const gain = Math.max(2, Math.round(CONFIG.BASE_GAIN * scoreMult * eloScale * rankScale * mult));
    return { gain, loss: 0, scoreMult, eloScale, rankScale, streakMultVal: mult, qualityScore };
  } else {
    // Loss is harsher for:
    //   - high scoreMult (blowout defeat)
    //   - low eloScale  (expected win that didn't happen — higher MMR player lost)
    //   - high rankScale (higher-ranked player lost to lower-ranked)
    //   - active loss streak (streakMult > 1)
    // LOSS_HARSHNESS nudges the base up slightly without doubling anything
    const lossRankPunish = (2 - rankScale); // > 1 when higher-ranked lost to lower
    const loss = Math.max(1, Math.round(
      CONFIG.BASE_LOSS * scoreMult * (2 - eloScale) * lossRankPunish * mult * CONFIG.LOSS_HARSHNESS
    ));
    return { gain: 0, loss, scoreMult, eloScale, rankScale, streakMultVal: mult, qualityScore };
  }
}

// Legacy team-level wrapper used by GameDetail display (summary only)
function calcDelta({ winnerScore, loserScore, winnerAvgMMR, loserAvgMMR,
                     winnerAvgStreakPower, loserAvgStreakPower, winnerAvgRank, loserAvgRank }) {
  const scoreDiff  = winnerScore - loserScore;
  const scoreRatio = scoreDiff / Math.max(winnerScore, 1);
  const scoreMult  = 1 + CONFIG.SCORE_WEIGHT * Math.pow(scoreRatio, CONFIG.SCORE_EXP);
  const mmrGap     = winnerAvgMMR - loserAvgMMR;
  const eloScale   = 2 / (1 + Math.exp(mmrGap / CONFIG.ELO_DIVISOR));
  const rankDiff   = (loserAvgRank ?? 0) - (winnerAvgRank ?? 0);
  const rankScale  = 1 + CONFIG.RANK_WEIGHT * Math.tanh(rankDiff / CONFIG.RANK_DIVISOR);
  const winMult    = streakMult(winnerAvgStreakPower ?? 0, true);
  const lossMult   = streakMult(loserAvgStreakPower ?? 0, false);
  const gain = Math.max(2, Math.round(CONFIG.BASE_GAIN * scoreMult * eloScale * rankScale * winMult));
  const loss = Math.max(1, Math.round(CONFIG.BASE_LOSS * scoreMult * (2 - eloScale) * (2 - rankScale) * lossMult * CONFIG.LOSS_HARSHNESS));
  return { gain, loss, eloScale, rankScale, winMult, lossMult, scoreMult };
}

function getMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
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
    { id:"p1", name:"Alex",   mmr:1060, pts:74,  wins:9,  losses:3, streak: 4, championships:[] },
    { id:"p2", name:"Jordan", mmr:1038, pts:55,  wins:8,  losses:4, streak: 3, championships:[] },
    { id:"p3", name:"Sam",    mmr:1018, pts:38,  wins:6,  losses:5, streak: 1, championships:[] },
    { id:"p4", name:"Riley",  mmr: 992, pts:18,  wins:4,  losses:6, streak:-2, championships:[] },
    { id:"p5", name:"Casey",  mmr: 981, pts:10,  wins:3,  losses:7, streak:-3, championships:[] },
    { id:"p6", name:"Morgan", mmr: 970, pts: 4,  wins:2,  losses:8, streak:-4, championships:[] },
  ],
  games: [
    { id:"g1", sideA:["p1","p2"], sideB:["p3","p4"], winner:"A", scoreA:10, scoreB:6,  ptsGain:14, ptsLoss:6,  mmrGain:14, mmrLoss:6,  eloScale:.52, ptsFactor:.55, winMult:1.7, lossMult:1.1, date:new Date(Date.now()-86400000*3).toISOString(), monthKey:MK },
    { id:"g2", sideA:["p3","p5"], sideB:["p4","p6"], winner:"A", scoreA:10, scoreB:7,  ptsGain:12, ptsLoss:5,  mmrGain:12, mmrLoss:5,  eloScale:.50, ptsFactor:.50, winMult:1.2, lossMult:1.0, date:new Date(Date.now()-86400000*2).toISOString(), monthKey:MK },
    { id:"g3", sideA:["p2","p4"], sideB:["p1","p3"], winner:"A", scoreA:10, scoreB:8,  ptsGain:13, ptsLoss:5,  mmrGain:13, mmrLoss:5,  eloScale:.55, ptsFactor:.48, winMult:1.4, lossMult:1.3, date:new Date(Date.now()-86400000).toISOString(),   monthKey:MK },
  ],
  monthlyPlacements: {},
  finals: {},
  rules: DEFAULT_RULES,
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
    if (!s.players || s.players.length === 0) return SEED;
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
  return {
    players: s.players || [],
    games: s.games || [],
    monthlyPlacements: s.monthlyPlacements || {},
    finals: s.finals || {},
    rules: s.rules || DEFAULT_RULES,
    finalsDate: s.finalsDate || null,
    _v: typeof s._v === 'number' ? s._v : 0,
  };
}

// Duplicate game check: same players + same score on same day
function isDuplicateGame(candidate, existing) {
  const day = candidate.date.slice(0,10);
  const cSet = new Set([...candidate.sideA, ...candidate.sideB]);
  return existing.some(g => {
    if (g.date.slice(0,10) !== day) return false;
    const gSet = new Set([...g.sideA, ...g.sideB]);
    if (gSet.size !== cSet.size) return false;
    for (const id of cSet) if (!gSet.has(id)) return false;
    return g.scoreA === candidate.scoreA && g.scoreB === candidate.scoreB;
  });
}

// ── SUPABASE SETUP REQUIRED ─────────────────────────────────
// Run this SQL once in the Supabase SQL editor to enable true version-locked saves:
//
//   create or replace function update_state_versioned(expected_v int, new_state jsonb)
//   returns boolean language plpgsql as $$
//   declare updated int;
//   begin
//     update app_state set state = new_state, updated_at = now()
//     where id = 1 and (state->>'_v')::int = expected_v;
//     get diagnostics updated = row_count;
//     return updated > 0;
//   end;
//   $$;
//
// Without this, saves fall back to unconditional upsert (still works, less safe).
// ── SAVE QUEUE: true version-locked writes + exponential retry ─
// _pendingVersion tracks what _v we're about to write so the
// subscription can ignore our own echo without a timer window.
const _sq = {
  state: null, version: 0, pendingVersion: null,
  retries: 0, timer: null, onConflict: null, onSuccess: null,
};

function saveState(s, onConflict, onSuccess) {
  clearTimeout(_sq.timer);
  _sq.state = s;
  _sq.version = typeof s._v === 'number' ? s._v : 0;
  _sq.retries = 0;
  _sq.onConflict = onConflict || null;
  _sq.onSuccess = onSuccess || null;
  _sq.timer = setTimeout(_flushSave, 500);
}

async function _flushSave() {
  if (!_sq.state) return;
  const { state: s, version } = _sq;
  const nextV = version + 1;
  _sq.pendingVersion = nextV;

  const doUpsert = async () => {
    // Unconditional upsert — used when RPC unavailable or _v not yet seeded
    const { error } = await supabase
      .from('app_state')
      .upsert({ id: 1, state: slimState({ ...s, _v: nextV }), updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    const cb = _sq.onSuccess;
    _sq.state = null; _sq.retries = 0; _sq.onSuccess = null; _sq.pendingVersion = null;
    if (cb) cb(nextV);
  };

  try {
    const { data, error } = await supabase.rpc('update_state_versioned', {
      expected_v: version,
      new_state: slimState({ ...s, _v: nextV }),
    });

    if (!error && data === true) {
      // Clean success
      console.log('✓ saved _v' + nextV);
      const cb = _sq.onSuccess;
      _sq.state = null; _sq.retries = 0; _sq.onSuccess = null; _sq.pendingVersion = null;
      if (cb) cb(nextV);
      return;
    }

    if (!error && data === false) {
      // Definitive version mismatch — fetch remote to check
      // It's possible _v was null in DB (not seeded); if so, fall back to upsert
      const { data: cur } = await supabase.from('app_state').select('state').eq('id',1).single();
      const remoteV = cur?.state?._v;
      if (remoteV == null) {
        // _v not seeded in DB yet — just upsert, no real conflict
        console.warn('DB _v not seeded, falling back to upsert');
        await doUpsert();
        return;
      }
      if (remoteV === nextV) {
        // We actually succeeded (echo), treat as success
        console.log('✓ echo detected, treating as success _v' + nextV);
        const cb = _sq.onSuccess;
        _sq.state = null; _sq.retries = 0; _sq.onSuccess = null; _sq.pendingVersion = null;
        if (cb) cb(nextV);
        return;
      }
      // Genuine conflict — another client saved first
      console.warn('Version conflict at _v' + version + ', remote is _v' + remoteV);
      _sq.pendingVersion = null; _sq.state = null; _sq.retries = 0;
      if (cur?.state && _sq.onConflict) _sq.onConflict(normaliseState(cur.state));
      return;
    }

    // RPC unavailable (null data or error) — fall back to upsert
    if (error) console.warn('RPC error, falling back to upsert:', error.message);
    else console.warn('RPC returned null, falling back to upsert');
    await doUpsert();

  } catch (err) {
    _sq.pendingVersion = null;
    const MAX = 8;
    if (_sq.retries < MAX) {
      _sq.retries++;
      const delay = Math.min(600 * Math.pow(1.7, _sq.retries), 30000);
      console.warn(`Save retry ${_sq.retries}/${MAX} in ${Math.round(delay)}ms:`, err.message);
      _sq.timer = setTimeout(_flushSave, delay);
    } else {
      console.error('Save failed after max retries');
      _sq.state = null; _sq.retries = 0;
      try {
        const { data: cur } = await supabase.from('app_state').select('state').eq('id',1).single();
        if (cur?.state && _sq.onConflict) _sq.onConflict(normaliseState(cur.state));
      } catch {}
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

  /* ── MARKDOWN ────────────────────────────────────────────── */
  .md h1{font-family:var(--disp);font-size:30px;font-weight:800;color:var(--amber);margin-bottom:16px;letter-spacing:1px}
  .md h2{font-family:var(--disp);font-size:20px;font-weight:700;color:var(--text);margin:20px 0 8px;letter-spacing:1px;border-bottom:1px solid var(--b1);padding-bottom:6px}
  .md h3{font-family:var(--disp);font-size:16px;font-weight:700;color:var(--text);margin:14px 0 6px}
  .md p{line-height:1.7;color:var(--dim);margin-bottom:10px;font-size:13px}
  .md ul,.md ol{padding-left:20px;margin-bottom:10px}
  .md li{line-height:1.7;color:var(--dim);font-size:13px;margin-bottom:3px}
  .md strong{color:var(--text);font-weight:600}
  .md code{background:var(--s2);border:1px solid var(--b2);padding:1px 5px;border-radius:3px;font-size:11px;color:var(--amber)}
  .md hr{border:none;border-top:1px solid var(--b2);margin:16px 0}

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

  /* ── ANIMATIONS ──────────────────────────────────────────── */
  @keyframes slideUp{from{transform:translateY(10px);opacity:0}to{transform:translateY(0);opacity:1}}
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

  @media(max-width:640px){
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
  return d.toLocaleDateString("en-GB", { day:"numeric", month:"short" }) + " " +
    d.toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit" });
}
function fmtMonth(key) {
  if (!key) return "";
  const [y, m] = key.split("-");
  return new Date(y, m - 1).toLocaleString("en-GB", { month:"long", year:"numeric" });
}
function pName(id, players) { return players.find(p => p.id === id)?.name || "?"; }

function StreakBadge({ streak, streakPower=0, showMult=false }) {
  const s = streak || 0;
  if (s === 0) return <span className="text-dd">—</span>;
  const m = s > 0
    ? streakMult(streakPower, true)
    : streakMult(Math.abs(s) * CONFIG.STREAK_POWER_SCALE * 0.4, false);
  return s > 0
    ? <span className="text-g bold">▲{s}{showMult && <span className="xs" style={{opacity:.7}}> ×{m.toFixed(2)}</span>}</span>
    : <span className="text-r bold">▼{Math.abs(s)}{showMult && <span className="xs" style={{opacity:.7}}> ×{m.toFixed(2)}</span>}</span>;
}
function Pips({ used }) {
  return <>{Array.from({length:CONFIG.MAX_PLACEMENTS_PER_MONTH}).map((_,i)=>
    <span key={i} className={`pip ${i<used?"pip-u":"pip-f"}`}/>
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
  return <div className="fac" style={{gap:3,flexWrap:"wrap"}}>{badges}</div>;
}
function Toast({ t }) {
  if (!t) return null;
  return <div className={`toast ${t.type||"info"}`}>{t.msg}</div>;
}
function Modal({ onClose, children, large=false }) {
  return createPortal(
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className={`modal ${large?"modal-lg":""}`}>{children}</div>
    </div>,
    document.body
  );
}

// Simple markdown renderer
function renderMd(md) {
  if (!md) return "";
  return md
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/^---$/gm, "<hr>")
    .replace(/^\- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/gs, m => `<ul>${m}</ul>`)
    .replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
    .replace(/^(?!<[h|u|o|l|h]|$)(.+)$/gm, "<p>$1</p>")
    .replace(/<\/ul>\s*<ul>/g, "");
}

function ConfirmDialog({ title, msg, onConfirm, onCancel, danger=false }) {
  return (
    <Modal onClose={onCancel}>
      <div className="confirm-modal">
        <div className="modal-title" style={{color:danger?"var(--red)":"var(--amber)"}}>{title}</div>
        <p className="text-d sm mb16">{msg}</p>
        <div className="fac" style={{justifyContent:"center",gap:10}}>
          <button className="btn btn-g" onClick={onCancel}>Cancel</button>
          <button className={`btn ${danger?"btn-d":"btn-p"}`} onClick={onConfirm}>Confirm</button>
        </div>
      </div>
    </Modal>
  );
}

// ============================================================
// PLAYER PROFILE MODAL
// ============================================================
function PlayerProfile({ player, state, onClose, isAdmin, onEdit }) {
  const monthKey = getMonthKey();
  const placements = (state.monthlyPlacements[monthKey]||{})[player.id]||0;
  const myGames = [...state.games]
    .filter(g=>g.sideA.includes(player.id)||g.sideB.includes(player.id))
    .sort((a,b)=>new Date(b.date)-new Date(a.date));
  const rank = [...state.players].sort((a,b)=>(b.pts||0)-(a.pts||0)).findIndex(p=>p.id===player.id)+1;
  const champs = player.championships || [];

  return (
    <Modal onClose={onClose} large>
      {champs.length > 0 && (
        <div className="championship-banner">
          <span style={{fontSize:22}}>🏆</span>
          <div>
            <div className="xs text-am bold" style={{letterSpacing:2,textTransform:"uppercase"}}>Monthly Champion</div>
            <div className="sm text-d mt8" style={{marginTop:2}}>
              {champs.map((c,i)=>(
                <span key={i}>{fmtMonth(c.month)}{c.partner ? ` (w/ ${c.partner})` : ""}{i<champs.length-1?" · ":""}</span>
              ))}
            </div>
          </div>
          {isAdmin && (
            <button className="btn btn-warn btn-sm" style={{marginLeft:"auto"}} onClick={onEdit}>Edit</button>
          )}
        </div>
      )}

      <div className="prof-head">
        <div className="prof-av">{player.name[0].toUpperCase()}</div>
        <div style={{flex:1}}>
          <div className="prof-name">{player.name}</div>
          <div className="prof-sub">Rank #{rank} · {player.pts||0} pts</div>
        </div>
        <div className="fac" style={{gap:6}}>
          {isAdmin && !champs.length && (
            <button className="btn btn-g btn-sm" onClick={onEdit}>Edit</button>
          )}
          <button className="btn btn-g btn-sm" onClick={onClose} style={{fontSize:14,padding:"3px 9px"}}>×</button>
        </div>
      </div>

      <div className="grid-3 mb16">
        <div className="stat-box">
          <div className="stat-lbl">Points</div>
          <div className="stat-val am">
            {placements >= CONFIG.MAX_PLACEMENTS_PER_MONTH
              ? (player.pts||0)
              : <span className="text-dd" title="Complete placements to reveal points">?</span>}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-lbl">Record</div>
          <div className="stat-val" style={{fontSize:20}}>
            <span className="text-g">{player.wins}</span>
            <span className="text-dd" style={{fontSize:13}}>/</span>
            <span className="text-r">{player.losses}</span>
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-lbl">Streak</div>
          <div className="stat-val" style={{fontSize:20}}><StreakBadge streak={player.streak} streakPower={player.streakPower||0} showMult /></div>
        </div>
      </div>

      <div className="grid-3 mb16">
        <div className="stat-box">
          <div className="stat-lbl">Win Rate</div>
          <div className="stat-val" style={{fontSize:20}}>
            {player.wins+player.losses>0
              ? <span className={player.wins/(player.wins+player.losses)>=.5?"text-g":"text-r"}>
                  {Math.round(player.wins/(player.wins+player.losses)*100)}%
                </span>
              : <span className="text-dd">—</span>}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-lbl">Position</div>
          <div style={{marginTop:8}}><PosBadge pos={player.position}/></div>
        </div>
        <div className="stat-box">
          <div className="stat-lbl">Placements this month</div>
          <div style={{marginTop:10}}><Pips used={placements}/></div>
        </div>
      </div>

      <div className="sec">Match History</div>
      {myGames.length===0 && <div className="text-d sm">No games yet</div>}
      {myGames.map(g=>{
        const onA = g.sideA.includes(player.id);
        const won = (onA&&g.winner==="A")||(!onA&&g.winner==="B");
        const mates = (onA?g.sideA:g.sideB).filter(id=>id!==player.id).map(id=>pName(id,state.players));
        const opps  = (onA?g.sideB:g.sideA).map(id=>pName(id,state.players));
        const myScore = onA?g.scoreA:g.scoreB;
        const oppScore = onA?g.scoreB:g.scoreA;
        return (
          <div key={g.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:"1px solid var(--b1)",fontSize:12,gap:6,flexWrap:"wrap"}}>
            <span className={`tag ${won?"tag-w":"tag-l"}`}>{won?"WIN":"LOSS"}</span>
            {mates.length>0 && <span className="text-d sm">w/ {mates.join(" & ")}</span>}
            <span className="text-d sm">vs {opps.join(" & ")}</span>
            <span className="disp text-am" style={{fontSize:15}}>{myScore}–{oppScore}</span>
            <span className={won?"text-g":"text-r"}>
              {(() => {
                const delta = won
                  ? (g.perPlayerGains?.[player.id] ?? g.playerDeltas?.[player.id]?.gain ?? g.ptsGain)
                  : (g.perPlayerLosses?.[player.id] ?? g.playerDeltas?.[player.id]?.loss ?? g.ptsLoss);
                return `${won?"+":"−"}${delta}pts`;
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
  const [pts, setPts] = useState(String(player.pts||0));
  const [streak, setStreak] = useState(String(player.streak||0));
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
    const newPts = parseInt(pts);
    const newStreak = parseInt(streak);
    if (isNaN(newPts) || isNaN(newStreak)) { showToast("Invalid values","error"); return; }
    if (!name.trim()) { showToast("Name required","error"); return; }
    setState(s => ({
      ...s,
      players: s.players.map(p => p.id===player.id
        ? {...p, name:name.trim(), pts:newPts, streak:newStreak, position: positions.length === 0 ? "none" : positions}
        : p
      )
    }));
    showToast("Profile updated");
    onClose();
  }

  function addChamp() {
    if (!champMonth) { showToast("Select a month","error"); return; }
    const c = { month: champMonth, partner: champPartner.trim() || null };
    setState(s => ({
      ...s,
      players: s.players.map(p => p.id===player.id
        ? {...p, championships:[...(p.championships||[]), c]}
        : p
      )
    }));
    showToast("Championship added 🏆");
    setChampMonth(""); setChampPartner("");
  }

  function removeChamp(i) {
    setState(s => ({
      ...s,
      players: s.players.map(p => p.id===player.id
        ? {...p, championships:(p.championships||[]).filter((_,idx)=>idx!==i)}
        : p
      )
    }));
    showToast("Championship removed");
  }

  function recalcPlayer() {
    setConfirm({
      title:"Recalculate from Games?",
      msg:`This will recalculate ${player.name}'s pts, mmr, wins, losses, and streak from the game log. Manual edits will be overwritten.`,
      onConfirm: () => {
        const { players, games } = replayGames(state.players, state.games);
        setState(s => ({...s, players, games}));
        showToast("All stats recalculated from game log");
        setConfirm(null);
        onClose();
      }
    });
  }

  // Generate month options (last 12 months)
  const monthOptions = Array.from({length:12}).map((_,i) => {
    const d = new Date(); d.setMonth(d.getMonth()-i);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  });

  return (
    <>
      <Modal onClose={onClose}>
        <div className="modal-title">Edit — {player.name}</div>

        <div className="sec">Profile</div>
        <div className="field"><label className="lbl">Name</label>
          <input className="inp inp-edit" value={name} onChange={e=>setName(e.target.value)}/></div>
        <div className="grid-2">
          <div className="field"><label className="lbl">Points (visible)</label>
            <input className="inp inp-edit" type="number" value={pts} onChange={e=>setPts(e.target.value)}/></div>
          <div className="field"><label className="lbl">Streak (+win / -loss)</label>
            <input className="inp inp-edit" type="number" value={streak} onChange={e=>setStreak(e.target.value)}/></div>
        </div>
        <div className="field mt8"><label className="lbl">Position Preference</label>
          <div className="fac" style={{gap:6,flexWrap:"wrap",marginBottom:4}}>
            {[["attack","🗡 Attack"],["defense","🛡 Defense"],["flex","⚡ Flex"]].map(([v,l])=>{
              const on = positions.includes(v);
              return (
                <button key={v} className={`pill ${on?"on":""}`} onClick={()=>{
                  setPositions(prev => prev.includes(v) ? prev.filter(x=>x!==v) : [...prev, v]);
                }}>{l}</button>
              );
            })}
          </div>
          <div className="xs text-dd" style={{marginTop:3}}>Select all that apply. Flex = comfortable in either role.</div>
        </div>
        <div className="msg msg-w sm">Manually editing pts/streak will diverge from game history. Use recalculate to re-sync.</div>

        <div className="divider"/>
        <div className="sec">Championships</div>
        {(player.championships||[]).map((c,i)=>(
          <div key={i} className="fbc" style={{padding:"6px 0",borderBottom:"1px solid var(--b1)",fontSize:12}}>
            <span className="text-am">🏆 {fmtMonth(c.month)}{c.partner?` (w/ ${c.partner})`:""}</span>
            <button className="btn btn-d btn-sm" onClick={()=>removeChamp(i)}>Remove</button>
          </div>
        ))}
        <div className="grid-2 mt8">
          <div className="field"><label className="lbl">Month</label>
            <select className="inp" value={champMonth} onChange={e=>setChampMonth(e.target.value)}>
              <option value="">Select…</option>
              {monthOptions.map(m=><option key={m} value={m}>{fmtMonth(m)}</option>)}
            </select>
          </div>
          <div className="field"><label className="lbl">Partner (optional)</label>
            <input className="inp" placeholder="Teammate name" value={champPartner} onChange={e=>setChampPartner(e.target.value)}/>
          </div>
        </div>
        <button className="btn btn-warn btn-sm" onClick={addChamp}>+ Add Championship</button>

        <div className="divider"/>
        <div className="fac" style={{justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
          <button className="btn btn-g btn-sm" onClick={recalcPlayer}>Recalculate All from Games</button>
          <div className="fac">
            <button className="btn btn-g" onClick={onClose}>Cancel</button>
            <button className="btn btn-p" onClick={save}>Save</button>
          </div>
        </div>
      </Modal>
      {confirm && <ConfirmDialog {...confirm} onCancel={()=>setConfirm(null)}/>}
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

  const sA = game.sideA.map(id=>state.players.find(p=>p.id===id)).filter(Boolean);
  const sB = game.sideB.map(id=>state.players.find(p=>p.id===id)).filter(Boolean);
  const allPlayers = [...sA, ...sB];

  function setPenalty(pid, type, val) {
    setPenalties(prev => ({
      ...prev,
      [pid]: { ...(prev[pid]||{yellow:0,red:0}), [type]: Math.max(0, val) }
    }));
  }

  function savePenalties() {
    // Save penalties without changing scores — just rerun to apply
    const updatedGame = {...game, penalties};
    const editedGames = state.games.map(g=>g.id===game.id ? updatedGame : g);
    const basePlayers = state.players.map(p=>({...p, mmr:CONFIG.STARTING_MMR, pts:CONFIG.STARTING_PTS, wins:0, losses:0, streak:0, streakPower:0, lossStreakPower:0}));
    const { players: newPlayers, games: newGames } = replayGames(basePlayers, editedGames);
    const mergedPlayers = newPlayers.map(p => {
      const orig = state.players.find(x=>x.id===p.id);
      return {...p, name:orig?.name||p.name, championships:orig?.championships||[], position:orig?.position||p.position};
    });
    const newPlacements = computePlacements(newGames);
    setState(s=>({...s, games:newGames, players:mergedPlayers, monthlyPlacements:newPlacements}));
    const totalCards = Object.values(penalties).reduce((s,v)=>(v.yellow||0)+(v.red||0)+s, 0);
    showToast(totalCards > 0 ? "Penalties applied & stats updated" : "Penalties cleared");
    setEditing(false);
    onClose();
  }

  function saveEdit() {
    const nA = parseInt(scoreA), nB = parseInt(scoreB);
    if (isNaN(nA)||isNaN(nB)||nA<0||nB<0) { showToast("Invalid scores","error"); return; }
    if (nA===nB) { showToast("No draws","error"); return; }
    const updatedGame = {...game, scoreA:nA, scoreB:nB, winner, penalties};
    const editedGames = state.games.map(g=>g.id===game.id ? updatedGame : g);
    const basePlayers = state.players.map(p=>({...p, mmr:CONFIG.STARTING_MMR, pts:CONFIG.STARTING_PTS, wins:0, losses:0, streak:0, streakPower:0, lossStreakPower:0}));
    const { players: newPlayers, games: newGames } = replayGames(basePlayers, editedGames);
    const mergedPlayers = newPlayers.map(p => {
      const orig = state.players.find(x=>x.id===p.id);
      return {...p, name:orig?.name||p.name, championships:orig?.championships||[], position:orig?.position||p.position};
    });
    const newPlacements = computePlacements(newGames);
    setState(s=>({...s, games:newGames, players:mergedPlayers, monthlyPlacements:newPlacements}));
    showToast("Match updated & stats recalculated");
    setEditing(false);
    onClose();
  }

  function deleteGame() {
    setConfirm({
      title:"Delete Match?",
      msg:"Permanently removes this match and recalculates all affected stats.",
      danger:true,
      onConfirm:()=>{
        const filteredGames = state.games.filter(g=>g.id!==game.id);
        const basePlayers = state.players.map(p=>({...p, mmr:CONFIG.STARTING_MMR, pts:CONFIG.STARTING_PTS, wins:0, losses:0, streak:0, streakPower:0, lossStreakPower:0}));
        const { players: newPlayers, games: newGames } = replayGames(basePlayers, filteredGames);
        const mergedPlayers = newPlayers.map(p => {
          const orig = state.players.find(x=>x.id===p.id);
          return {...p, name:orig?.name||p.name, championships:orig?.championships||[], position:orig?.position||p.position};
        });
        const newPlacements = computePlacements(newGames);
        setState(s=>({...s, games:newGames, players:mergedPlayers, monthlyPlacements:newPlacements}));
        showToast("Match deleted & stats recalculated");
        setConfirm(null);
        onClose();
      }
    });
  }

  // Total penalty deduction per player
  function penaltyTotal(pid) {
    const p = penalties[pid]||{};
    return (p.yellow||0)*CONFIG.YELLOW_CARD_PTS + (p.red||0)*CONFIG.RED_CARD_PTS;
  }

  const hasPenalties = Object.values(game.penalties||{}).some(v=>(v.yellow||0)+(v.red||0)>0);

  return (
    <>
      <Modal onClose={onClose}>
        <div className="fbc mb12">
          <div>
            <div className="modal-title" style={{marginBottom:2}}>Match Detail</div>
            <div className="xs text-dd">{fmtDate(game.date)}</div>
          </div>
          {isAdmin && !editing && (
            <div className="fac" style={{gap:6}}>
              <button className="btn btn-warn btn-sm" onClick={()=>setEditing(true)}>Edit</button>
              <button className="btn btn-d btn-sm" onClick={deleteGame}>Delete</button>
            </div>
          )}
        </div>

        {/* Score display / edit */}
        <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:14,alignItems:"center",margin:"14px 0"}}>
          <div>
            <div className="xs" style={{marginBottom:6,fontWeight:600,color:game.winner==="A"?"var(--green)":"var(--dimmer)"}}>
              {game.winner==="A"?"🏆 ":""}Side A
            </div>
            {sA.map(p=>{
              const gain = game.perPlayerGains?.[p.id]??game.ptsGain;
              const loss = game.perPlayerLosses?.[p.id]??game.ptsLoss;
              const pen = penaltyTotal(p.id);
              return (
                <div key={p.id} style={{marginBottom:4}}>
                  <div className={`bold ${game.winner==="A"?"text-g":"text-r"}`} style={{fontSize:14}}>{p.name}</div>
                  <div className="xs text-dd">
                    {game.winner==="A"?<span className="text-g">+{gain}pts</span>:<span className="text-r">−{loss}pts</span>}
                    {pen>0&&<span style={{color:"var(--orange)",marginLeft:4}}>−{pen} 🟡</span>}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{textAlign:"center"}}>
            {editing ? (
              <div style={{display:"flex",flexDirection:"column",gap:6,alignItems:"center"}}>
                <div className="fac" style={{gap:6}}>
                  <input className="inp inp-edit" type="number" min="0" value={scoreA}
                    onChange={e=>setScoreA(e.target.value)}
                    style={{width:52,textAlign:"center",fontSize:20,fontFamily:"var(--disp)",fontWeight:700}}/>
                  <span className="text-dd" style={{fontSize:18}}>–</span>
                  <input className="inp inp-edit" type="number" min="0" value={scoreB}
                    onChange={e=>setScoreB(e.target.value)}
                    style={{width:52,textAlign:"center",fontSize:20,fontFamily:"var(--disp)",fontWeight:700}}/>
                </div>
                <select className="inp" value={winner} onChange={e=>setWinner(e.target.value)} style={{fontSize:11,padding:"4px 8px"}}>
                  <option value="A">A won</option>
                  <option value="B">B won</option>
                </select>
              </div>
            ) : (
              <div className="disp text-am" style={{fontSize:36,fontWeight:700}}>{game.scoreA}–{game.scoreB}</div>
            )}
          </div>

          <div style={{textAlign:"right"}}>
            <div className="xs" style={{marginBottom:6,fontWeight:600,color:game.winner==="B"?"var(--green)":"var(--dimmer)"}}>
              Side B{game.winner==="B"?" 🏆":""}
            </div>
            {sB.map(p=>{
              const gain = game.perPlayerGains?.[p.id]??game.ptsGain;
              const loss = game.perPlayerLosses?.[p.id]??game.ptsLoss;
              const pen = penaltyTotal(p.id);
              return (
                <div key={p.id} style={{marginBottom:4}}>
                  <div className={`bold ${game.winner==="B"?"text-g":"text-r"}`} style={{fontSize:14}}>{p.name}</div>
                  <div className="xs text-dd">
                    {game.winner==="B"?<span className="text-g">+{gain}pts</span>:<span className="text-r">−{loss}pts</span>}
                    {pen>0&&<span style={{color:"var(--orange)",marginLeft:4}}>−{pen} 🟡</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Per-player penalties — always shown to admin */}
        {isAdmin && (
          <div style={{marginTop:4}}>
            <div className="sec" style={{marginBottom:8}}>Disciplinary Cards</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {allPlayers.map(p=>{
                const pen = penalties[p.id]||{yellow:0,red:0};
                return (
                  <div key={p.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:"var(--s2)",borderRadius:8,border:"1px solid var(--b1)"}}>
                    <span style={{flex:1,fontWeight:600,fontSize:13}}>{p.name}</span>
                    {/* Yellow card */}
                    <div className="fac" style={{gap:4}}>
                      <span style={{fontSize:16}}>🟡</span>
                      <button className="btn btn-g btn-sm" style={{padding:"2px 7px",minWidth:22}}
                        onClick={()=>setPenalty(p.id,"yellow",Math.max(0,(pen.yellow||0)-1))}>−</button>
                      <span style={{minWidth:16,textAlign:"center",fontWeight:700,fontSize:13}}>{pen.yellow||0}</span>
                      <button className="btn btn-g btn-sm" style={{padding:"2px 7px",minWidth:22}}
                        onClick={()=>setPenalty(p.id,"yellow",(pen.yellow||0)+1)}>+</button>
                      <span className="xs text-dd">−{CONFIG.YELLOW_CARD_PTS}pts ea</span>
                    </div>
                    {/* Red card */}
                    <div className="fac" style={{gap:4}}>
                      <span style={{fontSize:16}}>🔴</span>
                      <button className="btn btn-g btn-sm" style={{padding:"2px 7px",minWidth:22}}
                        onClick={()=>setPenalty(p.id,"red",Math.max(0,(pen.red||0)-1))}>−</button>
                      <span style={{minWidth:16,textAlign:"center",fontWeight:700,fontSize:13}}>{pen.red||0}</span>
                      <button className="btn btn-g btn-sm" style={{padding:"2px 7px",minWidth:22}}
                        onClick={()=>setPenalty(p.id,"red",(pen.red||0)+1)}>+</button>
                      <span className="xs text-dd">−{CONFIG.RED_CARD_PTS}pts ea</span>
                    </div>
                    {penaltyTotal(p.id)>0 && (
                      <span style={{color:"var(--orange)",fontWeight:700,fontSize:12,minWidth:50,textAlign:"right"}}>
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
          <div className="msg msg-e" style={{marginTop:8,fontSize:11}}>
            ⚠ Disciplinary penalties have been applied to this match
          </div>
        )}

        <div className="fac mt16" style={{justifyContent:"flex-end",gap:8}}>
          {editing ? (
            <>
              <button className="btn btn-g" onClick={()=>setEditing(false)}>Cancel</button>
              <button className="btn btn-p" onClick={saveEdit}>Save & Recalculate</button>
            </>
          ) : (
            <button className="btn btn-g w-full" onClick={onClose}>Close</button>
          )}
        </div>
      </Modal>
      {confirm && <ConfirmDialog {...confirm} onCancel={()=>setConfirm(null)}/>}
    </>
  );
}

// Last N game results for a player — oldest first
function lastNResults(pid, games, n=5) {
  return [...games]
    .filter(g => g.sideA.includes(pid) || g.sideB.includes(pid))
    .sort((a,b) => new Date(a.date)-new Date(b.date))
    .slice(-n)
    .map(g => {
      const onA = g.sideA.includes(pid);
      return (onA && g.winner==="A") || (!onA && g.winner==="B") ? "W" : "L";
    });
}

function Sparkline({ pid, games }) {
  const results = lastNResults(pid, games, 5);
  if (!results.length) return null;
  return (
    <div style={{display:"flex",gap:2,alignItems:"center"}}>
      {results.map((r,i) => (
        <div key={i} style={{
          width:5, height:5, borderRadius:"50%",
          background: r==="W" ? "var(--green)" : "var(--red)",
          opacity: 0.5 + (i/results.length)*0.5,
        }}/>
      ))}
    </div>
  );
}

// ============================================================
// LIVE TICKER
// ============================================================
function LiveTicker({ games, players }) {
  const [visible, setVisible] = useState(true);
  const latest = [...(games||[])].sort((a,b)=>new Date(b.date)-new Date(a.date))[0];
  if (!latest || !visible) return null;
  const age = Date.now() - new Date(latest.date).getTime();
  if (age > 5 * 60 * 1000) return null; // only show within 5 mins
  const wIds = latest.winner==="A"?latest.sideA:latest.sideB;
  const lIds = latest.winner==="A"?latest.sideB:latest.sideA;
  const wNames = wIds.map(id=>pName(id,players)).join(" & ");
  const lNames = lIds.map(id=>pName(id,players)).join(" & ");
  const score = `${latest.scoreA}–${latest.scoreB}`;
  return (
    <div style={{
      background:"radial-gradient(ellipse 80% 300% at 0% 50%,rgba(94,201,138,.12),var(--s1))",
      border:"1px solid var(--amber-d)",borderRadius:10,
      padding:"8px 16px",display:"flex",alignItems:"center",gap:10,fontSize:12,
      animation:"slideUp .3s ease"
    }}>
      <span className="tag tag-w" style={{flexShrink:0}}>LIVE</span>
      <span style={{flex:1}}>
        <span className="text-g bold">{wNames}</span>
        <span className="text-dd"> beat </span>
        <span>{lNames}</span>
        <span className="text-am bold" style={{marginLeft:8,fontFamily:"var(--disp)"}}>{score}</span>
      </span>
      <button onClick={()=>setVisible(false)} style={{background:"none",border:"none",color:"var(--dimmer)",cursor:"pointer",fontSize:14,padding:"0 4px"}}>×</button>
    </div>
  );
}

// ============================================================
// LEADERBOARD VIEW
// ============================================================
function LeaderboardView({ state, setState, onSelectPlayer, onNavToPlay, onNavToHistory, rtConnected, isAdmin, showToast, syncStatus }) {
  const monthKey = getMonthKey();
  const ranked = [...(state.players ?? [])].sort((a,b)=>(b.pts||0)-(a.pts||0));
  const [showRecalcConfirm, setShowRecalcConfirm] = useState(false);

  function doRecalc() {
    const { players, games } = replayGames(state.players, state.games);
    const monthlyPlacements = computePlacements(games);
    setState(s => ({ ...s, players, games, monthlyPlacements }));
    showToast("All stats recalculated from game log");
    setShowRecalcConfirm(false);
  }
  const monthGames = (state.games ?? []).filter(g=>g.monthKey===monthKey);

  const prevSnapshot = useRef(null); // null = not yet initialised
  const animClearTimer = useRef(null);
  const [animMap, setAnimMap] = useState({});
  useEffect(()=>{
    // Build new snapshot from current ranked list
    const next = {};
    ranked.forEach((p,i)=>{ next[p.id]={rank:i,pts:p.pts||0}; });

    const prev = prevSnapshot.current;
    // First render — just store snapshot, no animation
    if(!prev){ prevSnapshot.current=next; return; }

    const anims = {};
    ranked.forEach((p,i)=>{
      const pr = prev[p.id]?.rank;
      const pp = prev[p.id]?.pts;
      // Only animate if we have a previous value AND it changed
      if(pr!==undefined && pr!==i){
        anims[p.id] = i < pr ? "rank-up" : "rank-down";
      } else if(pp!==undefined && pp!==(p.pts||0)){
        anims[p.id] = "pts-changed";
      }
    });

    // Update snapshot to new state
    prevSnapshot.current = next;

    if(Object.keys(anims).length){
      clearTimeout(animClearTimer.current);
      setAnimMap(anims);
      animClearTimer.current = setTimeout(()=>setAnimMap({}), 1200);
    }
  },[state.players]);

  return (
    <>
    <div className="stack page-fade">
      <LiveTicker games={state.games} players={state.players}/>
      {isAdmin && (
        <div style={{display:"flex",justifyContent:"flex-end"}}>
          <button className="btn btn-g btn-sm" style={{gap:6}} onClick={()=>setShowRecalcConfirm(true)}>
            ↺ Recalc
          </button>
        </div>
      )}
      <div className="grid-3">
        <div className="stat-box"><div className="stat-lbl">Players</div><div className="stat-val am">{(state.players??[]).length}</div></div>
        <div className="stat-box" style={{cursor:"pointer"}} onClick={onNavToHistory}
          title="View match history">
          <div className="stat-lbl">Games This Month</div>
          <div className="stat-val">{monthGames.length}</div>
          <div className="xs text-dd" style={{marginTop:3}}>View history →</div>
        </div>
        <div className="stat-box"><div className="stat-lbl">Top Points</div><div className="stat-val am">{ranked[0]?.pts??0}</div></div>
      </div>
      {ranked.filter(p=>(state.monthlyPlacements[monthKey]||{})[p.id]>=CONFIG.MAX_PLACEMENTS_PER_MONTH).slice(0,4).length >= 2 && (
        <div className="card" style={{cursor:"pointer",transition:"border-color .15s"}}
          onClick={()=>onNavToPlay()} onMouseEnter={e=>e.currentTarget.style.borderColor="var(--amber-d)"}
          onMouseLeave={e=>e.currentTarget.style.borderColor=""}>
          <div className="card-header">
            <span className="card-title">Championship Race</span>
            <span className="tag tag-a" style={{cursor:"pointer"}}>View Finals →</span>
          </div>
          <div style={{padding:"10px 16px",display:"flex",gap:8,flexWrap:"wrap"}}>
            {ranked.filter(p=>(state.monthlyPlacements[monthKey]||{})[p.id]>=CONFIG.MAX_PLACEMENTS_PER_MONTH).slice(0,4).map((p,i)=>(
              <div key={p.id} style={{
                flex:"1 1 120px",padding:"8px 12px",borderRadius:8,
                background: i===0?"radial-gradient(ellipse 120% 120% at 100% 100%,rgba(232,184,74,.15),var(--s2))":
                            i===1?"radial-gradient(ellipse 120% 120% at 100% 100%,rgba(192,200,196,.08),var(--s2))":
                            i===2?"radial-gradient(ellipse 120% 120% at 100% 100%,rgba(200,134,74,.08),var(--s2))":
                            "var(--s2)",
                border:`1px solid ${i===0?"rgba(232,184,74,.35)":i===1?"rgba(192,200,196,.2)":i===2?"rgba(200,134,74,.2)":"var(--b2)"}`,
              }}>
                <div className="xs" style={{marginBottom:3,color:i===0?"var(--gold)":i===1?"#c0c8c4":i===2?"#c8864a":"var(--dimmer)"}}>
                  {i===0?"🥇":i===1?"🥈":i===2?"🥉":`#${i+1}`}
                </div>
                <div style={{fontWeight:600,fontSize:13}}>{p.name}</div>
                <div className="xs" style={{color:i===0?"var(--gold)":"var(--amber)",marginTop:2}}>{p.pts||0} pts</div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Rankings — {fmtMonth(monthKey)}</span>
          <div className="fac" style={{gap:8}}>
            <span className={`rt-dot ${rtConnected?"live":""}`} title={rtConnected?"Live":"Connecting…"}/>
            <span className="xs text-dd">{rtConnected?"Live":"…"}</span>
            {isAdmin && syncStatus !== 'idle' && (
              <span className="xs" style={{color:
                syncStatus==='saving'  ? 'var(--dimmer)' :
                syncStatus==='saved'   ? 'var(--green)'  :
                syncStatus==='conflict'? 'var(--orange)' : 'var(--red)'
              }}>
                {syncStatus==='saving'?'↑ saving':syncStatus==='saved'?'✓ saved':syncStatus==='conflict'?'⚡ synced':'⚠ error'}
              </span>
            )}
          </div>
        </div>
        <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr><th>#</th><th>Player</th><th>Points</th><th>W</th><th>L</th><th>Win%</th><th>Streak</th><th>Position</th><th>Placements</th></tr>
          </thead>
          <tbody>
            {(()=>{ let placedCount=0; return ranked.map((p,i)=>{
              const placements=(state.monthlyPlacements[monthKey]||{})[p.id]||0;
              const isPlaced=placements>=CONFIG.MAX_PLACEMENTS_PER_MONTH;
              const rankNum=isPlaced?++placedCount:null;
              const total=p.wins+p.losses;
              const pct=total?Math.round(p.wins/total*100):0;
              const anim=animMap[p.id]||"";
              return (
                <tr key={p.id} className={`lb-row ${anim}`} style={{animationDelay:`${i*28}ms`,opacity:isPlaced?1:0.6}} onClick={()=>onSelectPlayer(p)}>
                  <td><span className={`rk ${isPlaced?(rankNum===1?"r1":rankNum===2?"r2":rankNum===3?"r3":""):""}`}
                    style={!isPlaced?{color:"var(--dimmer)"}:{}}>
                    {isPlaced?(rankNum===1?"①":rankNum===2?"②":rankNum===3?"③":`#${rankNum}`):<span style={{fontSize:9,letterSpacing:.5,fontFamily:"var(--sans)",fontWeight:500}}>UNRANKED</span>}
                  </span></td>
                  <td>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <span className="bold">{p.name}</span>
                      {(p.championships||[]).length>0&&<span style={{fontSize:13}}>🏆</span>}
                      <Sparkline pid={p.id} games={state.games}/>
                    </div>
                  </td>
                  <td>
                    {isPlaced
                      ? <><span className="bold" style={{fontSize:14}}>{p.pts||0}</span>
                          {anim==="rank-up"&&<span className="xs text-g" style={{marginLeft:5}}>▲</span>}
                          {anim==="rank-down"&&<span className="xs text-r" style={{marginLeft:5}}>▼</span>}
                        </>
                      : <span className="text-dd" style={{fontSize:10,fontFamily:"var(--sans)",fontWeight:500,letterSpacing:.3}}>—</span>
                    }
                  </td>
                  <td><span className="text-g bold">{p.wins}</span></td>
                  <td><span className="text-r bold">{p.losses}</span></td>
                  <td><span className={pct>=50?"text-g":"text-d"}>{total?`${pct}%`:"—"}</span></td>
                  <td><StreakBadge streak={p.streak} streakPower={p.streakPower||0} showMult /></td>
                  <td><PosBadge pos={p.position}/></td>
                  <td>
                    {isPlaced
                      ? <span className="placement-badge placement-done">✓ Placed</span>
                      : <span className="placement-badge placement-pending"><Pips used={placements}/> {CONFIG.MAX_PLACEMENTS_PER_MONTH - placements} left</span>
                    }
                  </td>
                </tr>
              );
            });})()}
            {ranked.length===0&&<tr><td colSpan={9} style={{textAlign:"center",padding:32,color:"var(--dimmer)"}}>
              No players yet — ask an admin to onboard players
            </td></tr>}
          </tbody>
        </table>
        </div>
        {/* Mobile card layout */}
        <div className="lb-cards">
          {(()=>{ let placedCount=0; return ranked.map((p,i)=>{
            const placements=(state.monthlyPlacements[monthKey]||{})[p.id]||0;
            const isPlaced=placements>=CONFIG.MAX_PLACEMENTS_PER_MONTH;
            const rankNum=isPlaced?++placedCount:null;
            const total=p.wins+p.losses;
            const pct=total?Math.round(p.wins/total*100):0;
            return (
              <div key={p.id} className="lb-card" onClick={()=>onSelectPlayer(p)}>
                <div className="lb-card-rank">
                  {isPlaced
                    ? <span className={rankNum===1?"text-am":rankNum===2?"":rankNum===3?"":""} style={{color:rankNum===1?"var(--gold)":rankNum===2?"#c0c8c4":rankNum===3?"#c8864a":"var(--dim)"}}>
                        #{rankNum}
                      </span>
                    : <span style={{fontSize:9,color:"var(--dimmer)",fontFamily:"var(--sans)"}}>—</span>
                  }
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span className="lb-card-name">{p.name}</span>
                    {(p.championships||[]).length>0&&<span style={{fontSize:12}}>🏆</span>}
                    <Sparkline pid={p.id} games={state.games}/>
                  </div>
                  <div className="lb-card-meta">
                    <span className="text-g">{p.wins}W</span>
                    {" "}<span className="text-r">{p.losses}L</span>
                    {" · "}{total?`${pct}%`:"—"}
                    {" · "}<StreakBadge streak={p.streak} streakPower={p.streakPower||0} lossStreakPower={p.lossStreakPower||0} showMult />
                  </div>
                </div>
                <div className="lb-card-pts">{isPlaced?p.pts||0:"—"}</div>
              </div>
            );
          });})()}
        </div>
      </div>
    </div>
    {showRecalcConfirm && (
      <ConfirmDialog
        title="Recalculate All Stats?"
        msg="This will replay every game in history and rewrite all player points, MMR, streaks, wins, losses, and the pts shown in match history. This cannot be undone (but you can undo via the undo button after logging games)."
        onConfirm={doRecalc}
        onCancel={()=>setShowRecalcConfirm(false)}
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

  const allGames = [...(state.games ?? [])].sort((a, b) => new Date(b.date) - new Date(a.date));

  const filtered = allGames.filter(g => {
    if (playerFilter) {
      const names = [...g.sideA,...g.sideB].map(id=>pName(id,state.players)).join(" ").toLowerCase();
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
    const day = new Date(g.date).toLocaleDateString("en-GB", { weekday:"short", day:"numeric", month:"short", year:"numeric" });
    if (day !== lastDay) { groups.push({ day, games:[] }); lastDay = day; }
    groups[groups.length-1].games.push(g);
  }

  const hasFilters = playerFilter || dateFrom || dateTo;

  function GameRow({ g }) {
    const sAN = g.sideA.map(id=>pName(id,state.players));
    const sBN = g.sideB.map(id=>pName(id,state.players));
    const winnerSide = g.winner;
    return (
      <div className="game-row" onClick={()=>setSelectedGameId(g.id)}>
        {/* Side A */}
        <div className="g-side">
          {sAN.map((n,i)=>(
            <span key={i} className={winnerSide==="A"?"g-name-w":"g-name-l"}>
              {winnerSide==="A" && <span style={{color:"var(--green)",marginRight:3,fontSize:9}}>▲</span>}{n}
            </span>
          ))}
          <div className="g-delta" style={{display:"flex",flexDirection:"column",gap:1}}>
            {g.sideA.map(id=>{
              const delta = winnerSide==="A"
                ? (g.perPlayerGains?.[id] ?? g.playerDeltas?.[id]?.gain ?? g.ptsGain)
                : (g.perPlayerLosses?.[id] ?? g.playerDeltas?.[id]?.loss ?? g.ptsLoss);
              return <span key={id} className={winnerSide==="A"?"text-g":"text-r"}>{winnerSide==="A"?"+":"−"}{delta} {pName(id,state.players).split(" ")[0]}</span>;
            })}
          </div>
        </div>
        {/* Score */}
        <div style={{textAlign:"center"}}>
          <div className="g-score">{g.scoreA}–{g.scoreB}</div>
          <div className="g-date">{new Date(g.date).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}</div>
          {g.penalties && Object.values(g.penalties).some(v=>(v.yellow||0)+(v.red||0)>0) && (
            <div style={{fontSize:10,marginTop:2}}>
              {Object.values(g.penalties).some(v=>v.red>0)&&<span>🔴</span>}
              {Object.values(g.penalties).some(v=>v.yellow>0)&&<span>🟡</span>}
            </div>
          )}
        </div>
        {/* Side B */}
        <div className="g-side right">
          {sBN.map((n,i)=>(
            <span key={i} className={winnerSide==="B"?"g-name-w":"g-name-l"}>
              {n}{winnerSide==="B" && <span style={{color:"var(--green)",marginLeft:3,fontSize:9}}>▲</span>}
            </span>
          ))}
          <div className="g-delta" style={{display:"flex",flexDirection:"column",gap:1,alignItems:"flex-end"}}>
            {g.sideB.map(id=>{
              const delta = winnerSide==="B"
                ? (g.perPlayerGains?.[id] ?? g.playerDeltas?.[id]?.gain ?? g.ptsGain)
                : (g.perPlayerLosses?.[id] ?? g.playerDeltas?.[id]?.loss ?? g.ptsLoss);
              return <span key={id} className={winnerSide==="B"?"text-g":"text-r"}>{winnerSide==="B"?"+":"−"}{delta} {pName(id,state.players).split(" ")[0]}</span>;
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
            isAdmin={isAdmin} showToast={showToast} onClose={()=>setSelectedGameId(null)}/>
        ) : null;
      })()}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Match History ({allGames.length})</span>
          <div className="fac" style={{gap:6}}>
            {hasFilters && <span className="xs tag tag-a">{filtered.length} shown</span>}
            <button className={`btn btn-sm ${showFilters?"btn-p":"btn-g"}`}
              onClick={()=>setShowFilters(f=>!f)}>⚡ Filter</button>
          </div>
        </div>
        {showFilters && (
          <div style={{padding:"10px 16px",background:"var(--s2)",borderBottom:"1px solid var(--b1)",display:"flex",gap:8,flexWrap:"wrap",alignItems:"flex-end"}}>
            <div style={{flex:"1 1 140px"}}>
              <div className="lbl">Player</div>
              <input className="inp" placeholder="Search player…" value={playerFilter}
                onChange={e=>setPlayerFilter(e.target.value)} style={{fontSize:11,padding:"5px 8px"}}/>
            </div>
            <div style={{flex:"1 1 120px"}}>
              <div className="lbl">From</div>
              <input className="inp" type="date" value={dateFrom}
                onChange={e=>setDateFrom(e.target.value)} style={{fontSize:11,padding:"5px 8px"}}/>
            </div>
            <div style={{flex:"1 1 120px"}}>
              <div className="lbl">To</div>
              <input className="inp" type="date" value={dateTo}
                onChange={e=>setDateTo(e.target.value)} style={{fontSize:11,padding:"5px 8px"}}/>
            </div>
            {hasFilters && (
              <button className="btn btn-d btn-sm" style={{alignSelf:"flex-end"}}
                onClick={()=>{setPlayerFilter("");setDateFrom("");setDateTo("");}}>Clear</button>
            )}
          </div>
        )}
        {groups.length === 0 && <div style={{padding:32,textAlign:"center",color:"var(--dimmer)",fontSize:12}}>No games found</div>}
        {groups.slice(0, visibleDays).map(({ day, games }) => (
          <div key={day}>
            <div style={{padding:"7px 18px",background:"var(--s2)",borderBottom:"1px solid var(--b1)",fontSize:10,letterSpacing:1.5,textTransform:"uppercase",color:"var(--dimmer)",fontWeight:600}}>
              {day} · {games.length} game{games.length!==1?"s":""}
            </div>
            {games.map(g => <GameRow key={g.id} g={g}/>)}
          </div>
        ))}
        {groups.length > visibleDays && (
          <div style={{padding:"12px 18px",textAlign:"center",borderTop:"1px solid var(--b1)"}}>
            <button className="btn btn-g btn-sm" onClick={()=>setVisibleDays(v=>v+5)}>
              Load more — {groups.length - visibleDays} day{groups.length-visibleDays!==1?"s":""} remaining
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
  VIEWER:0,
  REFEREE:1,
  ADMIN:2,
  OWNER:3
};

function can(required,user){
  return (user?.role ?? 0) >= required;
}

// admin audit log
function logAdmin(state,action,details){
  return {
    ...state,
    audit:[
      {
        id:crypto.randomUUID(),
        action,
        details,
        date:new Date().toISOString()
      },
      ...(state.audit||[])
    ]
  };
}

// centralized admin actions
const Admin = {

  addPlayer(state,name){
    const exists = state.players.find(p=>p.name.toLowerCase()===name.toLowerCase());
    if(exists) return {error:"Player already exists"};

    return {
      player:{
        id:crypto.randomUUID(),
        name,
        mmr:CONFIG.STARTING_MMR,
        pts:CONFIG.STARTING_PTS,
        wins:0,
        losses:0,
        streak:0,
        championships:[]
      }
    };
  },

  renamePlayer(state,id,newName){
    const taken = state.players.find(
      p=>p.id!==id && p.name.toLowerCase()===newName.toLowerCase()
    );
    if(taken) return {error:"Name already taken"};

    return {
      players: state.players.map(p=>p.id===id?{...p,name:newName}:p)
    };
  },

  removePlayer(state,id){
    return {
      players: state.players.filter(p=>p.id!==id)
    };
  }

};


// ============================================================
// HELPERS
// ============================================================

function placementsLeft(pid,state){
  const m=getMonthKey();
  const used=state.monthlyPlacements[m]?.[pid]||0;
  return CONFIG.MAX_PLACEMENTS_PER_MONTH-used;
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
      mmr: CONFIG.STARTING_MMR,
      pts: CONFIG.STARTING_PTS,
      wins: 0,
      losses: 0,
      streak: 0,
      championships: []
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
function PtsChart({ pid, games, players }) {
  const W=320, H=90, PAD=10;
  const [hovered, setHovered] = useState(null); // index
  const svgRef = useRef(null);

  const playerGames = [...games]
    .filter(g=>g.sideA.includes(pid)||g.sideB.includes(pid))
    .sort((a,b)=>new Date(a.date)-new Date(b.date));
  if (playerGames.length < 2) return (
    <div style={{height:H,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <span className="xs text-dd">Not enough games</span>
    </div>
  );

  // Build cumulative pts + per-game delta
  let pts = 0;
  const data = playerGames.map(g => {
    const onA = g.sideA.includes(pid);
    const won = (onA&&g.winner==="A")||(!onA&&g.winner==="B");
    const delta = won ? (g.perPlayerGains?.[pid]??g.ptsGain) : -(g.perPlayerLosses?.[pid]??g.ptsLoss);
    pts += delta;
    const oppIds = onA ? g.sideB : g.sideA;
    const opps = oppIds.map(id=>pName(id, players||[])).join(" & ");
    return { pts, delta, won, date: g.date, opps, scoreA: g.scoreA, scoreB: g.scoreB };
  });

  const minP = Math.min(0, ...data.map(d=>d.pts));
  const maxP = Math.max(...data.map(d=>d.pts));
  const range = Math.max(maxP - minP, 1);
  const toX = i => PAD + (i / (data.length-1)) * (W - PAD*2);
  const toY = v => PAD + (1 - (v - minP) / range) * (H - PAD*2);

  const pathD = data.map((d,i)=>`${i===0?"M":"L"}${toX(i).toFixed(1)},${toY(d.pts).toFixed(1)}`).join(" ");
  const fillD = pathD + ` L${toX(data.length-1).toFixed(1)},${H} L${toX(0).toFixed(1)},${H} Z`;
  const lastPts = data[data.length-1].pts;
  const isPos = lastPts >= 0;
  const lineCol = isPos ? "#5ec98a" : "#f07070";

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
    <div style={{position:"relative"}}>
      <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`}
        style={{overflow:"visible",cursor:"crosshair",display:"block"}}
        onMouseMove={handleMouseMove} onMouseLeave={()=>setHovered(null)}>
        <defs>
          <linearGradient id={`cg-${pid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineCol} stopOpacity="0.22"/>
            <stop offset="100%" stopColor={lineCol} stopOpacity="0"/>
          </linearGradient>
        </defs>
        {/* Grid lines */}
        {[0.25,0.5,0.75].map(t=>(
          <line key={t} x1={PAD} y1={PAD+(1-t)*(H-PAD*2)} x2={W-PAD} y2={PAD+(1-t)*(H-PAD*2)}
            stroke="var(--b1)" strokeWidth="1"/>
        ))}
        {minP < 0 && <line x1={PAD} y1={toY(0)} x2={W-PAD} y2={toY(0)} stroke="var(--b2)" strokeWidth="1" strokeDasharray="4,3"/>}
        {/* Fill */}
        <path d={fillD} fill={`url(#cg-${pid})`}/>
        {/* Line */}
        <path d={pathD} fill="none" stroke={lineCol} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        {/* All dots — small */}
        {data.map((d,i)=>(
          <circle key={i} cx={toX(i)} cy={toY(d.pts)} r={hovered===i?4:2}
            fill={d.won?"#5ec98a":"#f07070"}
            stroke={hovered===i?"var(--bg)":"none"} strokeWidth="1.5"
            style={{transition:"r .1s"}}/>
        ))}
        {/* Hover crosshair */}
        {hov && (
          <line x1={toX(hovered)} y1={PAD} x2={toX(hovered)} y2={H-PAD}
            stroke="var(--dimmer)" strokeWidth="1" strokeDasharray="3,2"/>
        )}
      </svg>

      {/* Tooltip */}
      {hov && (() => {
        const x = toX(hovered) / W * 100;
        const flipLeft = x > 65;
        return (
          <div style={{
            position:"absolute", top:0,
            left: flipLeft ? "auto" : `calc(${x}% + 8px)`,
            right: flipLeft ? `calc(${100-x}% + 8px)` : "auto",
            background:"var(--s1)", border:"1px solid var(--b2)",
            borderRadius:8, padding:"6px 10px", fontSize:11,
            pointerEvents:"none", zIndex:10, minWidth:130,
            boxShadow:"0 4px 20px rgba(0,0,0,.5)",
            lineHeight:1.7,
          }}>
            <div style={{fontWeight:700,fontSize:13,color:hov.won?"var(--green)":"var(--red)",marginBottom:2}}>
              {hov.won?"▲":"▼"} {hov.pts} pts
            </div>
            <div style={{color:hov.won?"var(--green)":"var(--red)"}}>
              {hov.delta>=0?"+":""}{hov.delta} this game
            </div>
            <div className="text-dd">{hov.scoreA}–{hov.scoreB} vs {hov.opps}</div>
            <div className="text-dd" style={{fontSize:10,marginTop:2}}>
              {new Date(hov.date).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}
            </div>
          </div>
        );
      })()}

      {/* Axis labels */}
      <div style={{display:"flex",justifyContent:"space-between",marginTop:3,padding:`0 ${PAD}px`}}>
        <span className="xs text-dd">{new Date(playerGames[0].date).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</span>
        <span className="xs text-dd">{lastPts} pts</span>
        <span className="xs text-dd">{new Date(playerGames[playerGames.length-1].date).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</span>
      </div>
    </div>
  );
}

// Win rate donut
function WinDonut({ wins, losses }) {
  const total = wins + losses;
  if (!total) return <div style={{width:64,height:64,display:"flex",alignItems:"center",justifyContent:"center"}}><span className="xs text-dd">—</span></div>;
  const pct = wins/total;
  const R=28, CX=32, CY=32, CIRC=2*Math.PI*R;
  const dash = pct * CIRC;
  return (
    <svg width="64" height="64" viewBox="0 0 64 64">
      <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--b2)" strokeWidth="6"/>
      <circle cx={CX} cy={CY} r={R} fill="none" stroke="#5ec98a" strokeWidth="6"
        strokeDasharray={`${dash} ${CIRC}`} strokeDashoffset={CIRC/4}
        strokeLinecap="round" style={{transition:"stroke-dasharray .6s ease"}}/>
      <text x={CX} y={CY+1} textAnchor="middle" dominantBaseline="middle"
        fill="var(--text)" fontSize="11" fontWeight="700" fontFamily="var(--disp)">
        {Math.round(pct*100)}%
      </text>
    </svg>
  );
}

function StatsView({ state, onSelectPlayer }) {
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");

  const sorted = [...state.players].sort((a,b)=>(b.pts||0)-(a.pts||0));
  const selected = state.players.find(p=>p.id===selectedId);

  function getH2H(pidA, pidB) {
    const shared = state.games.filter(g =>
      (g.sideA.includes(pidA)||g.sideB.includes(pidA)) &&
      (g.sideA.includes(pidB)||g.sideB.includes(pidB))
    );
    let winsA=0, winsB=0;
    for (const g of shared) {
      const aOnA = g.sideA.includes(pidA);
      const won = (aOnA&&g.winner==="A")||(!aOnA&&g.winner==="B");
      if (won) winsA++; else winsB++;
    }
    return { games: shared.length, winsA, winsB };
  }

  function getStats(p) {
    const playerGames = [...state.games]
      .filter(g=>g.sideA.includes(p.id)||g.sideB.includes(p.id))
      .sort((a,b)=>new Date(a.date)-new Date(b.date));
    const wins = playerGames.filter(g=>{const onA=g.sideA.includes(p.id);return(onA&&g.winner==="A")||(!onA&&g.winner==="B");});
    const losses = playerGames.filter(g=>{const onA=g.sideA.includes(p.id);return(onA&&g.winner==="B")||(!onA&&g.winner==="A");});
    const avgGain = wins.length ? Math.round(wins.reduce((s,g)=>s+(g.perPlayerGains?.[p.id]??g.ptsGain),0)/wins.length) : 0;
    const avgLoss = losses.length ? Math.round(losses.reduce((s,g)=>s+(g.perPlayerLosses?.[p.id]??g.ptsLoss),0)/losses.length) : 0;
    const biggestMargin = wins.reduce((best,g)=>Math.max(best,Math.abs(g.scoreA-g.scoreB)),0);
    const longestStreak = (() => {
      let best=0, cur=0;
      playerGames.forEach(g=>{
        const onA=g.sideA.includes(p.id);
        const won=(onA&&g.winner==="A")||(!onA&&g.winner==="B");
        cur = won ? cur+1 : 0;
        best = Math.max(best,cur);
      });
      return best;
    })();
    return { avgGain, avgLoss, biggestMargin, longestStreak, totalGames: playerGames.length, wins: wins.length, losses: losses.length };
  }

  return (
    <div className="stack page-fade">
      <div className="grid-2" style={{alignItems:"start"}}>
        {/* Player selector */}
        <div className="card">
          <div className="card-header"><span className="card-title">Player Stats</span></div>
          <div style={{padding:14}}>
            <input className="inp" placeholder="Search…" value={search}
              onChange={e=>setSearch(e.target.value)} style={{marginBottom:10,fontSize:12}}/>
            <div style={{display:"flex",flexDirection:"column",gap:3,maxHeight:260,overflowY:"auto"}}>
              {sorted.filter(p=>!search||p.name.toLowerCase().includes(search.toLowerCase())).map(p=>(
                <div key={p.id} className={`player-chip ${selectedId===p.id?"sel-a":""}`}
                  onClick={()=>setSelectedId(p.id)}>
                  <span style={{fontWeight:600}}>{p.name}</span>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <Sparkline pid={p.id} games={state.games}/>
                    <span className="xs text-dd">{p.pts||0}pts</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Stats panel */}
        {selected ? (() => {
          const st = getStats(selected);
          const rank = sorted.findIndex(p=>p.id===selected.id)+1;
          return (
            <div className="card">
              <div className="card-header">
                <div style={{display:"flex",flexDirection:"column",gap:1}}>
                  <span className="card-title">{selected.name}</span>
                  <span className="xs text-dd">Rank #{rank} · {st.totalGames} games played</span>
                </div>
                <button className="btn btn-g btn-sm" onClick={()=>onSelectPlayer(selected)}>Profile</button>
              </div>
              <div style={{padding:16,display:"flex",flexDirection:"column",gap:14}}>

                {/* Points chart */}
                <div>
                  <div className="xs text-dd" style={{marginBottom:6,letterSpacing:.5,textTransform:"uppercase",fontWeight:600}}>Points over time</div>
                  <div style={{background:"var(--s2)",borderRadius:8,padding:"10px 12px"}}>
                    <PtsChart pid={selected.id} games={state.games} players={state.players}/>
                  </div>
                </div>

                {/* Stats row */}
                <div style={{display:"grid",gridTemplateColumns:"64px 1fr 1fr 1fr",gap:10,alignItems:"center"}}>
                  <WinDonut wins={st.wins} losses={st.losses}/>
                  <div className="stat-box" style={{padding:"8px 12px"}}>
                    <div className="stat-lbl">Avg gain</div>
                    <div className="stat-val am" style={{fontSize:20}}>+{st.avgGain}</div>
                  </div>
                  <div className="stat-box" style={{padding:"8px 12px"}}>
                    <div className="stat-lbl">Avg loss</div>
                    <div className="stat-val" style={{fontSize:20,color:"var(--red)"}}>−{st.avgLoss}</div>
                  </div>
                  <div className="stat-box" style={{padding:"8px 12px"}}>
                    <div className="stat-lbl">Best streak</div>
                    <div className="stat-val" style={{fontSize:20}}>▲{st.longestStreak}</div>
                  </div>
                </div>

                {/* H2H */}
                <div>
                  <div className="sec" style={{marginBottom:6}}>Head to Head</div>
                  <div style={{display:"flex",flexDirection:"column",gap:4,maxHeight:160,overflowY:"auto"}}>
                    {sorted.filter(p=>p.id!==selected.id).map(p=>{
                      const h = getH2H(selected.id, p.id);
                      if (!h.games) return null;
                      const pct = Math.round(h.winsA/h.games*100);
                      return (
                        <div key={p.id} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",borderRadius:8,background:"var(--s2)",border:"1px solid var(--b1)"}}>
                          <span style={{flex:1,fontWeight:600,fontSize:13}}>{p.name}</span>
                          {/* Mini win bar */}
                          <div style={{width:60,height:5,borderRadius:3,background:"var(--b2)",overflow:"hidden"}}>
                            <div style={{width:`${pct}%`,height:"100%",background:"var(--green)",borderRadius:3,transition:"width .4s ease"}}/>
                          </div>
                          <span className="text-g bold" style={{fontSize:12,minWidth:20}}>{h.winsA}W</span>
                          <span className="text-dd xs">–</span>
                          <span className="text-r bold" style={{fontSize:12,minWidth:20}}>{h.winsB}L</span>
                        </div>
                      );
                    }).filter(Boolean)}
                    {!sorted.filter(p=>p.id!==selected.id).some(p=>getH2H(selected.id,p.id).games>0) && (
                      <div className="xs text-dd" style={{padding:"8px 0"}}>No H2H data yet</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })() : (
          <div className="card" style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:240}}>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:28,marginBottom:8}}>📊</div>
              <span className="text-dd" style={{fontSize:13}}>Select a player to view stats</span>
            </div>
          </div>
        )}
      </div>

      <TeamBalancer players={state.players}/>
    </div>
  );
}

// ============================================================
// TEAM BALANCER
// ============================================================
function TeamBalancer({ players }) {
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState("");

  const sorted = [...players].sort((a,b)=>(b.mmr||0)-(a.mmr||0));
  const visible = sorted.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()));

  function toggle(id) {
    setSelected(s => s.includes(id) ? s.filter(x=>x!==id) : s.length < 4 ? [...s, id] : s);
  }

  // Generate all 3 possible 2v2 splits from 4 players
  function getBalancings(pids) {
    const [a,b,c,d] = pids;
    const splits = [
      [[a,b],[c,d]],
      [[a,c],[b,d]],
      [[a,d],[b,c]],
    ];
    return splits.map(([t1,t2]) => {
      const mmr1 = t1.reduce((s,id)=>s+(players.find(p=>p.id===id)?.mmr||1000),0)/2;
      const mmr2 = t2.reduce((s,id)=>s+(players.find(p=>p.id===id)?.mmr||1000),0)/2;
      const diff = Math.abs(mmr1-mmr2);
      const total = mmr1+mmr2;
      const balance = Math.round((1 - diff/Math.max(total/2,1)) * 100);
      return { t1, t2, mmr1: Math.round(mmr1), mmr2: Math.round(mmr2), diff: Math.round(diff), balance };
    }).sort((a,b)=>a.diff-b.diff);
  }

  const matchups = selected.length === 4 ? getBalancings(selected) : null;
  const best = matchups?.[0];

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">⚖ Team Balancer</span>
        {selected.length > 0 && (
          <button className="btn btn-g btn-sm" onClick={()=>setSelected([])}>Clear</button>
        )}
      </div>
      <div style={{padding:14}}>
        <div className="xs text-dd" style={{marginBottom:10,lineHeight:1.6}}>
          Select 4 players to see all possible fair matchups ranked by MMR balance.
        </div>
        <div className="lbl">{selected.length}/4 players selected</div>
        {selected.length > 0 && (
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
            {selected.map(id=>{
              const p = players.find(x=>x.id===id);
              return <span key={id} className="tag tag-a" style={{cursor:"pointer",fontSize:11,padding:"3px 8px"}}
                onClick={()=>toggle(id)}>{p?.name} ×</span>;
            })}
          </div>
        )}
        <input className="inp" placeholder="Search players…" value={search}
          onChange={e=>setSearch(e.target.value)} style={{marginBottom:8,fontSize:12}}/>
        <div style={{display:"flex",flexDirection:"column",gap:3,maxHeight:160,overflowY:"auto",marginBottom:14}}>
          {visible.map(p=>{
            const sel = selected.includes(p.id);
            const full = !sel && selected.length >= 4;
            return (
              <div key={p.id} className={`player-chip ${sel?"sel-a":""} ${full?"disabled":""}`}
                onClick={()=>!full&&toggle(p.id)}>
                <span>{p.name}</span>
                <span className="xs text-dd">{p.mmr||1000} MMR · {p.pts||0}pts</span>
              </div>
            );
          })}
        </div>

        {matchups && (
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <div className="sec">Suggested matchups</div>
            {matchups.map(({t1,t2,mmr1,mmr2,diff,balance},i)=>(
              <div key={i} style={{
                background: i===0?"rgba(94,201,138,.06)":"var(--s2)",
                border: `1px solid ${i===0?"var(--amber-d)":"var(--b2)"}`,
                borderRadius:6, padding:"10px 14px"
              }}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <span className="xs text-dd">Option {i+1}</span>
                  <span className={`tag ${i===0?"tag-w":"tag-a"}`}>{balance}% balanced</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:10,alignItems:"center"}}>
                  <div>
                    {t1.map(id=><div key={id} className="bold" style={{fontSize:12}}>{players.find(p=>p.id===id)?.name}</div>)}
                    <div className="xs text-dd" style={{marginTop:2}}>{mmr1} avg MMR</div>
                  </div>
                  <div style={{textAlign:"center",color:"var(--dimmer)",fontSize:11,fontWeight:700}}>
                    VS<br/><span style={{fontSize:10,color:diff<30?"var(--green)":diff<80?"var(--orange)":"var(--red)"}}>Δ{diff}</span>
                  </div>
                  <div style={{textAlign:"right"}}>
                    {t2.map(id=><div key={id} className="bold" style={{fontSize:12}}>{players.find(p=>p.id===id)?.name}</div>)}
                    <div className="xs text-dd" style={{marginTop:2}}>{mmr2} avg MMR</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {selected.length > 0 && selected.length < 4 && (
          <div className="msg msg-w" style={{marginTop:8}}>Select {4-selected.length} more player{4-selected.length!==1?"s":""}</div>
        )}
      </div>
    </div>
  );
}

const EMPTY_ROW = () => ({ id: crypto.randomUUID(), sideA: [], sideB: [], scoreA: "", scoreB: "", searchA: "", searchB: "", penalties: {} });

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
      const cur = row.penalties?.[pid] || { yellow:0, red:0 };
      const newVal = Math.max(0, (cur[type]||0) + delta);
      return { ...row, penalties: { ...row.penalties, [pid]: { ...cur, [type]: newVal } } };
    }));
  }

  function togglePlayer(rowId, side, pid) {
    setRows(r =>
      r.map(row => {
        if (row.id !== rowId) return row;
        const key = side === "A" ? "sideA" : "sideB";
        const searchKey = side === "A" ? "searchA" : "searchB";
        const other = side === "A" ? "sideB" : "sideA";
        const otherFiltered = row[other].filter(id => id !== pid);

        if (row[key].includes(pid)) return { ...row, [key]: row[key].filter(id => id !== pid) };
        if (row[key].length >= 2) return row;
        // Auto-clear search after selecting
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
    }

    setErrors(newErrors);
    if (Object.keys(newErrors).length) { showToast("Fix errors first", "error"); return; }

    // Duplicate game check
    if (!skipDuplicateCheck) {
      const today = new Date().toISOString();
      const duplicates = rows.filter(row => {
        const sA = parseInt(row.scoreA,10), sB = parseInt(row.scoreB,10);
        return isDuplicateGame({ sideA:row.sideA, sideB:row.sideB, scoreA:sA, scoreB:sB, date:today }, state.games);
      });
      if (duplicates.length > 0) {
        const names = duplicates.map(r =>
          [...r.sideA,...r.sideB].map(id=>pName(id,state.players)).join(', ')
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

    let newPlayers = [...state.players];
    const newGames = [];
    const newPlacements = { ...state.monthlyPlacements, [monthKey]: { ...(state.monthlyPlacements?.[monthKey] || {}) } };

    for (const row of rows) {
      const sA = parseInt(row.scoreA, 10), sB = parseInt(row.scoreB, 10);
      const winner = sA > sB ? "A" : "B";
      const winnerIds = winner === "A" ? row.sideA : row.sideB;
      const loserIds = winner === "A" ? row.sideB : row.sideA;
      const winnerScore = Math.max(sA, sB), loserScore = Math.min(sA, sB);

      // Rank positions before this game
      const currentRanked = [...newPlayers].sort((a,b)=>(b.pts||0)-(a.pts||0));
      const rankOf = id => currentRanked.findIndex(p=>p.id===id);
      const avgRank = ids => ids.reduce((s,id)=>s+rankOf(id),0)/ids.length;

      // Per-player deltas
      const oppWinMMR  = avg(winnerIds, newPlayers, "mmr");
      const oppLosMMR  = avg(loserIds,  newPlayers, "mmr");
      const oppWinRank = avgRank(winnerIds);
      const oppLosRank = avgRank(loserIds);
      const allPids = [...winnerIds, ...loserIds];
      const playerDeltas = {};
      allPids.forEach(pid => {
        const p = newPlayers.find(x=>x.id===pid);
        if (!p) return;
        const isWin = winnerIds.includes(pid);
        playerDeltas[pid] = calcPlayerDelta({
          winnerScore, loserScore,
          playerMMR:         p.mmr,
          playerRank:        rankOf(pid),
          playerStreakPower: p.streakPower || 0,
          oppAvgMMR:    isWin ? oppLosMMR  : oppWinMMR,
          oppAvgRank:   isWin ? oppLosRank : oppWinRank,
          isWinner: isWin,
        });
      });

      const placementsBefore = { ...newPlacements[monthKey] };

      newPlayers = newPlayers.map(p => {
        const isWinner = winnerIds.includes(p.id);
        const isLoser  = loserIds.includes(p.id);
        if (!isWinner && !isLoser) return p;
        const d = playerDeltas[p.id];
        const placedBefore = (placementsBefore[p.id] || 0) >= CONFIG.MAX_PLACEMENTS_PER_MONTH;
        if (isWinner) {
          const ns = (p.streak||0) >= 0 ? (p.streak||0)+1 : 1;
          const newPts = placedBefore ? (p.pts||0)+d.gain : (p.pts||0);
          const newPower = updateStreakPower(p.streakPower||0, true, d.qualityScore||1);
          return { ...p, mmr: p.mmr+d.gain, pts: newPts, wins: p.wins+1, streak: ns, streakPower: newPower };
        }
        const ns = (p.streak||0) <= 0 ? (p.streak||0)-1 : -1;
        const newPts = placedBefore ? Math.max(0,(p.pts||0)-d.loss) : (p.pts||0);
        return { ...p, mmr: Math.max(0,p.mmr-d.loss), pts: newPts, losses: p.losses+1, streak: ns, streakPower: 0 };
      });

      // Placements + calibration
      allPids.forEach(pid => {
        const before = placementsBefore[pid] || 0;
        newPlacements[monthKey][pid] = before + 1;
        if (before + 1 === CONFIG.MAX_PLACEMENTS_PER_MONTH) {
          const thisPlayer = newPlayers.find(p => p.id === pid);
          if (thisPlayer) {
            const placed = newPlayers.filter(p => p.id!==pid && (newPlacements[monthKey][p.id]||0) >= CONFIG.MAX_PLACEMENTS_PER_MONTH);
            const byMmr = [...placed].sort((a,b)=>(b.mmr||0)-(a.mmr||0));
            const ins = byMmr.findIndex(p=>(p.mmr||0)<(thisPlayer.mmr||0));
            const rk = ins===-1 ? byMmr.length : ins;
            let cal;
            if (!byMmr.length) cal = Math.round((thisPlayer.mmr-CONFIG.STARTING_MMR)*0.5);
            else if (rk===0) cal = Math.round((byMmr[0].pts||0)*1.1+5);
            else if (rk>=byMmr.length) cal = Math.max(0,Math.round((byMmr[byMmr.length-1].pts||0)*0.9-5));
            else cal = Math.round(((byMmr[rk-1].pts||0)+(byMmr[rk].pts||0))/2);
            newPlayers = newPlayers.map(p => p.id===pid ? {...p, pts: Math.max(0,cal)} : p);
          }
        }
      });

      // Flat per-player maps — survive slimState, enable individual history display
      const perPlayerGains  = {};
      const perPlayerLosses = {};
      winnerIds.forEach(id => { if (playerDeltas[id]) perPlayerGains[id]  = playerDeltas[id].gain; });
      loserIds.forEach(id  => { if (playerDeltas[id]) perPlayerLosses[id] = playerDeltas[id].loss; });

      const avgGain = Math.round(winnerIds.reduce((s,id)=>s+(playerDeltas[id]?.gain||0),0)/Math.max(winnerIds.length,1));
      const avgLoss = Math.round(loserIds.reduce((s,id)=>s+(playerDeltas[id]?.loss||0),0)/Math.max(loserIds.length,1));

      // Only include penalties if any were set
      const gamePenalties = Object.keys(row.penalties||{}).length > 0 ? row.penalties : undefined;

      newGames.push({
        id: crypto.randomUUID(), sideA: row.sideA, sideB: row.sideB,
        winner, scoreA: sA, scoreB: sB,
        ptsGain: avgGain, ptsLoss: avgLoss, mmrGain: avgGain, mmrLoss: avgLoss,
        perPlayerGains, perPlayerLosses,
        ...(gamePenalties ? { penalties: gamePenalties } : {}),
        date: new Date().toISOString(), monthKey
      });
    }

    setState(s => ({ ...s, players: newPlayers, games: [...newGames, ...s.games], monthlyPlacements: newPlacements }));
    setRows([EMPTY_ROW()]);
    setLastLogged({ games: newGames, players: newPlayers, timestamp: new Date() });
    showToast(`${newGames.length} game${newGames.length > 1 ? "s" : ""} logged`, "success");

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
        <div className="card" style={{borderColor:"var(--amber-d)"}}>
          <div className="card-header" style={{background:"var(--amber-g)"}}>
            <span className="card-title">✓ Just Logged</span>
            <button className="btn btn-g btn-sm" onClick={()=>setLastLogged(null)}>Dismiss</button>
          </div>
          <div style={{padding:"10px 16px",display:"flex",flexDirection:"column",gap:8}}>
            {lastLogged.games.map(g => {
              const wIds = g.winner==="A"?g.sideA:g.sideB;
              const lIds = g.winner==="A"?g.sideB:g.sideA;
              return (
                <div key={g.id} style={{display:"flex",alignItems:"center",gap:10,fontSize:13}}>
                  <span className="text-g bold">{wIds.map(id=>pName(id,lastLogged.players)).join(" & ")}</span>
                  <span className="disp text-am" style={{fontSize:18}}>{g.scoreA}–{g.scoreB}</span>
                  <span className="text-dd">{lIds.map(id=>pName(id,lastLogged.players)).join(" & ")}</span>
                  <span className="xs text-dd" style={{marginLeft:"auto"}}>
                    {wIds.map(id=><span key={id} className="text-g" style={{marginRight:6}}>+{g.perPlayerGains?.[id]??g.ptsGain} {pName(id,lastLogged.players).split(" ")[0]}</span>)}
                    {lIds.map(id=><span key={id} className="text-r" style={{marginRight:6}}>−{g.perPlayerLosses?.[id]??g.ptsLoss} {pName(id,lastLogged.players).split(" ")[0]}</span>)}
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
              const currentRanked = [...state.players].sort((a,b)=>(b.pts||0)-(a.pts||0));
              const rankOf = id => { const i = currentRanked.findIndex(p=>p.id===id); return i===-1?currentRanked.length:i; };
              const oppWinMMR = avg(wIds, state.players, "mmr"), oppLosMMR = avg(lIds, state.players, "mmr");
              const oppWinRank = wIds.reduce((s,id)=>s+rankOf(id),0)/wIds.length;
              const oppLosRank = lIds.reduce((s,id)=>s+rankOf(id),0)/lIds.length;
              const perPlayer = {};
              [...wIds,...lIds].forEach(pid => {
                const p = state.players.find(x=>x.id===pid); if(!p) return;
                const isW = wIds.includes(pid);
                perPlayer[pid] = calcPlayerDelta({
                  winnerScore: Math.max(sA,sB), loserScore: Math.min(sA,sB),
                  playerMMR: p.mmr, playerRank: rankOf(pid), playerStreakPower: p.streakPower||0,
                  oppAvgMMR: isW ? oppLosMMR : oppWinMMR,
                  oppAvgRank: isW ? oppLosRank : oppWinRank,
                  isWinner: isW,
                });
              });
              prev = { perPlayer, wIds, lIds };
            }

            return (
              <div key={row.id} style={{ marginBottom: 10, padding: 12, background: "var(--s2)", borderRadius: 6, border: "1px solid var(--b1)" }}>
                <div className="fbc mb8">
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span className="xs text-dd">Game {ri + 1}</span>
                    {(() => {
                      const sA = parseInt(row.scoreA,10), sB = parseInt(row.scoreB,10);
                      const playersOk = row.sideA.length===2 && row.sideB.length===2;
                      const scoresOk = !isNaN(sA) && !isNaN(sB) && sA>=0 && sB>=0 && sA!==sB;
                      const dupCheck = playersOk && scoresOk;
                      if (!playersOk) return <span className="xs" style={{color:"var(--orange)"}}>● {4 - row.sideA.length - row.sideB.length} player{4-row.sideA.length-row.sideB.length!==1?"s":""} needed</span>;
                      if (!scoresOk) return <span className="xs" style={{color:"var(--orange)"}}>● enter scores</span>;
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
                      <div style={{ display:"flex", gap:4, flexWrap:"wrap", marginBottom:5 }}>
                        {row.sideA.map(id => (
                          <span key={id} className="tag tag-w" style={{cursor:"pointer",fontSize:11}}
                            onClick={() => togglePlayer(row.id,"A",id)}>
                            {pName(id,state.players)} ×
                          </span>
                        ))}
                      </div>
                    )}
                    <input
                      className="inp" placeholder="Search…" value={row.searchA}
                      onChange={e => setRows(r => r.map(x => x.id===row.id ? {...x, searchA: e.target.value} : x))}
                      style={{marginBottom:4,fontSize:11,padding:"4px 7px"}}
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight:160, overflowY:"auto" }}>
                      {[...state.players]
                        .sort((a, b) => (b.pts || 0) - (a.pts || 0))
                        .filter(p => !row.searchA || p.name.toLowerCase().includes(row.searchA.toLowerCase()))
                        .map(p => {
                          const onA = row.sideA.includes(p.id), onB = row.sideB.includes(p.id), full = !onA && row.sideA.length >= 2;
                          if (onA) return null; // already shown above as tag
                          return (
                            <div key={p.id} className={`player-chip ${onB || full ? "disabled" : ""}`}
                              onClick={() => !onB && !full ? togglePlayer(row.id, "A", p.id) : null}>
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
                      <div className="lbl" style={{fontSize:9,lineHeight:1.3,color:"var(--green)",minHeight:22}}>
                        {row.sideA.map(id=>pName(id,state.players)).join(" & ") || "A"}
                      </div>
                      <input className="inp" type="number" min="0" placeholder="10" value={row.scoreA}
                        onChange={e => setRows(r => r.map(x => x.id === row.id ? { ...x, scoreA: e.target.value } : x))}
                        style={{ textAlign: "center", fontSize: 18, fontFamily: "var(--disp)", fontWeight: 800 }} />
                    </div>
                    <div>
                      <div className="lbl" style={{fontSize:9,lineHeight:1.3,color:"var(--blue)",minHeight:22}}>
                        {row.sideB.map(id=>pName(id,state.players)).join(" & ") || "B"}
                      </div>
                      <input className="inp" type="number" min="0" placeholder="7" value={row.scoreB}
                        onChange={e => setRows(r => r.map(x => x.id === row.id ? { ...x, scoreB: e.target.value } : x))}
                        style={{ textAlign: "center", fontSize: 18, fontFamily: "var(--disp)", fontWeight: 800 }} />
                    </div>

                    {prev && (
                      <div style={{ background: "var(--s1)", borderRadius: 4, padding: "6px 8px", fontSize: 10, lineHeight: 1.8 }}>
                        {prev.wIds.map(id => {
                          const d = prev.perPlayer[id];
                          const n = state.players.find(p=>p.id===id)?.name?.split(" ")[0]||"?";
                          return <div key={id} className="text-g">+{d?.gain??0} {n}</div>;
                        })}
                        {prev.lIds.map(id => {
                          const d = prev.perPlayer[id];
                          const n = state.players.find(p=>p.id===id)?.name?.split(" ")[0]||"?";
                          return <div key={id} className="text-r">-{d?.loss??0} {n}</div>;
                        })}
                      </div>
                    )}
                  </div>

                  {/* Side B */}
                  <div>
                    <div className="lbl" style={{ color: "var(--blue)" }}>Side B {row.sideB.length}/2</div>
                    {row.sideB.length > 0 && (
                      <div style={{ display:"flex", gap:4, flexWrap:"wrap", marginBottom:5 }}>
                        {row.sideB.map(id => (
                          <span key={id} className="tag tag-b" style={{cursor:"pointer",fontSize:11}}
                            onClick={() => togglePlayer(row.id,"B",id)}>
                            {pName(id,state.players)} ×
                          </span>
                        ))}
                      </div>
                    )}
                    <input
                      className="inp" placeholder="Search…" value={row.searchB}
                      onChange={e => setRows(r => r.map(x => x.id===row.id ? {...x, searchB: e.target.value} : x))}
                      style={{marginBottom:4,fontSize:11,padding:"4px 7px"}}
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight:160, overflowY:"auto" }}>
                      {[...state.players]
                        .sort((a, b) => (b.pts || 0) - (a.pts || 0))
                        .filter(p => !row.searchB || p.name.toLowerCase().includes(row.searchB.toLowerCase()))
                        .map(p => {
                          const onA = row.sideA.includes(p.id), onB = row.sideB.includes(p.id), full = !onB && row.sideB.length >= 2;
                          if (onB) return null;
                          return (
                            <div key={p.id} className={`player-chip ${onA || full ? "disabled" : ""}`}
                              onClick={() => !onA && !full ? togglePlayer(row.id, "B", p.id) : null}>
                              <span>{p.name}</span>
                              <span className="xs text-dd">{p.pts || 0}pts</span>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                </div>

                {errors[row.id] && (
                  <div className="msg msg-e mt8" style={{fontWeight:600,fontSize:12}}>
                    ⚠ {errors[row.id]}
                  </div>
                )}

                {/* Penalty cards — shown when all 4 players selected */}
                {row.sideA.length===2 && row.sideB.length===2 && (
                  <div style={{marginTop:8,borderTop:"1px solid var(--b1)",paddingTop:8}}>
                    <div className="xs text-dd" style={{marginBottom:6,fontWeight:600,letterSpacing:.5}}>
                      DISCIPLINARY CARDS <span style={{opacity:.6}}>(optional)</span>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:4}}>
                      {[...row.sideA,...row.sideB].map(pid => {
                        const pen = row.penalties?.[pid] || { yellow:0, red:0 };
                        const total = (pen.yellow||0)*CONFIG.YELLOW_CARD_PTS + (pen.red||0)*CONFIG.RED_CARD_PTS;
                        if (pen.yellow===0 && pen.red===0 && total===0) {
                          // Compact row — just show quick-add buttons
                          return (
                            <div key={pid} style={{display:"flex",alignItems:"center",gap:8,fontSize:12}}>
                              <span style={{flex:1,fontWeight:500}}>{pName(pid,state.players)}</span>
                              <button className="btn btn-g btn-sm" style={{fontSize:10,padding:"2px 8px"}}
                                onClick={()=>setRowPenalty(row.id,pid,"yellow",1)}>🟡+</button>
                              <button className="btn btn-g btn-sm" style={{fontSize:10,padding:"2px 8px"}}
                                onClick={()=>setRowPenalty(row.id,pid,"red",1)}>🔴+</button>
                            </div>
                          );
                        }
                        return (
                          <div key={pid} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 8px",background:"var(--s1)",borderRadius:6,border:"1px solid var(--b1)",fontSize:12}}>
                            <span style={{flex:1,fontWeight:600}}>{pName(pid,state.players)}</span>
                            <div className="fac" style={{gap:3}}>
                              <span>🟡</span>
                              <button className="btn btn-g btn-sm" style={{padding:"1px 6px"}} onClick={()=>setRowPenalty(row.id,pid,"yellow",-1)}>−</button>
                              <span style={{minWidth:14,textAlign:"center",fontWeight:700}}>{pen.yellow||0}</span>
                              <button className="btn btn-g btn-sm" style={{padding:"1px 6px"}} onClick={()=>setRowPenalty(row.id,pid,"yellow",1)}>+</button>
                            </div>
                            <div className="fac" style={{gap:3}}>
                              <span>🔴</span>
                              <button className="btn btn-g btn-sm" style={{padding:"1px 6px"}} onClick={()=>setRowPenalty(row.id,pid,"red",-1)}>−</button>
                              <span style={{minWidth:14,textAlign:"center",fontWeight:700}}>{pen.red||0}</span>
                              <button className="btn btn-g btn-sm" style={{padding:"1px 6px"}} onClick={()=>setRowPenalty(row.id,pid,"red",1)}>+</button>
                            </div>
                            <span style={{color:"var(--orange)",fontWeight:700,minWidth:44,textAlign:"right"}}>−{total}pts</span>
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
                const sA = parseInt(row.scoreA,10), sB = parseInt(row.scoreB,10);
                return row.sideA.length===2 && row.sideB.length===2 && !isNaN(sA) && !isNaN(sB) && sA>=0 && sB>=0 && sA!==sB;
              }).length;
              return (
                <button className="btn btn-p" onClick={submitAll} disabled={readyCount===0}
                  style={{opacity:readyCount===0?0.4:1}}>
                  Submit {readyCount}/{rows.length} Game{rows.length!==1?"s":""}
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
    {confirm && <ConfirmDialog {...confirm} onCancel={()=>setConfirm(null)}/>}
    </>
  );
}
// ============================================================
// FINALS DATE EDITOR (top-level so hooks are stable across re-renders)
// ============================================================
function FinalsDateEditor({ finalsDate, setState, showToast, isAdmin }) {
  const [editing, setEditing] = useState(false);

  const parsed = finalsDate ? new Date(finalsDate) : null;
  const [dd,   setDd]   = useState(parsed ? String(parsed.getDate()).padStart(2,"0")        : "");
  const [mm,   setMm]   = useState(parsed ? String(parsed.getMonth()+1).padStart(2,"0")     : "");
  const [yyyy, setYyyy] = useState(parsed ? String(parsed.getFullYear())                    : "");
  const [hh,   setHh]   = useState(parsed ? String(parsed.getHours()).padStart(2,"0")       : "18");
  const [mn,   setMn]   = useState(parsed ? String(parsed.getMinutes()).padStart(2,"0")     : "00");

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
    setDd(String(p.getDate()).padStart(2,"0"));
    setMm(String(p.getMonth()+1).padStart(2,"0"));
    setYyyy(String(p.getFullYear()));
    setHh(String(p.getHours()).padStart(2,"0"));
    setMn(String(p.getMinutes()).padStart(2,"0"));
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
      parseInt(yyyy), parseInt(mm)-1, parseInt(dd),
      parseInt(hh)||0, parseInt(mn)||0
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
    ["Day",  "DD",   dd,   setDd,   60, 1,    31  ],
    ["Month","MM",   mm,   setMm,   60, 1,    12  ],
    ["Year", "YYYY", yyyy, setYyyy, 80, 2026, 2099],
    ["Hour", "HH",   hh,   setHh,   60, 0,    23  ],
    ["Min",  "MM",   mn,   setMn,   60, 0,    59  ],
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
      days:  Math.floor(diff / 864e5),
      hours: Math.floor((diff / 36e5) % 24),
      mins:  Math.floor((diff / 6e4) % 60),
      secs:  Math.floor((diff / 1e3) % 60),
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
    const [p0,p1,p2,p3] = pool;
    const roles = pos => { const s=new Set(); [].concat(pos||[]).forEach(p=>{if(p==="attack")s.add("atk");if(p==="defense")s.add("def");if(p==="both"||p==="flex"){s.add("atk");s.add("def");}}); return s; };
    const posScore = (a,b) => { const ra=roles(a.position),rb=roles(b.position); if(!ra.size&&!rb.size)return 1; if(!ra.size||!rb.size)return 1; return(ra.has("atk")||rb.has("atk"))&&(ra.has("def")||rb.has("def"))?2:0; };
    const splits = [{a:[p0,p1],b:[p2,p3]},{a:[p0,p2],b:[p1,p3]},{a:[p0,p3],b:[p1,p2]}];
    const score = ({a,b}) => [posScore(a[0],a[1])+posScore(b[0],b[1]), -Math.abs(((a[0].mmr||1000)+(a[1].mmr||1000))/2-((b[0].mmr||1000)+(b[1].mmr||1000))/2)];
    const best = splits.reduce((acc,s)=>{ const[ap,am]=score(acc),[bp,bm]=score(s); return bp>ap||(bp===ap&&bm>am)?s:acc; });
    return { teamA:[best.a[0].id,best.a[1].id], teamB:[best.b[0].id,best.b[1].id] };
  }

  // Only placed players can be in the bracket
  const placedRanked = ranked.filter(p=>(state.monthlyPlacements[monthKey]||{})[p.id]>=CONFIG.MAX_PLACEMENTS_PER_MONTH);
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

  // ── BRACKET MATCH COMPONENT ───────────────────────────────
  function BMatch({ matchKey, label, overrideSideA, overrideSideB, preview }) {
    const [sA, setSA] = useState("");
    const [sBv, setSBv] = useState("");

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
    // sideB can be null for upper-only finals — show pending
    const sideBReady = m.sideB && m.sideB.length > 0;

    const pA = m.sideA.map(id => {
      const pl = state.players.find(p => p.id === id);
      return pl ? { name: pl.name, pos: pl.position } : { name: "?", pos: null };
    });
    const pB = (m.sideB || []).map(id => {
      const pl = state.players.find(p => p.id === id);
      return pl ? { name: pl.name, pos: pl.position } : { name: "?", pos: null };
    });
    const done = !!m.winner;

    return (
      <div>
        <div className="xs text-dd" style={{ textAlign: "center", marginBottom: 5, letterSpacing: 2, textTransform: "uppercase" }}>{label}</div>
        <div style={{ background: "var(--s2)", border: "1px solid var(--b2)", borderRadius: 8, overflow: "hidden", minWidth: 280 }}>
          {/* Team A */}
          <div style={{ padding: "10px 14px", borderBottom: "2px solid var(--b1)", background: m.winner === "A" ? "rgba(94,201,138,.08)" : "transparent", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {pA.map((pl, i) => (
                <div key={i} className="fac" style={{ gap: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: m.winner === "A" ? "var(--green)" : "var(--text)" }}>{pl.name}</span>
                  <PosBadge pos={pl.pos} />
                </div>
              ))}
            </div>
            {done && <span className="disp text-am" style={{ fontSize: 26, marginLeft: 12 }}>{m.scoreA}</span>}
            {m.winner === "A" && <span className="tag tag-w" style={{ marginLeft: 8 }}>WIN</span>}
          </div>
          {/* VS divider */}
          <div style={{ textAlign: "center", padding: "4px 0", background: "var(--s3)", fontSize: 9, letterSpacing: 3, color: "var(--dimmer)", textTransform: "uppercase" }}>vs</div>
          {/* Team B */}
          <div style={{ padding: "10px 14px", background: m.winner === "B" ? "rgba(94,201,138,.08)" : "transparent", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
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
              <span className="text-dd xs" style={{fontStyle:"italic"}}>Awaiting lower bracket…</span>
            )}
            {done && <span className="disp text-am" style={{ fontSize: 26, marginLeft: 12 }}>{m.scoreB}</span>}
            {m.winner === "B" && <span className="tag tag-w" style={{ marginLeft: 8 }}>WIN</span>}
          </div>
        </div>
        {!preview && isAdmin && !done && (
          <div style={{ display: "flex", gap: 5, alignItems: "center", justifyContent: "center", marginTop: 7 }}>
            <input className="inp" type="number" min="0" placeholder="A" value={sA} onChange={e => setSA(e.target.value)} style={{ width: 50, textAlign: "center" }} />
            <span className="text-dd">–</span>
            <input className="inp" type="number" min="0" placeholder="B" value={sBv} onChange={e => setSBv(e.target.value)} style={{ width: 50, textAlign: "center" }} />
            <button className="btn btn-p btn-sm" onClick={() => {
              const nA = parseInt(sA), nB = parseInt(sBv);
              if (isNaN(nA) || isNaN(nB) || nA === nB) return;
              recordResult(matchKey, nA > nB ? "A" : "B", nA, nB);
            }}>Set</button>
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
              ? <>Scheduled: <span className="text-am">{new Date(state.finalsDate).toLocaleString("en-GB", { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" })}</span></>
              : `Finals — last day of ${fmtMonth(monthKey)}`}
          </div>
          <Countdown />
          {cdDiff < 864e5 && <div className="tag tag-l" style={{ marginBottom: 16, fontSize: 11, letterSpacing: 2 }}>🔥 Finals are today!</div>}
          {cdDiff >= 864e5 && cdDiff < 7 * 864e5 && <div className="tag tag-a" style={{ marginBottom: 16, fontSize: 11, letterSpacing: 2 }}>⚡ Finals this week</div>}
          <FinalsDateEditor finalsDate={state.finalsDate} setState={setState} showToast={showToast} isAdmin={isAdmin} />
          <div className="mt12">
            {placedRanked.length >= 4
              ? isAdmin && (
                  <div style={{marginTop:12}}>
                    <div className="xs text-dd" style={{marginBottom:6}}>Top 4 placed players by points will be seeded into the bracket.</div>
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
          <span className={`tag ${status === "complete" ? "tag-w" : "tag-a"}`}>{status.toUpperCase()}</span>
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
    setState(s=>({...s,rules:draft}));
    showToast("Rulebook saved");
    setEditing(false);
  }

  if (editing) return (
    <div className="stack">
      <div className="card">
        <div className="card-header">
          <span className="card-title">Edit Rulebook</span>
          <div className="fac">
            <button className="btn btn-g" onClick={()=>{setDraft(state.rules||DEFAULT_RULES);setEditing(false);}}>Cancel</button>
            <button className="btn btn-p" onClick={save}>Save</button>
          </div>
        </div>
        <div style={{padding:18}}>
          <div className="msg msg-w sm mb12">Supports basic markdown: # headings, **bold**, - lists, `code`, ---</div>
          <textarea className="inp" rows={28} value={draft} onChange={e=>setDraft(e.target.value)}
            style={{fontFamily:"var(--mono)",fontSize:12,lineHeight:1.7}}/>
        </div>
      </div>
    </div>
  );

  return (
    <div className="stack page-fade">
      <div className="card">
        <div className="card-header">
          <span className="card-title">Rulebook</span>
          {isAdmin && <button className="btn btn-g btn-sm" onClick={()=>{setDraft(state.rules||DEFAULT_RULES);setEditing(true);}}>Edit</button>}
        </div>
        <div style={{padding:24}} className="md"
          dangerouslySetInnerHTML={{__html:renderMd(state.rules||DEFAULT_RULES)}}/>
      </div>
    </div>
  );
}

// ============================================================
// ADMIN LOGIN
// ============================================================
function AdminLogin({onLogin}){
  const[pw,setPw]=useState("");const[err,setErr]=useState("");
  function go(){pw===CONFIG.ADMIN_PASSWORD?onLogin():(setErr("Incorrect password"),setPw(""));}
  return(
    <div className="login-wrap">
      <div className="login-box">
        <div className="login-title">Admin Access</div>
        <div className="field"><label className="lbl">Password</label>
          <input className="inp" type="password" placeholder="Password…" value={pw}
            onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()}/>
        </div>
        {err&&<div className="msg msg-e">{err}</div>}
        <button className="btn btn-p w-full mt16" onClick={go}>Login</button>
      </div>
    </div>
  );
}

// ============================================================
// ROOT
// ============================================================
export default function App(){

  // PWA setup
  useEffect(()=>{
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
      const blob = new Blob([JSON.stringify(manifest)], {type:"application/json"});
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
  },[]);

  const[state,setState]=useState(SEED);
  const[isAdmin,setIsAdmin]=useState(false);
  const[tab,setTab]=useState("ranks");
  const[adminTab,setAdminTab]=useState("onboard");
  const[showLogin,setShowLogin]=useState(false);
  const[toast,setToast]=useState(null);
  const[selPlayer,setSelPlayer]=useState(null);
  const[editPlayer,setEditPlayer]=useState(null);

  // realtime + loading
  const[loading,setLoading]=useState(true);
  const[rtConnected,setRtConnected]=useState(false);
  const subscriptionRef=useRef(null);
  const isRemoteUpdate=useRef(false);
  const lastSavedVersion=useRef(-1); // tracks _v we last wrote, to suppress our own echo

  // ============================================================
  // LOAD STATE
  // ============================================================
  useEffect(()=>{

    async function initState(){
      try{
        const loaded = await loadState();
        setState(loaded);
        subscribeToStateChanges();
      }catch(err){
        console.error("Failed to initialize:",err);
      }finally{
        setLoading(false);
      }
    }

    initState();

    return ()=>{
      clearTimeout(reconnectTimer.current);
      if(subscriptionRef.current){
        supabase.removeChannel(subscriptionRef.current);
      }
    };

  },[]);

  // Always keep a ref to latest state so saveState never captures stale closure
  const stateRef = useRef(state);
  useEffect(()=>{ stateRef.current = state; }, [state]);

  // showToastRef declared here so autosave callback can use it before showToast is defined
  const showToastRef = useRef(null);

  // syncStatus: 'idle' | 'saving' | 'saved' | 'conflict' | 'error'
  const [syncStatus, setSyncStatus] = useState('idle');
  const syncStatusTimer = useRef(null);
  function setSyncFor(status, ms = 2500) {
    setSyncStatus(status);
    clearTimeout(syncStatusTimer.current);
    if (ms) syncStatusTimer.current = setTimeout(() => setSyncStatus('idle'), ms);
  }

  // autosave — skip on initial load, skip when change came from realtime
  const isInitialLoad = useRef(true);
  const pendingSave = useRef(false);
  useEffect(()=>{
    if(!loading){
      if(isInitialLoad.current){ isInitialLoad.current=false; return; }
      if(isRemoteUpdate.current){ isRemoteUpdate.current=false; return; }
      pendingSave.current = true;
      setSyncStatus('saving');
      saveState(
        stateRef.current,
        (remoteState) => {
          // Version conflict — another client saved first, accept their state
          isRemoteUpdate.current = true;
          pendingSave.current = false;
          setState(remoteState);
          setSyncFor('conflict', 4000);
          if (showToastRef.current) showToastRef.current("Sync conflict — remote state applied", "warning");
        },
        (newV) => {
          // Success — stamp _v directly onto stateRef so next save
          // uses the correct version WITHOUT triggering the autosave effect.
          pendingSave.current = false;
          lastSavedVersion.current = newV;
          stateRef.current = { ...stateRef.current, _v: newV };
          setSyncFor('saved');
        }
      );
    }
  },[state,loading]);

  // ============================================================
  // REALTIME SUBSCRIPTION
  // ============================================================
  const reconnectTimer = useRef(null);
  const wasDisconnected = useRef(false);

  function handleRemotePayload(payload) {
    const incoming = normaliseState(payload.new?.state || {});
    const incomingV = incoming._v ?? 0;
    const localV = _sq.currentV !== null ? _sq.currentV : (stateRef.current?._v ?? 0);

    // Ignore if this is our own echo
    if (incomingV === _sq.currentV || incomingV === lastSavedVersion.current) {
      console.log('Ignoring own echo _v' + incomingV);
      return;
    }
    // Ignore stale
    if (incomingV <= localV && !pendingSave.current) {
      console.log('Ignoring stale _v' + incomingV + ' (have ' + localV + ')');
      return;
    }
    console.log('Applying remote _v' + incomingV + ' (was ' + localV + ')');
    _sq.currentV = incomingV;
    isRemoteUpdate.current = true;
    setState(incoming);
  }

  function subscribeToStateChanges(){
    if(subscriptionRef.current){
      supabase.removeChannel(subscriptionRef.current);
      subscriptionRef.current = null;
    }

    // Stable channel name — no Date.now() leak on reconnect
    const channel = supabase
      .channel('app_state_v1')
      .on('postgres_changes',
        {event:'UPDATE',schema:'public',table:'app_state',filter:'id=eq.1'},
        handleRemotePayload
      )
      .on('postgres_changes',
        {event:'INSERT',schema:'public',table:'app_state',filter:'id=eq.1'},
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
              const { data } = await supabase.from('app_state').select('state').eq('id',1).single();
              if (data?.state) {
                const fresh = normaliseState(data.state);
                const freshV = fresh._v ?? 0;
                const localV = stateRef.current?._v ?? 0;
                if (freshV > localV) {
                  console.log('Catch-up fetch: remote _v' + freshV + ' > local _v' + localV);
                  isRemoteUpdate.current = true;
                  setState(fresh);
                  if (showToastRef.current) showToastRef.current('Synced with latest state', 'info');
                }
              }
            } catch(e) { console.warn('Catch-up fetch failed:', e); }
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
  const showToast = useCallback((msg,type="success")=>{
    setToast({msg,type});
    setTimeout(()=>setToast(null),4500);
  },[]);
  showToastRef.current = showToast;

  // ============================================================
  // NAV
  // ============================================================
  const PUB = ["ranks","history","stats","play","rules"];

  const ADMIN_TABS = [
    { id:"onboard", label:"Onboard" },
    { id:"logGames", label:"Log Games" }
  ];

  const[mobMenuOpen,setMobMenuOpen]=useState(false);
  function navTo(t, aTab){
    setTab(t);
    if(aTab) setAdminTab(aTab);
    setMobMenuOpen(false);
  }

  // keep selected player synced with state updates
  const currentSelPlayer = selPlayer
    ? state.players.find(p=>p.id===selPlayer.id) || selPlayer
    : null;

  const currentEditPlayer = editPlayer
    ? state.players.find(p=>p.id===editPlayer.id) || editPlayer
    : null;

  // ============================================================
  // LOADING SCREEN
  // ============================================================
  if(loading){
    return(
      <div style={{
        display:'flex',
        alignItems:'center',
        justifyContent:'center',
        minHeight:'100vh',
        color:'var(--dim)',
        fontFamily:'var(--mono)'
      }}>
        <div style={{textAlign:'center'}}>
          <div style={{fontSize:24,marginBottom:12}}>⚽</div>
          <div>Loading leaderboard...</div>
        </div>
      </div>
    );
  }

  // ============================================================
  // APP
  // ============================================================
  return(
    <>
      <style>{CSS}</style>

      <div className="app">

        {/* ============================================================ */}
        {/* TOPBAR */}
        {/* ============================================================ */}

        <div className="topbar" style={{position:"sticky",top:0,zIndex:100}}>

          <div className="brand" onClick={()=>navTo("ranks")} style={{cursor:"pointer",userSelect:"none"}} title="Go to leaderboard">
            St. Marylebone <span className="brand-sub">Table Tracker</span>
          </div>

          {/* Desktop nav */}
          <nav className="nav">
            {PUB.map(t=>(
              <button key={t} className={`nav-btn ${tab===t?"active":""}`} onClick={()=>navTo(t)}>
                {{"ranks":"Ranks","history":"History","stats":"Stats","play":"Champions","rules":"Rules"}[t]||t}
              </button>
            ))}
            {isAdmin && ADMIN_TABS.map(t=>(
              <button key={t.id}
                className={`nav-btn ${tab==="admin"&&adminTab===t.id?"active":""}`}
                onClick={()=>navTo("admin",t.id)}>
                {t.label}
              </button>
            ))}
          </nav>

          <div className="fac" style={{gap:8}}>
            {/* Realtime connection dot — always visible in topbar */}
            <div className="fac" style={{gap:5}} title={rtConnected?"Live — connected to database":"Connecting…"}>
              <span className={`rt-dot ${rtConnected?"live":""}`}></span>
              <span className="xs text-dd" style={{whiteSpace:"nowrap"}}>{rtConnected?"Live":"…"}</span>
            </div>
            {isAdmin ? (
              <>
                <span className="admin-badge">Admin</span>
                <button className="btn btn-g btn-sm" onClick={()=>{setIsAdmin(false);navTo("leaderboard");}}>
                  Logout
                </button>
              </>
            ) : (
              <button className="btn btn-g btn-sm" onClick={()=>setShowLogin(true)}>Admin</button>
            )}
            {/* Hamburger — mobile only */}
            <button className={`ham-btn ${mobMenuOpen?"open":""}`} onClick={()=>setMobMenuOpen(o=>!o)} aria-label="Menu">
              <span/><span/><span/>
            </button>
          </div>

        </div>

        {/* Sync status bar — admin only, shows during save/conflict/error */}
        {isAdmin && syncStatus !== 'idle' && (
          <div style={{
            position:'fixed', top:52, left:0, right:0, zIndex:98, height:3,
            background: syncStatus==='saving'  ? 'var(--amber-d)' :
                        syncStatus==='saved'   ? 'var(--green)'   :
                        syncStatus==='conflict'? 'var(--orange)'  : 'var(--red)',
            animation: syncStatus==='saving' ? 'savingBar 1.2s ease-in-out infinite alternate' : 'none',
            transition: 'background .3s',
          }}/>
        )}

        {/* Mobile nav dropdown */}
        <div className={`mob-nav ${mobMenuOpen?"open":""}`}>
          {PUB.map(t=>(
            <button key={t} className={`nav-btn ${tab===t?"active":""}`} onClick={()=>navTo(t)}>
              {{"ranks":"Ranks","history":"History","stats":"Stats","play":"Champions","rules":"Rules"}[t]||t}
            </button>
          ))}
          {isAdmin && ADMIN_TABS.map(t=>(
            <button key={t.id}
              className={`nav-btn ${tab==="admin"&&adminTab===t.id?"active":""}`}
              onClick={()=>navTo("admin",t.id)}>
              {t.label}
            </button>
          ))}
        </div>


        {/* ============================================================ */}
        {/* MAIN CONTENT */}
        {/* ============================================================ */}

        <div className="main">

          {tab==="ranks" && (
            <LeaderboardView
              state={state}
              setState={setState}
              rtConnected={rtConnected}
              isAdmin={isAdmin}
              showToast={showToast}
              syncStatus={syncStatus}
              onNavToPlay={()=>navTo("play")}
              onNavToHistory={()=>navTo("history")}
              onSelectPlayer={p=>{
                setSelPlayer(p);
                setEditPlayer(null);
              }}
            />
          )}

          {tab==="history" && (
            <HistoryView
              state={state}
              setState={setState}
              isAdmin={isAdmin}
              showToast={showToast}
            />
          )}

          {tab==="stats" && (
            <StatsView
              state={state}
              onSelectPlayer={p=>{setSelPlayer(p);setEditPlayer(null);}}
            />
          )}

          {tab==="play" && (
            <FinalsView
              state={state}
              setState={setState}
              isAdmin={isAdmin}
              showToast={showToast}
            />
          )}

          {tab==="rules" && (
            <RulesView
              state={state}
              setState={setState}
              isAdmin={isAdmin}
              showToast={showToast}
            />
          )}

          {/* ADMIN LOGIN */}
          {tab==="admin" && !isAdmin && (
            <AdminLogin onLogin={()=>setIsAdmin(true)} />
          )}

          {/* ADMIN PANEL */}
          {tab==="admin" && isAdmin && (()=>{

            switch(adminTab){

              case "onboard":
                return (
                  <OnboardView
                    state={state}
                    setState={setState}
                    showToast={showToast}
                  />
                );

              case "logGames":
                return (
                  <LogView
                    state={state}
                    setState={setState}
                    showToast={showToast}
                  />
                );

              default:
                return (
                  <div className="card" style={{padding:24}}>
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
            onClick={e=>e.target===e.currentTarget && setShowLogin(false)}
          >
            <div className="modal">
              <AdminLogin
                onLogin={()=>{
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
            onClose={()=>setSelPlayer(null)}
            isAdmin={isAdmin}
            onEdit={()=>{
              setEditPlayer(currentSelPlayer);
              setSelPlayer(null);
            }}
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
            onClose={()=>setEditPlayer(null)}
          />
        )}


        {/* ============================================================ */}
        {/* TOAST */}
        {/* ============================================================ */}

        <Toast t={toast} />

      </div>
    </>
  );
}