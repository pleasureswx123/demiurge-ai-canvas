import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Handle,
  Position,
  useNodeId,
  useUpdateNodeInternals,
  useReactFlow,
} from '@xyflow/react';
import { motion, useMotionValue, useSpring } from 'framer-motion';
import {
  getMentionDeletionRange,
  getMentionCaretNavigationTarget,
  protectImageMentionTokens,
  restoreImageMentionTokens,
} from './mentionTokens';
import CrispZoomRoot from './CrispZoomRoot';
import { useProjectWorkspace } from './ProjectWorkspaceContext';
import { useCanvasUi } from './CanvasUiContext';
import { useNodeUiState } from './NodeUiStore';
import { useConnectionHoverForNode } from './ConnectionHoverStore';
import { cancelGenerationForNode, registerGenerationCancel } from './GenerationCancelStore';
import {
  DEFAULT_VIDEO_MODEL_ID,
  getAllowedVideoDurations,
  getAllowedVideoRatios,
  getAllowedVideoResolutions,
  getDefaultVideoDuration,
  getDefaultVideoRatio,
  getDefaultVideoResolution,
  getVideoModelConfig,
  videoModelOptions,
} from './videoGenerationConfig';
import {
  Camera,
  ChevronDown,
  Check,
  Download,
  Expand,
  Image as ImageIcon,
  Info,
  Loader2,
  MoveUp,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  Sparkles,
  Tags,
  Upload,
  Video as VideoIcon,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (sec) => {
  if (!isFinite(sec) || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

function formatGenerationInfoTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatGenerationDuration(startValue, endValue) {
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return '';
  const totalSeconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
}

const NODE_DRAG_HANDLE_SELECTOR = '.node-drag-handle';
const VIDEO_TASK_STATUS_RANK = {
  '': 0,
  SUBMITTING: 1,
  PENDING: 2,
  RUNNING: 3,
  SUCCEEDED: 4,
  FAILED: 4,
  CANCELED: 4,
};

function pickNewestVideoTaskStatus(localStatus, dataStatus) {
  const local = String(localStatus || '').toUpperCase();
  const fromData = String(dataStatus || '').toUpperCase();
  if (!local) return fromData;
  if (!fromData) return local;
  return (VIDEO_TASK_STATUS_RANK[fromData] || 0) > (VIDEO_TASK_STATUS_RANK[local] || 0)
    ? fromData
    : local;
}

const areSerializableValuesEqual = (a, b) => {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

const isNodeDataPatchUnchanged = (data, patch) => {
  if (!patch || typeof patch !== 'object') return true;
  return Object.entries(patch).every(([key, value]) =>
    areSerializableValuesEqual(data?.[key], value)
  );
};

const SEEDANCE_SCENARIOS = [
  { id: 'text', label: '文生视频', hint: '纯文本生成视频' },
  { id: 'multimodal', label: '全能参考', hint: '多张图片参考' },
  { id: 'first_frame', label: '图生视频', hint: 'image 首帧生成' },
  { id: 'first_last_frame', label: '首尾帧', hint: 'first_frame_image / last_frame_image' },
  { id: 'image_reference', label: '图片参考', hint: 'reference_images 图片风格/内容参考' },
];
const VIDEO_TOOL_ACTIONS = [
  { id: 'tag', label: '标记', icon: Tags },
  { id: 'fx', label: '特效', icon: Sparkles },
  { id: 'camera', label: '运镜', icon: Camera },
];
const RATIO_ICON_CLASS = {
  '自适应': 'h-2.5 w-4',
  '16:9': 'h-2.5 w-7',
  '4:3': 'h-3 w-5',
  '1:1': 'h-4 w-4',
  '3:4': 'h-5 w-4',
  '9:16': 'h-7 w-3.5',
  '21:9': 'h-2 w-8',
};
const MotionDiv = motion.div;

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const sleepWithAbort = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });

/** 与图片节点 imageMode 对齐：外部导入 / 剪辑 blob 为素材类，不展示底部生成编辑区 */
const inferInitialVideoMode = (d) => {
  if (d?.videoMode === 'asset' || d?.videoMode === 'generated') return d.videoMode;
  if (d?.capturedClip?.src) return 'asset';
  const gv = d?.generatedVideo?.src;
  if (typeof gv === 'string' && gv.length > 0) {
    return gv.startsWith('blob:') ? 'asset' : 'generated';
  }
  return 'generated';
};

const pickWebmRecorderMime = () => {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return 'video/webm';
};

/** 旧版：canvas 抽帧录制，无音轨（仅作 play/captureStream 失败时的兜底） */
const trimVideoSilentCanvas = (src, startTime, endTime) =>
  new Promise((resolve, reject) => {
    const proxy = document.createElement('video');
    proxy.src = src;
    proxy.muted = true;
    proxy.addEventListener(
      'loadedmetadata',
      () => {
        const W = proxy.videoWidth || 1280;
        const H = proxy.videoHeight || 720;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        const stream = canvas.captureStream(30);
        const mime = pickWebmRecorderMime();
        if (!MediaRecorder.isTypeSupported(mime)) {
          reject(new Error('MediaRecorder not supported'));
          return;
        }
        const recorder = new MediaRecorder(stream, { mimeType: mime });
        const chunks = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
        proxy.currentTime = startTime;
        proxy.addEventListener(
          'seeked',
          () => {
            recorder.start(100);
            proxy.play();
            const tick = () => {
              if (proxy.currentTime >= endTime || proxy.ended) {
                proxy.pause();
                recorder.stop();
                return;
              }
              ctx.drawImage(proxy, 0, 0, W, H);
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          },
          { once: true }
        );
      },
      { once: true }
    );
  });

/**
 * 裁剪导出：对 video.captureStream() 录像，保留音轨。
 * （canvas.captureStream 只有画面，导出剪辑会静音。）
 */
const trimVideo = async (src, startTime, endTime) => {
  const proxy = document.createElement('video');
  proxy.playsInline = true;
  proxy.src = src;
  proxy.muted = false;
  proxy.volume = 1;

  const cleanup = () => {
    try {
      proxy.pause();
      proxy.removeAttribute('src');
      proxy.load();
    } catch {
      /* ignore */
    }
  };

  try {
    await new Promise((resolve, reject) => {
      if (proxy.readyState >= 1) {
        resolve();
        return;
      }
      proxy.addEventListener('loadedmetadata', resolve, { once: true });
      proxy.addEventListener(
        'error',
        () => reject(new Error('视频加载失败')),
        { once: true }
      );
    });

    const dur = proxy.duration;
    if (!isFinite(dur) || dur <= 0) {
      cleanup();
      return trimVideoSilentCanvas(src, startTime, endTime);
    }

    const t0 = Math.max(0, Math.min(startTime, dur - 0.001));
    const t1 = Math.max(t0 + 0.04, Math.min(endTime, dur));

    proxy.currentTime = t0;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      proxy.addEventListener('seeked', finish, { once: true });
      requestAnimationFrame(() => {
        if (Math.abs(proxy.currentTime - t0) < 0.03) finish();
      });
    });

    try {
      await proxy.play();
    } catch {
      cleanup();
      return trimVideoSilentCanvas(src, startTime, endTime);
    }

    const mimeType = pickWebmRecorderMime();
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      proxy.pause();
      cleanup();
      return trimVideoSilentCanvas(src, startTime, endTime);
    }

    const stream = proxy.captureStream();
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const blobPromise = new Promise((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
      recorder.addEventListener('error', () => reject(new Error('录制失败')), { once: true });
    });

    recorder.start(100);

    await new Promise((resolve) => {
      const tick = () => {
        if (proxy.currentTime >= t1 - 0.05 || proxy.ended) {
          proxy.pause();
          recorder.stop();
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const blob = await blobPromise;
    cleanup();
    return blob;
  } catch {
    cleanup();
    return trimVideoSilentCanvas(src, startTime, endTime);
  }
};

// ── Component ────────────────────────────────────────────────────────────────

const AIVideoNode = ({ data, selected = false }) => {
  const { slug: projectSlug } = useProjectWorkspace();
  const nodeId = useNodeId();
  const updateNodeInternals = useUpdateNodeInternals();
  const { addNodes, addEdges, getNode, getInternalNode, updateNodeData, setEdges, setNodes } = useReactFlow();
  const {
    persistNodeData,
    flushProjectSave,
    saveSnapshot,
  } = useCanvasUi();
  const {
    uiDismissToken,
    isSingleSelected,
    isFocused,
    isMaximizedView,
  } = useNodeUiState(nodeId);

  // refs
  const nodeSurfaceRef    = useRef(null);
  const videoRef          = useRef(null);
  const videoSurfaceRef   = useRef(null);
  const videoToolbarRef   = useRef(null);
  const videoFileInputRef = useRef(null);
  const videoObjectUrlRef = useRef(null);
  const captureMenuRef    = useRef(null);
  const progressBarRef    = useRef(null);
  const filmstripRef      = useRef(null);
  const clipToolbarButtonRef = useRef(null);
  const textareaRef       = useRef(null);
  const modalTextareaRef  = useRef(null);
  const promptHighlightRef = useRef(null);
  const modalPromptHighlightRef = useRef(null);
  const refsScrollerRef   = useRef(null);
  const generationActiveRef = useRef(true);
  const videoGenerationAbortRef = useRef(null);
  const videoGenerationCancelledRef = useRef(false);
  const mentionTriggerRef = useRef(false);
  const clipStateRef           = useRef({ start: 0, end: 1 });
  const draggingHandle         = useRef(null);
  const durationRef            = useRef(data?.capturedClip?.duration || 0);
  // video state
  const [importedVideo, setImportedVideo] = useState(() => {
    if (data?.capturedClip) {
      return {
        src: data.capturedClip.src,
        width: 1280, height: 720,
        name: data.capturedClip.name || 'clip.webm',
        duration: 0,
      };
    }
    if (data?.generatedVideo?.src) {
      return {
        src: data.generatedVideo.src,
        width: data.generatedVideo.width || 1280,
        height: data.generatedVideo.height || 720,
        name: data.generatedVideo.name || 'dashscope-video.mp4',
        duration: data.generatedVideo.duration || 0,
      };
    }
    return null;
  });
  const [currentTime,     setCurrentTime]     = useState(0);
  const [duration,        setDuration]        = useState(() => data?.capturedClip?.duration || 0);
  const [isPlaying,       setIsPlaying]       = useState(false);
  const [isMuted,         setIsMuted]         = useState(false);

  // UI state — after user clicks the video area, leaving the node does not pause until deselect / click elsewhere
  const [engagedPlayback, setEngagedPlayback] = useState(false);
  const [showCaptureMenu,      setShowCaptureMenu]      = useState(false);
  const [showVideoPreviewModal,setShowVideoPreviewModal] = useState(false);
  const [showGenerationInfo,   setShowGenerationInfo]   = useState(false);
  const [showPromptModal,       setShowPromptModal]       = useState(false);
  const [showVideoTools,       setShowVideoTools]       = useState(false);
  const [showClipEditor,       setShowClipEditor]       = useState(false);
  const [videoGenMode,         setVideoGenMode]         = useState(data?.videoGenMode || 'text');
  const initialVideoModeRef = useRef(inferInitialVideoMode(data));
  const [videoMode, setVideoMode] = useState(() => initialVideoModeRef.current);
  const [videoPrompt,          setVideoPrompt]          = useState(data?.videoPrompt || '');
  const [lastVideoGenerationPrompt, setLastVideoGenerationPrompt] = useState(
    data?.lastVideoGenerationPrompt || data?.videoPrompt || ''
  );
  const [lastVideoGenerationSubmittedAt, setLastVideoGenerationSubmittedAt] = useState(
    data?.lastVideoGenerationSubmittedAt || data?.lastVideoGenerationStartedAt || ''
  );
  const [lastVideoGenerationCompletedAt, setLastVideoGenerationCompletedAt] = useState(
    data?.lastVideoGenerationCompletedAt || data?.lastVideoGenerationAt || data?.generationTime || ''
  );
  const [videoModel,           setVideoModel]           = useState(data?.videoModel || DEFAULT_VIDEO_MODEL_ID);
  const [videoRatio,           setVideoRatio]           = useState(data?.videoRatio || getDefaultVideoRatio(data?.videoModel));
  const [videoResolution,      setVideoResolution]      = useState(
    data?.videoResolution || getDefaultVideoResolution(data?.videoModel)
  );
  const [videoDurationLabel,   setVideoDurationLabel]   = useState(
    data?.videoDurationLabel || getDefaultVideoDuration(data?.videoModel)
  );
  const [seedanceScenario,     setSeedanceScenario]     = useState(data?.seedanceScenario || 'multimodal');
  const [showModelMenu,        setShowModelMenu]        = useState(false);
  const [showSpecMenu,         setShowSpecMenu]         = useState(false);
  const showSubjectMenu = false;
  const [isGenerating,         setIsGenerating]         = useState(false);
  const [activeVideoGenerationTargetId, setActiveVideoGenerationTargetId] = useState('');
  const [isTranslating,        setIsTranslating]        = useState(false);
  const [videoTaskStatus,      setVideoTaskStatus]      = useState(data?.videoTaskStatus || '');
  const [videoTaskId,          setVideoTaskId]          = useState(data?.videoTaskId || '');
  const [selectedReferenceTokens, setSelectedReferenceTokens] = useState([]);
  const [mentionMenu, setMentionMenu] = useState({
    open: false,
    query: '',
    replaceStart: 0,
    replaceEnd: 0,
  });
  const [clipStart,            setClipStart]            = useState(0);
  const [clipEnd,              setClipEnd]              = useState(1);
  const [thumbnails,           setThumbnails]           = useState([]);
  const [isTrimming,           setIsTrimming]           = useState(false);
  // handle magnetism
  const [isNodeHovering, setIsNodeHovering] = useState(false);
  const [isPreviewHovering, setIsPreviewHovering] = useState(false);
  const springCfg = { stiffness: 520, damping: 18, mass: 0.38 };
  const lXRaw = useMotionValue(0), lYRaw = useMotionValue(0);
  const rXRaw = useMotionValue(0), rYRaw = useMotionValue(0);
  const lX = useSpring(lXRaw, springCfg), lY = useSpring(lYRaw, springCfg);
  const rX = useSpring(rXRaw, springCfg), rY = useSpring(rYRaw, springCfg);

  // derived
  const isNodeSelected  = selected || isSingleSelected;
  const showDetailPanel = selected && isFocused;
  const [maximizedDetailBoost, setMaximizedDetailBoost] = useState(false);
  useEffect(() => {
    if (!isMaximizedView) setMaximizedDetailBoost(false);
  }, [isMaximizedView]);
  const detailPanelScale = !isMaximizedView ? 1 : maximizedDetailBoost ? 0.76 : 0.4;
  const handleDetailPanelExpand = useCallback((event) => {
    event?.stopPropagation?.();
    setMentionMenu({
      open: false,
      query: '',
      replaceStart: 0,
      replaceEnd: 0,
    });
    setShowPromptModal(true);
  }, []);
  const showHandleUi    = isNodeHovering || selected;
  const connectionHover = useConnectionHoverForNode(nodeId);
  const isConnectionHoverTarget = connectionHover.isTarget;
  const resolvedConnectionHoverTilt = connectionHover.tilt;
  const hasVideo        = Boolean(importedVideo);
  const isAssetLikeVideoNode = hasVideo && videoMode === 'asset';
  const showInputHandleUi = showHandleUi && !isAssetLikeVideoNode;
  const resolvedLastVideoGenerationSubmittedAt =
    lastVideoGenerationSubmittedAt || data?.lastVideoGenerationSubmittedAt || data?.lastVideoGenerationStartedAt || '';
  const resolvedLastVideoGenerationCompletedAt =
    lastVideoGenerationCompletedAt || data?.lastVideoGenerationCompletedAt || data?.lastVideoGenerationAt || data?.generationTime || '';
  const generationInfoPrompt = String(
    lastVideoGenerationPrompt || data?.lastVideoGenerationPrompt || ''
  ).trim();
  const generationInfoSubmittedTime = formatGenerationInfoTime(resolvedLastVideoGenerationSubmittedAt);
  const generationInfoCompletedTime = formatGenerationInfoTime(resolvedLastVideoGenerationCompletedAt);
  const generationInfoDuration = formatGenerationDuration(
    resolvedLastVideoGenerationSubmittedAt,
    resolvedLastVideoGenerationCompletedAt
  );
  /** 素材类始终无底部栏；生成类在打开剪辑条时也隐藏底部栏，避免与剪辑 UI 叠在一起 */
  const showGenerationDetailPanel =
    showDetailPanel && !isAssetLikeVideoNode && !showClipEditor;
  const inputImageRefs = useMemo(
    () =>
      (Array.isArray(data?.inputImageRefs) ? data.inputImageRefs : [])
        .filter((asset) => asset && typeof asset.src === 'string' && asset.src.trim())
        .slice(0, 8),
    [data?.inputImageRefs]
  );
  const inputVideoRefs = useMemo(
    () =>
      (Array.isArray(data?.inputVideoRefs) ? data.inputVideoRefs : [])
        .filter((asset) => asset && typeof asset.src === 'string' && asset.src.trim())
        .slice(0, 8),
    [data?.inputVideoRefs]
  );
  const inputMediaRefs = useMemo(
    () => [
      ...inputImageRefs.map((asset, index) => ({ ...asset, kind: 'image', mediaIndex: index })),
      ...inputVideoRefs.map((asset, index) => ({ ...asset, kind: 'video', mediaIndex: index })),
    ],
    [inputImageRefs, inputVideoRefs]
  );
  const hasInputMediaRefs = inputMediaRefs.length > 0;
  const nodeGenerationPending = Boolean(data?.generationPending);
  const videoGenerationActive = nodeGenerationPending || (isGenerating && activeVideoGenerationTargetId === nodeId);
  const videoGenerationBackdropAsset = importedVideo || data?.pendingPreviewAsset || inputVideoRefs[0] || inputImageRefs[0] || null;
  const videoGenerationProgress = useMemo(() => {
    if (!isGenerating) return 0;
    const status = String(videoTaskStatus || '').toUpperCase();
    if (status === 'SUCCEEDED') return 100;
    if (status === 'RUNNING') return 62;
    if (status === 'PENDING') return 28;
    if (status === 'SUBMITTING') return 14;
    return 14;
  }, [isGenerating, videoTaskStatus]);
  const nodeWidth       = 408;
  const videoAspect     = importedVideo
    ? (importedVideo.width  || 16) / (importedVideo.height || 9)
    : 16 / 9;
  const videoCardHeight = hasVideo
    ? Math.max(248, Math.min(720, nodeWidth / videoAspect))
    : 230;
  const progressPct  = duration > 0 ? (currentTime / duration) * 100 : 0;
  const clipDuration = (clipEnd - clipStart) * duration;
  const currentVideoSizeLabel =
    importedVideo?.width && importedVideo?.height
      ? `${Math.round(importedVideo.width)} × ${Math.round(importedVideo.height)}`
      : '1280 × 720';
  const videoNodeIndexLabel = String(nodeId || '').replace(/\D/g, '') || '';
  /** 仅在剪辑面板打开时预览区间循环；退出面板后不限制播放区间 */
  const clipSegmentActive =
    showClipEditor &&
    duration > 0 &&
    clipEnd - clipStart < 0.999 &&
    clipEnd - clipStart > 0.001;
  const mentionItems = useMemo(
    () =>
      inputImageRefs.map((asset, index) => ({
        index,
        token: `@图片${index + 1}`,
        label: `图片${index + 1}`,
        src: asset.src,
        sourceNodeId: asset.sourceNodeId,
        seedanceFaceReview: asset.seedanceFaceReview || null,
      })),
    [inputImageRefs]
  );
  const mediaMentionItems = useMemo(
    () =>
      inputMediaRefs.map((asset) => {
        const isVideo = asset.kind === 'video';
        const displayIndex = asset.mediaIndex + 1;
        return {
          ...asset,
          index: asset.mediaIndex,
          token: isVideo ? `@\u89c6\u9891${displayIndex}` : `@\u56fe\u7247${displayIndex}`,
          label: isVideo ? `\u89c6\u9891${displayIndex}` : `\u56fe\u7247${displayIndex}`,
          src: asset.src,
          sourceNodeId: asset.sourceNodeId,
          seedanceFaceReview: asset.seedanceFaceReview || null,
          kind: isVideo ? 'video' : 'image',
        };
      }),
    [inputMediaRefs]
  );
  const generatedVideoData = useMemo(() => {
    if (!importedVideo?.src || String(importedVideo.src).startsWith('blob:')) {
      return null;
    }

    return {
      src: importedVideo.src,
      width: importedVideo.width || 1280,
      height: importedVideo.height || 720,
      name: importedVideo.name || 'dashscope-video.mp4',
      duration: importedVideo.duration || 0,
      previewUpdatedAt: importedVideo.previewUpdatedAt || null,
    };
  }, [
    importedVideo?.duration,
    importedVideo?.height,
    importedVideo?.name,
    importedVideo?.src,
    importedVideo?.width,
  ]);
  const capturedClipData = useMemo(() => {
    if (videoMode !== 'asset' || !importedVideo?.src) {
      return null;
    }

    return {
      src: importedVideo.src,
      width: importedVideo.width || 1280,
      height: importedVideo.height || 720,
      name: importedVideo.name || 'clip.webm',
      duration: importedVideo.duration || 0,
      previewUpdatedAt: importedVideo.previewUpdatedAt || null,
    };
  }, [
    importedVideo?.duration,
    importedVideo?.height,
    importedVideo?.name,
    importedVideo?.src,
    importedVideo?.width,
    videoMode,
  ]);

  const resolveGenerationReferenceItems = useCallback(() => {
    /**
     * 生成时优先级说明：
     * 1. 如果用户在缩略图里手动点选了若干张素材，就严格以“当前选中的素材”为准；
     * 2. 如果没有手动点选，但 prompt 里写了 `@图片1` / `@图片2` 之类的引用，就按引用顺序取；
     * 3. 如果既没有点选，也没有 @ 引用，则回退为“当前输入区已有的全部素材”。
     */
    if (!inputMediaRefs.length) return [];

    if (selectedReferenceTokens.length > 0) {
      const selectedSet = new Set(selectedReferenceTokens);
      return mediaMentionItems.filter((item) => selectedSet.has(item.token));
    }

    const matchedTokens = Array.from(
      new Set((videoPrompt.match(/@(?:\u56fe\u7247|\u89c6\u9891)\d+/g) || []))
    );
    if (matchedTokens.length > 0) {
      const mentionMap = new Map(mediaMentionItems.map((item) => [item.token, item]));
      return matchedTokens.map((token) => mentionMap.get(token)).filter(Boolean);
    }

    return mediaMentionItems;
  }, [inputMediaRefs.length, mediaMentionItems, selectedReferenceTokens, videoPrompt]);

  const generationReferenceCount = useMemo(
    () => {
      const refs = resolveGenerationReferenceItems();
      return refs.length;
    },
    [resolveGenerationReferenceItems]
  );
  const hasGenerationReferences = useMemo(
    () => generationReferenceCount > 0,
    [generationReferenceCount]
  );
  const currentVideoCapability = useMemo(() => {
    const base = getVideoModelConfig(videoModel);
    return base;
  }, [videoModel]);
  const selectedResolutionOption = useMemo(
    () =>
      currentVideoCapability.resolutions.find((item) => item.label === videoResolution)
      || currentVideoCapability.resolutions[0],
    [currentVideoCapability, videoResolution]
  );
  const selectedDurationOption = useMemo(
    () =>
      getAllowedVideoDurations(videoModel).find((item) => item.label === videoDurationLabel)
      || getAllowedVideoDurations(videoModel)[0],
    [currentVideoCapability, videoDurationLabel]
  );

  // ── Effects ───────────────────────────────────────────────────────────────

  // Hover: play; leave: pause only if user has not clicked the video to "engage" playback
  useEffect(() => {
    if (!videoRef.current || !hasVideo) return;
    if (isPreviewHovering) videoRef.current.play().catch(() => {});
    else if (!engagedPlayback) videoRef.current.pause();
  }, [isPreviewHovering, hasVideo, engagedPlayback]);

  // Clicking blank canvas or another node deselects — pause and clear engage
  useEffect(() => {
    if (!isNodeSelected) {
      setEngagedPlayback(false);
      videoRef.current?.pause();
    }
  }, [isNodeSelected]);

  useEffect(() => {
    if (hasInputMediaRefs && videoGenMode !== 'image') {
      setVideoGenMode('image');
    }
  }, [hasInputMediaRefs, videoGenMode]);

  useEffect(() => {
    if (hasInputMediaRefs && seedanceScenario === 'text') {
      setSeedanceScenario('multimodal');
    }
  }, [hasInputMediaRefs, seedanceScenario]);

  useEffect(() => {
    if (!SEEDANCE_SCENARIOS.some((item) => item.id === seedanceScenario)) {
      setSeedanceScenario('image_reference');
    }
  }, [seedanceScenario]);

  useEffect(() => {
    generationActiveRef.current = true;
    return () => {
      generationActiveRef.current = false;
    };
  }, []);

  useEffect(() => {
    /**
     * 当模型切换时，右侧参数必须同步到“该模型真的支持”的范围内。
     *
     * 这里做了两层保险：
     * 1. 如果当前值仍被新模型支持，就保留，避免用户刚选的值被无意义重置；
     * 2. 如果当前值不再支持，就自动回退到该模型的默认值。
     */
    const nextCapability = getVideoModelConfig(videoModel);

    if (!nextCapability.ratios.some((item) => item.label === videoRatio)) {
      setVideoRatio(nextCapability.defaultRatio);
    }
    if (!nextCapability.resolutions.some((item) => item.label === videoResolution)) {
      setVideoResolution(nextCapability.defaultResolution);
    }
    if (!nextCapability.durations.some((item) => item.label === videoDurationLabel)) {
      setVideoDurationLabel(nextCapability.defaultDuration);
    }
  }, [videoDurationLabel, videoModel, videoRatio, videoResolution]);

  useEffect(() => {
    const handleOutsideClick = (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const clickedInModelUi = path.some(
        (node) =>
          node instanceof Element &&
          (node.dataset.videoModelTrigger === 'true' || node.dataset.videoModelPanel === 'true')
      );
      const clickedInSpecUi = path.some(
        (node) =>
          node instanceof Element &&
          (node.dataset.videoSpecTrigger === 'true' || node.dataset.videoSpecPanel === 'true')
      );

      if (!clickedInModelUi) {
        setShowModelMenu(false);
      }
      if (!clickedInSpecUi) {
        setShowSpecMenu(false);
      }
    };

    document.addEventListener('pointerdown', handleOutsideClick, true);
    return () => document.removeEventListener('pointerdown', handleOutsideClick, true);
  }, []);

  useEffect(() => {
    setShowModelMenu(false);
    setShowSpecMenu(false);
  }, [uiDismissToken]);

  useEffect(() => {
    const nextPrompt = data?.lastVideoGenerationPrompt || '';
    const nextSubmittedAt = data?.lastVideoGenerationSubmittedAt || data?.lastVideoGenerationStartedAt || '';
    const nextCompletedAt =
      data?.lastVideoGenerationCompletedAt || data?.lastVideoGenerationAt || data?.generationTime || '';
    if (nextPrompt && nextPrompt !== lastVideoGenerationPrompt) {
      setLastVideoGenerationPrompt(nextPrompt);
    }
    if (nextSubmittedAt && nextSubmittedAt !== lastVideoGenerationSubmittedAt) {
      setLastVideoGenerationSubmittedAt(nextSubmittedAt);
    }
    if (nextCompletedAt && nextCompletedAt !== lastVideoGenerationCompletedAt) {
      setLastVideoGenerationCompletedAt(nextCompletedAt);
    }
  }, [
    data?.generationTime,
    data?.lastVideoGenerationAt,
    data?.lastVideoGenerationCompletedAt,
    data?.lastVideoGenerationPrompt,
    data?.lastVideoGenerationStartedAt,
    data?.lastVideoGenerationSubmittedAt,
    lastVideoGenerationCompletedAt,
    lastVideoGenerationPrompt,
    lastVideoGenerationSubmittedAt,
  ]);

  useEffect(() => {
    if (!showDetailPanel) {
      setShowModelMenu(false);
      setShowSpecMenu(false);
    }
  }, [showDetailPanel]);

  useEffect(() => {
    if (!showGenerationInfo) return;
    const handleEscape = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setShowGenerationInfo(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [showGenerationInfo]);

  useEffect(() => {
    const nextVideo = data?.generatedVideo ?? data?.capturedClip ?? null;
    if (!nextVideo?.src) return;

    const nextDuration = nextVideo.duration || 0;
    const nextMode = data?.videoMode || inferInitialVideoMode(data);
    const nextPreviewUpdatedAt = nextVideo.previewUpdatedAt || null;
    const needsVideoSync =
      importedVideo?.src !== nextVideo.src ||
      importedVideo?.previewUpdatedAt !== nextPreviewUpdatedAt;

    if (needsVideoSync) {
      setImportedVideo((prev) => ({
        src: nextVideo.src,
        width: nextVideo.width || prev?.width || 1280,
        height: nextVideo.height || prev?.height || 720,
        name: nextVideo.name || 'dashscope-video.mp4',
        duration: nextDuration || prev?.duration || 0,
        previewUpdatedAt: nextPreviewUpdatedAt,
      }));
      requestAnimationFrame(() => updateNodeInternals(nodeId));
    }
    if (nextMode && nextMode !== videoMode) {
      setVideoMode(nextMode);
    }
    if (durationRef.current !== nextDuration) {
      setDuration(nextDuration);
      durationRef.current = nextDuration;
    }
  }, [
    data?.capturedClip,
    data?.generatedVideo,
    data?.videoMode,
    importedVideo?.previewUpdatedAt,
    importedVideo?.src,
    nodeId,
    updateNodeInternals,
    videoMode,
  ]);

  useEffect(() => {
    const nextStatus = String(data?.videoTaskStatus || '').toUpperCase();
    const nextTaskId = String(data?.videoTaskId || '');
    if (nextStatus && nextStatus !== String(videoTaskStatus || '').toUpperCase()) {
      const newestStatus = pickNewestVideoTaskStatus(videoTaskStatus, nextStatus);
      if (newestStatus !== String(videoTaskStatus || '').toUpperCase()) {
        setVideoTaskStatus(newestStatus);
      }
    }
    if (nextTaskId && nextTaskId !== videoTaskId) {
      setVideoTaskId(nextTaskId);
    }
  }, [data?.videoTaskId, data?.videoTaskStatus, videoTaskId, videoTaskStatus]);

  useEffect(() => {
    const nextGeneratedVideoData =
      generatedVideoData || (data?.generatedVideo?.src ? data.generatedVideo : null);
    const nextCapturedClipData =
      capturedClipData || (data?.capturedClip?.src ? data.capturedClip : null);
    const nextVideoTaskStatus = pickNewestVideoTaskStatus(videoTaskStatus, data?.videoTaskStatus);
    const nextVideoTaskId = videoTaskId || data?.videoTaskId || '';
    const patch = {
      videoGenMode,
      videoMode,
      videoPrompt,
      lastVideoGenerationPrompt,
      lastVideoGenerationSubmittedAt: resolvedLastVideoGenerationSubmittedAt,
      lastVideoGenerationCompletedAt: resolvedLastVideoGenerationCompletedAt,
      lastVideoGenerationAt: resolvedLastVideoGenerationCompletedAt,
      videoModel,
      videoRatio,
      videoResolution,
      videoDurationLabel,
      seedanceScenario,
      videoTaskStatus: nextVideoTaskStatus,
      videoTaskId: nextVideoTaskId,
      capturedClip: nextCapturedClipData,
      generatedVideo: nextGeneratedVideoData,
    };
    if (isNodeDataPatchUnchanged(data, patch)) return;
    if (persistNodeData) {
      persistNodeData(nodeId, patch);
    } else {
      updateNodeData(nodeId, patch);
    }
  }, [
    capturedClipData,
    data?.capturedClip,
    data?.generatedVideo,
    data?.videoTaskId,
    data?.videoTaskStatus,
    generatedVideoData,
    nodeId,
    persistNodeData,
    updateNodeData,
    videoDurationLabel,
    videoGenMode,
    videoMode,
    videoModel,
    videoPrompt,
    lastVideoGenerationPrompt,
    lastVideoGenerationSubmittedAt,
    lastVideoGenerationCompletedAt,
    resolvedLastVideoGenerationSubmittedAt,
    resolvedLastVideoGenerationCompletedAt,
    videoRatio,
    videoResolution,
    seedanceScenario,
    videoTaskStatus,
    videoTaskId,
  ]);

  const closeMentionMenu = useCallback(() => {
    setMentionMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
  }, []);

  const syncMentionMenu = useCallback(
    (value, caret) => {
      if (!inputMediaRefs.length) {
        closeMentionMenu();
        return;
      }

      const safeCaret = Math.max(0, Math.min(caret ?? value.length, value.length));
      const beforeCaret = value.slice(0, safeCaret);
      const match = beforeCaret.match(/@([^\s@]*)$/);
      if (!match) {
        closeMentionMenu();
        return;
      }

      const query = match[1] || '';
      setMentionMenu({
        open: true,
        query,
        replaceStart: safeCaret - query.length - 1,
        replaceEnd: safeCaret,
      });
    },
    [closeMentionMenu, inputMediaRefs.length]
  );

  const filteredMentionItems = useMemo(() => {
    const query = mentionMenu.query.trim().toLowerCase();
    if (!query) return mediaMentionItems;
    return mediaMentionItems.filter(
      (item) =>
        item.token.toLowerCase().includes(`@${query}`) ||
        item.label.toLowerCase().includes(query) ||
        String(item.index + 1).includes(query)
    );
  }, [mediaMentionItems, mentionMenu.query]);

  const renderPromptMentionHighlight = useCallback((className = 'px-0 py-0 text-[15px] leading-[1.6]') => {
    if (!videoPrompt || !mediaMentionItems.length) return null;

    const validTokens = new Set(mediaMentionItems.map((item) => item.token));
    const segments = videoPrompt.split(/(@(?:\u56fe\u7247|\u89c6\u9891)\d+)/g);

    return (
      <div
        ref={showPromptModal ? modalPromptHighlightRef : promptHighlightRef}
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-transparent ${className}`}
      >
        {segments.map((segment, index) =>
          validTokens.has(segment) ? (
            <span
              key={`video-token-${index}`}
              className="rounded-[6px] border border-[#556079] bg-[#3a4358]/95 font-medium text-[#f7f9fd] shadow-[0_0_0_1px_rgba(255,255,255,0.04)] [box-decoration-break:clone] [-webkit-box-decoration-break:clone]"
            >
              {segment}
            </span>
          ) : (
            <span key={`video-plain-${index}`} className="text-transparent">
              {segment}
            </span>
          )
        )}
      </div>
    );
  }, [mediaMentionItems, videoPrompt]);

  const syncPromptHighlightScroll = useCallback(() => {
    const textarea = showPromptModal ? modalTextareaRef.current : textareaRef.current;
    const highlight = showPromptModal ? modalPromptHighlightRef.current : promptHighlightRef.current;
    if (!textarea || !highlight) return;
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }, [showPromptModal]);

  const insertMentionToken = useCallback(
    (item) => {
      if (!item) return;

      const textarea = showPromptModal ? modalTextareaRef.current : textareaRef.current;
      const fallbackCaret = textarea?.selectionStart ?? videoPrompt.length;
      const replaceStart = mentionMenu.open ? mentionMenu.replaceStart : fallbackCaret;
      const replaceEnd = mentionMenu.open ? mentionMenu.replaceEnd : fallbackCaret;
      const nextValue = `${videoPrompt.slice(0, replaceStart)}${item.token} ${videoPrompt.slice(replaceEnd)}`;
      const nextCaret = replaceStart + item.token.length + 1;

      setVideoPrompt(nextValue);
      closeMentionMenu();

      requestAnimationFrame(() => {
        const target = showPromptModal ? modalTextareaRef.current : textareaRef.current;
        if (!target) return;
        target.focus();
        target.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [closeMentionMenu, mentionMenu.open, mentionMenu.replaceEnd, mentionMenu.replaceStart, showPromptModal, videoPrompt]
  );

  const removeMentionTokenAroundCaret = useCallback(
    (value, selectionStart, selectionEnd, action) => {
      const tokenRegex = /@(?:\u56fe\u7247|\u89c6\u9891)\d+/g;
      let match;
      while ((match = tokenRegex.exec(value))) {
        const tokenStart = match.index;
        const tokenEnd = tokenStart + match[0].length;
        const overlapsSelection =
          selectionStart !== selectionEnd &&
          Math.max(selectionStart, tokenStart) < Math.min(selectionEnd, tokenEnd);
        const backspaceHit =
          selectionStart === selectionEnd && selectionStart > tokenStart && selectionStart <= tokenEnd;
        const backspaceTrailingSpaceHit =
          action === 'backspace' &&
          selectionStart === selectionEnd &&
          value[tokenEnd] === ' ' &&
          selectionStart === tokenEnd + 1;
        const deleteHit =
          selectionStart === selectionEnd && selectionStart >= tokenStart && selectionStart < tokenEnd;

        if (!overlapsSelection && !backspaceHit && !backspaceTrailingSpaceHit && !deleteHit) continue;

        let removeStart = tokenStart;
        let removeEnd = tokenEnd;
        if (value[removeEnd] === ' ') removeEnd += 1;

        const nextValue = `${value.slice(0, removeStart)}${value.slice(removeEnd)}`;
        setVideoPrompt(nextValue);
        closeMentionMenu();

        requestAnimationFrame(() => {
          const target = textareaRef.current;
          if (!target) return;
          target.focus();
          target.setSelectionRange(removeStart, removeStart);
        });
        return true;
      }

      return false;
    },
    [closeMentionMenu]
  );

  const adjustPromptAfterRefRemoval = useCallback((value, removedIndex, kind = 'image') => {
    if (!value) return value;

    const prefix = kind === 'video' ? '\u89c6\u9891' : '\u56fe\u7247';
    let nextValue = value.replace(new RegExp(`@${prefix}${removedIndex}`, 'g'), '');
    for (let index = removedIndex + 1; index <= 8; index += 1) {
      nextValue = nextValue.replace(new RegExp(`@${prefix}${index}`, 'g'), `@${prefix}${index - 1}`);
    }

    return nextValue
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/(^|\n) /g, '$1')
      .replace(/ \n/g, '\n');
  }, []);

  const adjustSelectedTokensAfterRefRemoval = useCallback((tokens, removedIndex, kind = 'image') => {
    const prefix = kind === 'video' ? '\u89c6\u9891' : '\u56fe\u7247';
    return tokens
      .map((token) => {
        const match = token.match(new RegExp(`^@${prefix}(\\d+)$`));
        if (!match) return token;
        const tokenIndex = Number(match[1]);
        if (tokenIndex === removedIndex) return null;
        if (tokenIndex > removedIndex) return `@${prefix}${tokenIndex - 1}`;
        return token;
      })
      .filter(Boolean);
  }, []);

  const removeInputReference = useCallback(
    (item) => {
      if (!item?.sourceNodeId || !nodeId) return;
      const removedIndex = item.index + 1;
      setEdges((edges) =>
        edges.filter((edge) => !(edge.source === item.sourceNodeId && edge.target === nodeId))
      );
      const removedKind = item.kind === 'video' ? 'video' : 'image';
      setSelectedReferenceTokens((prev) => adjustSelectedTokensAfterRefRemoval(prev, removedIndex, removedKind));
      setVideoPrompt((prev) => adjustPromptAfterRefRemoval(prev, removedIndex, removedKind));
      closeMentionMenu();
    },
    [adjustPromptAfterRefRemoval, adjustSelectedTokensAfterRefRemoval, closeMentionMenu, nodeId, setEdges]
  );

  useEffect(() => {
    if (!mentionMenu.open) return;
    const close = (event) => {
      if (typeof event.target?.closest === 'function' && event.target.closest('[data-mention-menu="true"]')) return;
      if (textareaRef.current?.contains?.(event.target)) return;
      if (modalTextareaRef.current?.contains?.(event.target)) return;
      closeMentionMenu();
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [closeMentionMenu, mentionMenu.open]);

  // mute sync
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = isMuted;
  }, [isMuted]);

  // keep clipStateRef / durationRef in sync (for stale-closure-free drag handlers)
  useEffect(() => { clipStateRef.current.start = clipStart; }, [clipStart]);
  useEffect(() => { clipStateRef.current.end   = clipEnd;   }, [clipEnd]);
  useEffect(() => { durationRef.current        = duration;  }, [duration]);

  // 仅在剪辑面板打开时：将播放约束在入出点之间循环；关闭面板后立即恢复全片播放
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !hasVideo) return;
    const onTime = () => {
      if (!showClipEditor) return;
      const d = durationRef.current;
      if (!d || !isFinite(d) || d <= 0) return;
      const s = clipStateRef.current.start;
      const e = clipStateRef.current.end;
      if (e - s >= 0.999) return;
      if (e - s <= 0.001) return;
      const t0 = s * d;
      const t1 = e * d;
      if (v.currentTime >= t1 - 0.05) {
        v.currentTime = t0;
      } else if (v.currentTime < t0) {
        v.currentTime = t0;
      }
    };
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, [hasVideo, showClipEditor]);

  // generate filmstrip thumbnails when clip editor opens
  useEffect(() => {
    if (!showClipEditor || !importedVideo || thumbnails.length > 0) return;
    let cancelled = false;
    (async () => {
      const COUNT = 16;
      const probe = document.createElement('video');
      probe.src = importedVideo.src;
      probe.muted = true;
      await new Promise(r => probe.addEventListener('loadedmetadata', r, { once: true }));
      const out = [];
      for (let i = 0; i < COUNT; i++) {
        if (cancelled) break;
        const t = (probe.duration * i) / COUNT;
        await new Promise(r => {
          probe.onseeked = () => {
            probe.onseeked = null;
            if (!cancelled) {
              const c = document.createElement('canvas');
              c.width = 60; c.height = 34;
              c.getContext('2d').drawImage(probe, 0, 0, 60, 34);
              out.push(c.toDataURL('image/jpeg', 0.65));
            }
            r();
          };
          probe.currentTime = t;
        });
      }
      if (!cancelled) setThumbnails(out);
    })();
    return () => { cancelled = true; };
  }, [showClipEditor, importedVideo, thumbnails.length]);

  /** Esc：退出剪辑面板并重置入出点（不保留区间记录）；blur 去掉「剪辑」按钮焦点残留高亮 */
  useEffect(() => {
    if (!showClipEditor) return;
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setClipStart(0);
      setClipEnd(1);
      clipStateRef.current = { start: 0, end: 1 };
      setShowClipEditor(false);
      queueMicrotask(() => {
        clipToolbarButtonRef.current?.blur();
        const ae = document.activeElement;
        if (ae instanceof HTMLElement) ae.blur();
      });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [showClipEditor]);

  // close capture menu on outside click
  useEffect(() => {
    if (!showCaptureMenu) return;
    const h = (e) => {
      if (captureMenuRef.current && !captureMenuRef.current.contains(e.target))
        setShowCaptureMenu(false);
    };
    document.addEventListener('pointerdown', h);
    return () => document.removeEventListener('pointerdown', h);
  }, [showCaptureMenu]);

  useEffect(() => {
    if (!hasVideo) {
      setShowVideoTools(false);
      return;
    }
    const handleOutsidePointer = (event) => {
      if (!showVideoTools) return;
      const clickedToolbar = videoToolbarRef.current?.contains(event.target);
      const clickedSurface = videoSurfaceRef.current?.contains(event.target);
      if (!clickedToolbar && !clickedSurface) {
        setShowVideoTools(false);
      }
    };
    document.addEventListener('pointerdown', handleOutsidePointer);
    return () => document.removeEventListener('pointerdown', handleOutsidePointer);
  }, [hasVideo, showVideoTools]);

  // cleanup blob URL
  useEffect(() => () => {
    if (videoObjectUrlRef.current) URL.revokeObjectURL(videoObjectUrlRef.current);
  }, []);

  // update node internals
  useEffect(() => {
    if (nodeId) updateNodeInternals(nodeId);
  }, [nodeId, showClipEditor, showDetailPanel, showHandleUi, showInputHandleUi, videoCardHeight, updateNodeInternals]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handlePromptKeyDown = useCallback(
    (event) => {
      if (event.key === '@') {
        mentionTriggerRef.current = true;
      } else if (mentionTriggerRef.current) {
        mentionTriggerRef.current = false;
      }

      const inputEl = event.currentTarget;
      const value = inputEl.value;
      const selectionStart = inputEl.selectionStart ?? 0;
      const selectionEnd = inputEl.selectionEnd ?? selectionStart;

      const nextCaret = getMentionCaretNavigationTarget(value, selectionStart, selectionEnd, event.key);
      if (nextCaret !== null) {
        event.preventDefault();
        requestAnimationFrame(() => {
          inputEl.setSelectionRange(nextCaret, nextCaret);
        });
        return;
      }

      if ((event.key === 'Backspace' || event.key === 'Delete') && selectionStart !== selectionEnd) {
        const deletionRange = getMentionDeletionRange(value, selectionStart, selectionEnd);
        if (deletionRange) {
          event.preventDefault();
          const nextValue = `${value.slice(0, deletionRange.start)}${value.slice(deletionRange.end)}`;
          setVideoPrompt(nextValue);
          requestAnimationFrame(() => {
            inputEl.setSelectionRange(deletionRange.start, deletionRange.start);
          });
          return;
        }
      }

      if (event.key === 'Backspace') {
        if (removeMentionTokenAroundCaret(value, selectionStart, selectionEnd, 'backspace')) {
          event.preventDefault();
          return;
        }
      }

      if (event.key === 'Delete') {
        if (removeMentionTokenAroundCaret(value, selectionStart, selectionEnd, 'delete')) {
          event.preventDefault();
        }
      }
    },
    [removeMentionTokenAroundCaret]
  );

  const renderInputImageRefs = useCallback(({ scrollerRef = refsScrollerRef, sizeClass = 'h-14 w-14' } = {}) => {
    if (!mediaMentionItems.length) return null;

    return (
      <div
        ref={scrollerRef}
        className="flex h-full items-center gap-3 overflow-x-auto overflow-y-hidden px-0.5 py-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        {mediaMentionItems.map((asset) => (
          <div
            key={`${asset.kind}-${asset.src}-${asset.index}`}
            className={`group relative ${sizeClass} shrink-0 overflow-hidden rounded-[13px] border bg-[#14161b] ${
              selectedReferenceTokens.includes(asset.token)
                ? 'border-[#8fb9ff] shadow-[0_0_0_1px_rgba(143,185,255,0.35)]'
                : 'border-white/30'
            }`}
          >
            <button
              type="button"
              className="absolute inset-0 z-0"
              onClick={() => {
                const token = asset.token;
                setSelectedReferenceTokens((prev) =>
                  prev.includes(token) ? prev.filter((item) => item !== token) : [...prev, token]
                );
              }}
            />
            <div className="absolute left-1 top-1 z-10 min-w-4 rounded-full bg-black/60 px-1 py-[1px] text-center text-[10px] font-semibold leading-none text-white backdrop-blur-sm">
              {asset.label}
            </div>
            <button
              type="button"
              className="absolute right-1 top-1 z-20 flex h-4 w-4 items-center justify-center rounded-full border border-white/15 bg-black/70 text-white/80 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                removeInputReference(asset);
              }}
            >
              <X size={10} />
            </button>
            {asset.kind === 'video' ? (
              <video
                src={asset.src}
                preload="metadata"
                muted
                playsInline
                className="pointer-events-none h-full w-full object-cover"
                draggable={false}
              />
            ) : (
              <img
                src={asset.src}
                alt={asset.name || asset.label}
                loading="lazy"
                decoding="async"
                className="pointer-events-none h-full w-full object-cover"
                draggable={false}
              />
            )}
          </div>
        ))}
      </div>
    );
  }, [mediaMentionItems, removeInputReference, selectedReferenceTokens]);

  const imageSourceToRequestPayload = useCallback(async (source) => {
    /**
     * 这一层专门解决“前端素材 src 的形态很多，但后端希望统一收到可处理内容”的问题。
     *
     * 可能出现的 src：
     * 1. 已经是 http/https 公网地址 -> 直接传给后端；
     * 2. 已经是 data URL -> 直接传给后端；
     * 3. 浏览器 blob URL / 本地对象 URL -> 先 fetch 成 Blob，再转成 data URL；
     * 4. 其他情况 -> 尝试按 URL fetch，再转 data URL。
     *
     * 后端拿到 data URL 后，会再走“官方临时 OSS 上传”流程转成 DashScope 可识别的 `oss://` URL。
     */
    const rawSource = String(source || '').trim();
    if (!rawSource) return '';

    if (
      rawSource.startsWith('asset://') ||
      rawSource.startsWith('http://') ||
      rawSource.startsWith('https://') ||
      rawSource.startsWith('data:')
    ) {
      return rawSource;
    }

    const response = await fetch(rawSource);
    if (!response.ok) {
      throw new Error(`素材读取失败：${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();

    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(new Error('素材转 data URL 失败'));
      reader.readAsDataURL(blob);
    });
  }, []);

  const resolveSeedanceReferenceSource = useCallback((item) => {
    if (!item) return '';
    const review = item.seedanceFaceReview || {};
    const reviewStatus = String(review.status || '').toLowerCase();
    const assetRef = String(review.assetRef || '').trim();
    if (currentVideoCapability.backend === 'xunke_seedance' && reviewStatus === 'approved' && assetRef) {
      return assetRef;
    }
    return item.src || '';
  }, [currentVideoCapability.backend]);

  const ensureSeedanceReferencesReady = useCallback((items) => {
    if (currentVideoCapability.backend !== 'xunke_seedance') return true;
    const pendingOrFailed = items.find((item) => {
      const reviewStatus = String(item?.seedanceFaceReview?.status || '').toLowerCase();
      return reviewStatus && reviewStatus !== 'approved';
    });
    if (!pendingOrFailed) return true;

    const reviewStatus = String(pendingOrFailed.seedanceFaceReview?.status || '').toLowerCase();
    const message =
      reviewStatus === 'processing'
        ? 'Seedance 2.0 face review is still processing. Please generate video after approval.'
        : pendingOrFailed.seedanceFaceReview?.message || 'Seedance 2.0 face review failed. Please replace the image or review it again.';
    window.alert(message);
    return false;
  }, [currentVideoCapability.backend]);

  const applyGeneratedVideoResult = useCallback((result, targetNodeId = nodeId, generationMeta = {}) => {
    const previewSrc = result?.preview_url || result?.result_url;
    if (!previewSrc) {
      throw new Error('视频任务已成功，但没有拿到可回显的视频地址');
    }

    const completedAt = new Date().toISOString();
    const videoAsset = {
      src: previewSrc,
      width: importedVideo?.width || 1280,
      height: importedVideo?.height || 720,
      name: result?.saved_filename || importedVideo?.name || 'dashscope-video.mp4',
      duration: 0,
      previewUpdatedAt: completedAt,
    };
    const finalPatch = {
      videoMode: 'generated',
      generatedVideo: videoAsset,
      capturedClip: null,
      videoTaskStatus: 'SUCCEEDED',
      videoTaskId: generationMeta.taskId || '',
      generationPending: false,
      generationProgress: 100,
      generationError: '',
      pendingPreviewAsset: null,
      lastVideoGenerationPrompt: generationMeta.prompt || lastVideoGenerationPrompt,
      lastVideoGenerationSubmittedAt: generationMeta.submittedAt || lastVideoGenerationSubmittedAt,
      lastVideoGenerationCompletedAt: completedAt,
      lastVideoGenerationAt: completedAt,
    };

    if (targetNodeId === nodeId) {
      setImportedVideo(videoAsset);
      setVideoMode('generated');
      setVideoTaskStatus('SUCCEEDED');
      setVideoTaskId(generationMeta.taskId || '');
      setLastVideoGenerationCompletedAt(completedAt);
      setCurrentTime(0);
      setDuration(0);
      setClipStart(0);
      setClipEnd(1);
      clipStateRef.current = { start: 0, end: 1 };
      setShowClipEditor(false);
    }

    setNodes((nodes) =>
      nodes.map((node) =>
        node.id === targetNodeId
          ? { ...node, data: { ...(node.data || {}), ...finalPatch } }
          : node
      )
    );
    updateNodeData(targetNodeId, finalPatch);
    persistNodeData?.(targetNodeId, finalPatch);
    void flushProjectSave?.();
    requestAnimationFrame(() => updateNodeInternals(targetNodeId));
  }, [
    flushProjectSave,
    importedVideo?.height,
    importedVideo?.name,
    importedVideo?.width,
    lastVideoGenerationPrompt,
    lastVideoGenerationSubmittedAt,
    nodeId,
    persistNodeData,
    setNodes,
    updateNodeData,
    updateNodeInternals,
  ]);

  const pollVideoTaskUntilFinished = useCallback(async (taskId, signal, targetNodeId = nodeId, generationMeta = {}) => {
    /**
     * 这是整个视频生成流程里最关键的“异步轮询函数”。
     *
     * 为什么它不会阻塞 UI 主线程：
     * - 因为这里不是 while(true) + 同步 sleep；
     * - 而是 `await fetch(...)` + `await sleep(5000)`；
     * - 每一次等待都会把控制权交还给浏览器事件循环；
     * - 所以在轮询期间，画布拖拽、节点点击、输入框编辑都还能正常响应。
     *
     * 轮询规则严格按你的要求实现：
     * 1. 每隔 5 秒请求一次任务查询接口；
     * 2. `PENDING` / `RUNNING` -> 继续等待；
     * 3. `SUCCEEDED` -> 取回 video_url / preview_url，回显到节点；
     * 4. `FAILED` / `CANCELED` / `UNKNOWN` -> 抛错，中止轮询，并恢复按钮状态。
     */
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const response = await fetch(`/api/video-task/${encodeURIComponent(taskId)}`, {
        signal,
        headers: {
          ...(projectSlug ? { 'X-Project-Slug': projectSlug } : {}),
        },
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result?.error || '查询视频任务状态失败');
      }

      const nextStatus = String(result?.task_status || '').toUpperCase();
      const nextProgress = nextStatus === 'SUCCEEDED'
        ? 100
        : nextStatus === 'RUNNING'
          ? 62
          : nextStatus === 'PENDING'
            ? 28
            : 12;
      if (targetNodeId === nodeId && generationActiveRef.current) {
        setVideoTaskStatus(nextStatus);
        setVideoTaskId(taskId);
      }
      const statusPatch = {
        videoTaskId: taskId,
        videoTaskStatus: nextStatus,
        generationPending: nextStatus === 'PENDING' || nextStatus === 'RUNNING',
        generationProgress: nextProgress,
        generationError: '',
      };
      updateNodeData(targetNodeId, statusPatch);
      persistNodeData?.(targetNodeId, statusPatch);
      void flushProjectSave?.();

      if (nextStatus === 'PENDING' || nextStatus === 'RUNNING') {
        await sleepWithAbort(5000, signal);
        continue;
      }

      if (nextStatus === 'SUCCEEDED') {
        applyGeneratedVideoResult(result, targetNodeId, { ...generationMeta, taskId });
        return result;
      }

      throw new Error(result?.error || result?.message || `视频生成失败：${nextStatus || 'UNKNOWN'}`);
    }

    throw new DOMException('Aborted', 'AbortError');
  }, [applyGeneratedVideoResult, flushProjectSave, nodeId, persistNodeData, projectSlug, updateNodeData]);

  useEffect(() => {
    const status = String(data?.videoTaskStatus || '').toUpperCase();
    const storedTaskId = String(data?.videoTaskId || '').trim();
    if (!nodeGenerationPending || storedTaskId || isGenerating) return;
    if (!['SUBMITTING', 'PENDING', 'RUNNING'].includes(status)) return;

    const submittedAt = Date.parse(data?.lastVideoGenerationSubmittedAt || '');
    const isFreshSubmit = Number.isFinite(submittedAt) && Date.now() - submittedAt < 120000;
    if (isFreshSubmit) return;

    const patch = {
      generationPending: false,
      generationProgress: 0,
      generationError: '视频生成已中断：缺少任务 ID，无法继续轮询，请重新生成。',
      videoTaskStatus: 'FAILED',
    };
    updateNodeData(nodeId, patch);
    persistNodeData?.(nodeId, patch);
    void flushProjectSave?.();
  }, [
    data?.lastVideoGenerationSubmittedAt,
    data?.videoTaskId,
    data?.videoTaskStatus,
    flushProjectSave,
    isGenerating,
    nodeGenerationPending,
    nodeId,
    persistNodeData,
    updateNodeData,
  ]);

  useEffect(() => {
    const storedTaskId = String(data?.videoTaskId || '').trim();
    const storedStatus = String(data?.videoTaskStatus || '').toUpperCase();
    if (!nodeGenerationPending || !storedTaskId || isGenerating || videoGenerationAbortRef.current) return;
    if (!['SUBMITTING', 'PENDING', 'RUNNING'].includes(storedStatus)) return;

    const abortController = new AbortController();
    videoGenerationAbortRef.current = abortController;
    videoGenerationCancelledRef.current = false;
    const resumedStatus = storedStatus === 'SUBMITTING' ? 'PENDING' : storedStatus;
    setIsGenerating(true);
    setActiveVideoGenerationTargetId(nodeId);
    setVideoTaskId(storedTaskId);
    setVideoTaskStatus(resumedStatus);

    const unregisterCancel = registerGenerationCancel(nodeId, () => {
      videoGenerationCancelledRef.current = true;
      abortController.abort();
      const patch = {
        generationPending: false,
        generationProgress: 0,
        generationError: '已取消',
        videoTaskStatus: 'CANCELED',
      };
      updateNodeData(nodeId, patch);
      persistNodeData?.(nodeId, patch);
      void flushProjectSave?.();
    });

    pollVideoTaskUntilFinished(storedTaskId, abortController.signal, nodeId, {
      prompt: data?.lastVideoGenerationPrompt || data?.videoPrompt || videoPrompt,
      submittedAt: data?.lastVideoGenerationSubmittedAt || lastVideoGenerationSubmittedAt,
      taskId: storedTaskId,
    })
      .catch((error) => {
        if (abortController.signal.aborted || videoGenerationCancelledRef.current || error?.name === 'AbortError') return;
        const patch = {
          generationPending: false,
          generationProgress: 0,
          generationError: error instanceof Error ? error.message : '生成失败',
          videoTaskStatus: 'FAILED',
        };
        setVideoTaskStatus('FAILED');
        updateNodeData(nodeId, patch);
        persistNodeData?.(nodeId, patch);
        void flushProjectSave?.();
      })
      .finally(() => {
        unregisterCancel();
        if (videoGenerationAbortRef.current === abortController) {
          videoGenerationAbortRef.current = null;
        }
        if (!abortController.signal.aborted && generationActiveRef.current) {
          setIsGenerating(false);
          setActiveVideoGenerationTargetId('');
        }
      });

    return () => {
      abortController.abort();
      unregisterCancel();
      if (videoGenerationAbortRef.current === abortController) {
        videoGenerationAbortRef.current = null;
      }
    };
  }, [
    data?.lastVideoGenerationPrompt,
    data?.lastVideoGenerationSubmittedAt,
    data?.videoPrompt,
    data?.videoTaskId,
    data?.videoTaskStatus,
    flushProjectSave,
    isGenerating,
    lastVideoGenerationSubmittedAt,
    nodeGenerationPending,
    nodeId,
    persistNodeData,
    pollVideoTaskUntilFinished,
    updateNodeData,
    videoPrompt,
  ]);

  const createPendingGeneratedVideoNode = useCallback((usedPrompt = '', submittedAt = '') => {
    saveSnapshot?.();
    const cur =
      getInternalNode(nodeId)?.internals?.positionAbsolute ??
      getNode(nodeId)?.position ??
      { x: 0, y: 0 };
    const newId = `video_generated_${Date.now()}`;
    const patch = {
      cleanPanel: true,
      videoMode: 'generated',
      generationPending: true,
      generationProgress: 12,
      generationError: '',
      videoTaskStatus: 'SUBMITTING',
      videoTaskId: '',
      videoPrompt: usedPrompt,
      lastVideoGenerationPrompt: usedPrompt,
      lastVideoGenerationSubmittedAt: submittedAt,
      lastVideoGenerationCompletedAt: '',
      lastVideoGenerationAt: '',
      videoModel,
      videoRatio,
      videoResolution,
      videoDurationLabel,
      seedanceScenario,
      pendingPreviewAsset: importedVideo
        ? { ...importedVideo, kind: 'video' }
        : inputVideoRefs[0] || inputImageRefs[0] || null,
      uiDismissToken: uiDismissToken ?? 0,
    };
    addNodes({
      id: newId,
      type: 'AIVideoNode',
      position: { x: cur.x + 460, y: cur.y },
      dragHandle: NODE_DRAG_HANDLE_SELECTOR,
      data: patch,
      selected: true,
    });
    addEdges({
      id: `e-generate-video-${nodeId}-${newId}`,
      source: nodeId,
      target: newId,
      sourceHandle: 'output',
      sourcePosition: Position.Right,
      targetHandle: 'input',
      targetPosition: Position.Left,
      selectable: true,
      focusable: true,
      style: { stroke: '#a8afbb', strokeWidth: 1.8 },
    });
    requestAnimationFrame(() => {
      updateNodeInternals(newId);
      void flushProjectSave?.();
    });
    return newId;
  }, [
    addEdges,
    addNodes,
    flushProjectSave,
    getInternalNode,
    getNode,
    importedVideo,
    inputImageRefs,
    inputVideoRefs,
    nodeId,
    saveSnapshot,
    seedanceScenario,
    uiDismissToken,
    updateNodeInternals,
    videoDurationLabel,
    videoModel,
    videoRatio,
    videoResolution,
  ]);

  const handleCancelVideoGeneration = useCallback((event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    videoGenerationCancelledRef.current = true;
    videoGenerationAbortRef.current?.abort();
    setVideoTaskStatus('CANCELED');
    setIsGenerating(false);
  }, []);

  const handleCancelVisibleVideoGeneration = useCallback((event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (cancelGenerationForNode(nodeId)) return;
    if (nodeGenerationPending) {
      updateNodeData(nodeId, {
        generationPending: false,
        generationProgress: 0,
        generationError: '已取消',
        videoTaskStatus: 'CANCELED',
        videoTaskId: '',
      });
      persistNodeData?.(nodeId, {
        generationPending: false,
        generationProgress: 0,
        generationError: '已取消',
        videoTaskStatus: 'CANCELED',
        videoTaskId: '',
      });
      return;
    }
    handleCancelVideoGeneration(event);
  }, [handleCancelVideoGeneration, nodeGenerationPending, nodeId, persistNodeData, updateNodeData]);


  const handleGenerateVideo = useCallback(async () => {
    const prompt = videoPrompt.trim();
    if (!prompt) {
      window.alert('请先填写视频提示词。');
      return;
    }

    const referenceItems = resolveGenerationReferenceItems();
    const effectiveReferenceItems = referenceItems;
    const effectiveScenario = ['edit', 'extend'].includes(seedanceScenario)
      ? 'image_reference'
      : seedanceScenario;
    const effectiveImageReferenceItems = effectiveReferenceItems.filter((item) => item?.kind !== 'video');
    const effectiveVideoReferenceItems = effectiveReferenceItems.filter((item) => item?.kind === 'video');
    const selectedFirstFrameItem = effectiveImageReferenceItems[0] || null;
    const selectedLastFrameItem = effectiveImageReferenceItems[1] || null;

    if (!ensureSeedanceReferencesReady(effectiveReferenceItems)) {
      return;
    }

    if (currentVideoCapability.requiresReferenceImages && !effectiveImageReferenceItems.length) {
      setVideoGenMode('image');
      window.alert('当前模型至少需要 1 张参考图片。请先连接图片素材，或在提示词里 @引用图片。');
      return;
    }
    if (effectiveScenario === 'first_frame' && !selectedFirstFrameItem) {
      setVideoGenMode('image');
      window.alert('首帧生视频需要选择或连接 1 张图片作为首帧。');
      return;
    }
    if (effectiveScenario === 'first_last_frame' && (!selectedFirstFrameItem || !selectedLastFrameItem)) {
      setVideoGenMode('image');
      window.alert('首尾帧场景需要选择首帧和尾帧两张图片。');
      return;
    }

    const abortController = new AbortController();
    videoGenerationAbortRef.current = abortController;
    videoGenerationCancelledRef.current = false;
    const generationStartedAt = new Date().toISOString();
    const shouldGenerateIntoCurrentNode = !importedVideo?.src;
    const targetVideoNodeId = shouldGenerateIntoCurrentNode
      ? nodeId
      : createPendingGeneratedVideoNode(prompt, generationStartedAt);
    let unregisterCancel = () => {};

    try {
      setIsGenerating(true);
      setActiveVideoGenerationTargetId(targetVideoNodeId);
      setVideoTaskStatus('SUBMITTING');
      setLastVideoGenerationPrompt(prompt);
      setLastVideoGenerationSubmittedAt(generationStartedAt);
      setLastVideoGenerationCompletedAt('');
      if (shouldGenerateIntoCurrentNode) {
        const pendingPatch = {
          cleanPanel: true,
          videoMode: 'generated',
          generationPending: true,
          generationProgress: 12,
          generationError: '',
          videoTaskStatus: 'SUBMITTING',
          videoTaskId: '',
          videoPrompt: prompt,
          lastVideoGenerationPrompt: prompt,
          lastVideoGenerationSubmittedAt: generationStartedAt,
          lastVideoGenerationCompletedAt: '',
          lastVideoGenerationAt: '',
          pendingPreviewAsset: inputVideoRefs[0] || inputImageRefs[0] || null,
          uiDismissToken: uiDismissToken ?? 0,
        };
        updateNodeData(nodeId, pendingPatch);
        persistNodeData?.(nodeId, pendingPatch);
        void flushProjectSave?.();
      }
      unregisterCancel = registerGenerationCancel(targetVideoNodeId, () => {
        videoGenerationCancelledRef.current = true;
        abortController.abort();
        if (targetVideoNodeId === nodeId) {
          updateNodeData(nodeId, {
            generationPending: false,
            generationProgress: 0,
            generationError: '已取消',
            videoTaskStatus: 'CANCELED',
            videoTaskId: '',
          });
          persistNodeData?.(nodeId, {
            generationPending: false,
            generationProgress: 0,
            generationError: '已取消',
            videoTaskStatus: 'CANCELED',
            videoTaskId: '',
          });
          void flushProjectSave?.();
          return;
        }
        setNodes((nodes) => nodes.filter((node) => node.id !== targetVideoNodeId));
        setEdges((edges) =>
          edges.filter((edge) => edge.source !== targetVideoNodeId && edge.target !== targetVideoNodeId)
        );
      });

      const inputImages = await Promise.all(
        effectiveImageReferenceItems
          .slice(0, currentVideoCapability.maxInputImages || 9)
          .map((item) => imageSourceToRequestPayload(resolveSeedanceReferenceSource(item)))
      );
      const referenceVideos = await Promise.all(
        effectiveVideoReferenceItems
          .slice(0, 9)
          .map((item) => imageSourceToRequestPayload(resolveSeedanceReferenceSource(item)))
      );
      const firstFrameImage = selectedFirstFrameItem
        ? await imageSourceToRequestPayload(resolveSeedanceReferenceSource(selectedFirstFrameItem))
        : '';
      const lastFrameImage = selectedLastFrameItem
        ? await imageSourceToRequestPayload(resolveSeedanceReferenceSource(selectedLastFrameItem))
        : '';

      const requestedSeedanceModel =
        (selectedResolutionOption?.apiValue || '').toLowerCase() === '1080p'
          ? 'seed-2-1080'
          : currentVideoCapability.apiModel;

      const response = await fetch('/api/generate-video', {
        method: 'POST',
        signal: abortController.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(projectSlug ? { 'X-Project-Slug': projectSlug } : {}),
        },
        body: JSON.stringify({
          model: videoModel,
          backend: currentVideoCapability.backend,
          endpoint: currentVideoCapability.endpoint,
          provider_model_hint: requestedSeedanceModel,
          seedance_model: requestedSeedanceModel,
          prompt,
          ratio:
            getAllowedVideoRatios(videoModel).find((item) => item.label === videoRatio)?.apiValue || videoRatio,
          resolution: selectedResolutionOption?.apiValue || videoResolution,
          duration: selectedDurationOption?.apiValue || 5,
          scenario: effectiveScenario,
          reference_videos: referenceVideos.filter(Boolean),
          reference_audios: [],
          image: firstFrameImage,
          first_frame_image: firstFrameImage,
          last_frame_image: lastFrameImage,
          generate_audio: true,
          watermark: false,
          input_images: inputImages.filter(Boolean),
        }),
      });

      const submitResult = await response.json().catch(() => ({}));
      if (videoGenerationCancelledRef.current || abortController.signal.aborted) return;
      if (!response.ok) {
        throw new Error(submitResult?.error || '提交视频生成任务失败');
      }

      const taskId = submitResult?.task_id;
      if (!taskId) {
        throw new Error('任务提交成功，但没有返回 task_id');
      }

      const submittedStatus = String(submitResult?.task_status || 'PENDING').toUpperCase();
      const submittedProgress = submittedStatus === 'RUNNING' ? 62 : 28;
      if (targetVideoNodeId === nodeId) {
        setVideoTaskId(taskId);
        setVideoTaskStatus(submittedStatus);
      }
      updateNodeData(targetVideoNodeId, {
        videoTaskId: taskId,
        videoTaskStatus: submittedStatus,
        generationPending: true,
        generationProgress: submittedProgress,
        generationError: '',
      });
      persistNodeData?.(targetVideoNodeId, {
        videoTaskId: taskId,
        videoTaskStatus: submittedStatus,
        generationPending: true,
        generationProgress: submittedProgress,
        generationError: '',
      });
      void flushProjectSave?.();
      await pollVideoTaskUntilFinished(taskId, abortController.signal, targetVideoNodeId, {
        prompt,
        submittedAt: generationStartedAt,
        taskId,
      });
    } catch (error) {
      if (videoGenerationCancelledRef.current || abortController.signal.aborted || error?.name === 'AbortError') {
        return;
      }
      setVideoTaskStatus('FAILED');
      updateNodeData(targetVideoNodeId, {
        generationPending: false,
        generationProgress: 0,
        generationError: error instanceof Error ? error.message : '生成失败',
        videoTaskStatus: 'FAILED',
      });
      persistNodeData?.(targetVideoNodeId, {
        generationPending: false,
        generationProgress: 0,
        generationError: error instanceof Error ? error.message : '生成失败',
        videoTaskStatus: 'FAILED',
      });
      void flushProjectSave?.();
      window.alert(error instanceof Error ? error.message : '视频生成失败');
    } finally {
      unregisterCancel();
      setActiveVideoGenerationTargetId('');
      if (videoGenerationAbortRef.current === abortController) {
        videoGenerationAbortRef.current = null;
      }
      if (generationActiveRef.current) {
        setIsGenerating(false);
      }
    }
  }, [
    createPendingGeneratedVideoNode,
    imageSourceToRequestPayload,
    ensureSeedanceReferencesReady,
    importedVideo?.src,
    inputImageRefs,
    inputVideoRefs,
    nodeId,
    pollVideoTaskUntilFinished,
    resolveGenerationReferenceItems,
    resolveSeedanceReferenceSource,
    selectedDurationOption?.apiValue,
    selectedResolutionOption?.apiValue,
    currentVideoCapability.apiModel,
    currentVideoCapability.backend,
    currentVideoCapability.endpoint,
    currentVideoCapability.maxInputImages,
    currentVideoCapability.requiresReferenceImages,
    flushProjectSave,
    persistNodeData,
    videoModel,
    videoPrompt,
    videoRatio,
    videoResolution,
    setEdges,
    setNodes,
    updateNodeData,
    uiDismissToken,
    projectSlug,
    seedanceScenario,
  ]);

  const handleTranslatePrompt = useCallback(async () => {
    const sourceText = videoPrompt.trim();
    if (!sourceText || isTranslating) return;

    try {
      setIsTranslating(true);
      const { protectedText, tokens } = protectImageMentionTokens(sourceText);

      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: protectedText,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result?.error || '翻译失败');
      }

      if (result?.translated) {
        setVideoPrompt(restoreImageMentionTokens(result.translated, tokens));
      }
    } catch (error) {
      console.error('Translate video prompt failed:', error);
      window.alert(`翻译失败：${error.message || '请检查 DeepSeek API 配置'}`);
    } finally {
      setIsTranslating(false);
    }
  }, [isTranslating, videoPrompt]);

  const triggerImportVideo = (e) => { e?.stopPropagation?.(); videoFileInputRef.current?.click(); };

  const getAbsoluteNodePosition = useCallback(() => {
    return (
      getInternalNode(nodeId)?.internals?.positionAbsolute ??
      getNode(nodeId)?.position ??
      { x: 0, y: 0 }
    );
  }, [getInternalNode, getNode, nodeId]);

  const handleVideoImport = (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    probe.onloadedmetadata = () => {
      if (videoObjectUrlRef.current) URL.revokeObjectURL(videoObjectUrlRef.current);
      videoObjectUrlRef.current = url;
      setImportedVideo({
        src: url, width: probe.videoWidth || 1280,
        height: probe.videoHeight || 720,
        name: file.name, duration: probe.duration || 0,
        previewUpdatedAt: new Date().toISOString(),
      });
      setVideoMode('asset');
      setThumbnails([]);
      setCurrentTime(0);
      setDuration(probe.duration || 0);
      setClipStart(0);
      setClipEnd(1);
      clipStateRef.current = { start: 0, end: 1 };
      setShowClipEditor(false);
    };
    probe.src = url;
    ev.target.value = '';
  };

  /** Play/pause only from bottom control bar (not from clicking the video surface) */
  const togglePlayPause = useCallback((e) => {
    e?.stopPropagation?.();
    if (!videoRef.current) return;
    if (videoRef.current.paused) videoRef.current.play().catch(() => {});
    else videoRef.current.pause();
  }, []);

  const downloadImportedVideoFile = useCallback((e) => {
    e?.stopPropagation?.();
    if (!importedVideo?.src) return;
    const a = document.createElement('a');
    a.href = importedVideo.src;
    const name = importedVideo.name?.trim() || 'video.webm';
    a.download = /\.(webm|mp4|mov|mkv|avi)$/i.test(name) ? name : `${name.replace(/\.[^/.]+$/, '') || 'video'}.webm`;
    a.rel = 'noopener';
    a.click();
  }, [importedVideo]);

  /** 点击画面：保持「点选后离开仍播放」；仅在剪辑面板打开时用入出点预览区间 */
  const onVideoSurfacePointerDown = useCallback(() => {
    setEngagedPlayback(true);
    const v = videoRef.current;
    if (!v) return;
    const d = durationRef.current;
    if (d > 0 && showClipEditor) {
      const s = clipStateRef.current.start;
      const e = clipStateRef.current.end;
      if (e - s < 0.999 && e - s > 0.001) {
        const t0 = s * d;
        const t1 = e * d;
        if (v.currentTime < t0 || v.currentTime >= t1 - 0.05) v.currentTime = t0;
      }
    }
    v.play().catch(() => {});
  }, [showClipEditor]);

  const toggleMute = (e) => { e.stopPropagation(); setIsMuted(v => !v); };

  // progress bar seek on pointer-down + drag
  const handleProgressPointerDown = (e) => {
    e.stopPropagation(); e.preventDefault();
    if (!videoRef.current) return;
    const rect = progressBarRef.current?.getBoundingClientRect();
    if (!rect) return;
    const wasPlaying = !videoRef.current.paused;
    videoRef.current.pause();
    const seek = (cx) => {
      if (!videoRef.current) return;
      const r = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
      videoRef.current.currentTime = r * videoRef.current.duration;
    };
    seek(e.clientX);
    const onMv = (me) => seek(me.clientX);
    const onUp = () => {
      if (wasPlaying) videoRef.current?.play().catch(() => {});
      window.removeEventListener('pointermove', onMv);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMv);
    window.addEventListener('pointerup', onUp);
  };

  // frame capture → new image node
  const captureFrame = useCallback(async (frameType) => {
    if (!videoRef.current || !importedVideo) return;
    const v = videoRef.current;
    const draw = () => new Promise(resolve => {
      const c = document.createElement('canvas');
      c.width = v.videoWidth || 1280; c.height = v.videoHeight || 720;
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.toBlob(b => resolve({ blob: b, w: c.width, h: c.height }), 'image/png');
    });
    const seekDraw = (t) => new Promise(resolve => {
      const onS = async () => { v.removeEventListener('seeked', onS); resolve(await draw()); };
      v.addEventListener('seeked', onS);
      v.currentTime = t;
    });
    let res;
    if (frameType === 'first')      res = await seekDraw(0);
    else if (frameType === 'last')  res = await seekDraw(Math.max(0, (v.duration || 1) - 0.001));
    else                            res = await draw();
    const url = URL.createObjectURL(res.blob);
    const cur = getAbsoluteNodePosition();
    addNodes({
      id:   `img_frame_${Date.now()}`,
      type: 'AIImageNode',
      position: { x: cur.x + 460, y: cur.y },
      dragHandle: NODE_DRAG_HANDLE_SELECTOR,
      data: {
        capturedFrame: {
          src: url,
          width: res.w,
          height: res.h,
          name: `${frameType}-frame.png`,
          previewUpdatedAt: new Date().toISOString(),
        },
        uiDismissToken: uiDismissToken ?? 0,
      },
    });
    setShowCaptureMenu(false);
  }, [importedVideo, addNodes, getAbsoluteNodePosition, uiDismissToken]);

  // seek the visible video to a ratio [0-1] of total duration
  const seekPreview = useCallback((ratio) => {
    const v = videoRef.current;
    const dur = durationRef.current;
    if (!v || !dur || !isFinite(dur)) return;
    v.pause();
    v.currentTime = Math.max(0, Math.min(ratio * dur, dur));
  }, []);

  // filmstrip handle drag — also previews that frame in the video
  const startHandleDrag = useCallback((e, handle) => {
    e.preventDefault(); e.stopPropagation();
    draggingHandle.current = handle;
    const onMv = (me) => {
      if (!filmstripRef.current || !draggingHandle.current) return;
      const rect = filmstripRef.current.getBoundingClientRect();
      const r = Math.max(0, Math.min(1, (me.clientX - rect.left) / rect.width));
      if (draggingHandle.current === 'start') {
        const v = Math.min(r, clipStateRef.current.end - 0.04);
        clipStateRef.current.start = v; setClipStart(v);
        seekPreview(v);
      } else {
        const v = Math.max(r, clipStateRef.current.start + 0.04);
        clipStateRef.current.end = v; setClipEnd(v);
        seekPreview(v);
      }
    };
    const onUp = () => {
      draggingHandle.current = null;
      window.removeEventListener('pointermove', onMv);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMv);
    window.addEventListener('pointerup', onUp);
  }, [seekPreview]);

  // filmstrip middle-zone drag — moves the whole selection range
  const startMiddleDrag = useCallback((e) => {
    e.preventDefault(); e.stopPropagation();
    if (!filmstripRef.current) return;
    const startX   = e.clientX;
    const rect     = filmstripRef.current.getBoundingClientRect();
    const trackW   = rect.width;
    const initStart = clipStateRef.current.start;
    const initEnd   = clipStateRef.current.end;
    const span      = initEnd - initStart;
    // Preview at the start of the initial range
    seekPreview(initStart);
    const onMv = (me) => {
      const delta    = (me.clientX - startX) / trackW;
      const newStart = Math.max(0, Math.min(1 - span, initStart + delta));
      const newEnd   = newStart + span;
      clipStateRef.current.start = newStart;
      clipStateRef.current.end   = newEnd;
      setClipStart(newStart);
      setClipEnd(newEnd);
      seekPreview(newStart);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMv);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMv);
    window.addEventListener('pointerup', onUp);
  }, [seekPreview]);

  // confirm clip → trim → new video node + edge
  const handleConfirmClip = useCallback(async () => {
    if (!importedVideo || isTrimming || clipDuration < 0.1) return;
    setIsTrimming(true);
    try {
      const blob = await trimVideo(importedVideo.src, clipStart * duration, clipEnd * duration);
      const url  = URL.createObjectURL(blob);
      const cur  = getAbsoluteNodePosition();
      const newId = `video_clip_${Date.now()}`;
      addNodes({
        id:   newId,
        type: 'AIVideoNode',
        position: { x: cur.x + 460, y: cur.y },
        dragHandle: NODE_DRAG_HANDLE_SELECTOR,
        data: {
          videoMode: 'asset',
          capturedClip: {
            src: url,
            name: `clip_${(clipStart * duration).toFixed(2)}-${(clipEnd * duration).toFixed(2)}.webm`,
            duration: (clipEnd - clipStart) * duration,
            previewUpdatedAt: new Date().toISOString(),
          },
          uiDismissToken: uiDismissToken ?? 0,
        },
      });
      addEdges({
        id:           `e-clip-${nodeId}-${newId}`,
        source:       nodeId,
        target:       newId,
        sourceHandle: 'output',
        sourcePosition: Position.Right,
        targetHandle: 'input',
        targetPosition: Position.Left,
        selectable:   true,
        focusable:    true,
        style:        { stroke: '#a8afbb', strokeWidth: 1.8 },
      });
      setShowClipEditor(false);
    } catch (err) {
      console.error('Trim failed:', err);
    } finally {
      setIsTrimming(false);
    }
  }, [importedVideo, isTrimming, clipStart, clipEnd, clipDuration, duration, addNodes, addEdges, getAbsoluteNodePosition, nodeId, uiDismissToken]);

  // handle magnetism
  const handleNodeMouseMove = useCallback((ev) => {
    if (!nodeSurfaceRef.current) return;
    const rect = nodeSurfaceRef.current.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    const cy = rect.height / 2, lcx = -28, rcx = rect.width + 28;
    const mR = 180;
    const ld = Math.hypot(x - lcx, y - cy), rd = Math.hypot(x - rcx, y - cy);
    const lf = Math.max(0, 1 - ld / mR) * 0.75;
    const rf = Math.max(0, 1 - rd / mR) * 0.75;
    const mX = 24, mY = 18;
    lXRaw.set(Math.min(0, Math.max(-mX, (x - lcx) * lf)));
    lYRaw.set(Math.max(-mY, Math.min(mY, (y - cy) * lf)));
    rXRaw.set(Math.max(0, Math.min(mX, (x - rcx) * rf)));
    rYRaw.set(Math.max(-mY, Math.min(mY, (y - cy) * rf)));
  }, [lXRaw, lYRaw, rXRaw, rYRaw]);

  const handleNodeMouseLeave = useCallback(() => {
    setIsNodeHovering(false);
    setIsPreviewHovering(false);
    lXRaw.set(0); lYRaw.set(0); rXRaw.set(0); rYRaw.set(0);
  }, [lXRaw, lYRaw, rXRaw, rYRaw]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="relative w-[408px] text-[#E6E6E7]">
      <CrispZoomRoot>
      <input ref={videoFileInputRef} type="file" accept="video/*" className="hidden" onChange={handleVideoImport} />

      {/* Upload button */}
      {!hasVideo && (
        <div className="mb-[10px] flex justify-center">
          <button
            onClick={triggerImportVideo}
            onPointerDown={(e) => e.stopPropagation()}
            className="h-9 px-4 rounded-xl text-sm text-[#ECECEF] flex items-center gap-2 bg-[#1a1a1a] border border-white/10 hover:bg-[#252525] transition-colors"
          >
            <Upload size={16} />
            上传
          </button>
        </div>
      )}

      <div className="relative mx-auto w-[408px]">
        <div data-role="node-video-upper">
        <div className="mb-2 flex items-center justify-between gap-3 text-[#8C8F96]">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex items-center gap-1.5">
              <VideoIcon size={14} />
              <span className="text-sm leading-none">视频节点</span>
              <span className="text-xs leading-none">{videoNodeIndexLabel}</span>
            </div>
            <button
              type="button"
              className="nodrag inline-flex h-6 items-center gap-1 rounded-[8px] border border-white/[0.08] px-2 text-[11px] text-[#cfd3dc] transition-colors hover:border-white/[0.18] hover:bg-white/[0.06] hover:text-white"
              onClick={(event) => {
                event.stopPropagation();
                setShowGenerationInfo(true);
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Info size={12} />
              生成信息
            </button>
          </div>
          <span className="text-[11px] leading-none text-white/40">{currentVideoSizeLabel}</span>
        </div>

        <div
          className="relative node-drag-handle cursor-move"
          ref={nodeSurfaceRef}
          onPointerEnter={() => setIsNodeHovering(true)}
          onPointerMove={handleNodeMouseMove}
          onPointerLeave={handleNodeMouseLeave}
        >

          {/* ── Top toolbar (above preview) ───────────────────────────────── */}
          {hasVideo && showVideoTools && (
            <div
              ref={videoToolbarRef}
              data-role="node-image-toolbar"
              className="absolute left-1/2 z-30 h-10 rounded-xl border border-white/[0.05] bg-[#202020] px-2.5 flex items-center gap-0.5 shadow-xl whitespace-nowrap"
              style={{
                top: 'var(--node-top-toolbar-y, -82px)',
                transform: 'translateX(-50%) scale(var(--node-editor-scale, 1))',
                transformOrigin: 'bottom center',
                transition: 'top 120ms ease-out, transform 120ms ease-out',
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {/* 剪辑 — 与图片节点工具栏同一套底色与字色 */}
              <button
                ref={clipToolbarButtonRef}
                title="剪辑"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowClipEditor((wasOpen) => {
                    if (wasOpen) {
                      queueMicrotask(() => clipToolbarButtonRef.current?.blur());
                    }
                    return !wasOpen;
                  });
                }}
                className={`h-7 px-2 rounded-md inline-flex items-center gap-1.5 text-xs leading-none transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/25 ${
                  showClipEditor ? 'bg-white/15 text-white' : 'text-[#e4e7ee] hover:bg-white/10'
                }`}
              >
                <Scissors size={12} strokeWidth={2} />
                剪辑
              </button>
              <span className="mx-1 h-4 w-px bg-white/12" />
              <button
                title="放大查看"
                type="button"
                onClick={(e) => { e.stopPropagation(); setShowVideoPreviewModal(true); }}
                className="h-7 w-7 rounded-md text-[#d3d8e2] hover:bg-white/10 hover:text-white transition-colors flex items-center justify-center"
              >
                <Expand size={13} strokeWidth={2} />
              </button>
              <button
                title="下载"
                type="button"
                onClick={downloadImportedVideoFile}
                className="h-7 w-7 rounded-md text-[#d3d8e2] hover:bg-white/10 hover:text-white transition-colors flex items-center justify-center"
              >
                <Download size={13} strokeWidth={2} />
              </button>
              <button
                title="重新导入"
                type="button"
                onClick={(e) => { e.stopPropagation(); triggerImportVideo(e); }}
                className="h-7 w-7 rounded-md text-[#d3d8e2] hover:bg-white/10 hover:text-white transition-colors flex items-center justify-center"
              >
                <Upload size={13} strokeWidth={2} />
              </button>
            </div>
          )}

          {/* ── Video card ───────────────────────────────────────────────────── */}
          <div
            data-role="node-video-preview"
            className={`relative rounded-[18px] transition-all duration-[130ms] ease-out ${
              hasVideo ? 'bg-transparent border border-transparent' : 'bg-[#202020] p-6 border border-[#202020]'
            }`}
            style={{
              height: videoCardHeight,
              transform: isConnectionHoverTarget
                ? `perspective(1200px) rotateX(${resolvedConnectionHoverTilt.x}deg) rotateY(${resolvedConnectionHoverTilt.y}deg) scale3d(1.025, 1.025, 1.025)`
                : undefined,
              transformStyle: isConnectionHoverTarget ? 'preserve-3d' : undefined,
              willChange: isConnectionHoverTarget ? 'transform, box-shadow' : 'auto',
              boxShadow: isConnectionHoverTarget
                ? '0 0 0 1.5px rgba(255,255,255,0.58), 0 14px 28px rgba(255,255,255,0.08), 0 20px 42px rgba(76,125,214,0.2), inset 0 0 0 1px rgba(255,255,255,0.1)'
                : isNodeSelected && !isMaximizedView
                  ? '0 0 0 2px rgba(255,255,255,0.52)'
                  : undefined,
              transition: 'transform 120ms ease-out, box-shadow 120ms ease-out',
            }}
          >
            {isConnectionHoverTarget && <div className="connection-hover-glow" />}
            <div className={`h-full w-full overflow-hidden ${hasVideo ? 'rounded-[18px]' : 'rounded-[14px] bg-[#202020]'}`}>
              {hasVideo ? (
                <div
                  ref={videoSurfaceRef}
                  className="relative h-full w-full group"
                  onClick={() => setShowVideoTools(true)}
                  onPointerEnter={() => setIsPreviewHovering(true)}
                  onPointerLeave={() => setIsPreviewHovering(false)}
                >
                  <video
                    ref={videoRef}
                    src={importedVideo.src}
                    preload="metadata"
                    className={`h-full w-full object-cover transition-[filter,transform] duration-150 ease-out ${
                      videoGenerationActive
                        ? 'scale-[1.02] blur-[8px] brightness-[0.45] saturate-90'
                        : isConnectionHoverTarget
                          ? 'scale-[1.015] blur-[3px] brightness-75 saturate-90'
                          : ''
                    }`}
                    loop={!clipSegmentActive}
                    playsInline
                    muted={isMuted}
                    onPointerDown={onVideoSurfacePointerDown}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
                    onLoadedMetadata={() => {
                      const v = videoRef.current;
                      if (!v) return;
                      // MediaRecorder webm often reports Infinity; fall back to the value we passed via data
                      const d = isFinite(v.duration) && v.duration > 0
                        ? v.duration
                        : (data?.capturedClip?.duration || durationRef.current || 0);
                      setDuration(d);
                      durationRef.current = d;
                      setImportedVideo(prev => prev ? { ...prev, width: v.videoWidth || 1280, height: v.videoHeight || 720, duration: d } : null);
                    }}
                    draggable={false}
                  />

                  {/* ── Controls overlay ────────────────────────────────────── */}
                  <div className="absolute bottom-0 left-0 right-0 px-2.5 pt-8 pb-2.5 bg-gradient-to-t from-black/85 via-black/25 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none">
                    {/* Progress bar */}
                    <div
                      className="mb-2 pointer-events-auto"
                      onPointerDown={handleProgressPointerDown}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div ref={progressBarRef} className="relative h-[2px] bg-white/30 rounded-full cursor-pointer">
                        <div className="absolute left-0 top-0 bottom-0 bg-white rounded-full" style={{ width: `${progressPct}%` }} />
                        <div
                          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 bg-white rounded-full shadow"
                          style={{ left: `${progressPct}%` }}
                        />
                      </div>
                    </div>

                    {/* Controls row */}
                    <div
                      className="flex items-center gap-2 pointer-events-auto"
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={togglePlayPause}
                        className="text-white hover:text-white/70 transition-colors flex-shrink-0 p-0.5"
                      >
                        {isPlaying ? <Pause size={11} strokeWidth={2} /> : <Play size={11} strokeWidth={2} />}
                      </button>
                      <span className="text-white/80 text-[10px] tabular-nums leading-none">{fmt(currentTime)}</span>
                      <div className="flex-1" />
                      <span className="text-white/50 text-[10px] tabular-nums leading-none">{fmt(duration)}</span>
                      <button type="button" onClick={toggleMute} className="text-white/70 hover:text-white transition-colors p-0.5">
                        {isMuted ? <VolumeX size={11} strokeWidth={2} /> : <Volume2 size={11} strokeWidth={2} />}
                      </button>
                      {/* Frame capture */}
                      <div ref={captureMenuRef} className="relative">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setShowCaptureMenu(v => !v); }}
                          className="text-white/70 hover:text-white transition-colors p-0.5"
                        >
                          <Camera size={11} strokeWidth={2} />
                        </button>
                        {showCaptureMenu && (
                          <div className="absolute bottom-full right-0 mb-2 w-[128px] rounded-xl border border-white/[0.08] bg-[#1e1e22] shadow-xl overflow-hidden">
                            {[
                              { key: 'first',   label: '截取首帧' },
                              { key: 'last',    label: '截取尾帧' },
                              { key: 'current', label: '截取当前帧' },
                            ].map(({ key, label }) => (
                              <button
                                key={key}
                                onClick={(e) => { e.stopPropagation(); captureFrame(key); }}
                                className="w-full px-3 py-2.5 text-left text-xs text-[#d8dae2] hover:bg-white/10 transition-colors flex items-center gap-2"
                              >
                                <ImageIcon size={11} />
                                {label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="relative h-full w-full">
                  <div
                    className="absolute left-1/2 top-[44%] z-10 flex h-[44px] w-[44px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[8px] bg-white/[0.12] text-white/40"
                    onClick={triggerImportVideo}
                  >
                    <VideoIcon size={20} fill="currentColor" />
                  </div>
                  <div className="absolute left-2 top-1/2 max-w-[128px] -translate-y-1/2">
                    <p className="mb-3 text-sm leading-none text-[#A3A7AF]">尝试：</p>
                    <div className="space-y-3">
                      <button className="flex items-center gap-2.5 text-white transition-colors hover:text-white/80">
                        <Sparkles size={12} />
                        <span className="text-[13px] leading-none">首尾帧生成视频</span>
                      </button>
                      <button className="flex items-center gap-2.5 text-[#D8DAE0] transition-colors hover:text-white">
                        <Sparkles size={12} />
                        <span className="text-[13px] leading-none">首帧生成视频</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {videoGenerationActive && (
                <div
                  className={`absolute inset-0 z-20 flex items-center justify-center overflow-hidden [&>p]:hidden ${
                    hasVideo ? 'rounded-[18px]' : 'rounded-[14px]'
                  } bg-[#201b18]`}
                >
                  {videoGenerationBackdropAsset?.src && videoGenerationBackdropAsset?.kind === 'video' ? (
                    <video
                      src={videoGenerationBackdropAsset.src}
                      preload="metadata"
                      className="generation-breathing-backdrop absolute inset-0 h-full w-full scale-[1.04] object-cover blur-[12px] brightness-[0.42] saturate-90"
                      muted
                      playsInline
                      loop
                      autoPlay
                    />
                  ) : videoGenerationBackdropAsset?.src ? (
                    <img
                      src={videoGenerationBackdropAsset.src}
                      alt=""
                      loading="eager"
                      decoding="async"
                      className="generation-breathing-backdrop absolute inset-0 h-full w-full scale-[1.04] object-cover blur-[12px] brightness-[0.42] saturate-90"
                      draggable={false}
                    />
                  ) : null}
                  <div className="absolute inset-0 bg-black/28" />
                  <div
                    className="nodrag relative z-10 inline-flex items-center gap-3 rounded-[10px] border border-white/35 bg-[#211a16]/76 px-5 py-2 text-[15px] font-semibold text-white shadow-[0_10px_28px_rgba(0,0,0,0.35)] backdrop-blur-md"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <span>生成中</span>
                    <span className="loading-ellipsis" aria-hidden="true">
                      <span className="loading-ellipsis-dot" />
                      <span className="loading-ellipsis-dot" />
                      <span className="loading-ellipsis-dot" />
                    </span>
                    <button
                      type="button"
                      className="text-white/55 transition-colors hover:text-white"
                      onClick={handleCancelVisibleVideoGeneration}
                    >
                      取消
                    </button>
                  </div>
                  <p className="text-sm font-medium text-white/50">生成中...</p>
                </div>
              )}
            </div>
          </div>

          {/* + handles（素材类仅保留右侧输出，与图片节点一致） */}
          <MotionDiv
            className={`absolute -left-7 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-transparent border border-white/40 flex items-center justify-center text-[#B8BBC3] text-[11px] pointer-events-none transition-all duration-200 ease-out ${showInputHandleUi ? 'opacity-100' : 'opacity-0'}`}
            style={{ x: lX, y: lY, zIndex: 10 }}
          >
            <span className="leading-none relative -top-px">+</span>
          </MotionDiv>
          <MotionDiv
            className={`absolute -right-7 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-transparent border border-white/40 flex items-center justify-center text-[#B8BBC3] text-[11px] pointer-events-none transition-all duration-200 ease-out ${showHandleUi ? 'opacity-100' : 'opacity-0'}`}
            style={{ x: rX, y: rY, zIndex: 10 }}
          >
            <span className="leading-none relative -top-px">+</span>
          </MotionDiv>
          <Handle id="input" type="target" position={Position.Left} className={`node-handle-zone ${showInputHandleUi ? 'opacity-100' : 'opacity-0'}`} style={{ pointerEvents: showInputHandleUi ? 'auto' : 'none', zIndex: 20 }} />
          <Handle id="output" type="source" position={Position.Right} className={`node-handle-zone ${showHandleUi ? 'opacity-100' : 'opacity-0'}`} style={{ pointerEvents: showHandleUi ? 'auto' : 'none', zIndex: 20 }} />
        </div>
        </div>
      </div>

      {showGenerationDetailPanel && (
        <div
          data-role="node-detail-panel"
          title={isMaximizedView ? '双击可放大/缩小编辑区' : undefined}
          className="nodrag absolute left-1/2 z-10 flex min-h-[236px] w-[760px] flex-col rounded-[18px] border border-white/[0.05] bg-[#202020] px-4 pb-4 pt-3"
          style={{
            top: 'calc(100% + var(--node-bottom-panel-gap, 24px))',
            transform: isConnectionHoverTarget
              ? `translateX(-50%) perspective(1200px) rotateX(${resolvedConnectionHoverTilt.x}deg) rotateY(${resolvedConnectionHoverTilt.y}deg) scale(var(--node-editor-scale, 1)) scale(${detailPanelScale * 1.018})`
              : `translateX(-50%) scale(var(--node-editor-scale, 1)) scale(${detailPanelScale})`,
            transformOrigin: 'top center',
            transformStyle: isConnectionHoverTarget ? 'preserve-3d' : undefined,
            willChange: isConnectionHoverTarget ? 'transform, box-shadow' : 'auto',
            boxShadow: isConnectionHoverTarget
              ? '0 0 0 1.5px rgba(255,255,255,0.62), 0 16px 30px rgba(255,255,255,0.08), 0 24px 44px rgba(76,125,214,0.18), inset 0 0 0 1px rgba(255,255,255,0.12)'
              : undefined,
            transition: 'top 120ms ease-out, transform 120ms ease-out, box-shadow 120ms ease-out',
          }}
          onPointerDownCapture={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDownCapture={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (e.target.closest('textarea, input, select, button, a')) return;
            handleDetailPanelExpand(e);
          }}
        >
          {isConnectionHoverTarget && <div className="connection-hover-glow" />}
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
              {SEEDANCE_SCENARIOS.map((tab) => {
                const active = seedanceScenario === tab.id;
                const disabled = tab.id === 'text' && hasInputMediaRefs;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      if (disabled) return;
                      setSeedanceScenario(tab.id);
                      if (tab.id === 'first_frame' || tab.id === 'first_last_frame') {
                        setVideoGenMode('image');
                      }
                    }}
                    title={disabled ? '输入端已有素材时不可选择文生视频' : tab.hint}
                    className={`shrink-0 rounded-[10px] border px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                      disabled
                        ? 'cursor-not-allowed border-white/[0.05] bg-white/[0.02] text-white/25'
                        : active
                        ? 'border-[#8fb9ff] bg-[#8fb9ff]/12 text-white'
                        : 'border-white/[0.08] text-[#9ca2ac] hover:border-white/[0.16] hover:text-white'
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              title="放大输入"
              aria-pressed={maximizedDetailBoost}
              className={`rounded-md p-1 transition-colors hover:bg-white/[0.08] hover:text-white ${
                maximizedDetailBoost ? 'bg-white/[0.1] text-white' : 'text-[#8f949d]'
              }`}
              onClick={handleDetailPanelExpand}
            >
              <Expand size={15} />
            </button>
          </div>

          <div className="mb-3 flex min-h-[56px] items-start gap-3 overflow-hidden">
            <div className="flex shrink-0 items-center gap-3">
              {VIDEO_TOOL_ACTIONS.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="flex h-14 w-14 flex-col items-center justify-center rounded-[12px] border border-white/[0.08] bg-[#242424] text-[#c7ccd5] transition-colors hover:bg-white/[0.06] hover:text-white"
                >
                  <action.icon size={14} className="mb-1.5" />
                  <span className="text-[12px] leading-none">{action.label}</span>
                </button>
              ))}
            </div>
            <div className="min-w-0 flex-1 self-stretch">{renderInputImageRefs()}</div>
          </div>

          <div className="relative min-h-[86px] flex-1">
            {mentionMenu.open && filteredMentionItems.length && (
              <div
                data-mention-menu="true"
                className="absolute left-0 top-10 z-30 w-[240px] overflow-hidden rounded-[18px] border border-white/[0.08] bg-[#25262c] shadow-2xl"
              >
                <div className="max-h-[240px] overflow-y-auto bg-[#25262c] p-2">
                  {filteredMentionItems.map((item) => (
                    <button
                      key={item.token}
                      type="button"
                      className="mt-2 flex w-full items-center gap-3 rounded-[14px] border border-white/[0.06] bg-[#31343b] px-3 py-2.5 text-left transition-colors first:mt-0 hover:bg-[#3a3f49]"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insertMentionToken(item)}
                    >
                      {item.kind === 'video' ? (
                        <video
                          src={item.src}
                          preload="metadata"
                          muted
                          playsInline
                          className="h-10 w-10 shrink-0 rounded-[10px] object-cover"
                          draggable={false}
                        />
                      ) : (
                        <img
                          src={item.src}
                          alt={item.label}
                          loading="lazy"
                          decoding="async"
                          className="h-10 w-10 shrink-0 rounded-[10px] object-cover"
                          draggable={false}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] font-medium text-white">{item.label}</div>
                        <div className="text-[12px] text-[#9da3ad]">{`(${item.token})`}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {renderPromptMentionHighlight()}
            <textarea
              ref={textareaRef}
              value={videoPrompt}
              onChange={(event) => {
                const nextValue = event.target.value;
                const caret = event.target.selectionStart ?? nextValue.length;
                setVideoPrompt(nextValue);
                if (mentionTriggerRef.current || mentionMenu.open) {
                  syncMentionMenu(nextValue, caret);
                }
                mentionTriggerRef.current = false;
              }}
              onClick={() => {
                mentionTriggerRef.current = false;
                closeMentionMenu();
              }}
              onKeyDown={handlePromptKeyDown}
              rows={4}
              onScroll={syncPromptHighlightScroll}
              onWheelCapture={(e) => e.stopPropagation()}
              placeholder={
                videoGenMode === 'text'
                  ? '描述你想要生成的画面内容，@引用素材'
                  : '描述你想要生成的视频内容，支持结合@引用素材'
              }
              className="nodrag min-h-[86px] w-full flex-1 resize-none border-none bg-transparent px-0 py-0 text-[15px] leading-[1.6] text-[#E7E8EC] placeholder:text-[#7D8088] focus:outline-none"
              onPointerDownCapture={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDownCapture={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            />
          </div>

          <div className="mt-4 flex items-center justify-between text-[#D8DAE0]">
            <div className="flex items-center gap-4 text-[15px] leading-none">
              <div className="relative">
                <button
                  type="button"
                  data-video-model-trigger="true"
                  className="inline-flex items-center gap-2 rounded-[14px] border border-transparent bg-transparent px-0 text-white transition-colors hover:text-white/80"
                  onClick={(event) => {
                    event.stopPropagation();
                    setShowModelMenu((prev) => !prev);
                    setShowSpecMenu(false);
                  }}
                >
                  <Sparkles size={16} />
                  <span className="font-semibold">{currentVideoCapability.label}</span>
                  <ChevronDown size={13} className="text-[#80838C]" />
                </button>
                {showModelMenu && (
                  <div
                    data-video-model-panel="true"
                    className="absolute bottom-full left-0 z-30 mb-3 min-w-[220px] overflow-hidden rounded-[16px] border border-white/[0.05] bg-[#202020] p-2 shadow-2xl"
                  >
                    {videoModelOptions.map(({ id, label }) => {
                      const active = id === videoModel;
                      return (
                        <button
                          key={id}
                          type="button"
                          className={`flex w-full items-center justify-between rounded-[12px] px-3 py-2.5 text-left text-[13px] transition-colors ${
                            active
                              ? 'bg-white/[0.08] text-white'
                              : 'text-[#c7ccd5] hover:bg-white/[0.05] hover:text-white'
                          }`}
                          onClick={() => {
                            setVideoModel(id);
                            setShowModelMenu(false);
                          }}
                        >
                          <span>{label}</span>
                          {active ? <Check size={14} /> : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="relative">
                <button
                  type="button"
                  data-video-spec-trigger="true"
                  className={`inline-flex h-9 items-center gap-2 rounded-[12px] border px-3 text-white transition-colors ${
                    showSpecMenu
                      ? 'border-white/[0.22] bg-white/[0.08] shadow-[0_6px_16px_rgba(0,0,0,0.22)]'
                      : 'border-transparent bg-transparent shadow-none hover:bg-white/[0.06]'
                  }`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setShowSpecMenu((prev) => !prev);
                    setShowModelMenu(false);
                  }}
                >
                  <span className="inline-block h-3 w-5 rounded-[3px] border-2 border-[#d7dae2]" />
                  <span className="font-semibold">{videoRatio}</span>
                  <span className="text-[#8e949e]">•</span>
                  <span className="font-semibold">{videoResolution}</span>
                  <span className="text-[#8e949e]">•</span>
                  <span className="font-semibold">{videoDurationLabel}</span>
                  <span className="text-[#8e949e]">•</span>
                  <Volume2 size={15} className="text-[#d7dae2]" />
                  <ChevronDown size={13} className="text-[#9ca0aa]" />
                </button>
                {showSpecMenu && (
                  <div
                    data-video-spec-panel="true"
                    className="absolute bottom-full left-0 z-30 mb-3 w-[430px] rounded-[20px] border border-white/[0.08] bg-[#242424] p-4 shadow-[0_22px_58px_rgba(0,0,0,0.48)]"
                  >
                    <div className="mb-4">
                      <div className="mb-3 text-[15px] font-semibold text-[#9fa3aa]">比例</div>
                      <div className="grid grid-cols-5 gap-2">
                        {getAllowedVideoRatios(videoModel).map((item) => (
                          <button
                            key={item.label}
                            type="button"
                            className={`flex h-[76px] flex-col items-center justify-center gap-3 rounded-[12px] border text-[15px] font-semibold transition-colors ${
                              item.label === videoRatio
                                ? 'border-white bg-white/[0.12] text-white'
                                : 'border-white/[0.12] text-[#8f949d] hover:border-white/[0.22] hover:text-white'
                            }`}
                            onClick={() => setVideoRatio(item.label)}
                          >
                            <span className={`${RATIO_ICON_CLASS[item.label] || 'h-3 w-5'} rounded-[2px] border-2 border-current`} />
                            <span>{item.label === '自适应' ? 'Auto' : item.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="mb-4">
                      <div className="mb-3 text-[15px] font-semibold text-[#9fa3aa]">清晰度</div>
                      <div className="grid grid-cols-3 gap-2">
                        {currentVideoCapability.resolutions.map((item) => (
                          <button
                            key={item.label}
                            type="button"
                            className={`h-12 rounded-[12px] border text-[16px] font-semibold transition-colors ${
                              item.label === videoResolution
                                ? 'border-white bg-white/[0.12] text-white'
                                : 'border-white/[0.12] text-[#8f949d] hover:border-white/[0.22] hover:text-white'
                            }`}
                            onClick={() => setVideoResolution(item.label)}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="mb-4">
                      <div className="mb-3 text-[15px] font-semibold text-[#9fa3aa]">视频时长</div>
                      <div className="flex items-center gap-4">
                        <input
                          type="range"
                          min="4"
                          max="15"
                          step="1"
                          value={selectedDurationOption?.apiValue || 5}
                          onChange={(event) => setVideoDurationLabel(`${event.target.value}s`)}
                          className="nodrag h-2 flex-1 accent-[#36a3ff]"
                          onPointerDown={(e) => e.stopPropagation()}
                        />
                        <span className="w-8 text-right text-[15px] font-semibold text-[#aeb3bd]">{videoDurationLabel}</span>
                      </div>
                    </div>
                    <div>
                      <div className="mb-3 flex items-center gap-1.5 text-[15px] font-semibold text-[#9fa3aa]">
                        <span>生成音频</span>
                        <span className="flex h-4 w-4 items-center justify-center rounded-full border border-white/25 text-[10px] text-[#9fa3aa]">?</span>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="button"
                          className="h-12 rounded-[12px] border border-white bg-white/[0.12] text-[16px] font-semibold text-white"
                        >
                          开启
                        </button>
                        <button
                          type="button"
                          disabled
                          className="h-12 rounded-[12px] border border-white/[0.12] text-[16px] font-semibold text-[#777c85] opacity-70"
                        >
                          关闭
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={toggleMute}
                className="inline-flex items-center gap-1.5 text-[#d4d8df] transition-colors hover:text-white"
              >
                {isMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                <ChevronDown size={12} className="text-[#80838C]" />
              </button>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleTranslatePrompt}
                disabled={isTranslating || !videoPrompt.trim()}
                className="text-sm text-[#DADCE2] transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isTranslating ? '翻译中...' : '文A'}
              </button>
              <span className="text-[15px] text-[#DADCE2]">{generationReferenceCount}个</span>
              <button
                type="button"
                className="text-[#8f949d] transition-colors hover:text-white"
                onClick={() => setVideoPrompt('')}
                title="清空提示词"
              >
                <RotateCcw size={15} />
              </button>
              <button
                type="button"
                disabled={isGenerating}
                onClick={handleGenerateVideo}
                className={`rounded-[10px] text-[#17181B] flex items-center justify-center transition-colors ${
                  isGenerating
                    ? 'h-9 px-3 bg-[#9da1ab] cursor-not-allowed'
                    : 'w-9 h-9 bg-[#8C8F96] hover:bg-[#9A9EA6]'
                }`}
              >
                {isGenerating ? (
                  <span className="text-[12px] font-semibold">生成中...</span>
                ) : (
                  <MoveUp size={16} />
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPromptModal &&
        createPortal(
          <div
            className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 backdrop-blur-[1px]"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                closeMentionMenu();
                setShowPromptModal(false);
              }
            }}
          >
            <div
              className="nodrag flex aspect-[16/9] w-[min(60vw,calc(57vh*16/9))] flex-col rounded-2xl border border-white/[0.05] bg-[#202020] p-6 text-[#DADCE2]"
              onPointerDownCapture={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDownCapture={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
            >
            <div className="mb-4 flex items-center justify-between">
              <span className="text-base font-medium leading-none text-[#DADCE2]">放大输入</span>
              <button
                type="button"
                onClick={() => {
                  closeMentionMenu();
                  setShowPromptModal(false);
                }}
                className="text-sm text-[#A3A8B1] transition-colors hover:text-white"
              >
                关闭
              </button>
            </div>

            <div className="mb-4 flex h-[68px] shrink-0 items-center gap-3 overflow-hidden">
              <div className="flex shrink-0 items-center gap-2">
                {VIDEO_TOOL_ACTIONS.map((action) => (
                  <button
                    key={`modal-${action.id}`}
                    type="button"
                    className="flex h-[58px] w-[78px] flex-col items-center justify-center rounded-[14px] border border-white/[0.08] bg-white/[0.03] text-[#D6DAE2] transition-colors hover:bg-white/[0.06] hover:text-white"
                  >
                    <action.icon size={16} className="mb-1 text-[#AEB4BF]" />
                    <span className="text-[12px] leading-none">{action.label}</span>
                  </button>
                ))}
              </div>
              <div className="min-w-0 flex-1 self-stretch">
                {renderInputImageRefs({
                  scrollerRef: null,
                  sizeClass: 'h-16 w-16',
                })}
              </div>
            </div>

            <div className="relative min-h-0 flex-1">
              {mentionMenu.open && filteredMentionItems.length && (
                <div
                  data-mention-menu="true"
                  className="absolute left-0 top-10 z-30 w-[240px] overflow-hidden rounded-[18px] border border-white/[0.08] bg-[#25262c] shadow-2xl"
                >
                  <div className="max-h-[240px] overflow-y-auto bg-[#25262c] p-2">
                    {filteredMentionItems.map((item) => (
                      <button
                        key={`modal-${item.token}`}
                        type="button"
                        className="mt-2 flex w-full items-center gap-3 rounded-[14px] border border-white/[0.06] bg-[#31343b] px-3 py-2.5 text-left transition-colors first:mt-0 hover:bg-[#3a3f49]"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => insertMentionToken(item)}
                      >
                        {item.kind === 'video' ? (
                          <video
                            src={item.src}
                            preload="metadata"
                            muted
                            playsInline
                            className="h-10 w-10 shrink-0 rounded-[10px] object-cover"
                            draggable={false}
                          />
                        ) : (
                          <img
                            src={item.src}
                            alt={item.label}
                            loading="lazy"
                            decoding="async"
                            className="h-10 w-10 shrink-0 rounded-[10px] object-cover"
                            draggable={false}
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[14px] font-medium text-white">{item.label}</div>
                          <div className="text-[12px] text-[#9da3ad]">{`(${item.token})`}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {renderPromptMentionHighlight('px-0 py-0 text-[17px] leading-[1.7]')}
              <textarea
                ref={modalTextareaRef}
                value={videoPrompt}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  const caret = event.target.selectionStart ?? nextValue.length;
                  setVideoPrompt(nextValue);
                  if (mentionTriggerRef.current || mentionMenu.open) {
                    syncMentionMenu(nextValue, caret);
                  }
                  mentionTriggerRef.current = false;
                }}
                onClick={() => {
                  mentionTriggerRef.current = false;
                  closeMentionMenu();
                }}
                onKeyDown={handlePromptKeyDown}
                rows={10}
                onScroll={syncPromptHighlightScroll}
                onWheelCapture={(e) => e.stopPropagation()}
                placeholder={
                  videoGenMode === 'text'
                    ? '描述你想要生成的画面内容，@引用素材'
                    : '描述你想要生成的视频内容，支持结合@引用素材'
                }
                className="nodrag h-full min-h-0 w-full resize-none border-none bg-transparent px-0 py-0 text-[17px] leading-[1.7] text-[#E7E8EC] placeholder:text-[#7D8088] focus:outline-none"
              />
            </div>

            <div className="mt-5 flex shrink-0 items-center justify-between border-t border-white/[0.06] pt-4 text-[#D8DAE0]">
              <div className="flex items-center gap-5 text-[17px] leading-none">
                <div className="relative">
                  <button
                    type="button"
                    data-video-model-trigger="true"
                    className="inline-flex h-11 items-center gap-2 rounded-[14px] border border-transparent bg-transparent px-0 text-white transition-colors hover:text-white/80"
                    onClick={(event) => {
                      event.stopPropagation();
                      setShowModelMenu((prev) => !prev);
                      setShowSpecMenu(false);
                    }}
                  >
                    <Sparkles size={17} />
                    <span className="font-semibold">{currentVideoCapability.label}</span>
                    <ChevronDown size={14} className="text-[#80838C]" />
                  </button>
                  {showModelMenu && (
                    <div
                      data-video-model-panel="true"
                      className="absolute bottom-full left-0 z-30 mb-3 min-w-[220px] overflow-hidden rounded-[16px] border border-white/[0.05] bg-[#202020] p-2 shadow-2xl"
                    >
                      {videoModelOptions.map(({ id, label }) => {
                        const active = id === videoModel;
                        return (
                          <button
                            key={`modal-${id}`}
                            type="button"
                            className={`flex w-full items-center justify-between rounded-[12px] px-3 py-2.5 text-left text-[13px] transition-colors ${
                              active
                                ? 'bg-white/[0.08] text-white'
                                : 'text-[#c7ccd5] hover:bg-white/[0.05] hover:text-white'
                            }`}
                            onClick={() => {
                              setVideoModel(id);
                              setShowModelMenu(false);
                            }}
                          >
                            <span>{label}</span>
                            {active ? <Check size={14} /> : null}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="relative">
                  <button
                    type="button"
                    data-video-spec-trigger="true"
                    className={`inline-flex h-11 items-center gap-2 rounded-[14px] border px-3 text-white transition-colors ${
                      showSpecMenu
                        ? 'border-white/[0.22] bg-white/[0.08] shadow-[0_6px_16px_rgba(0,0,0,0.22)]'
                        : 'border-transparent bg-transparent shadow-none hover:bg-white/[0.06]'
                    }`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setShowSpecMenu((prev) => !prev);
                      setShowModelMenu(false);
                    }}
                  >
                    <span className="inline-block h-3 w-5 rounded-[3px] border-2 border-[#d7dae2]" />
                    <span className="font-semibold">{videoRatio}</span>
                    <span className="text-[#8e949e]">•</span>
                    <span className="font-semibold">{videoResolution}</span>
                    <span className="text-[#8e949e]">•</span>
                    <span className="font-semibold">{videoDurationLabel}</span>
                    <ChevronDown size={14} className="text-[#9ca0aa]" />
                  </button>
                  {showSpecMenu && (
                    <div
                      data-video-spec-panel="true"
                      className="absolute bottom-full left-0 z-30 mb-3 w-[430px] rounded-[20px] border border-white/[0.08] bg-[#242424] p-4 shadow-[0_22px_58px_rgba(0,0,0,0.48)]"
                    >
                      <div className="mb-4">
                        <div className="mb-3 text-[15px] font-semibold text-[#9fa3aa]">比例</div>
                        <div className="grid grid-cols-5 gap-2">
                          {getAllowedVideoRatios(videoModel).map((item) => (
                            <button
                              key={`modal-ratio-${item.label}`}
                              type="button"
                              className={`flex h-[76px] flex-col items-center justify-center gap-3 rounded-[12px] border text-[15px] font-semibold transition-colors ${
                                item.label === videoRatio
                                  ? 'border-white bg-white/[0.12] text-white'
                                  : 'border-white/[0.12] text-[#8f949d] hover:border-white/[0.22] hover:text-white'
                              }`}
                              onClick={() => setVideoRatio(item.label)}
                            >
                              <span className={`${RATIO_ICON_CLASS[item.label] || 'h-3 w-5'} rounded-[2px] border-2 border-current`} />
                              <span>{item.label === '自适应' ? 'Auto' : item.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="mb-4">
                        <div className="mb-3 text-[15px] font-semibold text-[#9fa3aa]">清晰度</div>
                        <div className="grid grid-cols-3 gap-2">
                          {currentVideoCapability.resolutions.map((item) => (
                            <button
                              key={`modal-resolution-${item.label}`}
                              type="button"
                              className={`h-12 rounded-[12px] border text-[16px] font-semibold transition-colors ${
                                item.label === videoResolution
                                  ? 'border-white bg-white/[0.12] text-white'
                                  : 'border-white/[0.12] text-[#8f949d] hover:border-white/[0.22] hover:text-white'
                              }`}
                              onClick={() => setVideoResolution(item.label)}
                            >
                              {item.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="mb-3 text-[15px] font-semibold text-[#9fa3aa]">视频时长</div>
                        <div className="flex items-center gap-4">
                          <input
                            type="range"
                            min="4"
                            max="15"
                            step="1"
                            value={selectedDurationOption?.apiValue || 5}
                            onChange={(event) => setVideoDurationLabel(`${event.target.value}s`)}
                            className="nodrag h-2 flex-1 accent-[#36a3ff]"
                            onPointerDown={(e) => e.stopPropagation()}
                          />
                          <span className="w-8 text-right text-[15px] font-semibold text-[#aeb3bd]">{videoDurationLabel}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={handleTranslatePrompt}
                  disabled={isTranslating || !videoPrompt.trim()}
                  className="text-base text-[#DADCE2] transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isTranslating ? '翻译中...' : '文A'}
                </button>
                <span className="text-base text-[#DADCE2]">{generationReferenceCount}个</span>
                <button
                  type="button"
                  className="text-[#8f949d] transition-colors hover:text-white"
                  onClick={() => setVideoPrompt('')}
                  title="清空提示词"
                >
                  <RotateCcw size={16} />
                </button>
                <button
                  type="button"
                  disabled={isGenerating}
                  onClick={handleGenerateVideo}
                  className={`rounded-[10px] text-[#17181B] flex items-center justify-center transition-colors ${
                    isGenerating
                      ? 'h-10 px-4 bg-[#9da1ab] cursor-not-allowed'
                      : 'h-10 w-10 bg-[#8C8F96] hover:bg-[#9A9EA6]'
                  }`}
                >
                  {isGenerating ? (
                    <span className="text-sm font-semibold">生成中...</span>
                  ) : (
                    <MoveUp size={16} />
                  )}
                </button>
              </div>
            </div>
          </div>
          </div>,
          document.body
        )}

      {/* ── Clip editor ──────────────────────────────────────────────────────── */}
      {showClipEditor && hasVideo && (
        <div
          className={`absolute left-1/2 top-full z-20 w-[540px] -translate-x-1/2 rounded-[18px] border border-white/[0.07] bg-[#18181b] px-3 py-3 shadow-2xl ${
            showGenerationDetailPanel ? 'mt-[252px]' : 'mt-3'
          } flex items-center gap-2.5`}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* Close */}
          <button
            onClick={() => setShowClipEditor(false)}
            className="flex-shrink-0 w-8 h-8 rounded-xl bg-white/[0.06] hover:bg-white/10 text-[#9da2af] hover:text-white flex items-center justify-center transition-colors"
          >
            <X size={13} />
          </button>

          {/* Filmstrip + range selector */}
          {/* Outer wrapper: relative, no overflow-hidden so handles can bleed slightly */}
          <div ref={filmstripRef} className="relative flex-1 h-12">
            {/* Inner: thumbnails + overlays, overflow-hidden for rounded clip */}
            <div className="absolute inset-0 rounded-lg overflow-hidden bg-[#2c2c30]">
              {/* Thumbnail strip */}
              <div className="absolute inset-0 flex">
                {thumbnails.length > 0
                  ? thumbnails.map((t, i) => (
                      <img key={i} src={t} alt="" loading="lazy" decoding="async" className="flex-1 h-full object-cover" draggable={false} />
                    ))
                  : Array.from({ length: 16 }).map((_, i) => (
                      <div key={i} className="flex-1 h-full bg-white/[0.03]" />
                    ))
                }
              </div>
              {/* Left dark overlay */}
              <div className="absolute inset-y-0 left-0 bg-black/60 pointer-events-none" style={{ width: `${clipStart * 100}%` }} />
              {/* Right dark overlay */}
              <div className="absolute inset-y-0 right-0 bg-black/60 pointer-events-none" style={{ width: `${(1 - clipEnd) * 100}%` }} />
              {/* Selection border */}
              <div
                className="absolute inset-y-0 border-[2px] border-white rounded-lg pointer-events-none"
                style={{ left: `${clipStart * 100}%`, right: `${(1 - clipEnd) * 100}%` }}
              />
              {/* Duration label */}
              <div
                className="absolute inset-y-0 flex items-center justify-center pointer-events-none"
                style={{ left: `${clipStart * 100}%`, right: `${(1 - clipEnd) * 100}%` }}
              >
                {(clipEnd - clipStart) > 0.12 && (
                  <span className="text-white text-[11px] font-semibold tabular-nums select-none drop-shadow">
                    {clipDuration.toFixed(2)} s
                  </span>
                )}
              </div>
            </div>

            {/* Middle drag zone — moves the whole selection */}
            <div
              className="absolute inset-y-0 z-[6] cursor-grab active:cursor-grabbing"
              style={{
                left:  `calc(${clipStart * 100}% + 12px)`,
                right: `calc(${(1 - clipEnd) * 100}% + 12px)`,
              }}
              onPointerDown={startMiddleDrag}
            />

            {/* Start handle (outside overflow-hidden parent) */}
            <div
              className="absolute inset-y-0 w-5 flex items-center justify-center cursor-ew-resize z-10 -translate-x-1/2"
              style={{ left: `${clipStart * 100}%` }}
              onPointerDown={(e) => startHandleDrag(e, 'start')}
            >
              <div className="w-[5px] h-8 bg-white rounded-full shadow-md" />
            </div>

            {/* End handle */}
            <div
              className="absolute inset-y-0 w-5 flex items-center justify-center cursor-ew-resize z-10 -translate-x-1/2"
              style={{ left: `${clipEnd * 100}%` }}
              onPointerDown={(e) => startHandleDrag(e, 'end')}
            >
              <div className="w-[5px] h-8 bg-white rounded-full shadow-md" />
            </div>
          </div>

          {/* Confirm */}
          <button
            onClick={handleConfirmClip}
            disabled={isTrimming || clipDuration < 0.1}
            className="flex-shrink-0 w-10 h-10 rounded-xl bg-white text-[#17181B] hover:bg-white/90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors shadow-lg"
          >
            {isTrimming
              ? <Loader2 size={16} className="animate-spin text-[#17181B]" />
              : <Check size={16} />
            }
          </button>
        </div>
      )}

      {showSubjectMenu && createPortal(
        <div
          className="fixed inset-0 z-[85] flex items-center justify-center bg-black/68 backdrop-blur-[1px]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowSubjectMenu(false);
          }}
        >
          <div
            data-video-subject-panel="true"
            className="flex h-[min(82vh,720px)] w-[min(92vw,980px)] flex-col overflow-hidden rounded-[22px] border border-white/[0.06] bg-[#18181b] shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/[0.08] px-6 py-5">
              <div>
                <div className="text-[16px] font-semibold text-white">角色主体库</div>
                <div className="mt-1 text-[12px] text-white/42">
                  上传本地角色图后可常驻保存、改名；拿到官方审核通过的主体 ID 后填入，即可作为 Seedance 主体调用。
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSubjectMenu(false)}
                className="rounded-xl p-2 text-white/45 transition-colors hover:bg-white/8 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex items-center gap-3 border-b border-white/[0.08] px-6 py-4">
              <button
                type="button"
                onClick={() => subjectFileInputRef.current?.click()}
                disabled={subjectUploadPending}
                className="rounded-[12px] bg-white px-4 py-2 text-[13px] font-medium text-[#17181B] transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {subjectUploadPending ? '上传中...' : '上传本地主体图'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedSubjectId('');
                  setShowSubjectMenu(false);
                }}
                className="rounded-[12px] border border-white/[0.08] px-4 py-2 text-[13px] text-white/78 transition-colors hover:border-white/[0.16] hover:text-white"
              >
                不使用主体
              </button>
              {subjectsLoading ? <span className="text-[12px] text-white/42">主体库加载中...</span> : null}
              {subjectsError ? <span className="text-[12px] text-[#ffb4b4]">{subjectsError}</span> : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {seedanceSubjects.length ? (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {seedanceSubjects.map((item) => {
                    const draft = subjectDrafts[item.id] || { name: item.name || '', subjectId: item.subjectId || '' };
                    const approved = Boolean(String(draft.subjectId || item.subjectId || '').trim()) || item.status === 'approved';
                    const selectedSubjectCard = item.id === selectedSubjectId;
                    return (
                      <div
                        key={item.id}
                        className={`rounded-[18px] border p-4 ${
                          selectedSubjectCard ? 'border-white/[0.22] bg-white/[0.04]' : 'border-white/[0.06] bg-[#202020]'
                        }`}
                      >
                        <div className="flex gap-4">
                          <div className="h-[108px] w-[108px] shrink-0 overflow-hidden rounded-[14px] bg-[#111]">
                            {item.coverUrl || item.referenceImageUrl ? (
                              <img
                                src={item.coverUrl || item.referenceImageUrl}
                                alt={item.name}
                                loading="lazy"
                                decoding="async"
                                className="h-full w-full object-cover"
                                draggable={false}
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-white/22">
                                <Tags size={24} />
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <span className={`rounded-full px-2 py-1 text-[11px] ${
                                approved ? 'bg-[#214126] text-[#b6efc0]' : 'bg-white/[0.06] text-white/52'
                              }`}>
                                {approved ? '已可调用' : '待填写审核通过 ID'}
                              </span>
                              {selectedSubjectCard ? <span className="text-[11px] text-[#8fb9ff]">当前已选</span> : null}
                            </div>
                            <input
                              value={draft.name}
                              onChange={(event) => handleSubjectDraftChange(item.id, { name: event.target.value })}
                              className="mb-2 h-9 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-3 text-[13px] text-white placeholder:text-white/28 focus:outline-none"
                              placeholder="角色名称"
                            />
                            <input
                              value={draft.subjectId}
                              onChange={(event) => handleSubjectDraftChange(item.id, { subjectId: event.target.value })}
                              className="mb-2 h-9 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-3 text-[12px] text-white placeholder:text-white/28 focus:outline-none"
                              placeholder="审核通过后的主体 ID（可选）"
                            />
                            <div className="line-clamp-2 text-[11px] leading-[1.5] text-white/38">
                              {item.summary || '上传本地图后会常驻在这里。拿到官方审核通过主体 ID 后填进上面这一栏，就会按 Seedance 主体调用。'}
                            </div>
                          </div>
                        </div>
                        <div className="mt-4 flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => handleSaveSubjectDraft(item.id)}
                            disabled={subjectSavingId === item.id}
                            className="rounded-[10px] border border-white/[0.08] px-3 py-2 text-[12px] text-white/78 transition-colors hover:border-white/[0.16] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {subjectSavingId === item.id ? '保存中...' : '保存名称'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (!approved) return;
                              setSelectedSubjectId(item.id);
                              setShowSubjectMenu(false);
                            }}
                            disabled={!approved}
                            className={`rounded-[10px] px-3 py-2 text-[12px] transition-colors ${
                              approved
                                ? 'bg-white text-[#17181B] hover:bg-white/90'
                                : 'cursor-not-allowed bg-white/[0.08] text-white/28'
                            }`}
                          >
                            设为当前主体
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="py-16 text-center text-sm text-white/38">
                  还没有角色主体。点击上方“上传本地主体图”后，它会一直保存在这里。
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Video preview modal ───────────────────────────────────────────────── */}
      {showVideoPreviewModal && importedVideo && createPortal(
        <div
          className="fixed inset-0 z-[80] bg-black/75 backdrop-blur-[1px] flex items-center justify-center"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setShowVideoPreviewModal(false); }}
        >
          <div className="relative w-[min(92vw,1200px)] h-[min(88vh,860px)]">
            <button
              type="button"
              className="absolute right-3 top-3 z-10 rounded-md border border-white/15 bg-black/45 px-2 py-1 text-xs text-[#d7dae2] hover:text-white hover:bg-black/60 transition-colors"
              onClick={() => setShowVideoPreviewModal(false)}
            >
              关闭
            </button>
            <video src={importedVideo.src} className="h-full w-full object-contain" controls autoPlay preload="metadata" />
          </div>
        </div>,
        document.body
      )}

      {showGenerationInfo && createPortal(
        <div
          className="fixed inset-0 z-[230] flex items-center justify-center bg-black/72 backdrop-blur-[2px]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowGenerationInfo(false);
          }}
        >
          <div
            className="nodrag flex h-[min(72vh,620px)] w-[min(88vw,860px)] flex-col rounded-[20px] border border-white/[0.08] bg-[#202020] shadow-[0_28px_80px_rgba(0,0,0,0.58)]"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/[0.07] px-6 py-4">
              <div className="flex items-center gap-2 text-white">
                <Info size={16} />
                <span className="text-[16px] font-semibold">生成信息</span>
              </div>
              <button
                type="button"
                onClick={() => setShowGenerationInfo(false)}
                className="rounded-xl p-2 text-white/45 transition-colors hover:bg-white/8 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <div className="mb-5 rounded-[14px] border border-white/[0.08] bg-[#181818] px-4 py-3">
                <div className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 text-[14px] leading-6">
                  <div className="font-semibold text-white/42">提交时间</div>
                  <div className="text-[#e7e9ef]">{generationInfoSubmittedTime || '暂无记录'}</div>
                  <div className="font-semibold text-white/42">完成时间</div>
                  <div className="text-[#e7e9ef]">{generationInfoCompletedTime || '暂无记录'}</div>
                  <div className="font-semibold text-white/42">生成耗时</div>
                  <div className="text-[#e7e9ef]">{generationInfoDuration || '暂无记录'}</div>
                </div>
              </div>
              <div className="mb-3 text-[12px] font-semibold text-white/42">描述词</div>
              <div className="min-h-[220px] whitespace-pre-wrap rounded-[14px] border border-white/[0.08] bg-[#181818] px-4 py-4 text-[15px] leading-7 text-[#e7e9ef]">
                {generationInfoPrompt || '暂无生成描述词'}
              </div>
            </div>
            <div className="border-t border-white/[0.07] px-6 py-3 text-[12px] text-white/35">
              按 Esc 退出
            </div>
          </div>
        </div>,
        document.body
      )}
      </CrispZoomRoot>
    </div>
  );
};

export default memo(AIVideoNode);
