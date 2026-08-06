import fs from 'node:fs';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { DataUtils } from 'three';

const read = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset+b.byteLength); };

// Decode our baked .hdr back with three's stock loader.
const rl = new RGBELoader();
rl.setDataType(1015); // FloatType
const hdr = rl.parse(read('public/hdri/rift_sky.hdr'));
console.log('decoded hdr:', hdr.width + 'x' + hdr.height, 'type', hdr.type, 'len', hdr.data.length);

// Decode the original EXR and downsample the same way for comparison.
const exr = new EXRLoader().parse(read('assets/hdri/moonless_golf_2k.exr'));
const tf = (i) => exr.data instanceof Uint16Array ? DataUtils.fromHalfFloat(exr.data[i]) : exr.data[i];
const W = hdr.width, H = hdr.height, bx = exr.width/W, by = exr.height/H;

let sumRef=0, sumGot=0, maxRel=0, worst=null, n=0;
for (let y=0;y<H;y+=4) for (let x=0;x<W;x+=4) {
  const x0=Math.floor(x*bx), x1=Math.min(exr.width,Math.ceil((x+1)*bx));
  const y0=Math.floor(y*by), y1=Math.min(exr.height,Math.ceil((y+1)*by));
  let r=0,g=0,b=0,c=0;
  for(let sy=y0;sy<y1;sy++) for(let sx=x0;sx<x1;sx++){const i=(sy*exr.width+sx)*4; r+=tf(i);g+=tf(i+1);b+=tf(i+2);c++;}
  r/=c;g/=c;b/=c;
  const o=(y*W+x)*4;
  const gr=hdr.data[o], gg=hdr.data[o+1], gb=hdr.data[o+2];
  const refL=0.2126*r+0.7152*g+0.0722*b, gotL=0.2126*gr+0.7152*gg+0.0722*gb;
  sumRef+=refL; sumGot+=gotL; n++;
  const rel = refL>1e-4 ? Math.abs(gotL-refL)/refL : 0;
  if (rel>maxRel){maxRel=rel;worst={x,y,refL:+refL.toFixed(4),gotL:+gotL.toFixed(4)};}
}
console.log('samples', n);
console.log('mean luminance  ref', (sumRef/n).toFixed(4), ' decoded', (sumGot/n).toFixed(4),
            ' ratio', (sumGot/sumRef).toFixed(4));
console.log('worst relative error', (maxRel*100).toFixed(2)+'%', worst);
const ok = Math.abs(sumGot/sumRef - 1) < 0.03 && maxRel < 0.06;
console.log(ok ? 'ROUND-TRIP OK' : 'ROUND-TRIP FAILED');
process.exit(ok?0:1);
