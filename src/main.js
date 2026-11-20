'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, nativeImage, session, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const SMOKE = process.argv.includes('--smoke');
const { DEFAULT_CHANNELS: BUILD_CHANNELS, fetchBuilds, resolveChannel } = require('./builds');
// Feature flags come from package.json ("wipewatch": { "social": false } in the Solo edition, which also ships without the social files)
const FEATURES = (() => { try { return { social: (require(path.join(app.getAppPath(), 'package.json')).wipewatch || {}).social !== false }; } catch (_) { return { social: true }; } })();
const createSocial = FEATURES.social ? require('./social').createSocial : null;
app.setName('Wipewatch');
app.setAppUserModelId('Wipewatch');   // the name Windows shows on pop-up notifications
// The app was renamed from "Rust Drops Tracker": keep using the old data folder so nothing is lost.
app.setPath('userData', path.join(app.getPath('appData'), 'Rust Drops Tracker'));
const APP_ICON = path.join(__dirname, '..', 'assets', 'icon-256.png');
if (SMOKE) app.disableHardwareAcceleration();

const KICK_URL = 'https://web.kick.com/api/v1/drops/campaigns';
const KICK_IMG = 'https://ext.cdn.kick.com/';
const FACEPUNCH_URL = 'https://twitch.facepunch.com/';
const TWITCH_DROPS_TAG_URL = 'https://www.twitch.tv/directory/category/rust?tl=c2542d6d-cd10-4532-919b-3d19f30a768b';
const UA = 'RustDropsTracker/1.0';

// ------------------------------------------------------------------ storage
let DATA_PATH;
let data;
const DEFAULTS = () => ({
  settings: {
    webhook: '', toast: true, pollSeconds: 300, twitchClientId: '', steamInput: '', autoStart: true,
    pingRole: '', currency: 1, notifyPatch: true, steamApiKey: '',
    quietEnabled: false, quietStart: '23:00', quietEnd: '08:00',   // quiet hours mute Windows pop-ups only (Discord still posts)
    updateRepo: '',                                                // GitHub repo (owner/name) to check for new releases
    wipeAlertsFavs: true,                                          // wipe alert for every starred server
    notifyFriends: false,                                          // Windows pop-up when a Steam friend starts playing Rust
    soundMode: 'airdrop', soundVolume: 60,                         // alert sound: airdrop | chime | radar | off
    overlayOn: false, overlayLock: false, overlayOpacity: 92,      // small always-on-top mini window
    buildAlerts: false,                                            // pop-up when a popular new base-build video appears
  },
  builds: { channels: BUILD_CHANNELS.map((c) => ({ ...c })), seen: [] },   // Build Ideas sources + videos already announced
  watchlist: [],           // skins to track that you don't own: [{ hash, name, icon, color }]
  social: { server: '', id: '', name: '', token: '', visibility: 'open', share: { value: true, activity: true, servers: true, hours: true, playing: true } },   // Friends + Clan account (token is a secret)
  recentServers: [],       // servers you were seen playing on: [{ id, name, t }]
  costs: {},               // market_hash_name -> price you paid per item (for profit/loss)
  kv: {},                  // small user data kept in backups: planner checklist/notes, base pins
  watchDays: {},           // 'YYYY-MM-DD' -> minutes watched (for streaks)
  serverAlerts: {},        // server id -> { queueBelow, playersAbove, onWipe, qArmed, pArmed, lastBorn }
  favorites: [],           // favourite servers: [{ id, ip, qport, gport, name }]
  history: {},             // market_hash_name -> [[time, lowestPrice], ...]
  valueHistory: [],        // [[time, totalValue, currencyId], ...]
  alerts: {},              // market_hash_name -> { dir: 'above'|'below', price, armed }
  log: [],                 // activity: [{ t, type, text }]
  twitch: { token: '', refresh: '', expires: 0, login: '', userId: '' },
  steam: { id64: '', lastCheck: 0, items: [], inventory: [], error: '' },
  prices: {},              // market_hash_name -> { lowest, median, volume, lowestText, currency, at }
  progress: {},            // key -> { minutes, claimed: null|'steam'|'manual', claimedAt }
  customDrops: [],         // user-entered Twitch drops
  seen: { kick: {}, facepunchHash: '', twitchLive: false, ready: {}, news: null, newsRead: {} },
  watchLog: [],            // [{t, key, minutes}] recent
});

function loadData() {
  DATA_PATH = path.join(app.getPath('userData'), 'data.json');
  let d = DEFAULTS();
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    d = { ...d, ...raw, settings: { ...d.settings, ...(raw.settings || {}) },
      twitch: { ...d.twitch, ...(raw.twitch || {}) }, steam: { ...d.steam, ...(raw.steam || {}) },
      seen: { ...d.seen, ...(raw.seen || {}) }, social: { ...d.social, ...(raw.social || {}), share: { ...d.social.share, ...((raw.social || {}).share || {}) } } };
  } catch (e) { /* first run: start from the defaults */ }
  data = d;
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
      fs.writeFileSync(DATA_PATH + '.tmp', JSON.stringify(data, null, 2));
      fs.renameSync(DATA_PATH + '.tmp', DATA_PATH);
    } catch (e) { console.error('save failed', e.message); }
  }, 300);
}
function saveNow() { clearTimeout(saveTimer); try { fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2)); } catch (_) {} }

// ------------------------------------------------------------------ runtime state
const rt = {
  campaigns: [],          // normalized Kick campaigns
  twitchStreams: [],      // streams with Drops Enabled
  twitchStatus: 'Twitch not linked',
  facepunchChanged: false,
  lastPoll: 0,
  errors: {},
  watch: { active: false, platform: '', channel: '', url: '', keys: [], sessionMinutes: 0, lastMinuteAt: 0, note: '' },
};
let win = null; let tray = null; let quitting = false;

function log(...a) { console.log(new Date().toISOString(), ...a); }

// activity log shown on the History tab
function logEvent(type, text, extra = {}) {
  data.log.unshift({ t: Date.now(), type, text, ...extra });
  if (data.log.length > 500) data.log.length = 500;
  save();
}

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch (_) { body = text; }
  if (!r.ok) { const e = new Error(`HTTP ${r.status} ${url}`); e.status = r.status; e.body = body; throw e; }
  return body;
}

// ------------------------------------------------------------------ notifications
// True when the clock is inside the user's quiet hours (handles overnight ranges like 23:00 -> 08:00).
function inQuietHours(now = new Date()) {
  const s = data.settings; if (!s.quietEnabled) return false;
  const mins = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  const a = mins(s.quietStart); const b = mins(s.quietEnd); if (a == null || b == null || a === b) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return a < b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}

