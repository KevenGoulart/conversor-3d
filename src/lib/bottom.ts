import * as THREE from "three";
import type { FitParams, ProcessedGarment } from "./garment";
import { matrixToSceneSpace, type BodySurface } from "./rig";

/* -------------------------------------------------------------------------- */
/*                         Medidas do quadril e das pernas                     */
/* -------------------------------------------------------------------------- */

export type Hips = {
  /** Altura do gancho (onde as pernas se separam), na cena. */
  crotchY: number;
  /** Meia largura do corpo (sem braços) na altura y; abaixo do gancho, até a borda de fora da perna. */
  halfWidth: (y: number) => number;
  /** Centro da perna (x) na altura y; side −1 = lado −x. */
  legCenter: (y: number, side: 1 | -1) => number | null;
};

const STEP = 0.005;

/** Mede gancho, quadril e pernas pela silhueta do corpo (mapa de superfície). */
export function measureHips(map: BodySurface, hipJoint: number | null): Hips {
  const gap = (y: number) => !map.inside(0, y) && !map.inside(-STEP, y) && !map.inside(STEP, y);
  const top = hipJoint ?? 1.05;
  const bottom = hipJoint !== null ? hipJoint - 0.2 : 0.6;
  let crotchY = hipJoint !== null ? hipJoint - 0.07 : 0.85;
  for (let y = top; y >= bottom; y -= STEP) {
    if (gap(y)) {
      crotchY = y + STEP;
      break;
    }
  }

  const halfWidth = (y: number) => {
    let total = 0, n = 0;
    for (const side of [1, -1]) {
      let x = 0, seen = false, outer = 0;
      for (; x < 0.6; x += STEP) {
        const inn = map.inside(side * x, y);
        if (inn) {
          seen = true;
          outer = x;
        } else if (seen) break;
      }
      if (seen) {
        total += outer;
        n++;
      }
    }
    return n ? total / n : 0.17;
  };

  const legCenter = (y: number, side: 1 | -1) => {
    let lo = -1, hi = -1;
    for (let x = 0; x < 0.5; x += STEP) {
      if (map.inside(side * x, y)) {
        if (lo < 0) lo = x;
        hi = x;
      } else if (lo >= 0) break;
    }
    return lo < 0 ? null : (side * (lo + hi)) / 2;
  };

  return { crotchY, halfWidth, legCenter };
}

/**
 * Caimento de saia: abaixo do gancho o tecido não entra entre as pernas — segue
 * a linha do quadril e cai reto. Além da largura do quadril (saia rodada), a
 * espessura afina aos poucos em vez de frente e verso colarem.
 */
export function hangBelowHips(map: BodySurface, hips: Hips, skirtTopY?: number): BodySurface {
  const yh = hips.crotchY + 0.03;
  const hw = hips.halfWidth(yh);
  const widths = new Map<number, number>();
  const halfAt = (y: number) => {
    const k = Math.round(y * 100);
    let w = widths.get(k);
    if (w === undefined) widths.set(k, (w = hips.halfWidth(k / 100)));
    return w;
  };
  const fn = (x: number, y: number, sleeve = 0) => {
    const s = map(x, y, sleeve);
    if (sleeve >= 0.5) return s;
    if (y >= yh) {
      // Saia rodada (vestido acinturado): da cintura para baixo, o que passa da
      // largura do corpo mantém volume e afina aos poucos, em vez de frente e
      // verso colarem numa folha.
      if (skirtTopY === undefined || y >= skirtTopY) return s;
      const ax = Math.abs(x), half = halfAt(y);
      if (ax <= half) return s;
      const edge = map(half * 0.97 * (Math.sign(x) || 1), y, 0);
      if (!edge) return s;
      const mid = (edge.front + edge.back) / 2, depth = (edge.front - edge.back) / 2;
      const k = Math.sqrt(Math.max(0.12, 1 - ((ax - half) / 0.3) ** 2));
      const t = smoothstep(skirtTopY, skirtTopY - 0.06, y);
      const f = mid + depth * k, b = mid - depth * k;
      return s ? { front: s.front + (f - s.front) * t, back: s.back + (b - s.back) * t } : { front: f, back: b };
    }
    const ax = Math.abs(x);
    let hip = map(Math.min(ax, hw) * (Math.sign(x) || 1), yh, 0);
    if (!hip) return s;
    if (ax > hw) {
      const mid = (hip.front + hip.back) / 2, half = (hip.front - hip.back) / 2;
      const k = Math.sqrt(Math.max(0.12, 1 - ((ax - hw) / 0.3) ** 2));
      hip = { front: mid + half * k, back: mid - half * k };
    }
    // Uma perna que vai para a frente (pose) ainda empurra o tecido.
    const legIn = map.inside(x, y) && s;
    return {
      front: legIn ? Math.max(hip.front, s.front) : hip.front,
      back: legIn ? Math.min(hip.back, s.back) : hip.back,
    };
  };
  return Object.assign(fn, { inside: map.inside });
}

