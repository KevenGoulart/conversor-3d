import * as THREE from "three";
import { BODY, type BodyDims } from "./body";

/** Resultado da análise 2D da foto da roupa. */
export type ProcessedGarment = {
  width: number;
  height: number;
  /** 1 = pixel pertence à roupa */
  mask: Uint8Array;
  /** Imagem com o fundo preenchido pela cor base (usada como textura). */
  textureCanvas: HTMLCanvasElement;
  /** PNG com fundo transparente, para pré-visualização. */
  cutoutUrl: string;
  /** Cor predominante do tecido (hex). */
  baseColor: string;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** Centro horizontal do corpo da peça (px). */
  centerX: number;
  /** Largura do tronco (abaixo das mangas) em px. */
  bodyWidth: number;
  /** Ponto mais baixo da gola no centro (px). */
  collarY: number;
  /**
   * Peça acinturada (vestido, blusa justa na cintura): linha e largura (px) da
   * cintura. A escala e o encaixe passam a ser pela cintura do corpo — a
   * largura de baixo é a saia, não o tronco.
   */
  waist: { y: number; width: number } | null;
  /**
   * Peça sem manga (alças, regata, tomara que caia): linha (px) em que o corpo
   * da peça começa na lateral, que veste na altura da axila. null = tem manga
   * (ou cobre o ombro) e é ancorada pela gola.
   */
  armpitY: number | null;
  /** y do pixel mais baixo da roupa em cada coluna (barra). -1 se vazio. */
  hemY: Int32Array;
};

const MAX_SIZE = 1024;

export async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = src;
  await img.decode();
  return img;
}

/**
 * Remove o fundo (flood fill a partir das bordas, ou canal alfa se existir),
 * mede a peça e prepara a textura.
 */
export function processImage(img: HTMLImageElement, tolerance: number): ProcessedGarment {
  const scale = Math.min(1, MAX_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height);
  const px = data.data;
  const n = width * height;

  // 1) Máscara -----------------------------------------------------------
  let mask = new Uint8Array(n);
  let transparent = 0;
  for (let i = 0; i < n; i++) if (px[i * 4 + 3] < 128) transparent++;

  if (transparent > n * 0.01) {
    // PNG já recortado: usa o alfa.
    for (let i = 0; i < n; i++) mask[i] = px[i * 4 + 3] >= 128 ? 1 : 0;
  } else {
    mask = floodFillBackground(px, width, height, tolerance);
    // Halo/sombra do fundo colado na borda da peça: fica um pouco fora da
    // tolerância e entrava no recorte, virando uma faixa clara na costura.
    // Fundo liso não tem halo, e a tolerância frouxa comeria a borda de uma peça de cor parecida.
    if (!isFlatBackground(px, width, height, backgroundColor(px, width, height))) {
      peelHalo(mask, px, width, height, Math.max(tolerance * 2.5, 45), Math.round(Math.max(width, height) * 0.015));
    }
  }
  mask = erode(keepLargestComponent(mask, width, height), width, height);

  // 2) Medidas --------------------------------------------------------------
  let minX = width, minY = height, maxX = -1, maxY = -1;
  const hemY = new Int32Array(width).fill(-1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      hemY[x] = y;
    }
  }
  if (maxX < 0) throw new Error("Não foi possível encontrar a roupa na imagem. Tente ajustar a tolerância do fundo.");

  const bh = maxY - minY + 1;
  const widths: number[] = [];
  const centers: number[] = [];
  // Centro pela linha dos ombros (alto da peça), que é simétrica mesmo quando
  // uma manga caída encosta no corpo mais abaixo.
  const tops: number[] = [];
  for (let y = Math.round(minY + bh * 0.06); y <= Math.round(minY + bh * 0.14); y++) {
    let l = -1, r = -1;
    for (let x = minX; x <= maxX; x++) {
      if (mask[y * width + x]) {
        if (l < 0) l = x;
        r = x;
      }
    }
    if (l >= 0) tops.push((l + r) / 2);
  }
  const midX = Math.round(median(tops) || (minX + maxX) / 2);
  // Só o trecho que passa pelo meio da peça: com manga longa (ou bufante) a
  // linha também corta as mangas, e a largura somada encolhia a peça inteira.
  // Dos dois lados do centro vale o mais estreito: se uma manga caída está
  // colada ao corpo na foto, o outro lado ainda mostra a largura real.
  for (let y = Math.round(minY + bh * 0.65); y <= Math.round(minY + bh * 0.85); y++) {
    const row = y * width;
    let seed = -1;
    for (let d = 0; d <= (maxX - minX) * 0.15 && seed < 0; d++) {
      if (mask[row + midX - d]) seed = midX - d;
      else if (mask[row + midX + d]) seed = midX + d;
    }
    if (seed < 0) continue;
    let l = seed, r = seed;
    while (l > 0 && mask[row + l - 1]) l--;
    while (r < width - 1 && mask[row + r + 1]) r++;
    const left = midX - l, right = r - midX;
    const half = Math.min(left, right);
    // Lados parecidos: peça simétrica, usa a medida inteira.
    if (half > 0 && Math.max(left, right) > half * 1.25) {
      widths.push(2 * half);
      centers.push(midX);
    } else {
      widths.push(r - l + 1);
      centers.push((l + r) / 2);
    }
  }
  let bodyWidth = median(widths) || maxX - minX + 1;
  let centerX = median(centers) || (minX + maxX) / 2;

  // Perfil da peça, linha a linha: extensão total, quanto dela é tecido e a
  // largura do trecho central (simétrica em volta do meio).
  const rowOf = (y: number) => {
    const row = y * width;
    let l = -1, r = -1, fill = 0;
    for (let x = minX; x <= maxX; x++) {
      if (mask[row + x]) {
        if (l < 0) l = x;
        r = x;
        fill++;
      }
    }
    let cl = -1, cr = -1;
    const c = Math.round(centerX);
    let seed = -1;
    for (let d = 0; d <= (maxX - minX) * 0.15 && seed < 0; d++) {
      if (mask[row + c - d]) seed = c - d;
      else if (mask[row + c + d]) seed = c + d;
    }
    if (seed >= 0) {
      cl = cr = seed;
      while (cl > 0 && mask[row + cl - 1]) cl--;
      while (cr < width - 1 && mask[row + cr + 1]) cr++;
    }
    const left = c - cl, right = cr - c;
    const lo = Math.max(0, Math.min(left, right));
    const hi = Math.max(left, right);
    // Trecho quase todo de um lado do centro (metade de um decote em V, uma
    // alça): não é o corpo da peça nesta linha.
    const central = seed < 0 || lo < hi * 0.3 ? 0 : hi > lo * 1.25 ? 2 * lo : cr - cl + 1;
    return { l, r, extent: l < 0 ? 0 : r - l + 1, fill, central, mid: (cl + cr) / 2 };
  };

  // Cintura: a linha mais estreita entre 25% e 70% da altura, se a peça alarga
  // bem acima (busto) e abaixo (saia) dela.
  let waist: ProcessedGarment["waist"] = null;
  {
    let best = Infinity, bestY = -1;
    for (let y = Math.round(minY + bh * 0.25); y <= Math.round(minY + bh * 0.7); y++) {
      // Média de 5 linhas: um vinco ou falha do recorte não vira cintura.
      let sum = 0, n = 0;
      for (let d = -2; d <= 2; d++) {
        const w = rowOf(Math.min(maxY, Math.max(minY, y + d))).central;
        if (w > 0) {
          sum += w;
          n++;
        }
      }
      if (n && sum / n < best) {
        best = sum / n;
        bestY = y;
      }
    }
    if (bestY >= 0) {
      const below = rowOf(Math.round(minY + bh * 0.88)).central;
      let above = 0;
      for (let y = Math.round(minY + bh * 0.1); y < bestY - bh * 0.03; y++) above = Math.max(above, rowOf(y).central);
      if (below > best * 1.3 && above > best * 1.08) waist = { y: bestY, width: best };
    }
  }
  if (waist) {
    const m = rowOf(waist.y).mid;
    if (m > 0) centerX = m;
    // "Largura do corpo" (peito) estimada pela cintura: usada para achar mangas e a barra.
    bodyWidth = Math.min(bodyWidth, waist.width * 1.3);
  }

  // Sem manga: no alto da peça nada passa muito da largura do corpo (ignorando
  // linhas ralas — alças e laços). A lateral do corpo da peça começa na axila.
  let armpitY: number | null = null;
  {
    const yEnd = waist ? waist.y : Math.round(minY + bh * 0.5);
    const solid = (r: ReturnType<typeof rowOf>) => r.extent > 0 && r.fill >= r.extent * 0.6;
    let maxExtent = 0, maxHalf = 0;
    for (let y = minY; y <= yEnd; y++) {
      const r = rowOf(y);
      if (!solid(r)) continue;
      maxExtent = Math.max(maxExtent, r.extent);
      maxHalf = Math.max(maxHalf, centerX - r.l, r.r - centerX);
    }
    if (maxExtent > 0 && maxHalf - bodyWidth / 2 < bodyWidth * 0.2) {
      for (let y = minY; y <= yEnd; y++) {
        const r = rowOf(y);
        if (solid(r) && r.extent >= maxExtent * 0.85) {
          armpitY = y;
          break;
        }
      }
      // Regata que cobre o ombro: o topo fica junto da gola e a âncora pela gola continua valendo.
      if (armpitY !== null && armpitY - minY < bh * 0.06) armpitY = null;
    }
  }

  let collarY = minY;
  for (let dx = -3; dx <= 3; dx++) {
    const x = Math.round(centerX) + dx;
    if (x < 0 || x >= width) continue;
    for (let y = 0; y < height; y++) {
      if (mask[y * width + x]) {
        collarY = Math.max(collarY, y);
        break;
      }
    }
  }

  // 3) Cor base + textura ----------------------------------------------------
  const baseRGB = dominantColor(px, mask);
  const baseColor = "#" + baseRGB.map((c) => c.toString(16).padStart(2, "0")).join("");

  // Alças finas (cordões, laços): entre elas sobra fundo dentro do recorte, que
  // na peça virava manchas claras. Acima da axila, o que tem cor de fundo é
  // pintado com a cor do tecido — só se o tecido não for da cor do fundo.
  if (armpitY !== null && transparent <= n * 0.01) {
    const ref = backgroundColor(px, width, height);
    const thr = Math.max(tolerance * 2, 30);
    const d2 = (r: number, g: number, b: number) => (r - ref[0]) ** 2 + (g - ref[1]) ** 2 + (b - ref[2]) ** 2;
    if (d2(baseRGB[0], baseRGB[1], baseRGB[2]) > (thr * 3) ** 2) {
      for (let y = minY; y < armpitY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const i = y * width + x;
          if (!mask[i] || d2(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) > thr * thr * 4) continue;
          px[i * 4] = baseRGB[0];
          px[i * 4 + 1] = baseRGB[1];
          px[i * 4 + 2] = baseRGB[2];
        }
      }
    }
  }

  const cutout = new ImageData(new Uint8ClampedArray(px), width, height);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) {
      px[i * 4] = baseRGB[0];
      px[i * 4 + 1] = baseRGB[1];
      px[i * 4 + 2] = baseRGB[2];
      px[i * 4 + 3] = 255;
      cutout.data[i * 4 + 3] = 0;
    }
  }
  ctx.putImageData(data, 0, 0);

  const cutCanvas = document.createElement("canvas");
  cutCanvas.width = width;
  cutCanvas.height = height;
  cutCanvas.getContext("2d")!.putImageData(cutout, 0, 0);

  return {
    width,
    height,
    mask,
    textureCanvas: canvas,
    cutoutUrl: cutCanvas.toDataURL("image/png"),
    baseColor,
    bbox: { minX, minY, maxX, maxY },
    centerX,
    bodyWidth,
    collarY,
    waist,
    armpitY,
    hemY,
  };
}

