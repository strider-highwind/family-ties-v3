
/**
 * Family Ties — Multiplayer Spades (v3)
 * Adds: Custom card art, Spectators, Seat reclaim on reconnects (5 min hold)
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static('public'));
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const SAVE_PATH = path.join(__dirname, 'rooms.json');
const HOLD_MS = 5 * 60 * 1000;

// ---- Game Logic ----

const SUITS = ['C','D','H','S'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function newDeck(){
  const deck = [];
  for (const s of SUITS){ for (const r of RANKS){ deck.push(r + s); } }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function cardValue(card){ return RANKS.indexOf(card.slice(0,-1)); }
function suit(card){ return card.slice(-1); }
function seatTeam(seat){ return seat % 2; }
function cardSort(a,b){ const sa=suit(a), sb=suit(b); return sa===sb ? cardValue(a)-cardValue(b) : ['C','D','H','S'].indexOf(sa)-['C','D','H','S'].indexOf(sb); }

// ---- Room storage ----
const rooms = new Map(); // roomId -> room

function persistRooms(){
  try {
    const data = Array.from(rooms.values()).map(r => ({
      id: r.id,
      createdAt: r.createdAt,
      scores: r.scores,
      roomName: r.roomName || '',
      chat: r.chat.slice(-50).map(m => ({name:m.name, msg:m.msg, at:m.at})),
    }));
    fs.writeFileSync(SAVE_PATH, JSON.stringify({version:3, rooms:data}, null, 2));
  } catch(e){ console.error('Persist failed', e); }
}
function loadRooms(){
  try{
    if (!fs.existsSync(SAVE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(SAVE_PATH, 'utf8'));
    if (!raw?.rooms) return;
    for (const r of raw.rooms){
      const room = createRoom(r.id, r.roomName, true);
      room.scores = r.scores || room.scores;
      room.chat = r.chat || [];
      room.phase = 'lobby';
    }
    console.log(`Restored ${rooms.size} lobby(ies) from disk.`);
  }catch(e){ console.error('Failed to load rooms:', e); }
}

// ---- Room helpers ----
function createRoom(roomName, displayName, restoring=false){
  const id = (roomName || uuidv4().slice(0,6).toUpperCase()).toUpperCase();
  if (rooms.has(id)) return rooms.get(id);
  const room = {
    id,
    roomName: displayName || id,
    createdAt: Date.now(),
    players: [], // {id, name, seat, ready, token, lastSeen}
    spectators: [], // {id, name}
    phase: 'lobby',
    dealerSeat: 0,
    turnSeat: 0,
    leaderSeat: 0,
    spadesBroken: false,
    hands: {}, // token -> [cards]  (token persists across reconnects)
    tokenSeat: {}, // token -> seat
    bids: {},  // seat -> number
    blindNil: {},
    nilCalls: {},
    tricksWon: {0:0,1:0,2:0,3:0},
    currentTrick: [],
    scores: { 0: { points: 0, bags: 0 }, 1: { points: 0, bags: 0 } },
    chat: [],
  };
  rooms.set(id, room);
  if (!restoring) persistRooms();
  return room;
}

function getPlayerBySeat(room, seat){
  return room.players.find(p=>p.seat===seat);
}

function deal(room){
  const deck = newDeck();
  room.bids = {}; room.nilCalls = {}; room.blindNil = {};
  room.tricksWon = {0:0,1:0,2:0,3:0};
  room.currentTrick = []; room.spadesBroken = false;
  // Hands are per token so they survive reconnects
  for (let i=0;i<4;i++){
    const p = getPlayerBySeat(room, i);
    if (p && p.token){
      room.hands[p.token] = deck.slice(i*13, (i+1)*13).sort(cardSort);
      room.tokenSeat[p.token] = i;
    }
  }
  room.turnSeat = (room.dealerSeat + 1) % 4;
  room.leaderSeat = room.turnSeat;
  room.phase = 'bidding';
  persistRooms();
}

function canPlay(room, playerSeat, token, card){
  const hand = room.hands[token];
  if (!hand?.includes(card)) return false;
  if (room.turnSeat !== playerSeat) return false;
  if (room.currentTrick.length === 0){
    if (suit(card) === 'S' && !room.spadesBroken){
      const nonSpade = hand.some(c => suit(c) !== 'S');
      if (nonSpade) return false;
    }
    return true;
  } else {
    const leadSuit = suit(room.currentTrick[0].card);
    const hasLead = hand.some(c => suit(c) === leadSuit);
    if (hasLead && suit(card) !== leadSuit) return false;
    return true;
  }
}

function trickWinner(trick){
  const leadSuit = suit(trick[0].card);
  let winIdx = 0;
  for (let i=1;i<trick.length;i++){
    const s = suit(trick[i].card);
    const w = trick[winIdx];
    if (s === 'S' && suit(w.card) !== 'S'){ winIdx = i; }
    else if (s === suit(w.card) && cardValue(trick[i].card) > cardValue(w.card)){ winIdx = i; }
  }
  return trick[winIdx].seat;
}

function scoreHand(room){
  const teamTricks = {0: room.tricksWon[0]+room.tricksWon[2], 1: room.tricksWon[1]+room.tricksWon[3]};
  const bidsTeam = {0: (room.bids[0]||0)+(room.bids[2]||0), 1: (room.bids[1]||0)+(room.bids[3]||0)};
  for (const team of [0,1]){
    const tricks = teamTricks[team];
    const bids = bidsTeam[team];
    if (tricks >= bids){
      room.scores[team].points += bids * 10 + (tricks - bids);
      room.scores[team].bags += (tricks - bids);
      if (room.scores[team].bags >= 10){ room.scores[team].points -= 100; room.scores[team].bags -= 10; }
    } else {
      room.scores[team].points -= bids * 10;
    }
  }
  for (const seat of [0,1,2,3]){
    const team = seatTeam(seat);
    const wonAny = room.tricksWon[seat] > 0;
    if (room.nilCalls[seat]){ room.scores[team].points += wonAny ? -100 : 100; }
    if (room.blindNil[seat]){ room.scores[team].points += wonAny ? -200 : 200; }
  }
  room.phase = 'scoring';
  persistRooms();
}

function broadcastState(room){
  const payload = {
    id: room.id,
    players: room.players.map(p=>({id:p.id,name:p.name,seat:p.seat,ready:p.ready})),
    spectators: room.spectators.map(s=>({id:s.id,name:s.name})),
    phase: room.phase,
    dealerSeat: room.dealerSeat,
    turnSeat: room.turnSeat,
    leaderSeat: room.leaderSeat,
    spadesBroken: room.spadesBroken,
    bids: room.bids,
    nilCalls: room.nilCalls,
    blindNil: room.blindNil,
    tricksWon: room.tricksWon,
    currentTrick: room.currentTrick,
    scores: room.scores,
    chat: room.chat.slice(-100)
  };
  io.to(room.id).emit('room:update', payload);
  // Send personal hands to players by token
  for (const p of room.players){
    if (!p.token) continue;
    const hide = room.phase === 'bidding' && room.blindNil[p.seat];
    const hand = hide ? [] : (room.hands[p.token] || []);
    io.to(p.id).emit('room:hand', hand);
  }
}

function claimSeat(room, token, name){
  // reuse seat if token known
  if (token && room.tokenSeat[token] !== undefined){
    const seat = room.tokenSeat[token];
    const prev = room.players.find(p=>p.seat===seat);
    if (prev){ prev.token = token; return seat; }
    return seat;
  }
  // otherwise the first free seat
  const taken = room.players.map(p=>p.seat);
  const seat = [0,1,2,3].find(s=>!taken.includes(s));
  return seat;
}

// ---- Socket.IO ----
io.on('connection', (socket) => {
  // initial handshake carries client token if any
  socket.on('room:create', ({roomName, playerName, token}, cb) => {
    const room = createRoom(roomName, roomName);
    socket.join(room.id);
    // join as player if seat available, else spectator
    let seat = claimSeat(room, token, playerName);
    if (seat === undefined){
      room.spectators.push({id:socket.id, name:playerName||'Spectator'});
      socket.data.spectator = true;
    } else {
      const p = {id: socket.id, name: playerName || 'Player', seat, ready: false, token: token || uuidv4(), lastSeen: Date.now()};
      socket.data.token = p.token;
      room.players = room.players.filter(x=>x.seat!==seat);
      room.players.push(p);
      room.tokenSeat[p.token] = seat;
    }
    socket.data.roomId = room.id;
    broadcastState(room);
    persistRooms();
    cb && cb({roomId: room.id, seat, spectator: seat===undefined, token: socket.data.token});
  });

  socket.on('room:join', ({roomId, playerName, asSpectator, token}, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({error:'Room not found'});
    socket.join(room.id);
    socket.data.roomId = room.id;

    if (asSpectator){
      room.spectators.push({id:socket.id, name:playerName||'Spectator'});
      socket.data.spectator = true;
      broadcastState(room);
      return cb && cb({roomId:room.id, spectator:true});
    }

    let seat = claimSeat(room, token, playerName);
    if (seat === undefined){
      room.spectators.push({id:socket.id, name:playerName||'Spectator'});
      socket.data.spectator = true;
      broadcastState(room);
      return cb && cb({roomId:room.id, spectator:true});
    }
    const p = {id: socket.id, name: playerName || 'Player', seat, ready: false, token: token || uuidv4(), lastSeen: Date.now()};
    socket.data.token = p.token;
    room.players = room.players.filter(x=>x.seat!==seat);
    room.players.push(p);
    room.tokenSeat[p.token] = seat;
    broadcastState(room);
    persistRooms();
    cb && cb({roomId: room.id, seat, spectator:false, token: socket.data.token});
  });

  socket.on('player:ready', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || socket.data.spectator) return;
    const p = room.players.find(p=>p.id===socket.id);
    if (p){ p.ready = true; p.lastSeen = Date.now(); }
    if (room.players.length === 4 && room.players.every(p=>p.ready)){
      deal(room);
    }
    broadcastState(room);
  });

  socket.on('bidding:bid', ({bid}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== 'bidding' || socket.data.spectator) return;
    const p = room.players.find(p=>p.id===socket.id);
    if (!p) return;
    const seat = p.seat;
    if (room.bids[seat] !== undefined || room.nilCalls[seat] || room.blindNil[seat]) return;
    const bStr = (typeof bid === 'string') ? bid.toLowerCase() : bid;

    if (bStr === 'nil'){
      room.bids[seat] = 0; room.nilCalls[seat] = true;
    } else if (bStr === 'blindnil' || bStr === 'blind nil'){
      room.bids[seat] = 0; room.blindNil[seat] = true;
    } else {
      const n = parseInt(bid, 10);
      if (isNaN(n) || n < 0 || n > 13) return;
      room.bids[seat] = n;
    }
    room.turnSeat = (room.turnSeat + 1) % 4;
    if ([0,1,2,3].every(s => room.bids[s] !== undefined || room.nilCalls[s] || room.blindNil[s])){
      room.phase = 'playing';
      room.turnSeat = room.leaderSeat;
    }
    broadcastState(room);
  });

  socket.on('play:card', ({card}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== 'playing' || socket.data.spectator) return;
    const p = room.players.find(p=>p.id===socket.id);
    if (!p) return;
    const seat = p.seat;
    if (!canPlay(room, seat, p.token, card)) return;
    const hand = room.hands[p.token];
    room.hands[p.token] = hand.filter(c=>c!==card);
    room.currentTrick.push({seat, card});
    if (suit(card)==='S') room.spadesBroken = true;
    room.turnSeat = (room.turnSeat + 1) % 4;

    if (room.currentTrick.length === 4){
      const winnerSeat = trickWinner(room.currentTrick);
      room.tricksWon[winnerSeat] += 1;
      room.leaderSeat = winnerSeat;
      room.turnSeat = winnerSeat;
      room.currentTrick = [];
      const cardsLeft = Object.values(room.hands).reduce((a,h)=>a + h.length, 0);
      if (cardsLeft === 0){
        scoreHand(room);
      }
    }
    broadcastState(room);
  });

  socket.on('scoring:nextHand', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.phase !== 'scoring' || socket.data.spectator) return;
    room.dealerSeat = (room.dealerSeat + 1) % 4;
    for (const p of room.players){ p.ready = true; }
    room.nilCalls = {}; room.blindNil = {};
    deal(room);
    broadcastState(room);
  });

  // Chat
  socket.on('chat:send', ({msg}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !msg) return;
    const name = (room.players.find(p=>p.id===socket.id)?.name) || (room.spectators.find(s=>s.id===socket.id)?.name) || 'Guest';
    const entry = {name, msg: String(msg).slice(0,300), at: Date.now()};
    room.chat.push(entry); room.chat = room.chat.slice(-300);
    io.to(room.id).emit('chat:update', room.chat);
    persistRooms();
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    // spectators simply drop
    room.spectators = room.spectators.filter(s=>s.id!==socket.id);

    // players: hold their seat for HOLD_MS
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx !== -1){
      const p = room.players[idx];
      p.id = null; // seat held
      p.lastSeen = Date.now();
      // leave in array
    }
    broadcastState(room);
    persistRooms();

    // cleanup seats after hold window
    setTimeout(()=>{
      const r = rooms.get(roomId);
      if (!r) return;
      const pp = r.players.find(x=>x.id===null && (Date.now()-x.lastSeen>HOLD_MS));
      if (pp){
        // remove seat and hand
        r.players = r.players.filter(x=>x!==pp);
        if (pp.token){ delete r.hands[pp.token]; delete r.tokenSeat[pp.token]; }
        broadcastState(r);
        persistRooms();
      }
    }, HOLD_MS + 2000);
  });
});

app.get('/api/rooms', (req,res)=>{
  res.json(Array.from(rooms.values()).map(r=>({id:r.id, players:r.players.length, phase:r.phase, name:r.roomName, createdAt:r.createdAt, spectators:r.spectators.length})));
});

loadRooms();
server.listen(PORT, () => console.log(`Family Ties server listening on http://localhost:${PORT}`));
