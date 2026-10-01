import type { ComponentExample, ComponentSpec, PropertySpec, WorkspaceState } from './types';

/**
 * 断网草稿合并引擎。
 *
 * 以工作区 base（最近一次同步点）为共同祖先，对 local（当前草稿）与 incoming
 * （对方带回的草稿）做三方合并：
 * - 只有一方改动的字段/实体自动接上；
 * - 双方改动且取值相同的视为一致；
 * - 双方改动但取值不同的字段，或一方删除另一方修改的实体，记为冲突，保留双方结果；
 * - 冲突在用户选定前不写入正式规范。
 */

export interface MergeConflict {
  id: string;
  kind: 'field' | 'delete';
  componentId: string;
  componentName: string;
  entityType: 'component' | 'property' | 'example';
  entityId: string;
  entityLabel: string;
  field: string;
  fieldLabel: string;
  baseValue: unknown;
  localValue: unknown;
  incomingValue: unknown;
}

export interface MergeChange {
  componentId: string;
  componentName: string;
  entityType: 'component' | 'property' | 'example';
  entityLabel: string;
  field: string;
  fieldLabel: string;
  source: 'local' | 'incoming' | 'both';
}

export interface MergeResult {
  ok: boolean;
  error?: string;
  /** 合并后的工作区（冲突保留 local 方取值，待 resolveMerge 调整）。 */
  merged: WorkspaceState;
  conflicts: MergeConflict[];
  changes: MergeChange[];
  /** 因属性改动而失效的示例 id。 */
  invalidatedExamples: string[];
}

export type ConflictResolution = Record<string, 'local' | 'incoming'>;

interface FieldDef<T> {
  field: keyof T;
  label: string;
}

const COMPONENT_FIELDS: Array<FieldDef<Omit<ComponentSpec, 'snapshots'>>> = [
  { field: 'name', label: '名称' },
  { field: 'category', label: '分类' },
  { field: 'status', label: '状态' },
  { field: 'purpose', label: '用途' },
  { field: 'usage', label: '使用规则' },
  { field: 'states', label: '状态说明' },
  { field: 'keyboardBehavior', label: '键盘行为' },
  { field: 'screenReader', label: '读屏说明' },
  { field: 'disabledScenarios', label: '禁用场景' },
  { field: 'interactionSignature', label: '交互签名' }
];

const PROPERTY_FIELDS: Array<FieldDef<PropertySpec>> = [
  { field: 'name', label: '名称' },
  { field: 'type', label: '类型' },
  { field: 'required', label: '必填' },
  { field: 'defaultValue', label: '默认值' },
  { field: 'description', label: '说明' }
];

const EXAMPLE_FIELDS: Array<FieldDef<ComponentExample>> = [
  { field: 'title', label: '标题' },
  { field: 'code', label: '代码' },
  { field: 'propertyIds', label: '依赖属性' }
];

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** 深比较；数组按集合比较（propertyIds 等顺序无关）。 */
function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sa = [...a].map((v) => JSON.stringify(v)).sort();
    const sb = [...b].map((v) => JSON.stringify(v)).sort();
    return sa.every((v, i) => v === sb[i]);
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => isEqual(a[k], b[k]));
  }
  return false;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '（空）';
  if (Array.isArray(value)) return value.length ? value.join('、') : '（空）';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

export const stripSnapshots = (component: ComponentSpec): Omit<ComponentSpec, 'snapshots'> => {
  const { snapshots: _snapshots, ...rest } = component;
  return rest;
};

export const baseFromState = (state: WorkspaceState): NonNullable<WorkspaceState['base']> => ({
  components: state.components.map(stripSnapshots)
});

