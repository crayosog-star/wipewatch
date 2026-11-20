'use strict';
// Extras: Build Ideas, Wipe Planner (checklist, notes, base pins), skin watchlist, claim/watch streaks, alert sounds, overlay settings.
// Depends on app.js helpers (h, $, $$, S, money, lineChart, alertBox, ...). Classic script, shares global scope.

// ------------------------------------------------------------------ alert sounds (synthesised, no files)
let actx = null;
function playSound(o) {
  const mode = (o && o.mode) || 'airdrop'; if (mode === 'off') return;
  const vol = Math.min(1, Math.max(0, ((o && o.volume) == null ? 60 : o.volume) / 100));
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (_) { return; }
  const t0 = actx.currentTime + 0.03;
  const master = actx.createGain(); master.gain.value = vol * 0.55; master.connect(actx.destination);
  const tone = (type, f0, f1, at, dur, g) => {
    const os = actx.createOscillator(); const gn = actx.createGain(); os.type = type;
    os.frequency.setValueAtTime(f0, t0 + at); if (f1 !== f0) os.frequency.exponentialRampToValueAtTime(f1, t0 + at + dur);
    gn.gain.setValueAtTime(0.0001, t0 + at); gn.gain.exponentialRampToValueAtTime(g, t0 + at + 0.02); gn.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    os.connect(gn); gn.connect(master); os.start(t0 + at); os.stop(t0 + at + dur + 0.05);
  };
  const thump = (at) => {
    const len = Math.floor(actx.sampleRate * 0.35); const buf = actx.createBuffer(1, len, actx.sampleRate); const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = actx.createBufferSource(); src.buffer = buf; const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
    const gn = actx.createGain(); gn.gain.value = 0.9; src.connect(lp); lp.connect(gn); gn.connect(master); src.start(t0 + at);
    tone('sine', 110, 38, at, 0.4, 1);
  };
  const kind = (o && o.kind) || 'drop';
  if (mode === 'airdrop' && kind === 'drop') {          // falling whistle, ground thump, then a bright chime
    tone('sawtooth', 1500, 260, 0, 0.85, 0.12); tone('sine', 1900, 340, 0, 0.85, 0.12);
    thump(0.85); tone('triangle', 880, 880, 1.1, 0.6, 0.5); tone('triangle', 1320, 1320, 1.25, 0.7, 0.4);
  } else if (mode === 'radar') {
    tone('sine', 1040, 1040, 0, 0.45, 0.6); tone('sine', 1040, 1040, 0.5, 0.45, 0.4);
  } else {                                              // chime (also the quieter variant for non-drop alerts)
    tone('triangle', 784, 784, 0, 0.5, 0.5); tone('triangle', 1175, 1175, 0.14, 0.6, 0.4);
  }
}
window.api.onSound(playSound);

// ------------------------------------------------------------------ helpers
const xAgo = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); if (m < 60) return m + 'm ago'; const hr = Math.round(m / 60); if (hr < 48) return hr + 'h ago'; return Math.round(hr / 24) + 'd ago'; };
const xViews = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(n)) + ' views';
const kvGet = (k, d) => ((S && S.kv && S.kv[k] != null) ? S.kv[k] : d);
function kvSave(k, v) { if (S) { S.kv = S.kv || {}; S.kv[k] = v; } return window.api.kvSet(k, v); }

