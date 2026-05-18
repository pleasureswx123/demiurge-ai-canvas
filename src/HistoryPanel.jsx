import React, { useMemo, useState } from 'react';
import { Clapperboard, History, Image as ImageIcon, Video, X } from 'lucide-react';

const HISTORY_TABS = [
  { id: 'image', label: '图片历史', Icon: ImageIcon },
  { id: 'video', label: '视频历史', Icon: Video },
];

export default function HistoryPanel({
  visible,
  items,
  counts,
  loading,
  error,
  onUseItem,
  onDragItemStart,
  onClose,
}) {
  const [activeTab, setActiveTab] = useState('image');

  const filteredItems = useMemo(
    () => items.filter((item) => item.kind === activeTab),
    [activeTab, items]
  );

  const groupedItems = useMemo(() => {
    const map = new Map();
    filteredItems.forEach((item) => {
      const key = item.dateLabel || '未知日期';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    });
    return [...map.entries()];
  }, [filteredItems]);

  if (!visible) return null;

  return (
    <div className="flex h-[640px] min-h-[640px] flex-col">
      <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
        <div className="flex items-center gap-5">
          {HISTORY_TABS.map(({ id, label, Icon }) => {
            const active = activeTab === id;
            const count = counts?.[id] ?? filteredItems.length;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`inline-flex items-center gap-2 text-[13px] transition-colors ${
                  active ? 'text-white' : 'text-white/32 hover:text-white/58'
                }`}
              >
                <Icon size={13} />
                <span>{`${label}(${count})`}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3">
          <div className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[12px] text-white/55">
            <History size={12} className="mr-1 inline-block" />
            仅显示 AI 生成记录
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-white/45 transition-colors hover:bg-white/8 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-8 pt-5">
        {loading ? (
          <div className="py-12 text-sm text-white/40">历史记录加载中...</div>
        ) : error ? (
          <div className="py-12 text-sm text-[#ffb4b4]">{error}</div>
        ) : groupedItems.length ? (
          <div className="space-y-6">
            {groupedItems.map(([dateLabel, entries]) => (
              <section key={dateLabel}>
                <div className="mb-3 text-[14px] font-medium text-white/88">{dateLabel}</div>
                <div className="flex flex-wrap gap-3">
                  {entries.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onUseItem?.(item)}
                      draggable
                      onDragStart={(event) => onDragItemStart?.(event, item)}
                      className="group text-left"
                    >
                      <div className="relative h-[118px] w-[118px] overflow-hidden rounded-[10px] border border-white/[0.06] bg-[#232323] transition-colors group-hover:border-white/[0.16]">
                        {item.kind === 'video' ? (
                          <img
                            src={item.thumbUrl}
                            alt={item.name}
                            className="h-full w-full object-cover"
                            draggable={false}
                          />
                        ) : (
                          <img
                            src={item.thumbUrl || item.assetUrl}
                            alt={item.name}
                            className="h-full w-full object-cover"
                            draggable={false}
                          />
                        )}
                        {item.kind === 'video' && (
                          <div className="absolute right-2 top-2 rounded-md bg-black/40 p-1 text-white/82">
                            <Clapperboard size={12} />
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="py-12 text-sm text-white/35">还没有 AI 生成历史记录。</div>
        )}
      </div>
    </div>
  );
}
