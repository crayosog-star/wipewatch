'use strict';
// Builds a portable Windows app: dist/Wipewatch-win32-x64/Wipewatch.exe
// `node tools/package.js --solo` builds the Solo edition (no Friends/Clan, no social server) into dist/Wipewatch-Solo-win32-x64.
// Uses the Electron runtime already in node_modules (no downloads), copies the app into resources/app,
// renames the exe and stamps the Wipewatch icon + version info onto it.
const fs = require('fs');
const path = require('path');
const { rcedit } = require('rcedit');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const SOLO = process.argv.includes('--solo');
const out = path.join(root, 'dist', SOLO ? 'Wipewatch-Solo-win32-x64' : 'Wipewatch-win32-x64');
const exe = path.join(out, 'Wipewatch.exe');

(async () => {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.cpSync(path.join(root, 'node_modules', 'electron', 'dist'), out, { recursive: true });
  fs.renameSync(path.join(out, 'electron.exe'), exe);
  fs.rmSync(path.join(out, 'resources', 'default_app.asar'), { force: true });

  const app = path.join(out, 'resources', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.cpSync(path.join(root, 'src'), path.join(app, 'src'), { recursive: true, filter: (src) => !/[\\/]demo\.js$/.test(src) });   // demo.js is a development tool (README screenshots), not shipped
  fs.cpSync(path.join(root, 'assets'), path.join(app, 'assets'), { recursive: true });
  if (!SOLO) fs.cpSync(path.join(root, 'server'), path.join(app, 'server'), { recursive: true, filter: (src) => !/[\\/]data([\\/]|$)/.test(src) });   // the friends/clans server, so it can be hosted from an install
  else {   // Solo edition: take the whole social feature out of the shipped files
    for (const f of ['social.js', 'social-client.js', 'social-ui.js']) fs.rmSync(path.join(app, 'src', f), { force: true });
    const htmlPath = path.join(app, 'src', 'index.html'); let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(/\s*<button data-tab="(friends|clan)">[\s\S]*?<\/button>/g, '')
      .replace(/\s*<!-- =+ FRIENDS =+ -->[\s\S]*?(?=\s*<!-- =+ BUILD IDEAS =+ -->)/, '')
      .replace(/\s*<script src="social-ui\.js"><\/script>/, '');
    fs.writeFileSync(htmlPath, html);
  }
  const slim = { name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, main: pkg.main, author: pkg.author, license: pkg.license, ...(SOLO ? { wipewatch: { social: false } } : {}) };
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(slim, null, 2));

  await rcedit(exe, {
    icon: path.join(root, 'assets', 'icon.ico'),
    'version-string': { ProductName: 'Wipewatch', FileDescription: 'Wipewatch - your Rust companion', CompanyName: 'Wipewatch', InternalName: 'Wipewatch', OriginalFilename: 'Wipewatch.exe', LegalCopyright: 'Wipewatch' },
    'file-version': pkg.version, 'product-version': pkg.version,
  });
  const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
  console.log(`Built ${exe} (${Math.round(size(out) / 1048576)} MB)`);
})().catch((e) => { console.error('Packaging failed:', e); process.exit(1); });
