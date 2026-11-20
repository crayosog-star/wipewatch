'use strict';
// Run: node tests/social-test.js   (starts a throwaway server on a random port and drives it with simulated users)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server/server');
const { SocialClient, normalizeServerUrl } = require('../src/social-client');

let pass = 0; let failN = 0;
const ok = (cond, label, extra) => { if (cond) pass++; else { failN++; console.log('FAIL:', label, extra !== undefined ? JSON.stringify(extra) : ''); } };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-social-'));
  const srv = createServer({ dataDir: dir });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const mk = async (name) => { const c = new SocialClient(base); const r = await c.register(name); c.token = r.token; return { c, r, name }; };
  const snap = (total, extra = {}) => ({ value: { total, net: total / 1.15, count: 10, currency: 'USD', top: [{ name: 'Tempered AK47', each: 31.2, count: 1 }] },
    activity: [{ t: Date.now() - 1000, type: 'claim', text: 'Garage Door claimed' }], servers: [{ name: 'Rusty Moose US Main', t: Date.now() - 5000 }], hours: 934, playing: 'Rusty Moose US Main', ...extra });

  ok((await new SocialClient(base).health()).ok === true, 'health');
  ok(normalizeServerUrl('example.com').url === 'https://example.com', 'url adds https');
  ok(!!normalizeServerUrl('http://example.com').error, 'plain http to a remote host rejected');
  ok(normalizeServerUrl('http://localhost:8787').url === 'http://localhost:8787', 'plain http allowed for localhost');
  ok(!!normalizeServerUrl('https://user:pw@example.com').error, 'credentials in url rejected');

  // ---- accounts
  const alice = await mk('Alice'); const bob = await mk('Bob_77'); const cara = await mk('Cara'); const dan = await mk('Dan');
  ok(alice.r.id && alice.r.token && alice.r.token.length === 64, 'register returns id + token');
  ok(!!(await new SocialClient(base).register('Alice')).error, 'duplicate name rejected (case-insensitive)');
  ok(!!(await new SocialClient(base).register('alice')).error, 'duplicate name different case rejected');
  ok(!!(await new SocialClient(base).register('x')).error, 'short name rejected');
  ok(!!(await new SocialClient(base).register('bad name!')).error, 'bad characters rejected');
  ok(!!(await new SocialClient(base).me()).error, 'no token -> rejected');
  const forged = new SocialClient(base, 'a'.repeat(64)); ok((await forged.me()).status === 401, 'wrong token -> 401');
  const dbRaw = fs.readFileSync(path.join(dir, 'db.json'), 'utf8').length ? true : false; srv.flush();
  const stored = fs.readFileSync(path.join(dir, 'db.json'), 'utf8'); ok(!stored.includes(alice.r.token), 'raw token is never stored');

  // ---- snapshots + visibility
  await alice.c.pushSnapshot(snap(251.16)); await bob.c.pushSnapshot(snap(99.5)); await cara.c.pushSnapshot(snap(12));
  ok((await alice.c.search('bo')).results.some((x) => x.name === 'Bob_77'), 'open user shows in search');
  await bob.c.updateMe({ visibility: 'private' });
  ok(!(await alice.c.search('bo')).results.some((x) => x.name === 'Bob_77'), 'private user hidden from search');
  ok((await alice.c.profile('Bob_77')).status === 403, 'private profile blocked for strangers');
  const openProf = await bob.c.profile('Alice'); ok(openProf.value && openProf.value.total === 251.16, 'open profile visible to anyone');
  ok(!!(await alice.c.updateMe({ visibility: 'nope' })).error, 'bad visibility rejected');

  // ---- friend flow
  ok((await alice.c.friendRequest('Bob_77')).status === 'pending', 'request to private user by exact name works');
  ok(!!(await alice.c.friendRequest('Bob_77')).error, 'duplicate request rejected');
  ok(!!(await alice.c.friendRequest('Alice')).error, 'cannot add yourself');
  ok(!!(await alice.c.friendRequest('Nobody')).error, 'unknown user');
  let bf = await bob.c.friends(); ok(bf.incoming.length === 1 && bf.incoming[0].name === 'Alice', 'bob sees incoming request');
  let af = await alice.c.friends(); ok(af.outgoing.length === 1, 'alice sees outgoing request');
  ok((await alice.c.friendAccept('Bob_77')).error !== undefined, 'requester cannot accept own request');
  ok((await alice.c.profile('Bob_77')).status === 403, 'still private before accept');
  ok((await bob.c.friendAccept('Alice')).status === 'accepted', 'bob accepts');
  const bobSeen = await alice.c.profile('Bob_77'); ok(bobSeen.value && bobSeen.value.total === 99.5 && bobSeen.relation === 'friend', 'friend can see private profile', bobSeen);
  ok(bobSeen.activity.length === 1 && bobSeen.servers.length === 1 && bobSeen.hours === 934 && bobSeen.playing, 'all shared fields visible to friend');
  ok(!!(await alice.c.friendRequest('Bob_77')).error, 'already friends');

  // ---- share switches enforced server-side
  await bob.c.updateMe({ share: { value: false, servers: false } });
  const filtered = await alice.c.profile('Bob_77');
  ok(filtered.value === undefined && filtered.servers === undefined && filtered.activity && filtered.hours === 934, 'unshared fields hidden', filtered);
  await bob.c.updateMe({ share: { value: true, servers: true, playing: false } });
  ok((await alice.c.profile('Bob_77')).playing === undefined, 'playing switch hides playing');
  ok(!(await alice.c.friends()).friends[0].playing, 'playing hidden in friend list too');

  // ---- snapshot sanitising
  await cara.c.pushSnapshot({ value: { total: 'abc', count: -5, currency: 'x'.repeat(50), top: new Array(20).fill({ name: 'n'.repeat(500), each: 1e99 }) }, activity: new Array(60).fill({ t: 1, type: 'claim', text: '<img src=x onerror=alert(1)>' + 'z'.repeat(600) }), servers: 'oops', hours: 1e12 });
  const cp = await cara.c.profile('Cara');
  ok(cp.value && cp.value.top.length <= 5 && cp.value.top.every((t) => t.name.length <= 60) && cp.value.currency.length <= 4, 'snapshot size limits applied', cp.value);
  ok(cp.activity.length <= 15 && cp.activity.every((a) => a.text.length <= 160), 'activity limits applied');
  ok(cp.hours === undefined, 'out-of-range hours dropped');

  // ---- decline / cancel / remove
  ok((await cara.c.friendRequest('Dan')).status === 'pending', 'cara -> dan request');
  ok((await dan.c.friendDecline('Cara')).ok, 'dan declines');
  ok((await dan.c.friends()).incoming.length === 0, 'declined request gone');
  await cara.c.friendRequest('Dan'); ok((await cara.c.friendCancel('Dan')).ok, 'requester cancels');
  await cara.c.friendRequest('Dan'); ok((await dan.c.friendRequest('Cara')).status === 'accepted', 'crossed requests auto-accept');
  ok((await dan.c.friendRemove('Cara')).ok && (await cara.c.friends()).friends.length === 0, 'remove friend');

  // ---- clans
  await alice.c.friendRequest('Cara'); await cara.c.friendAccept('Alice');
  ok(!!(await alice.c.clanInvite('Bob_77')).error, 'cannot invite when not in a clan');
  ok(!!(await alice.c.clanCreate('x', 'ab')).error, 'bad clan name rejected');
  ok(!!(await alice.c.clanCreate('Good Name', 'toolongtag')).error, 'bad tag rejected');
  const clan = await alice.c.clanCreate('Night Owls', 'owl'); ok(clan.name === 'Night Owls' && clan.tag === 'OWL' && clan.members.length === 1 && clan.members[0].role === 'owner', 'create clan', clan);
  ok(!!(await bob.c.clanCreate('night owls', 'XX')).error, 'clan name unique (case-insensitive)');
  ok(!!(await alice.c.clanCreate('Another', 'AN')).error, 'one clan per user');
  ok(!!(await alice.c.clanInvite('Dan')).error, 'can only invite friends');
  ok((await alice.c.clanInvite('Bob_77')).ok && (await alice.c.clanInvite('Cara')).ok, 'invite friends');
  const inv = await bob.c.clanInvites(); ok(inv.invites.length === 1 && inv.invites[0].name === 'Night Owls', 'bob sees invite');
  ok(!!(await dan.c.clanAccept(clan.id)).error, 'cannot accept without invite');
  const joined = await bob.c.clanAccept(clan.id); ok(joined.members.length === 2, 'bob joins');
  await cara.c.clanAccept(clan.id);
  const mine = await bob.c.clanMine(); ok(mine.clan.members.length === 3 && mine.clan.members.every((m) => m.name), 'members listed');
  ok(mine.clan.members.find((m) => m.name === 'Cara').value, 'clanmate profile includes shared value');
  // a clanmate who is not a friend is visible as clan relation
  const cb = await bob.c.profile('Cara'); ok(cb.relation === 'clan' || cb.relation === 'friend', 'clanmates can view each other', cb.relation);
  ok(!!(await bob.c.clanKick('Cara')).error, 'non-owner cannot kick');
  ok(!!(await bob.c.clanDisband()).error, 'non-owner cannot disband');
  ok((await bob.c.clanLeave()).ok, 'member leaves');
  ok((await alice.c.clanKick('Cara')).ok, 'owner kicks');
  await alice.c.clanInvite('Bob_77'); await bob.c.clanAccept(clan.id);
  ok(!!(await alice.c.clanLeave()).error, 'owner with members cannot just leave');
  ok((await alice.c.clanTransfer('Bob_77')).ok && (await bob.c.clanMine()).clan.owner === bob.r.id, 'ownership transfer');
  ok((await bob.c.clanDisband()).ok && (await bob.c.clanMine()).clan === null, 'disband');

  // ---- limits
  for (let i = 0; i < 12; i++) await new SocialClient(base).register('Spam' + i);   // registration rate limit (10/hour/IP): later ones must fail
  ok(!!(await new SocialClient(base).register('SpamLast')).error, 'registration rate limited');
  const big = await fetch(base + '/snapshot', { method: 'PUT', headers: { Authorization: 'Bearer ' + alice.r.token }, body: 'x'.repeat(200000) }).then((r) => r.status).catch(() => 'closed');
  ok(big === 413 || big === 'closed', 'oversized body refused', big);
  ok((await fetch(base + '/nope')).status === 404, '404 for unknown route');

  // ---- deleting an account removes its traces
  ok((await dan.c.deleteAccount()).ok, 'delete account');
  ok((await dan.c.me()).status === 401, 'deleted account token is dead');
  ok(!(await alice.c.search('dan')).results.length, 'deleted account gone from search');

  // ---- persistence across restarts
  srv.flush(); await new Promise((r) => srv.close(r));
  const srv2 = createServer({ dataDir: dir }); await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
  const again = new SocialClient('http://127.0.0.1:' + srv2.address().port, alice.r.token); const me2 = await again.me();
  ok(me2.name === 'Alice' && (await again.friends()).friends.length >= 1, 'data and token survive a restart', me2);
  await new Promise((r) => srv2.close(r));

  console.log(`\nsocial tests: ${pass} passed, ${failN} failed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failN ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
