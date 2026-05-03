import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

function getGradlePropsPath(): string {
  return join(homedir(), '.gradle', 'gradle.properties')
}

export const gradle = {
  name: 'Gradle',

  async apply(proxyAddr: string): Promise<boolean> {
    const [host, port] = proxyAddr.split(':')
    const propsPath = getGradlePropsPath()
    const gradleDir = join(homedir(), '.gradle')

    try {
      await mkdir(gradleDir, { recursive: true })
      let content = ''
      try {
        content = await readFile(propsPath, 'utf-8')
      } catch { content = '' }

      // Backup
      await writeFile(propsPath + '.vpn-backup', content, 'utf-8')

      // Remove old VPN entries
      content = content.replace(/# VPN Tunnel Enforcer[\s\S]*?(?=\n[^\n]|\n*$)/g, '').trimEnd()

      // Add new entries
      const proxyLines = `\n# VPN Tunnel Enforcer\nsystemProp.socksProxyHost=${host}\nsystemProp.socksProxyPort=${port}\nsystemProp.http.nonProxyHosts=localhost|127.*|[::1]\n`
      content += proxyLines

      await writeFile(propsPath, content, 'utf-8')
      return true
    } catch {
      return false
    }
  },

  async rollback(): Promise<boolean> {
    const propsPath = getGradlePropsPath()
    try {
      const backup = await readFile(propsPath + '.vpn-backup', 'utf-8')
      await writeFile(propsPath, backup, 'utf-8')
      return true
    } catch {
      return false
    }
  },

  async isApplied(): Promise<boolean> {
    const propsPath = getGradlePropsPath()
    try {
      const content = await readFile(propsPath, 'utf-8')
      return content.includes('VPN Tunnel Enforcer')
    } catch {
      return false
    }
  }
}
