import { memo } from 'react';

/**
 * React Flow 视口用 CSS scale 缩放画布，节点内文字/图标栅格会被二次拉伸而发糊。
 * 用与视口 zoom 相反的局部缩放（优先 CSS zoom，其次 transform），且始终用「放大布局再向下缩放」，
 * 避免 zoom 小于 1 时把小字号栅格放大造成糊边。
 */
export const CrispZoomRoot = memo(function CrispZoomRoot({ children, className }) {
  return (
    <div className={`min-w-0 overflow-visible ${className ?? ''}`}>
      <div className="crisp-zoom-inner">{children}</div>
    </div>
  );
});

export default CrispZoomRoot;
