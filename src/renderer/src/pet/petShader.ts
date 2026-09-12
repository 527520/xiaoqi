import { PET_GEOMETRY } from '@shared/constants'
import { PET_FACE } from '@shared/palette'
import {
  AMBIENT_GROUND,
  AMBIENT_SKY,
  BODY_MATERIAL,
  EYE_MATERIAL,
  INNER_MATERIAL,
  KEY_LIGHT,
} from '@shared/lighting'

/**
 * 宠物的光照着色器（GPU 侧）。
 *
 * ── ⚠️ 这个文件是 `src/shared/lighting.ts` 的**第二份实现** ──
 *
 * GLSL 与 TypeScript 无法共享代码，所以同一套公式写了两遍：CPU 侧那份有
 * 34 条单测钉住方向与边界；GPU 侧这份只能靠"传同一组 uniform、再比对渲染
 * 结果"来验证。
 *
 * **改公式必须同时改两个文件。** 不一致的后果不是报错，而是
 * "测试通过但画面不对"——本项目最怕的那类静默失效。
 *
 * ── 整体做法（一句话）──
 *
 * 把整只宠物（身体/耳朵/尾巴/五官）先用 `Graphics` 画进一张
 * **RenderTexture** 当 albedo，再用 `Mesh` + 这个着色器逐像素重新着色：
 * 法线按"椭圆即球面"解析求出，于是平面图形获得了真正的球面受光。
 * 形状仍然是程序化画的，`PET_GEOMETRY` 与命中测试一行不改。
 *
 * ── 三条来自渲染探针的血泪约定（见 `docs/verify-render-probe.md`）──
 *
 * ① uniform **必须**走 `UniformGroup`，不能在 `resources` 里直接塞
 *    `Float32Array` 或裸数字（会抛一个完全不提 uniform 名字的 TypeError）。
 * ② 顶点着色器**必须**接收 `aUV`，否则几何建好了却什么都不画。
 * ③ 这段是源码里的模板字符串，**注释里不能出现反引号**。
 */

