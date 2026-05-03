import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

function proxyUrl(proxyAddr: string, proxyType: 'socks5' | 'http'): string {
  const [host, port] = proxyAddr.split(':')
  // Git supports socks5h:// natively (curl backend). socks5h forces DNS through
  // the proxy. Plain http://host:socksPort would attempt HTTP CONNECT against
  // a SOCKS port and fail for every clone/fetch.
  return proxyType === 'socks5' ? `socks5h://${host}:${port}` : `http://${host}:${port}`
}

export const git = {
  name: 'Git',

  async apply(proxyAddr: string, proxyType: 'socks5' | 'http' = 'socks5'): Promise<boolean> {
    const url = proxyUrl(proxyAddr, proxyType)
    try {
      await execAsync(`git config --global http.proxy ${url}`)
      await execAsync(`git config --global https.proxy ${url}`)
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