/**
 * Escolhe a tolerância da remoção do fundo para a foto: a menor que realmente
 * separa a peça. Com fundo de tecido, papel ou ruído de JPEG, um valor fixo
 * baixo não tirava nada e a peça virava um retângulo com o fundo.
 * Critérios (numa cópia pequena da foto): quase toda a borda é fundo e a peça
 * ocupa entre 5% e 85% da imagem.
 */
export function autoTolerance(img: HTMLImageElement): number {
  const scale = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  // PNG recortado: a tolerância nem é usada.
  let transparent = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 128) transparent++;
  if (transparent > w * h * 0.01) return 12;

  const candidates = [12, 16, 20, 25, 30, 36, 42, 50, 58, 66, 75];
  for (const tol of candidates) {
    const mask = keepLargestComponent(floodFillBackground(px, w, h, tol), w, h);
    let border = 0, borderOn = 0, area = 0;
    for (let i = 0; i < w * h; i++) {
      area += mask[i];
      const x = i % w, y = (i / w) | 0;
      if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) {
        border++;
        borderOn += mask[i];
      }
    }
    const a = area / (w * h);
    if (borderOn / border < 0.08 && a < 0.85 && a > 0.05) return tol;
  }
  return 12;
}

function median(a: number[]) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** Cor de referência do fundo = mediana dos pixels da borda. */
function backgroundColor(px: Uint8ClampedArray, w: number, h: number) {
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const pushBorder = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    rs.push(px[i]);
    gs.push(px[i + 1]);
    bs.push(px[i + 2]);
  };
  for (let x = 0; x < w; x++) {
    pushBorder(x, 0);
    pushBorder(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    pushBorder(0, y);
    pushBorder(w - 1, y);
  }
  return [median(rs), median(gs), median(bs)];
}

/**
 * Descasca a borda do recorte, camada por camada (até `depth` pixels), enquanto
 * os pixels dela ainda forem parecidos com o fundo (tolerância mais frouxa).
 * Só anda a partir da borda e por pouca distância: não come o tecido.
 */
function peelHalo(mask: Uint8Array, px: Uint8ClampedArray, w: number, h: number, tol: number, depth: number) {
  const ref = backgroundColor(px, w, h);
  const tol2 = tol * tol;
  const like = (i: number) => {
    const dr = px[i * 4] - ref[0], dg = px[i * 4 + 1] - ref[1], db = px[i * 4 + 2] - ref[2];
    return dr * dr + dg * dg + db * db <= tol2;
  };
  for (let it = 0; it < depth; it++) {
    const drop: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i] || !like(i)) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) drop.push(i);
      }
    }
    if (!drop.length) break;
    for (const i of drop) mask[i] = 0;
  }
}

