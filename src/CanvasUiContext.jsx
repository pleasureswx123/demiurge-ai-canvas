import { createContext, useContext } from 'react';

export const CanvasUiContext = createContext({
  saveSnapshot: () => {},
  persistNodeData: () => {},
  flushProjectSave: () => Promise.resolve(),
  onRequestSaveToMaterial: () => {},
});

export function useCanvasUi() {
  return useContext(CanvasUiContext);
}
