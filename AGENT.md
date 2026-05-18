# AGENT.md

这份文档给后续维护者或 AI 代理使用。这个仓库不是普通的 Vite 模板，而是一个本地 AI 图像/视频创作画布。处理代码时要把用户工程、素材、生成结果和环境配置都视为真实本地数据。

## 项目概览

Demiurge My Canvas 是一个基于 React + Vite 的 AI 多模态创作工作台。用户可以在节点画布里导入素材、连接图片/视频/文本节点、引用上游媒体、生成新资产、分析图片、保存可复用素材，并把整个创作过程持久化为本地工程。

项目运行时由三部分组成：

- Vite 前端：`5173`
- Node API 服务：`8787`
- Python 媒体生成服务：`8790`

前端统一请求 `/api/*`，再由 Vite 代理转发到对应后端。正常开发时优先运行：

```bash
npm run dev:all
```

## 用户能做什么

- 创建、打开、重命名、复制、删除本地工程。
- 在无限画布里工作。
- 添加图片节点、视频节点、文本分析节点。
- 上传本地图片或视频到画布。
- 通过节点连线把上游素材传给下游生成节点。
- 在提示词中使用 `@图片1` 这类引用。
- 通过已配置的图片模型生成图片。
- 通过 Seedance 或 Wan 类视频模型生成视频。
- 轮询异步视频任务，并把完成的视频保存到本地。
- 裁剪、标注、放大查看、下载和复用图片。
- 播放、静音、剪辑、截帧和复用视频。
- 把图片/视频保存到跨工程素材库。
- 保存 Seedance 主体库、人脸审核信息，用于角色一致性工作流。

## 重要文件

```text
src/App.jsx
```

主应用和画布外壳。负责 React Flow 配置、节点创建、选择、批量上传、编组、复制、排列、自动保存、素材库接入和工程级 UI。

```text
src/ProjectDashboard.jsx
```

工程浏览首页。调用 `/api/project/list`、`/api/project/create`、`/api/project/load` 以及重命名、复制、删除接口，并把加载后的工作区传入 `App`。

```text
src/AIImageNode.jsx
```

图片节点。负责本地上传、生成图状态、提示词输入、模型/比例/尺寸控制、提示词翻译、图片生成、裁剪、标注、下载、Seedance 人脸审核和保存到素材库。

```text
src/AIVideoNode.jsx
```

视频节点。负责本地视频素材、文本/图片/视频参考输入、Seedance 场景、时长/分辨率/比例设置、视频生成请求、异步轮询、剪辑工具、截帧、下载和主体库 UI。

```text
src/AITextNode.jsx
```

文本/视觉分析节点。把提示词和引用图片发送到 `/api/text-analyze`。

```text
src/imageGenerationConfig.js
src/videoGenerationConfig.js
```

前端模型能力配置。新增或调整模型标签、供应商标识、比例、尺寸、时长和 API 模型名时，通常先改这里。

```text
server/deepseek-proxy.js
```

Node 服务入口。提供 `/api/health`、`/api/translate`、`/api/text-analyze`，并把工程与素材库请求委托给 `projects-api.mjs`。

```text
server/projects-api.mjs
```

本地文件系统 API。负责工程、素材库、主体库、媒体文件读取、缩略图、封面、资产上传、清理、复制、重命名和删除。

```text
server/image_generate_service.py
```

Python 媒体服务。负责图片生成、视频生成、不同供应商的请求体转换、异步任务轮询、文件下载/保存和视频文件服务。

## 运行命令

```bash
npm run dev:all
```

启动前端、Node API 和 Python 媒体服务。

```bash
npm run dev:web
npm run dev:api
npm run dev:image-api
```

分别启动单个服务。

```bash
npm run build
npm run lint
```

构建和 lint。

## 端口与健康检查

- 前端：`http://localhost:5173/`
- Node API：`http://127.0.0.1:8787/api/health`
- 媒体服务：`http://127.0.0.1:8790/api/health`

