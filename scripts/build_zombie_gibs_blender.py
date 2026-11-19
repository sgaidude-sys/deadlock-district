"""Headless Blender 5.2 script: slices real Zombie Apocalypse Kit glTF rigs by vertex weight
groups into severed heads, arms, gore chunks, and bloody bone stumps, exporting .glb gibs."""
import os
import math
import random
import bpy
import bmesh
from mathutils import Vector

REPO = os.getcwd()
ZOMBIE_BASIC = os.path.join(REPO, "public", "assets", "zombie-kit", "Characters", "glTF", "Zombie_Basic.gltf")
ZOMBIE_CHUBBY = os.path.join(REPO, "public", "assets", "zombie-kit", "Characters", "glTF", "Zombie_Chubby.gltf")
OUT_DIR = os.path.join(REPO, "public", "assets", "gibs")
os.makedirs(OUT_DIR, exist_ok=True)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_pbr_material(name, color, roughness=0.22, metallic=0.0):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
    return mat


def create_gore_materials():
    gore = make_pbr_material("WetGore", (0.26, 0.012, 0.014), roughness=0.16, metallic=0.02)
    marrow = make_pbr_material("DarkBlood", (0.12, 0.006, 0.008), roughness=0.14, metallic=0.04)
    bone = make_pbr_material("SnappedBone", (0.82, 0.78, 0.66), roughness=0.45, metallic=0.0)
    return gore, marrow, bone


def add_jagged_stump_cap(bm, cut_center, cut_dir, radius, gore_idx, bone_idx):
    """Adds a glistening irregular flesh cap + protruding snapped bone stub at the sever point."""
    rng = random.Random(42)
    z_axis = cut_dir.normalized()
    ref = Vector((1, 0, 0)) if abs(z_axis.x) < 0.8 else Vector((0, 0, 1))
    x_axis = z_axis.cross(ref).normalized()
    y_axis = z_axis.cross(x_axis).normalized()

    # Organic jagged gore collar (10-sided slightly lumpy disc/dome)
    ring_verts = []
    segs = 10
    for i in range(segs):
        a = (i / segs) * math.pi * 2
        r = radius * (0.86 + rng.random() * 0.28)
        pt = cut_center + (x_axis * math.cos(a) + y_axis * math.sin(a)) * r - z_axis * (radius * 0.08 * rng.random())
        ring_verts.append(bm.verts.new(pt))
    center_v = bm.verts.new(cut_center + z_axis * (radius * 0.22))
    for i in range(segs):
        f = bm.faces.new((ring_verts[i], ring_verts[(i + 1) % segs], center_v))
        f.material_index = gore_idx

    # Protruding snapped ivory bone stub
    b_rad = radius * 0.36
    b_len = radius * 0.95
    base_ring = []
    tip_ring = []
    b_segs = 8
    for i in range(b_segs):
        a = (i / b_segs) * math.pi * 2
        radial = x_axis * math.cos(a) + y_axis * math.sin(a)
        v0 = bm.verts.new(cut_center + radial * b_rad - z_axis * (radius * 0.12))
        # Jagged snapped break angle at tip
        jagged = 0.72 + 0.55 * abs(math.sin(a * 1.5 + 0.6))
        v1 = bm.verts.new(cut_center + radial * (b_rad * 0.78) + z_axis * (b_len * jagged))
        base_ring.append(v0)
        tip_ring.append(v1)

    tip_center = bm.verts.new(cut_center + z_axis * (b_len * 0.78))
    for i in range(b_segs):
        ni = (i + 1) % b_segs
        f_side = bm.faces.new((base_ring[i], base_ring[ni], tip_ring[ni], tip_ring[i]))
        f_side.material_index = bone_idx
        f_cap = bm.faces.new((tip_ring[i], tip_ring[ni], tip_center))
        f_cap.material_index = gore_idx