// ------------------------------------------------------------------ build ideas
const BD = { info: null, loading: false, chip: 'all', error: '' };
const BD_CHIPS = [
  ['all', 'All', null], ['solo', 'Solo', /\bsolo\b/i], ['duo', 'Duo / Trio', /\b(duo|trio|2x2|small group)\b/i], ['group', 'Group / Clan', /\b(quad|group|clan|zerg|\d+\s?man)\b/i],
  ['bunker', 'Bunker', /bunker|underground|tunnel/i], ['cheap', 'Cheap / Starter', /cheap|starter|budget|beginner|easy|simple|fast|min(ute)?s?/i],
  ['trap', 'Trap / Trick', /trap|trick|troll|bait|egg/i], ['rate', 'Rate my base', /rate my|review|teardown|roast/i],
];
async function loadBuilds(force) {
  if (BD.loading) return; BD.loading = true; renderBuilds();
  try { BD.info = await window.api.buildsGet(force); BD.error = ''; } catch (e) { BD.error = 'Could not load build videos'; }
  BD.loading = false; renderBuilds();
}
function renderBuilds() {
  if ($('#tab-builds').hidden) return;
  const info = BD.info;
  const chips = $('#bd-chips'); chips.replaceChildren(...BD_CHIPS.map(([id, label]) => h('button', { class: 'chip' + (BD.chip === id ? ' on' : ''), onclick: () => { BD.chip = id; renderBuilds(); } }, label)));
  const note = $('#bd-note'); note.replaceChildren();
  const grid = $('#bd-grid'); grid.replaceChildren();
  if (!info) { note.append(h('div', { class: 'note slim' }, BD.error || 'Loading build videos...')); renderBuildSources(); return; }
  for (const [name, err] of Object.entries(info.errors || {})) note.append(h('div', { class: 'note slim' }, `${name}: ${err}`));
  const re = (BD_CHIPS.find((c) => c[0] === BD.chip) || [])[2]; const q = $('#bd-search').value.trim().toLowerCase(); const sort = $('#bd-sort').value;
  let list = info.videos.filter((v) => (!re || re.test(v.title)) && (!q || (v.title + ' ' + v.channel).toLowerCase().includes(q)));
  const hotIds = new Set(info.videos.slice(0, 3).map((v) => v.id));   // videos is already ordered by hot score
  if (sort === 'new') list = [...list].sort((a, b) => b.published - a.published); else if (sort === 'views') list = [...list].sort((a, b) => b.views - a.views);
  if (!list.length) note.append(h('div', { class: 'note slim' }, info.videos.length ? 'No videos match that filter.' : 'No recent base-build videos found. Add more channels below.'));
  for (const v of list) {
    grid.append(h('div', { class: 'bd', onclick: () => window.api.open(v.url), title: 'Open on YouTube' },
      h('div', { class: 'th' }, h('img', { src: v.thumb, alt: '', loading: 'lazy' }), hotIds.has(v.id) ? h('span', { class: 'hot' }, 'HOT') : null),
      h('div', { class: 'bi' }, h('div', { class: 'tt' }, v.title.replace(/\s*#\w+/g, '').trim() || v.title), h('div', { class: 'mt' }, h('span', {}, v.channel), h('span', {}, `${xViews(v.views)} - ${xAgo(v.published)}`)))));
  }
  renderBuildSources();
}
function renderBuildSources() {
  const box = $('#bd-sources'); if (!box) return;
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;   // don't wipe a half-typed channel
  const chans = (BD.info && BD.info.channels) || [];
  const input = h('input', { placeholder: '@handle or youtube.com link', class: 'grow' });
  const msg = h('div', { class: 'muted' });
  const add = h('button', { class: 'btn ghost', onclick: async () => {
    if (!input.value.trim()) return; add.disabled = true; msg.textContent = 'Looking up channel...';
    const r = await window.api.buildsAdd(input.value.trim()); add.disabled = false;
    if (r.error) msg.textContent = r.error; else { BD.info = r; renderBuilds(); }
  } }, 'Add channel');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add.click(); });
  box.replaceChildren(h('h3', {}, 'Channels you follow'), h('p', { class: 'muted' }, 'Videos come from YouTube\'s public channel feeds, so only channels you add here are checked. Only titles about bases and building are shown.'),
    ...chans.map((c) => h('div', { class: 'srcrow' }, h('span', {}, c.name || c.id), h('button', { class: 'btn ghost sm', onclick: async () => { BD.info = await window.api.buildsRemove(c.id); renderBuilds(); } }, 'Remove'))),
    h('div', { class: 'row' }, input, add), msg);
}
$('#bd-search').addEventListener('input', () => renderBuilds());
$('#bd-sort').addEventListener('change', () => renderBuilds());
$('#bd-refresh').addEventListener('click', async (e) => { e.target.disabled = true; await loadBuilds(true); e.target.disabled = false; });

// ------------------------------------------------------------------ wipe planner
const PLAN_DEFAULT = ['Pick a server and join right at wipe', 'Gather wood, stone and cloth', 'Craft and place a sleeping bag', 'Hit the first monuments for scrap', 'Research / build a workbench',
  'Choose the base spot and place the tool cupboard', 'Code locks on every door', 'Stock food, water and medical', 'Set up a second sleeping bag away from base'];
const lastForceWipe = () => { const n = new Date(); for (let i = 0; i <= 1; i++) { const t = firstThursday(n.getUTCFullYear(), n.getUTCMonth() - i); if (t.getTime() <= Date.now()) return t.getTime(); } return 0; };
const lastWipeOnTab = () => lastForceWipe();
function getPlan() {
  let p = kvGet('plan', null);
  if (!p || !Array.isArray(p.items)) p = { items: PLAN_DEFAULT.map((t, i) => ({ id: 'd' + i, text: t, done: false })), wipeKey: lastWipeOnTab(), notes: '' };
  return p;
}
let plRender = 0;
function renderPlanner() {
  if (!S || $('#tab-planner').hidden) return;
  let plan = getPlan();
  if (plan.wipeKey !== lastWipeOnTab()) { plan = { ...plan, items: plan.items.map((i) => ({ ...i, done: false })), wipeKey: lastWipeOnTab() }; kvSave('plan', plan); }
  const lw = plan.wipeKey; const nu = S.nextUpdate;
  const days = lw ? Math.floor((Date.now() - lw) / 864e5) : null;
  $('#pl-wipe').replaceChildren(
    h('div', { class: 'hero-main' }, h('div', { class: 'muted' }, 'Next force wipe'), h('div', { class: 'hero-num' }, nu && nu > Date.now() ? untilText(nu - Date.now()) : '-'), h('div', { class: 'muted' }, nu ? fmtDate(nu) : '')),
    h('div', { class: 'hero-stats' }, h('div', {}, h('b', {}, days != null ? 'Day ' + (days + 1) : '-'), h('span', {}, 'Of this wipe cycle')), h('div', {}, h('b', {}, `${plan.items.filter((i) => i.done).length}/${plan.items.length}`), h('span', {}, 'Steps done'))));
  $('#pl-list').replaceChildren(...plan.items.map((it) => h('div', { class: 'pl-item' + (it.done ? ' done' : '') },
    h('input', { type: 'checkbox', ...(it.done ? { checked: '' } : {}), onchange: (e) => { it.done = e.target.checked; kvSave('plan', plan); renderPlanner(); } }),
    h('span', {}, it.text), h('button', { title: 'Remove step', onclick: () => { plan.items = plan.items.filter((x) => x.id !== it.id); kvSave('plan', plan); renderPlanner(); } }, '×'))));
  const notes = $('#pl-notes'); if (document.activeElement !== notes && notes.value !== (plan.notes || '')) notes.value = plan.notes || '';
  renderPinList();
}
function renderPinList() {
  const pins = kvGet('pins', {}); const box = $('#pl-pins'); const groups = Object.entries(pins).filter(([, g]) => g.pins && g.pins.length);
  if (!groups.length) return box.replaceChildren(h('div', { class: 'muted' }, 'No pins yet.'));
  box.replaceChildren(...groups.map(([key, g]) => h('div', { style: 'margin-bottom:12px' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, g.name || g.id), h('span', { class: 'muted' }, `Seed ${g.seed} - size ${g.size}`),
      h('button', { class: 'btn ghost sm', onclick: () => { showTab('servers'); setTimeout(() => openServer(g.id), 250); } }, 'Open server')),
    ...g.pins.map((p) => h('div', { class: 'srcrow' }, h('span', {}, p.label || 'Base'), h('span', { class: 'muted' }, `${Math.round(p.x)}%, ${Math.round(p.y)}%`),
      h('button', { class: 'btn ghost sm', onclick: () => { const all = kvGet('pins', {}); const gg = all[key]; if (!gg) return; gg.pins = gg.pins.filter((x) => x.id !== p.id); if (!gg.pins.length) delete all[key]; kvSave('pins', all); renderPinList(); } }, 'Remove'))))));
}
$('#pl-add').addEventListener('click', () => { const t = $('#pl-new').value.trim(); if (!t) return; const plan = getPlan(); plan.items.push({ id: 'u' + Date.now(), text: t.slice(0, 120), done: false }); $('#pl-new').value = ''; kvSave('plan', plan); renderPlanner(); });
$('#pl-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pl-add').click(); });
$('#pl-reset').addEventListener('click', () => { const plan = getPlan(); plan.items.forEach((i) => (i.done = false)); kvSave('plan', plan); renderPlanner(); });
let notesT = null;
$('#pl-notes').addEventListener('input', (e) => { clearTimeout(notesT); const v = e.target.value.slice(0, 20000); notesT = setTimeout(() => { const plan = getPlan(); plan.notes = v; kvSave('plan', plan); }, 600); });

