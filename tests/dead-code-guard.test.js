/**
 * 死代码护栏（2026-09-27，dsh 审计 P3）
 *
 * 背景：这三项经全仓 grep 确认**零调用方**后删除。它们能长期留存的共同原因是
 * **过时注释**——文件头/依赖说明仍写着"member-write / message-write → addMemberFact"，
 * 让读者以为它在用（本次审计就是据此把它列为"零调用方，请确认"）。
 *
 * 本护栏的性质：不是"这三个名字永远不能出现"，而是**不得被静默加回**。
 * 若确需恢复某个能力，请连同用途、调用方一起加，并同步更新本测试与 README。
 */
const memberRepo = require('../cloudfunctions/dataWrite/_shared/memberRepo')
const factWrite = require('../cloudfunctions/dataWrite/fact-write')
const factVocab = require('../cloudfunctions/_shared/fact-vocab')

describe('P3 死代码：已删除项不得静默回归', () => {
  test('memberRepo 不再导出 deleteMembersForFamily（级联改由 family-write 的 batchTx 承担）', () => {
    expect(memberRepo.deleteMembersForFamily).toBeUndefined()
    // 级联能力本身仍在（不得因为删函数而丢失）：family-write 的三个家庭级入口必须齐
    const familyWrite = require('../cloudfunctions/dataWrite/family-write')
    expect(typeof familyWrite.createFamily).toBe('function')
    expect(typeof familyWrite.updateFamilyHandler).toBe('function')
    expect(typeof familyWrite.deleteFamilyHandler).toBe('function')
  })

  test('fact-write 不再导出 addMemberFact / strategyOf 再导出', () => {
    expect(factWrite.addMemberFact).toBeUndefined()
    expect(factWrite.strategyOf).toBeUndefined()
    // 但 addFact 与 DIM_TO_PREDICATE 是其真实对外面，必须仍在
    expect(typeof factWrite.addFact).toBe('function')
    expect(factWrite.DIM_TO_PREDICATE).toBeTruthy()
  })

  test('strategyOf 本体仍在契约里（删的是再导出，不是函数）', () => {
    expect(typeof factVocab.strategyOf).toBe('function')
    expect(factVocab.strategyOf('年薪')).toBe('versioned')
  })
})
