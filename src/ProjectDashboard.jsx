import React, { useCallback, useEffect, useRef, useState } from 'react';
import brandLogo from './assets/branding/logo.svg';
import {
  FolderOpen,
  MoreHorizontal,
  Plus,
  Trash2,
  Copy,
  Pencil,
  Video,
  Image as ImagePlaceholder,
} from 'lucide-react';

/**
 * 工程管理起始页（参考 LibTV / Resolve 项目浏览器布局）。
 * 挂载：src/App.jsx 在未进入画布时渲染。
 *
 * props.onEnterProject({ slug, name, flow })
 */
export default function ProjectDashboard({ onEnterProject }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [menuSlug, setMenuSlug] = useState(null);
  const [editingSlug, setEditingSlug] = useState(null);
  const [editingName, setEditingName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [pendingDeleteProject, setPendingDeleteProject] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const renamingRef = useRef(false);

  const refreshList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/project/list');
      const data = await res.json();
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } catch {
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  const parseJsonSafe = async (res) => {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { error: text?.slice(0, 120) || `HTTP ${res.status}` };
    }
  };

  /** 开始创作：不弹窗，后端默认名称「未命名工程」，直接进入画布 */
  const handleCreateImmediate = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const res = await fetch('/api/project/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '未命名工程' }),
      });
      const data = await parseJsonSafe(res);
      if (!res.ok) {
        const hint =
          res.status === 404 || String(data.error || '').includes('Not found')
            ? '请先在本机终端启动工程服务：在项目根目录运行 node server/deepseek-proxy.js（监听 8787 端口），并保持窗口不要关闭。'
            : '';
        throw new Error([data.error || `创建失败 (${res.status})`, hint].filter(Boolean).join('\n'));
      }
      const loadRes = await fetch(`/api/project/load?slug=${encodeURIComponent(data.slug)}`);
      const loaded = await parseJsonSafe(loadRes);
      if (!loadRes.ok) throw new Error(loaded.error || '读取工程失败');
      onEnterProject({
        slug: data.slug,
        name: loaded.data?.name || '未命名工程',
        flow: loaded.data?.flow || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 0.85 } },
      });
    } catch (e) {
      window.alert(e.message || '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const openProject = async (slug) => {
    try {
      const res = await fetch(`/api/project/load?slug=${encodeURIComponent(slug)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '打开失败');
      onEnterProject({
        slug,
        name: data.data?.name || slug,
        flow: data.data?.flow || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 0.85 } },
      });
    } catch (e) {
      window.alert(e.message || '打开失败');
    }
  };

  const startRenameProject = (project) => {
    setMenuSlug(null);
    setEditingSlug(project.slug);
    setEditingName(project.name || '');
  };

  const cancelRenameProject = () => {
    if (renamingRef.current) return;
    setEditingSlug(null);
    setEditingName('');
  };

  const renameProject = async (slug) => {
    if (renamingRef.current) return;
    const trimmed = editingName.trim();
    if (!trimmed) {
      cancelRenameProject();
      return;
    }
    try {
      renamingRef.current = true;
      setRenaming(true);
      const res = await fetch('/api/project/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, newName: trimmed }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || '重命名失败');
      setProjects((prev) =>
        prev.map((project) => (project.slug === slug ? { ...project, name: trimmed } : project))
      );
      setEditingSlug(null);
      setEditingName('');
      await refreshList();
    } catch (e) {
      window.alert(e.message || '重命名失败');
    } finally {
      renamingRef.current = false;
      setRenaming(false);
    }
  };

  const copyProject = async (slug) => {
    try {
      const res = await fetch('/api/project/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '复制失败');
      setMenuSlug(null);
      await refreshList();
    } catch (e) {
      window.alert(e.message || '复制失败');
    }
  };

  const requestDeleteProject = (project) => {
    setMenuSlug(null);
    setPendingDeleteProject(project);
  };

  const closeDeleteDialog = () => {
    if (deleting) return;
    setPendingDeleteProject(null);
  };

  const deleteProject = async (slug) => {
    try {
      setDeleting(true);
      const res = await fetch(`/api/project/delete?slug=${encodeURIComponent(slug)}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '删除失败');
      setMenuSlug(null);
      setPendingDeleteProject(null);
      await refreshList();
    } catch (e) {
      window.alert(e.message || '删除失败');
    } finally {
      setDeleting(false);
    }
  };

  const fmtDate = (iso) => {
    try {
      const d = new Date(iso);
      return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    } catch {
      return '—';
    }
  };

  const getPreviewTiles = (project) => {
    const tiles = Array.isArray(project?.coverTiles)
      ? project.coverTiles.filter((tile) => tile && typeof tile.url === 'string' && tile.url.trim())
      : [];
    if (tiles.length) return tiles.slice(0, 4);
    if (typeof project?.coverUrl === 'string' && project.coverUrl.trim()) {
      return [{ url: project.coverUrl, kind: 'image' }];
    }
    return [];
  };

  return (
    <div className="min-h-screen bg-[#181818] text-[#eceef2] antialiased">
      {/* 顶栏：纯色中性灰，避免偏蓝（不用半透明+blur 叠色） */}
      <header className="h-16 shrink-0 px-6 md:px-10 flex items-center justify-between border-b border-white/[0.06] bg-[#181818]">
        <div className="flex items-baseline gap-2">
          <div className="flex h-9 items-center">
            <img
              src={brandLogo}
              alt="Demiurge"
              className="h-9 w-auto max-w-[172px] object-contain brightness-125 contrast-110 drop-shadow-[0_0_14px_rgba(255,255,255,0.08)]"
              draggable={false}
            />
          </div>
        </div>
        <div className="text-xs text-white/25 hidden md:block">本地工程</div>
      </header>

      <div className="px-6 md:px-10 pt-10 pb-5">
        <h2 className="text-[17px] font-semibold text-white tracking-tight">全部项目</h2>
      </div>

      <main className="px-6 md:px-10 pb-16 max-w-[1680px] mx-auto">
        {loading ? (
          <div className="text-white/35 text-sm py-12">加载工程列表…</div>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-4 gap-4 md:gap-5">
              {/* 开始创作：独立一列，标题在卡片下方 */}
              <div className="flex flex-col gap-2 min-w-0">
                <button
                  type="button"
                  onClick={handleCreateImmediate}
                  disabled={creating}
                  className="group relative w-full aspect-video rounded-[12px] overflow-hidden border border-white/[0.08] bg-[#202020] shadow-[0_8px_28px_rgba(0,0,0,0.35)] hover:bg-[#252525] hover:border-white/[0.12] transition-all disabled:opacity-60 disabled:pointer-events-none"
                >
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                    <Plus
                      size={44}
                      strokeWidth={1}
                      className="text-white/95 group-hover:opacity-100 opacity-90 transition-opacity"
                    />
                    <span className="text-[15px] font-medium text-white/95">开始创作</span>
                  </div>
                </button>
                <p className="text-left text-[11px] text-white/42 leading-snug pl-0.5">
                  创建新的视频项目
                </p>
              </div>

              {projects.map((p) => (
                <div
                  key={p.slug}
                  className="relative flex flex-col min-w-0 gap-2"
                >
                  {/* 16:9 封面区 */}
                  <div className="relative aspect-video w-full shrink-0 rounded-[12px] overflow-hidden bg-[#202020] border border-white/[0.08] shadow-[0_8px_28px_rgba(0,0,0,0.28)]">
                    {(() => {
                      const previewTiles = getPreviewTiles(p);
                      const hasVideoTile = previewTiles.some((tile) => tile?.kind === 'video');
                      return (
                        <>
                          <button
                            type="button"
                            onClick={() => openProject(p.slug)}
                            className="absolute inset-0 z-10 block w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/25"
                            aria-label={`打开 ${p.name}`}
                          />
                          {previewTiles.length > 0 ? (
                            <div className="pointer-events-none absolute inset-0 grid grid-cols-2 grid-rows-2 gap-[3px] p-1.5">
                              {[0, 1, 2, 3].map((i) => {
                                const tile = previewTiles[i];
                                return (
                                  <div
                                    key={`${p.slug}-tile-${i}`}
                                    className="relative min-h-0 min-w-0 overflow-hidden rounded-[7px] bg-[#262626]"
                                  >
                                    {tile?.url ? (
                                      <img
                                        src={tile.url}
                                        alt=""
                                        className="absolute inset-0 h-full w-full object-cover"
                                        loading="lazy"
                                        draggable={false}
                                        onError={(e) => {
                                          e.currentTarget.style.display = 'none';
                                        }}
                                      />
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                              <ImagePlaceholder className="w-11 h-11 text-white/[0.12]" strokeWidth={1.25} />
                            </div>
                          )}
                          {hasVideoTile ? (
                            <div className="pointer-events-none absolute left-2.5 top-2.5 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[10px] font-medium text-white/80 backdrop-blur-sm">
                              <span className="inline-flex items-center gap-1">
                                <Video size={11} strokeWidth={1.8} />
                                视频
                              </span>
                            </div>
                          ) : null}
                        </>
                      );
                    })()}
                  </div>

                  <div className="px-0.5">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        {editingSlug === p.slug ? (
                          <input
                            type="text"
                            value={editingName}
                            autoFocus
                            disabled={renaming}
                            onChange={(e) => setEditingName(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                renameProject(p.slug);
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                cancelRenameProject();
                              }
                            }}
                            onBlur={() => {
                              if (editingSlug === p.slug && !renamingRef.current) {
                                renameProject(p.slug);
                              }
                            }}
                            className="w-full rounded-md border border-white/[0.14] bg-[#2a2a2a] px-2 py-1 text-[14px] font-medium leading-snug text-white/95 outline-none ring-0 transition-colors focus:border-white/[0.28]"
                          />
                        ) : (
                          <div className="line-clamp-2 text-[14px] font-medium leading-snug text-white/92">
                            {p.name}
                          </div>
                        )}
                        <div className="mt-1 text-[11px] tabular-nums text-white/35">{fmtDate(p.updatedAt)}</div>
                      </div>
                      <div
                        className="relative shrink-0"
                        onMouseEnter={() => setMenuSlug(p.slug)}
                        onMouseLeave={() => setMenuSlug(null)}
                      >
                        <button
                          type="button"
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white/55 hover:bg-white/[0.06] hover:text-white/80"
                          aria-expanded={menuSlug === p.slug}
                          aria-haspopup="menu"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal size={16} className="text-inherit" />
                        </button>
                        {menuSlug === p.slug && (
                          <div className="absolute right-0 top-full z-50 pt-2">
                            <div
                              className="w-44 rounded-xl border border-white/[0.08] bg-[#262626] py-1 shadow-xl"
                              role="menu"
                            >
                              <button
                                type="button"
                                role="menuitem"
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-white/[0.06]"
                                onClick={() => {
                                  setMenuSlug(null);
                                  openProject(p.slug);
                                }}
                              >
                                <FolderOpen size={14} /> 打开
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-white/[0.06]"
                                onClick={() => startRenameProject(p)}
                              >
                                <Pencil size={14} /> 重命名
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-white/[0.06]"
                                onClick={() => copyProject(p.slug)}
                              >
                                <Copy size={14} /> 复制项目
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-red-300 hover:bg-red-500/15"
                                onClick={() => requestDeleteProject(p)}
                              >
                                <Trash2 size={14} /> 删除项目
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <p className="text-center text-[12px] text-white/28 mt-12 pb-4">没有更多了</p>
          </>
        )}
      </main>

      {pendingDeleteProject ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 px-4">
          <div className="w-full max-w-[344px] rounded-[16px] border border-white/[0.06] bg-[#2a2a2a] px-5 pb-5 pt-4 shadow-[0_24px_60px_rgba(0,0,0,0.45)]">
            <div className="text-[15px] font-semibold tracking-tight text-white">删除项目</div>
            <div className="mt-4 text-[13px] leading-6 text-white/58">确定要删除该项目吗?</div>
            <div className="mt-7 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={closeDeleteDialog}
                disabled={deleting}
                className="rounded-[10px] bg-white/[0.08] px-4 py-2 text-[13px] font-medium text-white/88 transition-colors hover:bg-white/[0.12] disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => deleteProject(pendingDeleteProject.slug)}
                disabled={deleting}
                className="rounded-[10px] bg-[#4f8cff] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[#669bff] disabled:opacity-60"
              >
                {deleting ? '处理中' : '确认'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
