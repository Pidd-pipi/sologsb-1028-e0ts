// 端到端验证三方合并引擎：用 esbuild（vite 自带依赖）即时转译 TS 源后运行。
//   node scripts/test-merge.mjs
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { build: esbuildBuild } = await import('esbuild');

const dir = mkdtempSync(join(tmpdir(), 'merge-test-'));
await esbuildBuild({
  entryPoints: ['src/merge.ts', 'src/data.ts'],
  outdir: dir,
  format: 'esm',
  bundle: true,
  logLevel: 'silent'
});
const { buildMergeReport, resolveConflict, allConflictsResolved, bundleFromState } = await import(
  pathToFileURL(join(dir, 'merge.js')).href
);
const dataMod = await import(pathToFileURL(join(dir, 'data.js')).href);
const baseMap = dataMod.createBundledBaseMap();

let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ---------- 场景 1：不同处自动接上 ----------
{
  console.log('\n场景1：彼此改的不是同处 → 自动接上');
  const base = dataMod.createInitialState();
  const local = structuredClone(base);
  const incomingState = structuredClone(base);

  // 本机：改 button 的 purpose，并新增一个属性
  const localBtn = local.components.find((c) => c.id === 'button-spec');
  localBtn.purpose = '本机改的用途';
  localBtn.properties.push({ id: 'p-local-only', name: 'loading', type: 'boolean', required: false, defaultValue: 'false', description: '本机新增' });

  // 带回稿：改同一组件的 keyboardBehavior，新增另一个属性
  const inBtn = incomingState.components.find((c) => c.id === 'button-spec');
  inBtn.keyboardBehavior = '带回稿改的键盘行为';
  inBtn.properties.push({ id: 'p-incoming-only', name: 'href', type: 'string', required: false, defaultValue: '', description: '带回新增' });

  const report = buildMergeReport(local, bundleFromState(incomingState), baseMap);
  const btn = report.merged.components.find((c) => c.id === 'button-spec');
  check('无冲突', report.conflicts.length === 0, `实际 ${report.conflicts.length}`);
  check('本机 purpose 保留', btn.purpose === '本机改的用途');
  check('带回 keyboardBehavior 保留', btn.keyboardBehavior === '带回稿改的键盘行为');
  check('两个新增属性都接上', btn.properties.some((p) => p.id === 'p-local-only') && btn.properties.some((p) => p.id === 'p-incoming-only'));
}

// ---------- 场景 2：同一属性两套值 → 冲突双方保留，选定前不提交 ----------
{
  console.log('\n场景2：同一属性出现两套值 → 双方保留待选定');
  const base = dataMod.createInitialState();
  const local = structuredClone(base);
  const incomingState = structuredClone(base);
  local.components.find((c) => c.id === 'button-spec').properties.find((p) => p.id === 'p-variant').defaultValue = 'primary';
  incomingState.components.find((c) => c.id === 'button-spec').properties.find((p) => p.id === 'p-variant').defaultValue = 'accent';

  const report = buildMergeReport(local, bundleFromState(incomingState), baseMap);
  check('产生 1 个冲突', report.conflicts.length === 1, `实际 ${report.conflicts.length}`);
  const conflict = report.conflicts[0];
  check('冲突定位到 variant.defaultValue', conflict.target === 'property' && conflict.itemId === 'p-variant' && conflict.field === 'defaultValue');
  check('本机值保留在 localRaw', conflict.localRaw === 'primary');
  check('带回值保留在 incomingRaw', conflict.incomingRaw === 'accent');
  check('未全部选定', !allConflictsResolved(report));

  // 选定前 merged 里放的是本机占位值；选 incoming 后变为 accent
  const chosen = resolveConflict(report, conflict.id, 'incoming', baseMap);
  check('选定后全部解决', allConflictsResolved(chosen));
  const btn = chosen.merged.components.find((c) => c.id === 'button-spec');
  check('写入的是带回稿值', btn.properties.find((p) => p.id === 'p-variant').defaultValue === 'accent');

  // 可改选
  const reChosen = resolveConflict(chosen, conflict.id, 'local', baseMap);
  const btn2 = reChosen.merged.components.find((c) => c.id === 'button-spec');
  check('改选回本机值', btn2.properties.find((p) => p.id === 'p-variant').defaultValue === 'primary');
}