/** 校验 incoming 草稿结构；失败时合并中止，双方草稿保留。 */
function validateDraft(draft: unknown): { valid: boolean; error?: string } {
  if (!isObject(draft)) return { valid: false, error: '草稿不是有效的 JSON 对象。' };
  if (!Array.isArray(draft.components)) return { valid: false, error: '草稿缺少 components 数组。' };
  const seenCompIds = new Set<string>();
  for (const raw of draft.components as unknown[]) {
    if (!isObject(raw)) return { valid: false, error: '存在格式无效的组件。' };
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== 'string' || !c.id) return { valid: false, error: '组件缺少 id。' };
    if (seenCompIds.has(c.id)) return { valid: false, error: `组件 id「${c.id}」重复。` };
    seenCompIds.add(c.id);
    if (typeof c.name !== 'string') return { valid: false, error: `组件「${c.id}」缺少 name。` };
    if (!Array.isArray(c.properties)) return { valid: false, error: `组件「${c.id}」缺少 properties 数组。` };
    if (!Array.isArray(c.examples)) return { valid: false, error: `组件「${c.id}」缺少 examples 数组。` };
    const seenPropIds = new Set<string>();
    for (const p of c.properties as unknown[]) {
      if (!isObject(p)) return { valid: false, error: `组件「${c.id}」存在格式无效的属性。` };
      if (typeof p.id !== 'string' || !p.id) return { valid: false, error: `组件「${c.id}」的属性缺少 id。` };
      if (seenPropIds.has(p.id)) return { valid: false, error: `组件「${c.id}」的属性 id「${p.id}」重复。` };
      seenPropIds.add(p.id);
      if (typeof p.name !== 'string') return { valid: false, error: `组件「${c.id}」的属性「${p.id}」缺少 name。` };
    }
    const seenExIds = new Set<string>();
    for (const e of c.examples as unknown[]) {
      if (!isObject(e)) return { valid: false, error: `组件「${c.id}」存在格式无效的示例。` };
      if (typeof e.id !== 'string' || !e.id) return { valid: false, error: `组件「${c.id}」的示例缺少 id。` };
      if (seenExIds.has(e.id)) return { valid: false, error: `组件「${c.id}」的示例 id「${e.id}」重复。` };
      seenExIds.add(e.id);
      if (typeof e.title !== 'string') return { valid: false, error: `组件「${c.id}」的示例「${e.id}」缺少 title。` };
      if (typeof e.code !== 'string') return { valid: false, error: `组件「${c.id}」的示例「${e.id}」缺少 code。` };
      if (!Array.isArray(e.propertyIds)) return { valid: false, error: `组件「${c.id}」的示例「${e.id}」缺少 propertyIds 数组。` };
    }
  }
  return { valid: true };
}

type FieldMergeStatus = 'unchanged' | 'local' | 'incoming' | 'both' | 'conflict';

function mergeField(base: unknown, local: unknown, incoming: unknown): { value: unknown; status: FieldMergeStatus } {
  const baseExists = base !== undefined && base !== null;
  const localChanged = !baseExists || !isEqual(base, local);
  const incomingChanged = !baseExists || !isEqual(base, incoming);
  if (!localChanged && !incomingChanged) return { value: local, status: 'unchanged' };
  if (localChanged && !incomingChanged) return { value: local, status: 'local' };
  if (!localChanged && incomingChanged) return { value: incoming, status: 'incoming' };
  if (isEqual(local, incoming)) return { value: local, status: 'both' };
  return { value: null, status: 'conflict' };
}

interface ItemMergeOutcome<T> {
  item: T;
  conflicts: MergeConflict[];
  changes: MergeChange[];
}

function mergeProperty(
  base: PropertySpec | undefined,
  local: PropertySpec,
  incoming: PropertySpec,
  compId: string,
  compName: string
): ItemMergeOutcome<PropertySpec> {
  const item: PropertySpec = { ...local };
  const conflicts: MergeConflict[] = [];
  const changes: MergeChange[] = [];
  for (const { field, label } of PROPERTY_FIELDS) {
    const result = mergeField(base?.[field], local[field], incoming[field]);
    if (result.status === 'conflict') {
      conflicts.push({
        id: `prop-${compId}-${local.id}-${String(field)}`,
        kind: 'field',
        componentId: compId,
        componentName: compName,
        entityType: 'property',
        entityId: local.id,
        entityLabel: local.name,
        field: String(field),
        fieldLabel: label,
        baseValue: base?.[field],
        localValue: local[field],
        incomingValue: incoming[field]
      });
    } else if (result.status !== 'unchanged') {
      (item as unknown as Record<string, unknown>)[field] = result.value;
      changes.push({
        componentId: compId,
        componentName: compName,
        entityType: 'property',
        entityLabel: local.name,
        field: String(field),
        fieldLabel: label,
        source: result.status
      });
    }
  }
  return { item, conflicts, changes };
}

