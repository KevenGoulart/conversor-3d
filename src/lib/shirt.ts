import * as THREE from "three";
import type { ProcessedGarment } from "./garment";

/**
 * Camiseta pronta do modelo (objeto cima_*): em vez de montar a peça a partir da
 * silhueta da foto, pinta a camiseta com a cor da foto e desenha a estampa dela
 * no painel da frente ou das costas do atlas UV.
 *
 * Retângulo de um painel no atlas, em coordenadas de imagem (0–1, y para baixo):
 * [x0, y0, x1, y1]. Vem do .glb (extras "uv_frente" / "uv_costas" do gerador).
 */
export type Panel = [number, number, number, number];

const TEXTURE_SIZE = 2048;

/** Lê os painéis gravados pelo gerador no objeto da camiseta. */
export function shirtPanels(o: THREE.Object3D): { front: Panel; back: Panel } | null {
  let front: Panel | null = null, back: Panel | null = null;
  o.traverse((x) => {
    const d = x.userData;
    if (!front && isPanel(d?.uv_frente)) front = d.uv_frente;
    if (!back && isPanel(d?.uv_costas)) back = d.uv_costas;
  });
  return front && back ? { front, back } : null;
}

function isPanel(v: unknown): v is Panel {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number");
}

/**
 * Estampa: o tronco da foto (sem as mangas), com transparência onde o pixel tem
 * a cor do tecido. A borda é suave (rampa na distância de cor) para não serrilhar,
 * e as sombras leves da foto (dobras) ficam abaixo do limiar.
 */
export function extractPrint(g: ProcessedGarment): HTMLCanvasElement {
  const { width, mask, centerX, bodyWidth, bbox, hemY, textureCanvas } = g;
  const x0 = Math.max(0, Math.round(centerX - bodyWidth / 2));
  const x1 = Math.min(width - 1, Math.round(centerX + bodyWidth / 2));
  const y0 = bbox.minY;
  let y1 = y0 + 1;
  for (let x = x0; x <= x1; x++) y1 = Math.max(y1, hemY[x]);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;

  const src = textureCanvas.getContext("2d", { willReadFrequently: true })!.getImageData(x0, y0, w, h);
  const base = hexToRgb(g.baseColor);
  const px = src.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!mask[(y + y0) * width + x + x0]) {
        px[i + 3] = 0;
        continue;
      }
      const d = Math.hypot(px[i] - base[0], px[i + 1] - base[1], px[i + 2] - base[2]);
      px[i + 3] = Math.round(255 * smoothstep(28, 60, d));
    }
  }
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.putImageData(src, 0, 0);
  return out;
}

/**
 * Tecido da foto para cobrir a peça inteira (costas, lados, mangas): o quadrado do
 * tronco com menos estampa (pixels longe da cor do tecido), todo dentro da peça.
 * Sai espelhado 2×2, para as emendas da repetição não aparecerem. Uma camiseta
 * lisa dá um quadrado quase liso; um tricô dá a malha.
 */
export function extractFabric(g: ProcessedGarment): HTMLCanvasElement {
  const { width, height, mask, centerX, bodyWidth, bbox, textureCanvas } = g;
  const P = Math.max(8, Math.round(bodyWidth * 0.18));
  const step = Math.max(2, Math.round(P / 3));
  const x0 = Math.max(0, Math.round(centerX - bodyWidth / 2));
  const x1 = Math.min(width - P, Math.round(centerX + bodyWidth / 2) - P);
  const px = textureCanvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, width, height).data;
  const base = hexToRgb(g.baseColor);
  let best: { x: number; y: number; score: number } | null = null;
  for (let y = bbox.minY; y + P <= bbox.maxY; y += step) {
    for (let x = x0; x <= x1; x += step) {
      let off = 0, inside = true;
      for (let yy = y; yy < y + P && inside; yy += 2) {
        for (let xx = x; xx < x + P; xx += 2) {
          const i = yy * width + xx;
          if (!mask[i]) {
            inside = false;
            break;
          }
          const d = Math.hypot(px[i * 4] - base[0], px[i * 4 + 1] - base[1], px[i * 4 + 2] - base[2]);
          if (d > 40) off++;
        }
      }
      if (inside && (!best || off < best.score)) best = { x, y, score: off };
    }
  }
  const out = document.createElement("canvas");
  out.width = out.height = P * 2;
  const ctx = out.getContext("2d")!;
  if (!best) {
    ctx.fillStyle = g.baseColor;
    ctx.fillRect(0, 0, P * 2, P * 2);
    return out;
  }
  const patch = flattenShading(textureCanvas, best.x, best.y, P);
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    ctx.save();
    ctx.translate(sx < 0 ? P * 2 : 0, sy < 0 ? P * 2 : 0);
    ctx.scale(sx, sy);
    ctx.drawImage(patch, 0, 0);
    ctx.restore();
  }
  return out;
}

