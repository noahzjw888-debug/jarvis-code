/**
 * JarvisCode Agent 系统
 * 基于 Claude Code 的 Agent 架构
 */

// ==================== 类型定义 ====================

export type AgentType = 'coordinator' | 'worker' | 'specialist'
export type AgentStatus = 'idle' | 'thinking' | 'executing' | 'waiting' | 'completed' | 'failed'

export interface AgentConfig {
  id?: string
  name: string
  type?: AgentType
  role?: string
  tools?: string[]
  skills?: string[]
  permissions?: Record<string, PermissionMode>
  systemPrompt?: string
  model?: string
  apiKey?: string
  apiUrl?: string
}

export type PermissionMode = 'always_allow' | 'prompt' | 'deny'

// ==================== Agent 类 ====================

export class Agent {
  id: string
  name: string
  type: AgentType
  role: string
  status: AgentStatus
  tools: string[]
  permissions: Record<string, PermissionMode>
  skills: string[]
  systemPrompt: string
  model: string
  apiKey?: string
  apiUrl?: string
  messages: Message[]
  currentTask?: TaskInfo
  createdAt: number
  teamName?: string

  constructor(config: AgentConfig) {
    this.id = config.id || `agent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    this.name = config.name
    this.type = config.type || 'worker'
    this.role = config.role || 'worker'
    this.status = 'idle'
    this.tools = config.tools || []
    this.permissions = config.permissions || {}
    this.skills = config.skills || []
    this.systemPrompt = config.systemPrompt || ''
    this.model = config.model || 'minimax'
    this.apiKey = config.apiKey
    this.apiUrl = config.apiUrl
    this.messages = []
    this.createdAt = Date.now()
  }

  canUseTool(toolName: string): boolean {
    if (this.permissions[toolName] === 'deny') return false
    return this.permissions[toolName] !== undefined || this.tools.includes(toolName)
  }

  needsConfirmation(toolName: string): boolean {
    return this.permissions[toolName] === 'prompt'
  }

  addMessage(role: 'user' | 'assistant' | 'system' | 'tool', content: string, toolName?: string) {
    this.messages.push({
      role,
      content,
      toolName,
      timestamp: Date.now()
    })
  }

  setStatus(status: AgentStatus) {
    this.status = status
  }

  assignTask(task: TaskInfo) {
    this.currentTask = { ...task, assignedAt: Date.now() }
    this.status = 'idle'
  }

  completeTask() {
    this.currentTask = undefined
    this.status = 'completed'
  }

  failTask(error?: string) {
    if (this.currentTask) {
      this.currentTask.error = error
    }
    this.status = 'failed'
  }

  getSummary(): AgentSummary {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      role: this.role,
      status: this.status,
      tools: this.tools,
      skills: this.skills,
      messageCount: this.messages.length,
      currentTask: this.currentTask?.description,
      model: this.model
    }
  }
}

interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolName?: string
  timestamp: number
}

interface TaskInfo {
  id: string
  description: string
  tool?: string
  input?: any
  delegatedFrom?: string
  assignedAt?: number
  error?: string
}

export interface AgentSummary {
  id: string
  name: string
  type: AgentType
  role: string
  status: AgentStatus
  tools: string[]
  skills: string[]
  messageCount: number
  currentTask?: string
  model: string
}

// ==================== 预定义角色 ====================

export const AGENT_ROLES: Record<string, {
  type: AgentType
  description: string
  tools: string[]
  skills: string[]
  permissions: Record<string, PermissionMode>
}> = {
  COORDINATOR: {
    type: 'coordinator',
    description: '主控Agent - 理解用户目标、分解任务、分配给Workers，综合结果',
    tools: ['agent', 'task', 'bash', 'read', 'write', 'edit', 'memory'],
    skills: ['general'],
    permissions: { agent: 'always_allow', task: 'always_allow', bash: 'prompt', memory: 'always_allow' }
  },
  CODER: {
    type: 'worker',
    description: '编程专家 - 编写代码、调试、修复bug',
    tools: ['bash', 'read', 'write', 'edit', 'grep', 'glob'],
    skills: ['coder', 'general'],
    permissions: { bash: 'prompt', read: 'always_allow', write: 'always_allow', edit: 'always_allow' }
  },
  REVIEWER: {
    type: 'worker',
    description: '代码审查专家 - 审查代码、发现问题、提出改进建议',
    tools: ['read', 'grep', 'glob', 'bash'],
    skills: ['reviewer', 'coder'],
    permissions: { read: 'always_allow', grep: 'always_allow', glob: 'always_allow', bash: 'prompt' }
  },
  RESEARCHER: {
    type: 'worker',
    description: '调研专家 - 搜索资料，研究问题',
    tools: ['web_search', 'web_fetch', 'read', 'memory'],
    skills: ['researcher', 'general'],
    permissions: { web_search: 'always_allow', web_fetch: 'always_allow', read: 'always_allow', memory: 'always_allow' }
  },
  MEMORY_MANAGER: {
    type: 'worker',
    description: '记忆管理专家 - 整理、存储、检索记忆',
    tools: ['memory', 'read'],
    skills: ['memory', 'general'],
    permissions: { memory: 'always_allow', read: 'always_allow' }
  }
}

// ==================== 预定义团队 ====================

export const AGENT_TEAMS: Record<string, Array<{ role: string, name: string }>> = {
  FULL_STACK: [
    { role: 'COORDINATOR', name: 'MainCoordinator' },
    { role: 'CODER', name: 'Coder1' },
    { role: 'REVIEWER', name: 'Reviewer1' },
    { role: 'RESEARCHER', name: 'Researcher1' },
    { role: 'MEMORY_MANAGER', name: 'MemoryManager' }
  ],
  PHONEAI: [
    { role: 'COORDINATOR', name: 'PhoneCoordinator' },
    { role: 'CODER', name: 'Coder1' },
    { role: 'MEMORY_MANAGER', name: 'MemoryManager' }
  ],
  DEFAULT: [
    { role: 'COORDINATOR', name: 'MainCoordinator' },
    { role: 'CODER', name: 'Coder1' }
  ]
}