// ------------------------------------------------------------------ base pins on the server map
function attachPins(mapbox, m, b) {
  const key = `${b.id}|${m.seed}|${m.size}`;
  let pinning = false;
  const draw = () => {
    $$('.pin', mapbox).forEach((p) => p.remove());
    const g = kvGet('pins', {})[key];
    for (const p of (g && g.pins) || []) {
      const el = h('div', { class: 'pin', style: `left:${p.x}%;top:${p.y}%`, title: p.label }, h('b', {}, p.label || 'Base'));
      el.addEventListener('click', (e) => { e.stopPropagation(); if (!confirm(`Remove pin "${p.label || 'Base'}"?`)) return; const all = kvGet('pins', {}); const gg = all[key]; gg.pins = gg.pins.filter((x) => x.id !== p.id); if (!gg.pins.length) delete all[key]; kvSave('pins', all); draw(); });
      mapbox.append(el);
    }
  };
  const btn = h('button', { class: 'btn ghost sm', onclick: () => { pinning = !pinning; mapbox.classList.toggle('pinning', pinning); btn.textContent = pinning ? 'Click the map to place a pin...' : 'Pin a base'; } }, 'Pin a base');
  mapbox.addEventListener('click', (e) => {
    if (!pinning) return;
    e.stopPropagation(); e.preventDefault();
    const r = mapbox.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * 100; const y = ((e.clientY - r.top) / r.height) * 100;
    pinning = false; mapbox.classList.remove('pinning'); btn.textContent = 'Pin a base';
    const input = h('input', { placeholder: 'Name this pin (e.g. Main base)', value: 'Main base', class: 'grow', maxlength: '40' });
    const form = h('div', { class: 'row', style: 'margin-top:8px' }, input, h('button', { class: 'btn sm', onclick: () => {
      const all = kvGet('pins', {}); const g = (all[key] = all[key] || { id: b.id, name: b.name || b.id, seed: m.seed, size: m.size, pins: [] });
      g.pins.push({ id: 'p' + Date.now(), x: +x.toFixed(1), y: +y.toFixed(1), label: input.value.trim().slice(0, 40) || 'Base' }); kvSave('pins', all); form.remove(); draw();
    } }, 'Save pin'), h('button', { class: 'btn ghost sm', onclick: () => form.remove() }, 'Cancel'));
    mapbox.after(form); input.focus(); input.select();
  }, true);
  draw();
  return btn;
}

