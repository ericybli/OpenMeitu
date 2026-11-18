/**
 * Thin WebGL2 wrapper shared by every render pass.
 *
 * COORDINATE CONVENTION (read this before writing a shader)
 * ---------------------------------------------------------
 * Images are uploaded WITHOUT Y-flip, so texture memory row 0 is the TOP row
 * of the image. The default vertex shader maps the fullscreen quad so that
 * `v_uv = (0,0)` is the image's TOP-LEFT and `v_uv.y` grows DOWNWARDS when
 * rendering into a RenderTarget. This matches normalised face landmarks
 * (x right, y down), so landmark coordinates can be used directly as uv.
 * Only `present()` (drawing to the visible canvas) flips Y.
 *
 * All render targets are RGBA8, LINEAR filtered, CLAMP_TO_EDGE, straight
 * (non-premultiplied) alpha. The canvas is non-premultiplied too, so
 * transparent pixels show the page behind it.
 */

export const DEFAULT_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const COPY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_image;
out vec4 outColor;
void main() { outColor = texture(u_image, v_uv); }
`;

const PRESENT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_image;
out vec4 outColor;
void main() { outColor = texture(u_image, vec2(v_uv.x, 1.0 - v_uv.y)); }
`;

export interface GpuTexture {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
  /** Depth for 3D textures (LUTs), 1 for 2D. */
  readonly depth: number;
  readonly target: '2d' | '3d';
}

export interface RenderTarget extends GpuTexture {
  readonly framebuffer: WebGLFramebuffer;
}

export type UniformValue =
  | number
  | boolean
  | readonly number[]
  | Float32Array
  | Int32Array
  | GpuTexture;

interface UniformInfo {
  location: WebGLUniformLocation;
  type: number;
  size: number;
}

export interface GpuProgram {
  readonly key: string;
  readonly program: WebGLProgram;
  readonly uniforms: ReadonlyMap<string, UniformInfo>;
}

export interface TextureOptions {
  filter?: 'linear' | 'nearest';
  wrap?: 'clamp' | 'repeat' | 'mirror';
}

export interface GpuOptions {
  /**
   * Use a lower texture size limit than the device's. Tests use it to
   * exercise the oversized-image path with small images.
   */
  maxTextureSize?: number;
}

/** Free render targets kept for reuse: bounded in count and in bytes. */
const POOL_MAX_TARGETS = 12;
const POOL_MAX_BYTES = 256 * 1024 * 1024;

function targetBytes(target: GpuTexture): number {
  return target.width * target.height * 4;
}

export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isGpuTexture(v: UniformValue): v is GpuTexture {
  return typeof v === 'object' && v !== null && 'texture' in v && 'target' in v;
}

export class Gpu {
  readonly gl: WebGL2RenderingContext;
  readonly maxTextureSize: number;
  readonly max3DTextureSize: number;

  private readonly programs = new Map<string, GpuProgram>();
  private readonly freeTargets: RenderTarget[] = [];
  private freeBytes = 0;
  private readonly ownedTextures = new Set<WebGLTexture>();
  private readonly ownedFramebuffers = new Set<WebGLFramebuffer>();
  private readonly quadVao: WebGLVertexArrayObject;
  private readonly quadBuffer: WebGLBuffer;
  private disposed = false;

  constructor(gl: WebGL2RenderingContext, options: GpuOptions = {}) {
    this.gl = gl;
    const deviceMax = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.maxTextureSize = Math.min(deviceMax, options.maxTextureSize ?? deviceMax);
    this.max3DTextureSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;

    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    if (!vao || !buf) throw new Error('WebGL2: failed to allocate quad geometry');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.quadVao = vao;
    this.quadBuffer = buf;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  }

  /** Create a Gpu on a canvas. Throws a descriptive error when WebGL2 is unavailable. */
  static create(canvas: HTMLCanvasElement | OffscreenCanvas, options?: GpuOptions): Gpu {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    return new Gpu(gl, options);
  }

