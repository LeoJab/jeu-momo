/* Momo – interface, réseau (SDK ChadGang) et boucle de jeu.
   Modèle : l'hôte (premier joueur de la salle) fait foi. Il valide les actions, gère les chronos
   et diffuse l'état COMPLET de la partie (version croissante, envoyé avec keep:true). */
(() => {
  'use strict';

  const E = window.MomoEngine;
  const F = window.FX;
  const $ = (s, el = document) => el.querySelector(s);
  const app = $('#app');
  const HUB = !!window.ChadGang;
  const SPEED = Math.max(1, Number(new URLSearchParams(location.search).get('speed')) || 1); // accélérateur de test
  const REACTIONS = ['😂', '🔥', '😱', '👏', '🥟'];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const S = {
    screen: 'menu', mode: null, room: null, code: '',
    me: { id: 'local-' + Math.random().toString(36).slice(2, 8), name: 'Joueur', avatar: null },
    players: [], isHost: false, st: null, mySeat: -1, avatars: {},
    lastEv: 0, evKey: null, timer: null, reported: null, schedV: -1, findStart: 0,
    cardKey: '', actKey: '', ovKey: '', lastReact: 0,
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

  function updateHost() { S.isHost = S.players.length > 0 && S.players[0].id === S.me.id; }
  function isPresent(id) { return S.players.some((p) => p.id === id); }
  function hello() { if (S.room && S.mode === 'online') S.room.send({ t: 'hi', avatar: S.me.avatar }); }

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
    S.evKey = null; S.ovKey = ''; S.cardKey = ''; S.actKey = ''; S.schedV = -1;
    $('#overlay').innerHTML = ''; $('#modal').innerHTML = '';
  }

  function onMessage(d, from) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'state') { if (d.s && (!S.st || d.s.v > S.st.v)) setState(d.s); }
    else if (d.t === 'act') { if (S.isHost) hostAct(from.id, d.a); }
    else if (d.t === 'hi') S.avatars[from.id] = d.avatar || null;
    else if (d.t === 'react') showReaction(from.id, d.e);
  }

  function act(a) {
    if (S.isHost) hostAct(S.me.id, a);
    else if (S.room) S.room.send({ t: 'act', a });
  }

  /* =====================================================================
     Logique de l'hôte
     ===================================================================== */
  function initLobby() {
    S.st = { v: 0, phase: 'lobby' };
    commit();
  }

  function startGame() {
    const humans = S.players.slice(0, 8).map((p) => ({ id: p.id, name: p.name }));
    if (S.mode === 'online' && humans.length < 2) return 'Il faut au moins 2 joueurs.';
    const st = E.newGame(humans, (S.code || 'SOLO') + '-' + Date.now().toString(36));
    st.v = S.st.v;
    S.st = st;
    return null;
  }

  function newSoloGame() {
    S.st = { v: S.st ? S.st.v : 0, phase: 'lobby' };
    startGame();
    commit();
  }

  const awaySeats = () => S.st.seats.map((s, i) => i).filter((i) => !isPresent(S.st.seats[i].id));

  function hostAct(pid, a) {
    const st = S.st;
    if (!st || !a) return;
    const seat = st.seats ? st.seats.findIndex((s) => s.id === pid) : -1;
    const mine = pid === S.me.id;
    let err = null, changed = true;
    switch (a.k) {
      case 'start':
        if (st.phase === 'lobby' && mine) err = startGame(); else changed = false;
        break;
      case 'buzz':
        if (seat >= 0 && st.phase === 'find') err = E.buzz(st, seat, st.budget - (Date.now() - S.findStart));
        else { changed = false; if (mine && seat >= 0) toast('Trop tard !'); }
        break;
      case 'word': {
        const jurors = st.seats.map((s, i) => i).filter((i) => i !== seat && isPresent(st.seats[i].id));
        if (seat >= 0) err = E.submitWord(st, seat, String(a.w || ''), jurors); else changed = false;
        break;
      }
      case 'vote':
        if (seat >= 0) E.vote(st, seat, a.ok); else changed = false;
        break;
      case 'ready':
        if (seat >= 0 && st.phase === 'roundEnd' && !st.ready.includes(seat)) st.ready.push(seat); else changed = false;
        break;
      case 'again':
        if (st.phase === 'over' && mine) {
          if (S.mode === 'solo') { newSoloGame(); return; }
          S.st = { v: st.v, phase: 'lobby' };
        } else changed = false;
        break;
      default: changed = false;
    }
    if (err) { if (mine) toast(err); return; }
    if (changed) commit();
  }

  function commit() {
    const st = S.st;
    st.v++;
    if (S.room) S.room.send({ t: 'state', s: st }, { keep: true });
    setState(st);
  }

  // Prochaine action automatique de l'hôte (chronos).
  function schedule() {
    clearTimeout(S.timer);
    const st = S.st;
    if (!S.isHost || !st || st.phase === 'lobby' || st.phase === 'over') return;
    if (S.schedV !== st.v) { S.schedV = st.v; S.findStart = Date.now(); }
    const elapsed = Date.now() - S.findStart;
    let delay = 0, fn = null;
    switch (st.phase) {
      case 'reveal': delay = st.dur - elapsed; fn = () => E.openFind(st); break;
      case 'find': delay = st.budget - elapsed; fn = () => E.timeoutFind(st); break;
      case 'speak': delay = st.dur - elapsed; fn = () => E.failSpeaker(st, 'Temps écoulé !'); break;
      case 'judge': {
        const all = st.jury.every((i) => i in st.votes);
        delay = all ? 600 : st.dur - elapsed; fn = () => E.judgeResolve(st); break;
      }
      case 'roundEnd': {
        const humans = st.seats.map((s, i) => i).filter((i) => isPresent(st.seats[i].id));
        const allReady = humans.every((i) => st.ready.includes(i));
        delay = allReady ? 700 : st.dur - elapsed;
        fn = () => E.nextRound(st, awaySeats());
        break;
      }
      default: return;
    }
    const v = st.v;
    S.timer = setTimeout(() => {
      if (S.st !== st || st.v !== v || !S.isHost) return;
      fn();
      commit();
    }, Math.max(50, delay) / SPEED);
  }

  /* =====================================================================
     Application d'un état + effets
     ===================================================================== */
  function setState(s, silent) {
    const old = S.st;
    S.st = s;
    const key = s.gameId || 'lobby';
    if (S.evKey !== key) { S.evKey = key; S.lastEv = (silent || !old) ? (s.eid || 0) : 0; }
    else if (silent) S.lastEv = s.eid || 0;
    S.mySeat = s.seats ? s.seats.findIndex((x) => x.id === S.me.id) : -1;
    S.phaseAt = Date.now();
    refresh();
    processEvents();
    maybeReport();
    if (S.isHost) schedule();
  }

  function processEvents() {
    const st = S.st;
    if (!st || !st.events) return;
    const evs = st.events.filter((e) => e.id > S.lastEv).sort((a, b) => a.id - b.id);
    for (const ev of evs) { S.lastEv = ev.id; handleEvent(ev, st); }
  }

  function seatCenter(seat) {
    const el = $('[data-seat="' + seat + '"]');
    if (!el) return { x: innerWidth / 2, y: innerHeight / 3 };
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function handleEvent(ev, st) {
    const nm = (i) => (st.seats[i] ? st.seats[i].name : '?');
    switch (ev.type) {
      case 'round':
        F.sfx('deal');
        F.banner(st.solo ? 'Manche ' + ev.round : 'Manche ' + ev.round + ' / ' + st.R, 'small');
        if (ev.f) setTimeout(() => { F.sfx('momo'); F.shake(); F.flash('#ffd426'); F.banner('⚡ FLASH !'); }, 900);
        if (ev.i) setTimeout(() => { F.sfx('momo'); F.flash('#7a4cf0'); F.banner('🔄 INVERSION !'); }, 900);
        if (ev.u) setTimeout(() => { F.sfx('momo'); F.flash('#3a49ff'); F.banner('🎩 ACCENT !'); }, 900);
        break;
      case 'buzz': {
        F.sfx('buzz');
        const p = seatCenter(ev.seat);
        F.floatText(p.x, p.y, '🙋 Moi !', '#fff');
        break;
      }
      case 'say': {
        const p = seatCenter(ev.seat);
        F.floatText(p.x, p.y + 28, ev.w, '#fff');
        break;
      }
      case 'ok': {
        F.sfx('trick');
        const p = seatCenter(ev.seat);
        F.burst(p.x, p.y, '#5dffa8', 40);
        if (ev.seat === S.mySeat) F.confetti(p.x, p.y, 60);
        break;
      }
      case 'verdict':
        F.floatText(innerWidth / 2, innerHeight * 0.45, (ev.ok ? '👍 ' : '👎 ') + ev.y + ' – ' + ev.n, ev.ok ? '#5dffa8' : '#ff6b73');
        break;
      case 'bad':
        F.sfx('miss'); F.shake(); F.flash('#e8333b');
        break;
      case 'time':
        F.sfx('miss'); F.flash('#e8333b');
        F.banner('Temps écoulé !', 'small');
        break;
      case 'collect':
        ev.c.forEach(([seat, n]) => {
          const p = seatCenter(seat);
          F.floatText(p.x, p.y, '+' + n + ' 🃏', '#ff6b73');
          F.burst(p.x, p.y, '#ff6b73', 30);
          if (seat === S.mySeat) { F.sfx('lose'); F.shake(); }
        });
        break;
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
      const p = ChadGang.finPartie({ gagne: st.result.winners.includes(S.mySeat), partie: st.gameId });
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

  function avatarHTML(id, name) {
    const url = id === S.me.id ? S.me.avatar : S.avatars[id];
    if (url) return '<img class="av" data-chadgang-id="' + esc(id) + '" src="' + esc(url) + '" alt="">';
    return '<span class="av" data-chadgang-id="' + esc(id) + '" style="background:' + colorFor(id) + '">' +
      esc((name || '?').trim().charAt(0).toUpperCase()) + '</span>';
  }

  // Une carte Momo (dos + face). k = code de carte (voir engine.js).
  function cardHTML(k, up, style) {
    let cls = 'free', face = '<span class="big">🥟</span><span class="lab">carte libre</span>';
    if (k[0] === '+') { cls = 'plus'; face = '<span class="lab">Contient</span><span class="big">' + k[1] + '</span>'; }
    else if (k[0] === '-') { cls = 'minus'; face = '<span class="lab">Sans</span><span class="big">' + k[1] + '</span>'; }
    else if (k[0] === '^') { cls = 'start'; face = '<span class="lab">Commence par</span><span class="big">' + k[1] + '</span>'; }
    else if (k[0] === 'T') { cls = 'theme'; const t = E.THEMES[+k.slice(1)]; face = '<span class="big">' + t[1] + '</span><span class="nm">' + esc(t[0]) + '</span>'; }
    else if (k === '!F') { cls = 'kflash'; face = '<span class="big">⚡</span><span class="lab">Flash !</span>'; }
    else if (k === '!I') { cls = 'inv'; face = '<span class="big">🔄</span><span class="lab">Inversion</span>'; }
    else if (k === '!U') { cls = 'uk'; face = '<span class="big">🎩</span><span class="lab">Accent anglais</span>'; }
    return '<div class="tc ' + cls + (up ? ' up' : '') + '" style="' + (style || '') + '"><div class="in"><div class="b">🥟</div><div class="f">' + face + '</div></div></div>';
  }

  function fanHTML() {
    return ['+A', 'T0', '!F', '-E', '^S'].map((k, i) =>
      cardHTML(k, true, '--i:' + i + ';--rt:' + ((i - 2) * 9) + 'deg;--ty:' + (Math.abs(i - 2) * 6) + 'px')).join('');
  }

  /* =====================================================================
     Rendu : menu, attente, salon
     ===================================================================== */
  function renderMenu() {
    S.screen = 'menu';
    app.innerHTML =
      '<div class="menu">' +
      '<h1 class="logo">MOMO</h1>' +
      '<p class="tag">Une lettre interdite, un thème imposé… Trouve un mot avant les autres, ou ramasse tout !</p>' +
      '<div class="fan">' + fanHTML() + '</div>' +
      (HUB
        ? '<div class="hello">Salut ' + esc(S.me.name) + ' 👋</div>'
        : '<input id="pseudo" class="inp" maxlength="16" placeholder="Ton pseudo" value="' + esc(S.me.name === 'Joueur' ? '' : S.me.name) + '">') +
      '<div class="row">' +
      (HUB ? '<button class="btn" id="bCreate">Créer une salle</button>' : '') +
      '<button class="btn ' + (HUB ? 'alt' : '') + '" id="bSolo">Entraînement solo</button></div>' +
      (HUB
        ? '<div class="row"><input id="code" class="inp code" maxlength="12" placeholder="CODE" autocomplete="off"><button class="btn alt" id="bJoin">Rejoindre</button></div>'
        : '<p class="hint">Le multijoueur en ligne (2 à 8 joueurs) est disponible depuis le hub ChadGangGames.</p>') +
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
    const humans = S.players.slice(0, 8);
    const list = humans.map((p, i) =>
      '<li>' + avatarHTML(p.id, p.name) + '<span>' + esc(p.name) + '</span>' + (i === 0 ? '<span class="host">hôte</span>' : '') + '</li>').join('');
    app.innerHTML =
      '<div class="menu"><h1 class="logo" style="font-size:clamp(48px,14vw,90px)">MOMO</h1>' +
      '<div class="panelbox">' +
      '<div>Code de la salle</div><div class="bigcode" id="codeBox" title="Copier le code">' + esc(S.code) + '</div>' +
      '<ul class="plist">' + list + '</ul>' +
      '<div class="hint">' + humans.length + ' joueur' + (humans.length > 1 ? 's' : '') + ' (2 à 8). Allume ta caméra ou ton micro dans le hub, c\'est meilleur quand on se voit !</div>' +
      (S.isHost
        ? '<button class="btn" id="bStart"' + (humans.length < 2 ? ' disabled' : '') + '>Lancer la partie 🚀</button>'
        : '<div class="hint">L\'hôte va lancer la partie…</div>') +
      '</div>' +
      '<div class="row"><button class="btn alt small" id="bRules">📖 Règles</button><button class="btn alt small" id="bQuit">Quitter</button></div></div>';
    $('#codeBox').onclick = () => {
      try { navigator.clipboard.writeText(S.code); toast('Code copié !'); } catch (e) { /* ignore */ }
    };
    $('#bRules').onclick = () => openModal('rules');
    $('#bQuit').onclick = () => { leaveRoom(); renderMenu(); };
    if (S.isHost) $('#bStart').onclick = () => { F.sfx('click'); act({ k: 'start' }); };
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
    S.screen = 'game'; S.cardKey = ''; S.actKey = '';
    app.innerHTML =
      '<div id="game">' +
      '<div class="hud" id="hud"></div>' +
      '<div class="opps" id="opps"></div>' +
      '<div class="stage"><div class="cards" id="cards"></div><div class="rules" id="rules"></div><div class="words" id="words"></div></div>' +
      '<div class="act" id="act"></div>' +
      (S.mode === 'online' ? '<div class="react" id="react">' + REACTIONS.map((e) => '<button data-e="' + e + '">' + e + '</button>').join('') + '</div>' : '') +
      '</div>';
    const rc = $('#react');
    if (rc) rc.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b || Date.now() - S.lastReact < 700) return;
      S.lastReact = Date.now();
      S.room.send({ t: 'react', e: b.dataset.e });
    };
  }

  function updateGame() {
    updateHud(); updateOpps(); updateStage(); updateAct(); updateOverlay();
  }

  function seatName(i) { return S.st.seats[i] ? S.st.seats[i].name : '?'; }

  function updateHud() {
    const st = S.st, c = E.constraints(st);
    $('#hud').innerHTML =
      '<div class="pill">Manche ' + st.round + '/' + st.R + '</div>' +
      (c.flash ? '<div class="pill flashp">⚡ FLASH</div>' : '') + (c.inv ? '<div class="pill">🔄 Inversion</div>' : '') + (c.uk ? '<div class="pill">🎩 Accent</div>' : '') +
      '<div class="sp"></div>' +
      '<button class="ibtn" id="bMute" title="Son">' + (F.isMuted() ? '🔇' : '🔊') + '</button>' +
      '<button class="ibtn" id="bScores" title="Scores">📊</button>' +
      '<button class="ibtn" id="bRules" title="Règles">❓</button>' +
      '<button class="ibtn" id="bQuit" title="Quitter">🚪</button>';
    $('#bMute').onclick = () => { F.toggleMute(); updateHud(); };
    $('#bScores').onclick = () => openModal('scores');
    $('#bRules').onclick = () => openModal('rules');
    $('#bQuit').onclick = () => { leaveRoom(); renderMenu(); };
  }

  function updateOpps() {
    const st = S.st;
    $('#opps').innerHTML = st.seats.map((s, i) => {
      const away = !isPresent(s.id), speak = st.speaker === i && (st.phase === 'speak' || st.phase === 'judge');
      const found = st.found[i] && st.phase !== 'reveal' && !away;
      return '<div class="seat' + (speak ? ' speak' : '') + (found ? ' found' : '') + (away ? ' away' : '') + (i === S.mySeat ? ' me' : '') + '" data-seat="' + i + '">' +
        avatarHTML(s.id, s.name) +
        '<div><div class="nm">' + esc(s.name) + (away ? ' 💤' : '') + '</div><div class="pts">🃏 ' + st.col[i] + ' ramassée' + (st.col[i] > 1 ? 's' : '') + '</div></div>' +
        '<span class="st">' + (speak ? '🎤' : found ? '✅' : '') + '</span></div>';
    }).join('');
  }

  function rulesChips(c) {
    const out = [];
    c.plus.forEach((l) => out.push('<span class="r plus">Contient <b>' + l + '</b></span>'));
    c.minus.forEach((l) => out.push('<span class="r minus">Sans <b>' + l + '</b></span>'));
    if (c.start) out.push('<span class="r start">Commence par <b>' + c.start + '</b></span>');
    if (c.theme >= 0) out.push('<span class="r sp">' + E.THEMES[c.theme][1] + ' Thème : ' + esc(E.THEMES[c.theme][0]) + '</span>');
    if (c.flash) out.push('<span class="r sp">⚡ Flash : chrono réduit !</span>');
    if (c.inv) out.push('<span class="r sp">🔄 Inversion : le premier qui trouve ramasse !</span>');
    if (c.uk) out.push('<span class="r sp">🎩 Dis ton mot avec l\'accent anglais !</span>');
    if (!out.length) out.push('<span class="r">Aucune contrainte : lâche-toi !</span>');
    return out.join('');
  }

  function updateStage() {
    const st = S.st, row = st.cards[st.round - 1], key = st.gameId + ':' + st.round;
    const fresh = S.cardKey !== key && st.phase === 'reveal';
    S.cardKey = key;
    $('#cards').innerHTML = row.map((k, i) =>
      '<div class="cardwrap">' + cardHTML(k, !fresh) + (st.solo ? '' : '<small>' + esc(seatName(i)) + '</small>') + '</div>').join('');
    const rules = $('#rules');
    rules.innerHTML = rulesChips(E.constraints(st));
    if (fresh) {
      rules.classList.add('hide');
      row.forEach((k, i) => setTimeout(() => {
        const el = document.querySelectorAll('#cards .tc')[i];
        if (el) el.classList.add('up');
        F.sfx('play');
      }, (250 + i * 160) / SPEED));
      setTimeout(() => rules.classList.remove('hide'), (400 + row.length * 160) / SPEED);
    } else rules.classList.remove('hide');
    $('#words').innerHTML = st.words.map((w) =>
      '<span class="w ' + (w.ok === true ? 'ok' : w.ok === false ? 'ko' : '') + '">' + esc(seatName(w.s)) + ' : ' + esc(w.w) + '</span>').join('');
  }

  function barHTML(ms, hot) {
    return '<div class="bar' + (hot ? ' hot' : '') + '"><i style="animation-duration:' + Math.max(200, ms) + 'ms"></i></div>';
  }

  function updateAct() {
    const st = S.st, box = $('#act'), me = S.mySeat, c = E.constraints(st);
    const key = [st.gameId, st.round, st.phase, st.speaker, st.words.length, me >= 0 && st.found[me] ? 1 : 0, me >= 0 ? st.votes[me] : '-', st.phase === 'find' ? st.v : ''].join(':');
    if (key === S.actKey) return;
    S.actKey = key;
    let h = '';
    if (me < 0) h = '<div class="status">👀 Partie en cours : tu regardes</div>';
    else if (st.phase === 'reveal') h = '<div class="status">Les cartes se retournent… prépare-toi !</div>';
    else if (st.phase === 'find') {
      if (st.found[me]) h = barHTML(st.dur, c.flash) + '<div class="status">✅ Tu es à l\'abri ! Regarde les autres galérer…</div>';
      else h = barHTML(st.dur, c.flash) + '<button class="buzz" id="bBuzz">🙋 J\'AI TROUVÉ !</button><div class="status">(ou appuie sur Espace)</div>';
    } else if (st.phase === 'speak') {
      if (st.speaker === me) {
        h = barHTML(st.dur, true) + '<form class="say" id="sayForm"><input class="inp" id="sayInp" maxlength="30" placeholder="Ton mot…" autocomplete="off" autocapitalize="off"><button class="btn green" type="submit">OK</button></form>' +
          '<div class="status">Crie ton mot et écris-le vite !</div>';
      } else h = barHTML(st.dur, true) + '<div class="status">🎤 ' + esc(seatName(st.speaker)) + ' répond…</div>';
    } else if (st.phase === 'judge') {
      const w = st.words[st.words.length - 1];
      const q = c.uk && c.theme >= 0 ? 'Thème ET accent anglais OK ?' : c.uk ? 'Accent anglais OK ?' : 'Ça colle au thème ?';
      if (st.jury.includes(me)) {
        h = barHTML(st.dur, false) + '<div class="status">« <b>' + esc(w ? w.w : '') + '</b> » de ' + esc(seatName(st.speaker)) + '<br>' + q + '</div>' +
          '<div class="jury"><button class="btn green" data-v="1"' + (me in st.votes ? ' disabled' : '') + '>👍 Valable</button><button class="btn red" data-v="0"' + (me in st.votes ? ' disabled' : '') + '>👎 Refusé</button></div>';
      } else h = barHTML(st.dur, false) + '<div class="status">⚖️ Le jury juge « ' + esc(w ? w.w : '') + ' »…</div>';
    }
    box.innerHTML = h;
    const bz = $('#bBuzz');
    if (bz) bz.onclick = () => act({ k: 'buzz' });
    const form = $('#sayForm');
    if (form) {
      const inp = $('#sayInp');
      form.onsubmit = (e) => { e.preventDefault(); const w = inp.value.trim(); if (w) { form.querySelector('button').disabled = true; act({ k: 'word', w }); } };
      setTimeout(() => inp.focus(), 30);
    }
    box.querySelectorAll('[data-v]').forEach((b) => {
      b.onclick = () => { F.sfx('click'); act({ k: 'vote', ok: b.dataset.v === '1' }); };
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || S.screen !== 'game' || !S.st || S.st.phase !== 'find') return;
    if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const b = $('#bBuzz');
    if (b) { e.preventDefault(); b.click(); }
  });

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
  function whyText(l) {
    if (l.why === 'last') return 'Dernier à trouver un mot…';
    if (l.why === 'err') return l.msg || 'Mot refusé !';
    if (l.why === 'time') return 'Temps écoulé !';
    if (l.why === 'inv') return 'Inversion : premier à trouver, premier à ramasser !';
    if (l.why === 'solo') return 'Bien joué !';
    return '';
  }

  function updateOverlay() {
    const st = S.st, ov = $('#overlay');
    if (st.phase !== 'roundEnd' && st.phase !== 'over') { ov.innerHTML = ''; S.ovKey = ''; return; }
    const key = st.phase + ':' + st.gameId + ':' + st.round + ':' + (st.ready || []).join(',') + ':' + S.players.length;
    if (key === S.ovKey) return;
    S.ovKey = key;
    if (st.phase === 'roundEnd') {
      const l = st.last || { losers: [] };
      const names = l.losers.map(([s, n]) => '<b>' + esc(seatName(s)) + '</b> ramasse ' + n + ' carte' + (n > 1 ? 's' : '')).join('<br>');
      const ready = S.mySeat >= 0 && st.ready.includes(S.mySeat);
      ov.innerHTML = '<div class="sheet"><h2>' + (l.losers.length ? '💥 Aïe !' : '🎉 Bravo !') + '</h2>' +
        '<div class="big-loser">' + (names || 'Personne ne ramasse') + '</div>' +
        '<p style="text-align:center">' + esc(whyText(l)) + '</p>' +
        '<div class="acts">' + (S.mySeat >= 0 ? '<button class="btn" id="bReady"' + (ready ? ' disabled' : '') + '>' + (ready ? 'En attente des autres…' : (st.round >= st.R ? 'Voir le résultat ▶' : 'Manche suivante ▶')) + '</button>' : '') + '</div></div>';
      const b = $('#bReady');
      if (b) b.onclick = () => { F.sfx('click'); act({ k: 'ready' }); };
      return;
    }
    const order = st.seats.map((s, i) => i).sort((a, b) => st.col[a] - st.col[b]);
    const win = st.result.winners;
    const podium = order.map((i) =>
      '<div class="p' + (win.includes(i) ? ' w' : '') + (i === S.mySeat ? ' me' : '') + '">' + (win.includes(i) ? '🏆' : '') + '<span>' + esc(seatName(i)) + '</span><b>🃏 ' + st.col[i] + '</b></div>').join('');
    ov.innerHTML = '<div class="sheet"><h2>' + (win.includes(S.mySeat) ? '🎉 Victoire !' : '🥟 Fin de partie') + '</h2>' +
      '<p style="text-align:center">' + (st.solo ? 'Entraînement terminé : ' + st.col[0] + ' carte' + (st.col[0] > 1 ? 's' : '') + ' ramassée' + (st.col[0] > 1 ? 's' : '') + ' !' :
        win.map(seatName).map(esc).join(' & ') + ' ' + (win.length > 1 ? 'gagnent' : 'gagne') + ' : le moins de cartes ramassées !') + '</p>' +
      '<div class="podium">' + podium + '</div>' +
      '<div class="acts">' + (S.isHost ? '<button class="btn" id="bAgain">Rejouer 🔁</button>' : '<span class="hint" style="color:#12102b;text-shadow:none">L\'hôte peut relancer une partie…</span>') +
      '<button class="btn alt" id="bQuit2">Quitter</button></div></div>';
    if (S.isHost) $('#bAgain').onclick = () => act({ k: 'again' });
    $('#bQuit2').onclick = () => { leaveRoom(); renderMenu(); };
  }

  function openModal(kind) {
    const m = $('#modal');
    let body = '';
    if (kind === 'rules') {
      body = '<h2>🥟 Règles de Momo</h2>' +
        '<h3>Le principe</h3><p>À chaque manche, tous les joueurs retournent une carte en même temps. Les cartes donnent les contraintes du mot à trouver : lettre obligatoire, lettre interdite, première lettre, thème imposé…</p>' +
        '<h3>Une manche</h3><ol><li>Dès que tu as un mot qui respecte <b>toutes</b> les contraintes, appuie sur <b>J\'AI TROUVÉ !</b>, crie-le et écris-le.</li>' +
        '<li>Les lettres sont vérifiées automatiquement. Pour le thème (et l\'accent anglais), les autres joueurs te jugent : 👍 ou 👎.</li>' +
        '<li>Un mot déjà dit, trop court (3 lettres min.) ou refusé : tu es le premier à te tromper et tu <b>ramasses toutes les cartes</b>.</li>' +
        '<li>Sinon, le <b>dernier</b> joueur à ne pas avoir trouvé de mot ramasse les cartes. Le chrono s\'écoule : à la fin, tous ceux qui n\'ont rien trouvé se les partagent !</li></ol>' +
        '<h3>Cartes spéciales</h3><ul><li>⚡ <b>Flash</b> : chrono très court.</li><li>🔄 <b>Inversion</b> : le premier à trouver un mot valable ramasse !</li><li>🎩 <b>Accent anglais</b> : dis ton mot avec l\'accent, le jury décide.</li></ul>' +
        '<h3>Fin de partie</h3><p>Après 8 manches, celui qui a ramassé le <b>moins de cartes</b> gagne. Seules les parties à 2 joueurs ou plus comptent pour le classement du hub. Le mode entraînement se joue seul contre le chrono.</p>';
    } else {
      const st = S.st;
      if (!st || !st.seats) body = '<h2>📊 Scores</h2><p>La partie n\'a pas commencé.</p>';
      else {
        const rows = st.seats.map((s, i) => '<div><span>' + esc(s.name) + '</span><b>🃏 ' + st.col[i] + '</b></div>').join('');
        body = '<h2>📊 Cartes ramassées</h2><div class="hist">' + rows + '</div><p style="font-size:12px">Le moins de cartes ramassées gagne.</p>';
      }
    }
    m.className = 'modal';
    m.innerHTML = '<div class="sheet">' + body + '<div class="acts"><button class="btn" id="bClose">Fermer</button></div></div>';
    $('#bClose').onclick = () => { m.innerHTML = ''; };
    m.onclick = (e) => { if (e.target === m) m.innerHTML = ''; };
  }

  init();
})();