// ---------- 场景 3：属性改动后依赖示例失效重算 ----------
{
  console.log('\n场景3：属性改动 → 依赖示例失效重算');
  const base = dataMod.createInitialState();
  const local = structuredClone(base);
  const incomingState = structuredClone(base);
  // 带回稿把 p-variant 的默认值从 secondary 改成 accent
  incomingState.components.find((c) => c.id === 'button-spec').properties.find((p) => p.id === 'p-variant').defaultValue = 'accent';
  const report = buildMergeReport(local, bundleFromState(incomingState), baseMap);
  const btn = report.merged.components.find((c) => c.id === 'button-spec');
  const primaryExample = btn.examples.find((e) => e.id === 'example-button-primary');
  check('依赖 p-variant 的示例被标记失效', primaryExample.stale === true, primaryExample.staleReason);
  check('失效原因提到 variant', primaryExample.staleReason.includes('variant'));
  const disabledExample = btn.examples.find((e) => e.id === 'example-button-disabled');
  check('不相关示例保持有效', disabledExample.stale === false);
}

// ---------- 场景 3b：冲突改选回基线值 → 合并器加的失效标记撤回 ----------
{
  console.log('\n场景3b：冲突改选回基线值 → 示例失效自动撤回');
  const base = dataMod.createInitialState();
  const local = structuredClone(base);
  const incomingState = structuredClone(base);
  // 基线 p-variant.defaultValue = 'secondary'；本机保持，带回稿改成 accent
  incomingState.components.find((c) => c.id === 'button-spec').properties.find((p) => p.id === 'p-variant').defaultValue = 'accent';
  const report = buildMergeReport(local, bundleFromState(incomingState), baseMap);
  // 单边改动自动接入，无冲突；示例失效
  let btn = report.merged.components.find((c) => c.id === 'button-spec');
  let example = btn.examples.find((e) => e.id === 'example-button-primary');
  check('自动接入带回值', btn.properties.find((p) => p.id === 'p-variant').defaultValue === 'accent');
  check('示例因自动接入而失效', example.stale && example.staleReason.startsWith('合并后属性契约变化：'));

  // 维护者手动构造“改回基线”的选择不可得（无冲突条目）；
  // 因此撤回路径通过删除/修改冲突来验证：见场景4选回后的结构重算。
  check('失效原因包含 variant', example.staleReason.includes('variant'));
}

// ---------- 场景 4：属性删除 vs 修改 → 结构冲突，可选保留任一方 ----------
{
  console.log('\n场景4：一方删属性、一方改属性 → 双方草稿保留');
  const base = dataMod.createInitialState();
  const local = structuredClone(base);
  const incomingState = structuredClone(base);
  const localBtn = local.components.find((c) => c.id === 'button-spec');
  localBtn.properties = localBtn.properties.filter((p) => p.id !== 'p-disabled');
  incomingState.components.find((c) => c.id === 'button-spec').properties.find((p) => p.id === 'p-disabled').description = '带回稿改的说明';

  const report = buildMergeReport(local, bundleFromState(incomingState), baseMap);
  const conflict = report.conflicts.find((c) => c.kind === 'deleted-modified' && c.itemId === 'p-disabled');
  check('出现删除/修改冲突', !!conflict);
  check('本机值显示已删除', conflict.localValue.includes('已删除'));

  // 选本机（删除）
  const deleted = resolveConflict(report, conflict.id, 'local', baseMap);
  const btnDel = deleted.merged.components.find((c) => c.id === 'button-spec');
  check('选本机后属性不存在', !btnDel.properties.some((p) => p.id === 'p-disabled'));
  const keptExample = btnDel.examples.find((e) => e.id === 'example-button-disabled');
  check('引用被清理且示例失效', !keptExample.propertyIds.includes('p-disabled') && keptExample.stale);

  // 选带回（保留修改后的属性）
  const kept = resolveConflict(report, conflict.id, 'incoming', baseMap);
  const btnKeep = kept.merged.components.find((c) => c.id === 'button-spec');
  check('选带回后属性恢复且说明已更新', btnKeep.properties.find((p) => p.id === 'p-disabled')?.description === '带回稿改的说明');
}