/** Quase toda a borda da imagem tem a mesma cor do fundo (sem vinheta, sombra ou textura). */
function isFlatBackground(px: Uint8ClampedArray, w: number, h: number, ref: number[]) {
  let total = 0, off = 0;
  const check = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    const dr = px[i] - ref[0], dg = px[i + 1] - ref[1], db = px[i + 2] - ref[2];
    total++;
    if (dr * dr + dg * dg + db * db > 16) off++;
  };
  for (let x = 0; x < w; x++) {
    check(x, 0);
    check(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    check(0, y);
    check(w - 1, y);
  }
  return off <= total * 0.02;
}

function floodFillBackground(px: Uint8ClampedArray, w: number, h: number, tol: number) {
  const ref = backgroundColor(px, w, h);
  const tol2 = tol * tol;
  /*
   * Fundo em degradê (foto de loja com vinheta, sombra suave): longe da borda
   * a cor do fundo já saiu da tolerância e ficava uma mancha dele grudada na
   * peça. O preenchimento também segue o fundo passo a passo: um pixel entra
   * se for quase igual ao vizinho que já é fundo (degradê suave), desde que
   * não se afaste demais da cor de referência. A borda da peça é um salto de
   * cor bem maior que esse passo, então ele não entra no tecido.
   */
  const step2 = Math.max(3, tol * 0.3) ** 2;
  /*
   * Fundo liso (foto de loja montada no computador): não há degradê a seguir, e
   * seguir passo a passo só faz o fundo atravessar a borda suave de uma peça de
   * cor parecida (camiseta creme em fundo cinza-claro) e comer o tecido todo.
   */
  const far2 = isFlatBackground(px, w, h, ref) ? tol2 : (tol * 4) ** 2;

  const refDist = (i: number) => {
    const dr = px[i * 4] - ref[0];
    const dg = px[i * 4 + 1] - ref[1];
    const db = px[i * 4 + 2] - ref[2];
    return dr * dr + dg * dg + db * db;
  };
  const stepDist = (i: number, j: number) => {
    const dr = px[i * 4] - px[j * 4];
    const dg = px[i * 4 + 1] - px[j * 4 + 1];
    const db = px[i * 4 + 2] - px[j * 4 + 2];
    return dr * dr + dg * dg + db * db;
  };

  const bg = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const add = (i: number) => {
    bg[i] = 1;
    queue[tail++] = i;
  };
  const seed = (i: number) => {
    if (!bg[i] && refDist(i) <= tol2) add(i);
  };
  const grow = (j: number, from: number) => {
    if (bg[j]) return;
    const d = refDist(j);
    if (d <= tol2 || (d <= far2 && stepDist(j, from) <= step2)) add(j);
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w, y = (i / w) | 0;
    if (x > 0) grow(i - 1, i);
    if (x < w - 1) grow(i + 1, i);
    if (y > 0) grow(i - w, i);
    if (y < h - 1) grow(i + w, i);
  }

  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = bg[i] ? 0 : 1;
  return mask;
}

function keepLargestComponent(mask: Uint8Array, w: number, h: number) {
  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let best = 0, bestSize = 0, current = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue;
    current++;
    let head = 0, tail = 0;
    label[s] = current;
    queue[tail++] = s;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w, y = (i / w) | 0;
      const visit = (j: number) => {
        if (mask[j] && !label[j]) {
          label[j] = current;
          queue[tail++] = j;
        }
      };
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y < h - 1) visit(i + w);
    }
    if (tail > bestSize) {
      bestSize = tail;
      best = current;
    }
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = label[i] === best ? 1 : 0;
  return out;
}

function erode(mask: Uint8Array, w: number, h: number) {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      out[i] = mask[i] & mask[i - 1] & mask[i + 1] & mask[i - w] & mask[i + w];
    }
  }
  return out;
}

function dominantColor(px: Uint8ClampedArray, mask: Uint8Array): [number, number, number] {
  const buckets = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const acc = buckets.get(key) ?? [0, 0, 0, 0];
    acc[0] += r;
    acc[1] += g;
    acc[2] += b;
    acc[3]++;
    buckets.set(key, acc);
  }
  let best: [number, number, number, number] = [200, 200, 200, 1];
  for (const acc of buckets.values()) if (acc[3] > best[3]) best = acc;
  return [Math.round(best[0] / best[3]), Math.round(best[1] / best[3]), Math.round(best[2] / best[3])];
}

/* -------------------------------------------------------------------------- */
/*                               Geração da malha                              */
/* -------------------------------------------------------------------------- */

/**
 * z da frente e das costas do corpo em (x, y), no referencial da peça.
 * `sleeve`: 0 no tronco, 1 na manga (transição na axila/ombro).
 */
export type GarmentSurface = (x: number, y: number, sleeve: number) => { front: number; back: number } | null;

export type FitParams = {
  /** Folga da peça: 1 = justa, 1.5 = bem larga. */
  ease: number;
  /** Deslocamento vertical em metros. */
  offsetY: number;
  /** Raio do arredondamento das costuras em metros. */
  seamRadius: number;
};

/**
 * "estampa" = a foto só pinta/estampa uma peça pronta do modelo (camiseta,
 * calça…), que mantém o formato dela; "modelo" = uma peça nova é montada a
 * partir da silhueta da foto (vestido, bermuda, saia, manga bufante…).
 */
export type GarmentMode = "estampa" | "modelo";

/** Uma peça da foto vestida num lugar do corpo (cima ou baixo). */
export type GarmentLayer = {
  garment: ProcessedGarment;
  fit: FitParams;
  photoIsBack: boolean;
  mode: GarmentMode;
  /** "estampa" na versão de manga comprida da camiseta pronta, se o modelo tiver. */
  longSleeves?: boolean;
};

/**
 * Transforma a silhueta 2D numa peça 3D "inflada": duas camadas (frente e
 * verso) que se encontram nas costuras laterais e envolvem o tronco do
 * manequim. A barra fica aberta para o corpo passar.
 *
 * Com `surface` (mapa da frente/costas do corpo, z relativo a centerZ), a
 * frente e o verso seguem o corpo com uma folga que cresce com `fit.ease`;
 * sem ele, o tronco é uma elipse.
 *
 * Grupo 0 = lado da foto (textura), grupo 1 = lado oposto (cor lisa).
 * O atributo "manga" (0 = tronco, 1 = manga) diz o quanto cada vértice segue o braço.
 */
