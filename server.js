import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);

// --- CSV Parser ---
function parseCSV(filepath) {
  const raw = fs.readFileSync(filepath, 'utf-8');
  const lines = raw.trim().split('\n');
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => obj[h.trim()] = (vals[i] || '').trim());
    return obj;
  });
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// --- Load Questions ---
const csvPath = path.join(__dirname, 'data', 'questions.csv');

function loadQuestions() {
  const rows = parseCSV(csvPath);
  return rows.map(q => ({
    question: q.question,
    type: q.type,
    options: [q.option1, q.option2, q.option3, q.option4].filter(o => o !== ''),
    correct: parseInt(q.correct, 10),
    timeLimit: parseInt(q.time_limit, 10) || 20,
    image: q.image || '',
  }));
}

if (!fs.existsSync(csvPath)) {
  console.error('Error: questions.csv not found');
  process.exit(1);
}
let questions = loadQuestions();

// --- Watch for CSV changes ---
fs.watch(csvPath, (eventType) => {
  if (eventType !== 'change') return;
  try {
    const updated = loadQuestions();
    questions = updated;
    console.log(`CSV changed — reloaded ${questions.length} questions`);
    if (game.state === 'idle' || game.state === 'lobby') {
      game.questions = questions;
    }
  } catch (err) {
    console.warn(`Warning: failed to reload questions.csv — ${err.message}`);
  }
});

// --- Game State ---
let game = {
  pin: null,
  state: 'idle', // idle | lobby | question | reveal | leaderboard
  players: new Map(), // id -> { name, ws, score, answer, answerTime }
  questions,
  currentQuestion: -1,
  timer: null,
  timeRemaining: 0,
  hostWs: null,
  answerCount: 0,
};

function resetGame() {
  if (game.timer) clearInterval(game.timer);

  try {
    questions = loadQuestions();
    console.log(`Reloaded ${questions.length} questions from CSV`);
  } catch (err) {
    console.warn(`Warning: failed to reload questions.csv, keeping previous ${questions.length} questions — ${err.message}`);
  }

  game.pin = String(Math.floor(1000 + Math.random() * 9000));
  game.state = 'lobby';
  game.players = new Map();
  game.questions = questions;
  game.currentQuestion = -1;
  game.timer = null;
  game.timeRemaining = 0;
  game.answerCount = 0;
  console.log(`New game created — PIN: ${game.pin}`);
}

// --- Helpers ---
let nextPlayerId = 1;

function send(ws, type, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type, data }));
  }
}

function broadcast(type, data) {
  game.players.forEach(p => send(p.ws, type, data));
  if (game.hostWs) send(game.hostWs, type, data);
}

function sendToHost(type, data) {
  if (game.hostWs) send(game.hostWs, type, data);
}

