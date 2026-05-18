import { useSyncExternalStore } from 'react';

const listeners = new Set();

let uiState = {
  uiDismissToken: 0,
  singleSelectedNodeId: null,
  focusedNodeId: null,
  textEditingNodeId: null,
  maximizedViewNodeId: null,
};

const snapshotCache = new Map();

const normalizeNodeId = (value) => (typeof value === 'string' && value ? value : null);

const normalizeState = (next) => ({
  uiDismissToken: Number.isFinite(next?.uiDismissToken) ? next.uiDismissToken : 0,
  singleSelectedNodeId: normalizeNodeId(next?.singleSelectedNodeId),
  focusedNodeId: normalizeNodeId(next?.focusedNodeId),
  textEditingNodeId: normalizeNodeId(next?.textEditingNodeId),
  maximizedViewNodeId: normalizeNodeId(next?.maximizedViewNodeId),
});

const areStatesEqual = (a, b) =>
  a.uiDismissToken === b.uiDismissToken &&
  a.singleSelectedNodeId === b.singleSelectedNodeId &&
  a.focusedNodeId === b.focusedNodeId &&
  a.textEditingNodeId === b.textEditingNodeId &&
  a.maximizedViewNodeId === b.maximizedViewNodeId;

export function setNodeUiState(next) {
  const normalized = normalizeState(next);
  if (areStatesEqual(uiState, normalized)) return;
  uiState = normalized;
  snapshotCache.clear();
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getNodeSnapshot(nodeId) {
  const id = normalizeNodeId(nodeId);
  const isSingleSelected = !!id && uiState.singleSelectedNodeId === id;
  const isFocused = !!id && uiState.focusedNodeId === id;
  const isTextEditing = !!id && uiState.textEditingNodeId === id;
  const isMaximizedView = !!id && uiState.maximizedViewNodeId === id;
  const key = [
    id || '',
    uiState.uiDismissToken,
    isSingleSelected ? 1 : 0,
    isFocused ? 1 : 0,
    isTextEditing ? 1 : 0,
    isMaximizedView ? 1 : 0,
  ].join('|');

  const cached = snapshotCache.get(key);
  if (cached) return cached;

  const snapshot = Object.freeze({
    uiDismissToken: uiState.uiDismissToken,
    isSingleSelected,
    isFocused,
    isTextEditing,
    isMaximizedView,
  });
  snapshotCache.set(key, snapshot);
  return snapshot;
}

export function useNodeUiState(nodeId) {
  return useSyncExternalStore(
    subscribe,
    () => getNodeSnapshot(nodeId),
    () => getNodeSnapshot(nodeId)
  );
}
