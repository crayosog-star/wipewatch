'use strict';
// Wipewatch social server: accounts, friends and clans for Wipewatch users.
// Zero dependencies (Node 18+). Run:  node server/server.js   (env: PORT=8787, DATA_DIR=./server/data, HOST=0.0.0.0)
// Put it behind HTTPS (a reverse proxy or tunnel) before exposing it to the internet.
//
// Privacy model (enforced here, never trusted to the client):
//   * Each account is "open" or "private".
//       open    - listed in search, profile viewable by anyone (only the fields the user chose to share)
//       private - not listed in search, friend requests need the exact username, profile only for accepted friends and clanmates
//   * Every profile field (skin value, activity, servers, hours, playing now) has its own share switch.
//   * Tokens are random and stored only as SHA-256 hashes. No emails, no passwords, no Steam data beyond what the user shares.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const CLAN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{2,23}$/;
const TAG_RE = /^[A-Za-z0-9]{2,5}$/;
const MAX_CLAN_MEMBERS = 25;
const MAX_FRIENDS = 200;
const ONLINE_MS = 5 * 60 * 1000;
const SHARE_KEYS = ['value', 'activity', 'servers', 'hours', 'playing'];

function createServer(opts = {}) {
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  const dbPath = path.join(dataDir, 'db.json');
  let db = { users: {}, friends: {}, clans: {} };
  try { db = { ...db, ...JSON.parse(fs.readFileSync(dbPath, 'utf8')) }; } catch (_) { /* fresh database */ }
  let saveTimer = null;
  const save = (now) => {
    clearTimeout(saveTimer);
    const write = () => { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(dbPath + '.tmp', JSON.stringify(db)); fs.renameSync(dbPath + '.tmp', dbPath); } catch (e) { console.error('save failed', e.message); } };
    if (now) write(); else saveTimer = setTimeout(write, 400);
  };

  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const newId = () => crypto.randomBytes(9).toString('hex');
  const byName = (n) => { const l = String(n || '').toLowerCase(); return Object.values(db.users).find((u) => u.nameLower === l) || null; };
  const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const clanOf = (uid) => Object.values(db.clans).find((c) => c.members.includes(uid)) || null;
  const isFriend = (a, b) => { const f = db.friends[pairKey(a, b)]; return !!f && f.status === 'accepted'; };
  const sameClan = (a, b) => { const c = clanOf(a); return !!c && c.members.includes(b); };
  const friendsOf = (uid) => Object.entries(db.friends).filter(([k, f]) => f.status === 'accepted' && k.split('|').includes(uid)).map(([k]) => k.split('|').find((x) => x !== uid));

  // ---------------------------------------------------------------- rate limiting (per IP, in memory)
  const hits = new Map();
  const limited = (ip, key, max, windowMs) => {
    const k = key + '|' + ip; const now = Date.now(); const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    arr.push(now); hits.set(k, arr); return arr.length > max;
  };
  setInterval(() => { const now = Date.now(); for (const [k, a] of hits) { const f = a.filter((t) => now - t < 3600e3); if (f.length) hits.set(k, f); else hits.delete(k); } }, 600e3).unref();

  // ---------------------------------------------------------------- input cleaning
  const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  // for identifiers (usernames, clan names/tags): too long is an error, never silently truncated into something else
  const strict = (v, max) => { const t = String(v == null ? '' : v).trim(); return t.length > max ? '' : t; };
  const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 100) / 100 : null; };
  function cleanSnapshot(s) {
    s = s && typeof s === 'object' ? s : {};
    const out = { value: null, activity: [], servers: [], hours: null, playing: null };
    const v = s.value && typeof s.value === 'object' ? s.value : null;
    if (v) {
      const total = num(v.total, 0, 1e7); const count = num(v.count, 0, 1e6);
      out.value = { total, count, currency: str(v.currency, 4) || 'USD', net: num(v.net, 0, 1e7),
        top: (Array.isArray(v.top) ? v.top : []).slice(0, 5).map((t) => ({ name: str(t && t.name, 60), each: num(t && t.each, 0, 1e6), count: num(t && t.count, 0, 1e5) })).filter((t) => t.name) };
    }
    out.activity = (Array.isArray(s.activity) ? s.activity : []).slice(0, 15).map((a) => ({ t: num(a && a.t, 0, 4e12), type: str(a && a.type, 12), text: str(a && a.text, 160) })).filter((a) => a.text && a.t);
    out.servers = (Array.isArray(s.servers) ? s.servers : []).slice(0, 10).map((x) => ({ name: str(x && x.name, 100), t: num(x && x.t, 0, 4e12) })).filter((x) => x.name && x.t);
    out.hours = num(s.hours, 0, 1e6);
    out.playing = str(s.playing, 100) || null;
    return out;
  }
  const defaultShare = () => ({ value: true, activity: true, servers: true, hours: true, playing: true });
  const cleanShare = (sh, base) => { const out = { ...base }; if (sh && typeof sh === 'object') for (const k of SHARE_KEYS) if (typeof sh[k] === 'boolean') out[k] = sh[k]; return out; };

  const online = (u) => Date.now() - (u.lastSeen || 0) < ONLINE_MS;
  // What a viewer may see: only fields the owner shares. Basic identity (name, last seen) is always included for friends/clanmates/open profiles.
  function viewProfile(u, rel) {
    const p = { id: u.id, name: u.name, visibility: u.visibility, lastSeen: u.lastSeen || 0, online: online(u), relation: rel };
    const sn = u.snapshot || {}; const sh = u.share;
    p.share = sh;
    if (sh.value && sn.value) p.value = sn.value;
    if (sh.activity) p.activity = sn.activity || [];
    if (sh.servers) p.servers = sn.servers || [];
    if (sh.hours && sn.hours != null) p.hours = sn.hours;
    if (sh.playing && sn.playing && online(u)) p.playing = sn.playing;
    return p;
  }
  const brief = (u) => ({ id: u.id, name: u.name, lastSeen: u.lastSeen || 0, online: online(u), playing: (u.share.playing && online(u) && u.snapshot && u.snapshot.playing) || null });
  function relationOf(me, other) { return me.id === other.id ? 'self' : isFriend(me.id, other.id) ? 'friend' : sameClan(me.id, other.id) ? 'clan' : 'none'; }
  function clanView(c, me) {
    return { id: c.id, name: c.name, tag: c.tag, owner: c.owner, createdAt: c.createdAt, you: me.id,
      members: c.members.map((id) => db.users[id]).filter(Boolean).map((u) => ({ ...viewProfile(u, relationOf(me, u) === 'none' ? 'clan' : relationOf(me, u)), role: u.id === c.owner ? 'owner' : 'member' })) };
  }

  // ---------------------------------------------------------------- routes
  const routes = [];
  const route = (method, pattern, handler, auth = true) => routes.push({ method, re: new RegExp('^' + pattern + '$'), handler, auth });
  const fail = (status, error) => { const e = new Error(error); e.status = status; return e; };

  route('GET', '/health', () => ({ ok: true, name: 'wipewatch-server', users: Object.keys(db.users).length }), false);

  route('POST', '/register', (req, body) => {
    if (limited(req.ip, 'register', 10, 3600e3)) throw fail(429, 'Too many accounts created from this address. Try again later.');
    const name = strict(body.name, 20);
    if (!NAME_RE.test(name)) throw fail(400, 'Username must be 3-20 letters, numbers, - or _.');
    if (byName(name)) throw fail(409, 'That username is taken.');
    const token = crypto.randomBytes(32).toString('hex'); const id = newId();
    db.users[id] = { id, name, nameLower: name.toLowerCase(), tokenHash: sha(token), createdAt: Date.now(), lastSeen: Date.now(), visibility: 'open', share: defaultShare(), snapshot: cleanSnapshot({}) };
    save(true);
    return { id, name, token, visibility: 'open', share: db.users[id].share };
  }, false);

  route('GET', '/me', (req) => { const u = req.user; return { id: u.id, name: u.name, visibility: u.visibility, share: u.share, clan: (clanOf(u.id) || {}).id || null }; });
  route('PUT', '/me', (req, body) => {
    const u = req.user;
    if (body.visibility !== undefined) { if (!['open', 'private'].includes(body.visibility)) throw fail(400, 'Visibility must be open or private.'); u.visibility = body.visibility; }
    if (body.share !== undefined) u.share = cleanShare(body.share, u.share);
    save(); return { visibility: u.visibility, share: u.share };
  });
  route('PUT', '/snapshot', (req, body) => { req.user.snapshot = cleanSnapshot(body); save(); return { ok: true }; });
  route('DELETE', '/me', (req) => {   // delete the account and everything attached to it
    const u = req.user; const c = clanOf(u.id);
    if (c) { if (c.owner === u.id) delete db.clans[c.id]; else c.members = c.members.filter((x) => x !== u.id); }
    for (const k of Object.keys(db.friends)) if (k.split('|').includes(u.id)) delete db.friends[k];
    for (const cl of Object.values(db.clans)) cl.invites = cl.invites.filter((x) => x !== u.id);
    delete db.users[u.id]; save(true); return { ok: true };
  });

  route('GET', '/search', (req, _b, q) => {
    const term = str(q.get('q'), 20).toLowerCase(); if (term.length < 2) return { results: [] };
    const results = Object.values(db.users).filter((u) => u.visibility === 'open' && u.id !== req.user.id && u.nameLower.includes(term)).slice(0, 10)
      .map((u) => ({ id: u.id, name: u.name, online: online(u), relation: relationOf(req.user, u), pending: !!db.friends[pairKey(req.user.id, u.id)] && db.friends[pairKey(req.user.id, u.id)].status === 'pending' }));
    return { results };
  });

  route('GET', '/friends', (req) => {
    const me = req.user; const friends = []; const incoming = []; const outgoing = [];
    for (const [k, f] of Object.entries(db.friends)) {
      const ids = k.split('|'); if (!ids.includes(me.id)) continue; const other = db.users[ids.find((x) => x !== me.id)]; if (!other) continue;
      if (f.status === 'accepted') friends.push({ ...brief(other), since: f.at });
      else if (f.from === me.id) outgoing.push({ id: other.id, name: other.name, at: f.at });
      else incoming.push({ id: other.id, name: other.name, at: f.at });
    }
    friends.sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    return { friends, incoming, outgoing };
  });
  route('POST', '/friends/request', (req, body) => {
    if (limited(req.ip, 'frq', 40, 3600e3)) throw fail(429, 'Too many friend requests. Slow down.');
    const me = req.user; const other = byName(strict(body.name, 20));
    if (!other || other.id === me.id) throw fail(404, 'No user with that name.');
    const key = pairKey(me.id, other.id); const ex = db.friends[key];
    if (ex && ex.status === 'accepted') throw fail(409, 'You are already friends.');
    if (ex && ex.status === 'pending') {
      if (ex.from === me.id) throw fail(409, 'Request already sent.');
      ex.status = 'accepted'; ex.at = Date.now(); save(); return { status: 'accepted' };   // they had already asked you: it's mutual
    }
    if (friendsOf(me.id).length >= MAX_FRIENDS || friendsOf(other.id).length >= MAX_FRIENDS) throw fail(409, 'Friend list is full.');
    const pend = Object.entries(db.friends).filter(([k, f]) => f.status === 'pending' && f.from === me.id).length; if (pend >= 50) throw fail(409, 'You have too many pending requests.');
    db.friends[key] = { status: 'pending', from: me.id, at: Date.now() }; save(); return { status: 'pending' };
  });
  route('POST', '/friends/accept', (req, body) => {
    const me = req.user; const other = byName(strict(body.name, 20)); const f = other && db.friends[pairKey(me.id, other.id)];
    if (!f || f.status !== 'pending' || f.from === me.id) throw fail(404, 'No request from that user.');
    f.status = 'accepted'; f.at = Date.now(); save(); return { status: 'accepted' };
  });
  const dropFriend = (req, body) => {   // decline, cancel and remove all delete the link
    const me = req.user; const other = byName(strict(body.name, 20)); const key = other && pairKey(me.id, other.id);
    if (!key || !db.friends[key]) throw fail(404, 'Nothing to remove.');
    delete db.friends[key]; save(); return { ok: true };
  };
  route('POST', '/friends/decline', dropFriend);
  route('POST', '/friends/cancel', dropFriend);
  route('POST', '/friends/remove', dropFriend);

  route('GET', '/profile/([A-Za-z0-9_-]{3,20})', (req, _b, _q, m) => {
    const other = byName(m[1]); if (!other) throw fail(404, 'No user with that name.');
    const rel = relationOf(req.user, other);
    if (rel === 'none' && other.visibility !== 'open') throw fail(403, 'This profile is private.');
    return viewProfile(other, rel);
  });

  // ---- clans
  route('POST', '/clans', (req, body) => {
    const me = req.user; if (clanOf(me.id)) throw fail(409, 'Leave your current clan first.');
    const name = strict(body.name, 24); const tag = strict(body.tag, 5).toUpperCase();
    if (!CLAN_NAME_RE.test(name)) throw fail(400, 'Clan name must be 3-24 characters (letters, numbers, spaces, - or _).');
    if (!TAG_RE.test(tag)) throw fail(400, 'Clan tag must be 2-5 letters or numbers.');
    if (Object.values(db.clans).some((c) => c.name.toLowerCase() === name.toLowerCase())) throw fail(409, 'That clan name is taken.');
    const id = newId(); db.clans[id] = { id, name, tag, owner: me.id, members: [me.id], invites: [], createdAt: Date.now() };
    for (const c of Object.values(db.clans)) c.invites = c.invites.filter((x) => x !== me.id);
    save(); return clanView(db.clans[id], me);
  });
  route('GET', '/clans/mine', (req) => { const c = clanOf(req.user.id); return { clan: c ? clanView(c, req.user) : null }; });
  route('GET', '/clans/invites', (req) => ({ invites: Object.values(db.clans).filter((c) => c.invites.includes(req.user.id)).map((c) => ({ id: c.id, name: c.name, tag: c.tag, members: c.members.length, owner: (db.users[c.owner] || {}).name || '?' })) }));
  route('POST', '/clans/invite', (req, body) => {
    if (limited(req.ip, 'cinv', 60, 3600e3)) throw fail(429, 'Too many invites. Slow down.');
    const me = req.user; const c = clanOf(me.id); if (!c) throw fail(400, 'You are not in a clan.');
    const other = byName(strict(body.name, 20)); if (!other) throw fail(404, 'No user with that name.');
    if (!isFriend(me.id, other.id)) throw fail(403, 'You can only invite your friends.');
    if (clanOf(other.id)) throw fail(409, 'That player is already in a clan.');
    if (c.members.length >= MAX_CLAN_MEMBERS) throw fail(409, 'The clan is full.');
    if (!c.invites.includes(other.id)) c.invites.push(other.id);
    save(); return { ok: true };
  });
  route('POST', '/clans/accept', (req, body) => {
    const me = req.user; const c = db.clans[str(body.clanId, 40)];
    if (!c || !c.invites.includes(me.id)) throw fail(404, 'No such invite.');
    if (clanOf(me.id)) throw fail(409, 'Leave your current clan first.');
    if (c.members.length >= MAX_CLAN_MEMBERS) throw fail(409, 'The clan is full.');
    c.members.push(me.id); for (const cl of Object.values(db.clans)) cl.invites = cl.invites.filter((x) => x !== me.id);
    save(); return clanView(c, me);
  });
  route('POST', '/clans/decline', (req, body) => { const c = db.clans[str(body.clanId, 40)]; if (c) { c.invites = c.invites.filter((x) => x !== req.user.id); save(); } return { ok: true }; });
  route('POST', '/clans/leave', (req) => {
    const me = req.user; const c = clanOf(me.id); if (!c) throw fail(400, 'You are not in a clan.');
    if (c.owner === me.id) { if (c.members.length > 1) throw fail(409, 'Transfer ownership or kick everyone first, or disband the clan.'); delete db.clans[c.id]; }
    else c.members = c.members.filter((x) => x !== me.id);
    save(); return { ok: true };
  });
  route('POST', '/clans/kick', (req, body) => {
    const me = req.user; const c = clanOf(me.id); if (!c || c.owner !== me.id) throw fail(403, 'Only the clan owner can remove members.');
    const other = byName(strict(body.name, 20)); if (!other || !c.members.includes(other.id) || other.id === me.id) throw fail(404, 'That player is not a member.');
    c.members = c.members.filter((x) => x !== other.id); save(); return { ok: true };
  });
  route('POST', '/clans/transfer', (req, body) => {
    const me = req.user; const c = clanOf(me.id); if (!c || c.owner !== me.id) throw fail(403, 'Only the clan owner can do that.');
    const other = byName(strict(body.name, 20)); if (!other || !c.members.includes(other.id) || other.id === me.id) throw fail(404, 'That player is not a member.');
    c.owner = other.id; save(); return { ok: true };
  });
  route('POST', '/clans/disband', (req) => {
    const me = req.user; const c = clanOf(me.id); if (!c || c.owner !== me.id) throw fail(403, 'Only the clan owner can disband the clan.');
    delete db.clans[c.id]; save(); return { ok: true };
  });

  // ---------------------------------------------------------------- HTTP plumbing
  const server = http.createServer((req, res) => {
    const send = (status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
    req.ip = (opts.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
    if (limited(req.ip, 'all', 600, 60e3)) return send(429, { error: 'Too many requests.' });
    const url = new URL(req.url, 'http://x'); let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) { send(413, { error: 'Request too large.' }); req.destroy(); } });
    req.on('end', () => {
      try {
        let data = {}; if (body) { try { data = JSON.parse(body); } catch (_) { return send(400, { error: 'Invalid JSON.' }); } if (!data || typeof data !== 'object') data = {}; }
        for (const r of routes) {
          if (r.method !== req.method) continue; const m = r.re.exec(url.pathname); if (!m) continue;
          if (r.auth) {
            const tok = (/^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '') || [])[1];
            const h = tok && sha(tok); const user = h && Object.values(db.users).find((u) => u.tokenHash === h);
            if (!user) return send(401, { error: 'Not signed in.' });
            user.lastSeen = Date.now(); req.user = user;
          }
          return send(200, r.handler(req, data, url.searchParams, m));
        }
        send(404, { error: 'Not found.' });
      } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Server error.' }); if (!e.status) console.error(e); }
    });
  });
  server.flush = () => { clearTimeout(saveTimer); save(true); };
  server.db = db;
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  const port = parseInt(process.env.PORT, 10) || 8787; const host = process.env.HOST || '0.0.0.0';
  const s = createServer({ trustProxy: process.env.TRUST_PROXY === '1' });
  s.listen(port, host, () => console.log(`Wipewatch server listening on http://${host}:${port}  (data: ${process.env.DATA_DIR || path.join(__dirname, 'data')})`));
  process.on('SIGINT', () => { s.flush(); process.exit(0); }); process.on('SIGTERM', () => { s.flush(); process.exit(0); });
}
