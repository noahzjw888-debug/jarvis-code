/**
 * JarvisCode 核心执行循环
 * 真正模拟 Claude Code 的 query.ts 执行流程
 * 
 * Claude Code 核心流程:
 * 1. 构建消息 (system + context + history)
 * 2. 调用 AI (流式)
 * 3. 解析响应 (文本 + 工具调用)
 * 4. 执行工具
 * 5. 将工具结果加入消息历史
 * 6. 循环直到 AI 不再调用工具
 */

import https from 'https'
import http from 'http'
import { ToolManager } from '../tools/ToolManager.js'
import { MemoryStore } from '../memory/MemoryStore.js'

// ==================== 类型定义 ====================

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | ToolCall | ToolResult
  name?: string
  tool_call_id?: string
}

export interface ToolCall {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, any>
}

export interface ToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export interface ExecutionResult {
  success: boolean
  content: string
  toolCalls: ToolCall[]
  toolResults: ToolResult[]
  turns: number
  tokens?: { input: number, output: number }
}

// ==================== ClaudeStyleLoop ====================

export class ClaudeStyleLoop {
  private toolManager: ToolManager
  private memoryStore: MemoryStore
  private apiKey: string
  private model: string
  private apiUrl: string
  private maxTurns: number
  private tools: any[]

  constructor(config: {
    toolManager: ToolManager
    memoryStore: MemoryStore
    apiKey: string
    model?: string
    apiUrl?: string
    maxTurns?: number
  }) {
    this.toolManager = config.toolManager
    this.memoryStore = config.memoryStore
    this.apiKey = config.apiKey
    this.model = config.model || 'MiniMax-M2.7'
    this.apiUrl = config.apiUrl || 'https://api.minimax.chat/v1/chat/completions'
    this.maxTurns = config.maxTurns || 15
    this.tools = this.buildToolsSchema()
  }

  /**
   * 主执行循环 - 模拟 Claude Code 的 query.ts
   */
  async execute(userMessage: string, options?: {
    systemPrompt?: string
    context?: Record<string, string>
    workspace?: string
  }): Promise<ExecutionResult> {
    const messages: Message[] = []
    const toolResults: ToolResult[] = []
    let totalInputTokens = 0
    let totalOutputTokens = 0

    // 1. 构建系统提示
    const systemPrompt = options?.systemPrompt || this.getDefaultSystemPrompt(options?.workspace)
    messages.push({ role: 'system', content: systemPrompt })

    // 2. 添加上下文
    if (options?.context) {
      const contextStr = Object.entries(options.context)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
      messages.push({ role: 'system', content: `\n## 上下文\n${contextStr}` })
    }

    // 3. 添加记忆上下文
    const memoryContext = this.memoryStore.toPromptString()
    if (memoryContext) {
      messages.push({ role: 'system', content: memoryContext })
    }

    // 4. 添加用户消息
    messages.push({ role: 'user', content: userMessage })

    console.log(`\n========== ClaudeStyleLoop 执行 ==========`)
    console.log(`模型: ${this.model}`)
    console.log(`工具: ${this.tools.length} 个`)
    console.log(`最大回合: ${this.maxTurns}`)
    console.log(`==========================================\n`)

    // 5. 执行循环
    let turn = 0
    let finalContent = ''

    while (turn < this.maxTurns) {
      turn++
      console.log(`[Turn ${turn}/${this.maxTurns}] 调用 AI...`)

      // 调用 AI
      const response = await this.callAI(messages)

      if (response.error) {
        console.log(`[Turn ${turn}] API 错误: ${response.error}`)
        return {
          success: false,
          content: `错误: ${response.error}`,
          toolCalls: [],
          toolResults: toolResults,
          turns: turn
        }
      }

      totalInputTokens += response.usage?.input || 0
      totalOutputTokens += response.usage?.output || 0

      // 6. 解析响应
      const parsed = this.parseResponse(response.content)
      console.log(`[Turn ${turn}] 解析结果: ${parsed.text ? '文本' : ''} ${parsed.toolCalls.length} 个工具调用`)

      // 7. 如果有文本回复，添加到消息
      if (parsed.text) {
        finalContent += parsed.text + '\n'
        messages.push({
          role: 'assistant',
          content: parsed.text
        })
      }

      // 8. 如果有工具调用，执行它们
      if (parsed.toolCalls.length > 0) {
        console.log(`[Turn ${turn}] 执行 ${parsed.toolCalls.length} 个工具...`)

        for (const toolCall of parsed.toolCalls) {
          console.log(`[Turn ${turn}] 执行: ${toolCall.name}(${JSON.stringify(toolCall.input).substring(0, 50)}...)`)

          // 执行工具
          const result = await this.toolManager.execute(toolCall.name, toolCall.input)

          // 构建结果消息
          const toolResult: ToolResult = {
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: result.success
              ? JSON.stringify(result.data || result.output, null, 2)
              : `错误: ${result.error}`,
            is_error: !result.success
          }

          toolResults.push(toolResult)

          // 添加到消息历史
          messages.push({
            role: 'tool',
            content: toolResult.content,
            name: toolCall.name,
            tool_call_id: toolCall.id
          } as any)

          console.log(`[Turn ${turn}] ${toolCall.name} => ${result.success ? '成功' : '失败'}`)
        }
      } else {
        // 没有更多工具调用，结束
        console.log(`[Turn ${turn}] 没有更多工具调用，结束`)
        break
      }
    }

    console.log(`\n========== 执行完成 ==========`)
    console.log(`总回合: ${turn}`)
    console.log(`工具调用: ${toolResults.length} 次`)
    console.log(`=============================\n`)

    return {
      success: true,
      content: finalContent.trim(),
      toolCalls: [], // 已执行
      toolResults,
      turns: turn,
      tokens: { input: totalInputTokens, output: totalOutputTokens }
    }
  }