// ------------------------------------------------------------------ skin watchlist (Skins page)
const WL = { results: null, msg: '', busy: false };
function buildWatchShell() {
  const box = $('#sk-watch'); if (!box || box.dataset.ready) return; box.dataset.ready = '1';
  const input = h('input', { id: 'wl-q', placeholder: 'Search the Steam Market, e.g. Tempered AK47', class: 'grow' });
  const go = async () => {
    const q = input.value.trim(); if (q.length < 2 || WL.busy) return; WL.busy = true; WL.msg = 'Searching...'; renderWatchResults();
    const r = await window.api.watchSearch(q); WL.busy = false; WL.results = r.results || []; WL.msg = r.error || (WL.results.length ? '' : 'No market items matched that.'); renderWatchResults();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  box.append(h('div', { class: 'wl-head' }, h('div', {}, h('h2', { style: 'margin:0' }, 'Watchlist'), h('div', { class: 'muted' }, 'Track skins you don\'t own yet. Prices refresh with your inventory, and you can set price alerts.')),
    h('div', { class: 'row', style: 'min-width:320px;flex:1;max-width:520px' }, input, h('button', { class: 'btn ghost', onclick: go }, 'Search'))),
    h('div', { id: 'wl-msg', class: 'muted' }), h('div', { id: 'wl-res', class: 'wl-res' }), h('div', { id: 'wl-grid', class: 'skgrid' }));
}
function renderWatchResults() {
  const res = $('#wl-res'); if (!res) return; $('#wl-msg').textContent = WL.msg;
  const have = new Set((S.watchlist || []).map((w) => w.hash));
  res.replaceChildren(...(WL.results || []).filter((r) => !have.has(r.hash)).map((r) => h('div', { class: 'opt', title: 'Add to watchlist', onclick: async () => { await window.api.watchAdd(r); WL.results = WL.results.filter((x) => x.hash !== r.hash); renderWatchResults(); } },
    r.icon ? h('img', { src: r.icon, alt: '' }) : null, h('div', {}, h('b', {}, r.name), h('div', { class: 'muted' }, r.price ? `${r.price} - ${r.listings} listed` : 'Add')))));
}
function renderWatchlist() {
  if (!S || $('#tab-skins').hidden) return; buildWatchShell();
  const a = document.activeElement; if (a && a.closest && a.closest('#wl-grid .alertbox')) return;
  renderWatchResults();
  const k = S.skins; const grid = $('#wl-grid'); const list = S.watchlist || [];
  $('#sk-watch .wl-head .muted').textContent = list.length ? `Tracking ${list.length} skin${list.length === 1 ? '' : 's'}. Prices refresh with your inventory, and you can set price alerts.` : 'Track skins you don\'t own yet. Search above and click a result to add it.';
  grid.replaceChildren(...list.map((i) => h('div', { class: 'sk', style: `--glow:${i.color || '#8b93a8'}` },
    h('div', { class: 'imgbox' }, i.icon ? h('img', { src: i.icon, alt: '', loading: 'lazy' }) : h('div', { class: 'ph' }, i.name.slice(0, 1)),
      i.owned ? h('span', { class: 'qty' }, 'owned x' + i.owned) : null,
      h('button', { class: 'bell' + (i.alert ? ' on' : ''), title: i.alert ? 'Edit price alert' : 'Set a price alert', onclick: () => { alertOpen = alertOpen === i.hash ? '' : i.hash; alertDraft = { dir: i.alert ? i.alert.dir : 'below', price: i.alert ? String(i.alert.price) : '' }; renderWatchlist(); } }, bellIcon())),
    h('div', { class: 'nm' }, i.name),
    h('div', { class: 'prices' },
      h('div', { class: 'pr' }, h('span', { class: 'muted' }, 'Lowest'), i.lowest != null ? h('b', {}, money(i.lowest, k.currency), i.pct != null && Math.abs(i.pct) >= 0.1 ? h('small', { class: i.pct > 0 ? 'up' : 'down', style: 'margin-left:6px;font-weight:600' }, `${i.pct > 0 ? '+' : ''}${i.pct}%`) : null) : h('span', { class: 'muted' }, k.pricing.running ? 'checking...' : 'waiting for price')),
      h('div', { class: 'pr' }, h('span', { class: 'muted' }, 'Median'), h('span', {}, i.median != null ? money(i.median, k.currency) : '-')),
      i.spark.length >= 2 ? h('div', { class: 'spark' }, lineChart(i.spark, 100, 22, i.spark[i.spark.length - 1] >= i.spark[0] ? '#3ddc97' : '#ff5d6c')) : null,
      i.alert && alertOpen !== i.hash ? h('div', { class: 'muted' }, `Alert: ${i.alert.dir === 'above' ? '>=' : '<='} ${money(i.alert.price, k.currency)}`) : null,
      alertOpen === i.hash ? alertBox(i, k) : null),
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('a', { onclick: () => window.api.open('https://steamcommunity.com/market/listings/252490/' + encodeURIComponent(i.hash)) }, 'View on Steam Market'),
      h('a', { style: 'cursor:pointer', onclick: () => window.api.watchRemove(i.hash) }, 'Remove')))));
}
{ const _rs = renderSkins; renderSkins = function () { _rs(); renderWatchlist(); }; }   // keep the watchlist in step with the Skins page

