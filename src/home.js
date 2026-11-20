'use strict';
// Home dashboard: an at-a-glance summary built from data the other tabs already load. Depends on helpers in app.js.

let homeFavs = null; let homeFriends = null; let homeFetchedAt = 0; let homeBuilds = null;
const SETUP_KEY = 'wipewatch-setup-dismissed';
const setupDismissed = () => { try { return localStorage.getItem(SETUP_KEY) === '1'; } catch (_) { return false; } };

function greeting() { const hr = new Date().getHours(); return hr < 5 ? 'Still up' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'; }
function untilText(ms) {
  const d = Math.floor(ms / 86400000); const hr = Math.floor((ms % 86400000) / 3600000); const mi = Math.floor((ms % 3600000) / 60000);
  return d > 0 ? `${d}d ${hr}h` : hr > 0 ? `${hr}h ${mi}m` : `${mi}m`;
}

// Live data that needs a network call (favourite servers, friends) is fetched at most every 45s and re-rendered when it lands.
async function homeLoadLive() {
  if (Date.now() - homeFetchedAt < 45000) return;
  homeFetchedAt = Date.now();
  try { homeFavs = await window.api.serverFavs(); } catch (_) { homeFavs = []; }
  try { const f = await window.api.friendsList(false); homeFriends = f && !f.error ? f : null; } catch (_) { homeFriends = null; }
  try { const b = await window.api.buildsGet(false); homeBuilds = (b.videos || []).slice(0, 3); } catch (_) { homeBuilds = []; }
  if (!$('#tab-home').hidden) renderHome(true);
}

function homeCard(title, ...kids) { return h('div', { class: 'card hm-card' }, h('div', { class: 'hm-title' }, title), ...kids); }

function renderHome(fromLive) {
  if (!S) return;
  const k = S.skins;
  $('#hm-greet').textContent = greeting();
  const nu = S.nextUpdate ? S.nextUpdate - Date.now() : 0;
  $('#hm-sub').textContent = nu > 0 ? `The next Rust update and wipe is in ${untilText(nu)}.` : 'Here is what is happening in Rust.';

  // ---- tiles
  const liveKick = S.campaigns.filter((c) => c.status === 'live').length;
  const tile = (n, label, c, sub) => h('div', { class: 'tile', style: `--c:${c}` }, h('b', {}, n), h('span', {}, label), sub ? h('div', { class: 'tsub ' + (sub.cls || '') }, sub.text) : null);
  $('#hm-tiles').replaceChildren(
    tile(k.priced ? money(k.total, k.currency) : '-', 'Skin inventory', 'var(--acc)', k.change ? { text: `${k.change > 0 ? '+' : ''}${money(k.change, k.currency)} in 24h`, cls: k.change > 0 ? 'up' : 'down' } : null),
    tile(String(liveKick + (S.twitch.streams.length ? 1 : 0)), 'Live drop campaigns', 'var(--kick)', S.twitch.streams.length ? { text: `${S.twitch.streams.length} Twitch streams with drops` } : null),
    tile(nu > 0 ? untilText(nu) : '-', 'Until next wipe', 'var(--bad)'),
    tile(homeFriends ? String(homeFriends.playing.length) : '-', 'Friends in Rust', 'var(--tw)', homeFriends ? { text: `${homeFriends.online} of ${homeFriends.total} online` } : { text: S.settings.steamApiKey ? 'Loading...' : 'Needs a Steam API key' }));

  // ---- live drops
  const live = S.campaigns.filter((c) => c.status === 'live');
  const liveBox = live.length
    ? live.slice(0, 3).map((c) => {
      const all = c.rewards.length; const done = c.rewards.filter((r) => (S.progress[r.key] || {}).claimed).length;
      return h('div', { class: 'hm-row', onclick: () => showTab('drops') },
        h('div', {}, h('b', {}, c.name), h('div', { class: 'muted' }, `${done} of ${all} rewards claimed - ends ${fmtDate(c.end)}`)),
        h('span', { class: 'badge live' }, 'live'));
    })
    : [h('div', { class: 'muted' }, 'No live Kick drops right now. You will get an alert the moment one starts.')];
  if (S.twitch.streams.length) liveBox.push(h('div', { class: 'hm-row', onclick: () => showTab('drops') }, h('div', {}, h('b', {}, 'Twitch drops'), h('div', { class: 'muted' }, `${S.twitch.streams.length} Rust streams have Drops Enabled`)), h('span', { class: 'badge live' }, 'live')));
  const patch = S.news.find((n) => n.official);
  const patchCard = patch ? homeCard('Latest Rust update',
    h('div', { class: 'hm-patch', onclick: () => { showTab('news'); openNews(patch.id); } },
      patch.image ? h('div', { class: 'hm-pimg', style: `background-image:url("${patch.image}")` }) : null,
      h('div', {}, h('b', {}, patch.title), h('div', { class: 'muted' }, new Date(patch.date).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })), h('div', { class: 'hm-ex' }, patch.excerpt)))) : null;
  // ---- wipe checklist, hot builds, watchlist
  let planCard = null;
  if (typeof getPlan === 'function') {
    const plan = getPlan(); const done = plan.items.filter((i) => i.done).length; const next = plan.items.find((i) => !i.done);
    planCard = homeCard('Wipe checklist', h('div', { class: 'hm-row', onclick: () => showTab('planner') }, h('div', {}, h('b', {}, `${done} of ${plan.items.length} steps done`), h('div', { class: 'muted' }, next ? 'Next: ' + next.text : 'All done for this wipe')), h('span', { class: 'badge' }, 'open')),
      h('div', { class: 'bar' }, h('i', { style: `width:${plan.items.length ? Math.round((done / plan.items.length) * 100) : 0}%` })));
  }
  const buildsCard = homeBuilds && homeBuilds.length ? homeCard('Hot build ideas',
    ...homeBuilds.map((v) => h('div', { class: 'hm-row', onclick: () => window.api.open(v.url) }, h('div', { class: 'hm-bth', style: `background-image:url("${v.thumb}")` }),
      h('div', { class: 'hm-bt' }, h('b', {}, v.title.replace(/\s*#\w+/g, '').trim() || v.title), h('div', { class: 'muted' }, `${v.channel} - ${(v.views >= 1000 ? Math.round(v.views / 100) / 10 + 'K' : v.views)} views`)))),
    h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn ghost sm', onclick: () => showTab('builds') }, 'More build ideas'))) : null;
  const wl = (S.watchlist || []).filter((w) => w.lowest != null).slice(0, 3);
  const wlCard = wl.length ? homeCard('Skin watchlist', ...wl.map((w) => h('div', { class: 'hm-row', onclick: () => showTab('skins') }, h('div', {}, h('b', {}, w.name)),
    h('span', {}, money(w.lowest, k.currency), w.pct != null && Math.abs(w.pct) >= 0.1 ? h('small', { class: w.pct > 0 ? 'up' : 'down', style: 'margin-left:6px' }, `${w.pct > 0 ? '+' : ''}${w.pct}%`) : null)))) : null;
  $('#hm-live').replaceChildren(homeCard('Live drops', ...liveBox), ...(patchCard ? [patchCard] : []), ...(planCard ? [planCard] : []), ...(buildsCard ? [buildsCard] : []), ...(wlCard ? [wlCard] : []));

  // ---- favourite servers
  const favBox = [];
  if (homeFavs && homeFavs.length) for (const f of homeFavs.slice(0, 5)) favBox.push(h('div', { class: 'hm-row', onclick: () => { showTab('servers'); setTimeout(() => openServer(f.id), 250); } },
    h('div', { class: 'hm-sname' }, h('b', { title: f.name }, f.name), h('div', { class: 'muted' }, f.players != null ? `${f.players}/${f.max} players${f.ping != null ? ' - ' + f.ping + 'ms' : ''}${f.live ? '' : ' (from list)'}` : 'No live data')),
    h('div', { class: 'row', style: 'gap:6px;flex:none' },
      f.born && Date.now() - f.born < 24 * 3600e3 ? h('span', { class: 'badge live', title: 'Wiped in the last 24 hours' }, 'just wiped') : null,
      f.queue > 0 ? h('span', { class: 'qpill' }, f.queue + ' queue') : h('span', { class: 'qpill none' }, 'no queue'),
      h('button', { class: 'btn sm', title: 'Launch Rust and join', onclick: (e) => { e.stopPropagation(); window.api.serverConnect(f.id); } }, 'Join'))));
  else favBox.push(h('div', { class: 'muted' }, homeFavs ? 'Star servers in the Servers tab and their live queue shows up here.' : 'Loading...'));
  const srvCard = homeCard('Your servers', ...favBox, h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn ghost sm', onclick: () => showTab('servers') }, 'Browse servers')));

  // ---- setup checklist
  const s = S.settings;
  const steps = [
    { ok: k.hasSteam, label: 'Link your Steam account', hint: 'Shows your skins and marks claimed drops', go: 'settings' },
    { ok: !!s.steamApiKey, label: 'Add a Steam Web API key', hint: 'Unlocks Servers, Friends and My Stats', go: 'servers' },
    { ok: !!(s.webhook || '').trim(), label: 'Connect Discord alerts (optional)', hint: 'Get drop and price alerts on your phone', go: 'settings' },
    { ok: S.twitch.linked, label: 'Link Twitch (optional)', hint: 'Live Twitch drops streams', go: 'settings' },
  ];
  const doneN = steps.filter((x) => x.ok).length;
  let setupCard = null;
  if (doneN < steps.length && !setupDismissed()) {
    setupCard = homeCard(`Set up Wipewatch (${doneN} of ${steps.length})`,
      h('div', { class: 'bar' }, h('i', { style: `width:${Math.round((doneN / steps.length) * 100)}%` })),
      ...steps.map((x) => h('div', { class: 'hm-step' + (x.ok ? ' ok' : ''), onclick: () => !x.ok && showTab(x.go) },
        h('span', { class: 'chk-dot' }, x.ok ? '✓' : ''), h('div', {}, h('b', {}, x.label), h('div', { class: 'muted' }, x.hint)))),
      h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn ghost sm', onclick: () => { try { localStorage.setItem(SETUP_KEY, '1'); } catch (_) { /* ignore */ } renderHome(); } }, 'Hide this')));
  }

  // ---- recent activity
  const recent = (S.log || []).slice(0, 5);
  const recentCard = homeCard('Recent activity', ...(recent.length ? recent.map((e) => h('div', { class: 'hm-row plain' }, h('span', { class: 'tag ' + e.type }, { claim: 'Claimed', ready: 'Ready', price: 'Price', patch: 'Update', server: 'Server', friend: 'Friend' }[e.type] || e.type),
    h('div', { class: 'hm-ev' }, e.text), h('span', { class: 'muted' }, new Date(e.t).toLocaleDateString([], { day: 'numeric', month: 'short' })))) : [h('div', { class: 'muted' }, 'Claims, price alerts and new updates will appear here.')]));

  const upCard = S.update ? homeCard('Update available', h('div', { class: 'hm-row', onclick: () => showTab('settings') }, h('div', {}, h('b', {}, `Wipewatch ${S.update.version}`), h('div', { class: 'muted' }, `You have ${S.version}`)), h('span', { class: 'badge live' }, 'new'))) : null;
  $('#hm-side').replaceChildren(...(upCard ? [upCard] : []), srvCard, ...(setupCard ? [setupCard] : []), recentCard);
  if (!fromLive) homeLoadLive();
}

document.addEventListener('click', (e) => { const b = e.target.closest('[data-jump]'); if (b) showTab(b.dataset.jump); });
