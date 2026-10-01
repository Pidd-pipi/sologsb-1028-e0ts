import type {
  ComponentExample,
  ComponentSpec,
  MergeChangeNote,
  MergeConflict,
  MergeReport,
  MergeSide,
  PropertySpec,
  SpecBundle,
  WorkspaceState
} from './types';

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export const COMPONENT_SCALAR_FIELDS = [
  'name',
  'category',
  'status',
  'purpose',
  'usage',
  'states',
  'keyboardBehavior',
  'screenReader',
  'disabledScenarios',
  'interactionSignature'
] as const;

export const PROPERTY_VALUE_FIELDS = ['name', 'type', 'required', 'defaultValue', 'description'] as const;

export const EXAMPLE_VALUE_FIELDS = ['title', 'code'] as const;

const MERGE_STALE_PREFIX = '合并后属性契约变化：';

/**
 * 属性关键字段指纹：名称、类型、必填与默认值变化都可能让依赖示例失去依据。
 * description 属于解释性文字，变化不让示例失效。
 */
export function propertyFingerprint(property: PropertySpec): string {
  return [property.name, property.type, property.required ? '1' : '0', property.defaultValue].join('');
}

interface MergeAccumulator {
  conflicts: MergeConflict[];
  changes: MergeChangeNote[];
  baseFoundFor: string[];
  baseMissingFor: string[];
}

/** 三方标量合并：都没改→基线；只一边改→自动接上；两边改成不同值→冲突 */
function mergeScalar<T>(base: T, local: T, incoming: T): { value: T; conflict: boolean } {
  const localChanged = local !== base;
  const incomingChanged = incoming !== base;
  if (!localChanged && !incomingChanged) return { value: local, conflict: false };
  if (localChanged && !incomingChanged) return { value: local, conflict: false };
  if (!localChanged && incomingChanged) return { value: incoming, conflict: false };
  return { value: local, conflict: local !== incoming };
}

function pushConflict(acc: MergeAccumulator, conflict: Omit<MergeConflict, 'id' | 'chosen'>): MergeConflict {
  const created: MergeConflict = { ...conflict, id: uid('conflict'), chosen: null };
  acc.conflicts.push(created);
  return created;
}

function pushChange(acc: MergeAccumulator, level: MergeChangeNote['level'], message: string) {
  acc.changes.push({ id: uid('change'), level, message });
}

/* ------------------------------- 属性三方合并 ------------------------------ */

function mergeProperty(
  base: PropertySpec | undefined,
  local: PropertySpec | undefined,
  incoming: PropertySpec | undefined,
  componentId: string,
  acc: MergeAccumulator
): PropertySpec | null {
  const itemId = (local ?? incoming ?? base)!.id;

  // 无基线：两边都新增同编号属性 → 字段级并列冲突；只有一边 → 直接接入
  if (!base) {
    if (local && incoming) {
      const merged = clone(local);
      for (const field of PROPERTY_VALUE_FIELDS) {
        if (local[field] !== incoming[field]) {
          pushConflict(acc, {
            componentId,
            itemId,
            target: 'property',
            kind: 'added-both',
            field,
            label: `双方都新增了属性 ${local.name}，${FIELD_LABELS[field]}不一致`,
            localLabel: '本机稿',
            incomingLabel: '带回稿',
            localValue: formatValue(local[field]),
            incomingValue: formatValue(incoming[field]),
            localRaw: local[field],
            incomingRaw: incoming[field]
          });
        }
      }
      return merged;
    }
    const winner = local ?? incoming;
    pushChange(acc, 'auto', `自动接入新增属性 ${winner!.name}。`);
    return clone(winner!);
  }

  // 一边删除、另一边修改 → 结构冲突，双方结果都保留在冲突面板里
  if (!local || !incoming) {
    pushConflict(acc, {
      componentId,
      itemId,
      target: 'property',
      kind: 'deleted-modified',
      field: '',
      label: `属性 ${base.name}：${local ? '带回稿删除、本机稿修改' : '本机稿删除、带回稿修改'}`,
      localLabel: '本机稿',
      incomingLabel: '带回稿',
      localValue: local ? formatProperty(local) : '（已删除）',
      incomingValue: incoming ? formatProperty(incoming) : '（已删除）',
      localRaw: local ?? null,
      incomingRaw: incoming ?? null
    });
    const survivor = local ?? incoming;
    return survivor ? clone(survivor) : null;
  }

  const merged = clone(base);
  for (const field of PROPERTY_VALUE_FIELDS) {
    const result = mergeScalar(base[field], local[field], incoming[field]);
    if (result.conflict) {
      pushConflict(acc, {
        componentId,
        itemId,
        target: 'property',
        kind: 'both-modified',
        field,
        label: `属性 ${base.name} 的${FIELD_LABELS[field]}出现两套值`,
        localLabel: '本机稿',
        incomingLabel: '带回稿',
        localValue: formatValue(local[field]),
        incomingValue: formatValue(incoming[field]),
        localRaw: local[field],
        incomingRaw: incoming[field]
      });
    }
    (merged[field] as unknown) = result.value;
  }
  return merged;
}

