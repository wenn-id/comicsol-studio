// The hero's softcover comic book. Sheets are bendable planes deformed on the CPU each
// frame (a few hundred vertices), so the cover bows as it opens and pages curl as they
// turn. Rendering happens only when the scroll or pointer actually changed something.

import * as THREE from "../../vendor/three.module.min.js";
import {
  PAGE_COUNT,
  PAGE_RATIO,
  drawBackCover,
  drawCover,
  drawEdge,
  drawInsideCover,
  drawPage,
  fontsReady,
} from "./textures.js";
import { LEAVES, TIMELINE, clamp01, coverAngle, leafAngle, lerp, smooth, span } from "./timeline.js";

const PAGE_W = 1.3;
const PAGE_H = PAGE_W * PAGE_RATIO;
const BLOCK = 0.075;
const GAP = 0.0016;
const SEGMENTS_U = 36;
const SEGMENTS_V = 10;

// Camera keyframes: [progress, position, target], composed for landscape screens.
const SHOTS = [
  [0.0, [1.6, 2.95, 3.4], [-0.42, 0.0, 0.2]],
  [0.1, [1.35, 3.3, 3.2], [-0.4, 0.0, 0.12]],
  [0.36, [-0.2, 4.9, 2.95], [-0.62, 0.0, 0.12]],
  [0.82, [-0.05, 4.4, 2.55], [-0.5, 0.0, 0.08]],
  [0.9, [0.05, 4.2, 2.45], [-0.42, 0.0, 0.06]],
  [1.0, [1.25, 2.05, 1.05], [0.42, 0.0, -0.08]],
];

// Portrait screens: the book sits in the upper half, clear of the copy below it, and
// the open spread is centered so both pages stay on screen.
const PORTRAIT_SHOTS = [
  [0.0, [1.15, 6.0, 6.1], [0.62, 0.0, 1.95]],
  [0.1, [0.95, 6.1, 5.9], [0.5, 0.0, 1.75]],
  [0.36, [0.0, 7.6, 5.3], [0.0, 0.0, 1.35]],
  [0.9, [0.0, 7.3, 5.0], [0.0, 0.0, 1.3]],
  [1.0, [0.95, 2.7, 2.2], [0.68, 0.0, 0.45]],
];

function shot(p, portrait) {
  const shots = portrait ? PORTRAIT_SHOTS : SHOTS;
  let index = shots.length - 2;
  for (let i = 0; i < shots.length - 1; i++) {
    if (p <= shots[i + 1][0]) {
      index = i;
      break;
    }
  }
  const [p0, pos0, tgt0] = shots[index];
  const [p1, pos1, tgt1] = shots[index + 1];
  const t = smooth(clamp01((p - p0) / (p1 - p0)));
  return {
    position: pos0.map((value, axis) => lerp(value, pos1[axis], t)),
    target: tgt0.map((value, axis) => lerp(value, tgt1[axis], t)),
  };
}

// Sheets ----------------------------------------------------------------------

