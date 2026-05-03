import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

function proxyUrl(proxyAddr: string, proxyType: 'socks5' | 'http'): string {
  const [host, port] = proxyAddr.split(':')
  // For SOCKS5 we use socks5h:// (h = resolve DNS through the proxy too).
  // curl, pip, npm, git, requests/httpx all accept this scheme. Plain socks5://
  // would resolve DNS locally, which would defeat the kill-switch (DNS could
  // leak to the ISP if Hard mode TUN is not active for the env-mode user).
  return proxyType === 'socks5' ? `socks5h://${host}:${port}` : `http://${host}:${port}`
}

export const env = {
  name: 'Environment Variables',

  async apply(proxyAddr: string, proxyType: 'socks5' | 'http' = 'socks5'): Promise<boolean> {
    const url = proxyUrl(proxyAddr, proxyType)
    try {
      // Set user-level environment variables (survives reboot)
      await execAsync(`setx HTTP_PROXY "${url}"`)
      await execAsync(`setx HTTPS_PROXY "${url}"`)
      await execAsync(`setx ALL_PROXY "${url}"`)
      await execAsync(`setx NO_PROXY "localhost,127.0.0.1,::1"`)
      return true
    } catch {
      return false
    }
  },

  async rollback(): Promise<boolean> {
    try {
      // Delete user-level environment variables
      await execAsync('reg delete "HKCU\\Environment" /v HTTP_PROXY /f 2>nul || echo ok')
      await execAsync('reg delete "HKCU\\Environment" /v HTTPS_PROXY /f 2>nul || echo ok')
      await execAsync('reg delete "HKCU\\Environment" /v ALL_PROXY /f 2>nul || echo ok')
      await execAsync('reg delete "HKCU\\Environment" /v NO_PROXY /f 2>nul || echo ok')
      return true
    } catch {
      return false
    }
  },

  async isApplied(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('reg query "HKCU\\Environment" /v HTTP_PROXY 2>nul')
      return stdout.includes('HTTP_PROXY')
    } catch {
      return false
    }
  }
}