  // ---------------------------------------------------------------- programs

  /** Compile (once, cached by key) a program. Attribute 0 is `a_position`. */
  program(key: string, fragmentSource: string, vertexSource: string = DEFAULT_VERTEX_SHADER): GpuProgram {
    const cached = this.programs.get(key);
    if (cached) return cached;
    const gl = this.gl;
    const vs = this.compile(gl.VERTEX_SHADER, vertexSource, key);
    const fs = this.compile(gl.FRAGMENT_SHADER, fragmentSource, key);
    const program = gl.createProgram();
    if (!program) throw new Error(`WebGL2: createProgram failed (${key})`);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'a_position');
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`WebGL2: link failed for "${key}": ${log ?? ''}`);
    }
    const uniforms = new Map<string, UniformInfo>();
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const location = gl.getUniformLocation(program, info.name);
      if (!location) continue;
      const name = info.name.endsWith('[0]') ? info.name.slice(0, -3) : info.name;
      uniforms.set(name, { location, type: info.type, size: info.size });
    }
    const result: GpuProgram = { key, program, uniforms };
    this.programs.set(key, result);
    return result;
  }

  private compile(type: number, source: string, key: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error(`WebGL2: createShader failed (${key})`);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      const stage = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
      throw new Error(`WebGL2: ${stage} shader compile failed for "${key}": ${log ?? ''}`);
    }
    return shader;
  }

  // ---------------------------------------------------------------- textures

  private applyTextureParams(target: number, opts: TextureOptions = {}): void {
    const gl = this.gl;
    const filter = opts.filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    const wrap =
      opts.wrap === 'repeat' ? gl.REPEAT : opts.wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, wrap);
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, wrap);
  }

  /** Create an RGBA8 2D texture, optionally initialised with tightly packed RGBA bytes (row 0 = top). */
  createTexture(width: number, height: number, data: Uint8Array | Uint8ClampedArray | null = null, opts?: TextureOptions): GpuTexture {
    this.assertSize(width, height);
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('WebGL2: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    this.applyTextureParams(gl.TEXTURE_2D, opts);
    const bytes = data ? (data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) : null;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.ownedTextures.add(texture);
    return { texture, width, height, depth: 1, target: '2d' };
  }

  /** Upload a browser image source (ImageBitmap, canvas, <img>, ImageData) as an RGBA8 texture. No Y-flip. */
  uploadImage(source: TexImageSource, opts?: TextureOptions): GpuTexture {
    const { width, height } = sourceSize(source);
    this.assertSize(width, height);
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('WebGL2: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    try {
      this.applyTextureParams(gl.TEXTURE_2D, opts);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (error) {
      gl.deleteTexture(texture);
      throw error;
    } finally {
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    this.ownedTextures.add(texture);
    return { texture, width, height, depth: 1, target: '2d' };
  }

  /**
   * Create a 3D LUT texture. `rgba` is size^3 * 4 bytes with red varying
   * fastest: index = ((b * size + g) * size + r) * 4.
   * Sample with `texture(u_lut, c * ((size-1)/size) + 0.5/size)`.
   */
  createLut3D(size: number, rgba: Uint8Array): GpuTexture {
    if (rgba.length !== size * size * size * 4) {
      throw new Error(`LUT data length ${rgba.length} does not match size ${size}`);
    }
    if (size > this.max3DTextureSize) throw new Error(`LUT size ${size} exceeds MAX_3D_TEXTURE_SIZE`);
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('WebGL2: createTexture failed');
    gl.bindTexture(gl.TEXTURE_3D, texture);
    this.applyTextureParams(gl.TEXTURE_3D, { filter: 'linear', wrap: 'clamp' });
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.bindTexture(gl.TEXTURE_3D, null);
    this.ownedTextures.add(texture);
    return { texture, width: size, height: size, depth: size, target: '3d' };
  }

  /** Create an un-pooled render target. Caller owns it (call deleteTexture when done). */
  createTarget(width: number, height: number, opts?: TextureOptions): RenderTarget {
    const tex = this.createTexture(width, height, null, opts);
    const gl = this.gl;
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error('WebGL2: createFramebuffer failed');
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`WebGL2: framebuffer incomplete (0x${status.toString(16)})`);
    this.ownedFramebuffers.add(framebuffer);
    return { ...tex, framebuffer };
  }

  /** Get a pooled render target of exactly this size. Return it with `release`. Contents are undefined. */
  acquire(width: number, height: number): RenderTarget {
    const idx = this.freeTargets.findIndex((t) => t.width === width && t.height === height);
    if (idx < 0) return this.createTarget(width, height);
    const target = this.freeTargets.splice(idx, 1)[0]!;
    this.freeBytes -= targetBytes(target);
    return target;
  }

  /** Return a target to the pool. The least recently released targets are deleted beyond the pool's bounds. */
  release(target: RenderTarget): void {
    if (this.freeTargets.includes(target)) return;
    this.freeTargets.push(target);
    this.freeBytes += targetBytes(target);
    while (this.freeTargets.length > POOL_MAX_TARGETS || this.freeBytes > POOL_MAX_BYTES) {
      this.deleteTexture(this.freeTargets[0]!);
    }
  }

  /** Free (pooled) render targets: how many and their total size in bytes. */
  get pool(): { targets: number; bytes: number } {
    return { targets: this.freeTargets.length, bytes: this.freeBytes };
  }

  /** Delete a texture or render target created by this Gpu. */
  deleteTexture(tex: GpuTexture): void {
    const gl = this.gl;
    if ('framebuffer' in tex) {
      const fb = (tex as RenderTarget).framebuffer;
      if (this.ownedFramebuffers.delete(fb)) gl.deleteFramebuffer(fb);
      const i = this.freeTargets.indexOf(tex as RenderTarget);
      if (i >= 0) {
        this.freeTargets.splice(i, 1);
        this.freeBytes -= targetBytes(tex);
      }
    }
    if (this.ownedTextures.delete(tex.texture)) gl.deleteTexture(tex.texture);
  }

  /** Drop all pooled (free) render targets, e.g. after the working resolution changed. */
  trimPool(): void {
    while (this.freeTargets.length) this.deleteTexture(this.freeTargets[this.freeTargets.length - 1]!);
  }

  // ---------------------------------------------------------------- drawing

  /**
   * Run `program` over a fullscreen quad into `target` (null = canvas).
   * Uniforms are matched by name against the program's active uniforms;
   * unknown names are ignored (the GLSL compiler may optimise them away).
   * GpuTexture values are bound to texture units automatically.
   */
  draw(program: GpuProgram, target: RenderTarget | null, uniforms: Record<string, UniformValue> = {}, viewport?: Viewport): void {
    const gl = this.gl;
    gl.useProgram(program.program);
    let unit = 0;
    for (const [name, value] of Object.entries(uniforms)) {
      const info = program.uniforms.get(name);
      if (!info) continue;
      if (isGpuTexture(value)) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(value.target === '3d' ? gl.TEXTURE_3D : gl.TEXTURE_2D, value.texture);
        gl.uniform1i(info.location, unit);
        unit++;
        continue;
      }
      this.setUniform(info, value, name, program.key);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
    if (viewport) gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
    else if (target) gl.viewport(0, 0, target.width, target.height);
    else gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    // Unbind textures so a target texture is never bound while being rendered to next time.
    for (let u = 0; u < unit; u++) {
      gl.activeTexture(gl.TEXTURE0 + u);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindTexture(gl.TEXTURE_3D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  private setUniform(info: UniformInfo, value: Exclude<UniformValue, GpuTexture>, name: string, key: string): void {
    const gl = this.gl;
    const arr: ArrayLike<number> =
      typeof value === 'number' ? [value] : typeof value === 'boolean' ? [value ? 1 : 0] : value;
    const loc = info.location;
    switch (info.type) {
      case gl.FLOAT:
        gl.uniform1fv(loc, toF32(arr));
        break;
      case gl.FLOAT_VEC2:
        gl.uniform2fv(loc, toF32(arr));
        break;
      case gl.FLOAT_VEC3:
        gl.uniform3fv(loc, toF32(arr));
        break;
      case gl.FLOAT_VEC4:
        gl.uniform4fv(loc, toF32(arr));
        break;
      case gl.INT:
      case gl.BOOL:
        gl.uniform1iv(loc, toI32(arr));
        break;
      case gl.INT_VEC2:
      case gl.BOOL_VEC2:
        gl.uniform2iv(loc, toI32(arr));
        break;
      case gl.INT_VEC3:
      case gl.BOOL_VEC3:
        gl.uniform3iv(loc, toI32(arr));
        break;
      case gl.INT_VEC4:
      case gl.BOOL_VEC4:
        gl.uniform4iv(loc, toI32(arr));
        break;
      case gl.FLOAT_MAT2:
        gl.uniformMatrix2fv(loc, false, toF32(arr));
        break;
      case gl.FLOAT_MAT3:
        gl.uniformMatrix3fv(loc, false, toF32(arr));
        break;
      case gl.FLOAT_MAT4:
        gl.uniformMatrix4fv(loc, false, toF32(arr));
        break;
      default:
        throw new Error(`Uniform "${name}" in "${key}" has unsupported type 0x${info.type.toString(16)} or needs a texture`);
    }
  }

  /** Copy `input` into `output` (resampling if sizes differ). */
  copy(input: GpuTexture, output: RenderTarget): void {
    this.draw(this.program('gpu.copy', COPY_FRAGMENT_SHADER), output, { u_image: input });
  }

  /**
   * Draw `texture` onto the canvas (default framebuffer), filling `viewport`
   * (default: whole drawing buffer). Handles the Y flip and keeps alpha.
   */
  present(texture: GpuTexture, viewport?: Viewport): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.draw(this.program('gpu.present', PRESENT_FRAGMENT_SHADER), null, { u_image: texture }, viewport);
  }

  /** Read a render target back as tightly packed RGBA8, row 0 = image top (ImageData order). */
  readPixels(target: RenderTarget): Uint8ClampedArray<ArrayBuffer> {
    const gl = this.gl;
    const out = new Uint8ClampedArray(target.width * target.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  private assertSize(width: number, height: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error(`Invalid texture size ${width}x${height}`);
    }
    if (width > this.maxTextureSize || height > this.maxTextureSize) {
      throw new Error(`Texture ${width}x${height} exceeds MAX_TEXTURE_SIZE ${this.maxTextureSize}`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    for (const p of this.programs.values()) gl.deleteProgram(p.program);
    this.programs.clear();
    for (const fb of this.ownedFramebuffers) gl.deleteFramebuffer(fb);
    for (const t of this.ownedTextures) gl.deleteTexture(t);
    this.ownedFramebuffers.clear();
    this.ownedTextures.clear();
    this.freeTargets.length = 0;
    this.freeBytes = 0;
    gl.deleteVertexArray(this.quadVao);
    gl.deleteBuffer(this.quadBuffer);
  }
}

function toF32(a: ArrayLike<number>): Float32Array {
  return a instanceof Float32Array ? a : Float32Array.from(a);
}

function toI32(a: ArrayLike<number>): Int32Array {
  return a instanceof Int32Array ? a : Int32Array.from(a, (v) => Math.round(v));
}

/** Pixel size of any TexImageSource. */
export function sourceSize(source: TexImageSource): { width: number; height: number } {
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight };
  }
  if (typeof VideoFrame !== 'undefined' && source instanceof VideoFrame) {
    return { width: source.displayWidth, height: source.displayHeight };
  }
  const s = source as { width: number; height: number };
  return { width: s.width, height: s.height };
}