如果首页不显示项目，或者点击“开始创作”无法进入工作区，优先检查 `8787` 是否被旧版或不兼容的 API 服务占用。当前前端期望的项目列表响应格式是：

```json
{ "projects": [] }
```

旧服务或其他服务可能返回：

```json
{ "ok": true, "data": [] }
```

这种格式不会被 `ProjectDashboard.jsx` 正确渲染。

## 环境变量

以 `.env.example` 为模板，在 `.env.local` 写入真实值。不要暴露 `.env.local`。

重要变量分组：

- DeepSeek：`DEEPSEEK_API_KEY`、`DEEPSEEK_ANALYSIS_MODEL`
- Volcengine Ark：`ARK_API_KEY`、`ARK_BASE_URL`、`SEED_ANALYSIS_MODEL`
- VectorEngine / Gemini 图片网关：`VECTORENGINE_API_KEY`、`VECTORENGINE_BASE_URL`
- GPT Image：`GPT_IMAGE_2_API_KEY`、`GPT_IMAGE_2_BASE_URL`、`GPT_IMAGE_2_MODEL`
- Seedance / Xunke：`XUNKE_API_KEY`、`XUNKE_ASSET_TOKEN`、`XUNKE_BASE_URL`
- DashScope：`DASHSCOPE_API_KEY`
- ffmpeg：`FFMPEG_PATH`

## 本地数据

```text
projects/<slug>/project_data.json
projects/<slug>/assets/
```

每个工程保存画布节点、连线、视口和本地资产。

```text
material-library/library_data.json
material-library/seedance_subjects.json
material-library/assets/
```

跨工程复用素材和 Seedance 主体数据。

```text
outputs/
```

未绑定到具体工程的生成媒体、临时文件或外部服务上传缓存。

除非用户明确要求，不要删除或重写这些目录。

## 开发注意事项

- 优先沿用现有节点和组件模式，不要轻易引入新的状态体系。
- 改动尽量收窄。`AIImageNode.jsx`、`AIVideoNode.jsx`、`App.jsx` 很大，并且包含大量持久化字段。
- 修改节点持久化数据时，要兼容已有 `project_data.json`。
- 新增工程或素材库 API 时，同时更新前端调用和 `server/projects-api.mjs`。
- 新增生成供应商时，通常需要同时改前端模型配置和 Python 服务请求处理。
- 前端生成请求通常保持相对路径，例如 `/api/generate-image`，让 Vite 代理处理跨域。
- 不要随意提交生成日志、`outputs/`、`projects/`、`material-library/assets/`、`.env.local`，除非用户明确要保存数据快照。
- 如果构建或 lint 在未触碰的旧代码中失败，报告具体既有失败，不要顺手大范围重构。

## 当前架构

```text
浏览器
  -> Vite 开发服务器 :5173
    -> /api/project*、/api/material-library*、/api/translate、/api/text-analyze
       -> Node 服务 :8787
          -> server/projects-api.mjs
          -> DeepSeek / Ark 兼容 Chat API
    -> /api/generate-image、/api/generate-video、/api/video-task、/api/video-file、/api/seedance-face-review
       -> Python 服务 :8790
          -> 外部图片/视频生成供应商
          -> 本地工程 assets 或 outputs
```

## 验证清单

做完有意义的代码修改后：

1. 运行 `npm run build` 检查前端构建。
2. 如果改动涉及源码，并且当前 lint 状态有参考价值，运行 `npm run lint`。
3. 启动 `npm run dev:all`。
4. 验证：
   - `http://localhost:5173/`
   - `http://127.0.0.1:8787/api/health`
   - `http://127.0.0.1:8790/api/health`
   - 首页能显示工程卡片
   - 工程可以正常打开

## 对外定位

可以把这个应用描述为一个 AI 图片/视频创作工作台。它特别适合需要反复迭代角色、场景、参考图和视频镜头，同时又希望在本地保留可复用素材链路的创作者。
