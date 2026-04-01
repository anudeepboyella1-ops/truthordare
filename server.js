const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

const PLAYER_COLORS = [
  '#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7',
  '#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#85C1E9',
  '#F8C471','#82E0AA','#F1948A','#73C6B6','#F9E79F',
  '#AF7AC5','#5DADE2','#48C9B0','#F4D03F','#EB984E',
  '#5D6D7E','#A569BD','#2E86C1','#17A589'
];

const PLAYER_EMOJIS = [
  '🦁','🐯','🦊','🐺','🦝','🐼','🐨','🦄','🐲','🦋',
  '🦅','🦉','🐬','🦈','🐊','🦖','🦩','🦚','🦜','🐙',
  '🦑','🦞','🦀','🐠'
];

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getLeaderboard(room) {
  return [...room.players]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({
      rank: i + 1, id: p.id, name: p.name,
      score: p.score, completedTasks: p.completedTasks,
      failedTasks: p.failedTasks, color: p.color, emoji: p.emoji
    }));
}

function startTimer(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.timeLeft = 600;
  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(roomCode).emit('timer-update', { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      room.timer = null;
      handleTimeout(roomCode);
    }
  }, 1000);
}

function stopTimer(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || !room.timer) return;
  clearInterval(room.timer);
  room.timer = null;
}

function handleTimeout(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const cp = room.players[room.currentPlayerIndex];
  if (!cp) return;
  cp.failedTasks++;
  room.didNotComplete.push({ playerName: cp.name, type: room.currentType, questionIndex: room.currentQuestion, reason: 'timeout' });
  io.to(roomCode).emit('player-timed-out', { player: cp, didNotComplete: room.didNotComplete });
  setTimeout(() => advanceTurn(roomCode), 3000);
}

function advanceTurn(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  stopTimer(roomCode);
  room.currentPlayerIndex++;
  if (room.currentPlayerIndex >= room.players.length) {
    room.currentPlayerIndex = 0;
    room.round = (room.round || 1) + 1;
    io.to(roomCode).emit('round-end', {
      leaderboard: getLeaderboard(room),
      didNotComplete: room.didNotComplete,
      round: room.round
    });
  } else {
    startNextTurn(roomCode);
  }
}

function startNextTurn(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.state = 'choosing';
  room.currentQuestion = null;
  room.currentType = null;
  room.votes = {};
  const cp = room.players[room.currentPlayerIndex];
  io.to(roomCode).emit('turn-start', {
    currentPlayer: cp,
    playerIndex: room.currentPlayerIndex,
    totalPlayers: room.players.length,
    round: room.round || 1,
    leaderboard: getLeaderboard(room)
  });
}

