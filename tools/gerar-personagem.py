"""
Gera um personagem realista com o MPFB (MakeHuman para Blender). Não é mais o modelo padrão do app
(ver tools/gerar-quaternius.py); para usá-lo, gere direto em public/models/personagem.glb.

Uso (o Blender precisa ter a extensão MPFB instalada):
    blender --background --python tools/gerar-personagem.py -- public/models/personagem.glb [--feminino] [--branca]

O que sai no arquivo (ver docs/modelo-realista.md para a convenção de nomes):
  - corpo com esqueleto "game_engine" e shape keys: peso, musculo, idade, feminino/masculino,
    rosto_queixo, rosto_mandibula, rosto_nariz, rosto_bochechas, rosto_cabeca
  - olhos (esclera + iris + pupila) presos ao osso da cabeça
  - com o pacote de assets do MakeHuman instalado no MPFB: 10 cabelos, sobrancelha, cílios,
    6 sapatos e 4 peças de baixo (cortadas na cintura a partir das roupas do pacote)
  - sem o pacote: cabelos e sobrancelhas simples, gerados aqui, e legging auxiliar
  - baixo_saia (geometria auxiliar do próprio MakeHuman)
  - com o pacote: cima_camiseta, camiseta lisa para o app pintar e estampar com a foto
  - animação "idle" (respiração e leve balanço)
"""
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Quaternion, Vector

from bl_ext.blender_org.mpfb.entities.objectproperties import HumanObjectProperties
from bl_ext.blender_org.mpfb.services.humanservice import HumanService
from bl_ext.blender_org.mpfb.services.locationservice import LocationService
from bl_ext.blender_org.mpfb.services.targetservice import TargetService

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else "public/models/personagem.glb")
FEMALE = "--feminino" in argv
WHITE = "--branca" in argv
# Visual semi-estilizado (cabeça e olhos maiores, traços suaves, pele e cabelo com
# aspecto pintado) em vez do realista.
STYLIZED = "--estilizado" in argv

BASE = {
    "gender": 0.0 if FEMALE else 1.0,
    "age": 0.5,
    "muscle": 0.5,
    "weight": 0.5,
    "proportions": 0.6,
    "height": 0.5,
    "cupsize": 0.5,
    "firmness": 0.5,
    "race": {"asian": 0.0, "caucasian": 1.0, "african": 0.0} if WHITE else {"asian": 0.33, "caucasian": 0.34, "african": 0.33},
}

# Variações do corpo: nome da shape key -> valores de macro que mudam.
MACRO_VARIANTS = {
    "peso_mais": {"weight": 1.0},
    "peso_menos": {"weight": 0.0},
    "musculo_mais": {"muscle": 1.0},
    "musculo_menos": {"muscle": 0.0},
    "idade_mais": {"age": 0.8},
    "idade_menos": {"age": 0.38},
    ("masculino" if FEMALE else "feminino"): {"gender": 1.0 if FEMALE else 0.0},
}

# Variações do rosto: nome -> alvos do MakeHuman (caminho relativo, peso).
T = lambda *names: [(n, 1.0) for n in names]
TARGET_VARIANTS = {
    "rosto_queixo_mais": T("chin/chin-prominent-incr"),
    "rosto_queixo_menos": T("chin/chin-prominent-decr"),
    "rosto_mandibula_mais": T("chin/chin-width-incr"),
    "rosto_mandibula_menos": T("chin/chin-width-decr"),
    "rosto_nariz_mais": T("nose/nose-scale-horiz-incr", "nose/nose-scale-vert-incr"),
    "rosto_nariz_menos": T("nose/nose-scale-horiz-decr", "nose/nose-scale-vert-decr"),
    "rosto_bochechas_mais": T("cheek/l-cheek-volume-incr", "cheek/r-cheek-volume-incr"),
    "rosto_bochechas_menos": T("cheek/l-cheek-volume-decr", "cheek/r-cheek-volume-decr"),
    "rosto_cabeca_mais": T("head/head-scale-horiz-incr", "head/head-scale-vert-incr"),
    "rosto_cabeca_menos": T("head/head-scale-horiz-decr", "head/head-scale-vert-decr"),
}

# Rosto mais feminino, fixado na forma base com --feminino (os sliders do rosto
# continuam começando em 0). Pesos moderados para não caricaturar.
# Proporções do visual estilizado, fixadas na forma base (como o rosto feminino).
STYLIZED_SHAPE = [
    # Cabeça um pouco maior que a real, oval e magra (sem bochecha "inchada").
    ("head/head-scale-horiz-incr", 0.6),
    ("head/head-scale-vert-incr", 0.7),
    ("head/head-scale-depth-incr", 0.6),
    ("head/head-fat-decr", 0.8),
    ("head/head-invertedtriangular", 0.3),
    # Olhos grandes e amendoados, levemente puxados para cima no canto de fora.
    ("eyes/l-eye-scale-incr", 1.0),
    ("eyes/r-eye-scale-incr", 1.0),
    ("eyes/l-eye-height2-incr", 0.8),
    ("eyes/r-eye-height2-incr", 0.8),
    ("eyes/l-eye-corner2-up", 0.35),
    ("eyes/r-eye-corner2-up", 0.35),
    ("eyes/l-eye-bag-decr", 0.8),
    ("eyes/r-eye-bag-decr", 0.8),
    # Nariz pequeno, fino e arrebitado.
    ("nose/nose-scale-horiz-decr", 0.8),
    ("nose/nose-scale-vert-decr", 0.7),
    ("nose/nose-scale-depth-decr", 0.5),
    ("nose/nose-width1-decr", 0.5),
    ("nose/nose-width2-decr", 0.4),
    ("nose/nose-flaring-decr", 0.5),
    ("nose/nose-point-up", 0.25),
    # Lábios cheios e bem desenhados, cantos levemente para cima.
    ("mouth/mouth-upperlip-volume-incr", 0.4),
    ("mouth/mouth-lowerlip-volume-incr", 0.4),
    ("mouth/mouth-cupidsbow-incr", 0.4),
    ("mouth/mouth-scale-horiz-decr", 0.15),
    ("mouth/mouth-angles-up", 0.15),
    # Maçãs altas, bochecha lisa, mandíbula estreita e definida, queixo pequeno.
    ("cheek/l-cheek-bones-incr", 0.35),
    ("cheek/r-cheek-bones-incr", 0.35),
    ("cheek/l-cheek-volume-decr", 0.15),
    ("cheek/r-cheek-volume-decr", 0.15),
    ("cheek/l-cheek-inner-decr", 0.2),
    ("cheek/r-cheek-inner-decr", 0.2),
    ("chin/chin-width-decr", 0.3),
    ("chin/chin-bones-incr", 0.2),
    ("chin/chin-height-decr", 0.15),
    ("neck/neck-scale-horiz-decr", 0.3),
    ("neck/neck-double-decr", 1.0),
    ("ears/l-ear-scale-decr", 0.3),
    ("ears/r-ear-scale-decr", 0.3),
] if STYLIZED else []

