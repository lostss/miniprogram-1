/**
 * member-matcher 纯函数测试
 * _tryMatch, SKELETON_RE（Plan A：生日写入改走 members 集合，无内嵌 _setMemberBd）
 */
const { _tryMatch, SKELETON_RE } = require('../cloudfunctions/_shared/member-matcher')

const members = [
  { member_id: 'm1', name: '张三', role: '本人' },
  { member_id: 'm2', name: '李四', role: '配偶' },
  { member_id: 'm3', name: '成员2', role: '' },
  { member_id: 'm4', name: '成员3', role: '' }
]

describe('_tryMatch', () => {
  test('精确匹配', () => {
    expect(_tryMatch('张三', members)).toEqual(members[0])
  })

  test('模糊匹配（包含关系）', () => {
    expect(_tryMatch('张', members)).toEqual(members[0])
    expect(_tryMatch('李', members)).toEqual(members[1])
    expect(_tryMatch('王', members)).toEqual(null) // 无成员含"王"
  })

  test('多个模糊匹配返回null', () => {
    const m2 = [...members, { member_id: 'm5', name: '张晓', role: '' }]
    expect(_tryMatch('张', m2)).toBeNull() // 张三和张晓都包含"张"
  })

  test('空名返回null', () => {
    expect(_tryMatch('', members)).toBeNull()
    expect(_tryMatch(null, members)).toBeNull()
  })

  test('跳过骨架成员做模糊匹配', () => {
    // 成员3是骨架，不参与模糊匹配
    const r = _tryMatch('成员', members)
    expect(r).toBeNull() // 没有非骨架成员叫"成员"
  })

  test('精确匹配骨架成员可以', () => {
    expect(_tryMatch('成员2', members)).toEqual(members[2])
  })

  // =========================================================================
  // 2026-09-20（复核批次 B 收口 · 产品判断）：同名成员的处理方式
  //   流程审计曾把「重名成员重挂取首个命中」列为缺陷。复核后**关掉该项**：
  //   家庭内重名属罕见情形（产品判断），而此处若改成返回 null 会触发建档
  //   （matchPoliciesToMembers：未匹配上的人一律建档）→ 同一个人被登记成两条成员记录，
  //   比"挂到同名者名下"更糟。故取首个是刻意选择 —— 用这两条对照用例钉住。
  // =========================================================================
  test('同名成员：取首个（刻意不消歧）', () => {
    const dup = [
      { member_id: 'a1', name: '张伟', role: '本人' },
      { member_id: 'a2', name: '张伟', role: '子女' }
    ]
    expect(_tryMatch('张伟', dup)).toEqual(dup[0])
  })

  test('对照：模糊歧义返回 null（宁可建档也不猜，故骨架/多人歧义不会误挂）', () => {
    const amb = [
      { member_id: 'b1', name: '张三丰', role: '' },
      { member_id: 'b2', name: '张三明', role: '' }
    ]
    expect(_tryMatch('张三', amb)).toBeNull()
  })
})

describe('SKELETON_RE', () => {
  test('匹配骨架名称', () => {
    expect(SKELETON_RE.test('成员1')).toBe(true)
    expect(SKELETON_RE.test('成员2')).toBe(true)
    expect(SKELETON_RE.test('成员99')).toBe(true)
  })

  test('不匹配真实名称', () => {
    expect(SKELETON_RE.test('张三')).toBe(false)
    expect(SKELETON_RE.test('成员')).toBe(false)
    expect(SKELETON_RE.test('')).toBe(false)
  })
})