export function buildGarmentGeometry(
  g: ProcessedGarment,
  fit: FitParams,
  body: BodyDims = BODY,
  surface?: GarmentSurface,
) {
  const { mask, width, height, bbox, centerX, collarY, hemY } = g;

  // Peça acinturada: a cintura da foto veste a cintura do corpo. Senão, a
  // largura do tronco da peça veste o peito.
  const byWaist = g.waist && body.waist ? { px: g.waist, body: body.waist } : null;
  const metersPerPx = byWaist
    ? (2 * byWaist.body.halfWidth * fit.ease) / byWaist.px.width
    : (2 * body.chestHalfWidth * fit.ease) / g.bodyWidth;
  // Largura do peito em pixels, na escala escolhida.
  const bodyWidth = byWaist ? (2 * body.chestHalfWidth * fit.ease) / metersPerPx : g.bodyWidth;
  const sleeveless = g.armpitY !== null;
  // Alças: na foto elas sobem retas, com laços e pontas, bem acima de onde fica
  // o ombro. O que passa do alto do ombro é cortado (a alça termina em cima
  // dele, onde frente e costas se encontram) — senão ficava espetado no ar.
  const armpitWorldY = body.shoulderY - 0.085 + fit.offsetY;
  const strapTopPx = g.armpitY !== null ? g.armpitY - (body.shoulderY + 0.045 - armpitWorldY) / metersPerPx : -Infinity;
  // E elas são trazidas para cima do ombro (entre o pescoço e a articulação),
  // se na escala da peça caírem para fora dele.
  let strapScale = 1;
  if (g.armpitY !== null) {
    let sum = 0, n = 0;
    for (let y = Math.max(0, Math.ceil(strapTopPx)); y < g.armpitY - 2; y++) {
      for (let x = bbox.minX; x <= bbox.maxX; x++) {
        if (!mask[y * width + x]) continue;
        sum += Math.abs(x - centerX);
        n++;
      }
    }
    const actual = n ? (sum / n) * metersPerPx : 0;
    const target = body.shoulderX * 0.62;
    if (actual > target) strapScale = target / actual;
  }
  const bodyHalfW = body.chestHalfWidth * fit.ease;
  const bodyHalfD = body.chestHalfDepth * (1 + (fit.ease - 1) * 0.8) + 0.012;
  /**
   * Distância entre o tecido e a pele (frente e costas): o tecido apoia nos
   * ombros e no alto do peito e só se afasta mais da metade do tronco para
   * baixo. Antes era uniforme (2,8 cm com 20% de folga) e a peça parecia inflada.
   */
  const extra = Math.max(0, fit.ease - 1);
  const gapAt = (y: number) => 0.005 + extra * (0.015 + 0.035 * smoothstep(body.collarY - 0.08, body.collarY - 0.4, y));

  const bw = bbox.maxX - bbox.minX + 1;
  const cell = Math.max(1, bw / 150);
  const x0 = bbox.minX - cell;
  const y0 = bbox.minY - cell;
  const cols = Math.ceil(bw / cell) + 3;
  const rows = Math.ceil((bbox.maxY - bbox.minY + 1) / cell) + 3;

  // Sem manga, toda a borda de baixo é barra (aberta), inclusive a saia rodada;
  // com manga, só a largura do tronco (o lado de baixo da manga é costura).
  const hemL = sleeveless ? -Infinity : centerX - bodyWidth / 2 + cell * 2;
  const hemR = sleeveless ? Infinity : centerX + bodyWidth / 2 - cell * 2;

  const inMask = new Uint8Array(cols * rows);
  const inExt = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const px = Math.round(x0 + i * cell);
      const py = Math.round(y0 + j * cell);
      const k = j * cols + i;
      const inside =
        px >= 0 && py >= 0 && px < width && py < height && mask[py * width + px] === 1 && py >= strapTopPx;
      inMask[k] = inside ? 1 : 0;
      // Extensão abaixo da barra (dentro da largura do tronco) para manter a barra aberta.
      const col = Math.min(width - 1, Math.max(0, px));
      const below = px >= hemL && px <= hemR && hemY[col] >= 0 && py > hemY[col] - cell;
      inExt[k] = inside || below ? 1 : 0;
    }
  }

  // Frestas finas na silhueta (a manga caída encostada no corpo deixa um fio de
  // fundo entre os dois): na grade viravam uma fileira de furos. Fecha vãos
  // horizontais de até 3 células (~2% da largura da peça) com tecido dos dois lados.
  const GAP = 3;
  for (let j = 0; j < rows; j++) {
    let last = -1;
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (!inMask[k]) continue;
      if (last >= 0 && i - last > 1 && i - last <= GAP + 1) {
        for (let q = last + 1; q < i; q++) inMask[j * cols + q] = inExt[j * cols + q] = 1;
      }
      last = i;
    }
  }
  const dist = chamferDistance(inExt, cols, rows); // em células
  // Numa borda inclinada (a manga) a distância da grade vira uma escada, linha
  // a linha, e o arredondamento da costura saía em listras. Suaviza o campo.
  for (let it = 0; it < 8; it++) {
    const next = dist.slice();
    for (let j = 1; j < rows - 1; j++) {
      for (let i = 1; i < cols - 1; i++) {
        const k = j * cols + i;
        if (!inExt[k]) continue;
        let s = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const q = k + dj * cols + di;
            s += dist[q];
            n++;
          }
        }
        next[k] = Math.max(0.5, s / n);
      }
    }
    dist.set(next);
  }
  const radiusCells = fit.seamRadius / (metersPerPx * cell);

  // Vértices --------------------------------------------------------------
  const frontIdx = new Int32Array(cols * rows).fill(-1);
  const backIdx = new Int32Array(cols * rows).fill(-1);
  const positions: number[] = [];
  const uvs: number[] = [];
  const sleeves: number[] = [];
  const pushVertex = (x: number, y: number, z: number, u: number, v: number, s: number) => {
    positions.push(x, y, z);
    uvs.push(u, v);
    sleeves.push(s);
    return positions.length / 3 - 1;
  };

  // Vizinhança de 8: todo triângulo que falta ao redor de um vértice tem um
  // canto fora entre os 8 vizinhos. Com só 4, os vértices nos degraus
  // diagonais do contorno ficavam duplicados (frente ≠ verso) e abriam
  // buracos na costura do ombro e da manga.
  const isBoundary = (i: number, j: number) => {
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) return true;
        if (!inExt[nj * cols + ni]) return true;
      }
    }
    return false;
  };

  // Posições em pixels; o contorno é suavizado para tirar o efeito "escada".
  const gx = new Float32Array(cols * rows);
  const gy = new Float32Array(cols * rows);
  const boundary = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      gx[k] = x0 + i * cell;
      gy[k] = y0 + j * cell;
      if (inMask[k] && isBoundary(i, j)) boundary[k] = 1;
    }
  }
  for (let iter = 0; iter < 16; iter++) {
    const nx = gx.slice(), ny = gy.slice();
    for (let j = 1; j < rows - 1; j++) {
      for (let i = 1; i < cols - 1; i++) {
        const k = j * cols + i;
        if (!boundary[k]) continue;
        let sx = gx[k], sy = gy[k], c = 1;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const q = k + dj * cols + di;
            if (q !== k && boundary[q]) {
              sx += gx[q];
              sy += gy[q];
              c++;
            }
          }
        }
        nx[k] = sx / c;
        ny[k] = sy / c;
      }
    }
    gx.set(nx);
    gy.set(ny);
  }

  // A borda suavizada sai da grade, mas os vértices logo para dentro ficavam
  // nela: a faixa de triângulos junto à costura variava a cada degrau e virava
  // listras de sombra (na manga e nas laterais). Relaxa essa faixa também.
  for (let iter = 0; iter < 12; iter++) {
    const nx = gx.slice(), ny = gy.slice();
    for (let j = 1; j < rows - 1; j++) {
      for (let i = 1; i < cols - 1; i++) {
        const k = j * cols + i;
        if (!inMask[k] || boundary[k] || dist[k] > 4) continue;
        let sx = 0, sy = 0, c = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const q = k + dj * cols + di;
            if (q === k || !inMask[q]) continue;
            sx += gx[q];
            sy += gy[q];
            c++;
          }
        }
        if (!c) continue;
        nx[k] = (gx[k] + sx / c) / 2;
        ny[k] = (gy[k] + sy / c) / 2;
      }
    }
    gx.set(nx);
    gy.set(ny);
  }

  // Âncora vertical: sem manga, o alto da lateral fica na axila (decote em V,
  // alças e laços não dizem onde é o pescoço); senão, a gola fica no pescoço.
  const anchorPx = g.armpitY !== null ? g.armpitY : collarY;
  const anchorY = sleeveless ? body.shoulderY - 0.085 : body.collarY;
  const toWorldY = (py: number) => anchorY + fit.offsetY - (py - anchorPx) * metersPerPx;
  const drape = sleeveless ? null : sleeveDrape({ ...g, bodyWidth }, metersPerPx, toWorldY, body);

  /**
   * Peso da manga pelo ângulo em volta do ombro: o tronco (abaixo da axila)
   * fica parado, a manga segue o braço inteira e acima do ombro o efeito some
   * aos poucos. `ax` = |x| em metros.
   */
  let ramp = drape ? drape.phiHi - drape.phiLo : 1;
  const sleeveWeight = (ax: number, ym: number) => {
    if (!drape) return 0;
    const phi = Math.atan2(ym - drape.pivotY, ax - drape.pivotX);
    return (
      Math.min(1, Math.max(0, (phi - drape.phiLo) / ramp)) * (1 - smoothstep(Math.PI * 0.35, Math.PI * 0.85, phi))
    );
  };

  // Manga comprida ou já caída na foto (vestido, blusa de manga longa): o tubo
  // reto em volta do osso do braço (ombro → cotovelo) virava um cilindro duro,
  // solto do ombro e quebrado no cotovelo. Nesse caso a manga fica em duas
  // camadas que seguem a superfície do braço, como o tronco.
  const upperArm = body.arm ? Math.hypot(body.arm.x1 - body.shoulderX, body.arm.y1 - body.shoulderY) : 0;
  const hanging = !!drape && (Math.abs(drape.theta) < 0.45 || drape.length > upperArm * 1.2);
  const tube = drape && body.arm && surface && !hanging ? sleeveTube(drape, body, extra) : null;
  // Na foto a manga caída costuma ficar colada ao corpo, mais para dentro que o
  // braço do personagem (que abre para o lado): o braço saía por fora dela. Em
  // cada linha a manga desliza para fora até o meio dela cair sobre o braço.
  // Saia de peça acinturada: volume redondo (visto de cima, uma elipse), com a
  // profundidade crescendo junto com a largura da saia. Só seguindo o corpo, a
  // saia abria para os lados e de perfil ficava chapada.
  const waistWorldY = byWaist ? toWorldY(byWaist.px.y) : 0;
  const waistCenter = byWaist && surface ? surface(0, waistWorldY, 0) : null;
  const skirt = byWaist && waistCenter
    ? { y: waistWorldY, a0: (byWaist.px.width / 2) * metersPerPx, depth: (waistCenter.front - waistCenter.back) / 2 }
    : null;
  const skirtHalf = new Float32Array(rows);
  if (skirt) {
    for (let j = 0; j < rows; j++) {
      const py = Math.min(height - 1, Math.max(0, Math.round(y0 + j * cell)));
      let l = -1, r = -1;
      for (let x = bbox.minX; x <= bbox.maxX; x++) {
        if (mask[py * width + x]) {
          if (l < 0) l = x;
          r = x;
        }
      }
      skirtHalf[j] = l < 0 ? 0 : Math.max(centerX - l, r - centerX) * metersPerPx;
    }
    for (let it = 0; it < 4; it++) {
      const prev = skirtHalf.slice();
      for (let j = 1; j < rows - 1; j++) skirtHalf[j] = (prev[j - 1] + 2 * prev[j] + prev[j + 1]) / 4;
    }
  }

  const rowShift = new Float32Array(rows);
  const inner = (bodyWidth / 2) * metersPerPx;
  if (hanging && !tube) {
    const tanA = Math.tan((body.armAngleDeg * Math.PI) / 180);
    for (let j = 0; j < rows; j++) {
      const py = Math.round(y0 + j * cell);
      if (py < 0 || py >= height) continue;
      let l = -1, r = -1;
      for (let x = bbox.minX; x <= bbox.maxX; x++) {
        if (mask[py * width + x]) {
          if (l < 0) l = x;
          r = x;
        }
      }
      if (l < 0) continue;
      const outer = ((centerX - l + (r - centerX)) / 2) * metersPerPx;
      if (outer < inner * 1.05) continue;
      const armX = body.shoulderX + Math.max(0, body.shoulderY - toWorldY(py)) / tanA;
      rowShift[j] = Math.max(0, armX - (inner + outer) / 2);
    }
    for (let it = 0; it < 6; it++) {
      const prev = rowShift.slice();
      for (let j = 1; j < rows - 1; j++) rowShift[j] = (prev[j - 1] + 2 * prev[j] + prev[j + 1]) / 4;
    }
  }
  // Meia espessura mínima da manga sem tubo: o braço cabe dentro mesmo onde o
  // mapa do corpo já afinou (manga mais larga que o braço).
  const sleeveHalf = (body.arm?.radius ?? 0.045) + 0.012 + extra * 0.03;
  if (tube) {
    // O giro antigo precisava de uma rampa larga (senão a malha dobrava); com o
    // tubo, a manga inteira é manga e a transição fica só junto à axila. Com a
    // rampa larga, metade da manga se misturava à posição plana e ondulava.
    // A faixa de transição mistura o tubo com a posição plana da foto; larga, ela
    // formava uma superfície que cruzava o tubo em ângulo rasante (listras).
    ramp = Math.min(ramp, 0.08);
    // Largura da manga (de costura a costura) ao longo do eixo dela na foto.
    for (let k = 0; k < cols * rows; k++) {
      if (!inMask[k]) continue;
      const ax = Math.abs((gx[k] - centerX) * metersPerPx);
      const ym = toWorldY(gy[k]);
      if (sleeveWeight(ax, ym) >= 0.5) tube.addSample(ax, ym);
    }
    tube.finish();
  }
  const cellM = cell * metersPerPx;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (!inMask[k]) continue;
      const px = gx[k];
      const py = gy[k];
      let xm = (px - centerX) * metersPerPx;
      let ym = toWorldY(py);
      if (strapScale < 1) xm *= 1 + (strapScale - 1) * smoothstep(armpitWorldY, armpitWorldY + 0.05, ym);
      const side = Math.sign(xm) || 1;
      const ax = Math.abs(xm);

      // Sem mapa do corpo: perfil elíptico do tronco + espessura mínima nas mangas.
      const e = 1 - (xm / bodyHalfW) ** 2;
      const zBody = e > 0 ? bodyHalfD * Math.sqrt(e) : 0;
      const zFull = Math.max(zBody, body.sleeveHalfThickness);

      const u = px / width;
      const v = 1 - py / height;

      let sleeve = sleeveWeight(ax, ym);
      // Sem o tubo (manequim sem esqueleto): a manga gira em volta do ombro.
      if (drape && !tube && hanging) {
        // O deslocamento cresce aos poucos a partir da lateral do tronco (no
        // máximo ~1,5× de estiramento). Aplicado de uma vez, uma fileira de
        // triângulos esticava vários centímetros e a pele passava por eles.
        // Só a manga desliza (a saia rodada, mais larga que o tronco, fica onde está).
        const d = rowShift[j];
        // Manga caída = tudo que passa da lateral do tronco, da ponta da manga para
        // cima (pelo ângulo em volta do ombro, a faixa logo abaixo da axila ficava
        // de fora e virava tronco).
        const above = smoothstep(drape.endY - 0.1, drape.endY - 0.04, ym);
        const r = smoothstep(inner, inner + Math.max(0.03, d / 0.75), ax) * Math.max(Math.min(1, sleeve * 4), above);
        if (d > 0) xm = side * (ax + d * r);
        sleeve = Math.max(sleeve, above * smoothstep(inner - 0.01, inner + 0.015, Math.abs(xm)));
        // O que foi parar em cima do braço é manga: usa o molde com o braço (e a
        // folga dela) e herda os pesos do braço. Como "tronco" ficava dentro do
        // braço e o empurrão para fora deixava um calombo a cada anel da malha.
        if (d > 0) sleeve = Math.max(sleeve, r);
      } else if (drape && !tube && sleeve > 0) {
        const dx = ax - drape.pivotX, dy = ym - drape.pivotY;
        const ang = drape.theta * sleeve;
        const c = Math.cos(ang), s = Math.sin(ang);
        xm = side * (drape.pivotX + dx * c - dy * s);
        ym = drape.pivotY + dx * s + dy * c;
      }

      // Frente e verso: seguem o corpo (com folga) quando há mapa dele. Com o
      // tubo, esta é a posição "de tronco" da peça, misturada ao tubo abaixo.
      const sw = tube ? 0 : sleeve;
      let zF = zFull, zB = -zFull;
      let s = surface?.(xm, ym, sw);
      if (s && surface && hanging && !tube && sw > 0) {
        // Manga caída: o tecido passa reto por cima da dobra entre o braço e o
        // tronco (pega a superfície mais saliente em ±6 cm) em vez de entrar
        // nela — atrás da axila ficava uma abertura com a pele à mostra.
        let front = s.front, back = s.back;
        for (const dx of [-0.06, -0.03, 0.03, 0.06]) {
          const q = surface(xm + dx, ym, sw);
          if (!q) continue;
          front = Math.max(front, q.front);
          back = Math.min(back, q.back);
        }
        s = { front: s.front + (front - s.front) * sw, back: s.back + (back - s.back) * sw };
      }
      if (skirt && surface && ym < skirt.y && skirtHalf[j] > 0.01) {
        const t = smoothstep(skirt.y, skirt.y - 0.08, ym);
        const c0 = surface(0, ym, 0);
        if (c0 && t > 0) {
          const a = skirtHalf[j];
          const zc = (c0.front + c0.back) / 2;
          const e = (skirt.depth + Math.max(0, a - skirt.a0) * 0.8) * Math.sqrt(Math.max(0, 1 - (xm / a) ** 2));
          s = s
            ? {
                front: s.front + (Math.max(s.front, zc + e) - s.front) * t,
                back: s.back + (Math.min(s.back, zc - e) - s.back) * t,
              }
            : { front: zc + e * t, back: zc - e * t };
        }
      }
      const gap = gapAt(ym) + (0.008 + extra * 0.1 - gapAt(ym)) * sw;
      if (s) {
        zF = s.front + gap;
        zB = s.back - gap;
      } else if (surface) {
        // Longe do corpo (entre o braço e o tronco): frente e verso quase juntos.
        zF = gap;
        zB = -gap;
      }
      if (!tube && sw > 0 && zF - zB < 2 * sleeveHalf * sw) {
        const m = (zF + zB) / 2, half = Math.max((zF - zB) / 2, sleeveHalf * sw);
        zF = m + half;
        zB = m - half;
      }
      const mid = (zF + zB) / 2;

      let zf = mid, zb = mid;
      if (!boundary[k]) {
        const t = Math.min(1, Math.max(0, (dist[k] - 1) / radiusCells));
        const round = Math.sqrt(1 - (1 - t) * (1 - t));
        zf = mid + (zF - mid) * round;
        zb = mid + (zB - mid) * round;
        // O arredondamento da costura não entra no corpo: senão o empurrão
        // para fora (pushOutOfBody) é que corrige, e deixa calombos. Cede perto
        // da costura, onde frente e verso se juntam.
        if (s && sw < 0.5) {
          const w = Math.sqrt(round) * (1 - sw * 2);
          zf = Math.max(zf, mid + (Math.min(zF, s.front + 0.003) - mid) * w);
          zb = Math.min(zb, mid + (Math.max(zB, s.back - 0.003) - mid) * w);
        }
      }

      if (tube && sleeve > 0) {
        // Manga enrolada no braço: a largura da foto é meia volta do tubo.
        const cuff = boundary[k] && sleeve >= 0.8 && tube.isCuff(ax, ym, cellM);
        const tf = tube.at(ax, ym, boundary[k] && !cuff ? 0 : 1);
        const tb = tube.at(ax, ym, boundary[k] && !cuff ? 0 : -1);
        const w = sleeve;
        const fx = side * (ax + (tf[0] - ax) * w), fy = ym + (tf[1] - ym) * w;
        const bx = side * (ax + (tb[0] - ax) * w), by = ym + (tb[1] - ym) * w;
        const ff = zf + (tf[2] - zf) * w, bb = zb + (tb[2] - zb) * w;
        if (boundary[k] && !cuff) {
          frontIdx[k] = backIdx[k] = pushVertex(fx, fy, ff, u, v, sleeve);
        } else {
          // O punho fica aberto (o braço passa por ele): vértices separados.
          frontIdx[k] = pushVertex(fx, fy, ff, u, v, sleeve);
          backIdx[k] = pushVertex(bx, by, bb, u, v, sleeve);
        }
        continue;
      }

      if (boundary[k]) {
        // Costura: frente e verso compartilham o vértice, no meio da profundidade.
        frontIdx[k] = backIdx[k] = pushVertex(xm, ym, mid, u, v, sleeve);
      } else {
        frontIdx[k] = pushVertex(xm, ym, zf, u, v, sleeve);
        backIdx[k] = pushVertex(xm, ym, zb, u, v, sleeve);
      }
    }
  }

  // Triângulos -------------------------------------------------------------
  const front: number[] = [];
  const back: number[] = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      const tri = (p: number, q: number, r: number) => {
        if (!inMask[p] || !inMask[q] || !inMask[r]) return;
        front.push(frontIdx[p], frontIdx[q], frontIdx[r]);
        back.push(backIdx[p], backIdx[r], backIdx[q]);
      };
      tri(a, c, b);
      tri(b, c, d);
    }
  }

  const index = [...front, ...back];
  // A manga enrolada no tubo já sai lisa: a suavização (feita para os degraus
  // das costuras do tronco) a deformava em vários milímetros e criava faixas.
  taubinSmooth(positions, index, 12, tube ? sleeves.map((s) => (s >= 0.99 ? 1 : 0)) : undefined);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("manga", new THREE.Float32BufferAttribute(sleeves, 1));
  geo.setIndex(index);
  geo.addGroup(0, front.length, 0);
  geo.addGroup(front.length, back.length, 1);
  geo.computeVertexNormals();
  if (body.centerZ) geo.translate(0, 0, body.centerZ);
  // Manga caída em camadas: pede o alisamento final (ver smoothGarment).
  geo.userData.hangingSleeves = hanging && !tube;
  return geo;
}

