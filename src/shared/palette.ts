import { PET_GEOMETRY } from './constants'

/**
 * 宠物的配色 —— 与 `scripts/generate-icons.mjs` 的 `PALETTE` 是同一套。
 *
 * 之所以单独成文件：图标生成脚本（`.mjs`，构建期）与渲染进程（`.ts`，运行期）
 * 都要用这套颜色，而脚本不便 import `.ts`。两边各存一份是必要的重复，
 * 但**颜色不一致是肉眼立刻能发现的**，因此这份重复的风险远低于几何漂移
 * （几何漂移会让托盘图标与宠物形状对不上，同样是肉眼可见——见图标脚本的自检）。
 *
 * 色板取向：暖奶油身体 + 深棕描边与眼睛。刻意不用纯黑——
 * 纯黑在透明窗上会显得硬、脏，深棕更"活物"。
 */
export const PET_PALETTE = {
  /** 身体主色。 */
  body: 0xfff4d6,
  /** 描边与耳朵内侧阴影。 */
  outline: 0x5a4632,
  /** 眼睛。 */
  eye: 0x3a2c20,
  /** 腮红。 */
  cheek: 0xffb0a8,
  /** 影子（贴地，半透明）。 */
  shadow: 0x000000,
} as const

/** 眼睛与腮红的位置（不在 PET_GEOMETRY 里，命中测试用不到它们）。 */
export const PET_FACE = {
  eyeLeft: { cx: 90, cy: 134, r: 9 },
  eyeRight: { cx: 130, cy: 134, r: 9 },
  cheekLeft: { cx: 76, cy: 152, rx: 9, ry: 6 },
  cheekRight: { cx: 144, cy: 152, rx: 9, ry: 6 },
  /** 影子椭圆：贴着身体底部。 */
  shadow: { cx: PET_GEOMETRY.body.cx, cy: 202, rx: 44, ry: 8 },
} as const
