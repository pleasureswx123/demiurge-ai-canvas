import React, { useState, useCallback, useRef, useEffect, useMemo, useContext } from 'react';
import brandLogo from './assets/branding/logo.svg';
import ProjectDashboard from './features/projects/ProjectDashboard';
import { ProjectWorkspaceContext } from './store/ProjectWorkspaceContext';
import { 
  ReactFlow,
  Background, 
  Controls, 
  BaseEdge,
  getBezierPath,
  applyEdgeChanges, 
  applyNodeChanges,
  addEdge,
  BackgroundVariant,
  ConnectionLineType,
  Position,
  SelectionMode,
  useReactFlow,
  ReactFlowProvider,
  useUpdateNodeInternals,
  useViewport
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Image as ImageIcon,
  ImagePlus,
  Video,
  Type,
  Plus,
  Network,
  Folder,
  History,
  Clapperboard,
  Music2,
  ScrollText,
  Upload,
  Images,
  Menu,
  LayoutGrid,
} from 'lucide-react';
import AIImageNode from './features/nodes/AIImageNode';
import AIVideoNode from './features/nodes/AIVideoNode';
import AITextNode from './features/nodes/AITextNode';
import { materializeEphemeralAssetUrls } from './api/materializeProjectAssets';
import GroupPanelNode from './components/GroupPanelNode';
import MultiSelectToolbar from './components/MultiSelectToolbar';
import GroupToolbar from './components/GroupToolbar';
import MaterialLibraryPanel from './components/MaterialLibraryPanel';
import SaveToMaterialModal from './components/SaveToMaterialModal';
import {
  deleteMaterialLibraryItem,
  fetchMaterialLibraryItems,
  saveMaterialLibraryItem,
} from './api/materialLibraryApi';
import { CanvasUiContext } from './store/CanvasUiContext';
import HistoryPanel from './components/HistoryPanel';
import {
  clearConnectionHoverTarget,
  setConnectionHoverTarget,
} from './store/ConnectionHoverStore';
import { setNodeUiState } from './store/NodeUiStore';
import { nodeApi } from './api/routes';
import { normalizeFlowAssetUrls } from './api/assetUrls';

/** 与画布节点面板一致：中性深灰，不偏蓝 */
const PANEL_SURFACE = 'bg-[#202020]';
const PANEL_MENU = 'bg-[#262626]';
const BRAND_MENU_OPEN_DELAY_MS = Math.round((1000 / 60) * 5);

const nodeTypes = {
  AIImageNode: AIImageNode,
  AIVideoNode: AIVideoNode,
  AITextNode: AITextNode,
  GroupPanelNode: GroupPanelNode,
};

const ASSET_NODE_TYPES = new Set(['AIImageNode', 'AIVideoNode']);

const EDGE_ATTACH_OVERLAP = 34;
const NODE_DRAG_HANDLE_SELECTOR = '.node-drag-handle';

/** Same width + gap as bulk canvas import — used by L-key arrange */
const CANVAS_NODE_LAYOUT_W = 408;
const CANVAS_NODE_LAYOUT_GAP = 40;
const MATERIAL_LIBRARY_DRAG_MIME = 'application/x-demiurge-material-library-item';
const AUTOSAVE_DEBOUNCE_MS = 20000;
const AUTOSAVE_IDLE_TIMEOUT_MS = 2000;
const DEFAULT_WORKSPACE_VIEWPORT = { x: 0, y: 0, zoom: 0.85 };
const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));
const getSafeViewportZoom = (zoom) => clampNumber(Number(zoom) || 1, 0.08, 5);
const getEditorBarReadabilityBoost = (zoom) => {
  const z = getSafeViewportZoom(zoom);
  return 1 + clampNumber((0.9 - z) / 0.45, 0, 1) * 0.45;
};
const getEditorBarZoomScale = (zoom) =>
  clampNumber((1 / getSafeViewportZoom(zoom)) * getEditorBarReadabilityBoost(zoom), 0.55, 6);
const getTopEditorBarY = (zoom, height = 40, headerFlowHeight = 32, screenGap = 10) =>
  -(height + headerFlowHeight + screenGap / getSafeViewportZoom(zoom));
const getEditorPanelGap = (zoom, screenGap = 24) => screenGap / getSafeViewportZoom(zoom);

const areStringArraysEqual = (a = [], b = []) => {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

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

const adjustAnchorForOverlap = (x, y, position, overlap = EDGE_ATTACH_OVERLAP) => {
  if (position === Position.Left) return { x: x + overlap, y };
  if (position === Position.Right) return { x: x - overlap, y };
  if (position === Position.Top) return { x, y: y + overlap };
  if (position === Position.Bottom) return { x, y: y - overlap };
  return { x, y };
};

const NormalEdge = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
}) => {
  const adjustedSource = adjustAnchorForOverlap(sourceX, sourceY, sourcePosition);
  const adjustedTarget = adjustAnchorForOverlap(targetX, targetY, targetPosition);
  const [edgePath] = getBezierPath({
    sourceX: adjustedSource.x,
    sourceY: adjustedSource.y,
    targetX: adjustedTarget.x,
    targetY: adjustedTarget.y,
    sourcePosition,
    targetPosition,
  });

  return <BaseEdge path={edgePath} style={style} markerEnd={markerEnd} />;
};

const EnergyEdgePaths = ({ path, preview = false }) => (
  <g className={preview ? 'edge-energy-preview' : 'edge-energy'}>
    <path d={path} className="edge-energy-base" fill="none" />
    <path d={path} className="edge-energy-glow" fill="none" />
    <path
      d={path}
      className={`edge-energy-strand ${preview ? 'edge-energy-strand-preview' : 'edge-energy-strand-main'}`}
      fill="none"
    />
    <path
      d={path}
      className={`edge-energy-tail ${preview ? 'edge-energy-tail-preview' : 'edge-energy-tail-main'}`}
      fill="none"
    />
  </g>
);

const edgeTypes = {
  default: NormalEdge,
  energy: ({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }) => {
    const lockedFrom = data?.lockedFrom;
    const lockedTo = data?.lockedTo;
    const rawSourceX = lockedFrom?.x ?? sourceX;
    const rawSourceY = lockedFrom?.y ?? sourceY;
    const rawTargetX = lockedTo?.x ?? targetX;
    const rawTargetY = lockedTo?.y ?? targetY;
    const resolvedSourcePosition = data?.lockedSourcePosition ?? sourcePosition;
    const resolvedTargetPosition = data?.lockedTargetPosition ?? targetPosition;
    const adjustedSource = lockedFrom
      ? { x: rawSourceX, y: rawSourceY }
      : adjustAnchorForOverlap(rawSourceX, rawSourceY, resolvedSourcePosition);
    const adjustedTarget = lockedTo
      ? { x: rawTargetX, y: rawTargetY }
      : adjustAnchorForOverlap(rawTargetX, rawTargetY, resolvedTargetPosition);
    const [edgePath] = getBezierPath({
      sourceX: adjustedSource.x,
      sourceY: adjustedSource.y,
      targetX: adjustedTarget.x,
      targetY: adjustedTarget.y,
      sourcePosition: resolvedSourcePosition,
      targetPosition: resolvedTargetPosition,
    });

    return (
      <EnergyEdgePaths path={edgePath} />
    );
  },
};

const EnergyConnectionLine = ({ fromX, fromY, toX, toY, fromPosition, toPosition }) => {
  const [edgePath] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    targetX: toX,
    targetY: toY,
    sourcePosition: fromPosition,
    targetPosition: toPosition,
  });

  return (
    <EnergyEdgePaths path={edgePath} preview />
  );
};

class FlowErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[FlowErrorBoundary]', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-[#181818] px-6 text-white">
          <div className="w-full max-w-[720px] rounded-2xl border border-white/[0.08] bg-[#202020] p-6 shadow-2xl">
            <div className="text-[18px] font-semibold">画布加载失败</div>
            <p className="mt-3 text-sm leading-6 text-white/72">
              已拦截到一个旧工程兼容错误，当前不会再整页黑屏。把下面这段报错发给我，我会继续直接修掉。
            </p>
            <pre className="mt-4 overflow-auto rounded-xl bg-black/30 p-4 text-xs leading-6 text-[#ffb4b4]">
              {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
            </pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const initialNodes = [];

const sanitizeNodeInputRefs = (value) =>
  Array.isArray(value)
    ? value.filter((item) => item && typeof item.src === 'string' && item.src.trim())
    : [];

const sanitizeFlowNode = (node) => {
  if (!node || typeof node !== 'object' || !node.id || !node.type) return null;
  const data = node.data && typeof node.data === 'object' ? { ...node.data } : {};
  if ('inputImageRefs' in data) {
    data.inputImageRefs = sanitizeNodeInputRefs(data.inputImageRefs);
  }
  if ('inputVideoRefs' in data) {
    data.inputVideoRefs = sanitizeNodeInputRefs(data.inputVideoRefs);
  }
  return {
    ...node,
    data,
  };
};

const resolveInitialEdgesFromFlow = (flow) => {
  const list = flow?.edges;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (edge) =>
      edge &&
      typeof edge === 'object' &&
      typeof edge.source === 'string' &&
      edge.source &&
      typeof edge.target === 'string' &&
      edge.target
  );
};

const syncGeneratedNodeIdCounter = (nodes) => {
  if (!Array.isArray(nodes) || !nodes.length) return;
  let maxNodeNumber = 1;
  for (const node of nodes) {
    const match = /^node_(\d+)$/.exec(String(node?.id || ''));
    if (!match) continue;
    const numericId = Number(match[1]);
    if (Number.isFinite(numericId)) {
      maxNodeNumber = Math.max(maxNodeNumber, numericId);
    }
  }
  id = Math.max(id, maxNodeNumber + 1);
};

const resolveInitialNodesFromFlow = (flow) => {
  const list = flow?.nodes;
  if (Array.isArray(list)) {
    const sanitized = list.map(sanitizeFlowNode).filter(Boolean);
    syncGeneratedNodeIdCounter(sanitized);
    return sanitized;
  }
  return initialNodes;
};

let id = 2;
const getId = (existingNodes = []) => {
  syncGeneratedNodeIdCounter(existingNodes);
  return `node_${id++}`;
};

const getEdgeSignature = (edge) =>
  `${edge.source}|${edge.target}|${edge.sourceHandle || 'output'}|${edge.targetHandle || 'input'}`;

const duplicateConnectedEdges = ({ edgesToCopy, idMap, existingEdges = [] }) => {
  const existingKeys = new Set(existingEdges.map(getEdgeSignature));
  const nonce = Date.now();

  return (edgesToCopy || []).reduce((result, edge, index) => {
    const source = idMap.get(edge.source) || edge.source;
    const target = idMap.get(edge.target) || edge.target;
    if (!source || !target || source === target) return result;

    const signature = getEdgeSignature({
      source,
      target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
    });
    if (existingKeys.has(signature)) return result;
    existingKeys.add(signature);

    result.push({
      ...edge,
      id: `e-${source}-${target}-${nonce}-${index}`,
      source,
      target,
      selected: true,
    });
    return result;
  }, []);
};

const MEDIA_FILE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov|mkv|avi|m4v)$/i;

const isSupportedMediaFile = (file) => {
  if (!file) return false;
  const type = String(file.type || '').toLowerCase();
  if (type.startsWith('image/') || type.startsWith('video/')) return true;
  return MEDIA_FILE_EXTENSION_RE.test(String(file.name || ''));
};

const safeDecodeUriPart = (value) => {
  try {
    return decodeURIComponent(String(value ?? ''));
  } catch {
    return null;
  }
};

const boundsIntersect = (a, b) => {
  if (!a || !b) return false;
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
};

