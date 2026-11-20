'use strict';
// Friends + Clan pages. Everything that comes from the server (names, activity text, ...) is untrusted and only ever rendered as text via h().
// Depends on app.js helpers (h, $, $$, S, money, toggle, showTab) and extras.js (xAgo).

const FR = { sel: '', profile: null, loadingProfile: false, results: null, msg: '', busy: false, ver: 0 };
const CL = { sel: '', profile: null, msg: '', busy: false };
let socTimer = null;

const soc = () => (S && S.social) || { linked: false };
const avatarColor = (name) => { let n = 0; for (const c of String(name)) n = (n * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${n % 360} 60% 45%)`; };
const avatar = (name, size = 38) => h('div', { class: 'avatar', style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px;background:${avatarColor(name)}` }, String(name).slice(0, 1).toUpperCase());
const seenText = (p) => (p.online ? 'Online' : p.lastSeen ? 'Seen ' + xAgo(p.lastSeen) : 'Never seen');

async function socCall(method, ...args) {
  const r = await window.api.socialCall(method, ...args);
  return r || { error: 'No answer.' };
}
function flash(target, text, bad) { target.msg = text || ''; target.bad = !!bad; renderSocial(); if (text) setTimeout(() => { if (target.msg === text) { target.msg = ''; renderSocial(); } }, 6000); }

// ------------------------------------------------------------------ shared pieces
function setupCard(forTab) {
  const s = soc();
  const server = h('input', { placeholder: 'https://your-wipewatch-server.example.com', value: s.server || '', class: 'grow' });
  const name = h('input', { placeholder: 'Pick a username (3-20 letters, numbers, - _)', maxlength: '20', class: 'grow' });
  const msg = h('div', { class: 'muted' });
  const go = h('button', { class: 'btn', onclick: async () => {
    go.disabled = true; msg.textContent = 'Connecting...'; msg.className = 'muted';
    const r = await window.api.socialSetup({ server: server.value, name: name.value }); go.disabled = false;
    if (r.error) { msg.textContent = r.error; msg.className = 'muted bad'; } else { S.social = await window.api.socialGet(); renderSocial(); }
  } }, 'Create my profile');
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
  return h('div', { class: 'card form soc-setup' }, h('h3', {}, forTab === 'clan' ? 'Set up your profile first' : 'Create your Wipewatch profile'),
    h('p', { class: 'muted' }, 'Friends and clans run on a Wipewatch server, a small program that one of you hosts (see ', h('b', {}, 'server/README.md'), '). Enter its address and pick a username. No email or password: this PC keeps a private key for your account.'),
    h('label', {}, 'Server address', server), h('label', {}, 'Username', name), h('div', { class: 'row' }, go), msg,
    h('div', { class: 'muted' }, 'You choose exactly what friends can see (skin value, activity, servers, hours) and whether your profile is open or private.'));
}

function statTile(n, label, c) { return h('div', { class: 'tile', style: `--c:${c}` }, h('b', {}, n), h('span', {}, label)); }
function profilePanel(p, extra) {
  if (!p) return h('div', { class: 'card muted' }, 'Pick someone to see their profile.');
  if (p.error) return h('div', { class: 'card' }, h('div', { class: 'banner err' }, p.error));
  const sh = p.share || {};
  const hidden = (label) => h('div', { class: 'muted soc-hidden' }, `${p.name} does not share ${label}.`);
  const kids = [
    h('div', { class: 'prof-head' }, avatar(p.name, 52),
      h('div', {}, h('h3', { style: 'margin:0' }, p.name), h('div', { class: 'muted' }, h('span', { class: 'sdot ' + (p.online ? 'ok' : ''), style: 'display:inline-block;margin-right:6px' }), seenText(p), p.playing ? ' - playing ' + p.playing : ''))),
  ];
  const tiles = [];
  if (p.value) { tiles.push(statTile(money(p.value.total, p.value.currency), 'Skin inventory', 'var(--acc)')); if (p.value.net != null) tiles.push(statTile(money(p.value.net, p.value.currency), 'After Steam fees', 'var(--ok)')); tiles.push(statTile(String((p.value.count || 0).toLocaleString()), 'Items', 'var(--tw)')); }
  if (p.hours != null) tiles.push(statTile(p.hours.toLocaleString(), 'Hours played', 'var(--kick)'));
  if (tiles.length) kids.push(h('div', { class: 'tiles prof-tiles' }, ...tiles));
  if (sh.value === false) kids.push(hidden('their skin value'));
  if (p.value && p.value.top && p.value.top.length) kids.push(h('div', { class: 'prof-sec' }, h('h4', {}, 'Top skins'), ...p.value.top.map((t) => h('div', { class: 'srcrow' }, h('span', {}, t.name + (t.count > 1 ? ' x' + t.count : '')), h('b', {}, t.each != null ? money(t.each, p.value.currency) : '')))));
  if (p.servers) kids.push(h('div', { class: 'prof-sec' }, h('h4', {}, 'Recent servers'), ...(p.servers.length ? p.servers.map((x) => h('div', { class: 'srcrow' }, h('span', {}, x.name), h('span', { class: 'muted' }, xAgo(x.t)))) : [h('div', { class: 'muted' }, 'No servers seen yet.')])));
  else if (sh.servers === false) kids.push(hidden('recent servers'));
  if (p.activity) kids.push(h('div', { class: 'prof-sec' }, h('h4', {}, 'Recent activity'), ...(p.activity.length ? p.activity.map((a) => h('div', { class: 'srcrow' }, h('span', {}, h('span', { class: 'tag ' + a.type, style: 'margin-right:8px' }, { claim: 'Claimed', ready: 'Ready', price: 'Price', patch: 'Update' }[a.type] || a.type), a.text), h('span', { class: 'muted' }, xAgo(a.t)))) : [h('div', { class: 'muted' }, 'Nothing yet.')])));
  else if (sh.activity === false) kids.push(hidden('recent activity'));
  if (extra) kids.push(extra);
  return h('div', { class: 'card prof' }, ...kids);
}

