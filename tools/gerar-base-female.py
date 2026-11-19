"""
Gera public/models/personagem.glb a partir do "Base Female - Game Ready - Rigged - Low Poly" de arte_art
(CC BY 4.0, https://skfb.ly/pJYJQ), baixado do Sketchfab em glTF/GLB.

Uso:
    blender --background --python tools/gerar-base-female.py -- fonte/base-female/base-female.glb \
        public/models/personagem.glb

O modelo vem com esqueleto (54 ossos, pose T), corpo, roupa íntima, olhos, um cabelo, sobrancelhas +
cílios e boca, mas sem shape keys nem animação. O script:
  - desfaz a rotação extra da raiz do Sketchfab (o modelo vinha deitado) e fixa a frente em -Y
  - renomeia os ossos para o padrão que o app e as poses usam (pelvis, spine_01, upperarm_l, ...)
  - renomeia as malhas para a convenção do app (corpo, cabelo_*, sobrancelha, cilios, ...)
  - reaproveita o gerador do Quaternius (tools/gerar-quaternius.py) para o resto: pose A,
    shape keys de corpo, camiseta, calça e tênis feitos do próprio corpo e a animação idle
  - tira a cor média da pele (o app escolhe o tom) e deixa o cabelo em cinza (o app tinge)
"""
import math
import os
import re
import sys

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib  # noqa: E402

gq = importlib.import_module("gerar-quaternius")  # funções compartilhadas (não roda o main dele)

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) < 2:
    raise SystemExit("uso: -- <base-female.glb> <saida.glb>")
SRC = os.path.abspath(argv[0])
OUT = os.path.abspath(argv[1])

# Ossos do modelo → padrão do app (o sufixo _NNN é o índice que veio do FBX).
BONES = {
    "Root": "root", "Hips": "pelvis",
    "Spine.001": "spine_01", "Spine1": "spine_02", "Spine2": "spine_03",
    "Neck": "neck_01", "Head": "head",
}
for s in ("L", "R"):
    t = s.lower()
    BONES.update({
        f"Shoulder.{s}": f"clavicle_{t}", f"Arm.{s}": f"upperarm_{t}", f"ForeArm.{s}": f"lowerarm_{t}",
        f"Hand.{s}": f"hand_{t}", f"UpLeg.{s}": f"thigh_{t}", f"Leg.{s}": f"calf_{t}",
        f"Foot.{s}": f"foot_{t}", f"ToeBase.{s}": f"ball_{t}",
    })
    for finger, name in (("Thumb", "thumb"), ("Index", "index"), ("Middle", "middle"),
                         ("Ring", "ring"), ("Pinky", "pinky")):
        for i in (1, 2, 3):
            BONES[f"Hand{finger}{i}.{s}"] = f"{name}_0{i}_{t}"

# Material de cada malha → nome no .glb.
MESHES = {
    "m_body": "corpo",
    "m_clothes": "roupa_intima",
    "m_eyes": "olhos",
    "m_hair": "cabelo_chanel",
    "m_hair_extra": "sobrancelha",  # separado em sobrancelha + cilios abaixo
    "m_mouth": "boca",
}


def log(*a):
    print("[gerar-base-female]", *a, flush=True)


def apply_all_transforms(objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def import_model():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=SRC)
    for o in [o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith("Icosphere")]:
        bpy.data.objects.remove(o, do_unlink=True)
    # A raiz "Sketchfab_model" gira -90° em X por cima da conversão do glTF: o corpo
    # ficava deitado. Sem ela, a altura volta para +Z.
    for o in bpy.data.objects:
        if o.type == "EMPTY" and o.parent is None:
            o.rotation_mode = "QUATERNION"
            o.rotation_quaternion = (1, 0, 0, 0)
    bpy.context.view_layer.update()
    rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    # A pose que vem no arquivo (Root 180°, Hips 90° e braços abaixados) só compensava
    # aquela rotação da raiz; zerada, a malha fica na pose T, em pé, igual ao esqueleto.
    for pb in rig.pose.bones:
        pb.location = (0, 0, 0)
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.scale = (1, 1, 1)
    bpy.context.view_layer.update()
    mw = rig.matrix_world.copy()
    rig.parent = None
    rig.matrix_world = mw
    for o in [o for o in bpy.data.objects if o.type == "EMPTY"]:
        bpy.data.objects.remove(o, do_unlink=True)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = rig
        o.matrix_world = mw
    apply_all_transforms([rig] + meshes)
    rig.name = rig.data.name = "Armature"
    return rig, meshes


