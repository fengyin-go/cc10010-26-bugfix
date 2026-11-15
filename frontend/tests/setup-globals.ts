// 测试前置：在任何业务模块 import 之前装好浏览器环境桩（业务模块在加载期会访问 window/localStorage）。
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}

const storage = new MemoryStorage()
;(globalThis as Record<string, unknown>).window = {
  localStorage: storage,
  addEventListener: () => undefined,
}
;(globalThis as Record<string, unknown>).localStorage = storage
