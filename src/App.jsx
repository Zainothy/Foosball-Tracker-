import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from './supabaseClient';

// ============================================================
// CONFIGURATION — tune these before your season starts.
// Changing mid-season only affects future games.
// ============================================================
const CONFIG = {
  ADMIN_PASSWORD: "YoungHector123",   // CHANGE THIS before deploying

  STARTING_MMR: 1000,           // hidden matchmaking rating
  STARTING_PTS: 0,              // visible leaderboard points

  // Base deltas — before all modifiers
  BASE_GAIN: 18,
  BASE_LOSS: 10,

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

  // Streak: exponential scale with sigmoid cap
  // mult = 1 + tanh(streak / STREAK_SCALE) * (CAP - 1)
  STREAK_SCALE: 3,              // streak of 3 = ~halfway to cap
  STREAK_CAP: 2.2,              // absolute max multiplier

  MAX_PLACEMENTS_PER_MONTH: 5,  // per player per calendar month
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
`;

// ============================================================
// MMR / POINTS ENGINE
// ============================================================

// Streak multiplier: tanh curve — grows fast early, plateaus hard at cap.
// streak=1→~1.3, streak=3→~1.9, streak=6→~2.15, streak=10→~2.2
function streakMult(streak) {
  const s = Math.max(0, Math.abs(streak));
  const t = Math.tanh(s / CONFIG.STREAK_SCALE);
  return 1 + t * (CONFIG.STREAK_CAP - 1);
}

function avg(ids, players, key) {
  const found = ids.map(id => players.find(p => p.id === id)).filter(Boolean);
  if (!found.length) return key === "mmr" ? CONFIG.STARTING_MMR : 0;
  return found.reduce((s, p) => s + (p[key] || 0), 0) / found.length;
}

// Recalculate pts/mmr/streaks/wins/losses from scratch AND rewrite
// ptsGain/ptsLoss/mmrGain/mmrLoss on every game record for full consistency.
// Returns { players, games } — caller must update both.
function replayGames(basePlayers, games, monthlyPlacements) {
  let players = basePlayers.map(p => ({
    ...p,
    mmr: CONFIG.STARTING_MMR,
    pts: CONFIG.STARTING_PTS,
    wins: 0, losses: 0, streak: 0,
  }));
  // Track placement counts during replay
  const placements = {};
  const sorted = [...games].sort((a, b) => new Date(a.date) - new Date(b.date));
  const updatedGames = sorted.map(g => {
    const winIds = g.winner === "A" ? g.sideA : g.sideB;
    const losIds = g.winner === "A" ? g.sideB : g.sideA;
    const ranked = [...players].sort((a,b)=>(b.pts||0)-(a.pts||0));
    const rankOf = id => { const i = ranked.findIndex(p=>p.id===id); return i === -1 ? ranked.length : i; };
    const avgRank = ids => ids.reduce((s,id)=>s+rankOf(id),0)/ids.length;
    const { gain, loss, eloScale, rankScale, winMult, lossMult, scoreMult } = calcDelta({
      winnerScore: Math.max(g.scoreA, g.scoreB),
      loserScore:  Math.min(g.scoreA, g.scoreB),
      winnerAvgMMR:    avg(winIds, players, "mmr"),
      loserAvgMMR:     avg(losIds, players, "mmr"),
      winnerAvgStreak: avg(winIds, players, "streak"),
      loserAvgStreak:  avg(losIds, players, "streak"),
      winnerAvgRank:   avgRank(winIds),
      loserAvgRank:    avgRank(losIds),
    });

    // Check placement status for each player before incrementing
    const allPids = [...winIds, ...losIds];
    const placedBefore = {};
    allPids.forEach(pid => { placedBefore[pid] = (placements[pid] || 0) >= CONFIG.MAX_PLACEMENTS_PER_MONTH; });

    players = players.map(p => {
      const isWin = winIds.includes(p.id);
      const isLos = losIds.includes(p.id);
      if (!isWin && !isLos) return p;
      const placed = placedBefore[p.id];
      if (isWin) {
        const ns = (p.streak||0) >= 0 ? (p.streak||0)+1 : 1;
        return { ...p, mmr: p.mmr+gain, pts: placed ? (p.pts||0)+gain : (p.pts||0), wins: p.wins+1, streak: ns };
      }
      const ns = (p.streak||0) <= 0 ? (p.streak||0)-1 : -1;
      return { ...p, mmr: Math.max(0,p.mmr-loss), pts: placed ? Math.max(0,(p.pts||0)-loss) : (p.pts||0), losses: p.losses+1, streak: ns };
    });

    // Increment placements and calibrate pts on completion
    allPids.forEach(pid => {
      const before = placements[pid] || 0;
      placements[pid] = before + 1;
      if (before + 1 === CONFIG.MAX_PLACEMENTS_PER_MONTH) {
        const thisPlayer = players.find(p => p.id === pid);
        if (thisPlayer) {
          const placedPlayers = players.filter(p => p.id !== pid && (placements[p.id]||0) >= CONFIG.MAX_PLACEMENTS_PER_MONTH);
          const sortedByMmr = [...placedPlayers].sort((a,b)=>(b.mmr||0)-(a.mmr||0));
          const insertRank = sortedByMmr.findIndex(p=>(p.mmr||0)<(thisPlayer.mmr||0));
          const rank = insertRank === -1 ? sortedByMmr.length : insertRank;
          let calibratedPts;
          if (sortedByMmr.length === 0) {
            calibratedPts = Math.round((thisPlayer.mmr - CONFIG.STARTING_MMR) * 0.5);
          } else if (rank === 0) {
            calibratedPts = Math.round((sortedByMmr[0].pts||0) * 1.1 + 5);
          } else if (rank >= sortedByMmr.length) {
            calibratedPts = Math.max(0, Math.round((sortedByMmr[sortedByMmr.length-1].pts||0) * 0.9 - 5));
          } else {
            calibratedPts = Math.round(((sortedByMmr[rank-1].pts||0)+(sortedByMmr[rank].pts||0))/2);
          }
          players = players.map(p => p.id===pid ? {...p, pts: Math.max(0, calibratedPts)} : p);
        }
      }
    });

    // Return game with recalculated deltas stamped on it
    return { ...g, ptsGain: gain, ptsLoss: loss, mmrGain: gain, mmrLoss: loss, eloScale, rankScale, winMult, lossMult, scoreMult };
  });

  return { players, games: updatedGames };
}

// ── CORE DELTA FORMULA ───────────────────────────────────────
// Three independent multipliers, all applied to base gain/loss:
//
// 1. SCORE DOMINANCE — how one-sided was the match?
//    ratio = scoreDiff / winnerScore  (0 = tie, 1 = shutout)
//    scoreMult = 1 + SCORE_WEIGHT * ratio^SCORE_EXP
//    Range: 1.0 (10-9) → ~2.2 (10-0)
//
// 2. MMR/ELO SURPRISE — did the underdog win?
//    eloScale = sigmoid of mmrGap → high when upset, low when expected
//    Range: 0.1 (massive favourite wins) → 1.9 (massive underdog wins)
//
// 3. RANK GAP — beating a higher-ranked opponent = extra reward
//    rankScale = 1 + RANK_WEIGHT * tanh(rankDiff / RANK_DIVISOR)
//    Range: 0.6 (losing to lower) → 1.4 (beating much higher)
//
// 4. STREAK — exponential warm-up, hard plateau at cap
//
function calcDelta({ winnerScore, loserScore, winnerAvgMMR, loserAvgMMR,
                     winnerAvgStreak, loserAvgStreak, winnerAvgRank, loserAvgRank }) {
  // Score dominance
  const scoreDiff = winnerScore - loserScore;
  const scoreRatio = scoreDiff / Math.max(winnerScore, 1);
  const scoreMult = 1 + CONFIG.SCORE_WEIGHT * Math.pow(scoreRatio, CONFIG.SCORE_EXP);

  // MMR surprise (elo): high reward for underdog win, low for expected win
  const mmrGap = winnerAvgMMR - loserAvgMMR;
  const eloScale = 2 / (1 + Math.exp(mmrGap / CONFIG.ELO_DIVISOR));
  // ^ ranges 0→2; = 1 at equal MMR, >1 when winner had lower MMR

  // Rank gap: winner gains more if they ranked lower, lose less if ranked higher
  const rankDiff = (loserAvgRank ?? 0) - (winnerAvgRank ?? 0);
  // positive = winner was ranked lower (upset) = bonus gain
  const rankScale = 1 + CONFIG.RANK_WEIGHT * Math.tanh(rankDiff / CONFIG.RANK_DIVISOR);

  // Streak multipliers
  const winMult  = streakMult(winnerAvgStreak);
  const lossMult = streakMult(loserAvgStreak);

  const gain = Math.max(2, Math.round(CONFIG.BASE_GAIN * scoreMult * eloScale * rankScale * winMult));
  const loss = Math.max(1, Math.round(CONFIG.BASE_LOSS * scoreMult * (2 - eloScale) * (2 - rankScale) * lossMult));

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
    return normaliseState(s);
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
  };
}

let _saveTimer = null;
function saveState(s) {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    try {
      const { error } = await supabase
        .from('app_state')
        .upsert({ id: 1, state: s, updated_at: new Date().toISOString() });
      if (error) {
        console.error('Failed to save to Supabase:', error);
      } else {
        console.log('✓ state saved to Supabase');
      }
    } catch (err) {
      console.error('Supabase save error:', err);
    }
  }, 800);
}

// ============================================================
// STYLES
// ============================================================
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&family=Barlow+Condensed:wght@400;600;700;800&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#080e0b;
    --s1:#0f1511;
    --s2:#141c18;
    --s3:#192019;

    --b1:#243029;
    --b2:#2f3e37;

    /* Primary accent */
    --amber:#1ed760;
    --amber-d:#14a84d;
    --amber-g:rgba(30,215,96,0.10);

    /* Supporting colours */
    --green:#1ed760;
    --red:#e05252;
    --blue:#5b9bd5;
    --purple:#9b7fe8;
    --orange:#f0a050;

    --text:#edf5f0;
    --dim:#adc4b8;
    --dimmer:#7a9a8c;

    --mono:'IBM Plex Mono',monospace;
    --disp:'Barlow Condensed',sans-serif;
  }
  body{background:var(--bg);color:var(--text);font-family:var(--mono);min-height:100vh}
  ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:var(--bg)}::-webkit-scrollbar-thumb{background:var(--b2);border-radius:2px}
  .app{display:flex;flex-direction:column;min-height:100vh}

  /* ── TOPBAR ─────────────────────────────────────────────── */
  .topbar{display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:52px;background:var(--s1);border-bottom:1px solid var(--b1);position:sticky;top:0;z-index:100;gap:12px}
  .brand{font-family:var(--disp);font-size:19px;font-weight:800;letter-spacing:2px;color:var(--amber);text-transform:uppercase;white-space:nowrap}
  .brand span{color:var(--dim);font-weight:400}
  .nav{display:flex;gap:2px;flex-wrap:nowrap;overflow:hidden}
  .nav-btn{background:none;border:none;cursor:pointer;font-family:var(--mono);font-size:11px;font-weight:500;color:var(--dim);padding:5px 11px;border-radius:3px;text-transform:uppercase;letter-spacing:1px;transition:all .15s;white-space:nowrap}
  .nav-btn:hover{color:var(--text);background:var(--s2)}
  .nav-btn.active{color:var(--amber);background:var(--amber-g);font-weight:700}
  .admin-badge{font-size:10px;font-weight:600;color:var(--amber);background:var(--amber-g);border:1px solid var(--amber-d);border-radius:3px;padding:2px 7px;letter-spacing:1px;text-transform:uppercase;white-space:nowrap}

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
  .card{background:var(--s1);border:1px solid var(--b1);border-radius:6px;overflow:hidden;transition:border-color .15s}
  .card-hover:hover{border-color:var(--b2)}
  .card-header{padding:12px 18px;border-bottom:1px solid var(--b2);display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--s2)}
  .card-title{font-family:var(--disp);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:var(--text);white-space:nowrap}

  /* ── TABLE ──────────────────────────────────────────────── */
  .tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
  .tbl{width:100%;border-collapse:collapse;min-width:520px}
  .tbl th{font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:var(--dim);padding:9px 14px;text-align:left;border-bottom:1px solid var(--b1);background:var(--s2)}
  .tbl td{padding:11px 14px;border-bottom:1px solid var(--b1);font-size:13px;color:var(--text);transition:background .1s}
  .tbl tr:last-child td{border-bottom:none}
  .tbl tbody tr{transition:background .12s,box-shadow .12s;cursor:pointer;position:relative}
  .tbl tbody tr:hover{background:var(--s2)}
  .tbl tbody tr:hover td:first-child{box-shadow:inset 3px 0 0 var(--amber)}
  .rk{font-family:var(--disp);font-size:17px;font-weight:800;color:var(--dim);min-width:26px;display:inline-block}
  .rk.r1{color:var(--amber)}.rk.r2{color:#c0c0c0}.rk.r3{color:#cd7f32}

  /* ── BUTTONS ─────────────────────────────────────────────── */
  .btn{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;padding:7px 14px;border-radius:4px;cursor:pointer;border:1px solid;transition:all .15s;white-space:nowrap}
  .btn-p{background:var(--amber);color:#000;border-color:var(--amber)}.btn-p:hover{background:#3dff7a;border-color:#3dff7a}
  .btn-g{background:transparent;color:var(--dim);border-color:var(--b2)}.btn-g:hover{color:var(--text);border-color:var(--dim)}
  .btn-d{background:transparent;color:var(--red);border-color:var(--red)}.btn-d:hover{background:rgba(224,82,82,.12)}
  .btn-warn{background:transparent;color:var(--amber);border-color:var(--amber-d)}.btn-warn:hover{background:var(--amber-g)}
  .btn-sm{padding:4px 9px;font-size:10px}
  .btn:disabled{opacity:.4;cursor:not-allowed}
  .w-full{width:100%}

  /* ── INPUTS ──────────────────────────────────────────────── */
  .inp{background:var(--s2);border:1px solid var(--b2);color:var(--text);font-family:var(--mono);font-size:13px;padding:8px 11px;border-radius:4px;outline:none;width:100%;transition:border .15s}
  .inp:focus{border-color:var(--amber);box-shadow:0 0 0 2px rgba(30,215,96,.1)}
  .inp::placeholder{color:var(--dimmer)}
  select.inp{cursor:pointer}
  textarea.inp{resize:vertical;line-height:1.6}
  .lbl{font-size:10px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--dim);margin-bottom:5px;display:block}
  .field{margin-bottom:12px}

  /* ── MESSAGES ────────────────────────────────────────────── */
  .msg{font-size:12px;padding:7px 11px;border-radius:4px;margin-top:7px}
  .msg-e{background:rgba(224,82,82,.10);color:var(--red);border:1px solid rgba(224,82,82,.3)}
  .msg-s{background:rgba(30,215,96,.10);color:var(--green);border:1px solid rgba(30,215,96,.3)}
  .msg-w{background:rgba(30,215,96,.08);color:var(--amber);border:1px solid rgba(30,215,96,.25)}

  /* ── TOAST ───────────────────────────────────────────────── */
  .toast{position:fixed;bottom:20px;right:20px;z-index:999;background:var(--s2);border:1px solid var(--b2);padding:11px 16px;border-radius:6px;font-size:12px;animation:slideUp .2s ease;box-shadow:0 8px 32px rgba(0,0,0,.5);max-width:300px}
  .toast.success{border-left:3px solid var(--green);color:var(--green)}
  .toast.error{border-left:3px solid var(--red);color:var(--red)}
  .toast.info{border-left:3px solid var(--amber);color:var(--amber)}

  /* ── MODALS ──────────────────────────────────────────────── */
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(4px);padding:16px}
  .modal{background:var(--s1);border:1px solid var(--b2);border-radius:8px;padding:24px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,.7);animation:mIn .18s ease}
  .modal-lg{max-width:740px}
  @keyframes mIn{from{transform:scale(.96) translateY(4px);opacity:0}to{transform:scale(1) translateY(0);opacity:1}}
  .modal-title{font-family:var(--disp);font-size:20px;font-weight:800;letter-spacing:1px;text-transform:uppercase;margin-bottom:18px;color:var(--amber)}
  .confirm-modal{max-width:380px;text-align:center}
  .confirm-modal .modal-title{font-size:17px}

  /* ── STAT BOXES ──────────────────────────────────────────── */
  .stat-box{background:var(--s2);border:1px solid var(--b2);border-radius:8px;padding:14px 18px;transition:border-color .2s,transform .15s}.stat-box:hover{border-color:var(--amber-d);transform:translateY(-1px)}
  .stat-box:hover{border-color:var(--b2)}
  .stat-lbl{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--dimmer);margin-bottom:5px}
  .stat-val{font-family:var(--disp);font-size:26px;font-weight:800;color:var(--text)}
  .stat-val.am{color:var(--amber)}

  /* ── PILLS / TAGS ────────────────────────────────────────── */
  .pills{display:flex;gap:4px;margin-bottom:16px;flex-wrap:wrap}
  .pill{font-family:var(--mono);font-size:11px;letter-spacing:1px;text-transform:uppercase;padding:5px 12px;border-radius:20px;cursor:pointer;border:1px solid var(--b2);background:none;color:var(--dim);transition:all .15s}
  .pill.on{background:var(--amber);color:#000;border-color:var(--amber);font-weight:700}
  .pill:hover:not(.on){color:var(--text);border-color:var(--dim)}
  .tag{display:inline-block;font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:2px 6px;border-radius:3px;font-weight:600}
  .tag-w{background:rgba(30,215,96,.15);color:var(--green)}
  .tag-l{background:rgba(224,82,82,.12);color:var(--red)}
  .tag-a{background:var(--amber-g);color:var(--amber)}
  .tag-b{background:rgba(91,155,213,.12);color:var(--blue)}
  .tag-p{background:rgba(155,127,232,.12);color:var(--purple)}

  /* ── GAME ROWS ───────────────────────────────────────────── */
  .game-row{padding:11px 18px;border-bottom:1px solid var(--b1);display:grid;grid-template-columns:1fr auto 1fr auto;gap:10px;align-items:center;font-size:12px;cursor:pointer;transition:background .1s}
  .game-row:hover{background:var(--s2)}
  .game-row:last-child{border-bottom:none}
  .g-side{display:flex;flex-direction:column;gap:2px}
  .g-side.right{text-align:right;align-items:flex-end}
  .g-score{font-family:var(--disp);font-size:21px;font-weight:800;color:var(--amber);text-align:center;min-width:56px}
  .g-date{font-size:10px;color:var(--dimmer);text-align:center}
  .g-name-w{color:var(--text);font-weight:600}
  .g-name-l{color:var(--dim)}

  /* ── LOG GAME SPECIFIC ───────────────────────────────────── */
  .add-row{display:flex;align-items:center;justify-content:center;gap:6px;background:none;border:1px dashed var(--b2);color:var(--dim);font-family:var(--mono);font-size:11px;padding:8px;border-radius:4px;cursor:pointer;letter-spacing:1px;text-transform:uppercase;transition:all .15s;width:100%;margin-top:8px}
  .add-row:hover{border-color:var(--amber);color:var(--amber)}
  .player-chip{display:flex;align-items:center;justify-content:space-between;background:var(--s3);border:1px solid var(--b2);border-radius:4px;padding:5px 8px;font-size:12px;cursor:pointer;transition:all .1s;user-select:none}
  .player-chip:hover:not(.disabled){border-color:var(--amber)}
  .player-chip.sel-a{background:rgba(30,215,96,.1);border-color:var(--green);color:var(--green)}
  .player-chip.sel-b{background:rgba(91,155,213,.10);border-color:var(--blue);color:var(--blue)}
  .player-chip.disabled{opacity:.3;cursor:not-allowed}

  /* ── POSITION BADGES ─────────────────────────────────────── */
  .pos-badge{display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:2px 6px;border-radius:3px;border:1px solid}
  .pos-atk{background:rgba(224,82,82,.12);color:var(--red);border-color:rgba(224,82,82,.3)}
  .pos-def{background:rgba(91,155,213,.12);color:var(--blue);border-color:rgba(91,155,213,.3)}
  .pos-both{background:rgba(155,127,232,.12);color:var(--purple);border-color:rgba(155,127,232,.3)}

  /* ── PLACEMENT STATUS ────────────────────────────────────── */
  .placement-badge{display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:2px 7px;border-radius:3px}
  .placement-done{background:rgba(30,215,96,.12);color:var(--green);border:1px solid rgba(30,215,96,.3)}
  .placement-pending{background:rgba(240,160,80,.10);color:var(--orange);border:1px solid rgba(240,160,80,.3)}

  /* ── BRACKET ─────────────────────────────────────────────── */
  .bracket{padding:20px;display:flex;gap:28px;align-items:center;justify-content:center;overflow-x:auto;-webkit-overflow-scrolling:touch}
  .b-col{display:flex;flex-direction:column;gap:28px;align-items:center}
  .b-match{background:var(--s2);border:1px solid var(--b2);border-radius:6px;overflow:hidden;width:200px}
  .b-side{padding:9px 13px;font-size:12px;border-bottom:1px solid var(--b1);display:flex;justify-content:space-between;align-items:center}
  .b-side:last-child{border-bottom:none}
  .b-side.win{background:var(--amber-g);color:var(--amber);font-weight:600}
  .b-conn{color:var(--dim);font-size:24px;font-weight:800}

  /* ── PROFILE ─────────────────────────────────────────────── */
  .prof-head{display:flex;align-items:center;gap:14px;margin-bottom:18px}
  .prof-av{width:50px;height:50px;border-radius:6px;background:var(--amber-g);border:2px solid var(--amber-d);display:flex;align-items:center;justify-content:center;font-family:var(--disp);font-size:22px;font-weight:800;color:var(--amber);flex-shrink:0}
  .prof-name{font-family:var(--disp);font-size:24px;font-weight:800}
  .prof-sub{font-size:11px;color:var(--dim);margin-top:2px}
  .championship-banner{background:linear-gradient(135deg,rgba(30,215,96,.14),rgba(30,215,96,.04));border:1px solid var(--amber-d);border-radius:6px;padding:10px 14px;display:flex;align-items:center;gap:10px;margin-bottom:14px}

  /* ── MISC ────────────────────────────────────────────────── */
  .login-wrap{display:flex;align-items:center;justify-content:center;min-height:60vh}
  .login-box{background:var(--s1);border:1px solid var(--b1);border-radius:8px;padding:28px;width:100%;max-width:300px}
  .login-title{font-family:var(--disp);font-size:20px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:var(--amber);margin-bottom:18px}
  .sec{font-family:var(--disp);font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:var(--dimmer);margin-bottom:10px;display:flex;align-items:center;gap:10px}
  .sec::after{content:'';flex:1;height:1px;background:var(--b1)}
  .fac{display:flex;align-items:center;gap:8px}
  .fbc{display:flex;justify-content:space-between;align-items:center}
  .mt8{margin-top:8px}.mt12{margin-top:12px}.mt16{margin-top:16px}.mb8{margin-bottom:8px}.mb12{margin-bottom:12px}.mb16{margin-bottom:16px}
  .text-am{color:var(--amber)}.text-g{color:var(--green)}.text-r{color:var(--red)}.text-d{color:var(--dim)}.text-dd{color:var(--dimmer)}
  .bold{font-weight:600}.sm{font-size:11px}.xs{font-size:10px}
  .disp{font-family:var(--disp);font-weight:800}
  .pip{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:3px}
  .pip-u{background:var(--dimmer)}.pip-f{background:var(--amber)}
  .divider{height:1px;background:var(--b1);margin:14px 0}

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
  .inp-edit{border-color:var(--amber-d) !important;background:rgba(30,215,96,.04) !important}

  /* ── REALTIME DOT ────────────────────────────────────────── */
  .rt-dot{width:8px;height:8px;border-radius:50%;background:var(--dimmer);display:block;flex-shrink:0;transition:background .3s}
  .rt-dot.live{background:var(--green);animation:rtPulse 2.5s infinite}
  @keyframes rtPulse{0%{box-shadow:0 0 0 0 rgba(30,215,96,.55)}70%{box-shadow:0 0 0 7px rgba(30,215,96,0)}100%{box-shadow:0 0 0 0 rgba(30,215,96,0)}}

  /* ── LEADERBOARD ANIMATIONS ──────────────────────────────── */
  .lb-row{transition:background .1s}
  .lb-row.rank-up{animation:rankUp .75s ease forwards}
  .lb-row.rank-down{animation:rankDown .75s ease forwards}
  .lb-row.pts-changed{animation:ptsFlash .85s ease}
  @keyframes rankUp{0%{background:rgba(30,215,96,.22)}100%{background:transparent}}
  @keyframes rankDown{0%{background:rgba(224,82,82,.18)}100%{background:transparent}}
  @keyframes ptsFlash{0%,100%{background:transparent}30%{background:rgba(30,215,96,.10)}}

  /* Stagger entrance for leaderboard rows */
  @keyframes rowIn{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:translateX(0)}}
  .lb-row{animation:rowIn .25s ease both}

  /* ── PAGE FADE ───────────────────────────────────────────── */
  .page-fade{animation:pageFade .18s ease both}
  .page-fade{animation:pageFade .2s ease both}
  @keyframes pageFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}

  /* ── ANIMATIONS ──────────────────────────────────────────── */
  @keyframes slideUp{from{transform:translateY(10px);opacity:0}to{transform:translateY(0);opacity:1}}
  @keyframes countUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}

  /* ── COUNTDOWN BLOCK ─────────────────────────────────────── */
  .cd-wrap{display:flex;gap:6px;align-items:flex-end;justify-content:center;margin:16px 0 6px}
  .cd-unit{display:flex;flex-direction:column;align-items:center;min-width:54px}
  .cd-num{font-family:var(--disp);font-size:46px;font-weight:800;line-height:1;letter-spacing:-1px;transition:color .4s}
  .cd-lbl{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--dimmer);margin-top:2px}
  .cd-sep{font-family:var(--disp);font-size:38px;font-weight:800;color:var(--dimmer);line-height:1;margin-bottom:16px;animation:sepBlink 1.2s step-start infinite}
  @keyframes sepBlink{0%,49%{opacity:1}50%,100%{opacity:.2}}
  .cd-urgent1{color:var(--orange) !important}
  .cd-urgent2{color:var(--red) !important}
  .cd-glow{animation:cdGlow 2s ease-in-out infinite alternate}
  @keyframes cdGlow{from{text-shadow:0 0 8px rgba(30,215,96,.2)}to{text-shadow:0 0 20px rgba(30,215,96,.5)}}

  /* ── MOBILE ──────────────────────────────────────────────── */
  @media(max-width:640px){
    .topbar{padding:0 12px;gap:8px}
    .brand{font-size:15px;letter-spacing:1px}
    .brand span{display:none}
    .nav{display:none}
    .ham-btn{display:flex}
    .main{padding:12px 10px}
    .grid-3{grid-template-columns:1fr 1fr}
    .grid-2{grid-template-columns:1fr}
    .stat-val{font-size:20px}
    .modal{padding:16px;max-height:85vh}
    .cd-num{font-size:32px}
    .cd-unit{min-width:38px}
    .cd-sep{font-size:26px}
    .tbl{min-width:420px}
    .tbl td,.tbl th{padding:8px 10px}
    .game-row{grid-template-columns:1fr auto 1fr;padding:9px 12px}
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

function StreakBadge({ streak, showMult=false }) {
  const s = streak || 0;
  if (s === 0) return <span className="text-dd">—</span>;
  const m = streakMult(s);
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
  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className={`modal ${large?"modal-lg":""}`}>{children}</div>
    </div>
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
  const myGames = state.games.filter(g=>g.sideA.includes(player.id)||g.sideB.includes(player.id));
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
        {isAdmin && !champs.length && (
          <button className="btn btn-g btn-sm" onClick={onEdit}>Edit Profile</button>
        )}
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
          <div className="stat-val" style={{fontSize:20}}><StreakBadge streak={player.streak} showMult /></div>
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
            <span className={won?"text-g":"text-r"}>{won?`+${g.ptsGain}pts`:`−${g.ptsLoss}pts`}</span>
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
        const { players, games } = replayGames(state.players, state.games, state.monthlyPlacements);
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
// GAME DETAIL MODAL (with edit)
// ============================================================
function GameDetail({ game, state, setState, isAdmin, showToast, onClose }) {
  const [editing, setEditing] = useState(false);
  const [scoreA, setScoreA] = useState(String(game.scoreA));
  const [scoreB, setScoreB] = useState(String(game.scoreB));
  const [winner, setWinner] = useState(game.winner);
  const [confirm, setConfirm] = useState(null);

  const sA = game.sideA.map(id=>state.players.find(p=>p.id===id)).filter(Boolean);
  const sB = game.sideB.map(id=>state.players.find(p=>p.id===id)).filter(Boolean);

  function saveEdit() {
    const nA = parseInt(scoreA), nB = parseInt(scoreB);
    if (isNaN(nA)||isNaN(nB)||nA<0||nB<0) { showToast("Invalid scores","error"); return; }
    if (nA===nB) { showToast("No draws","error"); return; }
    // Update game record, then replay all games to recalculate stats
    const updatedGame = {...game, scoreA:nA, scoreB:nB, winner};
    const editedGames = state.games.map(g=>g.id===game.id ? updatedGame : g);
    const basePlayers = state.players.map(p=>({...p, mmr:CONFIG.STARTING_MMR, pts:CONFIG.STARTING_PTS, wins:0, losses:0, streak:0}));
    const { players: newPlayers, games: newGames } = replayGames(basePlayers, editedGames, state.monthlyPlacements);
    const mergedPlayers = newPlayers.map(p => {
      const orig = state.players.find(x=>x.id===p.id);
      return {...p, name:orig?.name||p.name, championships:orig?.championships||[], position:orig?.position||p.position};
    });
    setState(s=>({...s, games:newGames, players:mergedPlayers}));
    showToast("Game updated & stats recalculated");
    setEditing(false);
    onClose();
  }

  function deleteGame() {
    setConfirm({
      title:"Delete Game?",
      msg:"This will permanently remove the game and recalculate all affected stats.",
      danger:true,
      onConfirm:()=>{
        const filteredGames = state.games.filter(g=>g.id!==game.id);
        const basePlayers = state.players.map(p=>({...p, mmr:CONFIG.STARTING_MMR, pts:CONFIG.STARTING_PTS, wins:0, losses:0, streak:0}));
        const { players: newPlayers, games: newGames } = replayGames(basePlayers, filteredGames, state.monthlyPlacements);
        const mergedPlayers = newPlayers.map(p => {
          const orig = state.players.find(x=>x.id===p.id);
          return {...p, name:orig?.name||p.name, championships:orig?.championships||[], position:orig?.position||p.position};
        });
        setState(s=>({...s, games:newGames, players:mergedPlayers}));
        showToast("Game deleted & stats recalculated");
        setConfirm(null);
        onClose();
      }
    });
  }

  return (
    <>
      <Modal onClose={onClose}>
        <div className="fbc mb16">
          <div className="modal-title" style={{marginBottom:0}}>Match Detail</div>
          {isAdmin && !editing && (
            <div className="fac">
              <button className="btn btn-warn btn-sm" onClick={()=>setEditing(true)}>Edit</button>
              <button className="btn btn-d btn-sm" onClick={deleteGame}>Delete</button>
            </div>
          )}
        </div>
        <div className="xs text-dd mb16">{fmtDate(game.date)}</div>

        <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:14,alignItems:"center",marginBottom:18}}>
          <div>
            <div className="xs text-dd" style={{marginBottom:5}}>{game.winner==="A"?"WINNER":"LOSER"}</div>
            {sA.map(p=><div key={p.id} className={`bold ${game.winner==="A"?"text-g":"text-r"}`}>{p.name}</div>)}
          </div>
          <div style={{textAlign:"center"}}>
            {editing ? (
              <div className="fac" style={{justifyContent:"center",gap:6}}>
                <input className="inp inp-edit" type="number" min="0" value={scoreA}
                  onChange={e=>setScoreA(e.target.value)}
                  style={{width:56,textAlign:"center",fontSize:18,fontFamily:"var(--disp)",fontWeight:800}}/>
                <span className="text-dd">–</span>
                <input className="inp inp-edit" type="number" min="0" value={scoreB}
                  onChange={e=>setScoreB(e.target.value)}
                  style={{width:56,textAlign:"center",fontSize:18,fontFamily:"var(--disp)",fontWeight:800}}/>
              </div>
            ) : (
              <div className="disp text-am" style={{fontSize:34}}>{game.scoreA}–{game.scoreB}</div>
            )}
            {editing && (
              <div className="mt8">
                <label className="lbl">Winner</label>
                <select className="inp" value={winner} onChange={e=>setWinner(e.target.value)}>
                  <option value="A">Side A ({sA.map(p=>p.name).join(" & ")})</option>
                  <option value="B">Side B ({sB.map(p=>p.name).join(" & ")})</option>
                </select>
              </div>
            )}
            {!editing && (
              <div className="xs text-dd mt8">
                {game.winner==="A"
                  ? <><span className="text-g">+{game.ptsGain}pts</span> / <span className="text-r">-{game.ptsLoss}pts</span></>
                  : <><span className="text-r">-{game.ptsLoss}pts</span> / <span className="text-g">+{game.ptsGain}pts</span></>}
              </div>
            )}
          </div>
          <div style={{textAlign:"right"}}>
            <div className="xs text-dd" style={{marginBottom:5}}>{game.winner==="B"?"WINNER":"LOSER"}</div>
            {sB.map(p=><div key={p.id} className={`bold ${game.winner==="B"?"text-g":"text-r"}`}>{p.name}</div>)}
          </div>
        </div>

        {!editing && game.eloScale!=null && (
          <div style={{background:"var(--s2)",borderRadius:6,padding:"8px 12px",fontSize:11,color:"var(--dimmer)",display:"flex",gap:16,flexWrap:"wrap"}}>
            <span>Elo scale: <span className="text-am">{(game.eloScale*100).toFixed(0)}%</span></span>
            <span>Rank scale: <span className="text-am">{game.rankScale?.toFixed(2) ?? "—"}</span></span>
            <span>Win streak ×: <span className="text-am">{game.winMult?.toFixed(2)}</span></span>
            <span>Loss streak ×: <span className="text-am">{game.lossMult?.toFixed(2)}</span></span>
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

// ============================================================
// LEADERBOARD VIEW
// ============================================================
function LeaderboardView({ state, setState, onSelectPlayer, rtConnected, isAdmin, showToast }) {
  const monthKey = getMonthKey();
  const ranked = [...(state.players ?? [])].sort((a,b)=>(b.pts||0)-(a.pts||0));
  const [showRecalcConfirm, setShowRecalcConfirm] = useState(false);

  function doRecalc() {
    const { players, games } = replayGames(state.players, state.games, state.monthlyPlacements);
    setState(s => ({ ...s, players, games }));
    showToast("All stats recalculated from game log");
    setShowRecalcConfirm(false);
  }
  const monthGames = (state.games ?? []).filter(g=>g.monthKey===monthKey);

  const prevSnapshot = useRef({});
  const [animMap, setAnimMap] = useState({});
  useEffect(()=>{
    const prev = prevSnapshot.current;
    const next = {};
    const anims = {};
    ranked.forEach((p,i)=>{
      const pr = prev[p.id]?.rank, pp = prev[p.id]?.pts;
      if(pr!==undefined && pr!==i) anims[p.id] = i<pr?"rank-up":"rank-down";
      else if(pp!==undefined && pp!==(p.pts||0)) anims[p.id]="pts-changed";
      next[p.id]={rank:i,pts:p.pts||0};
    });
    prevSnapshot.current=next;
    if(Object.keys(anims).length){ setAnimMap(anims); setTimeout(()=>setAnimMap({}),900); }
  },[state.players]);

  return (
    <>
    <div className="stack page-fade">
      {isAdmin && (
        <div style={{display:"flex",justifyContent:"flex-end"}}>
          <button className="btn btn-warn" style={{gap:6}} onClick={()=>setShowRecalcConfirm(true)}>
            ↺ Recalculate All Stats
          </button>
        </div>
      )}
      <div className="grid-3">
        <div className="stat-box"><div className="stat-lbl">Players</div><div className="stat-val am">{(state.players??[]).length}</div></div>
        <div className="stat-box"><div className="stat-lbl">Games This Month</div><div className="stat-val">{monthGames.length}</div></div>
        <div className="stat-box"><div className="stat-lbl">Top Points</div><div className="stat-val am">{ranked[0]?.pts??0}</div></div>
      </div>
      <div className="card">
        <div className="card-header">
          <span className="card-title">Rankings — {fmtMonth(monthKey)}</span>
          <div className="fac" style={{gap:8}}>
            <span className={`rt-dot ${rtConnected?"live":""}`} title={rtConnected?"Live":"Connecting…"}/>
            <span className="xs text-dd">{rtConnected?"Live":"…"}</span>
          </div>
        </div>
        <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr><th>#</th><th>Player</th><th>Points</th><th>W</th><th>L</th><th>Win%</th><th>Streak</th><th>Position</th><th>Placements</th></tr>
          </thead>
          <tbody>
            {ranked.map((p,i)=>{
              const placements=(state.monthlyPlacements[monthKey]||{})[p.id]||0;
              const total=p.wins+p.losses;
              const pct=total?Math.round(p.wins/total*100):0;
              const anim=animMap[p.id]||"";
              return (
                <tr key={p.id} className={`lb-row ${anim}`} style={{animationDelay:`${i*28}ms`}} onClick={()=>onSelectPlayer(p)}>
                  <td><span className={`rk ${placements >= CONFIG.MAX_PLACEMENTS_PER_MONTH ? (i===0?"r1":i===1?"r2":i===2?"r3":"") : ""}`}
                    style={placements < CONFIG.MAX_PLACEMENTS_PER_MONTH ? {color:"var(--dimmer)"} : {}}>
                    {placements >= CONFIG.MAX_PLACEMENTS_PER_MONTH
                      ? (i===0?"①":i===1?"②":i===2?"③":`#${i+1}`)
                      : "?"}
                  </span></td>
                  <td>
                    <span className="bold">{p.name}</span>
                    {(p.championships||[]).length>0&&<span style={{marginLeft:6,fontSize:13}}>🏆</span>}
                  </td>
                  <td>
                    {placements >= CONFIG.MAX_PLACEMENTS_PER_MONTH
                      ? <><span className="bold" style={{fontSize:14}}>{p.pts||0}</span>
                          {anim==="rank-up"&&<span className="xs text-g" style={{marginLeft:5}}>▲</span>}
                          {anim==="rank-down"&&<span className="xs text-r" style={{marginLeft:5}}>▼</span>}
                        </>
                      : <span className="bold text-dd" style={{fontSize:14}} title="Complete placements to reveal ranking">?</span>
                    }
                  </td>
                  <td><span className="text-g bold">{p.wins}</span></td>
                  <td><span className="text-r bold">{p.losses}</span></td>
                  <td><span className={pct>=50?"text-g":"text-d"}>{total?`${pct}%`:"—"}</span></td>
                  <td><StreakBadge streak={p.streak} showMult /></td>
                  <td><PosBadge pos={p.position}/></td>
                  <td>
                    {(state.monthlyPlacements[monthKey]||{})[p.id] >= CONFIG.MAX_PLACEMENTS_PER_MONTH
                      ? <span className="placement-badge placement-done">✓ Placed</span>
                      : <span className="placement-badge placement-pending"><Pips used={placements}/> {CONFIG.MAX_PLACEMENTS_PER_MONTH - placements} left</span>
                    }
                  </td>
                </tr>
              );
            })}
            {ranked.length===0&&<tr><td colSpan={9} style={{textAlign:"center",padding:32,color:"var(--dimmer)"}}>No players yet</td></tr>}
          </tbody>
        </table>
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
  const [filter, setFilter] = useState("");
  const [selectedGameId, setSelectedGameId] = useState(null);

  const allGames = [...(state.games ?? [])].sort((a, b) => new Date(b.date) - new Date(a.date));
  const filtered = allGames.filter(g=>{
    if (!filter) return true;
    return [...g.sideA,...g.sideB].map(id=>pName(id,state.players)).join(" ").toLowerCase().includes(filter.toLowerCase());
  });

  return (
    <div className="stack page-fade">
      <div className="card">
        <div className="card-header">
          <span className="card-title">Match History ({allGames.length})</span>
          <input className="inp" placeholder="Filter by player…" value={filter}
            onChange={e=>setFilter(e.target.value)} style={{width:170}}/>
        </div>
        {filtered.map(g=>{
          const sAN=g.sideA.map(id=>pName(id,state.players));
          const sBN=g.sideB.map(id=>pName(id,state.players));
          return (
            <div className="game-row" key={g.id} onClick={()=>setSelectedGameId(g.id)}>
              <div className="g-side">
                {sAN.map((n,i)=><span key={i} className={g.winner==="A"?"g-name-w":"g-name-l"}>{n}</span>)}
                <span className="xs text-dd">
                  {g.winner==="A"
                    ? <span className="text-g">+{g.ptsGain}pts</span>
                    : <span className="text-r">−{g.ptsLoss}pts</span>}
                </span>
              </div>
              <div>
                <div className="g-score">{g.scoreA}–{g.scoreB}</div>
                <div className="g-date">{fmtDate(g.date)}</div>
              </div>
              <div className="g-side right">
                {sBN.map((n,i)=><span key={i} className={g.winner==="B"?"g-name-w":"g-name-l"}>{n}</span>)}
                <span className="xs text-dd">
                  {g.winner==="B"
                    ? <span className="text-g">+{g.ptsGain}pts</span>
                    : <span className="text-r">−{g.ptsLoss}pts</span>}
                </span>
              </div>
              <span className={`tag ${g.winner==="A"?"tag-w":"tag-b"}`}>
                {g.winner==="A"?sAN[0]:sBN[0]} won
              </span>
            </div>
          );
        })}
        {filtered.length===0 && <div style={{padding:32,textAlign:"center",color:"var(--dimmer)",fontSize:12}}>No games found</div>}
      </div>
      {selectedGameId && (() => {
        const selectedGame = state.games.find(g => g.id === selectedGameId);
        return selectedGame ? (
          <GameDetail game={selectedGame} state={state} setState={setState}
            isAdmin={isAdmin} showToast={showToast} onClose={()=>setSelectedGameId(null)}/>
        ) : null;
      })()}
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
const EMPTY_ROW = () => ({ id: crypto.randomUUID(), sideA: [], sideB: [], scoreA: "", scoreB: "" });

function LogView({ state, setState, showToast }) {
  const [rows, setRows] = useState([EMPTY_ROW()]);
  const [errors, setErrors] = useState({});
  const [undoStack, setUndoStack] = useState([]);
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
  function togglePlayer(rowId, side, pid) {
    setRows(r =>
      r.map(row => {
        if (row.id !== rowId) return row;
        const key = side === "A" ? "sideA" : "sideB";
        const other = side === "A" ? "sideB" : "sideA";
        const otherFiltered = row[other].filter(id => id !== pid);

        if (row[key].includes(pid)) return { ...row, [key]: row[key].filter(id => id !== pid) };
        if (row[key].length >= 2) return row;
        return { ...row, [key]: [...row[key], pid], [other]: otherFiltered };
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
  function submitAll() {
    const newErrors = {};
    const monthKey = getMonthKey() ?? "default";
    const placements = { ...((state.monthlyPlacements ?? {})[monthKey] ?? {}) };

    for (const row of rows) {
      if (row.sideA.length !== 2 || row.sideB.length !== 2) { newErrors[row.id] = "Each side needs exactly 2 players"; continue; }
      if (new Set([...row.sideA, ...row.sideB]).size < 4) { newErrors[row.id] = "A player appears on both sides"; continue; }

      const sA = parseInt(row.scoreA, 10), sB = parseInt(row.scoreB, 10);
      if (isNaN(sA) || isNaN(sB) || sA < 0 || sB < 0) { newErrors[row.id] = "Invalid scores"; continue; }
      if (sA === sB) { newErrors[row.id] = "No draws allowed"; continue; }

      // Placements are informational only — no lockout
    }

    setErrors(newErrors);
    if (Object.keys(newErrors).length) { showToast("Fix errors first", "error"); return; }

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

      const { gain, loss, eloScale, rankScale, winMult, lossMult, scoreMult } = calcDelta({
        winnerScore, loserScore,
        winnerAvgMMR: avg(winnerIds, newPlayers, "mmr"),
        loserAvgMMR:  avg(loserIds,  newPlayers, "mmr"),
        winnerAvgStreak: avg(winnerIds, newPlayers, "streak"),
        loserAvgStreak:  avg(loserIds,  newPlayers, "streak"),
        winnerAvgRank: avgRank(winnerIds),
        loserAvgRank:  avgRank(loserIds),
      });

      // Check placement status for each player before updating counts
      const allPids = [...winnerIds, ...loserIds];
      const placementsBefore = { ...newPlacements[monthKey] };

      newPlayers = newPlayers.map(p => {
        const isWinner = winnerIds.includes(p.id);
        const isLoser  = loserIds.includes(p.id);
        if (!isWinner && !isLoser) return p;

        const placedBefore = (placementsBefore[p.id] || 0) >= CONFIG.MAX_PLACEMENTS_PER_MONTH;
        const thisIsLastPlacement = (placementsBefore[p.id] || 0) === CONFIG.MAX_PLACEMENTS_PER_MONTH - 1;

        if (isWinner) {
          const ns = (p.streak || 0) >= 0 ? (p.streak || 0) + 1 : 1;
          const newMmr = p.mmr + gain;
          // During placements: MMR moves, pts hidden (stays 0 until revealed)
          // After placements: pts move normally
          const newPts = placedBefore ? (p.pts || 0) + gain : (p.pts || 0);
          return { ...p, mmr: newMmr, pts: newPts, wins: p.wins + 1, streak: ns };
        }
        if (isLoser) {
          const ns = (p.streak || 0) <= 0 ? (p.streak || 0) - 1 : -1;
          const newMmr = Math.max(0, p.mmr - loss);
          const newPts = placedBefore ? Math.max(0, (p.pts || 0) - loss) : (p.pts || 0);
          return { ...p, mmr: newMmr, pts: newPts, losses: p.losses + 1, streak: ns };
        }
        return p;
      });

      // Update placement counts and calibrate pts on completion
      allPids.forEach(pid => {
        const before = placementsBefore[pid] || 0;
        newPlacements[monthKey][pid] = before + 1;
        const justCompleted = before + 1 === CONFIG.MAX_PLACEMENTS_PER_MONTH;
        if (justCompleted) {
          // Calibrate: assign pts based on MMR standing relative to already-placed players
          const thisPlayer = newPlayers.find(p => p.id === pid);
          if (thisPlayer) {
            const placedPlayers = newPlayers.filter(p => {
              const pCount = (newPlacements[monthKey][p.id] || 0);
              return p.id !== pid && pCount >= CONFIG.MAX_PLACEMENTS_PER_MONTH;
            });
            // Find where this player's MMR sits among placed players and assign pts accordingly
            const sortedByMmr = [...placedPlayers].sort((a,b)=>(b.mmr||0)-(a.mmr||0));
            const insertRank = sortedByMmr.findIndex(p=>(p.mmr||0)<(thisPlayer.mmr||0));
            const rank = insertRank === -1 ? sortedByMmr.length : insertRank;
            // Pts = median of neighbours, or MMR-derived if no neighbours
            let calibratedPts;
            if (sortedByMmr.length === 0) {
              calibratedPts = Math.round((thisPlayer.mmr - CONFIG.STARTING_MMR) * 0.5);
            } else if (rank === 0) {
              calibratedPts = Math.round((sortedByMmr[0].pts || 0) * 1.1 + 5);
            } else if (rank >= sortedByMmr.length) {
              calibratedPts = Math.max(0, Math.round((sortedByMmr[sortedByMmr.length-1].pts || 0) * 0.9 - 5));
            } else {
              calibratedPts = Math.round(((sortedByMmr[rank-1].pts||0) + (sortedByMmr[rank].pts||0)) / 2);
            }
            newPlayers = newPlayers.map(p => p.id === pid ? { ...p, pts: Math.max(0, calibratedPts) } : p);
          }
        }
      });

      newGames.push({
        id: crypto.randomUUID(), sideA: row.sideA, sideB: row.sideB,
        winner, scoreA: sA, scoreB: sB, ptsGain: gain, ptsLoss: loss,
        mmrGain: gain, mmrLoss: loss, eloScale, rankScale, winMult, lossMult, scoreMult,
        date: new Date().toISOString(), monthKey
      });
    }

    setState(s => ({ ...s, players: newPlayers, games: [...newGames, ...s.games], monthlyPlacements: newPlacements }));
    setRows([EMPTY_ROW()]);
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
    <div className="stack page-fade">
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
              const rankOf = id => currentRanked.findIndex(p=>p.id===id);
              const avgRank = ids => ids.reduce((s,id)=>s+rankOf(id),0)/ids.length;
              prev = calcDelta({
                winnerScore: Math.max(sA, sB), loserScore: Math.min(sA, sB),
                winnerAvgMMR: avg(wIds, state.players, "mmr"), loserAvgMMR: avg(lIds, state.players, "mmr"),
                winnerAvgStreak: avg(wIds, state.players, "streak"), loserAvgStreak: avg(lIds, state.players, "streak"),
                winnerAvgRank: avgRank(wIds), loserAvgRank: avgRank(lIds),
              });
            }

            return (
              <div key={row.id} style={{ marginBottom: 10, padding: 12, background: "var(--s2)", borderRadius: 6, border: "1px solid var(--b1)" }}>
                <div className="fbc mb8">
                  <span className="xs text-dd">Game {ri + 1}</span>
                  {rows.length > 1 && <button className="btn btn-d btn-sm" onClick={() => setRows(r => r.filter(x => x.id !== row.id))}>Remove</button>}
                </div>

                <div className="log-game-grid" style={{ display: "grid", gridTemplateColumns: "1fr 96px 1fr", gap: 10, alignItems: "start" }}>
                  {/* Side A */}
                  <div>
                    <div className="lbl" style={{ color: "var(--green)" }}>Side A</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      {[...state.players].sort((a, b) => (b.pts || 0) - (a.pts || 0)).map(p => {
                        const onA = row.sideA.includes(p.id), onB = row.sideB.includes(p.id), full = !onA && row.sideA.length >= 2;
                        return (
                          <div key={p.id} className={`player-chip ${onA ? "sel-a" : ""} ${onB || full ? "disabled" : ""}`}
                            onClick={() => !onB && !full ? togglePlayer(row.id, "A", p.id) : onA ? togglePlayer(row.id, "A", p.id) : null}>
                            <span>{p.name}</span>
                            <span className="xs text-dd">{p.pts || 0}pts</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Scores / Preview */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 16 }}>
                    <div><div className="lbl">A</div>
                      <input className="inp" type="number" min="0" placeholder="10" value={row.scoreA}
                        onChange={e => setRows(r => r.map(x => x.id === row.id ? { ...x, scoreA: e.target.value } : x))}
                        style={{ textAlign: "center", fontSize: 18, fontFamily: "var(--disp)", fontWeight: 800 }} />
                    </div>
                    <div><div className="lbl">B</div>
                      <input className="inp" type="number" min="0" placeholder="7" value={row.scoreB}
                        onChange={e => setRows(r => r.map(x => x.id === row.id ? { ...x, scoreB: e.target.value } : x))}
                        style={{ textAlign: "center", fontSize: 18, fontFamily: "var(--disp)", fontWeight: 800 }} />
                    </div>

                    {prev && (
                      <div style={{ background: "var(--s1)", borderRadius: 4, padding: "6px 8px", fontSize: 10, textAlign: "center", lineHeight: 1.7 }}>
                        <div className="text-g">+{prev.gain}pts</div>
                        <div className="text-r">-{prev.loss}pts</div>
                        <div className="text-dd">elo {(prev.eloScale * 100).toFixed(0)}%</div>
                        <div className="text-dd">rank ×{prev.rankScale?.toFixed(2)}</div>
                      </div>
                    )}
                  </div>

                  {/* Side B */}
                  <div>
                    <div className="lbl" style={{ color: "var(--blue)" }}>Side B</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      {[...state.players].sort((a, b) => (b.pts || 0) - (a.pts || 0)).map(p => {
                        const onA = row.sideA.includes(p.id), onB = row.sideB.includes(p.id), full = !onB && row.sideB.length >= 2;
                        return (
                          <div key={p.id} className={`player-chip ${onB ? "sel-b" : ""} ${onA || full ? "disabled" : ""}`}
                            onClick={() => !onA && !full ? togglePlayer(row.id, "B", p.id) : onB ? togglePlayer(row.id, "B", p.id) : null}>
                            <span>{p.name}</span>
                            <span className="xs text-dd">{p.pts || 0}pts</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {errors[row.id] && <div className="msg msg-e mt8">{errors[row.id]}</div>}
              </div>
            );
          })}

          <button className="add-row" onClick={() => setRows(r => [...r, EMPTY_ROW()])}>+ Add Another Game</button>

          <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button className="btn btn-p" onClick={submitAll}>Submit All</button>
            <input className="inp" placeholder="Template name…" value={tplName} onChange={e => setTplName(e.target.value)} style={{ width: 150 }} />
            <button className="btn btn-g" onClick={saveTpl}>Save Template</button>
            {undoStack.length > 0 && <button className="btn btn-warn" onClick={undoLast}>↩ Undo Last Submit</button>}
          </div>
        </div>
      </div>
    </div>
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

  // Sync fields if finalsDate changes externally
  useEffect(() => {
    if (!finalsDate) { setDd(""); setMm(""); setYyyy(""); setHh("18"); setMn("00"); return; }
    const p = new Date(finalsDate);
    setDd(String(p.getDate()).padStart(2,"0"));
    setMm(String(p.getMonth()+1).padStart(2,"0"));
    setYyyy(String(p.getFullYear()));
    setHh(String(p.getHours()).padStart(2,"0"));
    setMn(String(p.getMinutes()).padStart(2,"0"));
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
    ["Year", "YYYY", yyyy, setYyyy, 80, 2025, 2099],
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
          <button className="btn btn-p btn-sm" onClick={handleSave}>Save</button>
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

  // ── BRACKET SEEDING ───────────────────────────────────────
  // Build balanced 2v2 teams from top N players respecting position:
  // Each team needs 1 attacker + 1 defender if possible, else flex fills gaps.
  function buildTeam(pool) {
    const atk = pool.find(p => p.position === "attack" || p.position === "both");
    const def = pool.find(p => (p.position === "defense" || p.position === "both") && p.id !== atk?.id);
    if (atk && def) return [atk.id, def.id];
    // Fallback: just take first two
    return pool.slice(0, 2).map(p => p.id);
  }

  // Upper bracket: top 4 players split into 2 teams
  // Lower bracket: players 5-8 split into 2 teams
  function buildBracket(playerPool) {
    if (playerPool.length < 4) return null;
    const top4 = playerPool.slice(0, 4);
    // Seed 1+4 vs 2+3 for balance
    const teamA = [top4[0].id, top4[3].id];
    const teamB = [top4[1].id, top4[2].id];
    return { teamA, teamB };
  }

  const upperPool = ranked.slice(0, 4);
  const lowerPool = ranked.slice(4, 8);

  const previewUpper = upperPool.length >= 4 ? buildBracket(upperPool) : null;
  const previewLower = lowerPool.length >= 4 ? buildBracket(lowerPool) : null;

  // ── INIT FINALS ───────────────────────────────────────────
  function initFinals() {
    if (ranked.length < 4) { showToast("Need at least 4 players", "error"); return; }

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

      // After both semis done, set up grand final
      if (match === "upper" || match === "lower") {
        const uw = b.upper?.winner ? (b.upper.winner === "A" ? b.upper.sideA : b.upper.sideB) : null;
        const lw = b.lower?.winner ? (b.lower.winner === "A" ? b.lower.sideA : b.lower.sideB) : null;
        const needsBoth = !!b.lower;
        if (uw && (!needsBoth || lw)) {
          b.final = {
            sideA: uw,
            sideB: lw || uw, // if no lower bracket, upper winner plays themselves (shouldn't happen)
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

    if (!m || !m.sideA || !m.sideB) {
      return (
        <div>
          <div className="xs text-dd" style={{ textAlign: "center", marginBottom: 5, letterSpacing: 2, textTransform: "uppercase" }}>{label}</div>
          <div className="b-match" style={{ padding: 18, textAlign: "center", color: "var(--dimmer)", fontSize: 12 }}>TBD</div>
        </div>
      );
    }

    const pA = m.sideA.map(id => {
      const pl = state.players.find(p => p.id === id);
      return pl ? { name: pl.name, pos: pl.position } : { name: "?", pos: null };
    });
    const pB = m.sideB.map(id => {
      const pl = state.players.find(p => p.id === id);
      return pl ? { name: pl.name, pos: pl.position } : { name: "?", pos: null };
    });
    const done = !!m.winner;

    return (
      <div>
        <div className="xs text-dd" style={{ textAlign: "center", marginBottom: 5, letterSpacing: 2, textTransform: "uppercase" }}>{label}</div>
        <div style={{ background: "var(--s2)", border: "1px solid var(--b2)", borderRadius: 8, overflow: "hidden", minWidth: 280 }}>
          {/* Team A */}
          <div style={{ padding: "10px 14px", borderBottom: "2px solid var(--b1)", background: m.winner === "A" ? "rgba(30,215,96,.08)" : "transparent", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
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
          <div style={{ padding: "10px 14px", background: m.winner === "B" ? "rgba(30,215,96,.08)" : "transparent", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {pB.map((pl, i) => (
                <div key={i} className="fac" style={{ gap: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: m.winner === "B" ? "var(--green)" : "var(--text)" }}>{pl.name}</span>
                  <PosBadge pos={pl.pos} />
                </div>
              ))}
            </div>
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
            {ranked.length >= 4
              ? isAdmin && <button className="btn btn-p mt8" onClick={initFinals}>Generate Bracket</button>
              : <div className="msg msg-e" style={{ display: "inline-block" }}>Need at least 4 players</div>}
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

  const[state,setState]=useState(SEED);
  const[isAdmin,setIsAdmin]=useState(false);
  const[tab,setTab]=useState("leaderboard");
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

  // autosave — skip on initial load, skip when change came from realtime
  const lastSaveTime = useRef(0);
  const isInitialLoad = useRef(true);
  useEffect(()=>{
    if(!loading){
      if(isInitialLoad.current){ isInitialLoad.current=false; return; }
      if(isRemoteUpdate.current){ isRemoteUpdate.current=false; return; }
      lastSaveTime.current = Date.now();
      saveState(stateRef.current);
    }
  },[state,loading]);

  // ============================================================
  // REALTIME SUBSCRIPTION
  // ============================================================
  const reconnectTimer = useRef(null);

  function subscribeToStateChanges(){
    // Clean up any existing channel first
    if(subscriptionRef.current){
      supabase.removeChannel(subscriptionRef.current);
      subscriptionRef.current = null;
    }

    const channel = supabase
      .channel('app_state_changes_' + Date.now())
      .on(
        'postgres_changes',
        {event:'UPDATE',schema:'public',table:'app_state',filter:'id=eq.1'},
        (payload)=>{
          // Ignore echoes from our own saves (within 5s window)
          if(Date.now() - lastSaveTime.current < 5000) return;
          isRemoteUpdate.current=true;
          setState(normaliseState(payload.new.state || {}));
        }
      )
      .on(
        'postgres_changes',
        {event:'INSERT',schema:'public',table:'app_state',filter:'id=eq.1'},
        (payload)=>{
          if(Date.now() - lastSaveTime.current < 5000) return;
          isRemoteUpdate.current=true;
          setState(normaliseState(payload.new.state || {}));
        }
      )
      .subscribe((status)=>{
        console.log('Realtime status:', status);
        if(status==='SUBSCRIBED'){
          setRtConnected(true);
          clearTimeout(reconnectTimer.current);
        }
        if(status==='CHANNEL_ERROR'||status==='CLOSED'){
          setRtConnected(false);
          clearTimeout(reconnectTimer.current);
          reconnectTimer.current = setTimeout(()=>subscribeToStateChanges(), 5000);
        }
      });

    subscriptionRef.current = channel;
  }

  // ============================================================
  // TOAST
  // ============================================================
  const showToast = useCallback((msg,type="success")=>{
    setToast({msg,type});
    setTimeout(()=>setToast(null),3500);
  },[]);

  // ============================================================
  // NAV
  // ============================================================
  const PUB = ["leaderboard","history","finals","rules"];

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

          <div className="brand">
            St. Marylebone <span className="brand-sub">Table Tracker</span>
          </div>

          {/* Desktop nav */}
          <nav className="nav">
            {PUB.map(t=>(
              <button key={t} className={`nav-btn ${tab===t?"active":""}`} onClick={()=>navTo(t)}>
                {t}
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

        {/* Mobile nav dropdown */}
        <div className={`mob-nav ${mobMenuOpen?"open":""}`}>
          {PUB.map(t=>(
            <button key={t} className={`nav-btn ${tab===t?"active":""}`} onClick={()=>navTo(t)}>
              {t}
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

          {tab==="leaderboard" && (
            <LeaderboardView
              state={state}
              rtConnected={rtConnected}
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

          {tab==="finals" && (
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