/** Cintura do corpo: a linha mais estreita do tronco entre o quadril e o peito. */
export function measureWaist(hips: Hips, shoulderY: number) {
  let best = Infinity, y = hips.crotchY + 0.2;
  for (let q = hips.crotchY + 0.14; q <= shoulderY - 0.2; q += 0.01) {
    const w = hips.halfWidth(q);
    if (w < best) {
      best = w;
      y = q;
    }
  }
  return isFinite(best) ? { y, halfWidth: best } : undefined;
}

/** Espelha o mapa (x e frente/costas) para montar a peça com a foto das costas. */
export function mirroredSurface(map: BodySurface, centerZ: number): BodySurface {
  const fn = (x: number, y: number, sleeve?: number) => {
    const s = map(-x, y, sleeve);
    return s ? { front: 2 * centerZ - s.back, back: 2 * centerZ - s.front } : null;
  };
  return Object.assign(fn, { inside: (x: number, y: number) => map.inside(-x, y) });
}

/* -------------------------------------------------------------------------- */
/*                 Parte de baixo gerada da foto (bermuda, calça, saia)        */
/* -------------------------------------------------------------------------- */

/** A foto (silhueta) tem duas pernas separadas por um gancho, ou é uma saia? */
export function bottomShape(g: ProcessedGarment) {
  const a = analyzeBottom(g);
  return a.hasLegs ? "pernas" : "saia";
}

