# Demiurge My Canvas

Demiurge My Canvas 是一个本地运行的 AI 多模态创作画布。它把项目管理、无限画布、图片生成、视频生成、文本/视觉分析、素材库和本地资产持久化放在同一个工作流里，适合用来做短视频、角色/场景设定、分镜探索、图生视频实验和素材复用。

## 这个项目是做什么的

它提供一个类似节点编辑器的创作空间。用户可以在画布上放置图片节点、视频节点和文本分析节点，把素材通过连线传给下游节点，再用提示词和模型配置生成新的图片、视频或分析结果。

核心目标不是单次调用某个 AI 接口，而是让创作者把“素材导入、参考图管理、提示词迭代、图片生成、视频生成、帧截取、素材沉淀、工程保存”串成一个可回溯的本地工作台。

## 别人通过它能做什么

- 管理多个本地创作工程，打开、复制、重命名、删除工程。
- 在无限画布上创建图片、视频、文本分析节点。
- 上传本地图片/视频，或把生成结果作为新节点继续加工。
- 通过 `@图片1` 等引用方式，把上游图片作为生成或分析参考。
- 生成图片，支持 Seedream、Nano Banana、GPT Image 等配置入口。
- 生成视频，支持文生视频、图生视频、多图参考、首尾帧等 Seedance/Wan 类工作流。
- 对图片进行裁剪、标注、下载、放大查看、保存到素材库。
- 对视频进行播放、静音、剪辑/截帧、下载、重新导入、保存到素材库。
- 用文本节点对参考图和提示词做视觉内容分析。
- 维护“我的素材”库，按人物、场景、物品、风格、音效、其他分类复用。
- 保存 Seedance 主体/人脸审核信息，用于稳定角色或主体参考。

## 能解决什么问题

- **素材链路容易断**：生成结果、上传文件和工程数据都会落到本地 `projects/` 或 `material-library/`，减少临时文件丢失。
- **AI 生成缺少上下文**：画布连线和 `@引用` 能明确表达“用哪些图作为参考”。
- **多模型配置分散**：前端节点封装了图片/视频模型、比例、清晰度、时长、分辨率等参数。
- **创作过程难复用**：工程保存画布节点、边、视口和节点数据，素材库沉淀可跨工程复用的资产。
- **图到视频流程繁琐**：可以从图片节点做人脸审核、再连接到视频节点，走图生视频或多图参考。
- **本地开发调试困难**：Vite 代理把前端 `/api/*` 分发到 Node 项目服务和 Python 媒体服务，开发时只访问一个前端地址即可。

## 技术栈

- React 19 + Vite 8
- `@xyflow/react` / React Flow 画布
- Tailwind CSS + lucide-react 图标
- Node.js 本地 API 服务
- Python 媒体生成服务
- 本地文件系统持久化
- 外部 AI 服务：DeepSeek、Volcengine Ark、VectorEngine、OpenAI Images、DashScope、Xunke Seedance 等，按 `.env.local` 配置启用

## 目录结构

