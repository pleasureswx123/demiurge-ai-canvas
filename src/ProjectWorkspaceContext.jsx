import { createContext, useContext } from 'react';

/**
 * 画布工作区：工程信息、导航与工程级操作（创建/删除等）。
 */
export const ProjectWorkspaceContext = createContext({
  slug: null,
  name: '',
  initialFlow: null,
  /** 回到工程列表（主页/仪表盘） */
  onBackToDashboard: () => {},
  onProjectNameChange: () => {},
  /** 与「回到主页」相同：打开全部项目列表 */
  onOpenAllProjects: () => {},
  /** 新建工程并切换到新画布 */
  onCreateNewProject: () => {},
  /** 删除当前工程（磁盘整目录）并返回列表 */
  onDeleteCurrentProject: () => {},
});

export function useProjectWorkspace() {
  return useContext(ProjectWorkspaceContext);
}
