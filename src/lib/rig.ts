import * as THREE from "three";
import { BODY, type BodyDims } from "./body";

/**
 * Convenção de nomes dos objetos no .glb (definida no Blender):
 *   corpo            → malha do corpo (com shape keys e armature)
 *   cabelo_<nome>    → opções de cabelo
 *   baixo_<nome>     → calças, saias, bermudas
 *   sapato_<nome>    → calçados
 *   cima_<nome>      → camiseta pronta, pintada e estampada a partir da foto
 *                      (cima_manga_longa = a versão de manga comprida, opcional)
 *   sobrancelha*     → pinta com a cor do cabelo
 *   iris*            → pinta com a cor dos olhos
 * Shape keys: "<nome>" vira um slider 0..1; o par "<nome>_mais"/"<nome>_menos"
 * vira um slider -1..1. Prefixo "rosto_" manda o slider para a aba Rosto.
 */
export type AssetKind = "cabelo" | "baixo" | "sapato";
export const ASSET_KINDS: AssetKind[] = ["cabelo", "baixo", "sapato"];

export type MorphSlider = {
  id: string;
  label: string;
  group: "corpo" | "rosto";
  plus: string;
  minus?: string;
};

export type ModelInfo = {
  sliders: MorphSlider[];
  /** tintable = o app pode recolorir (false para peças com cores próprias na textura). */
  assets: Record<AssetKind, { id: string; label: string; tintable: boolean }[]>;
  hasAnimation: boolean;
  hasIris: boolean;
  /** O modelo traz uma camiseta pronta (cima_*) para vestir com a foto. */
  hasShirt: boolean;
};

export type AnalyzedModel = {
  info: ModelInfo;
  body: THREE.SkinnedMesh | THREE.Mesh;
  /** Todas as malhas do corpo (o corpo pode vir dividido por material). */
  bodyMeshes: THREE.Mesh[];
  assetObjects: Record<AssetKind, Map<string, THREE.Object3D>>;
  brows: THREE.Mesh[];
  irises: THREE.Mesh[];
  lashes: THREE.Mesh[];
  /** Camiseta pronta (escondida até haver uma foto de roupa). */
  shirt: THREE.Object3D | null;
  /** Versão de manga comprida da camiseta pronta (suéter, blusa de manga longa). */
  longShirt: THREE.Object3D | null;
  /** Malhas com morphs (corpo + acessórios que receberam morphs). */
  morphMeshes: THREE.Mesh[];
};

const ASSET_RE = /^(cabelo|baixo|sapato)_(.+)$/i;
const HEIGHT = 1.8;

function meshesUnder(o: THREE.Object3D) {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh);
  });
  return out;
}

const vertexCount = (m: THREE.Mesh) => m.geometry.getAttribute("position")?.count ?? 0;

/* -------------------------------------------------------------------------- */
/*                        Preparação única (cacheada)                         */
/* -------------------------------------------------------------------------- */

/** Grava a pose de descanso dos ossos para poder voltar a ela depois. */
function recordRest(scene: THREE.Object3D) {
  if (scene.userData.rest) return;
  const rest: [THREE.Object3D, THREE.Vector3, THREE.Quaternion, THREE.Vector3][] = [];
  scene.traverse((o) => {
    if ((o as THREE.Bone).isBone) rest.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]);
  });
  scene.userData.rest = rest;
}

export function restorePose(scene: THREE.Object3D) {
  for (const [o, p, q, s] of (scene.userData.rest ?? []) as [THREE.Object3D, THREE.Vector3, THREE.Quaternion, THREE.Vector3][]) {
    o.position.copy(p);
    o.quaternion.copy(q);
    o.scale.copy(s);
  }
  scene.updateMatrixWorld(true);
}

/* -------------------------------------------------------------------------- */
/*                 Ajuste de pose (braços mais junto ao corpo)                 */
/* -------------------------------------------------------------------------- */

/**
 * Rotações extras, em graus, em torno dos eixos da cena (X = direita do
 * personagem, Y = cima, Z = frente), para o lado esquerdo (+X). O lado direito
 * é espelhado. Aplicadas por cima da pose de descanso / animação.
 */
const POSE_OFFSETS: { bone: RegExp; deg: [number, number, number] }[] = [
  { bone: /^upperarm_l$/i, deg: [0, 0, -16] },
  { bone: /^hand_l$/i, deg: [0, 0, 12] },
];

export type PoseBone = { bone: THREE.Bone; rest: THREE.Quaternion; world: THREE.Quaternion };

/** Encontra os ossos a ajustar e pré-calcula a rotação (no espaço da cena). */
export function findPoseBones(scene: THREE.Object3D): PoseBone[] {
  const out: PoseBone[] = [];
  scene.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return;
    for (const { bone, deg } of POSE_OFFSETS) {
      const left = bone.test(o.name);
      const right = bone.test(o.name.replace(/_r$/i, "_l")) && /_r$/i.test(o.name);
      if (!left && !right) continue;
      const s = right ? -1 : 1;
      const [x, y, z] = deg.map((d) => THREE.MathUtils.degToRad(d));
      const world = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y * s, z * s, "XYZ"));
      out.push({ bone: o as THREE.Bone, rest: o.quaternion.clone(), world });
    }
  });
  // Pais antes dos filhos, para que cada um já veja o pai ajustado.
  const depth = (o: THREE.Object3D) => {
    let d = 0;
    for (let p = o.parent; p; p = p.parent) d++;
    return d;
  };
  return out.sort((a, b) => depth(a.bone) - depth(b.bone));
}

/** Volta os ossos ajustados para o descanso (a animação sobrescreve os dela). */
export function resetPoseBones(bones: PoseBone[]) {
  for (const b of bones) b.bone.quaternion.copy(b.rest);
}

const _pq = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Aplica as rotações extras: local = pai⁻¹ · R_cena · pai · local. */
export function applyPoseBones(bones: PoseBone[], scene: THREE.Object3D) {
  for (const { bone, world } of bones) {
    if (!bone.parent) continue;
    matrixToSceneSpace(bone.parent, scene).decompose(_v, _pq, _v);
    _q.copy(_pq).invert().multiply(world).multiply(_pq);
    bone.quaternion.premultiply(_q);
  }
}

/* -------------------------------------------------------------------------- */
/*          Pose de referência: vestir a roupa como o corpo aparece           */
/* -------------------------------------------------------------------------- */

/**
 * Põe o esqueleto na pose em que o personagem é exibido: descanso + início da
 * animação de "parado" + ajustes de pose. A roupa é montada nessa pose e
 * depois levada de volta à pose de descanso com `unposeGeometry`, então na
 * tela ela fica exatamente como foi montada (sem amassar quando o braço desce).
 * Quem chama deve devolver o esqueleto com `restorePose` depois.
 */