/**
 * Alisamento final da peça já vestida. No vão entre o braço e o tronco o
 * empurrão para fora do corpo leva vértices vizinhos em direções opostas (um
 * segue o braço, o outro o tronco) e a manga caída saía com uma fileira de
 * calombos. As bordas abertas (barra, punho) ficam paradas.
 */
export function smoothGarment(geo: THREE.BufferGeometry, iterations: number) {
  const attr = geo.getAttribute("position");
  const index = geo.getIndex();
  if (!index) return;
  const pos = Array.from(attr.array as ArrayLike<number>);
  taubinSmooth(pos, Array.from(index.array as ArrayLike<number>), iterations);
  (attr.array as Float32Array).set(pos);
  attr.needsUpdate = true;
  geo.computeVertexNormals();
}

/**
 * Suavização de Taubin (λ/μ): tira as ondulações que os degraus da grade
 * deixam nas costuras sem encolher a peça. Vértices da barra aberta (arestas
 * com um só triângulo) ficam parados para a bainha não subir.
 */
function taubinSmooth(pos: number[], index: number[], iterations: number, fixed?: number[]) {
  const n = pos.length / 3;
  const edgeCount = new Map<number, number>();
  const nb: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t < index.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = index[t + e], b = index[t + ((e + 1) % 3)];
      const k = a < b ? a * n + b : b * n + a;
      const c = edgeCount.get(k) ?? 0;
      edgeCount.set(k, c + 1);
      if (!c) {
        nb[a].push(b);
        nb[b].push(a);
      }
    }
  }
  const pinned = new Uint8Array(n);
  if (fixed) for (let i = 0; i < n; i++) if (fixed[i]) pinned[i] = 1;
  for (const [k, c] of edgeCount) {
    if (c !== 1) continue;
    pinned[Math.floor(k / n)] = 1;
    pinned[k % n] = 1;
  }
  const tmp = new Float32Array(pos.length);
  const step = (f: number) => {
    for (let i = 0; i < n; i++) {
      const list = nb[i];
      for (let c = 0; c < 3; c++) {
        const own = pos[i * 3 + c];
        if (pinned[i] || !list.length) {
          tmp[i * 3 + c] = own;
          continue;
        }
        let s = 0;
        for (const j of list) s += pos[j * 3 + c];
        tmp[i * 3 + c] = own + f * (s / list.length - own);
      }
    }
    for (let i = 0; i < pos.length; i++) pos[i] = tmp[i];
  };
  for (let it = 0; it < iterations; it++) {
    step(0.5);
    step(-0.53);
  }
}