def extract_body_part(gltf_path, out_name, group_prefixes, cut_axis_hint, required_suffix=None):
    """Imports a zombie glTF, extracts faces dominated by the given bone vertex groups,
    caps the cut edge with glistening gore + snapped bone, centers COM, and exports .glb."""
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=gltf_path)

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"No mesh objects found in {gltf_path}")

    # Apply armature/transforms cleanly by evaluating depsgraph on each mesh
    depsgraph = bpy.context.evaluated_depsgraph_get()
    gore_mat, _, bone_mat = create_gore_materials()

    kept_objs = []
    matched_groups = set()
    for obj in meshes:
        vgroups = {vg.index: vg.name for vg in obj.vertex_groups}
        target_indices = {
            idx for idx, name in vgroups.items()
            if any(name == p or name.startswith(p) for p in group_prefixes)
            and (required_suffix is None or name.endswith(required_suffix))
        }
        for idx in target_indices:
            matched_groups.add(vgroups[idx])
        if not target_indices:
            continue

        eval_obj = obj.evaluated_get(depsgraph)
        me = bpy.data.meshes.new_from_object(eval_obj)
        # Apply world transform into vertex coordinates
        me.transform(obj.matrix_world)

        # Determine which vertices belong to target bone groups using source mesh weights
        keep_vert = [False] * len(obj.data.vertices)
        for v in obj.data.vertices:
            target_w = 0.0
            other_w = 0.0
            for g in v.groups:
                if g.group in target_indices:
                    target_w += g.weight
                else:
                    other_w += g.weight
            if target_w > 0.35 and target_w >= other_w * 0.85:
                keep_vert[v.index] = True

        bm = bmesh.new()
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table()
        bm.faces.ensure_lookup_table()

        del_faces = [f for f in bm.faces if not any(keep_vert[v.index] for v in f.verts)]
        if del_faces:
            bmesh.ops.delete(bm, geom=del_faces, context="FACES")

        # Remove stray loose verts
        loose_verts = [v for v in bm.verts if not v.link_faces]
        if loose_verts:
            bmesh.ops.delete(bm, geom=loose_verts, context="VERTS")

        if len(bm.faces) == 0:
            bm.free()
            bpy.data.meshes.remove(me)
            continue

        # Append gore & bone materials to this mesh
        gore_idx = len(me.materials)
        me.materials.append(gore_mat)
        bone_idx = len(me.materials)
        me.materials.append(bone_mat)

        # Find boundary edges (the severed opening) to place the bloody cap + snapped bone
        boundary_verts = list({v for e in bm.edges if e.is_boundary for v in e.verts})
        if boundary_verts:
            cut_center = sum((v.co for v in boundary_verts), Vector((0, 0, 0))) / len(boundary_verts)
            # Estimate radius from boundary spread
            radius = max(0.055, min(0.22, sum((v.co - cut_center).length for v in boundary_verts) / len(boundary_verts)))
            # Compute outward cut direction away from limb centroid
            mesh_center = sum((v.co for v in bm.verts), Vector((0, 0, 0))) / len(bm.verts)
            cut_dir = cut_center - mesh_center
            if cut_dir.length < 0.001:
                cut_dir = Vector(cut_axis_hint)
            add_jagged_stump_cap(bm, cut_center, cut_dir, radius, gore_idx, bone_idx)

        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()

        new_obj = bpy.data.objects.new(f"{out_name}_{obj.name}", me)
        bpy.context.collection.objects.link(new_obj)
        kept_objs.append(new_obj)

    if not kept_objs:
        raise RuntimeError(f"Failed to extract any geometry for {out_name}")

    # Remove all original imported objects so only our gib remains
    for o in list(bpy.context.scene.objects):
        if o not in kept_objs:
            bpy.data.objects.remove(o, do_unlink=True)

    # Center all gib pieces around combined bounding-box centroid
    all_pts = [v.co for o in kept_objs for v in o.data.vertices]
    min_v = Vector((min(p.x for p in all_pts), min(p.y for p in all_pts), min(p.z for p in all_pts)))
    max_v = Vector((max(p.x for p in all_pts), max(p.y for p in all_pts), max(p.z for p in all_pts)))
    center = (min_v + max_v) * 0.5
    for o in kept_objs:
        for v in o.data.vertices:
            v.co -= center
        o.data.update()

    bpy.ops.object.select_all(action="SELECT")
    out_path = os.path.join(OUT_DIR, f"{out_name}.glb")
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        use_selection=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
    )
    size = max_v - min_v
    print(f"Exported {out_path} ({os.path.getsize(out_path) / 1024:.1f} KB, verts={len(all_pts)}, size=({size.x:.2f},{size.y:.2f},{size.z:.2f}), groups={sorted(matched_groups)})")