export function setReferencePose(scene: THREE.Object3D, clip: THREE.AnimationClip | null, poseBones: PoseBone[]) {
  restorePose(scene);
  if (clip) {
    // Mixer temporário só para aplicar o quadro 0. Sem stop(): parar a ação
    // restauraria o estado original dos ossos.
    const m = new THREE.AnimationMixer(scene);
    m.clipAction(clip).play();
    m.setTime(0);
  }
  applyPoseBones(poseBones, scene);
  scene.updateWorldMatrix(true, true);
}

/** Cópia da malha com a geometria na pose atual do esqueleto (sem morphs). */
export function posedProxy(mesh: THREE.SkinnedMesh): THREE.SkinnedMesh {
  const src = mesh.geometry;
  const pos = src.getAttribute("position");
  const out = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    mesh.applyBoneTransform(i, v.fromBufferAttribute(pos, i));
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  for (const name of ["skinIndex", "skinWeight"]) {
    const a = src.getAttribute(name);
    if (a) geo.setAttribute(name, a);
  }
  if (src.index) geo.setIndex(src.index);
  geo.morphAttributes = src.morphAttributes;
  geo.morphTargetsRelative = src.morphTargetsRelative;
  geo.computeVertexNormals();
  const proxy = mesh.clone() as THREE.SkinnedMesh;
  proxy.geometry = geo;
  return proxy;
}

/**
 * Leva uma geometria montada na pose atual (espaço local da malha `skinned`,
 * já com skinIndex/skinWeight) para a pose de descanso, invertendo o skinning
 * de cada vértice: v_descanso = (Σ wₖ·Sₖ)⁻¹ · v_posado.
 */
export function unposeGeometry(geo: THREE.BufferGeometry, skinned: THREE.SkinnedMesh) {
  const { bones, boneInverses } = skinned.skeleton;
  const S = bones.map((b, k) =>
    new THREE.Matrix4()
      .copy(skinned.bindMatrixInverse)
      .multiply(b.matrixWorld)
      .multiply(boneInverses[k])
      .multiply(skinned.bindMatrix),
  );
  const pos = geo.getAttribute("position");
  const si = geo.getAttribute("skinIndex");
  const sw = geo.getAttribute("skinWeight");
  if (!si || !sw) return;
  const M = new THREE.Matrix4();
  const e = M.elements;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    e.fill(0);
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w <= 0) continue;
      const se = S[si.getComponent(i, k)].elements;
      for (let j = 0; j < 16; j++) e[j] += w * se[j];
      total += w;
    }
    if (total <= 0 || Math.abs(M.determinant()) < 1e-12) continue;
    v.fromBufferAttribute(pos, i).applyMatrix4(M.invert());
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

function findBody(scene: THREE.Object3D): THREE.Mesh[] {
  let named: THREE.Object3D | null = null;
  scene.traverse((o) => {
    if (!named && /^corpo/i.test(o.name)) named = o;
  });
  if (named) {
    const ms = meshesUnder(named);
    if (ms.length) return ms;
  }
  // Sem nome: a maior malha que não seja acessório.
  let best: THREE.Mesh | null = null;
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || hasAssetAncestor(m)) return;
    if (!best || vertexCount(m) > vertexCount(best)) best = m;
  });
  return best ? [best] : [];
}

function hasAssetAncestor(o: THREE.Object3D) {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (ASSET_RE.test(p.name) || /^(sobrancelha|iris|cima_)/i.test(p.name)) return true;
  return false;
}

/** Escala para 1,80 m, pés no chão e centralizado. Feito uma vez por cena. */
function normalize(scene: THREE.Object3D, bodyMeshes: THREE.Mesh[]) {
  if (scene.userData.normalized) return;
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const m of bodyMeshes) box.expandByObject(m);
  const h = box.max.y - box.min.y || 1;
  const s = HEIGHT / h;
  const c = box.getCenter(new THREE.Vector3());
  scene.scale.multiplyScalar(s);
  scene.position.set(-c.x * s, -box.min.y * s, -c.z * s);
  scene.updateMatrixWorld(true);
  scene.userData.normalized = true;
}

export function analyzeModel(scene: THREE.Object3D, animations: THREE.AnimationClip[]): AnalyzedModel {
  recordRest(scene);
  restorePose(scene);
  const bodyMeshes = findBody(scene);
  if (!bodyMeshes.length) throw new Error("Nenhuma malha de corpo encontrada no modelo.");
  normalize(scene, bodyMeshes);
  const body = bodyMeshes.reduce((a, b) => (vertexCount(b) > vertexCount(a) ? b : a));

  const assetObjects = { cabelo: new Map(), baixo: new Map(), sapato: new Map() } as AnalyzedModel["assetObjects"];
  const brows: THREE.Mesh[] = [];
  const irises: THREE.Mesh[] = [];
  const lashes: THREE.Mesh[] = [];
  let shirt: THREE.Object3D | null = null;
  let longShirt: THREE.Object3D | null = null;
  scene.traverse((o) => {
    if (!longShirt && /^cima_manga_longa/i.test(o.name)) longShirt = o;
    else if (!shirt && /^cima_/i.test(o.name)) shirt = o;
    const m = ASSET_RE.exec(o.name);
    if (m && !(o.parent && hasAssetAncestor(o.parent))) assetObjects[m[1].toLowerCase() as AssetKind].set(o.name, o);
    if (/^sobrancelha/i.test(o.name)) brows.push(...meshesUnder(o));
    if (/^iris/i.test(o.name)) irises.push(...meshesUnder(o));
    if (/^c[ií]lios/i.test(o.name)) lashes.push(...meshesUnder(o));
  });
  // Opção padrão (a primeira) de cada tipo: prefere as mais "neutras".
  const PREFERRED = /curto$|cal[cç]a|legging|t[eê]nis/i;
  for (const k of ASSET_KINDS) {
    const sorted = [...assetObjects[k]].sort(([a], [b]) => Number(PREFERRED.test(b)) - Number(PREFERRED.test(a)));
    assetObjects[k] = new Map(sorted);
  }
  for (const m of [...brows, ...irises]) m.material = (m.material as THREE.Material).clone();
  if (shirt) (shirt as THREE.Object3D).visible = false;
  if (longShirt) (longShirt as THREE.Object3D).visible = false;

  const sliders = buildSliders(body);

  // Acessórios sem os morphs do corpo recebem os morphs por proximidade,
  // para acompanhar o corpo quando os sliders mudam.
  const morphMeshes: THREE.Mesh[] = bodyMeshes.filter((m) => m.morphTargetDictionary);
  if (sliders.length) {
    // Todo o resto (acessórios, olhos, sobrancelhas…).
    const others = meshesUnder(scene).filter((m) => !bodyMeshes.includes(m));
    for (const m of others) {
      if (!m.userData.morphsTransferred && !m.morphTargetDictionary) {
        transferFromBody(m.geometry, body, { skin: false, morphs: true }, toBodySpace(m, body));
        m.updateMorphTargets();
        m.userData.morphsTransferred = true;
      }
      if (m.morphTargetDictionary) morphMeshes.push(m);
    }
  }

  const label = (name: string) => {
    const base = name.replace(ASSET_RE, "$2").replace(/[_-]+/g, " ").trim();
    return base.charAt(0).toUpperCase() + base.slice(1);
  };
  const assets = Object.fromEntries(
    ASSET_KINDS.map((k) => [
      k,
      [...assetObjects[k]].map(([id, obj]) => ({ id, label: label(id), tintable: isTintable(obj) })),
    ]),
  ) as ModelInfo["assets"];

  return {
    info: { sliders, assets, hasAnimation: animations.length > 0, hasIris: irises.length > 0, hasShirt: !!shirt },
    body,
    bodyMeshes,
    assetObjects,
    brows,
    irises,
    lashes,
    shirt,
    longShirt,
    morphMeshes,
  };
}

