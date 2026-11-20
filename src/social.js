'use strict';
// Main-process side of Friends and Clans: keeps this PC's account link, publishes your shareable snapshot,
// polls friends / clan / invites, and exposes a small allow-listed API to the window.
// ctx: { data(), save(), push(), notify(title, body, opts), skinState(), statsHours(), log() }
const { SocialClient, normalizeServerUrl } = require('./social-client');

const SNAPSHOT_EVERY_MS = 2 * 60000;
const POLL_EVERY_MS = 60000;
const ALLOWED = new Set(['search', 'friendRequest', 'friendAccept', 'friendDecline', 'friendCancel', 'friendRemove', 'profile',
  'clanCreate', 'clanInvite', 'clanAccept', 'clanDecline', 'clanLeave', 'clanKick', 'clanTransfer', 'clanDisband']);
const MUTATES = new Set([...ALLOWED].filter((m) => m !== 'search' && m !== 'profile'));

function createSocial(ctx) {
  const st = { error: '', friends: null, clan: undefined, invites: [], at: 0, selfPlaying: null, polling: false, lastCounts: null, snapshotTimer: null, pollTimer: null };
  const cfg = () => ctx.data().social;
  const client = () => (cfg().server && cfg().token ? new SocialClient(cfg().server, cfg().token) : null);
  const linked = () => !!(cfg().server && cfg().token);

  // ---- what we publish: only the shareable summary, never keys, webhook, Steam id, friends' names, or your alert thresholds
  function buildSnapshot() {
    const d = ctx.data(); const k = ctx.skinState(); const snap = {};
    if (k.priced) {
      const top = [...k.items].filter((i) => i.lowest != null).sort((a, b) => b.lowest * b.count - a.lowest * a.count).slice(0, 5).map((i) => ({ name: i.name, each: i.lowest, count: i.count }));
      snap.value = { total: +k.total.toFixed(2), net: +k.totalNet.toFixed(2), count: k.count, currency: k.currency, top };
    }
    snap.activity = d.log.filter((e) => ['claim', 'ready', 'patch', 'price'].includes(e.type))
      .map((e) => ({ t: e.t, type: e.type, text: String(e.text || '').replace(/\s*\((your alert|alert)[^)]*\)/i, '').slice(0, 160) })).slice(0, 15);
    snap.servers = (d.recentServers || []).slice(0, 10).map((s) => ({ name: s.name, t: s.t }));
    snap.hours = ctx.statsHours();
    snap.playing = st.selfPlaying && Date.now() - st.selfPlaying.at < 6 * 60000 ? st.selfPlaying.name : null;
    return snap;
  }
  async function pushSnapshot() {
    const c = client(); if (!c) return;
    const r = await c.pushSnapshot(buildSnapshot());
    if (r.error) { st.error = r.error; if (r.status === 401) { st.error = 'Your account is no longer valid on this server. Set up again.'; } } else if (st.error && !st.error.startsWith('Your account')) st.error = '';
  }

  const summarize = (r) => (r && !r.error ? r : null);
  async function refresh() {
    const c = client(); if (!c || st.polling) return; st.polling = true;
    try {
      const [f, inv, cl] = await Promise.all([c.friends(), c.clanInvites(), c.clanMine()]);
      const bad = [f, inv, cl].find((r) => r.error);
      if (bad) { st.error = bad.status === 401 ? 'Your account is no longer valid on this server. Set up again.' : bad.error; }
      else {
        st.error = ''; st.friends = f; st.invites = inv.invites || []; st.clan = cl.clan || null; st.at = Date.now();
        // local-only heads-up when something new arrives (never sent to Discord)
        const counts = { req: f.incoming.length, inv: st.invites.length, friends: f.friends.length };
        const prev = st.lastCounts; st.lastCounts = counts;
        if (prev) {
          if (counts.req > prev.req) ctx.notify('New friend request', `${f.incoming[0].name} wants to be your friend on Wipewatch.`, { discord: false, color: 0x5865f2 });
          if (counts.inv > prev.inv) ctx.notify('Clan invite', `You were invited to join ${st.invites[0].name} [${st.invites[0].tag}].`, { discord: false, color: 0x5865f2 });
          if (counts.friends > prev.friends && counts.req <= prev.req) ctx.notify('New friend', 'A friend request was accepted.', { discord: false, color: 0x57f287 });
        }
      }
    } finally { st.polling = false; }
    ctx.push();
  }

  function schedule() {
    clearInterval(st.snapshotTimer); clearInterval(st.pollTimer);
    if (!linked()) return;
    st.snapshotTimer = setInterval(() => pushSnapshot().catch(() => {}), SNAPSHOT_EVERY_MS);
    st.pollTimer = setInterval(() => refresh().catch(() => {}), POLL_EVERY_MS);
    pushSnapshot().then(refresh).catch(() => {});
  }

  const view = () => {
    const c = cfg();
    return { linked: linked(), server: c.server, name: c.name, visibility: c.visibility, share: c.share, error: st.error, at: st.at,
      friends: st.friends, clan: st.clan === undefined ? undefined : st.clan, invites: st.invites };
  };

  async function setup({ server, name }) {
    const n = normalizeServerUrl(server); if (n.error) return { error: n.error };
    const c = new SocialClient(n.url);
    const h = await c.health(); if (h.error || h.name !== 'wipewatch-server') return { error: h.error && h.status === 0 ? 'Could not reach that server.' : 'That address is not a Wipewatch server.' };
    const r = await c.register(String(name || '').trim()); if (r.error) return { error: r.error };
    Object.assign(cfg(), { server: n.url, id: r.id, name: r.name, token: r.token, visibility: r.visibility || 'open', share: { ...cfg().share, ...(r.share || {}) } });
    st.friends = null; st.clan = undefined; st.invites = []; st.lastCounts = null; st.error = '';
    ctx.save(); schedule(); ctx.push(); return { ok: true };
  }
  function forget() {   // stop using the account on this PC (the account itself stays on the server)
    Object.assign(cfg(), { id: '', name: '', token: '' }); st.friends = null; st.clan = undefined; st.invites = []; st.lastCounts = null; st.error = '';
    clearInterval(st.snapshotTimer); clearInterval(st.pollTimer); ctx.save(); ctx.push(); return { ok: true };
  }

  function register(ipcMain) {
    ipcMain.handle('social:get', () => view());
    ipcMain.handle('social:setup', (_e, a) => setup(a || {}));
    ipcMain.handle('social:forget', () => forget());
    ipcMain.handle('social:delete', async () => { const c = client(); if (!c) return { error: 'Not set up.' }; const r = await c.deleteAccount(); if (r.error && r.status !== 401) return r; forget(); return { ok: true }; });
    ipcMain.handle('social:refresh', async () => { await pushSnapshot().catch(() => {}); await refresh().catch(() => {}); return view(); });
    ipcMain.handle('social:settings', async (_e, patch) => {
      const c = client(); if (!c) return { error: 'Not set up.' };
      const body = {}; if (['open', 'private'].includes(patch && patch.visibility)) body.visibility = patch.visibility;
      if (patch && patch.share && typeof patch.share === 'object') body.share = Object.fromEntries(['value', 'activity', 'servers', 'hours', 'playing'].filter((k) => typeof patch.share[k] === 'boolean').map((k) => [k, patch.share[k]]));
      const r = await c.updateMe(body); if (r.error) return r;
      cfg().visibility = r.visibility; cfg().share = r.share; ctx.save(); ctx.push(); return view();
    });
    ipcMain.handle('social:call', async (_e, method, ...args) => {
      if (!ALLOWED.has(method)) return { error: 'Unknown action.' };
      const c = client(); if (!c) return { error: 'Not set up.' };
      const r = await c[method](...args.map((a) => (typeof a === 'string' ? a.slice(0, 60) : a)));
      if (MUTATES.has(method) && !r.error) { await refresh().catch(() => {}); }
      return r;
    });
  }

  return { register, schedule, pushSnapshot, refresh, view, buildSnapshot, linked, setPlaying: (name) => { st.selfPlaying = name ? { name, at: Date.now() } : null; }, state: st };
}

module.exports = { createSocial };
