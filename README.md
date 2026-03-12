# ⚽ Foosball MMR

A ranked table football leaderboard with hidden MMR, visible points, streaks, monthly finals, and a full admin panel. Single-file React app — no backend required.

---

## Quick start (local dev)

### Prerequisites
- **Node.js 18+** — download from [nodejs.org](https://nodejs.org). Use the LTS version.
- **Git** — download from [git-scm.com](https://git-scm.com)
- A terminal (Terminal on Mac, Git Bash / PowerShell on Windows)

### First-time setup

```bash
# 1. Clone the repo (after you've pushed it to GitHub)
git clone https://github.com/YOUR_USERNAME/foosball-mmr.git
cd foosball-mmr

# 2. Install dependencies
npm install

# 3. Start the dev server
npm run dev
```

Your browser will open at **http://localhost:5173** automatically.
The page hot-reloads every time you save a file — no refresh needed.

### Making a change

1. Open `src/App.jsx` in any editor (VS Code recommended)
2. Edit and save
3. The browser updates instantly

---

## Project structure

```
foosball-mmr/
├── index.html          ← HTML shell (don't edit this)
├── vite.config.js      ← Build config (don't edit this)
├── package.json        ← Dependencies
├── .gitignore
└── src/
    ├── main.jsx        ← React entry point (don't edit this)
    └── App.jsx         ← THE ENTIRE APP — edit this
```

All game logic, UI, and styles live in `src/App.jsx`. The `CONFIG` object at the top is the only thing you should need to change before launching.

---

## Before your first season — checklist

**1. Change the admin password**

Open `src/App.jsx`, find line ~8:
```js
ADMIN_PASSWORD: "admin123",
```
Change it to something only you know.

**2. Review CONFIG constants**

All tunable values are in the `CONFIG` object at the top of `src/App.jsx`:

| Key | Default | What it does |
|-----|---------|--------------|
| `STARTING_MMR` | 1000 | Hidden matchmaking rating — don't touch mid-season |
| `STARTING_PTS` | 0 | Starting visible points |
| `BASE_GAIN` | 12 | Points won in a perfectly average game |
| `BASE_LOSS` | 5 | Points lost in a perfectly average game |
| `SCORE_BONUS_RATE` | 0.025 | Extra gain per goal difference |
| `SCORE_LOSS_RATE` | 0.04 | Extra loss per goal difference |
| `ELO_DIVISOR` | 300 | How much hidden MMR gap affects gains |
| `PTS_LOSS_DIVISOR` | 120 | How much points gap affects losses |
| `STREAK_CAP` | 2.5 | Maximum streak multiplier |
| `MAX_PLACEMENTS_PER_MONTH` | 4 | Games per player per calendar month |

**3. Clear seed data (optional)**

The app ships with 6 demo players and 3 demo games. To wipe them and start fresh:
- Open the app, log in as admin, go to **Onboard → Roster** and remove all players
- Or: in your browser console, run `localStorage.removeItem("foosball_v4")` and refresh

---

## Hosting (free)

### Option A — Vercel (recommended, 2 minutes)

Vercel auto-deploys from GitHub on every push. Free tier is more than enough.
GitHub Student Developer Pack gives you Vercel Pro for free, but you won't need it.

```bash
# 1. Push your project to GitHub (see below)

# 2. Go to vercel.com → New Project → Import your repo
# 3. Framework preset: Vite (auto-detected)
# 4. Click Deploy — done.
```

Your app will be live at `https://foosball-mmr.vercel.app` (or similar).
Every `git push` to `main` will auto-deploy within ~30 seconds.

**Custom domain (optional, free with Student Pack):**
- GitHub Student Pack includes a free `.me` domain via Namecheap
- Add it in Vercel: Project → Settings → Domains

### Option B — Netlify (also free, same process)

```bash
# 1. Push to GitHub
# 2. netlify.com → New site from Git → connect repo
# 3. Build command: npm run build
# 4. Publish directory: dist
# 5. Deploy
```

### Option C — GitHub Pages (free, no account needed beyond GitHub)

```bash
# Add to package.json scripts:
"deploy": "vite build && gh-pages -d dist"

# Install gh-pages:
npm install --save-dev gh-pages

# Deploy:
npm run deploy
```

Note: GitHub Pages requires the `base` in `vite.config.js` to match your repo name:
```js
export default defineConfig({ base: "/foosball-mmr/", plugins: [react()] });
```

---

## Pushing to GitHub

```bash
# First time only:
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/foosball-mmr.git
git push -u origin main

# Every subsequent update:
git add .
git commit -m "describe your change"
git push
```

If you're using Vercel or Netlify, pushing to GitHub automatically deploys. No extra steps.

---

## Data & persistence

All data is stored in **localStorage** under the key `foosball_v4`. This means:

- Data is **per browser, per device**. If you log in on a different computer, you start fresh.
- Data **persists across page refreshes** and browser restarts.
- Data is **lost if you clear your browser storage**.

**This is fine for a school leaderboard** where one admin manages everything from one device.

### If you want multi-device sync later

The entire data layer is in two functions at the top of `App.jsx`:
```js
function loadState() { ... }
function saveState(s) { ... }
```

Swap these out for a Supabase client (free tier, in the GitHub Student Pack) and you'll have a real database with zero other changes needed. A drop-in replacement takes about 20 lines.

---

## GitHub Student Developer Pack

If you have a `.edu` email, get the pack at **education.github.com/pack**.

Relevant freebies for this project:
- **GitHub Pro** — private repos, more Actions minutes
- **Vercel Pro** — faster builds, analytics (free tier works fine without this)
- **Namecheap domain** — free `.me` domain for 1 year
- **Supabase** — free Postgres database if you want multi-device sync later

---

## Admin guide

### Season setup
1. Go to **Onboard**, bulk-import all player names
2. Update the Rulebook page with your house rules

### Logging games
1. Go to **Log Games**
2. Click players onto Side A and B — their points show on each chip
3. Enter scores — live points preview appears automatically
4. Add more rows for multiple games
5. Hit **Submit All**
6. If you made a mistake, hit **↩ Undo Last Submit** immediately (available for 30 seconds)

### Editing results
- Go to **History**, click any game, hit **Edit**
- Change score or winner — all stats recalculate automatically from the full game log
- Or **Delete** the game entirely — same recalculation

### Managing players
- **Rename**: Onboard → Roster → Rename
- **Edit points/streak manually**: click a player on the Leaderboard → Edit Profile
- **Recalculate All**: Onboard → Recalculate All — replays entire game history

### End of month
1. Go to **Finals** → Generate Bracket (seeds top 4 automatically)
2. Play semis, enter results
3. Play final, enter result
4. Hit **Award Championship to Profiles** — adds the 🏆 banner to winners' profiles

---

## Development tips

**VS Code extensions worth installing:**
- ES7+ React/Redux/React-Native snippets
- Prettier — Code formatter
- Auto Rename Tag

**Useful browser shortcuts:**
- `F12` → DevTools → Console: run `localStorage.getItem("foosball_v4")` to inspect raw state
- `localStorage.removeItem("foosball_v4")` + refresh to reset all data

**Building for production:**
```bash
npm run build
# Creates dist/ folder — this is what Vercel/Netlify deploys
```