function mergeExample(
  base: ComponentExample | undefined,
  local: ComponentExample,
  incoming: ComponentExample,
  compId: string,
  compName: string
): ItemMergeOutcome<ComponentExample> {
  // stale / staleReason / createdFromRevision 属于派生元数据，合并后按契约重算。
  const item: ComponentExample = { ...local };
  const conflicts: MergeConflict[] = [];
  const changes: MergeChange[] = [];
  for (const { field, label } of EXAMPLE_FIELDS) {
    const result = mergeField(base?.[field], local[field], incoming[field]);
    if (result.status === 'conflict') {
      conflicts.push({
        id: `ex-${compId}-${local.id}-${String(field)}`,
        kind: 'field',
        componentId: compId,
        componentName: compName,
        entityType: 'example',
        entityId: local.id,
        entityLabel: local.title,
        field: String(field),
        fieldLabel: label,
        baseValue: base?.[field],
        localValue: local[field],
        incomingValue: incoming[field]
      });
    } else if (result.status !== 'unchanged') {
      (item as unknown as Record<string, unknown>)[field] = result.value;
      changes.push({
        componentId: compId,
        componentName: compName,
        entityType: 'example',
        entityLabel: local.title,
        field: String(field),
        fieldLabel: label,
        source: result.status
      });
    }
  }
  return { item, conflicts, changes };
}

interface CollectionMergeOutcome<T extends { id: string }> {
  items: T[];
  conflicts: MergeConflict[];
  changes: MergeChange[];
  deletedIds: string[];
}

function mergeCollection<T extends { id: string }>(
  baseItems: T[],
  localItems: T[],
  incomingItems: T[],
  entityType: 'property' | 'example',
  compId: string,
  compName: string,
  labelOf: (item: T) => string,
  mergeItem: (base: T | undefined, local: T, incoming: T, compId: string, compName: string) => ItemMergeOutcome<T>
): CollectionMergeOutcome<T> {
  const baseMap = new Map(baseItems.map((i) => [i.id, i]));
  const localMap = new Map(localItems.map((i) => [i.id, i]));
  const incomingMap = new Map(incomingItems.map((i) => [i.id, i]));
  const allIds = [...new Set([...baseMap.keys(), ...localMap.keys(), ...incomingMap.keys()])];

  const items: T[] = [];
  const conflicts: MergeConflict[] = [];
  const changes: MergeChange[] = [];
  const deletedIds: string[] = [];

  for (const id of allIds) {
    const base = baseMap.get(id);
    const local = localMap.get(id);
    const incoming = incomingMap.get(id);

    if (local && !incoming) {
      if (!base) {
        // local 新增。
        items.push(local);
        changes.push({ componentId: compId, componentName: compName, entityType, entityLabel: labelOf(local), field: '*', fieldLabel: '新增', source: 'local' });
      } else if (isEqual(base, local)) {
        // incoming 删除，local 未改动 → 采用删除。
        deletedIds.push(id);
      } else {
        // incoming 删除但 local 修改 → 冲突，保留 local 修改。
        items.push(local);
        conflicts.push({
          id: `${entityType}-${compId}-${id}-delete`,
          kind: 'delete',
          componentId: compId,
          componentName: compName,
          entityType,
          entityId: id,
          entityLabel: labelOf(local),
          field: '__delete__',
          fieldLabel: '删除',
          baseValue: labelOf(local),
          localValue: 'keep',
          incomingValue: 'delete'
        });
      }
    } else if (!local && incoming) {
      if (!base) {
        // incoming 新增。
        items.push(incoming);
        changes.push({ componentId: compId, componentName: compName, entityType, entityLabel: labelOf(incoming), field: '*', fieldLabel: '新增', source: 'incoming' });
      } else if (isEqual(base, incoming)) {
        // local 删除，incoming 未改动 → 采用删除。
        deletedIds.push(id);
      } else {
        // local 删除但 incoming 修改 → 冲突，保留 incoming 修改。
        items.push(incoming);
        conflicts.push({
          id: `${entityType}-${compId}-${id}-delete`,
          kind: 'delete',
          componentId: compId,
          componentName: compName,
          entityType,
          entityId: id,
          entityLabel: labelOf(incoming),
          field: '__delete__',
          fieldLabel: '删除',
          baseValue: labelOf(incoming),
          localValue: 'delete',
          incomingValue: 'keep'
        });
      }
    } else if (local && incoming) {
      const outcome = mergeItem(base, local, incoming, compId, compName);
      items.push(outcome.item);
      conflicts.push(...outcome.conflicts);
      changes.push(...outcome.changes);
    }
  }

  return { items, conflicts, changes, deletedIds };
}