/**
 * Manga enrolada no braço. Na foto a manga é plana: o eixo dela vai do pivô do
 * ombro até a ponta, e a largura (da costura de cima à de baixo) é meia volta
 * do tubo. Cada ponto (a ao longo do eixo, p na largura) vai para o ângulo
 * α = π·(topo − p)/largura em volta do osso do braço (ombro → cotovelo): a
 * costura de cima fica do lado de fora do braço, a de baixo do lado de dentro,
 * a frente da peça cobre a frente do braço e o verso, as costas.
 * Antes a manga era girada no plano da foto, o que a espremia numa placa fina
 * ao lado do braço; o empurrão para fora a arrastava e ela saía listrada.
 */
function sleeveTube(drape: NonNullable<ReturnType<typeof sleeveDrape>>, body: BodyDims, extra: number) {
  const arm = body.arm!;
  // Eixo da manga na foto e a normal apontando para a costura de cima.
  let dPx = drape.endX - drape.pivotX, dPy = drape.endY - drape.pivotY;
  const lP = Math.hypot(dPx, dPy) || 1;
  dPx /= lP;
  dPy /= lP;
  const nPx = -dPy, nPy = dPx;
  // Eixo do braço (vista de frente) e a normal apontando para fora do corpo.
  let dx = arm.x1 - body.shoulderX, dy = arm.y1 - body.shoulderY;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const nx = -dy, ny = dx;
  // Onde o pivô da foto cai no eixo do braço.
  const tP = (drape.pivotX - body.shoulderX) * dx + (drape.pivotY - body.shoulderY) * dy;
  // Folga acima da margem do empurrão para fora (1,2 cm): no limite, metade dos
  // vértices era empurrada pela normal de cada anel da malha do braço e a manga
  // saía com listras.
  const minR = arm.radius + 0.018 + extra * 0.02;

  const local = (ax: number, ym: number) => {
    const rx = ax - drape.pivotX, ry = ym - drape.pivotY;
    return [rx * dPx + ry * dPy, rx * nPx + ry * nPy] as const;
  };

  const BIN = 0.01;
  const samples: number[] = [];
  let aLo = 0, pLo = 0, width = 0.1;
  let lo = new Float32Array(1), hi = new Float32Array(1), aMax = new Float32Array(1);
  // Leitura interpolada entre os centros das faixas (por faixa, o ângulo pulava
  // a cada centímetro e a manga saía ondulada).
  const binOf = (arr: Float32Array, start: number, x: number) => {
    const f = Math.min(arr.length - 1, Math.max(0, (x - start) / BIN - 0.5));
    const i = Math.min(arr.length - 2, Math.floor(f));
    if (i < 0) return arr[0];
    const t = f - i;
    return arr[i] * (1 - t) + arr[i + 1] * t;
  };

  return {
    addSample(ax: number, ym: number) {
      const [a, p] = local(ax, ym);
      samples.push(a, p);
    },
    finish() {
      if (!samples.length) return;
      let aHi = -Infinity, pHi = -Infinity;
      aLo = Infinity;
      pLo = Infinity;
      for (let i = 0; i < samples.length; i += 2) {
        aLo = Math.min(aLo, samples[i]);
        aHi = Math.max(aHi, samples[i]);
        pLo = Math.min(pLo, samples[i + 1]);
        pHi = Math.max(pHi, samples[i + 1]);
      }
      const na = Math.floor((aHi - aLo) / BIN) + 1;
      const np = Math.floor((pHi - pLo) / BIN) + 1;
      lo = new Float32Array(na).fill(Infinity);
      hi = new Float32Array(na).fill(-Infinity);
      aMax = new Float32Array(np).fill(-Infinity);
      for (let i = 0; i < samples.length; i += 2) {
        const a = samples[i], p = samples[i + 1];
        const ia = Math.floor((a - aLo) / BIN), ip = Math.floor((p - pLo) / BIN);
        lo[ia] = Math.min(lo[ia], p);
        hi[ia] = Math.max(hi[ia], p);
        aMax[ip] = Math.max(aMax[ip], a);
      }
      // As costuras de cima e de baixo da manga são quase retas: ajusta uma reta
      // a cada uma. Faixa a faixa, a largura oscilava com os degraus da borda e
      // a manga saía ondulada.
      fitLine(lo);
      fitLine(hi);
      // A reta passava pelo meio dos degraus da borda: os pontos acima dela eram
      // achatados em α = 0, faixas inteiras da grade caíam na costura e os
      // triângulos dobravam (anéis no lado de fora da manga). Desloca as retas
      // até envolverem todos os pontos.
      let up = 0, down = 0;
      for (let i = 0; i < samples.length; i += 2) {
        const a = samples[i], p = samples[i + 1];
        up = Math.max(up, p - binOf(hi, aLo, a));
        down = Math.max(down, binOf(lo, aLo, a) - p);
      }
      for (let i = 0; i < hi.length; i++) {
        hi[i] += up;
        lo[i] -= down;
      }
      fillGaps(aMax);
      // Largura de referência, medida na parte já formada da manga (perto do punho).
      const k = Math.floor((lo.length - 1) * 0.8);
      width = Math.max(0.02, hi[k] - lo[k]);
    },
    /** Posição no tubo: [|x|, y, z]; layer +1 = frente, −1 = verso, 0 = na costura. */
    at(ax: number, ym: number, layer: number): [number, number, number] {
      const [a, p] = local(ax, ym);
      const top = binOf(hi, aLo, a);
      // A faixa da foto em cada ponto do eixo (da costura de cima até onde a
      // manga encontra o tronco) vira a meia volta inteira. Com uma largura só,
      // perto do ombro a faixa (estreita) cobria só o alto do tubo e o resto
      // descia reto até o tronco: a manga virava uma caixa com parede no ombro.
      // Piso em meia largura: junto ao pivô a faixa tende a zero e o estiramento
      // explodia; lá a parte de baixo do tubo fica com a transição para o tronco.
      const span = Math.max(0.5 * width, top - binOf(lo, aLo, a));
      const R = Math.max(width / Math.PI, minR);
      let al = Math.PI * Math.min(1, Math.max(0, (top - p) / span));
      // Vértice de costura (frente e verso juntos): fica exatamente na dobra.
      if (layer === 0) al = al < Math.PI / 2 ? 0 : Math.PI;
      // Antes do ombro o eixo é comprimido aos poucos (piso suave). Com um piso
      // seco em −2 cm, toda a faixa acima do pivô caía no mesmo anel e o alto do
      // ombro rasgava, com pregas.
      const t0 = tP + a;
      const S = 0.04;
      const t = t0 >= 0 ? t0 : -S * (1 - Math.exp(t0 / S));
      const cx = body.shoulderX + dx * t, cy = body.shoulderY + dy * t;
      const zc = arm.z0 + ((arm.z1 - arm.z0) * t) / len;
      const c = Math.cos(al) * R;
      return [cx + nx * c, cy + ny * c, zc + layer * Math.sin(al) * R];
    },
    /** Ponto da borda que pertence ao punho (aberto), e não às costuras. */
    isCuff(ax: number, ym: number, cellM: number) {
      const [a, p] = local(ax, ym);
      return a > binOf(aMax, pLo, p) - 2.5 * cellM;
    },
  };
}

