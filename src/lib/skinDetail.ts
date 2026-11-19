import * as THREE from "three";

/**
 * Microrrelevo da pele, gerado uma vez e repetido sobre o atlas UV do corpo: o
 * pacote do MakeHuman não traz mapa de relevo, e sem ele o reflexo da pele era
 * uniforme como cera. Poros (pequenas depressões espalhadas) + uma ondulação
 * fina; o mapa de rugosidade deixa os poros um pouco mais foscos.
 * Tudo com coordenadas "dando a volta" para a textura emendar sem costura.
 */
const SIZE = 512;
let cache: { normal: THREE.Texture; roughness: THREE.Texture } | null = null;

export function skinDetailTextures(repeat: number) {
  if (!cache) cache = build();
  for (const t of [cache.normal, cache.roughness]) t.repeat.set(repeat, repeat);
  return cache;
}

function build() {
  const N = SIZE;
  const h = new Float32Array(N * N);
  const rand = mulberry32(7);
  const wrap = (v: number) => ((v % N) + N) % N;

  // Ondulação fina: ruído de valor em duas escalas (divisores de SIZE, para emendar).
  for (const [cell, amp] of [[16, 0.35], [8, 0.2]] as const) {
    const g = Math.ceil(N / cell);
    const grid = Array.from({ length: g * g }, () => rand() * 2 - 1);
    const at = (i: number, j: number) => grid[(j % g) * g + (i % g)];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const fx = x / cell, fy = y / cell;
        const i = Math.floor(fx), j = Math.floor(fy);
        const tx = smooth(fx - i), ty = smooth(fy - j);
        const a = at(i, j) * (1 - tx) + at(i + 1, j) * tx;
        const b = at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx;
        h[y * N + x] += amp * (a * (1 - ty) + b * ty);
      }
    }
  }

  // Poros.
  const pores = new Uint8Array(N * N);
  for (let k = 0; k < 4200; k++) {
    const cx = rand() * N, cy = rand() * N;
    const r = 0.9 + rand() * 1.6;
    const depth = 0.8 + rand() * 0.8;
    const R = Math.ceil(r * 2);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const d2 = (dx * dx + dy * dy) / (r * r);
        if (d2 > 4) continue;
        const i = wrap(Math.round(cy + dy)) * N + wrap(Math.round(cx + dx));
        h[i] -= depth * Math.exp(-d2 * 1.5);
        if (d2 < 1) pores[i] = 1;
      }
    }
  }

  const nData = new Uint8Array(N * N * 4);
  const rData = new Uint8Array(N * N * 4);
  const k = 0.9;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const dx = (h[y * N + wrap(x + 1)] - h[y * N + wrap(x - 1)]) * k;
      const dy = (h[wrap(y + 1) * N + x] - h[wrap(y - 1) * N + x]) * k;
      const len = Math.hypot(dx, dy, 1);
      nData[i * 4] = Math.round((-dx / len * 0.5 + 0.5) * 255);
      nData[i * 4 + 1] = Math.round((dy / len * 0.5 + 0.5) * 255);
      nData[i * 4 + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      nData[i * 4 + 3] = 255;
      // Rugosidade no canal verde (multiplica a do material).
      const rough = pores[i] ? 255 : 222 + Math.round(h[i] * 20);
      rData[i * 4] = rData[i * 4 + 1] = rData[i * 4 + 2] = Math.max(0, Math.min(255, rough));
      rData[i * 4 + 3] = 255;
    }
  }
  const make = (data: Uint8Array) => {
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  };
  return { normal: make(nData), roughness: make(rData) };
}

function smooth(t: number) {
  return t * t * (3 - 2 * t);
}

/** Gerador pseudoaleatório com semente (o relevo sai igual a cada carga). */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
