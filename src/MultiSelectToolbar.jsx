import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftRight,
  ArrowUpDown,
  Copy,
  Folder,
  LayoutGrid,
  Zap,
} from 'lucide-react';

const LAYOUT_ITEMS = [
  { id: 'grid', label: '宫格排列', icon: LayoutGrid },
  { id: 'horizontal', label: '水平排列', icon: ArrowLeftRight },
  { id: 'vertical', label: '垂直排列', icon: ArrowUpDown },
];

const MultiSelectToolbar = ({
  visible,
  screenPos,
  onArrange,
  onGroup,
  onDuplicate,
  onSaveToAssets,
  onBatchDownload,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!visible) setMenuOpen(false);
  }, [visible]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e) => {
      if (e.target.closest?.('[data-ms-toolbar-root]')) return;
      setMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  if (!visible || !screenPos) return null;

  return createPortal(
    <div
      data-ms-toolbar-root
      className="fixed z-[180] flex items-center gap-0.5 rounded-2xl border border-white/[0.09] bg-[#242424]/95 px-2 py-1.5 shadow-xl backdrop-blur-sm"
      style={{
        left: screenPos.left,
        top: screenPos.top,
        transform: 'translateX(-50%)',
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="relative">
        <button
          type="button"
          title="排列"
          onClick={() => setMenuOpen((v) => !v)}
          className={`flex h-8 w-8 items-center justify-center rounded-xl transition-colors ${
            menuOpen ? 'bg-white/15 text-white' : 'text-[#cfcfcf] hover:bg-white/10 hover:text-white'
          }`}
        >
          <LayoutGrid size={16} strokeWidth={2} />
        </button>

        {menuOpen && (
          <div
            data-ms-layout-menu
            className="absolute bottom-full left-1/2 z-[190] mb-2 w-40 -translate-x-1/2 rounded-xl border border-white/[0.09] bg-[#242424] py-1 shadow-2xl"
          >
            {LAYOUT_ITEMS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-[#e6e6e6] transition-colors hover:bg-white/10"
                onClick={() => {
                  onArrange(id);
                  setMenuOpen(false);
                }}
              >
                <Icon size={15} strokeWidth={2} className="shrink-0 text-[#bdbdbd]" />
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mx-0.5 h-5 w-px bg-white/12" />

      <button
        type="button"
        onClick={onSaveToAssets}
        className="flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-[12.5px] text-[#e6e6e6] transition-colors hover:bg-white/10"
      >
        <Zap size={14} className="text-[#bdbdbd]" />
        保存到素材
      </button>

      <button
        type="button"
        onClick={onBatchDownload}
        className="h-8 rounded-xl px-2.5 text-[12.5px] text-[#e6e6e6] transition-colors hover:bg-white/10"
      >
        批量下载
      </button>

      <button
        type="button"
        onClick={onDuplicate}
        className="flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-[12.5px] text-[#e6e6e6] transition-colors hover:bg-white/10"
      >
        <Copy size={14} className="text-[#bdbdbd]" />
        创建副本
      </button>

      <button
        type="button"
        onClick={onGroup}
        className="flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-[12.5px] text-[#e6e6e6] transition-colors hover:bg-white/10"
      >
        <Folder size={14} className="text-[#bdbdbd]" />
        打组
      </button>
    </div>,
    document.body
  );
};

export default MultiSelectToolbar;
