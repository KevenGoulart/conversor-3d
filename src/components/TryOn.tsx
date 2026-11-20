"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { autoTolerance, loadImage, processImage, type GarmentLayer, type GarmentMode, type ProcessedGarment } from "@/lib/garment";
import {
  CLOTH_COLORS,
  DEFAULT_CHARACTER,
  HAIR_COLORS,
  RANGES,
  SKIN_TONES,
  type CharacterConfig,
} from "@/lib/character";
import type { AssetKind, ModelInfo, MorphSlider } from "@/lib/rig";
import type { CameraFocus } from "./Scene";

/** Coloque aqui o personagem exportado do Blender (ver docs/modelo-realista.md). */
const MODEL_URL = "/models/personagem.glb";

const Scene = dynamic(() => import("./Scene"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-sky-900/60">Carregando personagem…</div>,
});

/**
 * Roupas que já testamos: entram prontas no guarda-roupa ao abrir o site.
 * Só a primeira de cada lugar já começa vestida.
 */
const PRESET_CLOTHES: { src: string; slot: Slot; photoIsBack?: boolean; mold?: GarmentMode; wear?: boolean; longSleeves?: boolean }[] = [
  { src: "/roupas/camiseta-shura.webp", slot: "cima", photoIsBack: true, mold: "estampa", wear: true },
  { src: "/roupas/vestido-alcas.webp", slot: "cima" },
  { src: "/roupas/blusa-laranja.jpg", slot: "cima" },
  // Mangas / pernas compridas da foto não encaixam bem como peça nova: só estampam a peça pronta.
  { src: "/roupas/sueter-gola-alta.jpg", slot: "cima", mold: "estampa", longSleeves: true },
  { src: "/roupas/shorts-couro.jpg", slot: "baixo" },
  { src: "/roupas/saia-jeans.jpg", slot: "baixo" },
  { src: "/roupas/calca-jeans.jpg", slot: "baixo", mold: "estampa" },
];

