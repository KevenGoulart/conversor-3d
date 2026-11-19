"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import type { CharacterConfig } from "@/lib/character";
import { buildGarmentGeometry, smoothGarment, type GarmentLayer, type GarmentSurface, type ProcessedGarment } from "@/lib/garment";
import { bottomShape, buildBottomGeometry, clearPrint, hangBelowHips, measureHips, measureWaist, mirroredSurface, printOnto } from "@/lib/bottom";
import {
  ASSET_KINDS,
  analyzeModel,
  applyBlink,
  applyMorphs,
  applyPoseBones,
  bodySurfaceMap,
  findPoseBones,
  hipJointY,
  isTintable,
  matrixToSceneSpace,
  measureBody,
  posedProxy,
  pushOutOfBody,
  resetPoseBones,
  restorePose,
  setReferencePose,
  unposeGeometry,
  type PoseBone,
  transferFromBody,
  type AnalyzedModel,
  type ModelInfo,
} from "@/lib/rig";
import type { BodyDims } from "@/lib/body";
import { useGarmentMaterials } from "./useGarmentMaterials";
import { composeShirtTexture, extractFabric, extractPrint, fabricFill, shirtPanels } from "@/lib/shirt";
import { skinDetailTextures } from "@/lib/skinDetail";
import { PoseLayer } from "@/lib/poses";

type Props = {
  url: string;
  c: CharacterConfig;
  /** Peça da foto na parte de cima (camiseta, vestido…). */
  top: GarmentLayer | null;
  /** Peça da foto na parte de baixo (bermuda, calça, saia…). */
  bottom: GarmentLayer | null;
  onInfo?: (info: ModelInfo | null) => void;
};

/**
 * Personagem carregado de um .glb (ex.: exportado do MakeHuman/MPFB):
 * morphs ligados aos sliders, animação de "parado" e a roupa da foto
 * presa ao esqueleto para acompanhar o corpo.
 */
