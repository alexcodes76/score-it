const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===================== CONFIG =====================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '73a80fb406c24e679d98bbb410b9b072';
const PORT = process.env.PORT || 3000;

// ===================== GAME STATE =====================
const rooms = new Map(); // roomCode -> Room

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(hostWs) {
  const code = generateRoomCode();
  const room = {
    code,
    host: hostWs,
    players: new Map(), // name -> { ws, submission, hints }
    state: 'lobby',     // lobby | submitting | playing | judging | verdict
    settings: {
      difficulty: 'easy',
      rounds: 5,
      judgeStyle: 'winner',
      songDuration: 60,
    },
    currentRound: 0,
    scores: {},
    currentScenario: '',
    currentConstraints: [],
    submissions: {},
    submissionOrder: [],
    verdictData: null,
    usedScenarios: new Set(),
    spotifyToken: null,
    playerColors: { 'Host': '#2DAA1F' }, // host is always green
    colorIndex: 0,
  };
  rooms.set(code, room);
  return room;
}

const PLAYER_COLORS = [
  '#217FEF', '#e05ce0', '#ef8c21', '#ef2157',
  '#21efce', '#efef21', '#7c21ef', '#21a8ef', '#ef4521'
];

function assignPlayerColor(room, name) {
  if (!room.playerColors[name]) {
    room.playerColors[name] = PLAYER_COLORS[room.colorIndex % PLAYER_COLORS.length];
    room.colorIndex++;
  }
  return room.playerColors[name];
}

function broadcast(room, message, excludeWs = null) {
  const data = JSON.stringify(message);
  if (room.host && room.host !== excludeWs && room.host.readyState === 1) {
    room.host.send(data);
  }
  for (const [, player] of room.players) {
    if (!player.ws) continue;
    if (!player.ws) continue;
    if (player.ws !== excludeWs && player.ws.readyState === 1) {
      player.ws.send(data);
    }
  }
}

function sendToHost(room, message) {
  if (room.host && room.host.readyState === 1) {
    room.host.send(JSON.stringify(message));
  }
}

function sendToPlayer(room, playerName, message) {
  const player = room.players.get(playerName);
  if (player && player.ws && player.ws.readyState === 1) {
    player.ws.send(JSON.stringify(message));
  }
}

function getRoomState(room) {
  return {
    type: 'room_state',
    code: room.code,
    state: room.state,
    players: Array.from(room.players.keys()),
    scores: room.scores,
    currentRound: room.currentRound,
    rounds: room.settings.rounds,
    settings: room.settings,
    scenario: room.currentScenario,
    constraints: room.currentConstraints,
    submissionsCount: Object.keys(room.submissions).length,
    totalPlayers: room.players.size,
  };
}

// ===================== AI CALLS =====================
async function callClaude(system, user) {
  if (!ANTHROPIC_API_KEY) throw new Error('No API key configured on server');
  const fetch = globalThis.fetch;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000); // 20 second timeout

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `API error ${res.status}`);
    }
    const data = await res.json();
    return data.content[0].text;
  } catch(e) {
    clearTimeout(timeout);
    throw e;
  }
}

