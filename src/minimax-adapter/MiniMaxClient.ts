/**
 * MiniMax API 适配器
 * 替换 Claude Code 的 @anthropic-ai/sdk
 * 
 * 这样 Claude Code 的 query.ts 等核心代码就可以直接使用 MiniMax
 */

import https from 'https'
import http from 'http'

// ==================== 类型定义 ====================

export interface MessageParam {
  role: 'user' | 'assistant' | 'system'
  content: string | ContentBlock[]
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: any
  content?: string
  is_error?: boolean
}

export interface Tool {
  name: string
  description?: string
  input_schema: {
    type: 'object'
    properties?: Record<string, any>
    required?: string[]
  }
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, any>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

// ==================== MiniMax Client ====================

export class MiniMaxClient {
  private apiKey: string
  private baseUrl: string

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl || 'https://api.minimax.chat/v1'
  }

  /**
   * 发送消息 - 模拟 Anthropic 的 messages.create API
   */
  async messages.create(params: {
    model: string
    messages: MessageParam[]
    max_tokens: number
    tools?: Tool[]
    stream?: boolean
    system?: string
  }): Promise<{
    id: string
    type: string
    role: 'assistant'
    content: ContentBlock[]
    model: string
    stop_reason: string
    usage: {
      input_tokens: number
      output_tokens: number
    }
  }> {
    // 将消息格式转换为 MiniMax 格式
    const messages = this.convertMessages(params.messages, params.system)

    // 调用 MiniMax API
    const result = await this.callMiniMax({
      model: params.model,
      messages,
      max_tokens: params.max_tokens,
      tools: params.tools
    })

    // 将结果转换回 Anthropic 格式
    return this.convertResponse(result)
  }

  /**
   * 流式发送消息
   */
  async messages.stream(params: {
    model: string
    messages: MessageParam[]
    max_tokens: number
    tools?: Tool[]
    system?: string
  }): AsyncGenerator<StreamEvent> {
    const messages = this.convertMessages(params.messages, params.system)

    // 调用 MiniMax 流式 API
    const response = await this.callMiniMaxStream({
      model: params.model,
      messages,
      max_tokens: params.max_tokens,
      tools: params.tools
    })

    // 转换流式事件
    for await (const chunk of response) {
      yield this.convertStreamEvent(chunk)
    }
  }

  // ==================== 转换函数 ====================

  private convertMessages(msgs: MessageParam[], system?: string): any[] {
    const result: any[] = []

    // 添加系统消息
    if (system) {
      result.push({ role: 'system', content: system })
    }

    // 转换用户消息
    for (const msg of msgs) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'user', content: msg.content })
        } else {
          // 处理多模态内容
          const textParts = msg.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n')
          if (textParts) {
            result.push({ role: 'user', content: textParts })
          }
        }
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'assistant', content: msg.content })
        } else {
          // 处理工具调用
          const textParts = msg.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n')
          if (textParts) {
            result.push({ role: 'assistant', content: textParts })
          }
        }
      } else if (msg.role === 'tool') {
        // MiniMax 使用 tool 角色
        result.push({ role: 'tool', content: msg.content })
      }
    }

    return result
  }

  private convertResponse(result: any): any {
    const content: ContentBlock[] = []

    // 解析 MiniMax 响应
    let text = ''
    if (result.choices?.[0]?.message?.content) {
      text = result.choices[0].message.content
    }

    // 检查是否包含工具调用
    const toolCalls = this.parseToolCalls(text)

    if (toolCalls.length > 0) {
      // 返回工具调用
      for (const tc of toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input
        })
      }
    } else {
      // 返回文本
      content.push({ type: 'text', text })
    }

    return {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content,
      model: result.model || 'MiniMax-M2.7',
      stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage: {
        input_tokens: result.usage?.prompt_tokens || 0,
        output_tokens: result.usage?.completion_tokens || 0
      }
    }
  }

  private parseToolCalls(text: string): ToolUseBlock[] {
    const calls: ToolUseBlock[] = []

    // 匹配 XML 格式的工具调用
    const regex = /<tool_call>\s*<tool_name>(\w+)<\/tool_name>\s*<tool_input>\s*([\s\S]*?)\s*<\/tool_input>\s*<\/tool_call>/g
    let match

    while ((match = regex.exec(text)) !== null) {
      const name = match[1]
      const inputStr = match[2].trim()

      try {
        // 尝试解析 JSON
        let input = {}
        try {
          input = JSON.parse(inputStr)
        } catch {
          // 尝试简单解析
          const params: Record<string, string> = {}
          const lines = inputStr.split('\n')
          for (const line of lines) {
            const colonIdx = line.indexOf(':')
            if (colonIdx > 0) {
              const key = line.substring(0, colonIdx).trim()
              let value = line.substring(colonIdx + 1).trim()
              if ((value.startsWith('"') && value.endsWith('"')) ||
                  (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1)
              }
              params[key] = value
            }
          }
          input = params
        }

        calls.push({
          type: 'tool_use',
          id: `tool_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          name,
          input
        })
      } catch (e) {
        console.error('Failed to parse tool call:', e)
      }
    }

    return calls
  }

  private *convertStreamEvent(chunk: string): StreamEvent {
    // 解析 SSE 格式的 chunk
    const lines = chunk.split('\n')
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6)
        if (data === '[DONE]') {
          return
        }

        try {
          const json = JSON.parse(data)
          
          // 转换 MiniMax 格式到 Anthropic 格式
          if (json.choices?.[0]?.delta?.content) {
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'text_delta',
                text: json.choices[0].delta.content
              }
            }
          }
        } catch (e) {}
      }
    }
  }

  // ==================== MiniMax API 调用 ====================

  private callMiniMax(params: {
    model: string
    messages: any[]
    max_tokens: number
    tools?: Tool[]
  }): Promise<any> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: params.model,
        messages: params.messages,
        max_tokens: params.max_tokens
      })

      const options = {
        hostname: 'api.minimax.chat',
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }

      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(e)
          }
        })
      })

      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }

  private async *callMiniMaxStream(params: {
    model: string
    messages: any[]
    max_tokens: number
    tools?: Tool[]
  }): AsyncGenerator<string> {
    // 简化的流式实现
    const result = await this.callMiniMax(params)
    const text = result.choices?.[0]?.message?.content || ''

    // 模拟流式输出
    const words = text.split(' ')
    for (const word of words) {
      yield `data: ${JSON.stringify({ choices: [{ delta: { content: word + ' ' } }] })}\n\n`
      await new Promise(r => setTimeout(r, 10))
    }
    yield 'data: [DONE]\n\n'
  }
}

// ==================== 流式事件类型 ====================

export interface StreamEvent {
  type: 'content_block_delta' | 'message_start' | 'message_delta' | 'message_stop'
  index?: number
  delta?: {
    type: 'text_delta'
    text: string
  }
  usage?: {
    input_tokens: number
    output_tokens: number
  }
}

// ==================== 创建客户端工厂 ====================

export function createClient(apiKey: string, baseUrl?: string): MiniMaxClient {
  return new MiniMaxClient(apiKey, baseUrl)
}