// ------------------------------------------------------------------ streaks (My Stats page)
function renderStreaks() {
  if (!S || $('#tab-stats').hidden) return;
  let box = $('#st-streaks');
  if (!box) { box = h('div', { id: 'st-streaks', class: 'card', style: 'margin-bottom:16px' }); $('#st-notice').before(box); }
  const days = S.watchDays || {}; const key = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  let streak = 0; let t = Date.now(); if (!days[key(t)]) t -= 864e5;   // today not watched yet doesn't break a streak
  while (days[key(t)] > 0) { streak++; t -= 864e5; }
  let best = 0; let run = 0; const ks = Object.keys(days).sort();
  for (let i = 0; i < ks.length; i++) { const cont = i && (new Date(ks[i]) - new Date(ks[i - 1])) === 864e5; run = days[ks[i]] > 0 ? (cont ? run + 1 : 1) : 0; best = Math.max(best, run); }
  const watchedMin = Object.values(days).reduce((a, b) => a + b, 0);
  const rewards = [...S.campaigns.flatMap((c) => c.rewards), ...S.customDrops];
  const claimed = rewards.filter((r) => (S.progress[r.key] || {}).claimed).length;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const claimedMonth = (S.log || []).filter((e) => e.type === 'claim' && e.t >= monthStart.getTime()).length;
  const open = rewards.filter((r) => r.minutes && !(S.progress[r.key] || {}).claimed).map((r) => { const m = (S.progress[r.key] || {}).minutes || 0; return { r, m, left: r.minutes - m, pct: m / r.minutes }; }).sort((a, b) => b.pct - a.pct)[0];
  const tile = (n, label, c, sub) => h('div', { class: 'tile', style: `--c:${c}` }, h('b', {}, n), h('span', {}, label), sub ? h('div', { class: 'tsub' }, sub) : null);
  const bars = []; let max = 1; const vals = [];
  for (let i = 13; i >= 0; i--) { const v = days[key(Date.now() - i * 864e5)] || 0; vals.push(v); max = Math.max(max, v); }
  for (const v of vals) bars.push(h('i', { class: v ? '' : 'z', style: `height:${Math.max(6, (v / max) * 100)}%`, title: fmtMin(v) }));
  box.replaceChildren(h('h3', { style: 'margin-top:0' }, 'Drops streaks'),
    h('div', { class: 'tiles', style: 'margin-bottom:8px' }, tile(streak ? `${streak} day${streak === 1 ? '' : 's'}` : '0', 'Current watch streak', 'var(--warn)', best ? `Best ${best}` : 'Watch today to start one'), tile(fmtMin(watchedMin) || '0m', 'Watched with the app', 'var(--kick)', 'Since streak tracking began'),
      tile(String(claimed), 'Drops claimed', 'var(--good, #3ddc97)', `${claimedMonth} this month`),
      open ? tile(`${Math.round(open.pct * 100)}%`, 'Closest reward', 'var(--acc)', `${open.r.name} - ${fmtMin(open.left)} to go`) : tile('-', 'Closest reward', 'var(--acc)', 'Nothing in progress')),
    h('div', { class: 'muted' }, 'Minutes watched, last 14 days'), h('div', { class: 'daybars' }, ...bars));
}

