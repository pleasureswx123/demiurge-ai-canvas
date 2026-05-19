import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position, useNodeId, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import { motion, useMotionValue, useSpring } from 'framer-motion';
import {
  getMentionDeletionRange,
  getMentionCaretNavigationTarget,
  protectImageMentionTokens,
  restoreImageMentionTokens,
} from '../../utils/mentionTokens';
import CrispZoomRoot from '../../components/CrispZoomRoot';
import { useCanvasUi } from '../../store/CanvasUiContext';
import { useNodeUiState } from '../../store/NodeUiStore';
import { useConnectionHoverForNode } from '../../store/ConnectionHoverStore';
import { cancelGenerationForNode, registerGenerationCancel } from '../../store/GenerationCancelStore';
import { useProjectWorkspace } from '../../store/ProjectWorkspaceContext';
import { mediaApi, nodeApi } from '../../api/routes';
import {
  getAllowedRatios,
  getAllowedSizes,
  getDefaultRatio,
  getDefaultSize,
  getImageModelConfig,
  getInitialImageNodeGenerationState,
  imageModelOptions,
  mapUiSizeToApiSize,
  ratioOptions,
  setPreferredImageGenerationModel,
} from '../generation/imageGenerationConfig';
import {
  ChevronDown,
  Crop,
  Download,
  Eraser,
  Expand,
  Focus,
  Image as ImageIcon,
  ImagePlus,
  Info,
  Maximize,
  MoveUp,
  Pencil,
  RotateCcw,
  Scissors,
  Square,
  Sparkles,
  Tags,
  Type,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
const NODE_DRAG_HANDLE_SELECTOR = '.node-drag-handle';

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

/**
 * 默认走相对路径 `/api/media/generate-image`，由 Vite 代理到 Python（与视频节点一致），避免跨域与自定义头 CORS 问题。
 * 若需直连（例如无 Vite），可在 `.env.local` 设置 `VITE_IMAGE_SERVICE_ORIGIN=http://127.0.0.1:3300`。
 */
function getImageGenerateApiUrl() {
  const raw = String(import.meta.env.VITE_IMAGE_SERVICE_ORIGIN || '').trim();
  const origin = raw.replace(/\/$/, '');
  if (origin) return `${origin}/api/media/generate-image`;
  return mediaApi('/generate-image');
}

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

/** Same horizontal step as canvas import / L-key (408 + 40) */
const CROP_NEW_NODE_OFFSET_X = 408 + 40;

/** Normalized crop box (0-1) with max area for target pixel aspect R = width/height */
function maxCropBoxForTargetPixelAspect(imageW, imageH, targetRWoverH) {
  const ar = imageW / imageH;
  const k = targetRWoverH / ar;
  let w;
  let h;
  if (k >= 1) {
    h = Math.min(1, 1 / k);
    w = k * h;
  } else {
    w = Math.min(1, k);
    h = w / k;
  }
  const x = (1 - w) / 2;
  const y = (1 - h) / 2;
  return { x, y, w, h };
}

const CROP_ASPECT_PRESETS = [
  { id: 'original', label: '原图比例', R: null },
  { id: '1:1', label: '1:1', R: 1 },
  { id: '4:3', label: '4:3', R: 4 / 3 },
  { id: '3:4', label: '3:4', R: 3 / 4 },
  { id: '16:9', label: '16:9', R: 16 / 9 },
  { id: '9:16', label: '9:16', R: 9 / 16 },
];

const ANNOTATION_COLOR_OPTIONS = ['#ff3b30', '#ffffff', '#ffd60a', '#34c759', '#0a84ff', '#bf5af2'];
const ANNOTATION_TOOL_OPTIONS = [
  { id: 'brush', label: '画笔', Icon: Pencil },
  { id: 'rect', label: '方形选区', Icon: Square },
  { id: 'text', label: '文字', Icon: Type },
];

const AIImageNode = ({ data, selected = false }) => {
  const { slug: projectSlug } = useProjectWorkspace();
  const nodeId = useNodeId();
  const { addNodes, addEdges, getNode, getInternalNode, updateNodeData, setEdges, setNodes } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const {
    persistNodeData,
    onRequestSaveToMaterial,
    saveSnapshot,
  } = useCanvasUi();
  const {
    uiDismissToken,
    isSingleSelected,
    isFocused,
    isMaximizedView,
  } = useNodeUiState(nodeId);
  const imageFileInputRef = useRef(null);
  const imageObjectUrlRef = useRef(null);
  const imageToolbarRef = useRef(null);
  const imageSurfaceRef = useRef(null);
  const inlineTextareaRef = useRef(null);
  const modalTextareaRef = useRef(null);
  const inlineHighlightRef = useRef(null);
  const modalHighlightRef = useRef(null);
  const inlineRefsScrollerRef = useRef(null);
  const modalRefsScrollerRef = useRef(null);
  const initialImageGenRef = useRef(null);
  const readInitialImageGen = () => {
    if (!initialImageGenRef.current) {
      initialImageGenRef.current = getInitialImageNodeGenerationState(data, projectSlug);
    }
    return initialImageGenRef.current;
  };
  const [prompt, setPrompt] = useState(data?.generationPrompt || '');
  const [lastGenerationPrompt, setLastGenerationPrompt] = useState(
    data?.lastGenerationPrompt || data?.generationPrompt || ''
  );
  const [lastGenerationSubmittedAt, setLastGenerationSubmittedAt] = useState(
    data?.lastGenerationSubmittedAt || data?.lastGenerationStartedAt || ''
  );
  const [lastGenerationCompletedAt, setLastGenerationCompletedAt] = useState(
    data?.lastGenerationCompletedAt || data?.lastGenerationAt || data?.generationTime || ''
  );
  const [isTranslating, setIsTranslating] = useState(false);
  const [selectedModel, setSelectedModel] = useState(() => readInitialImageGen().model);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [ratio, setRatio] = useState(() => readInitialImageGen().ratio);
  const [size, setSize] = useState(() => readInitialImageGen().size);
  const [selectedReferenceTokens, setSelectedReferenceTokens] = useState([]);
  const [showPresetMenu, setShowPresetMenu] = useState(false);
  const [presetMenuVisible, setPresetMenuVisible] = useState(false);
  const [renderPresetMenu, setRenderPresetMenu] = useState(false);
  const [showPromptModal, setShowPromptModal] = useState(false);
  const [showImagePreviewModal, setShowImagePreviewModal] = useState(false);
  const [showAnnotationModal, setShowAnnotationModal] = useState(false);
  const [showGenerationInfo, setShowGenerationInfo] = useState(false);
  const [showImageTools, setShowImageTools] = useState(false);
  const [nodeContextMenu, setNodeContextMenu] = useState(null);
  const [seedanceFaceReview, setSeedanceFaceReview] = useState(
    data?.seedanceFaceReview ||
      data?.imageAsset?.seedanceFaceReview ||
      data?.capturedFrame?.seedanceFaceReview ||
      null
  );
  const [seedanceFaceReviewPending, setSeedanceFaceReviewPending] = useState(false);
  // Load image state from the persisted asset first, while still keeping
  // backward compatibility with older nodes that only stored capturedFrame.
  // Use a ref so the initial value is read only once (avoids reset on data re-renders).
  const initialFrameRef = useRef(data?.imageAsset ?? data?.capturedFrame ?? null);
  const initialImageModeRef = useRef(
    data?.imageMode || (data?.imageAsset || data?.capturedFrame ? 'asset' : 'generated')
  );
  const [importedImage, setImportedImage] = useState(initialFrameRef.current);
  const [imageMode, setImageMode] = useState(initialImageModeRef.current);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const inlineSizeTriggerRef = useRef(null);
  const modalSizeTriggerRef = useRef(null);
  const nodeSurfaceRef = useRef(null);
  const [presetMenuMode, setPresetMenuMode] = useState('inline');
  const [presetPanelPosition, setPresetPanelPosition] = useState({ left: 16, top: 16 });
  const [isNodeHovering, setIsNodeHovering] = useState(false);
  const [handleFx, setHandleFx] = useState({
    leftActive: false,
    rightActive: false,
  });
  const springConfig = { stiffness: 520, damping: 18, mass: 0.38 };
  const leftXRaw = useMotionValue(0);
  const leftYRaw = useMotionValue(0);
  const rightXRaw = useMotionValue(0);
  const rightYRaw = useMotionValue(0);
  const leftX = useSpring(leftXRaw, springConfig);
  const leftY = useSpring(leftYRaw, springConfig);
  const rightX = useSpring(rightXRaw, springConfig);
  const rightY = useSpring(rightYRaw, springConfig);
  const showDetailPanel = selected && isFocused;
  const showHandleUi = isNodeHovering || selected;
  /** 画布最大化时底部编辑区默认更大；双击编辑区可切换不同缩放档位。 */
  const [maximizedDetailBoost, setMaximizedDetailBoost] = useState(false);
  useEffect(() => {
    if (!isMaximizedView) setMaximizedDetailBoost(false);
  }, [isMaximizedView]);
  const detailPanelScale = !isMaximizedView ? 1 : maximizedDetailBoost ? 0.9 : 0.58;
  const isCleanPanel = Boolean(data?.cleanPanel);
  const connectionHover = useConnectionHoverForNode(nodeId);
  const isConnectionHoverTarget = connectionHover.isTarget;
  const resolvedConnectionHoverTilt = connectionHover.tilt;
  const hasImportedImage = Boolean(importedImage);
  const hasEditableImage = hasImportedImage;
  const isAssetLikeImageNode = hasImportedImage && imageMode === 'asset';
  const showInputHandleUi = showHandleUi && !isAssetLikeImageNode;
  const nodeGenerationPending = Boolean(data?.generationPending);
  const displayedGenerationProgress = nodeGenerationPending
    ? Math.max(0, Math.min(100, Number(data?.generationProgress) || 0))
    : progress;
  const generationBackdropAsset = nodeGenerationPending
    ? importedImage
      || data?.pendingPreviewAsset
      || (Array.isArray(data?.inputImageRefs) ? data.inputImageRefs.find((asset) => asset?.src) : null)
      || null
    : null;
  const isRegeneratingToNewNode = false;
  const resolvedLastGenerationSubmittedAt =
    lastGenerationSubmittedAt || data?.lastGenerationSubmittedAt || data?.lastGenerationStartedAt || '';
  const resolvedLastGenerationCompletedAt =
    lastGenerationCompletedAt || data?.lastGenerationCompletedAt || data?.lastGenerationAt || data?.generationTime || '';
  const generationInfoPrompt = String(lastGenerationPrompt || data?.lastGenerationPrompt || '').trim();
  const generationInfoSubmittedTime = formatGenerationInfoTime(resolvedLastGenerationSubmittedAt);
  const generationInfoCompletedTime = formatGenerationInfoTime(resolvedLastGenerationCompletedAt);
  const generationInfoDuration = formatGenerationDuration(
    resolvedLastGenerationSubmittedAt,
    resolvedLastGenerationCompletedAt
  );

  const requestSaveToMaterialLibrary = useCallback(() => {
    if (!importedImage?.src || typeof onRequestSaveToMaterial !== 'function') return;
    onRequestSaveToMaterial({
      kind: 'image',
      defaultName: importedImage.name?.replace(/\.[^/.]+$/, '') || '图片素材',
      asset: {
        src: importedImage.src,
        name: importedImage.name || 'image.png',
        width: importedImage.width || null,
        height: importedImage.height || null,
        kind: 'image',
        seedanceFaceReview: seedanceFaceReview || null,
      },
      coverAsset: {
        src: importedImage.src,
        name: importedImage.name || 'image.png',
        width: importedImage.width || null,
        height: importedImage.height || null,
        kind: 'image',
        seedanceFaceReview: seedanceFaceReview || null,
      },
    });
  }, [importedImage, onRequestSaveToMaterial, seedanceFaceReview]);
  const inputImageRefs = useMemo(
    () =>
      (Array.isArray(data?.inputImageRefs) ? data.inputImageRefs : [])
        .filter((asset) => asset && typeof asset.src === 'string' && asset.src.trim())
        .slice(0, 8),
    [data?.inputImageRefs]
  );
  const imageAspect = importedImage ? importedImage.width / importedImage.height : null;
  const defaultNodeWidth = 408;
  const importedImageFrame = useMemo(() => {
    if (!hasImportedImage || !imageAspect || !Number.isFinite(imageAspect) || imageAspect <= 0) {
      return { width: defaultNodeWidth, height: 230 };
    }

    if (imageAspect >= 1) {
      const width = Math.min(720, Math.max(defaultNodeWidth, 230 * imageAspect));
      return { width, height: width / imageAspect };
    }

    const height = Math.min(620, Math.max(230, defaultNodeWidth / imageAspect));
    return { width: height * imageAspect, height };
  }, [hasImportedImage, imageAspect]);
  const nodeWidth = importedImageFrame.width;
  // Node height never changes on double-click (maximize = camera zoom only).
  // Keeping a stable height prevents the DOM-measure / camera-fit timing mismatch
  // that caused aspect-ratio distortion for images with letterbox borders.
  const imageCardHeight = importedImageFrame.height;

  const modelConfig = useMemo(() => getImageModelConfig(selectedModel), [selectedModel]);
  const selectedModelLabel = modelConfig.label || selectedModel;
  const supportedSizes = useMemo(() => getAllowedSizes(selectedModel), [selectedModel]);

  /** 当前模型允许选择的比例 id，用于面板里禁用显示。 */
  const supportedAspectRatioIds = useMemo(() => {
    return new Set(getAllowedRatios(selectedModel));
  }, [selectedModel]);

  useEffect(() => {
    const allowed = new Set(getAllowedRatios(selectedModel));
    if (!allowed.has(ratio)) {
      setRatio(getDefaultRatio(selectedModel));
    }
  }, [selectedModel, ratio]);

  useEffect(() => {
    const allowed = new Set(getAllowedSizes(selectedModel));
    if (!allowed.has(size)) {
      setSize(getDefaultSize(selectedModel));
    }
  }, [selectedModel, size]);

  // Crop feature state & refs
  const [showCropMenu, setShowCropMenu]         = useState(false);
  const [cropMenuPos, setCropMenuPos]           = useState({ top: 0, left: 0 });
  const [showCropModal, setShowCropModal]       = useState(false);
  const [cropBox, setCropBox]                   = useState({ x: 0, y: 0, w: 1, h: 1 });
  const [cropDisplaySize, setCropDisplaySize]   = useState({ w: 800, h: 450 });
  const cropButtonRef                           = useRef(null);
  const cropAspectBtnRef                        = useRef(null);
  const cropContainerRef                        = useRef(null);
  const cropBoxRef                              = useRef({ x: 0, y: 0, w: 1, h: 1 });
  const [showCropAspectMenu, setShowCropAspectMenu] = useState(false);
  const [cropAspectMenuPos, setCropAspectMenuPos]   = useState({ left: 0, top: 0 });
  const [cropAspectLabel, setCropAspectLabel]       = useState('原图比例');
  const annotationStageRef = useRef(null);
  const annotationCanvasRef = useRef(null);
  const annotationBaseImageRef = useRef(null);
  const annotationDraftRef = useRef(null);
  const annotationTextInputRef = useRef(null);
  const [annotationDisplaySize, setAnnotationDisplaySize] = useState({ w: 960, h: 540 });
  const [annotationTool, setAnnotationTool] = useState('brush');
  const [annotationColor, setAnnotationColor] = useState(ANNOTATION_COLOR_OPTIONS[0]);
  const [annotationBrushSize, setAnnotationBrushSize] = useState(10);
  const [annotationItems, setAnnotationItems] = useState([]);
  const [annotationUndoStack, setAnnotationUndoStack] = useState([]);
  const [annotationDraft, setAnnotationDraft] = useState(null);
  const mentionTriggerModeRef = useRef(null);
  const [mentionMenu, setMentionMenu] = useState({
    open: false,
    query: '',
    replaceStart: 0,
    replaceEnd: 0,
    mode: 'inline',
  });

  // Keep cropBoxRef in sync so drag closures always read the latest value
  useEffect(() => { cropBoxRef.current = cropBox; }, [cropBox]);

  // Close crop dropdown on outside click.
  // Must use bubble phase (not capture): capture runs before the portal can stopPropagation,
  // which was closing the menu before the menu item's click could open the crop modal.
  useEffect(() => {
    if (!showCropMenu) return;
    const handler = (e) => {
      const t = e.target;
      if (cropButtonRef.current?.contains(t)) return;
      if (typeof t?.closest === 'function' && t.closest('[data-crop-dropdown]')) return;
      setShowCropMenu(false);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [showCropMenu]);

  const openCropMenu = useCallback((e) => {
    e.stopPropagation();
    if (!showCropMenu) {
      const rect = cropButtonRef.current?.getBoundingClientRect();
      if (rect) setCropMenuPos({ top: rect.bottom + 6, left: rect.left + rect.width / 2 });
    }
    setShowCropMenu((v) => !v);
  }, [showCropMenu]);

  // Calculate display size (fit image inside viewport) when modal opens
  useEffect(() => {
    if (!showCropModal || !importedImage) return;
    const maxW = window.innerWidth  * 0.76;
    const maxH = window.innerHeight * 0.68;
    const ar   = (importedImage.width || 1) / (importedImage.height || 1);
    let w = maxW, h = maxW / ar;
    if (h > maxH) { h = maxH; w = maxH * ar; }
    setCropDisplaySize({ w: Math.round(w), h: Math.round(h) });
    const full = { x: 0, y: 0, w: 1, h: 1 };
    setCropBox(full);
    cropBoxRef.current = full;
    setCropAspectLabel('原图比例');
    setShowCropAspectMenu(false);
  }, [showCropModal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!showCropAspectMenu) return;
    const close = (e) => {
      const t = e.target;
      if (cropAspectBtnRef.current?.contains(t)) return;
      if (typeof t?.closest === 'function' && t.closest('[data-crop-aspect-menu]')) return;
      setShowCropAspectMenu(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [showCropAspectMenu]);

  const applyCropAspectPreset = useCallback(
    (preset) => {
      if (!importedImage?.width || !importedImage?.height) return;
      const iw = importedImage.width;
      const ih = importedImage.height;
      const R = preset.R == null ? iw / ih : preset.R;
      const next = maxCropBoxForTargetPixelAspect(iw, ih, R);
      setCropBox(next);
      cropBoxRef.current = next;
      setCropAspectLabel(preset.label);
      setShowCropAspectMenu(false);
    },
    [importedImage]
  );

  const toggleCropAspectMenu = useCallback((e) => {
    e.stopPropagation();
    const rect = cropAspectBtnRef.current?.getBoundingClientRect();
    if (rect) setCropAspectMenuPos({ left: rect.left + rect.width / 2, top: rect.top - 8 });
    setShowCropAspectMenu((v) => !v);
  }, []);

  const getAbsoluteNodePosition = useCallback(() => {
    return (
      getInternalNode(nodeId)?.internals?.positionAbsolute ??
      getNode(nodeId)?.position ??
      { x: 0, y: 0 }
    );
  }, [getInternalNode, getNode, nodeId]);

  // Keep the node's current image asset in React Flow data so App.jsx can build
  // Keep "引用素材" thumbnails available for downstream connected nodes.
  useEffect(() => {
    const patch = {
      imageAsset: importedImage
        ? {
            src: importedImage.src,
            width: importedImage.width,
            height: importedImage.height,
            name: importedImage.name || 'image.png',
            resultUrl: importedImage.resultUrl || importedImage.result_url || null,
            previewUpdatedAt: importedImage.previewUpdatedAt || null,
            seedanceFaceReview: seedanceFaceReview || null,
          }
        : null,
      generationModel: selectedModel,
      generationRatio: ratio,
      generationSize: size,
      generationQuality: size,
      generationPrompt: prompt,
      lastGenerationPrompt,
      lastGenerationSubmittedAt: resolvedLastGenerationSubmittedAt,
      lastGenerationCompletedAt: resolvedLastGenerationCompletedAt,
      lastGenerationAt: resolvedLastGenerationCompletedAt,
      imageMode,
      seedanceFaceReview,
    };
    if (isNodeDataPatchUnchanged(data, patch)) return;
    if (persistNodeData) {
      persistNodeData(nodeId, patch);
    } else {
      updateNodeData(nodeId, patch);
    }
  }, [
    imageMode,
    importedImage,
    nodeId,
    persistNodeData,
    ratio,
    selectedModel,
    size,
    prompt,
    lastGenerationPrompt,
    lastGenerationSubmittedAt,
    lastGenerationCompletedAt,
    resolvedLastGenerationSubmittedAt,
    resolvedLastGenerationCompletedAt,
    seedanceFaceReview,
    updateNodeData,
  ]);

  const handleCancelGeneration = useCallback((event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (cancelGenerationForNode(nodeId)) return;
    updateNodeData(nodeId, {
      generationPending: false,
      generationProgress: 0,
      generationError: '已取消',
    });
  }, [nodeId, updateNodeData]);

  const renderInputImageRefs = ({
    sizeClass = 'h-10 w-10',
    textClass = 'text-[12px]',
    showLabel = true,
    scrollerRef = null,
  } = {}) => {
    if (!inputImageRefs.length) return null;
    return (
      <div
        ref={scrollerRef}
        className="flex h-full items-center gap-2.5 overflow-x-auto overflow-y-hidden px-0.5 py-0.5 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        onWheel={(event) => {
          const container = event.currentTarget;
          if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
          event.preventDefault();
          container.scrollLeft += event.deltaY;
        }}
      >
        {showLabel && <span className={`shrink-0 text-[#8e949e] ${textClass}`}>引用素材</span>}
        {inputImageRefs.map((asset, index) => (
          <div
            key={`${asset.src}-${index}`}
            className={`group relative shrink-0 overflow-hidden rounded-[12px] border bg-[#14161b] ${sizeClass} ${
              selectedReferenceTokens.includes(`@图片${index + 1}`)
                ? 'border-[#8fb9ff] shadow-[0_0_0_1px_rgba(143,185,255,0.35)]'
                : 'border-white/30'
            }`}
          >
            <button
              type="button"
              title={`图片${index + 1}`}
              className="absolute inset-0 z-0"
              onClick={() => {
                const token = `@图片${index + 1}`;
                setSelectedReferenceTokens((prev) =>
                  prev.includes(token) ? prev.filter((item) => item !== token) : [...prev, token]
                );
              }}
            />
            <div className="absolute left-1 top-1 z-10 min-w-4 rounded-full bg-black/60 px-1 py-[1px] text-center text-[10px] font-semibold leading-none text-white backdrop-blur-sm">
              {index + 1}
            </div>
            <button
              type="button"
              aria-label={`删除图片${index + 1}引用`}
              className="absolute right-1 top-1 z-20 flex h-4 w-4 items-center justify-center rounded-full border border-white/15 bg-black/70 text-white/80 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                removeInputReference({ ...asset, index });
              }}
            >
              <X size={10} />
            </button>
            <img
              src={asset.src}
              alt={asset.name || `ref-${index + 1}`}
              loading="lazy"
              decoding="async"
              className="pointer-events-none h-full w-full object-cover"
              draggable={false}
            />
          </div>
        ))}
      </div>
    );
  };

  const mentionItems = useMemo(
    () =>
      inputImageRefs.map((asset, index) => ({
        index,
        token: `@图片${index + 1}`,
        label: `图片${index + 1}`,
        src: asset.src,
        sourceNodeId: asset.sourceNodeId,
        edgeId: asset.edgeId,
      })),
    [inputImageRefs]
  );

  const filteredMentionItems = mentionItems.filter((item) => {
    const query = mentionMenu.query.trim().toLowerCase();
    if (!query) return true;
    return (
      item.token.toLowerCase().includes(`@${query}`) ||
      item.label.toLowerCase().includes(query) ||
      String(item.index + 1).includes(query)
    );
  });

  const closeMentionMenu = useCallback(() => {
    setMentionMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
  }, []);

  const getPromptTextarea = useCallback((mode) => {
    return mode === 'modal' ? modalTextareaRef.current : inlineTextareaRef.current;
  }, []);

  const syncMentionMenu = useCallback((value, caret, mode) => {
    if (!inputImageRefs.length) {
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
      mode,
    });
  }, [closeMentionMenu, inputImageRefs.length]);

  const insertMentionToken = useCallback((item, mode) => {
    if (!item) return;

    const textarea = getPromptTextarea(mode);
    const fallbackCaret = textarea?.selectionStart ?? prompt.length;
    const replaceStart =
      mentionMenu.open && mentionMenu.mode === mode ? mentionMenu.replaceStart : fallbackCaret;
    const replaceEnd =
      mentionMenu.open && mentionMenu.mode === mode ? mentionMenu.replaceEnd : fallbackCaret;
    const nextValue = `${prompt.slice(0, replaceStart)}${item.token} ${prompt.slice(replaceEnd)}`;
    const nextCaret = replaceStart + item.token.length + 1;

    setPrompt(nextValue);
    closeMentionMenu();

    requestAnimationFrame(() => {
      const target = getPromptTextarea(mode);
      if (!target) return;
      target.focus();
      target.setSelectionRange(nextCaret, nextCaret);
    });
  }, [
    closeMentionMenu,
    getPromptTextarea,
    mentionMenu.mode,
    mentionMenu.open,
    mentionMenu.replaceEnd,
    mentionMenu.replaceStart,
    prompt,
  ]);

  const handlePromptChange = useCallback((event, mode) => {
    const nextValue = event.target.value;
    const caret = event.target.selectionStart ?? nextValue.length;
    setPrompt(nextValue);
    const shouldSyncMentionMenu =
      mentionTriggerModeRef.current === mode || (mentionMenu.open && mentionMenu.mode === mode);

    if (shouldSyncMentionMenu) {
      syncMentionMenu(nextValue, caret, mode);
    } else if (mentionMenu.open && mentionMenu.mode === mode) {
      closeMentionMenu();
    }

    mentionTriggerModeRef.current = null;
  }, [closeMentionMenu, mentionMenu.mode, mentionMenu.open, syncMentionMenu]);

  const handlePromptCursorChange = useCallback((event, mode) => {
    if (mentionMenu.open && mentionMenu.mode === mode) {
      closeMentionMenu();
    }
    mentionTriggerModeRef.current = null;
  }, [closeMentionMenu, mentionMenu.mode, mentionMenu.open]);

  const adjustPromptAfterRefRemoval = useCallback((value, removedIndex) => {
    if (!value) return value;

    let nextValue = value.replace(new RegExp(`@图片${removedIndex}`, 'g'), '');
    for (let index = removedIndex + 1; index <= 8; index += 1) {
      nextValue = nextValue.replace(new RegExp(`@图片${index}`, 'g'), `@图片${index - 1}`);
    }

    return nextValue
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/(^|\n) /g, '$1')
      .replace(/ \n/g, '\n');
  }, []);

  const adjustSelectedTokensAfterRefRemoval = useCallback((tokens, removedIndex) => {
    return tokens
      .map((token) => {
        const match = token.match(/^@图片(\d+)$/);
        if (!match) return token;
        const tokenIndex = Number(match[1]);
        if (tokenIndex === removedIndex) return null;
        if (tokenIndex > removedIndex) return `@图片${tokenIndex - 1}`;
        return token;
      })
      .filter(Boolean);
  }, []);

  const removeInputReference = useCallback((item) => {
    if (!item?.sourceNodeId || !nodeId) return;

    const removedIndex = item.index + 1;
    setEdges((edges) =>
      edges.filter((edge) => !(edge.source === item.sourceNodeId && edge.target === nodeId))
    );
    setSelectedReferenceTokens((prev) => adjustSelectedTokensAfterRefRemoval(prev, removedIndex));
    setPrompt((prev) => adjustPromptAfterRefRemoval(prev, removedIndex));
    closeMentionMenu();
  }, [adjustPromptAfterRefRemoval, adjustSelectedTokensAfterRefRemoval, closeMentionMenu, nodeId, setEdges]);

  const removeMentionTokenAroundCaret = useCallback((value, selectionStart, selectionEnd, mode, action) => {
    const tokenRegex = /@图片\d+/g;
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
      if (value[removeEnd] === ' ') {
        removeEnd += 1;
      }

      const nextValue = `${value.slice(0, removeStart)}${value.slice(removeEnd)}`;
      setPrompt(nextValue);
      closeMentionMenu();

      requestAnimationFrame(() => {
        const target = getPromptTextarea(mode);
        if (!target) return;
        target.focus();
        target.setSelectionRange(removeStart, removeStart);
      });
      return true;
    }

    return false;
  }, [closeMentionMenu, getPromptTextarea]);

  const renderPromptMentionHighlight = useCallback(
    (mode, className) => {
      if (!prompt || !mentionItems.length) return null;
      const validTokens = new Set(mentionItems.map((item) => item.token));
      const segments = prompt.split(/(@图片\d+)/g);

      return (
        <div
          ref={mode === 'modal' ? modalHighlightRef : inlineHighlightRef}
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-transparent ${className}`}
        >
          {segments.map((segment, index) =>
            validTokens.has(segment) ? (
              <span
                key={`${mode}-token-${index}`}
                className="rounded-[6px] border border-[#556079] bg-[#3a4358]/95 font-medium text-[#f7f9fd] shadow-[0_0_0_1px_rgba(255,255,255,0.04)] [box-decoration-break:clone] [-webkit-box-decoration-break:clone]"
              >
                {segment}
              </span>
            ) : (
              <span key={`${mode}-plain-${index}`} className="text-transparent">
                {segment}
              </span>
            )
          )}
        </div>
      );
    },
    [mentionItems, prompt]
  );

  const syncPromptHighlightScroll = useCallback(
    (mode) => {
      const textarea = mode === 'modal' ? modalTextareaRef.current : inlineTextareaRef.current;
      const highlight = mode === 'modal' ? modalHighlightRef.current : inlineHighlightRef.current;
      if (!textarea || !highlight) return;
      highlight.scrollTop = textarea.scrollTop;
      highlight.scrollLeft = textarea.scrollLeft;
    },
    []
  );

  const renderRatioIndicator = useCallback(
    (ratioId, iconOnly = false) => {
      const preset = ratioOptions.find((item) => item.id === ratioId) || ratioOptions[0];
      return (
        <span className="inline-flex items-center gap-2">
          <span
            className={`inline-block rounded-[3px] border-2 border-white/75 ${preset.iconClass}`}
            aria-hidden="true"
          />
          {!iconOnly && <span>{preset.label}</span>}
        </span>
      );
    },
    []
  );

  const updatePresetPanelPosition = useCallback(
    (mode = presetMenuMode) => {
      const trigger = mode === 'modal' ? modalSizeTriggerRef.current : inlineSizeTriggerRef.current;
      if (!trigger) return;

      const rect = trigger.getBoundingClientRect();
      const panelWidth = 506;
      const gutter = 16;
      const left = Math.min(Math.max(gutter, rect.left), window.innerWidth - panelWidth - gutter);
      const top = Math.max(gutter + 8, rect.top - 12);

      setPresetPanelPosition({ left, top });
    },
    [presetMenuMode]
  );

  const togglePresetMenu = useCallback(
    (mode) => {
      const shouldOpen = !(showPresetMenu && presetMenuMode === mode);
      if (shouldOpen) {
        setPresetMenuMode(mode);
        updatePresetPanelPosition(mode);
      }
      setShowPresetMenu(shouldOpen);
    },
    [presetMenuMode, showPresetMenu, updatePresetPanelPosition]
  );

  const renderPresetPanel = useCallback(
    (isModal = false) =>
      createPortal(
        <div
          data-size-panel="true"
          className="fixed z-[120] w-[506px] rounded-[24px] border border-white/[0.08] bg-[#262626] px-5 py-5 shadow-2xl transition-[opacity,transform] duration-150 ease-out"
          style={{
            left: presetPanelPosition.left,
            top: presetPanelPosition.top,
            transform: presetMenuVisible ? 'translateY(-100%)' : 'translateY(calc(-100% + 4px))',
            opacity: presetMenuVisible ? 1 : 0,
          }}
          onClick={(e) => e.stopPropagation()}
        >
        <div className="text-[16px] font-semibold text-[#c7c9ce]">尺寸</div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {supportedSizes.map((item) => {
            const selectedResolution = size === item;
            return (
              <button
                key={`${isModal ? 'modal-res' : 'inline-res'}-${item}`}
                onClick={() => {
                  setSize(item);
                  setShowPresetMenu(false);
                }}
                className={`flex h-[48px] items-center justify-center rounded-[14px] border text-[16px] font-semibold transition-colors ${
                  selectedResolution
                    ? 'border-white/0 bg-white/[0.12] text-white'
                    : 'border-white/[0.14] bg-transparent text-[#8f949c] hover:bg-white/[0.05] hover:text-white'
                }`}
              >
                {item}
              </button>
            );
          })}
        </div>

        <div className="mt-4 text-[16px] font-semibold text-[#c7c9ce]">比例</div>
        <div className="mt-4 grid grid-cols-5 gap-3">
          {ratioOptions.map((item) => {
            const selectedRatio = ratio === item.id;
            const ratioSupported = supportedAspectRatioIds.has(item.id);
            return (
              <button
                key={`${isModal ? 'modal-ratio' : 'inline-ratio'}-${item.id}`}
                type="button"
                disabled={!ratioSupported}
                onClick={() => {
                  if (!ratioSupported) return;
                  setRatio(item.id);
                  setShowPresetMenu(false);
                }}
                className={`flex h-[94px] flex-col items-center justify-center rounded-[16px] border transition-colors ${
                  !ratioSupported
                    ? 'cursor-not-allowed border-white/[0.06] bg-transparent opacity-35'
                    : selectedRatio
                      ? 'border-white/90 bg-white/[0.06] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]'
                      : 'border-white/[0.14] bg-transparent text-[#8f949c] hover:bg-white/[0.04] hover:text-white'
                }`}
              >
                <span
                  className={`inline-block rounded-[3px] border-2 ${selectedRatio ? 'border-white' : 'border-white/65'} ${item.iconClass}`}
                  aria-hidden="true"
                />
                <span
                  className={`mt-4 text-[14px] font-semibold leading-none ${
                    !ratioSupported ? 'text-[#5c6169]' : selectedRatio ? 'text-white' : 'text-[#8f949c]'
                  }`}
                >
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
        </div>,
        document.body
      ),
    [presetMenuVisible, presetPanelPosition.left, presetPanelPosition.top, ratio, size, supportedAspectRatioIds, supportedSizes]
  );

  const renderModelPanel = useCallback(
    (isModal = false) => (
      <div
        data-model-panel="true"
        className={`absolute left-0 top-[54px] z-30 w-[260px] rounded-[20px] border border-white/[0.08] bg-[#262626] p-3 shadow-2xl transition-all duration-150 ease-out ${
          showModelMenu ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 px-2 text-[14px] font-semibold text-[#b8bcc6]">选择模型</div>
        {imageModelOptions.map((item) => {
          const selected = selectedModel === item.id;
          return (
            <button
              key={`${isModal ? 'modal-model' : 'inline-model'}-${item.id}`}
              type="button"
              onClick={() => {
                setSelectedModel(item.id);
                setPreferredImageGenerationModel(projectSlug, item.id);
                setShowModelMenu(false);
              }}
              className={`flex w-full items-center justify-between rounded-[14px] px-3 py-3 text-left transition-colors ${
                selected
                  ? 'bg-white/[0.10] text-white'
                  : 'text-[#9ba1ab] hover:bg-white/[0.05] hover:text-white'
              }`}
            >
              <span className="text-[14px] font-medium">{item.label}</span>
              {selected && <span className="text-[12px] text-[#dfe4ec]">当前</span>}
            </button>
          );
        })}
      </div>
    ),
    [selectedModel, showModelMenu, projectSlug]
  );

  const renderMentionMenu = (mode) => {
    if (!mentionMenu.open || mentionMenu.mode !== mode || !filteredMentionItems.length) return null;

    const isModal = mode === 'modal';
    const handleMenuWheel = (event) => {
      const container = event.currentTarget;
      event.preventDefault();
      event.stopPropagation();
      container.scrollTop += event.deltaY;
    };

    return (
      <div
        data-mention-menu="true"
        className={`absolute left-0 z-30 overflow-hidden rounded-[18px] border border-white/[0.08] bg-[#25262c] shadow-2xl ${
          isModal ? 'top-11 w-[280px]' : 'top-9 w-[240px]'
        }`}
        onPointerDown={(e) => e.stopPropagation()}
        onWheelCapture={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div
          className="max-h-[260px] overflow-y-auto bg-[#25262c] p-2"
          onWheel={handleMenuWheel}
        >
          {filteredMentionItems.map((item) => (
            <button
              key={`${mode}-${item.token}`}
              type="button"
              className="mt-2 flex w-full items-center gap-3 rounded-[14px] border border-white/[0.06] bg-[#31343b] px-3 py-2.5 text-left transition-colors first:mt-0 hover:bg-[#3a3f49]"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertMentionToken(item, mode)}
            >
              <img
                src={item.src}
                alt={item.label}
                loading="lazy"
                decoding="async"
                className={`shrink-0 rounded-[10px] object-cover ${isModal ? 'h-12 w-12' : 'h-10 w-10'}`}
                draggable={false}
              />
              <div className="min-w-0 flex-1">
                <div className={`truncate font-medium text-white ${isModal ? 'text-[15px]' : 'text-[14px]'}`}>
                  {item.label}
                </div>
                <div className={`text-[#9da3ad] ${isModal ? 'text-[13px]' : 'text-[12px]'}`}>{`(${item.token})`}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  };

  useEffect(() => {
    if (!mentionMenu.open) return;
    const close = (e) => {
      if (typeof e.target?.closest === 'function' && e.target.closest('[data-mention-menu="true"]')) return;
      if (inlineTextareaRef.current?.contains?.(e.target)) return;
      if (modalTextareaRef.current?.contains?.(e.target)) return;
      closeMentionMenu();
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [closeMentionMenu, mentionMenu.open]);

  // Unified pointer-drag handler for crop box (move or resize corner)
  const startCropDrag = useCallback((e, type) => {
    e.preventDefault(); e.stopPropagation();
    const container = cropContainerRef.current;
    if (!container) return;
    const rect   = container.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startBox = { ...cropBoxRef.current };
    const MIN = 0.04;

    const onMove = (me) => {
      const dx = (me.clientX - startX) / rect.width;
      const dy = (me.clientY - startY) / rect.height;
      let { x, y, w, h } = startBox;

      if (type === 'move') {
        x = Math.max(0, Math.min(1 - w, x + dx));
        y = Math.max(0, Math.min(1 - h, y + dy));
      } else if (type === 'tl') {
        const nx = Math.max(0, Math.min(x + w - MIN, x + dx));
        const ny = Math.max(0, Math.min(y + h - MIN, y + dy));
        w = w + x - nx; h = h + y - ny; x = nx; y = ny;
      } else if (type === 'tr') {
        const ny = Math.max(0, Math.min(y + h - MIN, y + dy));
        h = h + y - ny; y = ny;
        w = Math.max(MIN, Math.min(1 - x, w + dx));
      } else if (type === 'bl') {
        const nx = Math.max(0, Math.min(x + w - MIN, x + dx));
        w = w + x - nx; x = nx;
        h = Math.max(MIN, Math.min(1 - y, h + dy));
      } else if (type === 'br') {
        w = Math.max(MIN, Math.min(1 - x, w + dx));
        h = Math.max(MIN, Math.min(1 - y, h + dy));
      }

      const next = {
        x: Math.max(0, x),
        y: Math.max(0, y),
        w: Math.min(1 - Math.max(0, x), w),
        h: Math.min(1 - Math.max(0, y), h),
      };
      setCropBox(next);
      cropBoxRef.current = next;
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  // Confirm crop: keep this node's image unchanged; add a new AI image node with the crop
  const applyCrop = useCallback(() => {
    if (!importedImage) return;
    const { x, y, w, h } = cropBoxRef.current;
    saveSnapshot?.();
    const img = new window.Image();
    img.onload = () => {
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      const cx = Math.round(x * iw);
      const cy = Math.round(y * ih);
      const cw = Math.max(1, Math.round(w * iw));
      const ch = Math.max(1, Math.round(h * ih));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      canvas.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const cur = getAbsoluteNodePosition();
        const nx = cur.x + CROP_NEW_NODE_OFFSET_X;
        const ny = cur.y;
        const newId = `img_crop_${Date.now()}`;
        addNodes({
          id: newId,
          type: 'AIImageNode',
          position: { x: nx, y: ny },
          dragHandle: NODE_DRAG_HANDLE_SELECTOR,
          data: {
            capturedFrame: {
              src: url,
              width: cw,
              height: ch,
              name: 'cropped.png',
              previewUpdatedAt: new Date().toISOString(),
              seedanceFaceReview: seedanceFaceReview || null,
            },
            seedanceFaceReview: seedanceFaceReview || null,
            imageMode: 'asset',
            cleanPanel: true,
            uiDismissToken: uiDismissToken ?? 0,
          },
        });
        addEdges({
          id: `e-crop-${nodeId}-${newId}`,
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
        setShowCropModal(false);
      }, 'image/png');
    };
    img.src = importedImage.src;
  }, [importedImage, saveSnapshot, addNodes, addEdges, getAbsoluteNodePosition, nodeId, seedanceFaceReview, uiDismissToken]);

  useEffect(() => {
    annotationDraftRef.current = annotationDraft;
  }, [annotationDraft]);

  const commitAnnotationItem = useCallback((item) => {
    if (!item) return;
    setAnnotationItems((prev) => {
      setAnnotationUndoStack((stack) => stack.concat([prev]).slice(-10));
      return prev.concat(item);
    });
  }, []);

  const undoAnnotation = useCallback(() => {
    if (annotationDraftRef.current) {
      setAnnotationDraft(null);
      return;
    }

    setAnnotationUndoStack((prevStack) => {
      if (!prevStack.length) return prevStack;
      const previousItems = prevStack[prevStack.length - 1];
      setAnnotationItems(previousItems);
      return prevStack.slice(0, -1);
    });
  }, []);

  const commitAnnotationTextDraft = useCallback(() => {
    const draft = annotationDraftRef.current;
    if (!draft || draft.type !== 'text') return null;
    const text = String(draft.text || '').trim();
    if (!text) {
      setAnnotationDraft(null);
      return null;
    }
    const nextItem = { ...draft, text };
    commitAnnotationItem(nextItem);
    setAnnotationDraft(null);
    return nextItem;
  }, [commitAnnotationItem]);

  const drawAnnotationItem = useCallback((ctx, item) => {
    if (!ctx || !item) return;
    if (item.type === 'brush') {
      const points = Array.isArray(item.points) ? item.points : [];
      if (!points.length) return;
      ctx.save();
      ctx.strokeStyle = item.color;
      ctx.lineWidth = item.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      if (points.length === 1) {
        ctx.lineTo(points[0].x + 0.01, points[0].y + 0.01);
      }
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (item.type === 'rect') {
      const width = item.endX - item.startX;
      const height = item.endY - item.startY;
      if (!width && !height) return;
      ctx.save();
      ctx.strokeStyle = item.color;
      ctx.lineWidth = item.size;
      ctx.strokeRect(item.startX, item.startY, width, height);
      ctx.restore();
      return;
    }

    if (item.type === 'text') {
      const text = String(item.text || '').trim();
      if (!text) return;
      ctx.save();
      ctx.fillStyle = item.color;
      ctx.font = `${Math.max(18, item.size * 4)}px sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(text, item.x, item.y);
      ctx.restore();
    }
  }, []);

  const renderAnnotationCanvas = useCallback(
    (items = annotationItems, draft = annotationDraft) => {
      const canvas = annotationCanvasRef.current;
      const image = annotationBaseImageRef.current;
      if (!canvas || !image) return;
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      items.forEach((item) => drawAnnotationItem(ctx, item));
      if (draft && draft.type !== 'text') {
        drawAnnotationItem(ctx, draft);
      }
    },
    [annotationDraft, annotationItems, drawAnnotationItem]
  );

  useEffect(() => {
    renderAnnotationCanvas();
  }, [renderAnnotationCanvas]);

  useEffect(() => {
    if (annotationDraft?.type !== 'text') return;
    requestAnimationFrame(() => {
      annotationTextInputRef.current?.focus();
    });
  }, [annotationDraft]);

  useEffect(() => {
    if (!showAnnotationModal) return;
    const handleAnnotationKeyDown = (event) => {
      const isUndo = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey;
      if (isUndo) {
        event.preventDefault();
        event.stopPropagation();
        undoAnnotation();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setAnnotationDraft(null);
        setShowAnnotationModal(false);
      }
    };
    window.addEventListener('keydown', handleAnnotationKeyDown, true);
    return () => window.removeEventListener('keydown', handleAnnotationKeyDown, true);
  }, [showAnnotationModal, undoAnnotation]);

  useEffect(() => {
    if (!showAnnotationModal || !importedImage?.src) return;
    const img = new window.Image();
    img.onload = () => {
      annotationBaseImageRef.current = img;
      const maxW = window.innerWidth * 0.82;
      const maxH = window.innerHeight * 0.74;
      const ar = (img.naturalWidth || 1) / (img.naturalHeight || 1);
      let w = maxW;
      let h = maxW / ar;
      if (h > maxH) {
        h = maxH;
        w = maxH * ar;
      }
      setAnnotationDisplaySize({ w: Math.round(w), h: Math.round(h) });
      setAnnotationItems([]);
      setAnnotationUndoStack([]);
      setAnnotationDraft(null);
      setAnnotationTool('brush');
      setAnnotationColor(ANNOTATION_COLOR_OPTIONS[0]);
      setAnnotationBrushSize(10);
    };
    img.src = importedImage.src;
  }, [importedImage, showAnnotationModal]);

  const getAnnotationPoint = useCallback((event) => {
    const stage = annotationStageRef.current;
    const image = annotationBaseImageRef.current;
    if (!stage || !image) return null;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = ((event.clientX - rect.left) / rect.width) * (image.naturalWidth || image.width);
    const y = ((event.clientY - rect.top) / rect.height) * (image.naturalHeight || image.height);
    return {
      x: Math.max(0, Math.min(image.naturalWidth || image.width, x)),
      y: Math.max(0, Math.min(image.naturalHeight || image.height, y)),
    };
  }, []);

  const startAnnotationInteraction = useCallback((event) => {
    if (!annotationBaseImageRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const startPoint = getAnnotationPoint(event);
    if (!startPoint) return;

    if (annotationTool === 'text') {
      commitAnnotationTextDraft();
      setAnnotationDraft({
        type: 'text',
        text: '',
        x: startPoint.x,
        y: startPoint.y,
        color: annotationColor,
        size: annotationBrushSize,
      });
      return;
    }

    const draft =
      annotationTool === 'rect'
        ? {
            type: 'rect',
            color: annotationColor,
            size: annotationBrushSize,
            startX: startPoint.x,
            startY: startPoint.y,
            endX: startPoint.x,
            endY: startPoint.y,
          }
        : {
            type: 'brush',
            color: annotationColor,
            size: annotationBrushSize,
            points: [startPoint],
          };

    setAnnotationDraft(draft);

    const handleMove = (moveEvent) => {
      const point = getAnnotationPoint(moveEvent);
      if (!point) return;
      setAnnotationDraft((prev) => {
        if (!prev) return prev;
        if (prev.type === 'rect') {
          return { ...prev, endX: point.x, endY: point.y };
        }
        if (prev.type === 'brush') {
          return { ...prev, points: prev.points.concat(point) };
        }
        return prev;
      });
    };

    const handleUp = () => {
      const finalDraft = annotationDraftRef.current;
      if (finalDraft) {
        const shouldCommit =
          finalDraft.type === 'brush'
            ? finalDraft.points.length > 0
            : Math.abs(finalDraft.endX - finalDraft.startX) > 2 || Math.abs(finalDraft.endY - finalDraft.startY) > 2;
        if (shouldCommit) {
          commitAnnotationItem(finalDraft);
        }
      }
      setAnnotationDraft(null);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }, [annotationBrushSize, annotationColor, annotationTool, commitAnnotationItem, commitAnnotationTextDraft, getAnnotationPoint]);

  const saveAnnotatedImage = useCallback(() => {
    const canvas = annotationCanvasRef.current;
    const image = annotationBaseImageRef.current;
    if (!canvas || !image) return;
    saveSnapshot?.();
    const pendingDraft = annotationDraftRef.current;
    const itemsForSave =
      pendingDraft?.type === 'text' && String(pendingDraft.text || '').trim()
        ? annotationItems.concat({ ...pendingDraft, text: String(pendingDraft.text || '').trim() })
        : annotationItems;
    renderAnnotationCanvas(itemsForSave, null);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const cur = getAbsoluteNodePosition();
      const nx = cur.x + CROP_NEW_NODE_OFFSET_X;
      const ny = cur.y;
      const baseName = importedImage?.name?.replace(/\.[^/.]+$/, '') || 'annotated';
      const newId = `img_annotated_${Date.now()}`;
      addNodes({
        id: newId,
        type: 'AIImageNode',
        position: { x: nx, y: ny },
        dragHandle: NODE_DRAG_HANDLE_SELECTOR,
        data: {
          capturedFrame: {
            src: url,
            width: image.naturalWidth || image.width,
            height: image.naturalHeight || image.height,
            name: `${baseName}_annotated.png`,
            previewUpdatedAt: new Date().toISOString(),
          },
          imageMode: 'asset',
          cleanPanel: true,
          uiDismissToken: uiDismissToken ?? 0,
        },
      });
      addEdges({
        id: `e-annot-${nodeId}-${newId}`,
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
      setAnnotationItems(itemsForSave);
      setShowAnnotationModal(false);
    }, 'image/png');
  }, [addNodes, addEdges, annotationItems, getAbsoluteNodePosition, importedImage, nodeId, renderAnnotationCanvas, saveSnapshot, uiDismissToken]);

  const triggerImportImage = (event) => {
    event?.stopPropagation?.();
    imageFileInputRef.current?.click();
  };

  const downloadImportedImageFile = useCallback(() => {
    if (!importedImage?.src) return;
    const a = document.createElement('a');
    a.href = importedImage.src;
    const name = importedImage.name?.trim() || 'image.png';
    a.download = /\.(png|jpe?g|gif|webp|bmp)$/i.test(name) ? name : `${name.replace(/\.[^/.]+$/, '') || 'image'}.png`;
    a.rel = 'noopener';
    a.click();
  }, [importedImage]);

  /**
   * 点击“文A”按钮时：
   * 1. 读取当前 prompt 全部内容；
   * 2. 先把 `@图片N` 临时替换为占位符，避免翻译时破坏引用 token；
   * 3. 请求本地 `/api/node/translate`；
   * 4. 返回后再把占位符恢复成原始 `@图片N`。
   */
  const handleTranslatePrompt = useCallback(async () => {
    const sourceText = prompt.trim();
    if (!sourceText || isTranslating) return;

    try {
      setIsTranslating(true);
      const { protectedText, tokens } = protectImageMentionTokens(sourceText);

      const response = await fetch(nodeApi('/translate'), {
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
        setPrompt(restoreImageMentionTokens(result.translated, tokens));
      }
    } catch (error) {
      console.error('Translate prompt failed:', error);
      window.alert(`翻译失败: ${error.message || '请检查 DeepSeek API 配置'}`);
    } finally {
      setIsTranslating(false);
    }
  }, [prompt, isTranslating]);

  const handleImageImport = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const nextUrl = URL.createObjectURL(file);
    const probeImage = new Image();
    probeImage.onload = () => {
      if (imageObjectUrlRef.current) {
        URL.revokeObjectURL(imageObjectUrlRef.current);
      }
      imageObjectUrlRef.current = nextUrl;
      setImageMode('asset');
      setImportedImage({
        src: nextUrl,
        width: probeImage.naturalWidth,
        height: probeImage.naturalHeight,
        name: file.name,
        previewUpdatedAt: new Date().toISOString(),
      });
    };
    probeImage.src = nextUrl;

    // Reset input value so selecting same file still triggers onChange.
    event.target.value = '';
  };

  const extractMentionTokensFromPrompt = useCallback(() => {
    const matches = prompt.match(/@图片\d+/g) || [];
    return Array.from(new Set(matches));
  }, [prompt]);

  const resolveGenerationReferenceItems = useCallback(() => {
    const mentionedTokens = extractMentionTokensFromPrompt();
    const activeTokens = mentionedTokens.length ? mentionedTokens : selectedReferenceTokens;
    return activeTokens
      .map((token) => mentionItems.find((item) => item.token === token))
      .filter(Boolean);
  }, [extractMentionTokensFromPrompt, mentionItems, selectedReferenceTokens]);

  const imageSourceToDataUrl = useCallback(async (src) => {
    if (!src) return null;
    if (String(src).startsWith('data:')) return String(src);

    const response = await fetch(src);
    if (!response.ok) {
      throw new Error('引用图片读取失败');
    }

    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('引用图片转 Base64 失败'));
      reader.readAsDataURL(blob);
    });
  }, []);

  const persistSeedanceFaceReview = useCallback((review) => {
    setSeedanceFaceReview(review);
    if (persistNodeData) {
      persistNodeData(nodeId, { seedanceFaceReview: review });
    } else {
      updateNodeData(nodeId, { seedanceFaceReview: review });
    }
  }, [nodeId, persistNodeData, updateNodeData]);

  const handleSeedanceFaceReview = useCallback(async () => {
    if (!importedImage?.src || seedanceFaceReviewPending) return;

    try {
      setSeedanceFaceReviewPending(true);
      persistSeedanceFaceReview({
        status: 'processing',
        assetId: seedanceFaceReview?.assetId || '',
        assetRef: seedanceFaceReview?.assetRef || '',
        assetStatus: seedanceFaceReview?.assetStatus || '',
        message: '正在上传到腾讯云并提交 Seedance 2.0 人脸审核...',
        updatedAt: new Date().toISOString(),
      });
      const publicReviewUrl = String(importedImage.resultUrl || importedImage.result_url || '').trim();
      let image = seedanceFaceReview?.assetRef || publicReviewUrl || String(importedImage.src || '').trim();
      if (!image.startsWith('http://') && !image.startsWith('https://') && !image.startsWith('asset://') && !image.startsWith('/')) {
        image = await imageSourceToDataUrl(importedImage.src);
      }
      if (false && image.startsWith('/')) {
        throw new Error('Seedance 2.0 人脸审核需要公网图片 URL，本地工程图片无法被讯客服务器访问。请使用生成图原始 URL 或先上传到公网图床后再审核。');
      } else if (false && !image.startsWith('http://') && !image.startsWith('https://') && !image.startsWith('asset://')) {
        throw new Error('Seedance 2.0 人脸审核需要公网图片 URL，拖入的本地图片不能直接审核。请先上传到公网图床后再审核。');
      }

      const response = await fetch(mediaApi('/seedance-face-review'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(projectSlug ? { 'X-Project-Slug': projectSlug } : {}),
        },
        body: JSON.stringify({
          image,
          name: importedImage.name || 'seedance-face-review.png',
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result?.error || 'Seedance 2.0 人脸审核失败');
      }

      let review = {
        status: result?.status || 'processing',
        assetId: result?.asset_id || '',
        assetRef: result?.asset_ref || '',
        assetStatus: result?.asset_status || '',
        message: result?.message || '',
        updatedAt: result?.updated_at || new Date().toISOString(),
      };
      persistSeedanceFaceReview(review);

      for (let attempt = 0; attempt < 24 && review.status === 'processing' && review.assetRef; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const pollResponse = await fetch(mediaApi('/seedance-face-review'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(projectSlug ? { 'X-Project-Slug': projectSlug } : {}),
          },
          body: JSON.stringify({
            image: review.assetRef,
            name: importedImage.name || 'seedance-face-review.png',
          }),
        });
        const pollResult = await pollResponse.json().catch(() => ({}));
        if (!pollResponse.ok) {
          throw new Error(pollResult?.error || 'Seedance 2.0 人脸审核查询失败');
        }
        review = {
          status: pollResult?.status || 'processing',
          assetId: pollResult?.asset_id || review.assetId || '',
          assetRef: pollResult?.asset_ref || review.assetRef || '',
          assetStatus: pollResult?.asset_status || '',
          message: pollResult?.message || (pollResult?.status === 'processing' ? '审核仍在处理中...' : ''),
          updatedAt: pollResult?.updated_at || new Date().toISOString(),
        };
        persistSeedanceFaceReview(review);
      }

      if (review.status === 'processing') {
        persistSeedanceFaceReview({
          ...review,
          message: '审核仍在处理中，可稍后再次右键查询状态。',
          updatedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      const review = {
        status: 'failed',
        message: error instanceof Error ? error.message : 'Seedance 2.0 人脸审核失败',
        updatedAt: new Date().toISOString(),
      };
      persistSeedanceFaceReview(review);
      window.alert(review.message);
    } finally {
      setSeedanceFaceReviewPending(false);
    }
  }, [
    importedImage?.name,
    importedImage?.resultUrl,
    importedImage?.result_url,
    importedImage?.src,
    imageSourceToDataUrl,
    nodeId,
    persistNodeData,
    persistSeedanceFaceReview,
    projectSlug,
    seedanceFaceReview?.assetId,
    seedanceFaceReview?.assetRef,
    seedanceFaceReview?.assetStatus,
    seedanceFaceReviewPending,
    updateNodeData,
  ]);

  /** 仅在「节点上已是生成结果」时再点生成才会调用；空白新节点或 asset 素材节点首次生成走就地更新 */
  const applyGeneratedImageToCurrentNode = useCallback((imageSrc, fileName = 'generated.png', resultUrl = '') => {
    if (!imageSrc) return;
    const probeImage = new Image();
    probeImage.onload = () => {
      saveSnapshot?.();
      setImageMode('generated');
      setImportedImage({
        src: imageSrc,
        width: probeImage.naturalWidth,
        height: probeImage.naturalHeight,
        name: fileName,
        resultUrl: resultUrl || null,
        previewUpdatedAt: new Date().toISOString(),
      });
      requestAnimationFrame(() => {
        updateNodeInternals(nodeId);
      });
    };
    probeImage.src = imageSrc;
  }, [nodeId, saveSnapshot, updateNodeInternals]);

  const createGeneratedImageNode = useCallback((imageSrc, fileName = 'generated.png', usedPrompt = '', resultUrl = '', submittedAt = '', completedAt = '') => {
    if (!imageSrc) return;
    const probeImage = new Image();
    probeImage.onload = () => {
      saveSnapshot?.();
      const cur = getAbsoluteNodePosition();
      const newId = `img_generated_${Date.now()}`;
      addNodes({
        id: newId,
        type: 'AIImageNode',
        position: { x: cur.x + CROP_NEW_NODE_OFFSET_X, y: cur.y },
        dragHandle: NODE_DRAG_HANDLE_SELECTOR,
        data: {
          capturedFrame: {
            src: imageSrc,
            width: probeImage.naturalWidth,
            height: probeImage.naturalHeight,
            name: fileName,
            resultUrl: resultUrl || null,
            previewUpdatedAt: new Date().toISOString(),
          },
          imageMode: 'generated',
          generationModel: selectedModel,
          generationRatio: ratio,
          generationSize: size,
          generationQuality: size,
          generationPrompt: usedPrompt,
          lastGenerationPrompt: usedPrompt,
          lastGenerationSubmittedAt: submittedAt,
          lastGenerationCompletedAt: completedAt,
          lastGenerationAt: completedAt,
          uiDismissToken: uiDismissToken ?? 0,
        },
        selected: true,
      });
      addEdges({
        id: `e-generate-${nodeId}-${newId}`,
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
      });
    };
    probeImage.src = imageSrc;
  }, [
    addEdges,
    addNodes,
    getAbsoluteNodePosition,
    nodeId,
    ratio,
    saveSnapshot,
    selectedModel,
    size,
    uiDismissToken,
    updateNodeInternals,
  ]);

  const createPendingGeneratedImageNode = useCallback((usedPrompt = '', submittedAt = '') => {
    saveSnapshot?.();
    const cur = getAbsoluteNodePosition();
    const newId = `img_generated_${Date.now()}`;
    const patch = {
      cleanPanel: true,
      imageMode: 'generated',
      generationPending: true,
      generationProgress: 12,
      generationModel: selectedModel,
      generationRatio: ratio,
      generationSize: size,
      generationQuality: size,
      generationPrompt: usedPrompt,
      lastGenerationPrompt: usedPrompt,
      lastGenerationSubmittedAt: submittedAt,
      lastGenerationCompletedAt: '',
      lastGenerationAt: '',
      pendingPreviewAsset: importedImage || inputImageRefs[0] || null,
      uiDismissToken: uiDismissToken ?? 0,
    };
    addNodes({
      id: newId,
      type: 'AIImageNode',
      position: { x: cur.x + CROP_NEW_NODE_OFFSET_X, y: cur.y },
      dragHandle: NODE_DRAG_HANDLE_SELECTOR,
      data: patch,
      selected: true,
    });
    addEdges({
      id: `e-generate-${nodeId}-${newId}`,
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
    });
    return newId;
  }, [
    addEdges,
    addNodes,
    getAbsoluteNodePosition,
    importedImage,
    inputImageRefs,
    nodeId,
    ratio,
    saveSnapshot,
    selectedModel,
    size,
    uiDismissToken,
    updateNodeInternals,
  ]);

  const currentImageSizeLabel = useMemo(() => {
    if (importedImage?.width && importedImage?.height) {
      return `${Math.round(importedImage.width)} × ${Math.round(importedImage.height)}`;
    }
    return mapUiSizeToApiSize(selectedModel, ratio, size);
  }, [importedImage, ratio, selectedModel, size]);

  const startGenerate = useCallback(async () => {
    if (loading) return;

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      window.alert('请先输入描述内容');
      return;
    }

    let outputNodeId = null;
    let abortController = null;
    let cancelRequested = false;
    let unregisterCancel = () => {};

    const shouldGenerateIntoCurrentNode = !importedImage?.src;

    try {
      const submittedAt = new Date().toISOString();
      if (shouldGenerateIntoCurrentNode) {
        saveSnapshot?.();
        outputNodeId = nodeId;
        updateNodeData(nodeId, {
          cleanPanel: true,
          imageMode: 'generated',
          generationPending: true,
          generationProgress: 12,
          generationError: '',
          generationModel: selectedModel,
          generationRatio: ratio,
          generationSize: size,
          generationQuality: size,
          generationPrompt: trimmedPrompt,
          lastGenerationPrompt: trimmedPrompt,
          lastGenerationSubmittedAt: submittedAt,
          lastGenerationCompletedAt: '',
          lastGenerationAt: '',
          pendingPreviewAsset: inputImageRefs[0] || null,
          uiDismissToken: uiDismissToken ?? 0,
        });
      } else {
        outputNodeId = createPendingGeneratedImageNode(trimmedPrompt, submittedAt);
      }
      abortController = new AbortController();
      const removePendingOutput = () => {
        if (outputNodeId === nodeId) {
          updateNodeData(nodeId, {
            generationPending: false,
            generationProgress: 0,
            generationError: '已取消',
          });
          return;
        }
        setNodes((nodes) => nodes.filter((node) => node.id !== outputNodeId));
        setEdges((edges) =>
          edges.filter((edge) => edge.source !== outputNodeId && edge.target !== outputNodeId)
        );
      };
      unregisterCancel = registerGenerationCancel(outputNodeId, () => {
        cancelRequested = true;
        abortController.abort();
        removePendingOutput();
      });
      const updateOutputProgress = (nextProgress) => {
        if (cancelRequested || abortController?.signal?.aborted) return;
        updateNodeData(outputNodeId, {
          generationPending: true,
          generationProgress: nextProgress,
        });
      };
      setLoading(true);
      setProgress(12);
      updateOutputProgress(12);

      const apiSize = mapUiSizeToApiSize(selectedModel, ratio, size);
      const referenceItems = resolveGenerationReferenceItems();
      const inputImages = await Promise.all(
        referenceItems.map(async (item) => imageSourceToDataUrl(item.src))
      );

      setProgress(38);
      updateOutputProgress(38);

      const response = await fetch(getImageGenerateApiUrl(), {
        method: 'POST',
        signal: abortController.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(projectSlug ? { 'X-Project-Slug': projectSlug } : {}),
        },
        body: JSON.stringify({
          model: selectedModel,
          backend: modelConfig.backend,
          endpoint: modelConfig.endpoint,
          provider_model_hint: modelConfig.apiModel,
          prompt: trimmedPrompt,
          ratio,
          ui_size: size,
          size: apiSize,
          input_images: inputImages.filter(Boolean),
        }),
      });

      if (cancelRequested || abortController.signal.aborted) return;
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result?.error || '鐢熸垚澶辫触');
      }

      setProgress(82);
      updateOutputProgress(82);

      if (!result?.preview_data_url) {
        throw new Error('未收到生成图片');
      }

      const persistedSrc =
        projectSlug && result.saved_filename
          ? nodeApi(`/project/media/${encodeURIComponent(projectSlug)}/${encodeURIComponent(result.saved_filename)}`)
          : result.preview_data_url;
      const fileName = result.saved_filename || 'generated.png';
      const resultUrl = result.result_url || '';
      const completedAt = new Date().toISOString();
      const probeImage = new Image();
      const imageSize = await new Promise((resolve) => {
        probeImage.onload = () =>
          resolve({ width: probeImage.naturalWidth || null, height: probeImage.naturalHeight || null });
        probeImage.onerror = () => resolve({ width: null, height: null });
        probeImage.src = persistedSrc;
      });
      const imageAsset = {
        src: persistedSrc,
        width: imageSize.width,
        height: imageSize.height,
        name: fileName,
        resultUrl: resultUrl || null,
        previewUpdatedAt: completedAt,
      };
      const finalPatch = {
        capturedFrame: imageAsset,
        imageAsset,
        imageMode: 'generated',
        cleanPanel: true,
        generationPending: false,
        generationProgress: 100,
        generationError: '',
        pendingPreviewAsset: null,
        generationModel: selectedModel,
        generationRatio: ratio,
        generationSize: size,
        generationQuality: size,
        generationPrompt: trimmedPrompt,
        lastGenerationPrompt: trimmedPrompt,
        lastGenerationSubmittedAt: submittedAt,
        lastGenerationCompletedAt: completedAt,
        lastGenerationAt: completedAt,
      };
      if (outputNodeId === nodeId) {
        setImageMode('generated');
        setImportedImage(imageAsset);
        setLastGenerationPrompt(trimmedPrompt);
        setLastGenerationSubmittedAt(submittedAt);
        setLastGenerationCompletedAt(completedAt);
      }
      updateNodeData(outputNodeId, finalPatch);
      persistNodeData?.(outputNodeId, finalPatch);
      requestAnimationFrame(() => updateNodeInternals(outputNodeId));
      setProgress(100);
    } catch (error) {
      if (cancelRequested || abortController?.signal?.aborted || error?.name === 'AbortError') {
        return;
      }
      console.error('Generate image failed:', error);
      if (outputNodeId) {
        updateNodeData(outputNodeId, {
          generationPending: false,
          generationProgress: 0,
          generationError: error instanceof Error ? error.message : '生成失败',
        });
      }
      window.alert(`生成失败: ${error.message || '请检查本地生成服务与 API_KEY 配置'}`);
    } finally {
      unregisterCancel();
      setTimeout(() => {
        setLoading(false);
        setProgress(0);
      }, 220);
    }
  }, [
    createPendingGeneratedImageNode,
    imageSourceToDataUrl,
    importedImage?.src,
    inputImageRefs,
    loading,
    modelConfig.apiModel,
    modelConfig.backend,
    modelConfig.endpoint,
    prompt,
    ratio,
    resolveGenerationReferenceItems,
    saveSnapshot,
    selectedModel,
    nodeId,
    projectSlug,
    size,
    setEdges,
    setNodes,
    updateNodeData,
    persistNodeData,
    updateNodeInternals,
    uiDismissToken,
  ]);

  const handlePromptKeyDown = useCallback((event, mode) => {
    if (event.key === '@') {
      mentionTriggerModeRef.current = mode;
    } else if (mentionTriggerModeRef.current === mode) {
      mentionTriggerModeRef.current = null;
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
        setPrompt(nextValue);
        requestAnimationFrame(() => {
          inputEl.setSelectionRange(deletionRange.start, deletionRange.start);
        });
        return;
      }
    }

    if (event.key === 'Backspace') {
      if (removeMentionTokenAroundCaret(value, selectionStart, selectionEnd, mode, 'backspace')) {
        event.preventDefault();
        return;
      }
    }

    if (event.key === 'Delete') {
      if (removeMentionTokenAroundCaret(value, selectionStart, selectionEnd, mode, 'delete')) {
        event.preventDefault();
        return;
      }
    }

    if (mentionMenu.open && mentionMenu.mode === mode) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMentionMenu();
        return;
      }

      if (event.key === 'Enter' && filteredMentionItems.length) {
        event.preventDefault();
        insertMentionToken(filteredMentionItems[0], mode);
        return;
      }
    }

    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !mentionMenu.open
    ) {
      event.preventDefault();
      startGenerate();
    }
  }, [
    closeMentionMenu,
    filteredMentionItems,
    insertMentionToken,
    mentionMenu.mode,
    mentionMenu.open,
    removeMentionTokenAroundCaret,
    startGenerate,
    getMentionCaretNavigationTarget,
  ]);

  useEffect(() => {
    let raf;
    let timer;
    if (showPresetMenu) {
      updatePresetPanelPosition();
      setRenderPresetMenu(true);
      raf = requestAnimationFrame(() => setPresetMenuVisible(true));
    } else {
      setPresetMenuVisible(false);
      timer = setTimeout(() => setRenderPresetMenu(false), 140);
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [showPresetMenu, updatePresetPanelPosition]);

  useEffect(() => {
    if (!showPresetMenu) return;

    const handleReposition = () => updatePresetPanelPosition();
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);

    return () => {
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [showPresetMenu, updatePresetPanelPosition]);

  useEffect(() => {
    setShowPresetMenu(false);
  }, [uiDismissToken]);

  useEffect(() => {
    const handleOutsideClick = (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const clickedInSizeUi = path.some(
        (node) =>
          node instanceof Element &&
          (node.dataset.sizeTrigger === 'true' || node.dataset.sizePanel === 'true')
      );

      if (!clickedInSizeUi) {
        setShowPresetMenu(false);
      }
    };
    document.addEventListener('pointerdown', handleOutsideClick, true);
    return () => document.removeEventListener('pointerdown', handleOutsideClick, true);
  }, []);

  useEffect(() => {
    const handleOutsideClick = (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const clickedInModelUi = path.some(
        (node) =>
          node instanceof Element &&
          (node.dataset.modelTrigger === 'true' || node.dataset.modelPanel === 'true')
      );

      if (!clickedInModelUi) {
        setShowModelMenu(false);
      }
    };

    document.addEventListener('pointerdown', handleOutsideClick, true);
    return () => document.removeEventListener('pointerdown', handleOutsideClick, true);
  }, []);

  useEffect(() => {
    if (!showDetailPanel) {
      setShowPromptModal(false);
      setShowPresetMenu(false);
      setShowModelMenu(false);
    }
  }, [showDetailPanel]);

  useEffect(() => {
    if (!hasEditableImage) {
      setShowImagePreviewModal(false);
      setShowImageTools(false);
      setShowAnnotationModal(false);
    }
  }, [hasEditableImage]);

  useEffect(() => {
    const handleOutsidePointer = (event) => {
      if (!showImageTools) return;
      const clickedToolbar = imageToolbarRef.current?.contains(event.target);
      const clickedSurface = imageSurfaceRef.current?.contains(event.target);
      if (!clickedToolbar && !clickedSurface) {
        setShowImageTools(false);
      }
    };

    document.addEventListener('pointerdown', handleOutsidePointer);
    return () => document.removeEventListener('pointerdown', handleOutsidePointer);
  }, [showImageTools]);

  useEffect(() => {
    if (!nodeContextMenu) return;
    const close = (event) => {
      if (event.target.closest?.('[data-image-node-context-menu="true"]')) return;
      setNodeContextMenu(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [nodeContextMenu]);

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
    const nextPrompt = data?.lastGenerationPrompt || '';
    const nextSubmittedAt = data?.lastGenerationSubmittedAt || data?.lastGenerationStartedAt || '';
    const nextCompletedAt = data?.lastGenerationCompletedAt || data?.lastGenerationAt || data?.generationTime || '';
    if (nextPrompt && nextPrompt !== lastGenerationPrompt) {
      setLastGenerationPrompt(nextPrompt);
    }
    if (nextSubmittedAt && nextSubmittedAt !== lastGenerationSubmittedAt) {
      setLastGenerationSubmittedAt(nextSubmittedAt);
    }
    if (nextCompletedAt && nextCompletedAt !== lastGenerationCompletedAt) {
      setLastGenerationCompletedAt(nextCompletedAt);
    }
  }, [
    data?.generationTime,
    data?.lastGenerationAt,
    data?.lastGenerationCompletedAt,
    data?.lastGenerationPrompt,
    data?.lastGenerationStartedAt,
    data?.lastGenerationSubmittedAt,
    lastGenerationCompletedAt,
    lastGenerationPrompt,
    lastGenerationSubmittedAt,
  ]);

  useEffect(() => {
    const nextAsset = data?.imageAsset ?? data?.capturedFrame ?? null;
    if (!nextAsset?.src) return;
    if (importedImage?.src === nextAsset.src) return;
    setImportedImage(nextAsset);
    setImageMode(data?.imageMode || 'generated');
    requestAnimationFrame(() => {
      updateNodeInternals(nodeId);
    });
  }, [
    data?.capturedFrame,
    data?.imageAsset,
    data?.imageMode,
    importedImage?.src,
    nodeId,
    updateNodeInternals,
  ]);

  useEffect(() => {
    return () => {
      if (imageObjectUrlRef.current) {
        URL.revokeObjectURL(imageObjectUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!nodeId) return;
    updateNodeInternals(nodeId);
  }, [nodeId, showHandleUi, showInputHandleUi, imageCardHeight, nodeWidth, updateNodeInternals]);

  const handleNodeMouseMove = (event) => {
    if (!nodeSurfaceRef.current) return;
    const rect = nodeSurfaceRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const centerY = rect.height / 2;
    const leftCenterX = -28;
    const rightCenterX = rect.width + 28;
    const maxRadius = 180;
    const snapRadius = 48;

    const leftDx = x - leftCenterX;
    const leftDy = y - centerY;
    const rightDx = x - rightCenterX;
    const rightDy = y - centerY;

    const leftDistance = Math.hypot(leftDx, leftDy);
    const rightDistance = Math.hypot(rightDx, rightDy);

    const nextHandleFx = {
      leftActive: leftDistance <= snapRadius,
      rightActive: rightDistance <= snapRadius,
    };
    setHandleFx((prev) =>
      prev.leftActive === nextHandleFx.leftActive && prev.rightActive === nextHandleFx.rightActive
        ? prev
        : nextHandleFx
    );

    // The closer the cursor is, the stronger the magnetic pull effect becomes.
    const leftFactor = Math.max(0, 1 - leftDistance / maxRadius) * 0.75;
    const rightFactor = Math.max(0, 1 - rightDistance / maxRadius) * 0.75;

    const maxOffsetX = 24;
    const maxOffsetY = 18;
    const nextLeftX = Math.min(0, Math.max(-maxOffsetX, leftDx * leftFactor));
    const nextRightX = Math.max(0, Math.min(maxOffsetX, rightDx * rightFactor));
    const nextLeftY = Math.max(-maxOffsetY, Math.min(maxOffsetY, leftDy * leftFactor));
    const nextRightY = Math.max(-maxOffsetY, Math.min(maxOffsetY, rightDy * rightFactor));

    // Keep + handles outside node body to avoid overlapping content panel.
    leftXRaw.set(nextLeftX);
    leftYRaw.set(nextLeftY);
    rightXRaw.set(nextRightX);
    rightYRaw.set(nextRightY);
  };

  const handleNodeMouseLeave = () => {
    setIsNodeHovering(false);
    setHandleFx({
      leftActive: false,
      rightActive: false,
    });
    leftXRaw.set(0);
    leftYRaw.set(0);
    rightXRaw.set(0);
    rightYRaw.set(0);
  };

  const seedanceReviewStatus = String(seedanceFaceReview?.status || (seedanceFaceReviewPending ? 'processing' : '')).toLowerCase();
  const seedanceReviewBadge =
    seedanceReviewStatus === 'approved'
      ? {
          label: 'Seedance 人脸识别通过',
          className: 'border-[#60d978]/35 bg-black/60 text-[#8ff0a0]',
        }
      : seedanceReviewStatus === 'failed'
        ? {
            label: 'Seedance 2.0 人脸审核失败',
            className: 'border-[#ff6b6b]/35 bg-black/60 text-[#ffb4b4]',
          }
        : seedanceReviewStatus === 'processing'
          ? {
              label: 'Seedance 2.0 人脸审核中',
              className: 'border-[#e8c766]/35 bg-black/60 text-[#f3d47a]',
            }
          : null;
  const seedanceReviewMenuText =
    seedanceReviewStatus === 'approved'
      ? '已通过，可以用于 Seedance 2.0。'
      : seedanceReviewStatus === 'failed'
        ? seedanceFaceReview?.message || '审核失败，请换一张清晰真人脸图片后重试。'
        : seedanceReviewStatus === 'processing'
          ? seedanceFaceReview?.message || '审核中，系统会自动刷新状态。'
          : '';

  return (
    <div className="relative w-[408px] text-[#E6E6E7]">
      <CrispZoomRoot>
      <div className="relative">
        <input
          ref={imageFileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleImageImport}
        />

        {!hasImportedImage && (
          <div className="mb-[10px] flex justify-center">
            <button
              onClick={triggerImportImage}
              onPointerDown={(e) => e.stopPropagation()}
              className={`h-9 px-4 rounded-xl text-sm text-[#ECECEF] flex items-center gap-2 transition-colors ${
                selected && !showDetailPanel
                  ? 'bg-[#1a1a1a] border border-transparent'
                  : 'bg-[#1a1a1a] border border-white/10 hover:bg-[#252525]'
              }`}
            >
              <Upload size={16} />
              上传
            </button>
          </div>
        )}

        <div className="relative mx-auto" style={{ width: nodeWidth }}>
          <div data-role="node-image-upper">
          <div className="mb-2 flex items-center justify-between gap-3 text-[#8C8F96]">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex items-center gap-1.5">
                <ImageIcon size={14} />
                <span className="text-sm leading-none">图片节点</span>
                <span className="text-xs leading-none">11</span>
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
            <span className="text-[11px] leading-none text-white/40">{currentImageSizeLabel}</span>
          </div>

          <div
            className="relative node-drag-handle cursor-move"
            ref={nodeSurfaceRef}
            onPointerEnter={() => setIsNodeHovering(true)}
            onPointerMove={handleNodeMouseMove}
            onPointerLeave={handleNodeMouseLeave}
          >
            {hasEditableImage && showImageTools && (
              <div
                ref={imageToolbarRef}
                data-role="node-image-toolbar"
                className="absolute left-1/2 z-30 h-10 rounded-xl border border-white/[0.05] bg-[#202020] px-2.5 flex items-center gap-0.5 shadow-xl whitespace-nowrap"
                style={{
                  top: 'var(--node-top-toolbar-y, -82px)',
                  transform: 'translateX(-50%) scale(var(--node-editor-scale, 1))',
                  transformOrigin: 'bottom center',
                  transition: 'top 120ms ease-out, transform 120ms ease-out',
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button className="h-7 px-2 rounded-md inline-flex items-center gap-1.5 text-xs leading-none text-[#e4e7ee] hover:bg-white/10 transition-colors">
                  <ImageIcon size={12} />
                  多视角
                </button>
                <button className="h-7 px-2 rounded-md inline-flex items-center gap-1.5 text-xs leading-none text-[#e4e7ee] hover:bg-white/10 transition-colors">
                  <Sparkles size={12} />
                  打光
                </button>
                <button className="h-7 px-2 rounded-md inline-flex items-center gap-1.5 text-xs leading-none text-[#e4e7ee] hover:bg-white/10 transition-colors">
                  <ImagePlus size={12} />
                  九宫格
                </button>
                <button className="h-7 px-2 rounded-md inline-flex items-center gap-1.5 text-xs leading-none text-[#e4e7ee] hover:bg-white/10 transition-colors">
                  <Upload size={12} />
                  高清
                </button>
                <button className="h-7 px-2 rounded-md inline-flex items-center gap-1.5 text-xs leading-none text-[#e4e7ee] hover:bg-white/10 transition-colors">
                  <MoveUp size={12} />
                  宫格切分
                </button>

                {/* 裁剪按钮，以下拉浮层形式渲染，避免被节点裁切 */}
                <button
                  ref={cropButtonRef}
                  className={`h-7 px-2 rounded-md inline-flex items-center gap-1 text-xs leading-none transition-colors ${
                    showCropMenu ? 'bg-white/15 text-white' : 'text-[#e4e7ee] hover:bg-white/10'
                  }`}
                  onClick={openCropMenu}
                >
                  <Crop size={11} />
                  裁剪
                  <ChevronDown size={9} />
                </button>
                <button
                  type="button"
                  className="h-7 px-2 rounded-md inline-flex items-center gap-1.5 text-xs leading-none text-[#e4e7ee] hover:bg-white/10 transition-colors"
                  onClick={(event) => {
                    event.stopPropagation();
                    setShowAnnotationModal(true);
                    setShowImageTools(false);
                  }}
                >
                  <Pencil size={11} />
                  标注
                </button>

                <span className="mx-1 h-4 w-px bg-white/12" />
                <button
                  type="button"
                  title="下载"
                  className="h-7 w-7 rounded-md text-[#d3d8e2] hover:bg-white/10 hover:text-white transition-colors flex items-center justify-center"
                  onClick={(e) => {
                    e.stopPropagation();
                    downloadImportedImageFile();
                  }}
                >
                  <Download size={13} />
                </button>
                <button
                  type="button"
                  title="放大查看"
                  className="h-7 w-7 rounded-md text-[#d3d8e2] hover:bg-white/10 hover:text-white transition-colors flex items-center justify-center"
                  onClick={() => setShowImagePreviewModal(true)}
                >
                  <Expand size={13} />
                </button>
              </div>
            )}

            <div
              data-role="node-image-preview"
              className={`relative rounded-[18px] ${hasImportedImage ? 'bg-transparent' : 'bg-[#202020]'} transition-all duration-[130ms] ease-out ${
                hasImportedImage ? 'p-0' : 'p-6'
              } ${
                hasImportedImage ? 'border border-transparent' : 'border border-[#202020]'
              }`}
              onContextMenu={(event) => {
                if (!hasImportedImage) return;
                event.preventDefault();
                event.stopPropagation();
                setNodeContextMenu({
                  left: event.clientX,
                  top: event.clientY,
                });
              }}
              style={{
                height: imageCardHeight,
                transform: isConnectionHoverTarget
                  ? `perspective(1200px) rotateX(${resolvedConnectionHoverTilt.x}deg) rotateY(${resolvedConnectionHoverTilt.y}deg) scale3d(1.025, 1.025, 1.025)`
                  : undefined,
                transformStyle: isConnectionHoverTarget ? 'preserve-3d' : undefined,
                willChange: isConnectionHoverTarget ? 'transform, box-shadow' : 'auto',
                boxShadow: isConnectionHoverTarget
                  ? '0 0 0 1.5px rgba(255,255,255,0.58), 0 14px 28px rgba(255,255,255,0.08), 0 20px 42px rgba(76,125,214,0.2), inset 0 0 0 1px rgba(255,255,255,0.1)'
                  : (selected || isSingleSelected) && !isMaximizedView
                    ? '0 0 0 2px rgba(255,255,255,0.52)'
                    : undefined,
                transition: 'transform 120ms ease-out, box-shadow 120ms ease-out',
              }}
            >
              {isConnectionHoverTarget && <div className="connection-hover-glow" />}
              <div className={`h-full w-full overflow-hidden ${hasImportedImage ? 'rounded-[18px]' : 'rounded-[14px] bg-[#202020]'}`}>
                {importedImage ? (
                  <div
                    ref={imageSurfaceRef}
                    className="h-full w-full bg-transparent"
                    onClick={() => {
                      if (hasEditableImage) {
                        setShowImageTools(true);
                      }
                    }}
                  >
                    <img
                      src={importedImage.src}
                      alt={importedImage.name || 'imported'}
                      loading="lazy"
                      decoding="async"
                      className={`h-full w-full object-contain transition-[filter,transform] duration-150 ease-out ${
                        isConnectionHoverTarget ? 'scale-[1.015] blur-[3px] brightness-75 saturate-90' : ''
                      }`}
                      draggable={false}
                    />
                    {seedanceReviewBadge ? (
                      <div className={`pointer-events-none absolute left-3 top-3 rounded-full border px-2 py-1 text-[11px] font-semibold backdrop-blur-sm ${seedanceReviewBadge.className}`}>
                        {seedanceReviewBadge.label}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="h-full w-full flex flex-col items-center justify-center">
                    <ImagePlus size={70} strokeWidth={1.5} className={`text-[#595D64] ${isCleanPanel ? '' : 'mb-6'}`} />
                    {!isCleanPanel && (
                      <div className="w-[76%]">
                        <p className="text-sm leading-none text-[#A3A7AF] mb-3">试试：</p>
                        <div className="space-y-2.5">
                          <button
                            type="button"
                            onClick={triggerImportImage}
                            className="flex items-center gap-3 text-[#D8DAE0] hover:text-white transition-colors"
                          >
                            <Upload size={14} />
                            <span className="text-sm leading-none">图生图</span>
                          </button>
                          <button className="flex items-center gap-3 text-[#D8DAE0] hover:text-white transition-colors">
                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-[4px] border border-[#A1A5AE] text-[12px] font-semibold">
                              HD
                            </span>
                            <span className="text-sm leading-none">图片高清</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {nodeGenerationPending && (
              <div
                className={`absolute inset-0 z-20 flex items-center justify-center overflow-hidden [&>p]:hidden ${
                  hasImportedImage ? 'rounded-[18px]' : 'rounded-[14px]'
                } bg-[#201b18]`}
              >
                {generationBackdropAsset?.src ? (
                  <img
                    src={generationBackdropAsset.src}
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
                    onClick={handleCancelGeneration}
                  >
                    取消
                  </button>
                </div>
                <p className="text-sm font-medium text-white/50">生成中...</p>
              </div>
            )}
            {isRegeneratingToNewNode && (
              <div className="pointer-events-none absolute right-3 top-3 rounded-full border border-white/[0.08] bg-black/58 px-3 py-1.5 text-[12px] font-semibold text-white/72 backdrop-blur-sm">
                生成新图中...
              </div>
            )}

            <motion.div
              className={`absolute -left-7 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-transparent border border-white/40 flex items-center justify-center text-[#B8BBC3] text-[11px] pointer-events-none transition-all duration-200 ease-out ${
                showInputHandleUi ? 'opacity-100' : 'opacity-0'
              }`}
              style={{ x: leftX, y: leftY, zIndex: 10 }}
            >
              <span className="leading-none relative -top-px">+</span>
            </motion.div>
            <motion.div
              className={`absolute -right-7 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-transparent border border-white/40 flex items-center justify-center text-[#B8BBC3] text-[11px] pointer-events-none transition-all duration-200 ease-out ${
                showHandleUi ? 'opacity-100' : 'opacity-0'
              }`}
              style={{ x: rightX, y: rightY, zIndex: 10 }}
            >
              <span className="leading-none relative -top-px">+</span>
            </motion.div>

            <Handle
              id="input"
              type="target"
              position={Position.Left}
              className={`node-handle-zone ${showInputHandleUi ? 'opacity-100' : 'opacity-0'}`}
              style={{ pointerEvents: showInputHandleUi ? 'auto' : 'none', zIndex: 20 }}
            />
            <Handle
              id="output"
              type="source"
              position={Position.Right}
              className={`node-handle-zone ${showHandleUi ? 'opacity-100' : 'opacity-0'}`}
              style={{ pointerEvents: showHandleUi ? 'auto' : 'none', zIndex: 20 }}
            />
          </div>
          </div>
        </div>

      {showDetailPanel && !isAssetLikeImageNode && (
        <div
          data-role="node-detail-panel"
          title={isMaximizedView ? '双击切换编辑区缩放' : undefined}
          className="nodrag absolute left-1/2 z-10 w-[760px] h-[230px] rounded-[18px] bg-[#202020] px-4 pt-4 pb-4 flex flex-col border border-white/[0.05]"
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
            if (!isMaximizedView) return;
            if (e.target.closest('textarea, input, select, button, a')) return;
            setMaximizedDetailBoost((v) => !v);
          }}
        >
          {isConnectionHoverTarget && <div className="connection-hover-glow" />}
          <div className="mb-3 flex h-[58px] shrink-0 items-center gap-3 overflow-hidden">
            <div className="flex shrink-0 items-center gap-2">
              {[
                { icon: Sparkles, label: '风格' },
                { icon: Tags, label: '标记' },
                { icon: Focus, label: '聚焦' },
              ].map(({ icon: Icon, label }) => (
                <button
                  key={label}
                  type="button"
                  className="flex h-[50px] w-[68px] flex-col items-center justify-center rounded-[12px] border border-white/[0.06] bg-white/[0.03] text-[#D6DAE2] transition-colors hover:bg-white/[0.06]"
                >
                  <Icon size={15} className="mb-1 text-[#AEB4BF]" />
                  <span className="text-[12px] leading-none">{label}</span>
                </button>
              ))}
            </div>

            <div className="min-w-0 flex-1 self-stretch">
                  {renderInputImageRefs({
                    sizeClass: 'h-14 w-14',
                    textClass: 'text-[12px]',
                    showLabel: false,
                    scrollerRef: inlineRefsScrollerRef,
                  })}
            </div>

            <button
              onClick={() => setShowPromptModal(true)}
              className="shrink-0 self-start text-[#9BA0A9] hover:text-white transition-colors"
              title="放大编辑"
            >
              <Expand size={16} />
            </button>
          </div>

          <div className="min-h-0 flex-1">
            <div className="relative w-full">
              {renderMentionMenu('inline')}
              {renderPromptMentionHighlight('inline', 'px-0 py-0 text-base leading-[1.5]')}
              <textarea
                ref={inlineTextareaRef}
                rows={4}
                value={prompt}
                onChange={(e) => handlePromptChange(e, 'inline')}
                onClick={(e) => handlePromptCursorChange(e, 'inline')}
                onKeyDown={(e) => handlePromptKeyDown(e, 'inline')}
                onScroll={() => syncPromptHighlightScroll('inline')}
                onWheelCapture={(e) => e.stopPropagation()}
                onPointerDownCapture={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDownCapture={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                placeholder="描述你想要生成的画面内容，按 / 唤出指令，输入 @ 引用素材"
                className="nodrag h-full min-h-0 w-full bg-transparent border-none px-0 py-0 text-base leading-[1.5] text-[#E7E8EC] placeholder:text-[#7D8088] focus:outline-none resize-none"
              />
            </div>
          </div>

          <div className="mt-3 flex shrink-0 items-center justify-between text-[#D8DAE0]">
            <div className="relative flex items-center gap-4 text-base leading-none">
              <div className="relative">
                <button
                  type="button"
                  data-model-trigger="true"
                  onClick={() => setShowModelMenu((v) => !v)}
                  className={`inline-flex h-11 items-center gap-2 rounded-[14px] border px-4 text-white transition-colors hover:bg-white/[0.12] ${
                    showModelMenu ? 'border-white/[0.22] bg-white/[0.12]' : 'border-transparent bg-transparent'
                  }`}
                >
                  <Sparkles size={16} />
                  <span className="text-[15px] font-semibold leading-none">{selectedModelLabel}</span>
                  <ChevronDown size={14} className={`text-[#80838C] transition-transform ${showModelMenu ? 'rotate-180' : ''}`} />
                </button>
                {showModelMenu && renderModelPanel(false)}
              </div>

              <button
                ref={inlineSizeTriggerRef}
                onClick={() => togglePresetMenu('inline')}
                data-size-trigger="true"
                className={`inline-flex h-11 items-center gap-2.5 rounded-[14px] border px-4 text-white transition-colors hover:bg-white/[0.12] ${
                  showPresetMenu
                    ? 'border-white/[0.22] bg-white/[0.12]'
                    : 'border-transparent bg-transparent'
                }`}
              >
                <span className="text-[15px] font-semibold leading-none">{renderRatioIndicator(ratio, true)}</span>
                <span className="text-[15px] font-semibold leading-none">{ratio}</span>
                <span className="text-[15px] leading-none text-[#a0a5ae]">·</span>
                <span className="text-[15px] font-semibold leading-none">{size}</span>
                <ChevronDown
                  size={14}
                  className={`text-[#B8BCC7] transition-transform ${showPresetMenu ? 'rotate-180' : ''}`}
                />
              </button>

              {renderPresetMenu && presetMenuMode === 'inline' && renderPresetPanel(false)}
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleTranslatePrompt}
                disabled={isTranslating || !prompt.trim()}
                className="text-sm text-[#DADCE2] transition-colors hover:text-white disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isTranslating ? '翻译中...' : '文A'}
              </button>
              <span className="text-base text-[#DADCE2]">1x</span>
              <span className="text-xs text-[#9AA0AB]">{'->'}</span>
              <span className="text-sm text-[#A2A8B2]">1</span>
              <button
                type="button"
                className="text-[#8f949d] transition-colors hover:text-white"
                onClick={() => setPrompt('')}
                title="清空描述"
              >
                <RotateCcw size={15} />
              </button>
              <button
                onClick={startGenerate}
                disabled={loading}
                className={`rounded-[10px] text-[#17181B] flex items-center justify-center transition-colors ${
                  loading
                    ? 'h-9 px-3 bg-[#9da1ab] cursor-not-allowed'
                    : 'w-9 h-9 bg-[#8C8F96] hover:bg-[#9A9EA6]'
                }`}
              >
                {loading ? (
                  <span className="text-xs font-semibold">生成中...</span>
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
            className="fixed inset-0 z-[60] bg-black/55 backdrop-blur-[1px] flex items-center justify-center"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setShowPromptModal(false);
            }}
          >
            <div
              className="nodrag w-[min(60vw,calc(57vh*16/9))] aspect-[16/9] rounded-2xl border border-white/[0.05] bg-[#202020] p-6 flex flex-col"
              onPointerDownCapture={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDownCapture={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-center justify-between">
                <span className="text-base text-[#DADCE2]">放大输入</span>
                <button
                  onClick={() => setShowPromptModal(false)}
                  className="text-sm text-[#A3A8B1] hover:text-white transition-colors"
                >
                  关闭
                </button>
              </div>

              <div className="mb-4 flex h-[68px] shrink-0 items-center gap-3 overflow-hidden">
                <div className="flex shrink-0 items-center gap-2">
                  {[
                    { icon: Sparkles, label: '风格' },
                    { icon: Tags, label: '标记' },
                    { icon: Focus, label: '聚焦' },
                  ].map(({ icon: Icon, label }) => (
                    <button
                      key={`modal-${label}`}
                      type="button"
                      className="flex h-[58px] w-[78px] flex-col items-center justify-center rounded-[14px] border border-white/[0.06] bg-white/[0.03] text-[#D6DAE2] transition-colors hover:bg-white/[0.06]"
                    >
                      <Icon size={16} className="mb-1 text-[#AEB4BF]" />
                      <span className="text-[12px] leading-none">{label}</span>
                    </button>
                  ))}
                </div>

                <div className="min-w-0 flex-1 self-stretch">
                  {renderInputImageRefs({
                    sizeClass: 'h-16 w-16',
                    textClass: 'text-[13px]',
                    showLabel: false,
                    scrollerRef: modalRefsScrollerRef,
                  })}
                </div>
              </div>

              <div className="relative min-h-0 flex-1">
                {renderMentionMenu('modal')}
                {renderPromptMentionHighlight('modal', 'rounded-none px-0 py-0 text-[17px] leading-[1.7]')}
                <textarea
                  ref={modalTextareaRef}
                  rows={10}
                  value={prompt}
                  onChange={(e) => handlePromptChange(e, 'modal')}
                  onClick={(e) => handlePromptCursorChange(e, 'modal')}
                  onKeyDown={(e) => handlePromptKeyDown(e, 'modal')}
                  onScroll={() => syncPromptHighlightScroll('modal')}
                  onWheelCapture={(e) => e.stopPropagation()}
                  onPointerDownCapture={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onMouseDownCapture={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  placeholder="描述你想要生成的画面内容，按 / 唤出指令，输入 @ 引用素材"
                  className="nodrag h-full min-h-0 w-full bg-transparent border-none rounded-none px-0 py-0 text-[17px] leading-[1.7] text-[#E7E8EC] placeholder:text-[#7D8088] focus:outline-none resize-none"
                />
              </div>

              <div className="mt-5 pt-4 border-t border-white/[0.06] flex items-center justify-between text-[#D8DAE0]">
                <div className="relative flex items-center gap-5 text-[17px] leading-none">
                  <div className="relative">
                    <button
                      type="button"
                      data-model-trigger="true"
                      onClick={() => setShowModelMenu((v) => !v)}
                      className={`inline-flex h-11 items-center gap-2 rounded-[14px] border px-4 text-white transition-colors hover:bg-white/[0.12] ${
                        showModelMenu ? 'border-white/[0.22] bg-white/[0.12]' : 'border-transparent bg-transparent'
                      }`}
                    >
                      <Sparkles size={16} />
                      <span className="text-[16px] font-semibold leading-none">{selectedModelLabel}</span>
                      <ChevronDown size={14} className={`text-[#80838C] transition-transform ${showModelMenu ? 'rotate-180' : ''}`} />
                    </button>
                    {showModelMenu && renderModelPanel(true)}
                  </div>

                  <button
                    ref={modalSizeTriggerRef}
                    onClick={() => togglePresetMenu('modal')}
                    data-size-trigger="true"
                    className={`inline-flex h-11 items-center gap-2.5 rounded-[14px] border px-4 text-white transition-colors hover:bg-white/[0.12] ${
                      showPresetMenu
                        ? 'border-white/[0.22] bg-white/[0.12]'
                        : 'border-transparent bg-transparent'
                    }`}
                  >
                    <span className="text-[16px] font-semibold leading-none">{renderRatioIndicator(ratio, true)}</span>
                    <span className="text-[16px] font-semibold leading-none">{ratio}</span>
                    <span className="text-[16px] leading-none text-[#a0a5ae]">·</span>
                    <span className="text-[16px] font-semibold leading-none">{size}</span>
                    <ChevronDown
                      size={14}
                      className={`text-[#B8BCC7] transition-transform ${showPresetMenu ? 'rotate-180' : ''}`}
                    />
                  </button>

                  {renderPresetMenu && presetMenuMode === 'modal' && renderPresetPanel(true)}
                </div>

                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={handleTranslatePrompt}
                    disabled={isTranslating || !prompt.trim()}
                    className="text-base text-[#DADCE2] transition-colors hover:text-white disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {isTranslating ? '翻译中...' : '文A'}
                  </button>
                  <span className="text-lg text-[#DADCE2]">1x</span>
                  <span className="text-sm text-[#9AA0AB]">{'->'}</span>
                  <span className="text-base text-[#A2A8B2]">1</span>
                  <button
                    type="button"
                    className="text-[#8f949d] transition-colors hover:text-white"
                    onClick={() => setPrompt('')}
                    title="清空描述"
                  >
                    <RotateCcw size={16} />
                  </button>
                  <button
                    onClick={startGenerate}
                    disabled={loading}
                    className={`rounded-[10px] text-[#17181B] flex items-center justify-center transition-colors ${
                      loading
                        ? 'h-10 px-4 bg-[#9da1ab] cursor-not-allowed'
                        : 'w-10 h-10 bg-[#8C8F96] hover:bg-[#9A9EA6]'
                    }`}
                  >
                    {loading ? (
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

      {showImagePreviewModal &&
        importedImage &&
        createPortal(
          <div
            className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-[1px] flex items-center justify-center"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setShowImagePreviewModal(false);
            }}
          >
            <div className="relative w-[min(92vw,1200px)] h-[min(88vh,860px)]">
              <button
                type="button"
                className="absolute right-3 top-3 z-10 rounded-md border border-white/15 bg-black/45 px-2 py-1 text-xs text-[#d7dae2] hover:text-white hover:bg-black/60 transition-colors"
                onClick={() => setShowImagePreviewModal(false)}
              >
                关闭
              </button>
              <img
                src={importedImage.src}
                alt={importedImage.name || 'preview'}
                loading="eager"
                decoding="async"
                className="h-full w-full object-contain"
                draggable={false}
              />
            </div>
          </div>,
          document.body
        )}

      {showGenerationInfo &&
        createPortal(
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

      {nodeContextMenu &&
        createPortal(
          <div
            data-image-node-context-menu="true"
            className="fixed z-[240] w-[220px] rounded-2xl border border-white/[0.06] bg-[#202020] p-2 shadow-[0_18px_44px_rgba(0,0,0,0.48)]"
            style={{ left: nodeContextMenu.left, top: nodeContextMenu.top }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                requestSaveToMaterialLibrary();
                setNodeContextMenu(null);
              }}
              className="flex h-10 w-full items-center rounded-xl px-3 text-left text-[14px] text-white transition-colors hover:bg-white/10"
            >
              保存到我的素材
            </button>
            <button
              type="button"
              disabled={seedanceFaceReviewPending}
              onClick={() => {
                setNodeContextMenu(null);
                void handleSeedanceFaceReview();
              }}
              className="mt-1 flex h-10 w-full items-center rounded-xl px-3 text-left text-[14px] text-white transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:text-white/38"
            >
              {seedanceFaceReviewPending
                ? '审核查询中...'
                : seedanceReviewStatus === 'approved' || seedanceReviewStatus === 'processing'
                  ? '查询审核状态'
                  : 'Seedance 2.0 人脸审核'}
            </button>
            {seedanceReviewStatus ? (
              <div className={`mt-1 rounded-xl px-3 py-2 text-[11px] leading-[1.4] ${
                seedanceReviewStatus === 'approved'
                  ? 'bg-[#1f3524] text-[#8ff0a0]'
                  : seedanceReviewStatus === 'failed'
                  ? 'bg-[#3b1f1f] text-[#ffb4b4]'
                  : 'bg-white/[0.05] text-white/52'
              }`}>
                {seedanceReviewMenuText}
              </div>
            ) : null}
          </div>,
          document.body
        )}

      {showAnnotationModal &&
        importedImage &&
        createPortal(
          <div
            className="fixed inset-0 z-[220] bg-[#111213] flex flex-col items-center justify-center"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="absolute top-6 left-7 text-[13px] text-white/35 flex items-center gap-1.5 pointer-events-none">
              <Pencil size={13} />
              标注
            </div>
            <div className="absolute top-6 left-1/2 z-[230] flex -translate-x-1/2 items-center gap-1.5 rounded-2xl border border-white/[0.08] bg-[#1e1e22] px-3 py-2 shadow-xl">
              <button
                type="button"
                onClick={() => setShowAnnotationModal(false)}
                className="flex h-8 w-8 items-center justify-center rounded-xl text-[#b0b3be] transition-colors hover:bg-white/10 hover:text-white"
              >
                <X size={15} />
              </button>
              <div className="h-4 w-px bg-white/10" />
              {ANNOTATION_TOOL_OPTIONS.map(({ id, label, Icon }) => {
                const active = annotationTool === id;
                return (
                  <button
                    key={id}
                    type="button"
                    title={label}
                    onClick={() => setAnnotationTool(id)}
                    className={`flex h-8 w-8 items-center justify-center rounded-xl transition-colors ${
                      active ? 'bg-white text-[#17181B]' : 'text-[#d8dae2] hover:bg-white/10'
                    }`}
                  >
                    <Icon size={15} />
                  </button>
                );
              })}
              <div className="h-4 w-px bg-white/10" />
              <div className="flex items-center gap-2 px-1">
                {ANNOTATION_COLOR_OPTIONS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    title={color}
                    onClick={() => setAnnotationColor(color)}
                    className={`h-5 w-5 rounded-full border-2 transition-transform ${
                      annotationColor === color ? 'scale-110 border-white' : 'border-white/15'
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
              <div className="h-4 w-px bg-white/10" />
              <input
                type="range"
                min="2"
                max="24"
                step="1"
                value={annotationBrushSize}
                onChange={(event) => setAnnotationBrushSize(Number(event.target.value))}
                className="h-2 w-28 accent-white"
              />
              <span className="w-8 text-center text-[12px] text-white/72">{annotationBrushSize}</span>
              <div className="h-4 w-px bg-white/10" />
              <button
                type="button"
                title="撤销"
                onClick={undoAnnotation}
                disabled={!annotationDraft && annotationUndoStack.length === 0}
                className="flex h-8 w-8 items-center justify-center rounded-xl text-[#d8dae2] transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:text-white/22 disabled:hover:bg-transparent"
              >
                <Undo2 size={15} />
              </button>
              <div className="h-4 w-px bg-white/10" />
              <button
                type="button"
                onClick={saveAnnotatedImage}
                className="h-8 rounded-xl bg-white px-4 text-[13px] font-semibold text-[#17181B] transition-colors hover:bg-white/90"
              >
                保存
              </button>
            </div>

            <div
              ref={annotationStageRef}
              className="relative mt-10 overflow-hidden rounded-[18px] border border-white/[0.08] bg-[#18191d] shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
              style={{ width: annotationDisplaySize.w, height: annotationDisplaySize.h, cursor: annotationTool === 'text' ? 'text' : 'crosshair' }}
              onPointerDown={startAnnotationInteraction}
            >
              <canvas
                ref={annotationCanvasRef}
                className="h-full w-full"
                style={{ width: annotationDisplaySize.w, height: annotationDisplaySize.h }}
              />
              {annotationDraft?.type === 'text' && annotationBaseImageRef.current && (
                <textarea
                  ref={annotationTextInputRef}
                  value={annotationDraft.text}
                  onChange={(event) =>
                    setAnnotationDraft((prev) =>
                      prev?.type === 'text' ? { ...prev, text: event.target.value } : prev
                    )
                  }
                  onBlur={() => commitAnnotationTextDraft()}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setAnnotationDraft(null);
                      setShowAnnotationModal(false);
                      return;
                    }
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      commitAnnotationTextDraft();
                    }
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  className="absolute min-w-[120px] max-w-[320px] resize-none overflow-hidden border-none bg-transparent p-0 text-left outline-none"
                  style={{
                    left: `${(annotationDraft.x / (annotationBaseImageRef.current.naturalWidth || annotationBaseImageRef.current.width || 1)) * annotationDisplaySize.w}px`,
                    top: `${(annotationDraft.y / (annotationBaseImageRef.current.naturalHeight || annotationBaseImageRef.current.height || 1)) * annotationDisplaySize.h}px`,
                    color: annotationDraft.color,
                    fontSize: `${Math.max(18, annotationDraft.size * 4) * (annotationDisplaySize.w / (annotationBaseImageRef.current.naturalWidth || annotationBaseImageRef.current.width || annotationDisplaySize.w))}px`,
                    lineHeight: 1.2,
                    textShadow: '0 1px 2px rgba(0,0,0,0.45)',
                  }}
                  placeholder="输入文字"
                  rows={1}
                />
              )}
            </div>
            <div className="mt-4 text-[12px] text-white/38">
              {annotationTool === 'text' ? '点击图片放置文字，保存后会生成一张带标注的新图片。' : '在图片上直接拖动即可标注，保存后会生成一张带标注的新图片。'}
            </div>
          </div>,
          document.body
        )}

      {/* 鈹€鈹€ Crop dropdown (portal so it's never clipped by node stacking) 鈹€鈹€ */}
      {showCropMenu && createPortal(
        <div
          data-crop-dropdown
          className="fixed z-[200] w-36 rounded-xl border border-white/[0.08] bg-[#1e1e22] shadow-2xl overflow-hidden py-1.5"
          style={{ top: cropMenuPos.top, left: cropMenuPos.left, transform: 'translateX(-50%)' }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {[
            { label: '高清',  icon: <Sparkles size={12} />,  active: false },
            { label: '扩图',  icon: <Maximize size={12} />,  active: false },
            { label: '重绘',  icon: <Pencil   size={12} />,  active: false },
            { label: '擦除',  icon: <Eraser   size={12} />,  active: false },
            { label: '抠图',  icon: <Scissors size={12} />,  active: false },
          ].map(({ label, icon }) => (
            <button
              key={label}
              type="button"
              className="w-full px-3 py-[7px] text-left text-[12.5px] text-[#e4e7ee] hover:bg-white/10 transition-colors flex items-center gap-2"
              onPointerDown={(e) => e.stopPropagation()}
            >
              {icon}{label}
            </button>
          ))}
          <div className="mx-3 my-1 h-px bg-white/[0.07]" />
          <button
            type="button"
            className="w-full px-3 py-[7px] text-left text-[12.5px] text-[#e4e7ee] hover:bg-white/10 transition-colors flex items-center gap-2"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setShowCropModal(true);
              setShowCropMenu(false);
            }}
          >
            <Crop size={12} />裁剪
          </button>
        </div>,
        document.body
      )}

      {/* 鈹€鈹€ Crop modal 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */}
      {showCropModal &&
        importedImage &&
        createPortal(
          <div
            className="fixed inset-0 z-[260] bg-[#111213] flex flex-col items-center justify-center select-none pb-28"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {/* Corner labels */}
            <div className="absolute top-6 left-7 text-[13px] text-white/35 flex items-center gap-1.5 pointer-events-none z-[1]">
              <ImageIcon size={13} />
              裁剪
            </div>
            <div className="absolute top-6 right-7 text-[13px] text-white/35 tabular-nums pointer-events-none z-[1]">
              {Math.max(1, Math.round(cropBox.w * (importedImage.width || 1)))} ×{' '}
              {Math.max(1, Math.round(cropBox.h * (importedImage.height || 1)))}
            </div>

            {/* Aspect ratio preset menu (opens upward from the bar) */}
            {showCropAspectMenu &&
              createPortal(
                <div
                  data-crop-aspect-menu
                  className="fixed z-[270] w-40 rounded-xl border border-white/[0.08] bg-[#25262c] py-1.5 shadow-2xl"
                  style={{
                    left: cropAspectMenuPos.left,
                    top: cropAspectMenuPos.top,
                    transform: 'translate(-50%, -100%)',
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {CROP_ASPECT_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={`w-full px-3 py-2.5 text-left text-[13px] flex items-center gap-2.5 transition-colors ${
                        cropAspectLabel === preset.label ? 'bg-white/10 text-white' : 'text-[#e4e7ee] hover:bg-white/10'
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        applyCropAspectPreset(preset);
                      }}
                    >
                      <span className="flex h-5 w-6 shrink-0 items-center justify-center">
                        {preset.id === 'original' && (
                          <span className="inline-flex h-4 w-4 rounded-[3px] border border-white/45" />
                        )}
                        {preset.id === '1:1' && (
                          <span className="inline-block h-3.5 w-3.5 rounded-[2px] border border-white/55" />
                        )}
                        {preset.id === '4:3' && (
                          <span className="inline-block h-3 w-4 rounded-[2px] border border-white/55" />
                        )}
                        {preset.id === '3:4' && (
                          <span className="inline-block h-4 w-3 rounded-[2px] border border-white/55" />
                        )}
                        {preset.id === '16:9' && (
                          <span className="inline-block h-2.5 w-4 rounded-[2px] border border-white/55" />
                        )}
                        {preset.id === '9:16' && (
                          <span className="inline-block h-4 w-2.5 rounded-[2px] border border-white/55" />
                        )}
                      </span>
                      {preset.label}
                    </button>
                  ))}
                </div>,
                document.body
              )}

            {/* Crop workspace */}
            <div
              ref={cropContainerRef}
              className="relative mt-10"
              style={{ width: cropDisplaySize.w, height: cropDisplaySize.h }}
            >
              {/* Source image 鈥?fills container exactly (no letterbox) */}
              <img
                src={importedImage.src}
                alt=""
                loading="eager"
                decoding="async"
                className="absolute inset-0 w-full h-full pointer-events-none"
                style={{ objectFit: 'fill' }}
                draggable={false}
              />

              {/* Semi-transparent overlays outside the crop box */}
              <div className="absolute inset-0 pointer-events-none">
                {/* top */}
                <div className="absolute left-0 right-0 top-0 bg-black/55"
                  style={{ height: `${cropBox.y * 100}%` }} />
                {/* bottom */}
                <div className="absolute left-0 right-0 bottom-0 bg-black/55"
                  style={{ height: `${(1 - cropBox.y - cropBox.h) * 100}%` }} />
                {/* left */}
                <div className="absolute bg-black/55"
                  style={{ top: `${cropBox.y * 100}%`, bottom: `${(1 - cropBox.y - cropBox.h) * 100}%`, left: 0, width: `${cropBox.x * 100}%` }} />
                {/* right */}
                <div className="absolute bg-black/55"
                  style={{ top: `${cropBox.y * 100}%`, bottom: `${(1 - cropBox.y - cropBox.h) * 100}%`, right: 0, width: `${(1 - cropBox.x - cropBox.w) * 100}%` }} />
              </div>

              {/* Crop box white border + 3x3 grid (visual only) */}
              <div
                className="absolute border border-white pointer-events-none"
                style={{
                  left:   `${cropBox.x * 100}%`,
                  top:    `${cropBox.y * 100}%`,
                  width:  `${cropBox.w * 100}%`,
                  height: `${cropBox.h * 100}%`,
                }}
              >
                <div className="absolute top-0 bottom-0 border-l border-white/30" style={{ left: '33.33%' }} />
                <div className="absolute top-0 bottom-0 border-l border-white/30" style={{ left: '66.66%' }} />
                <div className="absolute left-0 right-0 border-t border-white/30" style={{ top: '33.33%' }} />
                <div className="absolute left-0 right-0 border-t border-white/30" style={{ top: '66.66%' }} />
              </div>

              {/* Move zone 鈥?inset 14px from crop edges so corners take priority */}
              <div
                className="absolute cursor-move"
                style={{
                  left:   `calc(${cropBox.x * 100}% + 14px)`,
                  top:    `calc(${cropBox.y * 100}% + 14px)`,
                  right:  `calc(${(1 - cropBox.x - cropBox.w) * 100}% + 14px)`,
                  bottom: `calc(${(1 - cropBox.y - cropBox.h) * 100}% + 14px)`,
                }}
                onPointerDown={(e) => startCropDrag(e, 'move')}
              />

              {/* Corner handles */}
              {[
                { id: 'tl', cursor: 'nw-resize', x: cropBox.x,                y: cropBox.y },
                { id: 'tr', cursor: 'ne-resize', x: cropBox.x + cropBox.w,    y: cropBox.y },
                { id: 'bl', cursor: 'sw-resize', x: cropBox.x,                y: cropBox.y + cropBox.h },
                { id: 'br', cursor: 'se-resize', x: cropBox.x + cropBox.w,    y: cropBox.y + cropBox.h },
              ].map(({ id, cursor, x, y }) => (
                <div
                  key={id}
                  className={`absolute w-5 h-5 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center z-10 ${cursor}`}
                  style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
                  onPointerDown={(e) => startCropDrag(e, id)}
                >
                  <div className="w-2.5 h-2.5 rounded-full bg-white shadow-lg" />
                </div>
              ))}
            </div>

            {/* Bottom control bar: close | aspect ratio | confirm */}
            <div className="absolute bottom-8 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-2xl border border-white/[0.08] bg-[#1e1e22] px-3 py-2 shadow-xl">
              <button
                type="button"
                onClick={() => setShowCropModal(false)}
                className="flex h-8 w-8 items-center justify-center rounded-xl text-[#b0b3be] transition-colors hover:bg-white/10 hover:text-white"
              >
                <X size={15} />
              </button>
              <div className="h-4 w-px bg-white/10" />
              <button
                ref={cropAspectBtnRef}
                type="button"
                onClick={toggleCropAspectMenu}
                className={`flex h-8 items-center gap-1.5 rounded-xl px-3 text-[13px] transition-colors ${
                  showCropAspectMenu ? 'bg-white/14 text-white' : 'text-[#d8dae2] hover:bg-white/10'
                }`}
              >
                <Crop size={12} />
                {cropAspectLabel}
                <ChevronDown size={12} className="opacity-80" />
              </button>
              <div className="h-4 w-px bg-white/10" />
              <button
                type="button"
                onClick={applyCrop}
                className="h-8 rounded-xl bg-white px-5 text-[13px] font-semibold text-[#17181B] transition-colors hover:bg-white/90"
              >
                确认
              </button>
            </div>
          </div>,
          document.body
        )}
      </div>
      </CrispZoomRoot>
    </div>
  );
};

export default memo(AIImageNode);