FEMALE_FACE = [
    ("head/head-oval", 0.7),
    ("chin/chin-width-decr", 0.8),
    ("chin/chin-prominent-decr", 0.4),
    ("chin/chin-bones-decr", 0.6),
    ("chin/chin-height-decr", 0.2),
    ("nose/nose-scale-horiz-decr", 0.5),
    ("nose/nose-scale-vert-decr", 0.25),
    ("nose/nose-point-width-decr", 0.6),
    ("nose/nose-nostrils-width-decr", 0.3),
    ("nose/nose-point-up", 0.3),
    ("eyes/l-eye-scale-incr", 0.45),
    ("eyes/r-eye-scale-incr", 0.45),
    ("mouth/mouth-upperlip-volume-incr", 0.8),
    ("mouth/mouth-lowerlip-volume-incr", 0.8),
    ("mouth/mouth-cupidsbow-incr", 0.5),
    ("mouth/mouth-scale-horiz-decr", 0.2),
    ("eyes/l-eye-corner1-up", 0.3),
    ("eyes/r-eye-corner1-up", 0.3),
    ("cheek/l-cheek-bones-incr", 0.5),
    ("cheek/r-cheek-bones-incr", 0.5),
    ("eyebrows/eyebrows-trans-up", 0.35),
    ("neck/neck-scale-horiz-decr", 0.3),
] if FEMALE else []

# Geometrias auxiliares do MakeHuman que viram acessórios.
HELPER_ASSETS = {
    "helper-skirt": ("baixo_saia", (0.15, 0.2, 0.4), 0.9),
    "helper-tights": ("baixo_legging", (0.05, 0.05, 0.06), 0.85),
}

# Pacote de assets do MakeHuman (makehuman_system_assets, CC0), se instalado no MPFB.
# (pasta, asset, nome no .glb, cor, corte)
#   cor: "tint" = textura em tons de cinza para o app recolorir; "keep" = cores da textura.
#   corte: None, ("cintura", deslocamento em m) ou ("altura", z em m) — apaga o que fica acima
#   (a parte de cima das roupas, as meias dos sapatos) e também as mangas que descem até o pulso.
CUT_SOCKS = ("altura", 0.13)
PACK_ASSETS = [
    ("hair", "short02", "cabelo_curto", "tint", None),
    ("hair", "short01", "cabelo_curto-2", "tint", None),
    ("hair", "short03", "cabelo_curto-3", "tint", None),
    ("hair", "short04", "cabelo_curto-4", "tint", None),
    ("hair", "bob01", "cabelo_chanel", "tint", None),
    ("hair", "bob02", "cabelo_chanel-2", "tint", None),
    ("hair", "long01", "cabelo_longo", "tint", None),
    ("hair", "ponytail01", "cabelo_rabo-de-cavalo", "tint", None),
    ("hair", "braid01", "cabelo_trança", "tint", None),
    ("hair", "afro01", "cabelo_black-power", "tint", None),
    ("eyebrows", "eyebrow003" if STYLIZED else "eyebrow001", "sobrancelha", "tint", None),
    ("eyelashes", "eyelashes01", "cilios", "keep", None),
    ("clothes", "shoes05", "sapato_tênis-branco", "keep", CUT_SOCKS),
    ("clothes", "shoes06", "sapato_tênis-azul", "keep", CUT_SOCKS),
    ("clothes", "shoes02", "sapato_casual", "keep", CUT_SOCKS),
    ("clothes", "shoes01", "sapato_social-marrom", "keep", CUT_SOCKS),
    ("clothes", "shoes04", "sapato_social-preto", "keep", CUT_SOCKS),
    ("clothes", "shoes03", "sapato_bota", "keep", None),
    ("clothes", "male_casualsuit01", "baixo_calça-jeans", "keep", ("cintura", -0.08)),
    ("clothes", "female_casualsuit01", "baixo_jeans-skinny", "keep", ("cintura", -0.06)),
    ("clothes", "female_casualsuit02", "baixo_short-jeans", "keep", ("cintura", -0.11)),
    ("clothes", "female_sportsuit01", "baixo_legging", "keep", ("cintura", 0.0)),
]
ASSET_TYPES = {"hair": "Hair", "eyebrows": "Eyebrows", "eyelashes": "Eyelashes", "clothes": "Clothes"}

# Camiseta lisa para o app pintar e estampar (a parte de cima do male_casualsuit04).
# No atlas UV dele a camiseta ocupa a metade de cima (a calça, a de baixo), com os
# painéis em pé: costas | frente | as duas mangas. A textura exportada é só a oclusão
# (dobras e axilas em cinza); o app multiplica pela cor e desenha a estampa nos painéis.
SHIRT = ("male_casualsuit04", "cima_camiseta")
SHIRT_PANELS = {"uv_costas": (0.0, 0.37), "uv_frente": (0.39, 0.72), "uv_mangas": (0.72, 1.0)}
MAX_TEXTURE = 1024
# Pele e fios aparecem de perto (rosto, cabelo): mantêm a resolução do pacote.
MAX_TEXTURE_DETAIL = 2048
# Uma subdivisão (Catmull-Clark) do corpo, com as shape keys: tira o contorno
# facetado do rosto e dos ombros (a malha base do MakeHuman tem ~13 mil vértices).
BODY_SUBDIV = 1

SKIN = (0.69, 0.42, 0.28)
HAIR = (0.12, 0.08, 0.05)

# Cabelos, em coordenadas da esfera unitária da cabeça (frente = -Y, cima = +Z).
# Cada parte: (manter_face(x, y, z), planos de corte, escala extra, deslocamento).
# Os planos cortam a malha com bordas limpas; depois saem as faces que não passam no teste.
CAP_PLANE = ((0, 0, 0.02), (0, 0.6, 1))
CAP = lambda x, y, z: z + 0.6 * y > 0.02
FACE_PLANE = ((0, -0.25, 0), (0, 1, 0))
ALL = lambda x, y, z: True


def bob(lo):
    return (
        lambda x, y, z: z > lo and (CAP(x, y, z) or y > -0.25),
        [CAP_PLANE, FACE_PLANE, ((0, 0, lo), (0, 0, 1))],
    )


