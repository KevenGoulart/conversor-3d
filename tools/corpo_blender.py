"""
Troca o corpo do Quaternius pelo "Base Mesh - Stylized Female" do pacote Human Base Meshes
da Blender Studio (CC0, https://www.blender.org/download/demo-files/ → Asset Libraries).
Usado por tools/gerar-quaternius.py com --corpo-blender <human_base_meshes_bundle.blend>.

O pacote não traz esqueleto, textura nem cabelo:
  - o esqueleto do Quaternius é reajustado às articulações do corpo novo, medidas nas
    "primitivas" do próprio pacote (blocos de braço, perna, mão, pé… alinhados ao corpo);
    os nomes dos ossos não mudam, então poses, animação e roupas continuam valendo
  - pesos do esqueleto automáticos (bone heat)
  - cabelos e sobrancelhas do Quaternius são encaixados na cabeça nova
  - olhos: o globo do pacote vira olho_l/olho_r e ganham íris e pupila (o app pinta a íris
    e move os olhos)
  - cor de vértice suave para lábios e bochechas (a pele é lisa; o app escolhe o tom)
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

BODY = "GEO-body_female_stylized"
EYES = ("GEO-body_female_stylized.eye.L", "GEO-body_female_stylized.eye.R")
PRIM = "_female_primitive_stylized"


def log(*a):
    print("[corpo-blender]", *a, flush=True)


def _append(path, names):
    with bpy.data.libraries.load(path, link=False) as (src, dst):
        missing = [n for n in names if n not in src.objects]
        if missing:
            raise SystemExit(f"objetos não encontrados no .blend: {missing}")
        dst.objects = list(names)
    objs = []
    for o in dst.objects:
        bpy.context.scene.collection.objects.link(o)
        objs.append(o)
    bpy.context.view_layer.update()
    # Solta dos pais (que não vieram) mantendo a posição no mundo.
    for o in objs:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    bpy.context.view_layer.update()
    return objs


def _world_pts(o):
    mw = o.matrix_world
    return np.array([(mw @ v.co)[:] for v in o.data.vertices])


def _segment(o):
    """Extremos do eixo principal da primitiva: (ponta de cima, ponta de baixo)."""
    p = _world_pts(o)
    c = p.mean(0)
    _, _, vt = np.linalg.svd(p - c, full_matrices=False)
    ax = vt[0]
    t = (p - c) @ ax
    a, b = Vector(c + ax * t.min()), Vector(c + ax * t.max())
    return (a, b) if a.z >= b.z else (b, a)


def _box(o):
    p = _world_pts(o)
    return Vector(p.min(0)), Vector(p.max(0))


def load_body(path):
    """Carrega corpo, olhos e primitivas; centraliza tudo em x = 0 (o pacote vem em fila)."""
    import re

    with bpy.data.libraries.load(path, link=False) as (src, _):
        prims = [n for n in src.objects if PRIM in n]
    objs = _append(path, [BODY, *EYES, *prims])
    body = next(o for o in objs if o.name.startswith(BODY) and ".eye" not in o.name)
    eyes = [o for o in objs if ".eye." in o.name]
    prim = {re.sub(r"^GEO-|" + PRIM, "", o.name).replace("..", "."): o for o in objs if PRIM in o.name}
    # Os olhos do corpo e os das primitivas marcam o centro de cada conjunto.
    body_cx = sum(_box(e)[0].x + _box(e)[1].x for e in eyes) / 4
    pe = [prim["eye.L"], prim["eye.R"]]
    prim_cx = sum(_box(e)[0].x + _box(e)[1].x for e in pe) / 4
    for o in [body, *eyes]:
        o.location.x -= body_cx
    for o in prim.values():
        o.location.x -= prim_cx
    bpy.context.view_layer.update()
    for o in [body, *eyes, *prim.values()]:
        o.modifiers.clear()
    log("corpo:", len(body.data.vertices), "vértices; primitivas:", len(prim))
    return body, eyes, prim


def joint_targets(prim):
    """Posição (no mundo) da cabeça de cada osso principal, medida nas primitivas."""
    T = {}
    for s, S in (("l", "L"), ("r", "R")):
        ut, ub = _segment(prim[f"arm_upper.{S}"])
        lt, lb = _segment(prim[f"arm_lower.{S}"])
        ht, hb = _segment(prim[f"hand.{S}"])
        _, fb = _segment(prim[f"finger_middle.{S}"])
        T[f"upperarm_{s}"] = ut.lerp(ub, 0.12)
        T[f"lowerarm_{s}"] = (ub + lt) / 2
        T[f"hand_{s}"] = (lb + ht) / 2
        T[f"_fingertip_{s}"] = fb
        sh_lo, sh_hi = _box(prim[f"shoulder.{S}"])
        T[f"clavicle_{s}"] = Vector((math.copysign(0.015, T[f"upperarm_{s}"].x), (sh_lo.y + sh_hi.y) / 2 - 0.02,
                                     T[f"upperarm_{s}"].z + 0.01))
        gt, gb = _segment(prim[f"leg_upper.{S}"])
        kt, kb = _segment(prim[f"leg_lower.{S}"])
        f_lo, f_hi = _box(prim[f"foot.{S}"])
        T[f"thigh_{s}"] = gt.lerp(gb, 0.15)
        T[f"calf_{s}"] = (gb + kt) / 2
        T[f"foot_{s}"] = Vector((kb.x, kb.y, f_hi.z - 0.008))
        toes = [_box(prim[f"toe_{t}.{S}"]) for t in ("big", "index", "middle", "ring", "pinky")]
        back_y = max(b[1].y for b in toes)
        tx = sum((b[0].x + b[1].x) / 2 for b in toes) / len(toes)
        T[f"ball_{s}"] = Vector((tx, back_y, 0.025))
        T[f"ball_leaf_{s}"] = Vector((tx, min(b[0].y for b in toes), 0.015))
    p_lo, p_hi = _box(prim["pelvis"])
    n_lo, n_hi = _box(prim["neck"])
    h_lo, h_hi = _box(prim["head"])
    pelvis = Vector((0, (p_lo.y + p_hi.y) / 2, (T["thigh_l"].z + T["thigh_r"].z) / 2 + 0.03))
    neck = Vector((0, (n_lo.y + n_hi.y) / 2, n_lo.z + 0.25 * (n_hi.z - n_lo.z)))
    T["pelvis"] = pelvis
    for name, f in (("spine_01", 0.15), ("spine_02", 0.42), ("spine_03", 0.68)):
        T[name] = pelvis.lerp(neck, f)
    T["neck_01"] = neck
    T["head"] = Vector((0, (n_lo.y + n_hi.y) / 2, n_hi.z - 0.03))
    T["_headtop"] = Vector((0, (h_lo.y + h_hi.y) / 2, h_hi.z))
    return T


def fit_rig(rig, T):
    """Move as cabeças dos ossos para as articulações novas; dedos e pés por semelhança."""
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    eb = rig.data.edit_bones
    mw = rig.matrix_world
    inv = mw.inverted()
    old = {b.name: (mw @ b.head, mw @ b.tail) for b in eb}
    connected = {b.name: [c.name for c in b.children if (old[c.name][0] - old[b.name][1]).length < 1e-4]
                 for b in eb}
    new_head = {}

    def sim(src_a, src_b, dst_a, dst_b):
        """Semelhança que leva o segmento src ao dst (rotação mínima + escala)."""
        v0, v1 = src_b - src_a, dst_b - dst_a
        q = v0.normalized().rotation_difference(v1.normalized())
        k = v1.length / max(v0.length, 1e-9)
        return lambda p: dst_a + (q @ ((p - src_a) * k))

    for s in "lr":
        hand = f"hand_{s}"
        tip_q = old.get(f"middle_04_leaf_{s}", old.get(f"middle_03_{s}"))[0]
        f = sim(old[hand][0], tip_q, T[hand], T[f"_fingertip_{s}"])
        for b in eb:
            if b.name.endswith(f"_{s}") and any(b.name.startswith(k) for k in
                                                 ("index", "middle", "ring", "pinky", "thumb")):
                new_head[b.name] = f(old[b.name][0])
                b["_tail"] = f(old[b.name][1])[:]
    for name, p in T.items():
        if not name.startswith("_") and name in eb:
            new_head[name] = p

    # Cabeças e caudas: cauda = cabeça do filho ligado; senão mantém a direção (escalada).
    scale = (T["_headtop"].z) / max(old["head"][1].z, 1e-6)
    for b in eb:
        if b.name in new_head:
            b.head = inv @ new_head[b.name]
    for b in eb:
        kids = [k for k in connected[b.name] if k in new_head]
        if b.name == "head":
            b.tail = inv @ T["_headtop"]
        elif b.name.startswith("ball_leaf"):
            b.tail = b.head + (inv.to_3x3() @ Vector((0, -0.03, 0)))
        elif "_tail" in b:
            b.tail = inv @ Vector(b["_tail"])
            del b["_tail"]
        elif kids:
            b.tail = inv @ new_head[kids[0]]
        elif b.name in new_head:
            d = old[b.name][1] - old[b.name][0]
            b.tail = b.head + inv.to_3x3() @ (d * scale)
        if (b.tail - b.head).length < 1e-4:
            b.tail = b.head + Vector((0, 0, 0.01))
    for b in eb:
        b.use_deform = not (b.name == "root" or "_leaf" in b.name)
    bpy.ops.object.mode_set(mode="OBJECT")
    log("esqueleto ajustado:", len(new_head), "articulações")


def head_box(pts, z_from):
    sel = pts[pts[:, 2] > z_from]
    return Vector(sel.min(0)), Vector(sel.max(0))


def fit_head_parts(objs, src_box, dst_box, head_surface, gap):
    """Leva cabelos da cabeça antiga para a nova (caixa da cabeça) e tira de dentro do couro."""
    (s0, s1), (d0, d1) = src_box, dst_box
    sc = Vector(((d1.x - d0.x) / (s1.x - s0.x), (d1.y - d0.y) / (s1.y - s0.y), (d1.z - d0.z) / (s1.z - s0.z)))
    # Escala uniforme no meio termo (sem esticar demais em um eixo).
    u = (sc.x * sc.y * sc.z) ** (1 / 3)
    sc = Vector((0.5 * sc.x + 0.5 * u, 0.5 * sc.y + 0.5 * u, 0.5 * sc.z + 0.5 * u))
    sc_c, dc_c = (s0 + s1) / 2, (d0 + d1) / 2
    sc_c.z, dc_c.z = s1.z, d1.z + 0.012  # alinha pelo topo da cabeça (um pouco acima: franja longe dos olhos)
    for o in objs:
        mw, inv = o.matrix_world, o.matrix_world.inverted()
        for v in o.data.vertices:
            p = mw @ v.co
            q = dc_c + Vector(((p - sc_c).x * sc.x, (p - sc_c).y * sc.y, (p - sc_c).z * sc.z))
            loc, nor, _, _ = head_surface.find_nearest(q)
            if loc is not None:
                d = (q - loc).dot(nor)
                if d < gap:
                    q = q + nor * (gap - d)
            v.co = inv @ q
        o.data.update()


def make_eyes(eyes, rig):
    """Globo do pacote → olho_l/olho_r (esclera) + íris e pupila na frente, presos à cabeça."""
    mats = {}
    for name, color, rough in (("esclera", (0.95, 0.94, 0.92), 0.3), ("iris", (0.3, 0.2, 0.1), 0.25),
                               ("pupila", (0.01, 0.01, 0.01), 0.2)):
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        b = m.node_tree.nodes.get("Principled BSDF")
        b.inputs["Base Color"].default_value = (*color, 1)
        b.inputs["Roughness"].default_value = rough
        mats[name] = m
    out = []
    for e in eyes:
        side = "l" if e.name.endswith(".L") else "r"
        lo, hi = _box(e)
        c, r = (lo + hi) / 2, (hi.x - lo.x) / 2
        # Frente do globo: ponto mais à frente (-Y); direção do olhar a partir do centro.
        p = _world_pts(e)
        fwd = (Vector(p[p[:, 1].argmin()]) - c).normalized()
        e.name = e.data.name = f"olho_{side}"
        e.data.materials.clear()
        e.data.materials.append(mats["esclera"])
        out.append(e)
        # A pupila fica na frente da íris (senão a íris a cobre).
        for name, rad, dist, flat in (("iris", 0.4, 0.88, 0.28), ("pupila", 0.19, 0.975, 0.3)):
            me = bpy.data.meshes.new(f"{name}_{side}")
            bm = bmesh.new()
            bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=r * rad)
            bmesh.ops.scale(bm, vec=Vector((1, flat, 1)), verts=bm.verts)
            rot = Vector((0, -1, 0)).rotation_difference(fwd).to_matrix()
            bmesh.ops.rotate(bm, verts=bm.verts, cent=Vector(), matrix=rot)
            bmesh.ops.translate(bm, vec=c + fwd * r * dist, verts=bm.verts)
            bm.to_mesh(me)
            bm.free()
            o = bpy.data.objects.new(f"{name}_{side}", me)
            bpy.context.scene.collection.objects.link(o)
            o.data.materials.append(mats[name])
            out.append(o)
    for o in out:
        for p in o.data.polygons:
            p.use_smooth = True
        o.vertex_groups.clear()
        vg = o.vertex_groups.new(name="head")
        vg.add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
        o.parent = rig
        o.matrix_parent_inverse = rig.matrix_world.inverted()
        m = o.modifiers.new("Armature", "ARMATURE")
        m.object = rig
    log("olhos com íris e pupila")
    return out


def paint_face(body, prim, eyes_c):
    """Cor de vértice: lábios rosados e bochechas levemente coradas (o resto branco)."""
    me = body.data
    mw = body.matrix_world
    p = np.array([(mw @ v.co)[:] for v in me.vertices])
    n_lo, n_hi = _box(prim["nose"])
    h_lo, _ = _box(prim["head"])
    nose_bottom, chin = n_lo.z, h_lo.z
    mz = nose_bottom - 0.32 * (nose_bottom - chin)
    eye_d = abs(eyes_c[0].x - eyes_c[1].x)
    col = np.ones((len(p), 3))

    def soft(d):
        t = np.clip(1 - d, 0, 1)
        return t * t * (3 - 2 * t)

    # Lábios: faixa na altura da boca, perto do meio e na frente do rosto.
    band = (np.abs(p[:, 2] - mz) < 0.03) & (np.abs(p[:, 0]) < eye_d)
    front = np.full(len(p), np.inf)
    if band.any():
        zb = np.round(p[band, 2], 3)
        fy = {}
        for z, y in zip(zb, p[band, 1]):
            fy[z] = min(fy.get(z, y), y)
        front[band] = [fy[z] for z in zb]
    depth = np.where(band, (p[:, 1] - front) / 0.01, 9)
    lip = soft(np.sqrt((p[:, 0] / (eye_d * 0.42)) ** 2 + ((p[:, 2] - mz) / 0.011) ** 2)) * soft(depth)
    lip_col = np.array([0.86, 0.5, 0.5])
    col = col * (1 - lip[:, None] * 0.75) + lip_col * lip[:, None] * 0.75
    # Bochechas.
    for c in eyes_c:
        cc = np.array([c.x + math.copysign(eye_d * 0.15, c.x), c.y, c.z - eye_d * 0.6])
        w = soft(np.linalg.norm(p - cc, axis=1) / (eye_d * 0.55)) * (p[:, 1] < c.y + 0.02)
        col = col * (1 - w[:, None] * 0.25) + np.array([1.0, 0.72, 0.7]) * w[:, None] * 0.25
    attr = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    rgba = np.concatenate([col, np.ones((len(p), 1))], 1).astype(np.float32)
    attr.data.foreach_set("color", rgba.ravel())
    me.color_attributes.active_color = attr
    me.attributes.default_color_name = "Col"
    log("lábios e bochechas pintados")


def replace_body(path, rig, q_body, q_eyes_obj, hair_objs, brow_obj):
    """Executa a troca toda. Devolve o corpo novo (já chamado "corpo")."""
    q_pts = _world_pts(q_body)
    q_head_z = (rig.matrix_world @ rig.data.bones["head"].head_local).z
    q_box = head_box(q_pts, q_head_z)
    q_eye_pts = _world_pts(q_eyes_obj) if q_eyes_obj else None

    body, eyes, prim = load_body(path)
    sub = body.modifiers.new("Subdivisao", "SUBSURF")
    sub.levels = sub.render_levels = 1
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = body
    body.select_set(True)
    bpy.ops.object.modifier_apply(modifier=sub.name)

    T = joint_targets(prim)
    fit_rig(rig, T)

    new_pts = _world_pts(body)
    new_box = head_box(new_pts, T["head"].z)
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bm.transform(body.matrix_world)
    surface = BVHTree.FromBMesh(bm)
    bm.free()
    fit_head_parts(hair_objs, q_box, new_box, surface, 0.004)
    log("cabelos encaixados:", len(hair_objs))

    eyes_c = []
    for e in eyes:
        lo, hi = _box(e)
        eyes_c.append((lo + hi) / 2)
    eyes_c.sort(key=lambda c: -c.x)
    if brow_obj is not None and q_eye_pts is not None:
        # Sobrancelha: mesma posição relativa aos olhos, depois assentada na pele.
        ql = q_eye_pts[q_eye_pts[:, 0] > 0].mean(0)
        qr = q_eye_pts[q_eye_pts[:, 0] < 0].mean(0)
        qm, qd = Vector((ql + qr) / 2), abs(ql[0] - qr[0])
        nm, nd = (eyes_c[0] + eyes_c[1]) / 2, abs(eyes_c[0].x - eyes_c[1].x)
        k = nd / qd
        mw, inv = brow_obj.matrix_world, brow_obj.matrix_world.inverted()
        for v in brow_obj.data.vertices:
            p = mw @ v.co
            q = nm + (p - qm) * k + Vector((0, 0, nd * 0.12))
            # Mantém a forma; só sai de dentro da pele (achatada na superfície ela sumia).
            loc, nor, _, _ = surface.find_nearest(q)
            if loc is not None:
                d = (q - loc).dot(nor)
                if d < 0.002:
                    q = q + nor * (0.002 - d)
            v.co = inv @ q
        brow_obj.data.update()
        log("sobrancelha encaixada")

    paint_face(body, prim, eyes_c)
    for o in [q_body] + ([q_eyes_obj] if q_eyes_obj else []):
        bpy.data.objects.remove(o, do_unlink=True)
    for o in prim.values():
        bpy.data.objects.remove(o, do_unlink=True)

    body.name = body.data.name = "corpo"
    for p in body.data.polygons:
        p.use_smooth = True
    # Pesos automáticos.
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    weighted = sum(1 for v in body.data.vertices if v.groups)
    log(f"pesos automáticos: {weighted}/{len(body.data.vertices)} vértices")

    make_eyes(eyes, rig)
    return body
