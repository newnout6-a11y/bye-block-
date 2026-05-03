import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export const env = {
  name: 'Environment Variables',

  async apply(proxyAddr: string): Promise<boolean> {
    const [host, port] = proxyAddr.split(':')
    try {
      // Set user-level environment variables (survives reboot)
      await execAsync(`setx HTTP_PROXY "http://${host}:${port}"`)
      await execAsync(`setx HTTPS_PROXY "http://${host}:${port}"`)
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