// ------------------------------------------------------------------ settings: sound + overlay (saved immediately)
function bindExtraSettings() {
  const s = S.settings; const set = (id, fn) => { const el = $(id); if (el && document.activeElement !== el) fn(el); };
  set('#s-sound', (el) => (el.value = s.soundMode || 'airdrop')); set('#s-vol', (el) => (el.value = s.soundVolume == null ? 60 : s.soundVolume));
  set('#s-overlay', (el) => (el.checked = !!s.overlayOn)); set('#s-olock', (el) => (el.checked = !!s.overlayLock)); set('#s-oop', (el) => (el.value = s.overlayOpacity || 92)); set('#s-balert', (el) => (el.checked = !!s.buildAlerts));
}
const saveNow = (patch) => window.api.saveSettings(patch).then((st) => { S = st; });
$('#s-sound').addEventListener('change', (e) => { saveNow({ soundMode: e.target.value }); playSound({ mode: e.target.value, volume: +$('#s-vol').value }); });
$('#s-vol').addEventListener('change', (e) => saveNow({ soundVolume: +e.target.value }));
$('#s-sound-test').addEventListener('click', () => playSound({ mode: $('#s-sound').value, volume: +$('#s-vol').value, kind: 'drop' }));
$('#s-overlay').addEventListener('change', (e) => saveNow({ overlayOn: e.target.checked }));
$('#s-olock').addEventListener('change', (e) => saveNow({ overlayLock: e.target.checked }));
$('#s-oop').addEventListener('change', (e) => saveNow({ overlayOpacity: +e.target.value }));
$('#s-balert').addEventListener('change', (e) => saveNow({ buildAlerts: e.target.checked }));

