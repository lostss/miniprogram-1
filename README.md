# 云开发 quickstart

这是云开发的快速启动指引，其中演示了如何上手使用云开发的三大基础能力：

- 数据库：一个既可在小程序前端操作，也能在云函数中读写的 JSON 文档型数据库
- 文件存储：在小程序前端直接上传/下载云端文件，在云开发控制台可视化管理
- 云函数：在云端运行的代码，微信私有协议天然鉴权，开发者只需编写业务逻辑代码

## 部署信息

**环境**: `cloud1-3gan2ae3d3b400f1`（别名: cloud1）
**区域**: ap-shanghai
**套餐**: 个人版
**最新部署**: 2026-05-20

### 已部署云函数（15个）

| 云函数 | 运行时 | 类型 | 状态 |
|--------|--------|------|------|
| analysisSkill | Nodejs16.13 | Event | ✅ Active |
| chatSkill | Nodejs16.13 | Event | ✅ Active |
| confirmHealth | Nodejs16.13 | Event | ✅ Active |
| consultSkill | Nodejs16.13 | Event | ✅ Active |
| createFamily | Nodejs18.15 | Event | ✅ Active |
| getFacts | Nodejs18.15 | Event | ✅ Active |
| getFamily | Nodejs16.13 | Event | ✅ Active |
| getHomeList | Nodejs16.13 | Event | ✅ Active |
| getMessages | Nodejs16.13 | Event | ✅ Active |
| harness | Nodejs16.13 | Event | ✅ Active |
| login | Nodejs16.13 | Event | ✅ Active |
| ocrSkill | Nodejs16.13 | Event | ✅ Active |
| recordSkill | Nodejs16.13 | Event | ✅ Active |
| report | Nodejs16.13 | Event | ✅ Active |
| updateFamilyDetail | Nodejs18.15 | Event | ✅ Active |

### 目录（非云函数）
- layer/ — 共享层目录
- lib/ — 共享工具目录

### 资源
- **文档数据库**: messages 集合
- **云存储**: `636c-cloud1-3gan2ae3d3b400f1-1300232888`
- **静态托管**: `cloud1-3gan2ae3d3b400f1-1300232888.tcloudbaseapp.com`

## 参考文档

- [云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)
- [CloudBase 控制台](https://tcb.cloud.tencent.com/dev?envId=cloud1-3gan2ae3d3b400f1#/overview)