HAIR_STYLES = {
    "cabelo_curto": [(CAP, [CAP_PLANE], (1, 1, 1), (0, 0, 0))],
    "cabelo_chanel": [(*bob(-0.8), (1, 1, 1), (0, 0, 0))],
    "cabelo_longo": [(*bob(-0.85), (1, 1, 1), (0, 0, 0)), (ALL, [], (0.92, 0.42, 1.25), (0, 0.55, -1.15))],
    "cabelo_coque": [(*bob(-0.55), (1, 1, 1), (0, 0, 0)), (ALL, [], (0.42, 0.42, 0.42), (0, 0.75, 0.75))],
    "cabelo_rabo": [
        (*bob(-0.55), (1, 1, 1), (0, 0, 0)),
        (ALL, [], (0.28, 0.28, 0.28), (0, 1.0, 0.3)),
        (ALL, [], (0.3, 0.3, 0.85), (0, 1.12, -0.55)),
    ],
    "cabelo_black-power": [
        (lambda x, y, z: z + 0.5 * y > 0.02, [((0, 0, 0.02), (0, 0.5, 1))], (1.32, 1.3, 1.25), (0, 0.08, 0.22)),
    ],
}


def log(*a):
    print("[gerar-personagem]", *a, flush=True)


def set_macros(obj, values):
    for k, v in values.items():
        if k == "race":
            for rk, rv in v.items():
                HumanObjectProperties.set_value(rk, rv, entity_reference=obj)
        else:
            HumanObjectProperties.set_value(k, v, entity_reference=obj)
    TargetService.reapply_macro_details(obj)


def mix_coords(obj):
    """Posições dos vértices com a mistura atual de shape keys (sem modificadores)."""
    me = obj.data
    n = len(me.vertices)
    keys = me.shape_keys.key_blocks if me.shape_keys else None

    def co_of(block):
        a = np.empty(n * 3, dtype=np.float64)
        block.data.foreach_get("co", a)
        return a

    if not keys:
        a = np.empty(n * 3, dtype=np.float64)
        me.vertices.foreach_get("co", a)
        return a
    out = co_of(keys[0])
    for k in keys[1:]:
        if k.mute or abs(k.value) < 1e-9:
            continue
        out += k.value * (co_of(k) - co_of(k.relative_key))
    return out


def target_path(rel):
    return os.path.join(LocationService.get_mpfb_data("targets"), rel + ".target.gz")


def material(name, color, roughness):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    return m


def set_material(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    for p in obj.data.polygons:
        p.material_index = 0
        p.use_smooth = True


def select_group(obj, group, *, invert=False):
    bpy.ops.mesh.select_all(action="DESELECT")
    obj.vertex_groups.active_index = obj.vertex_groups[group].index
    bpy.ops.object.vertex_group_select()
    if invert:
        bpy.ops.mesh.select_all(action="INVERT")


def group_center_radius(obj, group):
    gi = obj.vertex_groups[group].index
    pts = [obj.matrix_world @ v.co for v in obj.data.vertices if any(g.group == gi and g.weight > 0.5 for g in v.groups)]
    c = sum(pts, Vector()) / len(pts)
    r = sum((p - c).length for p in pts) / len(pts)
    return c, r


def skinned_to_head(obj, rig):
    vg = obj.vertex_groups.new(name="head")
    vg.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
    obj.parent = rig
    mod = obj.modifiers.new("Armature", "ARMATURE")
    mod.object = rig


def make_eye(name, center, radius, rig, mats):
    """Esclera + íris + pupila, olhando para a frente (-Y no Blender)."""
    fwd = Vector((0, -1, 0))
    iris = 0.6 if STYLIZED else 0.5  # íris maior no estilizado
    parts = [
        (f"olho_{name}", radius, center, (1, 1, 1), mats["sclera"]),
        (f"iris_{name}", radius * iris, center + fwd * radius * (0.86 - (iris - 0.5) * 0.3), (1, 0.35, 1), mats["iris"]),
        (f"pupila_{name}", radius * iris * 0.48, center + fwd * radius * 0.99, (1, 0.25, 1), mats["pupil"]),
    ]
    for obj_name, r, pos, scale, mat in parts:
        me = bpy.data.meshes.new(obj_name)
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=r)
        bmesh.ops.scale(bm, vec=Vector(scale), verts=bm.verts)
        bmesh.ops.translate(bm, vec=pos, verts=bm.verts)
        bm.to_mesh(me)
        bm.free()
        obj = bpy.data.objects.new(obj_name, me)
        bpy.context.collection.objects.link(obj)
        set_material(obj, mat)
        skinned_to_head(obj, rig)


def head_ellipsoid(body, rig):
    """Centro e raios da cabeça (vértices acima da base do pescoço)."""
    neck = rig.data.bones["neck_01"].tail_local.z if "neck_01" in rig.data.bones else 1.5
    gi = body.vertex_groups["body"].index
    pts = [v.co for v in body.data.vertices if v.co.z > neck + 0.02 and any(g.group == gi for g in v.groups)]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    c = (lo + hi) / 2
    r = (hi - lo) / 2
    # O queixo puxa o centro para baixo: usa o crânio (metade de cima) para o raio vertical.
    c.z = hi.z - r.x * 1.15
    r.z = r.x * 1.15
    return c, r


def make_hair(name, parts, center, radii, rig, mat):
    bm = bmesh.new()
    for keep, planes, scale, offset in parts:
        tmp = bmesh.new()
        bmesh.ops.create_uvsphere(tmp, u_segments=64, v_segments=32, radius=1.0)
        for co, no in planes:
            geom = tmp.verts[:] + tmp.edges[:] + tmp.faces[:]
            bmesh.ops.bisect_plane(tmp, geom=geom, plane_co=Vector(co), plane_no=Vector(no).normalized())
        drop = [f for f in tmp.faces if not keep(*f.calc_center_median())]
        bmesh.ops.delete(tmp, geom=drop, context="FACES")
        for v in tmp.verts:
            u = Vector((v.co.x * scale[0] + offset[0], v.co.y * scale[1] + offset[1], v.co.z * scale[2] + offset[2]))
            v.co = center + Vector((u.x * radii.x * 1.08, u.y * radii.y * 1.08, u.z * radii.z * 1.06))
        me = bpy.data.meshes.new("tmp")
        tmp.to_mesh(me)
        tmp.free()
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    set_material(obj, mat)
    # Casca fina: dupla face no material, e um pouco de espessura.
    sol = obj.modifiers.new("Espessura", "SOLIDIFY")
    sol.thickness = 0.004
    skinned_to_head(obj, rig)


