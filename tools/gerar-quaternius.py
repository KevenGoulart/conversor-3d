"""
Gera public/models/personagem.glb (o modelo padrão do app) a partir do pacote "Universal Base Characters"
do Quaternius (CC0, https://quaternius.itch.io/universal-base-characters), versão Standard.

Uso:
    blender --background --python tools/gerar-quaternius.py -- <pasta do pacote extraído> \
        public/models/personagem.glb [--masculino]

<pasta do pacote> é a pasta "Universal Base Characters[Standard]" de dentro do .zip.

O que o script faz (ver docs/modelo-realista.md para a convenção de nomes do app):
  - importa o corpo (Superhero feminino ou masculino) e os cabelos "Rigged to Head Bone",
    religando os cabelos ao esqueleto do corpo (cada arquivo traz uma cópia dele)
  - baixa os braços da pose T para uma pose A (como o modelo do MakeHuman) e fixa essa
    pose como a de descanso
  - renomeia para a convenção do app: corpo, cabelo_*, sobrancelha; osso Head → head
  - tira a cor média da textura da pele (o app escolhe o tom multiplicando a cor)
  - cria shape keys de corpo por deformação: peso, músculo e quadril
  - cria a animação "idle" (respiração e leve balanço)
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Quaternion, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) < 2 and __name__ == "__main__":
    raise SystemExit("uso: -- <pasta do pacote> <saida.glb> [--masculino]")
PACK = os.path.abspath(argv[0]) if argv else ""
OUT = os.path.abspath(argv[1]) if len(argv) > 1 else ""
MALE = "--masculino" in argv
# Corpo "Stylized Female" do Human Base Meshes da Blender Studio no lugar do corpo do
# Quaternius (ver tools/corpo_blender.py); o esqueleto e os cabelos continuam do Quaternius.
BLEND_BODY = os.path.abspath(argv[argv.index("--corpo-blender") + 1]) if "--corpo-blender" in argv else None

BODY_FILE = "Superhero_Male_FullBody.gltf" if MALE else "Superhero_Female_FullBody.gltf"
# "Light"/"Dark" no pacote é a cor da roupa íntima pintada na pele (cinza-claro ou preta).
SKIN_TEXTURE = "T_Superhero_Male_Dark.png" if MALE else "T_Superhero_Female_Dark_BaseColor.png"
HAIR_DIR = os.path.join("Hairstyles", "Rigged to Head Bone", "glTF (Godot -Unreal)")
# arquivo do pacote → nome no .glb (cabelo_coque é o padrão do app)
HAIRS = {
    "Hair_Buns": "cabelo_coque",
    "Hair_Long": "cabelo_longo",
    "Hair_SimpleParted": "cabelo_repartido",
    "Hair_BuzzedFemale": "cabelo_curtinho",
    "Hair_Buzzed": "cabelo_raspado",
}
if MALE:
    HAIRS["Hair_Beard"] = "cabelo_barba"

# Braço abaixo da horizontal na pose de descanso (o app ainda baixa um pouco mais).
ARM_DOWN_DEG = 48


def log(*a):
    print("[gerar-quaternius]", *a, flush=True)


def import_gltf(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def main():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)

    # 1) Corpo + esqueleto ----------------------------------------------------------
    objs = import_gltf(os.path.join(PACK, "Base Characters", "Godot - UE", BODY_FILE))
    rig = next(o for o in objs if o.type == "ARMATURE")
    rig.name = rig.data.name = "Armature"
    for o in objs:
        if o.type == "MESH" and o.name.startswith("Icosphere"):
            bpy.data.objects.remove(o, do_unlink=True)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    body = max(meshes, key=lambda o: len(o.data.vertices))
    body.name = body.data.name = "corpo"
    for o in meshes:
        if o.name.lower().startswith("eyebrow"):
            o.name = o.data.name = "sobrancelha"
        elif o.name.lower().startswith("eyes"):
            o.name = o.data.name = "olhos"
    log("corpo:", len(body.data.vertices), "vértices; ossos:", len(rig.data.bones))

    # 2) Cabelos, religados ao esqueleto do corpo ------------------------------------
    for src, name in HAIRS.items():
        path = os.path.join(PACK, HAIR_DIR, src + ".gltf")
        if not os.path.isfile(path):
            log("cabelo não encontrado, pulando:", path)
            continue
        new = import_gltf(path)
        # Cada arquivo traz uma esfera auxiliar (Icosphere) além do cabelo.
        for o in [o for o in new if o.type == "MESH" and o.name.startswith("Icosphere")]:
            new.remove(o)
            bpy.data.objects.remove(o, do_unlink=True)
        for o in new:
            if o.type != "MESH":
                continue
            mw = o.matrix_world.copy()
            o.parent = rig
            o.matrix_world = mw
            for m in o.modifiers:
                if m.type == "ARMATURE":
                    m.object = rig
            o.name = o.data.name = name
        for o in new:
            if o.type == "ARMATURE" or (o.type == "EMPTY"):
                bpy.data.objects.remove(o, do_unlink=True)
        log("cabelo:", name)
    # Restos de nós vazios da importação.
    for o in list(bpy.data.objects):
        if o.type == "EMPTY":
            bpy.data.objects.remove(o, do_unlink=True)

    for o in bpy.data.objects:
        if o.type == "MESH":
            simplify_mesh(o)

    # 3) Pose A como descanso --------------------------------------------------------
    set_rest_pose(rig)
    swap_eyebrows(rig)  # vem com o osso "Head"; renomeado abaixo

    # 4) Nome do osso da cabeça (o app e as poses usam "head") -----------------------
    if "Head" in rig.data.bones:
        rig.data.bones["Head"].name = "head"
    for o in bpy.data.objects:
        if o.type == "MESH" and "Head" in o.vertex_groups:
            o.vertex_groups["Head"].name = "head"

    if BLEND_BODY:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import corpo_blender

        hairs = [o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith("cabelo_")]
        body = corpo_blender.replace_body(BLEND_BODY, rig, body, bpy.data.objects.get("olhos"), hairs,
                                          bpy.data.objects.get("sobrancelha"))
        skin = bpy.data.materials.new("pele")
        skin.use_nodes = True
        bsdf = skin.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = (1, 1, 1, 1)
        bsdf.inputs["Roughness"].default_value = 0.6
        attr = skin.node_tree.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "Col"
        skin.node_tree.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
        body.data.materials.clear()
        body.data.materials.append(skin)
    elif not MALE:
        feminize_face(body, rig)
        reshape_face(body, rig)
        soften_features(body)

    # 5) Pele sem cor média ------------------------------------------------------------
    if not BLEND_BODY:
        neutral_skin(body)
    body["estilo"] = "estilizado"  # o app usa o material de pele liso (sem poros)
    gray_hair_textures()

    # 6) Shape keys de corpo --------------------------------------------------------
    add_body_keys(body, rig)

    # 6b) Camiseta lisa, feita a partir do próprio corpo ------------------------------
    make_shirt(body, rig)
    make_pants_and_shoes(body, rig)

    # 7) Animação ---------------------------------------------------------------------
    add_idle(rig)

    # 8) Exporta ----------------------------------------------------------------------
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


def set_rest_pose(rig):
    """Gira os braços para baixo, aplica a deformação nas malhas e fixa como descanso."""
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    for side, s in (("l", 1), ("r", -1)):
        name = f"upperarm_{side}"
        if name not in rig.pose.bones:
            continue
        pb = rig.pose.bones[name]
        rest = rig.data.bones[name].matrix_local.to_3x3()
        # Eixo Y do Blender = frente/trás; braço esquerdo em +X desce girando em -Y.
        axis = (rest.inverted() @ Vector((0, s, 0))).normalized()
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = Quaternion(axis, math.radians(ARM_DOWN_DEG))
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()

    for o in [o for o in bpy.data.objects if o.type == "MESH"]:
        mods = [m for m in o.modifiers if m.type == "ARMATURE"]
        if not mods:
            continue
        bpy.context.view_layer.objects.active = o
        # Aplica uma cópia do modificador (a malha fica na pose nova) e mantém o original.
        bpy.ops.object.modifier_copy(modifier=mods[0].name)
        copy = o.modifiers[-1]
        bpy.ops.object.modifier_move_to_index(modifier=copy.name, index=0)
        bpy.ops.object.modifier_apply(modifier=copy.name)

    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    log(f"pose de descanso: braços {ARM_DOWN_DEG}° abaixo da horizontal")


def simplify_mesh(o):
    """
    Tira o que só serve à Unreal: cores de vértice (o material multiplicava a textura
    por elas) e UVs extras. A textura de cor vai direto para a cor base.
    """
    me = o.data
    for a in list(me.color_attributes):
        me.color_attributes.remove(a)
    while len(me.uv_layers) > 1:
        me.uv_layers.remove(me.uv_layers[-1])
    for mat in me.materials:
        if not mat or not mat.use_nodes:
            continue
        nt = mat.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        for n in list(nt.nodes):
            if n.type == "MIX" and any(l.to_socket == bsdf.inputs["Base Color"] for l in n.outputs[2].links):
                src = next((l.from_socket for l in nt.links if l.to_node == n and l.from_node.type == "TEX_IMAGE"), None)
                nt.nodes.remove(n)
                if src:
                    nt.links.new(src, bsdf.inputs["Base Color"])
            elif n.type == "VERTEX_COLOR":
                nt.nodes.remove(n)
            elif n.type == "TEX_IMAGE" and (n.image is None or n.image.size[0] == 0):
                # Imagem que a importação não achou: sairia no .glb sem fonte e o
                # three.js recusa o arquivo inteiro.
                log("textura sem imagem removida:", mat.name, n.name)
                nt.nodes.remove(n)


def soften_face_paint(px, w, h):
    """
    A pintura do rosto (canto de cima à esquerda do atlas) tem sulcos escuros marcados
    (bigode chinês, olheiras, linhas da testa) que dão o ar duro. Clareia só o que é
    mais escuro que a vizinhança, o que apaga as linhas e mantém olhos e lábios.
    """
    img = px.reshape(h, w, 4)  # linha 0 = base da imagem (Blender)
    x1, y0 = int(w * 0.37), int(h * (1 - 0.36))
    reg = img[y0:, :x1, :3].copy()
    blur = reg.copy()
    for _ in range(3):  # caixa 9x9 aproximada por médias repetidas
        acc = np.zeros_like(blur)
        for dy in range(-4, 5, 2):
            for dx in range(-4, 5, 2):
                acc += np.roll(np.roll(blur, dy, 0), dx, 1)
        blur = acc / 25
    lum = reg @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    blum = blur @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    dark = np.clip((blum - lum) / 0.08, 0, 1)[..., None]  # mais escuro que a vizinhança
    # Olhos e boca ficam (são escuros de propósito): pela saturação/vermelho dos lábios e
    # pelo escuro forte dos olhos.
    keep = (lum < 0.25)[..., None] | ((reg[..., 0] - reg[..., 2]) > 0.45)[..., None]
    mix = np.where(keep, 0.0, dark * 0.75)
    img[y0:, :x1, :3] = reg * (1 - mix) + blur * mix
    log("pintura do rosto suavizada")


def neutral_skin(body):
    """Divide a textura de cor pela cor mediana da pele: o app multiplica pelo tom escolhido."""
    mat = body.data.materials[0]
    tex = next((n for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and n.image and "BaseColor" in n.image.name
                or n.type == "TEX_IMAGE" and n.image and n.image.name.endswith(("_Dark", "_Ligh"))), None)
    src = os.path.join(PACK, "Base Characters", "Textures", SKIN_TEXTURE)
    if tex is None or not os.path.isfile(src):
        log("textura da pele não encontrada; mantendo a original")
        return
    img = bpy.data.images.load(src, check_existing=False)
    px = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    lum = px[:, :3] @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    skin = lum > 0.25  # tira a roupa íntima (preta) e o fundo do atlas
    med = np.median(px[skin, :3], axis=0)
    px[:, :3] = np.clip(px[:, :3] / np.maximum(med, 1e-3) * 0.92, 0, 1)
    if not MALE:
        soften_face_paint(px, img.size[0], img.size[1])
    img.pixels.foreach_set(px.ravel())
    import tempfile

    # Fora de public/: só serve de passagem até a textura entrar no .glb.
    out = os.path.join(tempfile.gettempdir(), "pele-quaternius.png")
    img.filepath_raw = out
    img.file_format = "PNG"
    img.save()
    tex.image = img
    log("pele sem cor média; mediana", np.round(med, 3))


# Quanto cada região engorda/ganha músculo (pelo osso de maior peso de cada vértice).
FAT = {
    "pelvis": 1.0, "spine_01": 1.2, "spine_02": 1.0, "spine_03": 0.7, "neck_01": 0.35,
    "clavicle": 0.4, "upperarm": 0.75, "lowerarm": 0.45, "thigh": 1.0, "calf": 0.55,
}
MUSCLE = {
    "spine_03": 0.8, "spine_02": 0.4, "clavicle": 0.9, "neck_01": 0.4,
    "upperarm": 1.0, "lowerarm": 0.7, "thigh": 0.8, "calf": 0.6,
}
HIP = {"pelvis": 1.0, "thigh": 0.8, "spine_01": 0.35}


def region_factor(table, bone):
    for k, v in table.items():
        if bone == k or bone.startswith(k + "_"):
            return v
    return 0.0


def add_body_keys(body, rig):
    """
    Shape keys por deformação, já que o pacote não traz nenhuma: cada vértice anda ao
    longo da normal (média entre as cópias da costura UV, para não abrir a malha) na
    medida da região do corpo a que pertence. O fator de cada região é misturado pelos
    pesos do esqueleto, então as transições (cotovelo, ombro) ficam suaves.
    """
    me = body.data
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float64)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    nor = np.empty(n * 3, dtype=np.float64)
    me.vertices.foreach_get("normal", nor)
    nor = nor.reshape(-1, 3)
    # Normais iguais nas cópias de um mesmo ponto.
    key = np.round(co, 5)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.ravel()
    acc = np.zeros((inv.max() + 1, 3))
    np.add.at(acc, inv, nor)
    acc /= np.maximum(np.linalg.norm(acc, axis=1, keepdims=True), 1e-9)
    nor = acc[inv]

    names = {g.index: g.name for g in body.vertex_groups}

    def field(table):
        f = np.zeros(n)
        for v in me.vertices:
            tot = sum(g.weight for g in v.groups)
            if tot <= 0:
                continue
            f[v.index] = sum(region_factor(table, names.get(g.group, "")) * g.weight for g in v.groups) / tot
        return f

    fat, mus, hip = field(FAT), field(MUSCLE), field(HIP)
    # Escala do modelo (o app normaliza a altura; aqui é a do arquivo).
    height = co[:, 2].max() - co[:, 2].min()
    k = height / 1.8
    # Barriga: o ganho de peso vai mais para a frente do tronco.
    front = np.clip(-nor[:, 1], 0, 1)  # frente = -Y no Blender
    belly = fat * (0.6 + 0.8 * front)
    side = np.abs(nor[:, 0])

    if not me.shape_keys:
        body.shape_key_add(name="Basis", from_mix=False)
    keys = {
        "peso_mais": co + nor * (belly * 0.032 * k)[:, None],
        "peso_menos": co - nor * (fat * 0.014 * k)[:, None],
        "musculo_mais": co + nor * (mus * 0.014 * k)[:, None],
        "musculo_menos": co - nor * (mus * 0.007 * k)[:, None],
        "quadril_mais": co + nor * (hip * side * 0.03 * k)[:, None],
        "quadril_menos": co - nor * (hip * side * 0.015 * k)[:, None],
    }
    for name, pos in keys.items():
        sk = body.shape_key_add(name=name, from_mix=False)
        sk.data.foreach_set("co", pos.ravel())
        sk.value = 0.0
        log(f"shape key {name}: máx {np.abs(pos - co).max() / k * 100:.1f} cm")


SHIRT_NAME = "cima_camiseta"
SHIRT_SLEEVE = 0.62  # comprimento da manga, em fração do osso do braço
LONG_SHIRT_NAME = "cima_manga_longa"
LONG_SLEEVE = 0.9  # manga comprida: até perto do pulso, em fração do antebraço
SHIRT_GAP = 0.012  # distância da pele, em m (para 1,80 m de altura)
TORSO_BONES = ("pelvis", "spine_01", "spine_02", "spine_03", "clavicle_l", "clavicle_r")


def make_shirt(body, rig, name=SHIRT_NAME, long_sleeves=False, bit=0):
    """
    Camiseta lisa (cima_camiseta) para o app pintar e estampar. O pacote não traz
    roupas, então ela sai do próprio corpo: as faces do tronco e do começo dos braços
    são copiadas (com os pesos do esqueleto e as shape keys), afastadas da pele e
    suavizadas para não colar em cada curva. O UV é refeito em dois painéis em pé,
    frente e costas, e os retângulos do tronco em cada um vão para os extras
    (uv_frente / uv_costas), como na camiseta do MakeHuman. A pele embaixo dela é
    marcada para o app esconder (atributo _oculta, bit `bit`). Com long_sleeves, a manga
    cobre o braço todo e o antebraço até LONG_SLEEVE (suéter, blusa de manga longa).
    """
    import bmesh
    from mathutils.bvhtree import BVHTree

    mw = body.matrix_world
    me = body.data
    names = {g.index: g.name for g in body.vertex_groups}
    co_w = [mw @ v.co for v in me.vertices]
    height = max(p.z for p in co_w) - min(p.z for p in co_w)
    k = height / 1.8

    def bone_pts(name):
        b = rig.data.bones[name]
        return rig.matrix_world @ b.head_local, rig.matrix_world @ b.tail_local

    arms = {s: bone_pts(f"upperarm_{s}") for s in ("l", "r")}
    forearms = {s: bone_pts(f"lowerarm_{s}") for s in ("l", "r")} if long_sleeves else {}

    def dominant(v):
        g = max(v.groups, key=lambda g: g.weight, default=None)
        return names.get(g.group, "") if g else ""

    # Barra no quadril, um pouco acima da virilha (o ponto mais alto entre as pernas).
    crotch_z = max((co_w[v.index].z for v in me.vertices
                    if abs(co_w[v.index].x) < 0.02 * k and dominant(v).startswith("thigh_")),
                   default=bone_pts("pelvis")[0].z - 0.08 * k)
    hem_z = crotch_z + 0.05 * k

    # covered = embaixo da camiseta (pele escondida); wide = folga para o corte reto
    # depois (os planos da barra e das mangas cortam as faces no meio).
    covered, wide, on_arm = [], [], []
    for v in me.vertices:
        bone, p = dominant(v), co_w[v.index]
        ok = ok_wide = False
        if bone in TORSO_BONES:
            ok, ok_wide = p.z > hem_z, p.z > hem_z - 0.06 * k
        elif bone.startswith("upperarm_") and long_sleeves:
            ok = ok_wide = True
        elif bone.startswith("upperarm_"):
            a, b = arms[bone[-1]]
            d = b - a
            t = (p - a).dot(d) / d.length_squared
            ok, ok_wide = t < SHIRT_SLEEVE, t < SHIRT_SLEEVE + 0.2
        elif bone.startswith("lowerarm_") and long_sleeves:
            a, b = forearms[bone[-1]]
            d = b - a
            t = (p - a).dot(d) / d.length_squared
            ok, ok_wide = t < LONG_SLEEVE, t < LONG_SLEEVE + 0.12
        elif bone.startswith("thigh_"):
            # Lateral do quadril: entra só para a barra sair reta no corte.
            ok, ok_wide = p.z > hem_z, p.z > hem_z - 0.06 * k
        covered.append(ok)
        wide.append(ok_wide)
        # Parte do braço onde fica o corte da manga (antebraço, na manga comprida).
        cut_bone = "lowerarm_" if long_sleeves else "upperarm_"
        on_arm.append(bone[-1] if bone.startswith(cut_bone) else "")

    shirt = body.copy()
    shirt.data = body.data.copy()
    bpy.context.collection.objects.link(shirt)
    shirt.name = shirt.data.name = name
    for key in ("estilo",):
        if key in shirt:
            del shirt[key]

    bm = bmesh.new()
    bm.from_mesh(shirt.data)
    bm.verts.ensure_lookup_table()
    side_of = {f: max("lr", key=lambda s: sum(on_arm[v.index] == s for v in f.verts)) for f in bm.faces}
    arm_face = {f: sum(on_arm[v.index] != "" for v in f.verts) * 2 > len(f.verts) for f in bm.faces}
    drop = [f for f in bm.faces if sum(wide[v.index] for v in f.verts) * 2 <= len(f.verts)]
    bmesh.ops.delete(bm, geom=drop, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    # Cortes retos: mangas (plano perpendicular ao braço, só nas faces do braço) e barra.
    inv = shirt.matrix_world.inverted()
    for s_ in "lr":
        a, b = forearms[s_] if long_sleeves else arms[s_]
        cut = a + (b - a) * (LONG_SLEEVE if long_sleeves else SHIRT_SLEEVE)
        faces = [f for f in bm.faces if f.is_valid and arm_face.get(f) and side_of.get(f) == s_]
        if faces:
            geom = list({x for f in faces for x in (*f.verts, *f.edges)}) + faces
            bmesh.ops.bisect_plane(bm, geom=geom, plane_co=inv @ cut,
                                   plane_no=(inv.to_3x3() @ (b - a)).normalized(), clear_outer=True)
    hem_local = inv @ Vector((0, 0, hem_z))
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=hem_local,
                           plane_no=(inv.to_3x3() @ Vector((0, 0, 1))).normalized(), clear_inner=True)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    # Pedaços soltos (uma face isolada na axila etc.).
    bm.verts.ensure_lookup_table()
    seen, islands = set(), []
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
        islands.append(isl)
    # Só fragmentos minúsculos: a malha do glTF já vem dividida nas costuras do UV,
    # então as partes grandes (frente, costas, mangas) são ilhas separadas.
    for isl in islands:
        if len(isl) < 12:
            bmesh.ops.delete(bm, geom=isl, context="VERTS")

    # Afasta da pele (normal média entre cópias da costura) e suaviza.
    bm.verts.ensure_lookup_table()
    pos = {v: v.co.copy() for v in bm.verts}
    groups = {}
    for v in bm.verts:
        groups.setdefault(tuple(round(c, 5) for c in v.co), []).append(v)
    for vs in groups.values():
        n = sum((v.normal for v in vs), Vector()).normalized()
        for v in vs:
            pos[v] = v.co + n * SHIRT_GAP * k
    boundary = {v for v in bm.verts if v.is_boundary}
    for _ in range(6):
        new = {}
        for v in bm.verts:
            nb = [e.other_vert(v) for e in v.link_edges]
            if not nb or v in boundary:
                new[v] = pos[v]
                continue
            avg = sum((pos[u] for u in nb), Vector()) / len(nb)
            new[v] = pos[v] * 0.5 + avg * 0.5
        pos = new
    # Nunca dentro do corpo.
    tree_bm = bmesh.new()
    tree_bm.from_mesh(body.data)
    tree = BVHTree.FromBMesh(tree_bm)
    tree_bm.free()
    min_gap = SHIRT_GAP * 0.6 * k
    for v in bm.verts:
        loc, nor, _, _ = tree.find_nearest(pos[v])
        if loc is None:
            continue
        d = (pos[v] - loc).dot(nor)
        if d < min_gap:
            pos[v] = pos[v] + nor * (min_gap - d)
    # Cópias da costura UV no mesmo lugar (senão a camiseta rasga ao suavizar).
    for vs in groups.values():
        c = sum((pos[v] for v in vs), Vector()) / len(vs)
        for v in vs:
            pos[v] = c
    disp = {v: pos[v] - v.co for v in bm.verts}
    for layer in bm.verts.layers.shape.values():
        for v in bm.verts:
            v[layer] = v[layer] + disp[v]
    for v in bm.verts:
        v.co = pos[v]

    # UV: dois painéis em pé (frente | costas).
    uv = bm.loops.layers.uv.verify()
    pts = [shirt.matrix_world @ v.co for v in bm.verts]
    X = max(abs(p.x) for p in pts)
    zmin, zmax = min(p.z for p in pts), max(p.z for p in pts)

    def u_front(x):
        return 0.02 + 0.46 * (x + X) / (2 * X)

    def u_back(x):
        return 0.52 + 0.46 * (X - x) / (2 * X)

    def v_of(z):
        return 0.02 + 0.96 * (z - zmin) / (zmax - zmin)

    for f in bm.faces:
        front = (shirt.matrix_world.to_3x3() @ f.normal).y < 0  # frente = -Y no Blender
        for loop in f.loops:
            p = shirt.matrix_world @ loop.vert.co
            loop[uv].uv = (u_front(p.x) if front else u_back(p.x), v_of(p.z))
    bm.to_mesh(shirt.data)
    bm.free()
    while len(shirt.data.uv_layers) > 1:
        shirt.data.uv_layers.remove(shirt.data.uv_layers[0])

    # Retângulo do tronco (largura do peito) em cada painel, em coordenadas de imagem.
    chest = max((abs(co_w[v.index].x) for v in me.vertices if dominant(v) == "spine_02"), default=X * 0.5)
    w = chest + SHIRT_GAP * k
    y0, y1 = 1 - v_of(zmax), 1 - v_of(max(hem_z, zmin))
    shirt["uv_frente"] = [round(u_front(-w), 4), round(y0, 4), round(u_front(w), 4), round(y1, 4)]
    shirt["uv_costas"] = [round(u_back(w), 4), round(y0, 4), round(u_back(-w), 4), round(y1, 4)]

    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    b = mat.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (0.9, 0.9, 0.9, 1)
    b.inputs["Roughness"].default_value = 0.9
    mat.use_backface_culling = False  # a barra e as mangas são abertas
    shirt.data.materials.clear()
    shirt.data.materials.append(mat)

    # Pele escondida embaixo: só o interior coberto (a borda fica, sob a barra).
    inner = list(covered)
    for e in me.edges:
        a, b2 = e.vertices
        if covered[a] != covered[b2]:
            inner[a] = inner[b2] = False
    hide_skin(body, inner, bit)
    shirt["oculta_bit"] = bit
    log(f"camiseta: {len(shirt.data.vertices)} vértices; pele escondida: {sum(inner)} vértices;",
        "painéis", list(shirt["uv_frente"]), list(shirt["uv_costas"]))


def hide_skin(body, inner, bit):
    """Soma o bit da peça no atributo _oculta do corpo (o app descarta essa pele no shader)."""
    me = body.data
    attr = me.attributes.get("_oculta") or me.attributes.new("_oculta", "FLOAT", "POINT")
    cur = np.zeros(len(me.vertices), dtype=np.float32)
    attr.data.foreach_get("value", cur)
    cur += np.array(inner, dtype=np.float32) * float(1 << bit)
    attr.data.foreach_set("value", cur)


def make_fitted(body, rig, name, rule, cuts, gap, smooth_iters, bit, color, post=None):
    """
    Peça justa feita do próprio corpo, como a camiseta (calça, tênis): copia as faces
    da região (com pesos do esqueleto e shape keys), corta por planos retos, afasta
    `gap` da pele e suaviza. `rule(bone, p)` devolve (coberto, folga) por vértice;
    `cuts` são (ponto, normal, filtro de faces por osso) e apagam o lado da normal.
    """
    import bmesh
    from mathutils.bvhtree import BVHTree

    mw = body.matrix_world
    me = body.data
    names = {g.index: g.name for g in body.vertex_groups}
    co_w = [mw @ v.co for v in me.vertices]
    height = max(p.z for p in co_w) - min(p.z for p in co_w)
    k = height / 1.8

    def dominant(v):
        g = max(v.groups, key=lambda g: g.weight, default=None)
        return names.get(g.group, "") if g else ""

    bones = [dominant(v) for v in me.vertices]
    covered, wide = [], []
    for v in me.vertices:
        ok, ok_wide = rule(bones[v.index], co_w[v.index])
        covered.append(ok)
        wide.append(ok_wide)

    obj = body.copy()
    obj.data = body.data.copy()
    bpy.context.collection.objects.link(obj)
    obj.name = obj.data.name = name
    for key in ("estilo",):
        if key in obj:
            del obj[key]

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    face_bone = {}
    for f in bm.faces:
        cnt = {}
        for v in f.verts:
            cnt[bones[v.index]] = cnt.get(bones[v.index], 0) + 1
        face_bone[f] = max(cnt, key=cnt.get)
    drop = [f for f in bm.faces if sum(wide[v.index] for v in f.verts) * 2 <= len(f.verts)]
    bmesh.ops.delete(bm, geom=drop, context="FACES")
    inv = obj.matrix_world.inverted()
    for point, normal, only in cuts:
        faces = [f for f in bm.faces if f.is_valid and (only is None or only(face_bone.get(f, "")))]
        if not faces:
            continue
        geom = list({x for f in faces for x in (*f.verts, *f.edges)}) + faces
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=inv @ point,
                               plane_no=(inv.to_3x3() @ normal).normalized(), clear_outer=True)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")

    bm.verts.ensure_lookup_table()
    groups = {}
    for v in bm.verts:
        groups.setdefault(tuple(round(c, 5) for c in v.co), []).append(v)
    pos = {}
    for vs in groups.values():
        n = sum((v.normal for v in vs), Vector()).normalized()
        for v in vs:
            pos[v] = v.co + n * gap * k
    boundary = {v for v in bm.verts if v.is_boundary}
    for _ in range(smooth_iters):
        new = {}
        for v in bm.verts:
            nb = [e.other_vert(v) for e in v.link_edges]
            if not nb or v in boundary:
                new[v] = pos[v]
                continue
            new[v] = pos[v] * 0.5 + (sum((pos[u] for u in nb), Vector()) / len(nb)) * 0.5
        pos = new
    tree_bm = bmesh.new()
    tree_bm.from_mesh(body.data)
    tree = BVHTree.FromBMesh(tree_bm)
    tree_bm.free()
    min_gap = gap * 0.6 * k
    for v in bm.verts:
        loc, nor, _, _ = tree.find_nearest(pos[v])
        if loc is not None:
            d = (pos[v] - loc).dot(nor)
            if d < min_gap:
                pos[v] = pos[v] + nor * (min_gap - d)
    if post:
        post(pos, k)
    for vs in groups.values():
        c = sum((pos[v] for v in vs), Vector()) / len(vs)
        for v in vs:
            pos[v] = c
    disp = {v: pos[v] - v.co for v in bm.verts}
    for layer in bm.verts.layers.shape.values():
        for v in bm.verts:
            v[layer] = v[layer] + disp[v]
    for v in bm.verts:
        v.co = pos[v]
    bm.to_mesh(obj.data)
    bm.free()

    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    b = mat.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = 0.85
    mat.use_backface_culling = False
    obj.data.materials.clear()
    obj.data.materials.append(mat)

    inner = list(covered)
    for e in me.edges:
        a, b2 = e.vertices
        if covered[a] != covered[b2]:
            inner[a] = inner[b2] = False
    hide_skin(body, inner, bit)
    obj["oculta_bit"] = bit
    log(f"{name}: {len(obj.data.vertices)} vértices; pele escondida: {sum(inner)} vértices")
    return obj


def make_pants_and_shoes(body, rig):
    mw = body.matrix_world
    zs = [(mw @ v.co).z for v in body.data.vertices]
    k = (max(zs) - min(zs)) / 1.8
    floor = min(zs)

    def pts(name):
        b = rig.data.bones[name]
        return rig.matrix_world @ b.head_local, rig.matrix_world @ b.tail_local

    waist_z = pts("spine_01")[0].z + 0.02 * k
    calves = {s: pts(f"calf_{s}") for s in "lr"}

    def along(side, p):
        a, b = calves[side]
        d = b - a
        return (p - a).dot(d) / d.length_squared

    PANTS_END, SHOE_TOP = 0.88, 0.84  # a barra da calça termina dentro do tênis

    def pants_rule(bone, p):
        if bone.startswith("thigh_"):
            return True, True
        if bone.startswith("calf_"):
            t = along(bone[-1], p)
            return t < PANTS_END, t < PANTS_END + 0.15
        if bone in ("pelvis", "spine_01"):
            return p.z < waist_z, p.z < waist_z + 0.05 * k
        return False, False

    cuts = [(Vector((0, 0, waist_z)), Vector((0, 0, 1)), lambda bn: bn in ("pelvis", "spine_01", "spine_02"))]
    for s in "lr":
        a, b = calves[s]
        cuts.append((a + (b - a) * PANTS_END, b - a, lambda bn, s=s: bn == f"calf_{s}"))
    make_fitted(body, rig, "baixo_calca", pants_rule, cuts, gap=0.007, smooth_iters=4, bit=1,
                color=(0.85, 0.85, 0.85))

    make_shoes(body, rig, calves, SHOE_TOP, floor, k)


def make_shoes(body, rig, calves, shoe_top, floor, k):
    """
    Tênis: o casco convexo de cada pé (afastado da pele), cortado no tornozelo,
    suavizado e com a sola reta. O casco não tem dedos e o bico sai arredondado;
    copiar a pele do pé (como a calça) deixava a forma dos dedos à mostra.
    Os pesos do esqueleto vêm do corpo por proximidade (Data Transfer); os morphs
    de peso o app transfere sozinho para acessórios sem shape keys.
    """
    import bmesh

    mw = body.matrix_world
    me = body.data
    names = {g.index: g.name for g in body.vertex_groups}

    def dominant(v):
        g = max(v.groups, key=lambda g: g.weight, default=None)
        return names.get(g.group, "") if g else ""

    def along(side, p):
        a, b = calves[side]
        d = b - a
        return (p - a).dot(d) / d.length_squared

    gap = 0.009 * k
    covered = [False] * len(me.vertices)
    bm = bmesh.new()
    for side in "lr":
        hb = bmesh.new()
        for v in me.vertices:
            bone, p = dominant(v), mw @ v.co
            on = bone in (f"foot_{side}", f"ball_{side}", f"ball_leaf_{side}") or (
                bone == f"calf_{side}" and along(side, p) > shoe_top - 0.04)
            if not on:
                continue
            covered[v.index] = bone != f"calf_{side}" or along(side, p) > shoe_top
            hb.verts.new(p + (mw.to_3x3() @ v.normal).normalized() * gap)
        bmesh.ops.convex_hull(hb, input=hb.verts[:])
        bmesh.ops.delete(hb, geom=[v for v in hb.verts if not v.link_faces], context="VERTS")
        a, b = calves[side]
        cut = a + (b - a) * shoe_top
        bmesh.ops.bisect_plane(hb, geom=hb.verts[:] + hb.edges[:] + hb.faces[:], plane_co=cut,
                               plane_no=(a - b).normalized(), clear_outer=True)
        tmp = bpy.data.meshes.new("tmp")
        hb.to_mesh(tmp)
        hb.free()
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)

    shoe_me = bpy.data.meshes.new("sapato_tenis")
    bm.to_mesh(shoe_me)
    bm.free()
    shoe = bpy.data.objects.new("sapato_tenis", shoe_me)
    bpy.context.collection.objects.link(shoe)
    for p in shoe_me.polygons:
        p.use_smooth = True

    # Suaviza (arredonda as arestas do casco) e achata a sola.
    sub = shoe.modifiers.new("Subdivisao", "SUBSURF")
    sub.levels = sub.render_levels = 2
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = shoe
    shoe.select_set(True)
    bpy.ops.object.modifier_apply(modifier=sub.name)
    sole = floor - 0.004 * k
    for v in shoe_me.vertices:
        if v.co.z < floor + 0.012 * k:
            v.co.z = sole
    for p in shoe_me.polygons:
        p.use_smooth = True

    # Pesos do esqueleto copiados do corpo.
    for g in body.vertex_groups:
        shoe.vertex_groups.new(name=g.name)
    dt = shoe.modifiers.new("Pesos", "DATA_TRANSFER")
    dt.object = body
    dt.use_vert_data = True
    dt.data_types_verts = {"VGROUP_WEIGHTS"}
    dt.vert_mapping = "POLYINTERP_NEAREST"
    dt.layers_vgroup_select_src = "ALL"
    dt.layers_vgroup_select_dst = "NAME"
    bpy.ops.object.modifier_apply(modifier=dt.name)
    shoe.parent = rig
    arm = shoe.modifiers.new("Armature", "ARMATURE")
    arm.object = rig

    mat = bpy.data.materials.new("sapato_tenis")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.95, 0.95, 0.95, 1)
    bsdf.inputs["Roughness"].default_value = 0.6
    shoe_me.materials.append(mat)

    inner = list(covered)
    for e in me.edges:
        i, j = e.vertices
        if covered[i] != covered[j]:
            inner[i] = inner[j] = False
    hide_skin(body, inner, 2)
    shoe["oculta_bit"] = 2
    log(f"sapato_tenis: {len(shoe_me.vertices)} vértices; pele escondida: {sum(inner)} vértices")


def feminize_face(body, rig):
    """
    Rosto mais feminino (o pacote não traz shape keys de rosto): mandíbula e queixo mais
    estreitos e o queixo um pouco recuado, arco das sobrancelhas mais baixo e pescoço
    mais fino. Deformação pela posição (as cópias da costura UV andam juntas), aplicada
    também às sobrancelhas e aos olhos para não descolarem.
    """
    head = rig.data.bones["head"]
    h0 = rig.matrix_world @ head.head_local
    meshes = [o for o in bpy.data.objects if o.type == "MESH" and o.name in ("corpo", "sobrancelha", "olhos")]
    top = max((o.matrix_world @ v.co).z for v in body.data.vertices for o in [body])
    H = top - h0.z
    neck = rig.data.bones["neck_01"]
    n0 = rig.matrix_world @ neck.head_local

    def smooth(a, b, x):
        t = min(1.0, max(0.0, (x - a) / (b - a)))
        return t * t * (3 - 2 * t)

    def bump(x, a, b, c, d):
        return smooth(a, b, x) * (1 - smooth(c, d, x))

    moved = 0
    for o in meshes:
        mw, inv = o.matrix_world, o.matrix_world.inverted()
        front_y = min((mw @ v.co).y for v in o.data.vertices) if o is body else None
        for v in o.data.vertices:
            p = mw @ v.co
            u = (p.z - h0.z) / H  # 0 = base da cabeça, 1 = topo
            fr = smooth(h0.y + 0.02 * H, h0.y - 0.12 * H, p.y)  # frente do rosto (-Y)
            q = p.copy()
            # Mandíbula e queixo: estreita em x.
            jaw = bump(u, -0.05, 0.05, 0.2, 0.32)  # só o queixo (o formato vem em reshape_face)
            q.x = h0.x + (p.x - h0.x) * (1 - 0.1 * jaw)
            # Queixo um pouco para trás e menos marcado.
            chin = bump(u, 0.0, 0.08, 0.18, 0.28) * fr
            q.y += 0.022 * H * chin
            # Arco das sobrancelhas para trás.
            brow = bump(u, 0.5, 0.56, 0.62, 0.68) * fr
            q.y += 0.012 * H * brow
            # Pescoço mais fino.
            if p.z < h0.z + 0.02 * H and p.z > n0.z - 0.05 * H:
                nk = bump(p.z, n0.z - 0.05 * H, n0.z, h0.z - 0.02 * H, h0.z + 0.02 * H)
                q.x = n0.x + (q.x - n0.x) * (1 - 0.1 * nk)
                q.y = n0.y + (q.y - n0.y) * (1 - 0.06 * nk)
            if (q - p).length > 1e-6:
                v.co = inv @ q
                moved += 1
        o.data.update()
    log("rosto feminino:", moved, "vértices ajustados")


def reshape_face(body, rig):
    """
    Formato do rosto: a cabeça do "Superhero" é longa e estreita. Encurta o terço de
    baixo (dos olhos ao queixo, ~13%: o queixo sobe e a mandíbula vem junto) e alarga
    o meio do rosto (maçãs e bochechas), deixando o contorno mais redondo. Abaixo do
    queixo o deslocamento some aos poucos até o meio do pescoço. A mesma deformação
    vale para olhos, sobrancelhas e cabelos, para nada descolar.
    """
    eyes = bpy.data.objects.get("olhos")
    if eyes is None:
        return
    ew = [eyes.matrix_world @ v.co for v in eyes.data.vertices]
    eye_z = sum(p.z for p in ew) / len(ew)
    eye_y = min(p.y for p in ew)
    cx = sum(p.x for p in ew) / len(ew)
    eye_dist = max(p.x for p in ew) - min(p.x for p in ew)
    neck = rig.matrix_world @ rig.data.bones["neck_01"].head_local
    head = rig.matrix_world @ rig.data.bones["head"].head_local
    bw = [body.matrix_world @ v.co for v in body.data.vertices]
    # Queixo: o ponto mais baixo da frente do rosto (acima do pescoço).
    chin_z = min(p.z for p in bw if abs(p.x - cx) < eye_dist * 0.15 and p.y < eye_y + eye_dist * 0.3
                 and p.z > head.z - eye_dist * 0.6 and p.z < eye_z)
    top_z = max(p.z for p in bw)
    log("formato: olhos z", round(eye_z, 3), "queixo z", round(chin_z, 3), "topo", round(top_z, 3))

    SHORTEN, WIDEN = 0.13, 0.08
    fade_end = (neck.z + chin_z) / 2  # abaixo disso nada muda

    def smooth(a, b, x):
        t = min(1.0, max(0.0, (x - a) / (b - a)))
        return t * t * (3 - 2 * t)

    def lift(z):
        if z >= eye_z:
            return 0.0
        if z >= chin_z:
            return (eye_z - z) * SHORTEN
        return (eye_z - chin_z) * SHORTEN * smooth(fade_end, chin_z, z)

    def warp(p):
        q = p.copy()
        q.z += lift(p.z)
        # Alarga o meio do rosto (das maçãs à mandíbula), mais na frente.
        span = eye_z - chin_z
        mid = smooth(chin_z - span * 0.1, chin_z + span * 0.35, p.z) * (1 - smooth(eye_z, eye_z + span * 0.5, p.z))
        front = smooth(head.y + eye_dist * 0.6, eye_y + eye_dist * 0.5, p.y)
        q.x = cx + (p.x - cx) * (1 + WIDEN * mid * (0.4 + 0.6 * front))
        return q

    moved = 0
    for o in [o for o in bpy.data.objects if o.type == "MESH" and (
            o.name in ("corpo", "olhos", "sobrancelha") or o.name.startswith("cabelo_"))]:
        mw, inv = o.matrix_world, o.matrix_world.inverted()
        for v in o.data.vertices:
            p = mw @ v.co
            if p.z < fade_end - 0.01:
                continue
            q = warp(p)
            if (q - p).length > 1e-7:
                v.co = inv @ q
                moved += 1
        o.data.update()
    log("formato do rosto:", moved, "vértices")


def soften_features(body):
    """
    Traços mais delicados, a partir de marcos achados no próprio modelo: centro de cada
    olho (malha "olhos"), ponta do nariz (ponto mais à frente do rosto) e boca. Olhos
    um pouco maiores (pálpebras e globo juntos), nariz menor e lábios mais cheios.
    """
    eyes = bpy.data.objects.get("olhos")
    if eyes is None:
        log("sem malha dos olhos; traços não ajustados")
        return
    ew = [eyes.matrix_world @ v.co for v in eyes.data.vertices]
    centers, radius = {}, 0.0
    for sign in (1, -1):
        pts = [p for p in ew if p.x * sign > 0]
        c = sum(pts, Vector()) / len(pts)
        centers[sign] = c
        radius = max(radius, max((p - c).length for p in pts))
    eye_z = (centers[1].z + centers[-1].z) / 2
    eye_dist = (centers[1] - centers[-1]).length

    bw = [body.matrix_world @ v.co for v in body.data.vertices]
    face = [p for p in bw if abs(p.x) < eye_dist * 0.25 and eye_z - eye_dist * 1.6 < p.z < eye_z]
    nose = min(face, key=lambda p: p.y)  # frente = -Y
    # Boca: entre o nariz e o queixo, no ponto mais à frente abaixo do nariz.
    below = [p for p in face if nose.z - eye_dist * 0.9 < p.z < nose.z - eye_dist * 0.25]
    mouth = min(below, key=lambda p: p.y) if below else nose - Vector((0, 0, eye_dist * 0.5))
    log("marcos: olhos", [tuple(round(c, 3) for c in centers[s]) for s in (1, -1)],
        "nariz", tuple(round(c, 3) for c in nose), "boca", tuple(round(c, 3) for c in mouth))

    def fall(d, r):
        t = max(0.0, 1 - d / r)
        return t * t * (3 - 2 * t)

    def warp(p):
        q = p.copy()
        # Olhos 20% maiores (em volta do centro do globo).
        for c in centers.values():
            w = fall((p - c).length, radius * 2.4)
            q += (p - c) * 0.2 * w
        # Bochechas mais cheias: abaixo e por fora dos olhos, para fora do rosto.
        for c in centers.values():
            cheek = c + Vector((math.copysign(eye_dist * 0.25, c.x), 0, -eye_dist * 0.75))
            w = fall((p - cheek).length, eye_dist * 0.6)
            out = Vector((math.copysign(1, c.x) * 0.6, -0.8, 0)).normalized()
            q += out * eye_dist * 0.07 * w
        # Nariz 18% menor, em direção à base do nariz (entre os olhos e a ponta).
        base = Vector((0, nose.y + eye_dist * 0.35, nose.z + eye_dist * 0.15))
        w = fall((p - nose).length, eye_dist * 0.55)
        q += (base - p) * 0.28 * w
        # Lábios mais cheios: crescem na altura e um pouco para a frente.
        dm = p - mouth
        w = fall(math.sqrt((dm.x / 1.6) ** 2 + dm.y ** 2 + (dm.z * 1.3) ** 2), eye_dist * 0.42)
        q.z += dm.z * 0.38 * w
        q.y -= eye_dist * 0.04 * w
        return q

    moved = 0
    for o in [o for o in bpy.data.objects if o.type == "MESH" and o.name in ("corpo", "olhos", "sobrancelha")]:
        mw, inv = o.matrix_world, o.matrix_world.inverted()
        for v in o.data.vertices:
            p = mw @ v.co
            q = warp(p)
            if (q - p).length > 1e-7:
                v.co = inv @ q
                moved += 1
        o.data.update()
    log("traços suavizados:", moved, "vértices")

    # Sobrancelhas mais finas: cada uma achatada na altura em volta do próprio centro.
    brow = bpy.data.objects.get("sobrancelha")
    if brow:
        mw, inv = brow.matrix_world, brow.matrix_world.inverted()
        for sign in (1, -1):
            vs = [v for v in brow.data.vertices if (mw @ v.co).x * sign > 0]
            if not vs:
                continue
            c = sum((mw @ v.co for v in vs), Vector()) / len(vs)
            for v in vs:
                p = mw @ v.co
                p.z = c.z + (p.z - c.z) * 0.6
                v.co = inv @ p
        brow.data.update()
        log("sobrancelhas afinadas")


def swap_eyebrows(rig):
    """Troca a sobrancelha que vem com o corpo pela feminina do pacote (mais fina)."""
    path = os.path.join(PACK, HAIR_DIR, "Eyebrows_Female.gltf")
    if MALE or not os.path.isfile(path):
        return
    old = bpy.data.objects.get("sobrancelha")
    new = import_gltf(path)
    for o in [o for o in new if o.type == "MESH" and o.name.startswith("Icosphere")]:
        new.remove(o)
        bpy.data.objects.remove(o, do_unlink=True)
    for o in new:
        if o.type == "MESH":
            mw = o.matrix_world.copy()
            o.parent = rig
            o.matrix_world = mw
            for m in o.modifiers:
                if m.type == "ARMATURE":
                    m.object = rig
            if old:
                bpy.data.objects.remove(old, do_unlink=True)
                old = None
            o.name = o.data.name = "sobrancelha"
    for o in new:
        if o.name in bpy.data.objects and o.type in ("ARMATURE", "EMPTY"):
            bpy.data.objects.remove(o, do_unlink=True)
    log("sobrancelha feminina")


def gray_hair_textures():
    """
    Cabelo e sobrancelha em tons de cinza: o app multiplica pela cor escolhida e, com
    a textura marrom do pacote, o loiro saía esverdeado.
    """
    done = set()
    for o in bpy.data.objects:
        if o.type != "MESH" or not (o.name.startswith("cabelo_") or o.name == "sobrancelha"):
            continue
        for mat in o.data.materials:
            if not mat or not mat.use_nodes:
                continue
            bsdf = mat.node_tree.nodes.get("Principled BSDF")
            for l in bsdf.inputs["Base Color"].links:
                img = getattr(l.from_node, "image", None)
                if img is None or img.name in done:
                    continue
                done.add(img.name)
                px = np.empty(len(img.pixels), dtype=np.float32)
                img.pixels.foreach_get(px)
                px = px.reshape(-1, 4)
                lum = px[:, :3] @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
                top = float(np.percentile(lum, 97)) or 1.0
                g = np.clip(lum * (0.95 / top), 0, 1)
                px[:, 0] = px[:, 1] = px[:, 2] = g
                img.pixels.foreach_set(px.ravel())
                img.update()
                img.pack()
                log("cabelo em cinza:", img.name)


def add_idle(rig):
    """Animação curta em loop: respiração, cabeça e braços levemente mais baixos."""
    scene = bpy.context.scene
    scene.render.fps = 24
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    pbs = rig.pose.bones

    def world_rot(bone_name, axis, deg):
        rest = rig.data.bones[bone_name].matrix_local.to_3x3()
        local_axis = (rest.inverted() @ Vector(axis)).normalized()
        return Quaternion(local_axis, math.radians(deg))

    frames = [1, 49, 97]
    poses = {
        "spine_03": [("x", 0), ("x", -1.6), ("x", 0)],
        "neck_01": [("x", 0), ("x", 1.2), ("x", 0)],
        "head": [("z", -2), ("z", 2), ("z", -2)],
        "upperarm_l": [("y", 4), ("y", 6), ("y", 4)],
        "upperarm_r": [("y", -4), ("y", -6), ("y", -4)],
        "lowerarm_l": [("z", 6), ("z", 8), ("z", 6)],
        "lowerarm_r": [("z", -6), ("z", -8), ("z", -6)],
    }
    axes = {"x": (1, 0, 0), "y": (0, 1, 0), "z": (0, 0, 1)}
    for bone, keys in poses.items():
        if bone not in pbs:
            log("osso não encontrado, pulando:", bone)
            continue
        pb = pbs[bone]
        pb.rotation_mode = "XYZ"
        for f, (ax, deg) in zip(frames, keys):
            pb.rotation_euler = world_rot(bone, axes[ax], deg).to_euler("XYZ")
            pb.keyframe_insert("rotation_euler", frame=f)
    bpy.ops.object.mode_set(mode="OBJECT")
    act = rig.animation_data.action
    act.name = "idle"
    act.use_fake_user = True
    scene.frame_start, scene.frame_end = 1, 96
    for pb in pbs:
        pb.rotation_euler = (0, 0, 0)


if __name__ == "__main__":
    main()
