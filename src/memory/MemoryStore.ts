/**
 * JarvisCode 记忆系统
 * 基于 Claude Code 的 4 种记忆类型架构
 */

import fs from 'fs'
import path from 'path'

// ==================== 类型定义 ====================

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export interface Memory {
  id: string
  type: MemoryType
  name: string
  description: string
  content: string
  why?: string        // 为什么保存这条记忆
  howToApply?: string // 如何应用
  createdAt: number
  updatedAt: number
  tags?: string[]
}

export interface MemoryQuery {
  type?: MemoryType
  query?: string
  limit?: number
}

// ==================== 记忆类型常量 ====================

export const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference']

export const MEMORY_TYPE_DESCRIPTIONS: Record<MemoryType, string> = {
  user: '用户偏好、角色、目标、知识 - 帮助AI理解用户是谁、如何更好地帮助他们',
  feedback: '用户反馈 - 什么该做、什么不该做、什么是有效的、什么是无效的',
  project: '项目状态、目标、bugs、initiatives - 帮助理解项目背景和动机',
  reference: '外部资源指针 - 保存在外部系统(Linear, Slack, Grafana等)的信息位置'
}

export const WHEN_TO_SAVE: Record<MemoryType, string[]> = {
  user: [
    '了解用户的角色、偏好、责任或知识时',
    '用户提到自己的专业领域或经验水平时',
    '用户说明自己的目标或需求时'
  ],
  feedback: [
    '用户纠正AI的做法时 ("不要那样做", "停止做X")',
    '用户确认一个非显而易见的方法有效时 ("对，就是这样")',
    '用户接受一个不寻常的选择没有反驳时'
  ],
  project: [
    '了解谁在做什么、为什么、什么时候做时',
    '了解项目截止日期、约束或利益相关者要求时',
    '了解技术决策背后的原因时'
  ],
  reference: [
    '了解外部系统的资源及其用途时',
    '用户提到bug跟踪系统、监控面板等时',
    '了解某个外部资源的作用时'
  ]
}

// ==================== MemoryStore 类 ====================

export class MemoryStore {
  memories: Map<string, Memory>
  memoryDir: string
  initialized: boolean

  constructor(memoryDir?: string) {
    this.memories = new Map()
    this.memoryDir = memoryDir || './memory'
    this.initialized = false
  }

