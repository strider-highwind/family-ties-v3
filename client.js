
const $ = (sel, parent=document) => parent.querySelector(sel);
const $$ = (sel, parent=document) => Array.from(parent.querySelectorAll(sel));
const view = $('#view');
const socket = io();

let state = { room: null, hand: [], chat: [], playerToken: localStorage.getItem('ft_token') || null };

function cardURL(code){
  return `cards/${code}.svg`;
}

function renderLobby(){
  const t = $('#tmpl-lobby').content.cloneNode(true);
  t.querySelector('#btnCreate').onclick = () => {
    const name = t.querySelector('#createName').value || 'Player';
    const roomName = (t.querySelector('#createRoom').value || '').trim();
    socket.emit('room:create', {roomName, playerName:name, token: state.playerToken}, (res)=>{
      if(res?.error){ alert(res.error); return; }
      if(res?.token){ state.playerToken = res.token; localStorage.setItem('ft_token', res.token); }
    });
  };
  t.querySelector('#btnJoin').onclick = (e) => {
    const name = t.querySelector('#joinName').value || 'Player';
    const roomId = t.querySelector('#joinRoom').value.trim();
    const asSpectator = $('#asSpectator', t)?.checked || false;
    if(!roomId){ alert('Enter a room ID'); return; }
    socket.emit('room:join', {roomId, playerName:name, asSpectator, token: state.playerToken}, (res)=>{
      if(res?.error){ alert(res.error); return; }
      if(res?.token){ state.playerToken = res.token; localStorage.setItem('ft_token', res.token); }
    });
  };
  const roomsList = t.querySelector('#roomsList');
  fetch('/api/rooms').then(r=>r.json()).then(rooms=>{
    if(!rooms.length){ roomsList.textContent = 'No rooms yet — create one!'; return; }
    const ul = document.createElement('ul');
    rooms.forEach(r=>{
      const li = document.createElement('li');
      const ts = new Date(r.createdAt || Date.now()).toLocaleString();
      li.innerHTML = `<span class="mono">${r.id}</span> — ${r.players}/4 (+${r.spectators} spect) — ${r.phase} — ${r.name||''} — ${ts}`;
      ul.appendChild(li);
    });
    roomsList.appendChild(ul);
  });
  // spectator toggle
  const specWrap = document.createElement('label');
  specWrap.style.display='block';
  specWrap.style.marginTop='6px';
  specWrap.innerHTML = `<input type="checkbox" id="asSpectator"> Join as spectator`;
  t.querySelector('.grid.two div:last-child').appendChild(specWrap);

  view.innerHTML = '';
  view.appendChild(t);
  $('#roomId').textContent = '—';
}

