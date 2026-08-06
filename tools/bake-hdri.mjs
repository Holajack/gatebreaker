// Bakes a source .exr into a compact Radiance .hdr the game can ship.
//
// The source Poly Haven EXR is 6.1MB of 2048x1024 PIZ-compressed float — far
// more than an APK wants to carry, and PIZ decoding in a phone WebView is slow.
// PMREMGenerator blurs the map into a small prefiltered cubemap for lighting
// anyway, so almost all of that resolution is thrown away.
//
// We box-downsample in linear light (averaging *before* any encoding, which is
// the only correct order) and re-emit as run-length-encoded RGBE, which three's
// stock RGBELoader reads directly.
//
//   node tools/bake-hdri.mjs assets/hdri/moonless_golf_2k.exr public/hdri/rift_sky.hdr 512

import fs from 'node:fs';
import path from 'node:path';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { DataUtils } from 'three';

const [, , inPath, outPath, widthArg] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node tools/bake-hdri.mjs <in.exr> <out.hdr> [width]');
  process.exit(1);
}
const targetW = Number(widthArg || 512);
const targetH = targetW / 2;

const buf = fs.readFileSync(inPath);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const loader = new EXRLoader();
const exr = loader.parse(ab);
const { width: sw, height: sh, data, type } = exr;
console.log(`source ${sw}x${sh}  type=${type === 1016 ? 'half' : 'float'}  texels=${sw * sh}`);

// Normalise whatever the loader gave us into linear float RGB.
const toFloat = (i) => (data instanceof Uint16Array ? DataUtils.fromHalfFloat(data[i]) : data[i]);

// --- box downsample in linear light ---
const bx = sw / targetW;
const by = sh / targetH;
const out = new Float32Array(targetW * targetH * 3);
let maxLum = 0;

for (let y = 0; y < targetH; y++) {
  const y0 = Math.floor(y * by), y1 = Math.min(sh, Math.ceil((y + 1) * by));
  for (let x = 0; x < targetW; x++) {
    const x0 = Math.floor(x * bx), x1 = Math.min(sw, Math.ceil((x + 1) * bx));
    let r = 0, g = 0, b = 0, n = 0;
    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const i = (sy * sw + sx) * 4;
        r += toFloat(i); g += toFloat(i + 1); b += toFloat(i + 2);
        n++;
      }
    }
    const o = (y * targetW + x) * 3;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    maxLum = Math.max(maxLum, 0.2126 * out[o] + 0.7152 * out[o + 1] + 0.0722 * out[o + 2]);
  }
}
console.log(`downsampled to ${targetW}x${targetH}, peak luminance ${maxLum.toFixed(3)}`);

// --- encode RGBE: a shared exponent per texel keeps HDR range in 4 bytes ---
function toRGBE(r, g, b, dst, o) {
  const v = Math.max(r, g, b);
  if (v < 1e-32) { dst[o] = dst[o + 1] = dst[o + 2] = dst[o + 3] = 0; return; }
  const e = Math.ceil(Math.log2(v));
  const s = Math.pow(2, -e) * 256;
  dst[o] = Math.min(255, Math.max(0, Math.floor(r * s)));
  dst[o + 1] = Math.min(255, Math.max(0, Math.floor(g * s)));
  dst[o + 2] = Math.min(255, Math.max(0, Math.floor(b * s)));
  dst[o + 3] = e + 128;
}

const rgbe = new Uint8Array(targetW * targetH * 4);
for (let i = 0, p = 0; i < out.length; i += 3, p += 4) toRGBE(out[i], out[i + 1], out[i + 2], rgbe, p);

// --- adaptive RLE, per Radiance's "new" scanline format ---
// Each scanline stores its four channels separately; runs of >=4 identical bytes
// become a run, everything else a literal block.
const chunks = [];
const header = Buffer.from(
  `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\nSOFTWARE=gatebreaker bake-hdri\n\n-Y ${targetH} +X ${targetW}\n`,
  'ascii',
);
chunks.push(header);

const chan = new Uint8Array(targetW);
for (let y = 0; y < targetH; y++) {
  const line = [2, 2, (targetW >> 8) & 0xff, targetW & 0xff];
  for (let c = 0; c < 4; c++) {
    for (let x = 0; x < targetW; x++) chan[x] = rgbe[(y * targetW + x) * 4 + c];
    let x = 0;
    while (x < targetW) {
      let run = 1;
      while (x + run < targetW && run < 127 && chan[x + run] === chan[x]) run++;
      if (run >= 4) {
        line.push(128 + run, chan[x]);
        x += run;
      } else {
        // Gather literals until a run of 4+ starts.
        let lit = 0;
        while (x + lit < targetW && lit < 128) {
          if (lit + 3 < targetW - x
            && chan[x + lit] === chan[x + lit + 1]
            && chan[x + lit] === chan[x + lit + 2]
            && chan[x + lit] === chan[x + lit + 3]) break;
          lit++;
        }
        line.push(lit);
        for (let k = 0; k < lit; k++) line.push(chan[x + k]);
        x += lit;
      }
    }
  }
  chunks.push(Buffer.from(line));
}

const result = Buffer.concat(chunks);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, result);
console.log(`wrote ${outPath}  ${(result.length / 1024).toFixed(1)} KB  (source ${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
