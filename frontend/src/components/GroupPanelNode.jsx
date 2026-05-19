import React, { memo } from 'react';

/**
 * Background panel for grouped nodes.
 * The whole empty panel is a drag handle so users can grab a group directly
 * without first selecting it.
 */
const GroupPanelNode = ({ selected }) => (
  <div
    className="node-drag-handle group-panel-frame relative h-full w-full cursor-grab rounded-2xl border border-white/[0.2] bg-white/[0.07] shadow-[inset_0_1px_0_rgba(255,255,255,0.055)] active:cursor-grabbing"
    style={{
      minWidth: 80,
      minHeight: 80,
      boxShadow: selected
        ? 'inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 2px rgba(255,255,255,0.42)'
        : 'inset 0 1px 0 rgba(255,255,255,0.055)',
    }}
  >
    <div className="node-drag-handle group-panel-handle pointer-events-auto absolute left-3 top-3 h-6 rounded-md border border-white/[0.16] bg-[#1c1f26]/90 px-2 text-[12px] font-medium leading-6 text-white/70">
      组
    </div>
    <div className="node-drag-handle group-panel-hit-area pointer-events-auto absolute inset-x-0 top-0 h-3 rounded-t-2xl" />
    <div className="node-drag-handle group-panel-hit-area pointer-events-auto absolute inset-x-0 bottom-0 h-3 rounded-b-2xl" />
    <div className="node-drag-handle group-panel-hit-area pointer-events-auto absolute inset-y-0 left-0 w-3 rounded-l-2xl" />
    <div className="node-drag-handle group-panel-hit-area pointer-events-auto absolute inset-y-0 right-0 w-3 rounded-r-2xl" />
  </div>
);

export default memo(GroupPanelNode);
