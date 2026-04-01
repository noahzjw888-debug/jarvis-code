/**
 * JarvisCode 模型适配器
 * 支持多种 AI 模型: MiniMax, Claude, GPT, Gemini, Kimi, DeepSeek, Qwen 等
 */

import https from 'https'
import http from 'http'

// ==================== 类型定义 ====================

export interface ModelConfig {
  model: string
  apiKey: string
  apiUrl?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ChatResult {
  success: boolean
  content?: string
  error?: string
  model?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
}

// ==================== 模型配置 ====================

const MODEL_CONFIGS: Record<string, (config: ModelConfig) => ModelRequestConfig> = {
  minimax: (config) => ({
    url: config.apiUrl || 'https://api.minimax.chat/v1/chat/completions',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: {
      model: 'MiniMax-M2.7',
      messages: [] as ChatMessage[],
      max_tokens: 4096
    },
    responseExtractor: (data: any) => data.choices?.[0]?.message?.content || ''
  }),

  claude: (config) => ({
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'x-api-key': config.apiKey,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01'
    },
    body: {
      model: 'claude-3-5-sonnet-20241022',
      messages: [] as ChatMessage[],
      max_tokens: 4096
    },
    responseExtractor: (data: any) => data.content?.[0]?.text || ''
  }),

  gpt: (config) => ({
    url: 'https://api.openai.com/v1/chat/completions',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: {
      model: 'gpt-4o',
      messages: [] as ChatMessage[],
      max_tokens: 4096
    },
    responseExtractor: (data: any) => data.choices?.[0]?.message?.content || ''
  }),