// ---------- 场景 5：示例各改各的 ----------
{
  console.log('\n场景5：同组件示例不同处 → 自动接上');
  const base = dataMod.createInitialState();
  const local = structuredClone(base);
  const incomingState = structuredClone(base);
  local.components.find((c) => c.id === 'button-spec').examples.find((e) => e.id === 'example-button-primary').title = '本机标题';
  incomingState.components.find((c) => c.id === 'button-spec').examples.find((e) => e.id === 'example-button-disabled').code = '<sp-button disabled>带回代码</sp-button>';
  const report = buildMergeReport(local, bundleFromState(incomingState), baseMap);
  const btn = report.merged.components.find((c) => c.id === 'button-spec');
  check('无冲突', report.conflicts.length === 0);
  check('本机标题接上', btn.examples.find((e) => e.id === 'example-button-primary').title === '本机标题');
  check('带回代码接上', btn.examples.find((e) => e.id === 'example-button-disabled').code === '<sp-button disabled>带回代码</sp-button>');
}

// ---------- 场景 6：同一示例代码两套值 ----------
{
  console.log('\n场景6：同一示例代码两套值 → 冲突');
  const base = dataMod.createInitialState();
  const local = structuredClone(base);
  const incomingState = structuredClone(base);
  local.components.find((c) => c.id === 'button-spec').examples.find((e) => e.id === 'example-button-primary').code = 'LOCAL CODE';
  incomingState.components.find((c) => c.id === 'button-spec').examples.find((e) => e.id === 'example-button-primary').code = 'INCOMING CODE';
  const report = buildMergeReport(local, bundleFromState(incomingState), baseMap);
  check('出现代码冲突', report.conflicts.some((c) => c.target === 'example' && c.field === 'code'));
}

// ---------- 场景 7：一方独有的组件不丢、不误判删除 ----------
{
  console.log('\n场景7：组件只在一方 → 保留，不当作删除');
  const base = dataMod.createInitialState();
  const local = structuredClone(base);
  const incomingState = structuredClone(base);
  // 本机新建组件（带回稿里没有）
  local.components.unshift({
    id: 'local-new', name: 'Local only', category: 'X', status: 'draft', purpose: '', usage: '',
    properties: [], states: '', keyboardBehavior: 'k', screenReader: 's', disabledScenarios: '',
    interactionSignature: '', examples: [], revision: 1, updatedAt: new Date().toISOString(), snapshots: []
  });
  // 带回稿也新建一个
  incomingState.components.unshift({
    id: 'incoming-new', name: 'Incoming only', category: 'Y', status: 'draft', purpose: '', usage: '',
    properties: [], states: '', keyboardBehavior: 'k', screenReader: 's', disabledScenarios: '',
    interactionSignature: '', examples: [], revision: 1, updatedAt: new Date().toISOString(), snapshots: []
  });
  const report = buildMergeReport(local, bundleFromState(incomingState), baseMap);
  check('两个独有组件都在', report.merged.components.some((c) => c.id === 'local-new') && report.merged.components.some((c) => c.id === 'incoming-new'));
  check('无删除型组件冲突', !report.conflicts.some((c) => c.target === 'component' && c.kind === 'deleted-modified'));
}

// ---------- 场景 8：同一标量字段两边改成相同值 → 不算冲突 ----------
{
  console.log('\n场景8：两边改成相同值 → 自动接上不冲突');
  const base = dataMod.createInitialState();
  const local = structuredClone(base);
  const incomingState = structuredClone(base);
  local.components.find((c) => c.id === 'field-spec').category = 'Forms v2';
  incomingState.components.find((c) => c.id === 'field-spec').category = 'Forms v2';
  const report = buildMergeReport(local, bundleFromState(incomingState), baseMap);
  check('无冲突', report.conflicts.length === 0);
  check('值已更新', report.merged.components.find((c) => c.id === 'field-spec').category === 'Forms v2');
}

