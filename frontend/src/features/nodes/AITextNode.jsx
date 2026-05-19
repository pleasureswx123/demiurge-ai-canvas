import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position, useNodeId, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import { AlignJustify, ChevronDown, Expand, MoveUp, Sparkles, Type, X } from 'lucide-react';

import CrispZoomRoot from '../../components/CrispZoomRoot';
import { useCanvasUi } from '../../store/CanvasUiContext';
import { useNodeUiState } from '../../store/NodeUiStore';
import { useConnectionHoverForNode } from '../../store/ConnectionHoverStore';
import { nodeApi } from '../../api/routes';

const TEXT_MODEL_OPTIONS = [
  { id: 'Seed-2.0-lite', label: 'Seed-2.0-lite' },
  { id: 'DeepSeek', label: 'DeepSeek' },
];
const NODE_DRAG_HANDLE_SELECTOR = '.node-drag-handle';
const TEXT_NODE_WIDTH = 320;
const TEXT_NODE_HEIGHT = Math.round((TEXT_NODE_WIDTH * 16) / 9);

const AITextNode = ({ data, selected = false }) => {
  const nodeId = useNodeId();
  const updateNodeInternals = useUpdateNodeInternals();
  const { updateNodeData, setEdges } = useReactFlow();
  const {
    persistNodeData,
  } = useCanvasUi();
  const {
    isSingleSelected,
    isFocused,
    isTextEditing,
  } = useNodeUiState(nodeId);

  const [prompt, setPrompt] = useState(data?.prompt || '');
  const [selectedModel, setSelectedModel] = useState(data?.textModel || 'Seed-2.0-lite');
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [resultText, setResultText] = useState(data?.analysisResult || '');
  const [loading, setLoading] = useState(false);
  const [showResultModal, setShowResultModal] = useState(false);
  const [selectedReferenceTokens, setSelectedReferenceTokens] = useState([]);
  const [mentionMenu, setMentionMenu] = useState({
    open: false,
    query: '',
    replaceStart: 0,
    replaceEnd: 0,
  });

  const textareaRef = useRef(null);
  const resultEditorRef = useRef(null);
  const nodeSurfaceRef = useRef(null);
  const [isNodeHovering, setIsNodeHovering] = useState(false);

  const showDetailPanel = selected && isFocused;
  const isEditing = isTextEditing;
  const showHandleUi = isNodeHovering || selected;
  const connectionHover = useConnectionHoverForNode(nodeId);
  const isConnectionHoverTarget = connectionHover.isTarget;
  const resolvedConnectionHoverTilt = connectionHover.tilt;
  const inputImageRefs = Array.isArray(data?.inputImageRefs) ? data.inputImageRefs.slice(0, 8) : [];

  useEffect(() => {
    const patch = {
      prompt,
      textModel: selectedModel,
      analysisResult: resultText,
    };
    updateNodeData(nodeId, patch);
    persistNodeData?.(nodeId, patch);
  }, [nodeId, persistNodeData, prompt, resultText, selectedModel, updateNodeData]);

  const mentionItems = useMemo(
    () =>
      inputImageRefs.map((asset, index) => ({
        index,
        token: `@图片${index + 1}`,
        label: `图片${index + 1}`,
        src: asset.src,
        sourceNodeId: asset.sourceNodeId,
      })),
    [inputImageRefs]
  );

  const closeMentionMenu = useCallback(() => {
    setMentionMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
  }, []);

  const syncMentionMenu = useCallback(
    (value, caret) => {
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
      });
    },
    [closeMentionMenu, inputImageRefs.length]
  );

  const filteredMentionItems = useMemo(() => {
    const query = mentionMenu.query.trim().toLowerCase();
    if (!query) return mentionItems;
    return mentionItems.filter(
      (item) =>
        item.token.toLowerCase().includes(`@${query}`) ||
        item.label.toLowerCase().includes(query) ||
        String(item.index + 1).includes(query)
    );
  }, [mentionItems, mentionMenu.query]);

  const insertMentionToken = useCallback(
    (item) => {
      if (!item) return;

      const textarea = textareaRef.current;
      const fallbackCaret = textarea?.selectionStart ?? prompt.length;
      const replaceStart = mentionMenu.open ? mentionMenu.replaceStart : fallbackCaret;
      const replaceEnd = mentionMenu.open ? mentionMenu.replaceEnd : fallbackCaret;
      const nextValue = `${prompt.slice(0, replaceStart)}${item.token} ${prompt.slice(replaceEnd)}`;
      const nextCaret = replaceStart + item.token.length + 1;

      setPrompt(nextValue);
      closeMentionMenu();

      requestAnimationFrame(() => {
        const target = textareaRef.current;
        if (!target) return;
        target.focus();
        target.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [closeMentionMenu, mentionMenu.open, mentionMenu.replaceEnd, mentionMenu.replaceStart, prompt]
  );

  const removeMentionTokenAroundCaret = useCallback(
    (value, selectionStart, selectionEnd, action) => {
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
        if (value[removeEnd] === ' ') removeEnd += 1;

        const nextValue = `${value.slice(0, removeStart)}${value.slice(removeEnd)}`;
        setPrompt(nextValue);
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

  const removeInputReference = useCallback(
    (item) => {
      if (!item?.sourceNodeId || !nodeId) return;
      const removedIndex = item.index + 1;
      setEdges((edges) =>
        edges.filter((edge) => !(edge.source === item.sourceNodeId && edge.target === nodeId))
      );
      setSelectedReferenceTokens((prev) => adjustSelectedTokensAfterRefRemoval(prev, removedIndex));
      setPrompt((prev) => adjustPromptAfterRefRemoval(prev, removedIndex));
      closeMentionMenu();
    },
    [adjustPromptAfterRefRemoval, adjustSelectedTokensAfterRefRemoval, closeMentionMenu, nodeId, setEdges]
  );

  const imageSourceToDataUrl = useCallback(async (src) => {
    if (!src) return null;
    if (String(src).startsWith('data:')) return String(src);

    const response = await fetch(src);
    if (!response.ok) throw new Error('引用图片读取失败');

    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('引用图片转 Base64 失败'));
      reader.readAsDataURL(blob);
    });
  }, []);

  const resolveReferenceItems = useCallback(() => {
    const mentionedTokens = Array.from(new Set(prompt.match(/@图片\d+/g) || []));
    const activeTokens = mentionedTokens.length
      ? mentionedTokens
      : selectedReferenceTokens.length
        ? selectedReferenceTokens
        : mentionItems.map((item) => item.token);
    return activeTokens
      .map((token) => mentionItems.find((item) => item.token === token))
      .filter(Boolean);
  }, [mentionItems, prompt, selectedReferenceTokens]);

  const runAnalysis = useCallback(async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || loading) return;

    try {
      setLoading(true);
      const refs = resolveReferenceItems();
      const inputImages = await Promise.all(refs.map((item) => imageSourceToDataUrl(item.src)));

      const response = await fetch(nodeApi('/text-analyze'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          prompt: trimmedPrompt,
          input_images: inputImages.filter(Boolean),
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result?.error || '分析失败');
      }

      setResultText(result?.text || '');
    } catch (error) {
      console.error('Text analysis failed:', error);
      window.alert(`分析失败：${error.message || '请检查文本分析模型配置'}`);
    } finally {
      setLoading(false);
    }
  }, [imageSourceToDataUrl, loading, prompt, resolveReferenceItems, selectedModel]);

  const handlePromptKeyDown = useCallback(
    (event) => {
      const selectionStart = event.currentTarget.selectionStart ?? 0;
      const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;

      if (event.key === 'Backspace') {
        if (removeMentionTokenAroundCaret(prompt, selectionStart, selectionEnd, 'backspace')) {
          event.preventDefault();
          return;
        }
      }

      if (event.key === 'Delete') {
        if (removeMentionTokenAroundCaret(prompt, selectionStart, selectionEnd, 'delete')) {
          event.preventDefault();
          return;
        }
      }

      if (mentionMenu.open) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeMentionMenu();
          return;
        }

        if (event.key === 'Enter' && filteredMentionItems.length) {
          event.preventDefault();
          insertMentionToken(filteredMentionItems[0]);
          return;
        }
      }

      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !mentionMenu.open) {
        event.preventDefault();
        runAnalysis();
      }
    },
    [closeMentionMenu, filteredMentionItems, insertMentionToken, mentionMenu.open, prompt, removeMentionTokenAroundCaret, runAnalysis]
  );

  useEffect(() => {
    if (!nodeId) return;
    updateNodeInternals(nodeId);
  }, [nodeId, showHandleUi, updateNodeInternals]);

  useEffect(() => {
    if (!showDetailPanel) {
      setShowModelMenu(false);
    }
  }, [showDetailPanel]);

  useEffect(() => {
    if (!showDetailPanel || !isEditing || resultText) return;
    let timeoutId = null;
    let frameA = 0;
    let frameB = 0;

    const focusEditor = () => {
      const target = textareaRef.current;
      if (!target) return;
      target.focus();
      const caret = target.value.length;
      try {
        target.setSelectionRange(caret, caret);
      } catch {
        // Ignore browsers that don't allow selection updates here.
      }
    };

    // Double click + viewport animation can steal focus once, so retry once more.
    frameA = requestAnimationFrame(() => {
      focusEditor();
      frameB = requestAnimationFrame(() => {
        focusEditor();
      });
    });
    timeoutId = window.setTimeout(() => {
      focusEditor();
    }, 140);

    return () => {
      cancelAnimationFrame(frameA);
      cancelAnimationFrame(frameB);
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [isEditing, resultText, showDetailPanel]);

  useEffect(() => {
    if (showResultModal || !isEditing || !resultText) return;

    let timeoutId = null;
    let frameA = 0;
    let frameB = 0;

    const focusEditor = () => {
      const target = resultEditorRef.current;
      if (!target) return;
      target.focus();
      const caret = target.value.length;
      try {
        target.setSelectionRange(caret, caret);
      } catch {
        // Ignore browsers that don't allow selection updates here.
      }
    };

    frameA = requestAnimationFrame(() => {
      focusEditor();
      frameB = requestAnimationFrame(() => {
        focusEditor();
      });
    });
    timeoutId = window.setTimeout(() => {
      focusEditor();
    }, 140);

    return () => {
      cancelAnimationFrame(frameA);
      cancelAnimationFrame(frameB);
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [isEditing, resultText, showResultModal]);

  useEffect(() => {
    if (!resultText) {
      setShowResultModal(false);
    }
  }, [resultText]);

  useEffect(() => {
    if (!mentionMenu.open) return;
    const close = (event) => {
      if (typeof event.target?.closest === 'function' && event.target.closest('[data-mention-menu="true"]')) return;
      if (textareaRef.current?.contains?.(event.target)) return;
      closeMentionMenu();
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [closeMentionMenu, mentionMenu.open]);

  const renderInputImageRefs = () => {
    if (!inputImageRefs.length) return null;

    return (
      <div className="flex h-full items-center gap-3 overflow-x-auto overflow-y-hidden px-0.5 py-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {inputImageRefs.map((asset, index) => (
          <div
            key={`${asset.src}-${index}`}
            className={`group relative h-14 w-14 shrink-0 overflow-hidden rounded-[13px] border bg-[#14161b] ${
              selectedReferenceTokens.includes(`@图片${index + 1}`)
                ? 'border-[#8fb9ff] shadow-[0_0_0_1px_rgba(143,185,255,0.35)]'
                : 'border-white/30'
            }`}
          >
            <button
              type="button"
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
              className="pointer-events-none h-full w-full object-cover"
              draggable={false}
            />
          </div>
        ))}
      </div>
    );
  };

  return (
    <div
      className="relative text-[#E6E6E7]"
      style={{ width: TEXT_NODE_WIDTH }}
      onMouseEnter={() => setIsNodeHovering(true)}
      onMouseLeave={() => setIsNodeHovering(false)}
    >
      <CrispZoomRoot>
      <div className="relative mx-auto" style={{ width: TEXT_NODE_WIDTH }}>
        <div className="mb-2 flex items-center gap-1.5 text-[#8C8F96]">
          <Type size={14} />
          <span className="text-sm leading-none">文本节点</span>
          <span className="text-xs leading-none">{String(nodeId || '').replace(/\D/g, '') || ''}</span>
        </div>

        <div className="relative node-drag-handle cursor-move" ref={nodeSurfaceRef}>
          <div
            className="relative rounded-[18px] border border-transparent bg-[#202020] transition-all duration-[130ms] ease-out"
            style={{
              height: TEXT_NODE_HEIGHT,
              transform: isConnectionHoverTarget
                ? `perspective(1200px) rotateX(${resolvedConnectionHoverTilt.x}deg) rotateY(${resolvedConnectionHoverTilt.y}deg) scale3d(1.025, 1.025, 1.025)`
                : undefined,
              transformStyle: isConnectionHoverTarget ? 'preserve-3d' : undefined,
              willChange: isConnectionHoverTarget ? 'transform, box-shadow' : 'auto',
              boxShadow: isConnectionHoverTarget
                ? '0 0 0 1.5px rgba(255,255,255,0.58), 0 14px 28px rgba(255,255,255,0.08), 0 20px 42px rgba(76,125,214,0.2), inset 0 0 0 1px rgba(255,255,255,0.1)'
                : (selected || isSingleSelected)
                  ? '0 0 0 2px rgba(255,255,255,0.52)'
                  : undefined,
            }}
          >
            <div className="h-full w-full overflow-hidden rounded-[18px] bg-[#202020]">
              {resultText ? (
                isEditing ? (
                  <textarea
                    ref={resultEditorRef}
                    value={resultText}
                    onChange={(event) => setResultText(event.target.value)}
                    className="nodrag h-full w-full resize-none overflow-y-auto bg-transparent px-5 py-5 text-[14px] leading-7 text-[#e8eaf0] focus:outline-none"
                    onWheelCapture={(event) => event.stopPropagation()}
                    onPointerDownCapture={(event) => event.stopPropagation()}
                    onPointerUpCapture={(event) => event.stopPropagation()}
                    onMouseDownCapture={(event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        event.stopPropagation();
                        return;
                      }
                      event.stopPropagation();
                    }}
                    onMouseUpCapture={(event) => event.stopPropagation()}
                    onClickCapture={(event) => event.stopPropagation()}
                    onDoubleClickCapture={(event) => event.stopPropagation()}
                  />
                ) : (
                  <div
                    className="h-full overflow-y-auto px-5 py-5 text-[14px] leading-7 text-[#e8eaf0] whitespace-pre-wrap cursor-move select-none"
                    onWheelCapture={(event) => event.stopPropagation()}
                    onPointerDownCapture={(event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        event.stopPropagation();
                      }
                    }}
                    onMouseDownCapture={(event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        event.stopPropagation();
                      }
                    }}
                  >
                    {resultText}
                  </div>
                )
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <AlignJustify size={42} className="text-white/35" strokeWidth={1.6} />
                </div>
              )}
            </div>
          </div>

          {Boolean(resultText) && (
            <button
              type="button"
              title="放大查看"
              className="absolute right-3 top-3 z-10 h-7 w-7 rounded-md text-[#d3d8e2] hover:bg-white/10 hover:text-white transition-colors flex items-center justify-center"
              onClick={(event) => {
                event.stopPropagation();
                setShowResultModal(true);
              }}
            >
              <Expand size={14} />
            </button>
          )}

          {loading && (
            <div className="absolute inset-0 rounded-[18px] bg-[#202020] flex flex-col items-center justify-center">
              <div className="loading-ellipsis mb-3" aria-hidden="true">
                <span className="loading-ellipsis-dot" />
                <span className="loading-ellipsis-dot" />
                <span className="loading-ellipsis-dot" />
              </div>
              <p className="text-sm font-medium text-white/50">分析中...</p>
            </div>
          )}

          <Handle
            id="input"
            type="target"
            position={Position.Left}
            className={`node-handle-zone ${showHandleUi ? 'opacity-100' : 'opacity-0'}`}
            style={{ pointerEvents: showHandleUi ? 'auto' : 'none', zIndex: 20 }}
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

      {showDetailPanel && (
        <div
          data-role="node-detail-panel"
          className="nodrag absolute left-1/2 top-full mt-6 z-10 flex min-h-[186px] w-[620px] flex-col rounded-[20px] border border-white/[0.05] bg-[#202020] px-5 pb-4 pt-4"
          style={{ transform: 'translateX(-50%)' }}
          onPointerDownCapture={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDownCapture={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="mb-4 flex min-h-[56px] shrink-0 items-start gap-3 overflow-hidden">
            <div className="min-w-0 flex-1 self-stretch">{renderInputImageRefs()}</div>
          </div>

          <div className="min-h-0 flex-1">
            <div className="relative w-full">
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
                        <img
                          src={item.src}
                          alt={item.label}
                          className="h-10 w-10 shrink-0 rounded-[10px] object-cover"
                          draggable={false}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[14px] font-medium text-white">{item.label}</div>
                          <div className="text-[12px] text-[#9da3ad]">{`(${item.token})`}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <textarea
                ref={textareaRef}
                rows={4}
                value={prompt}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  const caret = event.target.selectionStart ?? nextValue.length;
                  setPrompt(nextValue);
                  syncMentionMenu(nextValue, caret);
                }}
                onClick={(event) => syncMentionMenu(event.target.value, event.target.selectionStart ?? 0)}
                onKeyUp={(event) => syncMentionMenu(event.target.value, event.target.selectionStart ?? 0)}
                onKeyDown={handlePromptKeyDown}
                onWheelCapture={(event) => event.stopPropagation()}
                onPointerDownCapture={(event) => event.stopPropagation()}
                onMouseDownCapture={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }
                  event.stopPropagation();
                }}
                placeholder="输入分析需求，@引用素材，例如：分析这个小女孩穿的衣服"
                className="nodrag h-full min-h-0 w-full resize-none border-none bg-transparent px-0 py-0 text-[15px] leading-[1.65] text-[#E7E8EC] placeholder:text-[#7D8088] focus:outline-none"
              />
            </div>
          </div>

          <div className="mt-4 flex shrink-0 items-center justify-between text-[#D8DAE0]">
            <div className="relative flex items-center gap-4 text-base leading-none">
              <div className="relative">
                <button
                  type="button"
                  data-model-trigger="true"
                  onClick={() => setShowModelMenu((prev) => !prev)}
                  className={`inline-flex h-11 items-center gap-2 rounded-[14px] border px-4 text-white transition-colors hover:bg-white/[0.12] ${
                    showModelMenu ? 'border-white/[0.22] bg-white/[0.12]' : 'border-transparent bg-transparent'
                  }`}
                >
                  <Sparkles size={16} />
                  <span className="text-[15px] font-semibold leading-none">{selectedModel}</span>
                  <ChevronDown size={14} className={`text-[#80838C] transition-transform ${showModelMenu ? 'rotate-180' : ''}`} />
                </button>
                {showModelMenu && (
                  <div
                    data-model-panel="true"
                    className="absolute bottom-[54px] left-0 z-30 w-[220px] rounded-[20px] border border-white/[0.08] bg-[#262626] p-3 shadow-2xl"
                  >
                    {TEXT_MODEL_OPTIONS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setSelectedModel(item.id);
                          setShowModelMenu(false);
                        }}
                        className={`flex w-full items-center justify-between rounded-[14px] px-3 py-3 text-left transition-colors ${
                          selectedModel === item.id
                            ? 'bg-white/[0.10] text-white'
                            : 'text-[#9ba1ab] hover:bg-white/[0.05] hover:text-white'
                        }`}
                      >
                        <span className="text-[14px] font-medium">{item.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-4">
              <button
                onClick={runAnalysis}
                disabled={loading}
                className={`rounded-[10px] text-[#17181B] flex items-center justify-center transition-colors ${
                  loading
                    ? 'h-10 px-4 bg-[#9da1ab] cursor-not-allowed'
                    : 'w-10 h-10 bg-[#8C8F96] hover:bg-[#9A9EA6]'
                }`}
              >
                {loading ? <span className="text-[13px] font-semibold">分析中...</span> : <MoveUp size={16} />}
              </button>
            </div>
          </div>
        </div>
      )}
      </CrispZoomRoot>

      {showResultModal &&
        createPortal(
          <div
            className="fixed inset-0 z-[80] bg-black/65 backdrop-blur-[1px] flex items-center justify-center"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setShowResultModal(false);
            }}
          >
            <div
              className="nodrag relative h-[min(82vh,760px)] w-[min(74vw,980px)] rounded-[24px] border border-white/[0.06] bg-[#202020] px-7 py-6"
              onPointerDownCapture={(event) => event.stopPropagation()}
              onMouseDownCapture={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                event.stopPropagation();
              }}
            >
              <button
                type="button"
                className="absolute right-4 top-4 rounded-md border border-white/12 bg-black/30 px-2 py-1 text-xs text-[#d7dae2] hover:text-white hover:bg-black/50 transition-colors"
                onClick={() => setShowResultModal(false)}
              >
                关闭
              </button>
              {isEditing ? (
                <textarea
                  ref={resultEditorRef}
                  value={resultText}
                  onChange={(event) => setResultText(event.target.value)}
                  className="nodrag h-full w-full resize-none border-none bg-transparent pr-3 text-[15px] leading-8 text-[#eceef3] focus:outline-none"
                  onWheelCapture={(event) => event.stopPropagation()}
                  onPointerDownCapture={(event) => event.stopPropagation()}
                  onMouseDownCapture={(event) => event.stopPropagation()}
                />
              ) : (
                <div
                  className="h-full overflow-y-auto pr-3 text-[15px] leading-8 text-[#eceef3] whitespace-pre-wrap cursor-text select-text"
                  onWheelCapture={(event) => event.stopPropagation()}
                >
                  {resultText}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

export default memo(AITextNode);
