// The first-edition card on the Finish stage: a Three.js scene with the Verlet card,
// pointer tilt, flex, slice-or-pull tearing, and a flip to the colophon on the back.
// It renders only while something moves, and stops once the canvas leaves the page.

import * as THREE from "../../../vendor/three.module.min.js";
import { h } from "../dom.js";
import { createFoilMaterial } from "./foil.js";
import { CARD_H, CARD_W, COLS, LOWER_SEAM_ROW, SEAM_Y, VerletPaper } from "./paper.js";
import { drawBack, drawFront } from "./textures.js";

const inSeamBand = (y, band) => Math.abs(y - SEAM_Y) < band;

/**
 * @param {object} edition what the card prints (see textures.js)
 * @param {object} options
 * @param {boolean} options.still reduced motion: no idle tilt, the stub is removed without a fall
 * @param {import("./sound.js").TearSound} options.sound
 * @param {(intact: boolean[]) => void} options.onSnap which seam fibres still hold
 * @param {() => void} options.onRelease
 * @param {(face: "front" | "back") => void} options.onFace
 */
export function createEdition(edition, { still, sound, onSnap, onRelease, onFace }) {
  const hint = h("div", { class: "edition__hint", "aria-hidden": "true" });
  const element = h("div", { class: "edition__stage" }, hint);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute("aria-label", `First edition card for ${edition.title}, with a perforated stub that holds the PDF`);
  element.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);

  const paper = new VerletPaper({
    onSnap: (col) => {
      sound.snap(col, COLS);
      onSnap(paper.seamIntact.slice());
      wake(1500);
    },
    onDetach: () => {
      sound.chord();
      endDrag();
      if (still) geometry.setDrawRange(0, paper.bodyIndexCount);
      onRelease();
      wake(4000);
    },
  });

  const geometry = new THREE.BufferGeometry();
  const positions = new THREE.BufferAttribute(paper.pos, 3);
  positions.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positions);
  geometry.setAttribute("uv", new THREE.BufferAttribute(paper.uv, 2));
  geometry.setIndex(paper.index);
  geometry.computeVertexNormals();

  const material = createFoilMaterial();
  const card = new THREE.Mesh(geometry, material);
  card.frustumCulled = false;
  const root = new THREE.Group();
  root.add(card);
  scene.add(root);

  const textures = [];
  function setTextures(faces) {
    textures.forEach((texture) => texture.dispose());
    textures.length = 0;
    const make = (image, colorSpace) => {
      const texture = new THREE.CanvasTexture(image);
      texture.colorSpace = colorSpace;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      textures.push(texture);
      return texture;
    };
    material.uniforms.uFront.value = make(faces.front.color, THREE.SRGBColorSpace);
    material.uniforms.uFrontMask.value = make(faces.front.mask, THREE.NoColorSpace);
    material.uniforms.uBack.value = make(faces.back.color, THREE.SRGBColorSpace);
    material.uniforms.uBackMask.value = make(faces.back.mask, THREE.NoColorSpace);
  }
  setTextures({ front: drawFront(edition), back: drawBack(edition) });

  // Pose: pointer tilt, flip, and the slide-in of a fresh copy, all as damped springs.
  const pose = { tiltX: 0, tiltY: 0, targetX: 0, targetY: 0, flip: 0, flipTarget: 0, flipVel: 0, slide: still ? 0 : 4, slideVel: 0 };
  let face = "front";

  // Input ----------------------------------------------------------------------------

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane();
  const normal = new THREE.Vector3();
  const origin = new THREE.Vector3();
  let dragMode = null;
  let dragPointer = -1;
  let lastSliceX = 0;

  function setNdc(event) {
    const rect = element.getBoundingClientRect();
    ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  }

  // Where the pointer meets the card's flat plane, in card-local coordinates.
  function localPoint() {
    root.updateMatrixWorld();
    normal.set(0, 0, 1).applyQuaternion(root.quaternion);
    plane.setFromNormalAndCoplanarPoint(normal, root.getWorldPosition(origin));
    raycaster.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, hit) ? root.worldToLocal(hit) : null;
  }

  function hitsCard() {
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObject(card, false).length > 0;
  }

  function showHint(event, label) {
    const rect = element.getBoundingClientRect();
    hint.textContent = label;
    hint.style.left = `${event.clientX - rect.left}px`;
    hint.style.top = `${event.clientY - rect.top - 34}px`;
    hint.classList.add("is-visible");
  }

  function endDrag() {
    if (dragMode && dragMode !== "slice") paper.endGrab();
    if (dragPointer >= 0 && element.hasPointerCapture(dragPointer)) element.releasePointerCapture(dragPointer);
    dragMode = null;
    dragPointer = -1;
    element.classList.remove("is-grabbing", "is-slicing");
    hint.classList.remove("is-visible");
  }

  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || dragMode) return;
    sound.unlock();
    setNdc(event);
    const local = localPoint();
    if (!local) return;
    if (!paper.detached && inSeamBand(local.y, 0.17) && Math.abs(local.x) < CARD_W / 2 + 0.6) {
      dragMode = "slice";
      lastSliceX = local.x;
      element.classList.add("is-slicing");
    } else if (hitsCard()) {
      const stub = local.y < SEAM_Y;
      if (stub && paper.detached) return;
      dragMode = stub ? "pull" : "flex";
      paper.startGrab(local.x, local.y, dragMode);
      element.classList.add("is-grabbing");
    } else return;
    event.preventDefault();
    dragPointer = event.pointerId;
    element.setPointerCapture(event.pointerId);
    wake(1500);
  });

  element.addEventListener("pointermove", (event) => {
    setNdc(event);
    if (!dragMode) {
      if (!still) {
        pose.targetY = ndc.x * 0.3;
        pose.targetX = -ndc.y * 0.2;
        wake(1200);
      }
      const local = localPoint();
      if (local && !paper.detached && inSeamBand(local.y, 0.17) && Math.abs(local.x) < CARD_W / 2 && hitsCard()) showHint(event, "Slice to tear");
      else hint.classList.remove("is-visible");
      return;
    }
    if (event.pointerId !== dragPointer) return;
    const local = localPoint();
    if (!local) return;
    if (dragMode === "slice") {
      if (inSeamBand(local.y, 0.35)) paper.sliceBetween(lastSliceX, local.x);
      lastSliceX = local.x;
    } else {
      paper.moveGrab(local.x, local.y);
      if (dragMode === "pull" && !paper.detached) showHint(event, "Pull to tear");
    }
    wake(1500);
  });

  element.addEventListener("pointerup", endDrag);
  element.addEventListener("pointercancel", endDrag);
  element.addEventListener("pointerleave", () => {
    if (dragMode) return;
    pose.targetX = 0;
    pose.targetY = 0;
    hint.classList.remove("is-visible");
    wake(1200);
  });
  element.addEventListener("dblclick", () => flip());

  // Frame loop -----------------------------------------------------------------------

  const gravity = new THREE.Vector3();
  const inverse = new THREE.Quaternion();
  let awakeUntil = 0;
  let frameId = 0;
  let last = 0;
  let disposed = false;
  let stubGone = false;

  function wake(ms) {
    if (disposed) return;
    awakeUntil = Math.max(awakeUntil, performance.now() + ms);
    if (!frameId) {
      last = performance.now();
      frameId = requestAnimationFrame(frame);
    }
  }

  function resize() {
    const width = element.clientWidth;
    const height = element.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const need = Math.max(CARD_H / 0.84, CARD_W / 0.8 / camera.aspect);
    camera.position.set(0, 0, need / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))));
    camera.updateProjectionMatrix();
    wake(300);
  }
  const resizer = new ResizeObserver(resize);
  resizer.observe(element);

  function frame(now) {
    frameId = 0;
    if (disposed || !element.isConnected) return;
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;

    const ease = 1 - Math.exp(-dt * 7);
    pose.tiltX += (pose.targetX - pose.tiltX) * ease;
    pose.tiltY += (pose.targetY - pose.tiltY) * ease;
    pose.flipVel += ((pose.flipTarget - pose.flip) * 60 - pose.flipVel * 11) * dt;
    pose.flip += pose.flipVel * dt;
    pose.slideVel += (-pose.slide * 70 - pose.slideVel * 15) * dt;
    pose.slide += pose.slideVel * dt;
    root.position.set(0, pose.slide, 0);
    root.rotation.set(pose.tiltX, pose.flip + pose.tiltY, pose.slide * 0.04);

    inverse.copy(root.quaternion).invert();
    gravity.set(0, -1, 0).applyQuaternion(inverse);
    paper.step(dt, gravity, now);
    if (paper.detached && !stubGone && paper.stubBottom() < -CARD_H * 1.6) {
      // The stub has fallen out of frame: stop drawing it.
      stubGone = true;
      geometry.setDrawRange(0, paper.bodyIndexCount);
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();

    const nextFace = Math.cos(pose.flip) >= 0 ? "front" : "back";
    if (nextFace !== face) {
      face = nextFace;
      onFace(face);
    }
    renderer.render(scene, camera);

    const falling = paper.detached && !stubGone && !still;
    const settling = Math.abs(pose.slide) > 0.002 || Math.abs(pose.flipTarget - pose.flip) > 0.002 || Math.abs(pose.targetY - pose.tiltY) > 0.002;
    if (dragMode || falling || settling || now < awakeUntil) frameId = requestAnimationFrame(frame);
  }

  // Controls -------------------------------------------------------------------------

  function flip() {
    pose.flipTarget = pose.flipTarget === 0 ? Math.PI : 0;
    if (still) {
      pose.flip = pose.flipTarget;
      pose.flipVel = 0;
    }
    wake(1600);
  }

  // Tear the stub off column by column, left to right, as if by hand.
  let tearing = null;
  function tear() {
    if (paper.detached || tearing) return;
    sound.unlock();
    const order = paper.seamIntact.map((ok, c) => (ok ? c : -1)).filter((c) => c >= 0);
    if (still) {
      for (const c of order) paper.sever(c);
      wake(300);
      return;
    }
    let i = 0;
    const tick = () => {
      if (disposed || paper.detached || i >= order.length) {
        tearing = null;
        return;
      }
      const c = order[i++];
      paper.sever(c);
      // Tug the stub so the tear visibly runs along the seam.
      for (let r = LOWER_SEAM_ROW; r < LOWER_SEAM_ROW + 11; r++) {
        const v = (r * COLS + c) * 3;
        paper.prev[v + 1] += 0.006;
        paper.prev[v + 2] -= 0.008;
      }
      tearing = setTimeout(tick, 42);
    };
    tick();
  }

  function reset() {
    clearTimeout(tearing);
    tearing = null;
    endDrag();
    paper.reset();
    stubGone = false;
    geometry.setDrawRange(0, Infinity);
    pose.slide = still ? 0 : 4;
    pose.slideVel = 0;
    onSnap(paper.seamIntact.slice());
    wake(1800);
  }

  function dispose() {
    disposed = true;
    clearTimeout(tearing);
    cancelAnimationFrame(frameId);
    resizer.disconnect();
    textures.forEach((texture) => texture.dispose());
    geometry.dispose();
    material.dispose();
    renderer.dispose();
  }

  wake(2000);
  return {
    element,
    tear,
    flip,
    reset,
    dispose,
    wake: () => {
      resize();
      wake(2000);
    },
  };
}
