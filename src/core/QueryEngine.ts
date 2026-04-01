/**
 * JarvisCode 核心执行引擎
 * 基于 Claude Code 的 query.ts 和 toolOrchestration.ts
 */

import { AgentManager } from '../agent/AgentManager.js'
import { ToolManager } from '../tools/ToolManager.js'
import { MemoryStore } from '../memory/MemoryStore.js'
import { ModelAdapter } from '../models/ModelAdapter.js'

// ==================== 类型定义 ====================

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolName?: string
  toolInput?: any
  toolResult?: any
}

export interface ToolCall {
  name: string
  input: Record<string, any>
  id: string
}

export interface QueryResult {
  content: string
  toolCalls?: ToolCall[]
  error?: string
}

// ==================== QueryEngine 类 ====================

export class QueryEngine {
  private agentManager: AgentManager
  private toolManager: ToolManager
  private memoryStore: MemoryStore
  private model: ModelAdapter
  private maxTurns: number = 10

  constructor(config: {
    agentManager: AgentManager
    toolManager: ToolManager
    memoryStore: MemoryStore
    model: ModelAdapter
  }) {
    this.agentManager = config.agentManager
    this.toolManager = config.toolManager
    this.memoryStore = config.memoryStore
    this.model = config.model
  }

  /**
   * 处理用户查询 - 核心执行循环
   * 参考 Claude Code 的 query.ts
   */
  async processQuery(userMessage: string, options?: {
    agentId?: string
    systemPrompt?: string
    maxTurns?: number
  }): Promise<{
    content: string
    toolResults?: any[]
    turns: number
  }> {
    const maxTurns = options?.maxTurns || this.maxTurns
    const agentId = options?.agentId
    const systemPrompt = options?.systemPrompt || this.getDefaultSystemPrompt()

    // 构建消息历史
    const messages: Message[] = []

    // 添加系统提示
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
    }

    // 添加用户消息
    messages.push({ role: 'user', content: userMessage })

    // 添加工具使用历史
    let turn = 0
    let finalContent = ''

    // 执行循环 - 参考 Claude Code 的主循环
    while (turn < maxTurns) {
      turn++
      console.log(`[Turn ${turn}] 调用 AI...`)

      // 调用 AI
      const response = await this.callAI(messages)
      
      if (response.error) {
        return { content: `错误: ${response.error}`, turns: turn }
      }

      finalContent = response.content || ''

      // 检查是否有工具调用
      if (response.toolCalls && response.toolCalls.length > 0) {
        console.log(`[Turn ${turn}] 执行 ${response.toolCalls.length} 个工具调用`)

        // 执行工具
        for (const toolCall of response.toolCalls) {
          console.log(`[Turn ${turn}] 执行工具: ${toolCall.name}`)
          
          const result = await this.executeTool(toolCall)
          
          // 将工具结果添加到消息历史
          messages.push({
            role: 'tool',
            content: result.success ? JSON.stringify(result.data || result.output) : `错误: ${result.error}`,
            toolName: toolCall.name,
            toolInput: toolCall.input,
            toolResult: result
          })
        }
      } else {
        // 没有工具调用，返回结果
        break
      }
    }

