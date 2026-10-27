// =========================================================================
// glitch.js · raw WebGL2 renderer for the trend hero (no Three.js).
//
// One full-screen triangle. The model is drawn inside a pixel rect
// (x, y, w, h — canvas pixels, origin top-left) computed by main.js, so
// the image keeps its own aspect ratio at any size (never stretched).
//
// Transition (uProgress 0 → 1): ~uSlices horizontal slices with
// noise-irregular heights; 55% of them shift sideways by sin(πp); thin
// scan-line jitter; some slices pixelate at the peak; RGB split grows
// with the shift; every slice flips to the new image at its own random
// threshold with a dotted grain on the edge. uIntensity = 0 → plain
// crossfade (prefers-reduced-motion).
//
// Textures are uploaded premultiplied; everything outside the rect is
// exactly zero (no bright edge lines). Soft shadow = the model's alpha,
// offset down-left, blurred with 8 taps on a low mip, fading near the top.
// =========================================================================

const VERT = /* glsl */ `#version 300 es
void main() {
  // Full-screen triangle from gl_VertexID - no buffers needed.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uTex1;      // current look
uniform sampler2D uTex2;      // next look
uniform vec4  uRect1;         // x, y, w, h (canvas px, top-left origin)
uniform vec4  uRect2;
uniform vec2  uResolution;    // canvas size in px
uniform float uProgress;      // 0 → 1
uniform float uTime;          // seconds
uniform float uIntensity;     // 0 = crossfade, 1 = full glitch
uniform float uSlices;        // ~26
uniform float uShadow;        // shadow opacity, 0 disables it
uniform float uSeed;          // new random layout per transition
uniform float uPx;            // canvas pixels per CSS pixel

out vec4 outColor;

float hash1(float n) { return fract(sin(n * 127.1 + uSeed * 311.7) * 43758.5453123); }
float hash2(vec2 p)  { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed * 17.13) * 43758.5453); }
float vnoise(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash1(i), hash1(i + 1.0), f * f * (3.0 - 2.0 * f));
}

float inside(vec2 uv) {
  return step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
}

// Premultiplied image sample; exactly 0 outside the rect. Gradients come
// from the rect (not from screen derivatives), so slice edges never pick a
// blurry mip level. blk > 1 widens them to match the pixelation.
vec4 img(sampler2D tex, vec4 rect, vec2 p, float blk) {
  vec2 uv = (p - rect.xy) / rect.zw;
  if (inside(uv) < 0.5) return vec4(0.0);
  vec2 gx = vec2(blk / rect.z, 0.0);
  vec2 gy = vec2(0.0, blk / rect.w);
  return textureGrad(tex, uv, gx, gy);
}

// Soft contact shadow: alpha offset down-left, 8 taps on a low mip.
float shadowAlpha(sampler2D tex, vec4 rect, vec2 p) {
  vec2 suv = (p + vec2(0.06 * rect.z, -0.012 * rect.w) - rect.xy) / rect.zw;
  if (suv.x < -0.4 || suv.x > 1.4 || suv.y < -0.05 || suv.y > 1.05) return 0.0;
  // A very low mip: fine details (straps, hair) must not cast a crisp ghost.
  float lod = log2(max(float(textureSize(tex, 0).y) / rect.w, 1.0)) + 6.5;
  float a = 0.0;
  for (int i = 0; i < 8; i++) {
    float ang = float(i) * 0.7853982;
    vec2 u = suv + vec2(cos(ang) * 0.1, sin(ang) * 0.02);
    // Soft fall-off past the image edge (a hard mask would draw a visible line).
    float edge = smoothstep(-0.12, 0.0, u.x) * smoothstep(1.12, 1.0, u.x) * step(0.0, u.y) * step(u.y, 1.0);
    a += textureLod(tex, u, lod).a * edge;
  }
  a *= 0.125;
  return a * smoothstep(0.15, 0.85, suv.y) * uShadow;
}

vec4 look(sampler2D tex, vec4 rect, vec2 p, float blk, float split) {
  vec4 g = img(tex, rect, p, blk);
  vec4 c = g;
  if (split > 0.5) {
    vec4 r = img(tex, rect, p + vec2(split, 0.0), blk);
    vec4 b = img(tex, rect, p - vec2(split, 0.0), blk);
    c = vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
  }
  if (uShadow > 0.0) {
    float sa = shadowAlpha(tex, rect, p);
    vec4 sh = vec4(vec3(0.10, 0.075, 0.05) * sa, sa);  // premultiplied
    c += sh * (1.0 - c.a);
  }
  return c;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  float s = sin(uProgress * 3.14159265) * uIntensity;   // 0 at the ends, 1 at the peak

  // Slices with irregular heights: noise warps y before floor().
  float y = p.y / uResolution.y;
  float yy = y + (vnoise(y * 7.0 + uSeed * 13.0) - 0.5) * 0.07;
  float id = floor(yy * uSlices);
  float moving = step(0.45, hash1(id));                 // 55% of slices move
  float dir = hash1(id + 11.0) * 2.0 - 1.0;
  float dx = dir * (0.03 + 0.15 * hash1(id + 3.0)) * uResolution.x * s * moving;

  // Thin scan-line jitter.
  float tq = floor(uTime * 24.0);
  float line = floor(p.y / (3.0 * uPx));
  float jit = (hash2(vec2(line, tq)) - 0.5) * 24.0 * uPx
            * step(0.93, hash2(vec2(line * 0.37, tq + 3.0))) * s;

  vec2 pp = p + vec2(dx + jit, 0.0);

  // Pixelation for some moving slices at the peak.
  float blk = 1.0;
  if (moving > 0.5 && hash1(id + 7.0) > 0.55) {
    blk = max(1.0, floor(mix(1.0, 20.0, smoothstep(0.55, 1.0, s)) * uPx));
    if (blk > 1.0) pp = (floor(pp / blk) + 0.5) * blk;
  }

  float split = abs(dx) * 0.06 + 3.0 * uPx * s * moving;

  // Per-slice switch moment with a dotted grain on the edge.
  float th = 0.15 + 0.7 * hash1(id + 5.0);
  float grain = (hash2(floor(p / (2.0 * uPx)) + tq) - 0.5) * 0.2;
  float m = smoothstep(th - 0.08, th + 0.08, uProgress + grain);
  m = mix(uProgress, m, clamp(uIntensity, 0.0, 1.0));
  if (uProgress <= 0.0) m = 0.0;
  if (uProgress >= 1.0) m = 1.0;

  vec4 a = m < 1.0 ? look(uTex1, uRect1, pp, blk, split) : vec4(0.0);
  vec4 b = m > 0.0 ? look(uTex2, uRect2, pp, blk, split) : vec4(0.0);
  outColor = mix(a, b, m);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
}

export class GlitchRenderer {
  /** Returns null when WebGL2 isn't available (caller uses the <img> fallback). */
  static create(canvas, onContextLost) {
    let gl = null;
    try {
      gl = canvas.getContext("webgl2", {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: "high-performance",
      });
    } catch {
      gl = null;
    }
    if (!gl) return null;
    try {
      return new GlitchRenderer(canvas, gl, onContextLost);
    } catch (error) {
      console.warn("[trend-hero] WebGL init failed, using fallback:", error);
      return null;
    }
  }

  constructor(canvas, gl, onContextLost) {
    this.canvas = canvas;
    this.gl = gl;
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    this.maxAniso = this.aniso ? gl.getParameter(this.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
    this.vao = gl.createVertexArray();
    this.u = {};
    for (const name of [
      "uTex1", "uTex2", "uRect1", "uRect2", "uResolution", "uProgress", "uTime",
      "uIntensity", "uSlices", "uShadow", "uSeed", "uPx",
    ]) {
      this.u[name] = gl.getUniformLocation(program, name);
    }
    gl.useProgram(program);
    gl.uniform1i(this.u.uTex1, 0);
    gl.uniform1i(this.u.uTex2, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);

    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.lost = true;
      onContextLost?.();
    });
  }

  /** Uploads a decoded image as a premultiplied, mipmapped, anisotropic texture. */
  createTexture(image) {
    const gl = this.gl;
    let source = image;
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    if (w > this.maxTexture || h > this.maxTexture) {
      // Bigger than the GPU allows: downscale on a canvas, keeping the ratio.
      const k = this.maxTexture / Math.max(w, h);
      const c = document.createElement("canvas");
      c.width = Math.floor(w * k);
      c.height = Math.floor(h * k);
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, 0, 0, c.width, c.height);
      source = c;
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, this.maxAniso);
    gl.generateMipmap(gl.TEXTURE_2D);
    return tex;
  }

  deleteTexture(tex) {
    if (tex) this.gl.deleteTexture(tex);
  }

  setSize(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /**
   * Draws one frame. rect1/rect2 are [x, y, w, h] in canvas pixels.
   * Only the area that can contain the model (plus shadow and slice
   * shifts) is shaded - the rest of the canvas is a cheap clear.
   */
  render({ tex1, tex2, rect1, rect2, progress, time, intensity, slices, shadow, seed, px }) {
    if (this.lost) return;
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Scissor to the union of the rects (+ shadow spread); during a
    // transition slices shift by up to ~18% of the width, so widen.
    const shifting = progress > 0 && progress < 1 && intensity > 0;
    const padX = shifting ? W * 0.2 : 0;
    // The shadow spreads left of the figure (offset + blur), so pad that side more.
    let x0 = rect1[0] - rect1[2] * 0.45 - padX;
    let x1 = rect1[0] + rect1[2] * 1.25 + padX;
    let y0 = rect1[1] - 2;
    let y1 = rect1[1] + rect1[3] * 1.05;
    if (progress > 0) {
      x0 = Math.min(x0, rect2[0] - rect2[2] * 0.45 - padX);
      x1 = Math.max(x1, rect2[0] + rect2[2] * 1.25 + padX);
      y0 = Math.min(y0, rect2[1] - 2);
      y1 = Math.max(y1, rect2[1] + rect2[3] * 1.05);
    }
    x0 = Math.max(0, Math.floor(x0));
    x1 = Math.min(W, Math.ceil(x1));
    y0 = Math.max(0, Math.floor(y0));
    y1 = Math.min(H, Math.ceil(y1));
    if (x1 <= x0 || y1 <= y0) return;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x0, H - y1, x1 - x0, y1 - y0);   // scissor origin is bottom-left

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex2 || tex1);
    gl.uniform4f(this.u.uRect1, rect1[0], rect1[1], rect1[2], rect1[3]);
    gl.uniform4f(this.u.uRect2, rect2[0], rect2[1], rect2[2], rect2[3]);
    gl.uniform2f(this.u.uResolution, W, H);
    gl.uniform1f(this.u.uProgress, progress);
    gl.uniform1f(this.u.uTime, time);
    gl.uniform1f(this.u.uIntensity, intensity);
    gl.uniform1f(this.u.uSlices, slices);
    gl.uniform1f(this.u.uShadow, shadow);
    gl.uniform1f(this.u.uSeed, seed);
    gl.uniform1f(this.u.uPx, px);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
