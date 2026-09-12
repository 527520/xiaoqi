# 渲染探针：Mesh + 自定义 GLSL 在透明窗下可用吗？

**日期**：2026-09-12
**命令**：`pnpm probe:mesh`（6 项断言全过）
**产物**：`docs/evidence/runtime/mesh-probe/`

## 为什么要先做这个探针

把宠物的着色从 `Graphics` 平涂换成 GPU 光照，是"立体化"的前提。
但本项目在「透明窗 + 渲染特性」上**反复踩过静默失效**——
打开 DevTools 会让透明窗不透明、`CalculateNativeWinOcclusion` 会让窗口空白、
preload 产出 ESM 会静默不执行。共同点是**不报错、只是不对**。

所以先用一个**独立页面 + 真实透明窗**把风险验掉，而不是直接改 700 行的
`PetStage`：改完之后如果画面不对，根本分不清是"shader 没生效"还是
"窗口属性不兼容"。

## 结论：可用

```
✅ ★ 探针页加载且自定义着色器建立成功
     分步：["texture:ok","uniformGroup:ok","shader:ok","geometry:ok","mesh:ok","addChild:ok","firstRender:ok"]
✅ ★ 网格真的画出了像素（不是空白）
     不透明像素 15278 / 48400
✅ ★ 中心像素不透明且不是纯黑
     中心 rgba = [211,225,252,255]
✅ ★ 四角完全透明（透明窗没有退化成黑方块）
     四角 alpha 全为 0：[0,0,0,0]
✅ ★ 改变光源方向后画面显著不同（uniform 真的进了着色器）
     有差异的采样点 69 个，最大通道差 152
```

`light-ur.png` 与 `light-ll.png` 是**同一个网格**只改了光源方向：
前者亮面在右上，后者亮面在左下，明暗交界线跟着转。
这条对照实验是这个探针真正的价值——它把"光照有没有生效"从一个
**看起来对**变成**可断言**。没有它，前三条全过也可能什么都没做。

## 踩出来的三条 Pixi 8 事实（都花了时间，记下来避免重踩）

### ① 自定义 uniform 必须是 `UniformGroup`

不能直接在 `Shader.from({ resources })` 里塞 `Float32Array` 或裸数字：

```js
// ❌ 抛 TypeError: Cannot create property 'name' on number '1'
resources: { uColor: new Float32Array([1, 1, 1, 1]) }

// ✅ 走 UniformGroup，且每个键带 { value, type }
resources: { lightingUniforms: new UniformGroup({ uLightDir: { value: new Float32Array([...]), type: 'vec3<f32>' } }) }
```

**报错文本完全不提 uniform 名字**，所以第一轮是靠"逐个加 resource、
失败就记名"把它钉出来的（探针页现在仍保留分步记录
`window.__meshProbeSteps`）。这与 pixijs#11359 同类。

### ② 顶点着色器必须有 `aUV`

只提供 `aPosition` 时，几何**建得好好的、什么都不画**——又一个静默失效。

### ③ 无边框小窗里的默认样式会污染"透明"判据

浏览器默认给 `body` 8px 外边距。在 220×220 的无边框窗口里它会立刻造成
溢出，Chromium 于是画出**滚动条**——而滚动条是不透明的 UI。
第一轮的"四角不透明"就是这么**假失败**的：截图上能直接看到两个灰色滚动条。

探针页因此加了 `html, body { margin:0; padding:0; overflow:hidden }`。
**这条对真实宠物页同样重要**（`index.html` 的样式已由 `styles.css` 处理）。

## 一条方法学教训：像素判据必须走截图

第一版探针在页面里用 `drawImage(canvas)` + `getImageData()` 采样，
拿到的是**全透明**，于是报了"网格什么都没画"——而实际上球体画得好好的。

原因就是 `docs/RETRO.md` 已经记过的那条：**WebGL 的 drawing buffer 在
合成后就被清空**（默认 `preserveDrawingBuffer: false`）。

所以像素判据一律走 `Page.captureScreenshot`（**合成结果**）再解 PNG。
顺带产出了 `scripts/lib/png.mjs`——一个零依赖的最小 PNG 解码器
（不装 `pngjs`/`sharp`：本机没有 C++ 编译器，为几行采样引入依赖不划算）。

## 对实现的影响

技术路线确认可行，下一步按计划重写 `PetStage` 的着色部分：

- 形状**仍然程序化**（`PET_GEOMETRY` 与命中测试一行不改）；
- 把现有 `Graphics` 绘制渲染进一张 `RenderTexture` 当 albedo；
- 用 `MeshPlane` + 光照着色器采样它，法线按隐式椭球解析求出；
- 于是"命中判定"与"视觉轮廓"仍然同源，而受光方式变成真正三维的。
