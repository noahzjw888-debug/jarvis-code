/**
 * JarvisCode 后端服务
 * 使用 Claude Style 执行循环 + MiniMax API
 */

import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { AgentManager, globalAgentManager } from './src/agent/AgentManager.js'
import { ToolManager } from './src/tools/ToolManager.js'
import { MemoryStore, globalMemoryStore } from './src/memory/MemoryStore.js'
import { TaskManager, globalTaskManager } from './src/tasks/TaskManager.js'
import { ClaudeStyleLoop } from './src/core/ClaudeStyleLoop.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = 3847

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ==================== 配置 ====================

const CONFIG_FILE = path.join(__dirname, 'config.json')

let config = {
  globalModel: 'MiniMax-M2.7',
  globalApiKey: 'sk-U1ELE6uTQvNzGELEFE7a3x7D8ZM5PTazRnnfayuHOWtnTKJa',
  globalApiUrl: 'https://api.minimax.chat/v1/chat/completions',
  workspace: process.env.HOME + '/workspace',
  agents: {}
}

if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }
  } catch (e) {
    console.log('配置文件读取失败，使用默认配置')
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

// ==================== 初始化 ====================

if (!fs.existsSync(config.workspace)) {
  fs.mkdirSync(config.workspace, { recursive: true })
}

const toolManager = new ToolManager(config.workspace)
const memoryStore = globalMemoryStore
const taskManager = globalTaskManager

await memoryStore.init()
globalAgentManager.createPredefinedTeam('FULL_STACK')

// 创建 Claude Style 执行循环
let agentLoop = new ClaudeStyleLoop({
  toolManager,
  memoryStore,
  apiKey: config.globalApiKey,
  model: config.globalModel,
  apiUrl: config.globalApiUrl,
  maxTurns: 15
})

// ==================== API 路由 ====================

// 获取配置
app.get('/api/config', (req, res) => {
  res.json({
    globalModel: config.globalModel,
    globalApiUrl: config.globalApiUrl,
    workspace: config.workspace,
    agents: globalAgentManager.listAgents().map(a => a.getSummary())
  })
})

// 保存配置
app.post('/api/config', (req, res) => {
  const { globalModel, globalApiKey, globalApiUrl, workspace } = req.body
  
  if (globalModel) config.globalModel = globalModel
  if (globalApiKey) config.globalApiKey = globalApiKey
  if (globalApiUrl) config.globalApiUrl = globalApiUrl
  if (workspace) {
    config.workspace = workspace
    toolManager.setWorkspace(workspace)
  }
  
  // 重新创建执行循环
  agentLoop = new ClaudeStyleLoop({
    toolManager,
    memoryStore,
    apiKey: config.globalApiKey,
    model: config.globalModel,
    apiUrl: config.globalApiUrl,
    maxTurns: 15
  })
  
  saveConfig()
  res.json({ success: true })
})

// ==================== 文件操作 ====================

app.get('/api/files', (req, res) => {
  const dir = req.query.path || config.workspace
  try {
    const tree = buildFileTree(dir)
    res.json(tree)
  } catch (e: any) {
    res.json({ error: e.message })
  }
})

app.get('/api/read', (req, res) => {
  const filePath = req.query.path
  if (!filePath) return res.status(400).json({ error: '需要path参数' })
  
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    res.json({ content, path: filePath })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/write', (req, res) => {
  const { path: filePath, content } = req.body
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: '需要path和content参数' })
  }
  
  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(filePath, content, 'utf8')
    res.json({ success: true, path: filePath })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ==================== 工具执行 ====================

app.post('/api/tools/execute', async (req, res) => {
  const { tool, args } = req.body
  if (!tool) return res.status(400).json({ error: '需要tool参数' })
  
  try {
    const result = await toolManager.execute(tool, args || {})
    res.json(result)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/tools', (req, res) => {
  res.json(toolManager.listAll())
})

// ==================== 任务管理 ====================

app.get('/api/tasks', (req, res) => {
  res.json(taskManager.listTasks())
})

app.post('/api/tasks/shell', async (req, res) => {
  const { command, cwd } = req.body
  if (!command) return res.status(400).json({ error: '需要command参数' })
  
  const task = taskManager.createShellTask(command, cwd || config.workspace)
  const result = await taskManager.executeShell(task.id)
  
  res.json({ task, result })
})

// ==================== 记忆管理 ====================

app.get('/api/memory', (req, res) => {
  const type = req.query.type as any
  const query = req.query.query as string
  res.json(memoryStore.find({ type, query }))
})

app.post('/api/memory', async (req, res) => {
  const { type, name, description, content, why, howToApply } = req.body
  if (!type || !content) return res.status(400).json({ error: '需要type和content' })
  
  try {
    const memory = await memoryStore.save({ type, name: name || '未命名', description: description || content.substring(0, 100), content, why, howToApply })
    res.json(memory)
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/memory/:id', async (req, res) => {
  res.json({ success: await memoryStore.delete(req.params.id) })
})

app.get('/api/memory/stats', (req, res) => {
  res.json(memoryStore.getStats())
})

// ==================== AI 对话 (Claude Style Loop) ====================

app.post('/api/chat', async (req, res) => {
  const { message, context } = req.body
  if (!message) return res.status(400).json({ error: '需要message参数' })
  
  console.log(`\n========== 新请求 ==========`)
  console.log(`用户: ${message.substring(0, 100)}...`)
  
  try {
    const result = await agentLoop.execute(message, {
      workspace: config.workspace,
      context: context || {}
    })
    
    console.log(`结果: ${result.content.substring(0, 100)}...`)
    console.log(`回合: ${result.turns}`)
    console.log(`工具调用: ${result.toolResults.length} 次`)
    console.log(`=============================\n`)
    
    res.json({
      content: result.content,
      turns: result.turns,
      toolResults: result.toolResults,
      success: result.success
    })
  } catch (e: any) {
    console.error('Chat error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ==================== Agent 管理 ====================

app.get('/api/team', (req, res) => {
  res.json(globalAgentManager.getTeamStatus())
})

// ==================== 工具函数 ====================

function buildFileTree(dir: string, depth = 0): any {
  if (depth > 4) return { name: path.basename(dir), type: 'folder' }
  
  const items: any[] = []
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.name === 'node_modules') continue
      
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        items.push({
          name: entry.name,
          type: 'folder',
          path: fullPath,
          children: buildFileTree(fullPath, depth + 1).children || []
        })
      } else {
        items.push({
          name: entry.name,
          type: 'file',
          path: fullPath
        })
      }
    }
  } catch (e: any) {
    return { error: e.message }
  }
  
  return { name: path.basename(dir), type: 'folder', path: dir, children: items }
}

// ==================== 启动 ====================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║     🤖 JarvisCode 2.0 - Claude Style 执行循环                 ║
║                                                                ║
║     本地访问: http://localhost:${PORT}                              ║
║     工作目录: ${config.workspace.padEnd(30)}║
║     模型: ${config.globalModel.padEnd(30)}║
║                                                                ║
║     核心架构 (基于 Claude Code):                                ║
║     ✅ ClaudeStyleLoop (执行循环)                               ║
║     ✅ MiniMax API (大脑)                                      ║
║     ✅ 14 工具 (bash/read/write/edit/grep等)                   ║
║     ✅ 记忆系统 (user/feedback/project/reference)               ║
║     ✅ Agent团队 (Coordinator + Workers)                       ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
  `)
})