export default function RealisticCharacter({ url, c, top, bottom, onInfo }: Props) {
  const gltf = useGLTF(url);
  const scene = gltf.scene;
  const model = useMemo(() => analyzeModel(scene, gltf.animations), [scene, gltf.animations]);
  const dims = useMemo(() => measureBody(model, scene), [model, scene]);
  const hasSliders = model.info.sliders.length > 0;
  // Depois de analyzeModel, que deixa os ossos na pose de descanso.
  const poseBones = useMemo(() => (model ? findPoseBones(scene) : []), [model, scene]);
  const cRef = useRef(c);
  useEffect(() => {
    cRef.current = c;
  }, [c]);

  useEffect(() => {
    onInfo?.(model.info);
    return () => onInfo?.(null);
  }, [model, onInfo]);

  useEffect(() => {
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }, [scene]);

  // Animação de "parado", se o arquivo trouxer alguma.
  const idleClip = useMemo(
    () => gltf.animations.find((a) => /idle|parad|respir/i.test(a.name)) ?? gltf.animations[0] ?? null,
    [gltf.animations],
  );
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  useEffect(() => {
    if (!idleClip) return;
    const m = new THREE.AnimationMixer(scene);
    m.clipAction(idleClip).play();
    mixer.current = m;
    return () => {
      m.stopAllAction();
      m.uncacheRoot(scene);
      mixer.current = null;
      restorePose(scene);
    };
  }, [scene, idleClip]);

  // Pose escolhida, por cima da animação (com transição suave).
  const poseLayer = useMemo(() => new PoseLayer(scene), [scene]);
  useEffect(() => poseLayer.set(c.pose), [poseLayer, c.pose]);

  // Olhos que se mexem (antes de dressModel, que pinta a íris).
  useEyeGaze(scene);

  // Parte de cima "apenas estampa": a camiseta pronta do modelo com a estampa da foto.
  // Peça de manga comprida (suéter) usa a versão de manga longa, se o modelo tiver.
  const activeShirt = top?.longSleeves && model.longShirt ? model.longShirt : model.shirt;
  const shirtGarment = top && top.mode === "estampa" && activeShirt ? top.garment : null;
  useShirtTexture(activeShirt, shirtGarment, top?.photoIsBack ?? false);

  // Parte de baixo: "apenas estampa" projeta a foto na peça escolhida do modelo;
  // "modelo novo" esconde as peças do modelo e monta uma da silhueta.
  const bottomAssetId = chosenAsset(model, c, "baixo");
  const bottomModel = bottom?.mode === "modelo" ? bottom : null;
  const bottomPrint = bottom?.mode === "estampa" && bottomAssetId ? bottom.garment : null;
  useBottomPrint(model, scene, bottomAssetId, bottomPrint);

  // Visibilidade dos acessórios e cores (depois da estampa da parte de baixo).
  const topOn = !!top;
  useEffect(
    () => dressModel(model, c, shirtGarment ? activeShirt : null, topOn, scene, { printed: !!bottomPrint, generated: !!bottomModel }),
    [c, model, shirtGarment, activeShirt, topOn, scene, bottomPrint, bottomModel],
  );

  // Piscar: a cada 2–6 s (às vezes duas vezes seguidas), fecha em ~70 ms e abre em ~130 ms.
  const blink = useRef({ next: 2.5, t: -1, double: false });
  useFrame((_, dt) => {
    resetPoseBones(poseBones);
    poseLayer.reset();
    mixer.current?.update(dt);
    applyPoseBones(poseBones, scene);
    poseLayer.apply(dt, scene);
    applyMorphs(model.morphMeshes, model.info.sliders, cRef.current.morphs);

    const b = blink.current;
    let v = 0;
    if (b.t >= 0) {
      b.t += dt;
      const CLOSE = 0.07, OPEN = 0.13;
      v = b.t < CLOSE ? b.t / CLOSE : Math.max(0, 1 - (b.t - CLOSE) / OPEN);
      if (b.t >= CLOSE + OPEN) {
        b.t = -1;
        b.next = b.double ? 0.15 : 2 + Math.random() * 4;
        b.double = !b.double && Math.random() < 0.2;
      }
    } else if ((b.next -= dt) <= 0) {
      b.t = 0;
    }
    applyBlink(model.morphMeshes, v * v * (3 - 2 * v));
  });

  // Sem morphs no arquivo, o slider de peso cai para a escala simples.
  const w = hasSliders ? 1 : c.weight;
  return (
    <group scale={[w, 1, w]}>
      <primitive object={scene} />
      {top && !shirtGarment && (
        <SkinnedGarment
          slot="cima"
          model={model}
          scene={scene}
          dims={dims}
          layer={top}
          morphs={cRef}
          bottomId={bottomModel ? null : bottomAssetId}
          idleClip={idleClip}
          poseBones={poseBones}
        />
      )}
      {bottomModel && (
        <SkinnedGarment
          slot="baixo"
          model={model}
          scene={scene}
          dims={dims}
          layer={bottomModel}
          morphs={cRef}
          bottomId={null}
          idleClip={idleClip}
          poseBones={poseBones}
        />
      )}
    </group>
  );
}

