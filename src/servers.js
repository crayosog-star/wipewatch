'use strict';
// Rust server list + live server queries.
//  * List:   Steam's official IGameServersService/GetServerList (needs a free Steam Web API key).
//  * Detail: Valve's public A2S UDP query protocol sent straight to the game server (player count, queue, map seed/size).
//  * Map:    RustMaps public map pages (terrain image + monument icons) looked up by size_seed.
const dgram = require('dgram');

const UA = 'RustDropsTracker/1.0';
const REGIONS = { 0: 'US East', 1: 'US West', 2: 'South America', 3: 'Europe', 4: 'Asia', 5: 'Australia', 6: 'Middle East', 7: 'Africa', 255: 'World' };
// Real Rust server tags carry a bare region code (NA, EU, ...) and short flags: ^m monthly, ^w weekly, ^b biweekly, ^p pve, ^h hardcore (inferred from the live list)
const REGION_CODES = { na: 'North America', eu: 'Europe', sa: 'South America', ea: 'East Asia', wa: 'West Asia', oc: 'Oceania', af: 'Africa' };
const FLAG_TAGS = { '^m': 'monthly', '^w': 'weekly', '^b': 'biweekly', '^p': 'pve', '^h': 'hardcore', gmvanilla: 'vanilla' };
const KNOWN_TAGS = ['pve', 'modded', 'vanilla', 'weekly', 'biweekly', 'monthly', 'softcore', 'hardcore', 'roleplay', 'creative', 'minigame', 'training', 'battlefield', 'broyale', 'builder', 'oxide', 'carbon'];

// Rust puts its live stats in the server "tags": e.g. "mp200,cp143,qp12,born1730000000,pve,monthly"
function parseTags(str) {
  const out = { cp: null, qp: null, mp: null, born: null, tags: [], region: '' };
  for (const tok of String(str || '').split(',')) {
    const t = tok.trim().toLowerCase(); if (!t) continue;
    const m = /^(mp|cp|qp|born)(\d+)$/.exec(t);
    if (m) out[m[1]] = parseInt(m[2], 10);
    else if (REGION_CODES[t]) out.region = REGION_CODES[t];
    else { const k = FLAG_TAGS[t] || (KNOWN_TAGS.includes(t) ? t : ''); if (k && !out.tags.includes(k)) out.tags.push(k); }
  }
  return out;
}

// ---------------------------------------------------------------- Steam Web API list
async function fetchServerList(key) {
  const filter = '\\appid\\252490\\empty\\1';   // Rust servers that are not empty
  const url = `https://api.steampowered.com/IGameServersService/GetServerList/v1/?key=${encodeURIComponent(key)}&filter=${encodeURIComponent(filter)}&limit=20000`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (r.status === 403 || r.status === 401) throw new Error('Steam rejected the API key - check that it was copied correctly.');
  if (!r.ok) throw new Error('Steam returned HTTP ' + r.status);
  const j = await r.json();
  const list = (j.response && j.response.servers) || [];
  const out = [];
  for (const s of list) {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(s.addr || ''); if (!m) continue;
    const t = parseTags(s.gametype);
    const players = t.cp != null ? t.cp : (s.players || 0);
    out.push({
      id: `${m[1]}:${s.gameport || m[2]}`, ip: m[1], qport: parseInt(m[2], 10), gport: s.gameport || parseInt(m[2], 10),
      name: String(s.name || '').trim(), players, max: t.mp != null ? t.mp : (s.max_players || 0), queue: t.qp || 0,
      born: t.born ? t.born * 1000 : 0, map: s.map || '', region: t.region || REGIONS[s.region] || '', tags: t.tags,
    });
  }
  return out;
}

