/**
 * JarvisCode 工具系统
 * 基于 Claude Code 的 43 个工具架构
 */

import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'

// ==================== 类型定义 ====================

export interface ToolResult {
  success: boolean
  output?: string
  error?: string
  data?: any
}

export interface Tool {
  name: string
  description: string
  parameters: ToolParameter[]
  execute: (args: ToolArgs, context: ToolContext) => Promise<ToolResult>
}

export interface ToolParameter {
  name: string
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  description: string
  required?: boolean
  default?: any
}

export interface ToolArgs {
  [key: string]: any
}

export interface ToolContext {
  workspace: string
  agentId?: string
  onProgress?: (message: string) => void
}

// ==================== 工具实现 ====================

// BashTool - 执行shell命令
const BashTool: Tool = {
  name: 'bash',
  description: '执行shell命令',
  parameters: [
    { name: 'command', type: 'string', description: '要执行的命令', required: true },
    { name: 'cwd', type: 'string', description: '工作目录' }
  ],
  execute: async (args, context) => {
    return new Promise((resolve) => {
      context.onProgress?.(`执行: ${args.command}`)
      
      const proc = spawn(args.command, [], {
        shell: true,
        cwd: args.cwd || context.workspace,
        env: { ...process.env, HOME: process.env.HOME }
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data) => { stdout += data.toString() })
      proc.stderr?.on('data', (data) => { stderr += data.toString() })

      proc.on('close', (code) => {
        context.onProgress?.(code === 0 ? '完成' : `退出码: ${code}`)
        resolve({
          success: code === 0,
          output: stdout,
          error: stderr || undefined,
          data: { code, stdout, stderr }
        })
      })

      proc.on('error', (e) => {
        resolve({ success: false, error: e.message })
      })
    })
  }
}