/** Roupa da foto, presa ao esqueleto do corpo e com os morphs dele. */
function SkinnedGarment({
  slot,
  model,
  scene,
  dims,
  layer,
  morphs,
  bottomId,
  idleClip,
  poseBones,
}: {
  slot: "cima" | "baixo";
  model: AnalyzedModel;
  scene: THREE.Object3D;
  dims: BodyDims;
  layer: GarmentLayer;
  morphs: React.RefObject<CharacterConfig>;
  /** Parte de baixo vestida: a camiseta passa por cima dela. */
  bottomId: string | null;
  idleClip: THREE.AnimationClip | null;
  poseBones: PoseBone[];
}) {
  const hasSliders = model.info.sliders.length > 0;
  const { garment, fit, photoIsBack } = layer;
  const mesh = useMemo(() => {
    const { body } = model;
    const skinnedBody = (body as THREE.SkinnedMesh).isSkinnedMesh ? (body as THREE.SkinnedMesh) : null;

    // Monta a roupa na pose exibida (braços como aparecem na tela) e depois a
    // leva de volta à pose de descanso; sem esqueleto, usa a pose do arquivo.
    if (skinnedBody) setReferencePose(scene, idleClip, poseBones);
    let m: THREE.Mesh | null = null;
    let fitTo: THREE.Mesh | null = null;
    try {
      const d = skinnedBody ? measureBody(model, scene) : dims;
      const bottom = bottomId ? model.assetObjects.baixo.get(bottomId) : undefined;
      const rawMap = bodySurfaceMap(model, scene, bottom ? [bottom] : [], !!skinnedBody);
      const proxyBody: THREE.Mesh = skinnedBody ? posedProxy(skinnedBody) : body;
      fitTo = proxyBody;
      const hipJoint = hipJointY(model, scene);
      const c = d.centerZ ?? 0;

      let geo: THREE.BufferGeometry;
      if (slot === "cima") {
        // Vestido/túnica: abaixo do gancho o tecido cai reto, sem entrar entre as pernas.
        const hips = rawMap ? measureHips(rawMap, hipJoint) : null;
        const waist = hips ? measureWaist(hips, d.shoulderY) : undefined;
        const bodyMap = rawMap && hips ? hangBelowHips(rawMap, hips, garment.waist ? waist?.y : undefined) : null;
        // A peça é montada com a frente em +z e centerZ = 0; com a foto das costas
        // ela gira 180°, então o mapa é lido espelhado (x e frente/costas trocados).
        const surface: GarmentSurface | undefined = bodyMap
          ? (x, y, sleeve) => {
              const s = bodyMap(photoIsBack ? -x : x, y, sleeve);
              if (!s) return null;
              return photoIsBack ? { front: c - s.back, back: c - s.front } : { front: s.front - c, back: s.back - c };
            }
          : undefined;
        // Com a foto das costas a peça é montada girada 180°: o braço fica com z trocado.
        const arm = d.arm && photoIsBack ? { ...d.arm, z0: -d.arm.z0, z1: -d.arm.z1 } : d.arm;
        geo = buildGarmentGeometry(garment, fit, { ...d, centerZ: 0, arm, waist }, surface);
        if (photoIsBack) geo.rotateY(Math.PI);
        geo.translate(0, 0, c);
      } else {
        if (!rawMap) throw new Error("O modelo não tem corpo medível para a parte de baixo.");
        // Bermuda/calça/saia: montada já no espaço da cena (z absoluto).
        const base = photoIsBack ? mirroredSurface(rawMap, c) : rawMap;
        const hips = measureHips(base, hipJoint);
        const map = bottomShape(garment) === "saia" ? hangBelowHips(base, hips) : base;
        geo = buildBottomGeometry(garment, fit, map, hips);
        if (photoIsBack) {
          geo.translate(0, 0, -c);
          geo.rotateY(Math.PI);
          geo.translate(0, 0, c);
        }
      }
      geo.applyMatrix4(matrixToSceneSpace(body, scene).invert());
      // Metros na cena → unidades locais do corpo.
      const unit = 1 / new THREE.Vector3().setFromMatrixScale(matrixToSceneSpace(body, scene)).x;
      // Tecido a mais de 12 cm do corpo (saia rodada, manga larga) não precisa ser empurrado.
      pushOutOfBody(geo, proxyBody, (slot === "cima" ? 0.012 : 0.008) * unit, 0.12 * unit);
      // A calça também empurra (o quadril com jeans é mais largo que a costura lateral).
      if (skinnedBody && bottom) {
        for (const part of bottomMeshes(bottom)) {
          const proxy = posedProxy(part);
          const toPart = new THREE.Matrix4().copy(matrixToSceneSpace(part, scene)).invert().multiply(matrixToSceneSpace(body, scene));
          geo.applyMatrix4(toPart);
          pushOutOfBody(geo, proxy, 0.01 * unit, 0.04 * unit);
          geo.applyMatrix4(toPart.invert());
          proxy.geometry.dispose();
        }
      }
      if (geo.userData.hangingSleeves) smoothGarment(geo, 10);
      transferFromBody(geo, proxyBody, { skin: !!skinnedBody, morphs: hasSliders, smoothRadius: 0.06 * unit });
      // Só serve para a transferência; não vai para o .glb exportado.
      geo.deleteAttribute("manga");
      if (skinnedBody) unposeGeometry(geo, skinnedBody);
      m = skinnedBody ? new THREE.SkinnedMesh(geo) : new THREE.Mesh(geo);
      if (skinnedBody) (m as THREE.SkinnedMesh).bind(skinnedBody.skeleton, skinnedBody.bindMatrix);
    } catch (e) {
      // Uma silhueta estranha não derruba o personagem: só não veste a peça.
      console.warn(`[roupa ${slot}]`, e);
      return null;
    } finally {
      if (skinnedBody && fitTo && fitTo !== body) fitTo.geometry.dispose();
      // O laço de quadros reaplica a animação e os ajustes no próximo quadro.
      if (skinnedBody) restorePose(scene);
    }
    m.updateMorphTargets();
    m.name = slot === "cima" ? "roupa" : "roupa_baixo";
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a folga entra pelos valores, não pelo objeto
  }, [slot, garment, fit.ease, fit.offsetY, fit.seamRadius, photoIsBack, model, dims, scene, hasSliders, bottomId, idleClip, poseBones]);

  const materials = useGarmentMaterials(garment);
  useEffect(() => {
    if (mesh) setMaterial(mesh, materials);
  }, [mesh, materials]);

  // Fica ao lado do corpo, com o mesmo transform.
  useEffect(() => {
    if (!mesh) return;
    const { body } = model;
    const parent = body.parent ?? scene;
    mesh.position.copy(body.position);
    mesh.quaternion.copy(body.quaternion);
    mesh.scale.copy(body.scale);
    parent.add(mesh);
    return () => {
      parent.remove(mesh);
      mesh.geometry.dispose();
    };
  }, [mesh, model, scene]);

  useFrame(() => {
    if (mesh) applyMorphs([mesh], model.info.sliders, morphs.current.morphs);
  });
  return null;
}

