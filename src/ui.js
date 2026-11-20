'use strict';
// Theme, keyboard shortcuts and the Ctrl+K command palette. Depends on helpers from app.js.

// ------------------------------------------------------------------ theme
const THEME_KEY = 'wipewatch-theme';
const getTheme = () => { try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch (_) { return 'dark'; } };
function applyTheme(mode) {
  const light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.setAttribute('data-theme', (mode === 'light' || (mode === 'system' && light)) ? 'light' : 'dark');
}
function setTheme(mode) { try { localStorage.setItem(THEME_KEY, mode); } catch (_) { /* ignore */ } applyTheme(mode); const sel = $('#s-theme'); if (sel) sel.value = mode; }
applyTheme(getTheme());
if (window.matchMedia) window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme(getTheme()));
(function bindTheme() { const sel = $('#s-theme'); if (!sel) return; sel.value = getTheme(); sel.addEventListener('change', () => setTheme(sel.value)); })();

// ------------------------------------------------------------------ command palette
let palOpen = false; let palItems = []; let palSel = 0;
function palCommands() {
  const cmds = [];
  for (const b of $$('nav button').filter((x) => !x.hidden)) cmds.push({ label: 'Go to ' + b.querySelector('span').textContent, hint: 'Page', run: () => showTab(b.dataset.tab) });
  cmds.push(
    { label: 'Check for drops now', hint: 'Action', run: () => $('#refresh').click() },
    { label: 'Refresh skin prices', hint: 'Action', run: () => window.api.pricesRefresh(true) },
    { label: 'Refresh server list', hint: 'Action', run: () => { showTab('servers'); loadServersTab(true); } },
    { label: 'Export inventory to CSV', hint: 'Action', run: () => window.api.exportCsv('skins') },
    { label: 'Export history to CSV', hint: 'Action', run: () => window.api.exportCsv('history') },
    { label: 'Mark all patch notes as read', hint: 'Action', run: () => window.api.newsReadAll() },
    { label: 'Switch theme (dark / light)', hint: 'Action', run: () => setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light') },
    { label: 'Get a Steam Web API key', hint: 'Link', run: () => window.api.open('https://steamcommunity.com/dev/apikey') },
    { label: 'Create a Twitch developer app', hint: 'Link', run: () => window.api.open('https://dev.twitch.tv/console/apps/create') },
  );
  if (typeof homeFavs !== 'undefined' && homeFavs) for (const f of homeFavs) cmds.push({ label: 'Open server: ' + f.name, hint: 'Server', run: () => { showTab('servers'); setTimeout(() => openServer(f.id), 250); } });
  return cmds;
}
function palRender() {
  const q = $('#pal-input').value.trim().toLowerCase(); const words = q.split(/\s+/).filter(Boolean);
  palItems = palCommands().filter((c) => words.every((w) => c.label.toLowerCase().includes(w))).slice(0, 9);
  if (palSel >= palItems.length) palSel = 0;
  $('#pal-list').replaceChildren(...(palItems.length ? palItems.map((c, i) => h('div', { class: 'pal-item' + (i === palSel ? ' sel' : ''), onclick: () => palRun(i), onmousemove: () => { palSel = i; palMark(); } }, h('span', {}, c.label), h('em', {}, c.hint)))
    : [h('div', { class: 'pal-none' }, 'No matching command')]));
}
function palMark() { $$('#pal-list .pal-item').forEach((el, i) => el.classList.toggle('sel', i === palSel)); }
function palRun(i) { const c = palItems[i]; closePalette(); if (c) c.run(); }
function openPalette() {
  if (!$('#palette')) {
    const input = h('input', { id: 'pal-input', placeholder: 'Type a command or page name...', autocomplete: 'off', 'aria-label': 'Command palette' });
    input.addEventListener('input', () => { palSel = 0; palRender(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palItems.length - 1, palSel + 1); palMark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(0, palSel - 1); palMark(); }
      else if (e.key === 'Enter') { e.preventDefault(); palRun(palSel); }
    });
    document.body.append(h('div', { id: 'palette', class: 'pal', hidden: true, onclick: (e) => { if (e.target.id === 'palette') closePalette(); } },
      h('div', { class: 'pal-box', role: 'dialog', 'aria-label': 'Command palette' }, input, h('div', { id: 'pal-list' }), h('div', { class: 'pal-hint' }, 'Up/Down to move, Enter to run, Esc to close'))));
  }
  palOpen = true; $('#palette').hidden = false; $('#pal-input').value = ''; palSel = 0; palRender(); $('#pal-input').focus();
}
function closePalette() { palOpen = false; const p = $('#palette'); if (p) p.hidden = true; }

// ------------------------------------------------------------------ keyboard shortcuts
const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
  if (mod && k === 'k') { e.preventDefault(); palOpen ? closePalette() : openPalette(); return; }
  if (e.key === 'Escape' && palOpen) { closePalette(); return; }
  if (mod && /^[1-9]$/.test(e.key)) { const b = $$('nav button').filter((x) => !x.hidden)[Number(e.key) - 1]; if (b) { e.preventDefault(); showTab(b.dataset.tab); } return; }
  if (mod && k === 'r') { e.preventDefault(); const r = $('#refresh'); if (r && !r.disabled) r.click(); return; }
  if (e.key === '/' && !mod && !isTyping(e.target)) {   // jump to the search box of the current page
    const box = !$('#tab-servers').hidden ? $('#sv-search') : !$('#tab-skins').hidden ? $('#sk-search') : !$('#tab-stats').hidden ? $('#st-search') : null;
    e.preventDefault(); if (box) box.focus(); else openPalette();
  }
});