  /**
   * 调用 AI - 模拟 Claude Code 的 API 调用
   */
  private async callAI(messages: Message[]): Promise<{
    content: string
    error?: string
    usage?: { input: number, output: number }
  }> {
    // 构建请求
    const apiMessages = this.buildMessages(messages)

    return new Promise((resolve) => {
      const urlObj = new URL(this.apiUrl);
      console.log(`[DEBUG] API URL: ${this.apiUrl}`);
      console.log(`[DEBUG] Model: ${this.model}`);
      console.log(`[DEBUG] isAnthropicFormat: ${this.apiUrl.includes("/anthropic/")}`)
      const isHttps = urlObj.protocol === 'https:'
      const mod = isHttps ? https : http

      // 检查是否使用 Anthropic 格式
      const isAnthropicFormat = this.apiUrl.includes('/anthropic/')

      let body: string
      let headers: Record<string, string>

      if (isAnthropicFormat) {
        // Anthropic 格式
        body = JSON.stringify({
          model: this.model,
          messages: apiMessages,
          max_tokens: 4096
        })
        headers = {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body)
        }
      } else {
        // OpenAI 兼容格式
        const reqBody: any = {
          model: this.model,
          messages: apiMessages,
          max_tokens: 4096
        }
        if (this.tools.length > 0) {
          reqBody.tools = this.tools
        }
        body = JSON.stringify(reqBody)
        headers = {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers
      }

      const req = mod.request(options, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            const json = JSON.parse(data)

            if (res.statusCode !== 200) {
              resolve({
                content: '',
                error: `API错误 (${res.statusCode}): ${json.error?.message || json.base_resp?.status_msg || data.substring(0, 200)}`
              })
              return
            }

            let content = ''

            if (isAnthropicFormat) {
              // Anthropic 格式
              if (json.content) {
                for (const block of json.content) {
                  if (block.type === 'text') {
                    content += block.text
                  } else if (block.type === 'thinking') {
                    // 跳过 thinking
                  }
                }
              }
            } else {
              // OpenAI 格式
              content = json.choices?.[0]?.message?.content || ''
            }

            resolve({
              content,
              usage: {
                input: json.usage?.input_tokens || json.usage?.prompt_tokens || 0,
                output: json.usage?.output_tokens || json.usage?.completion_tokens || 0
              }
            })
          } catch (e: any) {
            resolve({
              content: '',
              error: `解析失败: ${e.message}`
            })
          }
        })
      })

      req.on('error', (e) => {
        resolve({
          content: '',
          error: e.message
        })
      })

      req.write(body)
      req.end()
    })
  }

  /**
   * 构建消息格式 - Anthropic API 只支持一个 system 消息
   */
  private buildMessages(msgs: Message[]): any[] {
    const result: any[] = []
    const systemParts: string[] = []

    for (const msg of msgs) {
      if (msg.role === 'system') {
        systemParts.push(String(msg.content))
      } else if (msg.role === 'user') {
        // 先添加合并后的 system 消息
        if (systemParts.length > 0) {
          result.push({ role: 'system', content: systemParts.join('\n\n') })
          systemParts.length = 0
        }
        result.push({ role: 'user', content: String(msg.content) })
      } else if (msg.role === 'assistant') {
        // 先添加合并后的 system 消息
        if (systemParts.length > 0) {
          result.push({ role: 'system', content: systemParts.join('\n\n') })
          systemParts.length = 0
        }
        result.push({ role: 'assistant', content: String(msg.content) })
      } else if (msg.role === 'tool') {
        // 先添加合并后的 system 消息
        if (systemParts.length > 0) {
          result.push({ role: 'system', content: systemParts.join('\n\n') })
          systemParts.length = 0
        }
        // 工具结果用 assistant 消息包装
        const toolContent = typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content)

        result.push({
          role: 'assistant',
          content: `[TOOL_RESULT:${msg.name}] ${toolContent}`
        })
      }
    }

    // 处理剩余的 system 消息
    if (systemParts.length > 0) {
      result.push({ role: 'system', content: systemParts.join('\n\n') })
    }

    return result
  }

  /**
   * 解析 AI 响应 - 支持工具调用格式
   */
  private parseResponse(content: string): {
    text: string
    toolCalls: ToolCall[]
  } {
    const toolCalls: ToolCall[] = []
    let text = content

    // 匹配 XML 格式的工具调用
    const regex = /<tool_call>\s*<tool_name>(\w+)<\/tool_name>\s*<tool_input>\s*([\s\S]*?)\s*<\/tool_input>\s*<\/tool_call>/g
    let match

    while ((match = regex.exec(content)) !== null) {
      const name = match[1]
      const inputStr = match[2].trim()

      try {
        let input = {}
        try {
          input = JSON.parse(inputStr)
        } catch {
          // 简单解析
          input = this.parseSimpleParams(inputStr)
        }

        toolCalls.push({
          type: 'tool_use',
          id: `tool_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          name,
          input
        })

        // 从文本中移除工具调用部分
        text = text.replace(match[0], '').trim()
      } catch (e) {
        console.error('解析工具调用失败:', e)
      }
    }

    return { text: text.trim(), toolCalls }
  }

  /**
   * 简单参数解析
   */
  private parseSimpleParams(str: string): Record<string, any> {
    const params: Record<string, any> = {}
    const lines = str.split('\n')

    for (const line of lines) {
      const colonIdx = line.indexOf(':')
      if (colonIdx > 0) {
        const key = line.substring(0, colonIdx).trim()
        let value = line.substring(colonIdx + 1).trim()

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
   * 构建工具 schema
   */
  private buildToolsSchema(): any[] {
    const tools = this.toolManager.listAll()

    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: tool.parameters.reduce((acc, p) => {
            acc[p.name] = { type: p.type, description: p.description }
            return acc
          }, {} as Record<string, any>),
          required: tool.parameters.filter(p => p.required).map(p => p.name)
        }
      }
    }))
  }

  /**
   * 获取默认系统提示
   */
  private getDefaultSystemPrompt(workspace?: string): string {
    return `你是 JarvisCode，一个专业的 AI 编程助手，由 MiniMax-M2.7 驱动。

## 核心能力
- 读取、编写、编辑文件
- 执行终端命令 (bash)
- 搜索文件内容 (grep)
- 创建目录和项目
- 运行代码和测试
- 创建和管理文件

## 工作目录
${workspace || '/home/andy/workspace'}

## 重要规则
1. 当需要执行操作时，使用工具调用格式
2. 每次只调用一个工具，等待结果后再决定下一步
3. 完成操作后简单总结结果
4. 如果出错，说明问题并尝试解决

## 工具调用格式
当需要执行操作时，输出:
<tool_call>
<tool_name>工具名</tool_name>
<tool_input>
{"param": "值"}
</tool_input>
</tool_call>

例如，创建文件:
<tool_call>
<tool_name>write</tool_name>
<tool_input>
{"path": "/home/andy/workspace/app.js", "content": "// 文件内容"}
</tool_input>
</tool_call>

执行命令:
<tool_call>
<tool_name>bash</tool_name>
<tool_input>
{"command": "ls -la /home/andy/workspace"}
</tool_input>
</tool_call>`
  }
}