/**
 * Tira a luz/sombra de baixa frequência do quadrado (fica só a trama do tecido na
 * cor média): sem isso, um lado mais claro vira losangos ao espelhar e repetir.
 */
function flattenShading(src: HTMLCanvasElement, x: number, y: number, P: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = out.height = P;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, x, y, P, P, 0, 0, P, P);
  const px = ctx.getImageData(0, 0, P, P);
  // Versão borrada: reduz a 8×8 e amplia de volta, suavizado (some o degradê e a
  // mancha média do desbotado; a trama fina fica).
  const small = document.createElement("canvas");
  small.width = small.height = 8;
  small.getContext("2d")!.drawImage(out, 0, 0, 8, 8);
  const blur = document.createElement("canvas");
  blur.width = blur.height = P;
  const bctx = blur.getContext("2d", { willReadFrequently: true })!;
  bctx.imageSmoothingQuality = "high";
  bctx.drawImage(small, 0, 0, P, P);
  const low = bctx.getImageData(0, 0, P, P).data;
  const mean = [0, 0, 0];
  for (let i = 0; i < P * P; i++) for (let c = 0; c < 3; c++) mean[c] += px.data[i * 4 + c] / (P * P);
  for (let i = 0; i < P * P; i++) {
    for (let c = 0; c < 3; c++) px.data[i * 4 + c] = px.data[i * 4 + c] - low[i * 4 + c] + mean[c];
  }
  ctx.putImageData(px, 0, 0);
  return out;
}

/**
 * Imagem do tamanho da foto coberta pelo tecido repetido (na escala da foto).
 * withPhoto: a peça da foto por cima, só onde a máscara é roupa. Serve para as
 * peças com UV na foto: o que cai fora da silhueta (laterais da calça, vão entre
 * as pernas) ou o lado de trás da peça montada continua sendo tecido, não cor lisa.
 */
export function fabricFill(g: ProcessedGarment, fabric: HTMLCanvasElement, withPhoto: boolean): HTMLCanvasElement {
  const { width, height, mask, textureCanvas } = g;
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = ctx.createPattern(fabric, "repeat")!;
  ctx.fillRect(0, 0, width, height);
  if (!withPhoto) return out;
  const dst = ctx.getImageData(0, 0, width, height);
  const src = textureCanvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, width, height).data;
  for (let i = 0; i < width * height; i++) {
    if (!mask[i]) continue;
    dst.data[i * 4] = src[i * 4];
    dst.data[i * 4 + 1] = src[i * 4 + 1];
    dst.data[i * 4 + 2] = src[i * 4 + 2];
  }
  ctx.putImageData(dst, 0, 0);
  return out;
}

/**
 * Textura final: o tecido da foto repetido na peça inteira (na mesma escala da
 * estampa), a estampa esticada do tronco da foto até o painel e, por cima, a
 * oclusão do modelo (multiplicada) para as dobras e axilas continuarem sombreadas.
 */
export function composeShirtTexture(opts: {
  ao: CanvasImageSource | null;
  fabric: HTMLCanvasElement;
  print: HTMLCanvasElement;
  printPanel: Panel;
}) {
  const S = TEXTURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const [px0, py0, px1, py1] = opts.printPanel;
  // Pixels do atlas por pixel da foto: o mesmo fator com que a estampa é esticada.
  const scale = ((px1 - px0) * S) / opts.print.width;
  const pattern = ctx.createPattern(opts.fabric, "repeat")!;
  pattern.setTransform(new DOMMatrix().scale(scale));
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, S, S);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(opts.print, px0 * S, py0 * S, (px1 - px0) * S, (py1 - py0) * S);
  if (opts.ao) {
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(opts.ao, 0, 0, S, S);
    ctx.globalCompositeOperation = "source-over";
  }
  const tex = new THREE.CanvasTexture(canvas);
  // Mesma convenção das texturas do glTF (sem inverter o eixo y).
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
