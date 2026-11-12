export type PetMode = 'idle' | 'thinking' | 'talking' | 'working' | 'happy' | 'oops' | 'sleeping'
export type PetState = { mode: PetMode; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'clau': { pet: Shaped<PetState> }
  }
}
