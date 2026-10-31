/* Momo – sons (WebAudio, aucun fichier) et effets spéciaux (confettis, feux d'artifice, secousses). */
(function () {
  'use strict';

  const calm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let muted = false;
  try { muted = localStorage.getItem('momo.muted') === '1'; } catch (e) { /* ignore */ }

  /* ---------- Sons ---------- */
  let ctx = null;
  function ac() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, dur, type, vol, delay, slideTo) {
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + (delay || 0);
    const o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.15, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function noise(dur, vol, delay, cutoff) {
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + (delay || 0);
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = c.createBufferSource(); s.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = cutoff || 1800;
    const g = c.createGain(); g.gain.value = vol || 0.2;
    s.connect(f).connect(g).connect(c.destination);
    s.start(t0);
  }
  const SOUNDS = {
    click() { tone(660, 0.05, 'square', 0.05); },
    play() { noise(0.07, 0.35, 0, 2200); tone(180, 0.08, 'triangle', 0.12); },
    deal() { for (let i = 0; i < 5; i++) noise(0.05, 0.25, i * 0.07, 3000); },
    bid() { tone(520, 0.09, 'square', 0.06); tone(780, 0.12, 'square', 0.06, 0.08); },
    trick() { [523, 659, 784].forEach((f, i) => tone(f, 0.16, 'triangle', 0.14, i * 0.07)); },
    momo() {
      tone(90, 0.7, 'sawtooth', 0.28, 0, 30);
      tone(300, 0.5, 'square', 0.08, 0, 1800);
      noise(0.6, 0.5, 0, 500);
      [1046, 1318, 1568].forEach((f, i) => tone(f, 0.3, 'triangle', 0.13, 0.25 + i * 0.09));
    },
    exact() { [659, 784, 988, 1318].forEach((f, i) => tone(f, 0.22, 'triangle', 0.15, i * 0.08)); },
    miss() { tone(260, 0.35, 'sawtooth', 0.09, 0, 120); },
    win() {
      [523, 659, 784, 1046, 784, 1046, 1318].forEach((f, i) => tone(f, 0.26, 'square', 0.09, i * 0.13));
      tone(130, 1.2, 'triangle', 0.15, 0);
    },
    lose() { [392, 349, 311, 262].forEach((f, i) => tone(f, 0.3, 'triangle', 0.12, i * 0.2)); },
    boom() { noise(0.35, 0.4, 0, 700); tone(120, 0.3, 'sine', 0.2, 0, 40); },
  };
  function sfx(name) {
    if (muted) return;
    try { if (SOUNDS[name]) SOUNDS[name](); } catch (e) { /* ignore */ }
  }
  function toggleMute() {
    muted = !muted;
    try { localStorage.setItem('momo.muted', muted ? '1' : '0'); } catch (e) { /* ignore */ }
    return muted;
  }

  /* ---------- Particules ---------- */
  const cv = document.getElementById('fx');
  const g2 = cv.getContext('2d');
  let parts = [], raf = 0, dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener('resize', resize); resize();

  const COLORS = ['#ffd426', '#e8333b', '#1fb86b', '#7a4cf0', '#ffffff', '#2dd4ff', '#ff8a1f'];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const scale = (n) => (calm ? Math.ceil(n * 0.25) : n);

  function add(p) { parts.push(p); if (!raf) raf = requestAnimationFrame(loop); }

  function confetti(x, y, n, spread) {
    for (let i = 0; i < scale(n || 60); i++) {
      const a = rnd(-Math.PI, 0), sp = rnd(4, 13) * (spread || 1);
      add({ kind: 'rect', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2, ay: 0.32, drag: 0.985,
        w: rnd(5, 10), h: rnd(3, 7), r: rnd(0, 6), vr: rnd(-0.3, 0.3), c: pick(COLORS), life: rnd(70, 130), max: 130 });
    }
  }
  function burst(x, y, color, n) {
    for (let i = 0; i < scale(n || 40); i++) {
      const a = rnd(0, Math.PI * 2), sp = rnd(2, 9);
      add({ kind: 'dot', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, ay: 0.12, drag: 0.95,
        w: rnd(2, 4.5), c: color || pick(COLORS), life: rnd(30, 55), max: 55 });
    }
  }
  function fireworks(ms) {
    const end = Date.now() + (ms || 4500);
    const tick = () => {
      if (Date.now() > end) return;
      const x = rnd(innerWidth * 0.1, innerWidth * 0.9), y = rnd(innerHeight * 0.1, innerHeight * 0.5);
      const col = pick(COLORS);
      burst(x, y, col, 55); burst(x, y, '#ffffff', 14);
      sfx('boom');
      setTimeout(tick, rnd(250, 600));
    };
    tick();
  }
  function rain(n) { for (let i = 0; i < scale(n || 80); i++) setTimeout(() => confetti(rnd(0, innerWidth), -10, 1, 0.2), i * 25); }

  function loop() {
    g2.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter((p) => p.life > 0);
    for (const p of parts) {
      p.vx *= p.drag; p.vy = p.vy * p.drag + p.ay;
      p.x += p.vx; p.y += p.vy; p.life--;
      g2.globalAlpha = Math.max(0, Math.min(1, p.life / (p.max * 0.4)));
      g2.fillStyle = p.c;
      if (p.kind === 'rect') {
        p.r += p.vr;
        g2.save(); g2.translate(p.x, p.y); g2.rotate(p.r); g2.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); g2.restore();
      } else {
        g2.beginPath(); g2.arc(p.x, p.y, p.w, 0, Math.PI * 2); g2.fill();
      }
    }
    g2.globalAlpha = 1;
    raf = parts.length ? requestAnimationFrame(loop) : 0;
    if (!parts.length) g2.clearRect(0, 0, innerWidth, innerHeight);
  }

  /* ---------- Effets DOM ---------- */
  function shake() {
    if (calm) return;
    document.body.classList.remove('shake');
    void document.body.offsetWidth;
    document.body.classList.add('shake');
    setTimeout(() => document.body.classList.remove('shake'), 520);
  }
  function flash(color) {
    const d = document.createElement('div');
    d.className = 'flash';
    d.style.background = color || '#fff';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 600);
  }
  function banner(text, cls) {
    const d = document.createElement('div');
    d.className = 'banner ' + (cls || '');
    d.textContent = text;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 1500);
  }
  function floatText(x, y, text, color) {
    const d = document.createElement('div');
    d.className = 'ftxt';
    d.textContent = text;
    d.style.left = x + 'px'; d.style.top = y + 'px';
    if (color) d.style.color = color;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 1500);
  }

  window.FX = {
    sfx, toggleMute, isMuted: () => muted,
    confetti, burst, fireworks, rain, shake, flash, banner, floatText,
  };
})();
