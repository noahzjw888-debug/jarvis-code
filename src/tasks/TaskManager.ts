/**
 * JarvisCode 任务系统
 * 基于 Claude Code 的 Task 架构
 */

import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'

// ==================== 类型定义 ====================

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped'
export type TaskType = 'shell' | 'agent' | 'workflow' | 'dream'

export interface TaskResult {
  stdout?: string
  stderr?: string
  code?: number
  output?: string
  error?: string
}

export interface Task {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  result?: TaskResult
  agentId?: string
  parentTaskId?: string
}

export interface ShellTask extends Task {
  type: 'shell'
  command: string
  cwd?: string
  env?: Record<string, string>
  process?: ChildProcess
}

// ==================== TaskManager 类 ====================

export class TaskManager {
  tasks: Map<string, Task>
  shellTasks: Map<string, ChildProcess>

  constructor() {
    this.tasks = new Map()
    this.shellTasks = new Map()
  }

  // ==================== 任务创建 ====================

  createShellTask(command: string, cwd?: string, env?: Record<string, string>): ShellTask {
    const id = `shell_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`
    
    const task: ShellTask = {
      id,
      type: 'shell',
      status: 'pending',
      description: command,
      command,
      cwd,
      env,
      createdAt: Date.now()
    }

    this.tasks.set(id, task)
    return task
  }

  createAgentTask(agentId: string, description: string, parentTaskId?: string): Task {
    const id = `agent_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`
    
    const task: Task = {
      id,
      type: 'agent',
      status: 'pending',
      description,
      agentId,
      parentTaskId,
      createdAt: Date.now()
    }

    this.tasks.set(id, task)
    return task
  }

  createDreamTask(description: string): Task {
    const id = `dream_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`
    
    const task: Task = {
      id,
      type: 'dream',
      status: 'pending',
      description,
      createdAt: Date.now()
    }

    this.tasks.set(id, task)
    return task
  }

  // ==================== 任务执行 ====================

  async executeShell(taskId: string): Promise<TaskResult> {
    const task = this.tasks.get(taskId) as ShellTask
    if (!task || task.type !== 'shell') {
      throw new Error(`任务不存在或类型错误: ${taskId}`)
    }

    task.status = 'running'
    task.startedAt = Date.now()

    return new Promise((resolve) => {
      const proc = spawn(task.command, [], {
        shell: true,
        cwd: task.cwd || process.cwd(),
        env: { ...process.env, ...task.env }
      })

      this.shellTasks.set(taskId, proc)

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data) => {
        stdout += data.toString()
      })

      proc.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        task.status = code === 0 ? 'completed' : 'failed'
        task.completedAt = Date.now()
        task.result = { stdout, stderr, code: code || 0 }
        this.shellTasks.delete(taskId)
        resolve(task.result)
      })

      proc.on('error', (error) => {
        task.status = 'failed'
        task.completedAt = Date.now()
        task.result = { error: error.message }
        this.shellTasks.delete(taskId)
        resolve(task.result)
      })
    })
  }

  completeTask(taskId: string, result?: TaskResult) {
    const task = this.tasks.get(taskId)
    if (!task) return

    task.status = 'completed'
    task.completedAt = Date.now()
    task.result = result
  }

  failTask(taskId: string, error?: string) {
    const task = this.tasks.get(taskId)
    if (!task) return

    task.status = 'failed'
    task.completedAt = Date.now()
    task.result = { error }
  }

  stopTask(taskId: string) {
    const task = this.tasks.get(taskId)
    if (!task) return

    if (task.type === 'shell' && this.shellTasks.has(taskId)) {
      const proc = this.shellTasks.get(taskId)
      proc?.kill('SIGTERM')
      this.shellTasks.delete(taskId)
    }

    task.status = 'stopped'
    task.completedAt = Date.now()
  }

  // ==================== 任务查询 ====================

  getTask(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  listTasks(filter?: { status?: TaskStatus, type?: TaskType }): Task[] {
    let tasks = Array.from(this.tasks.values())
    
    if (filter?.status) {
      tasks = tasks.filter(t => t.status === filter.status)
    }
    if (filter?.type) {
      tasks = tasks.filter(t => t.type === filter.type)
    }

    // 按创建时间倒序
    return tasks.sort((a, b) => b.createdAt - a.createdAt)
  }

  getRunningTasks(): Task[] {
    return this.listTasks({ status: 'running' })
  }

  getPendingTasks(): Task[] {
    return this.listTasks({ status: 'pending' })
  }

  // ==================== 任务统计 ====================

  getStats(): { pending: number, running: number, completed: number, failed: number, stopped: number } {
    const tasks = Array.from(this.tasks.values())
    return {
      pending: tasks.filter(t => t.status === 'pending').length,
      running: tasks.filter(t => t.status === 'running').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      stopped: tasks.filter(t => t.status === 'stopped').length
    }
  }

  // ==================== 清理 ====================

  clearCompleted(maxAge?: number) {
    const now = Date.now()
    for (const [id, task] of this.tasks) {
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'stopped') {
        if (maxAge && task.completedAt && (now - task.completedAt) > maxAge) {
          this.tasks.delete(id)
        }
      }
    }
  }

  clearAll() {
    // 停止所有运行的shell任务
    for (const [id, proc] of this.shellTasks) {
      proc.kill('SIGTERM')
    }
    this.shellTasks.clear()
    this.tasks.clear()
  }
}

// ==================== 全局实例 ====================

export const globalTaskManager = new TaskManager()
