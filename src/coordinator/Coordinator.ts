/**
 * JarvisCode Coordinator 系统
 * 基于 Claude Code 的 Coordinator Mode 架构
 */

import { AgentManager } from '../agent/AgentManager.ts'
import { ToolManager } from '../tools/ToolManager.ts'
import { ModelAdapter, createModelAdapter, ChatMessage } from '../models/ModelAdapter.ts'
import { globalMemoryStore } from '../memory/MemoryStore.ts'

// ==================== 类型定义 ====================

export interface CoordinatorConfig {
  agentManager: AgentManager
  toolManager: ToolManager
  globalModel: string
  globalApiKey: string
  globalApiUrl?: string
}

export interface AgentResult {
  agentId: string
  agentName: string
  status: 'completed' | 'failed' | 'stopped'
  result?: string
  error?: string
  usage?: {
    total_tokens?: number
    duration_ms?: number
  }
}

// ==================== Coordinator 类 ====================

export class Coordinator {
  private agentManager: AgentManager
  private toolManager: ToolManager
  private globalModel: string
  private globalApiKey: string
  private globalApiUrl?: string
  private model: ModelAdapter

  constructor(config: CoordinatorConfig) {
    this.agentManager = config.agentManager
    this.toolManager = config.toolManager
    this.globalModel = config.globalModel
    this.globalApiKey = config.globalApiKey
    this.globalApiUrl = config.globalApiUrl
    
    this.model = createModelAdapter(
      this.globalModel,
      this.globalApiKey,
      this.globalApiUrl
    )
  }

  // ==================== 核心方法 ====================

  /**
   * 处理用户消息
   */
  async processMessage(userMessage: string): Promise<{
    response: string
    tasks: string[]
    agentResults?: AgentResult[]
  }> {
    // 1. 理解用户意图
    const intent = await this.understandIntent(userMessage)
    
    // 2. 根据意图决定如何处理
    if (intent.shouldDelegate) {
      // 需要委托给 Worker
      return await this.handleDelegation(userMessage, intent)
    } else {
      // 直接回复用户
      const response = await this.directResponse(userMessage)
      return { response, tasks: [] }
    }
  }

  /**
   * 理解用户意图
   */
  private async understandIntent(message: string): Promise<{
    shouldDelegate: boolean
    task?: string
    targetAgent?: string
    tools?: string[]
  }> {
    const lower = message.toLowerCase()
    
    // 检查是否需要委托
    const delegateKeywords = [
      '写代码', '写一个', '帮我创建', '修改', '实现',
      '调查', '研究', '搜索', '查找',
      '优化', '重构', '修复', '调试',
      '测试', '运行', '执行',
      '分析', '审查', '检查'
    ]
    
    const needsDelegate = delegateKeywords.some(k => lower.includes(k))
    
    // 确定目标Agent类型
    let targetAgent = 'Coder1'
    if (lower.includes('搜索') || lower.includes('调查') || lower.includes('研究')) {
      targetAgent = 'Researcher1'
    } else if (lower.includes('审查') || lower.includes('检查') || lower.includes('分析')) {
      targetAgent = 'Reviewer1'
    } else if (lower.includes('记忆') || lower.includes('记住')) {
      targetAgent = 'MemoryManager'
    }

    return {
      shouldDelegate: needsDelegate,
      task: needsDelegate ? message : undefined,
      targetAgent: needsDelegate ? targetAgent : undefined
    }
  }

  /**
   * 处理委托
   */
  private async handleDelegation(userMessage: string, intent: {
    task?: string
    targetAgent?: string
  }): Promise<{
    response: string
    tasks: string[]
    agentResults?: AgentResult[]
  }> {
    const coordinator = this.agentManager.getCoordinator()
    if (!coordinator) {
      return { response: '错误: 未找到Coordinator', tasks: [] }
    }

    // 委托给 Worker
    const worker = intent.targetAgent 
      ? this.agentManager.getAgentByName(intent.targetAgent)
      : this.agentManager.getAgentByName('Coder1')

    if (!worker) {
      return { response: `错误: 未找到Agent ${intent.targetAgent}`, tasks: [] }
    }

    // 委托任务
    const task = intent.task!
    const taskInfo = this.agentManager.delegateTask(coordinator.id, worker.id, {
      description: task,
      tool: 'bash'
    })

    // 执行任务
    const result = await this.executeTask(worker, task)

    // 生成响应
    const response = this.generateResponse(task, worker.name, result)

    return {
      response,
      tasks: [taskInfo.id],
      agentResults: [result]
    }
  }

