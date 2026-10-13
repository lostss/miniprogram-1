/**
 * 页面注册表一致性守卫（2026-10-13 新增）
 *
 * 动因：本次"首页 + 客户列表页合并"删掉了整个 pages/clients 目录。删页有两个**静默失败点**，
 * 都不是编译期错误、测试也不会红：
 *  ① `app.json` 留着已删页面 → 小程序启动即报错（真机白屏，本仓无 CI 时只能在真机发现）；
 *  ② 别处仍 `navigateTo('/pages/clients/index')` → 导航失败但多数调用没有 fail 兜底，
 *     表现是"点了没反应"，最难定位。
 * 反向同理：`pages/` 下新增目录却忘了注册 → 页面永远进不去（同样静默）。
 *
 * 本守卫把两个方向都钉住（不依赖 tabBar：本项目无 tabBar，页面全部靠 navigateTo）。
 */
const fs = require('fs')
const path = require('path')

const MINIPROGRAM = path.join(__dirname, '..', 'miniprogram')
const appJson = JSON.parse(fs.readFileSync(path.join(MINIPROGRAM, 'app.json'), 'utf8'))
const pages = appJson.pages || []

function walkJs(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) walkJs(full, out)
    else if (name.endsWith('.js')) out.push(full)
  }
  return out
}

describe('页面注册表一致性', () => {
  test('app.json 注册的每个页面都有 .js / .wxml / .json 三件套', () => {
    for (const p of pages) {
      for (const ext of ['.js', '.wxml', '.json']) {
        expect(fs.existsSync(path.join(MINIPROGRAM, p + ext))).toBe(true)
      }
    }
  })

  test('pages/ 下每个页面目录都被 app.json 注册（防删页后残留、防新增未注册）', () => {
    const dirs = fs.readdirSync(path.join(MINIPROGRAM, 'pages'))
      .filter(n => fs.statSync(path.join(MINIPROGRAM, 'pages', n)).isDirectory())
      .map(n => 'pages/' + n + '/index')
    const registered = new Set(pages)
    expect(dirs.filter(d => !registered.has(d))).toEqual([])
  })

  test('源码里的 /pages/... 导航目标都指向已注册页面（防跳到已删页面静默失败）', () => {
    const registered = new Set(pages)
    const bad = []
    for (const file of walkJs(MINIPROGRAM)) {
      const src = fs.readFileSync(file, 'utf8')
      // 只认"页面路径字面量"：以 /pages/ 开头、后接 目录/文件
      const re = /['"`]\/pages\/([\w-]+)\/([\w-]+)/g
      let m
      while ((m = re.exec(src))) {
        const target = 'pages/' + m[1] + '/' + m[2]
        if (!registered.has(target)) bad.push(path.relative(MINIPROGRAM, file) + ' -> ' + target)
      }
    }
    expect(bad).toEqual([])
  })
})