/** Fotos do Wikimedia Commons: a licença (CC BY-SA) exige o crédito no site. */
const CLOTHES_CREDITS = [
  { work: "Jersei-coll-alt", url: "https://commons.wikimedia.org/wiki/File:Jersei-coll-alt.jpg", author: "Joan Rocaguinard", license: "CC BY-SA 3.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/" },
  { work: "Microskirt2", url: "https://commons.wikimedia.org/wiki/File:Microskirt2.jpg", author: "Safedom", license: "CC BY-SA 3.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/" },
  { work: "Denimjeans2", url: "https://commons.wikimedia.org/wiki/File:Denimjeans2.JPG", author: "Manda.L.Isch", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/" },
];

type Category = "corpo" | "cabelo" | "roupas";
type ClothTab = "cima" | "baixo" | "sapatos";
type Slot = "cima" | "baixo";

type WardrobeItem = {
  id: string;
  /** Onde a peça é vestida. */
  slot: Slot;
  src: string;
  garment: ProcessedGarment | null;
  error: string | null;
  photoIsBack: boolean;
  ease: number;
  offsetY: number;
  seamRadius: number;
  /** "estampa" = só estampa uma peça pronta do modelo; "modelo" = peça nova montada da silhueta da foto. */
  mold: GarmentMode;
  /** Veste a versão de manga comprida da camiseta pronta (suéter). */
  longSleeves: boolean;
};

const TAU = Math.PI * 2;

export default function TryOn() {
  const [character, setCharacter] = useState<CharacterConfig>(DEFAULT_CHARACTER);
  const [category, setCategory] = useState<Category>("roupas");
  const [clothTab, setClothTab] = useState<ClothTab>("cima");
  const [rotation, setRotation] = useState(0);
  const [autoRotate, setAutoRotate] = useState(false);

  // Modelo realista: nada é exibido até ele terminar de carregar.
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const realistic = modelInfo !== null;
  // A aba Sapatos só aparece se o modelo tiver algum calçado.
  const clothTabs = CLOTH_TABS.filter(([id]) => id !== "sapatos" || !!modelInfo?.assets.sapato.length);
  const setMorph = (id: string, value: number) => setCharacter((c) => ({ ...c, morphs: { ...c.morphs, [id]: value } }));
  const setAsset = (kind: AssetKind, id: string | null) => setCharacter((c) => ({ ...c, assets: { ...c.assets, [kind]: id } }));
  const assetValue = (kind: AssetKind) => {
    const id = character.assets[kind];
    const list = modelInfo?.assets[kind] ?? [];
    // undefined (ou um id que o modelo não tem) = primeira opção; null = nenhuma.
    if (id === null) return null;
    return id !== undefined && list.some((a) => a.id === id) ? id : (list[0]?.id ?? null);
  };

  /** A peça escolhida aceita troca de cor? */
  const assetTintable = (kind: AssetKind) => {
    const id = assetValue(kind);
    return !!id && !!modelInfo?.assets[kind].find((a) => a.id === id)?.tintable;
  };

  const [items, setItems] = useState<WardrobeItem[]>([]);
  // Uma peça da foto vestida em cima e outra embaixo.
  const [selectedIds, setSelectedIds] = useState<Record<Slot, string | null>>({ cima: null, baixo: null });
  /** Lugar do corpo em edição. */
  const activeSlot: Slot = clothTab === "baixo" ? "baixo" : "cima";
  const findItem = (id: string | null) => items.find((i) => i.id === id) ?? null;
  const topItem = findItem(selectedIds.cima);
  const bottomItem = findItem(selectedIds.baixo);
  const selected = activeSlot === "cima" ? topItem : bottomItem;
  const select = (slot: Slot, id: string | null) => setSelectedIds((s) => ({ ...s, [slot]: id }));
  const set = <K extends keyof CharacterConfig>(k: K, value: CharacterConfig[K]) =>
    setCharacter((c) => ({ ...c, [k]: value }));

  /** Gira o personagem até o lado da estampa, pelo caminho mais curto. */
  const faceSide = useCallback((back: boolean) => {
    setRotation((r) => {
      const base = Math.round(r / TAU) * TAU;
      const goal = base + (back ? Math.PI : 0);
      return Math.abs(goal - r) > Math.PI ? goal - Math.sign(goal - r) * TAU : goal;
    });
  }, []);

  const addItem = useCallback(async (src: string, slot: Slot, photoIsBack = false, forcedMold?: GarmentMode, wear = true) => {
    const id = Math.random().toString(36).slice(2);
    const base: WardrobeItem = {
      id,
      slot,
      src,
      garment: null,
      error: null,
      photoIsBack,
      ease: slot === "cima" ? 1.2 : 1.08,
      offsetY: 0,
      seamRadius: slot === "cima" ? 0.06 : 0.04,
      // Parte de baixo: em geral a foto é o formato da peça (bermuda, saia…).
      mold: forcedMold ?? (slot === "cima" ? "estampa" : "modelo"),
      longSleeves: !!PRESET_CLOTHES.find((p) => p.src === src)?.longSleeves,
    };
    try {
      const img = await loadImage(src);
      // Remoção do fundo com a tolerância escolhida automaticamente para esta foto.
      base.garment = processImage(img, autoTolerance(img));
      // Peça de cima bem mais comprida que uma camiseta (vestido, túnica): modelo novo.
      if (slot === "cima" && !forcedMold && looksLikeDress(base.garment)) base.mold = "modelo";
    } catch (e) {
      base.error = e instanceof Error ? e.message : "Não foi possível abrir a imagem.";
    }
    setItems((list) => [...list, base]);
    if (wear) setSelectedIds((s) => ({ ...s, [slot]: id }));
  }, []);

  // Roupas prontas no primeiro carregamento (uma por vez, para manter a ordem da lista).
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    void (async () => {
      for (const p of PRESET_CLOTHES) await addItem(p.src, p.slot, p.photoIsBack, p.mold, !!p.wear);
    })();
  }, [addItem]);

  // O item só muda de objeto quando é editado: a peça 3D não é remontada à toa.
  const topLayer = useMemo(() => toLayer(topItem), [topItem]);
  const bottomLayer = useMemo(() => toLayer(bottomItem), [bottomItem]);

  const focus: CameraFocus =
    category === "cabelo"
      ? "cabeca"
      : category === "roupas"
        ? clothTab === "cima"
          ? "tronco"
          : clothTab === "baixo"
            ? "pernas"
            : "pes"
        : "corpo";

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-[radial-gradient(ellipse_at_50%_35%,#f2faff_0%,#cfe8f7_45%,#8ec6e8_100%)] text-slate-800 lg:block">
      {/* Personagem */}
      <main className="relative h-[52dvh] shrink-0 lg:absolute lg:inset-0 lg:h-auto">
        <Scene
          character={character}
          top={topLayer}
          bottom={bottomLayer}
          focus={focus}
          rotation={rotation}
          autoRotate={autoRotate}
          modelUrl={MODEL_URL}
          onModelInfo={setModelInfo}
          onModelError={setModelError}
        />

        {!realistic && (
          <p className="pointer-events-none absolute left-1/2 top-1/2 max-w-md -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/70 px-4 py-1.5 text-center text-xs text-sky-900/80 shadow-sm backdrop-blur">
            {modelError
              ? `Não deu para abrir o modelo do personagem (${modelError}). Verifique public${MODEL_URL}.`
              : "Carregando personagem…"}
          </p>
        )}

        {/* Giro */}
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 lg:bottom-6">
          <RoundButton label="Girar para a esquerda" onClick={() => setRotation((r) => r - Math.PI / 4)}>
            <path d="M15 6l-6 6 6 6" />
          </RoundButton>
          <button
            onClick={() => setAutoRotate((v) => !v)}
            className={`rounded-full px-4 py-2 text-xs font-semibold shadow-md transition ${
              autoRotate ? "bg-sky-500 text-white" : "bg-white/90 text-sky-800 hover:bg-white"
            }`}
          >
            {autoRotate ? "Parar giro" : "Girar sozinho"}
          </button>
          <RoundButton label="Girar para a direita" onClick={() => setRotation((r) => r + Math.PI / 4)}>
            <path d="M9 6l6 6-6 6" />
          </RoundButton>
        </div>

        {/* Créditos do modelo base e das fotos de roupa (exigidos pelas licenças CC BY / CC BY-SA) */}
        <div className="pointer-events-auto absolute bottom-14 right-3 flex max-w-[16rem] flex-col gap-0.5 text-right text-[10px] leading-snug text-sky-900/60 lg:bottom-3 lg:max-w-none">
          <p>
            &quot;
            <a href="https://skfb.ly/pJYJQ" target="_blank" rel="noopener noreferrer" className="underline hover:text-sky-900">
              Base Female - Game Ready - Rigged - Low Poly
            </a>
            &quot; by arte_art is licensed under{" "}
            <a
              href="http://creativecommons.org/licenses/by/4.0/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-sky-900"
            >
              Creative Commons Attribution
            </a>
            .
          </p>
          <p>
            Fotos de roupa (Wikimedia Commons):{" "}
            {CLOTHES_CREDITS.map((c, i) => (
              <span key={c.url}>
                {i > 0 && " · "}
                <a href={c.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-sky-900">
                  {c.work}
                </a>{" "}
                by {c.author},{" "}
                <a href={c.licenseUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-sky-900">
                  {c.license}
                </a>
              </span>
            ))}
          </p>
        </div>
      </main>

      {/* Categorias + painel */}
      <aside className="z-10 flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3 lg:absolute lg:bottom-6 lg:left-4 lg:top-6 lg:w-[400px] lg:flex-row lg:p-0">
        <nav className="flex shrink-0 justify-center gap-2 lg:flex-col lg:justify-start">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              title={c.label}
              aria-label={c.label}
              className={`grid size-12 cursor-pointer place-items-center rounded-full border-2 shadow-md transition ${
                category === c.id
                  ? "scale-110 border-white bg-sky-500 text-white"
                  : "border-white/70 bg-white/85 text-sky-700 hover:bg-white"
              }`}
            >
              <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                {c.icon}
              </svg>
            </button>
          ))}
        </nav>

        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl border-2 border-white bg-white/85 shadow-xl backdrop-blur">
          <h2 className="border-b border-sky-100 px-5 pb-2 pt-4 text-lg font-bold text-sky-900">
            {CATEGORIES.find((c) => c.id === category)?.label}
          </h2>
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {category === "corpo" && (
              <div className="flex flex-col gap-5">
                <Group title="Tom de pele">
                  <Swatches colors={SKIN_TONES} value={character.skin} onChange={(v) => set("skin", v)} />
                </Group>
                <BodySlider label="Altura" left="Baixo" right="Alto" range={RANGES.height} value={character.height} onChange={(v) => set("height", v)} />
                {realistic &&
                  (modelInfo.sliders.some((s) => s.group === "corpo") ? (
                    <MorphSliders sliders={modelInfo.sliders.filter((s) => s.group === "corpo")} values={character.morphs} onChange={setMorph} />
                  ) : (
                    <BodySlider label="Peso" left="Magro" right="Pesado" range={RANGES.weight} value={character.weight} onChange={(v) => set("weight", v)} />
                  ))}
                <p className="text-xs text-slate-500">Altura: {Math.round(180 * character.height)} cm</p>
              </div>
            )}

            {category === "cabelo" && (
              <div className="flex flex-col gap-5">
                <Group title="Estilo">
                  {realistic ? (
                    <AssetTiles kind="cabelo" none="Careca" info={modelInfo} value={assetValue("cabelo")} onChange={setAsset} />
                  ) : (
                    <Loading />
                  )}
                </Group>
                <Group title="Cor">
                  <Swatches colors={HAIR_COLORS} value={character.hairColor} onChange={(v) => set("hairColor", v)} />
                </Group>
              </div>
            )}

            {category === "roupas" && (
              <div className="flex flex-col gap-5">
                <div
                  className={`grid gap-1 rounded-full bg-sky-100 p-1 text-sm font-semibold ${clothTabs.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}
                >
                  {clothTabs.map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => setClothTab(id)}
                      className={`rounded-full py-1.5 transition ${clothTab === id ? "bg-white text-sky-700 shadow" : "text-sky-700/70"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {(clothTab === "cima" || clothTab === "baixo") && (
                  <Wardrobe
                    items={items.filter((i) => i.slot === activeSlot)}
                    selected={selected}
                    onSelect={(item) => {
                      select(activeSlot, item.id);
                      faceSide(item.photoIsBack);
                    }}
                  />
                )}

                {clothTab === "baixo" && realistic && bottomItem?.mold !== "modelo" && (
                  <>
                    <Group title={bottomItem ? "Peça que recebe a estampa" : "Peça do modelo"}>
                      <AssetTiles kind="baixo" none="Nenhum" info={modelInfo} value={assetValue("baixo")} onChange={setAsset} />
                    </Group>
                    {bottomItem && !assetValue("baixo") && (
                      <p className="-mt-3 text-xs text-amber-600">Escolha uma peça acima para a estampa aparecer.</p>
                    )}
                    {!bottomItem && assetTintable("baixo") && (
                      <Group title="Cor">
                        <Swatches colors={CLOTH_COLORS} value={character.bottomColor} onChange={(v) => set("bottomColor", v)} custom />
                      </Group>
                    )}
                  </>
                )}

                {clothTab === "sapatos" && realistic && (
                  <>
                    <Group title="Calçado">
                      <AssetTiles kind="sapato" none="Descalço" info={modelInfo} value={assetValue("sapato")} onChange={setAsset} />
                    </Group>
                    {assetTintable("sapato") && (
                      <Group title="Cor">
                        <Swatches colors={CLOTH_COLORS} value={character.shoeColor} onChange={(v) => set("shoeColor", v)} custom />
                      </Group>
                    )}
                  </>
                )}

                {clothTab !== "cima" && !realistic && <Loading />}
              </div>
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}

/* --------------------------------- Peças --------------------------------- */

function toLayer(item: WardrobeItem | null): GarmentLayer | null {
  if (!item?.garment) return null;
  return {
    garment: item.garment,
    fit: { ease: item.ease, offsetY: item.offsetY, seamRadius: item.seamRadius },
    photoIsBack: item.photoIsBack,
    mode: item.mold,
    longSleeves: item.longSleeves,
  };
}

/**
 * A camiseta pronta não serve? Peça bem mais comprida que larga (vestido) ou
 * com mangas que descem até perto da barra (manga longa, bufante): nas linhas
 * de baixo a silhueta se divide em três (manga, corpo, manga).
 */
function looksLikeDress(g: ProcessedGarment) {
  // Acinturada ou sem manga: a camiseta pronta não tem esse formato.
  if (g.waist || g.armpitY !== null) return true;
  if ((g.bbox.maxY - g.collarY) / Math.max(1, g.bodyWidth) > 1.7) return true;
  const { mask, width, bbox } = g;
  const h = bbox.maxY - bbox.minY;
  const bw = bbox.maxX - bbox.minX + 1;
  let split = 0, wide = 0, total = 0;
  for (let t = 0.7; t <= 0.9; t += 0.02) {
    const y = Math.round(bbox.minY + h * t);
    let runs = 0, prev = 0, l = -1, r = -1;
    for (let x = bbox.minX; x <= bbox.maxX; x++) {
      const v = mask[y * width + x];
      if (v && !prev) runs++;
      if (v) {
        if (l < 0) l = x;
        r = x;
      }
      prev = v;
    }
    total++;
    if (runs >= 3) split++;
    // Camiseta aberta: perto da barra só há o corpo (~60% da largura com as mangas).
    if (l >= 0 && (r - l + 1) / bw > 0.8) wide++;
  }
  return split > total / 2 || wide > total / 2;
}

function Wardrobe({
  items,
  selected,
  onSelect,
}: {
  items: WardrobeItem[];
  selected: WardrobeItem | null;
  onSelect: (item: WardrobeItem) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((item) => (
        <button
          key={item.id}
          onClick={() => onSelect(item)}
          className={`relative aspect-square overflow-hidden rounded-2xl border-2 bg-sky-50 p-1 transition ${
            selected?.id === item.id ? "border-sky-500 ring-2 ring-sky-200" : "border-transparent hover:border-sky-200"
          }`}
        >
          {item.garment ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.garment.cutoutUrl} alt="Peça" className="size-full object-contain" />
          ) : (
            <span className="text-xs text-red-500">Erro</span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------- Componentes ------------------------------- */

const CATEGORIES: { id: Category; label: string; icon: React.ReactNode }[] = [
  {
    id: "corpo",
    label: "Corpo",
    icon: (
      <>
        <circle cx="12" cy="4.5" r="2" />
        <path d="M6 9h12M12 9v6m0 0l-3 6m3-6l3 6" />
      </>
    ),
  },
  {
    id: "cabelo",
    label: "Cabelo",
    icon: <path d="M5 14c0-6 3-10 7-10s7 4 7 10M5 14c0 3 1 6 2 7M19 14c0 3-1 6-2 7M8 9c2 2 6 2 9 0" />,
  },
  {
    id: "roupas",
    label: "Roupas",
    icon: <path d="M8 4l-5 3 2 4 2-1v10h10V10l2 1 2-4-5-3c-.5 1.5-2 2.5-4 2.5S8.5 5.5 8 4z" />,
  },
];

const CLOTH_TABS: [ClothTab, string][] = [
  ["cima", "Parte de cima"],
  ["baixo", "Parte de baixo"],
  ["sapatos", "Sapatos"],
];

function RoundButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid place-items-center rounded-full border-2 border-white bg-white/90 text-sky-700 shadow-md transition hover:bg-white active:scale-95 size-9`}
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

function Loading() {
  return <p className="text-xs text-slate-500">Carregando personagem…</p>;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-bold uppercase tracking-wide text-sky-800/70">{title}</span>
      {children}
    </div>
  );
}

function Swatches({ colors, value, onChange, custom }: { colors: string[]; value: string; onChange: (v: string) => void; custom?: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      {colors.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          aria-label={c}
          style={{ background: c }}
          className={`size-9 rounded-full border-2 shadow-sm transition hover:scale-110 ${
            value.toLowerCase() === c.toLowerCase() ? "border-white ring-[3px] ring-sky-500" : "border-white"
          }`}
        />
      ))}
      {custom && (
        <label
          title="Outra cor"
          className="relative grid size-9 cursor-pointer place-items-center overflow-hidden rounded-full border-2 border-white bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)] shadow-sm"
        >
          <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 opacity-0" />
        </label>
      )}
    </div>
  );
}

function Tiles<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-2xl border-2 px-2 py-3 text-xs font-semibold transition ${
            value === o.id ? "border-sky-500 bg-sky-500 text-white shadow" : "border-sky-100 bg-white text-sky-800 hover:border-sky-300"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Rótulos das pontas dos sliders de morph conhecidos. */
const SLIDER_ENDS: Record<string, [string, string]> = {
  peso: ["Magro", "Pesado"],
  musculo: ["Pouco", "Muito"],
  idade: ["Jovem", "Velho"],
  feminino: ["Masculino", "Feminino"],
  masculino: ["Feminino", "Masculino"],
  rosto_queixo: ["Recuado", "Projetado"],
  rosto_mandibula: ["Estreita", "Larga"],
  rosto_nariz: ["Menor", "Maior"],
  rosto_bochechas: ["Magras", "Cheias"],
  rosto_cabeca: ["Menor", "Maior"],
};

function MorphSliders({
  sliders,
  values,
  onChange,
}: {
  sliders: MorphSlider[];
  values: Record<string, number>;
  onChange: (id: string, v: number) => void;
}) {
  return (
    <>
      {sliders.map((s) => (
        <BodySlider
          key={s.id}
          label={s.label}
          left={SLIDER_ENDS[s.id]?.[0] ?? (s.minus ? "Menos" : "Nada")}
          right={SLIDER_ENDS[s.id]?.[1] ?? "Mais"}
          range={s.minus ? [-1, 1] : [0, 1]}
          value={values[s.id] ?? 0}
          onChange={(v) => onChange(s.id, v)}
        />
      ))}
    </>
  );
}

function AssetTiles({
  kind,
  none,
  info,
  value,
  onChange,
}: {
  kind: AssetKind;
  none: string;
  info: ModelInfo;
  value: string | null;
  onChange: (kind: AssetKind, id: string | null) => void;
}) {
  const options = [{ id: "__none__", label: none }, ...info.assets[kind]];
  if (options.length === 1) {
    return <p className="text-xs text-slate-500">O modelo não tem objetos &quot;{kind}_…&quot;. Veja docs/modelo-realista.md.</p>;
  }
  return (
    <Tiles options={options} value={value ?? "__none__"} onChange={(id) => onChange(kind, id === "__none__" ? null : id)} />
  );
}

function BodySlider({
  label,
  left,
  right,
  range,
  value,
  onChange,
}: {
  label: string;
  left: string;
  right: string;
  range: readonly [number, number];
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <Group title={label}>
      <input
        type="range"
        min={range[0]}
        max={range[1]}
        step={0.005}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-sky-500"
      />
      <div className="-mt-1 flex justify-between text-[11px] text-slate-500">
        <span>{left}</span>
        <span>{right}</span>
      </div>
    </Group>
  );
}
