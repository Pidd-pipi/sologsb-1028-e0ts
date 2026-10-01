import { createBundledBaseMap, createInitialState } from './data';
import { allConflictsResolved, buildMergeReport, bundleFromState, resolveConflict, validateBundle } from './merge';
import type { ComponentSnapshot, ComponentSpec, MergeReport, MergeSide, PendingMerge, SpecBundle, ValidationIssue, WorkspaceState } from './types';

const STORAGE_KEY = 'sologsb-1028-workspace-v1';
const PENDING_MERGE_KEY = 'sologsb-1028-pending-merge-v1';

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const signature = (component: ComponentSpec) => `${component.properties.map((item) => `${item.name}:${item.required}`).join('|')}::${component.interactionSignature}`;

export class SpecStore extends EventTarget {
  state: WorkspaceState;
  /** 未提交的合并：双方草稿都保留在这里，选定前不动正式规范 */
  pendingMerge: PendingMerge | null = null;
  private undoStack: WorkspaceState[] = [];
  private redoStack: WorkspaceState[] = [];
  private lastAction = '';
  private readonly bundledBases = createBundledBaseMap();

  constructor() {
    super();
    this.state = this.load();
    this.pendingMerge = this.loadPendingMerge();
  }

  get selected(): ComponentSpec | undefined {
    return this.state.components.find((item) => item.id === this.state.selectedId);
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get lastUndoLabel() { return this.lastAction; }
  get hasPendingMerge() { return this.pendingMerge !== null; }
  get pendingReport(): MergeReport | null { return this.pendingMerge?.report ?? null; }
  get pendingConflictsResolved(): boolean {
    return !!this.pendingMerge && allConflictsResolved(this.pendingMerge.report);
  }

  select(id: string) {
    if (!this.state.components.some((item) => item.id === id)) return;
    this.state = { ...this.state, selectedId: id };
    this.persist(false);
    this.emit();
  }

  addComponent() {
    const id = uid('component');
    const component: ComponentSpec = {
      id,
      name: 'Untitled component',
      category: 'Uncategorised',
      status: 'draft',
      purpose: '说明该组件解决的用户问题。',
      usage: '说明何时使用、何时不要使用。',
      properties: [],
      states: 'default、hover、focus-visible、disabled。',
      keyboardBehavior: '记录 Tab、Enter、Space、方向键和 Esc 等行为。',
      screenReader: '记录角色、名称、状态和动态播报。',
      disabledScenarios: '记录不应使用该组件的场景。',
      interactionSignature: '',
      examples: [],
      revision: 1,
      updatedAt: new Date().toISOString(),
      snapshots: []
    };
    this.commit('新建组件', (state) => {
      state.components.unshift(component);
      state.selectedId = id;
    });
  }

  updateComponent(patch: Partial<ComponentSpec>, markExamplesStale = false) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('编辑组件', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      Object.assign(target, patch, { updatedAt: new Date().toISOString() });
      if (markExamplesStale) {
        target.examples.forEach((example) => {
          example.stale = true;
          example.staleReason = '组件交互或属性契约已修改，示例需要重新验证。';
        });
      }
    });
  }

  addProperty() {
    const selected = this.selected;
    if (!selected) return;
    this.commit('新增属性', (state) => {
      state.components.find((item) => item.id === selected.id)?.properties.push({
        id: uid('property'),
        name: 'newProperty',
        type: 'string',
        required: false,
        defaultValue: '',
        description: '描述该属性对开发者和用户的影响。'
      });
    });
  }

  updateProperty(propertyId: string, patch: Partial<ComponentSpec['properties'][number]>) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('编辑属性', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      const property = target?.properties.find((item) => item.id === propertyId);
      if (target && property) Object.assign(property, patch);
    });
  }

  removeProperty(propertyId: string) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('删除属性', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      const property = target?.properties.find((item) => item.id === propertyId);
      if (!target || !property) return;
      target.properties = target.properties.filter((item) => item.id !== propertyId);
      target.examples.forEach((example) => {
        if (example.propertyIds.includes(propertyId) || example.code.includes(property.name)) {
          example.stale = true;
          example.staleReason = `属性 ${property.name} 已删除，示例代码或说明仍可能引用它。`;
        }
      });
    });
  }

  addExample() {
    const selected = this.selected;
    if (!selected) return;
    const exampleId = uid('example');
    this.commit('新增示例', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      target.examples.push({
        id: exampleId,
        title: '新示例',
        code: `<${target.name.toLowerCase().replaceAll(' ', '-')}>示例</${target.name.toLowerCase().replaceAll(' ', '-')}>`,
        propertyIds: [],
        stale: false,
        staleReason: '',
        createdFromRevision: target.revision
      });
    });
  }

  updateExample(exampleId: string, patch: Partial<ComponentSpec['examples'][number]>) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('编辑示例', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      const example = target?.examples.find((item) => item.id === exampleId);
      if (example) Object.assign(example, patch);
    });
  }

  removeExample(exampleId: string) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('删除示例', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (target) target.examples = target.examples.filter((item) => item.id !== exampleId);
    });
  }

  createSnapshot(reason = '手动版本') {
    const selected = this.selected;
    if (!selected) return;
    this.commit('创建版本快照', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      const { snapshots: _ignored, ...component } = clone(target);
      const nextRevision = target.revision + 1;
      const snapshot: ComponentSnapshot = {
        revision: target.revision,
        savedAt: new Date().toISOString(),
        reason,
        component: { ...component, revision: target.revision }
      };
      target.snapshots.unshift(snapshot);
      target.snapshots = target.snapshots.slice(0, 12);
      target.revision = nextRevision;
      target.updatedAt = new Date().toISOString();
    });
  }

  migrateExamples() {
    const selected = this.selected;
    if (!selected) return;
    this.commit('迁移示例到当前版本', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      const currentSignature = signature(target);
      const activePropertyIds = new Set(target.properties.map((item) => item.id));
      target.examples.forEach((example) => {
        example.propertyIds = example.propertyIds.filter((id) => activePropertyIds.has(id));
        example.stale = false;
        example.staleReason = '';
        example.createdFromRevision = target.revision;
      });
      target.interactionSignature = currentSignature.split('::')[1] ?? target.interactionSignature;
      target.revision += 1;
      target.updatedAt = new Date().toISOString();
    });
  }

  /* ------------------------------ 离线稿合并 ------------------------------ */

  /** 导出当前正式规范，供断网维护者带走 */
  exportBundle(): SpecBundle {
    return bundleFromState(this.state);
  }

  exportBundleJson(): string {
    return JSON.stringify(this.exportBundle(), null, 2);
  }

  /**
   * 读入维护者带回的稿包并做三方合并：
   * 无冲突可以直接提交；有冲突则挂起为待决合并，双方草稿都保留、允许重试。
   */
  importBundle(input: unknown): { ok: boolean; error?: string; report?: MergeReport } {
    const checked = validateBundle(input);
    if (!checked.ok) return { ok: false, error: checked.error };
    try {
      const report = buildMergeReport(this.state, checked.bundle, this.bundledBases);
      this.pendingMerge = {
        id: uid('merge'),
        startedAt: new Date().toISOString(),
        incoming: checked.bundle,
        report
      };
      this.persistPendingMerge();
      this.emit();
      return { ok: true, report };
    } catch (error) {
      return { ok: false, error: `合并失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** 维护者为一条冲突选择本机稿或带回稿；仅更新待决草稿 */
  chooseConflictSide(conflictId: string, side: MergeSide) {
    if (!this.pendingMerge) return;
    const report = resolveConflict(this.pendingMerge.report, conflictId, side, this.bundledBases);
    this.pendingMerge = { ...this.pendingMerge, report };
    this.persistPendingMerge();
    this.emit();
  }

  /** 冲突全部选定后把合并结果写入正式规范；未选定完不允许提交 */
  commitMerge(reason = '离线稿合并'): { ok: boolean; error?: string } {
    const pending = this.pendingMerge;
    if (!pending) return { ok: false, error: '没有待提交的合并。' };
    if (!allConflictsResolved(pending.report)) {
      return { ok: false, error: '仍有冲突未选定，正式规范保持不变。' };
    }
    const before = clone(this.state);
    const next = clone(pending.report.merged);
    next.components = next.components.map((component) => ({
      ...component,
      revision: component.revision + 1,
      updatedAt: new Date().toISOString()
    }));
    this.undoStack.push(before);
    this.undoStack = this.undoStack.slice(-40);
    this.redoStack = [];
    this.lastAction = reason;
    this.state = next;
    this.pendingMerge = null;
    localStorage.removeItem(PENDING_MERGE_KEY);
    this.persist();
    this.emit();
    return { ok: true };
  }

  /** 放弃本次挂起合并（带回稿可稍后重新导入），正式规范不变 */
  discardPendingMerge() {
    if (!this.pendingMerge) return;
    this.pendingMerge = null;
    localStorage.removeItem(PENDING_MERGE_KEY);
    this.emit();
  }

  /** 用原始双方草稿重新计算一次合并（失败后的重试入口） */
  retryMerge(): { ok: boolean; error?: string } {
    if (!this.pendingMerge) return { ok: false, error: '没有可重试的合并。' };
    try {
      const report = buildMergeReport(this.state, this.pendingMerge.incoming, this.bundledBases);
      this.pendingMerge = { ...this.pendingMerge, report, startedAt: new Date().toISOString() };
      this.persistPendingMerge();
      this.emit();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `重试失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  validate(): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const component of this.state.components) {
      const names = new Map<string, number>();
      component.properties.forEach((property) => names.set(property.name.trim(), (names.get(property.name.trim()) ?? 0) + 1));
      for (const [name, count] of names) {
        if (name && count > 1) {
          issues.push({ id: `${component.id}-duplicate-${name}`, level: 'error', componentId: component.id, target: component.name, message: `属性名称 ${name} 重复。`, field: 'properties' });
        }
      }
      const contractChanged = component.examples.some((example) => example.createdFromRevision < component.revision);
      component.examples.forEach((example) => {
        const missingReferences = example.propertyIds.filter((id) => !component.properties.some((property) => property.id === id));
        if (example.stale || missingReferences.length) {
          issues.push({ id: `${component.id}-${example.id}-stale`, level: 'warning', componentId: component.id, target: example.title, message: example.staleReason || '示例引用了已删除属性。', field: 'examples' });
        }
        if (!example.code.trim()) {
          issues.push({ id: `${component.id}-${example.id}-empty`, level: 'error', componentId: component.id, target: example.title, message: '示例代码不能为空。', field: 'examples' });
        }
      });
      if (!component.keyboardBehavior.trim()) {
        issues.push({ id: `${component.id}-keyboard`, level: 'error', componentId: component.id, target: component.name, message: '缺少键盘行为说明。', field: 'keyboard' });
      }
      if (!component.screenReader.trim()) {
        issues.push({ id: `${component.id}-screenreader`, level: 'error', componentId: component.id, target: component.name, message: '缺少读屏说明。', field: 'screenReader' });
      }
      if (contractChanged && component.examples.length) {
        issues.push({ id: `${component.id}-contract`, level: 'info', componentId: component.id, target: component.name, message: '属性契约或交互签名发生变化，建议创建快照并迁移示例。', field: 'properties' });
      }
    }
    return issues;
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(clone(this.state));
    this.state = previous;
    this.persist(false);
    this.emit();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.state));
    this.state = next;
    this.persist(false);
    this.emit();
  }

  reset() {
    this.undoStack = [];
    this.redoStack = [];
    this.state = createInitialState();
    this.pendingMerge = null;
    localStorage.removeItem(PENDING_MERGE_KEY);
    this.persist(false);
    this.emit();
  }

  private commit(label: string, mutator: (state: WorkspaceState) => void) {
    const before = clone(this.state);
    const next = clone(this.state);
    mutator(next);
    this.undoStack.push(before);
    this.undoStack = this.undoStack.slice(-40);
    this.redoStack = [];
    this.lastAction = label;
    this.state = next;
    this.persist();
    this.emit();
  }

  private load(): WorkspaceState {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved) as WorkspaceState;
    } catch {
      // A corrupted local draft falls back to the bundled demo data.
    }
    return createInitialState();
  }

  private persist(_notify = true) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  }

  private persistPendingMerge() {
    if (this.pendingMerge) {
      localStorage.setItem(PENDING_MERGE_KEY, JSON.stringify(this.pendingMerge));
    } else {
      localStorage.removeItem(PENDING_MERGE_KEY);
    }
  }

  private loadPendingMerge(): PendingMerge | null {
    try {
      const saved = localStorage.getItem(PENDING_MERGE_KEY);
      return saved ? (JSON.parse(saved) as PendingMerge) : null;
    } catch {
      return null;
    }
  }

  private emit() {
    this.dispatchEvent(new CustomEvent('change'));
  }
}
