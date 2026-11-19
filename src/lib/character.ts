import type { PoseId } from "./poses";

/** Configuração visual do personagem (tudo que não depende da foto da roupa). */
export type HairStyle = "careca" | "curto" | "chanel" | "longo" | "coque" | "rabo" | "afro";
export type BottomStyle = "nenhum" | "calca" | "bermuda" | "saia";
export type ShoeStyle = "descalco" | "tenis" | "bota";

export type CharacterConfig = {
  skin: string;
  hairStyle: HairStyle;
  hairColor: string;
  eyeColor: string;
  /** Escala de altura (1 = 1,80 m). */
  height: number;
  /** Largura/profundidade do corpo todo. */
  weight: number;
  /** Espessura dos braços. */
  muscle: number;
  /** Espessura das pernas. */
  legs: number;
  /** Tamanho da cabeça. */
  head: number;
  bottom: BottomStyle;
  bottomColor: string;
  shoes: ShoeStyle;
  shoeColor: string;
  /** Modelo realista: valor de cada slider de morph (id → -1..1 ou 0..1). */
  morphs: Record<string, number>;
  /** Modelo realista: acessório escolhido por tipo (undefined = primeiro, null = nenhum). */
  assets: Partial<Record<"cabelo" | "baixo" | "sapato", string | null>>;
  /** Pose por cima da animação de parado. */
  pose: PoseId;
};

export const SKIN_TONES = [
  "#fbe3d1", "#f3cfb3", "#e8b896", "#d9a07a", "#c68863",
  "#a96e4b", "#8d5638", "#6f4129", "#55301d", "#3d2215",
];

export const HAIR_COLORS = [
  "#0f0c0a", "#2b1d14", "#4a2f1d", "#6e4a2e", "#9a6b3f",
  "#c79a5b", "#e6c88f", "#b8452a", "#8a8a8a", "#e9e6e1",
  "#3657c9", "#d14f9b",
];

export const EYE_COLORS = ["#3b2414", "#6b4423", "#8a6d3b", "#4f7a3a", "#3f7f9e", "#6c8fb8", "#7a7f86", "#1d1d1d"];

export const CLOTH_COLORS = [
  "#1f2937", "#f5f5f4", "#2f4f8f", "#5a7fb5", "#7a5536", "#c8b28e",
  "#3f6b46", "#9b2c2c", "#e2a03f", "#6b4a8a", "#d77a99", "#111111",
];

export const HAIR_STYLES: { id: HairStyle; label: string }[] = [
  { id: "careca", label: "Careca" },
  { id: "curto", label: "Curto" },
  { id: "chanel", label: "Chanel" },
  { id: "longo", label: "Longo" },
  { id: "coque", label: "Coque" },
  { id: "rabo", label: "Rabo de cavalo" },
  { id: "afro", label: "Black power" },
];

export const BOTTOM_STYLES: { id: BottomStyle; label: string }[] = [
  { id: "nenhum", label: "Nenhum" },
  { id: "calca", label: "Calça" },
  { id: "bermuda", label: "Bermuda" },
  { id: "saia", label: "Saia" },
];

export const SHOE_STYLES: { id: ShoeStyle; label: string }[] = [
  { id: "descalco", label: "Descalço" },
  { id: "tenis", label: "Tênis" },
  { id: "bota", label: "Bota" },
];

/** Padrão: mulher branca e loira (cores padrão do personagem). */
export const DEFAULT_CHARACTER: CharacterConfig = {
  skin: SKIN_TONES[1],
  hairStyle: "coque",
  hairColor: HAIR_COLORS[6],
  eyeColor: EYE_COLORS[4],
  height: 1,
  weight: 1,
  muscle: 1,
  legs: 1,
  head: 1,
  bottom: "calca",
  bottomColor: CLOTH_COLORS[2],
  shoes: "tenis",
  shoeColor: CLOTH_COLORS[1],
  morphs: {},
  // Ids dos objetos no .glb; se o modelo não tiver, cai na primeira opção.
  assets: { cabelo: "cabelo_coque", baixo: "baixo_jeans-skinny" },
  pose: "parado",
};

export const RANGES = {
  height: [0.9, 1.1],
  weight: [0.85, 1.3],
  muscle: [0.85, 1.4],
  legs: [0.85, 1.3],
  head: [0.88, 1.15],
} as const;

const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
const between = ([a, b]: readonly [number, number]) => a + Math.random() * (b - a);

export function randomCharacter(): CharacterConfig {
  return {
    skin: pick(SKIN_TONES),
    hairStyle: pick(HAIR_STYLES).id,
    hairColor: pick(HAIR_COLORS.slice(0, 10)),
    eyeColor: pick(EYE_COLORS),
    height: between(RANGES.height),
    weight: between([0.9, 1.2]),
    muscle: between([0.9, 1.25]),
    legs: between([0.9, 1.2]),
    head: between([0.94, 1.08]),
    bottom: pick(BOTTOM_STYLES.slice(1)).id,
    bottomColor: pick(CLOTH_COLORS),
    shoes: pick(SHOE_STYLES.slice(1)).id,
    shoeColor: pick(CLOTH_COLORS),
    morphs: {},
    assets: {},
    pose: "parado",
  };
}
