"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { ProcessedGarment } from "@/lib/garment";
import { extractFabric, fabricFill } from "@/lib/shirt";

/**
 * Material 0 = lado da foto (textura), material 1 = outro lado: o tecido da foto
 * repetido (mesmos UVs, então na mesma escala), em vez de uma cor lisa.
 */
export function useGarmentMaterials(garment: ProcessedGarment) {
  const textures = useMemo(() => {
    const fabric = extractFabric(garment);
    return [fabricFill(garment, fabric, true), fabricFill(garment, fabric, false)].map((c) => {
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      return t;
    });
  }, [garment]);
  useEffect(() => () => textures.forEach((t) => t.dispose()), [textures]);

  const materials = useMemo(
    () => textures.map((map) => new THREE.MeshStandardMaterial({ map, roughness: 0.92, side: THREE.DoubleSide })),
    [textures],
  );
  useEffect(() => () => materials.forEach((m) => m.dispose()), [materials]);
  return materials;
}
