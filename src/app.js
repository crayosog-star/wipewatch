'use strict';
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));

let S = null;                  // latest state from the main process
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const fmtDate = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
function money(n, cur) {
  if (n == null) return '-';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n); } catch (_) { return n.toFixed(2) + ' ' + cur; }
}
function toggle(checked, onchange) {
  return h('span', { class: 'switch mini' }, h('input', { type: 'checkbox', ...(checked ? { checked: '' } : {}), onchange }), h('i'));
}

// ------------------------------------------------------------------ navigation
function showTab(name) {
  $$('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  for (const t of ['home', 'drops', 'watch', 'skins', 'servers', 'friends', 'clan', 'builds', 'planner', 'news', 'raid', 'calendar', 'stats', 'history', 'settings']) { const sec = $('#tab-' + t); if (sec) sec.hidden = t !== name; }
  if (typeof extrasOnTab === 'function') extrasOnTab(name);
  if (typeof socialOnTab === 'function') socialOnTab(name);
  if (name === 'raid' && typeof renderRaid === 'function') renderRaid();
  if (name === 'home' && S && typeof renderHome === 'function') renderHome();
  const content = $('.content'); if (content) content.scrollTop = 0;
  clearInterval(svTimer);
  if (name === 'servers' && S) {
    loadServersTab(false);
    svTimer = setInterval(() => {
      const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('.svalert');   // don't wipe a form the user is filling in
      if (svSel && !typing) window.api.serverDetail(svSel).then((d) => { if (!$('#tab-servers').hidden && d.base && d.base.id === svSel) renderServerDetail(d); });
      loadServersTab(false);
    }, 60000);
  }
  if (name === 'calendar' && S) renderCalendar();
  if (name === 'stats' && S) loadStats(false);
  if (!S) return;
  if (name === 'watch') renderTargets();
  if (name === 'news') { renderNews(); if (!openedNews) { const first = S.news.find((n) => n.official) || S.news[0]; if (first) openNews(first.id); } }
  if (name === 'history') renderHistory();
  if (name === 'skins') { renderSkins(); if (!S.skins.hasSteam && !skinsTried) { skinsTried = true; window.api.steamDetect().then((s) => { S = s; renderAll(); }); } }
}
let skinsTried = false;
$$('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ------------------------------------------------------------------ sidebar status
function renderStatus() {
  $('#pollinfo').textContent = S.lastPoll ? 'Checked ' + new Date(S.lastPoll).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Checking...';
  $('#dot-poll').className = 'sdot ' + (Object.keys(S.errors || {}).length ? 'warn' : S.lastPoll ? 'ok' : '');
  const k = S.skins;
  $('#st-steam').textContent = S.steam.error ? 'Steam: ' + (S.steam.error.length > 28 ? 'inventory not public' : S.steam.error) : k.hasSteam ? `Steam: ${k.count} items` : 'Steam: not linked';
  $('#dot-steam').className = 'sdot ' + (S.steam.error ? 'bad' : k.hasSteam ? 'ok' : '');
  const unread = (S.news || []).filter((n) => n.official && !n.read).length;
  const nb = $('#news-badge'); nb.hidden = !unread; nb.textContent = unread;
  $('#st-twitch').textContent = S.twitch.linked ? `Twitch: ${S.twitch.login || 'linked'}` : 'Twitch: not linked';
  $('#dot-twitch').className = 'sdot ' + (S.twitch.linked ? 'ok' : '');
}

// ------------------------------------------------------------------ drops

function rewardRow(r) {
  const p = S.progress[r.key] || { minutes: 0, claimed: null };
  const total = r.minutes || 0;
  const pct = p.claimed ? 100 : (total ? Math.min(100, Math.round((p.minutes / total) * 100)) : 0);
  const done = p.claimed || (total && p.minutes >= total);
  const meta = p.claimed ? h('span', { class: 'ok' }, p.claimed === 'steam' ? 'Claimed - found in your Steam inventory' : 'Claimed')
    : (total ? `${fmtMin(p.minutes)} of ${fmtMin(total)} watched (estimate)` : 'No watch time listed');
  return h('div', { class: 'reward' + (done ? ' done' : '') },
    r.image ? h('img', { src: r.image, alt: '' }) : h('div', { class: 'ph' }, r.name.slice(0, 1).toUpperCase()),
    h('div', {}, h('div', { class: 'rname' }, r.name), h('div', { class: 'rmeta' }, meta), h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` }))),
    h('div', { class: 'claimbox' },
      h('label', {}, 'Claimed', toggle(!!p.claimed, (e) => window.api.setClaimed(r.key, e.target.checked))),
      done && !p.claimed ? h('button', { class: 'btn sm', title: 'Open the claim page', onclick: () => window.api.open(r.claimUrl || (r.key.startsWith('kick:') ? 'https://kick.com/drops' : 'https://www.twitch.tv/drops/inventory')) }, 'Claim now') : null,
      !p.claimed && total ? h('div', { class: 'mini-actions' },
        h('button', { class: 'btn ghost sm', title: 'Add 10 minutes to fix the estimate', onclick: () => window.api.setProgress(r.key, Math.min(total, p.minutes + 10)) }, '+10m'),
        h('button', { class: 'btn ghost sm', title: 'Reset progress', onclick: () => window.api.setProgress(r.key, 0) }, 'Reset')) : null));
}

function campaignCard(c) {
  return h('div', { class: 'card camp' },
    h('div', { class: 'camp-head' },
      h('div', {}, h('h3', {}, c.name),
        h('div', { class: 'muted' }, c.status === 'upcoming' ? `Starts ${fmtDate(c.start)}` : c.status === 'live' ? `Ends ${fmtDate(c.end)}` : `Ended ${fmtDate(c.end)}`,
          c.channels.length ? ` - ${c.channels.slice(0, 4).join(', ')}` : ' - any Rust streamer')),
      h('span', { class: 'badge ' + c.status }, c.status)),
    h('div', { class: 'rewards' }, ...c.rewards.map((r) => rewardRow({ ...r, claimUrl: c.connectUrl }))),
    h('div', { class: 'camp-foot' },
      c.status === 'live' ? h('button', { class: 'btn sm', onclick: () => goWatch(c.channels[0] ? 'https://kick.com/' + c.channels[0] : 'https://kick.com/category/rust', c.rewards.map((r) => r.key)) }, 'Watch & track') : null,
      h('button', { class: 'btn ghost sm', onclick: () => window.api.open(c.connectUrl) }, 'Link account / claim')));
}

function renderDrops() {
  const b = $('#banners'); b.replaceChildren();
  for (const [k, v] of Object.entries(S.errors || {})) b.append(h('div', { class: 'banner err' }, `${k}: ${v}`));
  if (S.steam.error) b.append(h('div', { class: 'banner err' }, 'Steam: ' + S.steam.error));
  if (S.facepunchChanged) b.append(h('div', { class: 'banner' }, 'The Facepunch Twitch drops page changed - check it for new drops. ',
    h('button', { class: 'btn ghost sm', onclick: () => window.api.open(S.facepunchUrl) }, 'Open page')));

  // what is live right now: Kick campaigns + (if Twitch is linked) Twitch streams that have Drops Enabled
  const live = S.campaigns.filter((c) => c.status === 'live');
  const upcoming = S.campaigns.filter((c) => c.status === 'upcoming').sort((a, b) => a.start - b.start);
  const twLive = S.twitch.linked && S.twitch.streams.length > 0;
  const count = live.length + (twLive ? 1 : 0);
  const names = [...live.map((c) => 'Kick: ' + c.name), ...(twLive ? [`Twitch: ${S.twitch.streams.length} stream${S.twitch.streams.length === 1 ? '' : 's'} with Drops Enabled`] : [])];
  $('#drops-hero').replaceChildren(
    h('div', { class: 'hero-main' },
      h('div', { class: 'muted' }, count ? 'Live right now' : 'Right now'),
      h('div', { class: 'hero-num' }, count ? `${count} drop${count === 1 ? '' : 's'} live` : 'No drops live'),
      h('div', { class: 'muted' }, count ? names.join('  |  ') : upcoming.length ? `Next up: ${upcoming[0].name} (Kick) starts ${fmtDate(upcoming[0].start)}.` : 'You will get an alert the moment one starts.')));

  const box = $('#drops-live'); box.replaceChildren();
  live.forEach((c) => box.append(campaignCard(c)));
  if (twLive) {
    const chips = S.twitch.streams.slice(0, 12).map((s) => h('span', { class: 'chip', title: s.title, onclick: () => goWatch('https://www.twitch.tv/' + s.login, twitchKeys()) }, s.name, h('em', {}, s.viewers.toLocaleString())));
    box.append(h('div', { class: 'card camp' }, h('div', { class: 'camp-head' }, h('div', {}, h('h3', {}, 'Twitch drops'), h('div', { class: 'muted' }, 'Rust streams with Drops Enabled right now - click one to watch')), h('span', { class: 'badge live' }, 'live')),
      h('div', { class: 'chips', style: 'margin:10px 0 0' }, ...chips)));
  }

  // one small line when Twitch can't be checked yet (instead of a big setup panel)
  const tst = $('#twitch-status'); tst.replaceChildren(); tst.hidden = !!S.twitch.linked;
  if (!S.twitch.linked) tst.append(S.settings.twitchClientId
    ? 'Twitch is not linked yet, so Twitch drops are not being checked. '
    : 'Twitch is not set up yet. It needs a free Twitch Client ID to show live Rust drops streams. ',
  h('button', { class: 'btn sm', style: 'margin-left:6px', onclick: () => { showTab('settings'); $('#s-twitch-console').scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, 'Set up Twitch'));

  // Twitch rewards you track by hand (kept out of the way)
  const tl = $('#twitch-list'); tl.replaceChildren();
  const groups = {};
  for (const d of S.customDrops) (groups[d.campaign] = groups[d.campaign] || []).push(d);
  $('#tracked-summary').textContent = S.customDrops.length ? `Twitch drops you track (${S.customDrops.length})` : 'Track a Twitch drop';
  for (const g of Object.keys(groups)) {
    tl.append(h('div', { class: 'card camp' }, h('div', { class: 'camp-head' }, h('h3', {}, g)),
      h('div', { class: 'rewards' }, ...groups[g].map((d) => rewardRow({ key: d.key, name: d.name, minutes: d.minutes, image: '' }))),
      h('div', { class: 'camp-foot' }, ...groups[g].map((d) => h('button', { class: 'btn ghost sm', onclick: () => window.api.removeCustom(d.key) }, 'Remove ' + d.name)))));
  }
}
$('#refresh').addEventListener('click', async (e) => { e.target.disabled = true; e.target.textContent = 'Checking...'; S = await window.api.poll(); e.target.disabled = false; e.target.textContent = 'Check for drops now'; renderAll(); });
$('#cd-add').addEventListener('click', async () => {
  const ok = await window.api.addCustom({ name: $('#cd-name').value, minutes: $('#cd-min').value, campaign: $('#cd-camp').value });
  if (ok) { $('#cd-name').value = ''; $('#cd-min').value = ''; }
});
function twitchKeys() { return S.customDrops.map((d) => d.key).filter((k) => !(S.progress[k] || {}).claimed); }

// ------------------------------------------------------------------ watch
const player = $('#player');
let selected = new Set();
function platformOf(url) { return /kick\.com/i.test(url) ? 'kick' : /twitch\.tv/i.test(url) ? 'twitch' : ''; }
function channelOf(url) {
  try { const u = new URL(url); const seg = u.pathname.split('/').filter(Boolean)[0] || '';
    return ['category', 'directory', 'videos', 'drops', 'search'].includes(seg.toLowerCase()) ? '' : seg; } catch (_) { return ''; }
}
function goWatch(url, keys) {
  if (keys) selected = new Set(keys);
  showTab('watch'); $('#w-url').value = url; player.src = url; renderTargets();
}
function allActiveRewards() {
  const out = [];
  for (const c of S.campaigns) if (c.status === 'live') for (const r of c.rewards) out.push({ ...r, platform: 'kick', campaign: c.name });
  for (const d of S.customDrops) out.push({ key: d.key, name: d.name, minutes: d.minutes, platform: 'twitch', campaign: d.campaign });
  return out.filter((r) => !(S.progress[r.key] || {}).claimed);
}
function renderTargets() {
  if (!S) return;
  const box = $('#w-targets'); box.replaceChildren();
  const rs = allActiveRewards();
  if (!rs.length) box.append(h('span', { class: 'muted' }, 'No active unclaimed drops to count toward. Kick drops appear when a campaign is live; add Twitch drops on the Drops tab.'));
  rs.forEach((r) => box.append(h('label', {}, h('input', { type: 'checkbox', ...(selected.has(r.key) ? { checked: '' } : {}), onchange: (e) => { e.target.checked ? selected.add(r.key) : selected.delete(r.key); syncWatch(); } }), `${r.platform === 'kick' ? 'Kick' : 'Twitch'} - ${r.name}`)));
  // suggested streams: top Twitch Drops Enabled streams + channels named in live Kick campaigns
  const sg = $('#w-suggest'); sg.replaceChildren();
  const sugg = [];
  S.twitch.streams.slice(0, 5).forEach((s) => sugg.push({ label: `${s.name} (${s.viewers.toLocaleString()})`, url: 'https://www.twitch.tv/' + s.login, keys: twitchKeys(), tw: true }));
  S.campaigns.filter((c) => c.status === 'live').forEach((c) => c.channels.slice(0, 3).forEach((ch) => sugg.push({ label: ch, url: 'https://kick.com/' + ch, keys: c.rewards.map((r) => r.key), tw: false })));
  if (sugg.length) sg.append(h('span', { class: 'muted' }, 'Suggested streams:'), ...sugg.map((s) => h('span', { class: 'chip', onclick: () => goWatch(s.url, s.keys) }, s.label, h('em', {}, s.tw ? 'Twitch' : 'Kick'))));
  const w = S.watch;
  $('#w-toggle').textContent = w.active ? 'Stop counting' : 'Start counting';
  $('#w-status').textContent = w.active ? `Counting on ${w.platform} / ${w.channel || '?'} - ${w.sessionMinutes} min this session${w.note ? ' - ' + w.note : ''}` : 'Not counting. Time only counts while counting is ON and this window is visible.';
}
function syncWatch(force) {
  const url = $('#w-url').value;
  const active = force !== undefined ? force : S.watch.active;
  window.api.setWatch({ active, platform: platformOf(url), channel: channelOf(url), url, keys: [...selected] });
}
$('#w-go').addEventListener('click', () => {
  let u = $('#w-url').value.trim(); if (!u) return; if (!/^https?:\/\//.test(u)) u = 'https://' + u;
  if (!/^https:\/\/([a-z0-9-]+\.)*(kick\.com|twitch\.tv)(\/|$)/i.test(u)) return alert('Only kick.com and twitch.tv links can be opened here.');
  goWatch(u);
});
$('#w-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#w-go').click(); });
$$('[data-go]').forEach((b) => b.addEventListener('click', () => goWatch(b.dataset.go)));
$('#w-toggle').addEventListener('click', () => {
  if (!S.watch.active && !selected.size) selected = new Set(allActiveRewards().filter((r) => r.platform === platformOf($('#w-url').value) || !platformOf($('#w-url').value)).map((r) => r.key));
  syncWatch(!S.watch.active); setTimeout(renderTargets, 150);
});
player.addEventListener('did-navigate', (e) => { $('#w-url').value = e.url; if (S && S.watch.active) syncWatch(); });
player.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) { $('#w-url').value = e.url; if (S && S.watch.active) syncWatch(); } });

// ------------------------------------------------------------------ servers
let svSel = ''; let svTimer = null; let svSearchT = null; let svRegionsKey = '';
const fmtAgo = (ms) => { if (!ms) return '-'; const m = Math.max(0, Math.floor((Date.now() - ms) / 60000)); if (m < 60) return m + 'm ago'; const hr = Math.floor(m / 60); return hr < 48 ? hr + 'h ago' : Math.floor(hr / 24) + 'd ago'; };
function svQuery() {
  return { search: $('#sv-search').value, region: $('#sv-region').value, mods: $('#sv-mods').value, mode: $('#sv-mode').value, minPlayers: $('#sv-min').value,
    sort: $('#sv-sort').value, queueOnly: $('#sv-queue').checked, favOnly: $('#sv-fav').checked };
}
function svShowKeyPanel(msg) { $('#sv-nokey').hidden = false; $('#sv-main').hidden = true; $('#sv-keyerr').textContent = msg || ''; }

async function loadServersTab(force) {
  if (!S || !S.settings.steamApiKey) return svShowKeyPanel('');
  $('#sv-nokey').hidden = true; $('#sv-main').hidden = false;
  $('#sv-status').textContent = force ? 'Downloading the server list from Steam...' : 'Loading...';
  const res = await window.api.serversQuery({ ...svQuery(), force });
  if (res.error === 'nokey') return svShowKeyPanel('');
  if (res.error) { if (/key/i.test(res.error)) return svShowKeyPanel(res.error); $('#sv-status').textContent = res.error; return; }
  // regions dropdown (keep the current choice)
  const rk = res.regions.join('|');
  if (rk !== svRegionsKey) { const cur = $('#sv-region').value; svRegionsKey = rk; $('#sv-region').replaceChildren(h('option', { value: '' }, 'All regions'), ...res.regions.map((r) => h('option', { value: r }, r))); $('#sv-region').value = cur; }
  $('#sv-updated').textContent = 'Updated ' + new Date(res.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#sv-status').textContent = `${res.total.toLocaleString()} of ${res.all.toLocaleString()} servers match${res.total > res.rows.length ? ` - showing the top ${res.rows.length}` : ''}`;
  renderServerRows(res.rows);
  loadFriends(false);
  // favourites get live numbers straight from the game server
  if (res.rows.some((r) => r.fav)) {
    const live = await window.api.serverFavs();
    let changed = false;
    for (const l of live) { const row = res.rows.find((r) => r.id === l.id); if (row && l.live) { Object.assign(row, { players: l.players, max: l.max, queue: l.queue, ping: l.ping }); changed = true; } }
    if (changed) renderServerRows(res.rows);
  }
}

// friends who are in Rust right now (from Steam; needs a public friends list)
async function loadFriends(force) {
  const box = $('#sv-friends'); const f = await window.api.friendsList(force);
  if (!f || f.error === 'nokey') { box.hidden = true; return; }
  box.hidden = false;
  if (f.error) return box.replaceChildren(h('span', { class: 'fl' }, f.error));
  box.replaceChildren(h('span', { class: 'fl' }, f.playing.length ? `Friends playing Rust (${f.playing.length}) - ${f.online} of ${f.total} friends online` : `No friends are playing Rust right now - ${f.online} of ${f.total} friends online`),
    ...f.playing.map((p) => h('div', { class: 'friend' }, p.avatar ? h('img', { src: p.avatar, alt: '' }) : null,
      h('div', {}, h('div', { class: 'fn' }, p.name), h('div', { class: 'fs', title: p.serverName }, p.serverName ? `${p.serverName}${p.serverPlayers != null ? ` (${p.serverPlayers}/${p.serverMax})` : ''}` : (p.server || 'In menus / server hidden'))),
      p.server ? h('button', { class: 'btn sm', onclick: () => window.api.serverConnect(p.server) }, 'Join') : null)));
}

function serverAlertForm(d) {
  const b = d.base; const a = d.alert || {};
  const q = h('input', { type: 'number', min: '0', placeholder: 'e.g. 5', value: a.queueBelow ?? '' });
  const p = h('input', { type: 'number', min: '0', placeholder: 'e.g. 200', value: a.playersAbove ?? '' });
  const w = h('input', { type: 'checkbox', ...(a.onWipe ? { checked: '' } : {}) });
  const msg = h('span', { class: 'muted' });
  return h('div', { class: 'svalert' }, h('h3', {}, 'Alerts for this server'),
    h('label', {}, 'Queue is at or below', q, 'players'),
    h('label', {}, 'Population reaches', p, 'players'),
    h('label', {}, w, 'Tell me when it wipes'),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: async () => {
      const ok = await window.api.serverAlert(b.id, { queueBelow: q.value, playersAbove: p.value, onWipe: w.checked });
      msg.textContent = ok ? 'Saved. Checked every 2 minutes while the app runs.' : 'Could not save.'; if (ok) loadServersTab(false);
    } }, 'Save alerts'), msg),
    h('div', { class: 'muted' }, 'Setting an alert adds the server to your favourites. Leave all blank and save to remove it.'));
}

function renderServerRows(rows) {
  const box = $('#sv-rows'); const keep = box.scrollTop; box.replaceChildren();
  if (!rows.length) box.append(h('div', { class: 'empty', style: 'border:0' }, h('h3', {}, 'No servers match'), h('p', { class: 'muted' }, 'Try clearing a filter.')));
  for (const r of rows) {
    const pct = r.max ? Math.min(100, Math.round((r.players / r.max) * 100)) : 0;
    box.append(h('div', { class: 'sv-row' + (r.id === svSel ? ' sel' : ''), onclick: () => openServer(r.id) },
      h('button', { class: 'star' + (r.fav ? ' on' : ''), title: r.fav ? 'Remove from favourites' : 'Add to favourites', onclick: async (e) => { e.stopPropagation(); await window.api.serverFav(r); loadServersTab(false); } }, r.fav ? '★' : '☆'),
      h('div', { class: 'sv-name' }, h('b', { title: r.name }, r.name),
        h('div', { class: 'sv-meta' }, [r.region, r.born ? 'wiped ' + fmtAgo(r.born) : ''].filter(Boolean).join(' · '), ...r.tags.slice(0, 3).map((t) => h('span', { class: 'tg ' + t }, t)))),
      h('div', { class: 'sv-pl' }, `${r.players} / ${r.max}`, h('div', { class: 'pb' }, h('i', { style: `width:${pct}%` }))),
      h('div', {}, r.queue > 0 ? h('span', { class: 'qpill' }, r.queue + ' in queue') : h('span', { class: 'qpill none' }, 'none'))));
  }
  box.scrollTop = keep;
}

async function openServer(id) {
  svSel = id; $$('.sv-row').forEach((el) => el.classList.remove('sel'));
  const det = $('#sv-detail'); det.replaceChildren(h('div', { class: 'muted' }, 'Querying the server and looking up its map...'));
  const d = await window.api.serverDetail(id);
  if (svSel !== id) return;
  renderServerDetail(d);
  loadServersTab(false);   // re-highlight the selected row
}

function renderServerDetail(d) {
  const det = $('#sv-detail');
  if (d.error) return det.replaceChildren(h('div', { class: 'banner err' }, d.error));
  const b = d.base; const i = d.info;
  const players = i ? i.players : b.players; const max = i ? i.max : b.max; const queue = i ? i.queue : (b.queue || 0); const born = (i && i.born) || b.born;
  const tags = (i && i.tags) || b.tags || [];
  const children = [
    h('h2', {}, b.name || (i && i.name) || 'Server'),
    h('div', { class: 'muted' }, `${b.ip}:${b.gport}`, b.region ? ` - ${b.region}` : ''),
    h('div', { class: 'sv-tags', style: 'margin-top:8px' }, ...tags.map((t) => h('span', { class: 'tg ' + t }, t))),
    h('div', { class: 'sv-stats' },
      h('div', {}, h('b', {}, `${players}/${max}`), h('span', {}, 'Players')),
      h('div', {}, h('b', { class: queue > 0 ? '' : 'muted' }, queue > 0 ? String(queue) : '0'), h('span', {}, 'In queue')),
      h('div', {}, h('b', {}, i && i.ping != null ? i.ping + 'ms' : '-'), h('span', {}, 'Ping')),
      h('div', {}, h('b', {}, fmtAgo(born)), h('span', {}, 'Wiped'))),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => window.api.serverConnect(`${b.ip}:${b.gport}`) }, 'Join server'),
      h('button', { class: 'btn ghost', onclick: (e) => { navigator.clipboard.writeText(`client.connect ${b.ip}:${b.gport}`).then(() => { e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy connect command'), 1500); }).catch(() => {}); } }, 'Copy connect command')),
  ];
  children.push(serverAlertForm(d));
  if (d.infoError) children.push(h('div', { class: 'muted', style: 'margin-top:10px' }, 'Live query failed (' + d.infoError + '). Showing the numbers from Steam\'s list instead.'));
  if (d.rules && d.rules.description) children.push(h('div', { class: 'desc' }, d.rules.description));

  // map for the current wipe
  children.push(h('h3', { style: 'margin-top:18px' }, 'Map for this wipe'));
  const m = d.map;
  if (m && m.found) {
    const overlay = m.iconsUrl ? h('img', { src: m.iconsUrl, alt: '' }) : null;
    const mapbox = h('div', { class: 'mapbox', title: 'Open on RustMaps', onclick: () => window.api.open(m.pageUrl) }, h('img', { src: m.imageUrl, alt: 'Map' }), overlay);
    children.push(mapbox);
    const pinBtn = typeof attachPins === 'function' ? attachPins(mapbox, m, b) : null;
    children.push(h('div', { class: 'maptools' }, pinBtn,
      h('span', { class: 'muted' }, `Seed ${m.seed} - Size ${m.size}`),
      overlay ? h('label', { class: 'chk muted', style: 'display:inline-flex;gap:6px;align-items:center;cursor:pointer' }, h('input', { type: 'checkbox', checked: '', onchange: (e) => { overlay.style.display = e.target.checked ? '' : 'none'; } }), 'Monuments') : null,
      h('button', { class: 'btn ghost sm', onclick: () => window.api.open(m.pageUrl) }, 'Open on RustMaps')));
  } else if (m && m.pageUrl) {
    children.push(h('div', { class: 'note slim' }, `Seed ${m.seed}, size ${m.size}. RustMaps has no image for this seed yet.`),
      h('button', { class: 'btn ghost sm', onclick: () => window.api.open(m.pageUrl) }, 'Open on RustMaps'));
  } else if (d.rules && (d.rules.url || /custom|hapis|barren|savas/i.test(d.rules.level))) {
    children.push(h('div', { class: 'note slim' }, 'This server uses a custom map.'), d.rules.url ? h('button', { class: 'btn ghost sm', onclick: () => window.api.open(d.rules.url) }, 'Server website') : null);
  } else children.push(h('div', { class: 'note slim' }, d.rulesError ? 'Could not read the map from this server: ' + d.rulesError : 'This server does not publish its map seed.'));
  det.replaceChildren(...children.filter(Boolean));
}

for (const id of ['sv-region', 'sv-mods', 'sv-mode', 'sv-sort', 'sv-queue', 'sv-fav']) $('#' + id).addEventListener('change', () => loadServersTab(false));
$('#sv-min').addEventListener('input', () => { clearTimeout(svSearchT); svSearchT = setTimeout(() => loadServersTab(false), 350); });
$('#sv-search').addEventListener('input', () => { clearTimeout(svSearchT); svSearchT = setTimeout(() => loadServersTab(false), 300); });
$('#sv-refresh').addEventListener('click', async (e) => { e.target.disabled = true; await loadServersTab(true); e.target.disabled = false; });
$('#sv-getkey').addEventListener('click', () => window.api.open('https://steamcommunity.com/dev/apikey'));
$('#sv-savekey').addEventListener('click', async () => {
  const k = $('#sv-key').value.trim(); if (!k) return;
  S = await window.api.saveSettings({ steamApiKey: k }); $('#s-apikey').value = k; loadServersTab(true);
});

// ------------------------------------------------------------------ patch notes
let openedNews = ''; let countdownTimer = null;
const CLAN_IMG = 'https://clan.cloudflare.steamstatic.com/images/';
const safeUrl = (u) => { u = String(u || '').trim().replace('{STEAM_CLAN_IMAGE}/', CLAN_IMG).replace('{STEAM_CLAN_IMAGE}', CLAN_IMG); return /^https:\/\//i.test(u) ? u : ''; };

// Small, safe renderer for Steam's BBCode posts: builds DOM nodes only (never innerHTML).
function bbToDom(src) {
  const root = h('div', { class: 'bb' });
  const stack = [{ tag: 'root', el: root }];
  const top = () => stack[stack.length - 1];
  const re = /\[(\/?)([a-z0-9*]+)(?:=([^\]]*)|\s+([^\]]*))?\]/gi;
  let last = 0; let m;
  const text = (t) => { if (t) top().el.append(document.createTextNode(t)); };
  while ((m = re.exec(src))) {
    text(src.slice(last, m.index)); last = re.lastIndex;
    const close = !!m[1]; const tag = m[2].toLowerCase(); const arg = m[3]; const attrs = m[4] || '';
    if (!close) {
      let el = null;
      if (tag === 'img') {
        const sm = /src="([^"]+)"/i.exec(attrs);
        if (sm) { const u = safeUrl(sm[1]); if (u) top().el.append(h('img', { src: u, alt: '', loading: 'lazy' })); continue; }   // [img src="..."] (a trailing [/img] is ignored)
        const end = src.toLowerCase().indexOf('[/img]', last);   // [img]URL[/img]
        if (end > -1) { const u = safeUrl(src.slice(last, end)); if (u) top().el.append(h('img', { src: u, alt: '', loading: 'lazy' })); re.lastIndex = last = end + 6; }
        continue;
      }
      if (tag === 'hr') { top().el.append(h('hr')); continue; }
      if (tag === 'noparse' || tag === 'previewyoutube') { const end = src.toLowerCase().indexOf('[/' + tag + ']', last); if (end > -1) re.lastIndex = last = end + tag.length + 3; continue; }
      if (tag === '*') { if (top().tag === '*') stack.pop(); el = h('li'); }
      else if (['h1', 'h2', 'h3', 'p'].includes(tag)) el = h(tag);
      else if (tag === 'b') el = h('b'); else if (tag === 'i') el = h('i'); else if (tag === 'u') el = h('u'); else if (tag === 'strike') el = h('s');
      else if (tag === 'list') el = h('ul'); else if (tag === 'olist') el = h('ol');
      else if (tag === 'quote') el = h('blockquote'); else if (tag === 'code') el = h('pre');
      else if (['table', 'tr', 'td', 'th'].includes(tag)) el = h(tag);
      else if (tag === 'url') { el = h('a'); if (arg) el.dataset.href = arg; }
      else el = h('span');
      top().el.append(el); stack.push({ tag, el });
    } else {
      if (tag === '*') { if (top().tag === '*') stack.pop(); continue; }
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
    }
  }
  text(src.slice(last));
  $$('a', root).forEach((a) => { if (!a.dataset.href) a.dataset.href = a.textContent; });
  return root;
}

function renderCountdown() {
  const box = $('#next-update'); if (!S || !S.nextUpdate) return;
  const ms = S.nextUpdate - Date.now();
  const d = Math.max(0, Math.floor(ms / 86400000)); const hr = Math.max(0, Math.floor((ms % 86400000) / 3600000)); const mi = Math.max(0, Math.floor((ms % 3600000) / 60000));
  const unit = (n, l) => h('div', {}, h('b', {}, String(n)), h('span', {}, l));
  box.replaceChildren(
    h('div', {}, h('div', { class: 'cd-sub' }, 'Next monthly update and forced wipe (first Thursday)'),
      h('div', { class: 'big' }, new Date(S.nextUpdate).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })),
      h('div', { class: 'cd-sub' }, 'Usually 19:00 UTC. Patch notes appear below once it goes live.')),
    h('div', { class: 'cd-clock' }, unit(d, 'days'), unit(hr, 'hours'), unit(mi, 'min')));
}

function renderNews() {
  const mode = ($('input[name=nf]:checked') || {}).value || 'official';
  const list = $('#news-list'); const keepScroll = list.scrollTop; list.replaceChildren();
  const items = S.news.filter((n) => (mode === 'official') === n.official);
  setTimeout(() => { list.scrollTop = keepScroll; }, 0);
  if (!items.length) list.append(h('div', { class: 'card muted' }, S.errors && S.errors.news ? 'Could not load news: ' + S.errors.news : 'Nothing here yet.'));
  for (const n of items) {
    list.append(h('div', { class: 'ncard' + (n.id === openedNews ? ' sel' : ''), onclick: () => openNews(n.id) },
      h('div', { class: 'th', style: n.image ? `background-image:url("${n.image}")` : '' }),
      h('div', {}, h('div', { class: 't' }, n.title),
        h('div', { class: 'm' }, !n.read && n.official ? h('i', { class: 'udot' }) : null, new Date(n.date).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }), n.official ? null : ' - ' + n.feed),
        n.excerpt ? h('div', { class: 'ex' }, n.excerpt) : null)));
  }
  renderCountdown(); clearInterval(countdownTimer); countdownTimer = setInterval(renderCountdown, 30000);
}
async function openNews(id) {
  openedNews = id;
  const meta = S.news.find((n) => n.id === id);
  const reader = $('#news-reader');
  if (meta && !meta.official) {   // press items are only summaries: show the excerpt and link out
    reader.replaceChildren(h('div', { class: 'rh' }, h('div', {}, h('h2', {}, meta.title), h('div', { class: 'muted' }, `${meta.feed} - ${new Date(meta.date).toLocaleDateString()}`)),
      h('button', { class: 'btn', onclick: () => window.api.open(meta.url) }, 'Read article')), h('p', { class: 'bb' }, meta.excerpt));
    renderNews(); return;
  }
  reader.replaceChildren(h('div', { class: 'muted' }, 'Loading...'));
  const n = await window.api.newsGet(id);
  if (!n || openedNews !== id) return;
  reader.replaceChildren(
    h('div', { class: 'rh' }, h('div', {}, h('h2', {}, n.title), h('div', { class: 'muted' }, new Date(n.date).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))),
      h('button', { class: 'btn ghost', onclick: () => window.api.open(n.url) }, 'Open on Steam')),
    bbToDom(n.contents));
  reader.scrollTop = 0;
}
$('#news-reader').addEventListener('click', (e) => { const a = e.target.closest('a[data-href]'); if (a) { e.preventDefault(); const u = safeUrl(a.dataset.href); if (u) window.api.open(u); } });
$$('input[name=nf]').forEach((r) => r.addEventListener('change', () => S && renderNews()));
$('#news-readall').addEventListener('click', () => window.api.newsReadAll());

// ------------------------------------------------------------------ calendar
let calMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
let calSel = '';
const dkey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
function firstThursday(y, m) { const d = new Date(Date.UTC(y, m, 1, 19)); return new Date(Date.UTC(y, m, 1 + ((4 - d.getUTCDay() + 7) % 7), 19)); }   // Rust force wipe: first Thursday, ~19:00 UTC

function calEvents() {
  const map = {}; const add = (date, ev) => { (map[dkey(date)] = map[dkey(date)] || []).push({ ...ev, at: date.getTime() }); };
  for (let k = -1; k <= 1; k++) {
    const ft = firstThursday(calMonth.getFullYear(), calMonth.getMonth() + k);
    add(ft, { type: 'wipe', label: 'Force wipe', detail: `Monthly Rust update and wipe, about ${ft.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} your time` });
  }
  for (const n of S.news.filter((x) => x.official)) add(new Date(n.date), { type: 'update', label: n.title, detail: 'Official Rust update' });
  for (const c of S.campaigns) {
    add(new Date(c.start), { type: 'kick', label: `${c.name} starts`, detail: 'Kick drops campaign' });
    add(new Date(c.end), { type: 'kick', label: `${c.name} ends`, detail: 'Kick drops campaign' });
  }
  return map;
}
function renderCalendar() {
  if (!S) return;
  const ev = calEvents(); const y = calMonth.getFullYear(); const m = calMonth.getMonth();
  $('#cal-title').textContent = calMonth.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const grid = $('#cal-grid'); grid.replaceChildren();
  for (const d of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) grid.append(h('div', { class: 'cal-dow' }, d));
  const start = new Date(y, m, 1 - new Date(y, m, 1).getDay()); const today = dkey(new Date());
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i); const k = dkey(d); const list = (ev[k] || []).sort((a, b) => a.at - b.at);
    grid.append(h('div', { class: 'cal-cell' + (d.getMonth() !== m ? ' out' : '') + (k === today ? ' today' : '') + (k === calSel ? ' sel' : ''), onclick: () => { calSel = k; renderCalendar(); } },
      h('div', { class: 'n' }, String(d.getDate())),
      ...list.slice(0, 2).map((e) => h('div', { class: 'cal-chip ev-' + e.type, title: e.label }, e.label)),
      list.length > 2 ? h('div', { class: 'cal-more' }, `+${list.length - 2} more`) : null));
  }
  const box = $('#cal-day'); const sel = calSel || today; const list = (ev[sel] || []).sort((a, b) => a.at - b.at);
  const [sy, sm, sd] = sel.split('-').map(Number);
  box.replaceChildren(h('h3', {}, new Date(sy, sm - 1, sd).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })),
    ...(list.length ? list.map((e) => h('div', { class: 'ev-line ev-' + e.type }, h('i'), h('div', {}, h('b', {}, e.label), h('div', { class: 'muted' }, e.detail)))) : [h('div', { class: 'muted' }, 'Nothing scheduled this day.')]));
}
$('#cal-prev').addEventListener('click', () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); renderCalendar(); });
$('#cal-next').addEventListener('click', () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); renderCalendar(); });
$('#cal-today').addEventListener('click', () => { const d = new Date(); calMonth = new Date(d.getFullYear(), d.getMonth(), 1); calSel = dkey(d); renderCalendar(); });

// ------------------------------------------------------------------ my stats
let statsData = null;
const humanize = (n) => { const s = String(n).replace(/[_.]+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
async function loadStats(force) {
  if (!S) return;
  const notice = $('#st-notice'); notice.replaceChildren();
  if (!S.settings.steamApiKey) { $('#st-profile').replaceChildren(); $('#st-tiles').replaceChildren(); $('#st-grid').replaceChildren();
    notice.append(h('div', { class: 'banner' }, 'My Stats needs your free Steam Web API key (the same one the Servers tab uses). ', h('button', { class: 'btn ghost sm', onclick: () => showTab('settings') }, 'Open Settings'))); return; }
  if (!statsData || force) { notice.append(h('div', { class: 'muted' }, 'Loading from Steam...')); statsData = await window.api.statsGet(!!force); }
  renderStats();
}
function renderStats() {
  const d = statsData; const notice = $('#st-notice'); notice.replaceChildren();
  if (!d) return;
  if (d.error) { notice.append(h('div', { class: 'banner err' }, d.error === 'nokey' ? 'Add your Steam Web API key in Settings first.' : d.error)); return; }
  if (d.playNote) notice.append(h('div', { class: 'banner' }, d.playNote));
  if (d.statsNote) notice.append(h('div', { class: 'banner' }, d.statsNote));
  $('#st-profile').replaceChildren(...(d.profile.name ? [d.profile.avatar ? h('img', { src: d.profile.avatar, alt: '' }) : null, h('div', {}, h('b', {}, d.profile.name), d.lastPlayed ? h('div', { class: 'muted' }, 'Last played Rust ' + new Date(d.lastPlayed).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })) : null)].filter(Boolean) : []));
  const find = (...names) => { for (const n of names) { const s = d.stats.find((x) => x.name.toLowerCase() === n); if (s) return s.value; } return null; };
  const kills = find('kill_player', 'kills', 'player_kills'); const deaths = find('death_player', 'deaths', 'player_deaths'); const heads = find('headshot', 'headshots');
  const tile = (n, label, c) => h('div', { class: 'tile', style: `--c:${c}` }, h('b', {}, n), h('span', {}, label));
  const tiles = [];
  if (d.hours != null) tiles.push(tile(d.hours.toLocaleString(), 'Hours played', 'var(--acc)'), tile(String(d.hours2w), 'Hours, last 2 weeks', 'var(--warn)'));
  if (kills != null) tiles.push(tile(kills.toLocaleString(), 'Player kills', 'var(--ok)'));
  if (deaths != null) tiles.push(tile(deaths.toLocaleString(), 'Deaths', 'var(--bad)'));
  if (kills != null && deaths) tiles.push(tile((kills / deaths).toFixed(2), 'K/D ratio', 'var(--tw)'));
  if (heads != null) tiles.push(tile(heads.toLocaleString(), 'Headshots', 'var(--kick)'));
  $('#st-tiles').replaceChildren(...tiles);
  const q = $('#st-search').value.trim().toLowerCase();
  const list = d.stats.filter((s) => !q || s.name.toLowerCase().includes(q) || humanize(s.name).toLowerCase().includes(q)).sort((a, b) => b.value - a.value);
  $('#st-grid').replaceChildren(...list.map((s) => h('div', { class: 'stat', title: s.name }, h('span', {}, humanize(s.name)), h('b', {}, Number(s.value).toLocaleString()))));
}
$('#st-search').addEventListener('input', () => renderStats());
$('#st-refresh').addEventListener('click', () => loadStats(true));

// ------------------------------------------------------------------ export buttons
async function doExport(btn, kind) {
  const label = btn.textContent; const r = await window.api.exportCsv(kind);
  if (r && r.path) { btn.textContent = 'Saved'; setTimeout(() => (btn.textContent = label), 2000); }
  else if (r && r.error) alert('Export failed: ' + r.error);
}
$('#sk-export').addEventListener('click', (e) => doExport(e.target, 'skins'));
$('#log-export').addEventListener('click', (e) => doExport(e.target, 'history'));

// ------------------------------------------------------------------ history
function renderHistory() {
  const log = S.log || [];
  const count = (t) => log.filter((e) => e.type === t).length;
  const all = [...S.campaigns.flatMap((c) => c.rewards), ...S.customDrops];
  const mins = all.reduce((a, r) => a + ((S.progress[r.key] || {}).minutes || 0), 0);
  const tile = (n, label, c) => h('div', { class: 'tile', style: `--c:${c}` }, h('b', {}, n), h('span', {}, label));
  $('#hist-tiles').replaceChildren(tile(count('claim'), 'Drops claimed', 'var(--ok)'), tile(fmtMin(mins), 'Watch time tracked', 'var(--acc)'),
    tile(count('price'), 'Price alerts fired', 'var(--tw)'), tile(count('patch'), 'Updates seen', 'var(--warn)'));
  const box = $('#hist-list'); box.replaceChildren();
  if (!log.length) { box.append(h('div', { class: 'empty' }, h('h3', {}, 'Nothing yet'), h('p', { class: 'muted' }, 'Claimed drops, ready-to-claim moments, price alerts and new Rust updates will be listed here.'))); return; }
  let day = '';
  for (const e of log) {
    const d = new Date(e.t).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    if (d !== day) { day = d; box.append(h('div', { class: 'dayhead' }, d)); }
    const label = { claim: 'Claimed', ready: 'Ready', price: 'Price', patch: 'Update', server: 'Server', friend: 'Friend' }[e.type] || e.type;
    box.append(h('div', { class: 'ev' }, h('span', { class: 'tag ' + e.type }, label), h('span', { class: 'tx' }, e.text),
      h('span', { class: 'tm' }, new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))));
  }
}
$('#log-clear').addEventListener('click', () => window.api.logClear());

// ------------------------------------------------------------------ skins
const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...kids) { const el = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); kids.forEach((k) => el.append(k)); return el; }
function lineChart(points, w, hgt, color, fill) {
  const ys = points.map((p) => p); const min = Math.min(...ys); const max = Math.max(...ys); const span = max - min || 1;
  const xy = ys.map((y, i) => [(i / Math.max(1, ys.length - 1)) * w, hgt - 3 - ((y - min) / span) * (hgt - 6)]);
  const d = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const el = svg('svg', { viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none' });
  if (fill) el.append(svg('path', { d: d + ` L${w} ${hgt} L0 ${hgt} Z`, fill, opacity: '.18' }));
  el.append(svg('path', { d, fill: 'none', stroke: color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
  return el;
}
let alertOpen = ''; let alertDraft = { dir: 'below', price: '' };
function bellIcon() { return svg('svg', { viewBox: '0 0 24 24' }, svg('path', { d: 'M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0' })); }
function alertBox(i, k) {
  const draft = alertOpen === i.hash ? alertDraft : { dir: i.alert ? i.alert.dir : 'below', price: i.alert ? String(i.alert.price) : '' };
  const dir = h('select', { onchange: (e) => (alertDraft.dir = e.target.value) }, h('option', { value: 'below' }, 'Drops to or below'), h('option', { value: 'above' }, 'Rises to or above'));
  dir.value = draft.dir;
  const price = h('input', { type: 'number', step: '0.01', min: '0.01', placeholder: `Price in ${k.currency}`, value: draft.price, oninput: (e) => (alertDraft.price = e.target.value) });
  return h('div', { class: 'alertbox' }, h('div', { class: 'albl' }, 'Notify me when the lowest price...'), dir, price,
    h('div', { class: 'row' },
      h('button', { class: 'btn sm', onclick: async () => { const ok = await window.api.alertSet(i.hash, alertDraft.dir, alertDraft.price); if (ok) alertOpen = ''; } }, 'Save alert'),
      i.alert ? h('button', { class: 'btn ghost sm', onclick: async () => { await window.api.alertRemove(i.hash); alertOpen = ''; } }, 'Remove') : null,
      h('button', { class: 'btn ghost sm', onclick: () => { alertOpen = ''; renderSkins(); } }, 'Close')));
}
// "what I paid" per item, for profit/loss (inline editor; uses the alertbox class so a state refresh doesn't wipe it while typing)
let costOpen = '';
function costRow(i, k) {
  if (costOpen === i.hash) {
    const inp = h('input', { type: 'number', step: '0.01', min: '0', placeholder: `Paid each (${k.currency})`, value: i.paid != null ? String(i.paid) : '' });
    const save = async () => { await window.api.costSet(i.hash, inp.value.trim()); costOpen = ''; };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    return h('div', { class: 'alertbox' }, h('div', { class: 'albl' }, 'What did you pay for each one? (blank clears it)'), inp,
      h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: save }, 'Save'), h('button', { class: 'btn ghost sm', onclick: () => { costOpen = ''; renderSkins(); } }, 'Close')));
  }
  const pl = i.paid != null && i.lowest != null ? ((i.lowest / 1.15 - i.paid) / (i.paid || 1)) * 100 : null;
  return h('a', { style: 'cursor:pointer', onclick: () => { costOpen = i.hash; renderSkins(); } }, i.paid != null ? `Paid ${money(i.paid, k.currency)}` : 'Set what I paid',
    pl != null && i.paid > 0 ? h('small', { class: pl >= 0 ? 'up' : 'down', style: 'margin-left:6px;font-weight:600' }, `${pl >= 0 ? '+' : ''}${pl.toFixed(0)}%`) : null);
}
function renderSkins() {
  const k = S.skins;
  $('#sk-empty').hidden = k.hasSteam; $('#sk-main').hidden = !k.hasSteam;
  if (!k.hasSteam) {
    $('#sk-empty-msg').textContent = S.steamAccounts.length
      ? `Found ${S.steamAccounts.length} Steam account(s) on this PC. Pick one to load its Rust inventory.`
      : 'The app can find the Steam account signed in on this PC and load your Rust inventory.';
    return;
  }
  const marketable = k.items.filter((i) => i.marketable).length;
  $('#sk-count').textContent = k.count.toLocaleString();
  $('#sk-unique').textContent = k.items.length.toLocaleString();
  $('#sk-priced').textContent = `${k.priced}/${marketable}`;
  $('#sk-total').textContent = k.priced ? money(k.total, k.currency) : (k.pricing.running ? 'Pricing...' : '-');
  const sub = $('#sk-sub'); sub.replaceChildren();
  if (k.priced) {
    sub.append(`Lowest Steam Market listing across ${k.priced} priced item type(s)`);
    if (k.change != null && k.change !== 0) sub.append(' - ', h('span', { class: k.change > 0 ? 'up' : 'down' }, `${k.change > 0 ? '+' : ''}${money(k.change, k.currency)} in 24h`));
    if (k.alertsCount) sub.append(` - ${k.alertsCount} price alert(s) active`);
  }
  const mv = $('#sk-movers'); mv.replaceChildren();
  const moved = k.items.filter((i) => i.pct != null && Math.abs(i.pct) >= 0.1);
  if (moved.length) {
    const up = moved.reduce((a, b) => (b.pct > a.pct ? b : a)); const dn = moved.reduce((a, b) => (b.pct < a.pct ? b : a));
    if (up.pct > 0) mv.append('Top riser: ', h('b', {}, up.name), ' ', h('span', { class: 'up' }, `+${up.pct}%`));
    if (dn.pct < 0) mv.append(up.pct > 0 ? '  |  ' : '', 'Biggest drop: ', h('b', {}, dn.name), ' ', h('span', { class: 'down' }, `${dn.pct}%`));
  }
  $('#sk-net').textContent = k.priced ? `About ${money(k.totalNet, k.currency)} after Steam's ~13% market fee` : '';
  const plEl = $('#sk-pl'); plEl.replaceChildren();
  if (k.pl) plEl.append(`Cost basis ${money(k.pl.cost, k.currency)} on ${k.pl.items} item type(s): `, h('b', { class: k.pl.diff >= 0 ? 'up' : 'down' }, `${k.pl.diff >= 0 ? '+' : ''}${money(k.pl.diff, k.currency)}${k.pl.pct != null ? ` (${k.pl.pct > 0 ? '+' : ''}${k.pl.pct}%)` : ''}`), ' after fees');
  const ch = $('#sk-chart'); ch.replaceChildren();
  if (k.valueSeries.length >= 2) { const vals = k.valueSeries.map((p) => p[1]); ch.append(lineChart(vals, 300, 76, vals[vals.length - 1] >= vals[0] ? '#3ddc97' : '#ff5d6c', vals[vals.length - 1] >= vals[0] ? '#3ddc97' : '#ff5d6c')); }
  else ch.append(h('div', { class: 'empty-chart' }, 'Value history builds up as prices refresh'));
  let note = '';
  if (S.steam.error) note = S.steam.error;
  else if (k.pricing.running) note = `Fetching Steam Market prices ${k.pricing.done} of ${k.pricing.total}. Steam allows about 20 lookups a minute, so this takes a little while - prices appear as they arrive.`;
  else if (k.pricing.note) note = k.pricing.note;
  if (k.more) note += ' Only the first 2000 items are shown.';
  if (!k.items.length && !S.steam.error) note = 'No Rust items found in that inventory.';
  $('#sk-note').hidden = !note; $('#sk-note').textContent = note;

  const q = $('#sk-search').value.trim().toLowerCase(); const sort = $('#sk-sort').value;
  const items = k.items.filter((i) => !q || i.name.toLowerCase().includes(q));
  const val = (i) => (i.lowest != null ? i.lowest * i.count : -1);
  items.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'count' ? b.count - a.count || a.name.localeCompare(b.name)
    : sort === 'each' ? (b.lowest ?? -1) - (a.lowest ?? -1) : sort === 'change' ? (b.pct ?? -999) - (a.pct ?? -999) : val(b) - val(a) || a.name.localeCompare(b.name));
  const grid = $('#sk-grid'); grid.replaceChildren();
  for (const i of items) {
    grid.append(h('div', { class: 'sk', style: `--glow:${i.color || '#8b93a8'}` },
      h('div', { class: 'imgbox' }, i.icon ? h('img', { src: i.icon, alt: '', loading: 'lazy' }) : h('div', { class: 'ph' }, i.name.slice(0, 1)),
        i.count > 1 ? h('span', { class: 'qty' }, 'x' + i.count) : null,
        i.marketable ? h('button', { class: 'bell' + (i.alert ? ' on' : ''), title: i.alert ? 'Edit price alert' : 'Set a price alert',
          onclick: () => { alertOpen = alertOpen === i.hash ? '' : i.hash; alertDraft = { dir: i.alert ? i.alert.dir : 'below', price: i.alert ? String(i.alert.price) : '' }; renderSkins(); } }, bellIcon()) : null),
      h('div', { class: 'nm' }, i.name),
      i.marketable
        ? h('div', { class: 'prices' },
            h('div', { class: 'pr' }, h('span', { class: 'muted' }, 'Lowest'), i.lowest != null ? h('b', {}, money(i.lowest, k.currency), i.pct != null && Math.abs(i.pct) >= 0.1 ? h('small', { class: i.pct > 0 ? 'up' : 'down', style: 'margin-left:6px;font-weight:600' }, `${i.pct > 0 ? '+' : ''}${i.pct}%`) : null) : (k.pricing.running ? h('span', { class: 'skel' }) : h('span', { class: 'muted' }, 'no listings'))),
            h('div', { class: 'pr' }, h('span', { class: 'muted' }, 'Median'), h('span', {}, i.median != null ? money(i.median, k.currency) : '-')),
            i.count > 1 && i.lowest != null ? h('div', { class: 'pr' }, h('span', { class: 'muted' }, `Stack x${i.count}`), h('b', {}, money(i.lowest * i.count, k.currency))) : null,
            i.spark.length >= 2 ? h('div', { class: 'spark', title: 'Recent price history' }, lineChart(i.spark, 100, 22, i.spark[i.spark.length - 1] >= i.spark[0] ? '#3ddc97' : '#ff5d6c')) : null,
            i.alert && alertOpen !== i.hash ? h('div', { class: 'muted' }, `Alert: ${i.alert.dir === 'above' ? '>=' : '<='} ${money(i.alert.price, k.currency)}`) : null,
            alertOpen === i.hash ? alertBox(i, k) : null)
        : h('div', { class: 'nomkt' }, 'Not marketable'),
      i.marketable ? costRow(i, k) : null,
      i.marketable ? h('a', { onclick: () => window.api.open('https://steamcommunity.com/market/listings/252490/' + encodeURIComponent(i.hash)) }, 'View on Steam Market') : null));
  }
}
$('#sk-search').addEventListener('input', () => S && renderSkins());
$('#sk-sort').addEventListener('change', () => S && renderSkins());
$('#sk-refresh').addEventListener('click', async () => { S = await window.api.pricesRefresh(true); renderAll(); });
$('#sk-detect').addEventListener('click', async (e) => { e.target.disabled = true; e.target.textContent = 'Looking...'; S = await window.api.steamDetect(); e.target.disabled = false; e.target.textContent = 'Find my Steam account'; renderAll(); });

// ------------------------------------------------------------------ settings
let settingsLoaded = false;
function renderSettings() {
  const s = S.settings;
  if (!settingsLoaded) {
    const cs = $('#s-cur');
    for (const [id, code] of Object.entries(S.currencies)) cs.append(h('option', { value: id }, code));
    cs.value = String(s.currency || 1);
    $('#s-webhook').value = s.webhook || ''; $('#s-role').value = s.pingRole || ''; $('#s-toast').checked = !!s.toast; $('#s-patch').checked = s.notifyPatch !== false;
    $('#s-friends').checked = !!s.notifyFriends; $('#s-wipefav').checked = s.wipeAlertsFavs !== false; $('#s-quiet').checked = !!s.quietEnabled; $('#s-qstart').value = s.quietStart || '23:00'; $('#s-qend').value = s.quietEnd || '08:00';
    $('#s-apikey').value = s.steamApiKey || '';
    $('#s-poll').value = s.pollSeconds; $('#s-cid').value = s.twitchClientId || ''; $('#s-steam').value = s.steamInput || ''; $('#s-auto').checked = !!s.autoStart;
    settingsLoaded = true;
  }
  // detected Steam accounts (refreshed each render)
  const sel = $('#s-steam-acct'); const cur = S.steam.id64;
  sel.replaceChildren(h('option', { value: '' }, S.steamAccounts.length ? 'Choose an account...' : 'No Steam account found on this PC'),
    ...S.steamAccounts.map((a) => h('option', { value: a.id64 }, `${a.name}${a.id64 === S.steamActive ? ' (signed in)' : ''}`)));
  sel.value = S.steamAccounts.some((a) => a.id64 === cur) ? cur : '';
  $('#s-twitch').textContent = S.twitch.linked ? `Linked as ${S.twitch.login || '?'}` : 'Not linked';
  $('#s-steam-status').textContent = S.steam.error ? S.steam.error : S.steam.id64 ? `Loaded ${S.skins.count} Rust items (${S.steam.items} types) from Steam ID ${S.steam.id64}` : '';
  if (!S.twitch.linking) $('#s-code').hidden = true;
}
function readSettings() {
  return { webhook: $('#s-webhook').value.trim(), pingRole: $('#s-role').value.trim(), toast: $('#s-toast').checked, notifyPatch: $('#s-patch').checked, notifyFriends: $('#s-friends').checked, wipeAlertsFavs: $('#s-wipefav').checked, quietEnabled: $('#s-quiet').checked, quietStart: $('#s-qstart').value, quietEnd: $('#s-qend').value, pollSeconds: $('#s-poll').value,
    twitchClientId: $('#s-cid').value.trim(), steamApiKey: $('#s-apikey').value.trim(), currency: parseInt($('#s-cur').value, 10) || 1, steamInput: $('#s-steam').value.trim(), autoStart: $('#s-auto').checked };
}
$('#s-save').addEventListener('click', async () => { S = await window.api.saveSettings(readSettings()); $('#s-saved').textContent = 'Saved'; setTimeout(() => ($('#s-saved').textContent = ''), 2000); renderAll(); });
$('#s-test').addEventListener('click', async () => { await window.api.saveSettings(readSettings()); await window.api.testNotify(); });
window.api.appInfo().then((i) => { $('#ab-version').textContent = `Version ${i.version} - Electron ${i.electron}`; $('#ab-path').textContent = 'Data: ' + i.dataPath; });
$('#ab-open').addEventListener('click', () => window.api.openDataFolder());
$('#ab-export').addEventListener('click', async (e) => { const r = await window.api.backupExport(); if (r.path) { e.target.textContent = 'Saved'; setTimeout(() => (e.target.textContent = 'Back up settings'), 2000); } else if (r.error) alert('Backup failed: ' + r.error); });
$('#ab-import').addEventListener('click', async () => {
  if (!confirm('Restore a backup? This replaces your current settings, history and alerts with the ones in the file. Your Discord webhook, Steam key and Twitch login on this PC are kept.')) return;
  const r = await window.api.backupImport();
  if (r.error) alert(r.error); else if (r.ok) { settingsLoaded = false; alert('Backup restored.'); }
});
$('#s-twitch-console').addEventListener('click', () => window.api.open('https://dev.twitch.tv/console/apps/create'));
$('#s-link').addEventListener('click', async () => {
  await window.api.saveSettings(readSettings());
  const r = await window.api.twitchLogin(); const box = $('#s-code');
  box.hidden = false; box.textContent = r.error ? r.error : r.userCode;
  if (!r.error) box.append(h('div', { class: 'muted', style: 'letter-spacing:0;font-size:12.5px;font-weight:400;margin-top:6px' }, 'Enter this code on the Twitch page that just opened. This updates automatically.'));
});
$('#s-unlink').addEventListener('click', async () => { await window.api.twitchCancel(); await window.api.twitchLogout(); });
$('#s-steam-acct').addEventListener('change', async (e) => { if (!e.target.value) return; S = await window.api.steamDetect(e.target.value); $('#s-steam').value = e.target.value; renderAll(); });
$('#s-steam-detect').addEventListener('click', async () => { S = await window.api.steamDetect(); $('#s-steam').value = S.settings.steamInput || ''; renderAll(); });
$('#s-steam-check').addEventListener('click', async () => { await window.api.saveSettings(readSettings()); S = await window.api.steamRefresh(); renderAll(); });

// ------------------------------------------------------------------ boot
function renderAll() {
  if (!S) return;
  renderStatus(); renderDrops(); renderSettings();
  if (!$('#tab-home').hidden && typeof renderHome === 'function') renderHome();
  if (!$('#tab-watch').hidden) renderTargets();
  if (!$('#tab-skins').hidden) { const a = document.activeElement; if (!(a && a.closest && a.closest('.alertbox'))) renderSkins(); }   // don't rebuild while typing an alert
  if (!$('#tab-news').hidden) renderNews();
  if (!$('#tab-history').hidden) renderHistory();
  if (typeof extrasRender === 'function') extrasRender();
  if (typeof renderSocial === 'function') renderSocial();
}
window.api.onState((s) => { S = s; renderAll(); });
window.api.state().then((s) => { S = s; renderAll(); });