/* ------------------------------- 示例三方合并 ------------------------------ */

/**
 * 依赖属性集合三方协调：
 * - 两边都保留 → 保留；两边都删除 → 删除
 * - 基线中存在、只有一边删除 → 跟随显式删除（另一边是未改动）
 * - 基线中不存在、只有一边新增 → 并入（新增是显式意图）
 */
function reconcilePropertyReferences(base: string[], local: string[], incoming: string[]): string[] {
  const result: string[] = [];
  for (const id of new Set([...base, ...local, ...incoming])) {
    const inBase = base.includes(id);
    const inLocal = local.includes(id);
    const inIncoming = incoming.includes(id);
    if (inLocal && inIncoming) result.push(id);
    else if (!inLocal && !inIncoming) continue;
    else if (inBase) continue;
    else result.push(id);
  }
  return result;
}

function mergeExample(
  base: ComponentExample | undefined,
  local: ComponentExample | undefined,
  incoming: ComponentExample | undefined,
  componentId: string,
  acc: MergeAccumulator
): ComponentExample | null {
  const itemId = (local ?? incoming ?? base)!.id;

  if (!base) {
    if (local && incoming) {
      const merged = clone(local);
      for (const field of EXAMPLE_VALUE_FIELDS) {
        if (local[field] !== incoming[field]) {
          pushConflict(acc, {
            componentId,
            itemId,
            target: 'example',
            kind: 'added-both',
            field,
            label: `双方都新增了示例「${local.title}」，${FIELD_LABELS[field]}不一致`,
            localLabel: '本机稿',
            incomingLabel: '带回稿',
            localValue: formatValue(local[field]),
            incomingValue: formatValue(incoming[field]),
            localRaw: local[field],
            incomingRaw: incoming[field]
          });
        }
      }
      merged.propertyIds = reconcilePropertyReferences([], local.propertyIds, incoming.propertyIds);
      return merged;
    }
    const winner = local ?? incoming;
    pushChange(acc, 'auto', `自动接入新增示例「${winner!.title}」。`);
    return clone(winner!);
  }

  if (!local || !incoming) {
    pushConflict(acc, {
      componentId,
      itemId,
      target: 'example',
      kind: 'deleted-modified',
      field: '',
      label: `示例「${base.title}」：${local ? '带回稿删除、本机稿修改' : '本机稿删除、带回稿修改'}`,
      localLabel: '本机稿',
      incomingLabel: '带回稿',
      localValue: local ? formatExample(local) : '（已删除）',
      incomingValue: incoming ? formatExample(incoming) : '（已删除）',
      localRaw: local ?? null,
      incomingRaw: incoming ?? null
    });
    const survivor = local ?? incoming;
    return survivor ? clone(survivor) : null;
  }

  const merged = clone(base);
  for (const field of EXAMPLE_VALUE_FIELDS) {
    const result = mergeScalar(base[field], local[field], incoming[field]);
    if (result.conflict) {
      pushConflict(acc, {
        componentId,
        itemId,
        target: 'example',
        kind: 'both-modified',
        field,
        label: `示例「${base.title}」的${FIELD_LABELS[field]}出现两套值`,
        localLabel: '本机稿',
        incomingLabel: '带回稿',
        localValue: formatValue(local[field]),
        incomingValue: formatValue(incoming[field]),
        localRaw: local[field],
        incomingRaw: incoming[field]
      });
    }
    (merged[field] as unknown) = result.value;
  }
  merged.propertyIds = reconcilePropertyReferences(base.propertyIds, local.propertyIds, incoming.propertyIds);
  merged.stale = local.stale || incoming.stale;
  merged.staleReason = [local.staleReason, incoming.staleReason].filter(Boolean).join('；');
  merged.createdFromRevision = Math.min(local.createdFromRevision, incoming.createdFromRevision);
  return merged;
}