class Sheet {
  constructor(front, back, { stiffness = 0.55, twist = 0.22, material = "paper" } = {}) {
    this.geometry = new THREE.PlaneGeometry(PAGE_W, PAGE_H, SEGMENTS_U, SEGMENTS_V);
    this.geometry.rotateX(-Math.PI / 2);
    this.geometry.translate(PAGE_W / 2, 0, 0);
    this.rest = Float32Array.from(this.geometry.attributes.position.array);
    this.stiffness = stiffness;
    this.twist = twist;
    // A laminated softcover is glossy outside and matte inside; paper is matte both ways.
    this.frontMaterial =
      material === "cover"
        ? new THREE.MeshPhysicalMaterial({
            roughness: 0.34,
            clearcoat: 0.55,
            clearcoatRoughness: 0.32,
            map: front,
            side: THREE.FrontSide,
          })
        : new THREE.MeshStandardMaterial({ roughness: 0.86, map: front, side: THREE.FrontSide });
    this.backMaterial = new THREE.MeshStandardMaterial({ roughness: 0.88, map: back, side: THREE.BackSide });
    this.group = new THREE.Group();
    for (const material of [this.frontMaterial, this.backMaterial]) {
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    this.angle = -1;
  }

  // Bend the sheet around the spine (the z axis through x = 0).
  pose(angle, pivotY) {
    if (Math.abs(angle - this.angle) < 1e-5 && Math.abs(pivotY - this.pivotY) < 1e-6) return false;
    this.angle = angle;
    this.pivotY = pivotY;
    const lift = Math.sin(angle);
    const bend = this.stiffness * lift;
    const position = this.geometry.attributes.position;
    const columns = SEGMENTS_U + 1;
    const du = PAGE_W / SEGMENTS_U;
    for (let row = 0; row <= SEGMENTS_V; row++) {
      let x = 0;
      let y = 0;
      for (let col = 0; col < columns; col++) {
        const index = row * columns + col;
        const u = col / SEGMENTS_U;
        const v = row / SEGMENTS_V;
        if (col > 0) {
          const phi = angle + bend * (u - 0.4) + this.twist * lift * (v - 0.5) * u;
          x += Math.cos(phi) * du;
          y += Math.sin(phi) * du;
        }
        position.setXYZ(index, x, y + pivotY, this.rest[index * 3 + 2]);
      }
    }
    position.needsUpdate = true;
    this.geometry.computeVertexNormals();
    return true;
  }
}

function texture(renderer, source, { flip = false } = {}) {
  const map = new THREE.CanvasTexture(source);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  if (flip) {
    map.wrapS = THREE.RepeatWrapping;
    map.repeat.x = -1;
    map.offset.x = 1;
  }
  return map;
}

function studioEnvironment(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050506);
  const softbox = (color, intensity, width, height, position, rotation) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }),
    );
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    scene.add(mesh);
  };
  softbox(0xffd59a, 5, 6, 3, [2, 6, 2], [Math.PI / 2, 0, 0.3]);
  softbox(0x9fb0d0, 1.4, 1.2, 6, [-6, 2, -2], [0, Math.PI / 2, 0]);
  softbox(0xffe9c8, 2.2, 8, 0.4, [0, 3, -6], [0, 0, 0]);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.04);
  pmrem.dispose();
  return target.texture;
}