function getLeaderboard() {
  return Array.from(game.players.values())
    .map(p => ({ name: p.name, avatar: p.avatar, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function connectedPlayerCount() {
  let count = 0;
  game.players.forEach(p => { if (p.ws.readyState === 1) count++; });
  return count;
}

function buildResyncPayload(playerId) {
  const player = game.players.get(playerId);
  const payload = { state: game.state };

  if (game.state === 'question') {
    const q = game.questions[game.currentQuestion];
    payload.question = {
      index: game.currentQuestion,
      total: game.questions.length,
      question: q.question,
      type: q.type,
      options: q.options,
      timeLimit: q.timeLimit,
      image: q.image || '',
    };
    payload.timeRemaining = game.timeRemaining;
    payload.alreadyAnswered = player.answer !== null;
  } else if (game.state === 'reveal') {
    const q = game.questions[game.currentQuestion];
    payload.result = {
      correct: q.correct,
      yourAnswer: player.answer,
      points: player.lastPoints || 0,
      totalScore: player.score,
      isLast: game.currentQuestion >= game.questions.length - 1,
    };
  } else if (game.state === 'leaderboard') {
    payload.leaderboard = getLeaderboard();
  }

  return payload;
}

function startQuestion() {
  game.currentQuestion++;
  if (game.currentQuestion >= game.questions.length) {
    endGame();
    return;
  }

  game.state = 'question';
  game.answerCount = 0;
  const q = game.questions[game.currentQuestion];
  game.timeRemaining = q.timeLimit;

  // Reset player answers
  game.players.forEach(p => {
    p.answer = null;
    p.answerTime = null;
  });

  // Broadcast question (without correct answer)
  broadcast('question', {
    index: game.currentQuestion,
    total: game.questions.length,
    question: q.question,
    type: q.type,
    options: q.options,
    timeLimit: q.timeLimit,
    image: q.image || '',
  });

  // Start countdown
  game.timer = setInterval(() => {
    game.timeRemaining--;
    broadcast('timer', { remaining: game.timeRemaining });
    if (game.timeRemaining <= 0) {
      clearInterval(game.timer);
      game.timer = null;
      revealAnswer();
    }
  }, 1000);
}

function revealAnswer() {
  if (game.state !== 'question') return;
  if (game.timer) {
    clearInterval(game.timer);
    game.timer = null;
  }

  game.state = 'reveal';
  const q = game.questions[game.currentQuestion];

  // Calculate scores
  const distribution = new Array(q.options.length).fill(0);
  game.players.forEach(p => {
    if (p.answer !== null) {
      distribution[p.answer - 1]++;
      if (p.answer === q.correct) {
        const timeBonus = Math.round((p.answerTime / q.timeLimit) * 1000);
        p.lastPoints = 1000 + timeBonus;
        p.score += p.lastPoints;
      } else {
        p.lastPoints = 0;
      }
    } else {
      p.lastPoints = 0;
    }
  });

  const isLast = game.currentQuestion >= game.questions.length - 1;

  // Send results to host
  sendToHost('results', {
    correct: q.correct,
    distribution,
    options: q.options,
    leaderboard: getLeaderboard().slice(0, 5),
    isLast,
  });

  // Send individual results to players
  game.players.forEach(p => {
    send(p.ws, 'result', {
      correct: q.correct,
      yourAnswer: p.answer,
      points: p.lastPoints || 0,
      totalScore: p.score,
      isLast,
    });
  });
}

function endGame() {
  game.state = 'leaderboard';
  const leaderboard = getLeaderboard();
  broadcast('leaderboard', { leaderboard });
}

// --- Basic Auth ---
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="RobHoot Admin"');
    return res.status(401).send('Authentication required');
  }
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="RobHoot Admin"');
  return res.status(401).send('Invalid credentials');
}

// --- CSV Serializer ---
function serializeCSV(rows) {
  const headers = ['question', 'type', 'option1', 'option2', 'option3', 'option4', 'correct', 'time_limit', 'image'];
  const quoteField = (val) => {
    const s = String(val ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => quoteField(row[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

// --- Express ---
app.use(express.json());

// Admin routes (before static middleware)
app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/questions', requireAuth, (req, res) => {
  try {
    const rows = parseCSV(csvPath);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/questions', requireAuth, (req, res) => {
  try {
    const rows = req.body;
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: 'Expected an array of question objects' });
    }
    const csv = serializeCSV(rows);
    fs.writeFileSync(csvPath, csv, 'utf-8');
    res.json({ ok: true, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve uploaded images
const imagesDir = path.join(__dirname, 'data', 'images');
app.use('/images', express.static(imagesDir));

// Image upload (raw body, content-type used for extension)
app.post('/api/images', requireAuth, express.raw({ type: 'image/*', limit: '5mb' }), (req, res) => {
  try {
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[req.headers['content-type']];
    if (!ext) return res.status(400).json({ error: 'Unsupported image type' });
    const filename = crypto.randomBytes(8).toString('hex') + ext;
    fs.writeFileSync(path.join(imagesDir, filename), req.body);
    res.json({ filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// --- WebSocket ---
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const pathname = req.url;
  if (pathname === '/ws/host' || pathname === '/ws/play') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.role = pathname === '/ws/host' ? 'host' : 'player';
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  if (ws.role === 'host') {
    handleHost(ws);
  } else {
    handlePlayer(ws);
  }
});

function handleHost(ws) {
  // Notify existing players before wiping the game (e.g. host refreshed mid-game)
  game.players.forEach(p => send(p.ws, 'host-disconnected', {}));
  game.hostWs = ws;
  resetGame();

  send(ws, 'lobby', {
    pin: game.pin,
    players: Array.from(game.players.values()).map(p => ({ name: p.name, avatar: p.avatar })),
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'start' && game.state === 'lobby') {
      if (game.players.size === 0) {
        send(ws, 'error', { message: 'Need at least 1 player' });
        return;
      }
      startQuestion();
    } else if (msg.type === 'next' && game.state === 'reveal') {
      startQuestion();
    } else if (msg.type === 'reset') {
      resetGame();
      send(ws, 'lobby', {
        pin: game.pin,
        players: [],
      });
    }
  });

  ws.on('close', () => {
    if (game.hostWs === ws) {
      game.hostWs = null;
      game.players.forEach(p => send(p.ws, 'host-disconnected', {}));
    }
  });
}

function handlePlayer(ws) {
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const { pin, name, avatar } = msg.data || {};
      if (!pin || !name) {
        send(ws, 'error', { message: 'PIN and name required' });
        return;
      }
      if (String(pin) !== game.pin) {
        send(ws, 'error', { message: 'Invalid PIN' });
        return;
      }
      if (game.state !== 'lobby') {
        send(ws, 'error', { message: 'Game already in progress' });
        return;
      }
      const trimmedName = name.trim().slice(0, 20);
      if (!trimmedName) {
        send(ws, 'error', { message: 'Name cannot be empty' });
        return;
      }

      // Check for duplicate names
      for (const p of game.players.values()) {
        if (p.name.toLowerCase() === trimmedName.toLowerCase()) {
          send(ws, 'error', { message: 'Name already taken' });
          return;
        }
      }

      playerId = String(nextPlayerId++);
      game.players.set(playerId, {
        name: trimmedName,
        avatar: avatar || '🐶',
        ws,
        score: 0,
        answer: null,
        answerTime: null,
        lastPoints: 0,
      });

      send(ws, 'joined', { name: trimmedName, avatar: avatar || '🐶' });
      sendToHost('player-joined', {
        name: trimmedName,
        avatar: avatar || '🐶',
        count: game.players.size,
        players: Array.from(game.players.values()).map(p => ({ name: p.name, avatar: p.avatar })),
      });
      console.log(`Player joined: ${trimmedName} (${game.players.size} total)`);

    } else if (msg.type === 'rejoin') {
      const { pin, name } = msg.data || {};
      if (!pin || !name) {
        send(ws, 'error', { message: 'PIN and name required' });
        return;
      }
      if (String(pin) !== game.pin) {
        send(ws, 'error', { message: 'Invalid PIN' });
        return;
      }
      if (game.state === 'idle' || game.state === 'lobby') {
        send(ws, 'error', { message: 'No active game to rejoin' });
        return;
      }

      // Find player by name (case-insensitive)
      let foundId = null;
      for (const [id, p] of game.players.entries()) {
        if (p.name.toLowerCase() === name.trim().toLowerCase()) {
          foundId = id;
          break;
        }
      }
      if (!foundId) {
        send(ws, 'error', { message: 'Player not found in this game' });
        return;
      }

      // Swap WebSocket reference
      const player = game.players.get(foundId);
      player.ws = ws;
      playerId = foundId;

      const resync = buildResyncPayload(foundId);
      send(ws, 'rejoined', resync);
      console.log(`Player reconnected: ${player.name}`);

    } else if (msg.type === 'answer') {
      if (!playerId || game.state !== 'question') return;
      const player = game.players.get(playerId);
      if (!player || player.answer !== null) return; // Already answered

      const answerIndex = parseInt(msg.data?.answer, 10);
      const q = game.questions[game.currentQuestion];
      if (isNaN(answerIndex) || answerIndex < 1 || answerIndex > q.options.length) return;

      player.answer = answerIndex;
      player.answerTime = game.timeRemaining;
      game.answerCount++;

      send(ws, 'answer-received', {});
      sendToHost('answer-count', {
        count: game.answerCount,
        total: game.players.size,
      });

      // Auto-reveal if all connected players answered
      if (game.answerCount >= connectedPlayerCount()) {
        revealAnswer();
      }
    }
  });

  ws.on('close', () => {
    if (playerId && game.state === 'lobby') {
      const player = game.players.get(playerId);
      game.players.delete(playerId);
      if (player) {
        sendToHost('player-left', {
          name: player.name,
          count: game.players.size,
          players: Array.from(game.players.values()).map(p => ({ name: p.name, avatar: p.avatar })),
        });
        console.log(`Player left: ${player.name} (${game.players.size} total)`);
      }
    } else if (playerId && game.state !== 'idle') {
      const player = game.players.get(playerId);
      if (player) {
        console.log(`Player disconnected mid-game: ${player.name} (awaiting reconnect)`);
      }
    }
  });
}

// --- Start Server ---
const DEV_MODE = process.argv.includes('--dev');
const preferredPort = parseInt(process.env.PORT, 10) || 3000;

function startListening(port) {
  server.listen(port, () => {
    const localIP = Object.values(os.networkInterfaces())
      .flat()
      .find(i => i.family === 'IPv4' && !i.internal)?.address || 'localhost';
    console.log(`\nRobHoot server running on port ${port}`);
    console.log(`  Local:   http://localhost:${port}/host.html`);
    console.log(`  Network: http://${localIP}:${port}/play.html`);
    console.log(`\nLoaded ${questions.length} questions`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && DEV_MODE) {
      console.log(`Port ${port} in use, trying ${port + 1}...`);
      server.close();
      startListening(port + 1);
    } else {
      console.error(`Failed to start server: ${err.message}`);
      process.exit(1);
    }
  });
}

startListening(preferredPort);