const isViewportLikelyOffscreen = ({ viewport, nodes, containerWidth, containerHeight }) => {
  if (
    !viewport ||
    !Number.isFinite(viewport.x) ||
    !Number.isFinite(viewport.y) ||
    !Number.isFinite(viewport.zoom) ||
    viewport.zoom <= 0 ||
    !Array.isArray(nodes) ||
    !nodes.length ||
    !Number.isFinite(containerWidth) ||
    !Number.isFinite(containerHeight) ||
    containerWidth <= 0 ||
    containerHeight <= 0
  ) {
    return false;
  }

  const visibleRect = {
    minX: -viewport.x / viewport.zoom,
    minY: -viewport.y / viewport.zoom,
    maxX: (containerWidth - viewport.x) / viewport.zoom,
    maxY: (containerHeight - viewport.y) / viewport.zoom,
  };

  const nodeBounds = nodes.reduce(
    (acc, node) => {
      const x = Number(node?.position?.x);
      const y = Number(node?.position?.y);
      const width = Number(node?.measured?.width ?? node?.width ?? 408);
      const height = Number(node?.measured?.height ?? node?.height ?? 298);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return acc;
      return {
        minX: Math.min(acc.minX, x),
        minY: Math.min(acc.minY, y),
        maxX: Math.max(acc.maxX, x + (Number.isFinite(width) ? width : 408)),
        maxY: Math.max(acc.maxY, y + (Number.isFinite(height) ? height : 298)),
      };
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  );

  if (!Number.isFinite(nodeBounds.minX)) return false;

  const paddingX = Math.max(240, (nodeBounds.maxX - nodeBounds.minX) * 0.12);
  const paddingY = Math.max(180, (nodeBounds.maxY - nodeBounds.minY) * 0.12);
  const paddedNodeBounds = {
    minX: nodeBounds.minX - paddingX,
    minY: nodeBounds.minY - paddingY,
    maxX: nodeBounds.maxX + paddingX,
    maxY: nodeBounds.maxY + paddingY,
  };

  return !boundsIntersect(visibleRect, paddedNodeBounds);
};

const collectProjectAssetPathsFromNodes = (nodes, slug) => {
  const paths = new Set();
  if (!slug || !Array.isArray(nodes)) return paths;

  const pushSrc = (src) => {
    if (typeof src !== 'string' || !src.trim()) return;
    let pathname = '';
    try {
      pathname = new URL(src, window.location.origin).pathname || '';
    } catch {
      return;
    }

    const readRelativePath = (prefix) => {
      if (!pathname.startsWith(prefix)) return null;
      const segments = pathname
        .slice(prefix.length)
        .split('/')
        .filter(Boolean)
        .map((seg) => safeDecodeUriPart(seg));
      if (segments.length < 2 || segments.some((seg) => !seg)) return null;
      if (segments[0] !== slug) return null;
      return segments.slice(1).join('/');
    };

    const relPath =
      readRelativePath('/api/node/project/media/') ||
      readRelativePath('/api/project/media/') ||
      readRelativePath('/api/video-file/') ||
      readRelativePath('/api/media/video-file/');
    if (relPath) {
      paths.add(relPath);
    }
  };

  for (const node of nodes) {
    const data = node?.data;
    if (!data) continue;
    pushSrc(data.imageAsset?.src);
    pushSrc(data.capturedFrame?.src);
    pushSrc(data.capturedClip?.src);
    pushSrc(data.generatedVideo?.src);
  }

  return paths;
};
const normalEdgeStyle = {
  stroke: 'rgba(214, 222, 236, 0.66)',
  strokeWidth: 2.8,
};
const activeEdgeStyle = {
  stroke: 'rgba(238, 244, 255, 0.82)',
  strokeWidth: 4.2,
};

const CONNECTION_MENU_ITEMS = [
  { id: 'Image', label: '图片', icon: ImageIcon },
  { id: 'Video', label: '视频', icon: Video },
  { id: 'Text', label: '文本生成', icon: Type },
  { id: 'Logic', label: '逻辑判断', icon: Network },
];

const resolveNodeType = (nodeType) => {
  if (nodeType === 'Video') return 'AIVideoNode';
  if (nodeType === 'Text') return 'AITextNode';
  return 'AIImageNode';
};

const getPendingConnectionSourceIds = (pendingConnection) => {
  if (Array.isArray(pendingConnection?.sourceNodeIds) && pendingConnection.sourceNodeIds.length) {
    return Array.from(new Set(pendingConnection.sourceNodeIds.filter(Boolean)));
  }
  if (pendingConnection?.sourceNodeId) {
    return [pendingConnection.sourceNodeId];
  }
  return [];
};

const getPendingConnectionGhostNodeIds = (pendingConnection) => {
  if (Array.isArray(pendingConnection?.ghostNodeIds) && pendingConnection.ghostNodeIds.length) {
    return pendingConnection.ghostNodeIds.filter(Boolean);
  }
  if (pendingConnection?.ghostNodeId) {
    return [pendingConnection.ghostNodeId];
  }
  return [];
};

const getPendingConnectionTempEdgeIds = (pendingConnection) => {
  if (Array.isArray(pendingConnection?.tempEdgeIds) && pendingConnection.tempEdgeIds.length) {
    return pendingConnection.tempEdgeIds.filter(Boolean);
  }
  if (pendingConnection?.tempEdgeId) {
    return [pendingConnection.tempEdgeId];
  }
  return [];
};

function Flow() {
  const projectWorkspace = useContext(ProjectWorkspaceContext);
  const reactFlowWrapper = useRef(null);
  const drawerCloseTimeoutRef = useRef(null);
  const edgeHoverTimerRef = useRef(null);
  const edgeHoverPointRef = useRef(null);
  const selectionStartFlowRef = useRef(null);
  const clipboardRef = useRef(null);
  const pasteStepRef = useRef(0);
  const pasteAnchorFlowRef = useRef(null);
  // True only while the user is actively dragging a handle — prevents
  // spurious onConnect calls that can fire after node creation.
  const isUserConnectingRef  = useRef(false);
  const bulkUploadInputRef   = useRef(null);
  const paneMenuOriginRef    = useRef({ x: 0, y: 0 });
  const undoStackRef         = useRef([]); // [{nodes, edges}] max 10
  const nodesRef             = useRef([]);
  const edgesRef             = useRef([]);
  const latestSaveRequestRef = useRef(0);
  const updateNodeInternals  = useUpdateNodeInternals();
  const [nodes, setNodes] = useState(() => resolveInitialNodesFromFlow(projectWorkspace.initialFlow));
  const [edges, setEdges] = useState(() => resolveInitialEdgesFromFlow(projectWorkspace.initialFlow));
  const [projectNameDraft, setProjectNameDraft] = useState(() => projectWorkspace.name || '');
  /** 鼠标在放大后的品牌热区内 */
  const [brandHotZone, setBrandHotZone] = useState(false);
  /** 热区内延迟约 5 帧后再展开菜单 */
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const brandMenuTimerRef = useRef(null);

  useEffect(() => {
    if (!brandHotZone) {
      if (brandMenuTimerRef.current != null) {
        window.clearTimeout(brandMenuTimerRef.current);
        brandMenuTimerRef.current = null;
      }
      setBrandMenuOpen(false);
      return;
    }
    brandMenuTimerRef.current = window.setTimeout(() => {
      setBrandMenuOpen(true);
      brandMenuTimerRef.current = null;
    }, BRAND_MENU_OPEN_DELAY_MS);
    return () => {
      if (brandMenuTimerRef.current != null) {
        window.clearTimeout(brandMenuTimerRef.current);
        brandMenuTimerRef.current = null;
      }
    };
  }, [brandHotZone]);
  const [menu, setMenu] = useState(null);
  const [paneContextMenu, setPaneContextMenu] = useState(null);
  const [pendingConnection, setPendingConnection] = useState(null);
  const [connectStart, setConnectStart] = useState(null);
  const [uiDismissToken, setUiDismissToken] = useState(0);
  const [maximizedViewNodeId, setMaximizedViewNodeId] = useState(null);
  const [singleSelectedNodeId, setSingleSelectedNodeId] = useState(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState([]);
  const [focusedNodeId, setFocusedNodeId] = useState(null);
  const [textEditingNodeId, setTextEditingNodeId] = useState(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState(null);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState([]);
  const [activeTab, setActiveTab] = useState('nodes');
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [materialLibraryItems, setMaterialLibraryItems] = useState([]);
  const [materialLibraryLoading, setMaterialLibraryLoading] = useState(false);
  const [materialLibraryError, setMaterialLibraryError] = useState('');
  const [materialLibraryCategory, setMaterialLibraryCategory] = useState('all');
  const [deletingMaterialLibraryItemId, setDeletingMaterialLibraryItemId] = useState(null);
  const [historyItems, setHistoryItems] = useState([]);
  const [historyCounts, setHistoryCounts] = useState({ image: 0, video: 0 });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [pendingMaterialLibrarySave, setPendingMaterialLibrarySave] = useState(null);
  const [isSavingMaterialLibraryItem, setIsSavingMaterialLibraryItem] = useState(false);
  const [isConnectingFromSource, setIsConnectingFromSource] = useState(false);
  const [bulkConnectState, setBulkConnectState] = useState(null);
  const { screenToFlowPosition, setCenter, getNodesBounds, flowToScreenPosition, getInternalNode, fitView, getViewport, setViewport } =
    useReactFlow();
  const viewport = useViewport();
  const editorBarViewportVars = useMemo(
    () => ({
      '--node-editor-scale': getEditorBarZoomScale(viewport.zoom),
      '--node-top-toolbar-y': `${getTopEditorBarY(viewport.zoom)}px`,
      '--node-bottom-panel-gap': `${getEditorPanelGap(viewport.zoom)}px`,
    }),
    [viewport.zoom]
  );

  useEffect(() => {
    setNodeUiState({
      uiDismissToken,
      singleSelectedNodeId,
      focusedNodeId,
      textEditingNodeId,
      maximizedViewNodeId,
    });
  }, [focusedNodeId, maximizedViewNodeId, singleSelectedNodeId, textEditingNodeId, uiDismissToken]);

  const highlightedNodeId = focusedNodeId ?? singleSelectedNodeId;
  const visibleConnectionMenuItems = useMemo(() => {
    const allowedTypes = pendingConnection?.allowedNodeTypes;
    if (!Array.isArray(allowedTypes) || !allowedTypes.length) return CONNECTION_MENU_ITEMS;
    return CONNECTION_MENU_ITEMS.filter((item) => allowedTypes.includes(item.id));
  }, [pendingConnection]);

  // Keep refs in sync so undo callbacks never have stale closures
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  const selectedNodeIdsRef = useRef(selectedNodeIds);
  const selectedEdgeIdsRef = useRef(selectedEdgeIds);
  const singleSelectedNodeIdRef = useRef(singleSelectedNodeId);
  const focusedNodeIdRef = useRef(focusedNodeId);
  const textEditingNodeIdRef = useRef(textEditingNodeId);
  useEffect(() => { selectedNodeIdsRef.current = selectedNodeIds; }, [selectedNodeIds]);
  useEffect(() => { selectedEdgeIdsRef.current = selectedEdgeIds; }, [selectedEdgeIds]);
  useEffect(() => { singleSelectedNodeIdRef.current = singleSelectedNodeId; }, [singleSelectedNodeId]);
  useEffect(() => { focusedNodeIdRef.current = focusedNodeId; }, [focusedNodeId]);
  useEffect(() => { textEditingNodeIdRef.current = textEditingNodeId; }, [textEditingNodeId]);

  const persistNodeData = useCallback((nodeId, patch) => {
    if (!nodeId || !patch || typeof patch !== 'object') return;
    const patchNodes = (nds) => {
      let changed = false;
      const nextNodes = nds.map((node) => {
        if (node.id !== nodeId) return node;
        if (isNodeDataPatchUnchanged(node.data, patch)) return node;
        changed = true;
        return {
          ...node,
          data: {
            ...(node.data || {}),
            ...patch,
          },
        };
      });
      return changed ? nextNodes : nds;
    };
    nodesRef.current = patchNodes(nodesRef.current);
    setNodes((nds) => {
      const nextNodes = patchNodes(nds);
      nodesRef.current = nextNodes;
      return nextNodes;
    });
  }, []);

  const syncMaterializedAssetUrlsToLiveNodes = useCallback((expectedEphemeralSrcByNodeId, materializedNodes) => {
    if (!(expectedEphemeralSrcByNodeId instanceof Map) || !expectedEphemeralSrcByNodeId.size) return;
    if (!Array.isArray(materializedNodes) || !materializedNodes.length) return;

    const materializedById = new Map(materializedNodes.map((node) => [node.id, node]));
    setNodes((nds) => {
      let changed = false;

      const nextNodes = nds.map((node) => {
        const expectedFields = expectedEphemeralSrcByNodeId.get(node.id);
        const materializedNode = materializedById.get(node.id);
        if (!expectedFields || !materializedNode?.data) return node;

        let nodeChanged = false;
        let nextData = node.data || {};

        for (const [field, expectedSrc] of Object.entries(expectedFields)) {
          const liveAsset = nextData?.[field];
          const materializedAsset = materializedNode.data?.[field];
          const liveSrc = typeof liveAsset?.src === 'string' ? liveAsset.src.trim() : '';
          const materializedSrc = typeof materializedAsset?.src === 'string' ? materializedAsset.src.trim() : '';

          if (!liveSrc || liveSrc !== expectedSrc || !materializedSrc || materializedSrc === expectedSrc) continue;

          if (!nodeChanged) {
            nextData = { ...(node.data || {}) };
          }
          nextData[field] = {
            ...(liveAsset || {}),
            ...materializedAsset,
          };
          nodeChanged = true;
        }

        if (!nodeChanged) return node;
        changed = true;
        return {
          ...node,
          data: nextData,
        };
      });

      return changed ? nextNodes : nds;
    });
  }, []);

  const refreshMaterialLibrary = useCallback(async () => {
    setMaterialLibraryLoading(true);
    setMaterialLibraryError('');
    try {
      const items = await fetchMaterialLibraryItems();
      setMaterialLibraryItems(items);
    } catch (error) {
      setMaterialLibraryError(error instanceof Error ? error.message : '读取素材库失败');
    } finally {
      setMaterialLibraryLoading(false);
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const res = await fetch(nodeApi('/project/history'));
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || '读取历史记录失败');
      }
      setHistoryItems(Array.isArray(payload.items) ? payload.items : []);
      setHistoryCounts({
        image: Number(payload.counts?.image || 0),
        video: Number(payload.counts?.video || 0),
      });
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '读取历史记录失败');
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const openSaveToMaterialModal = useCallback((draft) => {
    if (!draft?.asset?.src) return;
    setPendingMaterialLibrarySave({
      ...draft,
      defaultName: String(draft.defaultName || '').trim() || '素材',
    });
  }, []);

  const closeSaveToMaterialModal = useCallback(() => {
    if (isSavingMaterialLibraryItem) return;
    setPendingMaterialLibrarySave(null);
  }, [isSavingMaterialLibraryItem]);

  const handleDeleteMaterialLibraryItem = useCallback(
    async (item) => {
      if (!item?.id || deletingMaterialLibraryItemId) return;
      setDeletingMaterialLibraryItemId(item.id);
      try {
        await deleteMaterialLibraryItem(item.id);
        setMaterialLibraryItems((prev) => prev.filter((entry) => entry.id !== item.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : '删除素材失败';
        if (message.includes('不存在') || message.includes('已删除')) {
          setMaterialLibraryItems((prev) => prev.filter((entry) => entry.id !== item.id));
          await refreshMaterialLibrary();
        } else {
          window.alert(message);
        }
      } finally {
        setDeletingMaterialLibraryItemId(null);
      }
    },
    [deletingMaterialLibraryItemId, refreshMaterialLibrary]
  );

  const materialLibraryVisibleItems = useMemo(() => {
    if (materialLibraryCategory === 'all') return materialLibraryItems;
    return materialLibraryItems.filter((item) => item.category === materialLibraryCategory);
  }, [materialLibraryCategory, materialLibraryItems]);

  useEffect(() => {
    void refreshMaterialLibrary();
  }, [refreshMaterialLibrary]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    if (activeTab === 'assets' && isDrawerOpen) {
      void refreshMaterialLibrary();
    }
  }, [activeTab, isDrawerOpen, refreshMaterialLibrary]);

  useEffect(() => {
    if (activeTab === 'history' && isDrawerOpen) {
      void refreshHistory();
    }
  }, [activeTab, isDrawerOpen, refreshHistory]);

  useEffect(() => {
    setNodes((nds) => {
      let changed = false;
      const next = nds.map((node) => {
        const expectedDragHandle =
          node.type === 'GroupPanelNode' ||
          node.type === 'AIImageNode' ||
          node.type === 'AIVideoNode' ||
          node.type === 'AITextNode'
            ? NODE_DRAG_HANDLE_SELECTOR
            : node.dragHandle;
        if (node.dragHandle === expectedDragHandle) return node;
        changed = true;
        return { ...node, dragHandle: expectedDragHandle };
      });
      return changed ? next : nds;
    });
  }, []);

  const requestProjectAssetCleanup = useCallback(
    async (paths) => {
      const slug = projectWorkspace.slug;
      if (!slug || !Array.isArray(paths) || !paths.length) return;
      try {
        const res = await fetch(nodeApi('/project/cleanup-assets'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, paths }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `cleanup failed (${res.status})`);
        }
      } catch (error) {
        console.error('[project cleanup-assets]', error);
      }
    },
    [projectWorkspace.slug]
  );

  const cleanupEvictedSnapshotAssets = useCallback(
    (evictedSnapshot, remainingSnapshots) => {
      const slug = projectWorkspace.slug;
      if (!slug || !Array.isArray(evictedSnapshot?.nodes)) return;

      const candidatePaths = collectProjectAssetPathsFromNodes(evictedSnapshot.nodes, slug);
      if (!candidatePaths.size) return;

      const protectedPaths = new Set();
      for (const snapshot of remainingSnapshots) {
        const snapshotPaths = collectProjectAssetPathsFromNodes(snapshot?.nodes, slug);
        for (const assetPath of snapshotPaths) {
          protectedPaths.add(assetPath);
        }
      }

      const stalePaths = [...candidatePaths].filter((assetPath) => !protectedPaths.has(assetPath));
      if (stalePaths.length) {
        void requestProjectAssetCleanup(stalePaths);
      }
    },
    [projectWorkspace.slug, requestProjectAssetCleanup]
  );

  const saveSnapshot = useCallback(() => {
    const snap = { nodes: nodesRef.current, edges: edgesRef.current };
    const nextBase = [...undoStackRef.current, snap];
    const evictedSnapshot = nextBase.length > 10 ? nextBase[0] : null;
    const nextStack = nextBase.slice(-10);
    undoStackRef.current = nextStack;
    if (evictedSnapshot) {
      cleanupEvictedSnapshotAssets(evictedSnapshot, nextStack);
    }
  }, [cleanupEvictedSnapshotAssets]);

  const undo = useCallback(() => {
    if (!undoStackRef.current.length) return;
    const stack = [...undoStackRef.current];
    const snap  = stack.pop();
    undoStackRef.current = stack;
    setNodes(snap.nodes);
    setEdges(snap.edges);
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setSingleSelectedNodeId(null);
    setFocusedNodeId(null);
    setTextEditingNodeId(null);
  }, []);

  useEffect(() => {
    const v = projectWorkspace.initialFlow?.viewport;
    const hasSavedViewport =
      v &&
      typeof v.x === 'number' &&
      typeof v.y === 'number' &&
      typeof v.zoom === 'number';
    const savedViewport = hasSavedViewport ? v : DEFAULT_WORKSPACE_VIEWPORT;

    const applyInitialViewport = () => {
      const container = reactFlowWrapper.current;
      const containerWidth = container?.clientWidth || window.innerWidth || 0;
      const containerHeight = container?.clientHeight || window.innerHeight || 0;
      const shouldRefit =
        Array.isArray(nodesRef.current) &&
        nodesRef.current.length > 0 &&
        isViewportLikelyOffscreen({
          viewport: savedViewport,
          nodes: nodesRef.current,
          containerWidth,
          containerHeight,
        });

      if (shouldRefit) {
        fitView({
          padding: 0.22,
          minZoom: 0.12,
          maxZoom: 1.2,
          duration: 0,
        });
        return;
      }

      setViewport(savedViewport);
    };

    requestAnimationFrame(() => {
      applyInitialViewport();
    });
    // 仅在工作区首次挂载时恢复存档视角（打开工程 / 新建后进入）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveProjectNow = useCallback(
    async (opts) => {
      const slug = projectWorkspace.slug;
      if (!slug) return;
      const saveIssuedAt = new Date().toISOString();
      const saveRequestId = ++latestSaveRequestRef.current;
      const stripNodeForSave = (n) => {
        const { selected, dragging, ...rest } = n;
        return rest;
      };
      const stripEdgeForSave = (e) => {
        const { selected, ...rest } = e;
        return rest;
      };
      let flowNodes;
      try {
        const clone = JSON.parse(JSON.stringify(nodesRef.current));
        const expectedEphemeralSrcByNodeId = new Map();
        clone.forEach((node) => {
          const fieldNames =
            node?.type === 'AIImageNode'
              ? ['imageAsset', 'capturedFrame']
              : node?.type === 'AIVideoNode'
                ? ['generatedVideo', 'capturedClip']
                : [];
          const expectedFields = {};

          fieldNames.forEach((field) => {
            const src = typeof node?.data?.[field]?.src === 'string' ? node.data[field].src.trim() : '';
            if (src.startsWith('blob:') || src.startsWith('data:')) {
              expectedFields[field] = src;
            }
          });

          if (Object.keys(expectedFields).length) {
            expectedEphemeralSrcByNodeId.set(node.id, expectedFields);
          }
        });
        await materializeEphemeralAssetUrls(slug, clone);
        if (saveRequestId !== latestSaveRequestRef.current) {
          return;
        }
        if (!opts?.skipStateSync && expectedEphemeralSrcByNodeId.size) {
          syncMaterializedAssetUrlsToLiveNodes(expectedEphemeralSrcByNodeId, clone);
        }
        flowNodes = clone.map(stripNodeForSave);
      } catch (matErr) {
        console.error('[project materialize]', matErr);
        if (!opts?.silent) {
          window.alert(
            matErr instanceof Error ? matErr.message : '素材写入工程目录失败，主页缩略图可能仍无法显示'
          );
        }
        flowNodes = nodesRef.current.map(stripNodeForSave);
      }
      const displayName =
        opts && typeof opts.name === 'string' && opts.name.trim()
          ? opts.name.trim()
          : projectWorkspace.name || slug;
      const data = {
        version: 1,
        slug,
        name: displayName,
        updatedAt: saveIssuedAt,
        flow: {
          nodes: flowNodes,
          edges: edgesRef.current.map(stripEdgeForSave),
          viewport: getViewport(),
        },
      };
      try {
        if (saveRequestId !== latestSaveRequestRef.current) {
          return;
        }
        const res = await fetch(nodeApi('/project/save'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, data }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || '保存失败');
      } catch (e) {
        if (opts?.silent) {
          console.error('[project autosave]', e);
        } else {
          window.alert(e instanceof Error ? e.message : '保存失败');
        }
      }
    },
    [projectWorkspace.slug, projectWorkspace.name, getViewport, setNodes, syncMaterializedAssetUrlsToLiveNodes]
  );

  /** 画布与视角变更后防抖写入 project_data.json（静默，不打断操作） */
  useEffect(() => {
    if (nodes.some((node) => node?.dragging)) return undefined;

    let cancelled = false;
    let idleId = null;

    const runSave = () => {
      if (cancelled) return;
      void saveProjectNow({ silent: true });
    };

    const tid = window.setTimeout(() => {
      if (cancelled) return;
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(runSave, { timeout: AUTOSAVE_IDLE_TIMEOUT_MS });
      } else {
        runSave();
      }
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(tid);
      if (idleId != null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      }
    };
  }, [nodes, edges, viewport.x, viewport.y, viewport.zoom, saveProjectNow]);

  const leaveWorkspaceToDashboard = useCallback(async () => {
    await saveProjectNow({ silent: true, skipStateSync: true });
    projectWorkspace.onBackToDashboard?.();
  }, [projectWorkspace, saveProjectNow]);

  const leaveWorkspaceToAllProjects = useCallback(async () => {
    await saveProjectNow({ silent: true, skipStateSync: true });
    projectWorkspace.onOpenAllProjects?.();
  }, [projectWorkspace, saveProjectNow]);

  const flushProjectSave = useCallback(
    async (opts = {}) => saveProjectNow({ silent: true, skipStateSync: true, ...opts }),
    [saveProjectNow]
  );

  useEffect(() => {
    setProjectNameDraft(projectWorkspace.name || '');
  }, [projectWorkspace.slug, projectWorkspace.name]);

  const commitProjectNameIfChanged = useCallback(() => {
    const t = projectNameDraft.trim();
    if (!t) {
      setProjectNameDraft(projectWorkspace.name || '');
      return;
    }
    if (t !== (projectWorkspace.name || '')) {
      projectWorkspace.onProjectNameChange?.(t);
      saveProjectNow({ name: t });
    }
  }, [
    projectNameDraft,
    projectWorkspace.name,
    projectWorkspace.slug,
    projectWorkspace.onProjectNameChange,
    saveProjectNow,
  ]);

  const getRenderedNodeSizeInFlow = useCallback(
    (nodeId) => {
      const container = reactFlowWrapper.current;
      if (!container) return null;
      const nodeElement = container.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
      if (!(nodeElement instanceof HTMLElement)) return null;
      return {
        // offsetWidth/offsetHeight are layout sizes in flow units already.
        // Dividing by zoom causes progressive over-zoom on repeated double-click.
        width: nodeElement.offsetWidth,
        height: nodeElement.offsetHeight,
      };
    },
    []
  );

  const getNodeSize = useCallback((node) => {
    const measuredWidth = node.measured?.width ?? node.width ?? node.style?.width;
    const measuredHeight = node.measured?.height ?? node.height ?? node.style?.height;
    const numericWidth =
      typeof measuredWidth === 'number' ? measuredWidth : Number.parseFloat(measuredWidth);
    const numericHeight =
      typeof measuredHeight === 'number' ? measuredHeight : Number.parseFloat(measuredHeight);
    return {
      width: Number.isFinite(numericWidth) ? numericWidth : 408,
      height: Number.isFinite(numericHeight) ? numericHeight : 230,
    };
  }, []);

  const getNodeDataRect = useCallback(
    (node, nodeById = new Map()) => {
      if (!node) return null;
      let x = node.positionAbsolute?.x ?? node.position?.x ?? 0;
      let y = node.positionAbsolute?.y ?? node.position?.y ?? 0;
      if (!node.positionAbsolute && node.parentId) {
        let parent = nodeById.get(node.parentId);
        const visitedParentIds = new Set();
        while (parent && !visitedParentIds.has(parent.id)) {
          visitedParentIds.add(parent.id);
          x += parent.position?.x ?? 0;
          y += parent.position?.y ?? 0;
          parent = parent.parentId ? nodeById.get(parent.parentId) : null;
        }
      }
      const { width, height } = getNodeSize(node);
      return {
        minX: x,
        minY: y,
        maxX: x + width,
        maxY: y + height,
        width,
        height,
      };
    },
    [getNodeSize]
  );

  const getNodesDataBounds = useCallback(
    (items) => {
      const targetNodes = Array.isArray(items) ? items.filter(Boolean) : [];
      if (!targetNodes.length) return null;
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      const rects = targetNodes
        .map((node) => getNodeDataRect(node, nodeById))
        .filter(Boolean);
      if (!rects.length) return null;
      const minX = Math.min(...rects.map((rect) => rect.minX));
      const minY = Math.min(...rects.map((rect) => rect.minY));
      const maxX = Math.max(...rects.map((rect) => rect.maxX));
      const maxY = Math.max(...rects.map((rect) => rect.maxY));
      return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      };
    },
    [getNodeDataRect, nodes]
  );

  const getAbsoluteNodeRect = useCallback(
    (node) => {
      if (!node) return null;
      const internalNode = getInternalNode(node.id);
      const absolutePosition =
        internalNode?.internals?.positionAbsolute ??
        node.positionAbsolute ??
        node.position;
      const { width, height } = getNodeSize(node);
      if (!absolutePosition) return null;
      return {
        minX: absolutePosition.x,
        minY: absolutePosition.y,
        maxX: absolutePosition.x + width,
        maxY: absolutePosition.y + height,
        width,
        height,
      };
    },
    [getInternalNode, getNodeSize]
  );

  const getConnectionInteractiveRect = useCallback(
    (node) => {
      const baseRect = getAbsoluteNodeRect(node);
      if (!baseRect || focusedNodeId !== node?.id) return baseRect;

      const container = reactFlowWrapper.current;
      if (!container) return baseRect;

      const nodeElement = container.querySelector(`.react-flow__node[data-id="${node.id}"]`);
      if (!(nodeElement instanceof HTMLElement)) return baseRect;

      const detailElement = nodeElement.querySelector('[data-role="node-detail-panel"]');
      if (!(detailElement instanceof HTMLElement)) return baseRect;

      const nodeBounds = nodeElement.getBoundingClientRect();
      const detailBounds = detailElement.getBoundingClientRect();
      const flowTL = screenToFlowPosition({
        x: Math.min(nodeBounds.left, detailBounds.left),
        y: Math.min(nodeBounds.top, detailBounds.top),
      });
      const flowBR = screenToFlowPosition({
        x: Math.max(nodeBounds.right, detailBounds.right),
        y: Math.max(nodeBounds.bottom, detailBounds.bottom),
      });

      return {
        minX: flowTL.x,
        minY: flowTL.y,
        maxX: flowBR.x,
        maxY: flowBR.y,
        width: flowBR.x - flowTL.x,
        height: flowBR.y - flowTL.y,
      };
    },
    [focusedNodeId, getAbsoluteNodeRect, screenToFlowPosition]
  );

  const getHandlePoint = useCallback(
    (nodeId, position = Position.Right) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return null;
      const { width, height } = getNodeSize(node);
      const baseX = node.position.x;
      const baseY = node.position.y;

      if (position === Position.Left) {
        return { x: baseX, y: baseY + height / 2 };
      }
      if (position === Position.Right) {
        return { x: baseX + width, y: baseY + height / 2 };
      }
      if (position === Position.Top) {
        return { x: baseX + width / 2, y: baseY };
      }
      return { x: baseX + width / 2, y: baseY + height };
    },
    [nodes, getNodeSize]
  );

  const pointInRect = useCallback((point, rect) => {
    return point.x >= rect.minX && point.x <= rect.maxX && point.y >= rect.minY && point.y <= rect.maxY;
  }, []);

  const clearConnectionHover = useCallback(() => {
    clearConnectionHoverTarget();
  }, []);

  const clearBulkConnectState = useCallback(() => {
    setBulkConnectState(null);
  }, []);

  const getConnectionDropTarget = useCallback(
    (flowPoint, sourceNodeId) => {
      const candidates = [...nodesRef.current]
        .filter((node) => ASSET_NODE_TYPES.has(node.type))
        .filter((node) => node.id !== sourceNodeId)
        .filter((node) => !String(node.id).startsWith('ghost_'));

      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const node = candidates[index];
        const rect = getConnectionInteractiveRect(node);
        if (!rect || !pointInRect(flowPoint, rect)) continue;

        const relX = rect.width > 0 ? (flowPoint.x - rect.minX) / rect.width : 0.5;
        const relY = rect.height > 0 ? (flowPoint.y - rect.minY) / rect.height : 0.5;
        const tiltY = Number((((relX - 0.5) * 2) * 15).toFixed(2));
        const tiltX = Number((((0.5 - relY) * 2) * 15).toFixed(2));

        return {
          node,
          tilt: {
            x: tiltX,
            y: tiltY,
          },
        };
      }

      return null;
    },
    [getConnectionInteractiveRect, pointInRect]
  );

  const getOrderedSelectedAssetNodes = useCallback(
    (nodeIds) => {
      const nodeIdSet = new Set(nodeIds || []);
      return [...nodesRef.current]
        .filter((node) => nodeIdSet.has(node.id))
        .filter((node) => ASSET_NODE_TYPES.has(node.type) && !node.parentId)
        .sort((a, b) => {
          const rectA = getAbsoluteNodeRect(a);
          const rectB = getAbsoluteNodeRect(b);
          const aY = rectA?.minY ?? a.position.y;
          const bY = rectB?.minY ?? b.position.y;
          const aX = rectA?.minX ?? a.position.x;
          const bX = rectB?.minX ?? b.position.x;
          if (Math.abs(aY - bY) > 40) return aY - bY;
          return aX - bX;
        });
    },
    [getAbsoluteNodeRect]
  );

  const getAllowedNodeTypesForSources = useCallback((sourceNodeIds) => {
    const sourceIdSet = new Set(sourceNodeIds || []);
    const sourceNodes = nodesRef.current.filter((node) => sourceIdSet.has(node.id));
    const hasImage = sourceNodes.some((node) => node.type === 'AIImageNode');
    const hasVideo = sourceNodes.some((node) => node.type === 'AIVideoNode');

    if (hasVideo) return ['Video'];
    if (hasImage) return ['Image', 'Video', 'Text'];
    return [];
  }, []);

  const getBulkConnectionDropTarget = useCallback(
    (flowPoint, sourceNodeIds) => {
      const sourceIdSet = new Set(sourceNodeIds || []);
      const sourceNodes = nodesRef.current.filter((node) => sourceIdSet.has(node.id));
      const allImages =
        sourceNodes.length > 0 && sourceNodes.every((node) => node.type === 'AIImageNode');
      const allReferenceMedia =
        sourceNodes.length > 0 && sourceNodes.every((node) => node.type === 'AIImageNode' || node.type === 'AIVideoNode');
      const candidates = [...nodesRef.current]
        .filter((node) => ASSET_NODE_TYPES.has(node.type))
        .filter((node) => !sourceIdSet.has(node.id))
        .filter((node) => !String(node.id).startsWith('ghost_'));

      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const node = candidates[index];
        const rect = getConnectionInteractiveRect(node);
        if (!rect || !pointInRect(flowPoint, rect)) continue;

        const relX = rect.width > 0 ? (flowPoint.x - rect.minX) / rect.width : 0.5;
        const relY = rect.height > 0 ? (flowPoint.y - rect.minY) / rect.height : 0.5;
        const tiltY = Number((((relX - 0.5) * 2) * 15).toFixed(2));
        const tiltX = Number((((0.5 - relY) * 2) * 15).toFixed(2));
        const isValid =
          (allImages && (node.type === 'AIImageNode' || node.type === 'AIVideoNode')) ||
          (allReferenceMedia && node.type === 'AIVideoNode');

        return {
          node,
          isValid,
          targetPoint: isValid ? flowPoint : null,
          tilt: {
            x: tiltX,
            y: tiltY,
          },
        };
      }

      return null;
    },
    [getConnectionInteractiveRect, pointInRect]
  );

  const lineIntersectsRect = useCallback(
    (a, b, rect) => {
      if (pointInRect(a, rect) || pointInRect(b, rect)) return true;

      const lines = [
        [{ x: rect.minX, y: rect.minY }, { x: rect.maxX, y: rect.minY }],
        [{ x: rect.maxX, y: rect.minY }, { x: rect.maxX, y: rect.maxY }],
        [{ x: rect.maxX, y: rect.maxY }, { x: rect.minX, y: rect.maxY }],
        [{ x: rect.minX, y: rect.maxY }, { x: rect.minX, y: rect.minY }],
      ];

      const ccw = (p1, p2, p3) => (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x);
      const intersects = (p1, p2, p3, p4) => ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);

      return lines.some(([l1, l2]) => intersects(a, b, l1, l2));
    },
    [pointInRect]
  );

  const clearEdgeHoverTimer = useCallback(() => {
    if (edgeHoverTimerRef.current) {
      clearTimeout(edgeHoverTimerRef.current);
      edgeHoverTimerRef.current = null;
    }
  }, []);

  const openDrawer = useCallback(() => {
    if (drawerCloseTimeoutRef.current) {
      clearTimeout(drawerCloseTimeoutRef.current);
      drawerCloseTimeoutRef.current = null;
    }
    setIsDrawerOpen(true);
  }, []);

  const closeDrawerWithDelay = useCallback(() => {
    if (drawerCloseTimeoutRef.current) {
      clearTimeout(drawerCloseTimeoutRef.current);
    }
    drawerCloseTimeoutRef.current = setTimeout(() => {
      setIsDrawerOpen(false);
      drawerCloseTimeoutRef.current = null;
    }, 140);
  }, []);

  useEffect(() => {
    return () => {
      if (drawerCloseTimeoutRef.current) {
        clearTimeout(drawerCloseTimeoutRef.current);
      }
      clearEdgeHoverTimer();
    };
  }, [clearEdgeHoverTimer]);

  // Gather incoming media references for generation/text nodes.
  // Image sources feed all generated nodes; video sources feed video nodes as Seedance refs.
  useEffect(() => {
    setNodes((nds) => {
      let changed = false;

      const next = nds.map((node) => {
        if (node.type !== 'AIImageNode' && node.type !== 'AITextNode' && node.type !== 'AIVideoNode') {
          if (node.data?.inputImageRefs?.length || node.data?.inputVideoRefs?.length) {
            changed = true;
            return {
              ...node,
              data: {
                ...(node.data || {}),
                inputImageRefs: [],
                inputVideoRefs: [],
              },
            };
          }
          return node;
        }

        const seenImages = new Set();
        const imageRefs = edges
          .filter((edge) => edge.target === node.id)
          .map((edge) => {
            const sourceNode = nds.find((candidate) => candidate.id === edge.source);
            const asset = sourceNode?.type === 'AIImageNode' ? sourceNode.data?.imageAsset : null;
            return asset?.src
              ? {
                  ...asset,
                  sourceNodeId: edge.source,
                  edgeId: edge.id,
                }
              : null;
          })
          .filter(Boolean)
          .filter((asset) => {
            if (seenImages.has(asset.sourceNodeId || asset.src)) return false;
            seenImages.add(asset.sourceNodeId || asset.src);
            return true;
          })
          .slice(0, 8);

        const seenVideos = new Set();
        const videoRefs =
          node.type === 'AIVideoNode'
            ? edges
                .filter((edge) => edge.target === node.id)
                .map((edge) => {
                  const sourceNode = nds.find((candidate) => candidate.id === edge.source);
                  const asset =
                    sourceNode?.type === 'AIVideoNode'
                      ? sourceNode.data?.generatedVideo || sourceNode.data?.capturedClip
                      : null;
                  return asset?.src
                    ? {
                        ...asset,
                        kind: 'video',
                        sourceNodeId: edge.source,
                        edgeId: edge.id,
                      }
                    : null;
                })
                .filter(Boolean)
                .filter((asset) => {
                  if (seenVideos.has(asset.sourceNodeId || asset.src)) return false;
                  seenVideos.add(asset.sourceNodeId || asset.src);
                  return true;
                })
                .slice(0, 8)
            : [];

        const prev = node.data?.inputImageRefs || [];
        const prevVideos = node.data?.inputVideoRefs || [];
        const sameImages =
          prev.length === imageRefs.length &&
          prev.every(
            (item, idx) =>
              item?.src === imageRefs[idx]?.src &&
              item?.name === imageRefs[idx]?.name &&
              item?.sourceNodeId === imageRefs[idx]?.sourceNodeId &&
              item?.seedanceFaceReview?.status === imageRefs[idx]?.seedanceFaceReview?.status &&
              item?.seedanceFaceReview?.assetRef === imageRefs[idx]?.seedanceFaceReview?.assetRef
          );
        const sameVideos =
          prevVideos.length === videoRefs.length &&
          prevVideos.every(
            (item, idx) =>
              item?.src === videoRefs[idx]?.src &&
              item?.name === videoRefs[idx]?.name &&
              item?.sourceNodeId === videoRefs[idx]?.sourceNodeId &&
              item?.duration === videoRefs[idx]?.duration
          );

        if (sameImages && sameVideos) return node;
        changed = true;
        return {
          ...node,
          data: {
            ...(node.data || {}),
            inputImageRefs: imageRefs,
            inputVideoRefs: videoRefs,
          },
        };
      });

      return changed ? next : nds;
    });
  }, [edges, nodes]);

  const renderedEdges = useMemo(
    () =>
      edges.map((edge) => {
        const isTemporaryEnergyEdge = Boolean(edge.data?.lockedFrom || edge.data?.lockedTo);
        const isHighlighted =
          highlightedNodeId && (edge.source === highlightedNodeId || edge.target === highlightedNodeId);
        const isHovered = edge.id === hoveredEdgeId;
        const isSelected = selectedEdgeIds.includes(edge.id);

        if (isTemporaryEnergyEdge || isHighlighted || isHovered || isSelected) {
          return {
            ...edge,
            type: 'energy',
            style: activeEdgeStyle,
          };
        }

        return {
          ...edge,
          type: 'default',
          style: normalEdgeStyle,
        };
      }),
    [edges, highlightedNodeId, hoveredEdgeId, selectedEdgeIds]
  );

  const onNodesChange = useCallback(
    (changes) => {
      if (changes.some((c) => c.type === 'remove')) saveSnapshot();
      setNodes((nds) => {
        const nextNodes = applyNodeChanges(changes, nds);
        nodesRef.current = nextNodes;
        return nextNodes;
      });
    },
    [saveSnapshot]
  );
  const onEdgesChange = useCallback(
    (changes) => {
      if (changes.some((c) => c.type === 'remove')) saveSnapshot();
      setEdges((eds) => {
        const nextEdges = applyEdgeChanges(changes, eds);
        edgesRef.current = nextEdges;
        return nextEdges;
      });
    },
    [saveSnapshot]
  );
  const commitConnection = useCallback(
    ({ source, target, sourceHandle, targetHandle = 'input' }) => {
      if (!source || !target || source === target) return false;

      saveSnapshot();
      let added = false;
      setEdges((eds) => {
        const alreadyExists = eds.some(
          (edge) =>
            edge.source === source &&
            edge.target === target &&
            (edge.sourceHandle || 'output') === (sourceHandle || 'output') &&
            (edge.targetHandle || 'input') === targetHandle
        );
        if (alreadyExists) return eds;

        added = true;
        return addEdge(
          {
            source,
            target,
            sourceHandle: sourceHandle || 'output',
            sourcePosition: Position.Right,
            targetHandle,
            targetPosition: Position.Left,
            selectable: true,
            focusable: true,
            style: normalEdgeStyle,
          },
          eds
        );
      });

      if (added) {
        setMenu(null);
        setPendingConnection(null);
      }
      return added;
    },
    [saveSnapshot]
  );
  const commitBulkConnections = useCallback(
    ({ sourceNodeIds, targetNodeId, sourceHandleId = 'output', targetHandle = 'input' }) => {
      if (!targetNodeId || !Array.isArray(sourceNodeIds) || !sourceNodeIds.length) return false;

      saveSnapshot();
      let added = false;
      setEdges((eds) => {
        const existingKeys = new Set(
          eds.map(
            (edge) =>
              `${edge.source}|${edge.target}|${edge.sourceHandle || 'output'}|${edge.targetHandle || 'input'}`
          )
        );

        const nextEdges = sourceNodeIds
          .filter((sourceNodeId) => sourceNodeId && sourceNodeId !== targetNodeId)
          .map((sourceNodeId) => ({
            id: `e-${sourceNodeId}-${targetNodeId}`,
            source: sourceNodeId,
            sourceHandle: sourceHandleId || 'output',
            sourcePosition: Position.Right,
            target: targetNodeId,
            targetHandle,
            targetPosition: Position.Left,
            selectable: true,
            focusable: true,
            style: normalEdgeStyle,
          }))
          .filter((edge) => {
            const key = `${edge.source}|${edge.target}|${edge.sourceHandle || 'output'}|${edge.targetHandle || 'input'}`;
            if (existingKeys.has(key)) return false;
            existingKeys.add(key);
            added = true;
            return true;
          });

        return nextEdges.length ? eds.concat(nextEdges) : eds;
      });

      if (added) {
        setMenu(null);
        setPendingConnection(null);
      }
      return added;
    },
    [saveSnapshot]
  );
  const onConnect = useCallback(
    (params) => {
      // Only accept connections that originated from a real user handle-drag.
      if (!isUserConnectingRef.current) return;
      // Guard against incidental connect events while menu-based node creation is active.
      if (pendingConnection) return;
      if (!params?.source || !params?.target) return;
      if (params.source === params.target) return;

      const resolvedSourceHandle = params?.sourceHandle || connectStart?.sourceHandleId || 'output';
      const resolvedTargetHandle = params?.targetHandle || 'input';
      commitConnection({
        source: params.source,
        target: params.target,
        sourceHandle: resolvedSourceHandle,
        targetHandle: resolvedTargetHandle,
      });
      setIsConnectingFromSource(false);
      clearConnectionHover();
    },
    [clearConnectionHover, commitConnection, connectStart, pendingConnection]
  );

  const onConnectStart = useCallback((_, params) => {
    isUserConnectingRef.current = true;
    clearBulkConnectState();
    clearConnectionHover();
    if (pendingConnection) {
      const ghostNodeIds = new Set(getPendingConnectionGhostNodeIds(pendingConnection));
      const tempEdgeIds = new Set(getPendingConnectionTempEdgeIds(pendingConnection));
      setNodes((nds) => nds.filter((n) => !ghostNodeIds.has(n.id)));
      setEdges((eds) => eds.filter((e) => !tempEdgeIds.has(e.id)));
      setMenu(null);
      setPendingConnection(null);
    }
    setConnectStart({
      sourceNodeId: params.nodeId,
      sourceHandleId: params.handleId || null,
      sourceHandleType: params.handleType,
    });
    setIsConnectingFromSource(params?.handleType === 'source');
  }, [clearBulkConnectState, clearConnectionHover, pendingConnection]);

  useEffect(() => {
    if (!connectStart?.sourceNodeId || !['source', 'target'].includes(connectStart.sourceHandleType)) {
      clearConnectionHover();
      return undefined;
    }

    const handlePointerMove = (event) => {
      const flowPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const target = getConnectionDropTarget(flowPoint, connectStart.sourceNodeId);
      if (!target) {
        clearConnectionHover();
        return;
      }

      setConnectionHoverTarget(target.node.id, target.tilt);
    };

    window.addEventListener('pointermove', handlePointerMove);
    return () => window.removeEventListener('pointermove', handlePointerMove);
  }, [clearConnectionHover, connectStart, getConnectionDropTarget, screenToFlowPosition]);

  const cancelPendingConnection = useCallback(() => {
    if (!pendingConnection) {
      setMenu(null);
      return;
    }

    const ghostNodeIds = new Set(getPendingConnectionGhostNodeIds(pendingConnection));
    const tempEdgeIds = new Set(getPendingConnectionTempEdgeIds(pendingConnection));
    setNodes((nds) => nds.filter((n) => !ghostNodeIds.has(n.id)));
    setEdges((eds) => eds.filter((e) => !tempEdgeIds.has(e.id)));
    setMenu(null);
    setPendingConnection(null);
    clearConnectionHover();
  }, [clearConnectionHover, pendingConnection]);

  const openBulkPendingConnection = useCallback(
    ({ sourceNodeIds, sourceHandleId = 'output', flowPosition, clientX, clientY, allowedNodeTypes }) => {
      if (!Array.isArray(sourceNodeIds) || !sourceNodeIds.length || !flowPosition) return;

      const ghostNodeId = `ghost_${getId(nodesRef.current)}`;
      const tempEdgeIds = sourceNodeIds.map((sourceNodeId, index) => `temp_${sourceNodeId}_${ghostNodeId}_${index}`);

      setNodes((nds) =>
        nds.concat({
          id: ghostNodeId,
          position: flowPosition,
          data: {},
          draggable: false,
          selectable: false,
          connectable: false,
          deletable: false,
          style: {
            width: 1,
            height: 1,
            background: 'transparent',
            border: 'none',
            opacity: 0,
            pointerEvents: 'none',
          },
        })
      );

      setEdges((eds) =>
        eds.concat(
          sourceNodeIds.map((sourceNodeId, index) => ({
            id: tempEdgeIds[index],
            type: 'energy',
            source: sourceNodeId,
            sourceHandle: sourceHandleId,
            target: ghostNodeId,
            sourcePosition: Position.Right,
            targetPosition: Position.Left,
            data: {
              lockedTo: flowPosition,
              lockedSourcePosition: Position.Right,
              lockedTargetPosition: Position.Left,
            },
            selectable: false,
            focusable: false,
            style: activeEdgeStyle,
          }))
        )
      );

      setMenu({
        top: clientY,
        left: clientX,
      });

      setPendingConnection({
        sourceNodeId: sourceNodeIds[0],
        sourceNodeIds,
        sourceHandleId: sourceHandleId || 'output',
        ghostNodeId,
        ghostNodeIds: [ghostNodeId],
        tempEdgeId: tempEdgeIds[0],
        tempEdgeIds,
        allowedNodeTypes,
        top: clientY,
        left: clientX,
      });
    },
    []
  );

  const startBulkConnection = useCallback(
    (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const sourceNodes = getOrderedSelectedAssetNodes(selectedNodeIds);
      const sourceNodeIds = sourceNodes.map((node) => node.id);
      if (sourceNodeIds.length < 2) return;

      cancelPendingConnection();
      setPaneContextMenu(null);
      clearConnectionHover();

      const flowPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setBulkConnectState({
        sourceNodeIds,
        sourceHandleId: 'output',
        currentPoint: flowPoint,
        targetNodeId: null,
        targetPoint: null,
        allowedNodeTypes: getAllowedNodeTypesForSources(sourceNodeIds),
      });
    },
    [
      cancelPendingConnection,
      clearConnectionHover,
      getAllowedNodeTypesForSources,
      getOrderedSelectedAssetNodes,
      screenToFlowPosition,
      selectedNodeIds,
    ]
  );

  useEffect(() => {
    if (!bulkConnectState?.sourceNodeIds?.length) return undefined;

    const handlePointerMove = (event) => {
      const flowPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const dropTarget = getBulkConnectionDropTarget(flowPoint, bulkConnectState.sourceNodeIds);
      const isValidTarget = Boolean(dropTarget?.isValid && dropTarget?.node?.id);

      if (isValidTarget) {
        setConnectionHoverTarget(dropTarget.node.id, dropTarget.tilt);
      } else {
        clearConnectionHover();
      }

      setBulkConnectState((prev) =>
        prev
          ? {
              ...prev,
              currentPoint: flowPoint,
              targetNodeId: isValidTarget ? dropTarget.node.id : null,
              targetPoint: isValidTarget ? dropTarget.targetPoint : null,
            }
          : prev
      );
    };

    const handlePointerUp = (event) => {
      const flowPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const dropTarget = getBulkConnectionDropTarget(flowPoint, bulkConnectState.sourceNodeIds);

      if (dropTarget?.isValid && dropTarget?.node?.id) {
        commitBulkConnections({
          sourceNodeIds: bulkConnectState.sourceNodeIds,
          targetNodeId: dropTarget.node.id,
          sourceHandleId: bulkConnectState.sourceHandleId || 'output',
        });
      } else {
        openBulkPendingConnection({
          sourceNodeIds: bulkConnectState.sourceNodeIds,
          sourceHandleId: bulkConnectState.sourceHandleId || 'output',
          flowPosition: flowPoint,
          clientX: event.clientX,
          clientY: event.clientY,
          allowedNodeTypes: bulkConnectState.allowedNodeTypes,
        });
      }

      clearBulkConnectState();
      clearConnectionHover();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [
    bulkConnectState,
    clearBulkConnectState,
    clearConnectionHover,
    commitBulkConnections,
    getBulkConnectionDropTarget,
    openBulkPendingConnection,
    screenToFlowPosition,
  ]);

  const onConnectEnd = useCallback(
    (event, connectionState) => {
      const sourceNodeId =
        connectionState?.fromNode?.id ||
        connectionState?.fromNodeId ||
        connectStart?.sourceNodeId;
      const sourceHandleId =
        connectionState?.fromHandle?.id ||
        connectionState?.fromHandleId ||
        connectStart?.sourceHandleId ||
        'output';
      const sourceHandleType =
        connectionState?.fromHandle?.type ||
        connectionState?.fromHandleType ||
        connectStart?.sourceHandleType;
      const { clientX, clientY } = 'changedTouches' in event ? event.changedTouches[0] : event;
      const flowPosition = screenToFlowPosition({ x: clientX, y: clientY });

      if (!connectionState.isValid && sourceNodeId && sourceHandleType === 'source') {
        const dropTarget = getConnectionDropTarget(flowPosition, sourceNodeId);
        if (dropTarget?.node?.id) {
          commitConnection({
            source: sourceNodeId,
            target: dropTarget.node.id,
            sourceHandle: sourceHandleId || 'output',
            targetHandle: 'input',
          });
          setConnectStart(null);
          setIsConnectingFromSource(false);
          isUserConnectingRef.current = false;
          clearConnectionHover();
          return;
        }
      } else if (!connectionState.isValid && sourceNodeId && sourceHandleType === 'target') {
        const dropTarget = getConnectionDropTarget(flowPosition, sourceNodeId);
        if (dropTarget?.node?.id && dropTarget.node.type === 'AIImageNode') {
          commitConnection({
            source: dropTarget.node.id,
            target: sourceNodeId,
            sourceHandle: 'output',
            targetHandle: sourceHandleId || 'input',
          });
          setConnectStart(null);
          setIsConnectingFromSource(false);
          isUserConnectingRef.current = false;
          clearConnectionHover();
          return;
        }
      }

      if (!connectionState.isValid && sourceNodeId && sourceHandleType === 'source') {
        const sourcePosition =
          connectionState?.fromPosition || (sourceHandleId === 'output' ? Position.Right : Position.Left);
        // Keep temp edge curvature consistent with drag preview by
        // always using opposite directions on source/target sides.
        const targetPosition =
          connectionState?.toPosition ||
          (sourcePosition === Position.Right ? Position.Left : Position.Right);
        const lockedFrom = connectionState?.from || null;
        // Always lock the temp edge head to the actual mouse release point
        // to avoid snapping to nearby handles/nodes.
        const lockedTo = flowPosition;

        const ghostNodeId = `ghost_${getId(nodesRef.current)}`;
        const tempEdgeId = `temp_${sourceNodeId}_${ghostNodeId}`;

        setNodes((nds) =>
          nds.concat({
            id: ghostNodeId,
            position: flowPosition,
            data: {},
            draggable: false,
            selectable: false,
            connectable: false,
            deletable: false,
            style: {
              width: 1,
              height: 1,
              background: 'transparent',
              border: 'none',
              opacity: 0,
              pointerEvents: 'none',
            },
          })
        );

        setEdges((eds) =>
          eds.concat({
            id: tempEdgeId,
            type: 'energy',
            source: sourceNodeId,
            sourceHandle: sourceHandleId,
            target: ghostNodeId,
            sourcePosition,
            targetPosition,
            data: {
              lockedFrom,
              lockedTo,
              lockedSourcePosition: sourcePosition,
              lockedTargetPosition: targetPosition,
            },
            selectable: false,
            focusable: false,
            style: activeEdgeStyle,
          })
        );

        setMenu({
          top: clientY,
          left: clientX,
        });

        setPendingConnection({
          sourceNodeId,
          sourceNodeIds: [sourceNodeId],
          sourceHandleId: sourceHandleId || 'output',
          ghostNodeId,
          ghostNodeIds: [ghostNodeId],
          tempEdgeId,
          tempEdgeIds: [tempEdgeId],
          top: clientY,
          left: clientX,
        });
      }

      setConnectStart(null);
      setIsConnectingFromSource(false);
      clearConnectionHover();
      isUserConnectingRef.current = false;
    },
    [clearConnectionHover, commitConnection, connectStart, getConnectionDropTarget, screenToFlowPosition]
  );

  const createNode = useCallback((nodeType) => {
    if (!menu || !pendingConnection) return;

    const sourceNodeIds = getPendingConnectionSourceIds(pendingConnection);
    if (!sourceNodeIds.length) return;

    const newNodeId = getId(nodesRef.current);
    const {
      sourceHandleId,
    } = pendingConnection;
    const ghostNodeIds = new Set(getPendingConnectionGhostNodeIds(pendingConnection));
    const tempEdgeIds = new Set(getPendingConnectionTempEdgeIds(pendingConnection));
    const position = screenToFlowPosition({
      x: menu.left,
      y: menu.top,
    });

    const resolvedType = resolveNodeType(nodeType);
    const newNode = {
      id: newNodeId,
      type: resolvedType,
      position,
      dragHandle: NODE_DRAG_HANDLE_SELECTOR,
      selected: true,
      data: {
        label: `${nodeType} Node`,
        uiDismissToken,
        cleanPanel: resolvedType === 'AIImageNode',
        focusedNodeId: resolvedType === 'AITextNode' ? newNodeId : undefined,
      },
    };

    setNodes((nds) =>
      nds
        .filter((n) => !ghostNodeIds.has(n.id))
        .map((node) => ({ ...node, selected: false }))
        .concat(newNode)
    );
    setEdges((eds) => eds.filter((e) => !tempEdgeIds.has(e.id)));

    setMenu(null);
    setPendingConnection(null);
    setIsConnectingFromSource(false);
    setSelectedNodeIds([newNodeId]);
    setSingleSelectedNodeId(newNodeId);
    setFocusedNodeId(newNodeId);
    setTextEditingNodeId(null);
    setSelectedEdgeIds([]);
    setHoveredEdgeId(null);
    setMaximizedViewNodeId(null);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        sourceNodeIds.forEach((sourceNodeId) => updateNodeInternals(sourceNodeId));
        updateNodeInternals(newNodeId);

        setEdges((eds) => {
          // Keep only the intended edge for newly created node.
          const cleaned = eds.filter((edge) => edge.source !== newNodeId && edge.target !== newNodeId);
          const existingKeys = new Set(
            cleaned.map(
              (edge) =>
                `${edge.source}|${edge.target}|${edge.sourceHandle || 'output'}|${edge.targetHandle || 'input'}`
            )
          );
          const nextEdges = sourceNodeIds
            .map((sourceNodeId) => ({
              id: `e-${sourceNodeId}-${newNodeId}`,
              source: sourceNodeId,
              sourceHandle: sourceHandleId || 'output',
              sourcePosition: Position.Right,
              target: newNodeId,
              targetHandle: 'input',
              targetPosition: Position.Left,
              selectable: true,
              focusable: true,
              style: normalEdgeStyle,
            }))
            .filter((edge) => {
              const key = `${edge.source}|${edge.target}|${edge.sourceHandle || 'output'}|${edge.targetHandle || 'input'}`;
              if (existingKeys.has(key)) return false;
              existingKeys.add(key);
              return true;
            });
          return cleaned.concat(nextEdges);
        });
      });
    });
  }, [menu, pendingConnection, screenToFlowPosition, uiDismissToken, updateNodeInternals]);

  const handleToolClick = useCallback((tab) => {
    setActiveTab(tab);
    if (tab === 'nodes' || tab === 'assets' || tab === 'history') {
      setIsDrawerOpen(true);
    } else {
      setIsDrawerOpen(false);
    }
  }, []);

  const selectDrawerItem = useCallback((tab) => {
    setActiveTab(tab);
  }, []);

  const buildMaterialDraftFromNode = useCallback((node) => {
    if (!node?.data) return null;

    if (node.type === 'AIImageNode') {
      const asset = node.data.imageAsset || node.data.capturedFrame;
      if (!asset?.src) return null;
      return {
        kind: 'image',
        defaultName: asset.name?.replace(/\.[^/.]+$/, '') || '图片素材',
        asset: {
          src: asset.src,
          name: asset.name || 'image.png',
          width: asset.width || null,
          height: asset.height || null,
          kind: 'image',
          seedanceFaceReview: node.data.seedanceFaceReview || asset.seedanceFaceReview || null,
        },
        coverAsset: {
          src: asset.src,
          name: asset.name || 'image.png',
          width: asset.width || null,
          height: asset.height || null,
          kind: 'image',
          seedanceFaceReview: node.data.seedanceFaceReview || asset.seedanceFaceReview || null,
        },
      };
    }

    if (node.type === 'AIVideoNode') {
      const asset = node.data.generatedVideo || node.data.capturedClip;
      if (!asset?.src) return null;
      return {
        kind: 'video',
        defaultName: asset.name?.replace(/\.[^/.]+$/, '') || '视频素材',
        asset: {
          src: asset.src,
          name: asset.name || 'clip.mp4',
          width: asset.width || null,
          height: asset.height || null,
          duration: asset.duration || null,
          kind: 'video',
        },
        coverAsset: {
          src: asset.src,
          name: asset.name || 'clip.mp4',
          width: asset.width || null,
          height: asset.height || null,
          duration: asset.duration || null,
          kind: 'video',
        },
      };
    }

    return null;
  }, []);

  const saveSelectedNodeToMaterialLibrary = useCallback(() => {
    const selectedNode = nodes.find((node) => selectedNodeIds.includes(node.id) && ASSET_NODE_TYPES.has(node.type));
    const draft = buildMaterialDraftFromNode(selectedNode);
    if (!draft) return;
    openSaveToMaterialModal(draft);
  }, [buildMaterialDraftFromNode, nodes, openSaveToMaterialModal, selectedNodeIds]);

  const createImageNodeAtScreen = useCallback((screenX, screenY) => {
    saveSnapshot();
    const newNodeId = getId(nodesRef.current);
    const position = screenToFlowPosition({
      x: screenX,
      y: screenY,
    });

    setNodes((nds) =>
      nds.concat({
        id: newNodeId,
        type: 'AIImageNode',
        position,
        dragHandle: NODE_DRAG_HANDLE_SELECTOR,
        data: { label: 'AI 图片节点', uiDismissToken },
        style: {
          opacity: 0,
          transition: 'opacity 180ms ease-out',
        },
      })
    );
    requestAnimationFrame(() => {
      setNodes((nds) =>
        nds.map((node) =>
          node.id === newNodeId
            ? { ...node, style: { ...node.style, opacity: 1 } }
            : node
        )
      );
    });
  }, [screenToFlowPosition, uiDismissToken, saveSnapshot]);

  const createImageNodeFromDrawer = useCallback(() => {
    createImageNodeAtScreen(window.innerWidth / 2 - 170, window.innerHeight / 2 - 120);
    setActiveTab('nodes');
    setIsDrawerOpen(false);
  }, [createImageNodeAtScreen]);

  const createTextNodeAtScreen = useCallback((screenX, screenY) => {
    saveSnapshot();
    const newNodeId = getId(nodesRef.current);
    const position = screenToFlowPosition({
      x: screenX,
      y: screenY,
    });

    setNodes((nds) =>
      nds.concat({
        id: newNodeId,
        type: 'AITextNode',
        position,
        dragHandle: NODE_DRAG_HANDLE_SELECTOR,
        data: { label: 'AI 文本节点', uiDismissToken },
        style: {
          opacity: 0,
          transition: 'opacity 180ms ease-out',
        },
      })
    );
    requestAnimationFrame(() => {
      setNodes((nds) =>
        nds.map((node) =>
          node.id === newNodeId
            ? { ...node, style: { ...node.style, opacity: 1 } }
            : node
        )
      );
    });
    setFocusedNodeId(newNodeId);
    setSingleSelectedNodeId(newNodeId);
    setSelectedNodeIds([newNodeId]);
    setTextEditingNodeId(null);
  }, [screenToFlowPosition, uiDismissToken, saveSnapshot]);

  const createTextNodeFromDrawer = useCallback(() => {
    createTextNodeAtScreen(window.innerWidth / 2 - 170, window.innerHeight / 2 - 120);
    setActiveTab('nodes');
    setIsDrawerOpen(false);
  }, [createTextNodeAtScreen]);

  const createVideoNodeAtScreen = useCallback((screenX, screenY) => {
    saveSnapshot();
    const newNodeId = getId(nodesRef.current);
    const position = screenToFlowPosition({
      x: screenX,
      y: screenY,
    });

    setNodes((nds) =>
      nds.concat({
        id: newNodeId,
        type: 'AIVideoNode',
        position,
        dragHandle: NODE_DRAG_HANDLE_SELECTOR,
        data: { label: 'AI 视频节点', uiDismissToken },
        style: {
          opacity: 0,
          transition: 'opacity 180ms ease-out',
        },
      }      )
    );
    requestAnimationFrame(() => {
      setNodes((nds) =>
        nds.map((node) =>
          node.id === newNodeId
            ? { ...node, style: { ...node.style, opacity: 1 } }
            : node
        )
      );
    });
  }, [screenToFlowPosition, uiDismissToken, saveSnapshot]);

  const createVideoNodeFromDrawer = useCallback(() => {
    createVideoNodeAtScreen(window.innerWidth / 2 - 170, window.innerHeight / 2 - 120);
    setActiveTab('nodes');
    setIsDrawerOpen(false);
  }, [createVideoNodeAtScreen]);

  const addMaterialLibraryItemToCanvas = useCallback((item, screenPoint = null) => {
    if (!item?.assetUrl) return;
    saveSnapshot();
    const newNodeId = getId(nodesRef.current);
    const targetPoint = screenPoint || {
      x: window.innerWidth / 2 - 180,
      y: window.innerHeight / 2 - 120,
    };
    const position = screenToFlowPosition(targetPoint);
    const baseNode = {
      id: newNodeId,
      position,
      dragHandle: NODE_DRAG_HANDLE_SELECTOR,
      style: {
        opacity: 0,
        transition: 'opacity 180ms ease-out',
      },
    };

    const newNode =
      item.kind === 'video'
        ? {
            ...baseNode,
            type: 'AIVideoNode',
            data: {
              label: 'AI 视频节点',
              uiDismissToken,
              videoMode: 'asset',
              capturedClip: {
                src: item.assetUrl,
                name: item.name || '视频素材',
                width: item.width || 1280,
                height: item.height || 720,
                duration: item.duration || 0,
                previewUpdatedAt: item.createdAt || new Date().toISOString(),
              },
            },
          }
        : {
            ...baseNode,
            type: 'AIImageNode',
            data: {
              label: 'AI 图片节点',
              uiDismissToken,
              imageMode: 'asset',
              capturedFrame: {
                src: item.assetUrl,
                name: item.name || '图片素材',
                width: item.width || 1024,
                height: item.height || 1024,
                previewUpdatedAt: item.createdAt || new Date().toISOString(),
                seedanceFaceReview: item.seedanceFaceReview || null,
              },
              seedanceFaceReview: item.seedanceFaceReview || null,
            },
          };

    setNodes((nds) => nds.map((node) => ({ ...node, selected: false })).concat(newNode));
    setSelectedNodeIds([newNodeId]);
    setSingleSelectedNodeId(newNodeId);
    setFocusedNodeId(null);
    setTextEditingNodeId(null);
    requestAnimationFrame(() => {
      updateNodeInternals(newNodeId);
      setNodes((nds) =>
        nds.map((node) =>
          node.id === newNodeId
            ? { ...node, style: { ...node.style, opacity: 1 }, selected: true }
            : node
        )
      );
    });
  }, [saveSnapshot, screenToFlowPosition, uiDismissToken, updateNodeInternals]);

  const handleConfirmMaterialLibrarySave = useCallback(
    async ({ name, category }) => {
      if (!pendingMaterialLibrarySave?.asset?.src) return;
      setIsSavingMaterialLibraryItem(true);
      try {
        await saveMaterialLibraryItem({
          name,
          category,
          asset: pendingMaterialLibrarySave.asset,
          coverAsset: pendingMaterialLibrarySave.coverAsset,
        });
        setPendingMaterialLibrarySave(null);
        setActiveTab('assets');
        setIsDrawerOpen(true);
        setMaterialLibraryCategory('all');
        await refreshMaterialLibrary();
      } catch (error) {
        window.alert(error instanceof Error ? error.message : '保存到素材库失败');
      } finally {
        setIsSavingMaterialLibraryItem(false);
      }
    },
    [pendingMaterialLibrarySave, refreshMaterialLibrary]
  );

  const importExternalMediaFiles = useCallback(async (files, originScreenPoint) => {
    const acceptedFiles = Array.from(files || []).filter(isSupportedMediaFile);
    if (!acceptedFiles.length) return;
    saveSnapshot();

    // Probe dimensions / duration for every file in parallel
    const probed = await Promise.all(
      acceptedFiles.map(
        (file) =>
          new Promise((resolve) => {
            const url = URL.createObjectURL(file);
            if (String(file.type || '').startsWith('image/')) {
              const img = new window.Image();
              img.onload  = () => resolve({ kind: 'image', url, name: file.name, w: img.naturalWidth,  h: img.naturalHeight });
              img.onerror = () => resolve({ kind: 'image', url, name: file.name, w: 1280, h: 720 });
              img.src = url;
            } else {
              const vid = document.createElement('video');
              vid.onloadedmetadata = () => resolve({ kind: 'video', url, name: file.name, w: vid.videoWidth || 1280, h: vid.videoHeight || 720, dur: vid.duration || 0 });
              vid.onerror          = () => resolve({ kind: 'video', url, name: file.name, w: 1280, h: 720, dur: 0 });
              vid.src = url;
            }
          })
      )
    );

    // Use flow-coordinate spacing so gaps stay constant regardless of canvas zoom
    const origin      = originScreenPoint || paneMenuOriginRef.current || {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    };
    const originFlow  = screenToFlowPosition({ x: origin.x, y: origin.y });
    const totalW_FLOW =
      probed.length * CANVAS_NODE_LAYOUT_W + (probed.length - 1) * CANVAS_NODE_LAYOUT_GAP;

    const newNodes = probed.map((res, idx) => {
      const flowPos = {
        x: originFlow.x - totalW_FLOW / 2 + idx * (CANVAS_NODE_LAYOUT_W + CANVAS_NODE_LAYOUT_GAP),
        y: originFlow.y,
      };
      const nodeId  = getId(nodesRef.current);
      if (res.kind === 'image') {
        return {
          id: nodeId, type: 'AIImageNode', position: flowPos, dragHandle: NODE_DRAG_HANDLE_SELECTOR,
          data: {
            capturedFrame: {
              src: res.url,
              width: res.w,
              height: res.h,
              name: res.name,
              previewUpdatedAt: new Date().toISOString(),
            },
            uiDismissToken,
          },
          style: { opacity: 0, transition: 'opacity 180ms ease-out' },
        };
      } else {
        return {
          id: nodeId, type: 'AIVideoNode', position: flowPos, dragHandle: NODE_DRAG_HANDLE_SELECTOR,
          data: {
            videoMode: 'asset',
            capturedClip: {
              src: res.url,
              name: res.name,
              duration: res.dur,
              previewUpdatedAt: new Date().toISOString(),
            },
            uiDismissToken,
          },
          style: { opacity: 0, transition: 'opacity 180ms ease-out' },
        };
      }
    });

    setNodes((nds) => nds.concat(newNodes));
    requestAnimationFrame(() => {
      setNodes((nds) =>
        nds.map((n) =>
          newNodes.find((nn) => nn.id === n.id)
            ? { ...n, style: { ...n.style, opacity: 1 } }
            : n
        )
      );
    });
  }, [screenToFlowPosition, uiDismissToken, saveSnapshot]);

  // ── Bulk file upload (right-click → 上传) ──────────────────────────────────
  const handleBulkUpload = useCallback(async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    await importExternalMediaFiles(files, paneMenuOriginRef.current);
  }, [importExternalMediaFiles]);

  const handleExternalMediaDragOver = useCallback((event) => {
    const types = Array.from(event.dataTransfer?.types || []);
    if (types.includes(MATERIAL_LIBRARY_DRAG_MIME)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      return;
    }
    if (!types.includes('Files')) return;
    const hasSupportedItem = Array.from(event.dataTransfer?.items || []).some((item) => {
      if (item.kind !== 'file') return false;
      const type = String(item.type || '').toLowerCase();
      return !type || type.startsWith('image/') || type.startsWith('video/');
    });
    if (!hasSupportedItem) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleExternalMediaDrop = useCallback(async (event) => {
    const materialPayload = event.dataTransfer?.getData(MATERIAL_LIBRARY_DRAG_MIME);
    if (materialPayload) {
      event.preventDefault();
      event.stopPropagation();
      setPaneContextMenu(null);
      clearBulkConnectState();
      cancelPendingConnection();
      setUiDismissToken((v) => v + 1);
      try {
        const item = JSON.parse(materialPayload);
        addMaterialLibraryItemToCanvas(item, {
          x: event.clientX,
          y: event.clientY,
        });
      } catch (error) {
        console.error('[material library drag]', error);
      }
      return;
    }
    const files = Array.from(event.dataTransfer?.files || []);
    const supportedFiles = files.filter(isSupportedMediaFile);
    if (!supportedFiles.length) return;
    event.preventDefault();
    event.stopPropagation();
    setPaneContextMenu(null);
    clearBulkConnectState();
    cancelPendingConnection();
    setUiDismissToken((v) => v + 1);
    await importExternalMediaFiles(supportedFiles, {
      x: event.clientX,
      y: event.clientY,
    });
  }, [addMaterialLibraryItemToCanvas, cancelPendingConnection, clearBulkConnectState, importExternalMediaFiles]);

  const onPaneContextMenu = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    clearBulkConnectState();
    cancelPendingConnection();
    paneMenuOriginRef.current = { x: event.clientX, y: event.clientY };
    setUiDismissToken((v) => v + 1);
    setPaneContextMenu({
      left: event.clientX,
      top: event.clientY,
      stage: 'root',
    });
  }, [cancelPendingConnection, clearBulkConnectState]);

  const openNodeCategoryMenu = useCallback(() => {
    setPaneContextMenu((prev) => (prev ? { ...prev, stage: 'nodes' } : null));
  }, []);

  const closePaneContextMenu = useCallback(() => {
    setPaneContextMenu(null);
  }, []);

  const multiSelectToolbarEligible =
    selectedNodeIds.length >= 2 &&
    selectedNodeIds.every((id) => {
      const n = nodes.find((x) => x.id === id);
      return n && ASSET_NODE_TYPES.has(n.type) && !n.parentId;
    });

  const canSaveSelectionToMaterialLibrary = selectedNodeIds.some((id) => {
    const node = nodes.find((item) => item.id === id);
    return Boolean(buildMaterialDraftFromNode(node));
  });

  const selectedGroupNode = useMemo(() => {
    if (selectedNodeIds.length !== 1) return null;
    const node = nodes.find((item) => item.id === selectedNodeIds[0]);
    return node?.type === 'GroupPanelNode' ? node : null;
  }, [nodes, selectedNodeIds]);

  const selectedNodesForUi = useMemo(() => {
    if (selectedNodeIds.length < 2) return [];
    const selectedIdSet = new Set(selectedNodeIds);
    return nodes.filter((node) => selectedIdSet.has(node.id));
  }, [nodes, selectedNodeIds]);

  const selectedBoundsForUi = useMemo(() => {
    if (selectedNodesForUi.length < 2) return null;
    return getNodesDataBounds(selectedNodesForUi);
  }, [getNodesDataBounds, selectedNodesForUi]);

  const selectedAssetNodesForToolbar = useMemo(() => {
    if (!multiSelectToolbarEligible) return [];
    return selectedNodesForUi;
  }, [multiSelectToolbarEligible, selectedNodesForUi]);

  const multiToolbarPos = useMemo(() => {
    if (selectedAssetNodesForToolbar.length < 2) return null;
    const bounds = selectedBoundsForUi;
    if (!bounds) return null;
    return {
      left: (bounds.x + bounds.width / 2) * viewport.zoom + viewport.x,
      top: bounds.y * viewport.zoom + viewport.y - 72,
    };
  }, [
    selectedAssetNodesForToolbar,
    selectedBoundsForUi,
    viewport.x,
    viewport.y,
    viewport.zoom,
  ]);

  const groupToolbarPos = useMemo(() => {
    if (!selectedGroupNode) return null;
    const width =
      selectedGroupNode.measured?.width ??
      selectedGroupNode.width ??
      selectedGroupNode.style?.width ??
      80;
    const numericWidth = Number(width) || 80;
    const x = selectedGroupNode.positionAbsolute?.x ?? selectedGroupNode.position?.x ?? 0;
    const y = selectedGroupNode.positionAbsolute?.y ?? selectedGroupNode.position?.y ?? 0;
    return {
      left: (x + numericWidth / 2) * viewport.zoom + viewport.x,
      top: y * viewport.zoom + viewport.y - 58,
    };
  }, [
    selectedGroupNode?.id,
    selectedGroupNode?.measured?.width,
    selectedGroupNode?.width,
    selectedGroupNode?.style?.width,
    selectedGroupNode?.positionAbsolute?.x,
    selectedGroupNode?.positionAbsolute?.y,
    selectedGroupNode?.position?.x,
    selectedGroupNode?.position?.y,
    viewport.x,
    viewport.y,
    viewport.zoom,
  ]);

  const bulkSelectionHandlePos = useMemo(() => {
    if (selectedAssetNodesForToolbar.length < 2) return null;
    const bounds = selectedBoundsForUi;
    if (!bounds) return null;
    return {
      left: (bounds.x + bounds.width) * viewport.zoom + viewport.x + 18,
      top: (bounds.y + bounds.height / 2) * viewport.zoom + viewport.y,
    };
  }, [
    selectedAssetNodesForToolbar,
    selectedBoundsForUi,
    viewport.x,
    viewport.y,
    viewport.zoom,
  ]);

  const multiSelectionOverlayRect = useMemo(() => {
    if (selectedNodesForUi.length < 2) return null;
    const bounds = selectedBoundsForUi;
    if (!bounds) return null;
    const padding = 18;
    return {
      left: bounds.x * viewport.zoom + viewport.x - padding,
      top: bounds.y * viewport.zoom + viewport.y - padding,
      width: bounds.width * viewport.zoom + padding * 2,
      height: bounds.height * viewport.zoom + padding * 2,
    };
  }, [
    selectedBoundsForUi,
    selectedNodesForUi.length,
    viewport.x,
    viewport.y,
    viewport.zoom,
  ]);

  const bulkPreviewPaths = useMemo(() => {
    if (!bulkConnectState?.sourceNodeIds?.length) return [];
    const targetFlowPoint = bulkConnectState.currentPoint;
    if (!targetFlowPoint) return [];

    const targetScreenPoint = flowToScreenPosition(targetFlowPoint);
    return bulkConnectState.sourceNodeIds
      .map((sourceNodeId) => {
        const sourceFlowPoint = getHandlePoint(sourceNodeId, Position.Right);
        if (!sourceFlowPoint) return null;
        const sourceScreenPoint = flowToScreenPosition(sourceFlowPoint);
        const [path] = getBezierPath({
          sourceX: sourceScreenPoint.x,
          sourceY: sourceScreenPoint.y,
          targetX: targetScreenPoint.x,
          targetY: targetScreenPoint.y,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
        });

        return {
          id: `bulk-preview-${sourceNodeId}`,
          path,
        };
      })
      .filter(Boolean);
  }, [
    bulkConnectState,
    flowToScreenPosition,
    getHandlePoint,
    viewport.x,
    viewport.y,
    viewport.zoom,
  ]);

  const arrangeSelectedAssets = useCallback(
    (mode) => {
      const sel = nodes.filter(
        (n) => selectedNodeIds.includes(n.id) && ASSET_NODE_TYPES.has(n.type) && !n.parentId
      );
      if (sel.length < 2) return;
      saveSnapshot();
      const STEP = CANVAS_NODE_LAYOUT_W + CANVAS_NODE_LAYOUT_GAP;
      const GAP = CANVAS_NODE_LAYOUT_GAP;

      const absOf = (id) =>
        getInternalNode(id)?.internals?.positionAbsolute ??
        nodes.find((x) => x.id === id)?.position ?? { x: 0, y: 0 };
      const heightOf = (id) =>
        getInternalNode(id)?.measured?.height ??
        nodes.find((x) => x.id === id)?.measured?.height ??
        280;

      const posMap = new Map();

      if (mode === 'horizontal') {
        const sorted = [...sel].sort((a, b) => absOf(a.id).x - absOf(b.id).x);
        const anchorX = Math.min(...sorted.map((n) => absOf(n.id).x));
        const anchorY = sorted.reduce((s, n) => s + absOf(n.id).y, 0) / sorted.length;
        sorted.forEach((n, i) => posMap.set(n.id, { x: anchorX + i * STEP, y: anchorY }));
      } else if (mode === 'vertical') {
        const sorted = [...sel].sort((a, b) => absOf(a.id).y - absOf(b.id).y);
        const anchorX = sorted.reduce((s, n) => s + absOf(n.id).x, 0) / sorted.length;
        let y = Math.min(...sorted.map((n) => absOf(n.id).y));
        sorted.forEach((n) => {
          posMap.set(n.id, { x: anchorX, y });
          y += heightOf(n.id) + GAP;
        });
      } else if (mode === 'grid') {
        const sorted = [...sel].sort((a, b) => {
          const pa = absOf(a.id);
          const pb = absOf(b.id);
          if (Math.abs(pa.y - pb.y) > 40) return pa.y - pb.y;
          return pa.x - pb.x;
        });
        const anchorX = Math.min(...sorted.map((n) => absOf(n.id).x));
        let rowY = Math.min(...sorted.map((n) => absOf(n.id).y));
        const COLS = 6;
        for (let i = 0; i < sorted.length; i += COLS) {
          const row = sorted.slice(i, i + COLS);
          const rowH = Math.max(...row.map((n) => heightOf(n.id)));
          row.forEach((n, col) => {
            posMap.set(n.id, { x: anchorX + col * STEP, y: rowY });
          });
          rowY += rowH + GAP;
        }
      }

      setNodes((nds) =>
        nds.map((n) => {
          const p = posMap.get(n.id);
          return p ? { ...n, position: p } : n;
        })
      );
      requestAnimationFrame(() => {
        sel.forEach((n) => updateNodeInternals(n.id));
      });
    },
    [
      nodes,
      selectedNodeIds,
      saveSnapshot,
      getInternalNode,
      updateNodeInternals,
    ]
  );

  const groupSelectedAssets = useCallback(() => {
    const sel = nodes.filter(
      (n) => selectedNodeIds.includes(n.id) && ASSET_NODE_TYPES.has(n.type) && !n.parentId
    );
    if (sel.length < 2) return;
    saveSnapshot();
    const bounds = getNodesBounds(sel.map((n) => n.id));
    const padding = 32;
    const gx = bounds.x - padding;
    const gy = bounds.y - padding;
    const gw = bounds.width + 2 * padding;
    const gh = bounds.height + 2 * padding;
    const groupId = getId(nodesRef.current);
    const selIds = new Set(sel.map((n) => n.id));
    const absMap = new Map(
      sel.map((n) => [
        n.id,
        getInternalNode(n.id)?.internals?.positionAbsolute ?? n.position,
      ])
    );

    setNodes((nds) => {
      const groupNode = {
        id: groupId,
        type: 'GroupPanelNode',
        position: { x: gx, y: gy },
        dragHandle: NODE_DRAG_HANDLE_SELECTOR,
        style: { width: gw, height: gh },
        data: { uiDismissToken },
        zIndex: 0,
        selectable: true,
        draggable: true,
        selected: true,
      };
      const next = nds.map((n) => {
        if (selIds.has(n.id)) {
          const abs = absMap.get(n.id) ?? n.position;
          return {
            ...n,
            parentId: groupId,
            position: { x: abs.x - gx, y: abs.y - gy },
            zIndex: 1,
            selected: false,
          };
        }
        return { ...n, selected: false };
      });
      return [groupNode, ...next];
    });
    setSelectedNodeIds([groupId]);
    setSingleSelectedNodeId(groupId);
    setFocusedNodeId(null);
    requestAnimationFrame(() => {
      updateNodeInternals(groupId);
      sel.forEach((n) => updateNodeInternals(n.id));
    });
  }, [
    nodes,
    selectedNodeIds,
    saveSnapshot,
    getNodesBounds,
    getInternalNode,
    uiDismissToken,
    updateNodeInternals,
  ]);

  const ungroupSelectedGroup = useCallback(() => {
    if (selectedNodeIds.length !== 1) return;
    const groupId = selectedNodeIds[0];
    const groupNode = nodes.find((node) => node.id === groupId);
    if (groupNode?.type !== 'GroupPanelNode') return;

    const childNodes = nodes.filter((node) => node.parentId === groupId);
    if (!childNodes.length) return;

    saveSnapshot();
    const childIds = childNodes.map((node) => node.id);

    setNodes((nds) => {
      const liveGroup = nds.find((node) => node.id === groupId);
      const groupPosition = liveGroup?.position ?? groupNode.position ?? { x: 0, y: 0 };

      return nds.flatMap((node) => {
        if (node.id === groupId) return [];
        if (node.parentId !== groupId) return { ...node, selected: false };

        const absolutePosition =
          getInternalNode(node.id)?.internals?.positionAbsolute ?? {
            x: groupPosition.x + node.position.x,
            y: groupPosition.y + node.position.y,
          };

        return {
          ...node,
          parentId: undefined,
          extent: undefined,
          position: absolutePosition,
          selected: true,
        };
      });
    });

    setSelectedNodeIds(childIds);
    setSingleSelectedNodeId(null);
    setFocusedNodeId(null);
    requestAnimationFrame(() => {
      childIds.forEach((id) => updateNodeInternals(id));
    });
  }, [
    selectedNodeIds,
    nodes,
    saveSnapshot,
    getInternalNode,
    updateNodeInternals,
  ]);

  const duplicateSelectedAssets = useCallback(() => {
    const sel = nodes.filter(
      (n) => selectedNodeIds.includes(n.id) && ASSET_NODE_TYPES.has(n.type) && !n.parentId
    );
    if (!sel.length) return;
    saveSnapshot();
    const delta = CANVAS_NODE_LAYOUT_GAP;
    const selectedIdSet = new Set(sel.map((node) => node.id));
    const idMap = new Map();
    const newNodes = sel.map((node) => {
      const newId = getId(nodesRef.current);
      idMap.set(node.id, newId);
      return {
        ...node,
        id: newId,
        position: { x: node.position.x + delta, y: node.position.y + delta },
        selected: true,
        parentId: undefined,
        extent: undefined,
        data: { ...(node.data || {}), uiDismissToken },
      };
    });
    const connectedEdges = edges.filter(
      (edge) => selectedIdSet.has(edge.source) || selectedIdSet.has(edge.target)
    );
    const duplicatedEdges = duplicateConnectedEdges({
      edgesToCopy: connectedEdges,
      idMap,
      existingEdges: edges,
    });
    setNodes((nds) => nds.map((n) => ({ ...n, selected: false })).concat(newNodes));
    setEdges((eds) => eds.map((edge) => ({ ...edge, selected: false })).concat(duplicatedEdges));
    setSelectedNodeIds(newNodes.map((n) => n.id));
    setSelectedEdgeIds(duplicatedEdges.map((edge) => edge.id));
    setSingleSelectedNodeId(null);
    setFocusedNodeId(null);
    requestAnimationFrame(() => newNodes.forEach((n) => updateNodeInternals(n.id)));
  }, [nodes, selectedNodeIds, saveSnapshot, uiDismissToken, updateNodeInternals, edges]);

  const onNodeDragStop = useCallback(
    (_, node) => {
      if (!node?.parentId) return;

      const parentInternal = getInternalNode(node.parentId);
      const nodeInternal = getInternalNode(node.id);
      if (!parentInternal || !nodeInternal) return;

      const parentAbs = parentInternal.internals?.positionAbsolute ?? { x: 0, y: 0 };
      const parentW =
        parentInternal.measured?.width ??
        parentInternal.internals?.userNode?.style?.width ??
        0;
      const parentH =
        parentInternal.measured?.height ??
        parentInternal.internals?.userNode?.style?.height ??
        0;

      const nodeAbs = nodeInternal.internals?.positionAbsolute ?? node.position;

      const isInsideParent =
        nodeAbs.x >= parentAbs.x &&
        nodeAbs.y >= parentAbs.y &&
        nodeAbs.x <= parentAbs.x + parentW &&
        nodeAbs.y <= parentAbs.y + parentH;

      if (isInsideParent) return;

      setNodes((nds) =>
        nds.map((n) =>
          n.id === node.id
            ? {
                ...n,
                parentId: undefined,
                extent: undefined,
                position: { x: nodeAbs.x, y: nodeAbs.y },
              }
            : n
        )
      );

      requestAnimationFrame(() => {
        updateNodeInternals(node.id);
      });
    },
    [getInternalNode, updateNodeInternals]
  );

  const onSelectionChange = useCallback(({ nodes: selectedNodes, edges: selectedEdges = [] }) => {
    const nextSelectedNodeIds = selectedNodes.map((node) => node.id).sort();
    const nextSelectedEdgeIds = selectedEdges.map((edge) => edge.id).sort();
    const nextSingleSelectedNodeId = selectedNodes.length === 1 ? selectedNodes[0].id : null;
    const nextTextEditingNodeId =
      selectedNodes.length === 1 && selectedNodes[0].id === textEditingNodeIdRef.current
        ? textEditingNodeIdRef.current
        : null;

    if (singleSelectedNodeIdRef.current !== nextSingleSelectedNodeId) {
      singleSelectedNodeIdRef.current = nextSingleSelectedNodeId;
      setSingleSelectedNodeId(nextSingleSelectedNodeId);
    }
    if (selectedNodes.length !== 1 && focusedNodeIdRef.current !== null) {
      focusedNodeIdRef.current = null;
      setFocusedNodeId(null);
    }
    if (textEditingNodeIdRef.current !== nextTextEditingNodeId) {
      textEditingNodeIdRef.current = nextTextEditingNodeId;
      setTextEditingNodeId(nextTextEditingNodeId);
    }
    if (!areStringArraysEqual(selectedNodeIdsRef.current, nextSelectedNodeIds)) {
      selectedNodeIdsRef.current = nextSelectedNodeIds;
      setSelectedNodeIds(nextSelectedNodeIds);
    }
    if (!areStringArraysEqual(selectedEdgeIdsRef.current, nextSelectedEdgeIds)) {
      selectedEdgeIdsRef.current = nextSelectedEdgeIds;
      setSelectedEdgeIds(nextSelectedEdgeIds);
    }
  }, []);

  const onSelectionStart = useCallback(
    (event) => {
      selectionStartFlowRef.current = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    },
    [screenToFlowPosition]
  );

  const onSelectionEnd = useCallback(
    (event) => {
      const start = selectionStartFlowRef.current;
      selectionStartFlowRef.current = null;
      if (!start) return;

      const end = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const rect = {
        minX: Math.min(start.x, end.x),
        maxX: Math.max(start.x, end.x),
        minY: Math.min(start.y, end.y),
        maxY: Math.max(start.y, end.y),
      };

      const matchedEdgeIds = edges
        .filter((edge) => {
          const sourcePos = edge.sourcePosition || Position.Right;
          const targetPos = edge.targetPosition || Position.Left;
          const sourcePoint = getHandlePoint(edge.source, sourcePos);
          const targetPoint = getHandlePoint(edge.target, targetPos);
          if (!sourcePoint || !targetPoint) return false;

          const adjustedSource = adjustAnchorForOverlap(sourcePoint.x, sourcePoint.y, sourcePos);
          const adjustedTarget = adjustAnchorForOverlap(targetPoint.x, targetPoint.y, targetPos);
          return lineIntersectsRect(adjustedSource, adjustedTarget, rect);
        })
        .map((edge) => edge.id);

      if (!matchedEdgeIds.length) return;

      setSelectedEdgeIds((prev) => Array.from(new Set([...prev, ...matchedEdgeIds])));
      setEdges((eds) =>
        eds.map((edge) =>
          matchedEdgeIds.includes(edge.id) ? { ...edge, selected: true } : edge
        )
      );
    },
    [edges, getHandlePoint, lineIntersectsRect, screenToFlowPosition]
  );

  useEffect(() => {
    // Sync edge highlight with React Flow built-in selection (including box selection).
    const selectedFromStore = edges.filter((edge) => edge.selected).map((edge) => edge.id);
    setSelectedEdgeIds((prev) => {
      const prevKey = prev.join('|');
      const nextKey = selectedFromStore.join('|');
      return prevKey === nextKey ? prev : selectedFromStore;
    });
  }, [edges]);

  const handleEdgeMouseEnter = useCallback((_, edge) => {
    setHoveredEdgeId(edge.id);
  }, []);

  const handleEdgeMouseMove = useCallback((_, __) => {}, []);

  const handleEdgeMouseLeave = useCallback((_, edge) => {
    setHoveredEdgeId((current) => (current === edge.id ? null : current));
  }, []);

  const handleEdgeClick = useCallback((event, edge) => {
    event.stopPropagation();
    setSelectedEdgeIds([edge.id]);
  }, []);

  useEffect(() => {
    let lastPointerEvent = null;
    let rafId = null;

    const flushPointerForPaste = () => {
      rafId = null;
      const event = lastPointerEvent;
      lastPointerEvent = null;
      if (!event || !reactFlowWrapper.current) return;
      const bounds = reactFlowWrapper.current.getBoundingClientRect();
      const inFlowBounds =
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom;
      if (!inFlowBounds) return;
      pasteAnchorFlowRef.current = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    };

    const trackPointerForPaste = (event) => {
      lastPointerEvent = event;
      if (rafId != null) return;
      rafId = window.requestAnimationFrame(flushPointerForPaste);
    };

    window.addEventListener('pointermove', trackPointerForPaste);
    return () => {
      window.removeEventListener('pointermove', trackPointerForPaste);
      if (rafId != null) window.cancelAnimationFrame(rafId);
    };
  }, [screenToFlowPosition]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      const target = event.target;
      const isEditableTarget =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (isEditableTarget) return;

      const isMetaPressed = event.ctrlKey || event.metaKey;

      // Ctrl/Cmd+Z — undo (up to 10 steps)
      if (isMetaPressed && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
        return;
      }

      // L key — same spacing as bulk import; left-anchored so repeated L does not drift
      if (event.key.toLowerCase() === 'l' && !isMetaPressed && selectedNodeIds.length >= 2) {
        event.preventDefault();
        saveSnapshot();
        const selNodes = nodes.filter((n) => selectedNodeIds.includes(n.id));
        selNodes.sort((a, b) => a.position.x - b.position.x);
        const STEP = CANVAS_NODE_LAYOUT_W + CANVAS_NODE_LAYOUT_GAP;
        const anchorX = Math.min(...selNodes.map((n) => n.position.x));
        const avgY = selNodes.reduce((s, n) => s + n.position.y, 0) / selNodes.length;
        const posMap = new Map(
          selNodes.map((n, i) => [n.id, { x: anchorX + i * STEP, y: avgY }])
        );
        setNodes((nds) =>
          nds.map((n) => {
            const p = posMap.get(n.id);
            return p ? { ...n, position: p } : n;
          })
        );
        return;
      }

      if (event.key.toLowerCase() === 'a' && !isMetaPressed && selectedNodeIds.length >= 2) {
        event.preventDefault();
        arrangeSelectedAssets('grid');
        return;
      }

      if (event.key.toLowerCase() === 'f' && !isMetaPressed) {
        event.preventDefault();
        const selectedNodes = nodes.filter((node) => selectedNodeIds.includes(node.id));
        if (selectedNodes.length > 0) {
          fitView({
            nodes: selectedNodes,
            padding: 0.22,
            duration: 240,
            minZoom: 0.08,
            maxZoom: 5,
          });
        } else {
          fitView({
            padding: 0.18,
            duration: 240,
            minZoom: 0.02,
            maxZoom: 5,
          });
        }
        return;
      }

      if (isMetaPressed && event.key.toLowerCase() === 'c') {
        if (!selectedNodeIds.length) return;
        event.preventDefault();
        const selectedIdSet = new Set(selectedNodeIds);
        const selectedNodes = nodes.filter((node) => selectedIdSet.has(node.id));
        const connectedEdgesForNodes = edges.filter(
          (edge) => selectedIdSet.has(edge.source) || selectedIdSet.has(edge.target)
        );
        clipboardRef.current = {
          nodes: selectedNodes.map((node) => ({
            ...node,
            selected: false,
          })),
          edges: connectedEdgesForNodes.map((edge) => ({
            ...edge,
            selected: false,
          })),
        };
        pasteStepRef.current = 0;
        return;
      }

      if (isMetaPressed && event.key.toLowerCase() === 'v') {
        if (!clipboardRef.current?.nodes?.length) return;
        event.preventDefault();
        saveSnapshot();
        pasteStepRef.current += 1;
        const cursorFlowPosition =
          pasteAnchorFlowRef.current ||
          screenToFlowPosition({
            x: window.innerWidth / 2,
            y: window.innerHeight / 2,
          });
        const copiedNodes = clipboardRef.current.nodes;
        const minX = Math.min(...copiedNodes.map((node) => node.position.x));
        const minY = Math.min(...copiedNodes.map((node) => node.position.y));
        const maxX = Math.max(...copiedNodes.map((node) => node.position.x));
        const maxY = Math.max(...copiedNodes.map((node) => node.position.y));
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const cascadeOffset = (pasteStepRef.current - 1) * 18;
        const deltaX = cursorFlowPosition.x - centerX + cascadeOffset;
        const deltaY = cursorFlowPosition.y - centerY + cascadeOffset;
        const idMap = new Map();

        const duplicatedNodes = copiedNodes.map((node) => {
          const newId = getId(nodesRef.current);
          idMap.set(node.id, newId);
          return {
            ...node,
            id: newId,
            position: {
              x: node.position.x + deltaX,
              y: node.position.y + deltaY,
            },
            selected: true,
            data: {
              ...(node.data || {}),
              uiDismissToken,
            },
          };
        });

        const duplicatedEdges = duplicateConnectedEdges({
          edgesToCopy: clipboardRef.current.edges || [],
          idMap,
          existingEdges: edges,
        });

        setNodes((nds) =>
          nds
            .map((node) => ({ ...node, selected: false }))
            .concat(duplicatedNodes)
        );
        setEdges((eds) =>
          eds
            .map((edge) => ({ ...edge, selected: false }))
            .concat(duplicatedEdges)
        );
        setSelectedNodeIds(duplicatedNodes.map((node) => node.id));
        setSelectedEdgeIds(duplicatedEdges.map((edge) => edge.id));
        setSingleSelectedNodeId(duplicatedNodes.length === 1 ? duplicatedNodes[0].id : null);
        setFocusedNodeId(null);

        requestAnimationFrame(() => {
          duplicatedNodes.forEach((node) => updateNodeInternals(node.id));
        });
        return;
      }

      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (!selectedNodeIds.length && !selectedEdgeIds.length) return;
      event.preventDefault();
      saveSnapshot();
      if (selectedNodeIds.length) {
        const selectedNodeIdSet = new Set(selectedNodeIds);
        setNodes((nds) => nds.filter((node) => !selectedNodeIdSet.has(node.id)));
        setEdges((eds) =>
          eds.filter(
            (edge) =>
              !selectedEdgeIds.includes(edge.id) &&
              !selectedNodeIdSet.has(edge.source) &&
              !selectedNodeIdSet.has(edge.target)
          )
        );
        setSelectedNodeIds([]);
        setSingleSelectedNodeId(null);
        setFocusedNodeId(null);
        setTextEditingNodeId(null);
        setMaximizedViewNodeId(null);
      } else {
        setEdges((eds) => eds.filter((edge) => !selectedEdgeIds.includes(edge.id)));
      }
      setHoveredEdgeId((current) => (current && selectedEdgeIds.includes(current) ? null : current));
      setSelectedEdgeIds([]);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedEdgeIds, selectedNodeIds, nodes, edges, uiDismissToken, updateNodeInternals, screenToFlowPosition, undo, saveSnapshot, arrangeSelectedAssets, fitView]);

  const canvasUiValue = useMemo(
    () => ({
      saveSnapshot,
      persistNodeData,
      flushProjectSave,
      onRequestSaveToMaterial: openSaveToMaterialModal,
    }),
    [saveSnapshot, persistNodeData, flushProjectSave, openSaveToMaterialModal]
  );

  return (
    <CanvasUiContext.Provider value={canvasUiValue}>
      <div
        className={`w-screen h-screen bg-[#181818] relative ${selectedNodeIds.length === 1 ? 'single-node-selection-active' : ''}`}
        style={{ width: '100vw', height: '100vh', ...editorBarViewportVars }}
        ref={reactFlowWrapper}
        onDragOver={handleExternalMediaDragOver}
        onDrop={handleExternalMediaDrop}
      >
      {multiSelectionOverlayRect && (
        <div
          className="multi-selection-overlay"
          style={{
            left: multiSelectionOverlayRect.left,
            top: multiSelectionOverlayRect.top,
            width: multiSelectionOverlayRect.width,
            height: multiSelectionOverlayRect.height,
          }}
        />
      )}

      <ReactFlow
        className="w-full h-full"
        style={{ width: '100%', height: '100%', position: 'relative', zIndex: 1 }}
        nodes={nodes}
        edges={renderedEdges}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        nodeTypes={nodeTypes}
        onlyRenderVisibleElements
        connectionLineType={ConnectionLineType.Bezier}
        connectOnClick={false}
        connectionLineStyle={normalEdgeStyle}
        connectionLineComponent={connectStart ? EnergyConnectionLine : undefined}
        defaultEdgeOptions={{ style: normalEdgeStyle, type: 'default', selectable: true, focusable: true }}
        panOnDrag={[1]}
        selectionOnDrag={true}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={['Control', 'Meta', 'Shift']}
        panOnScroll={false}
        zoomOnScroll
        zoomOnPinch
        onPaneContextMenu={onPaneContextMenu}
        onNodeDragStart={saveSnapshot}
        onNodeDragStop={onNodeDragStop}
        onSelectionChange={onSelectionChange}
        onSelectionStart={onSelectionStart}
        onSelectionEnd={onSelectionEnd}
        onEdgeMouseEnter={handleEdgeMouseEnter}
        onEdgeMouseMove={handleEdgeMouseMove}
        onEdgeMouseLeave={handleEdgeMouseLeave}
        onEdgeClick={handleEdgeClick}
        onNodeClick={(_, node) => {
          if (node.type === 'AITextNode') {
            setFocusedNodeId(node.id);
            setTextEditingNodeId(null);
            return;
          }
          setTextEditingNodeId(null);
          setFocusedNodeId(node.id);
        }}
        onNodeDoubleClick={(event, node) => {
          setFocusedNodeId(node.id);
          setSingleSelectedNodeId(node.id);
          setTextEditingNodeId(node.type === 'AITextNode' ? node.id : null);
          setNodes((nds) =>
            nds.map((n) => ({
              ...n,
              selected: n.id === node.id,
            }))
          );
          if (node.type === 'AITextNode') {
            setMaximizedViewNodeId(null);
            return;
          }

          /** 图片 / 视频节点：仅在双击上半区（预览/标题区域）时进入画布放大；编辑区双击不放大 */
          if (node.type === 'AIImageNode') {
            const target = event?.target;
            if (target?.closest?.('[data-role="node-detail-panel"]')) {
              return;
            }
            if (!target?.closest?.('[data-role="node-image-upper"]')) {
              return;
            }
          }
          if (node.type === 'AIVideoNode') {
            const target = event?.target;
            if (target?.closest?.('[data-role="node-detail-panel"]')) {
              return;
            }
            if (!target?.closest?.('[data-role="node-video-upper"]')) {
              return;
            }
          }

          setMaximizedViewNodeId(node.id);

          /**
           * maximizedViewNodeId 经 useEffect 写入 node.data 后编辑区才会缩小。setTimeout(0)+双 rAF 后，
           * 用 rAF 轮询同一套测量签名直到连续稳定（表示布局已跟上），再只执行一次 setCenter。
           * 固定长时间 setTimeout 会让相机先停住几百毫秒再动，体感卡顿；自适应通常 ~2–4 帧即可开始动画。
           */
          setTimeout(() => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const runMaximizeViewportFit = () => {
                  const container = reactFlowWrapper.current;
                  if (!container) return;
                  const nodeEl = container.querySelector(
                    `.react-flow__node[data-id="${node.id}"]`
                  );
                  if (!nodeEl) return;

                  const nb = nodeEl.getBoundingClientRect();

                  const toolbarEl = nodeEl.querySelector('[data-role="node-image-toolbar"]');
                  const tb = toolbarEl ? toolbarEl.getBoundingClientRect() : null;

                  const detailEl = nodeEl.querySelector('[data-role="node-detail-panel"]');
                  const db = detailEl ? detailEl.getBoundingClientRect() : null;

                  const screenLeft = nb.left;
                  const screenRight = nb.right;
                  const screenTop = tb ? Math.min(nb.top, tb.top) : nb.top;
                  const screenBottom = db ? Math.max(nb.bottom, db.bottom) : nb.bottom;

                  const cBounds = container.getBoundingClientRect();
                  const isMediaMaximizeFit =
                    node.type === 'AIImageNode' || node.type === 'AIVideoNode';
                  if (isMediaMaximizeFit) {
                    const previewSelector =
                      node.type === 'AIImageNode'
                        ? '[data-role="node-image-preview"]'
                        : '[data-role="node-video-preview"]';
                    const previewEl = nodeEl.querySelector(previewSelector);
                    const pr = previewEl?.getBoundingClientRect?.();
                    const toolbarFit = toolbarEl?.getBoundingClientRect?.();

                    let fitLeft = pr?.left ?? nb.left;
                    let fitRight = pr?.right ?? nb.right;
                    let fitTop = pr?.top ?? nb.top;
                    let fitBottom = pr?.bottom ?? nb.bottom;

                    if (toolbarFit && toolbarFit.width > 1 && toolbarFit.height > 1) {
                      fitLeft = Math.min(fitLeft, toolbarFit.left);
                      fitRight = Math.max(fitRight, toolbarFit.right);
                      fitTop = Math.min(fitTop, toolbarFit.top);
                      fitBottom = Math.max(fitBottom, toolbarFit.bottom);
                    }

                    if (db && db.width > 1 && db.height > 1) {
                      fitLeft = Math.min(fitLeft, db.left);
                      fitRight = Math.max(fitRight, db.right);
                      fitBottom = Math.max(fitBottom, db.bottom);
                    }

                    const imageFlowTL = screenToFlowPosition({
                      x: fitLeft,
                      y: fitTop,
                    });
                    const imageFlowBR = screenToFlowPosition({
                      x: fitRight,
                      y: fitBottom,
                    });
                    const imageFlowW = Math.max(1e-6, imageFlowBR.x - imageFlowTL.x);
                    const imageFlowH = Math.max(1e-6, imageFlowBR.y - imageFlowTL.y);
                    const margin = 28;
                    const safeW = Math.max(160, cBounds.width - margin * 2);
                    const safeH = Math.max(160, cBounds.height - margin * 2);
                    const centerX = (imageFlowTL.x + imageFlowBR.x) / 2;
                    const centerY = (imageFlowTL.y + imageFlowBR.y) / 2;
                    const fitPadding = 0.92;
                    const zoomW = (safeW / imageFlowW) * fitPadding;
                    const zoomH = (safeH / imageFlowH) * fitPadding;
                    const nextZoom = Math.min(5, Math.max(0.35, Math.min(zoomW, zoomH)));

                    setCenter(centerX, centerY, { zoom: nextZoom, duration: 280 });
                    return;
                  }

                  const flowTL = screenToFlowPosition({ x: screenLeft, y: screenTop });
                  const flowBR = screenToFlowPosition({ x: screenRight, y: screenBottom });
                  const flowW = flowBR.x - flowTL.x;
                  const flowH = flowBR.y - flowTL.y;
                  const centerX = (flowTL.x + flowBR.x) / 2;
                  const centerY = (flowTL.y + flowBR.y) / 2;
                  const safeW = Math.max(200, cBounds.width - 140);
                  const safeH = Math.max(200, cBounds.height - 140);
                  const nextZoom = Math.min(
                    2.4,
                    Math.max(0.6, Math.min(safeW / flowW, safeH / flowH) * 0.82)
                  );

                  setCenter(centerX, centerY, { zoom: nextZoom, duration: 280 });
                };

                const readLayoutSig = () => {
                  const container = reactFlowWrapper.current;
                  if (!container) return null;
                  const nodeEl = container.querySelector(
                    `.react-flow__node[data-id="${node.id}"]`
                  );
                  if (!nodeEl) return null;
                  const nb = nodeEl.getBoundingClientRect();
                  const detailEl = nodeEl.querySelector('[data-role="node-detail-panel"]');
                  const db = detailEl?.getBoundingClientRect?.();
                  const dh = db && db.height > 1 ? Math.round(db.height) : 0;
                  return `${Math.round(nb.width)}:${Math.round(nb.height)}:${dh}`;
                };

                const minFramesBeforeStable = 4;
                const stableFramesNeeded = 2;
                const minElapsedAfterChangeMs = 40;
                const noTransitionFallbackMs = 95;
                const hardCapMs = 200;
                const hardCapFrames = 22;

                let frames = 0;
                let stableRun = 0;
                let prevSig = null;
                let baselineSig = null;
                let sawSigChange = false;
                const t0 =
                  typeof performance !== 'undefined' && performance.now
                    ? performance.now()
                    : Date.now();

                const tick = () => {
                  frames++;
                  const elapsed =
                    (typeof performance !== 'undefined' && performance.now
                      ? performance.now()
                      : Date.now()) - t0;
                  const sig = readLayoutSig();

                  if (sig != null) {
                    if (baselineSig === null) baselineSig = sig;
                    else if (sig !== baselineSig) sawSigChange = true;

                    if (sig === prevSig) stableRun++;
                    else {
                      stableRun = 0;
                      prevSig = sig;
                    }
                  }

                  const stableEnough =
                    sawSigChange &&
                    frames >= minFramesBeforeStable &&
                    stableRun >= stableFramesNeeded &&
                    elapsed >= minElapsedAfterChangeMs;

                  const firstPaintAlreadyFinal =
                    !sawSigChange &&
                    elapsed >= noTransitionFallbackMs &&
                    frames >= minFramesBeforeStable &&
                    stableRun >= stableFramesNeeded;

                  const force =
                    elapsed >= hardCapMs || frames >= hardCapFrames || sig == null;

                  if (stableEnough || firstPaintAlreadyFinal || force) {
                    runMaximizeViewportFit();
                    return;
                  }
                  requestAnimationFrame(tick);
                };

                requestAnimationFrame(tick);
              });
            });
          }, 0);
        }}
        onPaneClick={() => {
          clearBulkConnectState();
          cancelPendingConnection();
          setUiDismissToken((v) => v + 1);
          setIsDrawerOpen(false);
          setFocusedNodeId(null);
          setTextEditingNodeId(null);
          setMaximizedViewNodeId(null);
          setSelectedEdgeIds([]);
          setHoveredEdgeId(null);
          closePaneContextMenu();
        }}
        edgesFocusable={true}
        connectionRadius={48}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.35, minZoom: 0.12, maxZoom: 1.2 }}
        defaultViewport={{ x: 0, y: 0, zoom: 0.85 }}
        minZoom={0.08}
        maxZoom={5}
      >
        <Background 
          variant={BackgroundVariant.Dots} 
          gap={24} 
          size={1.5} 
          color="#1c1f26" 
        />
        <Controls className="!bg-[#1c1f26] !border-[#2d3139] !fill-white !shadow-2xl" />
      </ReactFlow>

      <MultiSelectToolbar
        visible={multiSelectToolbarEligible}
        screenPos={multiToolbarPos}
        onArrange={arrangeSelectedAssets}
        onGroup={groupSelectedAssets}
        onDuplicate={duplicateSelectedAssets}
        onSaveToAssets={saveSelectedNodeToMaterialLibrary}
        onBatchDownload={() => {}}
      />

      <GroupToolbar
        visible={Boolean(selectedGroupNode)}
        screenPos={groupToolbarPos}
        onUngroup={ungroupSelectedGroup}
      />

      {multiSelectToolbarEligible && bulkSelectionHandlePos && (
        <button
          type="button"
          aria-label="批量输出"
          className={`bulk-selection-handle ${bulkConnectState ? 'is-active' : ''}`}
          style={{ left: bulkSelectionHandlePos.left, top: bulkSelectionHandlePos.top }}
          onPointerDown={startBulkConnection}
        >
          <Plus size={18} strokeWidth={2.2} />
        </button>
      )}

      {bulkPreviewPaths.length > 0 && (
        <svg className="pointer-events-none fixed inset-0 z-[175] h-full w-full overflow-visible">
          {bulkPreviewPaths.map(({ id, path }) => (
            <EnergyEdgePaths key={id} path={path} preview />
          ))}
        </svg>
      )}

      <div
        className="fixed left-2 top-1/2 -translate-y-1/2 z-[70]"
      >
        <div className="w-[50px] bg-[#202020] border border-white/[0.05] rounded-2xl shadow-xl flex flex-col items-center py-2.5 gap-1.5">
          <button
            onMouseEnter={() => {
              setActiveTab('nodes');
              openDrawer();
            }}
            onMouseLeave={closeDrawerWithDelay}
            onClick={() => {
              setActiveTab('nodes');
              setIsDrawerOpen((v) => !v);
            }}
            className={`h-9 w-9 rounded-xl flex items-center justify-center transition-colors ${
              isDrawerOpen
                ? 'bg-white/15 text-white'
                : 'text-white/60 hover:bg-white/10 hover:text-white'
            }`}
            title="展开/关闭"
          >
            <span className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-white">
              <Plus
                size={16}
                className={`text-[#1a1a1a] transition-transform duration-200 ease-out ${
                  isDrawerOpen ? 'rotate-45' : 'rotate-0'
                }`}
              />
            </span>
          </button>

          <button
            onClick={() => handleToolClick('nodes')}
            className={`h-9 w-9 rounded-xl flex items-center justify-center transition-colors ${
              activeTab === 'nodes'
                ? 'bg-white/12 text-white'
                : 'text-white/60 hover:bg-white/10 hover:text-white'
            }`}
            title="节点"
          >
            <Network size={16} className="text-white" />
          </button>

          <button
            onMouseEnter={() => {
              setActiveTab('assets');
              openDrawer();
            }}
            onMouseLeave={closeDrawerWithDelay}
            onClick={() => handleToolClick('assets')}
            className={`h-9 w-9 rounded-xl flex items-center justify-center transition-colors ${
              activeTab === 'assets'
                ? 'bg-white/12 text-white'
                : 'text-white/60 hover:bg-white/10 hover:text-white'
            }`}
            title="素材"
          >
            <Folder size={16} className="text-white" />
          </button>

          <button
            onMouseEnter={() => {
              setActiveTab('history');
              openDrawer();
            }}
            onMouseLeave={closeDrawerWithDelay}
            onClick={() => handleToolClick('history')}
            className={`h-9 w-9 rounded-xl flex items-center justify-center transition-colors ${
              activeTab === 'history'
                ? 'bg-white/12 text-white'
                : 'text-white/60 hover:bg-white/10 hover:text-white'
            }`}
            title="历史记录"
          >
            <History size={16} className="text-white" />
          </button>

        </div>

        <aside
          onMouseEnter={openDrawer}
          onMouseLeave={closeDrawerWithDelay}
          className={`absolute left-full top-1/2 ml-1 ${
            activeTab === 'assets' ? 'w-[720px]' : activeTab === 'history' ? 'w-[960px]' : 'w-[185px]'
          } ${
            activeTab === 'assets' ? 'h-[640px]' : activeTab === 'history' ? 'h-[640px]' : ''
          } -translate-y-1/2 bg-[#202020] border border-white/[0.05] rounded-2xl shadow-xl transition-all duration-300 ease-out ${
            isDrawerOpen ? 'translate-x-0 opacity-100 pointer-events-auto' : '-translate-x-4 opacity-0 pointer-events-none'
          }`}
          style={{ perspective: '900px' }}
        >
        {activeTab === 'assets' ? (
          <MaterialLibraryPanel
            visible={true}
            items={materialLibraryVisibleItems}
            activeCategory={materialLibraryCategory}
            loading={materialLibraryLoading}
            error={materialLibraryError}
            onCategoryChange={setMaterialLibraryCategory}
            onUseItem={addMaterialLibraryItemToCanvas}
            onDragItemStart={(event, item) => {
              event.dataTransfer.effectAllowed = 'copy';
              event.dataTransfer.setData(MATERIAL_LIBRARY_DRAG_MIME, JSON.stringify(item));
            }}
            onDeleteItem={handleDeleteMaterialLibraryItem}
            deletingItemId={deletingMaterialLibraryItemId}
            onClose={() => setIsDrawerOpen(false)}
          />
        ) : activeTab === 'history' ? (
          <HistoryPanel
            visible={true}
            items={historyItems}
            counts={historyCounts}
            loading={historyLoading}
            error={historyError}
            onUseItem={addMaterialLibraryItemToCanvas}
            onDragItemStart={(event, item) => {
              event.dataTransfer.effectAllowed = 'copy';
              event.dataTransfer.setData(MATERIAL_LIBRARY_DRAG_MIME, JSON.stringify(item));
            }}
            onClose={() => setIsDrawerOpen(false)}
          />
        ) : (
          <>
        <div className="px-3 py-2.5 border-b border-white/[0.08]">
          <h2 className="text-xs text-gray-400">添加节点</h2>
        </div>
        <div className="px-2 pt-2 space-y-0.5">
          <button
            onClick={createTextNodeFromDrawer}
            className="w-full h-9 rounded-lg px-2 text-left text-[13px] text-white/90 hover:bg-white/[0.08] transition-[background-color,transform,box-shadow] duration-180 ease-out transform-gpu hover:[transform:rotateY(-10deg)_translateX(2px)] hover:shadow-[0_10px_24px_rgba(0,0,0,0.35)] flex items-center gap-2.5"
          >
            <span className="w-6 h-6 rounded-md bg-black/30 border border-white/10 flex items-center justify-center"><Menu size={13} className="text-white/80" /></span>
            文本
          </button>
          <button
            onClick={createImageNodeFromDrawer}
            className="w-full h-9 rounded-lg px-2 text-left text-[13px] text-white/90 hover:bg-white/[0.08] transition-[background-color,transform,box-shadow] duration-180 ease-out transform-gpu hover:[transform:rotateY(-10deg)_translateX(2px)] hover:shadow-[0_10px_24px_rgba(0,0,0,0.35)] flex items-center gap-2.5"
          >
            <span className="w-6 h-6 rounded-md bg-black/30 border border-white/10 flex items-center justify-center"><ImagePlus size={13} className="text-white/80" /></span>
            图片
          </button>
          <button
            onClick={createVideoNodeFromDrawer}
            className="w-full h-9 rounded-lg px-2 text-left text-[13px] text-white/90 hover:bg-white/[0.08] transition-[background-color,transform,box-shadow] duration-180 ease-out transform-gpu hover:[transform:rotateY(-10deg)_translateX(2px)] hover:shadow-[0_10px_24px_rgba(0,0,0,0.35)] flex items-center gap-2.5"
          >
            <span className="w-6 h-6 rounded-md bg-black/30 border border-white/10 flex items-center justify-center"><Video size={13} className="text-white/80" /></span>
            视频
          </button>
          <button
            onClick={() => selectDrawerItem('video-compose')}
            className="w-full h-9 rounded-lg px-2 text-left text-[13px] text-white/90 hover:bg-white/[0.08] transition-[background-color,transform,box-shadow] duration-180 ease-out transform-gpu hover:[transform:rotateY(-10deg)_translateX(2px)] hover:shadow-[0_10px_24px_rgba(0,0,0,0.35)] flex items-center gap-2.5"
          >
            <span className="w-6 h-6 rounded-md bg-black/30 border border-white/10 flex items-center justify-center"><Clapperboard size={13} className="text-white/80" /></span>
            <span className="flex items-center gap-1.5">视频合成 <span className="text-[11px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-200">Beta</span></span>
          </button>
          <button
            onClick={() => selectDrawerItem('audio')}
            className="w-full h-9 rounded-lg px-2 text-left text-[13px] text-white/90 hover:bg-white/[0.08] transition-[background-color,transform,box-shadow] duration-180 ease-out transform-gpu hover:[transform:rotateY(-10deg)_translateX(2px)] hover:shadow-[0_10px_24px_rgba(0,0,0,0.35)] flex items-center gap-2.5"
          >
            <span className="w-6 h-6 rounded-md bg-black/30 border border-white/10 flex items-center justify-center"><Music2 size={13} className="text-white/80" /></span>
            音频
          </button>
          <button
            onClick={() => selectDrawerItem('script')}
            className="w-full h-9 rounded-lg px-2 text-left text-[13px] text-white/90 hover:bg-white/[0.08] transition-[background-color,transform,box-shadow] duration-180 ease-out transform-gpu hover:[transform:rotateY(-10deg)_translateX(2px)] hover:shadow-[0_10px_24px_rgba(0,0,0,0.35)] flex items-center gap-2.5"
          >
            <span className="w-6 h-6 rounded-md bg-black/30 border border-white/10 flex items-center justify-center"><ScrollText size={13} className="text-white/80" /></span>
            <span className="flex items-center gap-1.5">脚本 <span className="text-[11px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-200">Beta</span></span>
          </button>
        </div>

        <div className="px-3 pt-2 border-t border-white/[0.08] mt-2">
          <h2 className="text-xs text-gray-400">添加资源</h2>
        </div>
        <div className="px-2 pb-2 pt-1 space-y-0.5">
          <button
            onClick={() => setIsDrawerOpen(false)}
            className="w-full h-9 rounded-lg px-2 text-left text-[13px] text-white/90 hover:bg-white/[0.08] transition-[background-color,transform,box-shadow] duration-180 ease-out transform-gpu hover:[transform:rotateY(-10deg)_translateX(2px)] hover:shadow-[0_10px_24px_rgba(0,0,0,0.35)] flex items-center gap-2.5"
          >
            <span className="w-6 h-6 rounded-md bg-black/30 border border-white/10 flex items-center justify-center"><Upload size={13} className="text-white/80" /></span>
            上传
          </button>
          <button
            onClick={() => {
              setActiveTab('assets');
              setIsDrawerOpen(true);
            }}
            className="w-full h-9 rounded-lg px-2 text-left text-[13px] text-white/90 hover:bg-white/[0.08] transition-[background-color,transform,box-shadow] duration-180 ease-out transform-gpu hover:[transform:rotateY(-10deg)_translateX(2px)] hover:shadow-[0_10px_24px_rgba(0,0,0,0.35)] flex items-center gap-2.5"
          >
            <span className="w-6 h-6 rounded-md bg-black/30 border border-white/10 flex items-center justify-center"><Images size={13} className="text-white/80" /></span>
            从图库选择
          </button>
        </div>
          </>
        )}
        </aside>
      </div>

      {/* Context Menu */}
      {menu && (
        <div 
          className="fixed z-50 bg-[#1C1C1E] border border-white/10 rounded-lg shadow-2xl py-1.5 w-44 overflow-hidden"
          style={{ top: menu.top, left: menu.left }}
        >
          {visibleConnectionMenuItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => createNode(id)}
              className="w-full px-3 py-2.5 flex items-center gap-2.5 hover:bg-white/10 text-gray-200 transition-colors text-sm"
            >
              <Icon size={15} className="text-gray-400" />
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Hidden file input for bulk upload */}
      <input
        ref={bulkUploadInputRef}
        type="file"
        multiple
        accept="image/*,video/*"
        className="hidden"
        onChange={handleBulkUpload}
      />

      {paneContextMenu?.stage === 'root' && (
        <div
          className="fixed z-[80] w-[240px] rounded-2xl border border-white/[0.05] bg-[#202020] shadow-[0_18px_44px_rgba(0,0,0,0.48)] px-3 py-3"
          style={{ left: paneContextMenu.left, top: paneContextMenu.top }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); closePaneContextMenu(); bulkUploadInputRef.current?.click(); }}
            className="w-full h-9 rounded-lg px-2.5 text-left text-[15px] leading-6 text-white hover:bg-white/[0.08] active:bg-white/[0.11] hover:text-white transition-all duration-150 ease-out flex items-center gap-2"
          >
            <Upload size={14} className="text-white/60" />
            上传
          </button>
          <button
            onClick={(event) => {
              event.stopPropagation();
              if (!canSaveSelectionToMaterialLibrary) return;
              closePaneContextMenu();
              saveSelectedNodeToMaterialLibrary();
            }}
            className={`mt-1 w-full h-9 rounded-lg px-2.5 text-left text-[15px] leading-6 transition-all duration-150 ease-out ${
              canSaveSelectionToMaterialLibrary
                ? 'text-white hover:bg-white/[0.08] active:bg-white/[0.11] hover:text-white'
                : 'text-white/30 cursor-not-allowed'
            }`}
          >
            保存到我的素材
          </button>
          <button
            onClick={openNodeCategoryMenu}
            className="mt-1 w-full h-9 rounded-lg px-2.5 text-left text-[15px] leading-6 text-white hover:bg-white/[0.08] active:bg-white/[0.11] hover:text-white transition-all duration-150 ease-out"
          >
            添加节点
          </button>
          <div className="my-2 h-px bg-white/[0.08]" />
          <button className="w-full h-9 rounded-lg px-2.5 flex items-center justify-between text-[15px] leading-6 text-white hover:bg-white/[0.08] active:bg-white/[0.11] transition-all duration-150 ease-out">
            <span>撤销</span>
            <span className="text-white/35 text-[13px]">⌘Z</span>
          </button>
          <div className="mt-1 w-full h-9 rounded-lg px-2.5 flex items-center justify-between text-[15px] leading-6 text-white/30 cursor-not-allowed">
            <span>重做</span>
            <span className="text-white/20 text-[13px]">⇧⌘Z</span>
          </div>
          <div className="my-2 h-px bg-white/[0.08]" />
          <button className="w-full h-9 rounded-lg px-2.5 flex items-center justify-between text-[15px] leading-6 text-white hover:bg-white/[0.08] active:bg-white/[0.11] transition-all duration-150 ease-out">
            <span>粘贴</span>
            <span className="text-white/35 text-[13px]">⌘V</span>
          </button>
        </div>
      )}

      <SaveToMaterialModal
        open={Boolean(pendingMaterialLibrarySave)}
        draft={pendingMaterialLibrarySave}
        saving={isSavingMaterialLibraryItem}
        onClose={closeSaveToMaterialModal}
        onSubmit={handleConfirmMaterialLibrarySave}
      />

      {paneContextMenu?.stage === 'nodes' && (
        <div
          className="fixed z-[80] w-[185px] bg-[#202020] border border-white/[0.05] rounded-2xl shadow-xl px-2 py-2"
          style={{ left: paneContextMenu.left, top: paneContextMenu.top }}
        >
          <div className="px-2 pb-2 mb-1 border-b border-white/[0.08]">
            <h2 className="text-xs text-gray-400">添加节点</h2>
          </div>
          <div className="space-y-0.5">
            <button
              onClick={() => {
                createTextNodeAtScreen(paneContextMenu.left, paneContextMenu.top);
                closePaneContextMenu();
              }}
              className="w-full h-9 rounded-lg px-2 text-left text-[13px] text-white/90 hover:bg-white/[0.08] active:bg-white/[0.11] transition-all duration-150 ease-out flex items-center gap-2.5"
            >
              <span className="w-6 h-6 rounded-md bg-black/30 border border-white/10 flex items-center justify-center"><Menu size={13} className="text-white/80" /></span>
              文本
            </button>
            <button
              onClick={() => {
                createImageNodeAtScreen(paneContextMenu.left, paneContextMenu.top);
                closePaneContextMenu();
              }}
              className="w-full h-9 rounded-lg px-2 text-left text-[13px] text-white/90 hover:bg-white/[0.08] active:bg-white/[0.11] transition-all duration-150 ease-out flex items-center gap-2.5"
            >
              <span className="w-6 h-6 rounded-md bg-black/30 border border-white/10 flex items-center justify-center"><ImagePlus size={13} className="text-white/80" /></span>
              图片
            </button>
            <button
              onClick={() => {
                createVideoNodeAtScreen(paneContextMenu.left, paneContextMenu.top);
                closePaneContextMenu();
              }}
              className="w-full h-9 rounded-lg px-2 text-left text-[13px] text-white/90 hover:bg-white/[0.08] active:bg-white/[0.11] transition-all duration-150 ease-out flex items-center gap-2.5"
            >
              <span className="w-6 h-6 rounded-md bg-black/30 border border-white/10 flex items-center justify-center"><Video size={13} className="text-white/80" /></span>
              视频
            </button>
            <button
              onClick={() => {
                selectDrawerItem('video-compose');
                closePaneContextMenu();
              }}
              className="w-full h-9 rounded-lg px-2 text-left text-[13px] text-white/90 hover:bg-white/[0.08] active:bg-white/[0.11] transition-all duration-150 ease-out flex items-center gap-2.5"
            >
              <span className="w-6 h-6 rounded-md bg-black/30 border border-white/10 flex items-center justify-center"><Clapperboard size={13} className="text-white/80" /></span>
              <span className="flex items-center gap-1.5">视频合成 <span className="text-[11px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-200">Beta</span></span>
            </button>
            <button
              onClick={() => {
                selectDrawerItem('audio');
                closePaneContextMenu();
              }}
              className="w-full h-9 rounded-lg px-2 text-left text-[13px] text-white/90 hover:bg-white/[0.08] active:bg-white/[0.11] transition-all duration-150 ease-out flex items-center gap-2.5"
            >
              <span className="w-6 h-6 rounded-md bg-black/30 border border-white/10 flex items-center justify-center"><Music2 size={13} className="text-white/80" /></span>
              音频
            </button>
            <button
              onClick={() => {
                selectDrawerItem('script');
                closePaneContextMenu();
              }}
              className="w-full h-9 rounded-lg px-2 text-left text-[13px] text-white/90 hover:bg-white/[0.08] active:bg-white/[0.11] transition-all duration-150 ease-out flex items-center gap-2.5"
            >
              <span className="w-6 h-6 rounded-md bg-black/30 border border-white/10 flex items-center justify-center"><ScrollText size={13} className="text-white/80" /></span>
              <span className="flex items-center gap-1.5">脚本 <span className="text-[11px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-200">Beta</span></span>
            </button>
          </div>
        </div>
      )}

      <div className="fixed left-4 top-4 z-[60] pointer-events-auto flex flex-nowrap items-center gap-0 text-white/95 max-w-[calc(100vw-1.5rem)] select-none">
        {/* 莱博塔：热区略大于按钮；菜单绝对定位不挤压右侧工程名；宽度与按钮对齐 */}
        <div
          className="relative shrink-0 px-1 py-1 -mx-1 -my-1 inline-block"
          onMouseEnter={() => setBrandHotZone(true)}
          onMouseLeave={() => setBrandHotZone(false)}
        >
          <button
            type="button"
            className={`flex items-center gap-2 rounded-[10px] px-3 py-2 border transition-colors duration-150 text-[14px] font-semibold tracking-tight text-white/95 ${
              brandHotZone || brandMenuOpen
                ? `${PANEL_SURFACE} border-white/[0.1] shadow-sm`
                : 'bg-transparent border-transparent'
            }`}
            aria-expanded={brandMenuOpen}
            aria-haspopup="menu"
          >
            <div className="flex h-8 items-center">
              <img
                src={brandLogo}
                alt="Demiurge"
                className="h-8 w-auto max-w-[154px] object-contain brightness-125 contrast-110 drop-shadow-[0_0_14px_rgba(255,255,255,0.08)]"
                draggable={false}
              />
            </div>
          </button>
          {brandMenuOpen && (
            <>
              <div
                className="pointer-events-auto absolute left-0 top-full z-[65] h-2 w-full min-w-[100%]"
                aria-hidden
              />
              <div
                className={`absolute left-0 top-[calc(100%+8px)] z-[70] w-max min-w-full max-w-[min(100vw-2rem,280px)] rounded-xl border border-white/[0.08] ${PANEL_MENU} py-1 shadow-[0_12px_36px_rgba(0,0,0,0.55)]`}
                role="menu"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="w-full px-3 py-2 text-left text-[13px] text-white/92 hover:bg-white/[0.06]"
                  onClick={() => void leaveWorkspaceToDashboard()}
                >
                  回到主页
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="w-full px-3 py-2 text-left text-[13px] text-white/92 hover:bg-white/[0.06]"
                  onClick={() => void leaveWorkspaceToAllProjects()}
                >
                  全部项目
                </button>
                <div className="my-1 mx-2 h-px bg-white/[0.08]" />
                <button
                  type="button"
                  role="menuitem"
                  className="w-full px-3 py-2 text-left text-[13px] text-white/92 hover:bg-white/[0.06]"
                  onClick={() => projectWorkspace.onCreateNewProject?.()}
                >
                  创建新项目
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="w-full px-3 py-2 text-left text-[13px] text-red-300 hover:bg-red-500/15"
                  onClick={() => projectWorkspace.onDeleteCurrentProject?.()}
                >
                  删除项目
                </button>
              </div>
            </>
          )}
        </div>

        <div className="hidden sm:block w-px h-7 bg-white/[0.14] mx-3 shrink-0" aria-hidden />

        <div className="flex items-center min-w-0 ml-1 sm:ml-0 gap-2">
          <input
            type="text"
            value={projectNameDraft}
            onChange={(e) => setProjectNameDraft(e.target.value)}
            onBlur={commitProjectNameIfChanged}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            className="min-w-[96px] max-w-[min(52vw,320px)] rounded-lg px-2.5 py-2 text-[14px] font-medium bg-transparent border border-transparent text-white/95 placeholder:text-white/35 outline-none hover:border-white/[0.08] focus:border-white/18 focus:bg-black/25 focus:ring-1 focus:ring-white/12"
            placeholder="未命名"
            aria-label="工程名称"
            title="点击输入工程名称（已自动保存）"
          />
        </div>
      </div>
      </div>
    </CanvasUiContext.Provider>
  );
}