async function generateScenario(room) {
  const diff = room.settings.difficulty;
  const system = `You are the host of Aux Battles, a music party game. Generate vivid, creative scenarios players respond to by picking a song. You must respond in valid JSON only, no preamble.`;

  const constraintCategories = {
    genre: ['Genre: Hip-hop only', 'Genre: Country only', 'Genre: R&B only', 'Genre: Rock only', 'Genre: Pop only', 'Genre: Folk only', 'Genre: Electronic only', 'Genre: Jazz only'],
    decade: ['Decade: 1960s only', 'Decade: 1970s only', 'Decade: 1980s only', 'Decade: 1990s only', 'Decade: 2000s only', 'Decade: 2010s only'],
    singer: ['Singer: Female artist only', 'Singer: Male artist only'],
    format: ['Format: Solo artist only', 'Format: Bands/groups only'],
    tone: ['Tone: Must be funny or ironic', 'Tone: Must be deeply serious', 'Tone: Must be uplifting/celebratory', 'Tone: Must be the opposite mood of the scenario', 'Tone: Must be bittersweet', 'Tone: Must be angry or defiant', 'Tone: Must be tender/gentle'],
  };

  const constraintNote = diff === 'medium'
    ? `Also generate exactly 1 constraint. Choose from any of these categories — genre, decade, singer, format, or tone (tone = the emotional approach to the scenario, e.g. "Tone: Must be funny or ironic"). Pick what fits best.`
    : diff === 'hard'
    ? `Also generate exactly 2 constraints from 2 DIFFERENT categories (genre, decade, singer, format, or tone). Tone options: funny/ironic, deeply serious, uplifting, opposite mood, bittersweet, angry/defiant, tender/gentle.`
    : '';

  const usedList = Array.from(room.usedScenarios).join(', ') || 'none yet';
  const themePool = ['unexpected triumph','quiet grief','reckless joy','reluctant farewell','first impression','final conversation','secret kept too long','unexpected kindness','childhood memory','late night clarity','public embarrassment','private victory','unrequited feeling','unexpected reunion','moment of courage','productive anger','nostalgia for a place','letting go','starting over','being truly seen','nervous anticipation','peaceful solitude','bitter irony','pure celebration','identity crisis','sudden perspective','unspoken apology','found family','fading memory','righteous defiance','tender vulnerability','earned rest'];
  const shuffled = themePool.sort(() => Math.random() - 0.5).slice(0, 6).join(', ');

  const prompt = `Generate a scenario for round ${room.currentRound} of ${room.settings.rounds} at ${diff} difficulty.

The scenario must be a specific, evocative situation or moment — 1-2 sentences. Surprising and concrete, not abstract or cliché.

STRICT: Do NOT use any theme similar to these already used this game: ${usedList}

Consider these unused emotional territories: ${shuffled}

Bad example: "A moment of reflection." Good example: "The specific silence of a house after everyone has left for the last time."

Consider these scenario TYPES for variety — don't always use the same type:
- Situation: A vivid scene or moment ("The walk home after getting fired")
- Decision: A choice someone faces ("You just deleted their number. For good this time.")
- Dilemma: Torn between two things ("You love them but you know it's wrong")
- Contradiction: Two opposing truths ("A funeral that somehow feels like a relief")
- Provocation: A direct challenge ("A song that would make your ex regret everything")
- Feeling: A pure emotional state ("The specific loneliness of being in a crowded room")

${constraintNote}

Return JSON: {"text": "The scenario.", "theme": "2-3 word theme label", "constraints": []}
constraints is [] for easy, one item for medium, two for hard.
Constraint examples: "Genre: Hip-hop only", "Decade: 1990s only", "Singer: Female artist only", "Format: Bands/groups only", "Tone: Must be funny or ironic"`;

  const raw = await callClaude(system, prompt);
  const clean = raw.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(clean);
  if (parsed.theme) room.usedScenarios.add(parsed.theme);
  else room.usedScenarios.add(parsed.text.slice(0, 40));
  return parsed;
}

async function generateHints(scenario, constraints) {
  const constraintNote = constraints.length ? `\nConstraints: ${constraints.join(', ')}. All suggestions must meet these.` : '';
  const system = `You are a music suggestion assistant in Aux Battles. Suggest songs matching the EMOTIONAL FEEL of a scenario, not its literal subject. Suggest well-known songs. Be concise.`;
  const prompt = `Scenario: "${scenario}"${constraintNote}

Suggest exactly 3 well-known songs matching the EMOTIONAL FEEL. Format: one per line as "Song Title — Artist". No explanations, no numbering.`;
  return await callClaude(system, prompt);
}

