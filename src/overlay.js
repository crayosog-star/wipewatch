'use strict';
// Mini overlay: wipe countdown, skin value and favourite servers. Fed by the same state push as the main window.
let S = null; let favs = [];
const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; };
function left(ms) { const m = Math.max(0, Math.floor((ms - Date.now()) / 60000)); const d = Math.floor(m / 1440); const hr = Math.floor((m % 1440) / 60); return d ? `${d}d ${hr}h ${m % 60}m` : `${hr}h ${m % 60}m`; }
function money(n, cur) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n); } catch (_) { return n.toFixed(2) + ' ' + cur; } }
function render() {
  const root = document.getElementById('ov'); if (!S) return;
  const top = el('div', 'top'); const img = document.createElement('img'); img.src = '../assets/icon-256.png'; img.alt = ''; top.append(img, el('b', '', 'Wipewatch'));
  const kids = [top, el('div', 'lbl', 'Next force wipe'), el('div', 'big', S.nextUpdate ? left(S.nextUpdate) : '-')];
  const k = S.skins;
  if (k && k.priced) {
    const row = el('div', 'row'); row.append(el('span', 'lbl', 'Skins'), el('b', '', money(k.total, k.currency)));
    if (k.change) { const c = el('span', k.change > 0 ? 'up' : 'down', `${k.change > 0 ? '+' : ''}${money(k.change, k.currency)}`); row.append(c); }
    kids.push(row);
  }
  for (const f of favs.slice(0, 2)) {
    const row = el('div', 'sv'); row.append(el('span', '', f.name || f.id));
    const pc = `${f.players ?? '?'}/${f.max ?? '?'}`;
    row.append(f.queue > 0 ? el('span', 'q', `${pc}  +${f.queue} queue`) : el('span', '', pc)); kids.push(row);
  }
  root.replaceChildren(...kids);
}
async function loadFavs() { try { favs = (await window.api.serverFavs()) || []; } catch (_) { favs = []; } render(); }
window.api.onState((s) => { S = s; render(); });
window.api.state().then((s) => { S = s; render(); });
loadFavs(); setInterval(loadFavs, 60000); setInterval(render, 30000);