// opts.discord === false keeps an alert on this PC only (used for friends' names)
async function notify(title, body, { url, toastUrl, image, color = 0x5865f2, discord = true } = {}) {
  log('NOTIFY', title, '|', body.replace(/\n/g, ' / '));
  if (data.settings.soundMode && data.settings.soundMode !== 'off' && !inQuietHours() && win && !win.isDestroyed()) {
    win.webContents.send('sound', { mode: data.settings.soundMode, volume: data.settings.soundVolume, kind: /drop|claim|ready|ending/i.test(title) ? 'drop' : 'info' });
  }
  if (data.settings.toast && !inQuietHours() && Notification.isSupported()) {
    try {
      const n = new Notification({ title, body: body.slice(0, 250) });
      const click = toastUrl && /^steam:\/\/connect\/\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(toastUrl) ? toastUrl : url;   // clicking a server alert joins it
      if (click) n.on('click', () => shell.openExternal(click));
      n.show();
    } catch (_) { /* ignore */ }
  }
  const hook = discord ? (data.settings.webhook || '').trim() : '';
  if (hook.startsWith('https://discord.com/api/webhooks/') || hook.startsWith('https://discordapp.com/api/webhooks/')) {
    const content = data.settings.pingRole ? `<@&${data.settings.pingRole.replace(/\D/g, '')}>` : undefined;
    const embed = { title: title.slice(0, 256), description: body.slice(0, 4000), color, timestamp: new Date().toISOString() };
    if (url) embed.url = url;
    if (image) embed.thumbnail = { url: image };
    const payload = { username: 'Wipewatch', content, embeds: [embed],
      allowed_mentions: content ? { roles: [data.settings.pingRole.replace(/\D/g, '')] } : { parse: [] } };
    for (let i = 0; i < 2; i++) {
      try {
        const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (r.status === 429) { const j = await r.json().catch(() => ({})); await sleep(((j.retry_after) || 2) * 1000); continue; }
        if (!r.ok) log('discord webhook failed', r.status);
        break;
      } catch (e) { log('discord error', e.message); break; }
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ kick
function normalizeKick(c) {
  const now = Date.now();
  const start = Date.parse(c.starts_at); const end = Date.parse(c.ends_at);
  const status = end <= now ? 'ended' : (start > now ? 'upcoming' : 'live');
  return {
    platform: 'kick', id: c.id, name: c.name, status, start, end,
    connectUrl: c.connect_url || 'https://kick.com/drops',
    org: (c.organization && c.organization.name) || '',
    channels: (c.channels || []).map((ch) => ch.slug || ch.username).filter(Boolean),
    rewards: (c.rewards || []).map((r) => ({
      key: `kick:${c.id}:${r.id}`, name: r.name, minutes: r.required_units || 0,
      image: r.image_url ? KICK_IMG + r.image_url.replace(/^\//, '') : '',
    })),
  };
}

async function pollKick() {
  const body = await getJSON(KICK_URL);
  const list = (body.data || []).filter((c) => c.category && c.category.slug === 'rust').map(normalizeKick);
  list.sort((a, b) => ({ live: 0, upcoming: 1, ended: 2 }[a.status] - { live: 0, upcoming: 1, ended: 2 }[b.status]) || (b.start - a.start));
  rt.campaigns = list;
  const seen = data.seen.kick;
  for (const c of list) {
    if (c.status === 'ended') continue;
    const prev = seen[c.id];
    if (prev === c.status || (prev === 'live' && c.status === 'upcoming')) continue;
    seen[c.id] = c.status;
    const lines = c.rewards.slice(0, 8).map((r) => `• ${r.name}${r.minutes ? ` (${r.minutes} min)` : ''}`);
    if (c.channels.length) lines.push('Channels: ' + c.channels.slice(0, 6).join(', '));
    lines.push(c.status === 'live' ? `Ends: ${new Date(c.end).toLocaleString()}` : `Starts: ${new Date(c.start).toLocaleString()}`);
    await notify(`Kick Rust drop ${c.status === 'live' ? 'LIVE' : 'upcoming'}: ${c.name}`, lines.join('\n'),
      { url: c.connectUrl, image: c.rewards[0] && c.rewards[0].image, color: c.status === 'live' ? 0x53fc18 : 0xfaa61a });
  }
  const ids = new Set(list.map((c) => c.id));
  for (const id of Object.keys(seen)) if (!ids.has(id)) delete seen[id];

  // heads-up in the last 3 hours of a live campaign if some of its rewards are still unclaimed
  data.seen.ending = data.seen.ending || {};
  for (const c of list) {
    if (c.status !== 'live') continue;
    const left = c.end - Date.now();
    if (left <= 0 || left > 3 * 3600e3 || data.seen.ending[c.id]) continue;
    const open = c.rewards.filter((r) => !(data.progress[r.key] || {}).claimed);
    if (!open.length) continue;
    data.seen.ending[c.id] = 1;
    logEvent('ready', `${c.name} ends in about ${Math.ceil(left / 60000)} minutes - ${open.length} reward(s) not claimed`, { platform: 'kick' });
    await notify(`Ending soon: ${c.name}`, `${open.length} reward(s) you have not claimed yet:\n${open.slice(0, 6).map((r) => '• ' + r.name).join('\n')}\nEnds in about ${Math.ceil(left / 60000)} minutes.`, { url: c.connectUrl, color: 0xffb020 });
  }
}

// ------------------------------------------------------------------ twitch
async function twitchRefresh() {
  const t = data.twitch;
  if (!t.token) return false;
  if (t.expires > Date.now() + 120000) return true;
  if (!t.refresh || !data.settings.twitchClientId) { t.token = ''; return false; }
  try {
    const body = new URLSearchParams({ client_id: data.settings.twitchClientId, grant_type: 'refresh_token', refresh_token: t.refresh });
    const r = await getJSON('https://id.twitch.tv/oauth2/token', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    t.token = r.access_token; t.refresh = r.refresh_token || t.refresh; t.expires = Date.now() + (r.expires_in || 3600) * 1000;
    save(); return true;
  } catch (e) { log('twitch refresh failed', e.message); t.token = ''; t.login = ''; save(); return false; }
}
function helixHeaders() { return { 'Client-Id': data.settings.twitchClientId, Authorization: `Bearer ${data.twitch.token}` }; }

let deviceFlow = null;
async function twitchLoginStart() {
  const clientId = (data.settings.twitchClientId || '').trim();
  if (!clientId) throw new Error('Enter your Twitch Client ID in Settings first.');
  const mk = (scopes) => new URLSearchParams({ client_id: clientId, scopes });
  let r;
  try { r = await getJSON('https://id.twitch.tv/oauth2/device', { method: 'POST', body: mk(''), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); }
  catch (e) { r = await getJSON('https://id.twitch.tv/oauth2/device', { method: 'POST', body: mk('user:read:follows'), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); }
  const flow = { device: r.device_code, interval: (r.interval || 5) * 1000, expires: Date.now() + (r.expires_in || 600) * 1000, scopes: '', cancelled: false };
  deviceFlow = flow;
  (async () => {
    while (!flow.cancelled && Date.now() < flow.expires) {
      await sleep(flow.interval);
      try {
        const body = new URLSearchParams({ client_id: clientId, scopes: flow.scopes, device_code: flow.device, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
        const t = await getJSON('https://id.twitch.tv/oauth2/token', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        data.twitch = { token: t.access_token, refresh: t.refresh_token || '', expires: Date.now() + (t.expires_in || 3600) * 1000, login: '', userId: '' };
        const u = await getJSON('https://api.twitch.tv/helix/users', { headers: helixHeaders() });
        if (u.data && u.data[0]) { data.twitch.login = u.data[0].display_name; data.twitch.userId = u.data[0].id; }
        save(); deviceFlow = null; push(); pollAll(); return;
      } catch (e) {
        const msg = e.body && (e.body.message || e.body.error_description || '');
        if (e.status === 400 && /pending/i.test(msg)) continue;
        if (e.status === 400 && /slow/i.test(msg)) { flow.interval += 5000; continue; }
        log('device flow ended', e.message, msg); break;
      }
    }
    deviceFlow = null; push();
  })();
  return { userCode: r.user_code, url: r.verification_uri };
}

async function pollTwitch() {
  if (!(await twitchRefresh()) || !data.settings.twitchClientId) {
    rt.twitchStatus = data.settings.twitchClientId ? 'Twitch not linked - click Link Twitch in Settings' : 'Add a Twitch Client ID in Settings to detect live drops';
    rt.twitchStreams = []; return;
  }
  const h = helixHeaders();
  const g = await getJSON('https://api.twitch.tv/helix/games?name=Rust', { headers: h });
  if (!g.data || !g.data[0]) { rt.twitchStatus = 'Could not find Rust on Twitch'; return; }
  const gameId = g.data[0].id;
  const streams = []; let cursor = '';
  for (let i = 0; i < 5; i++) {
    const p = await getJSON(`https://api.twitch.tv/helix/streams?game_id=${gameId}&first=100${cursor ? '&after=' + cursor : ''}`, { headers: h });
    for (const s of p.data || []) {
      if ((s.tags || []).some((t) => t.toLowerCase().replace(/\s/g, '') === 'dropsenabled')) streams.push(s);
    }
    cursor = p.pagination && p.pagination.cursor; if (!cursor) break;
  }
  streams.sort((a, b) => b.viewer_count - a.viewer_count);
  rt.twitchStreams = streams.map((s) => ({ login: s.user_login, name: s.user_name, viewers: s.viewer_count, title: s.title }));
  rt.twitchStatus = `Linked as ${data.twitch.login || '?'} - ${streams.length} Rust stream(s) with Drops Enabled`;
  const live = streams.length > 0;
  if (live && !data.seen.twitchLive) {
    await notify('Twitch Rust drops are LIVE', `${streams.length} Rust streams have Drops Enabled:\n` +
      streams.slice(0, 6).map((s) => `• ${s.user_name} (${s.viewer_count.toLocaleString()} viewers)`).join('\n'),
      { url: TWITCH_DROPS_TAG_URL, color: 0x9146ff });
  }
  data.seen.twitchLive = live;
}

async function pollFacepunch() {
  const r = await fetch(FACEPUNCH_URL, { headers: { 'User-Agent': UA } });
  let html = await r.text();
  html = html.split('class="section is-large faq"')[0].replace(/\?v=[A-Za-z0-9_\-+/=]+/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/\s+/g, ' ');
  const hash = require('crypto').createHash('sha256').update(html).digest('hex');
  if (data.seen.facepunchHash && data.seen.facepunchHash !== hash) {
    rt.facepunchChanged = true;
    await notify('Twitch Rust drops page updated', 'The Facepunch drops page changed - a new Twitch campaign may be starting. Add the drops to the app from the Drops tab.', { url: FACEPUNCH_URL, color: 0x9146ff });
  }
  data.seen.facepunchHash = hash;
}

// ------------------------------------------------------------------ patch notes / news (official Steam News API)
const NEWS_URL = 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=252490&count=40&maxlength=0&format=json';
const CLAN_IMG = 'https://clan.cloudflare.steamstatic.com/images/';
let newsItems = [];   // full items incl. contents; kept in memory only (they are large)

function bbToText(s) {
  return String(s || '').replace(/\[img\][\s\S]*?\[\/img\]/gi, '').replace(/\[\/?[a-z0-9*]+(?:=[^\]]*|\s[^\]]*)?\]/gi, ' ').replace(/\s+/g, ' ').trim();
}
function newsImage(s) {
  // Steam uses both [img]URL[/img] and [img src="URL" ...]
  const m = /\[img\s+[^\]]*?src="([^"]+)"/i.exec(s || '') || /\[img\]([^\[]+)\[\/img\]/i.exec(s || ''); if (!m) return '';
  const u = m[1].trim().replace('{STEAM_CLAN_IMAGE}/', CLAN_IMG).replace('{STEAM_CLAN_IMAGE}', CLAN_IMG);
  return /^https:\/\//.test(u) ? u : '';
}
// Rust's monthly update + forced wipe lands on the first Thursday of the month (~19:00 UTC).
function nextMonthlyUpdate() {
  const now = Date.now(); const d0 = new Date();
  for (let m = 0; m < 3; m++) {
    const y = d0.getUTCFullYear(); const mo = d0.getUTCMonth() + m;
    const first = new Date(Date.UTC(y, mo, 1, 19, 0, 0));
    const t = Date.UTC(y, mo, 1 + ((4 - first.getUTCDay() + 7) % 7), 19, 0, 0);
    if (t > now) return t;
  }
  return 0;
}
async function pollNews() {
  const j = await getJSON(NEWS_URL);
  const items = (j.appnews && j.appnews.newsitems) || [];
  newsItems = items.map((n) => ({
    id: String(n.gid), title: n.title, url: n.url, author: n.author || '', date: (n.date || 0) * 1000, feed: n.feedlabel || n.feedname,
    official: n.feedname === 'steam_community_announcements', contents: n.contents || '',
  }));
  if (!data.seen.news) {   // first run: baseline. Everything counts as seen and read, except the newest official update
    const latest = newsItems.find((n) => n.official);
    data.seen.news = Object.fromEntries(newsItems.map((n) => [n.id, 1]));
    for (const n of newsItems) if (n !== latest) data.seen.newsRead[n.id] = 1;
    return;
  }
  for (const n of newsItems) {
    if (data.seen.news[n.id]) continue;
    data.seen.news[n.id] = 1;
    if (n.official) {
      logEvent('patch', `New Rust update: ${n.title}`);
      if (data.settings.notifyPatch) await notify(`Rust update: ${n.title}`, bbToText(n.contents).slice(0, 380) + '...', { url: n.url, image: newsImage(n.contents), color: 0xff7a2f });
    }
  }
}
function newsList() {
  return newsItems.map((n) => ({ id: n.id, title: n.title, url: n.url, author: n.author, date: n.date, feed: n.feed, official: n.official,
    excerpt: bbToText(n.contents).slice(0, 260), image: newsImage(n.contents), read: !!data.seen.newsRead[n.id] }));
}

// ------------------------------------------------------------------ servers (list, live queries, map)
const servers = require('./servers');
const serverCache = { at: 0, list: [], error: '' };
const detailCache = new Map();   // id -> { at, value }

async function loadServers(force) {
  const key = (data.settings.steamApiKey || '').trim();
  if (!key) throw new Error('NO_KEY');
  if (!force && serverCache.list.length && Date.now() - serverCache.at < 150000) return;   // the full list is a few MB: reuse for 2.5 min
  serverCache.list = await servers.fetchServerList(key);
  serverCache.at = Date.now();
}
const isFav = (id) => data.favorites.some((f) => f.id === id);
const WIPE_AGE_UNKNOWN = Infinity;

function queryServers(q) {
  let rows = serverCache.list;
  const s = String(q.search || '').trim().toLowerCase();
  if (s) rows = rows.filter((r) => r.name.toLowerCase().includes(s));
  if (q.region) rows = rows.filter((r) => r.region === q.region);
  if (q.mods === 'vanilla') rows = rows.filter((r) => r.tags.includes('vanilla') || !r.tags.some((t) => ['modded', 'oxide', 'carbon'].includes(t)));
  if (q.mods === 'modded') rows = rows.filter((r) => r.tags.some((t) => ['modded', 'oxide', 'carbon'].includes(t)));
  if (q.mode === 'pve') rows = rows.filter((r) => r.tags.includes('pve'));
  if (q.mode === 'pvp') rows = rows.filter((r) => !r.tags.includes('pve'));
  const minP = parseInt(q.minPlayers, 10); if (minP > 0) rows = rows.filter((r) => r.players >= minP);
  if (q.queueOnly) rows = rows.filter((r) => r.queue > 0);
  if (q.favOnly) rows = rows.filter((r) => isFav(r.id));
  const wipeAge = (r) => (r.born ? Date.now() - r.born : WIPE_AGE_UNKNOWN);
  const sorters = {
    players: (a, b) => b.players - a.players, queue: (a, b) => b.queue - a.queue || b.players - a.players,
    wipe: (a, b) => wipeAge(a) - wipeAge(b), name: (a, b) => a.name.localeCompare(b.name),
  };
  rows = [...rows].sort(sorters[q.sort] || sorters.players);
  const total = rows.length; const limit = Math.min(parseInt(q.limit, 10) || 150, 300);
  const regions = [...new Set(serverCache.list.map((r) => r.region).filter(Boolean))].sort();
  return { total, all: serverCache.list.length, rows: rows.slice(0, limit).map((r) => ({ ...r, fav: isFav(r.id) })), regions, fetchedAt: serverCache.at };
}

async function serverDetail(id) {
  const withAlert = (v) => ({ ...v, alert: data.serverAlerts[id] ? { queueBelow: data.serverAlerts[id].queueBelow, playersAbove: data.serverAlerts[id].playersAbove, onWipe: data.serverAlerts[id].onWipe } : null, fav: isFav(id) });
  const hit = detailCache.get(id); if (hit && Date.now() - hit.at < 60000) return withAlert(hit.value);
  const base = serverCache.list.find((r) => r.id === id) || data.favorites.find((f) => f.id === id);
  if (!base) return { error: 'Server not found in the list - refresh the list and try again.' };
  const [info, rules] = await Promise.allSettled([servers.a2s(base.ip, base.qport, 'info'), servers.a2s(base.ip, base.qport, 'rules', 5000)]);
  const out = { id, base, info: info.status === 'fulfilled' ? info.value : null, infoError: info.status === 'rejected' ? info.reason.message : '' };
  if (rules.status === 'fulfilled') {
    const r = rules.value;
    out.rules = { seed: r['world.seed'] || '', size: r['world.size'] || '', url: r.url || '', level: r.level || '',
      description: Object.keys(r).filter((k) => /^description_\d+$/.test(k)).sort().map((k) => r[k]).join('').slice(0, 1500) };
    out.map = (out.rules.seed && out.rules.size) ? await servers.mapInfo(out.rules.seed, out.rules.size) : { found: false };
  } else out.rulesError = rules.reason.message;
  detailCache.set(id, { at: Date.now(), value: out });
  return withAlert(out);
}

async function refreshFavorites() {
  const favs = data.favorites.slice(0, 12);
  const res = await Promise.allSettled(favs.map((f) => servers.a2s(f.ip, f.qport, 'info', 3000)));
  return favs.map((f, i) => {
    const live = res[i].status === 'fulfilled' ? res[i].value : null;
    const cached = serverCache.list.find((r) => r.id === f.id) || {};
    return { ...f, players: live ? live.players : cached.players ?? null, max: live ? live.max : cached.max ?? null, queue: live ? live.queue : cached.queue ?? null,
      born: live ? live.born : cached.born || 0, ping: live ? live.ping : null, live: !!live, tags: live ? live.tags : cached.tags || [], fav: true };
  });
}

// ---- server alerts for favourites: queue, population, wipe
async function serverAlert(name, id, text) {
  logEvent('server', `${name}: ${text}`);
  await notify(`Server alert: ${name}`, `${text}\nAddress: ${id}  (click the pop-up to join)`, { toastUrl: `steam://connect/${id}`, color: 0x3ddc97 });
}
async function checkServerAlerts() {
  // every starred server gets a wipe alert unless you turned that off in Settings (explicit per-server alerts still apply on top)
  const ids = new Set(Object.keys(data.serverAlerts));
  if (data.settings.wipeAlertsFavs !== false) for (const f of data.favorites) ids.add(f.id);
  for (const id of ids) {
    const explicit = data.serverAlerts[id]; const f = data.favorites.find((x) => x.id === id); if (!f) continue;
    const a = explicit || { queueBelow: null, playersAbove: null, onWipe: true, lastBorn: (data.wipeSeen || {})[id] || 0 };
    let info; try { info = await servers.a2s(f.ip, f.qport, 'info', 3500); } catch (_) { continue; }
    const name = f.name || id;
    if (a.queueBelow != null) {
      const hit = info.queue <= a.queueBelow;
      if (hit && a.qArmed !== false) { a.qArmed = false; await serverAlert(name, id, `Queue is down to ${info.queue} (your alert: ${a.queueBelow} or fewer). ${info.players}/${info.max} players.`); }
      else if (!hit) a.qArmed = true;
    }
    if (a.playersAbove != null) {
      const hit = info.players >= a.playersAbove;
      if (hit && a.pArmed !== false) { a.pArmed = false; await serverAlert(name, id, `${info.players} players online (your alert: ${a.playersAbove} or more). Queue: ${info.queue}.`); }
      else if (!hit) a.pArmed = true;
    }
    if (a.onWipe && info.born) {
      if (a.lastBorn && info.born > a.lastBorn + 3600e3) await serverAlert(name, id, `Just wiped (${new Date(info.born).toLocaleString()}).`);
      a.lastBorn = Math.max(a.lastBorn || 0, info.born);
      if (!explicit) (data.wipeSeen = data.wipeSeen || {})[id] = a.lastBorn;
    }
  }
  save();
}

// ---- Steam friends currently playing Rust (needs the user's Steam Web API key + a public friends list)
let friendsCache = { at: 0, value: null };
const steamApi = (p, params) => getJSON(`https://api.steampowered.com/${p}?${new URLSearchParams({ key: data.settings.steamApiKey, ...params })}`);
const validId = (id) => /^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(String(id || ''));

async function friendsPlaying(force) {
  if (!(data.settings.steamApiKey || '').trim()) return { error: 'nokey' };
  if (!data.steam.id64) return { error: 'No Steam account linked yet - open Settings and use Detect from this PC.' };
  if (!force && friendsCache.value && Date.now() - friendsCache.at < 60000) return friendsCache.value;
  let ids;
  try {
    const fl = await steamApi('ISteamUser/GetFriendList/v1/', { steamid: data.steam.id64, relationship: 'friend' });
    ids = ((fl.friendslist || {}).friends || []).map((f) => f.steamid);
  } catch (e) {
    if (e.status === 401 || e.status === 403) return { error: 'Your Steam friends list is private. In Steam: Profile > Edit Profile > Privacy Settings > set "Friends List" to Public.' };
    throw e;
  }
  const players = [];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await steamApi('ISteamUser/GetPlayerSummaries/v2/', { steamids: ids.slice(i, i + 100).join(',') });
    players.push(...((r.response || {}).players || []));
  }
  const playing = players.filter((p) => String(p.gameid) === '252490').map((p) => {
    const addr = validId(p.gameserverip) ? p.gameserverip : ''; const srv = addr ? serverCache.list.find((r) => r.id === addr) : null;
    return { id: p.steamid, name: p.personaname, avatar: p.avatarmedium, server: addr, serverName: srv ? srv.name : '', serverPlayers: srv ? srv.players : null, serverMax: srv ? srv.max : null };
  });
  const value = { total: ids.length, online: players.filter((p) => p.personastate > 0).length, playing };
  friendsCache = { at: Date.now(), value };
  return value;
}
async function checkFriends() {
  if (!data.settings.notifyFriends) return;
  const v = await friendsPlaying(true); if (!v || v.error) return;
  const now = v.playing.map((p) => p.id); const prev = data.seen.friends;
  data.seen.friends = now; save();
  if (!Array.isArray(prev)) return;   // first run: baseline only
  for (const p of v.playing) if (!prev.includes(p.id)) {
    logEvent('friend', `${p.name} started playing Rust${p.serverName ? ' on ' + p.serverName : ''}`);
    await notify('A friend is playing Rust', `${p.name}${p.serverName ? ' is on ' + p.serverName : ' just started playing'}`, { toastUrl: p.server ? `steam://connect/${p.server}` : undefined, discord: false });   // names stay on this PC
  }
}

// ---- My Stats (playtime + Rust's own Steam stats; both need the profile's "Game details" to be public)
let statsCache = { at: 0, value: null };
async function steamStats(force) {
  if (!(data.settings.steamApiKey || '').trim()) return { error: 'nokey' };
  const id = data.steam.id64; if (!id) return { error: 'No Steam account linked yet - open Settings and use Detect from this PC.' };
  if (!force && statsCache.value && Date.now() - statsCache.at < 120000) return statsCache.value;
  const [st, og, sm] = await Promise.allSettled([
    steamApi('ISteamUserStats/GetUserStatsForGame/v2/', { steamid: id, appid: '252490' }),
    steamApi('IPlayerService/GetOwnedGames/v1/', { steamid: id, include_played_free_games: '1', 'appids_filter[0]': '252490' }),
    steamApi('ISteamUser/GetPlayerSummaries/v2/', { steamids: id }),
  ]);
  const out = { profile: {}, hours: null, hours2w: null, lastPlayed: 0, stats: [], playNote: '', statsNote: '' };
  if (sm.status === 'fulfilled') { const p = ((sm.value.response || {}).players || [])[0]; if (p) out.profile = { name: p.personaname, avatar: p.avatarfull, url: p.profileurl }; }
  if (og.status === 'fulfilled') {
    const g = ((og.value.response || {}).games || [])[0];
    if (g) { out.hours = Math.round(g.playtime_forever / 6) / 10; out.hours2w = Math.round((g.playtime_2weeks || 0) / 6) / 10; out.lastPlayed = (g.rtime_last_played || 0) * 1000; }
    else out.playNote = 'Playtime is hidden. In Steam privacy settings set "Game details" to Public.';
  } else out.playNote = 'Could not read playtime (' + og.reason.message + ').';
  if (st.status === 'fulfilled') out.stats = (((st.value.playerstats || {}).stats) || []).map((s) => ({ name: s.name, value: s.value }));
  else out.statsNote = 'Rust stats are private or unavailable. In Steam privacy settings set "Game details" to Public.';
  statsCache = { at: Date.now(), value: out };
  return out;
}

// ---- CSV export
const csvEsc = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvEsc).join(',')).join('\r\n') + '\r\n';   // BOM so Excel reads UTF-8
function buildSkinsCsv() {
  const k = skinState();
  const rows = [['Name', 'Quantity', 'Marketable', `Lowest price (${k.currency})`, `Median price (${k.currency})`, `Stack value (${k.currency})`, `Paid each (${k.currency})`, `Profit/loss after fees (${k.currency})`]];
  for (const i of [...k.items].sort((a, b) => ((b.lowest || 0) * b.count) - ((a.lowest || 0) * a.count))) rows.push([i.name, i.count, i.marketable ? 'yes' : 'no', i.lowest ?? '', i.median ?? '', i.lowest != null ? (i.lowest * i.count).toFixed(2) : '', i.paid ?? '', i.paid != null && i.lowest != null ? ((i.lowest / 1.15 - i.paid) * i.count).toFixed(2) : '']);
  rows.push([], ['Total', k.count, '', '', '', k.total.toFixed(2)], ['After Steam fees (about 13%)', '', '', '', '', k.totalNet.toFixed(2)]);
  if (k.pl) rows.push(['Cost of items with a price entered', '', '', '', '', k.pl.cost.toFixed(2)], ['Profit/loss on those items after fees', '', '', '', '', k.pl.diff.toFixed(2)]);
  return toCsv(rows);
}
function buildHistoryCsv() {
  return toCsv([['Time', 'Type', 'Detail'], ...data.log.map((e) => [new Date(e.t).toISOString(), e.type, e.text])]);
}

// ------------------------------------------------------------------ steam
const { execFile } = require('child_process');
function regQuery(key, name) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', name], { windowsHide: true, timeout: 8000 }, (err, out) => resolve(err ? '' : String(out)));
  });
}
// Find Steam accounts that have signed in on this PC (local file + registry; nothing leaves the machine).
async function detectSteamAccounts() {
  let steamPath = 'C:\\Program Files (x86)\\Steam';
  const sp = (await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath')).match(/SteamPath\s+REG_SZ\s+(.+)/);
  if (sp) steamPath = sp[1].trim().replace(/\//g, '\\');
  let active = '';
  const au = (await regQuery('HKCU\\Software\\Valve\\Steam\\ActiveProcess', 'ActiveUser')).match(/ActiveUser\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  if (au) { const n = parseInt(au[1], 16); if (n) active = (BigInt('76561197960265728') + BigInt(n)).toString(); }
  const accounts = [];
  try {
    const vdf = fs.readFileSync(path.join(steamPath, 'config', 'loginusers.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"(\d{17})"\s*\{([^}]*)\}/g)) {
      const body = m[2];
      accounts.push({ id64: m[1], name: (body.match(/"PersonaName"\s*"([^"]*)"/i) || [])[1] || m[1],
        recent: ((body.match(/"MostRecent"\s*"(\d)"/i) || [])[1]) === '1' });
    }
  } catch (_) { /* steam not installed */ }
  if (!active) { const r = accounts.find((a) => a.recent); if (r) active = r.id64; }
  if (!active && accounts[0]) active = accounts[0].id64;
  return { accounts, active };
}
async function steamAutoDetect(force) {
  const d = await detectSteamAccounts();
  rt.steamAccounts = d.accounts; rt.steamActive = d.active;
  if (d.active && (force || !(data.settings.steamInput || '').trim())) {
    data.settings.steamInput = d.active; save();
    await refreshSteam();
  } else if ((data.settings.steamInput || '').trim()) {
    await refreshSteam();   // already linked: reload the inventory + prices on every start
  }
  push();
}

async function resolveSteamId(input) {
  input = (input || '').trim();
  if (!input) return '';
  let m = input.match(/steamcommunity\.com\/profiles\/(\d{17})/); if (m) return m[1];
  if (/^\d{17}$/.test(input)) return input;
  m = input.match(/steamcommunity\.com\/id\/([^/?#]+)/); const vanity = m ? m[1] : input;
  const r = await fetch(`https://steamcommunity.com/id/${encodeURIComponent(vanity)}/?xml=1`, { headers: { 'User-Agent': UA } });
  const x = await r.text();
  const id = x.match(/<steamID64>(\d{17})<\/steamID64>/);
  if (!id) throw new Error('Could not find that Steam profile (is it public?)');
  return id[1];
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function allRewards() {
  const out = [];
  for (const c of rt.campaigns) for (const r of c.rewards) out.push({ ...r, platform: 'kick', campaign: c.name });
  for (const d of data.customDrops) out.push({ key: d.key, name: d.name, minutes: d.minutes, platform: 'twitch', campaign: d.campaign || 'Twitch drop', image: '' });
  return out;
}

async function refreshSteam() {
  const st = data.steam;
  try {
    st.id64 = await resolveSteamId(data.settings.steamInput);
    if (!st.id64) { st.items = []; st.error = ''; return; }
    const r = await fetch(`https://steamcommunity.com/inventory/${st.id64}/252490/2?l=english&count=2000`, { headers: { 'User-Agent': UA } });
    if (r.status === 403 || r.status === 401) throw new Error('Steam inventory is private - set Inventory to Public in Steam privacy settings.');
    if (!r.ok) throw new Error('Steam returned HTTP ' + r.status);
    const j = await r.json();
    const descs = j.descriptions || [];
    st.items = [...new Set(descs.map((d) => d.market_hash_name || d.name).filter(Boolean))];
    // full inventory with stack counts
    const byClass = {}; for (const d of descs) byClass[d.classid + '_' + d.instanceid] = d;
    const counts = {};
    for (const a of j.assets || []) { const k = a.classid + '_' + a.instanceid; counts[k] = (counts[k] || 0) + (parseInt(a.amount || '1', 10) || 1); }
    const merged = {};
    for (const k of Object.keys(counts)) {
      const d = byClass[k] || {}; const hash = d.market_hash_name || d.name; if (!hash) continue;
      const m = merged[hash] = merged[hash] || { hash, name: d.name || hash, icon: d.icon_url ? 'https://community.cloudflare.steamstatic.com/economy/image/' + d.icon_url + '/128fx128f' : '',
        count: 0, marketable: !!d.marketable, tradable: !!d.tradable, type: d.type || '', color: d.name_color ? '#' + d.name_color : '' };
      m.count += counts[k];
    }
    st.inventory = Object.values(merged);
    st.more = !!j.more_items;
    st.error = ''; st.lastCheck = Date.now();
    pricesRun();
    matchClaims();
  } catch (e) { st.error = e.message; }
  save();
}

// Mark drops as claimed when the reward shows up in the Steam inventory.
function matchClaims() {
  const names = data.steam.items.map(norm);
  if (!names.length) return;
  for (const rw of allRewards()) {
    const p = (data.progress[rw.key] = data.progress[rw.key] || { minutes: 0, claimed: null });
    const n = norm(rw.name);
    const has = n && names.some((x) => x === n || x.includes(n));
    if (has && !p.claimed) { p.claimed = 'steam'; p.claimedAt = Date.now(); logEvent('claim', `${rw.name} found in your Steam inventory`, { platform: rw.platform }); }
  }
}

// ------------------------------------------------------------------ steam market prices
const CURRENCIES = { 1: 'USD', 2: 'GBP', 3: 'EUR', 20: 'CAD', 21: 'AUD', 23: 'CNY', 24: 'INR', 5: 'RUB', 7: 'BRL', 29: 'NZD' };
function parsePrice(s) {
  let t = String(s || '').replace(/[^\d.,]/g, ''); if (!t) return null;
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.'); else t = t.replace(/,/g, '');
  const n = parseFloat(t); return Number.isFinite(n) ? n : null;
}
const priceInfo = { running: false, done: 0, total: 0, note: '' };
async function pricesRun() {
  if (priceInfo.running) return;
  // Steam blocks the IP for a while after a 429; honour the cooldown (it survives restarts) instead of hammering it
  const blocked = (data.priceBlock && data.priceBlock.v === 2 && data.priceBlock.until) || 0;   // blocks saved by older versions (other endpoint) are ignored
  if (Date.now() < blocked) {
    priceInfo.note = `Steam is rate-limiting price lookups - retrying automatically at ${new Date(blocked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    clearTimeout(pricesRun.timer); pricesRun.timer = setTimeout(() => { pricesRun(); }, blocked - Date.now() + 2000); push(); return;
  }
  priceInfo.running = true; priceInfo.note = '';
  try {
    const cur = parseInt(data.settings.currency, 10) || 1;
    const wanted = new Map();   // owned skins plus the watchlist (deduplicated by market name)
    for (const it of data.steam.inventory) if (it.marketable) wanted.set(it.hash, it);
    for (const w of data.watchlist) if (!wanted.has(w.hash)) wanted.set(w.hash, w);
    const todo = [...wanted.values()].filter((it) => {
      const p = data.prices[it.hash]; return !p || p.currency !== cur || Date.now() - p.at > 60 * 60000;
    }).sort((a, b) => ((data.prices[a.hash] || {}).at || 0) - ((data.prices[b.hash] || {}).at || 0));   // oldest / never-priced first
    priceInfo.done = 0; priceInfo.total = todo.length; push();
    for (const it of todo) {
      // USD: Steam's market search answers when priceoverview is throttled for this IP (it ignores the currency, so other currencies use priceoverview)
      const viaSearch = cur === 1;
      const url = viaSearch
        ? `https://steamcommunity.com/market/search/render/?query=${encodeURIComponent('"' + it.hash + '"')}&start=0&count=10&search_descriptions=0&appid=252490&norender=1`
        : `https://steamcommunity.com/market/priceoverview/?appid=252490&currency=${cur}&market_hash_name=${encodeURIComponent(it.hash)}`;
      let r;
      try { r = await fetch(url, { headers: { 'User-Agent': UA } }); } catch (e) { priceInfo.note = 'Network error getting prices'; break; }
      if (r.status === 429) {
        const strikes = Math.min(((data.priceBlock && data.priceBlock.strikes) || 0) + 1, 4);
        const mins = [3, 6, 12, 20][strikes - 1];
        data.priceBlock = { until: Date.now() + mins * 60000, strikes, v: 2 };
        priceInfo.note = `Steam rate limit hit - prices continue automatically in ${mins} minutes`;
        clearTimeout(pricesRun.timer); pricesRun.timer = setTimeout(() => { pricesRun(); }, mins * 60000 + 2000); break;
      }
      if (data.priceBlock && r.ok) data.priceBlock = null;
      if (r.ok) {
        let j = await r.json().catch(() => null);
        if (viaSearch && j) {
          const hit = (j.results || []).find((x) => x.hash_name === it.hash);
          j = hit && hit.sell_price_text ? { success: true, lowest_price: hit.sell_price_text, median_price: '', volume: '' } : { success: false };
        }
        if (j && j.success) {
          const prev = data.prices[it.hash];
          data.prices[it.hash] = { lowest: parsePrice(j.lowest_price), median: j.median_price ? parsePrice(j.median_price) : (prev && prev.currency === cur ? prev.median : null),
            lowestText: j.lowest_price || '', medianText: j.median_price || (prev && prev.currency === cur ? prev.medianText : ''), volume: j.volume || (prev && prev.currency === cur ? prev.volume : ''), currency: cur, at: Date.now() };
          recordPrice(it.hash, data.prices[it.hash].lowest, cur);
          await checkAlert(it, data.prices[it.hash].lowest, cur);
        } else if (!data.prices[it.hash] || data.prices[it.hash].currency !== cur) data.prices[it.hash] = { lowest: null, median: null, lowestText: '', medianText: '', volume: '', currency: cur, at: Date.now() };
        else data.prices[it.hash].at = Date.now();   // no listing right now: keep the last known price
      }
      priceInfo.done++; if (priceInfo.done % 3 === 0) { save(); push(); }
      await sleep(4000); // stay well under Steam's ~20 requests/minute limit
    }
  } finally { priceInfo.running = false; recordValue(); save(); push(); }
}

// ---- price history, alerts, tray value
function recordPrice(hash, price, cur) {
  if (price == null) return;
  const hist = (data.history[hash] = data.history[hash] || []);
  const last = hist[hist.length - 1];
  if (!last || last[2] !== cur || last[1] !== price || Date.now() - last[0] > 6 * 3600e3) {
    hist.push([Date.now(), price, cur]);
    if (hist.length > 300) hist.splice(0, hist.length - 300);
  }
}
async function checkAlert(it, price, cur) {
  const a = data.alerts[it.hash]; if (!a || price == null) return;
  const hit = a.dir === 'above' ? price >= a.price : price <= a.price;
  if (hit && a.armed) {
    a.armed = false;
    const code = CURRENCIES[cur] || 'USD';
    const text = `${it.name} ${a.dir === 'above' ? 'rose to' : 'dropped to'} ${price.toFixed(2)} ${code} (your alert: ${a.dir === 'above' ? '>=' : '<='} ${a.price.toFixed(2)})`;
    logEvent('price', text);
    await notify(`Price alert: ${it.name}`, text, { url: 'https://steamcommunity.com/market/listings/252490/' + encodeURIComponent(it.hash), image: it.icon, color: 0xffb020 });
  } else if (!hit && !a.armed) a.armed = true;   // re-arm once the price crosses back
}
function recordValue() {
  const s = skinState(); const marketable = s.items.filter((i) => i.marketable).length;
  if (!s.priced || s.priced < marketable * 0.95) { updateTray(s); return; }   // only record when (nearly) fully priced
  const v = data.valueHistory; const last = v[v.length - 1];
  if (!last || last[2] !== s.currencyId || Math.abs(last[1] - s.total) > 0.005 || Date.now() - last[0] > 6 * 3600e3) {
    v.push([Date.now(), +s.total.toFixed(2), s.currencyId]);
    if (v.length > 500) v.splice(0, v.length - 500);
  }
  updateTray(s);
}
function trayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray-32.png'));
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16, quality: 'best' });
}
function buildTrayMenu() {
  const s = skinState(); const nu = nextMonthlyUpdate();
  const items = [{ label: 'Open Wipewatch', click: () => { win.show(); win.focus(); } }, { type: 'separator' }];
  if (s.priced) items.push({ label: `Skins: about ${s.total.toFixed(2)} ${s.currency}`, enabled: false });
  if (nu) items.push({ label: 'Next wipe: ' + new Date(nu).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), enabled: false });
  items.push({ type: 'separator' }, { label: 'Mini overlay', type: 'checkbox', checked: !!data.settings.overlayOn, click: (mi) => { data.settings.overlayOn = mi.checked; save(); syncOverlay(); push(); } },
    { label: 'Check for drops now', click: () => pollAll() }, { type: 'separator' }, { label: 'Quit Wipewatch', click: () => { quitting = true; app.quit(); } });
  return Menu.buildFromTemplate(items);
}
function updateTray(s) {
  if (!tray) return;
  s = s || skinState();
  tray.setToolTip(s.priced ? `Wipewatch - skins worth about ${s.total.toFixed(2)} ${s.currency}` : 'Wipewatch');
  tray.setContextMenu(buildTrayMenu());
}

function skinState() {
  const cur = parseInt(data.settings.currency, 10) || 1;
  let total = 0; let priced = 0; let count = 0;
  const items = data.steam.inventory.map((it) => {
    const p = data.prices[it.hash]; const ok = p && p.currency === cur;
    const each = ok ? p.lowest : null;
    count += it.count; if (each != null) { total += each * it.count; priced += 1; }
    const spark = (data.history[it.hash] || []).filter((x) => x[2] === cur).slice(-30).map((x) => x[1]);
    const al = data.alerts[it.hash];
    // price change over the last ~24h (or since the first recorded price if we have less history than that)
    const pts = (data.history[it.hash] || []).filter((x) => x[2] === cur); let pct = null;
    if (pts.length >= 2) { const last = pts[pts.length - 1]; const base = pts.find((x) => x[0] >= Date.now() - 24 * 3600e3) || pts[0]; if (base !== last && base[1] > 0) pct = +(((last[1] - base[1]) / base[1]) * 100).toFixed(1); }
    const paid = data.costs[it.hash] != null ? data.costs[it.hash] : null;
    return { ...it, paid, pct, lowest: each, median: ok ? p.median : null, lowestText: ok ? p.lowestText : '', medianText: ok ? p.medianText : '', volume: ok ? p.volume : '', priceAt: ok ? p.at : 0,
      spark, alert: al ? { dir: al.dir, price: al.price } : null };
  });
  const series = data.valueHistory.filter((x) => x[2] === cur).slice(-120);
  let change = null;
  if (series.length >= 2) { const dayAgo = Date.now() - 24 * 3600e3; const base = series.find((x) => x[0] >= dayAgo) || series[0]; if (base !== series[series.length - 1]) change = +(series[series.length - 1][1] - base[1]).toFixed(2); }
  // profit/loss on items with a cost entered: what they'd net after the ~13% Steam fee vs what you paid
  let costTotal = 0; let costNet = 0; let costItems = 0;
  for (const i of items) if (i.paid != null && i.lowest != null) { costTotal += i.paid * i.count; costNet += (i.lowest / 1.15) * i.count; costItems += 1; }
  const pl = costItems ? { cost: +costTotal.toFixed(2), net: +costNet.toFixed(2), diff: +(costNet - costTotal).toFixed(2), pct: costTotal > 0 ? +(((costNet - costTotal) / costTotal) * 100).toFixed(1) : null, items: costItems } : null;
  return { items, pl, total, totalNet: total / 1.15, priced, count, valueSeries: series.map((x) => [x[0], x[1]]), change, alertsCount: Object.keys(data.alerts).length,
    currency: CURRENCIES[cur] || 'USD', currencyId: cur, more: !!data.steam.more,
    pricing: { running: priceInfo.running, done: priceInfo.done, total: priceInfo.total, note: priceInfo.note }, hasSteam: !!data.steam.id64 };
}

// ------------------------------------------------------------------ polling
let polling = false;
async function pollAll() {
  if (polling) return; polling = true;
  try {
    for (const [name, fn] of [['kick', pollKick], ['twitch', pollTwitch], ['facepunch', pollFacepunch], ['news', pollNews]]) {
      try { await fn(); delete rt.errors[name]; } catch (e) { rt.errors[name] = e.message; log(name, 'error', e.message); }
    }
    matchClaims(); rt.lastPoll = Date.now(); save();
  } finally { polling = false; push(); }
}

// ------------------------------------------------------------------ watch tracker
const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function liveAndVisible() { return win && !win.isDestroyed() && win.isVisible() && !win.isMinimized(); }

async function trackerTick() {
  const w = rt.watch;
  if (!w.active) return;
  let counted = false; w.note = '';
  if (!liveAndVisible()) w.note = 'Paused - app window is hidden/minimised';
  else if (w.platform === 'twitch' && data.twitch.token && w.channel) {
    try {
      await twitchRefresh();
      const r = await getJSON(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(w.channel)}`, { headers: helixHeaders() });
      if (!r.data || !r.data[0]) w.note = 'Paused - channel is offline';
      else if (!(r.data[0].tags || []).some((t) => t.toLowerCase().replace(/\s/g, '') === 'dropsenabled')) w.note = 'Channel is live but does NOT have Drops Enabled';
      else counted = true;
    } catch (e) { counted = true; w.note = 'Could not verify live status; counting anyway'; }
  } else counted = true;
  if (counted) {
    w.sessionMinutes += 1;
    const day = dayKey(); data.watchDays[day] = (data.watchDays[day] || 0) + 1;
    for (const d of Object.keys(data.watchDays)) if (d < dayKey(Date.now() - 400 * 864e5)) delete data.watchDays[d];
    for (const key of w.keys) {
      const rw = allRewards().find((x) => x.key === key); if (!rw) continue;
      const p = (data.progress[key] = data.progress[key] || { minutes: 0, claimed: null });
      if (p.claimed) continue;
      p.minutes = Math.min(rw.minutes || 1e9, (p.minutes || 0) + 1);
      if (rw.minutes && p.minutes >= rw.minutes && !data.seen.ready[key]) {
        data.seen.ready[key] = true;
        logEvent('ready', `${rw.name} reached ${rw.minutes} minutes - ready to claim`, { platform: rw.platform });
        notify(`Ready to claim: ${rw.name}`, `You've watched ${rw.minutes} minutes (app estimate). Claim it on ${rw.platform === 'kick' ? 'Kick' : 'Twitch'}.`,
          { url: rw.platform === 'kick' ? 'https://kick.com/drops/inventory' : 'https://www.twitch.tv/drops/inventory', color: 0x57f287 });
      }
    }
    save();
  }
  push();
}

// ------------------------------------------------------------------ state for UI
function buildState() {
  const rewards = {};
  for (const r of allRewards()) rewards[r.key] = data.progress[r.key] || { minutes: 0, claimed: null };
  return {
    campaigns: rt.campaigns,
    customDrops: data.customDrops,
    progress: rewards,
    twitch: { status: rt.twitchStatus, login: data.twitch.login, linked: !!data.twitch.token, streams: rt.twitchStreams.slice(0, 30), tagUrl: TWITCH_DROPS_TAG_URL, linking: !!deviceFlow },
    steam: { id64: data.steam.id64, items: data.steam.items.length, error: data.steam.error, lastCheck: data.steam.lastCheck },
    news: newsList(), nextUpdate: nextMonthlyUpdate(), log: data.log.slice(0, 200),
    skins: skinState(), currencies: CURRENCIES, steamAccounts: rt.steamAccounts || [], steamActive: rt.steamActive || '',
    settings: data.settings, features: FEATURES, social: social ? social.view() : null, update: data.update || null, version: app.getVersion(), watchlist: watchState(), kv: data.kv, watchDays: data.watchDays,
    watch: rt.watch, lastPoll: rt.lastPoll, errors: rt.errors, facepunchChanged: rt.facepunchChanged, facepunchUrl: FACEPUNCH_URL,
  };
}
function watchState() {
  const cur = parseInt(data.settings.currency, 10) || 1;
  return data.watchlist.map((w) => {
    const p = data.prices[w.hash]; const ok = p && p.currency === cur;
    const pts = (data.history[w.hash] || []).filter((x) => x[2] === cur); let pct = null;
    if (pts.length >= 2) { const last = pts[pts.length - 1]; const base = pts.find((x) => x[0] >= Date.now() - 24 * 3600e3) || pts[0]; if (base !== last && base[1] > 0) pct = +(((last[1] - base[1]) / base[1]) * 100).toFixed(1); }
    const al = data.alerts[w.hash]; const owned = data.steam.inventory.find((i) => i.hash === w.hash);
    return { ...w, lowest: ok ? p.lowest : null, median: ok ? p.median : null, volume: ok ? p.volume : '', priceAt: ok ? p.at : 0, pct, spark: pts.slice(-30).map((x) => x[1]),
      alert: al ? { dir: al.dir, price: al.price } : null, owned: owned ? owned.count : 0 };
  });
}
function push() {
  if (win && !win.isDestroyed()) win.webContents.send('state', buildState());
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('state', buildState());
}

// ------------------------------------------------------------------ mini overlay (always-on-top)
let overlayWin = null;
function syncOverlay() {
  const want = !!data.settings.overlayOn && (!SMOKE || !!process.env.RDT_OVERLAY);
  if (!want) { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close(); overlayWin = null; return; }
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setIgnoreMouseEvents(!!data.settings.overlayLock, { forward: true });
    overlayWin.setOpacity(Math.min(1, Math.max(0.3, (data.settings.overlayOpacity || 92) / 100))); return;
  }
  const b = data.overlayBounds;
  const wa = screen.getPrimaryDisplay().workArea;
  const onScreen = b && screen.getAllDisplays().some((d) => b.x >= d.bounds.x - 20 && b.y >= d.bounds.y - 20 && b.x < d.bounds.x + d.bounds.width - 40 && b.y < d.bounds.y + d.bounds.height - 40);
  overlayWin = new BrowserWindow({
    width: 280, height: 168, x: onScreen ? b.x : wa.x + wa.width - 300, y: onScreen ? b.y : wa.y + 20,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false, focusable: false, title: 'Wipewatch overlay',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setOpacity(Math.min(1, Math.max(0.3, (data.settings.overlayOpacity || 92) / 100)));
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWin.once('ready-to-show', () => { overlayWin.showInactive(); overlayWin.setIgnoreMouseEvents(!!data.settings.overlayLock, { forward: true }); });
  let t = null;
  overlayWin.on('move', () => { clearTimeout(t); t = setTimeout(() => { if (overlayWin && !overlayWin.isDestroyed()) { const bb = overlayWin.getBounds(); data.overlayBounds = { x: bb.x, y: bb.y }; save(); } }, 500); });
  overlayWin.on('closed', () => { overlayWin = null; });
  overlayWin.webContents.on('will-navigate', (e) => e.preventDefault());
}

// ------------------------------------------------------------------ friends & clans (see social.js and server/server.js)
let social = null;
async function trackSelfServer() {   // which Rust server you are on right now (Steam shows it when your game details are public)
  if (!data.settings.steamApiKey || !data.steam.id64) return;
  let r; try { r = await steamApi('ISteamUser/GetPlayerSummaries/v2/', { steamids: data.steam.id64 }); } catch (_) { return; }
  const p = r.response && r.response.players && r.response.players[0];
  if (!p || String(p.gameid) !== '252490' || !validId(p.gameserverip)) { if (social) social.setPlaying(null); return; }
  const id = p.gameserverip; const known = serverCache.list.find((x) => x.id === id) || data.favorites.find((x) => x.id === id);
  const name = String((known && known.name) || id).slice(0, 100);
  const list = data.recentServers; const top = list[0];
  if (top && top.id === id && Date.now() - top.t < 20 * 60000) top.t = Date.now(); else { list.unshift({ id, name, t: Date.now() }); if (list.length > 20) list.length = 20; }
  if (social) social.setPlaying(name); save();
}

// ------------------------------------------------------------------ update check (GitHub releases of a repo you choose; never downloads or runs anything by itself)
const semverParts = (v) => String(v || '').replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
const isNewer = (a, b) => { const x = semverParts(a); const y = semverParts(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function checkUpdate(manual) {
  const repo = String(data.settings.updateRepo || '').trim();
  if (!/^[\w.-]{1,39}\/[\w.-]{1,100}$/.test(repo)) return { error: 'Enter a GitHub repository as owner/name first.' };
  let r;
  try { r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'User-Agent': 'Wipewatch-update-check', Accept: 'application/vnd.github+json' } }); } catch (e) { return { error: 'Could not reach GitHub.' }; }
  if (r.status === 404) return { error: 'No releases found in that repository.' };
  if (!r.ok) return { error: 'GitHub returned ' + r.status };
  const j = await r.json().catch(() => null); if (!j || !j.tag_name) return { error: 'Unexpected response from GitHub.' };
  data.updateCheckedAt = Date.now();
  if (isNewer(j.tag_name, app.getVersion())) {
    const exe = (j.assets || []).find((a) => /setup.*\.exe$/i.test(a.name || '') && /^https:\/\/github\.com\//.test(a.browser_download_url || ''));
    const had = data.update && data.update.version === j.tag_name;
    data.update = { version: j.tag_name, url: /^https:\/\/github\.com\//.test(j.html_url || '') ? j.html_url : `https://github.com/${repo}/releases`, asset: exe ? exe.browser_download_url : '', notes: String(j.body || '').slice(0, 800), notified: had ? data.update.notified : false };
    if (!data.update.notified) { data.update.notified = true; await notify('Wipewatch update available', `Version ${j.tag_name} is out (you have ${app.getVersion()}). Open Settings to download it.`, { url: data.update.url, discord: false, color: 0xff9a3d }); }
  } else data.update = null;
  save(); push(); return { ok: true, update: data.update, current: app.getVersion() };
}

// ------------------------------------------------------------------ build ideas
const buildCache = { at: 0, videos: [], errors: {} };
async function loadBuilds(force) {
  if (!force && Date.now() - buildCache.at < 30 * 60000 && buildCache.videos.length) return buildCache;
  const r = await fetchBuilds(data.builds.channels);
  if (r.videos.length) { buildCache.at = Date.now(); buildCache.videos = r.videos; buildCache.errors = r.errors; data.builds.cache = { at: buildCache.at, videos: r.videos.slice(0, 60) }; save(); }
  else if (data.builds.cache && data.builds.cache.videos.length) {   // YouTube down: show the last good list instead of an empty page
    buildCache.videos = data.builds.cache.videos; buildCache.at = Date.now();
    buildCache.errors = { 'YouTube': `could not be reached - showing results saved ${new Date(data.builds.cache.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` };
  } else { buildCache.errors = r.errors; buildCache.at = Date.now(); }
  return buildCache;
}
async function checkNewBuilds() {
  if (!data.settings.buildAlerts) return;
  const c = await loadBuilds(true);
  const seen = new Set(data.builds.seen); const first = seen.size === 0;
  const fresh = c.videos.filter((v) => !seen.has(v.id));
  for (const v of c.videos) seen.add(v.id);
  data.builds.seen = [...seen].slice(-300); save();
  if (first) return;   // baseline: don't announce the existing backlog
  for (const v of fresh.filter((x) => x.views >= 1500 || (Date.now() - x.published) < 36e5 * 6).slice(0, 2)) {
    await notify('New base build video', `${v.channel}: ${v.title}`, { url: v.url, image: v.thumb, color: 0xff9a3d });
  }
}

// ------------------------------------------------------------------ IPC
function ipc() {
  ipcMain.handle('state', () => buildState());
  ipcMain.handle('poll', async () => { await pollAll(); return buildState(); });
  ipcMain.handle('settings:save', async (_e, s) => {
    const prev = data.settings;
    data.settings = { ...prev, ...s, pollSeconds: Math.max(60, parseInt(s.pollSeconds || prev.pollSeconds, 10) || 300) };
    applyAutoStart(); save(); syncOverlay();
    if (s.steamInput !== undefined && s.steamInput !== prev.steamInput) await refreshSteam();
    if (s.twitchClientId !== undefined && s.twitchClientId !== prev.twitchClientId) { data.twitch = DEFAULTS().twitch; }
    if (s.steamApiKey !== undefined && s.steamApiKey !== prev.steamApiKey) { serverCache.list = []; serverCache.at = 0; detailCache.clear(); }
    if (s.currency !== undefined && parseInt(s.currency, 10) !== parseInt(prev.currency, 10)) { data.settings.currency = parseInt(s.currency, 10) || 1; pricesRun(); }
    schedulePoll(); push(); return buildState();
  });
  ipcMain.handle('notify:test', async () => { await notify('Wipewatch test', 'If you can see this, notifications work.', { color: 0x57f287 }); return true; });
  ipcMain.handle('twitch:login', async () => {
    try { const r = await twitchLoginStart(); shell.openExternal(r.url); push(); return r; }
    catch (e) {
      const why = e.body && typeof e.body === 'object' ? (e.body.message || e.body.error || '') : '';
      return { error: why ? `Twitch said: ${why}. Check the Client ID is correct and the app's Client Type is "Public".` : e.message };
    }
  });
  ipcMain.handle('twitch:cancel', () => { if (deviceFlow) deviceFlow.cancelled = true; deviceFlow = null; push(); });
  ipcMain.handle('twitch:logout', () => { data.twitch = DEFAULTS().twitch; rt.twitchStreams = []; save(); pollAll(); return true; });
  ipcMain.handle('steam:refresh', async () => { await refreshSteam(); push(); return buildState(); });
  ipcMain.handle('servers:query', async (_e, q) => {
    try { await loadServers(!!q.force); } catch (e) { return { error: e.message === 'NO_KEY' ? 'nokey' : e.message }; }
    return queryServers(q || {});
  });
  ipcMain.handle('servers:detail', async (_e, id) => { try { return await serverDetail(String(id)); } catch (e) { return { error: e.message }; } });
  ipcMain.handle('servers:favs', async () => { try { return await refreshFavorites(); } catch (e) { return []; } });
  ipcMain.handle('servers:fav', (_e, s) => {
    const id = String(s && s.id || ''); if (!/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(id)) return false;
    if (isFav(id)) data.favorites = data.favorites.filter((f) => f.id !== id);
    else data.favorites.push({ id, ip: s.ip, qport: s.qport, gport: s.gport, name: String(s.name || '').slice(0, 120) });
    save(); return true;
  });
  ipcMain.handle('servers:alert', (_e, id, cfg) => {
    id = String(id || ''); if (!validId(id)) return false; cfg = cfg || {};
    const base = serverCache.list.find((r) => r.id === id) || data.favorites.find((f) => f.id === id); if (!base) return false;
    if (!isFav(id)) data.favorites.push({ id, ip: base.ip, qport: base.qport, gport: base.gport, name: String(base.name || '').slice(0, 120) });   // alerts need the server in favourites
    const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : null; };
    const q = num(cfg.queueBelow); const p = num(cfg.playersAbove); const onWipe = !!cfg.onWipe;
    if (q == null && p == null && !onWipe) delete data.serverAlerts[id];
    else data.serverAlerts[id] = { queueBelow: q, playersAbove: p, onWipe, qArmed: true, pArmed: true, lastBorn: base.born || 0 };
    save(); setTimeout(() => checkServerAlerts().catch(() => {}), 500); return true;
  });
  ipcMain.handle('friends:list', async (_e, force) => { try { return await friendsPlaying(!!force); } catch (e) { return { error: e.message }; } });
  ipcMain.handle('stats:get', async (_e, force) => { try { return await steamStats(!!force); } catch (e) { return { error: e.message }; } });
  ipcMain.handle('export:csv', async (_e, kind) => {
    if (!['skins', 'history'].includes(kind)) return { error: 'Unknown export' };
    const r = await dialog.showSaveDialog(win, { title: 'Save CSV', defaultPath: path.join(app.getPath('documents'), `rust-${kind}-${new Date().toISOString().slice(0, 10)}.csv`), filters: [{ name: 'CSV spreadsheet', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return { canceled: true };
    try { fs.writeFileSync(r.filePath, kind === 'skins' ? buildSkinsCsv() : buildHistoryCsv(), 'utf8'); return { path: r.filePath }; } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, dataPath: app.getPath('userData') }));
  ipcMain.handle('app:openData', () => shell.openPath(app.getPath('userData')));
  // Backup: settings, progress, history, alerts, favourites. Secrets (webhook, API key, Twitch login) are never written to the file.
  ipcMain.handle('backup:export', async () => {
    const copy = JSON.parse(JSON.stringify(data));
    copy.settings.webhook = ''; copy.settings.steamApiKey = ''; copy.twitch = DEFAULTS().twitch; delete copy.window;
    copy.social = { ...copy.social, token: '', id: '' };   // the account token is a password: keep it out of backup files
    copy._wipewatch = { version: app.getVersion(), exportedAt: new Date().toISOString() };
    const r = await dialog.showSaveDialog(win, { title: 'Save Wipewatch backup', defaultPath: path.join(app.getPath('documents'), `wipewatch-backup-${new Date().toISOString().slice(0, 10)}.json`), filters: [{ name: 'Wipewatch backup', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return { canceled: true };
    try { fs.writeFileSync(r.filePath, JSON.stringify(copy, null, 2), 'utf8'); return { path: r.filePath }; } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('backup:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Restore a Wipewatch backup', properties: ['openFile'], filters: [{ name: 'Wipewatch backup', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    let obj;
    try { obj = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); } catch (e) { return { error: 'That file is not valid JSON.' }; }
    if (!obj || typeof obj !== 'object' || !obj._wipewatch || typeof obj.settings !== 'object') return { error: 'That is not a Wipewatch backup file.' };
    const keep = { webhook: data.settings.webhook, steamApiKey: data.settings.steamApiKey, twitch: data.twitch, social: data.social };
    const base = DEFAULTS();
    data = { ...base, ...obj, settings: { ...base.settings, ...obj.settings }, steam: { ...base.steam, ...(obj.steam || {}) }, seen: { ...base.seen, ...(obj.seen || {}) }, twitch: keep.twitch };
    delete data._wipewatch; data.social = { ...base.social, ...keep.social };
    data.settings.webhook = keep.webhook; data.settings.steamApiKey = keep.steamApiKey;   // keep this PC's secrets
    save(); serverCache.list = []; serverCache.at = 0; detailCache.clear(); friendsCache = { at: 0, value: null }; statsCache = { at: 0, value: null };
    schedulePoll(); setTimeout(() => { refreshSteam().then(push); pollAll(); }, 200); push();
    return { ok: true };
  });
  ipcMain.handle('servers:connect', (_e, id) => {
    id = String(id || ''); if (!/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(id)) return false;
    shell.openExternal('steam://connect/' + id); return true;   // asks Steam to launch Rust and join this server
  });
  ipcMain.handle('news:get', (_e, id) => {
    const n = newsItems.find((x) => x.id === String(id)); if (!n) return null;
    data.seen.newsRead[n.id] = 1; save(); push();
    return { id: n.id, title: n.title, url: n.url, date: n.date, official: n.official, contents: n.contents };
  });
  ipcMain.handle('news:readall', () => { for (const n of newsItems) data.seen.newsRead[n.id] = 1; save(); push(); return true; });
  ipcMain.handle('alert:set', (_e, hash, dir, price) => {
    const p = parseFloat(price); if (!hash || !(p > 0) || !['above', 'below'].includes(dir)) return false;
    const cur = (data.prices[hash] || {}).lowest;
    const hit = cur != null && (dir === 'above' ? cur >= p : cur <= p);
    data.alerts[hash] = { dir, price: p, armed: !hit }; save(); push(); return true;
  });
  ipcMain.handle('alert:remove', (_e, hash) => { delete data.alerts[hash]; save(); push(); return true; });
  ipcMain.handle('log:clear', () => { data.log = []; save(); push(); return true; });
  ipcMain.handle('steam:detect', async (_e, id) => {
    if (id) { data.settings.steamInput = id; save(); await refreshSteam(); push(); return buildState(); }
    await steamAutoDetect(true); return buildState();
  });
  ipcMain.handle('prices:refresh', async (_e, force) => {
    if (force) for (const k of Object.keys(data.prices)) data.prices[k].at = 0;
    pricesRun(); return buildState();
  });
  ipcMain.handle('claim:set', (_e, key, on) => {
    const p = (data.progress[key] = data.progress[key] || { minutes: 0, claimed: null });
    const was = p.claimed; p.claimed = on ? 'manual' : null; p.claimedAt = on ? Date.now() : 0;
    const rw = allRewards().find((x) => x.key === key);
    if (on && !was && rw) logEvent('claim', `${rw.name} marked as claimed`, { platform: rw.platform });
    save(); push(); return true;
  });
  ipcMain.handle('progress:set', (_e, key, minutes) => {
    const p = (data.progress[key] = data.progress[key] || { minutes: 0, claimed: null });
    p.minutes = Math.max(0, parseInt(minutes, 10) || 0); save(); push(); return true;
  });
  ipcMain.handle('custom:add', (_e, d) => {
    const name = String(d.name || '').trim(); if (!name) return false;
    data.customDrops.push({ key: 'twitch:custom:' + Date.now().toString(36), name, minutes: Math.max(1, parseInt(d.minutes, 10) || 60), campaign: String(d.campaign || '').trim() || 'Twitch drop' });
    save(); push(); return true;
  });
  ipcMain.handle('custom:remove', (_e, key) => { data.customDrops = data.customDrops.filter((x) => x.key !== key); delete data.progress[key]; save(); push(); return true; });
  ipcMain.handle('watch:set', (_e, w) => {
    const prev = rt.watch;
    rt.watch = { ...prev, ...w, lastMinuteAt: Date.now() };
    if (!w.active) rt.watch.note = '';
    if (w.active && !prev.active) rt.watch.sessionMinutes = 0;
    push(); return true;
  });
  ipcMain.handle('open', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

  // ---- build ideas
  const buildInfo = () => ({ channels: data.builds.channels, videos: buildCache.videos, errors: buildCache.errors, at: buildCache.at });
  ipcMain.handle('builds:get', async (_e, force) => { try { await loadBuilds(!!force); } catch (e) { buildCache.errors = { feed: e.message }; } return buildInfo(); });
  ipcMain.handle('builds:add', async (_e, input) => {
    try {
      const ch = await resolveChannel(input);
      if (data.builds.channels.some((c) => c.id === ch.id)) return { error: `${ch.name} is already in your list` };
      if (data.builds.channels.length >= 25) return { error: 'You can follow up to 25 channels' };
      data.builds.channels.push(ch); save(); await loadBuilds(true); return buildInfo();
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('builds:remove', async (_e, id) => { data.builds.channels = data.builds.channels.filter((c) => c.id !== id); save(); await loadBuilds(true).catch(() => {}); return buildInfo(); });

  // ---- skin watchlist (items you don't own)
  ipcMain.handle('watch:search', async (_e, q) => {
    q = String(q || '').trim().slice(0, 80); if (q.length < 2) return { results: [] };
    try {
      const r = await fetch(`https://steamcommunity.com/market/search/render/?query=${encodeURIComponent(q)}&start=0&count=12&search_descriptions=0&appid=252490&norender=1`, { headers: { 'User-Agent': UA } });
      if (r.status === 429) return { error: 'Steam is rate-limiting market searches right now. Try again in a few minutes.' };
      if (!r.ok) return { error: 'Steam Market search failed (' + r.status + ')' };
      const j = await r.json();
      return { results: (j.results || []).map((x) => ({ hash: x.hash_name, name: x.name, price: x.sell_price_text || '', listings: x.sell_listings || 0,
        icon: x.asset_description && x.asset_description.icon_url ? `https://community.cloudflare.steamstatic.com/economy/image/${x.asset_description.icon_url}/96fx96f` : '',
        color: x.asset_description && x.asset_description.name_color ? '#' + x.asset_description.name_color : '' })) };
    } catch (e) { return { error: 'Could not reach the Steam Market' }; }
  });
  ipcMain.handle('watch:add', (_e, it) => {
    const hash = String(it && it.hash || '').slice(0, 200); if (!hash || data.watchlist.some((w) => w.hash === hash) || data.watchlist.length >= 60) return false;
    const icon = /^https:\/\/community\.(cloudflare|akamai)\.steamstatic\.com\//.test(it.icon || '') ? it.icon : '';
    data.watchlist.push({ hash, name: String(it.name || hash).slice(0, 120), icon, color: /^#[0-9a-f]{3,8}$/i.test(it.color || '') ? it.color : '' });
    save(); push(); if (!priceInfo.running) pricesRun(); return true;
  });
  ipcMain.handle('cost:set', (_e, hash, paid) => {
    if (!hash || !data.steam.inventory.some((i) => i.hash === hash)) return false;
    const v = parseFloat(paid); if (paid === '' || paid == null) delete data.costs[hash]; else if (v >= 0 && v < 1e6) data.costs[hash] = +v.toFixed(2); else return false;
    save(); push(); return true;
  });
  ipcMain.handle('update:check', (_e) => checkUpdate(true));
  ipcMain.handle('watch:remove', (_e, hash) => { data.watchlist = data.watchlist.filter((w) => w.hash !== hash); delete data.alerts[hash]; save(); push(); return true; });

  // ---- small user data (planner checklist, notes, base pins); kept in backups
  ipcMain.handle('kv:set', (_e, key, value) => {
    if (!/^[\w.-]{1,40}$/.test(key)) return false;
    const s = JSON.stringify(value === undefined ? null : value); if (s.length > 200000) return false;
    data.kv[key] = JSON.parse(s); save(); push(); return true;
  });
  ipcMain.handle('overlay:toggle', (_e, on) => { data.settings.overlayOn = !!on; save(); syncOverlay(); push(); return true; });
}

// ------------------------------------------------------------------ window / tray / lifecycle
let pollTimer = null;
function schedulePoll() { clearInterval(pollTimer); pollTimer = setInterval(pollAll, Math.max(60, data.settings.pollSeconds) * 1000); }
function applyAutoStart() {
  if (SMOKE || !app.isPackaged && process.defaultApp === undefined) return;
  try {
    const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
    app.setLoginItemSettings({ openAtLogin: !!data.settings.autoStart, path: process.execPath, args });
  } catch (_) { /* ignore */ }
}

// Remember window size/position between runs (only restore a position that is still on a connected screen).
function restoredBounds() {
  const b = data.window; const def = { width: 1180, height: 780 };
  if (!b || !(b.width >= 900) || !(b.height >= 600)) return def;
  const onScreen = b.x != null && b.y != null && screen.getAllDisplays().some((d) => { const a = d.workArea; return b.x + 80 > a.x && b.x < a.x + a.width - 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80; });
  return onScreen ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: b.width, height: b.height };
}
function createWindow(show) {
  win = new BrowserWindow({
    ...restoredBounds(), minWidth: 900, minHeight: 600, show: false, backgroundColor: '#0a0c11', title: 'Wipewatch', icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },   // alert sounds must play while hidden in the tray
  });
  if (data.window && data.window.max) win.maximize();
  win.loadFile(path.join(__dirname, 'index.html'), { query: SMOKE && !process.env.RDT_INTRO ? { nointro: '1' } : {} });
  win.once('ready-to-show', () => { if (show) win.show(); });
  let boundsT = null;
  const rememberBounds = () => {
    clearTimeout(boundsT);
    boundsT = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized()) return;
      if (win.isMaximized()) data.window = { ...(data.window || {}), max: true }; else data.window = { ...win.getBounds(), max: false };
      save();
    }, 600);
  };
  win.on('resize', rememberBounds); win.on('move', rememberBounds); win.on('maximize', rememberBounds); win.on('unmaximize', rememberBounds);
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) { e.preventDefault(); } });
}

function createTray() {
  tray = new Tray(trayIcon());
  updateTray();
  tray.on('click', () => { win.isVisible() ? win.hide() : (win.show(), win.focus()); });
}

if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.on('before-quit', () => { quitting = true; saveNow(); });

app.whenReady().then(async () => {
  if (SMOKE) app.setPath('userData', path.join(app.getPath('temp'), 'rdt-smoke-' + Date.now()));
  if (SMOKE && process.env.RDT_DATA) {   // run the self-test on a COPY of real data (never touches the original)
    try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.copyFileSync(process.env.RDT_DATA, path.join(app.getPath('userData'), 'data.json')); } catch (e) { console.error('RDT_DATA copy failed', e.message); }
  }
  loadData(); ipc();
  social = FEATURES.social ? createSocial({ data: () => data, save, push, notify, skinState, statsHours: () => (statsCache.value && statsCache.value.hours != null ? statsCache.value.hours : null) }) : null;
  if (social) social.register(ipcMain);
  Menu.setApplicationMenu(null);   // no default File/Edit/View menu: keeps Ctrl+R / DevTools shortcuts out of the way (text copy/paste still works)
  if (SMOKE) { data.settings.webhook = ''; data.settings.toast = false; }
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  createWindow(!process.argv.includes('--hidden') && !SMOKE);
  if (!SMOKE) createTray();
  applyAutoStart();
  const REAL = SMOKE && process.env.RDT_REAL === '1';
  if (SMOKE && !REAL) { rt.steamAccounts = []; }
  else steamAutoDetect(false).catch((e) => log('steam detect failed', e.message));   // finds your account + loads the inventory
  pollAll().then(schedulePoll);
  setInterval(trackerTick, 60000);
  if (!SMOKE) {
    setInterval(() => checkServerAlerts().catch((e) => log('server alerts', e.message)), 2 * 60000);
    setInterval(() => checkFriends().catch((e) => log('friends', e.message)), 2 * 60000);
    setInterval(() => checkNewBuilds().catch((e) => log('builds', e.message)), 3 * 3600e3);
    setTimeout(() => checkNewBuilds().catch((e) => log('builds', e.message)), 20000);
    syncOverlay(); if (social) social.schedule();
    setInterval(() => { trackSelfServer().then(() => (data.settings.steamApiKey && data.steam.id64 ? steamStats(false) : null)).catch(() => {}); }, 2 * 60000);
    setTimeout(() => { trackSelfServer().catch(() => {}); }, 15000);
    setTimeout(() => { if (data.settings.updateRepo) checkUpdate(false).catch(() => {}); }, 45000);
    setInterval(() => { if (data.settings.updateRepo) checkUpdate(false).catch(() => {}); }, 12 * 3600e3);
  }
  setInterval(() => { if (data.settings.steamInput) refreshSteam().then(push).catch(() => {}); }, 10 * 60000);

  if (SMOKE) {
    // headless self-test: wait for UI, dump what it rendered, exit
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
    await sleep(2000);
    if (REAL) {
      // real run: wait for the real Steam inventory + a few prices to load
      for (let i = 0; i < 60 && !(data.steam.inventory.length && Object.keys(data.prices).length >= 6); i++) await sleep(1000);
    } else {
      // fake a public inventory so the Skins tab can be exercised without a real Steam account
      data.steam.id64 = '76561190000000000';
      data.steam.inventory = [
        { hash: 'Test Door', name: 'Test Door', icon: '', count: 3, marketable: true, tradable: true, type: 'Door', color: '#4b69ff' },
        { hash: 'Test Box', name: 'Test Box', icon: '', count: 1, marketable: false, tradable: false, type: 'Box', color: '' },
      ];
      data.prices['Test Door'] = { lowest: 4.5, median: 5, lowestText: '$4.50', medianText: '$5.00', volume: '9', currency: 1, at: Date.now() };
    }
    // seed history + an alert to exercise charts, sparklines and alert firing
    const first = data.steam.inventory.find((it) => data.prices[it.hash] && data.prices[it.hash].lowest != null) || data.steam.inventory[0];
    if (first) {
      const base = (data.prices[first.hash] || {}).lowest || 2; const now = Date.now();
      data.history[first.hash] = [0, 1, 2, 3, 4, 5].map((i) => [now - (6 - i) * 6 * 3600e3, +(base * (0.9 + i * 0.03)).toFixed(2), 1]);
      data.valueHistory = [0, 1, 2, 3, 4, 5].map((i) => [now - (6 - i) * 6 * 3600e3, +(10 + i * 0.7).toFixed(2), 1]);
      data.alerts[first.hash] = { dir: 'below', price: base + 1, armed: true };
      await checkAlert(first, base, 1);   // should fire: logs an event (webhook/toast are off in the test)
    }
    // fake server list + stubbed live query so the Servers tab can be tested without a Steam key or a real game server
    data.settings.steamApiKey = 'test-key';
    const names = ['Rustoria.com - US Long III', 'Rusty Moose |US Main|', 'Reddit.com/r/PlayRust - US', 'Facepunch Official EU 1', 'Bloodlust - EU Main', 'Vanilla PvE Chill Zone', 'Modded 3x Kits Oxide', 'Survivors.gg Monthly', 'Rustafied - AU Main', 'Zombie Land RP'];
    serverCache.list = Array.from({ length: 40 }, (_, i) => ({ id: `10.0.${i}.1:28015`, ip: `10.0.${i}.1`, qport: 28017, gport: 28015, name: `${names[i % names.length]} #${i + 1}`,
      players: 250 - i * 5, max: 300, queue: i % 4 === 0 ? 40 - i : 0, born: Date.now() - (i % 9) * 86400e3 - 3600e3, map: 'Procedural Map',
      region: ['US East', 'Europe', 'Australia', 'US West'][i % 4], tags: i % 5 === 0 ? ['pve', 'monthly'] : i % 3 === 0 ? ['modded', 'weekly'] : ['vanilla', 'biweekly'] }));
    serverCache.at = Date.now();
    data.favorites = [{ id: serverCache.list[2].id, ip: serverCache.list[2].ip, qport: 28017, gport: 28015, name: serverCache.list[2].name }];
    servers.a2s = async (ip, port, kind) => kind === 'info'
      ? { name: 'fake', map: 'Procedural Map', players: 231, max: 300, queue: 17, ping: 38, born: Date.now() - 2 * 86400e3, tags: ['vanilla', 'biweekly'] }
      : { 'world.seed': '1239791257', 'world.size': '2500', description_00: 'Welcome to the test server. Wipe every other Thursday at 2pm EST.\nRules: no cheating.' };
    // stub Steam's friends / playtime / stats endpoints (everything else, e.g. RustMaps and the news feed, stays real)
    const realFetch = globalThis.fetch; const jres = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('web.kick.com') && globalThis.__fakeKick) return jres({ data: [{ id: 'KICKTEST1', name: 'Test Campaign', category: { slug: 'rust' }, starts_at: new Date(Date.now() - 3600e3).toISOString(), ends_at: new Date(Date.now() + 3600e3).toISOString(), connect_url: 'https://kick.facepunch.com',
        rewards: [{ id: 'r1', name: 'Reward One', required_units: 60 }, { id: 'r2', name: 'Reward Two', required_units: 120 }], channels: [] }] });
      if (u.includes('market/search/render')) return jres({ success: true, results: [{ name: 'Tempered AK47', hash_name: 'Tempered AK47', sell_price_text: '$31.20', sell_listings: 85, asset_description: { icon_url: 'abc', name_color: 'D2D2D2' } }, { name: 'Glowing Door', hash_name: 'Glowing Door', sell_price_text: '$4.10', sell_listings: 300, asset_description: {} }] });
      if (u.includes('market/priceoverview') && u.includes('Tempered')) return jres({ success: true, lowest_price: '$31.20', median_price: '$32.00', volume: '40' });
      if (u.includes('GetFriendList')) return jres({ friendslist: { friends: [{ steamid: '1' }, { steamid: '2' }, { steamid: '3' }] } });
      if (u.includes('GetPlayerSummaries')) {
        if (u.includes('steamids=1%2C2%2C3')) return jres({ response: { players: [
          { steamid: '1', personaname: 'FriendOne', gameid: '252490', gameserverip: serverCache.list[2].id, personastate: 1, avatarmedium: '' },
          { steamid: '2', personaname: 'FriendTwo', gameid: '730', personastate: 1 }, { steamid: '3', personaname: 'FriendThree', personastate: 0 }] } });
        return jres({ response: { players: [{ steamid: data.steam.id64, personaname: 'Test Player', avatarfull: '', profileurl: 'https://steamcommunity.com/id/test' }] } });
      }
      if (u.includes('GetOwnedGames')) return jres({ response: { games: [{ appid: 252490, playtime_forever: 7260, playtime_2weeks: 300, rtime_last_played: Math.floor(Date.now() / 1000) - 86400 }] } });
      if (u.includes('GetUserStatsForGame')) return jres({ playerstats: { stats: [{ name: 'kill_player', value: 1234 }, { name: 'death_player', value: 987 }, { name: 'headshot', value: 456 }, { name: 'harvest.wood', value: 998877 }, { name: 'bullet_fired', value: 54321 }] } });
      return realFetch(url, opts);
    };
    // server alerts: queue alert should fire (queue 17 <= 20), population alert should not (231 < 500), wipe alert should fire (lastBorn was 5h older)
    const favId = data.favorites[0].id;
    data.serverAlerts[favId] = { queueBelow: 20, playersAbove: 500, onWipe: true, qArmed: true, pArmed: true, lastBorn: Date.now() - 2 * 86400e3 - 5 * 3600e3 };
    const logBefore = data.log.length;
    await checkServerAlerts();
    const serverAlertEvents = data.log.length - logBefore;
    // ending-soon alert: a live campaign ending in 1h with one of two rewards claimed must alert once, and only once
    globalThis.__fakeKick = true; data.progress['kick:KICKTEST1:r1'] = { minutes: 60, claimed: 'manual' };
    const logBeforeEnd = data.log.length; await pollKick(); await pollKick();
    const endingEvents = data.log.slice(0, data.log.length - logBeforeEnd).filter((e) => /ends in about/.test(e.text)).length;
    const endingText = (data.log.find((e) => /ends in about/.test(e.text)) || {}).text || '';
    globalThis.__fakeKick = false; rt.campaigns = [];
    // 24h price change from the seeded history
    const movers = skinState().items.filter((i) => i.pct != null).map((i) => ({ n: i.name, pct: i.pct }));
    // quiet hours + csv
    data.settings.quietEnabled = true; data.settings.quietStart = '23:00'; data.settings.quietEnd = '08:00';
    const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
    const quiet = [inQuietHours(at(23, 30)), inQuietHours(at(3, 0)), inQuietHours(at(12, 0))];
    data.settings.quietStart = '09:00'; data.settings.quietEnd = '17:00';
    quiet.push(inQuietHours(at(12, 0)), inQuietHours(at(18, 0)));
    data.settings.quietEnabled = false; quiet.push(inQuietHours(at(23, 30)));
    data.steam.inventory.push({ hash: 'Door, "Special"', name: 'Door, "Special"', icon: '', count: 2, marketable: true, tradable: true, type: '', color: '' }, { hash: '=cmd', name: '=cmd|calc', icon: '', count: 1, marketable: false, tradable: false, type: '', color: '' });
    const skinsCsv = buildSkinsCsv(); const histCsv = buildHistoryCsv();
    const csvChecks = { bom: skinsCsv.charCodeAt(0) === 0xfeff, quoted: skinsCsv.includes('"Door, ""Special"""'), injectionGuarded: skinsCsv.includes("'=cmd|calc"), hasTotals: /After Steam fees/.test(skinsCsv), histHeader: histCsv.includes('Time,Type,Detail') };
    for (let i = 0; i < 25 && !newsItems.length; i++) await sleep(1000);
    push(); await sleep(1500);
    const shots = process.env.RDT_SHOTS;
    if (shots) {
      fs.mkdirSync(shots, { recursive: true });
      for (const tab of ['home', 'drops', 'skins', 'servers', 'news', 'calendar', 'stats', 'history', 'settings', 'watch']) {
        await win.webContents.executeJavaScript(`document.querySelector('nav button[data-tab=${tab}]').click()`);
        await sleep(2500);
        if (tab === 'servers') { await win.webContents.executeJavaScript(`document.querySelectorAll('.sv-row')[1].click()`); await sleep(6000); }
        if (tab === 'skins') {   // scroll down so the skin grid itself is captured
          await win.webContents.executeJavaScript(`document.querySelector('.content').scrollTo(0, 0)`);
        }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(shots, tab + '.png'), img.toPNG());
      }
    }
    const out = await win.webContents.executeJavaScript(`(function(){
      document.querySelector('nav button[data-tab=skins]').click();
      return JSON.stringify({
      invCount: ${JSON.stringify(0)} + (window.__invCount||0),
      title: document.title,
      cards: document.querySelectorAll('.card').length,
      rewards: document.querySelectorAll('.reward').length,
      tabs: [...document.querySelectorAll('nav button')].map(b => b.textContent),
      sample: (document.querySelector('.card h3')||{}).textContent,
      twitchStatus: (document.querySelector('#twitch-status')||{}).textContent,
      skins: document.querySelectorAll('.sk').length,
      skTotal: (document.querySelector('#sk-total')||{}).textContent,
      skCount: (document.querySelector('#sk-count')||{}).textContent,
      sparks: document.querySelectorAll('.sk .spark svg').length,
      bells: document.querySelectorAll('.sk .bell.on').length,
      chartSvg: document.querySelectorAll('#sk-chart svg').length,
      friends: document.querySelectorAll('#sv-friends .friend').length,
      friendsText: (document.querySelector('#sv-friends .fl')||{}).textContent,
      alertForm: document.querySelectorAll('#sv-detail .svalert').length,
      calCells: document.querySelectorAll('.cal-cell').length,
      calWipeChips: document.querySelectorAll('.cal-chip.ev-wipe').length,
      calTitle: (document.querySelector('#cal-title')||{}).textContent,
      statTiles: [...document.querySelectorAll('#st-tiles .tile')].map(t => t.textContent).join(' | '),
      statCards: document.querySelectorAll('#st-grid .stat').length,
      net: (document.querySelector('#sk-net')||{}).textContent,
      svRows: document.querySelectorAll('.sv-row').length,
      svDetail: (document.querySelector('#sv-detail h2')||{}).textContent,
      svStats: [...document.querySelectorAll('#sv-detail .sv-stats b')].map(b => b.textContent).join(' | '),
      svMapImgs: document.querySelectorAll('#sv-detail .mapbox img').length,
      newsCards: document.querySelectorAll('.ncard').length,
      readerChars: (document.querySelector('#news-reader .bb')||{textContent:''}).textContent.length,
      readerImgs: document.querySelectorAll('#news-reader img').length,
      countdown: (document.querySelector('#next-update .big')||{}).textContent,
      histEvents: document.querySelectorAll('.ev').length,
      histPrice: document.querySelectorAll('.ev .tag.price').length,
      errors: window.__errors || []
    })})()`);
    const raid = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // pure maths: 3 stone walls + 1 sheet metal wall, checked by hand
      const m = raidCompute({ explosives: RAID_DEFAULT.explosives, targets: RAID_DEFAULT.targets, qty: { stone: 3, metal: 1 } });
      const byId = Object.fromEntries(m.rows.map((r) => [r.id, r]));
      const math = { c4: byId.c4.count === 10 && byId.c4.sulfur === 22000, rocket: byId.rocket.count === 20 && byId.rocket.sulfur === 28000,
        satchel: byId.satchel.count === 53 && byId.satchel.sulfur === 25440, ammo: byId.ammo.count === 955 && byId.ammo.sulfur === 47750, best: m.best && m.best.id === 'c4' };
      const empty = raidCompute({ explosives: RAID_DEFAULT.explosives, targets: RAID_DEFAULT.targets, qty: {} });
      // UI: open the tab, type quantities, read the results panel
      document.querySelector('nav button[data-tab=raid]').click(); await sleep(300);
      const q = document.querySelectorAll('.rd-q');
      q[0].value = '3'; q[0].dispatchEvent(new Event('input')); q[1].value = '1'; q[1].dispatchEvent(new Event('input')); await sleep(300);
      const ui = { rows: document.querySelectorAll('#rd-table .rd-row').length - 1, results: document.querySelectorAll('.rd-res').length, bestText: (document.querySelector('.rd-res.best')||{textContent:''}).textContent, banner: !!document.querySelector('#tab-raid .banner') };
      // editing: change the C4 sulfur cost, results must update; then it must be saved
      document.querySelector('#rd-edit').click(); await sleep(200);
      const costInputs = document.querySelectorAll('#rd-costs input'); costInputs[0].value = '1000'; costInputs[0].dispatchEvent(new Event('change')); await sleep(200);
      const afterEdit = (document.querySelector('.rd-res.best')||{textContent:''}).textContent;
      const saved = JSON.parse(localStorage.getItem(RAID_KEY) || 'null');
      const persisted = !!saved && saved.explosives.find((e) => e.id === 'c4').sulfur === 1000 && saved.qty.stone === 3;
      return JSON.stringify({ math, emptyBest: empty.best === null, ui, afterEdit, persisted });
    })()`);
    console.log('SMOKE_RAID ' + raid);
    // home, command palette, theme, shortcuts
    const uiTest = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      showTab('home'); await sleep(900);
      const home = { tiles: document.querySelectorAll('#hm-tiles .tile').length, cards: document.querySelectorAll('#tab-home .hm-card').length, setup: !!document.querySelector('#hm-side .hm-step'),
        greeting: document.querySelector('#hm-greet').textContent, favRows: document.querySelectorAll('#hm-side .hm-row').length, brand: document.querySelector('.brand-text b').textContent, logoOk: document.querySelector('.logo-img').naturalWidth > 0 };
      // palette: Ctrl+K, type, Enter
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); await sleep(200);
      const palOpenOk = !document.querySelector('#palette').hidden;
      const inp = document.querySelector('#pal-input'); inp.value = 'go to serv'; inp.dispatchEvent(new Event('input')); await sleep(150);
      const palFirst = (document.querySelector('#pal-list .pal-item span') || {}).textContent;
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(400);
      const navigated = !document.querySelector('#tab-servers').hidden && document.querySelector('#palette').hidden;
      // Ctrl+3 goes to the third nav entry
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', ctrlKey: true, bubbles: true })); await sleep(300);
      const ctrl3 = !document.querySelector('#tab-watch').hidden;
      // theme
      setTheme('light'); await sleep(200); const light = document.documentElement.getAttribute('data-theme');
      setTheme('dark'); await sleep(100); const dark = document.documentElement.getAttribute('data-theme');
      showTab('home');
      return JSON.stringify({ home, palOpenOk, palFirst, navigated, ctrl3, light, dark });
    })()`);
    console.log('SMOKE_UI ' + uiTest);
    if (shots) {   // light theme renders for visual review (transitions off: a hidden window can freeze CSS fades half-way)
      await win.webContents.executeJavaScript(`(() => { const s = document.createElement('style'); s.textContent = '*{transition:none!important;animation:none!important}'; document.head.append(s); })()`);
      for (const tab of ['home', 'skins', 'servers', 'settings']) {
        await win.webContents.executeJavaScript(`setTheme('light'); showTab('${tab}');`);
        await sleep(1800);
        fs.writeFileSync(path.join(shots, tab + '-light.png'), (await win.webContents.capturePage()).toPNG());
      }
      await win.webContents.executeJavaScript(`setTheme('dark')`);
    }
    if (shots) {
      await win.webContents.executeJavaScript(`(async()=>{ document.querySelector('#rd-edit').click(); await new Promise(r=>setTimeout(r,300)); })()`);
      fs.writeFileSync(path.join(shots, 'raid.png'), (await win.webContents.capturePage()).toPNG());
    }
    // ---- extras: build ideas, watchlist, planner, pins, streaks, sounds, overlay
    {
      const today = dayKey(); data.watchDays = { [today]: 42, [dayKey(Date.now() - 864e5)]: 60, [dayKey(Date.now() - 2 * 864e5)]: 25, [dayKey(Date.now() - 5 * 864e5)]: 90 };
      data.watchlist = []; push(); await sleep(300);
      await win.webContents.executeJavaScript(`showTab('builds')`);
      for (let i = 0; i < 25; i++) { const n = await win.webContents.executeJavaScript(`document.querySelectorAll('#bd-grid .bd').length`); if (n) break; await sleep(1000); }
      const builds = await win.webContents.executeJavaScript(`(async()=>{
        const n = document.querySelectorAll('#bd-grid .bd').length;
        const chips = document.querySelectorAll('#bd-chips .chip').length;
        const first = (document.querySelector('#bd-grid .bd .tt')||{}).textContent;
        const hot = document.querySelectorAll('#bd-grid .hot').length;
        const src = document.querySelectorAll('#bd-sources .srcrow').length;
        document.querySelector('#bd-chips .chip:nth-child(2)').click(); await new Promise(r=>setTimeout(r,200));
        const soloOnly = [...document.querySelectorAll('#bd-grid .tt')].every(t=>/solo/i.test(t.textContent));
        document.querySelector('#bd-chips .chip:nth-child(1)').click();
        const bad = await window.api.buildsAdd('https://evil.example/@x');
        return JSON.stringify({ n, chips, first, hot, src, soloOnly, badAddRejected: !!bad.error });
      })()`);
      await win.webContents.executeJavaScript(`showTab('skins')`); await sleep(500);
      const watch = await win.webContents.executeJavaScript(`(async()=>{
        const r = await window.api.watchSearch('tempered'); const ok = await window.api.watchAdd(r.results[0]); const dup = await window.api.watchAdd(r.results[0]);
        await new Promise(r=>setTimeout(r,6000));
        const st = await window.api.state(); const w = st.watchlist[0] || {};
        return JSON.stringify({ results: r.results.length, ok, dup, count: st.watchlist.length, lowest: w.lowest, cards: document.querySelectorAll('#wl-grid .sk').length, iconOk: /^https:\\/\\/community/.test(w.icon||'') });
      })()`);
      const planner = await win.webContents.executeJavaScript(`(async()=>{
        showTab('planner'); await new Promise(r=>setTimeout(r,500));
        const items = document.querySelectorAll('#pl-list .pl-item').length;
        document.querySelector('#pl-list input[type=checkbox]').click(); await new Promise(r=>setTimeout(r,400));
        const done = (await window.api.state()).kv.plan.items.filter(i=>i.done).length;
        document.querySelector('#pl-new').value = 'Test step'; document.querySelector('#pl-add').click(); await new Promise(r=>setTimeout(r,400));
        const after = document.querySelectorAll('#pl-list .pl-item').length;
        const resetKey = (await window.api.state()).kv.plan.wipeKey;
        return JSON.stringify({ items, done, after, countdown: document.querySelector('#pl-wipe .hero-num').textContent, wipeKeyPast: resetKey > 0 && resetKey <= Date.now() });
      })()`);
      const pins = await win.webContents.executeJavaScript(`(async()=>{
        const box = document.createElement('div'); box.className = 'mapbox'; box.style.cssText = 'position:fixed;left:10px;top:10px;width:200px;height:200px'; document.body.append(box);
        const btn = attachPins(box, { seed: 42, size: 3000 }, { id: '1.2.3.4:28015', name: 'Pin Test' }); document.body.append(btn); btn.click();
        box.dispatchEvent(new MouseEvent('click', { clientX: 110, clientY: 60, bubbles: true }));
        const form = document.querySelector('input[maxlength="40"]'); form.value = 'Test base'; form.nextSibling.click();
        await new Promise(r=>setTimeout(r,400));
        const g = Object.values((await window.api.state()).kv.pins||{})[0] || {};
        const p = (g.pins||[])[0] || {};
        const drawn = box.querySelectorAll('.pin').length;
        showTab('planner'); await new Promise(r=>setTimeout(r,300));
        const listed = document.querySelectorAll('#pl-pins .srcrow').length;
        box.remove(); btn.remove();
        return JSON.stringify({ x: p.x, y: p.y, label: p.label, drawn, listed });
      })()`);
      const streaks = await win.webContents.executeJavaScript(`(async()=>{
        showTab('stats'); await new Promise(r=>setTimeout(r,500));
        const box = document.querySelector('#st-streaks'); return JSON.stringify({ tiles: box ? box.querySelectorAll('.tile').length : 0, streakText: box ? box.querySelector('.tile b').textContent : '', bars: box ? box.querySelectorAll('.daybars i').length : 0 });
      })()`);
      // cost tracking / profit-loss
      const hadDoor = data.steam.inventory.some((i) => i.hash === 'Test Door');
      const costOk = hadDoor ? await win.webContents.executeJavaScript(`window.api.costSet('Test Door', '2.50')`) : null;
      const sk = skinState(); const door = sk.items.find((i) => i.hash === 'Test Door');
      const csvCost = buildSkinsCsv();
      await win.webContents.executeJavaScript(`showTab('skins')`); await sleep(700);
      const costUi = await win.webContents.executeJavaScript(`JSON.stringify({ link: [...document.querySelectorAll('#sk-grid .sk a')].some(a => /Paid/.test(a.textContent)), pl: document.querySelector('#sk-pl').textContent })`);
      const costCleared = hadDoor ? (await win.webContents.executeJavaScript(`window.api.costSet('Test Door', '')`)) && skinState().items.find((i) => i.hash === 'Test Door').paid === null : null;
      // favourite wipe alerts without an explicit alert: baseline first, then a newer wipe fires one
      const savedA2s = servers.a2s; let bornNow = Date.now() - 5 * 86400e3;
      servers.a2s = async (ip, port, kind) => (kind === 'info' ? { name: 'f2', map: 'x', players: 5, max: 100, queue: 0, ping: 10, born: bornNow, tags: [] } : {});
      const prevFavs = data.favorites; const prevAlerts = data.serverAlerts;
      data.favorites = [{ id: '9.9.9.9:28015', ip: '9.9.9.9', qport: 28017, gport: 28015, name: 'Fav Two' }]; data.serverAlerts = {}; data.wipeSeen = {};
      const l0 = data.log.length; await checkServerAlerts(); const afterBaseline = data.log.length - l0;
      bornNow = Date.now() - 600e3; await checkServerAlerts(); const afterWipe = data.log.slice(0, data.log.length - l0).filter((e) => e.type === 'server' && /Fav Two: Just wiped/.test(e.text)).length;
      data.settings.wipeAlertsFavs = false; bornNow = Date.now(); const l1 = data.log.length; await checkServerAlerts(); const whenOff = data.log.length - l1;
      data.settings.wipeAlertsFavs = true; servers.a2s = savedA2s; data.favorites = prevFavs; data.serverAlerts = prevAlerts;
      // update check against a stubbed GitHub release
      const fetchBefore = globalThis.fetch; data.settings.updateRepo = 'someone/wipewatch';
      globalThis.fetch = async (u, o) => (String(u).startsWith('https://api.github.com/') ? new Response(JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://github.com/someone/wipewatch/releases/tag/v9.9.9', body: 'Test notes', assets: [{ name: 'Wipewatch-Setup-9.9.9.exe', browser_download_url: 'https://github.com/someone/wipewatch/releases/download/v9.9.9/Wipewatch-Setup-9.9.9.exe' }] }), { status: 200 }) : fetchBefore(u, o));
      const up = await checkUpdate(true); const upBad = (data.settings.updateRepo = 'not a repo', await checkUpdate(true)); data.settings.updateRepo = '';
      globalThis.fetch = fetchBefore;
      const update = { found: up.update && up.update.version, asset: !!(up.update && up.update.asset), cmp: [isNewer('v1.3.0', '1.3.0'), isNewer('1.10.0', '1.9.9'), isNewer('2.0.0', '1.99.99'), isNewer('1.2.9', '1.3.0')], badRepoRejected: !!upBad.error };
      data.update = null;
      // ---- friends + clan end to end: a real throwaway server, this app as one user, a simulated second user
      let socialTest = 'skipped';
      try {
        if (!FEATURES.social) throw new Error('not part of this edition');
        const { createServer } = require('../server/server'); const { SocialClient } = require('./social-client');
        const sdir = fs.mkdtempSync(path.join(app.getPath('temp'), 'ww-srv-')); const srv = createServer({ dataDir: sdir }); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
        const base = 'http://127.0.0.1:' + srv.address().port;
        const setup = await win.webContents.executeJavaScript(`window.api.socialSetup({ server: '${base}', name: 'SmokeMe' })`);
        const rival = new SocialClient(base); const rr = await rival.register('Rival_One'); rival.token = rr.token;
        await rival.pushSnapshot({ value: { total: 412.5, net: 358.7, count: 88, currency: 'USD', top: [{ name: 'Tempered Mask', each: 200.85, count: 1 }, { name: 'Glowing Door', each: 4.1, count: 3 }] },
          activity: [{ t: Date.now() - 3600e3, type: 'claim', text: 'Garage Door claimed' }, { t: Date.now() - 7200e3, type: 'price', text: 'Tempered Mask dropped to 200.85 USD' }], servers: [{ name: 'Rusty Moose |US Main|', t: Date.now() - 1800e3 }, { name: 'Rustoria.co - US Long III', t: Date.now() - 86400e3 }], hours: 1204.5, playing: 'Rusty Moose |US Main|' });
        await rival.friendRequest('SmokeMe');
        await win.webContents.executeJavaScript(`window.api.socialRefresh()`); await sleep(600);
        await win.webContents.executeJavaScript(`showTab('friends')`); await sleep(1200);
        const sawReq = await win.webContents.executeJavaScript(`[...document.querySelectorAll('#fr-body .srcrow')].some(r => /Rival_One/.test(r.textContent))`);
        await win.webContents.executeJavaScript(`[...document.querySelectorAll('#fr-body .btn')].find(b => b.textContent === 'Accept').click()`); await sleep(1500);
        await win.webContents.executeJavaScript(`document.querySelector('.friend-card').click()`); await sleep(1500);
        const prof = await win.webContents.executeJavaScript(`JSON.stringify({ name: (document.querySelector('.prof h3')||{}).textContent, tiles: [...document.querySelectorAll('.prof-tiles .tile b')].map(b => b.textContent), servers: [...document.querySelectorAll('.prof-sec')].map(x => x.querySelector('h4').textContent) })`);
        if (shots) fs.writeFileSync(path.join(shots, 'x-friends.png'), (await win.webContents.capturePage()).toPNG());
        await rival.updateMe({ share: { value: false } }); await win.webContents.executeJavaScript(`document.querySelector('.friend-card').click()`); await sleep(1200);
        const hiddenNote = await win.webContents.executeJavaScript(`/does not share their skin value/.test(document.querySelector('.prof').textContent)`);
        await rival.updateMe({ share: { value: true } });
        // clan: create, invite the rival, they accept
        await win.webContents.executeJavaScript(`showTab('clan')`); await sleep(900);
        await win.webContents.executeJavaScript(`(async()=>{ const r = await window.api.socialCall('clanCreate', 'Smoke Squad', 'smk'); return r; })()`); await sleep(900);
        await win.webContents.executeJavaScript(`window.api.socialCall('clanInvite', 'Rival_One')`);
        const inv = await rival.clanInvites(); await rival.clanAccept(inv.invites[0].id);
        await win.webContents.executeJavaScript(`window.api.socialRefresh()`); await sleep(900);
        await win.webContents.executeJavaScript(`showTab('clan'); document.querySelectorAll('#cl-body .friend-card')[1].click()`); await sleep(1200);
        const clan = await win.webContents.executeJavaScript(`JSON.stringify({ title: (document.querySelector('#cl-body .hero-num')||{}).textContent, members: document.querySelectorAll('#cl-body .friend-card').length, stats: [...document.querySelectorAll('#cl-body .hero-stats b')].map(b => b.textContent), sel: CL.sel, panel: !!document.querySelector('#cl-body .prof'), panelName: (document.querySelector('#cl-body .prof h3')||{}).textContent })`);
        if (shots) fs.writeFileSync(path.join(shots, 'x-clan.png'), (await win.webContents.capturePage()).toPNG());
        // the published snapshot must never carry secrets
        const snapJson = JSON.stringify(social.buildSnapshot()); const leak = [data.settings.webhook, data.settings.steamApiKey, data.steam.id64, data.social.token].filter(Boolean).some((v) => snapJson.includes(v));
        const priceLeak = /your alert/i.test(snapJson);
        await win.webContents.executeJavaScript(`window.api.socialCall('clanDisband')`);
        const backupCopy = JSON.parse(JSON.stringify(data)); backupCopy.social = { ...backupCopy.social, token: '', id: '' };
        socialTest = { setup, sawReq, prof: JSON.parse(prof), hiddenNote, clan: JSON.parse(clan), leak, priceLeak, tokenKept: !!data.social.token, backupTokenCleared: backupCopy.social.token === '' };
        social.state && clearInterval(social.state.snapshotTimer); clearInterval(social.state.pollTimer); srv.flush(); srv.close();
      } catch (e) { socialTest = 'ERROR ' + e.message; }
      const sound = await win.webContents.executeJavaScript(`(()=>{ try { playSound({ mode: 'airdrop', volume: 0, kind: 'drop' }); playSound({ mode: 'radar', volume: 0 }); playSound({ mode: 'chime', volume: 0 }); return 'ok'; } catch (e) { return 'ERR ' + e.message; } })()`);
      let overlay = 'skipped';
      if (process.env.RDT_OVERLAY) {
        data.settings.overlayOn = true; data.favorites = data.favorites.length ? data.favorites : []; syncOverlay(); await sleep(3500); push(); await sleep(800);
        if (overlayWin && !overlayWin.isDestroyed()) {
          overlay = JSON.stringify(await overlayWin.webContents.executeJavaScript(`({ text: document.getElementById('ov').innerText.replace(/\\s+/g,' ') })`));
          if (shots) fs.writeFileSync(path.join(shots, 'overlay.png'), (await overlayWin.webContents.capturePage()).toPNG());
        } else overlay = 'no overlay window';
      }
      if (shots) for (const tab of ['builds', 'planner', 'skins', 'stats', 'settings']) { await win.webContents.executeJavaScript(`showTab('${tab}'); document.querySelector('.content').scrollTo(0, ${tab === 'skins' ? 99999 : 0})`); await sleep(1500); fs.writeFileSync(path.join(shots, 'x-' + tab + '.png'), (await win.webContents.capturePage()).toPNG()); }
      const xerrors = await win.webContents.executeJavaScript(`JSON.stringify(window.__errors)`);
      console.log('SMOKE_EXTRAS ' + JSON.stringify({ builds: JSON.parse(builds), watch: JSON.parse(watch), planner: JSON.parse(planner), pins: JSON.parse(pins), streaks: JSON.parse(streaks), social: socialTest, cost: { costOk, paid: door && door.paid, pl: sk.pl, csv: /Paid each/.test(csvCost) && /Profit\/loss/.test(csvCost), ui: JSON.parse(costUi), costCleared }, wipeFav: { afterBaseline, afterWipe, whenOff }, update, sound, overlay, errors: JSON.parse(xerrors) }));
    }
    console.log('SMOKE_RESULT ' + out);
    console.log('SMOKE_BACKEND ' + JSON.stringify({ endingEvents, endingText, movers, serverAlertEvents, quiet, csvChecks, serverEventsInLog: data.log.filter((e) => e.type === 'server').map((e) => e.text) }));
    quitting = true; app.exit(0);
  }
});
app.on('window-all-closed', (e) => { if (!quitting) e.preventDefault(); });