export default function App() {
  const [workspace, setWorkspace] = useState(null);
  const workspaceRef = useRef(null);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  const handleCreateNewProject = useCallback(async () => {
    try {
      const res = await fetch(nodeApi('/project/create'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '未命名工程' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '创建失败');
      const loadRes = await fetch(nodeApi(`/project/load?slug=${encodeURIComponent(data.slug)}`));
      const loaded = await loadRes.json().catch(() => ({}));
      if (!loadRes.ok) throw new Error(loaded.error || '读取工程失败');
      setWorkspace({
        slug: data.slug,
        name: loaded.data?.name || '未命名工程',
        flow: normalizeFlowAssetUrls(
          loaded.data?.flow || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 0.85 } }
        ),
      });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '创建失败');
    }
  }, []);

  const handleDeleteCurrentProject = useCallback(async () => {
    const w = workspaceRef.current;
    if (!w) return;
    if (
      !window.confirm(
        '确定删除当前工程？将永久删除本机该工程文件夹、project_data.json 与 assets 内全部文件，且不可恢复。'
      )
    ) {
      return;
    }
    try {
      const res = await fetch(nodeApi(`/project/delete?slug=${encodeURIComponent(w.slug)}`), {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '删除失败');
      setWorkspace(null);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '删除失败');
    }
  }, []);

  const goDashboard = useCallback(() => setWorkspace(null), []);

  if (!workspace) {
    return (
      <ProjectDashboard
        onEnterProject={(payload) =>
          setWorkspace({
            slug: payload.slug,
            name: payload.name || payload.slug,
            flow: normalizeFlowAssetUrls(
              payload.flow || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 0.85 } }
            ),
          })
        }
      />
    );
  }

  return (
    <ReactFlowProvider key={workspace.slug}>
      <ProjectWorkspaceContext.Provider
        value={{
          slug: workspace.slug,
          name: workspace.name,
          initialFlow: workspace.flow,
          onBackToDashboard: goDashboard,
          onOpenAllProjects: goDashboard,
          onProjectNameChange: (nextName) =>
            setWorkspace((wk) =>
              wk ? { ...wk, name: String(nextName || '').trim() || wk.name } : null
            ),
          onCreateNewProject: handleCreateNewProject,
          onDeleteCurrentProject: handleDeleteCurrentProject,
        }}
      >
        <FlowErrorBoundary>
          <Flow />
        </FlowErrorBoundary>
      </ProjectWorkspaceContext.Provider>
    </ReactFlowProvider>
  );
}