function mergeComponent(
  base: Omit<ComponentSpec, 'snapshots'> | undefined,
  local: ComponentSpec,
  incoming: ComponentSpec
): ItemMergeOutcome<ComponentSpec> & { deletedPropertyIds: string[]; modifiedPropertyIds: string[]; deletedExampleIds: string[] } {
  const item: ComponentSpec = { ...local, properties: [], examples: [] };
  const conflicts: MergeConflict[] = [];
  const changes: MergeChange[] = [];

  for (const { field, label } of COMPONENT_FIELDS) {
    const result = mergeField(base?.[field], local[field], incoming[field]);
    if (result.status === 'conflict') {
      conflicts.push({
        id: `comp-${local.id}-${String(field)}`,
        kind: 'field',
        componentId: local.id,
        componentName: local.name,
        entityType: 'component',
        entityId: local.id,
        entityLabel: local.name,
        field: String(field),
        fieldLabel: label,
        baseValue: base?.[field],
        localValue: local[field],
        incomingValue: incoming[field]
      });
    } else if (result.status !== 'unchanged') {
      (item as unknown as Record<string, unknown>)[field] = result.value;
      changes.push({
        componentId: local.id,
        componentName: local.name,
        entityType: 'component',
        entityLabel: local.name,
        field: String(field),
        fieldLabel: label,
        source: result.status
      });
    }
  }

  const baseProps = base?.properties ?? [];
  const localProps = local.properties;
  const incomingProps = incoming.properties;
  const propOutcome = mergeCollection(
    baseProps, localProps, incomingProps, 'property', local.id, local.name,
    (p) => p.name,
    mergeProperty
  );
  item.properties = propOutcome.items;
  conflicts.push(...propOutcome.conflicts);
  changes.push(...propOutcome.changes);

  // 记录被删除/修改的属性，用于示例失效重算。
  const deletedPropertyIds = new Set(propOutcome.deletedIds);
  const modifiedPropertyIds = new Set<string>();
  for (const prop of propOutcome.items) {
    const b = baseProps.find((p) => p.id === prop.id);
    if (b && !isEqual(b, prop)) modifiedPropertyIds.add(prop.id);
  }
  // 冲突保留的属性也视为已修改（其取值待选定）。
  for (const c of propOutcome.conflicts) {
    if (c.entityType === 'property' && c.kind === 'field') modifiedPropertyIds.add(c.entityId);
  }

  const baseExamples = base?.examples ?? [];
  const localExamples = local.examples;
  const incomingExamples = incoming.examples;
  const exOutcome = mergeCollection(
    baseExamples, localExamples, incomingExamples, 'example', local.id, local.name,
    (e) => e.title,
    mergeExample
  );
  item.examples = exOutcome.items;
  conflicts.push(...exOutcome.conflicts);
  changes.push(...exOutcome.changes);

  return {
    item,
    conflicts,
    changes,
    deletedPropertyIds: [...deletedPropertyIds],
    modifiedPropertyIds: [...modifiedPropertyIds],
    deletedExampleIds: exOutcome.deletedIds
  };
}

