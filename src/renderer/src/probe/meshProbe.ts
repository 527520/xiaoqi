import 'pixi.js/unsafe-eval'

import {
  Application,
  BufferImageSource,
  Container,
  Graphics,
  Mesh,
  MeshGeometry,
  MeshPlane,
  RenderTexture,
  Shader,
  Texture,
  UniformGroup,
} from 'pixi.js'

/**
 * 渲染探针 —— 两个用途。
 *
 * ── 一、光照着色器的对照实验（`pnpm probe:mesh`）──
 *
 * 把圆当球面着色，然后**只改光源方向**再渲染一次：画面必须显著不同。
 * 没有这条对照，其余判据全过也可能什么都没做。
 *
 * ── 二、★ Mesh 变换语义的隔离实验（`pnpm probe:mesh --variants`）★ ──
 *
 * 把"GPU 光照"接进 `PetStage` 时卡住了：网格的 `position` / `scale`
 * 对渲染结果**完全没有影响**——扫了 6 组位置、又试了 2 倍缩放，
 * 可见包围盒始终不变。而同一个网格在 `stage` 上时，`worldTransform`
 * 的值确实在变，所以起初误判成"已经修好"。
 *
 * 那说明"变换的值在变"与"顶点被正确变换"是两件事。到底哪一种构造方式
 * 才能让变换生效？与其在 800 行的 `PetStage` 里继续试，不如在这里
 * **并排放几种画法**，各自放在明确的位置上，截图一看便知。
 *
 * 三种画法（都在同一条水平线上，从左到右）：
 *   A. `MeshPlane`（内置 shader + 默认几何）—— 最"正统"的用法
 *   B. `Mesh` + 自建几何 + 自定义 shader（`PetStage` 里用的那种）
 *   C. `Graphics`（对照组：它一定是好的，用来确认窗口与截图链路没问题）
 *
 * 判据：三者是否都出现在**各自设定的位置**上，且左右顺序正确。
 */

const DESIGN = 220
const SPHERE_R = 70

/**
 * 变体实验专用画布尺寸。
 *
 * 比设计空间（220）宽：要并排放四种画法且**互不重叠**。
 * 初版沿用 220 宽、四个圆心只隔 70–80px 而半径 32，
 * 于是它们在像素上连成一片，驱动脚本只测到一个区段，
 * 结论完全失真。
 */
const VARIANTS_W = 380
const VARIANTS_H = 260
const VARIANT_Y = 130
const VARIANT_R = 32