io.on('connection', (socket) => {
  console.log(`✅ Connected: ${socket.id}`);

  socket.on('create-room', ({ name }) => {
    if (!name || !name.trim()) { socket.emit('error-msg', { message: 'Enter your name!' }); return; }
    let code;
    do { code = generateRoomCode(); } while (rooms.has(code));
    const player = { id: socket.id, name: name.trim().slice(0,20), score: 0, completedTasks: 0, failedTasks: 0, color: PLAYER_COLORS[0], emoji: PLAYER_EMOJIS[0] };
    const room = { code, host: socket.id, players: [player], state: 'lobby', currentPlayerIndex: 0, currentQuestion: null, currentType: null, timer: null, timeLeft: 600, votes: {}, didNotComplete: [], round: 1, questionHistory: { truth: new Set(), dare: new Set() } };
    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    socket.emit('room-created', { code, player, players: room.players, isHost: true });
    console.log(`🏠 Room ${code} created by ${player.name}`);
  });

  socket.on('join-room', ({ name, code }) => {
    if (!name || !name.trim()) { socket.emit('error-msg', { message: 'Enter your name!' }); return; }
    const rc = code ? code.trim().toUpperCase() : '';
    if (!rc) { socket.emit('join-error', { message: 'Enter a room code!' }); return; }
    const room = rooms.get(rc);
    if (!room) { socket.emit('join-error', { message: '❌ Room not found! Check the code.' }); return; }
    if (room.state !== 'lobby') { socket.emit('join-error', { message: '🎮 Game already started!' }); return; }
    if (room.players.length >= 24) { socket.emit('join-error', { message: '🚫 Room full! (Max 24 players)' }); return; }
    const idx = room.players.length;
    const player = { id: socket.id, name: name.trim().slice(0,20), score: 0, completedTasks: 0, failedTasks: 0, color: PLAYER_COLORS[idx % PLAYER_COLORS.length], emoji: PLAYER_EMOJIS[idx % PLAYER_EMOJIS.length] };
    room.players.push(player);
    socket.join(rc);
    socket.roomCode = rc;
    socket.emit('room-joined', { code: rc, player, players: room.players, host: room.host, isHost: false });
    socket.to(rc).emit('player-joined', { player, players: room.players });
    console.log(`👤 ${player.name} joined ${rc}`);
  });

  socket.on('update-name', ({ name }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || !name || !name.trim()) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.name = name.trim().slice(0,20);
      io.to(socket.roomCode).emit('player-list-update', { players: room.players });
      socket.emit('name-updated', { name: player.name });
    }
  });

  socket.on('start-game', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    if (room.host !== socket.id) { socket.emit('error-msg', { message: 'Only the host can start!' }); return; }
    if (room.players.length < 2) { socket.emit('error-msg', { message: 'Need at least 2 players!' }); return; }
    room.state = 'playing';
    room.currentPlayerIndex = 0;
    room.didNotComplete = [];
    room.round = 1;
    io.to(socket.roomCode).emit('game-started', { players: room.players });
    setTimeout(() => startNextTurn(socket.roomCode), 2000);
  });

  socket.on('choose-option', ({ type }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state !== 'choosing') return;
    const cp = room.players[room.currentPlayerIndex];
    if (!cp || cp.id !== socket.id) return;
    room.currentType = type;
    room.state = 'question';
    const history = room.questionHistory[type];
    let qi;
    let attempts = 0;
    do { qi = Math.floor(Math.random() * 1000); attempts++; } while (history.has(qi) && history.size < 1000 && attempts < 300);
    history.add(qi);
    room.currentQuestion = qi;
    io.to(socket.roomCode).emit('question-assigned', { questionIndex: qi, type, currentPlayer: cp });
    startTimer(socket.roomCode);
  });

  socket.on('task-complete', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state !== 'question') return;
    const cp = room.players[room.currentPlayerIndex];
    if (!cp || cp.id !== socket.id) return;
    stopTimer(socket.roomCode);
    room.state = 'voting';
    room.votes = {};
    const otherCount = room.players.filter(p => p.id !== socket.id).length;
    io.to(socket.roomCode).emit('voting-start', { currentPlayer: cp, questionIndex: room.currentQuestion, type: room.currentType, totalVoters: otherCount });
  });

  socket.on('vote', ({ vote }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state !== 'voting') return;
    const cp = room.players[room.currentPlayerIndex];
    if (!cp || socket.id === cp.id || room.votes[socket.id]) return;
    room.votes[socket.id] = vote;
    const eligible = room.players.filter(p => p.id !== cp.id).length;
    const voteCount = Object.keys(room.votes).length;
    io.to(socket.roomCode).emit('vote-update', { voteCount, totalVoters: eligible });
    if (voteCount >= eligible) {
      const approvals = Object.values(room.votes).filter(v => v === 'approve').length;
      const rejections = voteCount - approvals;
      const approved = approvals >= rejections && approvals > 0;
      if (approved) {
        cp.score += 100 + approvals * 10;
        cp.completedTasks++;
      } else {
        cp.failedTasks++;
        room.didNotComplete.push({ playerName: cp.name, type: room.currentType, questionIndex: room.currentQuestion, reason: 'rejected' });
      }
      room.state = 'results';
      io.to(socket.roomCode).emit('voting-result', { approved, approvals, rejections, player: cp, scoreGained: approved ? 100 + approvals * 10 : 0, leaderboard: getLeaderboard(room), didNotComplete: room.didNotComplete });
      setTimeout(() => advanceTurn(socket.roomCode), 4000);
    }
  });

  socket.on('next-round', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.id) return;
    room.currentPlayerIndex = 0;
    room.votes = {};
    room.didNotComplete = [];
    io.to(socket.roomCode).emit('new-round-start', { round: room.round });
    setTimeout(() => startNextTurn(socket.roomCode), 1000);
  });

  socket.on('end-game', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.id) return;
    stopTimer(socket.roomCode);
    room.state = 'lobby';
    io.to(socket.roomCode).emit('game-ended', { leaderboard: getLeaderboard(room), didNotComplete: room.didNotComplete || [] });
  });

  socket.on('kick-player', ({ playerId }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.host !== socket.id) return;
    const kicked = io.sockets.sockets.get(playerId);
    if (kicked) { kicked.emit('kicked', { message: 'You were removed by the host.' }); kicked.leave(socket.roomCode); kicked.roomCode = null; }
    room.players = room.players.filter(p => p.id !== playerId);
    io.to(socket.roomCode).emit('player-list-update', { players: room.players });
  });

  socket.on('leave-room', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));

  function handleLeave(socket) {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const wasHost = room.host === socket.id;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) { stopTimer(code); rooms.delete(code); console.log(`🗑️ Room ${code} deleted`); return; }
    if (wasHost) { room.host = room.players[0].id; io.to(code).emit('host-changed', { newHostId: room.host }); }
    socket.to(code).emit('player-left', { playerId: socket.id, players: room.players });
    if (room.state !== 'lobby') {
      if (room.currentPlayerIndex >= room.players.length) room.currentPlayerIndex = 0;
      if (room.players.length < 2) {
        stopTimer(code);
        room.state = 'lobby';
        io.to(code).emit('game-ended', { reason: 'Not enough players', leaderboard: getLeaderboard(room) });
      }
    }
    socket.roomCode = null;
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 Truth or Dare Server running at http://localhost:${PORT}\n`);
});
