/**
 * tools.js — AI 工具定义（function calling schema）单一事实源
 *
 * 设计动机：原 _TOOL_DEFINITIONS 233 行 JSON 常量内联在 conversationAI/index.js
 * 编排文件正中，review 编排流程须滚动跳过。外移后 index.js 聚焦编排，
 * 工具 schema 可独立审阅、对照后端 handler 实现。
 *
 * 接口契约：
 *   TOOL_DEFINITIONS — function calling schema 数组，传 callChatWithTools
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
              age: { type: 'number', description: '年龄（用户说"X岁"时传，勿换算成出生日期；与已记录值差≥2岁系统会追问确认）' },
              birth_date: { type: 'string', description: 'YYYY-MM-DD（仅用户明确说出出生日期时传）' },
              role: { type: 'string', enum: ['本人', '配偶', '子女', '父母'] },
              gender: { type: 'string', enum: ['男', '女', '未知'] },
              occupation: { type: 'string' },
              health: { type: 'string' },
              income: { type: 'number', description: '个人年收入（单位：万，25万=25；用户说"收入25万"时传）' }
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
      description: '删除/作废某张保单。用户明确表示"删掉/退保/作废/取消/不要了"某张保单时调用。删除后软删保单并置 insight_stale（不触发报告自动刷新）',
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
      description: '记录事实三元组（subject 成员/保单 → predicate → object）。只记录代理人陈述的原始事实，缺口判断/购买建议不记录。predicate 从 enum 中选择，L1 核心维度优先；无法归入时用"有特征"（人况/标签类）或"备注"（时间线事件/补充说明）。',
      parameters: {
        type: 'object',
        properties: {
          subjectName: { type: 'string', description: '主体名称（成员姓名）' },
          predicate: {
            type: 'string',
            description: '谓词（必须从 enum 中选择，L1 核心维度优先；无法归入时用"有特征"或"备注"）。L1 分类：关系/保障/人况/经济依赖/风险敞口/现有保障/家庭资产/财富目标/关键时点/投保偏好/法律身份',
            enum: [
              '配偶', '子女', '父母',
              '拥有保障', '公司提供保障', '投保',
              '职业', '个人年收入', '健康异常', '病史时间线', '年龄', '性别', '教育程度',
              '婚姻状态', '职业状态', '吸烟习惯', '饮酒习惯', 'BMI指数',
              '收入来源', '抚养赡养人数', '社保情况',
              '负债', '负债期限', '房贷余额', '固定支出', '教育支出预期', '赡养支出预期',
              '保额', '年缴保费', '险种', '生效日', '承保公司', '保单号', '保障期间',
              '公司团险', '免赔额', '等待期', '缴费期', '缴费方式', '特殊条款',
              '持有资产', '房产价值', '金融资产', '企业经营权', '资产持有比例', '婚前财产',
              '未来计划', '教育规划', '退休规划', '传承意图', '资产隔离需求', '婚嫁规划',
              '退休预期年龄', '贷款到期日', '子女教育节点', '婚嫁预期时点',
              '有偏好', '年保费预算', '偏好保险公司', '缴费偏好', '风险偏好',
              '是否企业主', '企业类型', '婚姻财产制',
              '有特征', '备注'
            ]
          },
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
      description: '修改已录入保单的字段（保额/保费/保险公司/生效日/保单状态等）。用户说"把那张保单保额改成200万""这保单已失效/已续保/现在有效"等时使用',
      parameters: {
        type: 'object',
        properties: {
          policyId: { type: 'string', description: '保单业务ID（pol_xxx），优先' },
          product_name: { type: 'string', description: '产品名称（无 policyId 时用）' },
          insured_name: { type: 'string', description: '被保人姓名' },
          policy_number: { type: 'string', description: '保单号' },
          data: {
            type: 'object',
            description: '要更新的字段。保单状态类信息（有效/已失效/续保/取消）必须填 status，勿填到 effective_date',
            properties: {
              product_name: { type: 'string' },
              insurer: { type: 'string' },
              sum_assured: { type: 'number', description: '保额（元）' },
              annual_premium: { type: 'number', description: '年缴保费（元）' },
              effective_date: { type: 'string' },
              insurance_category: { type: 'string' },
              status: { type: 'string', enum: ['active', 'expired', 'cancelled', 'suspicious'], description: '保单状态：active=有效/在保，expired=已失效/过期，cancelled=已取消/退保，suspicious=待核查' }
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
  },
  {
    type: 'function',
    function: {
      name: 'queryMemberProfile',
      description: '查询单个成员的精简画像（基础属性 + 健康人况 + 经济依赖 + 财富目标 + 保障清单 + 其他事实）。用户问"某成员有什么保险/健康情况/收入"时优先用此工具，比 queryFacts 返回更精简且已按维度分组',
      parameters: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: '成员ID（优先）' },
          memberName: { type: 'string', description: '成员姓名（无 memberId 时用）' }
        },
        required: []
      }
    }
  }
]

/**
 * toToolList — 转换为前端 wx.cloud.extend.AI streamText tools.list 格式
 * （{name, description, parameters}），经 getPrompt 下发，前端不复制 schema，单一事实源保持在后端。
 */
function toToolList() {
  return TOOL_DEFINITIONS
    .map(d => d.function ? { name: d.function.name, description: d.function.description, parameters: d.function.parameters } : null)
    .filter(Boolean)
}

module.exports = { TOOL_DEFINITIONS, toToolList }