def make_brows(eyes, rig, mat):
    for side, (c, r) in eyes.items():
        me = bpy.data.meshes.new(f"sobrancelha_{side}")
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=8, radius=1.0)
        bmesh.ops.scale(bm, vec=Vector((r * 1.35, r * 0.45, r * 0.26)), verts=bm.verts)
        tilt = 0.12 if side == "l" else -0.12
        bmesh.ops.rotate(bm, verts=bm.verts, cent=Vector(), matrix=Quaternion((0, 1, 0), tilt).to_matrix())
        bmesh.ops.translate(bm, vec=c + Vector((0, -r * 1.15, r * 1.6)), verts=bm.verts)
        bm.to_mesh(me)
        bm.free()
        obj = bpy.data.objects.new(f"sobrancelha_{side}", me)
        bpy.context.collection.objects.link(obj)
        set_material(obj, mat)
        skinned_to_head(obj, rig)


def pack_dir():
    """Pasta de dados do usuário do MPFB, se o pacote de assets estiver instalado nela."""
    try:
        d = LocationService.get_user_data()
    except Exception:  # noqa: BLE001
        return None
    return d if d and os.path.isdir(os.path.join(d, "hair")) else None


def diffuse_texture(asset_dir, name):
    mhmat = os.path.join(asset_dir, name + ".mhmat")
    if os.path.isfile(mhmat):
        with open(mhmat, encoding="utf-8", errors="ignore") as f:
            for line in f:
                parts = line.split(None, 1)
                if len(parts) == 2 and parts[0] == "diffuseTexture":
                    path = os.path.join(asset_dir, parts[1].strip())
                    if os.path.isfile(path):
                        return path
    for f in sorted(os.listdir(asset_dir)):
        if f.lower().endswith(".png") and "normal" not in f.lower():
            return os.path.join(asset_dir, f)
    return None


def clean_alpha(px, w, h, grow=0):
    """
    Texturas de fios: tira riscos finos (1–2 px) do alfa, que viravam linhas claras
    na borda das faixas de cabelo, e espalha a cor média nos pixels transparentes
    (senão o mipmap misturava o fundo preto/branco na borda dos fios).
    """
    a = px[:, 3].reshape(h, w) > 0.5

    def shift_all(m, op):
        out = m.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                out = op(out, np.roll(np.roll(m, dy, 0), dx, 1))
        return out

    opened = a
    for _ in range(2):
        opened = shift_all(opened, np.logical_and)
    for _ in range(2):
        opened = shift_all(opened, np.logical_or)
    removed = (a & ~opened).ravel()
    # Cabelo feito de fios finos (black power): a limpeza apagaria o próprio cabelo.
    if removed.sum() > 0.03 * max(1, a.sum()):
        removed[:] = False
    px[removed, 3] = 0
    # Cabelo: as faixas são vizinhas no 3D mas separadas no atlas; a borda de cada
    # uma pegava a margem transparente e abria frestas claras entre as faixas.
    # Estende o alfa alguns pixels para dentro da margem.
    if grow:
        solid = px[:, 3].reshape(h, w) > 0.5
        grown = solid
        for _ in range(grow):
            grown = shift_all(grown, np.logical_or)
        ring = (grown & ~solid).ravel()
        if solid.any():
            px[ring, :3] = px[solid.ravel(), :3].mean(axis=0)
        px[ring, 3] = 1.0
    keep = px[:, 3] > 0.5
    if keep.any() and not keep.all():
        px[~keep, :3] = px[keep, :3].mean(axis=0)
    log(f"alfa: {int(removed.sum())} pixels de riscos finos removidos")


def soften(img, small):
    """Reduz e volta ao tamanho original: tira o detalhe fino (aspecto pintado)."""
    w, h = img.size
    if max(w, h) <= small:
        return
    k = small / max(w, h)
    img.scale(max(1, int(w * k)), max(1, int(h * k)))
    img.scale(w, h)


