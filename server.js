import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import path from 'path';

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
const csvPath = path.join(__dirname, 'questions.csv');

function loadQuestions() {
  const rows = parseCSV(csvPath);
  return rows.map(q => ({
    question: q.question,
    type: q.type,
    options: [q.option1, q.option2, q.option3, q.option4].filter(o => o !== ''),
    correct: parseInt(q.correct, 10),
    timeLimit: parseInt(q.time_limit, 10) || 20,
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
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
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

// --- Express ---
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
    players: Array.from(game.players.values()).map(p => p.name),
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
      const { pin, name } = msg.data || {};
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
        ws,
        score: 0,
        answer: null,
        answerTime: null,
        lastPoints: 0,
      });

      send(ws, 'joined', { name: trimmedName });
      sendToHost('player-joined', {
        name: trimmedName,
        count: game.players.size,
        players: Array.from(game.players.values()).map(p => p.name),
      });
      console.log(`Player joined: ${trimmedName} (${game.players.size} total)`);

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

      // Auto-reveal if everyone answered
      if (game.answerCount >= game.players.size) {
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
          players: Array.from(game.players.values()).map(p => p.name),
        });
        console.log(`Player left: ${player.name} (${game.players.size} total)`);
      }
    }
  });
}

// --- Start Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const localIP = Object.values(os.networkInterfaces())
    .flat()
    .find(i => i.family === 'IPv4' && !i.internal)?.address || 'localhost';
  console.log(`\nRobHoot server running on port ${PORT}`);
  console.log(`  Local:   http://localhost:${PORT}/host.html`);
  console.log(`  Network: http://${localIP}:${PORT}/play.html`);
  console.log(`\nLoaded ${questions.length} questions`);
});
