const fs = require('fs');
const BE = (o, n, buf) => buf.readUInt32BE(o + n);
const findBox = (buf, type, from = 0) => {
  let idx = from;
  while ((idx = buf.indexOf(type, idx)) !== -1) {
    if (idx >= 8) {
      const size = BE(idx - 4, 0, buf);
      if (size >= 8 && idx - 4 + size <= buf.length) return { off: idx - 4, size, type };
    }
    idx += 4;
  }
  return null;
};
const walk = (buf, start, end, want) => {
  const out = []; let p = start;
  while (p + 8 <= end) { const size = BE(p, 0, buf); const t = buf.toString('latin1', p + 4, p + 8); if (size < 8 || p + size > end) break; if (!want || t === want) out.push({ t, off: p, size }); p += size; }
  return out;
};
console.log('=== owner_test.mp4 ===');
const buf = fs.readFileSync('/tmp/owner_test.mp4');
console.log('size', buf.length, 'ftyp', buf.toString('latin1', 4, 8));
const moov = findBox(buf, 'moov');
console.log('moov found:', moov ? `@${moov.off} size=${moov.size}` : 'NO');
if (moov) {
  const mvhd = walk(buf, moov.off + 8, moov.off + moov.size, 'mvhd')[0];
  if (mvhd) { const v = buf.readUInt8(mvhd.off + 8); const C = mvhd.off + 8; const ts = v === 1 ? Number(buf.readBigUInt64BE(C + 20)) : BE(mvhd.off, 20, buf); const dur = v === 1 ? Number(buf.readBigUInt64BE(C + 28)) : BE(mvhd.off, 24, buf); console.log(`mvhd: ${(dur / ts).toFixed(3)}s (ts=${ts})`); }
  for (const trak of walk(buf, moov.off + 8, moov.off + moov.size, 'trak')) {
    const mdia = walk(buf, trak.off + 8, trak.off + trak.size, 'mdia')[0];
    const hdlr = walk(buf, mdia.off + 8, mdia.off + mdia.size, 'hdlr')[0];
    const type = hdlr ? buf.toString('latin1', hdlr.off + 16, hdlr.off + 20) : '?';
    const mdhd = walk(buf, mdia.off + 8, mdia.off + mdia.size, 'mdhd')[0];
    const v = mdhd ? buf.readUInt8(mdhd.off + 8) : 0; const ts = mdhd ? (v === 1 ? Number(buf.readBigUInt64BE(mdhd.off + 8 + 20)) : BE(mdhd.off, 8 + 12, buf)) : 0;
    const minf = walk(buf, mdia.off + 8, mdia.off + mdia.size, 'minf')[0];
    const stbl = walk(buf, minf.off + 8, minf.off + minf.size, 'stbl')[0];
    const stts = walk(buf, stbl.off + 8, stbl.off + stbl.size, 'stts')[0];
    const n = stts ? BE(stts.off, 12, buf) : 0; let samples = 0, total = 0; const deltas = [];
    for (let i = 0; i < n; i++) { const c = BE(stts.off, 16 + i * 8, buf); const d = BE(stts.off, 20 + i * 8, buf); samples += c; total += c * d; for (let j = 0; j < c && deltas.length < 300; j++) deltas.push(d); }
    const f = walk(buf, stbl.off + 8, stbl.off + stbl.size, 'stsd')[0];
    let codec = '?'; if (f) { const e = walk(buf, f.off + 8 + 8, f.off + f.size)[0]; if (e) codec = buf.toString('latin1', e.off + 8, e.off + 12); }
    const w = buf.toString('latin1', stbl.off + 4, stbl.off + 4); // placeholder
    console.log(`trak ${type}: codec=${codec} samples=${samples} dur=${(total / ts).toFixed(3)}s  deltasFirst8=${deltas.slice(0, 8).join(',')}  deltasLast8=${deltas.slice(-8).join(',')}`);
  }
}
console.log('=== mp3s (skip ID3) ===');
for (const f of ['aud_1.mp3', 'aud_2.mp3', 'aud_3.mp3']) {
  const d = fs.readFileSync('/tmp/' + f);
  let p = 0;
  if (d.toString('latin1', 0, 3) === 'ID3') {
    const sz = (d[6] & 0x7f) * 0x200000 + (d[7] & 0x7f) * 0x4000 + (d[8] & 0x7f) * 0x80 + (d[9] & 0x7f);
    p = 10 + sz;
  }
  const found = d.indexOf(0xff, p);
  if (found < 0 || found + 4 > d.length) { console.log(f, `id3skip=${p} no frame after skip`); continue; }
  const h = d.readUInt32BE(found);
  const ver = (h >> 19) & 3, layer = (h >> 17) & 3, brIdx = (h >> 12) & 15, srIdx = (h >> 10) & 3;
  const verS = ver === 3 ? 'MPEG1' : 'MPEG2';
  const layerS = layer === 3 ? 'I' : layer === 2 ? 'II' : 'III';
  const srs = [44100, 48000, 32000]; const sr = ver === 3 ? srs[srIdx] : srs[srIdx] / 2;
  const brs = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]; const br = brs[brIdx];
  const spf = 1152;
  const flen = Math.floor(144 * br * 1000 / sr);
  if (flen <= 0) { console.log(f, 'bad flen'); continue; }
  // walk frames until garbage
  let nframes = 0, pos = found;
  while (pos + 4 <= d.length && (d.readUInt32BE(pos) & 0xffe00000) === 0xffe00000) { nframes++; pos += flen; }
  console.log(`${f}: ${verS} ${layerS} ${br}kbps ${sr}Hz id3skip=${p} nframes=${nframes} dur≈${(nframes * spf / sr).toFixed(2)}s`);
}