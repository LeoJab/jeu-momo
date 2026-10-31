/* Momo (jeu de mots) – moteur de règles, sans interface.
   Cartes d'une manche (une par joueur) : '+A' contient A, '-E' sans E, '^S' commence par S,
   'T3' thème n°3, '!F' Flash, '!I' Inversion, '!U' accent anglais, '.' carte libre. */
(function (root) {
  'use strict';

  const THEMES = [
    ['Animaux', '🐾'], ['Nourriture', '🍕'], ['Métiers', '👷'], ['Pays & villes', '🌍'],
    ['Sports', '⚽'], ['Objets de la maison', '🛋️'], ['Vêtements', '👕'], ['Films & séries', '🎬'],
    ['Corps humain', '🦵'], ['Nature', '🌳'], ['Transports', '🚗'], ['Musique', '🎸'],
  ];
  const REQ = 'AEIORSTLNUMPCDGB', FORB = 'ADILMNOPRSTUC', START = 'ABCDEFGILMOPRSTV';
  const ROUNDS = 8, MIN_LEN = 3;
  const FIND_MS = 40000, FLASH_MS = 12000, SPEAK_MS = 10000, JUDGE_MS = 7000, END_MS = 5500, REVEAL_MS = 1700;

  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function pushEv(st, ev) {
    ev.id = ++st.eid;
    st.events.push(ev);
    if (st.events.length > 14) st.events.shift();
  }

  // minuscules, sans accents, lettres a-z uniquement
  function norm(w) {
    return String(w).toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae')
      .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
  }

  /* ---------- Génération des manches ---------- */
  function genRound(slots) {
    const used = new Set();
    const letter = (pool) => {
      let l;
      do { l = pick(pool.split('')); } while (used.has(l));
      used.add(l);
      return l;
    };
    const pool = (t) => (t === '+' ? REQ : t === '-' ? FORB : START);
    let cl = [];
    if (Math.random() < 0.5) {
      cl.push('T' + Math.floor(Math.random() * THEMES.length));
      const t = pick(['+', '-', '^']);
      cl.push(t + letter(pool(t)));
    } else {
      shuffle(['+', '+', '-', '^']).slice(0, Math.random() < 0.5 ? 2 : 3).forEach((t) => cl.push(t + letter(pool(t))));
    }
    const sp = Math.random() < 0.3 ? pick(['!F', '!I', '!U']) : null;
    cl = cl.slice(0, Math.max(1, slots - (sp ? 1 : 0)));
    const row = cl.concat(sp ? [sp] : []);
    while (row.length < slots) row.push('.');
    return shuffle(row);
  }

  function constraintsOf(row) {
    const c = { plus: [], minus: [], start: null, theme: -1, flash: false, inv: false, uk: false };
    row.forEach((k) => {
      if (k[0] === '+') c.plus.push(k[1]);
      else if (k[0] === '-') c.minus.push(k[1]);
      else if (k[0] === '^') c.start = k[1];
      else if (k[0] === 'T') c.theme = +k.slice(1);
      else if (k === '!F') c.flash = true;
      else if (k === '!I') c.inv = true;
      else if (k === '!U') c.uk = true;
    });
    return c;
  }
  const constraints = (st) => constraintsOf(st.cards[st.round - 1]);

  // Vérifie les contraintes de lettres (le thème et l'accent sont jugés par les autres joueurs).
  function checkWord(c, raw, said) {
    const w = norm(raw);
    if (w.length < MIN_LEN) return 'Mot trop court (3 lettres minimum).';
    if (said.includes(w)) return 'Ce mot a déjà été dit !';
    for (const l of c.plus) if (!w.includes(l.toLowerCase())) return 'Il manque la lettre ' + l + ' !';
    for (const l of c.minus) if (w.includes(l.toLowerCase())) return 'La lettre ' + l + ' est interdite !';
    if (c.start && w[0] !== c.start.toLowerCase()) return 'Le mot doit commencer par ' + c.start + ' !';
    return null;
  }

  /* ---------- Partie ---------- */
  function newGame(seats, gameId) {
    const N = seats.length, solo = N === 1, slots = solo ? 3 : N;
    const st = {
      v: 0, phase: 'reveal', gameId, seats, N, solo, R: ROUNDS, round: 1, slots,
      cards: Array.from({ length: ROUNDS }, () => genRound(slots)),
      col: seats.map(() => 0), found: [], words: [], speaker: -1, jury: [], votes: {},
      budget: 0, dur: 0, ready: [], events: [], eid: 0, humans: N, result: null, last: null,
    };
    startRound(st, []);
    return st;
  }

  function startRound(st, away) {
    const c = constraints(st);
    st.phase = 'reveal';
    st.found = st.seats.map((_, i) => away.includes(i));
    st.words = []; st.speaker = -1; st.jury = []; st.votes = {}; st.ready = []; st.last = null;
    st.budget = c.flash ? FLASH_MS : FIND_MS;
    st.dur = REVEAL_MS;
    pushEv(st, { type: 'round', round: st.round, f: c.flash ? 1 : 0, i: c.inv ? 1 : 0, u: c.uk ? 1 : 0 });
  }

  const notFound = (st) => st.seats.map((_, i) => i).filter((i) => !st.found[i]);

  // Fin de manche : les perdants se partagent les cartes de la table.
  function collect(st, losers, why) {
    const total = st.slots, res = [];
    if (losers.length) {
      const start = Math.floor(Math.random() * losers.length), add = {};
      for (let k = 0; k < total; k++) {
        const s = losers[(start + k) % losers.length];
        add[s] = (add[s] || 0) + 1;
      }
      Object.keys(add).forEach((s) => { st.col[+s] += add[s]; res.push([+s, add[s]]); });
    }
    st.last = { losers: res, why: why || '' };
    st.phase = 'roundEnd'; st.dur = END_MS; st.speaker = -1; st.ready = [];
    pushEv(st, { type: 'collect', c: res, why: why || '' });
  }

  function openFind(st) {
    st.phase = 'find'; st.dur = st.budget;
    checkLast(st);
  }

  function checkLast(st) {
    if (st.solo || st.phase !== 'find') return;
    const nf = notFound(st);
    if (nf.length <= 1) collect(st, nf, 'last');
  }

  function buzz(st, seat, remaining) {
    if (st.phase !== 'find') return "Trop tard, quelqu'un parle déjà !";
    if (st.found[seat]) return 'Tu as déjà trouvé !';
    st.phase = 'speak'; st.speaker = seat;
    st.budget = Math.max(2500, remaining);
    st.dur = SPEAK_MS;
    pushEv(st, { type: 'buzz', seat });
    return null;
  }

  function markBad(st, why) {
    const w = st.words[st.words.length - 1];
    if (w) w.ok = false;
    pushEv(st, { type: 'bad', seat: st.speaker, why });
    collect(st, [st.speaker], 'err');
    st.last.msg = why;
  }

  function accept(st) {
    const w = st.words[st.words.length - 1], s = st.speaker, c = constraints(st);
    if (w) w.ok = true;
    st.found[s] = true; st.jury = []; st.votes = {};
    pushEv(st, { type: 'ok', seat: s, w: w ? w.w : '' });
    if (st.solo) { collect(st, [], 'solo'); return; }
    if (c.inv) { collect(st, [s], 'inv'); return; }
    st.speaker = -1; st.phase = 'find'; st.dur = st.budget;
    checkLast(st);
  }

  function submitWord(st, seat, word, jurors) {
    if (st.phase !== 'speak' || st.speaker !== seat) return "Ce n'est pas ton tour de parler.";
    const clean = String(word).trim().slice(0, 30);
    if (!clean) return 'Écris un mot !';
    const c = constraints(st);
    const said = st.words.filter((x) => x.ok !== false).map((x) => x.n);
    const err = checkWord(c, clean, said);
    st.words.push({ s: seat, w: clean, n: norm(clean), ok: null });
    pushEv(st, { type: 'say', seat, w: clean });
    if (err) { markBad(st, err); return null; }
    if ((c.theme >= 0 || c.uk) && jurors.length) {
      st.phase = 'judge'; st.jury = jurors; st.votes = {}; st.dur = JUDGE_MS;
    } else accept(st);
    return null;
  }

  function vote(st, seat, ok) {
    if (st.phase !== 'judge' || !st.jury.includes(seat)) return null;
    st.votes[seat] = !!ok;
    return null;
  }

  function judgeResolve(st) {
    if (st.phase !== 'judge') return;
    const v = Object.values(st.votes), yes = v.filter(Boolean).length, no = v.length - yes;
    const ok = yes >= no;
    pushEv(st, { type: 'verdict', ok, y: yes, n: no });
    if (ok) accept(st); else markBad(st, 'Refusé par les autres joueurs !');
  }

  function failSpeaker(st, why) {
    if (st.phase !== 'speak') return;
    st.words.push({ s: st.speaker, w: '…', n: '', ok: false });
    markBad(st, why);
  }

  function timeoutFind(st) {
    if (st.phase !== 'find') return;
    pushEv(st, { type: 'time' });
    collect(st, notFound(st), 'time');
  }

  function nextRound(st, away) {
    if (st.round >= st.R) {
      const best = Math.min(...st.col);
      st.result = { winners: st.col.map((c, i) => (c === best ? i : -1)).filter((i) => i >= 0) };
      st.phase = 'over'; st.speaker = -1;
      pushEv(st, { type: 'over', winners: st.result.winners });
      return;
    }
    st.round++;
    startRound(st, away || []);
  }

  const api = {
    THEMES, FIND_MS, END_MS, norm, genRound, constraintsOf, constraints, checkWord, notFound,
    newGame, openFind, buzz, submitWord, vote, judgeResolve, failSpeaker, timeoutFind, nextRound,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MomoEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