// ------------------------------------------------------------------ friends page
function myProfileCard() {
  const s = soc(); const sh = s.share || {};
  const setShare = async (key, v) => { const r = await window.api.socialSettings({ share: { [key]: v } }); if (!r.error) { S.social = r; } };
  const vis = (val, title, text) => h('label', { class: 'vis' + (s.visibility === val ? ' on' : '') }, h('input', { type: 'radio', name: 'soc-vis', ...(s.visibility === val ? { checked: '' } : {}), onchange: async () => { const r = await window.api.socialSettings({ visibility: val }); if (!r.error) { S.social = r; renderSocial(); } } }), h('div', {}, h('b', {}, title), h('div', { class: 'muted' }, text)));
  const row = (key, label) => h('label', { class: 'switch-row' }, h('span', {}, label), toggle(sh[key] !== false, (e) => setShare(key, e.target.checked)));
  return h('div', { class: 'card form soc-me' },
    h('div', { class: 'prof-head' }, avatar(s.name, 46), h('div', {}, h('h3', { style: 'margin:0' }, s.name), h('div', { class: 'muted' }, 'Your Wipewatch profile on ' + s.server.replace(/^https?:\/\//, '')))),
    h('div', { class: 'vis-row' },
      vis('open', 'Open', 'Anyone can find you by name and view your profile (only the parts you share below).'),
      vis('private', 'Private', 'Not in search. People need your exact username to send a request, and only friends see your profile.')),
    h('div', { class: 'muted', style: 'margin-top:6px' }, 'Share with friends and clanmates:'),
    h('div', { class: 'share-grid' }, row('value', 'Skin inventory value'), row('activity', 'Recent activity'), row('servers', 'Recent servers'), row('hours', 'Hours played'), row('playing', "Show when I'm playing")),
    soc().error ? h('div', { class: 'banner err' }, soc().error) : null,
    h('details', { class: 'soc-danger' }, h('summary', { class: 'muted' }, 'Account'),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn ghost sm', onclick: async () => { if (!confirm('Stop using this profile on this PC? The account stays on the server, but you will not be able to get back into it from here.')) return; await window.api.socialForget(); S.social = await window.api.socialGet(); FR.sel = ''; FR.profile = null; renderSocial(); } }, 'Disconnect this PC'),
        h('button', { class: 'btn ghost sm', onclick: async () => { if (!confirm('Delete your account on the server? Your friends, clan membership and shared profile are removed. This cannot be undone.')) return; const r = await window.api.socialDelete(); if (r.error) alert(r.error); S.social = await window.api.socialGet(); FR.sel = ''; FR.profile = null; renderSocial(); } }, 'Delete my account'))));
}

function renderFriends() {
  const body = $('#fr-body'); if (!S) return;
  const s = soc();
  if (!s.linked) return body.replaceChildren(setupCard('friends'));
  const f = s.friends;
  const kids = [myProfileCard()];

  // requests
  if (f && (f.incoming.length || f.outgoing.length)) {
    kids.push(h('div', { class: 'card form' }, h('h3', {}, 'Friend requests'),
      ...f.incoming.map((r) => h('div', { class: 'srcrow' }, h('div', { class: 'row', style: 'gap:10px' }, avatar(r.name, 30), h('b', {}, r.name), h('span', { class: 'muted' }, 'wants to be friends')),
        h('div', { class: 'row', style: 'gap:6px' }, h('button', { class: 'btn sm', onclick: async () => { const x = await socCall('friendAccept', r.name); flash(FR, x.error || `You and ${r.name} are friends.`, !!x.error); } }, 'Accept'), h('button', { class: 'btn ghost sm', onclick: async () => { await socCall('friendDecline', r.name); renderSocial(); } }, 'Decline')))),
      ...f.outgoing.map((r) => h('div', { class: 'srcrow' }, h('span', {}, 'Sent to ', h('b', {}, r.name), h('span', { class: 'muted' }, ' - waiting')), h('button', { class: 'btn ghost sm', onclick: async () => { await socCall('friendCancel', r.name); renderSocial(); } }, 'Cancel')))));
  }

  // add friends
  const q = h('input', { id: 'fr-q', placeholder: 'Search open profiles, or type an exact username', class: 'grow', maxlength: '20' });
  const doSearch = async () => { const t = q.value.trim(); if (t.length < 2 || FR.busy) return; FR.busy = true; const r = await socCall('search', t); FR.busy = false; FR.results = r.error ? [] : r.results; FR.q = t; flash(FR, r.error || (FR.results.length ? '' : 'No open profile matches. If their profile is private, use Add by name.'), !!r.error); };
  const addByName = async () => { const t = q.value.trim(); if (!t) return; const r = await socCall('friendRequest', t); if (!r.error) q.value = ''; flash(FR, r.error || (r.status === 'accepted' ? `You and ${t} are now friends.` : `Request sent to ${t}.`), !!r.error); };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  const resultRows = (FR.results || []).map((u) => h('div', { class: 'srcrow' }, h('div', { class: 'row', style: 'gap:10px' }, avatar(u.name, 30), h('b', {}, u.name), h('span', { class: 'muted' }, u.relation === 'friend' ? 'already friends' : u.online ? 'online' : '')),
    u.relation === 'friend' ? null : h('button', { class: 'btn sm', disabled: u.pending, onclick: async () => { const r = await socCall('friendRequest', u.name); flash(FR, r.error || `Request sent to ${u.name}.`, !!r.error); } }, u.pending ? 'Pending' : 'Add friend')));
  kids.push(h('div', { class: 'card form' }, h('h3', {}, 'Add friends'), h('div', { class: 'row' }, q, h('button', { class: 'btn ghost', onclick: doSearch }, 'Search'), h('button', { class: 'btn', onclick: addByName }, 'Add by name')),
    FR.msg ? h('div', { class: FR.bad ? 'muted bad' : 'muted ok' }, FR.msg) : null, ...resultRows));

  // list + profile
  const list = (f ? f.friends : []).map((fr) => h('div', { class: 'friend-card' + (FR.sel === fr.name ? ' sel' : ''), onclick: () => selectFriend(fr.name) },
    avatar(fr.name, 38), h('div', { class: 'fc-main' }, h('b', {}, fr.name), h('div', { class: 'muted' }, fr.playing ? 'Playing ' + fr.playing : seenText(fr))), h('span', { class: 'sdot ' + (fr.online ? 'ok' : '') })));
  const cols = h('div', { class: 'soc-cols' },
    h('div', {}, h('h3', { style: 'margin:0 0 10px' }, `Friends${f ? ` (${f.friends.length})` : ''}`), ...(f ? (list.length ? list : [h('div', { class: 'card muted' }, 'No friends yet. Search above, or share your username with someone.')]) : [h('div', { class: 'card muted' }, 'Loading...')])),
    h('div', {}, FR.sel ? profilePanel(FR.profile, h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn ghost sm', onclick: async () => { if (!confirm(`Remove ${FR.sel} from your friends?`)) return; await socCall('friendRemove', FR.sel); FR.sel = ''; FR.profile = null; renderSocial(); } }, 'Remove friend'))) : h('div', { class: 'card muted' }, 'Pick a friend to see their skin value, recent servers and activity.')));
  kids.push(cols);
  const a = document.activeElement; const keepQ = a && a.id === 'fr-q' ? q.value : null;
  body.replaceChildren(...kids);
  if (keepQ != null) { const nq = $('#fr-q'); nq.value = keepQ; nq.focus(); }
}
async function selectFriend(name) {
  FR.sel = name; FR.profile = null; renderSocial(); const my = ++FR.ver;
  const p = await socCall('profile', name); if (my !== FR.ver) return; FR.profile = p; renderSocial();
}

// ------------------------------------------------------------------ clan page
function clanValue(members) {
  const withVal = members.filter((m) => m.value && m.value.total != null); if (!withVal.length) return null;
  const cur = withVal[0].value.currency; const same = withVal.filter((m) => m.value.currency === cur);
  return { total: same.reduce((a, m) => a + m.value.total, 0), currency: cur, shared: same.length };
}
function renderClan() {
  const body = $('#cl-body'); if (!S) return; const s = soc();
  if (!s.linked) return body.replaceChildren(setupCard('clan'));
  const clan = s.clan; const kids = [];
  if (clan === undefined) return body.replaceChildren(h('div', { class: 'card muted' }, 'Loading...'));
  if (!clan) {
    const name = h('input', { placeholder: 'Clan name', maxlength: '24', class: 'grow' }); const tag = h('input', { placeholder: 'TAG', maxlength: '5', class: 'narrow', style: 'text-transform:uppercase' });
    const create = async () => { const r = await socCall('clanCreate', name.value.trim(), tag.value.trim()); if (r.error) flash(CL, r.error, true); else { name.value = ''; tag.value = ''; CL.msg = ''; } };
    kids.push(h('div', { class: 'card form' }, h('h3', {}, 'Create a clan'), h('p', { class: 'muted' }, 'Give your clan a name and a short tag. Then invite your friends: clanmates see each other\'s profile, and the clan page adds up everyone\'s shared skin value.'),
      h('div', { class: 'row' }, name, tag, h('button', { class: 'btn', onclick: create }, 'Create clan')), CL.msg ? h('div', { class: CL.bad ? 'muted bad' : 'muted ok' }, CL.msg) : null));
    kids.push(h('div', { class: 'card form' }, h('h3', {}, `Clan invites${s.invites.length ? ` (${s.invites.length})` : ''}`),
      ...(s.invites.length ? s.invites.map((i) => h('div', { class: 'srcrow' }, h('span', {}, h('b', {}, i.name), ` [${i.tag}] - ${i.members} member${i.members === 1 ? '' : 's'}, led by ${i.owner}`),
        h('div', { class: 'row', style: 'gap:6px' }, h('button', { class: 'btn sm', onclick: async () => { const r = await socCall('clanAccept', i.id); if (r.error) flash(CL, r.error, true); } }, 'Join'), h('button', { class: 'btn ghost sm', onclick: async () => { await socCall('clanDecline', i.id); renderSocial(); } }, 'Decline')))) : [h('div', { class: 'muted' }, 'No invites. Ask a clan owner to invite you (you need to be friends first).')])));
    return body.replaceChildren(...kids);
  }
  const owner = clan.owner === clan.you; const cv = clanValue(clan.members); const onlineN = clan.members.filter((m) => m.online).length;
  kids.push(h('div', { class: 'hero' },
    h('div', { class: 'hero-main' }, h('div', { class: 'muted' }, 'Your clan'), h('div', { class: 'hero-num' }, clan.name, h('span', { class: 'clan-tag' }, clan.tag)), h('div', { class: 'muted' }, `${clan.members.length} member${clan.members.length === 1 ? '' : 's'} - ${onlineN} online`)),
    h('div', { class: 'hero-stats' }, h('div', {}, h('b', {}, cv ? money(cv.total, cv.currency) : '-'), h('span', {}, cv ? `Clan skin value (${cv.shared} sharing)` : 'Clan skin value')), h('div', {}, h('b', {}, String(onlineN)), h('span', {}, 'Online now')))));
  // members + profile
  const members = clan.members.map((m) => h('div', { class: 'friend-card' + (CL.sel === m.name ? ' sel' : ''), onclick: () => selectClanMember(m) },
    avatar(m.name, 38), h('div', { class: 'fc-main' }, h('b', {}, m.name, m.role === 'owner' ? h('span', { class: 'badge', style: 'margin-left:8px' }, 'owner') : null, m.name === s.name ? h('span', { class: 'muted', style: 'margin-left:6px' }, '(you)') : null),
      h('div', { class: 'muted' }, m.playing ? 'Playing ' + m.playing : seenText(m))), h('div', { class: 'fc-val' }, m.value ? money(m.value.total, m.value.currency) : ''), h('span', { class: 'sdot ' + (m.online ? 'ok' : '') })));
  const sel = clan.members.find((m) => m.name === CL.sel);
  const actions = sel && owner && sel.name !== s.name ? h('div', { class: 'row', style: 'margin-top:12px' },
    h('button', { class: 'btn ghost sm', onclick: async () => { if (!confirm(`Make ${sel.name} the clan owner? You will become a regular member.`)) return; const r = await socCall('clanTransfer', sel.name); if (r.error) flash(CL, r.error, true); } }, 'Make owner'),
    h('button', { class: 'btn ghost sm', onclick: async () => { if (!confirm(`Remove ${sel.name} from the clan?`)) return; const r = await socCall('clanKick', sel.name); if (r.error) flash(CL, r.error, true); else { CL.sel = ''; renderSocial(); } } }, 'Remove from clan')) : null;
  kids.push(h('div', { class: 'soc-cols' }, h('div', {}, h('h3', { style: 'margin:0 0 10px' }, 'Members'), ...members), h('div', {}, sel ? profilePanel(sel, actions) : h('div', { class: 'card muted' }, 'Pick a member to see their profile.'))));

  // invite friends
  const inClan = new Set(clan.members.map((m) => m.name)); const friends = ((s.friends && s.friends.friends) || []).filter((f) => !inClan.has(f.name));
  const pick = h('select', {}, h('option', { value: '' }, friends.length ? 'Choose a friend to invite...' : 'No friends available to invite'), ...friends.map((f) => h('option', { value: f.name }, f.name)));
  kids.push(h('div', { class: 'card form' }, h('h3', {}, 'Invite friends'), h('div', { class: 'row' }, pick, h('button', { class: 'btn', onclick: async () => { if (!pick.value) return; const r = await socCall('clanInvite', pick.value); flash(CL, r.error || `Invited ${pick.value}. They can join from their Clan page.`, !!r.error); } }, 'Send invite')),
    CL.msg ? h('div', { class: CL.bad ? 'muted bad' : 'muted ok' }, CL.msg) : null, h('div', { class: 'muted' }, 'Only people on your friends list can be invited. Add friends on the Friends page first.')));
  kids.push(h('div', { class: 'row' }, owner
    ? h('button', { class: 'btn ghost', onclick: async () => { if (!confirm(`Disband ${clan.name}? Every member is removed. This cannot be undone.`)) return; const r = await socCall('clanDisband'); if (r.error) flash(CL, r.error, true); else { CL.sel = ''; renderSocial(); } } }, 'Disband clan')
    : h('button', { class: 'btn ghost', onclick: async () => { if (!confirm(`Leave ${clan.name}?`)) return; const r = await socCall('clanLeave'); if (r.error) flash(CL, r.error, true); else { CL.sel = ''; renderSocial(); } } }, 'Leave clan')));
  body.replaceChildren(...kids);
}
function selectClanMember(m) { CL.sel = m.name; renderSocial(); }

// ------------------------------------------------------------------ hooks
function renderSocial() {
  if (!S) return;
  const off = !!(S.features && S.features.social === false);   // Solo edition: no friends/clans
  for (const t of ['friends', 'clan']) { const b = $(`nav button[data-tab=${t}]`); if (b) b.hidden = off; }
  if (off) return;
  if (!$('#tab-friends').hidden) { const a = document.activeElement; if (!(a && a.closest && a.closest('#fr-body') && a.tagName === 'INPUT' && a.id !== 'fr-q')) renderFriends(); }
  if (!$('#tab-clan').hidden) { const a = document.activeElement; if (!(a && a.closest && a.closest('#cl-body') && (a.tagName === 'INPUT' || a.tagName === 'SELECT'))) renderClan(); }
  const inv = $('#clan-badge'); if (inv) { const n = (soc().invites || []).length; inv.hidden = !n; inv.textContent = n; }
  const rq = $('#friends-badge'); if (rq) { const n = soc().friends ? soc().friends.incoming.length : 0; rq.hidden = !n; rq.textContent = n; }
}
function socialOnTab(name) {
  clearInterval(socTimer);
  if (name !== 'friends' && name !== 'clan') return;
  window.api.socialRefresh().then((v) => { if (S) { S.social = v; renderSocial(); } });
  socTimer = setInterval(() => window.api.socialRefresh().then((v) => { if (S) { S.social = v; renderSocial(); } }), 30000);
  renderSocial();
}

for (const id of ['#fr-refresh', '#cl-refresh']) $(id).addEventListener('click', () => window.api.socialRefresh().then((v) => { if (S) { S.social = v; renderSocial(); } }));