/** Preenche as posições infinitas com o vizinho conhecido mais próximo. */
function fillGaps(arr: Float32Array) {
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < arr.length; i++) if (!isFinite(arr[i]) && isFinite(arr[i - 1])) arr[i] = arr[i - 1];
    for (let i = arr.length - 2; i >= 0; i--) if (!isFinite(arr[i]) && isFinite(arr[i + 1])) arr[i] = arr[i + 1];
  }
}

/** Troca os valores pela reta de mínimos quadrados (ignorando os infinitos). */
function fitLine(arr: Float32Array) {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < arr.length; i++) {
    if (!isFinite(arr[i])) continue;
    n++;
    sx += i;
    sy += arr[i];
    sxx += i * i;
    sxy += i * arr[i];
  }
  if (!n) return;
  const den = n * sxx - sx * sx;
  const b = den > 1e-9 ? (n * sxy - sx * sy) / den : 0;
  const a = (sy - b * sx) / n;
  for (let i = 0; i < arr.length; i++) arr[i] = a + b * i;
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Calcula quanto girar as mangas (em torno do ombro) para que a ponta da manga
 * caia sobre a linha do braço do manequim. null se a peça não tem mangas.
 */
function sleeveDrape(g: ProcessedGarment, metersPerPx: number, toWorldY: (py: number) => number, body: BodyDims) {
  const { mask, width, height, bbox, centerX, bodyWidth } = g;
  const bw = bbox.maxX - bbox.minX + 1;
  const firstRow = (x: number) => {
    for (let y = 0; y < height; y++) if (mask[y * width + x]) return y;
    return -1;
  };
  const lastRow = (x: number) => {
    for (let y = height - 1; y >= 0; y--) if (mask[y * width + x]) return y;
    return -1;
  };

  const ends: { x: number; y: number }[] = [];
  const pivots: { x: number; y: number; armpit: number }[] = [];
  for (const side of [1, -1]) {
    const edge = side === 1 ? bbox.maxX : bbox.minX;
    if (Math.abs(edge - centerX) - bodyWidth / 2 < bw * 0.04) return null; // sem manga
    const band = bw * 0.03;
    let sx = 0, sy = 0, c = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (mask[y * width + x] && side * (x - edge) >= -band) {
          sx += x;
          sy += y;
          c++;
        }
      }
    }
    if (!c) return null;
    ends.push({ x: Math.abs(sx / c - centerX) * metersPerPx, y: toWorldY(sy / c) });

    const pivotCol = Math.round(centerX + side * (bodyWidth / 2) * 0.9);
    const armpitCol = Math.round(centerX + side * (bodyWidth / 2 + bw * 0.02));
    const top = firstRow(Math.min(width - 1, Math.max(0, pivotCol)));
    const pit = lastRow(Math.min(width - 1, Math.max(0, armpitCol)));
    if (top < 0 || pit < 0) return null;
    pivots.push({ x: (bodyWidth / 2) * 0.9 * metersPerPx, y: toWorldY(top) - 0.02, armpit: toWorldY(pit) });
  }

  const E = { x: (ends[0].x + ends[1].x) / 2, y: (ends[0].y + ends[1].y) / 2 };
  const P = { x: pivots[0].x, y: (pivots[0].y + pivots[1].y) / 2 };
  const armpitY = (pivots[0].armpit + pivots[1].armpit) / 2;

  // Ponto da linha do braço à mesma distância do pivô que a ponta da manga.
  const a = (body.armAngleDeg * Math.PI) / 180;
  const d = { x: Math.cos(a), y: -Math.sin(a) };
  const f = { x: body.shoulderX - P.x, y: body.shoulderY - P.y };
  const r2 = (E.x - P.x) ** 2 + (E.y - P.y) ** 2;
  const fd = f.x * d.x + f.y * d.y;
  const disc = fd * fd - (f.x * f.x + f.y * f.y) + r2;
  const from = Math.atan2(E.y - P.y, E.x - P.x);
  let to = -a;
  if (disc >= 0) {
    const t = -fd + Math.sqrt(disc);
    to = Math.atan2(body.shoulderY + t * d.y - P.y, body.shoulderX + t * d.x - P.x);
  }
  // Positivo = a manga da foto cai mais reta que o braço e abre até ele.
  const theta = Math.min(0.6, Math.max(-1.4, to - from));

  // Faixa de ângulos (vista do pivô) em que o giro vai de 0 a 1: começa na
  // axila. Com φ' = φ + θ·w(φ), a malha só dobra se |θ|·w' > 1; a rampa linear de
  // largura 1,12·|θ| fica logo abaixo disso e fecha o vão sob a manga (~10%).
  const pitX = (bodyWidth / 2 + bw * 0.02) * metersPerPx;
  const phiLo = Math.atan2(armpitY - P.y, pitX - P.x);
  const phiHi = phiLo + Math.max(0.05, Math.abs(theta) * 1.12);
  return { pivotX: P.x, pivotY: P.y, theta, phiLo, phiHi, endX: E.x, endY: E.y, length: Math.sqrt(r2) };
}

/** Distância (chamfer 3-4) de cada célula interna até a célula externa mais próxima. */
function chamferDistance(inside: Uint8Array, w: number, h: number) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) d[k] = inside[k] ? INF : 0;
  // Abaixo da grade, a extensão da barra continua "dentro" (barra aberta).
  const at = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w) return 0;
    if (y >= h) return inside[(h - 1) * w + x] ? INF : 0;
    return d[y * w + x];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (!d[k]) continue;
      d[k] = Math.min(d[k], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const k = y * w + x;
      if (!d[k]) continue;
      d[k] = Math.min(d[k], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  }
  for (let k = 0; k < w * h; k++) d[k] /= 3;
  return d;
}
