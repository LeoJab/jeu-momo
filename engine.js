/* Momo – moteur de règles (aucune interface ici).
   Cartes : 0-47 = 4 couleurs x 12 valeurs, 48-51 = les 4 cartes Momo. */
(function (root) {
  'use strict';

  const SUITS = [
    { id: 0, name: 'Piment', emoji: '🌶️' },
    { id: 1, name: 'Citron', emoji: '🍋' },
    { id: 2, name: 'Basilic', emoji: '🌿' },
    { id: 3, name: 'Myrtille', emoji: '🫐' },
  ];
  const PER_SUIT = 12;
  const MOMO0 = 48;
  const DECK = 52;
  const MAX_ROUNDS = 7;

  const isMomo = (c) => c >= MOMO0;
  const suitOf = (c) => (isMomo(c) ? -1 : Math.floor(c / PER_SUIT));
  const valOf = (c) => (isMomo(c) ? 99 : (c % PER_SUIT) + 1);

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Momo d'abord, puis par couleur, valeurs décroissantes.
  function sortCards(a, b) {
    const ma = isMomo(a), mb = isMomo(b);
    if (ma !== mb) return ma ? -1 : 1;
    if (ma) return a - b;
    const sa = suitOf(a), sb = suitOf(b);
    return sa !== sb ? sa - sb : valOf(b) - valOf(a);
  }

  function pushEv(st, ev) {
    ev.id = ++st.eid;
    st.events.push(ev);
    if (st.events.length > 14) st.events.shift();
  }

  /* ---------- Création / manches ---------- */

  function newGame(seats, gameId) {
    const n = seats.length;
    const st = {
      v: 0, phase: 'bid', gameId, seats, N: n, R: MAX_ROUNDS,
      round: 1, dealer: Math.floor(Math.random() * n),
      hands: [], trump: -1, trumpCard: null,
      bids: [], won: [], bidCount: 0,
      turn: 0, trick: [], leadSuit: -1, win: null, lastTrick: null,
      totals: seats.map(() => 0), history: [], ready: [],
      events: [], eid: 0, humans: seats.filter((s) => !s.bot).length, result: null,
    };
    startRound(st);
    return st;
  }

  function startRound(st) {
    const deck = shuffle(Array.from({ length: DECK }, (_, i) => i));
    st.hands = st.seats.map(() => deck.splice(0, st.round).sort(sortCards));
    const tc = deck.pop();
    st.trumpCard = tc;
    st.trump = isMomo(tc) ? -1 : suitOf(tc);
    st.bids = st.seats.map(() => null);
    st.won = st.seats.map(() => 0);
    st.bidCount = 0;
    st.turn = (st.dealer + 1) % st.N;
    st.trick = [];
    st.leadSuit = -1;
    st.win = null;
    st.ready = [];
    st.phase = 'bid';
    pushEv(st, { type: 'deal', round: st.round });
  }

  function nextRound(st) {
    st.round++;
    st.dealer = (st.dealer + 1) % st.N;
    startRound(st);
  }

  /* ---------- Règles ---------- */

  // Pari interdit pour le dernier parieur (le total ne doit pas égaler le nombre de plis).
  function forbiddenBid(st, seat) {
    if (st.bidCount !== st.N - 1) return -1;
    const sum = st.bids.reduce((a, b) => a + (b || 0), 0);
    const f = st.round - sum;
    return f >= 0 && f <= st.round ? f : -1;
  }

  function legalCards(st, seat) {
    const hand = st.hands[seat] || [];
    if (st.leadSuit < 0) return hand.slice();
    const has = hand.some((c) => !isMomo(c) && suitOf(c) === st.leadSuit);
    return has ? hand.filter((c) => isMomo(c) || suitOf(c) === st.leadSuit) : hand.slice();
  }

  function leadSuitOf(trick) {
    const f = trick.find((t) => !isMomo(t.c));
    return f ? suitOf(f.c) : -1;
  }

  // Premier Momo posé > meilleur atout > meilleure carte de la couleur demandée.
  function trickWinner(st, trick) {
    const m = trick.find((t) => isMomo(t.c));
    if (m) return m.s;
    const trumps = st.trump >= 0 ? trick.filter((t) => suitOf(t.c) === st.trump) : [];
    const lead = leadSuitOf(trick);
    const pool = trumps.length ? trumps : trick.filter((t) => suitOf(t.c) === lead);
    return pool.reduce((best, t) => (valOf(t.c) > valOf(best.c) ? t : best)).s;
  }

  function pointsFor(round, bid, got) {
    if (bid === got) return 10 + 4 * bid + (bid === 0 ? 2 * round : 0);
    return -3 * Math.abs(bid - got);
  }

  /* ---------- Actions (renvoient null si OK, sinon un message d'erreur) ---------- */

  function applyBid(st, seat, n) {
    if (st.phase !== 'bid' || st.turn !== seat) return "Ce n'est pas ton tour de parier.";
    if (!(n >= 0 && n <= st.round)) return 'Pari impossible.';
    if (n === forbiddenBid(st, seat)) return 'Pari interdit : le total ne peut pas égaler le nombre de plis.';
    st.bids[seat] = n;
    st.bidCount++;
    pushEv(st, { type: 'bid', seat, n });
    if (st.bidCount >= st.N) {
      st.phase = 'play';
      st.turn = (st.dealer + 1) % st.N;
    } else {
      st.turn = (st.turn + 1) % st.N;
    }
    return null;
  }

  function applyPlay(st, seat, card) {
    if (st.phase !== 'play' || st.turn !== seat || st.trick.length >= st.N) return "Ce n'est pas ton tour.";
    if (!st.hands[seat].includes(card)) return "Tu n'as pas cette carte.";
    if (!legalCards(st, seat).includes(card)) return 'Tu dois fournir la couleur demandée.';
    st.hands[seat].splice(st.hands[seat].indexOf(card), 1);
    st.trick.push({ s: seat, c: card });
    if (st.leadSuit < 0 && !isMomo(card)) st.leadSuit = suitOf(card);
    pushEv(st, { type: 'play', seat, c: card });
    if (isMomo(card)) pushEv(st, { type: 'momo', seat });
    if (st.trick.length === st.N) {
      st.win = trickWinner(st, st.trick);
      st.turn = -1;
    } else {
      st.turn = (st.turn + 1) % st.N;
    }
    return null;
  }

  // Clôture le pli complet ; enchaîne sur la fin de manche / de partie si c'était le dernier.
  function resolveTrick(st) {
    if (st.phase !== 'play' || st.trick.length !== st.N) return;
    const w = st.win;
    st.won[w]++;
    st.lastTrick = { cards: st.trick, winner: w };
    pushEv(st, { type: 'trick', w, momo: st.trick.some((t) => isMomo(t.c)) });
    st.trick = [];
    st.leadSuit = -1;
    st.win = null;
    if (st.hands[0].length > 0) {
      st.turn = w;
      return;
    }
    // fin de manche
    const res = st.seats.map((_, i) => [st.bids[i], st.won[i], pointsFor(st.round, st.bids[i], st.won[i])]);
    res.forEach((r, i) => { st.totals[i] += r[2]; });
    st.history.push(res);
    st.turn = -1;
    pushEv(st, { type: 'round', res });
    if (st.round >= st.R) {
      const best = Math.max(...st.totals);
      st.result = { winners: st.totals.map((t, i) => (t === best ? i : -1)).filter((i) => i >= 0) };
      st.phase = 'over';
      pushEv(st, { type: 'over', winners: st.result.winners });
    } else {
      st.phase = 'roundEnd';
    }
  }

  /* ---------- Bots ---------- */

  function botBid(st, seat) {
    let est = 0;
    for (const c of st.hands[seat]) {
      const v = valOf(c);
      if (isMomo(c)) est += 0.95;
      else if (suitOf(c) === st.trump) est += v >= 11 ? 0.9 : v >= 8 ? 0.6 : v >= 5 ? 0.3 : 0.12;
      else est += v === 12 ? 0.55 : v === 11 ? 0.35 : v === 10 ? 0.15 : 0.03;
    }
    est += (Math.random() - 0.5) * 0.7;
    const f = forbiddenBid(st, seat);
    const options = [];
    for (let n = 0; n <= st.round; n++) if (n !== f) options.push(n);
    options.sort((a, b) => Math.abs(a - est) - Math.abs(b - est));
    return options[0];
  }

  function botPlay(st, seat) {
    const legal = legalCards(st, seat);
    if (Math.random() < 0.08) return legal[Math.floor(Math.random() * legal.length)];
    const strength = (c) => (isMomo(c) ? 1000 : (suitOf(c) === st.trump ? 100 : 0) + valOf(c));
    const asc = legal.slice().sort((a, b) => strength(a) - strength(b));
    const wins = (c) => trickWinner(st, st.trick.concat([{ s: seat, c }])) === seat;
    const need = st.bids[seat] - st.won[seat];
    const leading = st.trick.length === 0;
    if (need > 0) {
      if (leading) {
        const noMomo = asc.filter((c) => !isMomo(c));
        return (noMomo.length ? noMomo : asc)[(noMomo.length ? noMomo : asc).length - 1];
      }
      const winners = asc.filter(wins);
      return winners.length ? winners[0] : asc[0];
    }
    if (leading) return asc[0];
    const losers = asc.filter((c) => !wins(c));
    return losers.length ? losers[losers.length - 1] : asc[0];
  }

  const api = {
    SUITS, MAX_ROUNDS, isMomo, suitOf, valOf, sortCards, shuffle,
    newGame, nextRound, forbiddenBid, legalCards, trickWinner, pointsFor,
    applyBid, applyPlay, resolveTrick, botBid, botPlay,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MomoEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
