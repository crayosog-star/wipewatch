'use strict';
// Talks to a Wipewatch social server (see server/server.js). Plain fetch, no Electron, so it can be tested on its own.
// Everything a server sends back is treated as untrusted data by the UI (it is only ever rendered as text).

// https is required unless the server is on this PC (localhost) - tokens must not cross the internet in clear text
function normalizeServerUrl(input) {
  let s = String(input || '').trim(); if (!s) return { error: 'Enter the server address.' };
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u; try { u = new URL(s); } catch (_) { return { error: 'That does not look like a web address.' }; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) return { error: 'Use an https:// address (plain http is only allowed for localhost).' };
  if (u.username || u.password) return { error: 'Do not put a username or password in the address.' };
  return { url: u.origin };
}

class SocialClient {
  constructor(baseUrl, token) { this.base = baseUrl; this.token = token || ''; }
  async call(method, path, body, timeoutMs = 9000) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(this.base + path, { method, signal: ctl.signal, headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: String(j.error || 'Server error (' + r.status + ')').slice(0, 200), status: r.status };
      return j;
    } catch (e) { return { error: e.name === 'AbortError' ? 'The server did not answer in time.' : 'Could not reach the server.', status: 0 }; }
    finally { clearTimeout(t); }
  }
  health() { return this.call('GET', '/health'); }
  register(name) { return this.call('POST', '/register', { name }); }
  me() { return this.call('GET', '/me'); }
  updateMe(patch) { return this.call('PUT', '/me', patch); }
  pushSnapshot(s) { return this.call('PUT', '/snapshot', s); }
  deleteAccount() { return this.call('DELETE', '/me'); }
  search(q) { return this.call('GET', '/search?q=' + encodeURIComponent(q)); }
  friends() { return this.call('GET', '/friends'); }
  friendRequest(name) { return this.call('POST', '/friends/request', { name }); }
  friendAccept(name) { return this.call('POST', '/friends/accept', { name }); }
  friendDecline(name) { return this.call('POST', '/friends/decline', { name }); }
  friendCancel(name) { return this.call('POST', '/friends/cancel', { name }); }
  friendRemove(name) { return this.call('POST', '/friends/remove', { name }); }
  profile(name) { return this.call('GET', '/profile/' + encodeURIComponent(name)); }
  clanMine() { return this.call('GET', '/clans/mine'); }
  clanInvites() { return this.call('GET', '/clans/invites'); }
  clanCreate(name, tag) { return this.call('POST', '/clans', { name, tag }); }
  clanInvite(name) { return this.call('POST', '/clans/invite', { name }); }
  clanAccept(clanId) { return this.call('POST', '/clans/accept', { clanId }); }
  clanDecline(clanId) { return this.call('POST', '/clans/decline', { clanId }); }
  clanLeave() { return this.call('POST', '/clans/leave'); }
  clanKick(name) { return this.call('POST', '/clans/kick', { name }); }
  clanTransfer(name) { return this.call('POST', '/clans/transfer', { name }); }
  clanDisband() { return this.call('POST', '/clans/disband'); }
}

module.exports = { SocialClient, normalizeServerUrl };
