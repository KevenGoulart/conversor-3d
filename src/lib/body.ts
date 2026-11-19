/** Medidas do corpo usadas para vestir a roupa gerada da foto. */
export type BodyDims = {
  chestHalfWidth: number;
  chestHalfDepth: number;
  collarY: number;
  sleeveHalfThickness: number;
  shoulderX: number;
  shoulderY: number;
  armAngleDeg: number;
  /** Cintura do corpo (linha mais estreita do tronco): altura e meia largura. */
  waist?: { y: number; halfWidth: number };
  /** Centro do tronco no eixo frente-costas (0 no manequim simples). */
  centerZ?: number;
  /**
   * Braço (lado +x) medido pelos ossos: ombro em (shoulderX, shoulderY, z0) e
   * cotovelo em (x1, y1, z1), z relativo a centerZ; raio médio do braço.
   */
  arm?: { z0: number; x1: number; y1: number; z1: number; radius: number };
};

/** Medidas do manequim em metros (altura ~1,80 m). */
export const BODY = {
  /** Meia largura do peito. */
  chestHalfWidth: 0.175,
  /** Meia profundidade do peito (frente-costas). */
  chestHalfDepth: 0.11,
  /** Profundidade do tronco relativa à largura. */
  depthRatio: 0.63,
  /** Altura em que a gola da roupa é ancorada. */
  collarY: 1.535,
  /** Meia espessura mínima das mangas. */
  sleeveHalfThickness: 0.068,
  /** Articulação do ombro (lado direito). */
  shoulderX: 0.17,
  shoulderY: 1.43,
  /** Ângulo dos braços abaixo da horizontal (90 = colado ao corpo). */
  armAngleDeg: 74,
} satisfies BodyDims & { depthRatio: number };

/** Perfil do tronco (raio, altura) girado em torno do eixo Y. */
export const TORSO_PROFILE: [number, number][] = [
  [0.0, 0.86],
  [0.1, 0.875],
  [0.155, 0.91],
  [0.175, 0.97],
  [0.168, 1.04],
  [0.145, 1.11],
  [0.148, 1.18],
  [0.165, 1.26],
  [0.175, 1.33],
  [0.178, 1.39],
  [0.165, 1.44],
  [0.125, 1.485],
  [0.07, 1.515],
  [0.052, 1.53],
  [0.0, 1.535],
];
