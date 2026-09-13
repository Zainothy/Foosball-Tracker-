import { UiIcon } from "./LeagueUI";

function MatchTeam({ ids, game, side, names }) {
  const won = game.winner === side;
  return <span className={`history-team ${won ? "is-winner" : ""}`}>
    <span className="history-team-label">Team {side}{won && <span><UiIcon name="check" size={12}/>Win</span>}</span>
    {ids.map(id => {
      const delta = won
        ? (game.perPlayerGains?.[id] ?? game.playerDeltas?.[id]?.gain ?? game.ptsGain)
        : (game.perPlayerLosses?.[id] ?? game.playerDeltas?.[id]?.loss ?? game.ptsLoss);
      const role = game.roles?.[id];
      return <span key={id} className="history-player">
        <span className="history-player-name">{names.get(id) || "?"}</span>
        <span className="history-player-meta">
          {role && <span className={`role-tag role-${role.toLowerCase()}`}>{role}</span>}
          <span className={won ? "text-g" : "text-r"}>{delta == null ? "-" : `${won ? "+" : "−"}${delta}`}<span className="history-points-unit"> pts</span></span>
        </span>
      </span>;
    })}
  </span>;
}

export function HistoryRecords({ groups, players, onSelect }) {
  const names = new Map(players.map(player => [player.id,player.name]));
  return <div className="history-timeline">{groups.map(({day,games}) => <section className="history-day" key={day} aria-label={day}>
    <header className="history-day-heading"><h2><UiIcon name="calendar" size={16}/>{day}</h2><span>{games.length} {games.length === 1 ? "game" : "games"}</span></header>
    <div className="history-day-records">{games.map(game => {
      const time = new Date(game.date).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"});
      const penalties = Object.values(game.penalties || {});
      return <button className="history-match" key={game.id} onClick={() => onSelect(game.id)} aria-label={`Match detail: ${game.sideA.map(id => names.get(id) || "?").join(" and ")} versus ${game.sideB.map(id => names.get(id) || "?").join(" and ")}, ${game.scoreA} to ${game.scoreB}, ${day} at ${time}`}>
        <span className="history-match-time"><time dateTime={game.date}>{time}</time><span>2 v 2</span></span>
        <MatchTeam ids={game.sideA} game={game} side="A" names={names}/>
        <span className="history-result"><strong><span className={game.winner === "A" ? "text-g" : ""}>{game.scoreA}</span><span className="history-score-divider">-</span><span className={game.winner === "B" ? "text-g" : ""}>{game.scoreB}</span></strong><span>Final score</span>
          {(penalties.some(p => p.red > 0) || penalties.some(p => p.yellow > 0)) && <span className="history-cards">{penalties.some(p => p.red > 0) && <UiIcon name="red-card" label="Red card" size={14}/>} {penalties.some(p => p.yellow > 0) && <UiIcon name="yellow-card" label="Yellow card" size={14}/>}</span>}
        </span>
        <MatchTeam ids={game.sideB} game={game} side="B" names={names}/>
        <span className="history-open" aria-hidden="true"><UiIcon name="next"/></span>
      </button>;
    })}</div>
  </section>)}</div>;
}
