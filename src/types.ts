export type ComponentStatus = 'draft' | 'review' | 'published';
export type PreviewTheme = 'light' | 'dark';
export type PreviewDensity = 'compact' | 'regular' | 'spacious';

export interface PropertySpec {
  id: string;
  name: string;
  type: string;
  required: boolean;
  defaultValue: string;
  description: string;
}

export interface ComponentExample {
  id: string;
  title: string;
  code: string;
  propertyIds: string[];
  stale: boolean;
  staleReason: string;
  createdFromRevision: number;
}

export interface ComponentSpec {
  id: string;
  name: string;
  category: string;
  status: ComponentStatus;
  purpose: string;
  usage: string;
  properties: PropertySpec[];
  states: string;
  keyboardBehavior: string;
  screenReader: string;
  disabledScenarios: string;
  interactionSignature: string;
  examples: ComponentExample[];
  revision: number;
  updatedAt: string;
  snapshots: ComponentSnapshot[];
}

export interface ComponentSnapshot {
  revision: number;
  savedAt: string;
  reason: string;
  component: Omit<ComponentSpec, 'snapshots'>;
}

export interface WorkspaceState {
  components: ComponentSpec[];
  selectedId: string;
}

export interface ValidationIssue {
  id: string;
  level: 'error' | 'warning' | 'info';
  componentId: string;
  target: string;
  message: string;
  field: 'properties' | 'examples' | 'keyboard' | 'screenReader';
}

export interface DiffRow {
  field: string;
  before: string;
  after: string;
}

export type MergeSide = 'local' | 'incoming';
export type MergeTarget = 'component' | 'property' | 'example';
export type MergeConflictKind =
  | 'both-modified'
  | 'added-both'
  | 'deleted-modified';

export interface MergeConflict {
  id: string;
  componentId: string;
  /** 组件级冲突等于 componentId，否则为属性或示例的稳定编号 */
  itemId: string;
  target: MergeTarget;
  kind: MergeConflictKind;
  /** 结构冲突（新增/删除）为空字符串 */
  field: string;
  label: string;
  localLabel: string;
  incomingLabel: string;
  localValue: string;
  incomingValue: string;
  localRaw: unknown;
  incomingRaw: unknown;
  chosen: MergeSide | null;
  /** 同名异编号结构冲突里，落选方的稳定编号（选定后剔除） */
  otherItemId?: string;
}

export interface MergeChangeNote {
  id: string;
  level: 'auto' | 'stale' | 'info';
  message: string;
}

/** 维护者断网后带回的整包稿 */
export interface SpecBundle {
  app: 'sologsb-1028';
  exportedAt: string;
  components: ComponentSpec[];
}

export interface MergeReport {
  generatedAt: string;
  /** 找到共同基线（快照或内置稿）、可做三方合并的组件 */
  baseFoundFor: string[];
  /** 没有共同基线、退回到保守二选一策略的组件 */
  baseMissingFor: string[];
  merged: WorkspaceState;
  conflicts: MergeConflict[];
  changes: MergeChangeNote[];
  addedComponentIds: string[];
}

export interface PendingMerge {
  id: string;
  startedAt: string;
  incoming: SpecBundle;
  report: MergeReport;
}
