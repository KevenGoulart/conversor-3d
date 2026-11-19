import * as THREE from "three";
import { matrixToSceneSpace } from "./rig";

/**
 * Poses escolhidas pelo usuário, aplicadas por cima da animação de "parado"
 * (a respiração continua). Cada pose é uma lista de rotações, em graus, em
 * torno dos eixos da cena: X = lado esquerdo do personagem (+X), Y = cima,
 * Z = frente. Os ossos são girados em volta da própria articulação, dos pais
 * para os filhos, então cada rotação é "no mundo", já com o pai girado.
 *
 * `sym` vale para os dois lados: o valor é o do lado esquerdo e o direito sai
 * espelhado (y e z com sinal trocado). Ossos com _l/_r no nome valem só para
 * aquele lado. `wave` é um balanço contínuo (ex.: acenar).
 *
 * As roupas (camiseta pronta e peça da foto) estão presas ao esqueleto, então
 * acompanham qualquer pose.
 */
export type PoseId = "parado";

type Rot = [number, number, number];
type PoseDef = {
  label: string;
  sym?: Record<string, Rot>;
  bones?: Record<string, Rot>;
  wave?: { bone: string; axis: Rot; amp: number; hz: number };
};

// Só a pose de "parado" (a animação idle do modelo); as outras foram retiradas.
const POSE_DEFS: Record<PoseId, PoseDef> = {
  parado: { label: "Parado" },
};

export const POSES: { id: PoseId; label: string }[] = (Object.keys(POSE_DEFS) as PoseId[]).map((id) => ({
  id,
  label: POSE_DEFS[id].label,
}));

/** Rotações (no espaço da cena) de cada osso numa pose; inclui o lado espelhado. */
function rotationsOf(id: PoseId, time: number): Map<string, THREE.Quaternion> {
  const def = POSE_DEFS[id];
  const out = new Map<string, THREE.Quaternion>();
  const put = (name: string, [x, y, z]: Rot) => {
    const r = (d: number) => THREE.MathUtils.degToRad(d);
    out.set(name, new THREE.Quaternion().setFromEuler(new THREE.Euler(r(x), r(y), r(z), "XYZ")));
  };
  for (const [b, [x, y, z]] of Object.entries(def.sym ?? {})) {
    put(`${b}_l`, [x, y, z]);
    put(`${b}_r`, [x, -y, -z]);
  }
  for (const [b, rot] of Object.entries(def.bones ?? {})) put(b, rot);
  if (def.wave) {
    const { bone, axis, amp, hz } = def.wave;
    const a = THREE.MathUtils.degToRad(amp * Math.sin(time * hz * Math.PI * 2));
    const w = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), a);
    out.set(bone, w.multiply(out.get(bone) ?? new THREE.Quaternion()));
  }
  return out;
}

const BLEND_SECONDS = 0.5;

/**
 * Aplica a pose escolhida a cada quadro, com transição suave entre poses.
 * Chamar `apply` depois da animação e dos ajustes fixos de pose.
 */
export class PoseLayer {
  private bones = new Map<string, THREE.Bone>();
  private order: THREE.Bone[] = [];
  private from: PoseId = "parado";
  private to: PoseId = "parado";
  private t = 1;
  private time = 0;
  private parentQ = new THREE.Quaternion();
  private tmpQ = new THREE.Quaternion();
  private v = new THREE.Vector3();
  /** Rotação de descanso de cada osso (a animação não redefine todos a cada quadro). */
  private rest = new Map<THREE.Bone, THREE.Quaternion>();
  private touched = new Set<THREE.Bone>();

  constructor(scene: THREE.Object3D) {
    scene.traverse((o) => {
      if ((o as THREE.Bone).isBone) {
        this.bones.set(o.name, o as THREE.Bone);
        this.rest.set(o as THREE.Bone, o.quaternion.clone());
      }
    });
    const depth = (o: THREE.Object3D) => {
      let d = 0;
      for (let p = o.parent; p; p = p.parent) d++;
      return d;
    };
    this.order = [...this.bones.values()].sort((a, b) => depth(a) - depth(b));
  }

  /**
   * Volta ao descanso os ossos girados no quadro anterior. Chamar antes da
   * animação: os ossos que ela não anima (pelve, pernas…) acumulavam a rotação
   * da pose a cada quadro e o corpo saía torto.
   */
  reset() {
    for (const b of this.touched) b.quaternion.copy(this.rest.get(b)!);
    this.touched.clear();
  }

  set(id: PoseId) {
    if (id === this.to) return;
    this.from = this.to;
    this.to = id;
    this.t = 0;
  }

  apply(dt: number, scene: THREE.Object3D) {
    this.time += dt;
    this.t = Math.min(1, this.t + dt / BLEND_SECONDS);
    const k = this.t * this.t * (3 - 2 * this.t);
    const a = rotationsOf(this.from, this.time);
    const b = rotationsOf(this.to, this.time);
    if (!a.size && !b.size) return;
    const identity = new THREE.Quaternion();
    for (const bone of this.order) {
      const qa = a.get(bone.name), qb = b.get(bone.name);
      if (!qa && !qb) continue;
      const world = this.tmpQ.copy(qa ?? identity).slerp(qb ?? identity, k);
      if (!bone.parent) continue;
      // local = pai⁻¹ · R_cena · pai · local (pai já com a pose aplicada).
      matrixToSceneSpace(bone.parent, scene).decompose(this.v, this.parentQ, this.v);
      const q = this.parentQ.clone().invert().multiply(world).multiply(this.parentQ);
      bone.quaternion.premultiply(q);
      this.touched.add(bone);
    }
  }
}