```text
my-canvas/
  .env.example                 # 环境变量模板
  .env.local                   # 本机密钥配置，勿提交
  index.html                   # Vite HTML 入口
  package.json                 # npm 脚本与依赖
  vite.config.js               # Vite 端口与 API 代理
  README.md                    # 项目说明
  AGENT.md                     # 维护代理说明

  src/
    main.jsx                   # React 挂载入口
    App.jsx                    # 主应用、React Flow 画布、工程工作区、节点操作
    ProjectDashboard.jsx       # 工程列表首页
    AIImageNode.jsx            # 图片节点：上传、生成、裁剪、标注、审核、下载
    AIVideoNode.jsx            # 视频节点：上传、生成、轮询、剪辑、截帧、下载
    AITextNode.jsx             # 文本/视觉分析节点
    imageGenerationConfig.js   # 图片模型、比例、尺寸映射
    videoGenerationConfig.js   # 视频模型、比例、分辨率、时长配置
    materialLibraryApi.js      # 素材库前端 API 封装
    MaterialLibraryPanel.jsx   # 我的素材面板
    HistoryPanel.jsx           # 历史/最近素材面板
    SaveToMaterialModal.jsx    # 保存素材弹窗
    ProjectWorkspaceContext.jsx# 当前工程上下文
    *Store.js                  # 轻量 UI 状态存储

  server/
    deepseek-proxy.js          # Node API：翻译、文本分析、工程/素材库路由入口
    projects-api.mjs           # 工程、素材库、媒体文件、封面/缩略图 API
    image_generate_service.py  # Python 媒体服务：图片/视频生成、任务轮询、视频文件输出
    run-image-service-dev.mjs  # 开发模式启动并监听 Python 服务
    requirements.txt           # Python 依赖

  projects/
    <project-slug>/
      project_data.json        # 工程画布存档
      assets/                  # 该工程的图片、视频、缩略图等资产

  material-library/
    library_data.json          # 我的素材索引
    seedance_subjects.json     # Seedance 主体库索引
    assets/                    # 跨工程复用素材

  outputs/                     # 非工程绑定的生成输出或中间上传文件
  public/                      # 静态资源
  tools/ffmpeg-dist/           # 随项目携带的 ffmpeg
  dist/                        # 构建产物
```

## 本地运行

安装依赖：

```bash
npm install
```

配置密钥：

```bash
cp .env.example .env.local
```

按需填写 `.env.local` 中的 `DEEPSEEK_API_KEY`、`ARK_API_KEY`、`VECTORENGINE_API_KEY`、`XUNKE_API_KEY`、`DASHSCOPE_API_KEY` 等。

启动完整开发环境：

```bash
npm run dev:all
```

默认地址：

- 前端：`http://localhost:5173/`
- Node API：`http://127.0.0.1:8787`
- Python 媒体服务：`http://127.0.0.1:8790`

也可以分开启动：

```bash
npm run dev:web
npm run dev:api
npm run dev:image-api
```

## 常用命令

```bash
npm run dev:all      # 前端 + Node API + Python 媒体服务
npm run dev          # 前端 + Python 媒体服务，不含 Node API
npm run dev:web      # 只启动 Vite
npm run dev:api      # 只启动 Node API
npm run dev:image-api# 只启动 Python 媒体服务
npm run build        # 构建前端
npm run lint         # ESLint
npm run preview      # 预览 dist
```

## 关键 API

Node API，端口 `8787`：

- `GET /api/health`
- `POST /api/translate`
- `POST /api/text-analyze`
- `GET /api/project/list`
- `GET /api/project/load?slug=...`
- `POST /api/project/create`
- `PUT /api/project/save`
- `POST /api/project/rename`
- `POST /api/project/copy`
- `DELETE /api/project/delete?slug=...`
- `GET /api/material-library/list`
- `POST /api/material-library/save`
- `GET /api/material-library/subjects`

Python 媒体服务，端口 `8790`：

- `GET /api/health`
- `POST /api/generate-image`
- `POST /api/generate-video`
- `GET /api/video-task/:taskId`
- `GET /api/video-file/...`
- `POST /api/seedance-face-review`

开发时前端统一请求 `/api/...`，由 `vite.config.js` 代理到对应服务。

## 数据与安全

- `.env.local` 存放真实 API Key，不要提交或分享。
- `projects/` 和 `material-library/` 是本地业务数据，包含用户素材和生成结果。
- `outputs/` 可能包含生成输出、中间文件或外部服务上传缓存。
- 若接口返回格式异常，优先确认 `8787` 是否被旧服务占用。

## 当前状态

本项目已经可以通过 `npm run dev:all` 在本机运行。运行后打开 `http://localhost:5173/`，首页会显示本地工程列表，进入工程后即可使用画布节点创作。
