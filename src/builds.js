'use strict';
// Build Ideas: recent Rust base-building videos from YouTube's public channel feeds (no key, no scraping of search).
// Each feed lists a channel's latest uploads with view counts; we rank them by views for their age ("hot").
const UA = 'Wipewatch/1.2 (desktop app)';

// Channels that publish Rust base content (user can add/remove more in the app)
const DEFAULT_CHANNELS = [
  { id: 'UC_KL-AxUUmpEFvmqc2rKe6g', name: 'PrinceVidz', rustOnly: true },
  { id: 'UCnuk6QPjyRA_SCE4I6RcPbA', name: 'CrowRust', rustOnly: true },
  { id: 'UCvVyqMCjiDSLkuhVMGnp8mQ', name: 'spinky', rustOnly: false },
];

const BUILD_RE = /\b(base|bases|build|builds|building|bunker|bunkers|design|designs|layout|compound|honeycomb|twig|raid[- ]?proof|trap|tour|fortress|castle|shelter|cave|tunnel|turret|egg|rate my base|clan|solo|duo|trio|quad)\b/i;

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const pick = (s, re) => { const m = re.exec(s); return m ? m[1] : ''; };

function parseFeed(xml) {
  const channel = decode(pick(xml, /<author>\s*<name>([^<]*)/));
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const vid = pick(e, /<yt:videoId>([\w-]{11})</);
    if (!vid) continue;
    out.push({
      id: vid, title: decode(pick(e, /<title>([^<]*)</)), channel: decode(pick(e, /<author>\s*<name>([^<]*)/)) || channel,
      published: Date.parse(pick(e, /<published>([^<]*)</)) || 0, views: parseInt(pick(e, /<media:statistics views="(\d+)"/), 10) || 0,
      url: 'https://www.youtube.com/watch?v=' + vid, thumb: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
    });
  }
  return { channel, videos: out };
}

// YouTube's RSS feeds are intermittently down (404/500). Fallback: read the channel's public videos page.
const AGE_MS = { m: 6e4, h: 36e5, d: 864e5, w: 6048e5, mo: 2592e6, y: 31536e6 };
function parsePage(html) {
  const m = /var ytInitialData = (\{.*?\});<\/script>/s.exec(html); if (!m) return { channel: '', videos: [] };
  const j = JSON.parse(m[1]); const out = []; const now = Date.now();
  const strings = (x, acc) => { if (!x || typeof x !== 'object') return acc; if (typeof x.content === 'string') acc.push(x.content); for (const k in x) strings(x[k], acc); return acc; };
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    const v = o.lockupViewModel;
    if (v && v.contentId && /VIDEO/.test(v.contentType || '')) {
      const md = v.metadata && v.metadata.lockupMetadataViewModel; const title = md && md.title && md.title.content; const rows = strings(md && md.metadata, []);
      const age = rows.map((r) => /^(\d+)\s*(mo|y|w|d|h|m)\w*\s+ago$/i.exec(r.trim())).find(Boolean);
      const vw = rows.map((r) => /^([\d.,]+)\s*([KMB])?(\s+views)?$/i.exec(r.trim())).find(Boolean);
      if (title && age) {
        const mult = { K: 1e3, M: 1e6, B: 1e9 }[(vw && vw[2] || '').toUpperCase()] || 1;
        out.push({ id: v.contentId, title, channel: '', published: now - parseInt(age[1], 10) * AGE_MS[age[2].toLowerCase()], views: vw ? Math.round(parseFloat(vw[1].replace(/,/g, '')) * mult) : 0,
          url: 'https://www.youtube.com/watch?v=' + v.contentId, thumb: `https://i.ytimg.com/vi/${v.contentId}/hqdefault.jpg` });
      }
      return;
    }
    for (const k in o) walk(o[k]);
  })(j);
  const channel = decode((/<title>([^<]*?)(?: - YouTube)?<\/title>/.exec(html) || [])[1] || '');
  for (const v of out) v.channel = channel;
  return { channel, videos: out };
}
async function fetchFeed(channelId) {
  const id = encodeURIComponent(channelId);
  let status = 0;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch('https://www.youtube.com/feeds/videos.xml?channel_id=' + id, { headers: { 'User-Agent': UA } });
      if (r.ok) return parseFeed(await r.text());
      status = r.status;
    } catch (e) { status = 0; }
    await new Promise((res) => setTimeout(res, 700));
  }
  try {   // feed down: fall back to the public channel page
    const r = await fetch(`https://www.youtube.com/channel/${id}/videos`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en' } });
    if (r.ok) { const f = parsePage(await r.text()); if (f.videos.length) return f; }
  } catch (_) { /* fall through */ }
  throw new Error('YouTube feed unavailable (' + (status || 'network') + ')');
}

// Accepts @handle, a channel id, or a youtube.com link; returns { id, name, rustOnly }
async function resolveChannel(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter a channel handle or link');
  let id = (/^UC[\w-]{22}$/.exec(s) || [])[0];
  if (!id) {
    let url;
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      if (!/(^|\.)youtube\.com$/i.test(u.hostname)) throw new Error('Only youtube.com links are supported');
      const cm = /\/channel\/(UC[\w-]{22})/.exec(u.pathname); if (cm) id = cm[1];
      url = 'https://www.youtube.com' + u.pathname;
    } else {
      s = s.replace(/^@/, '');
      if (!/^[\w.-]{2,60}$/.test(s)) throw new Error('That does not look like a channel handle');
      url = 'https://www.youtube.com/@' + s;
    }
    if (!id) {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
      if (!r.ok) throw new Error('Channel not found');
      const t = await r.text();
      id = pick(t, /"channelId":"(UC[\w-]{22})"/) || pick(t, /channel_id=(UC[\w-]{22})/);
      if (!id) throw new Error('Could not find that channel');
    }
  }
  const f = await fetchFeed(id);
  if (!f.videos.length) throw new Error('That channel has no public uploads');
  const rustShare = f.videos.filter((v) => /rust/i.test(v.title)).length / f.videos.length;
  return { id, name: f.channel || id, rustOnly: rustShare >= 0.5 };
}

const looksLikeBuild = (v, ch) => BUILD_RE.test(v.title) && (ch.rustOnly || /rust/i.test(v.title));

// Returns { videos, errors } with a "hot" score: views, discounted by age
async function fetchBuilds(channels, maxAgeDays = 60) {
  const errors = {}; const now = Date.now(); const all = [];
  await Promise.all(channels.map(async (ch) => {
    try {
      const f = await fetchFeed(ch.id);
      for (const v of f.videos) {
        const ageDays = (now - v.published) / 864e5;
        if (ageDays > maxAgeDays || !looksLikeBuild(v, ch)) continue;
        all.push({ ...v, hot: v.views / Math.pow(ageDays + 2, 1.3) });
      }
    } catch (e) { errors[ch.name || ch.id] = e.message; }
  }));
  const seen = new Set();
  const videos = all.filter((v) => (seen.has(v.id) ? false : seen.add(v.id))).sort((a, b) => b.hot - a.hot);
  return { videos, errors };
}

module.exports = { DEFAULT_CHANNELS, fetchBuilds, resolveChannel, parseFeed, looksLikeBuild };