def face_front(rig, meshes):
    """Frente em -Y (o que o resto do pipeline espera): olhos à frente do osso da cabeça."""
    eyes = next(o for o in meshes if o.data.materials and o.data.materials[0].name.startswith("m_eyes"))
    ey = np.mean([(eyes.matrix_world @ v.co).y for v in eyes.data.vertices])
    head = next(b for b in rig.data.bones if b.name.startswith("Head"))
    hy = (rig.matrix_world @ head.head_local).y
    if ey > hy:
        rig.matrix_world = Matrix.Rotation(np.pi, 4, "Z") @ rig.matrix_world
        bpy.context.view_layer.update()
        apply_all_transforms([rig] + meshes)
        log("girado 180° para a frente ficar em -Y")
    zs = [(o.matrix_world @ v.co).z for o in meshes for v in o.data.vertices]
    log(f"altura {max(zs) - min(zs):.3f} m, pés em z={min(zs):.3f}")


def rename_bones(rig, meshes):
    done = 0
    for b in rig.data.bones:
        base = re.sub(r"_\d+$", "", b.name)
        new = BONES.get(base)
        if not new:
            continue
        old = b.name
        b.name = new
        for o in meshes:  # o Blender costuma renomear sozinho; garante
            g = o.vertex_groups.get(old)
            if g:
                g.name = new
        done += 1
    log(f"ossos renomeados: {done} de {len(rig.data.bones)}")


def rename_meshes(meshes):
    out = {}
    for o in meshes:
        mat = o.data.materials[0].name if o.data.materials else ""
        name = MESHES.get(mat.split(".")[0])
        if name is None:
            log("malha sem nome conhecido:", o.name, mat)
            continue
        o.name = o.data.name = name
        out[name] = o
    return out


