import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Upload, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { Trophy, Medal, Swords, Shield, ArrowUpDown, Check, X, AlertTriangle, Flag, BarChart3, Scale, Settings, RotateCcw, Plus, History, CalendarDays, ListOrdered, Users, Megaphone, Download, DatabaseBackup, UserCog, Activity, BookOpen, Menu, LogOut, LogIn, ChevronDown, Zap, Pencil, Circle, Search, RectangleVertical, Play } from "lucide-react";

const icons = { trophy:Trophy, medal:Medal, swords:Swords, shield:Shield, swap:ArrowUpDown, check:Check, x:X, warning:AlertTriangle, flag:Flag, chart:BarChart3, balance:Scale, settings:Settings, reset:RotateCcw, plus:Plus, history:History, calendar:CalendarDays, ranks:ListOrdered, users:Users, announcement:Megaphone, download:Download, recovery:DatabaseBackup, accounts:UserCog, activity:Activity, rules:BookOpen, menu:Menu, logout:LogOut, login:LogIn, chevron:ChevronDown, zap:Zap, edit:Pencil, circle:Circle, search:Search };
export function UiIcon({ name, size = 18, label, ...props }) {
  const Icon = name === "red-card" || name === "yellow-card" ? RectangleVertical : name === "play" ? Play : ({upload:Upload,trash:Trash2,previous:ChevronLeft,next:ChevronRight}[name] || icons[name] || Circle);
  return <Icon size={size} strokeWidth={1.75} color={name === "red-card" ? "var(--red)" : name === "yellow-card" ? "var(--gold)" : undefined} className="ui-icon" aria-hidden={label ? undefined : true} aria-label={label} role={label ? "img" : undefined} {...props} />;
}

export const destinations = [ ["ranks","Ranks","ranks"], ["history","History","history"], ["play","Champions","trophy"], ["seasons","Seasons","calendar"] ];
const validViews = new Set(["ranks","stats","history","play","seasons","rules","admin"]);
const validTasks = new Set(["onboard","logGames","announcements","exports","recovery","access","accounts","roles","diagnostics","advanced"]);
export function readLocation() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const view = params.get("view");
  return { view:validViews.has(view) ? view : "ranks", task:validTasks.has(params.get("task")) ? params.get("task") : "onboard", season:params.get("season") || "current" };
}
export function useLeagueNavigation() {
  const [location,setLocation] = useState(readLocation);
  const [visited,setVisited] = useState(() => new Set([location.view]));
  const positions = useRef({});
  const key = `${location.view}/${location.task}`;
  const keyRef = useRef(key);
  useEffect(() => {
    const change = () => { positions.current[keyRef.current] = window.scrollY; setLocation(readLocation()); };
    window.addEventListener("hashchange",change);
    return () => window.removeEventListener("hashchange",change);
  },[]);
  useLayoutEffect(() => {
    keyRef.current = key;
    setVisited(prev => new Set([...prev,location.view]));
    window.scrollTo(0,positions.current[key] || 0);
  },[key,location.view]);
  function navigate(view,task = location.task,season = location.season) {
    positions.current[key] = window.scrollY;
    const params = new URLSearchParams({view});
    if(view === "admin") params.set("task",task);
    if(season !== "current") params.set("season",season);
    window.history.pushState(null,"",`#${params}`);
    setLocation({view,task,season});
  }
  return { ...location, navigate, visited };
}

