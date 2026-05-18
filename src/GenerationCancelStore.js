const listeners = new Set();
const cancelHandlers = new Map();

const emit = () => {
  listeners.forEach((listener) => listener());
};

export function registerGenerationCancel(nodeId, cancelHandler) {
  if (!nodeId || typeof cancelHandler !== 'function') return () => {};
  cancelHandlers.set(nodeId, cancelHandler);
  emit();

  return () => {
    if (cancelHandlers.get(nodeId) === cancelHandler) {
      cancelHandlers.delete(nodeId);
      emit();
    }
  };
}

export function cancelGenerationForNode(nodeId) {
  const cancelHandler = cancelHandlers.get(nodeId);
  if (typeof cancelHandler !== 'function') return false;
  cancelHandler();
  return true;
}

export function hasGenerationCancelHandler(nodeId) {
  return typeof cancelHandlers.get(nodeId) === 'function';
}