/** "Apenas estampa" na parte de baixo: projeta a foto na peça escolhida do modelo. */
function useBottomPrint(model: AnalyzedModel, scene: THREE.Object3D, id: string | null, garment: ProcessedGarment | null) {
  const texture = useMemo(() => {
    if (!garment) return null;
    // Atlas: à esquerda a foto (fora da silhueta, o tecido repetido); à direita só o
    // tecido, para os lados das pernas (ver printOnto).
    const fabric = extractFabric(garment);
    const atlas = document.createElement("canvas");
    atlas.width = garment.width * 2;
    atlas.height = garment.height;
    const ctx = atlas.getContext("2d")!;
    ctx.drawImage(fabricFill(garment, fabric, true), 0, 0);
    ctx.drawImage(fabricFill(garment, fabric, false), garment.width, 0);
    const t = new THREE.CanvasTexture(atlas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [garment]);
  useEffect(() => () => texture?.dispose(), [texture]);
  useEffect(() => {
    const obj = id ? model.assetObjects.baixo.get(id) : undefined;
    if (!obj || !garment || !texture) return;
    printOnto(obj, scene, garment, texture);
    return () => clearPrint(obj);
  }, [model, scene, id, garment, texture]);
}

/** Mostra só o acessório escolhido de cada tipo e aplica as cores. */
function bottomMeshes(o: THREE.Object3D) {
  const out: THREE.SkinnedMesh[] = [];
  o.traverse((x) => {
    if ((x as THREE.SkinnedMesh).isSkinnedMesh) out.push(x as THREE.SkinnedMesh);
  });
  return out;
}

/** Acessório vestido: undefined (ou um id que o modelo não tem) = primeira opção; null = nenhum. */
function chosenAsset(model: AnalyzedModel, c: CharacterConfig, kind: (typeof ASSET_KINDS)[number]) {
  const objs = model.assetObjects[kind];
  const wanted = c.assets[kind];
  if (wanted === null) return null;
  return wanted !== undefined && objs.has(wanted) ? wanted : ([...objs.keys()][0] ?? null);
}

/**
 * `topOn`: há uma peça de cima (camiseta pronta ou peça da foto). A roupa íntima do
 * modelo (intima_cima / intima_baixo) some embaixo das peças, senão atravessa o tecido.
 */
function dressModel(
  model: AnalyzedModel,
  c: CharacterConfig,
  /** Camiseta pronta vestida (curta ou de manga longa); null = nenhuma. */
  shirtOn: THREE.Object3D | null,
  topOn: boolean,
  scene: THREE.Object3D,
  /** printed: a peça de baixo do modelo recebeu a estampa da foto; generated: há uma parte de baixo montada da foto. */
  bottom: { printed: boolean; generated: boolean },
) {
  const bottomOn = chosenAsset(model, c, "baixo") !== null || bottom.generated;
  scene.traverse((o) => {
    if (/^intima_cima/i.test(o.name)) o.visible = !topOn;
    else if (/^intima_baixo/i.test(o.name)) o.visible = !bottomOn;
  });
  const colors: Record<(typeof ASSET_KINDS)[number], string> = {
    cabelo: c.hairColor,
    baixo: c.bottomColor,
    sapato: c.shoeColor,
  };
  let hideMask = 0;
  for (const kind of ASSET_KINDS) {
    const objs = model.assetObjects[kind];
    const chosen = chosenAsset(model, c, kind);
    for (const [id, obj] of objs) {
      // A parte de baixo montada da foto substitui as peças do modelo.
      obj.visible = id === chosen && !(kind === "baixo" && bottom.generated);
      if (kind === "cabelo") upgradeHair(obj, true, isStylized(model.body));
      // A peça estampada usa a foto como textura: não recebe a cor lisa.
      if (isTintable(obj) && !(kind === "baixo" && bottom.printed && id === chosen)) tint(obj, colors[kind]);
      if (obj.visible) hideMask |= hideBits(obj);
    }
  }
  for (const shirt of [model.shirt, model.longShirt]) {
    if (!shirt) continue;
    shirt.visible = shirt === shirtOn;
    if (shirt.visible) hideMask |= hideBits(shirt);
  }
  const uniform = hideUniformFor(model);
  for (const m of model.bodyMeshes) {
    upgradeSkin(m, uniform);
    tint(m, c.skin);
  }
  uniform.value = hideMask;
  for (const m of model.brows) {
    upgradeHair(m, false);
    tint(m, c.hairColor);
  }
  for (const m of model.lashes) upgradeHair(m, false);
  for (const m of model.irises) tint(m, c.eyeColor);
}

/* ----------------------------- Camiseta pronta ----------------------------- */

/**
 * Cobre a camiseta do modelo com o tecido da foto e desenha a estampa no painel da
 * frente (ou das costas, se a foto for das costas). A oclusão que vem como
 * textura no .glb é guardada na primeira vez e multiplicada por cima.
 */
function useShirtTexture(shirt: THREE.Object3D | null, garment: ProcessedGarment | null, photoIsBack: boolean) {
  const meshes = useMemo(() => {
    const out: THREE.Mesh[] = [];
    shirt?.traverse((x) => {
      const m = x as THREE.Mesh;
      if (!m.isMesh) return;
      if (!m.userData.ownMaterial) {
        m.material = (m.material as THREE.Material).clone();
        m.userData.ownMaterial = true;
        m.userData.ao = (m.material as THREE.MeshStandardMaterial).map?.image ?? null;
      }
      out.push(m);
    });
    return out;
  }, [shirt]);
  const panels = useMemo(() => (shirt ? shirtPanels(shirt) : null), [shirt]);
  const print = useMemo(() => (garment ? extractPrint(garment) : null), [garment]);
  const fabric = useMemo(() => (garment ? extractFabric(garment) : null), [garment]);

  useEffect(() => {
    if (!print || !fabric || !panels || !meshes.length) return;
    const tex = composeShirtTexture({
      ao: meshes[0].userData.ao as CanvasImageSource | null,
      fabric,
      print,
      printPanel: photoIsBack ? panels.back : panels.front,
    });
    setShirtMap(meshes, tex);
    return () => tex.dispose();
  }, [print, fabric, panels, meshes, photoIsBack]);
}

function setShirtMap(meshes: THREE.Mesh[], tex: THREE.Texture) {
  for (const m of meshes) {
    const mat = m.material as THREE.MeshStandardMaterial;
    mat.map = tex;
    mat.color.set("#ffffff");
    mat.needsUpdate = true;
  }
}

/* ---------------------------------- Fios ---------------------------------- */

/**
 * Cabelo, sobrancelhas e cílios são faixas com transparência recortada (alpha
 * MASK do glTF): a borda saía serrilhada e o cabelo parecia pintado. Com
 * alpha-to-coverage o recorte vira uma borda suave (usa o antialias do canvas,
 * sem ordenar transparências). No cabelo, brilho de fio: reflexo esticado ao
 * longo dos fios (anisotropia). Sem sheen: ele acendia as bordas das faixas.
 */
function upgradeHair(o: THREE.Object3D, shine: boolean, stylized = false) {
  o.traverse((x) => {
    const mesh = x as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.hairReady) return;
    mesh.userData.hairReady = true;
    const upgrade = (old: THREE.Material) => {
      const mat = toPhysical(old);
      mat.alphaTest = mat.alphaTest || 0.5;
      mat.alphaToCoverage = true;
      mat.side = THREE.DoubleSide;
      if (shine) {
        // Estilizado: brilho mais largo e suave, de mecha.
        mat.roughness = stylized ? 0.6 : 0.5;
        mat.metalness = 0;
        mat.specularIntensity = 0.6;
        mat.anisotropy = stylized ? 0.4 : 0.7;
        mat.anisotropyRotation = Math.PI / 2;
      }
      return mat;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(upgrade) : upgrade(mesh.material);
    mesh.userData.ownMaterial = true;
  });
}

/* ------------------- Pele escondida embaixo das roupas -------------------- */
/*
 * O gerador grava no corpo o atributo "_oculta" (um bit por peça) e em cada peça
 * "oculta_bit". Com a peça visível, o shader descarta a pele marcada com o bit dela,
 * como o MakeHuman faz com os "delete_verts" — sem isso a pele atravessa roupas justas.
 */
const hideUniforms = new WeakMap<AnalyzedModel, { value: number }>();
function hideUniformFor(model: AnalyzedModel) {
  let u = hideUniforms.get(model);
  if (!u) hideUniforms.set(model, (u = { value: 0 }));
  return u;
}

function hideBits(o: THREE.Object3D) {
  let mask = 0;
  o.traverse((x) => {
    const bit = x.userData?.oculta_bit;
    if (typeof bit === "number") mask |= 1 << bit;
  });
  return mask;
}

/**
 * Troca o material da pele por um físico (uma vez por malha): brilho suave
 * nas bordas (sheen avermelhado, como a luz atravessando a pele), reflexo
 * especular fraco e sombras levemente quentes em vez de cinzas — uma
 * aproximação barata de subsurface scattering. Junta o descarte da pele
 * escondida embaixo das roupas no mesmo shader.
 */
function upgradeSkin(mesh: THREE.Mesh, uniform: { value: number }) {
  if (mesh.userData.skinReady) return;
  mesh.userData.skinReady = true;
  const geo = mesh.geometry;
  const attr = geo.getAttribute("_oculta") ?? geo.getAttribute("_OCULTA");
  if (attr && !geo.getAttribute("_oculta")) geo.setAttribute("_oculta", attr);
  const hide = !!attr;

  const stylized = isStylized(mesh);
  const upgrade = (old: THREE.Material) => {
    const mat = toPhysical(old);
    mat.metalness = 0;
    if (stylized) {
      // Visual estilizado: pele lisa e macia, reflexo fraco e espalhado, um brilho
      // suave nas bordas; sem poros.
      mat.roughness = 0.65;
      mat.specularIntensity = 0.25;
      mat.sheen = 0.45;
      mat.sheenRoughness = 0.8;
      mat.sheenColor.set("#ffc8b4");
    } else {
      mat.roughness = 0.5;
      mat.specularIntensity = 0.5;
      // Microrrelevo (poros): quebra o reflexo uniforme de cera.
      const detail = skinDetailTextures(16);
      mat.normalMap = detail.normal;
      mat.normalScale.set(0.15, 0.15);
      mat.roughnessMap = detail.roughness;
      mat.sheen = 0.25;
      mat.sheenRoughness = 0.6;
      mat.sheenColor.set("#ffb39c");
    }
    mat.onBeforeCompile = (shader) => {
      if (hide) {
        shader.uniforms.uHideMask = uniform;
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nattribute float _oculta;\nuniform int uHideMask;\nvarying float vOculta;")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\nvOculta = (int(_oculta + 0.5) & uHideMask) != 0 ? 1.0 : 0.0;");
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nvarying float vOculta;")
          .replace("void main() {", "void main() {\n  if (vOculta > 0.5) discard;");
      }
      // Luz "vazando" por baixo da pele: as sombras puxam para o vermelho.
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <lights_fragment_end>",
        "#include <lights_fragment_end>\nreflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.09, 0.03, 0.02);",
      );
    };
    mat.customProgramCacheKey = () => (hide ? "pele-oculta" : "pele");
    return mat;
  };
  mesh.material = Array.isArray(mesh.material) ? mesh.material.map(upgrade) : upgrade(mesh.material);
  mesh.userData.ownMaterial = true;
}