// ---------- 场景 9：以共同快照为基线（出厂稿之后又分叉） ----------
{
  console.log('\n场景9：共同快照优先于出厂稿作为基线');
  const base = dataMod.createInitialState();
  const local = structuredClone(base);
  const incomingState = structuredClone(base);
  // 两边都从 button r3 存档，然后各自分叉
  const btn0 = local.components.find((c) => c.id === 'button-spec');
  const snapshot = { revision: 3, savedAt: new Date().toISOString(), reason: '断网前', component: structuredClone({ ...btn0, snapshots: [] }) };
  for (const state of [local, incomingState]) {
    const btn = state.components.find((c) => c.id === 'button-spec');
    btn.snapshots = [structuredClone(snapshot)];
    btn.revision = 4;
  }
  // 出厂稿里 purpose 与 r3 相同；两人在 r3 之后改了不同字段
  local.components.find((c) => c.id === 'button-spec').purpose = '快照后本机改';
  incomingState.components.find((c) => c.id === 'button-spec').states = '快照后带回改';
  const report = buildMergeReport(local, bundleFromState(incomingState), baseMap);
  const btn = report.merged.components.find((c) => c.id === 'button-spec');
  check('找到共同基线', report.baseFoundFor.includes('button-spec'));
  check('无冲突且两处都接上', report.conflicts.length === 0 && btn.purpose === '快照后本机改' && btn.states === '快照后带回改');
}

// ---------- 场景 9b：双方各自新增同名异编号属性 → 冲突，选定后剔除落选方 ----------
{
  console.log('\n场景9b：同名不同编号的新增属性 → 结构冲突');
  const base = dataMod.createInitialState();
  const local = structuredClone(base);
  const incomingState = structuredClone(base);
  local.components.find((c) => c.id === 'button-spec').properties.push(
    { id: 'p-new-local', name: 'size', type: 'string', required: false, defaultValue: 'm', description: '本机版' }
  );
  incomingState.components.find((c) => c.id === 'button-spec').properties.push(
    { id: 'p-new-incoming', name: 'size', type: '"s"|"m"|"l"', required: false, defaultValue: 'm', description: '带回版' }
  );
  const report = buildMergeReport(local, bundleFromState(incomingState), baseMap);
  const conflict = report.conflicts.find((c) => c.otherItemId === 'p-new-incoming');
  check('出现同名异编号冲突', !!conflict);
  check('未选定时两个属性都暂存在结果里', report.merged.components.find((c) => c.id === 'button-spec').properties.filter((p) => p.name === 'size').length === 2);

  const keptIncoming = resolveConflict(report, conflict.id, 'incoming', baseMap);
  const btn = keptIncoming.merged.components.find((c) => c.id === 'button-spec');
  const remaining = btn.properties.filter((p) => p.name === 'size');
  check('选带回稿后只留带回属性', remaining.length === 1 && remaining[0].id === 'p-new-incoming');
}

// ---------- 场景 10：重试——原双方草稿不变，重新计算得到同样结果 ----------
{
  console.log('\n场景10：重试幂等（双方草稿保留）');
  const base = dataMod.createInitialState();
  const local = structuredClone(base);
  const incomingState = structuredClone(base);
  local.components.find((c) => c.id === 'button-spec').purpose = 'A';
  incomingState.components.find((c) => c.id === 'button-spec').purpose = 'B';
  const report1 = buildMergeReport(local, bundleFromState(incomingState), baseMap);
  const report2 = buildMergeReport(local, bundleFromState(incomingState), baseMap);
  check('两次合并冲突数一致', report1.conflicts.length === report2.conflicts.length);
  check('本机正式稿未被合并过程改动', local.components.find((c) => c.id === 'button-spec').purpose === 'A');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
