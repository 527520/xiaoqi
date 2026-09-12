import 'pixi.js/unsafe-eval'

import {
  Application,
  BufferImageSource,
  Mesh,
  MeshGeometry,
  Shader,
  Texture,
  UniformGroup,
} from 'pixi.js'

/**
 * 网格 + 自定义光照着色器的**最小探针**。
 *
 * ── 它存在的理由 ──
 *
 * 把宠物的着色从 Pixi `Graphics` 平涂换成 GPU 光照，是"立体化"的前提。
 * 但本项目在"透明窗 + 渲染特性"上**反复踩过静默失效**：打开 DevTools 会让
 * 透明窗不透明、`CalculateNativeWinOcclusion` 会让窗口空白、preload 产出
 * ESM 会静默不执行。共同点是**不报错、只是不对**。
 *
 * 所以先用一个独立页面把四件事验掉，而不是直接改 700 行的 `PetStage`：
 *
 * 1. 自定义 shader 能否建起来（失败时错误文本能不能定位原因？）；
 * 2. 网格是否真的画出了像素；
 * 3. **透明区域是否仍然透明**（桌宠的命脉）；
 * 4. ★ **光照是否真的受 uniform 控制**——只改光源方向，画面必须不同。
 *    这是**对照实验**：若两个方向渲染出同样的像素，说明 uniform 根本没进
 *    shader，那后面的立体化全是白做。
 *
 * ── 本探针踩出来的两条 Pixi 8 事实（都写进代码注释，避免重踩）──
 *
 * ① **自定义 uniform 必须是 `UniformGroup`**，不能直接在
 *    `Shader.from({ resources })` 里塞 `Float32Array` 或裸数字。
 *    后果是一个完全不提 uniform 的报错：
 *    `TypeError: Cannot create property 'name' on number '1'`。
 *    （与 pixijs#11359 同类。）第一版就是这么失败的，见
 *    `docs/evidence/runtime/mesh-probe/`。
 * ② **顶点着色器必须有 `aUV` 属性**。Pixi 8 的网格管线按 `aUV` 找 uv 缓冲区，
 *    只提供 `aPosition` 会导致几何虽然建好了却**什么都不画**——
 *    又是一个静默失效。
 */

const DESIGN = 220
const SPHERE_R = 70

/**
 * 造一张最简单的 albedo 纹理：一块**圆**。
 *
 * 刻意不用 `Graphics` 画——那会引入"纹理生成是否正确"这个额外变量。
 * 形状完全由代码决定，探针的结论才干净。
 */
function makeCircleTexture(): Texture {
  const cx = DESIGN / 2
  const cy = DESIGN / 2
  const data = new Uint8Array(DESIGN * DESIGN * 4)

  for (let y = 0; y < DESIGN; y++) {
    for (let x = 0; x < DESIGN; x++) {
      const i = (y * DESIGN + x) * 4
      if ((x - cx) ** 2 + (y - cy) ** 2 > SPHERE_R * SPHERE_R) continue
      data[i] = 232
      data[i + 1] = 238
      data[i + 2] = 245
      data[i + 3] = 255
    }
  }

  return new Texture({
    source: new BufferImageSource({ resource: data, width: DESIGN, height: DESIGN }),
  })
}

const VERTEX = /* glsl */ `
  in vec2 aPosition;
  in vec2 aUV;

  out vec2 vUV;

  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform vec4 uWorldColorAlpha;

  void main(void) {
    mat3 world = uWorldTransformMatrix;
    vec3 projected = uProjectionMatrix * world * vec3(aPosition, 1.0);
    gl_Position = vec4(projected.xy, 0.0, 1.0);
    vUV = aUV;
  }
`

const FRAGMENT = /* glsl */ `
  in vec2 vUV;
  out vec4 finalColor;

  uniform sampler2D uTexture;
  uniform vec3 uLightDir;

  void main(void) {
    vec4 tex = texture(uTexture, vUV);
    if (tex.a < 0.01) discard;

    // 把圆**当作一个球**来着色：法线由像素位置解析求出，不需要法线贴图。
    // 这正是"程序化立体"的关键——形状仍是代码画的，但受光方式变成了真正三维的。
    vec2 p = (vUV * vec2(220.0) - vec2(110.0)) / 70.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    vec3 normal = normalize(vec3(p, sqrt(max(0.0, 1.0 - r2))));

    vec3 lightDir = normalize(uLightDir);
    vec3 viewDir = vec3(0.0, 0.0, 1.0);

    // ① 漫反射：明暗交界线来自这一项
    float diffuse = max(dot(normal, lightDir), 0.0);

    // ② 半球环境光：上冷下暖。这一步最能出体积
    float sky = normal.y * 0.5 + 0.5;
    vec3 ambient = mix(vec3(0.30, 0.33, 0.40), vec3(0.55, 0.60, 0.70), sky);

    // ③ 轮廓光：把角色从背景"剪"出来
    float rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.5);

    // ④ 高光
    vec3 halfDir = normalize(lightDir + viewDir);
    float spec = pow(max(dot(normal, halfDir), 0.0), 40.0);

    vec3 albedo = tex.rgb;
    vec3 color = albedo * (ambient + diffuse * 0.85) + vec3(rim * 0.35) + vec3(spec * 0.6);

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
  // 分步记录挂到 window 上：Pixi 的报错常常提不到调用方，
  // 有分步才知道**卡在哪一步**（本探针第一轮就是靠它把范围缩到 shader）。
  Reflect.set(window, '__meshProbeSteps', steps)

  const app = new Application()
  await app.init({
    width: DESIGN,
    height: DESIGN,
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

  const texture = step('texture', makeCircleTexture)

  // ★ 自定义 uniform 走 UniformGroup —— 见文件头事实 ①
  const lightingUniforms = step(
    'uniformGroup',
    () =>
      new UniformGroup({
        uLightDir: { value: new Float32Array([0.55, -0.6, 0.58]), type: 'vec3<f32>' },
      }),
  )

  const shader = step('shader', () =>
    Shader.from({
      gl: { vertex: VERTEX, fragment: FRAGMENT },
      resources: {
        uTexture: texture.source,
        lightingUniforms,
      },
    }),
  )

  // ★ 必须带 aUV —— 见文件头事实 ②
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
  step('addChild', () => app.stage.addChild(mesh))

  Reflect.set(window, '__meshProbe', {
    /** 改光源方向并渲染一帧。 */
    setLight(x: number, y: number, z: number): boolean {
      const uniforms = lightingUniforms.uniforms as { uLightDir: Float32Array }
      uniforms.uLightDir[0] = x
      uniforms.uLightDir[1] = y
      uniforms.uLightDir[2] = z
      app.render()
      return true
    },
    info(): { type: string; canvasCount: number; steps: string[] } {
      return {
        type: String(app.renderer.type),
        canvasCount: document.querySelectorAll('canvas').length,
        steps,
      }
    },
  })

  // 用块体包住：`app.render()` 返回 void，而箭头函数简写返回 void 表达式
  // 会被 lint 的 no-confusing-void-expression 拦下。
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