/** Objetos marcados com "sem_cor" no Blender mantêm as cores da textura. */
export function isTintable(o: THREE.Object3D) {
  let ok = true;
  o.traverse((x) => {
    if (x.userData?.sem_cor) ok = false;
  });
  return ok;
}

/** Shape key das pálpebras fechadas: animada pelo app, não vira slider. */
export const BLINK_MORPH = "piscar";

/** Aplica o piscar (0 = aberto, 1 = fechado) nas malhas que têm a shape key. */
export function applyBlink(meshes: THREE.Mesh[], value: number) {
  for (const m of meshes) {
    const i = m.morphTargetDictionary?.[BLINK_MORPH];
    if (i !== undefined && m.morphTargetInfluences) m.morphTargetInfluences[i] = value;
  }
}

function buildSliders(body: THREE.Mesh): MorphSlider[] {
  const names = Object.keys(body.morphTargetDictionary ?? {}).filter(
    (n) => !n.includes("$") && n.toLowerCase() !== "basis" && n !== BLINK_MORPH,
  );
  const set = new Set(names);
  const out: MorphSlider[] = [];
  for (const n of names) {
    let base = n;
    let minus: string | undefined;
    if (/_mais$/i.test(n)) {
      base = n.replace(/_mais$/i, "");
      const m = names.find((x) => x.toLowerCase() === `${base}_menos`.toLowerCase());
      if (m) minus = m;
    } else if (/_menos$/i.test(n) && set.has(n.replace(/_menos$/i, "_mais"))) {
      continue;
    }
    const rosto = /^rosto_/i.test(base);
    const text = base.replace(/^rosto_/i, "").replace(/[_-]+/g, " ");
    out.push({
      id: base,
      label: text.charAt(0).toUpperCase() + text.slice(1),
      group: rosto ? "rosto" : "corpo",
      plus: n,
      minus,
    });
  }
  return out;
}

/** Aplica os valores dos sliders em todas as malhas com morphs. */
export function applyMorphs(meshes: THREE.Mesh[], sliders: MorphSlider[], values: Record<string, number>) {
  for (const m of meshes) {
    const dict = m.morphTargetDictionary;
    const inf = m.morphTargetInfluences;
    if (!dict || !inf) continue;
    for (const s of sliders) {
      const v = values[s.id] ?? 0;
      const ip = dict[s.plus];
      if (ip !== undefined) inf[ip] = s.minus ? Math.max(0, v) : v;
      if (s.minus) {
        const im = dict[s.minus];
        if (im !== undefined) inf[im] = Math.max(0, -v);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                         Medidas para vestir a roupa                         */
/* -------------------------------------------------------------------------- */

const ARM_EXCLUDE = /upper_?arm|lower_?arm|fore_?arm|hand|finger|thumb|index|middle|ring|pinky|^(mixamorig:?)?(left|right)arm/i;

function findBone(bones: THREE.Bone[], patterns: RegExp[]) {
  for (const re of patterns) {
    const b = bones.find((x) => re.test(x.name));
    if (b) return b;
  }
  return null;
}

/**
 * Matriz do espaço local de `o` até o espaço em que `scene` está (o pai da
 * cena), usando só as matrizes locais — funciona antes da cena ser montada.
 */
export function matrixToSceneSpace(o: THREE.Object3D, scene: THREE.Object3D) {
  const m = new THREE.Matrix4();
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    p.updateMatrix();
    m.premultiply(p.matrix);
    if (p === scene) break;
  }
  return m;
}

/**
 * Mede o corpo (na pose de descanso) no espaço da cena normalizada: ombros,
 * gola, largura e profundidade do peito e ângulo dos braços.
 */
export function measureBody(model: AnalyzedModel, scene: THREE.Object3D): BodyDims {
  const { body } = model;
  const skinned = (body as THREE.SkinnedMesh).isSkinnedMesh ? (body as THREE.SkinnedMesh) : null;
  if (!skinned) return BODY;

  const bones = skinned.skeleton.bones;
  const at = (b: THREE.Object3D) => new THREE.Vector3().applyMatrix4(matrixToSceneSpace(b, scene));

  // Lado esquerdo do personagem fica em +X; usamos |x|, então qualquer lado serve.
  const upper = findBone(bones, [/^(mixamorig:?)?leftarm$/i, /upper_?arm(_?0?1)?[._]?l$/i, /upper_?arm/i]);
  const lower = findBone(bones, [/^(mixamorig:?)?leftforearm$/i, /(lower|fore)_?arm(_?0?1)?[._]?l$/i, /(lower|fore)_?arm/i]);
  const neck = findBone(bones, [/^(mixamorig:?)?neck$/i, /neck_?0?1$/i, /neck/i]);
  if (!upper || !lower || !neck) return BODY;

  const pu = at(upper);
  const pl = at(lower);
  const pn = at(neck);
  const shoulderX = Math.abs(pu.x);
  const shoulderY = pu.y;
  const armAngleDeg = THREE.MathUtils.radToDeg(Math.atan2(pu.y - pl.y, Math.abs(pl.x - pu.x)));

  // Vértices do tronco numa faixa abaixo dos ombros.
  const pos = skinned.geometry.getAttribute("position");
  const si = skinned.geometry.getAttribute("skinIndex");
  const sw = skinned.geometry.getAttribute("skinWeight");
  const m = matrixToSceneSpace(skinned, scene);
  const isArmBone = bones.map((b) => ARM_EXCLUDE.test(b.name));
  const v = new THREE.Vector3();
  let maxX = 0, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    let best = 0, bw = -1;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > bw) {
        bw = w;
        best = si.getComponent(i, k);
      }
    }
    if (isArmBone[best]) continue;
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    if (v.y < shoulderY - 0.18 || v.y > shoulderY - 0.04) continue;
    maxX = Math.max(maxX, Math.abs(v.x));
    minZ = Math.min(minZ, v.z);
    maxZ = Math.max(maxZ, v.z);
  }
  if (!maxX || !isFinite(minZ)) return BODY;
  const centerZ = (maxZ + minZ) / 2;

  // Raio do braço: distância mediana dos vértices do braço até o osso.
  const upperIdx = bones.indexOf(upper as THREE.Bone);
  const sx = Math.sign(pu.x) || 1;
  const seg = new THREE.Line3(pu, pl);
  const closest = new THREE.Vector3();
  const radii: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    let best = 0, bw = -1;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > bw) {
        bw = w;
        best = si.getComponent(i, k);
      }
    }
    if (best !== upperIdx) continue;
    // Com a pose exibida aplicada (setReferencePose), a posição crua ainda é a
    // do bind: o braço da malha não coincidia com o osso e o raio saía ~8 cm
    // (em vez de ~4,5), o que deixava a manga um tubo largo e duro.
    skinned.getVertexPosition(i, v).applyMatrix4(m);
    if (Math.sign(v.x) !== sx) continue;
    // Só o meio do braço: perto do ombro entram o deltoide e a axila.
    const t = seg.closestPointToPointParameter(v, true);
    if (t < 0.3 || t > 0.8) continue;
    seg.at(t, closest);
    radii.push(v.distanceTo(closest));
  }
  radii.sort((a, b) => a - b);
  const radius = radii.length ? radii[Math.floor(radii.length / 2)] : 0.045;

  return {
    chestHalfWidth: maxX,
    chestHalfDepth: (maxZ - minZ) / 2,
    centerZ,
    arm: { z0: pu.z - centerZ, x1: Math.abs(pl.x), y1: pl.y, z1: pl.z - centerZ, radius: THREE.MathUtils.clamp(radius, 0.03, 0.07) },
    collarY: pn.y + 0.01,
    sleeveHalfThickness: BODY.sleeveHalfThickness,
    shoulderX,
    shoulderY,
    armAngleDeg: THREE.MathUtils.clamp(armAngleDeg, 20, 88),
  };
}