export async function createBook(canvas, { onReady } = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x08090b);
  scene.fog = new THREE.Fog(0x08090b, 5.5, 12);
  scene.environment = studioEnvironment(renderer);
  scene.environmentIntensity = 0.55;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 40);

  const key = new THREE.SpotLight(0xffdcae, 85, 0, 0.52, 0.85, 2);
  key.position.set(2.4, 5.6, 2.2);
  key.target.position.set(0.2, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.025;
  key.shadow.radius = 4;
  scene.add(key, key.target);
  scene.add(new THREE.HemisphereLight(0x515867, 0x0a0a0c, 0.45));
  const rim = new THREE.DirectionalLight(0xbac6e6, 0.7);
  rim.position.set(-3.5, 2.4, -4);
  scene.add(rim);

  const table = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.MeshStandardMaterial({ color: 0x0d0e11, roughness: 0.78, metalness: 0.0 }),
  );
  table.rotation.x = -Math.PI / 2;
  table.receiveShadow = true;
  scene.add(table);

  await fontsReady();
  const book = new THREE.Group();
  book.position.set(0, 0, 0);
  scene.add(book);

  const blank = new THREE.CanvasTexture(document.createElement("canvas"));
  const cover = new Sheet(texture(renderer, drawCover()), texture(renderer, drawInsideCover({ mirrored: true })), {
    stiffness: 0.85,
    twist: 0.32,
    material: "cover",
  });
  const back = new Sheet(texture(renderer, drawBackCover()), texture(renderer, drawBackCover()), { material: "cover" });
  back.group.rotation.z = 0;
  back.pose(0, 0.0012);
  // The back cover lies face down: show its outside to the table, the inside up.
  back.frontMaterial.map = texture(renderer, drawInsideCover());

  const edgeMap = texture(renderer, drawEdge());
  edgeMap.wrapS = edgeMap.wrapT = THREE.RepeatWrapping;
  edgeMap.repeat.set(1, 3);
  const edgeMaterial = new THREE.MeshStandardMaterial({ map: edgeMap, roughness: 0.92 });
  const makeBlock = (topMap) => {
    const topMaterial = new THREE.MeshStandardMaterial({ map: topMap, roughness: 0.86 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(PAGE_W - 0.012, 1, PAGE_H - 0.012), [
      edgeMaterial,
      edgeMaterial,
      topMaterial,
      edgeMaterial,
      edgeMaterial,
      edgeMaterial,
    ]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };
  const rightBlock = makeBlock(blank);
  const leftBlock = makeBlock(blank);
  book.add(rightBlock, leftBlock, back.group, cover.group);

  const leaves = [];
  for (let index = 0; index < LEAVES; index++) {
    const leaf = new Sheet(blank, blank, { stiffness: 0.5 + (index % 2) * 0.12, twist: 0.26 });
    leaves.push(leaf);
    book.add(leaf.group);
  }

  // Interior pages load after the first frame so the cover appears without waiting.
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 32));
  let pending = LEAVES + 1;
  const fill = (index) => {
    if (index < LEAVES) {
      leaves[index].frontMaterial.map = texture(renderer, drawPage(index * 2));
      leaves[index].backMaterial.map = texture(renderer, drawPage(index * 2 + 1, { mirrored: true }));
      leaves[index].frontMaterial.needsUpdate = leaves[index].backMaterial.needsUpdate = true;
    } else {
      rightBlock.material[2].map = texture(renderer, drawPage(PAGE_COUNT - 1));
      leftBlock.material[2].map = texture(renderer, drawPage(1));
      rightBlock.material[2].needsUpdate = leftBlock.material[2].needsUpdate = true;
    }
    pending -= 1;
    state.dirty = true;
    if (index < LEAVES) idle(() => fill(index + 1));
  };

  const state = {
    progress: 0,
    shown: -1,
    pointer: [0, 0],
    pointerShown: [0, 0],
    dirty: true,
    width: 1,
    height: 1,
  };

  function layout(p) {
    const cover01 = coverAngle(p) / Math.PI;
    const leafAngles = leaves.map((_, index) => leafAngle(p, index));
    const turned = leafAngles.reduce((sum, angle) => sum + angle / Math.PI, 0) / LEAVES;
    const right = BLOCK * (1 - 0.45 * turned) + 0.002;
    const left = BLOCK * 0.45 * turned + 0.004;

    rightBlock.scale.y = right - 0.003;
    rightBlock.position.set(PAGE_W / 2 + 0.004, (right + 0.003) / 2, 0);
    leftBlock.visible = turned > 0.001;
    leftBlock.scale.y = Math.max(0.0001, left - 0.004);
    leftBlock.position.set(-PAGE_W / 2 - 0.004, (left + 0.004) / 2, 0);

    const stackTop = right + LEAVES * GAP;
    cover.pose(coverAngle(p), lerp(stackTop + GAP, 0.003, smooth(cover01)));
    leaves.forEach((leaf, index) => {
      const turn = leafAngles[index] / Math.PI;
      const from = right + (LEAVES - index) * GAP;
      const to = left + (index + 1) * GAP;
      leaf.pose(leafAngles[index], lerp(from, to, smooth(turn)));
    });

    // The closed book sits a little turned toward the viewer, then squares up to open.
    const settle = smooth(span(p, 0.04, TIMELINE.coverEnd));
    book.rotation.y = lerp(-0.38, 0, settle);
    book.position.x = lerp(0.05, 0, settle);
  }

  function frame() {
    const p = state.progress;
    const moved =
      Math.abs(p - state.shown) > 1e-5 ||
      Math.abs(state.pointer[0] - state.pointerShown[0]) > 1e-4 ||
      Math.abs(state.pointer[1] - state.pointerShown[1]) > 1e-4;
    if (!moved && !state.dirty) return false;
    state.shown = p;
    state.pointerShown = [...state.pointer];
    state.dirty = false;
    layout(p);
    const portrait = state.width / state.height < 0.9;
    const { position, target } = shot(p, portrait);
    const sway = 1 - span(p, 0.7, 1);
    camera.position.set(
      position[0] + state.pointer[0] * 0.18 * sway,
      position[1] - state.pointer[1] * 0.1 * sway,
      position[2],
    );
    camera.lookAt(...target);
    renderer.render(scene, camera);
    return true;
  }

  function resize(width, height) {
    state.width = width;
    state.height = height;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.fov = width / height < 0.9 ? 40 : 30;
    camera.updateProjectionMatrix();
    state.dirty = true;
  }

  layout(0);
  idle(() => fill(0));

  const api = {
    setProgress(value) {
      state.progress = clamp01(value);
    },
    setPointer(x, y) {
      state.pointer = [x, y];
    },
    resize,
    frame,
    get loading() {
      return pending > 0;
    },
    dispose() {
      renderer.dispose();
    },
  };
  onReady?.(api);
  return api;
}
