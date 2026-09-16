// Shared browser/server scoring. Preserve coefficients and legacy replay semantics.
export const CONFIG = {
  // ADMIN_PASSWORD removed (Phase 1) -- auth now goes through Supabase Auth via authClient.js.
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
  MAX_PLACEMENTS_PER_MONTH: 3,
  YELLOW_CARD_PTS: 5,
  RED_CARD_PTS: 20,
};

export function sortByDate(items, descending = false) {
  return [...items].sort((a, b) =>
    descending
      ? new Date(b.date) - new Date(a.date)
      : new Date(a.date) - new Date(b.date),
  );
}

export function sortByPoints(players, descending = true) {
  return [...players].sort((a, b) =>
    descending ? (b.pts || 0) - (a.pts || 0) : (a.pts || 0) - (b.pts || 0),
  );
}

export function streakMult(streakPower, isWinner) {
  const power = Math.max(0, streakPower || 0);
  const t = Math.tanh(power / CONFIG.STREAK_POWER_SCALE);
  const cap = isWinner ? CONFIG.STREAK_WIN_MAX : CONFIG.STREAK_LOSS_MAX;
  return 1 + t * cap;
}

export function updateStreakPower(currentPower, isWin, qualityScore) {
  if (!isWin) return 0;
  const base = currentPower || 0;
  const decayed =
    qualityScore < CONFIG.STREAK_DECAY_THRESHOLD
      ? base * CONFIG.STREAK_QUALITY_DECAY
      : base;
  return Math.min(decayed + qualityScore, CONFIG.STREAK_WINDOW * 2);
}

export function avg(ids, players, key) {
  const found = ids
    .map((id) => players.find((p) => p.id === id))
    .filter(Boolean);
  if (!found.length) return key === "mmr" ? CONFIG.STARTING_MMR : 0;
  return found.reduce((s, p) => s + (p[key] || 0), 0) / found.length;
}

export function avgWithMap(ids, playerMap, key) {
  const found = ids.map((id) => playerMap.get(id)).filter(Boolean);
  if (!found.length) return key === "mmr" ? CONFIG.STARTING_MMR : 0;
  return found.reduce((s, p) => s + (p[key] || 0), 0) / found.length;
}

