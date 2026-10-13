# 运维笔记（低频查用，不常驻规则）

> 从 `.codebuddy/rules/cloud-rules/RULE.mdc` 外移：这些内容更新频率低、篇幅大，留在 alwaysApply 规则里每轮都注入。
> 规则只保留单句结论，细节与实测数据放这里。

## GitHub 推送通道（2026-09-12 实测）

本机访问 GitHub 的通道实测（`lyy-win`，无任何代理 / VPN）：

| 通道 | 状态 |
|------|------|
| `github.com:443`（HTTPS） | ⚠️ 间歇性被精准阻断（curl 10s 无响应，`git push` 超时）|
| `github.com:22`（SSH） | ✅ 稳定 |
| `ssh.github.com:443`（SSH over 443） | ✅ 备用通道 |
| `api.github.com:443` | ✅ 稳定 —— 状态查询走它 |

已配置 `~/.ssh/id_ed25519`（无密码短语），公钥注册于账号 `lostss`，remote 为
`git@github.com:lostss/miniprogram-1.git`。**HTTPS 不通时不要去折腾代理，直接用 SSH 推送。**

排查心法（2026-09-11 故障根因）：用户说"已添加"≠已生效。**用独立通道核对状态，不要靠反复试错**：

- 公钥是否注册：`curl https://api.github.com/users/<user>/keys`（返回 `[]` = 账号上一个都没有）
- 认证是否通过：`ssh -T git@github.com` → 成功 `Hi <user>!`，失败 `Permission denied (publickey).`
- 服务端是否真 GitHub：`ssh-keygen -F github.com -l` 比对官方 ED25519 指纹
  `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`（不符 = 被劫持）
- 三层归因：传输层故障表现为 timeout / reset；`Permission denied (publickey)` 是应用层结论，
  说明网络完全正常，纯粹是没有匹配的 key。

## 部署方式与依赖实测（2026-09-11）

```
manageFunctions({ action:'updateFunctionCode', functionName:'<fn>',
                  functionRootPath:'<绝对路径>/cloudfunctions' })
```

`functionRootPath` 传包含函数文件夹的父目录（即 `cloudfunctions` 本身），SDK 自动拼 `<fn>/` 并打包，无需手动 zip / base64。
不用 `tcb fn deploy`：CLI 会轮询到 `Deployment completed` 才返回（同一函数实测 40.97s）；MCP 是异步的，调用秒级返回。

依赖方案三条实测结论：

| 配置 | 耗时 | 结果 |
|------|------|------|
| `installDependency: true`（云端装依赖） | CLI 40.97s / MCP 秒级 | ✅ 唯一可靠路径 |
| `installDependency: false` + 本地 `node_modules` 入包 | 46.29s（61.8MB 上传） | ✅ 可用但更慢 |
| 云函数层（Layer）承载依赖 | 19.45s | ❌ 部署即挂 |

云函数层在本项目不可用：层可创建、可绑定、`CompatibleRuntimes` 含全部三种 Node 运行时、zip 结构
（`nodejs/node_modules/`）也正确，但 CloudBase 的 Node 运行时框架不会把层挂载路径 `/opt/nodejs/node_modules`
加入 require 解析链 → `require('wx-server-sdk')` 直接失败。属平台行为而非配置问题，不要再尝试。