export const VERTEX_SRC = /* glsl */ `
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

/**
 * 片段着色器。
 *
 * 输入 `uAlbedo` 是"只带形状与基色"的宠物；输出是重新着色后的像素。
 */
export const FRAGMENT_SRC = /* glsl */ `
  in vec2 vUV;
  out vec4 finalColor;

  uniform sampler2D uAlbedo;

  uniform vec2 uSize;

  uniform vec4 uBody;    // cx, cy, rx, ry
  uniform vec4 uEarL;    // cx, cy, rx, ry
  uniform vec4 uEarR;    // cx, cy, rx, ry
  uniform vec4 uEyeL;    // cx, cy, rx, ry
  uniform vec3 uEyeColor;   // 用于识别"这是眼睛像素"

  // 注意：uShadowCenter 必须是 vec2（着色器里拿它和 point 相减）。
  // 声明成 vec3 会得到 "no operation minus exists between vec2 and vec3"，
  // 而报错只给 GLSL 行号、不给 uniform 名字（本轮踩过）。
  uniform vec2 uShadowCenter;
  uniform vec2 uShadowRadius;

  uniform vec3 uLightDir;
  uniform float uAmbientGround;
  uniform float uAmbientSky;
  uniform float uBodySpecular;
  uniform float uBodyRim;
  uniform float uBodyShininess;
  uniform float uEyeSpecular;
  uniform float uEyeShininess;
  uniform float uOcclusionRadius;
  uniform float uParallaxX;
  uniform float uParallaxY;

  const vec3 VIEW_DIR = vec3(0.0, 0.0, 1.0);

  bool insideEllipse(vec2 point, vec4 e) {
    vec2 d = (point - e.xy) / e.zw;
    return dot(d, d) <= 1.0;
  }

  // 椭球面法线：椭圆内 z = sqrt(1 - |d|^2)，之外完全侧向。
  // 与 lighting.ts 的 surfaceNormal 是同一套算式。
  vec3 ellipseNormal(vec2 point, vec4 e) {
    vec2 d = (point - e.xy) / e.zw;
    float r2 = dot(d, d);
    if (r2 >= 1.0) return normalize(vec3(d, 0.0));
    return normalize(vec3(d, sqrt(max(0.0, 1.0 - r2))));
  }

  // 归一化距离到椭圆边界的距离（0 = 正好在边界上，1 = 在中心）。
  // 用于估"离接缝多近"，从而压暗凹陷处。
  float edgeProximity(vec2 point, vec4 e) {
    vec2 d = (point - e.xy) / e.zw;
    return clamp(1.0 - length(d), 0.0, 1.0);
  }

  void main(void) {
    vec4 base = texture(uAlbedo, vUV);
    // 透明处直接丢弃：桌宠窗口里这些像素必须真的透明，
    // 否则会变成一个不透明方块挡住下层窗口。
    if (base.a < 0.02) discard;

    vec2 point = vUV * uSize;

    // ── 判断这一像素属于哪个部件，取对应法线 ──
    bool onEarL = insideEllipse(point, uEarL);
    bool onEarR = insideEllipse(point, uEarR);
    bool onEar = onEarL || onEarR;

    // 眼睛靠**颜色**识别：瞳孔/虹膜是暖色，而身体是冷灰。
    // 这样着色器不需要知道眼睛是怎么画的（形状仍归 Graphics 管），
    // 只需要知道"这块像素是玻璃材质"。
    vec3 baseRgb = base.rgb;
    bool onEye = distance(baseRgb, uEyeColor) < 0.28 || dot(baseRgb, vec3(1.0)) < 0.35;

    vec3 normal;
    if (onEye) {
      // 眼睛画在脸的正面、且更凸出：用眼椭球求法线
      normal = ellipseNormal(point, uEyeL);
    } else if (onEar) {
      normal = ellipseNormal(point, onEarL ? uEarL : uEarR);
    } else {
      normal = ellipseNormal(point, uBody);
    }

    // ── 视差：光标偏移让轮廓光方向轻微跟着偏，制造"有厚度"的暗示 ──
    //    幅度很小（设计空间几像素），大了会变成"光源在乱跑"。
    vec3 lightDir = normalize(uLightDir);
    vec3 rimDir = normalize(uLightDir + vec3(uParallaxX, uParallaxY, 0.0));

    // ① 漫反射：明暗交界线来自这一项。
    //    刻意用纯 Lambert——半兰伯特会把背光面也提亮，
    //    于是**明暗交界线消失**，而交界线正是球体感的来源。
    float diffuse = max(dot(normal, lightDir), 0.0);

    // ② 半球环境光：朝上的面接天光（亮），朝下的面接地面反弹（暗）。
    //    ⚠️ 设计空间 y 轴**向下**，所以"朝上"是 n.y < 0。
    float upward = clamp(-normal.y * 0.5 + 0.5, 0.0, 1.0);
    float ambient = uAmbientGround + upward * (uAmbientSky - uAmbientGround);

    // ③ 轮廓光：法线越垂直于视线（越靠边）越亮。指数让亮边**窄**。
    //    方向用 rimDir 而不是 lightDir：视差让亮边随光标轻微移动。
    //    （注意别在这里写反引号——这段是模板字符串，反引号会提前结束它。）
    float rim = pow(1.0 - clamp(dot(normal, VIEW_DIR), 0.0, 1.0), 2.5)
              * clamp(dot(normal, rimDir) * 0.5 + 0.5, 0.0, 1.0);

    // ④ 高光：Blinn-Phong + 标准归一化。
    //    ⚠️ 不做归一化的话，shininess 稍大时高光**实际上不存在**
    //    （正对观察者的球面上半程夹角下限约 50 度，cos^90 约 1e-8）。
    vec3 halfDir = normalize(lightDir + VIEW_DIR);
    float shininess = onEye ? uEyeShininess : uBodyShininess;
    float specStrength = onEye ? uEyeSpecular : uBodySpecular;
    float spec = pow(max(dot(normal, halfDir), 0.0), shininess)
               * specStrength
               * ((shininess + 8.0) / (8.0 * 3.14159265));

    // ⑤ 环境光遮蔽：越靠近身体/耳朵的椭圆边界，越像"接缝"，压暗它。
    //    这是"长在一起"与"前后叠放"的分界。
    float nearBodyEdge = edgeProximity(point, uBody);
    float nearEarEdge = max(edgeProximity(point, uEarL), edgeProximity(point, uEarR));
    float seam = 1.0 - smoothstep(0.0, uOcclusionRadius, min(nearBodyEdge, nearEarEdge));

    // ⑥ 接触阴影：贴地处压暗（没有它，宠物看起来浮在桌面上）
    float shadowDist = length((point - uShadowCenter) / max(uShadowRadius, vec2(0.001)));
    float contact = 1.0 - smoothstep(0.2, 1.2, shadowDist);

    // ⑦ 合成
    vec3 albedo = baseRgb;
    albedo = mix(albedo, albedo * 0.72, contact * 0.6);

    vec3 lit = albedo * (ambient + diffuse * 0.85);
    lit += vec3(rim * uBodyRim);
    lit += vec3(spec);
    // 接缝处压暗：往里混一点环境光色，而不是直接乘 0（乘 0 会死黑）
    lit = mix(lit, lit * 0.55, seam * 0.5);

    float alpha = base.a * mix(0.7, 1.0, smoothstep(1.3, 0.05, shadowDist));

    finalColor = vec4(min(lit, vec3(1.35)), alpha);
  }