  gemini: (config) => ({
    url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.apiKey}`,
    headers: { 'Content-Type': 'application/json' },
    body: {
      contents: [] as any[],
      generationConfig: { maxOutputTokens: 4096 }
    },
    prepareBody: (messages: ChatMessage[]) => ({
      contents: messages.map(m => ({ parts: [{ text: m.content }] }))
    }),
    responseExtractor: (data: any) => data.candidates?.[0]?.content?.parts?.[0]?.text || ''
  }),

  kimi: (config) => ({
    url: 'https://api.moonshot.cn/v1/chat/completions',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: {
      model: 'moonshot-v1-8k',
      messages: [] as ChatMessage[],
      max_tokens: 4096
    },
    responseExtractor: (data: any) => data.choices?.[0]?.message?.content || ''
  }),

  deepseek: (config) => ({
    url: 'https://api.deepseek.com/v1/chat/completions',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: {
      model: 'deepseek-chat',
      messages: [] as ChatMessage[],
      max_tokens: 4096
    },
    responseExtractor: (data: any) => data.choices?.[0]?.message?.content || ''
  }),

  qwen: (config) => ({
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: {
      model: 'qwen-plus',
      messages: [] as ChatMessage[],
      max_tokens: 4096
    },
    responseExtractor: (data: any) => data.choices?.[0]?.message?.content || ''
  }),

  siliconflow: (config) => ({
    url: 'https://api.siliconflow.cn/v1/chat/completions',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: {
      model: 'deepseek-ai/DeepSeek-V3',
      messages: [] as ChatMessage[],
      max_tokens: 4096
    },
    responseExtractor: (data: any) => data.choices?.[0]?.message?.content || ''
  })
}

interface ModelRequestConfig {
  url: string
  headers: Record<string, string>
  body: any
  prepareBody?: (messages: ChatMessage[]) => any
  responseExtractor: (data: any) => string
}

// ==================== ModelAdapter 类 ====================

export class ModelAdapter {
  config: ModelConfig
  messages: ChatMessage[]
  systemPrompt: string

  constructor(config: ModelConfig) {
    this.config = config
    this.messages = []
    this.systemPrompt = ''
  }

  setSystemPrompt(prompt: string) {
    this.systemPrompt = prompt
    this.messages = []
  }

  async chat(message: string): Promise<ChatResult> {
    // 添加用户消息
    this.messages.push({ role: 'user', content: message })

    try {
      const result = await this.sendRequest()
      
      if (result.error) {
        return result
      }

      // 添加助手回复
      if (result.content) {
        this.messages.push({ role: 'assistant', content: result.content })
      }

      return result
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendRequest(): Promise<ChatResult> {
    const modelKey = this.getModelKey()
    const getConfig = MODEL_CONFIGS[modelKey]
    
    if (!getConfig) {
      return { success: false, error: `未知模型: ${this.config.model}` }
    }

    const modelConfig = getConfig(this.config)
    
    // 准备消息
    const allMessages: ChatMessage[] = []
    if (this.systemPrompt) {
      allMessages.push({ role: 'system', content: this.systemPrompt })
    }
    allMessages.push(...this.messages)

    // 构建请求体
    const body = modelConfig.prepareBody 
      ? modelConfig.prepareBody(allMessages)
      : { ...modelConfig.body, messages: allMessages }

    return this.httpRequest(modelConfig.url, modelConfig.headers, body, modelConfig.responseExtractor)
  }

  private getModelKey(): string {
    // 从模型名称提取key
    const model = this.config.model.toLowerCase()
    
    if (model.includes('minimax')) return 'minimax'
    if (model.includes('claude')) return 'claude'
    if (model.includes('gpt') || model.includes('openai')) return 'gpt'
    if (model.includes('gemini')) return 'gemini'
    if (model.includes('kimi') || model.includes('moonshot')) return 'kimi'
    if (model.includes('deepseek')) return 'deepseek'
    if (model.includes('qwen')) return 'qwen'
    if (model.includes('silicon')) return 'siliconflow'
    
    return this.config.model
  }

  private httpRequest(url: string, headers: Record<string, string>, body: any, extractor: (data: any) => string): Promise<ChatResult> {
    return new Promise((resolve) => {
      const urlObj = new URL(url)
      const isHttps = urlObj.protocol === 'https:'
      const mod = isHttps ? https : http

      const bodyStr = JSON.stringify(body)
      
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(bodyStr)
        }
      }

      const req = mod.request(options, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            
            if (res.statusCode !== 200) {
              resolve({
                success: false,
                error: `API错误 (${res.statusCode}): ${json.error?.message || data.substring(0, 200)}`
              })
              return
            }

            const content = extractor(json)
            
            resolve({
              success: true,
              content,
              model: this.config.model,
              usage: json.usage
            })
          } catch (e) {
            resolve({
              success: false,
              error: `解析失败: ${data.substring(0, 200)}`
            })
          }
        })
      })

      req.on('error', e => resolve({ success: false, error: e.message }))
      req.write(bodyStr)
      req.end()
    })
  }

  clear() {
    this.messages = []
  }

  // 更新配置
  updateConfig(model: string, apiKey: string, apiUrl?: string) {
    this.config.model = model
    this.config.apiKey = apiKey
    if (apiUrl) this.config.apiUrl = apiUrl
    this.messages = [] // 清空对话历史
  }
}

// ==================== 便捷函数 ====================

export function createModelAdapter(model: string, apiKey: string, apiUrl?: string): ModelAdapter {
  return new ModelAdapter({ model, apiKey, apiUrl })
}

// 获取支持的模型列表
export function getSupportedModels(): Array<{ id: string, name: string, provider: string }> {
  return [
    { id: 'minimax', name: 'MiniMax-M2.7', provider: 'MiniMax' },
    { id: 'claude', name: 'Claude 3.5 Sonnet', provider: 'Anthropic' },
    { id: 'gpt', name: 'GPT-4o', provider: 'OpenAI' },
    { id: 'gemini', name: 'Gemini 2.0 Flash', provider: 'Google' },
    { id: 'kimi', name: 'Kimi', provider: 'Moonshot' },
    { id: 'deepseek', name: 'DeepSeek V3', provider: 'DeepSeek' },
    { id: 'qwen', name: 'Qwen Plus', provider: 'Alibaba' },
    { id: 'siliconflow', name: 'SiliconFlow (DeepSeek)', provider: 'SiliconFlow' }
  ]
}
