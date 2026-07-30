/**
 * tools.js — AI 工具定义（function calling schema）单一事实源
 *
 * 设计动机：原 _TOOL_DEFINITIONS 233 行 JSON 常量内联在 conversationAI/index.js
 * 编排文件正中，review 编排流程须滚动跳过。外移后 index.js 聚焦编排，
 * 工具 schema 可独立审阅、对照后端 handler 实现。
 *
 * 接口契约：
 *   TOOL_DEFINITIONS — function calling schema 数组，传 callChatWithTools
 *   TOOL_NAMES       — 工具名 Set，用于白名单校验
 */
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'upsertMember',
      description: '创建或更新家庭成员信息（多字段批量）。用户提到家庭成员的姓名/年龄/职业/健康状况/角色时调用。不存在则创建新成员',
      parameters: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: '成员ID（优先用，无则用 memberName 匹配）' },
          memberName: { type: 'string', description: '成员姓名（无 memberId 时用，后端按 name+role 匹配）' },
          role: { type: 'string', enum: ['本人', '配偶', '子女', '父母'], description: '角色（创建时必填，匹配时辅助）' },
          data: {
            type: 'object',
            description: '需更新的字段（至少传1个）',
            properties: {
              name: { type: 'string' },
              birth_date: { type: 'string', description: 'YYYY-MM-DD' },
              role: { type: 'string', enum: ['本人', '配偶', '子女', '父母'] },
              gender: { type: 'string', enum: ['男', '女', '未知'] },
              occupation: { type: 'string' },
              health: { type: 'string' }
            }
          }
        },
        required: ['data']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'updateFinances',
      description: '更新家庭财务信息。用户提到收入/负债/支出时调用，仅传需改的字段',
      parameters: {
        type: 'object',
        properties: {
          annual_income: { type: 'number', description: '年收入（元）' },
          total_debt: { type: 'number', description: '总负债（元）' },
          fixed_annual_expense: { type: 'number', description: '年固定支出（元）' },
          debt_type: { type: 'string', description: '负债类型，如房贷/车贷' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'addPolicy',
      description: '录入保单。用户提到买了什么保险、保单信息时调用',
      parameters: {
        type: 'object',
        properties: {
          product_name: { type: 'string', description: '产品名称' },
          insurance_category: { type: 'string', enum: ['重疾险', '医疗险', '意外险', '寿险', '年金', '其他'] },
          sum_assured: { type: 'number', description: '保额（元）' },
          annual_premium: { type: 'number', description: '年缴保费（元）' },
          insured_name: { type: 'string', description: '被保人姓名（后端匹配 memberId）' },
          effective_date: { type: 'string', description: '生效日 YYYY-MM-DD' },
          insurer: { type: 'string', description: '保险公司' },
          premium_term: { type: 'number', description: '缴费年期，0=趸交' },
          coverage_term: { type: 'number', description: '保障年期，0=终身' },
          policy_number: { type: 'string' },
          policyholder_name: { type: 'string', description: '投保人' }
        },
        required: ['product_name', 'insurance_category', 'sum_assured', 'annual_premium', 'insured_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deletePolicy',
      description: '删除/作废某张保单。用户明确表示"删掉/退保/作废/取消/不要了"某张保单时调用。删除后系统自动软删保单库并刷新报告',
      parameters: {
        type: 'object',
        properties: {
          policyId: { type: 'string', description: '保单业务ID（pol_xxx），优先' },
          product_name: { type: 'string', description: '产品名称（无 policyId 时用）' },
          insured_name: { type: 'string', description: '被保人姓名' },
          policy_number: { type: 'string', description: '保单号' },
          reason: { type: 'string', description: '作废原因（可选）' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'addFact',
      description: '记录事实三元组。按分类决策框架：保障类→拥有保障/公司提供保障，状态类→职业/个人年收入/健康异常/负债，资产类→持有资产，计划类→未来计划，偏好→有偏好，无法归类→有特征',
      parameters: {
        type: 'object',
        properties: {
          subjectName: { type: 'string', description: '主体名称（成员姓名）' },
          predicate: { type: 'string', description: '谓词（关系/保障/状态/资产/计划/偏好/备注等自由文本）。参考：配偶/子女/父母/拥有保障/公司提供保障/职业/个人年收入/健康异常/负债/持有资产/未来计划/有偏好/有特征/保额/年缴保费/险种/生效日/承保公司。OCR纠正场景记录如"房贷""车贷"等具体事项' },
          objectValue: { type: 'string', description: '客体值' },
          objectName: { type: 'string', description: '客体是成员时的姓名（如配偶关系）' },
          confidence: { type: 'number', description: '置信度 0-1：客户明确陈述→0.8-0.9；模糊提及/推断→0.4-0.6；未知默认 0.9。低于 0.6 会生成确认卡片' },
          reasoning: { type: 'string', description: '推理依据（AI 推理结论时填写）' }
        },
        required: ['subjectName', 'predicate', 'objectValue']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'triggerAnalysis',
      description: '重新生成保障分析报告（含缺口分析，后台执行 10-30 秒）。用户要求分析保障、查看缺口、刷新或重新生成报告时使用',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'queryPolicies',
      description: '查询该家庭全部保单明细（险种/保额/保费等）。仅当对话上下文缺失保单信息时使用',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'queryMembers',
      description: '查询该家庭全部成员。仅当对话上下文缺失成员信息时使用',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'createFamily',
      description: '新建客户家庭档案。用户说"新建一个家庭/新建客户/开个档案"并给出家庭名称和至少一个成员时调用，返回新建的家庭ID',
      parameters: {
        type: 'object',
        properties: {
          family_name: { type: 'string', description: '家庭/客户名称' },
          family_structure: { type: 'array', items: { type: 'string' }, description: '成员角色列表，如 ["本人","配偶"]' },
          members: {
            type: 'array',
            description: '初始成员（至少1个）',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                role: { type: 'string', enum: ['本人', '配偶', '子女', '父母'] },
                age: { type: 'number' },
                gender: { type: 'string' },
                occupation: { type: 'string' },
                health: { type: 'string' }
              },
              required: ['name', 'role']
            }
          }
        },
        required: ['family_name', 'members']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deleteMember',
      description: '删除家庭成员。用户明确要求"删掉某成员/移除XX"时调用，系统会弹出确认卡片，需代理人确认后才删除',
      parameters: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: '成员ID（优先）' },
          memberName: { type: 'string', description: '成员姓名（无 memberId 时用）' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'updatePolicy',
      description: '修改已录入保单的字段（保额/保费/保险公司/生效日等）。用户说"把那张保单保额改成200万"等时使用',
      parameters: {
        type: 'object',
        properties: {
          policyId: { type: 'string', description: '保单业务ID（pol_xxx），优先' },
          product_name: { type: 'string', description: '产品名称（无 policyId 时用）' },
          insured_name: { type: 'string', description: '被保人姓名' },
          policy_number: { type: 'string', description: '保单号' },
          data: {
            type: 'object',
            description: '要更新的字段',
            properties: {
              product_name: { type: 'string' },
              insurer: { type: 'string' },
              sum_assured: { type: 'number', description: '保额（元）' },
              annual_premium: { type: 'number', description: '年缴保费（元）' },
              effective_date: { type: 'string' },
              insurance_category: { type: 'string' }
            }
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deleteFact',
      description: '删除/作废一条已记录的事实。用户明确要求删除某条备注或事实时调用，系统会弹出确认卡片',
      parameters: {
        type: 'object',
        properties: {
          factId: { type: 'string', description: '事实ID' }
        },
        required: ['factId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'queryFacts',
      description: '查询该家庭全部事实记录（保障/状态/资产/计划/偏好/备注）。仅当对话上下文缺失事实信息时使用',
      parameters: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: '可选，按成员过滤' }
        },
        required: []
      }
    }
  }
]

const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(t => t.function.name))

module.exports = { TOOL_DEFINITIONS, TOOL_NAMES }
