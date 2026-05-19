import React from 'react';
import { createPortal } from 'react-dom';
import { Ungroup } from 'lucide-react';

const GroupToolbar = ({ visible, screenPos, onUngroup }) => {
  if (!visible || !screenPos) return null;

  return createPortal(
    <div
      data-group-toolbar-root
      className="fixed z-[180] flex items-center gap-0.5 rounded-2xl border border-white/[0.09] bg-[#242424]/95 px-2 py-1.5 shadow-xl backdrop-blur-sm"
      style={{
        left: screenPos.left,
        top: screenPos.top,
        transform: 'translateX(-50%)',
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={onUngroup}
        className="flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-[12.5px] text-[#e6e6e6] transition-colors hover:bg-white/10"
      >
        <Ungroup size={14} className="text-[#bdbdbd]" />
        解组
      </button>
    </div>,
    document.body
  );
};

export default GroupToolbar;
