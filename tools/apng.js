'use strict';
// Minimal APNG (animated PNG) assembler: takes same-sized PNG buffers and returns one animated PNG.
// GitHub READMEs, browsers and most image viewers play these natively, with full 24-bit colour (unlike GIF).
const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const crc = (buf) => (zlib.crc32 ? zlib.crc32(buf) >>> 0 : slowCrc(buf));
function slowCrc(buf) { let c; let crcv = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crcv ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcv = (crcv >>> 8) ^ c; } return (crcv ^ 0xffffffff) >>> 0; }
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };

function parse(png) {
  if (!png.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  const out = []; let off = 8;
  while (off < png.length) { const len = png.readUInt32BE(off); const type = png.toString('ascii', off + 4, off + 8); out.push({ type, data: png.subarray(off + 8, off + 8 + len) }); off += 12 + len; }
  return out;
}

// frames: [{ png: Buffer, delayMs: number }], loops: 0 = forever
function makeApng(frames, loops = 0) {
  const first = parse(frames[0].png); const ihdr = first.find((c) => c.type === 'IHDR').data;
  const w = ihdr.readUInt32BE(0); const h = ihdr.readUInt32BE(4);
  const parts = [SIG, chunk('IHDR', ihdr)];
  for (const c of first) if (['PLTE', 'tRNS', 'gAMA', 'sRGB', 'cHRM', 'iCCP'].includes(c.type)) parts.push(chunk(c.type, c.data));
  const actl = Buffer.alloc(8); actl.writeUInt32BE(frames.length, 0); actl.writeUInt32BE(loops, 4); parts.push(chunk('acTL', actl));
  let seq = 0;
  const fctl = (delayMs) => { const b = Buffer.alloc(26); b.writeUInt32BE(seq++, 0); b.writeUInt32BE(w, 4); b.writeUInt32BE(h, 8); b.writeUInt32BE(0, 12); b.writeUInt32BE(0, 16); b.writeUInt16BE(Math.max(1, Math.round(delayMs)), 20); b.writeUInt16BE(1000, 22); b[24] = 0; b[25] = 0; return chunk('fcTL', b); };
  frames.forEach((f, i) => {
    const cs = parse(f.png); const fh = cs.find((c) => c.type === 'IHDR').data;
    if (fh.readUInt32BE(0) !== w || fh.readUInt32BE(4) !== h) throw new Error('frame size mismatch');
    parts.push(fctl(f.delayMs));
    for (const c of cs.filter((x) => x.type === 'IDAT')) {
      if (i === 0) parts.push(chunk('IDAT', c.data));
      else { const s = Buffer.alloc(4); s.writeUInt32BE(seq++, 0); parts.push(chunk('fdAT', Buffer.concat([s, c.data]))); }
    }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

module.exports = { makeApng };