// 新增项没有基线时，依赖集合按“双方并集”处理（reconcilePropertyReferences 传空基线）

/* ------------------------------- 组件三方合并 ------------------------------ */

function mergeComponent(
  base: ComponentSpec | undefined,
  local: ComponentSpec | undefined,
  incoming: ComponentSpec | undefined,
  acc: MergeAccumulator
): ComponentSpec | null {
  if (!local && !incoming) return null;

  // 双方都带、但找不到共同基线：无法判断改动归属，整体保留双方结果
  if (!base) {
    if (local && incoming) {
      acc.baseMissingFor.push(local.id);
      pushConflict(acc, {
        componentId: local.id,
        itemId: local.id,
        target: 'component',
        kind: 'both-modified',
        field: '',
        label: `组件 ${local.name}：双方都有但找不到共同基线`,
        localLabel: '本机稿',
        incomingLabel: '带回稿',
        localValue: formatComponentSummary(local),
        incomingValue: formatComponentSummary(incoming),
        localRaw: local,
        incomingRaw: incoming
      });
      return clone(local);
    }
    const winner = local ?? incoming;
    pushChange(acc, 'auto', `自动接入${local ? '本机' : '带回'}组件 ${winner!.name}。`);
    return clone(winner!);
  }

  // 注意：组件只存在于一方时在 buildMergeReport 中直接保留，不会走到这里的删除分支
  if (!local || !incoming) {
    const survivor = local ?? incoming;
    return survivor ? clone(survivor) : null;
  }

  acc.baseFoundFor.push(base.id);
  const merged = clone(base);

  for (const field of COMPONENT_SCALAR_FIELDS) {
    const result = mergeScalar(base[field], local[field], incoming[field]);
    if (result.conflict) {
      pushConflict(acc, {
        componentId: base.id,
        itemId: base.id,
        target: 'component',
        kind: 'both-modified',
        field,
        label: `组件 ${base.name} 的${FIELD_LABELS[field]}出现两套值`,
        localLabel: '本机稿',
        incomingLabel: '带回稿',
        localValue: formatValue(local[field]),
        incomingValue: formatValue(incoming[field]),
        localRaw: local[field],
        incomingRaw: incoming[field]
      });
    }
    (merged[field] as unknown) = result.value;
  }

  merged.properties = mergeIndexed(base.properties, local.properties, incoming.properties, base.id, acc, mergeProperty);
  merged.examples = mergeIndexed(base.examples, local.examples, incoming.examples, base.id, acc, mergeExample);

  merged.revision = Math.max(base.revision, local.revision, incoming.revision);
  merged.updatedAt = newestIso(local.updatedAt, incoming.updatedAt);
  merged.snapshots = mergeSnapshots(base, local, incoming);

  // 属性改动后，依赖它的示例失效重算
  recomputeExampleStaleness(merged, base, local, incoming, acc);

  return merged;
}

