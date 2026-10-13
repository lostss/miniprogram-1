/**
 * member-skeleton — 「骨架成员」的命名与判定（跨树契约，唯一事实源）
 *
 * 什么是骨架成员：建档时按**人数**造出来的占位成员（还不知道姓名），名字形如「成员1」「成员2」。
 * 它的消费方在**后端**：`member-matcher.matchPoliciesToMembers` 在 OCR 写保单时，
 * 把保单里出现的真人名**按顺序认领**这些骨架成员（`target.name = name`），
 * 认领完还有余量才新建成员 —— 这样"建档填 3 人、OCR 只提取到 2 人"不会变成 3+2=5 条成员。
 *
 * 为什么必须是契约（不是随手一个常量）：**命名格式本身就是接口**。
 *   - 前端建档造占位必须用 `skeletonName(i)`，否则后端认不出来 → 变成新建（成员数据污染）
 *   - 前端展示（整理报告）要判断"这行是占位还是真人"，必须用 `isSkeletonName()`，
 *     否则两处判定不一致时，占位行会被当成真人（或反之）→ 又一处静默漂移
 * 历史：`SKELETON_RE` 原先只定义在 `member-matcher.js`（且测试钉住 `''` 不算骨架），
 * 而 2026-10-13 之前的建档占位用的是**空名** → 认领机制从未被触发，OCR 一律新建成员。
 */
const SKELETON_RE = /^成员\d+$/

/** 是否骨架成员名（占位成员） */
function isSkeletonName(name) {
  return SKELETON_RE.test(String(name === null || name === undefined ? '' : name))
}

/** 第 i 个占位成员的名字（i 从 0 起）：成员1、成员2 … */
function skeletonName(i) {
  return '成员' + (Number(i) + 1)
}

module.exports = { SKELETON_RE, isSkeletonName, skeletonName }