function analyzeBottom(g: ProcessedGarment) {
  const { width, mask, bbox, hemY } = g;
  const bh = bbox.maxY - bbox.minY + 1;
  const bw = bbox.maxX - bbox.minX + 1;
  // Centro pelo quadril (linhas de cima, peça inteira): nas pernas a medida da
  // peça de cima pegaria uma perna só.
  const centers: number[] = [];
  for (let y = bbox.minY + Math.round(bh * 0.1); y <= bbox.minY + bh * 0.4; y += 2) {
    let l = -1, r = -1;
    for (let x = bbox.minX; x <= bbox.maxX; x++) {
      if (mask[y * width + x]) {
        if (l < 0) l = x;
        r = x;
      }
    }
    if (l >= 0) centers.push((l + r) / 2);
  }
  centers.sort((p, q) => p - q);
  const cx = Math.round(centers.length ? centers[Math.floor(centers.length / 2)] : (bbox.minX + bbox.maxX) / 2);

  const topY = new Int32Array(width).fill(-1);
  for (let x = bbox.minX; x <= bbox.maxX; x++) {
    for (let y = bbox.minY; y <= bbox.maxY; y++) {
      if (mask[y * width + x]) {
        topY[x] = y;
        break;
      }
    }
  }

  // Barra suavizada (colunas vazias herdam a vizinha).
  const hem = new Float32Array(width);
  const win = Math.max(1, Math.round(bw * 0.01));
  for (let x = 0; x < width; x++) {
    let s = 0, n = 0;
    for (let d = -win; d <= win; d++) {
      const q = x + d;
      if (q >= 0 && q < width && hemY[q] >= 0) {
        s += hemY[q];
        n++;
      }
    }
    hem[x] = n ? s / n : -1;
  }

  // Gancho: o ponto mais alto da barra perto do centro.
  const band = Math.max(2, Math.round(bw * 0.03));
  let crotch = Infinity;
  for (let x = cx - band; x <= cx + band; x++) if (x >= 0 && x < width && hem[x] >= 0) crotch = Math.min(crotch, hem[x]);
  let lowL = 0, lowR = 0;
  for (let x = bbox.minX; x <= bbox.maxX; x++) {
    if (hem[x] < 0) continue;
    if (x < cx) lowL = Math.max(lowL, hem[x]);
    else lowR = Math.max(lowR, hem[x]);
  }
  const low = Math.max(lowL, lowR);
  const hasLegs = isFinite(crotch) && Math.min(lowL, lowR) - crotch > 0.06 * bh;

  // Topo do cós: mediana do topo das colunas centrais.
  const tops: number[] = [];
  for (let x = Math.round(bbox.minX + bw * 0.15); x <= bbox.maxX - bw * 0.15; x++) if (topY[x] >= 0) tops.push(topY[x]);
  tops.sort((a, b) => a - b);
  const waist = tops.length ? tops[Math.floor(tops.length / 2)] : bbox.minY;

  // Cantos de dentro das barras: andando do centro para fora até a barra descer.
  let innerL = cx, innerR = cx;
  if (hasLegs) {
    const tolL = 0.25 * (lowL - crotch), tolR = 0.25 * (lowR - crotch);
    while (innerL > bbox.minX && hem[innerL] < lowL - tolL) innerL--;
    while (innerR < bbox.maxX && hem[innerR] < lowR - tolR) innerR++;
  }

  /*
   * Bermuda dobrada na foto: a barra costuma sair inclinada (o canto de fora
   * bem mais alto). As colunas são esticadas na vertical, abaixo do quadril,
   * para a barra ficar reta — senão a parte inclinada virava costura lateral e
   * a perna saía fechada.
   */
  const yA = waist + (crotch - waist) * 0.35;
  const factor = new Float32Array(width).fill(1);
  if (hasLegs) {
    for (let x = bbox.minX; x <= bbox.maxX; x++) {
      const ref = x > innerL && x < innerR ? hem[x < cx ? innerL : innerR] : hem[x];
      if (ref < 0) continue;
      factor[x] = Math.min(3, Math.max(1, (low - yA) / Math.max(1, ref - yA)));
    }
    const f2 = factor.slice();
    for (let x = bbox.minX; x <= bbox.maxX; x++) {
      let s = 0, n = 0;
      for (let d = -win * 2; d <= win * 2; d++) {
        const q = x + d;
        if (q >= bbox.minX && q <= bbox.maxX) {
          s += factor[q];
          n++;
        }
      }
      f2[x] = s / n;
    }
    factor.set(f2);
  }
  const origY = (x: number, py: number) => {
    const xi = Math.min(width - 1, Math.max(0, Math.round(x)));
    return py <= yA ? py : yA + (py - yA) / factor[xi];
  };
  const crotchS = hasLegs ? (crotch <= yA ? crotch : yA + (crotch - yA) * factor[cx]) : NaN;

  return { cx, waist, low, hasLegs, crotchS, origY, bh };
}

type Row = { py: number; l: number; r: number; il: number; ir: number; legs: boolean };

/**
 * Bermuda/calça/saia "inflada" a partir da silhueta da foto: duas camadas
 * (frente e verso) seguindo o corpo com folga, unidas nas costuras laterais e,
 * nas pernas, no entrepernas. Cós e barras ficam abertos.
 *
 * A malha é montada por linhas da foto: cada linha tem a metade esquerda e a
 * direita (que no quadril se encontram no centro e, abaixo do gancho, viram as
 * duas pernas). Abaixo do gancho cada perna é levada para cima da perna do corpo.
 *
 * Saída no espaço da cena (z absoluto). Grupo 0 = frente (foto), 1 = verso.
 */