/* -------------------------------------------------------------------------- */
/*                  Mapa de profundidade do corpo (frente/costas)              */
/* -------------------------------------------------------------------------- */

/**
 * Superfície da frente (z maior) e das costas (z menor) do corpo em (x, y).
 * `sleeve` (0 = tronco, 1 = manga) escolhe o molde: o do tronco ignora os
 * braços, que caídos ao lado do corpo encostam na lateral e a deixavam ondulada.
 */
export type BodySurface = ((x: number, y: number, sleeve?: number) => { front: number; back: number } | null) & {
  /** O ponto (x, y) cai dentro da silhueta do corpo (sem braços), sem a extrapolação. */
  inside: (x: number, y: number) => boolean;
};

const SKIP_HEAD_HAND = /hand|finger|thumb|index|middle|ring|pinky|head|eye|jaw/i;

const SURF_CELL = 0.01;
const SURF_X = 0.7;
const SURF_Y0 = 0.2;
const SURF_Y1 = 1.9;

/**
 * Projeta o corpo (pose de descanso, espaço da cena) num mapa de 1 cm com o z
 * da frente e das costas, e simula o caimento do tecido: ele atravessa
 * reentrâncias na horizontal (entre os seios, coluna) e cai reto abaixo do
 * peito e das escápulas em vez de entrar na barriga ou na lombar. Células
 * vazias perto do corpo são preenchidas por extrapolação. Mãos e cabeça ficam
 * de fora (a mão fica perto da barra; a cabeça acima da gola).
 */
export function bodySurfaceMap(
  model: AnalyzedModel,
  scene: THREE.Object3D,
  extra: THREE.Object3D[] = [],
  /** Usa a pose atual do esqueleto em vez da pose de descanso. */
  posed = false,
): BodySurface | null {
  // Corpo + peças vestidas por baixo (ex.: a calça), para a camiseta passar por cima delas.
  const meshes = [...model.bodyMeshes, ...extra.flatMap((o) => meshesUnder(o))];
  const full = surfaceGrid(meshes, scene, posed, (name) => SKIP_HEAD_HAND.test(name));
  if (!full) return null;
  const torso = surfaceGrid(meshes, scene, posed, (name) => SKIP_HEAD_HAND.test(name) || ARM_EXCLUDE.test(name)) ?? full;
  const lookup = (x: number, y: number, sleeve = 0) => {
    const s = Math.min(1, Math.max(0, sleeve));
    if (s <= 0) return torso(x, y);
    if (s >= 1) return full(x, y);
    const a = torso(x, y), b = full(x, y);
    if (!a || !b) return a ?? b;
    return { front: a.front + (b.front - a.front) * s, back: a.back + (b.back - a.back) * s };
  };
  return Object.assign(lookup, { inside: torso.inside });
}

type SurfaceLookup = ((x: number, y: number) => { front: number; back: number } | null) & {
  inside: (x: number, y: number) => boolean;
};

