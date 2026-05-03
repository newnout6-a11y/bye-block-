import { androidStudio } from './androidStudio'
import { gradle } from './gradle'
import { env } from './env'
import { git } from './git'

export interface AutoconfigTarget {
  id: string
  name: string
  applied: boolean
}

const targets: Record<string, {
  name: string
  apply: (proxyAddr: string) => Promise<boolean>
  rollback: () => Promise<boolean>
  isApplied: () => Promise<boolean>
}> = {
  'android-studio': androidStudio,
  'gradle': gradle,
  'env': env,
  'git': git
}

export const autoconfig = {
  async apply(targetIds: string[], proxyAddr: string): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {}
    for (const id of targetIds) {
      const target = targets[id]
      if (target) {
        try {
          results[id] = await target.apply(proxyAddr)
        } catch {
          results[id] = false
        }
      }
    }
    return results
  },

  async rollback(targetIds: string[]): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {}
    for (const id of targetIds) {
      const target = targets[id]
      if (target) {
        try {
          results[id] = await target.rollback()
        } catch {
          results[id] = false
        }
      }
    }
    return results
  },

  async getStatus(): Promise<AutoconfigTarget[]> {
    const result: AutoconfigTarget[] = []
    for (const [id, target] of Object.entries(targets)) {
      let applied = false
      try {
        applied = await target.isApplied()
      } catch { /* */ }
      result.push({ id, name: target.name, applied })
    }
    return result
  }
}