/** Modelo gerado com --estilizado (o gerador marca o corpo com estilo = "estilizado"). */
function isStylized(o: THREE.Object3D) {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData?.estilo === "estilizado") return true;
  return false;
}

/** Cópia do material como MeshPhysicalMaterial (mantém cor, texturas e lados). */
function toPhysical(old: THREE.Material) {
  if ((old as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) return (old as THREE.MeshPhysicalMaterial).clone();
  const mat = new THREE.MeshPhysicalMaterial();
  if ((old as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
    THREE.MeshStandardMaterial.prototype.copy.call(mat, old as THREE.MeshStandardMaterial);
    // O copy do Standard apaga a define PHYSICAL (sem ela sheen/clearcoat não funcionam).
    mat.defines = { STANDARD: "", PHYSICAL: "" };
  } else {
    THREE.Material.prototype.copy.call(mat, old);
    const c = (old as THREE.MeshBasicMaterial).color;
    if (c) mat.color.copy(c);
    mat.map = (old as THREE.MeshBasicMaterial).map ?? null;
  }
  return mat;
}

/* ------------------------------- Olhos vivos ------------------------------- */
/*
 * O modelo não tem ossos nos olhos: olho, íris e pupila são malhas presas à
 * cabeça. O giro é feito no vertex shader, em volta do centro de cada globo
 * (antes do esqueleto, então acompanha a cabeça). Esclera e íris ganham uma
 * camada de verniz (clearcoat) para o brilho úmido.
 */
const EYE_PART = /^(olho|iris|pupila)_(l|r)$/i;

function setupEyes(scene: THREE.Object3D, rot: { value: THREE.Matrix3 }) {
  const centers: Record<string, THREE.Vector3> = {};
  scene.traverse((o) => {
    const m = /^olho_(l|r)$/i.exec(o.name);
    const mesh = o as THREE.Mesh;
    if (!m || !mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    centers[m[1].toLowerCase()] = mesh.geometry.boundingBox!.getCenter(new THREE.Vector3());
  });

  scene.traverse((o) => {
    const m = EYE_PART.exec(o.name);
    const mesh = o as THREE.Mesh;
    if (!m || !mesh.isMesh || mesh.userData.eyeReady) return;
    const center = centers[m[2].toLowerCase()];
    if (!center) return;
    mesh.userData.eyeReady = true;
    const wet = m[1].toLowerCase() !== "pupila";
    const upgrade = (old: THREE.Material) => {
      const mat = toPhysical(old);
      if (wet) {
        mat.clearcoat = 1;
        mat.clearcoatRoughness = 0.04;
      }
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uEyeRot = rot;
        shader.uniforms.uEyeCenter = { value: center };
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nuniform mat3 uEyeRot;\nuniform vec3 uEyeCenter;")
          .replace("#include <morphnormal_vertex>", "#include <morphnormal_vertex>\nobjectNormal = uEyeRot * objectNormal;")
          .replace(
            "#include <morphtarget_vertex>",
            "#include <morphtarget_vertex>\ntransformed = uEyeCenter + uEyeRot * (transformed - uEyeCenter);",
          );
      };
      mat.customProgramCacheKey = () => "olho";
      return mat;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(upgrade) : upgrade(mesh.material);
    mesh.userData.ownMaterial = true;
  });
}

/**
 * Olhar com movimentos sacádicos: fixa um ponto por 1–4 s e pula rápido
 * (~0,1 s) para outro, às vezes de volta ao centro, com micro-movimentos
 * entre os pulos.
 */
function useEyeGaze(scene: THREE.Object3D) {
  const rot = useRef({ value: new THREE.Matrix3() });
  const gaze = useRef({ yaw: 0, pitch: 0, toYaw: 0, toPitch: 0, next: 1.5 });
  const tmp = useRef({ e: new THREE.Euler(), m: new THREE.Matrix4() });

  useEffect(() => setupEyes(scene, rot.current), [scene]);

  useFrame((_, dt) => {
    const g = gaze.current;
    g.next -= dt;
    if (g.next <= 0) {
      if (Math.random() < 0.6) {
        const center = Math.random() < 0.4;
        g.toYaw = center ? 0 : (Math.random() * 2 - 1) * 0.22;
        g.toPitch = center ? 0 : (Math.random() * 2 - 1) * 0.09;
        g.next = 1.2 + Math.random() * 2.8;
      } else {
        g.toYaw += (Math.random() * 2 - 1) * 0.025;
        g.toPitch += (Math.random() * 2 - 1) * 0.015;
        g.next = 0.3 + Math.random() * 0.6;
      }
    }
    const k = 1 - Math.exp(-Math.min(dt, 0.1) * 30);
    g.yaw += (g.toYaw - g.yaw) * k;
    g.pitch += (g.toPitch - g.pitch) * k;
    const { e, m } = tmp.current;
    e.set(g.pitch, g.yaw, 0);
    rot.current.value.setFromMatrix4(m.makeRotationFromEuler(e));
  });
}

function setMaterial(mesh: THREE.Mesh, materials: THREE.Material[]) {
  mesh.material = materials;
}

/** Pinta as malhas de um objeto (clonando o material na primeira vez). */
function tint(o: THREE.Object3D, color: string) {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    if (!m.isMesh) return;
    if (!m.userData.ownMaterial) {
      m.material = Array.isArray(m.material) ? m.material.map((k) => k.clone()) : m.material.clone();
      m.userData.ownMaterial = true;
    }
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const std = mat as THREE.MeshStandardMaterial;
      if (std.color) std.color.set(color);
    }
  });
}