`

/**
 * uniform 清单 —— **单一真相**。
 *
 * 单测断言它和着色器源码里的声明一致：漏传一个 uniform 的后果是
 * 它在 GPU 上恒为 0，画面**静默地**不对（例如高光永远不出现）。
 * 那种问题极难从截图上认出来，所以在这里变成一条可断言的清单。
 */
export const UNIFORM_NAMES = [
  'uAlbedo',
  'uSize',
  'uBody',
  'uEarL',
  'uEarR',
  'uEyeL',
  'uEyeColor',
  'uShadowCenter',
  'uShadowRadius',
  'uLightDir',
  'uAmbientGround',
  'uAmbientSky',
  'uBodySpecular',
  'uBodyRim',
  'uBodyShininess',
  'uEyeSpecular',
  'uEyeShininess',
  'uOcclusionRadius',
  'uParallaxX',
  'uParallaxY',
] as const

export type UniformName = (typeof UNIFORM_NAMES)[number]

/**
 * 需要 JS 侧喂值的 uniform（即除纹理之外的全体）。
 *
 * 单列一个类型是为了让"漏传一个"变成**编译错误**而不是画面不对：
 * `uAlbedo` 是纹理、由 `Shader.from` 直接绑定，不属于这一组。
 */
export type PetUniformName = Exclude<UniformName, 'uAlbedo'>

export const VALUE_UNIFORM_NAMES = UNIFORM_NAMES.filter(
  (name): name is PetUniformName => name !== 'uAlbedo',
)

/**
 * uniform 的 GLSL 类型。
 *
 * ⚠️ 这组字面量必须与 Pixi 的 `UNIFORM_TYPES_VALUES` **逐字一致**
 *    （`f32` / `vec2<f32>` / `vec3<f32>` / `vec4<f32>` …）。
 *    写错的后果不是报错，而是 Pixi 在**绑定阶段**静默跳过这个 uniform——
 *    它在 GPU 上恒为 0（例如环境光永远全黑），画面上很难认出来。
 *
 * 类型在本地声明而不是从 `pixi.js` 导入：`UNIFORM_TYPES` 没有从包入口
 * 导出（只有内部模块里有），而深路径导入会与打包形态耦合。
 * 字面量结构与 Pixi 的完全一致，因此赋值时类型检查仍然有效。
 */
export type GlUniformType = 'f32' | 'i32' | 'u32' | 'vec2<f32>' | 'vec3<f32>' | 'vec4<f32>'

/**
 * uniform 的 GLSL 类型。Pixi 8 按它决定上传几个分量，**写错会静默错位**
 * （例如把 vec4 当 f32 传，GPU 上只有第一个分量生效）。
 */
export function uniformTypeOf(name: PetUniformName): GlUniformType {
  switch (name) {
    case 'uSize':
    case 'uShadowRadius':
      return 'vec2<f32>'
    case 'uBody':
    case 'uEarL':
    case 'uEarR':
    case 'uEyeL':
      return 'vec4<f32>'
    case 'uEyeColor':
    case 'uLightDir':
      return 'vec3<f32>'
    case 'uShadowCenter':
      return 'vec2<f32>'
    default:
      return 'f32'
  }
}

/**
 * 从源码里抽出 `uniform <type> <name>;` 的声明名（供单测比对）。
 *
 * ⚠️ **必须先剥掉注释**。源码里到处是解释性的 GLSL 注释，其中难免出现
 * "uniform" 这个词；不剥注释的话这个清单会被说明文字污染，
 * 而"守卫被自己的注释绊倒"正是本项目踩过的坑
 * （版权扫描测试曾匹配到它自己的警告注释）。
 */
export function declaredUniforms(source: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const found: string[] = []
  const re = /uniform\s+\w+\s+(\w+)\s*;/g
  let match = re.exec(withoutComments)
  while (match !== null) {
    // 正则里那个捕获组保证存在，但 `noUncheckedIndexedAccess` 不知道，
    // 所以显式判一下类型而不是用 `!`（lint 禁止非空断言）。
    const name: string | undefined = match[1]
    if (name !== undefined) found.push(name)
    match = re.exec(withoutComments)
  }
  return found
}

/** 环境光遮蔽的衰减半径（设计空间像素）。 */
export const OCCLUSION_RADIUS = 26

/**
 * 构造初始 uniform 值。
 *
 * **从 `PET_GEOMETRY` / `PET_FACE` / `lighting.ts` 派生**，不写第二份数字：
 * 几何一改、材质一调，着色器自动跟着走，不可能漂移。
 */
export function buildUniformValues(): Record<PetUniformName, Float32Array> {
  const body = PET_GEOMETRY.body
  const earL = PET_GEOMETRY.earLeft
  const earR = PET_GEOMETRY.earRight
  const eye = PET_FACE.eyeLeft

  return {
    // uSize 在 setSize 时填；这里给设计尺寸作为初值
    uSize: new Float32Array([PET_GEOMETRY.window.width, PET_GEOMETRY.window.height]),
    uBody: new Float32Array([body.cx, body.cy, body.rx, body.ry]),
    uEarL: new Float32Array([earL.cx, earL.cy, earL.r, earL.r]),
    uEarR: new Float32Array([earR.cx, earR.cy, earR.r, earR.r]),
    // 眼睛是椭圆（rx/ry 不同），照实传
    uEyeL: new Float32Array([eye.cx, eye.cy, eye.rx, eye.ry]),
    uEyeColor: new Float32Array([0.85, 0.54, 0.25]),
    uShadowCenter: new Float32Array([PET_FACE.shadow.cx, PET_FACE.shadow.cy]),
    uShadowRadius: new Float32Array([PET_FACE.shadow.rx * 1.2, PET_FACE.shadow.ry * 1.6]),
    uLightDir: new Float32Array([KEY_LIGHT.x, KEY_LIGHT.y, KEY_LIGHT.z]),
    uAmbientGround: new Float32Array([AMBIENT_GROUND]),
    uAmbientSky: new Float32Array([AMBIENT_SKY]),
    uBodySpecular: new Float32Array([BODY_MATERIAL.specularStrength]),
    uBodyRim: new Float32Array([BODY_MATERIAL.rimStrength]),
    uBodyShininess: new Float32Array([BODY_MATERIAL.shininess]),
    uEyeSpecular: new Float32Array([EYE_MATERIAL.specularStrength]),
    uEyeShininess: new Float32Array([EYE_MATERIAL.shininess]),
    uOcclusionRadius: new Float32Array([OCCLUSION_RADIUS]),
    uParallaxX: new Float32Array([0]),
    uParallaxY: new Float32Array([0]),
  }
}

/**
 * 耳朵内侧材质的强度 —— 目前用于生成 albedo 时的柔化，
 * 以及将来做"耳朵单独材质"的接点。保留导出以免被当成死代码删掉。
 */
export const EAR_INNER_SPECULAR = INNER_MATERIAL.specularStrength
