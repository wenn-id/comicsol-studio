// Amber foil for the first-edition card: a thin-film sweep from a cosine palette, Voronoi
// glitter flakes that flash when they face the light, letterpress emboss from the mask's
// green channel, and the punched holes cut out with discard. Normals come from the
// deformed mesh every frame, so the foil follows the bend.

import * as THREE from "../../../vendor/three.module.min.js";

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vViewPos;

  void main() {
    vUv = uv;
    vNormalV = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uFront;
  uniform sampler2D uFrontMask;
  uniform sampler2D uBack;
  uniform sampler2D uBackMask;
  uniform vec3 uLightDir;
  uniform vec3 uFillDir;
  uniform vec2 uTexel;

  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vViewPos;

  const float TAU = 6.28318530718;

  vec3 palette(float t) {
    return vec3(0.78, 0.6, 0.3) + vec3(0.3, 0.26, 0.2) * cos(TAU * (vec3(1.0, 1.0, 0.8) * t + vec3(0.0, 0.08, 0.22)));
  }

  vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
  }

  float glitter(vec2 uv, vec3 N, vec3 V, vec3 L) {
    vec2 g = uv * vec2(90.0, 153.0);
    vec2 cell = floor(g);
    vec2 f = fract(g);
    float best = 8.0;
    vec2 id = vec2(0.0);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 o = vec2(float(x), float(y));
        vec2 p = o + hash2(cell + o);
        float d = length(p - f);
        if (d < best) { best = d; id = cell + o; }
      }
    }
    vec2 h = hash2(id * 1.37) * 2.0 - 1.0;
    vec3 fn = normalize(N + vec3(h * 0.55, 0.0));
    float s = pow(max(dot(fn, normalize(L + V)), 0.0), 220.0);
    return s * smoothstep(0.42, 0.0, best) * step(0.55, hash2(id + 7.1).x);
  }

  void main() {
    bool front = gl_FrontFacing;
    // The back is seen through the card, so its texture is mirrored.
    vec2 uv = front ? vUv : vec2(1.0 - vUv.x, vUv.y);
    vec4 base = front ? texture2D(uFront, uv) : texture2D(uBack, uv);
    if (base.a < 0.5) discard;
    vec3 mask = front ? texture2D(uFrontMask, uv).rgb : texture2D(uBackMask, uv).rgb;

    vec3 N = normalize(vNormalV) * (front ? 1.0 : -1.0);
    vec3 V = normalize(-vViewPos);

    float hX = front ? texture2D(uFrontMask, uv + vec2(uTexel.x, 0.0)).g : texture2D(uBackMask, uv + vec2(uTexel.x, 0.0)).g;
    float hY = front ? texture2D(uFrontMask, uv + vec2(0.0, uTexel.y)).g : texture2D(uBackMask, uv + vec2(0.0, uTexel.y)).g;
    vec3 Np = normalize(N + vec3((mask.g - hX) * (front ? 1.0 : -1.0), mask.g - hY, 0.0) * 3.2);

    vec3 L = normalize(uLightDir);
    vec3 H = normalize(L + V);
    float diff = max(dot(Np, L), 0.0);
    float fill = max(dot(Np, normalize(uFillDir)), 0.0);
    vec3 paper = base.rgb * (0.66 + diff * 0.3 + fill * 0.1);
    float sheen = pow(max(dot(Np, H), 0.0), 40.0) * 0.06;

    float foil = mask.r;
    float ndv = dot(Np, V);
    float t = ndv * 1.6 + (uv.x * 0.9 + uv.y * 1.3) + mask.b * 0.9 + dot(Np.xy, vec2(1.3, -0.9)) * 1.2;
    vec3 rainbow = palette(t);
    float spec = pow(max(dot(Np, H), 0.0), 18.0);
    float fres = pow(1.0 - max(ndv, 0.0), 2.0);
    vec3 foilCol = mix(vec3(0.95, 0.8, 0.48) * (0.55 + diff * 0.5), rainbow, 0.72) * (0.78 + spec * 0.9 + fres * 0.6);
    vec3 col = mix(paper, foilCol, foil * 0.9);
    col += glitter(uv, Np, V, L) * foil * 1.3 * mix(vec3(1.0), rainbow, 0.4);
    col += sheen + spec * foil * 0.25;

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export function createFoilMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    uniforms: {
      uFront: { value: null },
      uFrontMask: { value: null },
      uBack: { value: null },
      uBackMask: { value: null },
      uLightDir: { value: new THREE.Vector3(0.5, 0.7, 0.8) },
      uFillDir: { value: new THREE.Vector3(-0.6, -0.2, 0.6) },
      uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1740) },
    },
  });
}
