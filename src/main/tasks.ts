import { randomUUID } from 'node:crypto'
import type { TaskEvent, TaskStatus } from '../shared/api'

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
export type TaskContext = { signal: AbortSignal; log(stage: string, message: string): void }

export class ImportTasks {
  private current?: { id: string; controller: AbortController; settled: Promise<void>; stage: string }

  constructor(private publish: (event: TaskEvent) => void) {}

  cancel(taskId?: string) {
    const task = this.current
    if (task && (taskId === undefined || task.id === taskId)) task.controller.abort(new Error(`${task.stage}已取消。`))
  }

  settled() { return this.current?.settled ?? Promise.resolve() }

  async run<T>(name: string, action: (context: TaskContext) => Promise<T>, stage = '导入', decode?: TaskEvent['decode']): Promise<T> {
    if (this.current) throw new Error('已有任务正在运行。')
    const controller = new AbortController()
    const { promise, resolve } = Promise.withResolvers<void>()
    const id = randomUUID()
    this.current = { id, controller, settled: promise, stage }
    const send = (status: TaskStatus, stage: string, message: string) =>
      this.publish({ id, status, stage, message, at: Date.now(), ...(decode && { decode }) })
    send('running', stage, name)
    try {
      const result = await action({ signal: controller.signal, log: (stage, message) => send('running', stage, message) })
      send('done', '完成', '工作区已就绪。')
      return result
    } catch (error) {
      send(controller.signal.aborted ? 'cancelled' : 'failed', '结束', errorMessage(error))
      throw error
    } finally {
      this.current = undefined
      resolve()
    }
  }
}
