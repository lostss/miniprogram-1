/**
 * calcAge — 从出生日期计算周岁（年年自动递增，权威源）
 * @param {string} birthDate YYYY-MM-DD
 * @returns {number} 周岁（无效输入返回 0）
 */
function calcAgeYears(birthDate) {
  if (!birthDate) return 0
  const b = new Date(birthDate)
  if (isNaN(b.getTime())) return 0
  const t = new Date()
  let a = t.getFullYear() - b.getFullYear()
  const m = t.getMonth() - b.getMonth()
  if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--
  return a
}

/**
 * @param {string} birthDate YYYY-MM-DD
 * @returns {string|null} "35岁" 或 null
 */
function calcAge(birthDate) {
  if (!birthDate) return null
  const b = new Date(birthDate)
  if (isNaN(b.getTime())) return null
  return calcAgeYears(birthDate) + '岁'
}

module.exports = { calcAge, calcAgeYears }