function mergeIndexed<T extends { id: string }>(
  baseItems: T[],
  localItems: T[],
  incomingItems: T[],
  componentId: string,
  acc: MergeAccumulator,
  itemMerger: (base: T | undefined, local: T | undefined, incoming: T | undefined, componentId: string, acc: MergeAccumulator) => T | null
): T[] {
  const ids = new Set([...baseItems, ...localItems, ...incomingItems].map((item) => item.id));
  const byId = (items: T[]) => new Map(items.map((item) => [item.id, item]));
  const baseMap = byId(baseItems);
  const localMap = byId(localItems);
  const incomingMap = byId(incomingItems);
  const merged: T[] = [];
  for (const id of ids) {
    const result = itemMerger(baseMap.get(id), localMap.get(id), incomingMap.get(id), componentId, acc);
    if (result) merged.push(result);
  }
  // 顺序沿用本机稿，新增项追加到尾部
  const localOrder = localItems.map((item) => item.id);
  merged.sort((a, b) => {
    const ai = localOrder.indexOf(a.id);
    const bi = localOrder.indexOf(b.id);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return merged;
}

function newestIso(a: string, b: string): string {
  return [a, b].sort().reverse()[0] ?? new Date().toISOString();
}

function mergeSnapshots(base: ComponentSpec, local: ComponentSpec, incoming: ComponentSpec): ComponentSpec['snapshots'] {
  const seen = new Map<number, ComponentSpec['snapshots'][number]>();
  for (const snapshot of [...local.snapshots, ...incoming.snapshots, ...base.snapshots]) {
    if (!seen.has(snapshot.revision)) seen.set(snapshot.revision, snapshot);
  }
  return [...seen.values()].sort((a, b) => b.revision - a.revision).slice(0, 12);
}

/**
 * 失效重算：以基线属性指纹为准，合并后只要依赖属性的关键字段发生变化
 * （或依赖属性已不存在），示例就失效；示例代码被任一方有意改写时，
 * 不再按属性名内联规则叠加失效。
 * rerun 模式用于冲突改选后重算：此时 local/incoming 不可得，以稿面现值为“双方原稿状态”。
 */
function recomputeExampleStaleness(
  component: ComponentSpec,
  base: ComponentSpec,
  local: ComponentSpec,
  incoming: ComponentSpec,
  acc: MergeAccumulator,
  rerun = false
) {
  const baseProperties = new Map(base.properties.map((property) => [property.id, property]));
  const activeIds = new Set(component.properties.map((property) => property.id));

  for (const example of component.examples) {
    const baseExample = base.examples.find((item) => item.id === example.id);
    const localExample = rerun ? undefined : local.examples.find((item) => item.id === example.id);
    const incomingExample = rerun ? undefined : incoming.examples.find((item) => item.id === example.id);

    let sideStale: boolean;
    let sideReasons: string[];
    if (rerun) {
      const mergeMarked = example.staleReason.startsWith(MERGE_STALE_PREFIX);
      sideStale = example.stale && !mergeMarked;
      sideReasons = mergeMarked ? [] : example.staleReason ? [example.staleReason] : [];
    } else {
      sideStale = (localExample?.stale ?? false) || (incomingExample?.stale ?? false);
      sideReasons = [localExample?.staleReason, incomingExample?.staleReason].filter(Boolean) as string[];
    }

    const codeRewritten = rerun
      ? !!baseExample && example.code !== baseExample.code
      : !!baseExample && (localExample?.code !== baseExample.code || incomingExample?.code !== baseExample.code);

    const reasons = new Set<string>();
    // rerun 模式（冲突改选后）当前引用可能已被结构调整过滤掉，
    // 需把基线里的依赖也纳入检测，才能识别“依赖属性被删除”
    const candidateRefs = rerun && baseExample
      ? [...new Set([...example.propertyIds, ...baseExample.propertyIds])]
      : example.propertyIds;
    for (const propertyId of candidateRefs) {
      if (!activeIds.has(propertyId)) {
        reasons.add(`依赖属性 ${propertyId} 在合并后已不存在`);
        continue;
      }
      const before = baseProperties.get(propertyId);
      const after = component.properties.find((property) => property.id === propertyId);
      if (before && after && propertyFingerprint(before) !== propertyFingerprint(after)) {
        reasons.add(`依赖属性 ${after.name} 的名称/类型/必填/默认值已变化`);
      }
    }
    // 同步清理指向已删除属性的引用
    const validRefs = example.propertyIds.filter((id) => activeIds.has(id));
    if (validRefs.length !== example.propertyIds.length) example.propertyIds = validRefs;
    if (!codeRewritten) {
      for (const property of component.properties) {
        const before = baseProperties.get(property.id);
        if (before && propertyFingerprint(before) !== propertyFingerprint(property) && example.code.includes(property.name)) {
          reasons.add(`代码内联引用了已变化的属性 ${property.name}`);
        }
      }
    }

    if (reasons.size) {
      example.stale = true;
      example.staleReason = MERGE_STALE_PREFIX + [...reasons].join('；');
      if (!rerun) pushChange(acc, 'stale', `示例「${example.title || example.id}」依赖的属性已变化，标记为待重算。`);
    } else if (example.staleReason.startsWith(MERGE_STALE_PREFIX)) {
      // 冲突改选后契约不再变化：撤掉合并器加的失效标记，恢复双方原稿状态
      example.stale = sideStale;
      example.staleReason = sideReasons.join('；');
    }
  }
}

/* -------------------------------- 报告与入口 ------------------------------- */

function findBaseComponent(
  componentId: string,
  local: ComponentSpec | undefined,
  incoming: ComponentSpec | undefined,
  bundledBases: Map<string, ComponentSpec>
): ComponentSpec | undefined {
  // 1. 双方快照里共同的修订版（离线前的最近同步点）
  const localRevisions = new Map((local?.snapshots ?? []).map((snapshot) => [snapshot.revision, snapshot]));
  for (const snapshot of incoming?.snapshots ?? []) {
    const common = localRevisions.get(snapshot.revision);
    if (common) return { ...clone(common.component), snapshots: [] };
  }
  // 2. 内置出厂稿
  return bundledBases.get(componentId);
}

/**
 * 双方各自新增了编号不同但名称相同的属性（或示例标题相同）时，
 * 稳定编号无法消歧——报为结构冲突，让维护者决定保留哪一方。
 * 基线中已存在的同名重复不在合并阶段处理（校验面板负责）。
 */
function detectDuplicateNames(
  merged: ComponentSpec,
  local: ComponentSpec | undefined,
  incoming: ComponentSpec | undefined,
  acc: MergeAccumulator
) {
  if (!local || !incoming) return;
  const localPropertyIds = new Set(local.properties.map((property) => property.id));
  const incomingPropertyIds = new Set(incoming.properties.map((property) => property.id));

  for (const localProperty of local.properties) {
    if (incomingPropertyIds.has(localProperty.id)) continue;
    const twin = incoming.properties.find(
      (property) => !localPropertyIds.has(property.id) && property.name.trim() === localProperty.name.trim()
    );
    if (twin) {
      pushConflict(acc, {
        componentId: merged.id,
        itemId: localProperty.id,
        target: 'property',
        kind: 'added-both',
        field: '',
        label: `双方各自新增了同名属性 ${localProperty.name}（编号不同）`,
        localLabel: `本机稿 ${localProperty.id}`,
        incomingLabel: `带回稿 ${twin.id}`,
        localValue: formatProperty(localProperty),
        incomingValue: formatProperty(twin),
        localRaw: localProperty,
        incomingRaw: twin,
        otherItemId: twin.id
      });
      // incoming 侧的 otherItemId 在 resolveConflict 中按 chosen 动态计算
    }
  }
}

export function validateBundle(input: unknown): { ok: true; bundle: SpecBundle } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: '文件不是合法的稿包对象。' };
  const candidate = input as Partial<SpecBundle>;
  if (candidate.app !== 'sologsb-1028') return { ok: false, error: '缺少 sologsb-1028 稿包标记（app 字段）。' };
  if (typeof candidate.exportedAt !== 'string') return { ok: false, error: '稿包缺少 exportedAt。' };
  if (!Array.isArray(candidate.components)) return { ok: false, error: '稿包中没有 components 数组。' };
  for (const component of candidate.components) {
    if (!component || typeof component.id !== 'string' || !Array.isArray(component.properties) || !Array.isArray(component.examples)) {
      return { ok: false, error: `组件 ${component?.id ?? '(无稳定编号)'} 结构不完整。` };
    }
  }
  return { ok: true, bundle: clone(candidate as SpecBundle) };
}