// ---------------------------------------------------------------- A2S (Valve query protocol over UDP)
function reader(buf, start) {
  let off = start;
  return {
    u8() { return buf[off++]; },
    u16() { const v = buf.readUInt16LE(off); off += 2; return v; },
    skip(n) { off += n; },
    str() { let e = buf.indexOf(0, off); if (e < 0) e = buf.length; const s = buf.toString('utf8', off, e); off = e + 1; return s; },
    get left() { return buf.length - off; },
  };
}
function parseInfo(buf) {
  const r = reader(buf, 5);
  r.u8();                                   // protocol
  const name = r.str(); const map = r.str(); r.str(); r.str();   // name, map, folder, game
  r.u16();                                   // app id
  const players = r.u8(); const max = r.u8(); r.u8(); r.u8(); r.u8(); r.u8(); r.u8();   // players, max, bots, type, env, visibility, vac
  r.str();                                   // version
  let keywords = '';
  if (r.left > 0) {
    const edf = r.u8();
    if (edf & 0x80) r.skip(2);
    if (edf & 0x10) r.skip(8);
    if (edf & 0x40) { r.skip(2); r.str(); }
    if (edf & 0x20) keywords = r.str();
  }
  const t = parseTags(keywords);
  return { name, map, players: t.cp != null ? t.cp : players, max: t.mp != null ? t.mp : max, queue: t.qp || 0, born: t.born ? t.born * 1000 : 0, tags: t.tags };
}
function parseRules(buf) {
  const r = reader(buf, 5); const n = r.u16(); const rules = {};
  for (let i = 0; i < n && r.left > 0; i++) { const k = r.str(); rules[k] = r.str(); }
  return rules;
}

// kind: 'info' | 'rules'. Handles the challenge handshake and split (multi-packet) replies.
function a2s(ip, port, kind, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const t0 = Date.now(); let ping = null; let done = false;
    const frags = {};
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); try { sock.close(); } catch (_) { /* closed */ } err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error('The server did not answer (it may block queries or be offline)')), timeoutMs);
    const send = (chal) => {
      const head = Buffer.from([0xff, 0xff, 0xff, 0xff]);
      let body;
      if (kind === 'info') body = Buffer.concat([Buffer.from([0x54]), Buffer.from('Source Engine Query\0', 'latin1'), chal || Buffer.alloc(0)]);
      else body = Buffer.concat([Buffer.from([0x56]), chal || Buffer.from([0xff, 0xff, 0xff, 0xff])]);
      sock.send(Buffer.concat([head, body]), port, ip, (e) => { if (e) finish(e); });
    };
    sock.on('message', (msg) => {
      try {
        if (ping === null) ping = Date.now() - t0;
        let data = msg;
        if (msg.length >= 12 && msg.readInt32LE(0) === -2) {          // split packet: header, id, total, number, size
          const id = msg.readInt32LE(4); const total = msg.readUInt8(8); const num = msg.readUInt8(9);
          const f = frags[id] || (frags[id] = { total, parts: {} });
          f.parts[num] = msg.subarray(12);
          if (Object.keys(f.parts).length < f.total) return;
          data = Buffer.concat(Array.from({ length: f.total }, (_, i) => f.parts[i]));
        }
        if (data.length < 5 || data.readInt32LE(0) !== -1) return;
        const type = data[4];
        if (type === 0x41) return send(data.subarray(5, 9));            // challenge: ask again with it
        if (kind === 'info' && type === 0x49) return finish(null, { ...parseInfo(data), ping });
        if (kind === 'rules' && type === 0x45) return finish(null, parseRules(data));
      } catch (e) { finish(e); }
    });
    sock.on('error', (e) => finish(e));
    send(null);
  });
}

// ---------------------------------------------------------------- RustMaps
async function mapInfo(seed, size) {
  seed = String(seed || '').replace(/\D/g, ''); size = String(size || '').replace(/\D/g, '');
  if (!seed || !size) return { found: false };
  const pageUrl = `https://rustmaps.com/map/${size}_${seed}`;
  try {
    const r = await fetch(pageUrl, { headers: { 'User-Agent': UA } });
    if (r.status === 404) return { found: false, pageUrl, seed, size };
    if (!r.ok) return { found: false, pageUrl, seed, size, error: 'RustMaps returned HTTP ' + r.status };
    const html = await r.text();
    const img = /property="og:image"\s+content="([^"]+)"/i.exec(html);
    if (!img || !/^https:\/\/content\.rustmaps\.com\//.test(img[1])) return { found: false, pageUrl, seed, size };
    const iconsUrl = img[1].replace('map_raw_normalized.png', 'map_icons.png');
    return { found: true, pageUrl, seed, size, imageUrl: img[1], iconsUrl: /^https:\/\/content\.rustmaps\.com\//.test(iconsUrl) ? iconsUrl : '' };
  } catch (e) { return { found: false, pageUrl, seed, size, error: e.message }; }
}

module.exports = { fetchServerList, a2s, mapInfo, parseTags, parseInfo, parseRules, REGIONS };
