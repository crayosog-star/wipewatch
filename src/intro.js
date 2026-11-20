'use strict';
// Launch animation: a supply drop parachutes in, slams down, bursts into the Wipewatch logo, then reveals the app.
// Skippable (click / any key), respects "reduce motion" and the Settings toggle, only runs once the window is visible.
(function () {
  const KEY = 'wipewatch-intro';
  const el = document.getElementById('intro');
  const chk = document.getElementById('s-intro');
  const get = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch (_) { return true; } };
  if (chk) { chk.checked = get(); chk.addEventListener('change', () => { try { localStorage.setItem(KEY, chk.checked ? 'on' : 'off'); } catch (_) { /* ignore */ } }); }
  const skip = /[?&]nointro=1/.test(location.search) || !get();   // the OS "reduce motion" flag is ignored on purpose (it reads true on many PCs); Settings has the off switch
  if (!el) return;
  if (skip) { el.remove(); return; }

  const sparks = el.querySelector('.in-sparks');
  const cols = ['#ff9a3d', '#ff5a4a', '#ff3d6e', '#ffd2a8', '#ffffff'];
  for (let i = 0; i < 34; i++) {
    const s = document.createElement('i');
    const a = (i / 34) * Math.PI * 2 + Math.random() * 0.4;
    const d = 130 + Math.random() * 230;
    s.style.setProperty('--dx', Math.cos(a) * d + 'px');
    s.style.setProperty('--dy', Math.sin(a) * d * 0.7 - 30 + 'px');
    s.style.setProperty('--sz', 3 + Math.random() * 5 + 'px');
    s.style.setProperty('--dl', 1.0 + Math.random() * 0.06 + 's');
    s.style.background = cols[i % cols.length];
    sparks.appendChild(s);
  }

  let done = false;
  const finish = () => {
    if (done) return; done = true;
    el.classList.add('out'); document.body.classList.add('intro-reveal');
    setTimeout(() => { el.remove(); document.body.classList.remove('intro-reveal'); }, 650);
    window.removeEventListener('keydown', finish); el.removeEventListener('pointerdown', finish);
  };
  const start = () => { el.classList.add('go'); setTimeout(finish, 2900); };
  window.addEventListener('keydown', finish); el.addEventListener('pointerdown', finish);
  // wait until the window is actually on screen (tray-start launches hidden)
  if (document.visibilityState === 'visible') requestAnimationFrame(start);
  else document.addEventListener('visibilitychange', function f() { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', f); start(); } });
})();
