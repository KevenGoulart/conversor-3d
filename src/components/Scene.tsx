"use client";

import { Component, Suspense, useEffect, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows, Environment, Lightformer, OrbitControls } from "@react-three/drei";
import type { GarmentLayer } from "@/lib/garment";
import type { CharacterConfig } from "@/lib/character";
import type { ModelInfo } from "@/lib/rig";
import RealisticCharacter from "./RealisticCharacter";

export type CameraFocus = "corpo" | "cabeca" | "tronco" | "pernas" | "pes";

export type SceneProps = {
  character: CharacterConfig;
  /** Peça da foto na parte de cima. */
  top: GarmentLayer | null;
  /** Peça da foto na parte de baixo. */
  bottom: GarmentLayer | null;
  focus: CameraFocus;
  /** Giro do personagem (rad). */
  rotation: number;
  autoRotate: boolean;
  /** URL do .glb do personagem realista. */
  modelUrl: string;
  onModelInfo?: (info: ModelInfo | null) => void;
  onModelError?: (message: string) => void;
};

export default function Scene(props: SceneProps) {
  return (
    <Canvas
      shadows="percentage"
      dpr={[1, 2]}
      camera={{ position: [0, 1.1, 3.6], fov: 32 }}
      gl={{ preserveDrawingBuffer: true, antialias: true, alpha: true }}
      onCreated={({ gl }) => {
        // Tone mapping neutro: não alaranja a pele nem muda as cores da foto da roupa.
        gl.toneMapping = THREE.NeutralToneMapping;
        gl.toneMappingExposure = 1;
      }}
    >
      {/* Estúdio: softboxes refletidas na pele, no tecido e nos olhos. */}
      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={2.2} position={[0, 3.5, 3]} scale={[5, 2.5, 1]} target={[0, 1, 0]} />
        <Lightformer form="rect" intensity={1.1} position={[-4, 1.6, 1.5]} scale={[2.5, 4, 1]} target={[0, 1, 0]} />
        <Lightformer form="rect" intensity={1.6} color="#dbeaff" position={[3.5, 2, -3]} scale={[2, 4, 1]} target={[0, 1, 0]} />
        <Lightformer form="rect" intensity={0.5} color="#cfe2f0" position={[0, -1, 1]} scale={[6, 1, 1]} target={[0, 1, 0]} />
      </Environment>
      <hemisphereLight args={["#ffffff", "#9fb8cc", 0.35]} />
      <directionalLight
        position={[2, 4, 3]}
        intensity={1.5}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0005}
        shadow-normalBias={0.045}
        shadow-radius={4}
      />
      <directionalLight position={[-3, 2, -2]} intensity={0.6} color="#dbeaff" />

      <Outfit {...props} />

      {/* pedestal */}
      <mesh position={[0, -0.03, 0]} receiveShadow>
        <cylinderGeometry args={[0.62, 0.66, 0.06, 64]} />
        <meshStandardMaterial color="#f4f8fb" roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.0015, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.56, 0.6, 64]} />
        <meshBasicMaterial color="#7cc4ec" />
      </mesh>
      <ContactShadows position={[0, 0.002, 0]} opacity={0.4} scale={1.6} blur={2.2} far={1.5} />

      <OrbitControls
        makeDefault
        target={[0, 1.0, 0]}
        enablePan={false}
        minDistance={0.6}
        maxDistance={5}
        minPolarAngle={0.3}
        maxPolarAngle={Math.PI / 2 + 0.05}
        autoRotate={props.autoRotate}
        autoRotateSpeed={1.2}
      />
      <CameraRig focus={props.focus} height={props.character.height} />
    </Canvas>
  );
}

const FOCUS: Record<CameraFocus, { y: number; dist: number; camY: number }> = {
  corpo: { y: 0.92, dist: 3.9, camY: 0.12 },
  cabeca: { y: 1.7, dist: 0.95, camY: 0.02 },
  tronco: { y: 1.2, dist: 2.5, camY: 0.08 },
  pernas: { y: 0.55, dist: 2.2, camY: 0.15 },
  pes: { y: 0.12, dist: 1.2, camY: 0.35 },
};

type OrbitLike = { target: THREE.Vector3; update: () => void };

/** Ao trocar de categoria, desliza a câmera até a parte do corpo em edição. */
function CameraRig({ focus, height }: { focus: CameraFocus; height: number }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null;
  const anim = useRef<{ t: number; fromPos: THREE.Vector3; fromTarget: THREE.Vector3 } | null>(null);

  useEffect(() => {
    if (!controls) return;
    anim.current = { t: 0, fromPos: camera.position.clone(), fromTarget: controls.target.clone() };
  }, [focus, height, controls, camera]);

  useFrame((_, dt) => {
    const a = anim.current;
    if (!a || !controls) return;
    a.t = Math.min(1, a.t + dt / 0.8);
    const k = 1 - Math.pow(1 - a.t, 3);
    const f = FOCUS[focus];
    const target = new THREE.Vector3(0, f.y * height, 0);
    const pos = new THREE.Vector3(0, target.y + f.camY * f.dist, f.dist);
    controls.target.lerpVectors(a.fromTarget, target, k);
    camera.position.lerpVectors(a.fromPos, pos, k);
    controls.update();
    if (a.t >= 1) anim.current = null;
  });
  return null;
}

function Outfit({
  character,
  top,
  bottom,
  rotation,
  modelUrl,
  onModelInfo,
  onModelError,
}: SceneProps) {
  const group = useRef<THREE.Group>(null);

  // Giro suave até o ângulo pedido.
  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    g.rotation.y += (rotation - g.rotation.y) * Math.min(1, dt * 8);
  });

  return (
    <group ref={group} name="personagem" scale={character.height}>
      <ModelBoundary onError={onModelError}>
        {/* Nada aparece até o modelo realista terminar de carregar. */}
        <Suspense fallback={null}>
          <RealisticCharacter
            url={modelUrl}
            c={character}
            top={top}
            bottom={bottom}
            onInfo={onModelInfo}
          />
        </Suspense>
      </ModelBoundary>
    </group>
  );
}

/** Se o .glb falhar ao carregar, não mostra nada e avisa o erro. */
class ModelBoundary extends Component<
  { onError?: (message: string) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError?.(error instanceof Error ? error.message : String(error));
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
