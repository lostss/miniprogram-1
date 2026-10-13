/**
 * fact-vocab 词表测试（2026-09-14 事实体系重构）
 *
 * 覆盖三条核心契约：
 * 1. 谓词开放：未命中属性槽不丢弃（axis 留空即可）
 * 2. axis 归一化：同义说法归到同一槽（冲突消解/字段定位的前提）
 * 3. 写策略派生：属性槽 versioned、保单节点属性 versioned、其余 dedup
 */
const { axisOf, strategyOf, kindOf, isPolicyAttr, AXIS_DEFS, AXES, KINDS, AXIS_SET, STANDARD_COVERAGE } = require('../cloudfunctions/_shared/fact-vocab')

describe('fact-vocab 词表', () => {
  test('同义说法归一到同一属性槽', () => {
    expect(axisOf('个人年收入')).toBe('个人年收入')
    expect(axisOf('年薪')).toBe('个人年收入')
    expect(axisOf('收入')).toBe('个人年收入')
    expect(axisOf('病史')).toBe('健康异常')
  })

  test('月薪**不**归一到个人年收入槽（2026-09-28 推翻旧口径）', () => {
    // 旧口径（docs/data-model-v2.md 同义词表原版）把「月薪」列入「个人年收入」同义词。
    // 但该槽经 AXIS_MEMBER_FIELD 直落 members.income（单位万/**年**）并被 gap-core 当 5×年收入
    // 基数 → "月薪2万"落成年入 2 万，少报约 12×；错在确定性计算上，故移出同义词表。
    // 未命中槽不丢信息：axis 留空，事实仍按 kind 进画像与 AI 上下文（原话保留）。
    expect(axisOf('月薪')).toBe('')
    expect(axisOf('月薪2万')).toBe('') // 谓词是 AI 原话，可能自带数值
    expect(strategyOf('月薪')).toBe('dedup')
    // 直接钉住词表本身，防止"顺手加回去"
    expect(AXIS_DEFS.filter(d => d.axis === '个人年收入')[0].syns).not.toContain('月薪')
  })

  test('未命中槽返回空字符串（谓词开放，语义不丢弃）', () => {
    expect(axisOf('公司团险在职有效')).toBe('')
    expect(axisOf('夫妻共保')).toBe('')
    expect(axisOf('')).toBe('')
    expect(axisOf(undefined)).toBe('')
  })

  test('写策略：属性槽 versioned（新值覆盖旧值）', () => {
    expect(strategyOf('年薪')).toBe('versioned')
    expect(strategyOf('职业')).toBe('versioned')
    expect(strategyOf('总负债')).toBe('versioned')
  })

  test('写策略：未命中槽默认 dedup（同值跳过，多值并存）', () => {
    expect(strategyOf('公司团险在职有效')).toBe('dedup')
    expect(strategyOf('夫妻共保')).toBe('dedup')
    expect(strategyOf('配偶')).toBe('dedup')
  })

  test('写策略：保单节点属性保持 versioned（保额改动必须覆盖旧值）', () => {
    expect(isPolicyAttr('保额')).toBe(true)
    expect(strategyOf('保额')).toBe('versioned')
    expect(strategyOf('险种')).toBe('versioned')
    expect(strategyOf('保单号')).toBe('versioned')
    // 成员事实里出现同名词也不能误判（axis 优先）
    expect(strategyOf('保额', '')).toBe('versioned')
  })

  test('kind 推断：关系类 → relation；默认 fact；显式传入优先', () => {
    expect(kindOf('配偶')).toBe('relation')
    expect(kindOf('子女')).toBe('relation')
    expect(kindOf('公司团险')).toBe('fact')
    expect(kindOf('公司团险', 'lead')).toBe('lead')
    expect(kindOf('公司团险', 'constraint')).toBe('constraint')
    expect(kindOf('公司团险', 'bogus')).toBe('fact')
  })

  test('axis 字典是闭合集（未命中不报错，只是留空）', () => {
    expect(AXES.length).toBeGreaterThan(20)
    expect(AXIS_SET.has('个人年收入')).toBe(true)
    expect(AXIS_SET.has('公司团险')).toBe(false)
    expect(KINDS).toEqual(['fact', 'constraint', 'relation', 'lead'])
    expect(STANDARD_COVERAGE).toHaveLength(8)
  })
})