function surfaceGrid(
  meshes: THREE.Mesh[],
  scene: THREE.Object3D,
  posed: boolean,
  skipBoneName: (name: string) => boolean,
): SurfaceLookup | null {
  const W = Math.round((2 * SURF_X) / SURF_CELL);
  const H = Math.round((SURF_Y1 - SURF_Y0) / SURF_CELL);
  const front = new Float32Array(W * H).fill(-Infinity);
  const back = new Float32Array(W * H).fill(Infinity);
  let any = false;
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const pos = geo.getAttribute("position");
    const m = matrixToSceneSpace(mesh, scene);
    const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh) : null;
    const si = geo.getAttribute("skinIndex");
    const sw = geo.getAttribute("skinWeight");
    const skipBone = skinned?.skeleton.bones.map((b) => skipBoneName(b.name));
    // Posições na cena (x, y em células; z em metros) e vértices ignorados.
    const n = pos.count;
    const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n);
    const skip = new Uint8Array(n);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i);
      if (posed && skinned) skinned.applyBoneTransform(i, v);
      v.applyMatrix4(m);
      X[i] = (v.x + SURF_X) / SURF_CELL - 0.5;
      Y[i] = (v.y - SURF_Y0) / SURF_CELL - 0.5;
      Z[i] = v.z;
      if (skipBone && si && sw) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (skipBone[si.getComponent(i, k)]) w += sw.getComponent(i, k);
        if (w > 0.5) skip[i] = 1;
      }
    }
    // Rasteriza cada triângulo (projeção em XY) guardando o z máximo e mínimo
    // por célula: é a superfície exata, sem os buracos de usar só os vértices.
    const index = geo.getIndex();
    const tris = index ? index.count / 3 : n / 3;
    for (let t = 0; t < tris; t++) {
      const a = index ? index.getX(t * 3) : t * 3;
      const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      if (skip[a] || skip[b] || skip[c]) continue;
      const det = (Y[b] - Y[c]) * (X[a] - X[c]) + (X[c] - X[b]) * (Y[a] - Y[c]);
      if (Math.abs(det) < 1e-9) continue;
      const x0 = Math.max(0, Math.ceil(Math.min(X[a], X[b], X[c])));
      const x1 = Math.min(W - 1, Math.floor(Math.max(X[a], X[b], X[c])));
      const y0 = Math.max(0, Math.ceil(Math.min(Y[a], Y[b], Y[c])));
      const y1 = Math.min(H - 1, Math.floor(Math.max(Y[a], Y[b], Y[c])));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const l1 = ((Y[b] - Y[c]) * (x - X[c]) + (X[c] - X[b]) * (y - Y[c])) / det;
          const l2 = ((Y[c] - Y[a]) * (x - X[c]) + (X[a] - X[c]) * (y - Y[c])) / det;
          const l3 = 1 - l1 - l2;
          if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
          const z = l1 * Z[a] + l2 * Z[b] + l3 * Z[c];
          const k = y * W + x;
          if (z > front[k]) front[k] = z;
          if (z < back[k]) back[k] = z;
          any = true;
        }
      }
    }
  }
  if (!any) return null;

  const filled = (k: number) => front[k] > -Infinity;
  // 1) Fecha os buracos entre vértices (dilatação 3×3).
  {
    const f2 = front.slice(), b2 = back.slice();
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const k = y * W + x;
        if (filled(k)) continue;
        let n = 0, sf = 0, sb = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const q = k + dy * W + dx;
            if (filled(q)) {
              sf += front[q];
              sb += back[q];
              n++;
            }
          }
        }
        if (n >= 3) {
          f2[k] = sf / n;
          b2[k] = sb / n;
        }
      }
    }
    front.set(f2);
    back.set(b2);
  }
  const body = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) body[k] = filled(k) ? 1 : 0;

  // 2) Tensão horizontal: o tecido não afunda em vãos estreitos.
  for (let it = 0; it < 6; it++) {
    for (let y = 0; y < H; y++) {
      for (let x = 2; x < W - 2; x++) {
        const k = y * W + x, l = k - 2, r = k + 2;
        if (!body[k] || !body[l] || !body[r]) continue;
        front[k] = Math.max(front[k], (front[l] + front[r]) / 2);
        back[k] = Math.min(back[k], (back[l] + back[r]) / 2);
      }
    }
  }

  // 3) Caimento: de cima para baixo, o tecido entra no máximo 0,25 cm por cm.
  const slope = 0.25 * SURF_CELL;
  for (let x = 0; x < W; x++) {
    for (let y = H - 2; y >= 0; y--) {
      const k = y * W + x, up = k + W;
      if (!body[k] || !body[up]) continue;
      front[k] = Math.max(front[k], front[up] - slope);
      back[k] = Math.min(back[k], back[up] + slope);
    }
  }

  // 4) Extrapola até ~20 cm para fora do corpo, afinando rápido (fica fino entre
  //    o braço e o tronco, como o tecido debaixo da manga), para a
  //    roupa mais larga que o corpo não ter degrau na borda do mapa.
  const known = body.slice();
  for (let it = 0; it < 20; it++) {
    const add: [number, number, number][] = [];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const k = y * W + x;
        if (known[k]) continue;
        // 8 vizinhos (diagonais com peso menor): com só 4 o contorno saía em "losango".
        let n = 0, sf = 0, sb = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const q = k + dy * W + dx;
            if (q === k || !known[q]) continue;
            const w = dx && dy ? 0.7 : 1;
            sf += front[q] * w;
            sb += back[q] * w;
            n += w;
          }
        }
        if (!n) continue;
        const f = sf / n, b = sb / n, mid = (f + b) / 2;
        add.push([k, mid + (f - mid) * 0.85, mid + (b - mid) * 0.85]);
      }
    }
    for (const [k, f, b] of add) {
      front[k] = f;
      back[k] = b;
      known[k] = 1;
    }
  }

  // 4b) Faixa da borda do corpo: o contorno muda de célula a cada linha e isso
  //     virava ondas na costura lateral. Ali o mapa é desfocado na vertical
  //     (como o tecido, que cai reto). Dentro do corpo o tecido só pode sair,
  //     nunca afundar na pele.
  {
    const BAND = 6;
    const edge = new Float32Array(W * H).fill(Infinity);
    let queue: number[] = [];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const k = y * W + x;
        if (!known[k]) continue;
        if (body[k - 1] !== body[k] || body[k + 1] !== body[k] || body[k - W] !== body[k] || body[k + W] !== body[k]) {
          edge[k] = 0;
          queue.push(k);
        }
      }
    }
    for (let d = 1; d <= BAND && queue.length; d++) {
      const next: number[] = [];
      for (const k of queue) {
        for (const q of [k - 1, k + 1, k - W, k + W]) {
          if (q < 0 || q >= W * H || !known[q] || edge[q] <= d) continue;
          edge[q] = d;
          next.push(q);
        }
      }
      queue = next;
    }
    const f0 = front.slice(), b0 = back.slice();
    for (let it = 0; it < 3; it++) {
      const f2 = front.slice(), b2 = back.slice();
      for (let y = 4; y < H - 4; y++) {
        for (let x = 1; x < W - 1; x++) {
          const k = y * W + x;
          if (edge[k] > BAND) continue;
          let n = 0, sf = 0, sb = 0;
          for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const q = k + dy * W + dx;
              if (!known[q]) continue;
              sf += front[q];
              sb += back[q];
              n++;
            }
          }
          const t = 1 - edge[k] / (BAND + 1);
          let f = front[k] + (sf / n - front[k]) * t;
          let b = back[k] + (sb / n - back[k]) * t;
          if (body[k]) {
            f = Math.max(f, f0[k]);
            b = Math.min(b, b0[k]);
          }
          f2[k] = f;
          b2[k] = b;
        }
      }
      front.set(f2);
      back.set(b2);
    }
  }

  // 5) Desfoque leve (3×3, 2 passadas) para o tecido não copiar cada detalhe.
  for (let it = 0; it < 2; it++) {
    const f2 = front.slice(), b2 = back.slice();
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const k = y * W + x;
        if (!known[k]) continue;
        let n = 0, sf = 0, sb = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const q = k + dy * W + dx;
            if (!known[q]) continue;
            sf += front[q];
            sb += back[q];
            n++;
          }
        }
        f2[k] = sf / n;
        b2[k] = sb / n;
      }
    }
    front.set(f2);
    back.set(b2);
  }

  const inside = (x: number, y: number) => {
    const X = Math.round((x + SURF_X) / SURF_CELL - 0.5), Y = Math.round((y - SURF_Y0) / SURF_CELL - 0.5);
    return X >= 0 && Y >= 0 && X < W && Y < H && body[Y * W + X] === 1;
  };
  // Leitura bilinear entre os centros das células conhecidas.
  const lookup = (x: number, y: number) => {
    const fx = (x + SURF_X) / SURF_CELL - 0.5;
    const fy = (y - SURF_Y0) / SURF_CELL - 0.5;
    const cx = Math.floor(fx), cy = Math.floor(fy);
    const tx = fx - cx, ty = fy - cy;
    let wsum = 0, f = 0, b = 0;
    for (const [dx, dy, w] of [
      [0, 0, (1 - tx) * (1 - ty)],
      [1, 0, tx * (1 - ty)],
      [0, 1, (1 - tx) * ty],
      [1, 1, tx * ty],
    ]) {
      const X = cx + dx, Y = cy + dy;
      if (X < 0 || Y < 0 || X >= W || Y >= H || w <= 0) continue;
      const k = Y * W + X;
      if (!known[k]) continue;
      f += front[k] * w;
      b += back[k] * w;
      wsum += w;
    }
    return wsum > 0.05 ? { front: f / wsum, back: b / wsum } : null;
  };
  return Object.assign(lookup, { inside });
}