// ------------------------------------------------------------------ updates (Settings)
function renderUpdateBanner() {
  const b = $('#up-banner'); if (!b) return; const u = S.update;
  b.replaceChildren(...(u ? [h('div', { class: 'note slim' }, h('b', {}, `Version ${u.version} is available`), ` (you have ${S.version}). `, h('a', { style: 'cursor:pointer', onclick: () => window.api.open(u.asset || u.url) }, u.asset ? 'Download the installer' : 'Open the release page'),
    u.notes ? h('div', { class: 'muted', style: 'white-space:pre-wrap;margin-top:6px' }, u.notes) : null)] : [h('div', { class: 'muted' }, `You have version ${S.version}.`)]));
  const r = $('#s-repo'); if (r && document.activeElement !== r && r.value !== (S.settings.updateRepo || '')) r.value = S.settings.updateRepo || '';
}
$('#s-repo').addEventListener('change', (e) => saveNow({ updateRepo: e.target.value.trim() }));
$('#up-check').addEventListener('click', async (e) => {
  const st = $('#up-status'); e.target.disabled = true; st.textContent = 'Checking...';
  await saveNow({ updateRepo: $('#s-repo').value.trim() });
  const r = await window.api.updateCheck(); e.target.disabled = false;
  st.textContent = r.error ? r.error : r.update ? '' : 'You are up to date.';
});

// ------------------------------------------------------------------ hooks called by app.js
let plTimer = null;
function extrasOnTab(name) {
  clearInterval(plTimer);
  if (name === 'builds') { if (!BD.info) loadBuilds(false); else renderBuilds(); }
  if (name === 'planner' && S) { renderPlanner(); plTimer = setInterval(renderPlanner, 30000); }
  if (name === 'stats') renderStreaks();
}
function extrasRender() {
  bindExtraSettings(); renderUpdateBanner();
  if (!$('#tab-planner').hidden) { const a = document.activeElement; if (!(a && a.closest && a.closest('#tab-planner') && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'))) renderPlanner(); }
  if (!$('#tab-stats').hidden) renderStreaks();
}