export function computePlacements(games, seasons) {
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

export function replayGames(basePlayers, games, seasonStart, seasons) {
  let players = basePlayers.map((p) => ({
    ...p,
    mmr: CONFIG.STARTING_MMR,
    pts: CONFIG.STARTING_PTS,
    mmr_atk: CONFIG.STARTING_MMR,
    mmr_def: CONFIG.STARTING_MMR,
    wins: 0,
    losses: 0,
    streak: 0,
    streakPower: 0,
    wins_atk: 0,
    losses_atk: 0,
    wins_def: 0,
    losses_def: 0,
  }));
  const seasonStartDate = seasonStart ? new Date(seasonStart) : null;
  const sorted = sortByDate(games);
  let playerMap = new Map(basePlayers.map((p) => [p.id, p]));
  const placementCount = {};
  const updatedGames = sorted.map((g) => {
    const gameDate = g.date ? new Date(g.date) : null;
    const inSeason =
      !seasonStartDate || !gameDate || gameDate >= seasonStartDate;
    const winIds = g.winner === "A" ? g.sideA : g.sideB;
    const losIds = g.winner === "A" ? g.sideB : g.sideA;
    const mk = getGamePlacementKey(g, seasons);
    const monthPlacements = placementCount[mk] || {};
    const isPlacedAtGameTime = (pid) =>
      (monthPlacements[pid] || 0) >= CONFIG.MAX_PLACEMENTS_PER_MONTH;
    const allPids = [...winIds, ...losIds];
    const ranked = sortByPoints(players);
    const rankOf = (id) => {
      const i = ranked.findIndex((p) => p.id === id);
      return i === -1 ? ranked.length : i;
    };
    playerMap = new Map(players.map((p) => [p.id, p]));
    const oppAvgMMR = (ids) => avgWithMap(ids, playerMap, "mmr");
    const oppAvgRankPlaced = (ids) => {
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
    const atkRanked = [...players].sort(
      (a, b) =>
        (b.mmr_atk ?? CONFIG.STARTING_MMR) - (a.mmr_atk ?? CONFIG.STARTING_MMR),
    );
    const defRanked = [...players].sort(
      (a, b) =>
        (b.mmr_def ?? CONFIG.STARTING_MMR) - (a.mmr_def ?? CONFIG.STARTING_MMR),
    );
    const atkRankOf = (id) => {
      const i = atkRanked.findIndex((p) => p.id === id);
      return i === -1 ? atkRanked.length : i;
    };
    const defRankOf = (id) => {
      const i = defRanked.findIndex((p) => p.id === id);
      return i === -1 ? defRanked.length : i;
    };
    const playerDeltas = {};
    allPids.forEach((pid) => {
      const p = playerMap.get(pid);
      if (!p) return;
      const isWinner = winIds.includes(pid);
      const myPlaced = isPlacedAtGameTime(pid);
      const oppRankPlaced = isWinner ? oppLosRankPlaced : oppWinRankPlaced;
      const myRole = gameRoles[pid];
      const oppIds = isWinner ? losIds : winIds;
      let playerMMR, oppMMRval, playerRank, oppRankVal;
      if (hasRoles && myRole && myRole !== "FLEX") {
        const oppRole = myRole === "ATK" ? "DEF" : "ATK";
        const oppMatchId = oppIds.find((id) => gameRoles[id] === oppRole);
        const oppMatch = oppMatchId ? playerMap.get(oppMatchId) : null;
        if (myRole === "ATK") {
          playerMMR = p.mmr_atk ?? p.mmr;
          oppMMRval = oppMatch
            ? (oppMatch.mmr_def ?? oppMatch.mmr)
            : isWinner
              ? oppLosMMR
              : oppWinMMR;
          playerRank = myPlaced ? atkRankOf(pid) : null;
          oppRankVal =
            myPlaced && oppMatchId && isPlacedAtGameTime(oppMatchId)
              ? defRankOf(oppMatchId)
              : null;
        } else {
          playerMMR = p.mmr_def ?? p.mmr;
          oppMMRval = oppMatch
            ? (oppMatch.mmr_atk ?? oppMatch.mmr)
            : isWinner
              ? oppLosMMR
              : oppWinMMR;
          playerRank = myPlaced ? defRankOf(pid) : null;
          oppRankVal =
            myPlaced && oppMatchId && isPlacedAtGameTime(oppMatchId)
              ? atkRankOf(oppMatchId)
              : null;
        }
      } else {
        playerMMR = p.mmr;
        oppMMRval = isWinner ? oppLosMMR : oppWinMMR;
        playerRank = myPlaced ? rankOf(pid) : null;
        oppRankVal = myPlaced && oppRankPlaced !== null ? oppRankPlaced : null;
      }
      const d = calcPlayerDelta({
        winnerScore,
        loserScore,
        playerMMR,
        playerRank,
        playerStreakPower: p.streakPower || 0,
        oppAvgMMR: oppMMRval,
        oppAvgRank: oppRankVal,
        isWinner,
        playerRole: myRole,
        playerPreferredRole: p.preferredRole,
      });
      playerDeltas[pid] = { ...d, role: myRole || null };
    });
    if (!placementCount[mk]) placementCount[mk] = {};
    allPids.forEach((pid) => {
      placementCount[mk][pid] = (placementCount[mk][pid] || 0) + 1;
    });
    players = players.map((p) => {
      const d = playerDeltas[p.id];
      if (!d) return p;
      const isWin = winIds.includes(p.id);
      const role = d.role;
      if (isWin) {
        const base = {
          ...p,
          wins: p.wins + 1,
          wins_atk: (p.wins_atk || 0) + (role === "ATK" ? 1 : 0),
          wins_def: (p.wins_def || 0) + (role === "DEF" ? 1 : 0),
        };
        if (!inSeason) return base;
        const ns = (p.streak || 0) >= 0 ? (p.streak || 0) + 1 : 1;
        const newPower = updateStreakPower(
          p.streakPower || 0,
          true,
          d.qualityScore || 1,
        );
        const newAtk =
          role === "ATK" ? (p.mmr_atk ?? p.mmr) + d.gain : (p.mmr_atk ?? p.mmr);
        const newDef =
          role === "DEF" ? (p.mmr_def ?? p.mmr) + d.gain : (p.mmr_def ?? p.mmr);
        const newMMR =
          role && role !== "FLEX"
            ? Math.round((newAtk + newDef) / 2)
            : p.mmr + d.gain;
        return {
          ...base,
          mmr: newMMR,
          mmr_atk: newAtk,
          mmr_def: newDef,
          pts: (p.pts || 0) + d.gain,
          streak: ns,
          streakPower: newPower,
        };
      }
      const base = {
        ...p,
        losses: p.losses + 1,
        losses_atk: (p.losses_atk || 0) + (role === "ATK" ? 1 : 0),
        losses_def: (p.losses_def || 0) + (role === "DEF" ? 1 : 0),
      };
      if (!inSeason) return base;
      const ns = (p.streak || 0) <= 0 ? (p.streak || 0) - 1 : -1;
      const newAtk =
        role === "ATK"
          ? Math.max(0, (p.mmr_atk ?? p.mmr) - d.loss)
          : (p.mmr_atk ?? p.mmr);
      const newDef =
        role === "DEF"
          ? Math.max(0, (p.mmr_def ?? p.mmr) - d.loss)
          : (p.mmr_def ?? p.mmr);
      const newMMR =
        role && role !== "FLEX"
          ? Math.round((newAtk + newDef) / 2)
          : Math.max(0, p.mmr - d.loss);
      return {
        ...base,
        mmr: newMMR,
        mmr_atk: newAtk,
        mmr_def: newDef,
        pts: Math.max(0, (p.pts || 0) - d.loss),
        streak: ns,
        streakPower: 0,
      };
    });
    if (g.penalties && inSeason) {
      players = players.map((p) => {
        const pen = g.penalties[p.id];
        if (!pen) return p;
        const deduct =
          (pen.yellow || 0) * CONFIG.YELLOW_CARD_PTS +
          (pen.red || 0) * CONFIG.RED_CARD_PTS;
        if (!deduct) return p;
        return { ...p, pts: Math.max(0, (p.pts || 0) - deduct) };
      });
    }
    const perPlayerGains = {},
      perPlayerLosses = {},
      perPlayerFactors = {};
    winIds.forEach((id) => {
      if (playerDeltas[id]) {
        perPlayerGains[id] = playerDeltas[id].gain;
        perPlayerFactors[id] = {
          eloScale: +playerDeltas[id].eloScale.toFixed(3),
          rankScale: +playerDeltas[id].rankScale.toFixed(3),
          matchQuality: +playerDeltas[id].matchQuality.toFixed(3),
          qualityScore: +playerDeltas[id].qualityScore.toFixed(3),
          roleMult: +(playerDeltas[id].roleMult || 1).toFixed(3),
        };
      }
    });
    losIds.forEach((id) => {
      if (playerDeltas[id]) {
        perPlayerLosses[id] = playerDeltas[id].loss;
        perPlayerFactors[id] = {
          eloScale: +playerDeltas[id].eloScale.toFixed(3),
          rankScale: +playerDeltas[id].rankScale.toFixed(3),
          matchQuality: +playerDeltas[id].matchQuality.toFixed(3),
          qualityScore: +playerDeltas[id].qualityScore.toFixed(3),
          roleMult: +(playerDeltas[id].roleMult || 1).toFixed(3),
        };
      }
    });
    const avgGain = Math.round(
      winIds.reduce((s, id) => s + (playerDeltas[id]?.gain || 0), 0) /
        Math.max(winIds.length, 1),
    );
    const avgLoss = Math.round(
      losIds.reduce((s, id) => s + (playerDeltas[id]?.loss || 0), 0) /
        Math.max(losIds.length, 1),
    );
    return {
      ...g,
      ptsGain: avgGain,
      ptsLoss: avgLoss,
      mmrGain: avgGain,
      mmrLoss: avgLoss,
      perPlayerGains,
      perPlayerLosses,
      perPlayerFactors,
    };
  });
  return { players, games: updatedGames };
}

export function calcPlayerDelta({
  winnerScore,
  loserScore,
  playerMMR,
  playerRank,
  playerStreakPower,
  oppAvgMMR,
  oppAvgRank,
  isWinner,
  playerRole,
  playerPreferredRole,
}) {
  const scoreDiff = winnerScore - loserScore;
  const scoreRatio = scoreDiff / Math.max(winnerScore, 1);
  const scoreMult =
    1 + CONFIG.SCORE_WEIGHT * Math.pow(scoreRatio, CONFIG.SCORE_EXP);
  const mmrGap = playerMMR - oppAvgMMR;
  const eloScale = 2 / (1 + Math.exp(mmrGap / CONFIG.ELO_DIVISOR));
  const rankDifficulty =
    playerRank === null || oppAvgRank === null
      ? 1.0
      : 1 +
        CONFIG.RANK_WEIGHT *
          Math.tanh((playerRank - oppAvgRank) / CONFIG.RANK_DIVISOR);
  const rankScale = rankDifficulty;
  const matchQuality = (() => {
    const elo = eloScale,
      rank = rankDifficulty;
    if (rank >= 1.0 && elo >= 1.0) return Math.max(elo, 0.7 * elo + 0.3 * rank);
    if (rank <= 1.0 && elo <= 1.0) return Math.max(0.7 * elo + 0.3 * rank, elo);
    if (rank > elo) return Math.min(1.0, 0.7 * elo + 0.3 * rank);
    return elo;
  })();
  const mult = streakMult(playerStreakPower, isWinner);
  const qualityScore = matchQuality;
  // FLEX is neutral (§3.6 — in position or FLEX = 1.0). Out-of-position = asymmetric bonus.
  const isOutOfPosition = !!(
    playerRole &&
    playerRole !== "FLEX" &&
    playerPreferredRole &&
    playerPreferredRole !== "FLEX" &&
    playerPreferredRole !== playerRole
  );
  const roleGainMult = isOutOfPosition ? CONFIG.ROLE_ALIGN_BONUS : 1.0;
  const roleLossMult = isOutOfPosition ? 1 / CONFIG.ROLE_ALIGN_BONUS : 1.0;
  const roleMult = roleGainMult;
  if (isWinner) {
    const gain = Math.max(
      2,
      Math.round(
        CONFIG.BASE_GAIN * scoreMult * matchQuality * mult * roleGainMult,
      ),
    );
    return {
      gain,
      loss: 0,
      scoreMult,
      eloScale,
      rankScale,
      matchQuality,
      streakMultVal: mult,
      qualityScore,
      roleMult: roleGainMult,
      roleLossMult,
    };
  } else {
    const loss = Math.max(
      1,
      Math.round(
        CONFIG.BASE_LOSS *
          scoreMult *
          (2 - matchQuality) *
          mult *
          CONFIG.LOSS_HARSHNESS *
          roleLossMult,
      ),
    );
    return {
      gain: 0,
      loss,
      scoreMult,
      eloScale,
      rankScale,
      matchQuality,
      streakMultVal: mult,
      qualityScore,
      roleMult: roleGainMult,
      roleLossMult,
    };
  }
}

export function calcDelta({
  winnerScore,
  loserScore,
  winnerAvgMMR,
  loserAvgMMR,
  winnerAvgStreakPower,
  loserAvgStreakPower,
  winnerAvgRank,
  loserAvgRank,
}) {
  const scoreDiff = winnerScore - loserScore;
  const scoreRatio = scoreDiff / Math.max(winnerScore, 1);
  const scoreMult =
    1 + CONFIG.SCORE_WEIGHT * Math.pow(scoreRatio, CONFIG.SCORE_EXP);
  const mmrGap = winnerAvgMMR - loserAvgMMR;
  const eloScale = 2 / (1 + Math.exp(mmrGap / CONFIG.ELO_DIVISOR));
  const rankDiff = (loserAvgRank ?? 0) - (winnerAvgRank ?? 0);
  const rankScale =
    1 + CONFIG.RANK_WEIGHT * Math.tanh(rankDiff / CONFIG.RANK_DIVISOR);
  const winMult = streakMult(winnerAvgStreakPower ?? 0, true);
  const lossMult = streakMult(loserAvgStreakPower ?? 0, false);
  const gain = Math.max(
    2,
    Math.round(CONFIG.BASE_GAIN * scoreMult * eloScale * rankScale * winMult),
  );
  const loss = Math.max(
    1,
    Math.round(
      CONFIG.BASE_LOSS *
        scoreMult *
        (2 - eloScale) *
        (2 - rankScale) *
        lossMult *
        CONFIG.LOSS_HARSHNESS,
    ),
  );
  return { gain, loss, eloScale, rankScale, winMult, lossMult, scoreMult };
}

export function getGamePlacementKey(game, seasons) {
  if (!seasons?.length) return "all";
  const gameDate = game.date ? new Date(game.date) : null;
  if (!gameDate) return "all";

  // Strip time for date-only comparison
  const toDateOnly = (d) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const gameDay = toDateOnly(gameDate);

  const season = [...seasons]
    .sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt))
    .find((s) => {
      const startDate = s.startAt ? new Date(s.startAt) : null;
      if (!startDate || isNaN(startDate)) return false;
      const startDay = toDateOnly(startDate);
      const endDay = s.endAt ? toDateOnly(new Date(s.endAt)) : null;
      // Game is on/after season start and before/equal to season end
      return gameDay >= startDay && (!endDay || gameDay <= endDay);
    });
  return season ? `season_${season.id}` : "all";
}
