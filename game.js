/* Momo – interface, réseau (SDK ChadGang) et boucle de jeu.
   Modèle : l'hôte (premier joueur de la salle) fait foi. Il valide les actions, fait jouer les bots
   et diffuse l'état COMPLET de la partie (version croissante, envoyé avec keep:true). */
(() => {
  'use strict';

  const E = window.MomoEngine;
  const F = window.FX;
  const $ = (s, el = document) => el.querySelector(s);
  const app = $('#app');
  const HUB = !!window.ChadGang;
  const TOUCH = window.matchMedia && matchMedia('(hover: none)').matches;
  const SPEED = Math.max(1, Number(new URLSearchParams(location.search).get('speed')) || 1); // accélérateur de test
  const BOT_NAMES = ['Mochi', 'Gyoza', 'Bao', 'Ramen', 'Tofu'];
  const REACTIONS = ['😂', '🔥', '😱', '👏', '🥟'];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  const S = {
    screen: 'menu', mode: null, room: null, code: '',
    me: { id: 'local-' + Math.random().toString(36).slice(2, 8), name: 'Joueur', avatar: null },
    players: [], isHost: false, st: null, mySeat: -1, avatars: {},
    lastEv: 0, evKey: null, timer: null, reported: null,
    shown: new Set(), handKey: '', ovKey: '', sel: null, lastReact: 0,
  };

  /* =====================================================================
     Démarrage
     ===================================================================== */
  async function init() {
    try { S.me.name = localStorage.getItem('momo.name') || S.me.name; } catch (e) { /* ignore */ }
    if (HUB) {
      try {
        const m = await ChadGang.me();
        S.me = { id: m.id, name: m.name || 'Joueur', avatar: m.avatar || null };
      } catch (e) { /* mode de secours */ }
    }
    renderMenu();
    const code = HUB && ChadGang.room ? ChadGang.room() : null;
    if (code) joinRoom(code, false);
  }

  /* =====================================================================
     Réseau
     ===================================================================== */
  function localRoom() {
    const h = {};
    return {
      on(e, f) { h[e] = f; },
      send(d) { setTimeout(() => h.message && h.message(d, { id: S.me.id, name: S.me.name }), 0); },
      leave() {},
    };
  }

  function updateHost() {
    S.isHost = S.players.length > 0 && S.players[0].id === S.me.id;
  }

  function isPresent(id) { return S.players.some((p) => p.id === id); }

  function hello() {
    if (S.room && S.mode === 'online') S.room.send({ t: 'hi', avatar: S.me.avatar });
  }

  function joinRoom(raw, create) {
    const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (code.length < 4) { toast('Le code doit faire au moins 4 caractères.'); return; }
    if (!HUB) { toast('Le multijoueur nécessite le hub.'); return; }
    leaveRoom();
    S.mode = 'online'; S.code = code; S.screen = 'wait';
    renderWait();
    const room = ChadGang.join(code, { create });
    S.room = room;
    room.on('ready', (info) => {
      S.players = info.players || [];
      updateHost();
      if (info.last && info.last.t === 'state' && info.last.s) setState(info.last.s, true);
      else if (S.isHost && !S.st) initLobby();
      hello();
      refresh();
    });
    room.on('players', (list) => {
      S.players = list || [];
      updateHost();
      if (S.isHost && !S.st) initLobby();
      hello();
      refresh();
      if (S.isHost) schedule();
    });
    room.on('message', onMessage);
    room.on('error', (msg) => { toast(msg || 'Salle introuvable.'); leaveRoom(); renderMenu(); });
  }

  function createRoom() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
    joinRoom(code, true);
  }

  function startSolo() {
    leaveRoom();
    S.mode = 'solo'; S.code = '';
    S.room = localRoom(); S.room.on('message', onMessage);
    S.players = [{ id: S.me.id, name: S.me.name }];
    updateHost();
    newSoloGame();
  }

  function leaveRoom() {
    clearTimeout(S.timer);
    if (S.room) { try { S.room.leave(); } catch (e) { /* ignore */ } }
    S.room = null; S.st = null; S.players = []; S.isHost = false; S.mode = null; S.mySeat = -1;
    S.evKey = null; S.ovKey = ''; S.handKey = '';
    $('#overlay').innerHTML = ''; $('#modal').innerHTML = '';
  }

  function onMessage(d, from) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'state') {
      if (d.s && (!S.st || d.s.v > S.st.v)) setState(d.s);
    } else if (d.t === 'act') {
      if (S.isHost) hostAct(from.id, d.a);
    } else if (d.t === 'hi') {
      S.avatars[from.id] = d.avatar || null;
    } else if (d.t === 'react') {
      showReaction(from.id, d.e);
    }
  }

  function act(a) {
    if (S.isHost) hostAct(S.me.id, a);
    else if (S.room) S.room.send({ t: 'act', a });
  }

  /* =====================================================================
     Logique de l'hôte
     ===================================================================== */
  function initLobby() {
    S.st = { v: 0, phase: 'lobby', bots: null };
    commit();
  }

  function lobbyBots() {
    const h = Math.min(S.players.length, 6);
    const nb = S.st.bots == null ? Math.max(0, 4 - h) : S.st.bots;
    return clamp(Math.min(nb, 6 - h), 0, 5);
  }

  function startGame() {
    const humans = S.players.slice(0, 6).map((p) => ({ id: p.id, name: p.name, bot: false }));
    const nb = lobbyBots();
    if (humans.length + nb < 3) return 'Il faut au moins 3 joueurs : ajoute des bots.';
    const names = E.shuffle(BOT_NAMES.slice());
    const bots = Array.from({ length: nb }, (_, i) => ({ id: 'bot' + i, name: names[i] + ' 🤖', bot: true }));
    const seats = E.shuffle(humans.concat(bots));
    const st = E.newGame(seats, (S.code || 'SOLO') + '-' + Date.now().toString(36));
    st.v = S.st.v;
    S.st = st;
    return null;
  }

  function newSoloGame() {
    S.st = { v: S.st ? S.st.v : 0, phase: 'lobby', bots: 3 };
    startGame();
    commit();
  }

  function hostAct(pid, a) {
    const st = S.st;
    if (!st || !a) return;
    const seat = st.seats ? st.seats.findIndex((s) => s.id === pid) : -1;
    const mine = pid === S.me.id;
    let err = null, changed = true;
    switch (a.k) {
      case 'bots':
        if (st.phase === 'lobby' && mine) st.bots = clamp(a.n | 0, 0, 5); else changed = false;
        break;
      case 'start':
        if (st.phase === 'lobby' && mine) err = startGame(); else changed = false;
        break;
      case 'bid':
        if (seat >= 0 && st.phase === 'bid') err = E.applyBid(st, seat, a.n | 0); else changed = false;
        break;
      case 'play':
        if (seat >= 0 && st.phase === 'play') err = E.applyPlay(st, seat, a.c | 0); else changed = false;
        break;
      case 'ready':
        if (seat >= 0 && st.phase === 'roundEnd' && !st.ready.includes(seat)) st.ready.push(seat); else changed = false;
        break;
      case 'again':
        if (st.phase === 'over' && mine) {
          if (S.mode === 'solo') { newSoloGame(); return; }
          S.st = { v: st.v, phase: 'lobby', bots: null };
        } else changed = false;
        break;
      default: changed = false;
    }
    if (err) { if (mine) toast(err); return; }
    if (changed) commit();
  }

  // Diffuse l'état complet (version +1) et l'applique chez l'hôte.
  function commit() {
    const st = S.st;
    st.v++;
    if (S.room) S.room.send({ t: 'state', s: st }, { keep: true });
    setState(st);
  }

  function autoSeat(st, seat) {
    const s = st.seats[seat];
    return s.bot || !isPresent(s.id);
  }

  // Prochaine action automatique de l'hôte : bots, joueurs absents, fin de pli, manche suivante.
  function schedule() {
    clearTimeout(S.timer);
    const st = S.st;
    if (!S.isHost || !st || st.phase === 'lobby' || st.phase === 'over') return;
    let delay = 0, fn = null;
    if (st.phase === 'bid' && autoSeat(st, st.turn)) {
      delay = rnd(900, 1700);
      fn = () => {
        const seat = st.turn;
        if (E.applyBid(st, seat, E.botBid(st, seat))) {
          for (let n = 0; n <= st.round; n++) if (!E.applyBid(st, seat, n)) break;
        }
      };
    } else if (st.phase === 'play' && st.trick.length < st.N && autoSeat(st, st.turn)) {
      delay = rnd(800, 1500);
      fn = () => {
        const seat = st.turn;
        if (E.applyPlay(st, seat, E.botPlay(st, seat))) E.applyPlay(st, seat, E.legalCards(st, seat)[0]);
      };
    } else if (st.phase === 'play' && st.trick.length === st.N) {
      delay = 1800;
      fn = () => { sweep(st); E.resolveTrick(st); };
    } else if (st.phase === 'roundEnd') {
      const humans = st.seats.map((s, i) => i).filter((i) => !st.seats[i].bot && isPresent(st.seats[i].id));
      const allReady = humans.every((i) => st.ready.includes(i));
      delay = allReady ? 700 : 15000;
      fn = () => E.nextRound(st);
    }
    if (!fn) return;
    const v = st.v;
    S.timer = setTimeout(() => {
      if (S.st !== st || st.v !== v || !S.isHost) return;
      fn();
      commit();
    }, delay / SPEED);
  }

  /* =====================================================================
     Application d'un état + effets
     ===================================================================== */
  function setState(s, silent) {
    const old = S.st;
    if (!silent && old && old !== s && old.phase === 'play' && old.trick && old.trick.length === old.N &&
        s.trick && s.trick.length === 0 && old.win != null) sweep(old);
    S.st = s;
    const key = s.gameId || 'lobby';
    if (S.evKey !== key) { S.evKey = key; S.lastEv = (silent || !old) ? (s.eid || 0) : 0; }
    else if (silent) S.lastEv = s.eid || 0;
    S.mySeat = s.seats ? s.seats.findIndex((x) => x.id === S.me.id) : -1;
    S.sel = null;
    if (silent && s.trick) s.trick.forEach((t) => S.shown.add(trickKey(s, t)));
    refresh();
    processEvents();
    maybeReport();
    if (S.isHost) schedule();
  }

  const trickKey = (st, t) => st.gameId + ':' + st.round + ':' + t.s + ':' + t.c;

  function processEvents() {
    const st = S.st;
    if (!st || !st.events) return;
    const evs = st.events.filter((e) => e.id > S.lastEv).sort((a, b) => a.id - b.id);
    for (const ev of evs) { S.lastEv = ev.id; handleEvent(ev, st); }
  }

  function seatCenter(seat) {
    let el = $('[data-seat="' + seat + '"]');
    if (seat === S.mySeat) el = $('#hand') || el;
    if (!el) return { x: innerWidth / 2, y: innerHeight / 2 };
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + (el.id === 'hand' ? r.height * 0.3 : r.height / 2) };
  }

  function tableCenter() {
    const el = $('#trick');
    if (!el) return { x: innerWidth / 2, y: innerHeight / 2 };
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function handleEvent(ev, st) {
    const nm = (i) => (st.seats[i] ? st.seats[i].name : '?');
    switch (ev.type) {
      case 'deal':
        F.sfx('deal');
        F.banner(ev.round === 1 ? 'Allez, on joue !' : 'Manche ' + ev.round, 'small');
        break;
      case 'bid': {
        F.sfx('bid');
        const p = seatCenter(ev.seat);
        F.floatText(p.x, p.y, '🎯 ' + ev.n, '#fff');
        break;
      }
      case 'play':
        F.sfx('play');
        break;
      case 'momo': {
        F.sfx('momo'); F.shake(); F.flash('#ffd426'); F.banner('MOMO !');
        const p = tableCenter();
        F.burst(p.x, p.y, '#ffd426', 70); F.confetti(p.x, p.y, 70);
        break;
      }
      case 'trick': {
        F.sfx('trick');
        const p = seatCenter(ev.w);
        F.floatText(p.x, p.y - 10, '+1 pli', '#ffd426');
        if (ev.w === S.mySeat) F.burst(p.x, p.y, '#ffd426', 25);
        break;
      }
      case 'round': {
        let anyExact = false;
        ev.res.forEach((r, i) => {
          const p = seatCenter(i), pts = r[2];
          F.floatText(p.x, p.y, (pts > 0 ? '+' : '') + pts, pts > 0 ? '#5dffa8' : '#ff6b73');
          if (r[0] === r[1]) {
            anyExact = true;
            F.burst(p.x, p.y, '#ffd426', 45);
            if (i === S.mySeat) { F.confetti(p.x, p.y, 90); F.banner('PILE POIL !'); }
          } else if (i === S.mySeat) {
            F.sfx('miss');
          }
        });
        if (anyExact) F.sfx('exact');
        break;
      }
      case 'over': {
        const win = ev.winners.includes(S.mySeat);
        if (win) { F.sfx('win'); F.fireworks(5000); F.rain(120); F.banner('VICTOIRE !'); }
        else { F.sfx('lose'); F.confetti(innerWidth / 2, innerHeight * 0.6, 60); F.banner(ev.winners.map(nm).join(' & ') + ' gagne !', 'small'); }
        break;
      }
      default:
    }
  }

  // Classement « all time » du hub : chaque joueur déclare son résultat pour lui-même.
  function maybeReport() {
    const st = S.st;
    if (!st || st.phase !== 'over' || S.reported === st.gameId) return;
    S.reported = st.gameId;
    if (S.mode !== 'online' || !HUB || !ChadGang.finPartie || S.mySeat < 0 || st.humans < 2) return;
    try {
      const p = ChadGang.finPartie({
        gagne: st.result.winners.includes(S.mySeat),
        partie: st.gameId,
        score: Math.max(0, st.totals[S.mySeat]),
      });
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }
  }

  /* =====================================================================
     Rendu : briques communes
     ===================================================================== */
  function toast(msg) {
    const d = document.createElement('div');
    d.textContent = msg;
    $('#toast').appendChild(d);
    setTimeout(() => d.remove(), 2600);
  }

  function colorFor(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return 'hsl(' + h + ' 65% 45%)';
  }

  function avatarHTML(id, name, bot) {
    if (bot) return '<span class="av" style="background:#555">🤖</span>';
    const url = id === S.me.id ? S.me.avatar : S.avatars[id];
    if (url) return '<img class="av" data-chadgang-id="' + esc(id) + '" src="' + esc(url) + '" alt="">';
    return '<span class="av" data-chadgang-id="' + esc(id) + '" style="background:' + colorFor(id) + '">' +
      esc((name || '?').trim().charAt(0).toUpperCase()) + '</span>';
  }

  function cardHTML(c, cls, style, attrs) {
    if (E.isMomo(c)) {
      return '<div class="card momo ' + (cls || '') + '" style="' + (style || '') + '" ' + (attrs || '') +
        '><span class="m">🥟</span><span class="t">MOMO</span></div>';
    }
    const s = E.suitOf(c), e = E.SUITS[s].emoji;
    return '<div class="card s' + s + ' ' + (cls || '') + '" style="' + (style || '') + '" ' + (attrs || '') +
      '><i class="cn tl">' + e + '</i><b class="v">' + E.valOf(c) + '</b><i class="cn br">' + e + '</i></div>';
  }

  function fanHTML() {
    return [11, 18, 48, 32, 47].map((c, i) =>
      cardHTML(c, '', '--i:' + i + ';--rt:' + ((i - 2) * 9) + 'deg;--ty:' + (Math.abs(i - 2) * 6) + 'px')).join('');
  }

  /* =====================================================================
     Rendu : menu, attente, salon
     ===================================================================== */
  function renderMenu() {
    S.screen = 'menu';
    app.innerHTML =
      '<div class="menu">' +
      '<h1 class="logo">MOMO</h1>' +
      '<p class="tag">Parie, bluffe, rafle les plis… et que le meilleur dumpling gagne !</p>' +
      '<div class="fan">' + fanHTML() + '</div>' +
      (HUB
        ? '<div class="hello">Salut ' + esc(S.me.name) + ' 👋</div>'
        : '<input id="pseudo" class="inp" maxlength="16" placeholder="Ton pseudo" value="' + esc(S.me.name === 'Joueur' ? '' : S.me.name) + '">') +
      '<div class="row">' +
      (HUB ? '<button class="btn" id="bCreate">Créer une salle</button>' : '') +
      '<button class="btn ' + (HUB ? 'alt' : '') + '" id="bSolo">Jouer contre des bots</button></div>' +
      (HUB
        ? '<div class="row"><input id="code" class="inp code" maxlength="12" placeholder="CODE" autocomplete="off"><button class="btn alt" id="bJoin">Rejoindre</button></div>'
        : '<p class="hint">Le multijoueur en ligne est disponible depuis le hub ChadGangGames.</p>') +
      '<button class="btn alt small" id="bRules">📖 Règles</button>' +
      '</div>';
    const ps = $('#pseudo');
    $('#bSolo').onclick = () => {
      if (ps) {
        S.me.name = ps.value.trim() || 'Joueur';
        try { localStorage.setItem('momo.name', S.me.name); } catch (e) { /* ignore */ }
      }
      F.sfx('click'); startSolo();
    };
    $('#bRules').onclick = () => openModal('rules');
    if (HUB) {
      $('#bCreate').onclick = () => { F.sfx('click'); createRoom(); };
      const join = () => joinRoom($('#code').value, false);
      $('#bJoin').onclick = join;
      $('#code').onkeydown = (e) => { if (e.key === 'Enter') join(); };
    }
  }

  function renderWait() {
    S.screen = 'wait';
    app.innerHTML = '<div class="menu"><h1 class="logo" style="font-size:clamp(48px,14vw,90px)">MOMO</h1>' +
      '<p class="tag">Connexion à la salle ' + esc(S.code) + '…</p>' +
      '<button class="btn alt" id="bQuit">Annuler</button></div>';
    $('#bQuit').onclick = () => { leaveRoom(); renderMenu(); };
  }

  function renderLobby() {
    S.screen = 'lobby';
    $('#overlay').innerHTML = ''; S.ovKey = '';
    const humans = S.players.slice(0, 6), nb = lobbyBots(), total = humans.length + nb;
    const list = humans.map((p, i) =>
      '<li>' + avatarHTML(p.id, p.name) + '<span>' + esc(p.name) + '</span>' + (i === 0 ? '<span class="host">hôte</span>' : '') + '</li>').join('') +
      Array.from({ length: nb }, (_, i) => '<li>' + avatarHTML('b', '', true) + '<span>' + esc(BOT_NAMES[i]) + ' 🤖</span></li>').join('');
    app.innerHTML =
      '<div class="menu"><h1 class="logo" style="font-size:clamp(48px,14vw,90px)">MOMO</h1>' +
      '<div class="panelbox">' +
      '<div>Code de la salle</div><div class="bigcode" id="codeBox" title="Copier le code">' + esc(S.code) + '</div>' +
      '<ul class="plist">' + list + '</ul>' +
      (S.isHost
        ? '<div class="stepper">Bots <button class="ibtn" id="bMinus">−</button><b>' + nb + '</b><button class="ibtn" id="bPlus">+</button></div>' +
          '<div class="hint">' + total + ' joueur' + (total > 1 ? 's' : '') + ' (3 à 6 pour jouer)</div>' +
          '<button class="btn" id="bStart"' + (total < 3 ? ' disabled' : '') + '>Lancer la partie 🚀</button>'
        : '<div class="hint">L\'hôte va lancer la partie…</div>') +
      '</div>' +
      '<div class="row"><button class="btn alt small" id="bRules">📖 Règles</button><button class="btn alt small" id="bQuit">Quitter</button></div></div>';
    $('#codeBox').onclick = () => {
      try { navigator.clipboard.writeText(S.code); toast('Code copié !'); } catch (e) { /* ignore */ }
    };
    $('#bRules').onclick = () => openModal('rules');
    $('#bQuit').onclick = () => { leaveRoom(); renderMenu(); };
    if (S.isHost) {
      $('#bMinus').onclick = () => act({ k: 'bots', n: nb - 1 });
      $('#bPlus').onclick = () => act({ k: 'bots', n: nb + 1 });
      $('#bStart').onclick = () => { F.sfx('click'); act({ k: 'start' }); };
    }
  }

  function refresh() {
    const st = S.st;
    if (!st) { if (S.screen === 'wait') renderWait(); return; }
    if (st.phase === 'lobby') { renderLobby(); return; }
    if (S.screen !== 'game') buildGame();
    updateGame();
  }

  /* =====================================================================
     Rendu : table de jeu
     ===================================================================== */
  function buildGame() {
    S.screen = 'game';
    app.innerHTML =
      '<div id="game">' +
      '<div class="hud" id="hud"></div>' +
      '<div class="opps" id="opps"></div>' +
      '<div class="table" id="table"><div id="tbtrump" class="tbtrump"></div><div id="trick"></div><div class="tbmsg" id="tbmsg"></div></div>' +
      '<div class="mine" id="mine"></div>' +
      '<div class="hand" id="hand"></div>' +
      (S.mode === 'online' ? '<div class="react" id="react">' + REACTIONS.map((e) => '<button data-e="' + e + '">' + e + '</button>').join('') + '</div>' : '') +
      '</div>';
    $('#hand').onclick = onHandClick;
    $('#mine').onclick = (e) => {
      const b = e.target.closest('.bbtn');
      if (b && !b.disabled) { F.sfx('click'); act({ k: 'bid', n: +b.dataset.n }); }
    };
    const rc = $('#react');
    if (rc) rc.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b || Date.now() - S.lastReact < 700) return;
      S.lastReact = Date.now();
      S.room.send({ t: 'react', e: b.dataset.e });
    };
  }

  function updateGame() {
    updateHud(); updateOpps(); updateTable(); updateMine(); updateHand(); updateOverlay();
  }

  function updateHud() {
    const st = S.st;
    const trump = st.trump >= 0 ? 'Atout ' + E.SUITS[st.trump].emoji : '🥟 Sans atout';
    $('#hud').innerHTML =
      '<div class="pill">Manche ' + st.round + '/' + st.R + '</div>' +
      '<div class="pill trump">' + trump + '</div><div class="sp"></div>' +
      '<button class="ibtn" id="bMute" title="Son">' + (F.isMuted() ? '🔇' : '🔊') + '</button>' +
      '<button class="ibtn" id="bScores" title="Scores">📊</button>' +
      '<button class="ibtn" id="bRules" title="Règles">❓</button>' +
      '<button class="ibtn" id="bQuit" title="Quitter">🚪</button>';
    $('#bMute').onclick = () => { F.toggleMute(); updateHud(); };
    $('#bScores').onclick = () => openModal('scores');
    $('#bRules').onclick = () => openModal('rules');
    $('#bQuit').onclick = () => { leaveRoom(); renderMenu(); };
  }

  function seatName(i) { return S.st.seats[i] ? S.st.seats[i].name : '?'; }

  function chipHTML(i) {
    const st = S.st, s = st.seats[i];
    const away = !s.bot && !isPresent(s.id);
    const acting = (st.phase === 'bid' || (st.phase === 'play' && st.trick.length < st.N)) && st.turn === i;
    let bet = '';
    if (st.bids[i] != null) {
      if (st.phase === 'bid') bet = '<span class="bet">🎯 ' + st.bids[i] + '</span>';
      else {
        const cls = st.won[i] === st.bids[i] ? 'ok' : st.won[i] > st.bids[i] ? 'bust' : '';
        bet = '<span class="bet ' + cls + '" title="plis gagnés / pari">🥟 ' + st.won[i] + '/' + st.bids[i] + '</span>';
      }
    } else if (st.phase === 'bid') bet = '<span class="bet">…</span>';
    const cnt = st.phase === 'play' && i !== S.mySeat ? '<span class="cnt">🃏' + st.hands[i].length + '</span>' : '';
    return '<div class="seat' + (acting ? ' turn' : '') + (away ? ' away' : '') + '" data-seat="' + i + '">' +
      avatarHTML(s.id, s.name, s.bot) +
      '<div><div class="nm">' + esc(s.name) + (away ? ' 💤' : '') + '</div><div class="pts">' + st.totals[i] + ' pts ' + cnt + '</div></div>' +
      bet + (st.dealer === i ? '<span class="dtok" title="Donneur">D</span>' : '') + '</div>';
  }

  function updateOpps() {
    const st = S.st, base = Math.max(S.mySeat, 0), out = [];
    for (let k = S.mySeat >= 0 ? 1 : 0; k < st.N; k++) out.push(chipHTML((base + k) % st.N));
    $('#opps').innerHTML = out.join('');
  }

  function slotPos(rel, n) {
    const phi = rel * 2 * Math.PI / n;
    return { x: 50 - Math.sin(phi) * 30, y: 50 + Math.cos(phi) * 27 };
  }

  function updateTable() {
    const st = S.st, base = Math.max(S.mySeat, 0);
    const win = st.trick.length === st.N ? st.win : null;
    $('#tbtrump').innerHTML = '<small>Retournée</small>' + cardHTML(st.trumpCard);
    $('#trick').innerHTML = st.trick.map((t) => {
      const p = slotPos((t.s - base + st.N) % st.N, st.N);
      const rot = ((t.c * 7 + t.s * 13) % 17) - 8;
      return '<div class="slot' + (win === t.s ? ' win' : '') + (E.isMomo(t.c) ? ' mm' : '') + '" data-key="' + trickKey(st, t) +
        '" data-s="' + t.s + '" style="left:' + p.x + '%;top:' + p.y + '%">' + cardHTML(t.c, '', '--rot:' + rot + 'deg') +
        '<span class="who">' + esc(seatName(t.s)) + '</span></div>';
    }).join('');
    document.querySelectorAll('#trick .slot').forEach((sl) => {
      if (S.shown.has(sl.dataset.key)) return;
      S.shown.add(sl.dataset.key);
      const card = sl.querySelector('.card'), r = card.getBoundingClientRect(), o = seatCenter(+sl.dataset.s);
      card.style.setProperty('--dx', (o.x - (r.left + r.width / 2)) + 'px');
      card.style.setProperty('--dy', (o.y - (r.top + r.height / 2)) + 'px');
      card.classList.add('fly');
    });
    let msg = '';
    if (st.phase === 'bid') msg = st.turn === S.mySeat ? '' : seatName(st.turn) + ' réfléchit à son pari…';
    else if (st.phase === 'play') {
      if (st.trick.length === st.N) msg = '👑 ' + seatName(st.win) + ' remporte le pli !';
      else if (st.turn !== S.mySeat) msg = seatName(st.turn) + ' joue…';
    }
    $('#tbmsg').textContent = msg;
  }

  function updateMine() {
    const st = S.st, box = $('#mine');
    if (S.mySeat < 0) { box.innerHTML = '<div class="statline me">👀 Partie en cours : tu regardes</div>'; return; }
    let panel = '';
    if (st.phase === 'bid' && st.turn === S.mySeat) {
      const forb = E.forbiddenBid(st, S.mySeat);
      let btns = '';
      for (let n = 0; n <= st.round; n++) btns += '<button class="bbtn" data-n="' + n + '"' + (n === forb ? ' disabled' : '') + '>' + n + '</button>';
      panel = '<div><div class="statline me">Combien de plis vas-tu faire ?</div><div class="bids">' + btns + '</div>' +
        (forb >= 0 ? '<div class="statline">Interdit : ' + forb + ' (le total ne peut pas égaler ' + st.round + ')</div>' : '') + '</div>';
    } else if (st.phase === 'play' && st.turn === S.mySeat) {
      panel = '<div class="statline me">À toi de jouer !</div>';
    }
    box.innerHTML = chipHTML(S.mySeat) + panel;
  }

  function onHandClick(e) {
    const el = e.target.closest('.card');
    if (!el || !el.classList.contains('legal')) return;
    const c = +el.dataset.c;
    if (TOUCH && S.sel !== c) { S.sel = c; updateHand(); return; }
    S.sel = null;
    F.sfx('click');
    act({ k: 'play', c });
  }

  function updateHand() {
    const st = S.st, h = $('#hand');
    if (S.mySeat < 0) { h.innerHTML = ''; return; }
    const hand = st.hands[S.mySeat] || [];
    const myTurn = st.phase === 'play' && st.turn === S.mySeat && st.trick.length < st.N;
    const legal = myTurn ? E.legalCards(st, S.mySeat) : [];
    const key = st.gameId + ':' + st.round;
    const fresh = S.handKey !== key;
    S.handKey = key;
    const mid = (hand.length - 1) / 2;
    h.innerHTML = hand.map((c, i) => {
      const cls = (legal.includes(c) ? 'legal ' : (myTurn ? 'dim ' : '')) + (fresh ? 'deal ' : '') + (S.sel === c ? 'sel' : '');
      const style = '--i:' + i + ';--rt:' + ((i - mid) * 3) + 'deg;--ty:' + (Math.pow(Math.abs(i - mid), 1.6) * 2).toFixed(1) + 'px';
      return cardHTML(c, cls, style, 'data-c="' + c + '"');
    }).join('');
  }

  // Vole des cartes du pli complet vers le gagnant.
  function sweep(st) {
    if (st.win == null) return;
    const w = $('[data-seat="' + st.win + '"]');
    if (!w) return;
    const wr = w.getBoundingClientRect(), wx = wr.left + wr.width / 2, wy = wr.top + wr.height / 2;
    document.querySelectorAll('#trick .slot').forEach((sl) => {
      const card = sl.querySelector('.card');
      if (!card) return;
      const r = card.getBoundingClientRect(), c = card.cloneNode(true);
      c.classList.remove('fly');
      c.classList.add('sweepcard');
      c.style.cssText += ';left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;margin:0;' +
        '--tx:' + (wx - (r.left + r.width / 2)) + 'px;--ty:' + (wy - (r.top + r.height / 2)) + 'px;--cw:' + r.width + 'px';
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 650);
    });
  }

  function showReaction(pid, emoji) {
    if (!S.st || !S.st.seats || !REACTIONS.includes(emoji)) return;
    const seat = S.st.seats.findIndex((s) => s.id === pid);
    const p = seat >= 0 ? seatCenter(seat) : { x: innerWidth / 2, y: innerHeight / 2 };
    const d = document.createElement('div');
    d.className = 'emoji-fly';
    d.textContent = emoji;
    d.style.left = p.x + 'px'; d.style.top = p.y + 'px';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 1900);
  }

  /* =====================================================================
     Fin de manche / fin de partie / fenêtres
     ===================================================================== */
  function updateOverlay() {
    const st = S.st, ov = $('#overlay');
    if (st.phase !== 'roundEnd' && st.phase !== 'over') { ov.innerHTML = ''; S.ovKey = ''; return; }
    const key = st.phase + ':' + st.gameId + ':' + st.round + ':' + (st.ready || []).join(',') + ':' + S.players.length;
    if (key === S.ovKey) return;
    S.ovKey = key;
    const last = st.history[st.history.length - 1] || [];
    const rows = st.seats.map((s, i) => {
      const r = last[i] || [0, 0, 0], ok = r[0] === r[1];
      return '<tr class="rise' + (i === S.mySeat ? ' me' : '') + '" style="--i:' + i + '"><td>' + esc(s.name) + '</td><td>' + r[0] + '</td><td>' +
        r[1] + ' ' + (ok ? '✅' : '❌') + '</td><td class="' + (r[2] > 0 ? 'good' : 'bad') + '">' + (r[2] > 0 ? '+' : '') + r[2] + '</td><td>' + st.totals[i] + '</td></tr>';
    }).join('');
    if (st.phase === 'roundEnd') {
      const ready = S.mySeat >= 0 && st.ready.includes(S.mySeat);
      ov.innerHTML = '<div class="sheet"><h2>Manche ' + st.round + ' terminée</h2>' +
        '<table class="res"><tr><th>Joueur</th><th>Pari</th><th>Plis</th><th>Pts</th><th>Total</th></tr>' + rows + '</table>' +
        '<div class="acts">' + (S.mySeat >= 0 ? '<button class="btn" id="bReady"' + (ready ? ' disabled' : '') + '>' + (ready ? 'En attente des autres…' : 'Manche suivante ▶') + '</button>' : '') + '</div></div>';
      const b = $('#bReady');
      if (b) b.onclick = () => { F.sfx('click'); act({ k: 'ready' }); };
      return;
    }
    const order = st.seats.map((s, i) => i).sort((a, b) => st.totals[b] - st.totals[a]);
    const win = st.result.winners;
    const podium = order.map((i) =>
      '<div class="p' + (win.includes(i) ? ' w' : '') + '">' + (win.includes(i) ? '🏆' : '') + '<span>' + esc(seatName(i)) + '</span><b>' + st.totals[i] + '</b></div>').join('');
    const canAgain = S.isHost;
    ov.innerHTML = '<div class="sheet"><h2>' + (win.includes(S.mySeat) ? '🎉 Victoire !' : '🥟 Fin de partie') + '</h2>' +
      '<p style="text-align:center">' + win.map(seatName).map(esc).join(' & ') + ' ' + (win.length > 1 ? 'remportent' : 'remporte') + ' la partie !</p>' +
      '<div class="podium">' + podium + '</div>' +
      '<div class="acts">' + (canAgain ? '<button class="btn" id="bAgain">Rejouer 🔁</button>' : '<span class="hint" style="color:#12102b;text-shadow:none">L\'hôte peut relancer une partie…</span>') +
      '<button class="btn alt" id="bScores2">📊 Détail</button><button class="btn alt" id="bQuit2">Quitter</button></div></div>';
    if (canAgain) $('#bAgain').onclick = () => act({ k: 'again' });
    $('#bScores2').onclick = () => openModal('scores');
    $('#bQuit2').onclick = () => { leaveRoom(); renderMenu(); };
  }

  function openModal(kind) {
    const m = $('#modal');
    let body = '';
    if (kind === 'rules') {
      body = '<h2>🥟 Règles de Momo</h2>' +
        '<h3>But</h3><p>Annoncer <b>exactement</b> combien de plis tu vas gagner, puis tenir ta promesse. Le plus de points après 7 manches gagne.</p>' +
        '<h3>Les cartes</h3><ul><li>4 couleurs (🌶️ 🍋 🌿 🫐) de 1 à 12.</li><li>4 cartes <b>Momo</b> 🥟 : elles se jouent à tout moment et gagnent le pli.</li></ul>' +
        '<h3>Une manche</h3><ol><li>À la manche N, chacun reçoit N cartes. Une carte est retournée : sa couleur est l\'<b>atout</b> (si c\'est un Momo : sans atout).</li>' +
        '<li><b>Paris</b> : chacun son tour annonce son nombre de plis. Le donneur parie en dernier et ne peut pas faire égaler le total des paris au nombre de plis : quelqu\'un sera forcément déçu !</li>' +
        '<li><b>Jeu</b> : le joueur après le donneur commence. Il faut fournir la couleur demandée si on peut (un Momo passe toujours).</li>' +
        '<li><b>Pli</b> : gagné par le premier Momo posé, sinon par le plus fort atout, sinon par la plus haute carte de la couleur demandée. Le gagnant rejoue.</li></ol>' +
        '<h3>Points</h3><ul><li>Pari réussi : <b>10 + 4 par pli</b> (un pari de 0 réussi ajoute 2 × le numéro de la manche).</li><li>Pari raté : <b>−3 par pli d\'écart</b>.</li></ul>' +
        '<p>Les bots 🤖 comblent les places vides (3 à 6 joueurs). Seules les parties à 2 humains ou plus comptent pour le classement du hub.</p>';
    } else {
      const st = S.st;
      if (!st || !st.seats) body = '<h2>📊 Scores</h2><p>La partie n\'a pas commencé.</p>';
      else {
        const head = '<tr><th>Manche</th>' + st.seats.map((s) => '<th>' + esc(s.name) + '</th>').join('') + '</tr>';
        const rows = st.history.map((h, r) => '<tr><td>' + (r + 1) + '</td>' + h.map((x) =>
          '<td class="' + (x[2] > 0 ? 'good' : 'bad') + '">' + (x[2] > 0 ? '+' : '') + x[2] + '<br><small>' + x[0] + '→' + x[1] + '</small></td>').join('') + '</tr>').join('');
        body = '<h2>📊 Scores</h2><div class="scroll-x"><table class="res">' + head + rows +
          '<tr><td><b>Total</b></td>' + st.totals.map((t) => '<td><b>' + t + '</b></td>').join('') + '</tr></table></div>' +
          '<p style="font-size:12px">Petit chiffre : pari → plis gagnés.</p>';
      }
    }
    m.className = 'modal';
    m.innerHTML = '<div class="sheet">' + body + '<div class="acts"><button class="btn" id="bClose">Fermer</button></div></div>';
    $('#bClose').onclick = () => { m.innerHTML = ''; };
    m.onclick = (e) => { if (e.target === m) m.innerHTML = ''; };
  }

  init();
})();