/** Altura (na cena) da articulação do quadril, pelo osso da coxa; null sem esqueleto. */
export function hipJointY(model: AnalyzedModel, scene: THREE.Object3D): number | null {
  const skinned = (model.body as THREE.SkinnedMesh).isSkinnedMesh ? (model.body as THREE.SkinnedMesh) : null;
  if (!skinned) return null;
  const thigh = findBone(skinned.skeleton.bones, [
    /^(mixamorig:?)?leftupleg$/i,
    /(thigh|upper_?leg|up_?leg)(_?0?1)?[._]?l$/i,
    /thigh|upper_?leg|upleg/i,
  ]);
  return thigh ? new THREE.Vector3().applyMatrix4(matrixToSceneSpace(thigh, scene)).y : null;
}

/* -------------------------------------------------------------------------- */
/*                Transferência de pesos/morphs por proximidade                */
/* -------------------------------------------------------------------------- */

/** Matriz que leva o espaço local de `m` ao espaço local do corpo. */
export function toBodySpace(m: THREE.Object3D, body: THREE.Object3D) {
  m.updateWorldMatrix(true, false);
  body.updateWorldMatrix(true, false);
  return new THREE.Matrix4().copy(body.matrixWorld).invert().multiply(m.matrixWorld);
}

type Grid = { cell: number; min: THREE.Vector3; cells: Map<number, number[]>; pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute };
const grids = new WeakMap<THREE.BufferGeometry, Grid>();

function gridFor(geo: THREE.BufferGeometry): Grid {
  const cached = grids.get(geo);
  if (cached) return cached;
  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const cell = box.getSize(new THREE.Vector3()).length() / 120 || 0.01;
  const pos = geo.getAttribute("position");
  const cells = new Map<number, number[]>();
  for (let i = 0; i < pos.count; i++) {
    const k = key(
      Math.floor((pos.getX(i) - box.min.x) / cell),
      Math.floor((pos.getY(i) - box.min.y) / cell),
      Math.floor((pos.getZ(i) - box.min.z) / cell),
    );
    let list = cells.get(k);
    if (!list) cells.set(k, (list = []));
    list.push(i);
  }
  const g = { cell, min: box.min.clone(), cells, pos };
  grids.set(geo, g);
  return g;
}

const key = (x: number, y: number, z: number) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);

/** Índice do vértice mais próximo, ou -1 se nenhum estiver a até `maxDist`. */
function nearest(g: Grid, p: THREE.Vector3, skip?: Uint8Array | null, maxDist = Infinity) {
  const cx = Math.floor((p.x - g.min.x) / g.cell);
  const cy = Math.floor((p.y - g.min.y) / g.cell);
  const cz = Math.floor((p.z - g.min.z) / g.cell);
  let best = -1, bd = Infinity;
  const maxR = Math.min(60, Math.ceil(maxDist / g.cell) + 1);
  for (let r = 0; r < maxR; r++) {
    if (bd < Infinity && (r - 1) * g.cell > Math.sqrt(bd)) break;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        // Só a casca do cubo: nas faces de x/y, a coluna inteira; no miolo, só
        // z = ±r. Percorrer o cubo todo a cada raio custava r⁴ e travava a
        // página com tecido longe do corpo (saia rodada, manga larga).
        const edge = Math.abs(dx) === r || Math.abs(dy) === r;
        for (let dz = -r; dz <= r; dz += edge || r === 0 ? 1 : 2 * r) {
          const list = g.cells.get(key(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (const i of list) {
            if (skip?.[i]) continue;
            const ddx = g.pos.getX(i) - p.x, ddy = g.pos.getY(i) - p.y, ddz = g.pos.getZ(i) - p.z;
            const d = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d < bd) {
              bd = d;
              best = i;
            }
          }
        }
      }
    }
  }
  // Sem limite, nunca devolve -1 (comportamento antigo: vértice 0).
  return best < 0 && maxDist === Infinity ? 0 : best;
}