    return {
      content: finalContent,
      turns
    }
  }

  /**
   * 调用 AI 模型
   */
  private async callAI(messages: Message[]): Promise<QueryResult> {
    // 构建提示
    const prompt = this.buildPrompt(messages)

    // 调用模型
    const response = await this.model.chat(prompt)

    if (!response.success || !response.content) {
      return { content: '', error: response.error }
    }

    // 解析响应 - 检查是否包含工具调用
    const toolCalls = this.parseToolCalls(response.content)

    return {
      content: toolCalls.length > 0 ? '' : response.content,
      toolCalls
    }
  }

  /**
   * 解析工具调用
   * Claude Code 使用 XML 格式: <tool_call>...</tool_call>
   */
  private parseToolCalls(content: string): ToolCall[] {
    const toolCalls: ToolCall[] = []
    
    // 匹配 XML 格式的工具调用
    const toolCallRegex = /<tool_call>\s*<tool_name>(\w+)<\/tool_name>\s*<tool_input>([\s\S]*?)<\/tool_input>\s*<\/tool_call>/g
    let match
    
    while ((match = toolCallRegex.exec(content)) !== null) {
      const toolName = match[1]
      const toolInputStr = match[2].trim()
      
      try {
        // 尝试解析 JSON
        const toolInput = this.parseJsonParams(toolInputStr)
        toolCalls.push({
          name: toolName,
          input: toolInput,
          id: `tool_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`
        })
      } catch (e) {
        console.error(`解析工具参数失败: ${toolInputStr}`)
      }
    }

    return toolCalls
  }

  /**
   * 解析工具参数
   */
  private parseJsonParams(str: string): Record<string, any> {
    // 尝试直接解析
    try {
      return JSON.parse(str)
    } catch (e) {}

    // 尝试提取 JSON 对象
    const jsonMatch = str.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0])
      } catch (e) {}
    }

    // 尝试简单的 key=value 格式
    const params: Record<string, any> = {}
    const lines = str.split('\n')
    for (const line of lines) {
      const colonIndex = line.indexOf(':')
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim()
        let value = line.substring(colonIndex + 1).trim()
        
        // 去除引号
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        
        params[key] = value
      }
    }
    
    return params
  }

  /**
   * 执行工具
   */
  private async executeTool(toolCall: ToolCall): Promise<{
    success: boolean
    output?: string
    data?: any
    error?: string
  }> {
    const { name, input } = toolCall

    try {
      const result = await this.toolManager.execute(name, input)
      return result
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  /**
   * 构建提示
   */
  private buildPrompt(messages: Message[]): string {
    const parts: string[] = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        parts.push(`<system>\n${msg.content}\n</system>`)
      } else if (msg.role === 'user') {
        parts.push(`<user>\n${msg.content}\n</user>`)
      } else if (msg.role === 'assistant') {
        parts.push(`<assistant>\n${msg.content}\n</assistant>`)
      } else if (msg.role === 'tool') {
        const result = msg.toolResult
        const output = result?.success ? 
          JSON.stringify(result.data || result.output, null, 2) : 
          `错误: ${result?.error}`
        
        parts.push(`<tool_result>\n<tool_name>${msg.toolName}</tool_name>\n<tool_output>\n${output}\n</tool_output>\n</tool_result>`)
      }
    }

    // 添加工具说明
    const toolsPrompt = this.buildToolsPrompt()
    parts.push(`<tools>\n${toolsPrompt}\n</tools>`)

    // 添加指令
    parts.push(`<instruction>
当你需要执行操作时，使用工具调用格式:
<tool_call>
<tool_name>工具名</tool_name>
<tool_input>
{"param": "值"}
</tool_input>
</tool_call>

可用的工具: ${this.toolManager.listAll().map(t => t.name).join(', ')}
</instruction>`)

    return parts.join('\n\n')
  }

  /**
   * 构建工具提示
   */
  private buildToolsPrompt(): string {
    const tools = this.toolManager.listAll()
    const lines: string[] = []

    for (const tool of tools) {
      const params = tool.parameters
        .map(p => `  ${p.name}: ${p.description} (${p.type})`)
        .join('\n')
      
      lines.push(`${tool.name}:\n${params}`)
    }

    return lines.join('\n\n')
  }

  /**
   * 获取默认系统提示
   */
  private getDefaultSystemPrompt(): string {
    return `你是 JarvisCode，一个专业的 AI 编程助手。

你可以：
- 读取、编写、编辑文件
- 执行终端命令
- 搜索文件内容
- 创建目录和项目
- 运行代码和测试

工作目录: /home/andy/workspace

当你需要执行操作时，必须使用工具调用格式。
如果用户要求你执行代码相关的任务，先查看现有文件结构，然后编写代码。
完成重要操作后，简单总结结果。`
  }

  /**
   * 设置最大回合数
   */
  setMaxTurns(maxTurns: number) {
    this.maxTurns = maxTurns
  }
}
