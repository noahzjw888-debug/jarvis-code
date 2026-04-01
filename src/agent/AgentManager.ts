/**
 * JarvisCode Agent 管理器
 * 基于 Claude Code 的 AgentManager 架构
 */

import { Agent, AgentConfig, AGENT_ROLES, AGENT_TEAMS, AgentSummary, PermissionMode } from './Agent.ts'

export interface TaskDelegate {
  fromAgentId: string
  toAgentId: string
  task: {
    id: string
    description: string
    tool?: string
    input?: any
  }
}

export interface AgentMessage {
  id: string
  from: string | null
  to: string
  content: string
  timestamp: number
  read: boolean
}

export class AgentManager {
  agents: Map<string, Agent>
  coordinator: Agent | null
  currentTeam: string | null
  messageQueue: Map<string, AgentMessage[]>

  constructor() {
    this.agents = new Map()
    this.coordinator = null
    this.currentTeam = null
    this.messageQueue = new Map()
  }

  // ==================== Agent 创建 ====================

  createAgent(config: AgentConfig): Agent {
    // 解析角色配置
    let roleConfig = config.role ? AGENT_ROLES[config.role.toUpperCase()] : null
    
    const agent = new Agent({
      ...config,
      type: config.type || roleConfig?.type || 'worker',
      tools: config.tools || roleConfig?.tools || [],
      permissions: config.permissions || roleConfig?.permissions || {},
      skills: config.skills || roleConfig?.skills || [],
      systemPrompt: config.systemPrompt || roleConfig?.description || ''
    })

    this.agents.set(agent.id, agent)
    
    if (agent.type === 'coordinator') {
      this.coordinator = agent
    }

    return agent
  }

  createTeam(config: { name: string, members: Array<{ role: string, name: string }> }): Agent[] {
    this.currentTeam = config.name
    const created: Agent[] = []

    for (const member of config.members) {
      const agent = this.createAgent({
        name: member.name,
        role: member.role,
        teamName: config.name
      })
      created.push(agent)
    }

    return created
  }

  createPredefinedTeam(teamName: string): Agent[] {
    const config = AGENT_TEAMS[teamName.toUpperCase()]
    if (!config) throw new Error(`未知团队: ${teamName}`)
    return this.createTeam({ name: teamName, members: config })
  }

  // ==================== Agent 查询 ====================

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id)
  }

  getAgentByName(name: string): Agent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.name === name) return agent
    }
    return undefined
  }

  listAgents(filter?: { type?: string, status?: string, role?: string, team?: string }): Agent[] {
    let agents = Array.from(this.agents.values())
    
    if (filter?.type) {
      agents = agents.filter(a => a.type === filter.type)
    }
    if (filter?.status) {
      agents = agents.filter(a => a.status === filter.status)
    }
    if (filter?.role) {
      agents = agents.filter(a => a.role === filter.role)
    }
    if (filter?.team) {
      agents = agents.filter(a => a.teamName === filter.team)
    }
    
    return agents
  }

  getCoordinator(): Agent | null {
    return this.coordinator
  }

  getWorkers(): Agent[] {
    return this.listAgents({ type: 'worker' })
  }

  // ==================== 消息系统 ====================

  sendMessage(toAgentId: string, content: string, fromAgentId: string | null = null): AgentMessage {
    const agent = this.agents.get(toAgentId)
    if (!agent) throw new Error(`Agent不存在: ${toAgentId}`)

    const message: AgentMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      from: fromAgentId,
      to: toAgentId,
      content,
      timestamp: Date.now(),
      read: false
    }

    if (!this.messageQueue.has(toAgentId)) {
      this.messageQueue.set(toAgentId, [])
    }
    this.messageQueue.get(toAgentId)!.push(message)
    
    // 添加到 Agent 的消息历史
    agent.addMessage('user', content)

    return message
  }

  getMessages(agentId: string, unreadOnly = false): AgentMessage[] {
    const messages = this.messageQueue.get(agentId) || []
    if (unreadOnly) return messages.filter(m => !m.read)
    return messages
  }

  markMessageRead(messageId: string, agentId: string) {
    const messages = this.messageQueue.get(agentId)
    if (messages) {
      const msg = messages.find(m => m.id === messageId)
      if (msg) msg.read = true
    }
  }

  // ==================== 任务委托 ====================

  delegateTask(fromAgentId: string, toAgentId: string, task: {
    description: string
    tool?: string
    input?: any
  }): Agent {
    const worker = this.agents.get(toAgentId)
    if (!worker) throw new Error(`Worker不存在: ${toAgentId}`)

    // 检查工具权限
    if (task.tool && !worker.canUseTool(task.tool)) {
      throw new Error(`Worker无权使用工具: ${task.tool}`)
    }

    // 分配任务
    const taskInfo = {
      id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      description: task.description,
      tool: task.tool,
      input: task.input,
      delegatedFrom: fromAgentId
    }

    worker.assignTask(taskInfo)
    
    // 发送任务消息
    this.sendMessage(toAgentId, `新任务: ${task.description}`, fromAgentId)

    return worker
  }

  // ==================== 生命周期管理 ====================

  stopAgent(agentId: string): boolean {
    const agent = this.agents.get(agentId)
    if (!agent) return false
    agent.currentTask = undefined
    agent.setStatus('idle')
    return true
  }

  deleteAgent(agentId: string): boolean {
    const agent = this.agents.get(agentId)
    if (!agent) return false
    if (this.coordinator?.id === agentId) this.coordinator = null
    this.messageQueue.delete(agentId)
    return this.agents.delete(agentId)
  }

  deleteTeam(): void {
    for (const agent of this.agents.values()) {
      this.deleteAgent(agent.id)
    }
    this.currentTeam = null
  }

  // ==================== 状态查询 ====================

  getTeamStatus(): {
    teamName: string | null
    coordinator: AgentSummary | null
    workers: AgentSummary[]
    totalAgents: number
  } {
    return {
      teamName: this.currentTeam,
      coordinator: this.coordinator?.getSummary() || null,
      workers: this.getWorkers().map(w => w.getSummary()),
      totalAgents: this.agents.size
    }
  }

  checkToolPermission(agentId: string, toolName: string): { allowed: boolean, needsConfirmation?: boolean, reason?: string } {
    const agent = this.agents.get(agentId)
    if (!agent) return { allowed: false, reason: 'Agent不存在' }
    if (!agent.canUseTool(toolName)) {
      return { allowed: false, reason: `工具${toolName}未被授权` }
    }
    if (agent.needsConfirmation(toolName)) {
      return { allowed: true, needsConfirmation: true }
    }
    return { allowed: true }
  }

  // ==================== 配置更新 ====================

  updateAgentModel(agentId: string, model: string, apiKey?: string, apiUrl?: string) {
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`Agent不存在: ${agentId}`)
    
    agent.model = model
    if (apiKey) agent.apiKey = apiKey
    if (apiUrl) agent.apiUrl = apiUrl
  }

  updateAgentTools(agentId: string, tools: string[]) {
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`Agent不存在: ${agentId}`)
    
    agent.tools = tools
  }

  updateAgentPermissions(agentId: string, permissions: Record<string, PermissionMode>) {
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`Agent不存在: ${agentId}`)
    
    agent.permissions = { ...agent.permissions, ...permissions }
  }
}

// ==================== 全局实例 ====================

export const globalAgentManager = new AgentManager()