  /**
   * 执行任务
   */
  private async executeTask(agent: any, taskDescription: string): Promise<AgentResult> {
    const startTime = Date.now()
    
    try {
      // 构建 Worker 的系统提示
      const systemPrompt = this.buildWorkerSystemPrompt(agent)
      
      // 构建任务提示
      const taskPrompt = `
## 任务
${taskDescription}

## 工作目录
${this.toolManager.workspace}

## 工具
${agent.tools.join(', ')}

请执行任务并报告结果。
`

      // 创建 Agent 的 Model Adapter
      const agentModel = createModelAdapter(
        agent.model || this.globalModel,
        agent.apiKey || this.globalApiKey,
        agent.apiUrl || this.globalApiUrl
      )
      agentModel.setSystemPrompt(systemPrompt)

      // 执行
      const result = await agentModel.chat(taskPrompt)

      const duration = Date.now() - startTime

      if (result.success) {
        return {
          agentId: agent.id,
          agentName: agent.name,
          status: 'completed',
          result: result.content,
          usage: { duration_ms: duration }
        }
      } else {
        return {
          agentId: agent.id,
          agentName: agent.name,
          status: 'failed',
          error: result.error,
          usage: { duration_ms: duration }
        }
      }
    } catch (e: any) {
      return {
        agentId: agent.id,
        agentName: agent.name,
        status: 'failed',
        error: e.message
      }
    }
  }

  /**
   * 构建 Worker 系统提示
   */
  private buildWorkerSystemPrompt(agent: any): string {
    const toolsHelp = agent.tools.map((toolName: string) => {
      const tool = this.toolManager.get(toolName)
      if (!tool) return `- ${toolName}`
      
      const params = tool.parameters
        .map(p => `${p.name}: ${p.description}`)
        .join(', ')
      
      return `- ${toolName}: ${tool.description} (参数: ${params})`
    }).join('\n')

    return `你是 ${agent.name}，一个专业的 ${agent.role}。

## 你的角色
${agent.systemPrompt || '执行分配给你的任务'}

## 你可以使用的工具
${toolsHelp}

## 工作目录
${this.toolManager.workspace}

## 重要规则
1. 使用工具完成实际工作，而不是仅仅描述
2. 报告你做了什么，产生了什么结果
3. 如果遇到错误，说明问题并尝试解决
4. 完成后清楚说明结果
`
  }

  /**
   * 直接响应用户（不需要委托）
   */
  private async directResponse(message: string): Promise<string> {
    // 获取记忆上下文
    const memoryContext = globalMemoryStore.toPromptString()
    
    // 构建提示
    const prompt = memoryContext 
      ? `${memoryContext}\n\n## 用户消息\n${message}`
      : message

    this.model.setSystemPrompt(`你是一个专业的编程助手，叫JarvisCode。
你可以回答问题、解释概念、提供建议。
保持简洁、直接、有帮助的风格。`)

    const result = await this.model.chat(prompt)
    
    if (result.success && result.content) {
      return result.content
    } else {
      return `抱歉，发生了错误: ${result.error}`
    }
  }

  /**
   * 生成响应
   */
  private generateResponse(task: string, agentName: string, result: AgentResult): string {
    if (result.status === 'completed') {
      return `✅ **任务已完成**\n\n` +
        `**执行者**: ${agentName}\n\n` +
        `**结果**:\n${result.result || '任务完成，无输出'}\n\n` +
        `**耗时**: ${result.usage?.duration_ms || 0}ms`
    } else {
      return `❌ **任务失败**\n\n` +
        `**执行者**: ${agentName}\n\n` +
        `**错误**: ${result.error}\n\n` +
        `请告诉我如何继续。`
    }
  }

  // ==================== 配置更新 ====================

  updateConfig(model: string, apiKey: string, apiUrl?: string) {
    this.globalModel = model
    this.globalApiKey = apiKey
    this.globalApiUrl = apiUrl
    
    this.model = createModelAdapter(model, apiKey, apiUrl)
  }
}