function renderChat(container){
  const wrap = document.createElement('div');
  wrap.id = 'chat';
  wrap.innerHTML = `<div id="chatLog"></div>
  <div id="chatForm"><input id="chatInput" placeholder="Type a message…" maxlength="300"><button id="chatSend">Send</button></div>`;
  container.appendChild(wrap);
  const log = wrap.querySelector('#chatLog');
  function redraw(){
    log.innerHTML = '';
    state.chat.forEach(m=>{
      const row = document.createElement('div');
      const t = new Date(m.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      row.className = 'chatrow';
      row.innerHTML = `<span class="time">${t}</span> <span class="name">${m.name}</span>: <span class="msg">${m.msg}</span>`;
      log.appendChild(row);
    });
    log.scrollTop = log.scrollHeight;
  }
  redraw();
  $('#chatSend').onclick = send;
  $('#chatInput').addEventListener('keydown', e=>{ if(e.key==='Enter') send(); });
  function send(){
    const inp = $('#chatInput'); const txt = inp.value.trim(); if(!txt) return;
    socket.emit('chat:send', {msg: txt}); inp.value='';
  }
}

function cardImg(code){
  const img = document.createElement('img');
  img.src = cardURL(code);
  img.alt = code;
  img.className = 'cardimg';
  img.draggable = true;
  return img;
}

function renderRoom(room){
  const t = $('#tmpl-room').content.cloneNode(true);
  t.querySelector('[data-bind="roomId"]').textContent = room.id;
  $('#roomId').textContent = room.id;

  const playersDiv = t.querySelector('#players');
  for (let s=0;s<4;s++){
    const p = room.players.find(p=>p.seat===s);
    const el = document.createElement('div');
    el.className = 'p';
    el.innerHTML = `<div class="seat">Seat ${s} ${s%2===0?'(N/S)':'(E/W)'} </div>
    <div class="name">${p? p.name : '—'}</div>
    <div>${p? (p.ready? '<span class="badge">ready</span>':'' ) : ''}</div>`;
    playersDiv.appendChild(el);
  }

  const status = t.querySelector('#status');
  const controls = t.querySelector('#controls');
  const table = t.querySelector('#table');
  const handDiv = t.querySelector('#hand');
  const scoresDiv = t.querySelector('#scores');

  renderChat(scoresDiv);

  const mySeat = room.players.find(p=>p.id===socket.id)?.seat;
  const amSpectator = !room.players.some(p=>p.id===socket.id);

  if (room.phase === 'lobby'){
    status.textContent = amSpectator ? 'Spectating lobby. You may take an empty seat if available.' : 'Waiting for players. Ready up to begin.';
    if (!amSpectator){
      const btn = document.createElement('button'); btn.textContent='Ready'; btn.onclick=()=>socket.emit('player:ready'); controls.appendChild(btn);
    }
    // Seat take buttons
    const taken = room.players.map(p=>p.seat);
    for (let s=0;s<4;s++){
      if (!taken.includes(s)){
        const b = document.createElement('button');
        b.textContent = `Take Seat ${s}`;
        b.onclick = ()=>{
          // re-join as player (server will seat via token)
          socket.emit('room:join', {roomId: room.id, playerName:'', asSpectator:false, token: state.playerToken}, ()=>{});
        };
        controls.appendChild(b);
      }
    }
  }

  if (room.phase === 'bidding'){
    status.textContent = `Bidding — ${room.turnSeat}'s turn.`;
    if (!amSpectator && room.turnSeat === mySeat && room.bids[mySeat] === undefined && !room.nilCalls[mySeat] && !room.blindNil[mySeat]){
      const input = document.createElement('input');
      input.placeholder = 'Enter bid (0-13), "nil", or "blind nil"';
      const btn = document.createElement('button'); btn.textContent='Submit Bid';
      btn.onclick = ()=>{
        const v = input.value.trim().toLowerCase();
        socket.emit('bidding:bid', {bid: v});
      };
      const bNil = document.createElement('button'); bNil.textContent='Nil'; bNil.onclick=()=>socket.emit('bidding:bid',{bid:'nil'});
      const bBlind = document.createElement('button'); bBlind.textContent='Blind Nil'; bBlind.onclick=()=>socket.emit('bidding:bid',{bid:'blind nil'});
      controls.append(input, btn, bNil, bBlind);
    }
  }

  if (room.phase === 'playing' || room.phase === 'scoring'){
    const drop = document.createElement('div');
    drop.id = 'dropzone';
    drop.textContent = amSpectator ? 'Spectating — live table' : 'Drop a card here to play';
    drop.ondragover = (e)=>{ e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = ()=>drop.classList.remove('over');
    drop.ondrop = (e)=>{
      e.preventDefault(); drop.classList.remove('over');
      if (amSpectator) return;
      const card = e.dataTransfer.getData('text/card'); if(card){ socket.emit('play:card', {card}); }
    };
    table.appendChild(drop);
    for (const play of room.currentTrick){
      const d = document.createElement('div');
      d.className = 'played';
      const img = cardImg(play.card); img.draggable=false; img.classList.add('small');
      d.appendChild(img);
      const label = document.createElement('div'); label.textContent = `Seat ${play.seat}`; label.style.fontSize='12px'; label.style.color='var(--muted)';
      d.appendChild(label);
      table.appendChild(d);
    }
    status.textContent = room.phase === 'scoring' ? 'Hand complete — see scores below.' : `Playing — Seat ${room.turnSeat}'s turn`;
  }

  // Hand
  if (!amSpectator && state.hand?.length){
    state.hand.forEach(code=>{
      const wrap = document.createElement('div'); wrap.className='cardwrap';
      const img = cardImg(code);
      img.addEventListener('dragstart', (e)=>{ e.dataTransfer.setData('text/card', code); setTimeout(()=>img.classList.add('dragging'),0); });
      img.addEventListener('dragend', ()=>img.classList.remove('dragging'));
      img.onclick = ()=>animatePlay(img, ()=>socket.emit('play:card', {card:code}));
      wrap.appendChild(img);
      handDiv.appendChild(wrap);
    });
  }

  // Bids & tricks
  const bidsTable = document.createElement('table');
  bidsTable.innerHTML = `<tr><th>Seat</th><th>Bid</th><th>Nil</th><th>Blind Nil</th><th>Tricks</th></tr>`;
  for (let s=0;s<4;s++){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${s} ${s%2===0?'(N/S)':'(E/W)'}</td>
      <td>${room.bids[s] === undefined ? '—' : room.bids[s] }</td>
      <td>${room.nilCalls[s] ? '✓' : ''}</td>
      <td>${room.blindNil[s] ? '✓' : ''}</td>
      <td>${room.tricksWon[s]||0}</td>`;
    bidsTable.appendChild(tr);
  }
  scoresDiv.appendChild(bidsTable);

  // Team scores
  const team = document.createElement('div');
  const s0 = room.scores[0]; const s1 = room.scores[1];
  team.innerHTML = `<p><strong>Team N/S</strong>: ${s0.points} pts (bags ${s0.bags}) &nbsp; | &nbsp; <strong>Team E/W</strong>: ${s1.points} pts (bags ${s1.bags})</p>`;
  scoresDiv.appendChild(team);

  if (!amSpectator && room.phase === 'scoring'){
    const btnNext = document.createElement('button'); btnNext.textContent='Next Hand'; btnNext.onclick=()=>socket.emit('scoring:nextHand'); controls.appendChild(btnNext);
  }

  view.innerHTML = '';
  view.appendChild(t);
}

function animatePlay(el, done){
  const rect = el.getBoundingClientRect();
  const clone = el.cloneNode(true);
  clone.style.position='fixed'; clone.style.left = rect.left+'px'; clone.style.top = rect.top+'px';
  clone.style.width = rect.width+'px'; clone.style.height = rect.height+'px'; clone.style.zIndex = 1000;
  clone.classList.add('flying');
  document.body.appendChild(clone);
  requestAnimationFrame(()=>{
    clone.style.transform = 'translate(0,-140px) scale(1.1)'; clone.style.opacity = '0.85';
  });
  setTimeout(()=>{ clone.remove(); done && done(); }, 300);
}

socket.on('room:update', (room)=>{ state.room = room; renderRoom(room); });
socket.on('room:hand', (hand)=>{
  state.hand = hand;
  const handDiv = $('#hand');
  if (handDiv){
    handDiv.innerHTML = '';
    hand.forEach(code=>{
      const wrap = document.createElement('div'); wrap.className='cardwrap';
      const img = cardImg(code);
      img.addEventListener('dragstart', (e)=>{ e.dataTransfer.setData('text/card', code); setTimeout(()=>img.classList.add('dragging'),0); });
      img.addEventListener('dragend', ()=>img.classList.remove('dragging'));
      img.onclick = ()=>animatePlay(img, ()=>socket.emit('play:card', {card:code}));
      wrap.appendChild(img);
      handDiv.appendChild(wrap);
    });
  }
});
socket.on('chat:update', (messages)=>{
  state.chat = messages;
  const log = $('#chatLog');
  if (log){
    log.innerHTML = '';
    state.chat.forEach(m=>{
      const row = document.createElement('div');
      const t = new Date(m.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      row.className = 'chatrow';
      row.innerHTML = `<span class="time">${t}</span> <span class="name">${m.name}</span>: <span class="msg">${m.msg}</span>`;
      log.appendChild(row);
    });
    log.scrollTop = log.scrollHeight;
  }
});

socket.on('connect', ()=>{ renderLobby(); });