/** Chama `cb(índice, distância²)` para cada vértice a até `r` de `p`. */
function forEachWithin(g: Grid, p: THREE.Vector3, r: number, cb: (i: number, d2: number) => void) {
  const r2 = r * r;
  const n = Math.ceil(r / g.cell);
  const cx = Math.floor((p.x - g.min.x) / g.cell);
  const cy = Math.floor((p.y - g.min.y) / g.cell);
  const cz = Math.floor((p.z - g.min.z) / g.cell);
  for (let dx = -n; dx <= n; dx++) {
    for (let dy = -n; dy <= n; dy++) {
      for (let dz = -n; dz <= n; dz++) {
        const list = g.cells.get(key(cx + dx, cy + dy, cz + dz));
        if (!list) continue;
        for (const i of list) {
          const ddx = g.pos.getX(i) - p.x, ddy = g.pos.getY(i) - p.y, ddz = g.pos.getZ(i) - p.z;
          const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d2 <= r2) cb(i, d2);
        }
      }
    }
  }
}

/** Vizinhos de cada vértice pelas arestas dos triângulos (formato CSR). */
function vertexNeighbors(geo: THREE.BufferGeometry) {
  const n = geo.getAttribute("position").count;
  const index = geo.getIndex();
  const sets: Set<number>[] = Array.from({ length: n }, () => new Set());
  if (index) {
    for (let t = 0; t + 2 < index.count; t += 3) {
      const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
      sets[a].add(b).add(c);
      sets[b].add(a).add(c);
      sets[c].add(a).add(b);
    }
  }
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + sets[i].size;
  const list = new Int32Array(start[n]);
  for (let i = 0; i < n; i++) list.set([...sets[i]], start[i]);
  return { start, list };
}

/**
 * Empurra a roupa para fora do corpo (na pose de descanso), deixando pelo
 * menos `margin` entre o tecido e a pele, para o braço/ombro não furarem a
 * manga. O deslocamento é suavizado na malha para não criar pontas.
 * Mãos e dedos são ignorados (ficam perto da barra mas não devem empurrá-la).
 * A geometria precisa estar no espaço local do corpo.
 */
/** 1 nos vértices do corpo presos mais à mão/dedos do que ao resto (ou null sem esqueleto). */
function handMask(body: THREE.Mesh) {
  return boneMask(body, /hand|finger|thumb|index|middle|ring|pinky/i);
}

/** 1 nos vértices do corpo presos mais aos ossos que casam com `re` (ou null sem esqueleto). */
function boneMask(body: THREE.Mesh, re: RegExp) {
  const skinned = (body as THREE.SkinnedMesh).isSkinnedMesh ? (body as THREE.SkinnedMesh) : null;
  const src = body.geometry;
  const si = src.getAttribute("skinIndex");
  const sw = src.getAttribute("skinWeight");
  if (!skinned || !si || !sw) return null;
  const isHand = skinned.skeleton.bones.map((b) => re.test(b.name));
  const mask = new Uint8Array(si.count);
  for (let j = 0; j < mask.length; j++) {
    let w = 0;
    for (let k = 0; k < 4; k++) if (isHand[si.getComponent(j, k)]) w += sw.getComponent(j, k);
    if (w > 0.5) mask[j] = 1;
  }
  return mask;
}

export function pushOutOfBody(
  target: THREE.BufferGeometry,
  body: THREE.Mesh,
  margin: number,
  /** Ignora vértices mais longe que isso do ponto mais próximo (bordas abertas, ex.: cós da calça). */
  maxDist = Infinity,
) {
  const src = body.geometry;
  const nor = src.getAttribute("normal");
  if (!nor) return;
  const g = gridFor(src);
  const pos = target.getAttribute("position");
  const n = pos.count;

  // Vértices do corpo que não empurram (mãos, dedos).
  const ignore = handMask(body);

  const p = new THREE.Vector3();
  const b = new THREE.Vector3();
  const nr = new THREE.Vector3();
  const disp = new Float32Array(n * 3);
  const push = (out: Float32Array, margin: number) => {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      p.set(pos.getX(i) + out[i * 3], pos.getY(i) + out[i * 3 + 1], pos.getZ(i) + out[i * 3 + 2]);
      const j = nearest(g, p, ignore, maxDist);
      if (j < 0) continue;
      b.fromBufferAttribute(g.pos, j);
      nr.fromBufferAttribute(nor, j).normalize();
      p.sub(b);
      if (p.lengthSq() > maxDist * maxDist) continue;
      const d = p.dot(nr);
      if (d >= margin) continue;
      out[i * 3] += nr.x * (margin - d);
      out[i * 3 + 1] += nr.y * (margin - d);
      out[i * 3 + 2] += nr.z * (margin - d);
      moved++;
    }
    return moved;
  };

  if (!push(disp, margin)) return;

  // Espalha o deslocamento para os vizinhos (sem pontas) e empurra de novo,
  // algumas vezes: o empurrão final sozinho trazia de volta os calombos
  // (cada vértice seguia a normal de um vértice do corpo).
  const { start, list } = vertexNeighbors(target);
  const smooth = (iterations: number) => {
    for (let iter = 0; iter < iterations; iter++) {
      const next = disp.slice();
      for (let i = 0; i < n; i++) {
        const s = start[i], e = start[i + 1];
        if (s === e) continue;
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let k = s; k < e; k++) sum += disp[list[k] * 3 + c];
          next[i * 3 + c] = (disp[i * 3 + c] + sum / (e - s)) / 2;
        }
      }
      disp.set(next);
    }
  };
  smooth(8);
  push(disp, margin);
  // Acabamento: suaviza e só garante metade da folga (a pele não atravessa).
  smooth(4);
  push(disp, margin * 0.5);

  for (let i = 0; i < n; i++) {
    pos.setXYZ(i, pos.getX(i) + disp[i * 3], pos.getY(i) + disp[i * 3 + 1], pos.getZ(i) + disp[i * 3 + 2]);
  }
  pos.needsUpdate = true;
  target.computeVertexNormals();
}

/**
 * Copia, do vértice mais próximo do corpo, os pesos do esqueleto e/ou os
 * deltas dos morphs. `toBody` leva a geometria alvo ao espaço do corpo.
 *
 * Com `smoothRadius`, pesos e deltas são uma média gaussiana em volta do ponto
 * mais próximo. Se a peça tem o atributo "manga" (0 = tronco, 1 = manga), o
 * tronco não copia nada do braço: com o braço caído encostado na lateral, o
 * vizinho mais próximo alternava entre braço e tronco e a lateral ondulava.
 */
