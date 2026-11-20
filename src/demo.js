'use strict';
// Demo mode (development only, not shipped): fills the app with sample data, then captures clean screenshots and an animated PNG
// for the README. Run:  RDT_DEMO=1 RDT_SHOTS=<outdir> electron . --smoke
// Skin names, icons and prices are real public Steam Market listings; everything else (servers, friends, drops, activity) is made up.
const fs = require('fs');
const path = require('path');

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr, i) => arr[i % arr.length];

module.exports = async function runDemo(ctx) {
  const { win, data, rt, push, sleep, serverCache, servers, outDir, getNews, startSocialServer, SocialClient } = ctx;
  const shotsDir = path.join(outDir, 'screenshots'); fs.mkdirSync(shotsDir, { recursive: true });
  const log = (...a) => console.log('[demo]', ...a);
  const js = (code) => win.webContents.executeJavaScript(code);
  win.setSize(1280, 800); await sleep(800);

  // ---------------------------------------------------------------- skins: real public market listings
  // market listings are fetched beforehand by tools/fetch-demo-market.js (RDT_MARKET=<file>); the app's own fetch gets rate limited by Steam more aggressively
  const found = process.env.RDT_MARKET ? JSON.parse(fs.readFileSync(process.env.RDT_MARKET, 'utf8')) : [];
  log('market items:', found.length);
  const items = found.filter((f) => f.price >= 0.8).sort(() => Math.random() - 0.5).slice(0, 18);
  const now = Date.now();
  data.steam.id64 = '76561190000000001'; data.steam.inventory = []; data.prices = {}; data.history = {}; data.costs = {}; data.alerts = {};
  items.forEach((f, i) => {
    const count = i % 5 === 0 ? 3 : i % 4 === 0 ? 2 : 1;
    data.steam.inventory.push({ hash: f.hash, name: f.name, icon: f.icon, count, marketable: true, tradable: true, type: '', color: f.color });
    const med = f.price * rnd(1.0, 1.06);
    data.prices[f.hash] = { lowest: f.price, median: +med.toFixed(2), lowestText: '$' + f.price.toFixed(2), medianText: '$' + med.toFixed(2), volume: String(Math.round(rnd(4, 90))), currency: 1, at: now };
    let p = f.price * rnd(0.88, 1.0); const series = [];
    for (let k = 0; k < 26; k++) { p = Math.max(0.2, p * rnd(0.985, 1.02)); series.push([now - (26 - k) * 5.5 * 3600e3, +p.toFixed(2), 1]); }
    series[series.length - 1] = [now, f.price, 1]; data.history[f.hash] = series;
    if (i % 3 === 0) data.costs[f.hash] = +(f.price * rnd(0.55, 1.1)).toFixed(2);
  });
  const total = data.steam.inventory.reduce((a, it) => a + data.prices[it.hash].lowest * it.count, 0);
  data.valueHistory = Array.from({ length: 60 }, (_, k) => [now - (60 - k) * 4 * 3600e3, +(total * (0.82 + (k / 60) * 0.17 + Math.sin(k / 5) * 0.012)).toFixed(2), 1]);
  data.valueHistory[59] = [now, +total.toFixed(2), 1];
  if (items[1]) data.alerts[items[1].hash] = { dir: 'above', price: +(items[1].price * 1.15).toFixed(2), armed: true };
  data.watchlist = found.filter((f) => !items.includes(f)).slice(0, 4).map((f) => ({ hash: f.hash, name: f.name, icon: f.icon, color: f.color }));
  for (const w of data.watchlist) { const f = found.find((x) => x.hash === w.hash); data.prices[w.hash] = { lowest: f.price, median: f.price * 1.02, lowestText: '', medianText: '', volume: '30', currency: 1, at: now }; let p = f.price * 0.93; data.history[w.hash] = Array.from({ length: 20 }, (_, k) => [now - (20 - k) * 6 * 3600e3, +(p *= rnd(0.99, 1.015)).toFixed(2), 1]); }
  data.settings.steamApiKey = 'demo'; data.settings.webhook = ''; data.settings.updateRepo = '';

  // ---------------------------------------------------------------- drops (made up)
  rt.campaigns = [{ platform: 'kick', id: 'demo1', name: 'Summer Drops Event', status: 'live', start: now - 2 * 86400e3, end: now + 5 * 86400e3, connectUrl: 'https://kick.com/drops', org: '', channels: ['demo_streamer_one', 'demo_streamer_two'],
    rewards: [{ key: 'kick:demo1:a', name: 'Garage Door', minutes: 60, image: '' }, { key: 'kick:demo1:b', name: 'Workbench Skin', minutes: 120, image: '' }, { key: 'kick:demo1:c', name: 'Rock Skin', minutes: 240, image: '' }] }];
  data.progress = { 'kick:demo1:a': { minutes: 60, claimed: 'manual', claimedAt: now - 3600e3 }, 'kick:demo1:b': { minutes: 78, claimed: null }, 'kick:demo1:c': { minutes: 12, claimed: null } };
  data.log = [
    { t: now - 25 * 60e3, type: 'claim', text: 'Garage Door marked as claimed' },
    { t: now - 3 * 3600e3, type: 'price', text: `${items[1] ? items[1].name : 'Tempered AK47'} rose to $${items[1] ? (items[1].price * 1.02).toFixed(2) : '31.20'} USD` },
    { t: now - 9 * 3600e3, type: 'ready', text: 'Workbench Skin reached 120 minutes - ready to claim' },
    { t: now - 30 * 3600e3, type: 'patch', text: 'New Rust update: PRINTED AND POLISHED' },
    { t: now - 50 * 3600e3, type: 'claim', text: 'Rock Skin found in your Steam inventory' },
  ];
  data.watchDays = { [shortDay(0)]: 55, [shortDay(1)]: 90, [shortDay(2)]: 40, [shortDay(3)]: 75, [shortDay(5)]: 120, [shortDay(6)]: 60 };
  function shortDay(back) { const d = new Date(Date.now() - back * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

  // ---------------------------------------------------------------- servers (made up)
  const regions = ['North America', 'Europe', 'Oceania', 'South America'];
  const brands = ['Iron Ridge', 'Sunset Raiders', 'Pine Valley', 'Cold Harbor', 'Redwood', 'Lone Pine', 'Granite Peak', 'Night Shift'];
  const modes = [['vanilla', 'monthly'], ['vanilla', 'biweekly'], ['pve', 'monthly'], ['modded', 'weekly'], ['vanilla', 'weekly']];
  serverCache.list = Array.from({ length: 48 }, (_, i) => ({ id: `10.0.${Math.floor(i / 10)}.${i % 10 + 1}:28015`, ip: `10.0.${Math.floor(i / 10)}.${i % 10 + 1}`, qport: 28017, gport: 28015,
    name: `${pick(brands, i)} ${pick(['2x', '3x', 'Vanilla', 'Main', 'Solo/Duo'], i + 2)} | ${pick(['US East', 'EU West', 'AU', 'US West'], i)} #${i + 1}`,
    players: 280 - i * 5 + (i % 3), max: 300, queue: i % 4 === 0 ? Math.max(3, 38 - i) : 0, born: now - ((i % 9) * 86400e3 + 3 * 3600e3), map: 'Procedural Map', region: pick(regions, i), tags: pick(modes, i) }));
  serverCache.at = Date.now();
  data.favorites = [serverCache.list[0], serverCache.list[2], serverCache.list[5]].map((s) => ({ id: s.id, ip: s.ip, qport: 28017, gport: 28015, name: s.name }));
  data.serverAlerts = { [serverCache.list[0].id]: { queueBelow: 10, playersAbove: null, onWipe: true, qArmed: true, pArmed: true, lastBorn: serverCache.list[0].born } };
  servers.a2s = async (ip, port, kind) => kind === 'info'
    ? (() => { const s = serverCache.list.find((x) => x.ip === ip) || serverCache.list[0]; return { name: s.name, map: 'Procedural Map', players: s.players, max: 300, queue: s.queue, ping: 34, born: s.born, tags: s.tags }; })()
    : { 'world.seed': '1239791257', 'world.size': '3500', description_00: 'A demo server for the screenshots. Wipes on the first Thursday of the month.\nBe kind, no cheating.' };
  data.kv = data.kv || {};
  data.kv.pins = { [`${serverCache.list[0].id}|1239791257|3500`]: { id: serverCache.list[0].id, name: serverCache.list[0].name, seed: 1239791257, size: 3500, pins: [{ id: 'p1', x: 41, y: 58, label: 'Main base' }, { id: 'p2', x: 63, y: 34, label: 'Farm outpost' }] } };
  data.kv.plan = { items: ['Pick a server and join right at wipe', 'Gather wood, stone and cloth', 'Craft and place a sleeping bag', 'Hit the first monuments for scrap', 'Research / build a workbench', 'Choose the base spot and place the tool cupboard', 'Code locks on every door', 'Stock food, water and medical']
    .map((t, i) => ({ id: 'd' + i, text: t, done: i < 5 })), wipeKey: lastThursday(), notes: 'Team: Nova + Dusty\nBase: honeycomb at the river bend\nFarm sulfur first, then electricity.' };
  function lastThursday() { const n = new Date(); for (let i = 0; i <= 1; i++) { const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - i, 1, 19)); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1 + ((4 - d.getUTCDay() + 7) % 7), 19)); if (t.getTime() <= Date.now()) return t.getTime(); } return 0; }

  // Steam endpoints used by Home / Servers / My Stats
  const realFetch = globalThis.fetch; const jres = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('GetFriendList')) return jres({ friendslist: { friends: [{ steamid: '1' }, { steamid: '2' }, { steamid: '3' }, { steamid: '4' }, { steamid: '5' }] } });
    if (u.includes('GetPlayerSummaries')) {
      if (u.includes('steamids=1%2C2')) return jres({ response: { players: [
        { steamid: '1', personaname: 'NovaFox', gameid: '252490', gameserverip: serverCache.list[0].id, personastate: 1, avatarmedium: '' },
        { steamid: '2', personaname: 'Dusty_Pete', gameid: '252490', gameserverip: serverCache.list[2].id, personastate: 1 }, { steamid: '3', personaname: 'Mara', personastate: 1 }, { steamid: '4', personaname: 'Quill', personastate: 0 }, { steamid: '5', personaname: 'Ironside', personastate: 0 }] } });
      return jres({ response: { players: [{ steamid: data.steam.id64, personaname: 'Scout', avatarfull: '', profileurl: 'https://steamcommunity.com/' }] } });
    }
    if (u.includes('GetOwnedGames')) return jres({ response: { games: [{ appid: 252490, playtime_forever: 40560, playtime_2weeks: 780, rtime_last_played: Math.floor(Date.now() / 1000) - 7200 }] } });
    if (u.includes('GetUserStatsForGame')) return jres({ playerstats: { stats: [{ name: 'kill_player', value: 1482 }, { name: 'deaths', value: 1211 }, { name: 'headshot', value: 903 }, { name: 'harvested_wood', value: 612340 }, { name: 'harvested_stones', value: 388120 }, { name: 'bullet_fired', value: 48210 }, { name: 'acquired_scrap', value: 31544 }, { name: 'kill_scientist', value: 211 }] } });
    return realFetch(url, opts);
  };

  // ---------------------------------------------------------------- friends + clan (a real throwaway server, simulated players)
  const { base } = await startSocialServer();
  const mk = async (name, snap) => { const c = new SocialClient(base); const r = await c.register(name); c.token = r.token; await c.pushSnapshot(snap); return c; };
  const act = (min, type, text) => ({ t: now - min * 60e3, type, text });
  const people = {
    NovaFox: await mk('NovaFox', { value: { total: 612.4, net: 532.5, count: 131, currency: 'USD', top: [{ name: items[0] ? items[0].name : 'Tempered AK47', each: 84.2, count: 1 }, { name: 'Glowing Door', each: 6.3, count: 4 }] }, activity: [act(40, 'claim', 'Garage Door claimed'), act(300, 'price', 'Punishment Mask rose to $212.40 USD')], servers: [{ name: serverCache.list[0].name, t: now - 1200e3 }, { name: serverCache.list[3].name, t: now - 86400e3 }], hours: 2310.5, playing: serverCache.list[0].name }),
    Dusty_Pete: await mk('Dusty_Pete', { value: { total: 148.9, net: 129.5, count: 44, currency: 'USD', top: [{ name: 'Whiteout AR', each: 22.4, count: 1 }] }, activity: [act(120, 'ready', 'Workbench Skin reached 120 minutes - ready to claim')], servers: [{ name: serverCache.list[2].name, t: now - 3600e3 }], hours: 874, playing: serverCache.list[2].name }),
    Mara: await mk('Mara', { value: { total: 36.2, net: 31.5, count: 12, currency: 'USD', top: [{ name: 'Hazmat Suit', each: 9.1, count: 1 }] }, activity: [act(900, 'claim', 'Rock Skin found in your Steam inventory')], servers: [{ name: serverCache.list[5].name, t: now - 7200e3 }], hours: 301.2 }),
    Quill: await mk('Quill', { value: { total: 905.7, net: 787.6, count: 210, currency: 'USD', top: [{ name: 'Tempered Mask', each: 200.85, count: 2 }] }, activity: [act(2600, 'patch', 'New Rust update: PRINTED AND POLISHED')], servers: [{ name: serverCache.list[1].name, t: now - 30 * 3600e3 }], hours: 5120 }),
  };
  const setup = await js(`window.api.socialSetup({ server: '${base}', name: 'Scout' })`); log('social setup', JSON.stringify(setup));
  for (const [name, c] of Object.entries(people)) await c.friendRequest('Scout');
  await js(`window.api.socialRefresh()`); await sleep(500);
  for (const name of Object.keys(people)) await js(`window.api.socialCall('friendAccept', '${name}')`);
  await js(`window.api.socialCall('clanCreate', 'Night Owls', 'OWL')`);
  for (const name of ['NovaFox', 'Dusty_Pete', 'Mara']) { await js(`window.api.socialCall('clanInvite', '${name}')`); const inv = await people[name].clanInvites(); await people[name].clanAccept(inv.invites[0].id); }
  await js(`window.api.socialRefresh()`);

  // wait for news + builds (real public data)
  for (let i = 0; i < 25 && !getNews(); i++) await sleep(1000);
  await js(`window.api.buildsGet(true)`);
  push(); await sleep(1500);

  const capture = async (name, dir = shotsDir) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG()); };
  const go = async (tab, wait = 2200) => { await js(`document.querySelector('nav button[data-tab=${tab}]').click()`); await sleep(wait); };

  // ---------------------------------------------------------------- screenshots
  await js(`(() => { const s = document.createElement('style'); s.textContent = '*{transition:none!important;animation:none!important}'; document.head.append(s); })()`);
  await go('home', 3000); await js(`homeFetchedAt = 0; renderHome();`); await sleep(7000); await js(`document.querySelector('#hm-greet').textContent = 'Good evening'`); await capture('home');
  await go('drops'); await capture('drops');
  await go('skins'); await js(`document.querySelector('.content').scrollTo(0, 0)`); await sleep(1200); await capture('skins');
  await go('servers', 2500); await js(`document.querySelectorAll('.sv-row')[0].click()`); await sleep(7000); await capture('servers');
  await go('friends', 2500); await js(`document.querySelector('.friend-card').click()`); await sleep(1500); await js(`document.querySelector('.soc-me .prof-head .muted').textContent = 'Your Wipewatch profile on wipewatch.example.com'`); await capture('friends');
  await go('clan', 2500); await js(`document.querySelectorAll('#cl-body .friend-card')[1].click()`); await sleep(1200); await capture('clan');
  await go('builds', 4500); await capture('build-ideas');
  await go('planner'); await capture('wipe-planner');
  await go('news', 3000); await capture('patch-notes');
  await go('raid'); await capture('raid-calculator');
  await go('calendar'); await capture('calendar');
  await go('stats', 3000); await capture('my-stats');
  await js(`document.querySelector('#ab-path').textContent = 'Data: %APPDATA%\\\\Rust Drops Tracker'`);
  await go('settings'); await js(`document.querySelector('#ab-path').textContent = 'Data: %APPDATA%\\\\Rust Drops Tracker'`); await sleep(300); await capture('settings');

  // ---------------------------------------------------------------- animated demo
  const { makeApng } = require('../tools/apng');
  const small = async () => { const img = await win.webContents.capturePage(); return img.resize({ width: 960, quality: 'best' }).toPNG(); };
  const frames = [];
  // launch animation: reload with the intro enabled and step through its timeline
  await win.loadFile(path.join(__dirname, 'index.html')); await sleep(600);
  await js(`document.getElementById('intro').classList.add('go')`); await sleep(60);
  await js(`document.querySelectorAll('style').forEach(s => { if (/transition:none/.test(s.textContent)) s.remove(); })`);
  for (const t of [250, 700, 1000, 1180, 1350, 1600, 1900, 2300, 2700]) {
    await js(`document.getAnimations().forEach(a => { a.pause(); a.currentTime = ${t}; })`); await sleep(120);
    frames.push({ png: await small(), delayMs: t < 1000 ? 150 : 170 });
  }
  await sleep(900); await js(`document.getAnimations().forEach(a => a.cancel()); document.querySelector('#intro') && document.querySelector('#intro').remove(); (() => { const s = document.createElement('style'); s.textContent = '*{transition:none!important;animation:none!important}'; document.head.append(s); })()`);
  const tour = [['home', 'Home', 1500], ['drops', 'Drops', 1300], ['skins', 'Skins', 1700], ['servers', 'Servers', 1700], ['friends', 'Friends', 1500], ['clan', 'Clan', 1500], ['builds', 'Build Ideas', 1500], ['planner', 'Wipe Planner', 1400], ['news', 'Patch Notes', 1400], ['raid', 'Raid Calc', 1200]];
  for (const [tab, , hold] of tour) {
    await go(tab, tab === 'servers' ? 1800 : tab === 'builds' ? 2500 : 1300);
    if (tab === 'home') { await js(`homeFetchedAt = 0; renderHome();`); await sleep(6000); await js(`document.querySelector('#hm-greet').textContent = 'Good evening'`); }
    if (tab === 'servers') { await js(`document.querySelectorAll('.sv-row')[0].click()`); await sleep(4500); }
    if (tab === 'friends') { await js(`document.querySelector('.friend-card').click()`); await sleep(900); await js(`document.querySelector('.soc-me .prof-head .muted').textContent = 'Your Wipewatch profile on wipewatch.example.com'`); }
    if (tab === 'clan') { await js(`document.querySelectorAll('#cl-body .friend-card')[1].click()`); await sleep(900); }
    frames.push({ png: await small(), delayMs: hold });
  }
  fs.writeFileSync(path.join(outDir, 'demo.png'), makeApng(frames, 0));
  log('done:', frames.length, 'frames');
};
