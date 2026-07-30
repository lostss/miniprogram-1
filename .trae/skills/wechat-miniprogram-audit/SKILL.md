---
name: "wechat-miniprogram-audit"
description: "WeChat Mini Program full-stack audit with walkthrough testing and pattern scanning. Invoke when user asks for code audit, bug hunting, health check, or 体检/审计/穿行测试."
---

# WeChat Mini Program Full-Stack Audit

对微信小程序项目执行系统性审计，结合穿行测试和模式扫描两种方法，发现隐藏 bug 和数据一致性问题。

## 审计流程

### Phase 1: 穿行测试（Walkthrough Testing）

按核心用户旅程逐条走通，验证端到端逻辑：

1. **登录 → 创建家庭 → 添加成员**
   - 检查 openid 传递链路
   - 检查 member_id 生成和回传
   - 检查 families.members 数组写入

2. **AI 对话 → 事实提取 → 成员更新**
   - 检查 AI 上下文中 memberId 列是否存在
   - 检查 [TOOL:writeFact] 参数中 memberId 是否传递
   - 检查 writeFact 中 member_id 写入和去重逻辑
   - 检查前端 onConfirmInfo 中 cardData.memberId 提取
   - 检查 familyStore.updateField 中成员匹配字段

3. **上传保单 → OCR → 匹配 → 写入**
   - 检查 OCR 识别结果中 member_id 回填
   - 检查 matchPoliciesToMembers 调用时机（单图/批量）
   - 检查 slimPolicies 中 id 字段是否传递（匹配用）
   - 检查 writePolicy 中 member_id 取值链路
   - 检查 policies 集合 member_id 同步

4. **生成报告 → 调整 → 查看**
   - 检查 family_id 字段名一致性（不是 familyId）
   - 检查 reports 集合查询条件
   - 检查 insights 集合字段名

5. **首页列表 → 筛选 → 搜索 → 删除**
   - 检查 deleteFamily 清理所有关联集合
   - 检查列表缓存刷新

### Phase 2: 模式扫描（Pattern Scanning）

用 6 大 bug 模式系统性扫描代码：

#### 模式 1: 字段名不一致
```
搜索: familyId[^_].*where | where.*familyId[^_]
重点: families 集合用 _id，其他集合用 family_id
检查: 所有 .where() 中的字段名是否与写入时一致
```

#### 模式 2: 查询投影缺失关键字段
```
搜索: .field({  或  .field('
重点: queryMembers 是否返回 member_id
      queryFacts 是否返回 member_id
      queryPolicies 是否返回完整字段
检查: 写入时有的字段，查询时是否被 .field() 过滤掉
```

#### 模式 3: 关联字段穿透性缺失
```
核心思路: 数据在写入时携带 X 字段，但在去重/作废/查询/返回环节丢失
检查清单:
  - writeFact 去重是否按 member_id 区分
  - writeFact 作废旧记录是否按 member_id 区分
  - queryFacts 返回是否包含 member_id
  - queryMembers 返回是否包含 member_id
  - AI 上下文表格是否包含 memberId 列
  - 前端确认卡片是否传递 memberId
```

#### 模式 4: wx-server-sdk 不兼容语法
```
搜索: \$gte|\$lt|\$gt|\$lte|\$ne|\$in|\$nin
重点: wx-server-sdk 不支持 MongoDB 原生操作符
修复: { $gte: value } → db.command.gte(value)
注意: 检查所有 _shared/guard.js 文件
```

#### 模式 5: 数据残留
```
检查: deleteFamily 是否清理所有关联集合
必须清理: families, policies, facts, messages, insights, reports
检查: 写入新记录时旧记录是否正确标记作废（superseded: true）
```

#### 模式 6: 成员标识匹配不一致
```
搜索: m\._id\s*\|\|\s*m\.id | findIndex.*member
重点: 成员匹配应优先用 member_id，兼容 _id/id
修复: m.member_id === memberId || (m._id || m.id) === memberId
```

#### 模式 7: 批量操作遗漏后处理
```
搜索: ocrBatch|batch.*process|Promise\.all
重点: 批量处理完成后是否执行必要的后处理步骤
案例: ocrBatch 逐图识别后未调用 matchPoliciesToMembers
检查: 单图模式有但批量模式缺失的逻辑
```

#### 模式 8: _shared 文件修复不完整
```
场景: 修复了某个 _shared 文件，但同名的其他 _shared 副本未同步修复
搜索: 同名文件在不同目录下的副本
案例: 修复 dataWrite/_shared/guard.js 后，ocrService/conversationAI/_shared/guard.js 未修
规则: 修改 _shared 文件时，必须 grep 所有同名文件确认一致性
```

#### 模式 9: 条件分支遗漏
```
场景: 去重/作废/查询条件只考虑了部分情况
案例: writeFact 去重只按 dimension，未区分 member_id
      → 不同成员同维度同值被误判为重复
检查: where 条件是否覆盖了所有业务区分维度
口诀: "写入时按什么分组，去重/作废时也要按什么分组"
```

### Phase 3: 汇总与修复

1. 按严重程度分类：严重 / 中等 / 低
2. 每个问题记录：问题、文件、修复方案
3. 批量修复后验证
4. 输出结构化总结表格

## 关键检查点速查表

| 环节 | 检查项 | 常见问题 |
|------|--------|----------|
| 云函数查询 | .field() 投影 | member_id 被过滤 |
| 云函数写入 | 去重/作废条件 | 缺少 member_id 区分 |
| AI 上下文 | 表格列名 | 缺少 memberId 列 |
| AI 工具调用 | 参数传递 | memberId 在 data 内部而非顶层 |
| 前端确认 | cardData 提取 | memberId 在 card.data 层级 |
| Store 更新 | 成员匹配 | 用 _id 而非 member_id |
| 批量操作 | 匹配调用 | ocrBatch 缺少 matchPoliciesToMembers |
| 数据清理 | 关联集合 | deleteFamily 遗漏集合 |

## 使用方式

用户说"体检"、"审计"、"穿行测试"、"检查bug"时触发。
按 Phase 1 → 2 → 3 顺序执行，每个 Phase 完成后给出中间结果。