export function transferFromBody(
  target: THREE.BufferGeometry,
  body: THREE.Mesh,
  opts: { skin: boolean; morphs: boolean; smoothRadius?: number },
  toBody = new THREE.Matrix4(),
) {
  const src = body.geometry;
  const g = gridFor(src);
  const pos = target.getAttribute("position");
  const n = pos.count;
  const r = opts.smoothRadius ?? 0;
  const sleeveAttr = target.getAttribute("manga");
  const sleeveOf = (i: number) => (sleeveAttr ? sleeveAttr.getX(i) : 1);

  // A roupa nunca herda pesos da mão: com o braço caído a mão encosta no
  // quadril e a barra se soltaria do corpo quando ela mexe.
  const hand = opts.skin ? handMask(body) : null;
  // O tronco da peça (manga < 0,5) também ignora os vértices do braço.
  const arm = sleeveAttr ? boneMask(body, ARM_EXCLUDE) : null;
  const skipFor = (i: number) => (arm && sleeveOf(i) < 0.5 ? arm : hand);

  const map = new Int32Array(n);
  const p = new THREE.Vector3();
  // Perto do corpo, busca exata (raio curto). Longe dele (saia rodada, manga
  // larga), a busca sem limite custa caro e o resultado quase não muda de um
  // ponto para o vizinho: é feita uma vez por bloco de ~4 células e reaproveitada.
  const near = (r || g.cell * 4) * 2;
  const coarse = g.cell * 4;
  const far = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(toBody);
    const skip = skipFor(i);
    let j = nearest(g, p, skip, near);
    if (j < 0) {
      const k = `${Math.floor(p.x / coarse)},${Math.floor(p.y / coarse)},${Math.floor(p.z / coarse)},${skip === arm ? 1 : 0}`;
      const hit = far.get(k);
      if (hit === undefined) far.set(k, (j = nearest(g, p, skip)));
      else j = hit;
    }
    map[i] = j;
  }

  /** Vizinhos (índice e peso gaussiano) em volta do ponto mais próximo de i. */
  const js: number[] = [];
  const fs: number[] = [];
  const q = new THREE.Vector3();
  const gather = (i: number) => {
    js.length = 0;
    fs.length = 0;
    if (r > 0) {
      const skip = skipFor(i);
      // A manga fica afastada do braço: o vértice mais próximo pulava de anel em
      // anel da malha do braço e, com a animação, a manga saía em faixas. Lá a
      // média cobre mais anéis.
      const ri = sleeveAttr ? r * (1 + sleeveOf(i)) : r;
      // Centrada no próprio ponto da roupa (pela distância além da do vértice
      // mais próximo). Centrada no vértice mais próximo, a janela pulava junto
      // com ele, de anel em anel do braço: os pesos mudavam em degraus e a manga
      // saía listrada ao se mexer.
      p.fromBufferAttribute(pos, i).applyMatrix4(toBody);
      const d0 = p.distanceTo(q.fromBufferAttribute(g.pos, map[i]));
      forEachWithin(g, p, d0 + ri, (j, d2) => {
        if (skip?.[j]) return;
        const e = Math.max(0, Math.sqrt(d2) - d0);
        js.push(j);
        fs.push(Math.exp((-4 * e * e) / (ri * ri)));
      });
    }
    if (!js.length) {
      js.push(map[i]);
      fs.push(1);
    }
  };

  const si = src.getAttribute("skinIndex");
  const sw = src.getAttribute("skinWeight");
  const doSkin = opts.skin && !!si && !!sw;
  const skinned = (body as THREE.SkinnedMesh).isSkinnedMesh ? (body as THREE.SkinnedMesh) : null;
  const isArmBone = sleeveAttr ? skinned?.skeleton.bones.map((b) => ARM_EXCLUDE.test(b.name)) : undefined;
  const idx = doSkin ? new Uint16Array(n * 4) : null;
  const wts = doSkin ? new Float32Array(n * 4) : null;

  const morphs = opts.morphs ? src.morphAttributes.position : undefined;
  const relative = src.morphTargetsRelative;
  const basePos = src.getAttribute("position");
  const back = new THREE.Matrix3().setFromMatrix4(toBody).invert();
  const outs = morphs?.map(() => new Float32Array(n * 3)) ?? [];
  const d = new THREE.Vector3();

  const acc = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    gather(i);
    let fsum = 0;
    for (const f of fs) fsum += f;

    if (idx && wts && si && sw) {
      // Média gaussiana dos pesos: vértices vizinhos da roupa recebem pesos
      // parecidos e a malha não rasga na axila/ombro quando o braço se move.
      // No tronco, os ossos do braço perdem a influência aos poucos.
      const armFactor = isArmBone ? smoothstep01((sleeveOf(i) - 0.15) / 0.7) : 1;
      acc.clear();
      for (let t = 0; t < js.length; t++) {
        const j = js[t];
        for (let k = 0; k < 4; k++) {
          const w = sw.getComponent(j, k);
          if (w <= 0) continue;
          const b = si.getComponent(j, k);
          const f = fs[t] * w * (isArmBone?.[b] ? armFactor : 1);
          if (f > 0) acc.set(b, (acc.get(b) ?? 0) + f);
        }
      }
      const top = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = top.reduce((s, [, w]) => s + w, 0);
      if (sum > 0) {
        top.forEach(([b, w], k) => {
          idx[i * 4 + k] = b;
          wts[i * 4 + k] = w / sum;
        });
      } else {
        for (let k = 0; k < 4; k++) {
          idx[i * 4 + k] = si.getComponent(map[i], k);
          wts[i * 4 + k] = sw.getComponent(map[i], k);
        }
      }
    }

    if (morphs) {
      for (let m = 0; m < morphs.length; m++) {
        const attr = morphs[m];
        let x = 0, y = 0, z = 0;
        for (let t = 0; t < js.length; t++) {
          const j = js[t], f = fs[t];
          x += f * (attr.getX(j) - (relative ? 0 : basePos.getX(j)));
          y += f * (attr.getY(j) - (relative ? 0 : basePos.getY(j)));
          z += f * (attr.getZ(j) - (relative ? 0 : basePos.getZ(j)));
        }
        d.set(x / fsum, y / fsum, z / fsum).applyMatrix3(back);
        outs[m][i * 3] = d.x;
        outs[m][i * 3 + 1] = d.y;
        outs[m][i * 3 + 2] = d.z;
      }
    }
  }

  if (idx && wts) {
    target.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(idx, 4));
    target.setAttribute("skinWeight", new THREE.Float32BufferAttribute(wts, 4));
  }

  if (morphs?.length) {
    // O GLTFLoader guarda os nomes só no dicionário da malha, não nos atributos.
    const names: string[] = [];
    for (const [name, i] of Object.entries(body.morphTargetDictionary ?? {})) names[i] = name;
    target.morphAttributes.position = morphs.map((attr, k) => {
      const a = new THREE.Float32BufferAttribute(outs[k], 3);
      a.name = names[k] ?? attr.name;
      return a;
    });
    target.morphTargetsRelative = true;
  }
}

function smoothstep01(t: number) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}