async function getVerdict(room) {
  // Build submission list with audio vibe descriptors
  const submissionsWithVibe = await Promise.all(
    room.submissionOrder.map(async p => {
      const sub = room.submissions[p];
      if (!sub) return `${p}: no submission`;
      let vibeDesc = '';
      if (sub.trackUri && room.spotifyToken) {
        try {
          const trackId = sub.trackUri.split(':')[2];
          const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));
          const res = await globalThis.fetch(
            `https://api.spotify.com/v1/audio-features/${trackId}`,
            { headers: { 'Authorization': `Bearer ${room.spotifyToken}` } }
          );
          if (res.ok) {
            const af = await res.json();
            const energy = af.energy > 0.7 ? 'high energy' : af.energy < 0.3 ? 'low energy' : 'mid energy';
            const valence = af.valence > 0.7 ? 'upbeat/happy' : af.valence < 0.3 ? 'dark/sad' : 'mixed mood';
            const dance = af.danceability > 0.7 ? 'very danceable' : af.danceability < 0.3 ? 'not danceable' : '';
            const acoustic = af.acousticness > 0.6 ? 'acoustic' : '';
            const parts = [energy, valence, dance, acoustic].filter(Boolean);
            vibeDesc = ` [vibe: ${parts.join(', ')}]`;
          }
        } catch(e) {}
      }
      return `${p}: "${sub.song}"${vibeDesc}`;
    })
  );

  const submissionsList = submissionsWithVibe.join('\n');
  const rankMode = room.settings.judgeStyle === 'ranked';
  const constraintNote = room.currentConstraints.length
    ? `\nConstraints this round: ${room.currentConstraints.join(', ')}. Penalize violations, especially Tone constraints which are about the emotional approach of the song.`
    : '';

  const system = `You are the AI judge for Aux Battles, a music party game. You are brilliant, witty, slightly pretentious, and genuinely entertaining. You have STRONG opinions and you're not afraid to roast a bad pick. You compare songs directly when it's interesting to do so. You reward creativity and punish the obvious safe choice. If someone picks something boring or lazy, call it out with flair. If someone picks something genuinely inspired, celebrate it. You judge on both lyrical/thematic fit AND sonic vibe. Your verdicts should feel like a music critic who also does stand-up comedy. Respond in valid JSON only.`;

  const prompt = `Scenario: "${room.currentScenario}"${constraintNote}

Submissions (with vibe data where available):
${submissionsList}

Judge each song on TWO dimensions:
1. CONTENT — do the lyrics, theme, and meaning of the song fit the scenario?
2. VIBE — does the sonic energy, mood, and feel of the song match what the moment calls for?

${rankMode
  ? `Rank all submissions best to worst. Give each a 1-2 sentence specific explanation covering both content and vibe. Return JSON:
{"ranking": [{"player": "Name", "song": "Song", "reason": "Explanation (be witty, specific, and don't be afraid to roast or celebrate)"}], "reasoning": "1-2 sentence overall take with personality."}`
  : `Pick the winner. Explain specifically why this song wins on both content and vibe, and what others missed. 3-4 sentences. Return JSON:
{"winner": "Player Name", "reasoning": "Specific 3-4 sentence explanation. Be direct, funny, and opinionated. Compare the songs. Roast bad picks."}`
}`;

  const raw = await callClaude(system, prompt);
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ===================== FALLBACK SCENARIOS =====================
const fallbackScenarios = {
  easy: [
    { text: "The moment you realize you've been driving the wrong direction for 40 minutes.", constraints: [] },
    { text: "A first slow dance at a wedding between two people who didn't expect to fall for each other.", constraints: [] },
    { text: "The walk home after a night that didn't go the way you planned.", constraints: [] },
    { text: "Standing in a grocery store at 11pm, not sure what you came for.", constraints: [] },
    { text: "The last song at a party when the lights come up.", constraints: [] },
    { text: "A road trip that nobody wants to end.", constraints: [] },
    { text: "Watching the sun come up after a night you'll never forget.", constraints: [] },
    { text: "The moment a plan you almost gave up on finally works.", constraints: [] },
    { text: "Saying goodbye at an airport and meaning it.", constraints: [] },
    { text: "The first warm day after a long winter.", constraints: [] },
    { text: "The feeling of leaving a job you hated on your last day.", constraints: [] },
    { text: "A summer night where nothing special happens but everything feels right.", constraints: [] },
    { text: "The moment before you say 'I love you' for the first time.", constraints: [] },
    { text: "Packing up an apartment you lived in for years.", constraints: [] },
    { text: "Hearing a song you forgot about and being transported back instantly.", constraints: [] },
  ],
  medium: [
    { text: "The road trip that started as an argument and ended as something else entirely.", constraints: ["Decade: 1990s only"] },
    { text: "Watching someone you love walk away and knowing it was the right call.", constraints: ["Singer: Female artist only"] },
    { text: "The city at 3am when you can't sleep and everything feels possible.", constraints: ["Genre: R&B only"] },
    { text: "Finding an old photo of someone you used to be close to.", constraints: ["Format: Solo artist only"] },
    { text: "The feeling right before you say something you can't take back.", constraints: ["Genre: Rock only"] },
    { text: "A montage of the best summer of your life.", constraints: ["Decade: 2000s only"] },
    { text: "The moment you stop waiting and just start.", constraints: ["Singer: Male artist only"] },
    { text: "Driving home from somewhere you didn't want to leave.", constraints: ["Genre: Country only"] },
    { text: "The feeling of winning something you worked years for.", constraints: ["Genre: Hip-hop only"] },
    { text: "A quiet Sunday morning that feels like a fresh start.", constraints: ["Format: Bands only"] },
  ],
  hard: [
    { text: "A montage of every mistake you made and somehow don't regret.", constraints: ["Decade: 1980s only", "Singer: Male artist only"] },
    { text: "The last five minutes of a long road trip as the familiar skyline comes into view.", constraints: ["Genre: Country only", "Decade: 1990s only"] },
    { text: "Someone finally saying the thing they've held back for years.", constraints: ["Singer: Female artist only", "Type: Movie or TV soundtrack only"] },
    { text: "A city you lived in once and can never quite leave behind.", constraints: ["Genre: Hip-hop only", "Decade: 2000s only"] },
    { text: "The silence after the biggest decision of your life.", constraints: ["Format: Bands only", "Decade: 1970s only"] },
    { text: "A reunion between two people who parted badly but grew up since then.", constraints: ["Genre: R&B only", "Singer: Female artist only"] },
    { text: "The feeling of finishing something you started years ago.", constraints: ["Decade: 2010s only", "Format: Solo artist only"] },
    { text: "Walking away from something comfortable toward something unknown.", constraints: ["Genre: Rock only", "Decade: 1990s only"] },
    { text: "The last night in a place you called home.", constraints: ["Genre: Folk only", "Singer: Male artist only"] },
    { text: "A triumph that only you know the full cost of.", constraints: ["Decade: 1980s only", "Format: Bands only"] },
  ],
};