export function buildMergeReport(state: WorkspaceState, incoming: SpecBundle, bundledBases: Map<string, ComponentSpec>): MergeReport {
  const acc: MergeAccumulator = { conflicts: [], changes: [], baseFoundFor: [], baseMissingFor: [] };
  const localMap = new Map(state.components.map((component) => [component.id, component]));
  const incomingMap = new Map(incoming.components.map((component) => [component.id, component]));

  // 输出顺序：本机稿顺序优先，带回稿独有的组件追加
  const orderedIds = [
    ...state.components.map((component) => component.id),
    ...incoming.components.map((component) => component.id).filter((id) => !localMap.has(id))
  ];

  const mergedComponents: ComponentSpec[] = [];
  const addedComponentIds: string[] = [];

  for (const id of orderedIds) {
    const local = localMap.get(id);
    const incomingComponent = incomingMap.get(id);

    // 稿包是某个时间点的整包：一边缺失只代表它脱网更早，不代表删除
    if (local && !incomingComponent) {
      mergedComponents.push(clone(local));
      continue;
    }
    if (!local && incomingComponent) {
      mergedComponents.push(clone(incomingComponent));
      addedComponentIds.push(id);
      pushChange(acc, 'auto', `接入带回稿独有的组件 ${incomingComponent.name}。`);
      continue;
    }

    const base = findBaseComponent(id, local, incomingComponent, bundledBases);
    const merged = mergeComponent(base, local, incomingComponent, acc);
    if (merged) {
      detectDuplicateNames(merged, local, incomingComponent, acc);
      mergedComponents.push(merged);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    baseFoundFor: [...new Set(acc.baseFoundFor)],
    baseMissingFor: [...new Set(acc.baseMissingFor)],
    merged: { components: mergedComponents, selectedId: state.selectedId },
    conflicts: acc.conflicts,
    changes: acc.changes,
    addedComponentIds: [...new Set(addedComponentIds)]
  };
}

/**
 * 记录维护者对某条冲突的选择，返回新的报告（不可变）。
 * 选定完成前由 UI 层保证不写入正式规范。
 */
export function resolveConflict(
  report: MergeReport,
  conflictIdValue: string,
  side: MergeSide,
  bundledBases: Map<string, ComponentSpec>
): MergeReport {
  const next = clone(report);
  const conflict = next.conflicts.find((item) => item.id === conflictIdValue);
  if (!conflict) return next;
  conflict.chosen = side;

  const component = next.merged.components.find((item) => item.id === conflict.componentId);
  if (!component) return next;
  const raw = side === 'local' ? conflict.localRaw : conflict.incomingRaw;

  if (conflict.target === 'component') {
    if (conflict.field) {
      (component as unknown as Record<string, unknown>)[conflict.field] = raw;
    } else if (raw === null) {
      next.merged.components = next.merged.components.filter((item) => item.id !== component.id);
    } else {
      const snapshots = component.snapshots;
      Object.assign(component, clone(raw as ComponentSpec), { snapshots });
    }
  } else if (conflict.target === 'property') {
    // 同名异编号冲突：选定一方后剔除落选方（在通用分支之前处理）
    if (conflict.otherItemId) {
      const winnerId = side === 'local' ? conflict.itemId : conflict.otherItemId;
      const loserId = side === 'local' ? conflict.otherItemId : conflict.itemId;
      component.properties = component.properties.filter((item) => item.id !== loserId);
      void winnerId;
      restructureExamples(component);
      rerunStaleness(component, bundledBases, next);
      return next;
    }
    const property = component.properties.find((item) => item.id === conflict.itemId);
    if (conflict.field && property) {
      (property as unknown as Record<string, unknown>)[conflict.field] = raw;
    } else if (raw === null) {
      component.properties = component.properties.filter((item) => item.id !== conflict.itemId);
    } else if (!property) {
      component.properties.push(clone(raw as PropertySpec));
    }
    restructureExamples(component);
    rerunStaleness(component, bundledBases, next);
  } else if (conflict.target === 'example') {
    const example = component.examples.find((item) => item.id === conflict.itemId);
    if (conflict.field && example) {
      (example as unknown as Record<string, unknown>)[conflict.field] = raw;
    } else if (raw === null) {
      component.examples = component.examples.filter((item) => item.id !== conflict.itemId);
    } else if (!example) {
      component.examples.push(clone(raw as ComponentExample));
    }
  }

  return next;
}

/** 结构型冲突改选后，重新过滤指向已删除属性的示例依赖 */
function restructureExamples(component: ComponentSpec) {
  const activeIds = new Set(component.properties.map((property) => property.id));
  for (const example of component.examples) {
    const filtered = example.propertyIds.filter((id) => activeIds.has(id));
    if (filtered.length !== example.propertyIds.length) {
      example.propertyIds = filtered;
      example.stale = true;
      example.staleReason = `${MERGE_STALE_PREFIX}依赖属性在冲突选择后被删除`;
    }
  }
}

/** 冲突改选后用出厂基线重新跑一次失效重算（无基线则跳过） */
function rerunStaleness(component: ComponentSpec, bundledBases: Map<string, ComponentSpec>, report: MergeReport) {
  const base = bundledBases.get(component.id);
  if (!base) return;
  const acc: MergeAccumulator = { conflicts: report.conflicts, changes: report.changes, baseFoundFor: [], baseMissingFor: [] };
  recomputeExampleStaleness(component, base, component, component, acc, true);
}

export function allConflictsResolved(report: MergeReport): boolean {
  return report.conflicts.every((conflict) => conflict.chosen !== null);
}

export function unresolvedCount(report: MergeReport): number {
  return report.conflicts.filter((conflict) => conflict.chosen === null).length;
}

export function bundleFromState(state: WorkspaceState): SpecBundle {
  return {
    app: 'sologsb-1028',
    exportedAt: new Date().toISOString(),
    components: clone(state.components)
  };
}

/* ---------------------------------- 展示 ---------------------------------- */

function formatValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? '是（true）' : '否（false）';
  return String(value ?? '');
}

function formatProperty(property: PropertySpec): string {
  return `${property.name}: ${property.type}${property.required ? '（必填）' : ''} = ${property.defaultValue || '∅'}\n${property.description}`;
}

function formatExample(example: ComponentExample): string {
  return `「${example.title}」\n${example.code}`;
}

function formatComponentSummary(component: ComponentSpec): string {
  return `${component.name}（${component.category}）\n${component.purpose}\n属性 ${component.properties.length} 项 · 示例 ${component.examples.length} 个`;
}

export const FIELD_LABELS: Record<string, string> = {
  name: '名称',
  category: '分类',
  status: '状态',
  purpose: '用途',
  usage: '使用规则',
  states: '状态说明',
  keyboardBehavior: '键盘行为',
  screenReader: '读屏说明',
  disabledScenarios: '禁用场景',
  interactionSignature: '交互签名',
  type: '类型',
  required: '必填',
  defaultValue: '默认值',
  description: '说明',
  title: '标题',
  code: '代码'
};
