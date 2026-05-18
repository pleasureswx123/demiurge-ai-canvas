import { useSyncExternalStore } from 'react';

const EMPTY_HOVER = Object.freeze({
  isTarget: false,
  tilt: Object.freeze({ x: 0, y: 0 }),
});

const listeners = new Set();
let hoverState = {
  nodeId: null,
  tilt: EMPTY_HOVER.tilt,
  snapshot: EMPTY_HOVER,
};

const normalizeTilt = (tilt) => ({
  x: Number.isFinite(tilt?.x) ? tilt.x : 0,
  y: Number.isFinite(tilt?.y) ? tilt.y : 0,
});

const emit = () => {
  listeners.forEach((listener) => listener());
};

export function setConnectionHoverTarget(nodeId, tilt) {
  const nextNodeId = nodeId || null;
  const nextTilt = normalizeTilt(tilt);
  if (
    hoverState.nodeId === nextNodeId &&
    hoverState.tilt.x === nextTilt.x &&
    hoverState.tilt.y === nextTilt.y
  ) {
    return;
  }

  hoverState = nextNodeId
    ? {
        nodeId: nextNodeId,
        tilt: nextTilt,
        snapshot: Object.freeze({
          isTarget: true,
          tilt: Object.freeze(nextTilt),
        }),
      }
    : {
        nodeId: null,
        tilt: EMPTY_HOVER.tilt,
        snapshot: EMPTY_HOVER,
      };
  emit();
}

export function clearConnectionHoverTarget() {
  setConnectionHoverTarget(null, EMPTY_HOVER.tilt);
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshotForNode(nodeId) {
  return hoverState.nodeId === nodeId ? hoverState.snapshot : EMPTY_HOVER;
}

export function useConnectionHoverForNode(nodeId) {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshotForNode(nodeId),
    () => EMPTY_HOVER
  );
}