def split_brows_lashes(obj, eyes):
    """
    Sobrancelhas e cílios vêm na mesma malha (e na mesma textura). Separa pelas peças
    soltas: o que fica acima do topo dos olhos é sobrancelha, o resto são cílios. Os
    cílios ganham uma cópia da textura (a da sobrancelha vira cinza para o app tingir).
    """
    import bmesh

    top = max((eyes.matrix_world @ v.co).z for v in eyes.data.vertices)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    seen, lash_faces = set(), []
    for v in bm.verts:
        if v in seen:
            continue
        stack, isl = [v], []
        seen.add(v)
        while stack:
            x = stack.pop()
            isl.append(x)
            for e in x.link_edges:
                y = e.other_vert(x)
                if y not in seen:
                    seen.add(y)
                    stack.append(y)
        cz = sum((obj.matrix_world @ x.co).z for x in isl) / len(isl)
        if cz < top:
            lash_faces.extend({f.index for x in isl for f in x.link_faces})
    bm.free()

    lashes = obj.copy()
    lashes.data = obj.data.copy()
    bpy.context.collection.objects.link(lashes)
    lashes.name = lashes.data.name = "cilios"
    lash_idx = set(lash_faces)

    def keep(o, want_lash):
        bm = bmesh.new()
        bm.from_mesh(o.data)
        drop = [f for f in bm.faces if (f.index in lash_idx) != want_lash]
        bmesh.ops.delete(bm, geom=drop, context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        bm.to_mesh(o.data)
        bm.free()

    keep(lashes, True)
    keep(obj, False)
    mat = obj.data.materials[0].copy()
    mat.name = "cilios"
    for n in mat.node_tree.nodes:
        if n.type == "TEX_IMAGE" and n.image and any(l.to_socket.name == "Base Color" for l in n.outputs[0].links):
            n.image = n.image.copy()
    lashes.data.materials[0] = mat
    log(f"sobrancelha: {len(obj.data.vertices)} vértices; cílios: {len(lashes.data.vertices)}")


def split_underwear(obj, rig):
    """
    Roupa íntima em duas peças: intima_cima (sutiã) e intima_baixo (calcinha), separadas
    na altura da cintura. O app esconde cada uma quando há roupa por cima.
    """
    import bmesh

    waist = (rig.matrix_world @ rig.data.bones["spine_01"].head_local).z + 0.05
    low = obj.copy()
    low.data = obj.data.copy()
    bpy.context.collection.objects.link(low)
    obj.name = obj.data.name = "intima_cima"
    low.name = low.data.name = "intima_baixo"
    for o, keep_top in ((obj, True), (low, False)):
        bm = bmesh.new()
        bm.from_mesh(o.data)
        mw = o.matrix_world
        drop = [f for f in bm.faces if ((mw @ f.calc_center_median()).z > waist) != keep_top]
        bmesh.ops.delete(bm, geom=drop, context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        bm.to_mesh(o.data)
        bm.free()
    log(f"roupa íntima: cima {len(obj.data.vertices)} vértices, baixo {len(low.data.vertices)}")


def smooth_body(body, levels=1):
    """
    O corpo é low poly (~6 mil faces): a camiseta e a calça feitas dele saíam serrilhadas.
    Junta as cópias de vértice das costuras do UV (o glTF separa) e subdivide uma vez
    (Catmull-Clark), antes de criar as shape keys. Pesos e UV acompanham.
    """
    import bmesh

    bm = bmesh.new()
    bm.from_mesh(body.data)
    before = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    bm.to_mesh(body.data)
    bm.free()
    if body.data.has_custom_normals:  # normais do glTF; recalculadas na subdivisão
        bpy.context.view_layer.objects.active = body
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    for p in body.data.polygons:
        p.use_smooth = True
    sub = body.modifiers.new("Subdivisao", "SUBSURF")
    sub.levels = sub.render_levels = levels
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = body
    body.select_set(True)
    bpy.ops.object.modifier_move_to_index(modifier=sub.name, index=0)
    bpy.ops.object.modifier_apply(modifier=sub.name)
    log(f"corpo: {before} → {len(body.data.vertices)} vértices (costuras juntas, subdividido {levels}x)")


def round_neckline(shirt, body, rig, bit=0):
    """
    A borda de cima da camiseta seguia os triângulos do corpo (serrilhada) e deixava
    buracos onde a pele embaixo era escondida. Abre uma gola redonda em volta do
    pescoço: apaga as faces dentro de um cilindro, empurra a borda para o círculo e
    devolve ao corpo a pele dessa região (bit `bit` do atributo _oculta, o da peça).
    """
    import bmesh

    neck = rig.matrix_world @ rig.data.bones["neck_01"].head_local
    names = {g.index: g.name for g in body.vertex_groups}
    mwb = body.matrix_world
    # Raio do pescoço: vértices do osso do pescoço perto da base.
    rs = []
    for v in body.data.vertices:
        g = max(v.groups, key=lambda g: g.weight, default=None)
        p = mwb @ v.co
        if g and names.get(g.group) == "neck_01" and abs(p.z - (neck.z + 0.03)) < 0.015:
            rs.append(math.hypot(p.x - neck.x, p.y - neck.y))
    r_neck = float(np.median(rs)) if rs else 0.05
    R = r_neck + 0.022  # gola um pouco afastada do pescoço
    # Elipse vista de cima, com o centro um pouco à frente (frente = -Y): a gola desce
    # mais na frente que atrás, como numa gola careca.
    cx, cy = neck.x, neck.y - 0.012
    rx, ry = R, R * 1.08
    # Altura mínima do corte: na frente a gola desce até ~13 cm abaixo da base do
    # pescoço; atrás fica só 1,5 cm abaixo do teto. As costas ficam mais para dentro na
    # linha da coluna, e o cilindro descia ali até bem abaixo dos ombros: a gola de trás
    # ganhava uma curva funda no meio (e, mais baixo, abria um buraco na coluna).
    def z_min(p):
        s_ = max(-1.0, min(1.0, (p.y - cy) / max(math.hypot(p.x - cx, p.y - cy), 1e-6)))  # -1 frente, +1 trás
        t_ = max(0.0, min(1.0, (s_ + 0.3) / 0.6))
        return neck.z - 0.13 + 0.145 * t_

    # Teto da gola: perto do pescoço nada passa desta altura (os pesos do pescoço sobem
    # pelo trapézio e a camiseta subia junto, atrás e dos lados).
    z_cap = neck.z + 0.03
    CAP_D = 1.5

    def ell(p):
        """Distância normalizada à elipse (1 = na borda) e ângulo em volta dela."""
        u, w = (p.x - cx) / rx, (p.y - cy) / ry
        return math.hypot(u, w), math.atan2(w, u)

    mw, inv = shirt.matrix_world, shirt.matrix_world.inverted()
    bm = bmesh.new()
    bm.from_mesh(shirt.data)
    # Divide as faces com planos verticais tangentes à elipse (48 setores, cada plano
    # só nas faces do próprio setor) e com o plano do teto, e depois apaga as peças do
    # lado de dentro: a borda passa no meio das faces e sai contínua (antes seguia os
    # triângulos e ficava torta). Apagar já no corte (clear_inner) levava junto faces
    # vizinhas inteiras.
    N = 48
    step = 2 * math.pi / N
    planes = []
    for k in range(N):
        t = k * step
        co = Vector((cx + rx * math.cos(t), cy + ry * math.sin(t), 0.0))
        no = Vector((math.cos(t) / rx, math.sin(t) / ry, 0.0)).normalized()
        planes.append((co, no))
        faces = []
        for f in bm.faces:
            c = mw @ f.calc_center_median()
            if c.z < z_min(c) - 0.02:
                continue
            d, a = ell(c)
            da = (a - t + math.pi) % (2 * math.pi) - math.pi
            if d < 1.7 and abs(da) < step * 1.6:
                faces.append(f)
        if not faces:
            continue
        geom = list({x for f in faces for x in (*f.verts, *f.edges)}) + faces
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=inv @ co,
                               plane_no=(inv.to_3x3() @ no).normalized())
    faces = [f for f in bm.faces if ell(mw @ f.calc_center_median())[0] < CAP_D + 0.2
             and (mw @ f.calc_center_median()).z > z_cap - 0.05]
    if faces:
        geom = list({x for f in faces for x in (*f.verts, *f.edges)}) + faces
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=inv @ Vector((cx, cy, z_cap)),
                               plane_no=(inv.to_3x3() @ Vector((0, 0, 1))).normalized())

    def inside(c):
        d, a = ell(c)
        if d < CAP_D and c.z > z_cap:
            return True
        if c.z < z_min(c) or d > 1.7:
            return False
        co, no = planes[round(a / step) % N]
        return (c - Vector((co.x, co.y, c.z))).dot(no) < 0

    drop = [f for f in bm.faces if inside(mw @ f.calc_center_median())]
    bmesh.ops.delete(bm, geom=drop, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    # Pedaços soltos que sobram perto da gola (lascas entre setores).
    bm.verts.ensure_lookup_table()
    seen = set()
    for v in list(bm.verts):
        if v in seen or not v.is_valid:
            continue
        stack, isl = [v], []
        seen.add(v)
        while stack:
            x = stack.pop()
            isl.append(x)
            for e in x.link_edges:
                y = e.other_vert(x)
                if y not in seen:
                    seen.add(y)
                    stack.append(y)
        if len(isl) < 6:
            bmesh.ops.delete(bm, geom=isl, context="VERTS")
    # Arredonda os cantos onde o teto encontra a elipse (atrás, nos ombros): suaviza a
    # borda da gola ao longo dela mesma (cada vértice vai para a média dos dois vizinhos
    # da borda). As shape keys andam junto.
    bm.verts.ensure_lookup_table()
    ring = [v for v in bm.verts if v.is_boundary and ell(mw @ v.co)[0] < CAP_D + 0.3
            and (mw @ v.co).z > z_min(mw @ v.co) - 0.02]
    ring_set = set(ring)
    nbrs = {v: [e.other_vert(v) for e in v.link_edges if e.is_boundary and e.other_vert(v) in ring_set]
            for v in ring}
    pos = {v: v.co.copy() for v in ring}
    for _ in range(30):
        new = {}
        for v in ring:
            nb = nbrs[v]
            new[v] = pos[v] * 0.5 + (pos[nb[0]] + pos[nb[1]]) * 0.25 if len(nb) == 2 else pos[v]
        pos = new
    layers = bm.verts.layers.shape.values()
    for v in ring:
        delta = pos[v] - v.co
        for layer in layers:
            v[layer] = v[layer] + delta
        v.co = pos[v]
    moved = len(ring)
    bm.to_mesh(shirt.data)
    bm.free()

    # Pele de volta: o que ficou fora da camiseta (dentro da gola ou acima do teto).
    attr = body.data.attributes.get("_oculta")
    freed = 0
    if attr is not None:
        vals = np.empty(len(body.data.vertices), dtype=np.float32)
        attr.data.foreach_get("value", vals)
        margin = 0.02 / R
        for v in body.data.vertices:
            p = mwb @ v.co
            d = ell(p)[0]
            out = (d < 1 + margin and p.z > z_min(p)) or (d < CAP_D + margin + 0.08 and p.z > z_cap - 0.03)
            if out and int(vals[v.index]) & (1 << bit):
                vals[v.index] -= 1 << bit
                freed += 1
        attr.data.foreach_set("value", vals)
    log(f"gola redonda: raio {R * 100:.1f} cm, teto {z_cap:.3f} m, {moved} vértices na borda, "
        f"{freed} vértices de pele devolvidos")


def soften_skin_paint(px, w, h):
    """
    A pintura da pele tem traços escuros marcados (riscos no pescoço, sulcos do rosto)
    que envelhecem o rosto. Clareia o que é mais escuro que a vizinhança e reduz um
    pouco o contraste geral; olhos (muito escuros) e lábios (avermelhados) ficam.
    """
    img = px.reshape(h, w, 4)
    rgb = img[..., :3]

    def box(a, r):
        c = np.cumsum(np.pad(a, ((r + 1, r), (0, 0), (0, 0)), mode="edge"), axis=0)
        a = (c[2 * r + 1:] - c[:-2 * r - 1]) / (2 * r + 1)
        c = np.cumsum(np.pad(a, ((0, 0), (r + 1, r), (0, 0)), mode="edge"), axis=1)
        return (c[:, 2 * r + 1:] - c[:, :-2 * r - 1]) / (2 * r + 1)

    blur = box(box(rgb, 10), 10)
    wts = np.array([0.299, 0.587, 0.114], dtype=np.float32)
    lum, blum = rgb @ wts, blur @ wts
    dark = np.clip((blum - lum) / 0.08, 0, 1)
    keep = (lum < 0.3) | ((rgb[..., 0] - rgb[..., 2]) > 0.25)
    mix = np.where(keep, 0.0, dark * 0.85)[..., None]
    out = rgb * (1 - mix) + blur * mix
    flat = np.where(keep, 1.0, 0.7)[..., None]  # contraste geral 30% menor
    img[..., :3] = np.clip(0.92 + (out - 0.92) * flat, 0, 1)
    log("pintura da pele suavizada")


def drop_shoes(body):
    """
    Sem calçado: o gerador do Quaternius cria a calça e o tênis juntos; o tênis sai e
    a pele dos pés volta a aparecer (bit 2 do atributo _oculta).
    """
    shoe = bpy.data.objects.get("sapato_tenis")
    if shoe is None:
        return
    bit = int(shoe.get("oculta_bit", 2))
    bpy.data.objects.remove(shoe, do_unlink=True)
    attr = body.data.attributes.get("_oculta")
    if attr is not None:
        vals = np.empty(len(body.data.vertices), dtype=np.float32)
        attr.data.foreach_get("value", vals)
        mask = (vals.astype(np.int32) >> bit) & 1
        vals -= mask * float(1 << bit)
        attr.data.foreach_set("value", vals)
    log("tênis removido (descalça)")


def neutral_skin(body):
    """
    Divide a cor da pele pela mediana: o app multiplica pelo tom escolhido. Os trechos
    escuros (sombra pintada embaixo da roupa íntima) ficam fora da mediana.
    """
    mat = body.data.materials[0]
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    link = next(iter(bsdf.inputs["Base Color"].links), None)
    img = getattr(link.from_node, "image", None) if link else None
    if img is None:
        log("textura da pele não encontrada")
        return
    px = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    lum = px[:, :3] @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    med = np.median(px[lum > 0.45, :3], axis=0)
    px[:, :3] = np.clip(px[:, :3] / np.maximum(med, 1e-3) * 0.92, 0, 1)
    soften_skin_paint(px, img.size[0], img.size[1])
    img.pixels.foreach_set(px.ravel())
    img.update()
    img.pack()
    log("pele sem cor média; mediana", np.round(med, 3))
    # O mapa de rugosidade/metal da pele não exporta (o glTF saía com uma textura sem
    # imagem, que pode derrubar o carregamento); o app define a rugosidade da pele.
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type == "SEPARATE_COLOR" or (n.type == "TEX_IMAGE" and any(
                l.to_node.type == "SEPARATE_COLOR" for l in n.outputs[0].links)):
            nt.nodes.remove(n)
    bsdf.inputs["Roughness"].default_value = 0.6
    bsdf.inputs["Metallic"].default_value = 0.0


# Dobra de cada falange na pose de descanso, em graus no eixo X local do osso (o
# mesmo eixo em que o arquivo original trazia os dedos fechados; positivo = fecha).
FINGER_CURL = {"01": 8.0, "02": 14.0, "03": 10.0}
THUMB_CURL = {"01": 4.0, "02": 8.0, "03": 6.0}


def curl_fingers(rig):
    """
    Na pose de descanso os dedos ficavam retos e abertos (pose T do arquivo). Dobra um
    pouco cada falange e fixa como descanso: a mão fica relaxada. Mesmo processo de
    gq.set_rest_pose (aplica uma cópia do modificador nas malhas e depois o esqueleto).
    """
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    n = 0
    for pb in rig.pose.bones:
        m = re.match(r"(thumb|index|middle|ring|pinky)_(0[123])_[lr]$", pb.name)
        if not m:
            continue
        deg = (THUMB_CURL if m.group(1) == "thumb" else FINGER_CURL)[m.group(2)]
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = Quaternion((1, 0, 0), math.radians(deg))
        n += 1
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()
    for o in [o for o in bpy.data.objects if o.type == "MESH"]:
        mods = [m for m in o.modifiers if m.type == "ARMATURE"]
        if not mods:
            continue
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_copy(modifier=mods[0].name)
        copy = o.modifiers[-1]
        bpy.ops.object.modifier_move_to_index(modifier=copy.name, index=0)
        bpy.ops.object.modifier_apply(modifier=copy.name)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    log(f"dedos levemente dobrados: {n} falanges")


def shrink_textures(size=1024):
    """Texturas de 2048 px para 1024: o arquivo cai quase pela metade e na tela quase não muda."""
    n = 0
    for img in bpy.data.images:
        w, h = img.size
        if w > size or h > size:
            img.scale(min(w, size), min(h, size))
            if img.packed_file or img.is_dirty:
                img.pack()
            n += 1
    log(f"texturas reduzidas para {size} px: {n}")


def main():
    rig, meshes = import_model()
    face_front(rig, meshes)
    rename_bones(rig, meshes)
    named = rename_meshes(meshes)
    body = named["corpo"]
    if "sobrancelha" in named and "olhos" in named:
        split_brows_lashes(named["sobrancelha"], named["olhos"])

    if "roupa_intima" in named:
        split_underwear(named["roupa_intima"], rig)

    gq.set_rest_pose(rig)
    curl_fingers(rig)
    smooth_body(body)
    neutral_skin(body)
    body["estilo"] = "estilizado"  # o app usa o material de pele liso (sem poros)
    gq.gray_hair_textures()
    gq.add_body_keys(body, rig)
    # Os pesos do pescoço deste modelo descem até o peito: só com os ossos do tronco a
    # camiseta parava ali, com a borda serrilhada. Inclui o pescoço e deixa a gola
    # redonda (round_neckline) recortar a abertura.
    torso = gq.TORSO_BONES
    gq.TORSO_BONES = torso + ("neck_01",)
    gq.make_shirt(body, rig)
    # Versão de manga comprida (suéter, blusa de manga longa); bit 3 (0 camiseta, 1 calça, 2 tênis).
    gq.make_shirt(body, rig, name=gq.LONG_SHIRT_NAME, long_sleeves=True, bit=3)
    gq.TORSO_BONES = torso
    round_neckline(bpy.data.objects[gq.SHIRT_NAME], body, rig)
    round_neckline(bpy.data.objects[gq.LONG_SHIRT_NAME], body, rig, bit=3)
    gq.make_pants_and_shoes(body, rig)
    drop_shoes(body)
    gq.add_idle(rig)
    shrink_textures()

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format="GLB",
        use_selection=False,
        export_apply=False,
        export_yup=True,
        export_morph=True,
        export_morph_normal=False,
        export_skins=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_extras=True,
        export_vertex_color="ACTIVE",
        export_image_format="WEBP",
        export_image_quality=85,
    )
    log("exportado:", OUT, os.path.getsize(OUT) // 1024, "KB")
    for o in bpy.data.objects:
        log("objeto", o.name, o.type, len(o.data.vertices) if o.type == "MESH" else "")


main()
