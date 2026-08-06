# Blender headless side of tools/build-items-glb.mjs.
#
# Merges every FBX in the CC0 Quaternius item pack into ONE Blender scene with a
# deduplicated material palette, then exports a single GLB whose scene roots are
# named exactly after the source files.
#
#   Blender -b --python tools/blender-items.py -- <srcDir> <outGlb> <statsJson>
#
# THE NON-OBVIOUS BUG (hit for real on the first attempt): creating the handle
# Empty with the same name as the just-imported FBX root makes Blender rename it
# to 'Sword001', and every three.js getObjectByName('Sword') then returns null.
# The fix is to rename the imported objects to '<name>__part' BEFORE the Empty
# is created, which is why the rename below happens first and unconditionally.

import bpy
import json
import os
import re
import sys

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT, STATS = argv[0], argv[1], argv[2]

# --------------------------------------------------------------- empty scene
bpy.ops.wm.read_factory_settings(use_empty=True)
scene_col = bpy.context.scene.collection

names = sorted(
    f[:-4] for f in os.listdir(SRC)
    if f.lower().endswith('.fbx') and not f.startswith('.')
)

SUFFIX = re.compile(r'\.\d{3,}$')
def base_name(n):
    return SUFFIX.sub('', n)

palette = {}       # canonical material name -> the one material kept
roots = []
per_model = {}

def deselect_all():
    for o in bpy.data.objects:
        o.select_set(False)

for name in names:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=os.path.join(SRC, name + '.fbx'))
    fresh = [o for o in bpy.data.objects if o not in before]
    if not fresh:
        raise RuntimeError('imported nothing from ' + name)

    # STEP 1 — rename FIRST. See the header note; skipping this silently
    # corrupts every node name in the finished GLB.
    for i, o in enumerate(fresh):
        o.name = '%s__part%d' % (name, i)

    # STEP 2 — collapse to the shared material palette. The pack ships the same
    # ~34 flat colours re-authored in all 106 files; without this the GLB
    # carries 300+ identical materials and three compiles a program for each.
    meshes = [o for o in fresh if o.type == 'MESH']
    for o in meshes:
        for slot in o.material_slots:
            m = slot.material
            if m is None:
                continue
            key = base_name(m.name)
            keep = palette.get(key)
            if keep is None:
                if m.name != key:
                    m.name = key
                palette[key] = m
            elif keep is not m:
                slot.material = keep

    # STEP 3 — one mesh per item. Multi-material meshes still export as one
    # glTF mesh with several primitives, so this costs nothing and keeps the
    # node count at 2 per item instead of N.
    deselect_all()
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = '%s__part' % name
    joined.data.name = '%s__mesh' % name

    # Drop anything that was not a mesh (stray empties/armatures in the FBX).
    for o in fresh:
        if o is not joined and o.name in bpy.data.objects:
            bpy.data.objects.remove(o, do_unlink=True)

    # STEP 4 — the handle. This is the node the game looks up by name.
    holder = bpy.data.objects.new(name, None)
    holder.empty_display_size = 0.05
    scene_col.objects.link(holder)
    joined.parent = holder
    joined.matrix_parent_inverse.identity()

    tris = sum(max(0, len(p.vertices) - 2) for p in joined.data.polygons)
    d = joined.dimensions
    per_model[name] = {
        'triangles': tris,
        'dims': [round(d.x, 4), round(d.y, 4), round(d.z, 4)],
    }
    roots.append(name)

    if holder.name != name:
        raise RuntimeError('node name collision: wanted %r got %r' % (name, holder.name))

# ------------------------------------------------------------- fix opacity
#
# The pack's FBX materials carry an opacity of 0. Blender's FBX importer maps
# that straight onto the Principled BSDF Alpha input, the glTF exporter writes
# baseColorFactor alpha 0, and three.js then hands every item a
# MeshStandardMaterial with opacity 0. alphaMode stays OPAQUE so nothing warns
# and nothing throws — the models simply render with a zero alpha channel and
# disappear the moment they pass through a render target that composites on
# alpha, which the game's bloom pass does. Confirmed by rendering the sword
# alone against the sky and getting an empty frame.
for m in bpy.data.materials:
    if not m.use_nodes:
        continue
    for node in m.node_tree.nodes:
        alpha = node.inputs.get('Alpha') if hasattr(node, 'inputs') else None
        if alpha is not None and not alpha.is_linked:
            alpha.default_value = 1.0
    try:
        m.blend_method = 'OPAQUE'
    except (AttributeError, TypeError):
        pass

# ------------------------------------------------------------- purge orphans
for coll in (bpy.data.materials, bpy.data.meshes, bpy.data.images, bpy.data.armatures):
    for block in list(coll):
        if block.users == 0:
            coll.remove(block)

used_materials = set()
for o in bpy.data.objects:
    if o.type == 'MESH':
        for m in o.data.materials:
            if m:
                used_materials.add(m.name)

# ------------------------------------------------------------------- export
kwargs = dict(
    filepath=OUT,
    export_format='GLB',
    export_yup=True,
    export_apply=False,
    export_cameras=False,
    export_lights=False,
    export_animations=False,
    export_skins=False,
    export_morph=False,
    export_extras=False,
    export_tangents=False,
    use_selection=False,
    use_visible=False,
    export_materials='EXPORT',
)
try:
    bpy.ops.export_scene.gltf(**kwargs)
except TypeError:
    # Older/newer exporters drop individual keywords; retry with the minimum
    # set rather than failing the whole build on an argument name.
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_yup=True)

with open(STATS, 'w') as fh:
    json.dump({
        'roots': roots,
        'models': len(roots),
        'triangles': sum(v['triangles'] for v in per_model.values()),
        'materials': sorted(used_materials),
        'perModel': per_model,
    }, fh)

print('ITEMPACK_OK models=%d tris=%d materials=%d' % (
    len(roots), sum(v['triangles'] for v in per_model.values()), len(used_materials)))