export function LeagueHeader({ view, task, navigate, profile, connected, onLogin, onLogout, onAccount, onLogGame, loading }) {
  const [open,setOpen] = useState(false);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);
  const active = view === "stats" ? "ranks" : view;
  const staff = ["referee", "gameadmin", "sysadmin"].includes(profile?.role);
  useEffect(() => {
    if(!open) return;
    const close = e => { if(!menuRef.current?.contains(e.target) && !triggerRef.current?.contains(e.target)) setOpen(false); };
    const escape = e => { if(e.key === "Escape") {setOpen(false);triggerRef.current?.focus();} };
    document.addEventListener("pointerdown",close);
    document.addEventListener("keydown",escape);
    return () => {document.removeEventListener("pointerdown",close);document.removeEventListener("keydown",escape);};
  },[open]);
  function go(v,t) {setOpen(false);navigate(v,t);}
  return <>
    <a className="skip-link" href="#main-content" onClick={e=>{e.preventDefault();const main=document.getElementById("main-content");main?.focus();main?.scrollIntoView();}}>Skip to content</a>
    <header className="league-header">
      <div className="league-header-inner">
        <button className="league-brand" onClick={()=>go("ranks")}><strong>St. Marylebone</strong><span>Table Tracker</span></button>
        <nav className="league-nav" aria-label="Primary">
          {destinations.map(([id,label])=><button key={id} aria-current={active===id?"page":undefined} className={active===id?"active":""} onClick={()=>go(id)}>{label}</button>)}
        </nav>
        <div className="league-actions">
          <span className={`connection-label ${connected?"connected":""}`} title={connected?"Live connection":"Connection unavailable"}><i />{loading?"Loading":connected?"Live":"Offline"}</span>
          {staff && <button className="btn btn-g manage-action" onClick={()=>go("admin","onboard")} aria-current={view==="admin"&&task!=="logGames"?"page":undefined}>Manage</button>}
          {profile && <button className="btn btn-p log-action" onClick={()=>staff ? go("admin","logGames") : onLogGame?.()}><UiIcon name="plus" /><span>Log game</span></button>}
          <button ref={triggerRef} className="icon-button" title="Menu" aria-label="Menu" aria-expanded={open} aria-controls="league-menu" onClick={()=>setOpen(v=>!v)}><UiIcon name={open?"x":"menu"}/></button>
        </div>
        {open && <nav id="league-menu" ref={menuRef} className="league-menu" aria-label="Utilities">
          <button onClick={()=>go("rules")}><UiIcon name="rules"/>Rules</button>
          {staff && <button onClick={()=>go("admin","onboard")}><UiIcon name="settings"/>Manage</button>}
          {profile && <span className="menu-identity">{profile.username || profile.call_sign}<small>{profile.role}</small></span>}
          {onAccount && <button onClick={()=>{setOpen(false);onAccount();}}><UiIcon name="users"/>{profile ? "My account" : "Player account"}</button>}
          <button onClick={()=>{setOpen(false);profile?onLogout():onLogin();}}><UiIcon name={profile?"logout":"login"}/>{profile?"Sign out":"Admin sign in"}</button>
        </nav>}
      </div>
    </header>
    <nav className="league-bottom-nav" aria-label="Mobile primary">
      {destinations.map(([id,label,icon])=><button key={id} aria-current={active===id?"page":undefined} onClick={()=>go(id)}><UiIcon name={icon}/><span>{label}</span></button>)}
    </nav>
  </>;
}

export function RanksHeading({ view, navigate, seasonLabel }) {
  return <div className="page-heading"><div className="heading-identity"><h1>Ranks</h1><span className="season-context">{seasonLabel || "Current season"}</span></div><nav className="segmented" aria-label="Ranks views"><button aria-current={view==="ranks"?"page":undefined} onClick={()=>navigate("ranks")}>Standings</button><button aria-current={view==="stats"?"page":undefined} onClick={()=>navigate("stats")}>Stats</button></nav></div>;
}