// ReadTool - 读取文件
const ReadTool: Tool = {
  name: 'read',
  description: '读取文件内容',
  parameters: [
    { name: 'path', type: 'string', description: '文件路径', required: true }
  ],
  execute: async (args) => {
    try {
      if (!fs.existsSync(args.path)) {
        return { success: false, error: `文件不存在: ${args.path}` }
      }
      
      const stat = fs.statSync(args.path)
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(args.path)
        return {
          success: true,
          output: `目录: ${args.path}\n\n${entries.map(e => {
            const fullPath = path.join(args.path, e)
            const s = fs.statSync(fullPath)
            return s.isDirectory() ? `📁 ${e}/` : `📄 ${e}`
          }).join('\n')}`,
          data: { entries }
        }
      }
      
      const content = fs.readFileSync(args.path, 'utf8')
      const lines = content.split('\n').length
      
      return {
        success: true,
        output: `文件: ${args.path} (${lines}行)\n\n${content}`,
        data: { content, lines, size: stat.size }
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}

// WriteTool - 写入文件
const WriteTool: Tool = {
  name: 'write',
  description: '写入文件内容（会覆盖原文件）',
  parameters: [
    { name: 'path', type: 'string', description: '文件路径', required: true },
    { name: 'content', type: 'string', description: '文件内容', required: true }
  ],
  execute: async (args, context) => {
    try {
      const dir = path.dirname(args.path)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      
      fs.writeFileSync(args.path, args.content, 'utf8')
      context.onProgress?.(`已写入: ${args.path}`)
      
      return {
        success: true,
        output: `已保存: ${args.path}`,
        data: { path: args.path, size: args.content.length }
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}

// EditTool - 编辑文件（替换文本）
const EditTool: Tool = {
  name: 'edit',
  description: '替换文件中的文本',
  parameters: [
    { name: 'path', type: 'string', description: '文件路径', required: true },
    { name: 'oldText', type: 'string', description: '要替换的原文', required: true },
    { name: 'newText', type: 'string', description: '替换后的新文本', required: true }
  ],
  execute: async (args, context) => {
    try {
      if (!fs.existsSync(args.path)) {
        return { success: false, error: `文件不存在: ${args.path}` }
      }
      
      let content = fs.readFileSync(args.path, 'utf8')
      
      if (!content.includes(args.oldText)) {
        return { success: false, error: '未找到要替换的文本' }
      }
      
      content = content.replace(args.oldText, args.newText)
      fs.writeFileSync(args.path, content, 'utf8')
      context.onProgress?.(`已修改: ${args.path}`)
      
      return {
        success: true,
        output: `已修改: ${args.path}`,
        data: { path: args.path }
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}

// GrepTool - 搜索文件内容
const GrepTool: Tool = {
  name: 'grep',
  description: '在文件中搜索文本',
  parameters: [
    { name: 'path', type: 'string', description: '搜索目录', required: true },
    { name: 'pattern', type: 'string', description: '搜索模式', required: true },
    { name: 'filePattern', type: 'string', description: '文件过滤 (如 *.js)' }
  ],
  execute: async (args) => {
    try {
      const results: Array<{ file: string, line: number, content: string }> = []
      
      const search = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue
          if (entry.name === 'node_modules') continue
          
          const fullPath = path.join(dir, entry.name)
          
          if (entry.isDirectory()) {
            search(fullPath)
          } else if (entry.isFile()) {
            if (args.filePattern) {
              const pattern = args.filePattern.replace('*', '.*')
              if (!entry.name.match(new RegExp(pattern))) continue
            }
            
            try {
              const content = fs.readFileSync(fullPath, 'utf8')
              const lines = content.split('\n')
              lines.forEach((line, i) => {
                if (line.includes(args.pattern)) {
                  results.push({
                    file: fullPath,
                    line: i + 1,
                    content: line.trim()
                  })
                }
              })
            } catch (e) {}
          }
        }
      }
      
      search(args.path)
      
      const output = results.map(r => `${r.file}:${r.line}: ${r.content}`).join('\n')
      
      return {
        success: true,
        output: `找到 ${results.length} 个匹配:\n\n${output}`,
        data: { results, count: results.length }
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}

// GlobTool - 文件名匹配
const GlobTool: Tool = {
  name: 'glob',
  description: '按模式查找文件',
  parameters: [
    { name: 'pattern', type: 'string', description: '文件模式 (如 *.js)', required: true }
  ],
  execute: async (args, context) => {
    try {
      const results: string[] = []
      
      // 转换glob模式到正则
      const regexPattern = args.pattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
      
      const regex = new RegExp(regexPattern)
      
      const search = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue
          if (entry.name === 'node_modules') continue
          
          const fullPath = path.join(dir, entry.name)
          
          if (entry.isDirectory()) {
            search(fullPath)
          } else if (regex.test(entry.name)) {
            results.push(fullPath)
          }
        }
      }
      
      search(context.workspace)
      
      return {
        success: true,
        output: `找到 ${results.length} 个文件:\n\n${results.join('\n')}`,
        data: { files: results, count: results.length }
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}

// MkdirTool - 创建目录
const MkdirTool: Tool = {
  name: 'mkdir',
  description: '创建目录',
  parameters: [
    { name: 'path', type: 'string', description: '目录路径', required: true }
  ],
  execute: async (args, context) => {
    try {
      fs.mkdirSync(args.path, { recursive: true })
      context.onProgress?.(`已创建目录: ${args.path}`)
      
      return {
        success: true,
        output: `已创建: ${args.path}`,
        data: { path: args.path }
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}

// RmTool - 删除文件/目录
const RmTool: Tool = {
  name: 'rm',
  description: '删除文件或目录',
  parameters: [
    { name: 'path', type: 'string', description: '路径', required: true }
  ],
  execute: async (args, context) => {
    try {
      if (!fs.existsSync(args.path)) {
        return { success: true, output: '路径不存在，无需删除' }
      }
      
      fs.rmSync(args.path, { recursive: true })
      context.onProgress?.(`已删除: ${args.path}`)
      
      return {
        success: true,
        output: `已删除: ${args.path}`,
        data: { path: args.path }
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}

// MvTool - 移动/重命名文件
const MvTool: Tool = {
  name: 'mv',
  description: '移动或重命名文件',
  parameters: [
    { name: 'from', type: 'string', description: '源路径', required: true },
    { name: 'to', type: 'string', description: '目标路径', required: true }
  ],
  execute: async (args, context) => {
    try {
      fs.renameSync(args.from, args.to)
      context.onProgress?.(`已移动: ${args.from} -> ${args.to}`)
      
      return {
        success: true,
        output: `已移动: ${args.from} -> ${args.to}`,
        data: { from: args.from, to: args.to }
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}

// CpTool - 复制文件/目录
const CpTool: Tool = {
  name: 'cp',
  description: '复制文件或目录',
  parameters: [
    { name: 'from', type: 'string', description: '源路径', required: true },
    { name: 'to', type: 'string', description: '目标路径', required: true }
  ],
  execute: async (args, context) => {
    try {
      if (fs.statSync(args.from).isDirectory()) {
        fs.cpSync(args.from, args.to, { recursive: true })
      } else {
        fs.copyFileSync(args.from, args.to)
      }
      context.onProgress?.(`已复制: ${args.from} -> ${args.to}`)
      
      return {
        success: true,
        output: `已复制: ${args.from} -> ${args.to}`,
        data: { from: args.from, to: args.to }
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}

// ExistsTool - 检查文件是否存在
const ExistsTool: Tool = {
  name: 'exists',
  description: '检查文件或目录是否存在',
  parameters: [
    { name: 'path', type: 'string', description: '路径', required: true }
  ],
  execute: async (args) => {
    const exists = fs.existsSync(args.path)
    return {
      success: true,
      output: exists ? '存在' : '不存在',
      data: { exists }
    }
  }
}

// ListTool - 列出目录内容
const ListTool: Tool = {
  name: 'list',
  description: '列出目录内容',
  parameters: [
    { name: 'path', type: 'string', description: '目录路径', required: true }
  ],
  execute: async (args) => {
    try {
      const entries = fs.readdirSync(args.path, { withFileTypes: true })
      const result = entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file'
      }))
      
      return {
        success: true,
        output: result.map(e => `${e.type === 'directory' ? '📁' : '📄'} ${e.name}`).join('\n'),
        data: { entries: result }
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}

// WebSearchTool - 网络搜索
const WebSearchTool: Tool = {
  name: 'web_search',
  description: '搜索网络信息',
  parameters: [
    { name: 'query', type: 'string', description: '搜索关键词', required: true }
  ],
  execute: async (args) => {
    try {
      const url = `https://ddg-api.herokuapp.com/search?q=${encodeURIComponent(args.query)}&limit=5`
      const res = await fetch(url)
      const data = await res.json()
      
      const results = (data.results || []).map((r: any, i: number) => 
        `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`
      ).join('\n\n')
      
      return {
        success: true,
        output: `搜索结果: ${args.query}\n\n${results || '无结果'}`,
        data: { results: data.results || [] }
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}

// WebFetchTool - 获取网页内容
const WebFetchTool: Tool = {
  name: 'web_fetch',
  description: '获取网页内容',
  parameters: [
    { name: 'url', type: 'string', description: '网页URL', required: true }
  ],
  execute: async (args) => {
    try {
      const res = await fetch(args.url)
      const text = await res.text()
      
      // 简单提取正文
      const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
      let content = bodyMatch ? bodyMatch[1] : text
      
      // 去除HTML标签
      content = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      
      return {
        success: true,
        output: content.substring(0, 2000),
        data: { url: args.url, length: text.length }
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }
}

// ==================== ToolManager ====================

export class ToolManager {
  tools: Map<string, Tool>
  workspace: string

  constructor(workspace: string) {
    this.tools = new Map()
    this.workspace = workspace

    // 注册所有工具
    this.register(BashTool)
    this.register(ReadTool)
    this.register(WriteTool)
    this.register(EditTool)
    this.register(GrepTool)
    this.register(GlobTool)
    this.register(MkdirTool)
    this.register(RmTool)
    this.register(MvTool)
    this.register(CpTool)
    this.register(ExistsTool)
    this.register(ListTool)
    this.register(WebSearchTool)
    this.register(WebFetchTool)
  }

  register(tool: Tool) {
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  listAll(): Array<{ name: string, description: string, parameters: ToolParameter[] }> {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }))
  }

  async execute(toolName: string, args: ToolArgs, context?: Partial<ToolContext>): Promise<ToolResult> {
    const tool = this.tools.get(toolName)
    if (!tool) {
      return { success: false, error: `未知工具: ${toolName}` }
    }

    const fullContext: ToolContext = {
      workspace: context?.workspace || this.workspace,
      agentId: context?.agentId,
      onProgress: context?.onProgress
    }

    try {
      return await tool.execute(args, fullContext)
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  setWorkspace(workspace: string) {
    this.workspace = workspace
  }
}