function getFallbackScenario(room) {
  const diff = room.settings.difficulty;
  const bank = fallbackScenarios[diff];
  const unused = bank.filter((s, i) => !room.usedScenarios.has(`${diff}-${i}`));
  const pool = unused.length > 0 ? unused : bank;
  const picked = pool[Math.floor(Math.random() * pool.length)];
  // Mark as used by index
  const idx = bank.indexOf(picked);
  if (idx >= 0) room.usedScenarios.add(`${diff}-${idx}`);
  return picked;
}

// ===================== GAME LOGIC =====================
async function beginRound(room) {
  room.currentRound++;
  room.submissions = {};
  // Include Host in submission order
  room.submissionOrder = [...Array.from(room.players.keys()), 'Host'];
  // Shuffle with rotation
  const offset = (room.currentRound - 1) % room.submissionOrder.length;
  room.submissionOrder = [
    ...room.submissionOrder.slice(offset),
    ...room.submissionOrder.slice(0, offset),
  ];
  room.state = 'submitting';

  // Notify everyone round is starting
  broadcast(room, { type: 'round_start', round: room.currentRound, rounds: room.settings.rounds });

  // Generate scenario
  try {
    const scenario = await generateScenario(room);
    room.currentScenario = scenario.text;
    room.currentConstraints = scenario.constraints || [];
  } catch (e) {
    const fallback = getFallbackScenario(room);
    room.currentScenario = fallback.text;
    room.currentConstraints = fallback.constraints || [];
  }

  // Push scenario to everyone
  broadcast(room, {
    type: 'scenario',
    scenario: room.currentScenario,
    constraints: room.currentConstraints,
    round: room.currentRound,
    rounds: room.settings.rounds,
  });

  // Generate hints for each player who wants them
  for (const [name, player] of room.players) {
    if (player.wantsHints) {
      generateHints(room.currentScenario, room.currentConstraints)
        .then(hints => {
          sendToPlayer(room, name, { type: 'hints', hints });
        })
        .catch(() => {});
    }
  }
}

