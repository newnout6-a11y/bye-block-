import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

function getGradlePropsPath(): string {
  return join(homedir(), '.gradle', 'gradle.properties')
}

export const gradle = {
  name: 'Gradle',

  async apply(proxyAddr: string, proxyType: 'socks5' | 'http' = 'socks5'): Promise<boolean> {
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

      // Gradle's JVM proxy switches differ for SOCKS vs HTTP. Mismatched scheme
      // (socksProxyHost pointed at an HTTP port, or http.proxyHost at a SOCKS
      // port) silently breaks every dependency download.
      const proxyLines = proxyType === 'socks5'
        ? `\n# VPN Tunnel Enforcer\nsystemProp.socksProxyHost=${host}\nsystemProp.socksProxyPort=${port}\nsystemProp.http.nonProxyHosts=localhost|127.*|[::1]\n`
        : `\n# VPN Tunnel Enforcer\nsystemProp.http.proxyHost=${host}\nsystemProp.http.proxyPort=${port}\nsystemProp.https.proxyHost=${host}\nsystemProp.https.proxyPort=${port}\nsystemProp.http.nonProxyHosts=localhost|127.*|[::1]\n`
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