export const managementTasks = [["onboard","Roster","users"],["announcements","Announcements","announcement"],["exports","Exports","download"],["recovery","Recovery","recovery"],["access","Access control","accounts"],["diagnostics","Diagnostics","activity"]];
export function ManagementNav({ task,navigate,profile,playerCount }) {
  return <nav className="management-nav" aria-label="Management workspace">
    <span className="workspace-label">Workspace</span>
    {managementTasks.filter(([id])=>(id!=="accounts"&&id!=="roles")||profile?.role==="sysadmin").map(([id,label,icon])=><button key={id} aria-current={task===id?"page":undefined} onClick={()=>navigate("admin",id)}><UiIcon name={icon}/>{label}{id === "onboard" && <span className="workspace-count">{playerCount}</span>}</button>)}
    <button className="management-rulebook" onClick={()=>navigate("rules")}><UiIcon name="rules"/>Rulebook</button>
  </nav>;
}

export function LeagueSkeleton() {
  return <div className="league-skeleton" role="status" aria-label="Loading league" aria-busy="true"><span className="sr-only">Loading league</span><div className="page-heading"><div className="skeleton-line skeleton-heading"/><div className="skeleton-line skeleton-control"/></div><div className="skeleton-race"><div className="skeleton-line skeleton-title"/><div className="skeleton-race-columns">{[0,1,2,3].map(i=><div key={i} className="skeleton-line"/>)}</div></div><div className="skeleton-table">{Array.from({length:8},(_,i)=><div key={i} className="skeleton-row"><div className="skeleton-line"/><div className="skeleton-line"/><div className="skeleton-line"/><div className="skeleton-line"/></div>)}</div></div>;
}

export function RecentResults({ games, players, onOpen }) {
  const recent = [...games].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,3);
  if (!recent.length) return null;
  return <section className="recent-results"><div className="card-header"><h2 className="card-title">Recent results</h2><button className="btn btn-g btn-sm" onClick={onOpen}>View history</button></div>
    {recent.map(game => <button key={game.id} className="game-row recent-result-button" onClick={onOpen}>
      {["A","score","B"].map(side => side === "score" ? <div key={side}><div className="g-score">{game.scoreA} : {game.scoreB}</div><div className="g-date">{new Date(game.date).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</div></div> : <div key={side} className={`g-side ${side === "B" ? "right" : ""}`}>{game[`side${side}`].map(id => {
        const winner=game.winner===side;
        const delta=winner ? game.perPlayerGains?.[id] ?? game.ptsGain : game.perPlayerLosses?.[id] ?? game.ptsLoss;
        return <div key={id}><span className={winner?"g-name-w":"g-name-l"}>{players.find(p=>p.id===id)?.name || "Removed player"}</span>{delta !== undefined && <span className={`g-delta ${winner?"text-g":"text-r"}`}>{winner?"+":"-"}{delta}</span>}</div>;
      })}</div>)}
    </button>)}
  </section>;
}

export function EventCountdown({ days,hours,mins,secs,diff,complete }) {
  return <div className={`event-countdown ${diff>0&&diff<86400000?"final-day":""} ${diff>0&&diff<=3600000?"final-hour":""} ${diff>0&&diff<=60000?"final-minute":""} ${complete?"event-complete":""}`}>
    <span className="countdown-keyline" aria-hidden="true" />
    {complete ? <span className="event-finished"><UiIcon name="trophy"/>Competition complete</span> : <>
      <div className="cd-wrap" role="timer" aria-label="Time until scheduled finals" aria-live="off">{[["Days",days],["Hours",hours],["Mins",mins],["Secs",secs]].map(([label,value])=><div className="cd-unit" key={label}><div className="cd-num"><span key={label === "Secs" ? "seconds" : value}>{value}</span></div><div className="cd-lbl">{label}</div></div>)}</div>
      <div className="countdown-tempo" aria-hidden="true"><span key={`${days}:${hours}:${mins}:${diff>0&&diff<=10000 ? "closing" : "normal"}`}/></div>
      <p className="countdown-status">{diff<=0 ? "Scheduled time reached" : diff<=60000 ? "Final minute" : diff<=3600000 ? "Less than an hour to go" : diff<86400000 ? "Under 24 hours to go" : "The countdown is on"}</p>
    </>}
  </div>;
}