function applyScores(room, verdict) {
  const judgeStyle = room.settings.judgeStyle;
  if (judgeStyle === 'ranked' && verdict.ranking) {
    verdict.ranking.forEach((entry, idx) => {
      const pts = room.players.size - idx;
      if (room.scores[entry.player] !== undefined) room.scores[entry.player] += pts;
    });
  } else if (verdict.winner) {
    if (room.scores[verdict.winner] !== undefined) room.scores[verdict.winner] += 3;
  }
}

// ===================== WEBSOCKET HANDLER =====================
wss.on('connection', (ws) => {
  ws.room = null;
  ws.role = null;
  ws.playerName = null;

  ws.on('message', async (raw) => {
    // Handle pong responses from clients
    if (raw.toString() === '__pong__') { ws.isAlive = true; return; }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type } = msg;

    // Handle client-side ping test
    if (type === 'ping') { ws.isAlive = true; return; }

    // ---- HOST: Create room ----
    if (type === 'host_create') {
      const room = createRoom(ws);
      ws.room = room;
      ws.role = 'host';
      ws.send(JSON.stringify({
        type: 'room_created',
        code: room.code,
        spotifyClientId: SPOTIFY_CLIENT_ID,
        hasApiKey: !!ANTHROPIC_API_KEY,
      }));
      return;
    }

    // ---- HOST: Update settings ----
    if (type === 'host_settings' && ws.role === 'host') {
      const room = ws.room;
      room.settings = { ...room.settings, ...msg.settings };
      ws.send(JSON.stringify({ type: 'settings_saved' }));
      return;
    }

    // ---- HOST: Start game ----
    if (type === 'host_start' && ws.role === 'host') {
      const room = ws.room;
      if (room.players.size < 1) {
        ws.send(JSON.stringify({ type: 'error', message: 'Need at least 1 player to start.' }));
        return;
      }
      room.players.forEach((_, name) => { room.scores[name] = 0; });
      room.scores['Host'] = 0; // Host participates and is scored
      await beginRound(room);
      return;
    }

    // ---- HOST: Playback started — send queue to players ----
    if (type === 'host_playback_start' && ws.role === 'host') {
      const room = ws.room;
      const hiddenQueue = (msg.queue || []).map(playerName => ({
        playerName,
        hidden: true,
      }));
      for (const [, player] of room.players) {
        if (player.ws && player.ws.readyState === 1) {
          player.ws.send(JSON.stringify({
            type: 'playback_start',
            queue: hiddenQueue,
          }));
        }
      }
      return;
    }

    // ---- HOST: Now playing — reveal song to players ----
    if (type === 'host_now_playing' && ws.role === 'host') {
      const room = ws.room;
      for (const [, player] of room.players) {
        if (player.ws && player.ws.readyState === 1) {
          player.ws.send(JSON.stringify({
            type: 'now_playing',
            playerName: msg.playerName,
            trackName: msg.trackName,
            artistName: msg.artistName,
            albumArt: msg.albumArt,
            index: msg.index,
            total: msg.total,
          }));
        }
      }
      return;
    }

    // ---- HOST: Refresh scenario ----
    if (type === 'host_refresh_scenario' && ws.role === 'host') {
      const room = ws.room;
      try {
        const scenario = await generateScenario(room);
        room.currentScenario = scenario.text;
        room.currentConstraints = scenario.constraints || [];
        room.usedScenarios.add(scenario.text.slice(0, 30));
      } catch(e) {
        const fallback = getFallbackScenario(room);
        room.currentScenario = fallback.text;
        room.currentConstraints = fallback.constraints || [];
      }
      broadcast(room, {
        type: 'scenario',
        scenario: room.currentScenario,
        constraints: room.currentConstraints,
        round: room.currentRound,
        rounds: room.settings.rounds,
      });
      return;
    }

    // ---- HOST: Start next round ----
    if (type === 'host_next_round' && ws.role === 'host') {
      const room = ws.room;
      if (room.currentRound >= room.settings.rounds) {
        // Game over
        const sorted = Object.entries(room.scores).sort((a, b) => b[1] - a[1]);
        broadcast(room, { type: 'game_over', scores: room.scores, winner: sorted[0][0] });
      } else {
        await beginRound(room);
      }
      return;
    }

    // ---- HOST: Judge round ----
    if (type === 'host_judge' && ws.role === 'host') {
      const room = ws.room;
      room.state = 'judging';
      broadcast(room, { type: 'judging_start' });
      try {
        const verdict = await getVerdict(room);
        room.verdictData = verdict;
        applyScores(room, verdict);
        room.state = 'verdict';
        broadcast(room, {
          type: 'verdict',
          verdict,
          scores: room.scores,
          round: room.currentRound,
          rounds: room.settings.rounds,
          isLastRound: room.currentRound >= room.settings.rounds,
          submissions: room.submissions,
        });
      } catch (e) {
        console.error('Judge error:', e.message);
        // Fall back to random winner
        const players = Object.keys(room.submissions).filter(p => room.submissions[p]);
        const winner = players[Math.floor(Math.random() * players.length)] || 'No one';
        const fallback = {
          winner,
          reasoning: `AI judging encountered an error (${e.message}). Winner selected randomly. Check that ANTHROPIC_API_KEY is set correctly in Railway variables.`
        };
        room.verdictData = fallback;
        applyScores(room, fallback);
        room.state = 'verdict';
        broadcast(room, {
          type: 'verdict',
          verdict: fallback,
          scores: room.scores,
          round: room.currentRound,
          rounds: room.settings.rounds,
          isLastRound: room.currentRound >= room.settings.rounds,
          submissions: room.submissions,
        });
      }
      return;
    }

    // ---- HOST: Share Spotify token ----
    if (type === 'host_token' && ws.role === 'host') {
      const room = ws.room;
      room.spotifyToken = msg.token;
      // Push token to all currently connected players
      for (const [, player] of room.players) {
        if (player.ws && player.ws.readyState === 1) {
          player.ws.send(JSON.stringify({ type: 'spotify_token', token: msg.token }));
        }
      }
      return;
    }

    // ---- PLAYER: Join room ----
    if (type === 'player_join') {
      const room = rooms.get(msg.code?.toUpperCase());
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found. Check the code and try again.' }));
        return;
      }
      const name = msg.name?.trim();
      if (!name) {
        ws.send(JSON.stringify({ type: 'error', message: 'Please enter your name.' }));
        return;
      }

      const isRejoin = room.players.has(name);

      // Block new players from joining mid-game, but allow rejoins
      if (room.state !== 'lobby' && !isRejoin) {
        ws.send(JSON.stringify({ type: 'error', message: 'Game already in progress.' }));
        return;
      }

      // Block name conflicts from genuinely new players
      if (!isRejoin && room.state === 'lobby' && room.players.has(name)) {
        ws.send(JSON.stringify({ type: 'error', message: 'That name is already taken.' }));
        return;
      }

      ws.room = room;
      ws.role = 'player';
      ws.playerName = name;

      // Update or add player entry
      const existingPlayer = room.players.get(name) || {};
      room.players.set(name, {
        ...existingPlayer,
        ws,
        wantsHints: msg.wantsHints || existingPlayer.wantsHints || false,
      });

      // Assign a server-side color to this player
      const playerColor = assignPlayerColor(room, name);

      // Send join confirmation with token and color map
      ws.send(JSON.stringify({
        type: 'joined',
        name,
        code: room.code,
        spotifyClientId: SPOTIFY_CLIENT_ID,
        spotifyToken: room.spotifyToken || null,
        rejoin: isRejoin,
        playerColor,
        playerColors: room.playerColors,
      }));

      // Broadcast updated color map to host and all players
      broadcast(room, { type: 'player_colors', playerColors: room.playerColors }, ws);

      // If rejoining mid-game, catch them up immediately
      if (isRejoin && room.state !== 'lobby') {
        const submission = room.submissions[name];

        if (room.state === 'verdict' && room.verdictData) {
          // Skip round_start entirely for verdict — go straight to verdict
          ws.send(JSON.stringify({
            type: 'verdict',
            verdict: room.verdictData,
            scores: room.scores,
            round: room.currentRound,
            rounds: room.settings.rounds,
            isLastRound: room.currentRound >= room.settings.rounds,
            submissions: room.submissions,
          }));
        } else if (room.state === 'judging') {
          ws.send(JSON.stringify({ type: 'judging_start' }));
        } else if (room.state === 'playing') {
          // Songs are playing — send round info then go to confirmed/waiting
          ws.send(JSON.stringify({
            type: 'round_start',
            round: room.currentRound,
            rounds: room.settings.rounds,
          }));
          if (room.currentScenario) {
            ws.send(JSON.stringify({
              type: 'scenario',
              scenario: room.currentScenario,
              constraints: room.currentConstraints,
              round: room.currentRound,
              rounds: room.settings.rounds,
            }));
          }
          // Send playback_start so they see the queue
          const queue = Array.from(room.submissionOrder).map(p => ({ playerName: p, hidden: false }));
          ws.send(JSON.stringify({ type: 'playback_start', queue }));
          if (submission) {
            ws.send(JSON.stringify({
              type: 'submission_confirmed',
              song: submission.trackName || submission.song,
              rejoin: true,
            }));
          }
        } else {
          // submitting state — send round info and scenario
          ws.send(JSON.stringify({
            type: 'round_start',
            round: room.currentRound,
            rounds: room.settings.rounds,
          }));
          if (room.currentScenario) {
            ws.send(JSON.stringify({
              type: 'scenario',
              scenario: room.currentScenario,
              constraints: room.currentConstraints,
              round: room.currentRound,
              rounds: room.settings.rounds,
            }));
          }
          // If already submitted, restore confirmed screen
          if (submission) {
            ws.send(JSON.stringify({
              type: 'submission_confirmed',
              song: submission.trackName || submission.song,
              rejoin: true,
            }));
          }
          // Send current submission count
          const submitted = Object.keys(room.submissions).length;
          const total = room.players.size + 1;
          ws.send(JSON.stringify({ type: 'submission_count', submitted, total }));
        }
      }

      if (!isRejoin) {
        sendToHost(room, { type: 'player_joined', name, playerCount: room.players.size });
      } else {
        sendToHost(room, { type: 'player_rejoined', name });
      }
      return;
    }

    // ---- HOST: Submit their own song ----
    if (type === 'host_submit' && ws.role === 'host') {
      const room = ws.room;
      const hostName = 'Host';

      const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const songKey = normalize((msg.trackName || msg.song) + (msg.artistName || ''));
      const alreadyTaken = Object.values(room.submissions)
        .some(s => normalize((s.trackName || s.song) + (s.artistName || '')) === songKey);

      if (alreadyTaken) {
        ws.send(JSON.stringify({ type: 'error', message: 'That song was already chosen.' }));
        return;
      }

      room.submissions[hostName] = {
        song: msg.song,
        trackUri: msg.trackUri,
        trackName: msg.trackName,
        artistName: msg.artistName,
        albumArt: msg.albumArt,
      };

      const submitted = Object.keys(room.submissions).length;
      const total = room.players.size + 1; // +1 for host

      ws.send(JSON.stringify({
        type: 'submission_received',
        playerName: hostName,
        submitted,
        total,
        allIn: submitted === total,
        submissions: submitted === total ? room.submissions : null,
      }));

      broadcast(room, { type: 'submission_count', submitted, total, playerName: hostName }, ws);
      return;
    }

    // ---- PLAYER: Toggle hints ----
    if (type === 'player_hints' && ws.role === 'player') {
      const room = ws.room;
      const player = room.players.get(ws.playerName);
      if (player) player.wantsHints = msg.wantsHints;
      return;
    }

    // ---- PLAYER: Submit song ----
    if (type === 'player_submit' && ws.role === 'player') {
      const room = ws.room;
      const name = ws.playerName;

      // Duplicate check
      const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const songKey = normalize((msg.trackName || msg.song) + (msg.artistName || ''));
      const alreadyTaken = Object.values(room.submissions)
        .some(s => normalize((s.trackName || s.song) + (s.artistName || '')) === songKey);

      if (alreadyTaken) {
        ws.send(JSON.stringify({ type: 'error', message: 'That song was already chosen. Pick something else.' }));
        return;
      }

      room.submissions[name] = {
        song: msg.song,
        trackUri: msg.trackUri,
        trackName: msg.trackName,
        artistName: msg.artistName,
        albumArt: msg.albumArt,
      };

      ws.send(JSON.stringify({ type: 'submission_confirmed', song: msg.song }));

      const submitted = Object.keys(room.submissions).length;
      const total = room.players.size + 1; // +1 for host

      // Notify host of progress
      sendToHost(room, {
        type: 'submission_received',
        playerName: name,
        submitted,
        total,
        allIn: submitted === total,
        submissions: submitted === total ? room.submissions : null,
      });

      // Notify other players (just count, not song)
      broadcast(room, { type: 'submission_count', submitted, total, playerName: name }, ws);
      return;
    }

    // ---- PLAYER: Request hints mid-round ----
    if (type === 'player_request_hints' && ws.role === 'player') {
      const room = ws.room;
      try {
        const hints = await generateHints(room.currentScenario, room.currentConstraints);
        ws.send(JSON.stringify({ type: 'hints', hints }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'hints', hints: 'Hints unavailable right now.' }));
      }
      return;
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;

    if (ws.role === 'host') {
      broadcast(room, { type: 'host_left' });
      rooms.delete(room.code);
    } else if (ws.role === 'player') {
      // Don't remove player from room — they may reconnect
      // Just mark their connection as dead so broadcasts skip them
      const player = room.players.get(ws.playerName);
      if (player) player.ws = null;
      sendToHost(room, { type: 'player_disconnected', name: ws.playerName });
    }
  });

  ws.on('pong', () => { ws.isAlive = true; });
});

// ===================== KEEP-ALIVE PING =====================
const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      // Only terminate hosts on failed ping — players may just be sleeping
      if (ws.role === 'host') {
        ws.terminate();
      }
      // For players, just reset so next ping cycle gives them another chance
      ws.isAlive = true;
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch(e) {}
  });
}, 25000);

wss.on('close', () => clearInterval(pingInterval));

// ===================== REST ENDPOINTS =====================

// Config endpoint — serves Spotify client ID to front-end
app.get('/api/config', (req, res) => {
  res.json({
    spotifyClientId: SPOTIFY_CLIENT_ID,
    hasApiKey: !!ANTHROPIC_API_KEY,
  });
});

// Serve host and player pages
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => {
  console.log(`Aux Battles server running on port ${PORT}`);
});
