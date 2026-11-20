'use strict';
// Publishes built installers as a GitHub release. Uses the GitHub credentials already saved by git (nothing is stored here).
// Usage: node tools/publish-release.js <owner/repo> [--solo-only]      (build first: npm run installer:solo, and npm run installer for the full edition)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const repo = process.argv[2];
const SOLO_ONLY = process.argv.includes('--solo-only');
if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) { console.error('Usage: node tools/publish-release.js owner/repo [--solo-only]'); process.exit(1); }
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tag = 'v' + pkg.version;
const names = SOLO_ONLY ? [`Wipewatch-Solo-Setup-${pkg.version}.exe`] : [`Wipewatch-Setup-${pkg.version}.exe`, `Wipewatch-Solo-Setup-${pkg.version}.exe`];
const files = names.map((n) => path.join(root, 'dist', n));
const assetName = (f) => path.basename(f).replace(`-${pkg.version}`, '');   // stable names so releases/latest/download/<name> never changes
for (const f of files) if (!fs.existsSync(f)) { console.error('Missing ' + f); process.exit(1); }

const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
const cred = Object.fromEntries(out.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const headers = { Authorization: 'Bearer ' + cred.password, 'User-Agent': 'wipewatch-publish', Accept: 'application/vnd.github+json' };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

(async () => {
  const sums = files.map((f) => `${sha(f)}  ${assetName(f)}`);
  const body = [
    `## Wipewatch ${pkg.version}${SOLO_ONLY ? ' (Solo edition)' : ''}`, '',
    'Windows 10/11 installer. Per-user install (no admin rights), Start Menu and Desktop shortcuts, uninstaller included.', '',
    ...(SOLO_ONLY
      ? ['**Solo edition**: drops, skins, servers, patch notes, wipe planner, build ideas, raid calculator and more, without the Friends and Clans pages.']
      : ['- **Wipewatch-Setup** - the full app, including Friends and Clans.', '- **Wipewatch-Solo-Setup** - the same app without Friends and Clans (and without any of the social code).']), '',
    'The installer is **not code-signed**, so Windows SmartScreen may ask you to confirm ("More info" then "Run anyway"). You can verify your download against this SHA-256 checksum:', '',
    '```', ...sums, '```',
  ].join('\n');
  let r = await fetch(`https://api.github.com/repos/${repo}/releases`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ tag_name: tag, target_commitish: 'main', name: `Wipewatch ${pkg.version}${SOLO_ONLY ? ' (Solo)' : ''}`, body, draft: false, prerelease: false }) });
  if (!r.ok) { console.error('create release failed', r.status, (await r.text()).slice(0, 300)); process.exit(1); }
  const rel = await r.json(); console.log('release created:', rel.html_url);
  for (const f of files) {
    const buf = fs.readFileSync(f); console.log('uploading', assetName(f), Math.round(buf.length / 1048576) + ' MB ...');
    const up = await fetch(`https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(assetName(f))}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) }, body: buf });
    if (!up.ok) { console.error('upload failed', up.status, (await up.text()).slice(0, 300)); process.exit(1); }
    const a = await up.json(); console.log('  ->', a.browser_download_url, `(${a.state})`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