/** 合并后重算示例失效状态：依赖的属性被删除或修改时，示例标记失效并清理失效引用。 */
function recomputeExampleStaleness(
  component: ComponentSpec,
  deletedPropertyIds: Set<string>,
  modifiedPropertyIds: Set<string>
): string[] {
  const invalidated: string[] = [];
  const activeIds = new Set(component.properties.map((p) => p.id));
  for (const example of component.examples) {
    const referenced = example.propertyIds;
    const deleted = referenced.filter((id) => deletedPropertyIds.has(id));
    const modified = referenced.filter((id) => modifiedPropertyIds.has(id));
    // 代码中引用了已删除属性名也标记失效（与既有 removeProperty 行为一致）。
    const codeReferencesDeleted = component.properties.some((p) => deletedPropertyIds.has(p.id) && example.code.includes(p.name));

    if (deleted.length || modified.length || codeReferencesDeleted) {
      example.stale = true;
      if (deleted.length) {
        const names = deleted.map((id) => component.properties.find((p) => p.id === id)?.name ?? id).join('、');
        example.staleReason = `引用的属性 ${names} 已删除，请更新示例代码与依赖。`;
      } else if (modified.length) {
        const names = modified.map((id) => component.properties.find((p) => p.id === id)?.name ?? id).join('、');
        example.staleReason = `依赖的属性 ${names} 已修改，请重新核对示例。`;
      } else {
        example.staleReason = '示例代码引用了已删除的属性，请更新。';
      }
      // 重算：清理已删除的依赖引用。
      example.propertyIds = referenced.filter((id) => activeIds.has(id));
      invalidated.push(example.id);
    }
  }
  return invalidated;
}