  async init(): Promise<void> {
    if (this.initialized) return

    // 确保目录存在
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true })
    }

    // 为每种类型创建子目录
    for (const type of MEMORY_TYPES) {
      const typeDir = path.join(this.memoryDir, type)
      if (!fs.existsSync(typeDir)) {
        fs.mkdirSync(typeDir, { recursive: true })
      }
    }

    // 加载已有记忆
    await this.loadAllMemories()
    this.initialized = true
  }

  private async loadAllMemories(): Promise<void> {
    for (const type of MEMORY_TYPES) {
      const typeDir = path.join(this.memoryDir, type)
      if (!fs.existsSync(typeDir)) continue

      const files = fs.readdirSync(typeDir).filter(f => f.endsWith('.md'))
      for (const file of files) {
        try {
          const filePath = path.join(typeDir, file)
          const content = fs.readFileSync(filePath, 'utf8')
          const memory = this.parseMemoryFile(content, filePath)
          if (memory) {
            this.memories.set(memory.id, memory)
          }
        } catch (e) {
          console.error(`加载记忆失败: ${file}`, e)
        }
      }
    }
  }

  private parseMemoryFile(content: string, filePath: string): Memory | null {
    // 解析 frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
    if (!frontmatterMatch) return null

    const frontmatter = this.parseFrontmatter(frontmatterMatch[1])
    const body = content.replace(frontmatterMatch[0], '').trim()

    return {
      id: frontmatter.id || path.basename(filePath, '.md'),
      type: (frontmatter.type as MemoryType) || 'user',
      name: frontmatter.name || '',
      description: frontmatter.description || '',
      content: body,
      why: frontmatter.why,
      howToApply: frontmatter['how_to_apply'],
      createdAt: parseInt(frontmatter.created_at) || Date.now(),
      updatedAt: parseInt(frontmatter.updated_at) || Date.now(),
      tags: frontmatter.tags ? frontmatter.tags.split(',').map(t => t.trim()) : []
    }
  }

  private parseFrontmatter(str: string): Record<string, string> {
    const result: Record<string, string> = {}
    const lines = str.split('\n')
    
    for (const line of lines) {
      const colonIndex = line.indexOf(':')
      if (colonIndex === -1) continue
      const key = line.substring(0, colonIndex).trim()
      const value = line.substring(colonIndex + 1).trim()
      result[key] = value
    }
    
    return result
  }

  // ==================== 记忆操作 ====================

  async save(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>): Promise<Memory> {
    const id = `memory_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`
    const now = Date.now()

    const newMemory: Memory = {
      ...memory,
      id,
      createdAt: now,
      updatedAt: now
    }

    // 保存到文件
    await this.saveToFile(newMemory)
    
    // 添加到内存
    this.memories.set(id, newMemory)

    return newMemory
  }

  private async saveToFile(memory: Memory): Promise<void> {
    const typeDir = path.join(this.memoryDir, memory.type)
    const filePath = path.join(typeDir, `${memory.id}.md`)

    const frontmatter = [
      '---',
      `id: ${memory.id}`,
      `name: ${memory.name}`,
      `description: ${memory.description}`,
      `type: ${memory.type}`,
      `created_at: ${memory.createdAt}`,
      `updated_at: ${memory.updatedAt}`,
      memory.why ? `why: ${memory.why}` : '',
      memory.howToApply ? `how_to_apply: ${memory.howToApply}` : '',
      memory.tags ? `tags: ${memory.tags.join(',')}` : '',
      '---'
    ].filter(line => line !== '').join('\n')

    const content = `${frontmatter}\n\n${memory.content}`
    fs.writeFileSync(filePath, content, 'utf8')
  }

  async update(id: string, updates: Partial<Memory>): Promise<Memory | null> {
    const existing = this.memories.get(id)
    if (!existing) return null

    const updated: Memory = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now()
    }

    await this.saveToFile(updated)
    this.memories.set(id, updated)

    return updated
  }

  async delete(id: string): Promise<boolean> {
    const memory = this.memories.get(id)
    if (!memory) return false

    const filePath = path.join(this.memoryDir, memory.type, `${id}.md`)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }

    return this.memories.delete(id)
  }

  get(id: string): Memory | undefined {
    return this.memories.get(id)
  }

  find(query: MemoryQuery): Memory[] {
    let results = Array.from(this.memories.values())

    if (query.type) {
      results = results.filter(m => m.type === query.type)
    }

    if (query.query) {
      const q = query.query.toLowerCase()
      results = results.filter(m => 
        m.name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.content.toLowerCase().includes(q)
      )
    }

    // 按更新时间排序
    results.sort((a, b) => b.updatedAt - a.updatedAt)

    if (query.limit) {
      results = results.slice(0, query.limit)
    }

    return results
  }

  // ==================== 便捷方法 ====================

  async saveUserPreference(name: string, content: string, why?: string, howToApply?: string): Promise<Memory> {
    return this.save({
      type: 'user',
      name,
      description: `用户偏好: ${name}`,
      content,
      why,
      howToApply
    })
  }

  async saveFeedback(content: string, isPositive: boolean, why?: string): Promise<Memory> {
    return this.save({
      type: 'feedback',
      name: isPositive ? '正面反馈' : '负面反馈',
      description: content.substring(0, 100),
      content: `${isPositive ? '✅ 有效' : '❌ 无效'}: ${content}`,
      why,
      howToApply: isPositive ? '继续保持这种做法' : '避免重复这个错误'
    })
  }

  async saveProjectInfo(name: string, content: string, why?: string, howToApply?: string): Promise<Memory> {
    return this.save({
      type: 'project',
      name,
      description: `项目信息: ${name}`,
      content,
      why,
      howToApply
    })
  }

  async saveReference(resource: string, url: string, description: string): Promise<Memory> {
    return this.save({
      type: 'reference',
      name: resource,
      description,
      content: `资源: ${resource}\n链接: ${url}\n说明: ${description}`
    })
  }

  // ==================== 统计 ====================

  getStats(): Record<MemoryType, number> {
    const stats: Record<MemoryType, number> = {
      user: 0,
      feedback: 0,
      project: 0,
      reference: 0
    }

    for (const memory of this.memories.values()) {
      stats[memory.type]++
    }

    return stats
  }

  // ==================== 导出为 Prompt 格式 ====================

  toPromptString(type?: MemoryType): string {
    const memories = type ? this.find({ type }) : Array.from(this.memories.values())
    
    if (memories.length === 0) return ''

    const sections = [`## 记忆系统 (${memories.length}条记忆)`]

    for (const memType of MEMORY_TYPES) {
      const typeMemories = memories.filter(m => m.type === memType)
      if (typeMemories.length === 0) continue

      sections.push(`\n### ${memType.toUpperCase()} (${typeMemories.length}条)`)
      
      for (const mem of typeMemories) {
        sections.push(`\n**${mem.name}**`)
        sections.push(mem.content)
        if (mem.why) sections.push(`Why: ${mem.why}`)
        if (mem.howToApply) sections.push(`How: ${mem.howToApply}`)
      }
    }

    return sections.join('\n')
  }
}

// ==================== 全局实例 ====================

export const globalMemoryStore = new MemoryStore()