export function buildBottomGeometry(g: ProcessedGarment, fit: FitParams, map: BodySurface, hips: Hips) {
  const { width, height, mask } = g;
  const a = analyzeBottom(g);
  const { cx, origY } = a;
  const inMask = (x: number, py: number) => {
    const xi = Math.round(x), yi = Math.round(origY(x, py));
    return xi >= 0 && yi >= 0 && xi < width && yi < height && mask[yi * width + xi] === 1;
  };

  // Linhas da foto (já com a barra endireitada) ------------------------------
  const R = 90;
  const y0 = a.waist, y1 = a.low;
  const rows: Row[] = [];
  for (let j = 0; j < R; j++) {
    const py = y0 + ((y1 - y0) * j) / (R - 1);
    let l = -1, r = -1;
    for (let x = g.bbox.minX; x <= g.bbox.maxX; x++) {
      if (inMask(x, py)) {
        if (l < 0) l = x;
        r = x;
      }
    }
    if (l < 0) continue;
    const legs = a.hasLegs && py > a.crotchS;
    let il = cx, ir = cx;
    if (legs) {
      while (il > l && !inMask(il, py)) il--;
      while (ir < r && !inMask(ir, py)) ir++;
      if (il <= l + 2 || ir >= r - 2) continue; // perna sumiu nesta linha
    }
    rows.push({ py, l: Math.min(l, cx - 2), r: Math.max(r, cx + 2), il, ir, legs });
  }
  if (rows.length < 4) throw new Error("Não deu para entender a silhueta da peça de baixo. Ajuste a remoção do fundo.");
  // Suaviza o contorno ao longo das linhas.
  for (let it = 0; it < 3; it++) {
    const prev = rows.map((r) => ({ ...r }));
    for (let j = 1; j < rows.length - 1; j++) {
      const p = prev[j - 1], q = prev[j + 1], c = prev[j];
      rows[j].l = (p.l + 2 * c.l + q.l) / 4;
      rows[j].r = (p.r + 2 * c.r + q.r) / 4;
      if (c.legs && p.legs && q.legs) {
        rows[j].il = (p.il + 2 * c.il + q.il) / 4;
        rows[j].ir = (p.ir + 2 * c.ir + q.ir) / 4;
      }
    }
  }

  // Escala e altura ------------------------------------------------------------
  const crotchRow = a.hasLegs ? a.crotchS - (a.crotchS - y0) * 0.1 : y0 + (y1 - y0) * 0.3;
  const ref = rows.reduce((best, r) => (Math.abs(r.py - crotchRow) < Math.abs(best.py - crotchRow) ? r : best), rows[0]);
  const hipY = hips.crotchY + 0.05;
  const metersPerPx = (2 * hips.halfWidth(hipY) * fit.ease) / Math.max(1, ref.r - ref.l);
  const toWorldY = a.hasLegs
    ? (py: number) => hips.crotchY - 0.012 + fit.offsetY + (a.crotchS - py) * metersPerPx
    : (py: number) => hipY + fit.offsetY + (crotchRow - py) * metersPerPx;

  const extra = Math.max(0, fit.ease - 1);
  const gap = 0.004 + extra * 0.05;

  /** Superfície do corpo em (x, y), procurando para dentro se cair fora do mapa. */
  const surfaceAt = (x: number, y: number, towards: number) => {
    for (let k = 0; k <= 30; k++) {
      const s = map(x + (towards - x) * (k / 30), y, 0);
      if (s) return s;
    }
    return null;
  };

  // Vértices --------------------------------------------------------------------
  const K = 22;
  const positions: number[] = [];
  const uvs: number[] = [];
  // Na borda da silhueta ficam restos do fundo (ou a cor de preenchimento): a
  // textura das costuras, do cós e da barra é lida um pouco para dentro.
  const inset = Math.max(2, (g.bbox.maxX - g.bbox.minX) * 0.012);
  let rowFrom = 0, rowTo = 0;
  const push = (x: number, y: number, z: number, px: number, py: number) => {
    positions.push(x, y, z);
    const ux = rowTo - rowFrom > 3 * inset ? Math.min(Math.max(px, rowFrom + inset), rowTo - inset) : px;
    const uy = Math.min(Math.max(py, y0 + inset), y1 - inset);
    uvs.push(ux / width, 1 - origY(ux, uy) / height);
    return positions.length / 3 - 1;
  };
  // [linha][painel][coluna] → índice da frente e do verso.
  const F: number[][][] = [], B: number[][][] = [];

  for (let j = 0; j < rows.length; j++) {
    const row = rows[j];
    const y = toWorldY(row.py);
    F.push([[], []]);
    B.push([[], []]);
    // Abaixo do gancho, cada perna desliza até a perna do corpo (aos poucos).
    const w = row.legs ? smoothstep(hips.crotchY, hips.crotchY - 0.12, y) : 0;
    for (const p of [0, 1] as const) {
      const side = p === 0 ? -1 : 1;
      // Painel 0: da borda esquerda (k = 0) ao centro/entrepernas (k = K).
      // Painel 1: do centro/entrepernas (k = 0) à borda direita (k = K).
      const from = p === 0 ? row.l : row.legs ? row.ir : cx;
      const to = p === 0 ? (row.legs ? row.il : cx) : row.r;
      let shift = 0;
      if (row.legs) {
        const pc = (from + to) / 2;
        const body = hips.legCenter(y, side);
        const photo = (pc - cx) * metersPerPx;
        if (body !== null) shift = (body - photo) * w;
      }
      const outerX = (p === 0 ? from - cx : to - cx) * metersPerPx + shift;
      const innerX = (p === 0 ? to - cx : from - cx) * metersPerPx + shift;
      const legMid = (outerX + innerX) / 2;
      // Só as costuras de verdade puxam a textura para dentro (não o centro do quadril).
      rowFrom = p === 0 || row.legs ? from : -Infinity;
      rowTo = p === 1 || row.legs ? to : Infinity;

      for (let k = 0; k <= K; k++) {
        // O painel da direita reaproveita a coluna central do da esquerda no quadril.
        if (p === 1 && k === 0 && !row.legs) {
          F[j][1].push(F[j][0][K]);
          B[j][1].push(B[j][0][K]);
          continue;
        }
        const px = from + ((to - from) * k) / K;
        const x = (px - cx) * metersPerPx + shift;
        const outerEdge = p === 0 ? k === 0 : k === K;
        const innerEdge = row.legs && (p === 0 ? k === K : k === 0);

        const s = surfaceAt(x, y, row.legs ? legMid : 0);
        let zF = s ? s.front + gap : 0.08, zB = s ? s.back - gap : -0.08;
        if (zF - zB < 0.03) {
          const m = (zF + zB) / 2;
          zF = m + 0.015;
          zB = m - 0.015;
        }
        const mid = (zF + zB) / 2;
        if (outerEdge || innerEdge) {
          const v = push(x, y, mid, px, row.py);
          F[j][p].push(v);
          B[j][p].push(v);
          continue;
        }
        let d = Math.abs(x - outerX);
        if (row.legs) d = Math.min(d, Math.abs(x - innerX));
        const t = Math.min(1, d / Math.max(0.005, fit.seamRadius));
        const round = Math.sqrt(1 - (1 - t) * (1 - t));
        F[j][p].push(push(x, y, mid + (zF - mid) * round, px, row.py));
        B[j][p].push(push(x, y, mid + (zB - mid) * round, px, row.py));
      }
    }
  }

  // Triângulos --------------------------------------------------------------------
  const front: number[] = [], back: number[] = [];
  for (let j = 0; j < rows.length - 1; j++) {
    for (const p of [0, 1]) {
      for (let k = 0; k < K; k++) {
        const fa = F[j][p][k], fb = F[j][p][k + 1], fc = F[j + 1][p][k], fd = F[j + 1][p][k + 1];
        const ba = B[j][p][k], bb = B[j][p][k + 1], bc = B[j + 1][p][k], bd = B[j + 1][p][k + 1];
        front.push(fa, fc, fb, fb, fc, fd);
        back.push(ba, bb, bc, bb, bd, bc);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  // Tudo é "tronco": a transferência de pesos ignora braços e mãos.
  geo.setAttribute("manga", new THREE.Float32BufferAttribute(new Float32Array(positions.length / 3), 1));
  geo.setIndex([...front, ...back]);
  geo.addGroup(0, front.length, 0);
  geo.addGroup(front.length, back.length, 1);
  geo.computeVertexNormals();
  return geo;
}

/* -------------------------------------------------------------------------- */
/*                    Estampa projetada na peça de baixo do modelo             */
/* -------------------------------------------------------------------------- */

/**
 * "Apenas estampa" na parte de baixo: a foto é projetada de frente na peça do
 * modelo (calça, saia…), que mantém o próprio formato. Guarda a geometria e o
 * material originais para desfazer.
 *
 * `map` é um atlas com o dobro da largura da foto: à esquerda a foto (com o tecido
 * repetido fora da silhueta), à direita só o tecido, para os lados das pernas.
 */
export function printOnto(obj: THREE.Object3D, scene: THREE.Object3D, g: ProcessedGarment, map: THREE.Texture) {
  const meshes: THREE.Mesh[] = [];
  obj.traverse((x) => {
    if ((x as THREE.Mesh).isMesh) meshes.push(x as THREE.Mesh);
  });
  // Caixa da peça (pose de descanso) na cena.
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const geo = (m.userData.printOrig?.geometry as THREE.BufferGeometry | undefined) ?? m.geometry;
    const pos = geo.getAttribute("position");
    const mat = matrixToSceneSpace(m, scene);
    for (let i = 0; i < pos.count; i++) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(mat));
  }
  const { bbox, width, height } = g;
  const bw = bbox.maxX - bbox.minX + 1, bh = bbox.maxY - bbox.minY + 1;
  const sx = box.max.x - box.min.x || 1, sy = box.max.y - box.min.y || 1;
  const n = new THREE.Vector3();
  const e = new THREE.Vector3();

  for (const m of meshes) {
    if (!m.userData.printOrig) m.userData.printOrig = { geometry: m.geometry, material: m.material };
    const orig = m.userData.printOrig as { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[] };
    if (m.geometry !== orig.geometry) m.geometry.dispose();
    // Triângulos soltos: cada um escolhe a projeção (frente ou lado) sozinho, sem
    // vértice dividido entre as duas metades do atlas (que espremeria a foto numa faixa).
    const geo = orig.geometry.index ? orig.geometry.toNonIndexed() : orig.geometry.clone();
    const pos = geo.getAttribute("position");
    const mat = matrixToSceneSpace(m, scene);
    const uv = new Float32Array(pos.count * 2);
    const tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let f = 0; f + 2 < pos.count; f += 3) {
      for (let k = 0; k < 3; k++) tri[k].fromBufferAttribute(pos, f + k).applyMatrix4(mat);
      n.subVectors(tri[1], tri[0]).cross(e.subVectors(tri[2], tri[0])).normalize();
      // Lado da perna (normal quase só em x): a foto de frente ficaria esticada ali.
      // Usa a metade direita do atlas (só tecido), projetada de lado, na mesma escala.
      const side = Math.abs(n.x) > 0.75;
      for (let k = 0; k < 3; k++) {
        const p = tri[k];
        const px = side ? width + ((p.z - box.min.z) / sx) * bw : bbox.minX + ((p.x - box.min.x) / sx) * bw;
        const py = bbox.minY + ((box.max.y - p.y) / sy) * bh;
        uv[(f + k) * 2] = px / (2 * width);
        uv[(f + k) * 2 + 1] = 1 - py / height;
      }
    }
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    m.geometry = geo;
    const old = m.material;
    const material = new THREE.MeshStandardMaterial({ map, roughness: 0.85, side: THREE.DoubleSide });
    m.material = material;
    if (old !== orig.material) (Array.isArray(old) ? old : [old]).forEach((x) => x.dispose());
  }
}

export function clearPrint(obj: THREE.Object3D) {
  obj.traverse((x) => {
    const m = x as THREE.Mesh;
    const orig = m.userData?.printOrig as { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[] } | undefined;
    if (!m.isMesh || !orig) return;
    if (m.geometry !== orig.geometry) m.geometry.dispose();
    if (m.material !== orig.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((k) => k.dispose());
    m.geometry = orig.geometry;
    m.material = orig.material;
    delete m.userData.printOrig;
  });
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