export function mergeDrafts(local: WorkspaceState, incoming: WorkspaceState): MergeResult {
  const validation = validateDraft(incoming);
  if (!validation.valid) {
    return {
      ok: false,
      error: validation.error,
      merged: structuredClone(local),
      conflicts: [],
      changes: [],
      invalidatedExamples: []
    };
  }

  const baseComponents = local.base?.components ?? [];
  const baseMap = new Map(baseComponents.map((c) => [c.id, c] as const));
  const localMap = new Map(local.components.map((c) => [c.id, c] as const));
  const incomingMap = new Map((incoming.components as ComponentSpec[]).map((c) => [c.id, c] as const));
  const allCompIds = [...new Set([...baseMap.keys(), ...localMap.keys(), ...incomingMap.keys()])];

  const conflicts: MergeConflict[] = [];
  const changes: MergeChange[] = [];
  const invalidatedExamples: string[] = [];
  const mergedComponents: ComponentSpec[] = [];

  for (const compId of allCompIds) {
    const base = baseMap.get(compId);
    const localComp = localMap.get(compId);
    const incomingComp = incomingMap.get(compId);

    if (localComp && !incomingComp) {
      if (!base) {
        mergedComponents.push(localComp);
        changes.push({ componentId: compId, componentName: localComp.name, entityType: 'component', entityLabel: localComp.name, field: '*', fieldLabel: '新增组件', source: 'local' });
      } else if (isEqual(base, stripSnapshots(localComp))) {
        // incoming 删除组件，local 未改动 → 采用删除。
      } else {
        // incoming 删除但 local 修改 → 冲突，保留 local。
        mergedComponents.push(localComp);
        conflicts.push({
          id: `comp-${compId}-delete`,
          kind: 'delete',
          componentId: compId,
          componentName: localComp.name,
          entityType: 'component',
          entityId: compId,
          entityLabel: localComp.name,
          field: '__delete__',
          fieldLabel: '删除组件',
          baseValue: localComp.name,
          localValue: 'keep',
          incomingValue: 'delete'
        });
      }
    } else if (!localComp && incomingComp) {
      if (!base) {
        mergedComponents.push(incomingComp);
        changes.push({ componentId: compId, componentName: incomingComp.name, entityType: 'component', entityLabel: incomingComp.name, field: '*', fieldLabel: '新增组件', source: 'incoming' });
      } else if (isEqual(base, stripSnapshots(incomingComp))) {
        // local 删除，incoming 未改动 → 采用删除。
      } else {
        // local 删除但 incoming 修改 → 冲突，保留 incoming。
        mergedComponents.push(incomingComp);
        conflicts.push({
          id: `comp-${compId}-delete`,
          kind: 'delete',
          componentId: compId,
          componentName: incomingComp.name,
          entityType: 'component',
          entityId: compId,
          entityLabel: incomingComp.name,
          field: '__delete__',
          fieldLabel: '删除组件',
          baseValue: incomingComp.name,
          localValue: 'delete',
          incomingValue: 'keep'
        });
      }
    } else if (localComp && incomingComp) {
      const outcome = mergeComponent(base, localComp, incomingComp);
      // 合并快照：保留双方历史，按 revision 去重（local 优先），取最近 12 条。
      const snapByRev = new Map<number, ComponentSpec['snapshots'][number]>();
      for (const snap of outcome.item.snapshots) snapByRev.set(snap.revision, snap);
      for (const snap of localComp.snapshots) if (!snapByRev.has(snap.revision)) snapByRev.set(snap.revision, snap);
      for (const snap of incomingComp.snapshots) if (!snapByRev.has(snap.revision)) snapByRev.set(snap.revision, snap);
      outcome.item.snapshots = [...snapByRev.values()].sort((a, b) => b.revision - a.revision).slice(0, 12);

      const invalidated = recomputeExampleStaleness(outcome.item, new Set(outcome.deletedPropertyIds), new Set(outcome.modifiedPropertyIds));
      invalidatedExamples.push(...invalidated);
      mergedComponents.push(outcome.item);
      conflicts.push(...outcome.conflicts);
      changes.push(...outcome.changes);
    }
  }

  // 保持 local 的目录顺序，追加 incoming 新增的组件。
  const localOrder = local.components.map((c) => c.id);
  mergedComponents.sort((a, b) => {
    const ai = localOrder.indexOf(a.id);
    const bi = localOrder.indexOf(b.id);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  const merged: WorkspaceState = {
    components: mergedComponents,
    selectedId: local.selectedId && mergedComponents.some((c) => c.id === local.selectedId)
      ? local.selectedId
      : mergedComponents[0]?.id ?? '',
    base: local.base
  };

  return { ok: true, merged, conflicts, changes, invalidatedExamples };
}

/** 应用用户选定的冲突取值，生成最终工作区。 */
export function resolveMerge(result: MergeResult, resolution: ConflictResolution): WorkspaceState {
  const merged = structuredClone(result.merged);
  for (const conflict of result.conflicts) {
    const selected = resolution[conflict.id] ?? 'local';
    if (conflict.kind === 'field') {
      const value = selected === 'local' ? conflict.localValue : conflict.incomingValue;
      if (conflict.entityType === 'component') {
        const target = merged.components.find((c) => c.id === conflict.entityId);
        if (target) (target as unknown as Record<string, unknown>)[conflict.field] = value;
      } else if (conflict.entityType === 'property') {
        for (const comp of merged.components) {
          const prop = comp.properties.find((p) => p.id === conflict.entityId);
          if (prop) {
            (prop as unknown as Record<string, unknown>)[conflict.field] = value;
            // 属性取值选定后，依赖它的示例需重新核对。
            recomputeExampleStaleness(comp, new Set(), new Set([prop.id]));
            break;
          }
        }
      } else if (conflict.entityType === 'example') {
        for (const comp of merged.components) {
          const example = comp.examples.find((e) => e.id === conflict.entityId);
          if (example) {
            (example as unknown as Record<string, unknown>)[conflict.field] = value;
            break;
          }
        }
      }
    } else if (conflict.kind === 'delete') {
      const shouldDelete = selected === 'incoming';
      if (conflict.entityType === 'component') {
        if (shouldDelete) {
          merged.components = merged.components.filter((c) => c.id === conflict.entityId);
        }
      } else if (conflict.entityType === 'property') {
        if (shouldDelete) {
          for (const comp of merged.components) {
            const before = comp.properties.length;
            comp.properties = comp.properties.filter((p) => p.id === conflict.entityId);
            if (comp.properties.length !== before) {
              recomputeExampleStaleness(comp, new Set([conflict.entityId]), new Set());
            }
          }
        }
      } else if (conflict.entityType === 'example') {
        if (shouldDelete) {
          for (const comp of merged.components) {
            if (comp.examples.some((e) => e.id === conflict.entityId)) {
              comp.examples = comp.examples.filter((e) => e.id !== conflict.entityId);
              break;
            }
          }
        }
      }
    }
  }
  if (merged.selectedId && !merged.components.some((c) => c.id === merged.selectedId)) {
    merged.selectedId = merged.components[0]?.id ?? '';
  }
  return merged;
}

export { formatValue };
