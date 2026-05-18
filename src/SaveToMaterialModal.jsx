import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';
import { MATERIAL_LIBRARY_SELECTABLE_CATEGORIES } from './materialLibraryApi';

export default function SaveToMaterialModal({
  open,
  draft,
  saving,
  onClose,
  onSubmit,
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');

  useEffect(() => {
    if (!open || !draft) return;
    setName(draft.defaultName || '');
    setCategory(draft.defaultCategory || '');
  }, [open, draft]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !saving) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, saving]);

  if (!open || !draft) return null;

  const previewSrc = draft.coverAsset?.src || draft.asset?.src;

  return createPortal(
    <div className="fixed inset-0 z-[260] flex items-center justify-center bg-black/62 backdrop-blur-[1px]">
      <div
        className="w-[min(96vw,960px)] overflow-hidden rounded-[22px] border border-white/[0.06] bg-[#1b1b1c] shadow-[0_28px_90px_rgba(0,0,0,0.52)]"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/[0.08] px-6 py-5">
          <div className="flex items-center gap-6">
            <div className="text-[18px] font-semibold text-white">创建素材文件夹</div>
            <div className="text-[14px] text-white/34">添加到现有素材文件</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-xl p-2 text-white/45 transition-colors hover:bg-white/8 hover:text-white disabled:opacity-50"
          >
            <X size={20} />
          </button>
        </div>

        <div className="grid grid-cols-[1.08fr_1fr] gap-6 px-6 py-5">
          <div>
            <div className="mb-3 text-[14px] text-white/62">封面</div>
            <div className="overflow-hidden rounded-[18px] border border-white/[0.06] bg-[#232323]">
              <div className="aspect-[4/5] bg-[#181818]">
                {draft.kind === 'video' ? (
                  <video
                    src={previewSrc}
                    className="h-full w-full object-cover"
                    muted
                    playsInline
                    preload="metadata"
                  />
                ) : (
                  <img
                    src={previewSrc}
                    alt={name || draft.defaultName || '素材预览'}
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-7 pt-1">
            <label className="block">
              <div className="mb-3 text-[14px] text-white/88">
                名称 <span className="text-[#ff6b6b]">*</span>
              </div>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="请输入素材名称"
                className="h-14 w-full rounded-[16px] border border-white/[0.08] bg-[#1c1c1c] px-4 text-[16px] text-white outline-none transition-colors placeholder:text-white/24 focus:border-white/18"
              />
            </label>

            <label className="block">
              <div className="mb-3 text-[14px] text-white/88">
                分类 <span className="text-[#ff6b6b]">*</span>
              </div>
              <div className="relative">
                <select
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  className="h-14 w-full appearance-none rounded-[16px] border border-white/[0.08] bg-[#1c1c1c] px-4 pr-12 text-[16px] text-white outline-none transition-colors focus:border-white/18"
                >
                  <option value="">请选择</option>
                  {MATERIAL_LIBRARY_SELECTABLE_CATEGORIES.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={18}
                  className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-white/36"
                />
              </div>
            </label>

            <div className="mt-auto flex justify-end">
              <button
                type="button"
                disabled={saving || !name.trim() || !category}
                onClick={() =>
                  onSubmit({
                    name: name.trim(),
                    category,
                  })
                }
                className="h-14 rounded-[16px] bg-[#4a8cff] px-7 text-[16px] font-semibold text-white transition-colors hover:bg-[#5a95ff] disabled:cursor-not-allowed disabled:bg-[#4a8cff]/45"
              >
                {saving ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
