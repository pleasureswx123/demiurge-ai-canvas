import React from 'react';
import { Folder, Image as ImageIcon, ShieldCheck, Trash2, Video, X } from 'lucide-react';
import { MATERIAL_LIBRARY_CATEGORY_TABS } from '../api/materialLibraryApi';

const isSeedanceApproved = (item) =>
  String(item?.seedanceFaceReview?.status || '').toLowerCase() === 'approved';

export default function MaterialLibraryPanel({
  visible,
  items,
  activeCategory,
  loading,
  error,
  onCategoryChange,
  onUseItem,
  onDragItemStart,
  onDeleteItem,
  deletingItemId = null,
  onClose,
}) {
  if (!visible) return null;

  return (
    <div className="flex h-full min-h-[520px] flex-col">
      <div className="flex items-center justify-between border-b border-white/[0.08] px-6 py-5">
        <div className="flex items-center gap-2 text-[15px] font-semibold text-white">
          <Folder size={16} />
          我的素材
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl p-2 text-white/45 transition-colors hover:bg-white/8 hover:text-white"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex items-center gap-3 px-6 py-4">
        {MATERIAL_LIBRARY_CATEGORY_TABS.map((item) => {
          const active = activeCategory === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onCategoryChange(item.id)}
              className={`rounded-xl px-4 py-2 text-[14px] transition-colors ${
                active ? 'bg-white/12 text-white' : 'text-white/52 hover:bg-white/6 hover:text-white/80'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {loading ? (
          <div className="py-10 text-sm text-white/40">素材库加载中...</div>
        ) : error ? (
          <div className="py-10 text-sm text-[#ffb4b4]">{error}</div>
        ) : items.length ? (
          <div className="grid grid-cols-3 gap-4 xl:grid-cols-4">
            {items.map((item) => (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                onClick={() => onUseItem(item)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onUseItem(item);
                  }
                }}
                draggable
                onDragStart={(event) => onDragItemStart?.(event, item)}
                className="group cursor-pointer text-left outline-none"
              >
                <div className="overflow-hidden rounded-[16px] border border-white/[0.06] bg-[#232323] transition-colors group-hover:border-white/[0.14]">
                  <div className="relative aspect-[4/4.2] overflow-hidden bg-[#1c1c1c]">
                    <button
                      type="button"
                      aria-label={`删除素材 ${item.name}`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onDeleteItem?.(item);
                      }}
                      className={`absolute right-2 top-2 z-10 rounded-lg border border-white/[0.08] bg-black/50 p-1.5 text-white/80 backdrop-blur transition-all ${
                        deletingItemId === item.id
                          ? 'opacity-100'
                          : 'opacity-0 group-hover:opacity-100 hover:bg-black/70 hover:text-white'
                      }`}
                    >
                      <Trash2 size={12} />
                    </button>
                    {item.kind === 'video' ? (
                      <video
                        src={item.coverUrl || item.assetUrl}
                        className="h-full w-full object-cover"
                        muted
                        playsInline
                        preload="metadata"
                        draggable={false}
                      />
                    ) : (
                      <img
                        src={item.coverUrl || item.assetUrl}
                        alt={item.name}
                        className="h-full w-full object-cover"
                        draggable={false}
                      />
                    )}
                    <div className="absolute left-2 top-2 rounded-lg bg-black/40 px-2 py-1 text-[11px] text-white/82 backdrop-blur">
                      {item.kind === 'video' ? (
                        <span className="inline-flex items-center gap-1">
                          <Video size={11} />
                          视频
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <ImageIcon size={11} />
                          图片素材
                        </span>
                      )}
                    </div>
                    {isSeedanceApproved(item) ? (
                      <div className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-lg border border-[#79d88a]/25 bg-[#15351d]/78 px-2 py-1 text-[11px] font-semibold text-[#b7f2c0] backdrop-blur">
                        <ShieldCheck size={11} />
                        Seedance 人脸识别通过
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="px-1 pt-2">
                  <div className="truncate text-[14px] text-white/92">{item.name}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-10 text-sm text-white/35">这个分类里还没有素材。</div>
        )}
      </div>
    </div>
  );
}
