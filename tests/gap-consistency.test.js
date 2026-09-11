/**
 * 跨端一致性契约（2026-09-11 缺口「单一实现」治理的伴随测试）
 *
 * 背景：此前前端 miniprogram/utils/report/gap-engine.js 与后端 reportAI/report-context.buildGapSnapshot
 * 各实现一遍缺口算法，口径分裂 2 次（P1-A 2026-09-05 / P1-2 2026-09-10）。现算法统一到
 * cloudfunctions/_shared/gap-core.js（经 sync-shared.js 跨树契约同步到 miniprogram/utils/gap-core.js）。
 *
 * 本测试锁定的是**适配层**：算法已共享，但两侧输入形态不同——
 *   前端 buildGaps(family)                      ← { family_income, debt:{amount}, members, policies }
 *   后端 buildGapSnapshot(policies, snap, members) ← { income, debt } + 独立 policies/members
 * 适配器写错（如单位误传、字段取错）会让共享算法的结果再次分叉，故用同一家庭数据做交叉验证。
 */
const { buildGaps } = require('../miniprogram/utils/report/gap-engine')
const { buildGapSnapshot } = require('../cloudfunctions/reportAI/report-context')

// 同一家庭的两种输入形态（数值等价）
const family = {
  family_income: 50,
  debt: { amount: 100 },
  members: [
    { member_id: 'm1', name: '张三', role: '本人', income: 30 },
    { member_id: 'm2', name: '李四', role: '配偶', income: 20 }
  ],
  policies: [
    { status: 'active', member_id: 'm2', insured_name: '李四', insurance_category: '寿险', sum_assured: 2000000 }
  ]
}
const snap = { income: 50, debt: 100 }

describe('缺口跨端一致性（前端 buildGaps ↔ 后端 buildGapSnapshot）', () => {
  test('同一家庭数据 → 两端「有缺口」项数与需求金额一致', () => {
    const frontGaps = buildGaps(family).filter(g => g.reliability !== 'blocked')
    const md = buildGapSnapshot(family.policies, snap, family.members)
    const backRows = md.split('\n').filter(l => l.indexOf('| ') === 0 && l.indexOf('❌ 有缺口') > 0)

    expect(backRows.length).toBe(frontGaps.length)
    for (const g of frontGaps) {
      const row = md.split('\n').find(l => l.indexOf('| ' + g.member + ' | ' + g.category + ' |') === 0)
      expect(row).toBeDefined()
      expect(row).toContain('❌ 有缺口')
      // 依据列的「=N万」只出现在完整公式行（负债已知 → confirmed）；estimated 行用「≈」表达
      if (g.reference != null && g.reliability === 'confirmed') expect(row).toContain('=' + g.reference + '万')
    }
  })

  test('两端「已覆盖」判定一致（满足阈值的项不进前端 gaps）', () => {
    const frontGaps = buildGaps(family)
    const md = buildGapSnapshot(family.policies, snap, family.members)
    const liRow = md.split('\n').find(l => l.indexOf('| 李四 | 寿险 |') === 0)
    expect(liRow).toContain('✅ 已覆盖') // 负债100 + 5×个人收入20 = 200 万，已保 200 万
    expect(frontGaps.find(g => g.member === '李四' && g.category === '寿险')).toBeUndefined()
  })

  test('两端 blocked 判定一致（收入缺失成员不进「❌ 有缺口」）', () => {
    const f2 = {
      family_income: 0,
      debt: { amount: 0 },
      members: [
        { member_id: 'm1', name: '张三', role: '本人', income: 0 },
        { member_id: 'm2', name: '李四', role: '配偶', income: 0 }
      ],
      policies: []
    }
    const frontGaps = buildGaps(f2)
    expect(frontGaps.filter(g => g.reliability === 'blocked').length).toBeGreaterThan(0) // 非支柱寿险/意外 blocked
    const md = buildGapSnapshot([], { income: 0, debt: 0 }, f2.members)
    expect(md).toContain('⚠️ 无法计算')
    const blockedRows = md.split('\n').filter(l => l.indexOf('| ') === 0 && l.indexOf('⚠️ 无法计算') > 0)
    const frontBlocked = frontGaps.filter(g => g.reliability === 'blocked')
    expect(blockedRows.length).toBe(frontBlocked.length)
  })

  test('两侧单位口径一致（万）：家庭收入 50 万 → 需求按 5×50 而非 5×50 元', () => {
    const f3 = {
      family_income: 50,
      debt: { amount: 0 },
      members: [{ member_id: 'm1', name: '张三', role: '本人', income: 0 }],
      policies: []
    }
    const g = buildGaps(f3).find(x => x.category === '寿险')
    expect(g.reference).toBe(250) // 0 + 5×50（万），单位错传会得到 0.025 之类的荒谬值
    const md = buildGapSnapshot([], { income: 50, debt: 0 }, f3.members)
    expect(md).toContain('5×年收入50万') // 负债为 0 → estimated 表达；单位错传（如传元）会得到 0.025 之类
  })
})
