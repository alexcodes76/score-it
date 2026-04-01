# Score It! — Multiplayer Music Party Game

## What This Is
Score It! is a real-time multiplayer music party game. One device is the host (controls music and scoring). Every other player joins on their own phone, submits songs privately, and sees the AI verdict simultaneously.

## How to Deploy to Fly.io

### 1. Install Fly CLI
```bash
curl -L https://fly.io/install.sh | sh
```

### 2. Log in to Fly
```bash
fly auth login
```

### 3. Create the app (first time only)
```bash
fly launch --name score-it-game --region ord --no-deploy
```
Say NO to PostgreSQL and NO to Redis when asked.

### 4. Set your secrets
```bash
fly secrets set ANTHROPIC_API_KEY=sk-ant-your-key-here
fly secrets set SPOTIFY_CLIENT_ID=73a80fb406c24e679d98bbb410b9b072
```

### 5. Deploy
```bash
fly deploy
```

Your app will be live at: **https://score-it-game-production.up.railway.app**

### 6. Update Spotify Dashboard
Go to developer.spotify.com → your app → Settings → Redirect URIs
Add: `https://score-it-game-production.up.railway.app/host`

## How to Play

1. **Host** opens `https://score-it-game-production.up.railway.app/host` on their device
2. Host connects Spotify, configures settings, creates a room → gets a 4-letter code
3. **Players** open `https://score-it-game-production.up.railway.app/play` on their phones, enter the code and their name
4. Host starts the game
5. Each round: scenario appears on all phones → players search and submit privately → host plays songs → AI judges → everyone sees verdict
6. After all rounds: winner announced

## Environment Variables
- `ANTHROPIC_API_KEY` — your Anthropic API key (stored securely on server)
- `SPOTIFY_CLIENT_ID` — your Spotify app client ID
- `PORT` — set automatically by Fly.io

## Local Development
```bash
npm install
ANTHROPIC_API_KEY=your-key node server.js
```
Then open http://localhost:3000
