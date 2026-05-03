import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export const git = {
  name: 'Git',

  async apply(proxyAddr: string): Promise<boolean> {
    const [host, port] = proxyAddr.split(':')
    try {
      await execAsync(`git config --global http.proxy http://${host}:${port}`)
      await execAsync(`git config --global https.proxy http://${host}:${port}`)
      return true
    } catch {
      return false
    }
  },

  async rollback(): Promise<boolean> {
    try {
      await execAsync('git config --global --unset http.proxy 2>nul || echo ok')
      await execAsync('git config --global --unset https.proxy 2>nul || echo ok')
      return true
    } catch {
      return false
    }
  },

  async isApplied(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('git config --global --get http.proxy')
      return stdout.trim().length > 0
    } catch {
      return false
    }
  }
}
