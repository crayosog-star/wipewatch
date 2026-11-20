'use strict';
// Builds dist/Wipewatch-Setup-<version>.exe from dist/Wipewatch-win32-x64 using Windows' built-in tar + IExpress (nothing is downloaded).
// Run `node tools/package.js` first (or `npm run installer`, which does both).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const SOLO = process.argv.includes('--solo');
const app = path.join(root, 'dist', SOLO ? 'Wipewatch-Solo-win32-x64' : 'Wipewatch-win32-x64');
if (!fs.existsSync(path.join(app, 'Wipewatch.exe'))) { console.error(`Run "node tools/package.js${SOLO ? ' --solo' : ''}" first.`); process.exit(1); }
const sys = path.join(process.env.SystemRoot, 'System32');
const work = path.join(root, 'dist', SOLO ? 'installer-work-solo' : 'installer-work');
fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
const out = path.join(root, 'dist', `Wipewatch-${SOLO ? 'Solo-' : ''}Setup-${pkg.version}.exe`);
fs.rmSync(out, { force: true });

console.log('Compressing app files...');
execFileSync(path.join(sys, 'tar.exe'), ['-a', '-c', '-f', path.join(work, 'payload.zip'), '-C', app, '.'], { stdio: 'inherit' });
fs.writeFileSync(path.join(work, 'install.ps1'), fs.readFileSync(path.join(__dirname, 'installer', 'install.ps1'), 'utf8').replace('__VERSION__', pkg.version));
fs.copyFileSync(path.join(__dirname, 'installer', 'uninstall.ps1'), path.join(work, 'uninstall.ps1'));

const files = ['payload.zip', 'install.ps1', 'uninstall.ps1'];
const sed = [
  '[Version]', 'Class=IEXPRESS', 'SEDVersion=3',
  '[Options]', 'PackagePurpose=InstallApp', 'ShowInstallProgramWindow=0', 'HideExtractAnimation=1', 'UseLongFileName=1', 'InsideCompressed=0',
  'CAB_FixedSize=0', 'CAB_ResvCodeSigning=0', 'RebootMode=N', 'InstallPrompt=', 'DisplayLicense=', 'FinishMessage=',
  `TargetName=${out}`, 'FriendlyName=Wipewatch setup',
  'AppLaunched=powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File install.ps1',
  'PostInstallCmd=<None>', 'AdminQuietInstCmd=', 'UserQuietInstCmd=', 'SourceFiles=SourceFiles',
  '[Strings]', ...files.map((f, i) => `FILE${i}="${f}"`),
  '[SourceFiles]', `SourceFiles0=${work}\\`,
  '[SourceFiles0]', ...files.map((f, i) => `%FILE${i}%=`),
  '',
].join('\r\n');
fs.writeFileSync(path.join(work, 'wipewatch.sed'), sed);

console.log('Building setup exe (IExpress)...');
execFileSync(path.join(sys, 'iexpress.exe'), ['/N', '/Q', path.join(work, 'wipewatch.sed')], { stdio: 'inherit' });
if (!fs.existsSync(out)) { console.error('IExpress did not produce the installer.'); process.exit(1); }
console.log(`Built ${out} (${Math.round(fs.statSync(out).size / 1048576)} MB)`);