def build_sculpted_gore_chunk():
    """Creates a jagged wet crimson meat + snapped curved rib chunk for shotgun & barrel blasts."""
    clear_scene()
    gore_mat, marrow_mat, bone_mat = create_gore_materials()
    rng = random.Random(1337)

    # Irregular meat lump
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.14)
    meat = bpy.context.active_object
    meat.name = "GibChunk"
    meat.data.materials.append(gore_mat)
    meat.data.materials.append(marrow_mat)
    meat.data.materials.append(bone_mat)

    bm = bmesh.new()
    bm.from_mesh(meat.data)
    for v in bm.verts:
        n = 0.65 + rng.random() * 0.72
        v.co.x *= n * 1.25
        v.co.y *= n * 0.78
        v.co.z *= n * 0.95
    for f in bm.faces:
        f.material_index = 1 if rng.random() < 0.35 else 0

    # Add two protruding snapped curved bone/rib spikes
    for sign, offset in [(-1, Vector((0.05, 0.02, 0.04))), (1, Vector((-0.04, 0.03, -0.05)))]:
        add_jagged_stump_cap(bm, offset, Vector((sign * 0.8, 0.5, 0.3 * sign)), 0.07, 0, 2)

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(meat.data)
    bm.free()

    bpy.ops.object.select_all(action="SELECT")
    out_path = os.path.join(OUT_DIR, "gib_chunk.glb")
    bpy.ops.export_scene.gltf(filepath=out_path, export_format="GLB", use_selection=True)
    print(f"Exported {out_path} ({os.path.getsize(out_path) / 1024:.1f} KB)")


def build_bloody_stump():
    """Creates a compact bloody flesh collar + exposed white bone stump for live dismembered zombies."""
    clear_scene()
    gore_mat, _, bone_mat = create_gore_materials()

    me = bpy.data.meshes.new("BloodyStump")
    me.materials.append(gore_mat)
    me.materials.append(bone_mat)

    bm = bmesh.new()
    add_jagged_stump_cap(bm, Vector((0, 0, 0)), Vector((0, 1, 0)), 0.105, 0, 1)
    # Close underside slightly
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()

    obj = bpy.data.objects.new("BloodyStump", me)
    bpy.context.collection.objects.link(obj)
    bpy.ops.object.select_all(action="SELECT")
    out_path = os.path.join(OUT_DIR, "gib_stump.glb")
    bpy.ops.export_scene.gltf(filepath=out_path, export_format="GLB", use_selection=True)
    print(f"Exported {out_path} ({os.path.getsize(out_path) / 1024:.1f} KB)")


def main():
    extract_body_part(ZOMBIE_BASIC, "gib_head", ["Head", "Neck", "Eyelid", "Tongue"], (0, -1, 0))
    extract_body_part(ZOMBIE_CHUBBY, "gib_brute_head", ["Head", "Neck", "Eyelid", "Tongue", "TopMouth", "BottomMouth"], (0, -1, 0))
    extract_body_part(ZOMBIE_BASIC, "gib_arm_l", ["UpperArm", "LowerArm", "Wrist", "Hand", "Fist", "Thumb", "Index", "Middle", "Ring", "Pinky"], (1, 0, 0), required_suffix=".L")
    extract_body_part(ZOMBIE_BASIC, "gib_arm_r", ["UpperArm", "LowerArm", "Wrist", "Hand", "Fist", "Thumb", "Index", "Middle", "Ring", "Pinky"], (-1, 0, 0), required_suffix=".R")
    extract_body_part(ZOMBIE_BASIC, "gib_leg_l", ["UpperLeg", "LowerLeg", "Foot"], (0, 1, 0), required_suffix=".L")
    extract_body_part(ZOMBIE_BASIC, "gib_leg_r", ["UpperLeg", "LowerLeg", "Foot"], (0, 1, 0), required_suffix=".R")
    build_sculpted_gore_chunk()
    build_bloody_stump()


if __name__ == "__main__":
    main()