/** 把 0xRRGGBB 变成不透明像素数据里的一块圆。 */
function makeCircleTexture(color: number, radius: number): Texture {
  const cx = DESIGN / 2
  const cy = DESIGN / 2
  const data = new Uint8Array(DESIGN * DESIGN * 4)
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff

  for (let y = 0; y < DESIGN; y++) {
    for (let x = 0; x < DESIGN; x++) {
      const i = (y * DESIGN + x) * 4
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }

  return new Texture({
    source: new BufferImageSource({ resource: data, width: DESIGN, height: DESIGN }),
  })
}

const VERTEX_SRC = /* glsl */ `
  in vec2 aPosition;
  in vec2 aUV;

  out vec2 vUV;

  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform vec4 uWorldColorAlpha;

  void main(void) {
    vec3 projected = uProjectionMatrix * uWorldTransformMatrix * vec3(aPosition, 1.0);
    gl_Position = vec4(projected.xy, 0.0, 1.0);
    vUV = aUV;
  }
`

const FRAGMENT_SRC = /* glsl */ `
  in vec2 vUV;
  out vec4 finalColor;

  uniform sampler2D uTexture;
  uniform vec3 uLightDir;

  void main(void) {
    vec4 tex = texture(uTexture, vUV);
    if (tex.a < 0.01) discard;

    // 把圆**当作一个球**来着色：法线由像素位置解析求出，不需要法线贴图。
    vec2 p = (vUV * vec2(220.0) - vec2(110.0)) / 70.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    vec3 normal = normalize(vec3(p, sqrt(max(0.0, 1.0 - r2))));

    vec3 lightDir = normalize(uLightDir);
    vec3 viewDir = vec3(0.0, 0.0, 1.0);

    float diffuse = max(dot(normal, lightDir), 0.0);
    float sky = -normal.y * 0.5 + 0.5;
    vec3 ambient = mix(vec3(0.30, 0.33, 0.40), vec3(0.55, 0.60, 0.70), sky);
    float rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.5);
    vec3 halfDir = normalize(lightDir + viewDir);
    float spec = pow(max(dot(normal, halfDir), 0.0), 40.0);

    vec3 color = tex.rgb * (ambient + diffuse * 0.85) + vec3(rim * 0.35) + vec3(spec * 0.6);
    finalColor = vec4(color, tex.a);
  }
`

async function boot(): Promise<void> {
  const steps: string[] = []
  const step = <T>(name: string, fn: () => T): T => {
    try {
      const value = fn()
      steps.push(`${name}:ok`)
      return value
    } catch (error) {
      steps.push(`${name}:FAIL ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }
  Reflect.set(window, '__meshProbeSteps', steps)

  const variants = new URLSearchParams(location.search).has('variants')

  const app = new Application()
  await app.init({
    width: variants ? VARIANTS_W : DESIGN,
    height: variants ? VARIANTS_H : DESIGN,
    resolution: 1,
    autoDensity: false,
    backgroundAlpha: 0,
    antialias: true,
    preference: 'webgl',
    powerPreference: 'low-power',
  })

  const root = document.getElementById('probe-root')
  if (!root) throw new Error('找不到 #probe-root')
  root.appendChild(app.canvas)

  if (variants) {
    bootVariants(app, step, steps)
    return
  }
  bootLighting(app, step, steps)
}

/**
 * 变体实验：三种画法并排，各自设定明确位置。
 *
 * 位置从左到右：A 在 x=20，B 在 x=90，C 在 x=160（都是圆心）。
 * 三者都画在 y=110。**顺序与位置都对**才说明变换生效。
 */
function bootVariants(
  app: Application,
  step: <T>(n: string, f: () => T) => T,
  steps: string[],
): void {
  const lighting = new UniformGroup({
    uLightDir: { value: new Float32Array([0.55, -0.6, 0.58]), type: 'vec3<f32>' },
  })

  // ── A: MeshPlane（内置 shader、默认几何）──
  const texA = step('texA', () => makeCircleTexture(0xd98a3f, VARIANT_R))
  const planeA = step('planeA', () => new MeshPlane({ texture: texA, verticesX: 2, verticesY: 2 }))
  planeA.position.set(50, VARIANT_Y)
  app.stage.addChild(planeA)

  // ── B: Mesh + 自建几何 + 自定义 shader（PetStage 用的那种）──
  const texB = step('texB', () => makeCircleTexture(0x4a7fb5, VARIANT_R))
  const shaderB = step('shaderB', () =>
    Shader.from({
      gl: { vertex: VERTEX_SRC, fragment: FRAGMENT_SRC },
      resources: { uTexture: texB.source, lightingUniforms: lighting },
    }),
  )
  const half = 100
  const geomB = step(
    'geomB',
    () =>
      new MeshGeometry({
        positions: new Float32Array([-half, -half, half, -half, half, half, -half, half]),
        uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      }),
  )
  const meshB = step('meshB', () => new Mesh({ geometry: geomB, shader: shaderB }))
  meshB.position.set(140, VARIANT_Y)
  app.stage.addChild(meshB)

  // ── C: Graphics（对照组）──
  const g = new Graphics()
  g.circle(230, VARIANT_Y, VARIANT_R).fill(0x3f7a4c)
  app.stage.addChild(g)

  // ── D: Graphics → RenderTexture → MeshPlane ──
  //
  // 这是**生产里要用的形状**：形状仍用 Graphics 画，烘进一张纹理，
  // 再由网格显示。A/B 都没画出来，所以补这一路来判断问题在
  // "纹理的来源"还是"网格本身"。
  const ctx = step('renderTexture', () => RenderTexture.create({ width: 120, height: 120 }))
  const sourceArt = new Graphics()
  sourceArt.circle(60, 60, VARIANT_R).fill(0xb05fa0)
  const bakeHolder = new Container()
  bakeHolder.addChild(sourceArt)
  step('bake', () => {
    app.renderer.render({ container: bakeHolder, target: ctx, clear: true })
  })
  const planeD = step('planeD', () => new MeshPlane({ texture: ctx, verticesX: 2, verticesY: 2 }))
  // 纹理 120×120、圆心在 (60,60)；要让圆心落在 (200,110)，左上角应在 (140,50)。
  planeD.position.set(260, VARIANT_Y - 60)
  planeD.width = 120
  planeD.height = 120
  app.stage.addChild(planeD)

  // 位置写进诊断面，供脚本核对
  Reflect.set(window, '__meshProbe', {
    setLight(): boolean {
      return true
    },
    /**
     * 逐个网格报告**它自己认为**的状态。
     *
     * "没画出来"可能是：不可见 / 不可渲染 / 走批处理 / 纹理是空的。
     * 只截一张图完全分不清，把每个对象的自述读出来才定位得了。
     */
    meshes(): string {
      const describe = (node: unknown): Record<string, unknown> => {
        const n = node as {
          visible?: boolean
          renderable?: boolean
          alpha?: number
          isRenderable?: () => boolean
          width?: number
          height?: number
          x?: number
          y?: number
          texture?: { width?: number; height?: number; uid?: number }
          geometry?: { positions?: Float32Array; uvs?: Float32Array; indices?: Uint32Array }
        }
        return {
          visible: n.visible,
          renderable: n.renderable,
          alpha: n.alpha,
          isRenderable: typeof n.isRenderable === 'function' ? n.isRenderable() : null,
          x: Math.round(n.x ?? 0),
          y: Math.round(n.y ?? 0),
          w: Math.round(n.width ?? 0),
          h: Math.round(n.height ?? 0),
          texW: n.texture?.width ?? null,
          texH: n.texture?.height ?? null,
          posLen: n.geometry?.positions?.length ?? null,
          uvLen: n.geometry?.uvs?.length ?? null,
        }
      }

      let bakedHasPixels: number | null = null
      try {
        const res = ctx.source.resource as Uint8Array | undefined
        if (res) {
          let count = 0
          for (let i = 3; i < res.length; i += 4) if ((res[i] ?? 0) > 8) count++
          bakedHasPixels = count
        }
      } catch {
        bakedHasPixels = -1
      }

      return JSON.stringify({
        planeA: describe(planeA),
        meshB: describe(meshB),
        planeD: describe(planeD),
        graphicsC: describe(g),
        bakedHasPixels,
      })
    },
    /** 回读三者的位置，以及它们是否在场景图里。 */
    variants(): string {
      return JSON.stringify({
        planeA: { x: planeA.x, y: planeA.y, parent: planeA.parent !== null },
        meshB: { x: meshB.x, y: meshB.y, parent: meshB.parent !== null },
        graphics: { parent: g.parent !== null },
        planeD: { x: planeD.x, y: planeD.y, w: planeD.width, h: planeD.height },
        stageChildren: app.stage.children.length,
      })
    },
    /** 列出场景图，确认结构 */
    tree(): string {
      const walk = (node: Container, depth: number): unknown[] => {
        const self = {
          d: depth,
          type: node.constructor.name,
          x: Math.round(node.x),
          y: Math.round(node.y),
          sx: Math.round(node.scale.x * 100) / 100,
        }
        return [self, ...node.children.flatMap((c) => walk(c, depth + 1))]
      }
      return JSON.stringify(walk(app.stage, 0))
    },
    info(): { type: string; canvasCount: number; steps: string[]; mode: string } {
      return {
        type: String(app.renderer.type),
        canvasCount: document.querySelectorAll('canvas').length,
        steps,
        mode: 'variants',
      }
    },
  })

  app.render()
}

/** 光照对照实验（原来的用途，保持不变）。 */
function bootLighting(
  app: Application,
  step: <T>(n: string, f: () => T) => T,
  steps: string[],
): void {
  const texture = step('texture', () => makeCircleTexture(0xe8eef5, SPHERE_R))

  const lightingUniforms = step(
    'uniformGroup',
    () =>
      new UniformGroup({
        uLightDir: { value: new Float32Array([0.55, -0.6, 0.58]), type: 'vec3<f32>' },
      }),
  )

  const shader = step('shader', () =>
    Shader.from({
      gl: { vertex: VERTEX_SRC, fragment: FRAGMENT_SRC },
      resources: { uTexture: texture.source, lightingUniforms },
    }),
  )

  const geometry = step(
    'geometry',
    () =>
      new MeshGeometry({
        positions: new Float32Array([0, 0, DESIGN, 0, DESIGN, DESIGN, 0, DESIGN]),
        uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      }),
  )

  const mesh = step('mesh', () => new Mesh({ geometry, shader }))
  step('addChild', () => {
    app.stage.addChild(mesh)
  })

  Reflect.set(window, '__meshProbe', {
    setLight(x: number, y: number, z: number): boolean {
      const uniforms = lightingUniforms.uniforms as { uLightDir: Float32Array }
      uniforms.uLightDir[0] = x
      uniforms.uLightDir[1] = y
      uniforms.uLightDir[2] = z
      app.render()
      return true
    },
    info(): { type: string; canvasCount: number; steps: string[]; mode: string } {
      return {
        type: String(app.renderer.type),
        canvasCount: document.querySelectorAll('canvas').length,
        steps,
        mode: 'lighting',
      }
    },
  })

  step('firstRender', () => {
    app.render()
  })
}

boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const steps = (Reflect.get(window, '__meshProbeSteps') as string[] | undefined) ?? []
  document.title = `探针失败：${message}`
  const root = document.getElementById('probe-root')
  if (root) root.textContent = `探针失败：${message}\n步骤：${steps.join(' | ')}`
  console.error('[meshProbe] 启动失败', error, steps)
})