def load_texture(path, gray, tmp_dir, max_size=MAX_TEXTURE, alpha=False, grow=0, blur_to=None):
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    if max(w, h) > max_size:
        k = max_size / max(w, h)
        img.scale(max(1, int(w * k)), max(1, int(h * k)))
        w, h = img.size
    if gray or alpha:
        px = np.empty(len(img.pixels), dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(-1, 4)
        if alpha:
            clean_alpha(px, w, h, grow)
        if gray:
            lum = px[:, :3] @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
            opaque = px[:, 3] > 0.5
            # Pelo percentil 97: pela média (0,8), os reflexos pintados na textura
            # estouravam no branco e os fios sumiam.
            top = float(np.percentile(lum[opaque], 97)) if opaque.any() else 1.0
            v = np.clip(lum * (0.95 / max(top, 1e-3)), 0, 1)
            px[:, 0] = px[:, 1] = px[:, 2] = v
        img.pixels.foreach_set(px.ravel())
    if blur_to:
        soften(img, blur_to)
    out = os.path.join(tmp_dir, os.path.basename(path))
    img.filepath_raw = out
    img.file_format = "PNG"
    img.save()
    return img


def texture_material(name, img, alpha):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = 0.8
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if alpha:
        # Alpha recortado (o exportador glTF transforma em alphaMode MASK).
        rnd = nt.nodes.new("ShaderNodeMath")
        rnd.operation = "ROUND"
        nt.links.new(tex.outputs["Alpha"], rnd.inputs[0])
        nt.links.new(rnd.outputs[0], bsdf.inputs["Alpha"])
    m.use_backface_culling = False
    return m


def cut_height(cut, waist):
    if cut is None:
        return None
    kind, value = cut
    return waist + value if kind == "cintura" else value


def in_kept_region(co, cut, z):
    """O ponto fica na parte que sobra depois do corte?"""
    if z is None:
        return True
    if co.z > z:
        return False
    # Mangas que descem até o pulso (só nas roupas cortadas na cintura).
    return not (cut[0] == "cintura" and abs(co.x) > 0.2 and co.z > 0.6)


def cut_asset(obj, cut, z):
    """Apaga as faces fora da região mantida."""
    mw = obj.matrix_world
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    drop = [f for f in bm.faces if not in_kept_region(mw @ f.calc_center_median(), cut, z)]
    bmesh.ops.delete(bm, geom=drop, context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()


def trim_delete_group(body, group_name, cut, z):
    """A pele escondida pela peça também se limita à parte que sobrou dela."""
    vg = body.vertex_groups.get(group_name)
    if vg is None or z is None:
        return
    mw = body.matrix_world
    outside = [v.index for v in body.data.vertices if not in_kept_region(mw @ v.co, cut, z)]
    vg.remove(outside)


def cut_above(obj, z):
    cut_asset(obj, ("altura", z), z)


def add_pack_assets(body, pack, waist):
    """Carrega os assets do pacote. Devolve (pasta temporária, {objeto: grupo de pele escondida})."""
    tmp_dir = os.path.join(os.path.dirname(OUT), ".texturas-tmp")
    os.makedirs(tmp_dir, exist_ok=True)
    hides = {}
    for folder, name, glb_name, color_mode, cut in PACK_ASSETS:
        asset_dir = os.path.join(pack, folder, name)
        mhclo = os.path.join(asset_dir, name + ".mhclo")
        if not os.path.isfile(mhclo):
            log("asset não encontrado, pulando:", mhclo)
            continue
        obj = HumanService.add_mhclo_asset(mhclo, body, asset_type=ASSET_TYPES[folder], subdiv_levels=0)
        obj.name = obj.data.name = glb_name
        for m in [m for m in obj.modifiers if m.type == "SUBSURF"]:
            obj.modifiers.remove(m)
        tex = diffuse_texture(asset_dir, name)
        if tex:
            fibers = folder in ("hair", "eyebrows", "eyelashes")
            img = load_texture(
                tex,
                color_mode == "tint",
                tmp_dir,
                MAX_TEXTURE_DETAIL if fibers else MAX_TEXTURE,
                alpha=fibers,
                grow=3 if folder == "hair" else 0,
                # Estilizado: mechas em vez de fios (cílios ficam como estão).
                blur_to=512 if STYLIZED and folder == "hair" else None,
            )
            mat = texture_material(glb_name, img, alpha=fibers)
        else:
            mat = material(glb_name, (0.5, 0.5, 0.5), 0.8)
        set_material(obj, mat)
        z = cut_height(cut, waist)
        if z is not None:
            cut_asset(obj, cut, z)
        group = "Delete." + name
        if group in body.vertex_groups:
            trim_delete_group(body, group, cut, z)
            hides[glb_name] = group
        if color_mode != "tint":
            obj["sem_cor"] = 1
        log("asset", glb_name, len(obj.data.vertices), "vértices")
    return tmp_dir, hides


def add_shirt(body, pack, tmp_dir):
    """Camiseta lisa (cima_camiseta). Devolve o grupo de pele escondida por ela, ou None."""
    name, glb_name = SHIRT
    asset_dir = os.path.join(pack, "clothes", name)
    mhclo = os.path.join(asset_dir, name + ".mhclo")
    if not os.path.isfile(mhclo):
        log("camiseta não encontrada, pulando:", mhclo)
        return None
    obj = HumanService.add_mhclo_asset(mhclo, body, asset_type="Clothes", subdiv_levels=0)
    obj.name = obj.data.name = glb_name
    for m in [m for m in obj.modifiers if m.type == "SUBSURF"]:
        obj.modifiers.remove(m)

    # Só a camiseta: as faces da calça ficam na metade de baixo do atlas UV.
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uv = bm.loops.layers.uv.active

    def mean_v(f):
        return sum(l[uv].uv.y for l in f.loops) / len(f.loops)

    bmesh.ops.delete(bm, geom=[f for f in bm.faces if mean_v(f) < 0.55], context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")

    # Retângulo de cada painel no atlas, em coordenadas de imagem (x para a direita,
    # y para baixo, 0–1), para o app saber onde desenhar a estampa.
    for prop, (u0, u1) in SHIRT_PANELS.items():
        pts = [l[uv].uv for f in bm.faces for l in f.loops if u0 <= l[uv].uv.x < u1]
        if not pts:
            log("camiseta: painel vazio", prop)
            continue
        obj[prop] = [
            round(min(p.x for p in pts), 4),
            round(1 - max(p.y for p in pts), 4),
            round(max(p.x for p in pts), 4),
            round(1 - min(p.y for p in pts), 4),
        ]
        log("camiseta:", prop, list(obj[prop]))
    bm.to_mesh(obj.data)
    bm.free()

    ao = os.path.join(asset_dir, name + "_ao.png")
    if os.path.isfile(ao):
        mat = texture_material(glb_name, load_texture(ao, False, tmp_dir), alpha=False)
        mat.use_backface_culling = True
    else:
        mat = material(glb_name, (0.9, 0.9, 0.9), 0.85)
    mat.node_tree.nodes.get("Principled BSDF").inputs["Roughness"].default_value = 0.9
    set_material(obj, mat)

    # A pele escondida pela peça inteira (camiseta + calça) se limita à camiseta.
    group = "Delete." + name
    vg = body.vertex_groups.get(group)
    if vg is None:
        return None
    hem = min((obj.matrix_world @ v.co).z for v in obj.data.vertices)
    mw = body.matrix_world
    vg.remove([v.index for v in body.data.vertices if (mw @ v.co).z < hem + 0.03])
    log("camiseta:", len(obj.data.vertices), "vértices, barra em z =", round(hem, 3))
    return glb_name, group


def push_shirt_out_of_bottoms(margin=0.006):
    """
    A camiseta passa por cima de todas as peças de baixo: o cós da calça (mais
    largo que a cintura da camiseta) a atravessava. Empurra cada vértice para fora
    da peça mais próxima e suaviza o deslocamento para não criar degraus.
    """
    from mathutils.bvhtree import BVHTree

    shirt = bpy.data.objects.get(SHIRT[1])
    # A saia é rodada: perto do quadril ela empurrava a barra para longe e dobrava a malha.
    bottoms = [
        o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith("baixo_") and o.name != "baixo_saia"
    ]
    if shirt is None or not bottoms:
        return
    trees = []
    for b in bottoms:
        bm = bmesh.new()
        bm.from_mesh(b.data)
        bm.transform(b.matrix_world)
        trees.append(BVHTree.FromBMesh(bm))
        bm.free()
    mw = shirt.matrix_world
    inv = mw.inverted()
    verts = shirt.data.vertices
    disp = [Vector() for _ in verts]
    for v in verts:
        p = mw @ v.co
        for t in trees:
            loc, nor, _, dist = t.find_nearest(p, 0.05)
            if loc is None:
                continue
            d = (p - loc).dot(nor)
            # Fundo demais = o ponto mais próximo é uma face de dentro da peça.
            if -0.02 < d < margin:
                disp[v.index] = max(disp[v.index], nor * (margin - d), key=lambda x: x.length)
    nb = [[] for _ in verts]
    for e in shirt.data.edges:
        a, b = e.vertices
        nb[a].append(b)
        nb[b].append(a)
    # A peça tem camadas (a de dentro da barra fica mais perto da calça e era
    # empurrada mais, passando para fora da de fora: manchas escuras). Cada vértice
    # usa o maior empurrão num raio de 4 cm, então as camadas andam juntas.
    from mathutils.kdtree import KDTree

    world = [mw @ v.co for v in verts]
    kd = KDTree(len(verts))
    for i, p in enumerate(world):
        kd.insert(p, i)
    kd.balance()
    disp = [
        max((disp[j] for _, j, _ in kd.find_range(world[i], 0.04)), key=lambda x: x.length, default=disp[i])
        for i in range(len(verts))
    ]
    need = disp
    for _ in range(4):
        disp = [
            (disp[i] + sum((disp[j] for j in nb[i]), Vector()) / len(nb[i])) / 2 if nb[i] else disp[i]
            for i in range(len(verts))
        ]
    moved = 0
    for v in verts:
        # A suavização espalha e encolhe o deslocamento: nunca menos que o necessário.
        d = max(disp[v.index], need[v.index], key=lambda x: x.length)
        if d.length > 1e-5:
            v.co = inv @ (mw @ v.co + d)
            moved += 1
    shirt.data.update()
    log("camiseta: empurrada para fora das peças de baixo,", moved, "vértices")


def make_bun(source_name, name, head_c, head_r):
    """
    Coque a partir do rabo de cavalo do pacote: o cabelo puxado para trás fica
    igual e a cauda (o que passa bem fora do crânio) é enrolada numa espiral
    presa na nuca. Os fios da textura seguem a cauda, então acompanham a volta.
    """
    src = bpy.data.objects.get(source_name)
    if src is None:
        log("sem", source_name, "; coque não criado")
        return
    obj = src.copy()
    obj.data = src.data.copy()
    bpy.context.collection.objects.link(obj)
    obj.name = obj.data.name = name

    mw = obj.matrix_world
    inv = mw.inverted()
    verts = obj.data.vertices
    world = [mw @ v.co for v in verts]

    def ell(p):
        d = p - head_c
        return math.sqrt((d.x / head_r.x) ** 2 + (d.y / head_r.y) ** 2 + (d.z / head_r.z) ** 2)

    # Cauda: atrás da cabeça (+Y no Blender) e bem fora do elipsoide do crânio.
    tail = [i for i, p in enumerate(world) if ell(p) > 1.3 and p.y > head_c.y]
    if len(tail) < 20:
        log("cauda do rabo de cavalo não encontrada; coque não criado")
        bpy.data.objects.remove(obj, do_unlink=True)
        return

    # Ponto de amarração = parte da cauda mais perto do crânio.
    by_ell = sorted(tail, key=lambda i: ell(world[i]))
    near = by_ell[: max(5, len(by_ell) // 20)]
    tie = sum((world[i] for i in near), Vector()) / len(near)
    # O começo da cauda fica colado na nuca (dentro de 1,3): entra também tudo
    # que está atrás, abaixo da amarração e um pouco fora da calota.
    in_tail = set(tail)
    tail += [
        i
        for i, p in enumerate(world)
        if i not in in_tail and p.z < tie.z and p.y > head_c.y + 0.3 * head_r.y and ell(p) > 1.12
    ]
    axis = (sum((world[i] for i in tail), Vector()) / len(tail) - tie).normalized()
    a1 = axis.cross(Vector((1, 0, 0))).normalized()
    a2 = axis.cross(a1).normalized()
    length = max((world[i] - tie).dot(axis) for i in tail) or 1.0

    # Coque: espiral (toro que fecha) em volta de n, saindo da cabeça pela amarração.
    n = (tie - head_c).normalized()
    u1 = n.cross(Vector((0, 0, 1))).normalized()
    u2 = n.cross(u1).normalized()
    rb = head_r.x * 0.42  # raio do coque
    rm = head_r.x * 0.2  # espessura da "mecha"
    center = tie + n * rm * 0.6
    turns = 2.25
    for i in tail:
        p = world[i] - tie
        t = min(1.0, max(0.0, p.dot(axis) / length))
        beta = math.atan2(p.dot(a2), p.dot(a1))
        alpha = t * 2 * math.pi * turns
        # A espiral fecha para dentro (sem furo no meio) e cresce para fora.
        R = rb * (1 - 0.8 * t)
        q = (
            center
            + (R + rm * math.cos(beta)) * (math.cos(alpha) * u1 + math.sin(alpha) * u2)
            + n * (rm * 0.8 * math.sin(beta) + rb * 0.35 * t)
        )
        verts[i].co = inv @ q

    # A cauda pode estar presa ao pescoço/costas: o coque segue só a cabeça.
    head_vg = obj.vertex_groups.get("head")
    if head_vg is not None:
        for vg in obj.vertex_groups:
            if vg is not head_vg:
                vg.remove(tail)
        head_vg.add(tail, 1.0, "REPLACE")
    obj.data.update()
    log("coque:", len(tail), "vértices enrolados")


def subdivide_body(body, levels):
    """
    Subdivide o corpo mantendo as shape keys: avalia o modificador Subdivision com
    cada shape key ligada sozinha (a topologia sai igual em todas) e recria as
    shape keys na malha subdividida. Grupos de vértices (pesos do esqueleto e as
    áreas de pele escondida) e UVs são interpolados pelo próprio modificador.
    """
    if levels <= 0:
        return
    keys = body.data.shape_keys.key_blocks if body.data.shape_keys else []
    names = [k.name for k in keys]
    saved = {k.name: k.value for k in keys}
    # Só a subdivisão: os Mask do MPFB (pele sob as roupas) apagariam as pernas e o
    # quadril da malha avaliada, e o Armature não deve deformar nada.
    others = [m for m in body.modifiers if m.show_viewport]
    for m in others:
        m.show_viewport = False
    sub = body.modifiers.new("Subdivisao", "SUBSURF")
    sub.levels = sub.render_levels = levels
    sub.uv_smooth = "PRESERVE_BOUNDARIES"
    for k in keys:
        k.value = 0.0

    def evaluated():
        dg = bpy.context.evaluated_depsgraph_get()
        dg.update()
        return body.evaluated_get(dg), dg

    ev, dg = evaluated()
    new_me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    coords = {}
    for k in keys[1:]:
        k.value = 1.0
        ev, _ = evaluated()
        m = ev.to_mesh()
        co = np.empty(len(m.vertices) * 3, dtype=np.float64)
        m.vertices.foreach_get("co", co)
        ev.to_mesh_clear()
        coords[k.name] = co
        k.value = 0.0
    body.modifiers.remove(sub)
    for m in others:
        m.show_viewport = True

    old = body.data
    new_me.name = old.name
    body.data = new_me
    bpy.data.meshes.remove(old)
    if names:
        body.shape_key_add(name=names[0], from_mix=False)
        for name in names[1:]:
            k = body.shape_key_add(name=name, from_mix=False)
            k.data.foreach_set("co", coords[name])
            k.value = saved.get(name, 0.0)
    log(f"corpo subdividido: {len(new_me.vertices)} vértices, {len(names) - 1} shape keys")


def write_hide_attribute(body, hides):
    """
    Atributo "_oculta" no corpo: bit i ligado = o vértice fica escondido quando o asset de
    bit i está visível (o app descarta essa pele no shader). O asset guarda "oculta_bit".
    """
    masks = np.zeros(len(body.data.vertices), dtype=np.float64)
    for bit, (glb_name, group) in enumerate(sorted(hides.items())):
        vg = body.vertex_groups.get(group)
        obj = bpy.data.objects.get(glb_name)
        if vg is None or obj is None or bit > 23:
            continue
        flag = float(1 << bit)
        n = 0
        for v in body.data.vertices:
            if any(g.group == vg.index and g.weight > 0.5 for g in v.groups):
                masks[v.index] += flag
                n += 1
        obj["oculta_bit"] = bit
        log(f"pele escondida por {glb_name}: {n} vértices (bit {bit})")
    attr = body.data.attributes.new("_oculta", "FLOAT", "POINT")
    attr.data.foreach_set("value", masks.astype(np.float32))


def add_blink(body, eyes):
    """Shape key "piscar": as pálpebras giram em volta do centro de cada olho até se fecharem.

    O MPFB sem o rig facial não tem expressões; aqui a pele em volta de cada olho gira
    em torno do eixo horizontal do globo (mantendo a distância até ele, então desliza por
    cima do olho): a pálpebra de cima desce bastante, a de baixo sobe um pouco, e o efeito
    some longe do olho e nos cantos.
    """
    me = body.data
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float64)
    me.shape_keys.key_blocks["Basis"].data.foreach_get("co", co)
    co = co.reshape(-1, 3)
    gi = body.vertex_groups["body"].index
    in_body = np.array([any(g.group == gi and g.weight > 0.5 for g in v.groups) for v in me.vertices])
    inv = body.matrix_world.inverted()
    scale = body.matrix_world.to_scale().x
    out = co.copy()
    for side, (cw, rw) in eyes.items():
        c = np.array(inv @ cw)
        r = rw / scale
        rel = co - c
        d = np.linalg.norm(rel, axis=1)
        f = -rel[:, 1]  # frente = -Y
        z = rel[:, 2]
        theta = np.arctan2(z, f)
        near = in_body & (d < r * 2.2) & (f > -0.2 * r)
        # Borda das pálpebras: os vértices do corpo mais próximos do globo.
        rim = near & (d < r * 1.3) & (np.abs(rel[:, 0]) < r * 0.6)
        up, lo = rim & (theta > 0), rim & (theta <= 0)
        if not up.any() or not lo.any():
            log("piscar: borda das pálpebras não encontrada no olho", side)
            continue
        tu, tl = theta[up].min(), theta[lo].max()
        tc = tl + 0.35 * (tu - tl)  # as pálpebras se encontram um pouco abaixo do meio
        wd = np.clip((2.1 * r - d) / (0.8 * r), 0, 1)
        wx = np.clip(1 - (rel[:, 0] / (r * 1.4)) ** 2, 0, 1)
        upper = theta > (tu + tl) / 2
        a = np.where(
            upper,
            (tc - tu) * np.clip(1 - (theta - tu) / 1.0, 0, 1),
            (tc - tl) * np.clip(1 - (tl - theta) / 0.7, 0, 1),
        ) * wd * wx * near
        ca, sa = np.cos(a), np.sin(a)
        f2 = f * ca - z * sa
        z2 = f * sa + z * ca
        moved = a != 0
        out[moved, 1] = c[1] - f2[moved]
        out[moved, 2] = c[2] + z2[moved]
        log(f"piscar {side}: {int(moved.sum())} vértices, abertura {np.degrees(tu - tl):.0f}°")
    k = body.shape_key_add(name="piscar", from_mix=False)
    k.data.foreach_set("co", out.ravel())
    k.value = 0.0


SKIN_TEXTURE = "young_caucasian_female" if FEMALE else "young_caucasian_male"


def skin_material(pack, tmp_dir):
    """Pele com a textura do MakeHuman (lábios, bochechas, unhas…), sem a cor média.

    A textura é dividida pela sua cor mediana: sobra só a variação em volta de ~0,92,
    e o app continua escolhendo o tom de pele (cor do material × textura).
    """
    d = os.path.join(pack, "skins", SKIN_TEXTURE)
    tex = diffuse_texture(d, SKIN_TEXTURE) if os.path.isdir(d) else None
    if not tex:
        log("textura de pele não encontrada:", d)
        return None
    img = load_texture(tex, False, tmp_dir, MAX_TEXTURE if STYLIZED else MAX_TEXTURE_DETAIL)
    px = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    lum = px[:, :3] @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    skin = lum > 0.08  # o fundo do atlas UV é preto
    med = np.median(px[skin, :3], axis=0)
    px[:, :3] = np.clip(px[:, :3] / np.maximum(med, 1e-3) * 0.92, 0, 1)
    img.pixels.foreach_set(px.ravel())
    if STYLIZED:
        # Só manchas suaves (lábios, bochechas, unhas), sem poros nem sardas.
        soften(img, 192)
    img.save()
    m = texture_material("pele", img, alpha=False)
    m.node_tree.nodes.get("Principled BSDF").inputs["Roughness"].default_value = 0.55
    m.use_backface_culling = True
    log("pele com textura:", os.path.basename(tex), "mediana", np.round(med, 3))
    return m


def add_idle(rig):
    """Animação curta em loop: respiração, cabeça e braços levemente mais baixos."""
    scene = bpy.context.scene
    scene.render.fps = 24
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    pbs = rig.pose.bones

    def world_rot(bone_name, axis, deg):
        """Rotação em torno de um eixo do mundo, convertida para o espaço do osso."""
        rest = rig.data.bones[bone_name].matrix_local.to_3x3()
        local_axis = (rest.inverted() @ Vector(axis)).normalized()
        return Quaternion(local_axis, math.radians(deg))

    frames = [1, 49, 97]  # 4 s, primeiro = último
    poses = {
        "spine_03": [("x", 0), ("x", -1.6), ("x", 0)],
        "neck_01": [("x", 0), ("x", 1.2), ("x", 0)],
        "head": [("z", -2), ("z", 2), ("z", -2)],
        "upperarm_l": [("y", 14), ("y", 16), ("y", 14)],
        "upperarm_r": [("y", -14), ("y", -16), ("y", -14)],
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
    # Volta para a pose de descanso na cena (a animação fica só na ação).
    for pb in pbs:
        pb.rotation_euler = (0, 0, 0)


def main():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)

    log("criando humano", "feminino" if FEMALE else "masculino")
    body = HumanService.create_human(scale=0.1, macro_detail_dict=BASE)
    bpy.context.view_layer.objects.active = body

    # Rosto feminino antes de tudo: entra em todas as variações e na forma base.
    for i, (t, w) in enumerate(FEMALE_FACE + STYLIZED_SHAPE):
        path = target_path(t)
        if os.path.isfile(path):
            TargetService.load_target(body, path, weight=w, name=f"rosto_base_{i}")
        else:
            log("alvo não encontrado, pulando:", t)

    # 1) Coleta as posições de cada variação.
    shapes = {}
    for name, overrides in MACRO_VARIANTS.items():
        set_macros(body, {**BASE, **overrides})
        shapes[name] = mix_coords(body)
        log("variação", name)
    set_macros(body, BASE)
    base = mix_coords(body)
    for name, targets in TARGET_VARIANTS.items():
        keys = [TargetService.load_target(body, target_path(t), weight=w, name=f"tmp_{i}") for i, (t, w) in enumerate(targets)]
        shapes[name] = mix_coords(body)
        for k in keys:
            body.shape_key_remove(k)
        log("variação", name)

    # 2) Fixa a forma base e recria só as nossas shape keys.
    TargetService.bake_targets(body)
    body.shape_key_add(name="Basis", from_mix=False)
    for name, co in shapes.items():
        k = body.shape_key_add(name=name, from_mix=False)
        k.data.foreach_set("co", co)
        k.value = 0.0
        delta = np.abs(co - base).max()
        log(f"shape key {name}: deslocamento máx {delta * 100:.2f} cm")

    # 3) Esqueleto.
    rig = HumanService.add_builtin_rig(body, "game_engine")
    rig.name = rig.data.name = "Armature"
    log("esqueleto com", len(rig.data.bones), "ossos")

    eyes = {side: group_center_radius(body, f"helper-{side}-eye") for side in ("l", "r")}
    add_blink(body, eyes)
    head_c, head_r = head_ellipsoid(body, rig)
    waist = rig.data.bones["spine_02"].head_local.z if "spine_02" in rig.data.bones else 1.0

    # Assets do pacote (precisam das geometrias auxiliares, então vêm antes de apagá-las).
    pack = pack_dir()
    tmp_dir = None
    hides = {}
    if pack:
        log("pacote de assets:", pack)
        HELPER_ASSETS.pop("helper-tights", None)
        tmp_dir, hides = add_pack_assets(body, pack, waist)
        shirt = add_shirt(body, pack, tmp_dir)
        if shirt:
            hides[shirt[0]] = shirt[1]
        make_bun("cabelo_rabo-de-cavalo", "cabelo_coque", head_c, head_r)
    else:
        log("pacote de assets do MakeHuman não instalado; usando cabelos simples")

    # 4) Acessórios a partir das geometrias auxiliares; o resto dos helpers sai.
    # Só o corpo selecionado: senão o modo de edição pega vários objetos juntos.
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = body
    body.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for group in HELPER_ASSETS:
        if group in body.vertex_groups:
            select_group(body, group)
            bpy.ops.mesh.separate(type="SELECTED")
    select_group(body, "body", invert=True)
    bpy.ops.mesh.delete(type="VERT")
    bpy.ops.object.mode_set(mode="OBJECT")

    body.name = body.data.name = "corpo"
    if STYLIZED:
        body["estilo"] = "estilizado"  # o app troca o material da pele
    subdivide_body(body, BODY_SUBDIV)
    if hides:
        write_hide_attribute(body, hides)
    skin_mat = skin_material(pack, tmp_dir) if pack and tmp_dir else None
    set_material(body, skin_mat or material("pele", SKIN, 0.55))
    for obj in list(bpy.data.objects):
        if obj.type != "MESH":
            continue
        for m in [m for m in obj.modifiers if m.type == "MASK"]:
            obj.modifiers.remove(m)
        if obj is body:
            continue
        for group, (name, color, rough) in HELPER_ASSETS.items():
            gi = obj.vertex_groups.get(group)
            if gi and any(g.group == gi.index for g in obj.data.vertices[0].groups):
                obj.name = obj.data.name = name
                set_material(obj, material(name, color, rough))
                break

    # Legging auxiliar (sem o pacote) só da cintura para baixo.
    leg = bpy.data.objects.get("baixo_legging")
    if leg and not pack:
        cut_above(leg, waist)
    push_shirt_out_of_bottoms()

    # Cabelos e sobrancelhas simples, só sem o pacote.
    if not pack:
        hair_mat = material("cabelo", HAIR, 0.75)
        hair_mat.use_backface_culling = False
        for name, parts in HAIR_STYLES.items():
            make_hair(name, parts, head_c, head_r, rig, hair_mat)
        make_brows(eyes, rig, material("sobrancelha", HAIR, 0.8))

    # 5) Olhos.
    mats = {
        "sclera": material("esclera", (0.93, 0.92, 0.9), 0.3),
        "iris": material("iris", (0.25, 0.15, 0.08), 0.25),
        "pupil": material("pupila", (0.01, 0.01, 0.01), 0.2),
    }
    for side, (c, r) in eyes.items():
        make_eye(side, c, r, rig, mats)

    # 6) Animação.
    add_idle(rig)

    # 7) Exporta.
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format="GLB",
        use_selection=False,
        export_apply=False,
        export_yup=True,
        export_morph=True,
        # Com o corpo subdividido, as normais das shape keys somavam ~10 MB ao
        # arquivo; sem elas o app usa as normais da forma base (diferença pequena).
        export_morph_normal=False,
        export_skins=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_extras=True,
        export_attributes=True,
        export_image_format="WEBP",
        export_image_quality=85,
    )
    if tmp_dir:
        import shutil

        shutil.rmtree(tmp_dir, ignore_errors=True)
    log("exportado:", OUT, os.path.getsize(OUT) // 1024, "KB")
    for o in bpy.data.objects:
        log("objeto", o.name, o.type, len(o.data.vertices) if o.type == "MESH" else "")


main()
