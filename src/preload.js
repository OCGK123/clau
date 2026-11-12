// 화면(렌더러)과 메인 프로세스 사이의 좁은 다리.
const { contextBridge, ipcRenderer } = require('electron')

const on = (channel, fn) => ipcRenderer.on(channel, (_e, ...args) => fn(...args))

contextBridge.exposeInMainWorld('pet', {
  init: () => ipcRenderer.invoke('pet:init'),
  expand: open => ipcRenderer.send('pet:expand', open),
  bubbleClosed: () => ipcRenderer.send('chat:closed'),
  menu: () => ipcRenderer.send('pet:menu'),
  drag: (phase, dx = 0, dy = 0) => ipcRenderer.send('pet:drag', phase, dx, dy),
  ask: question => ipcRenderer.send('chat:ask', question),
  cancel: () => ipcRenderer.send('chat:cancel'),
  onCfg: fn => on('cfg', fn),
  onLayout: fn => on('pet:layout', fn),
  onVisibility: fn => on('pet:visibility', fn),
  onChatVisibility: fn => on('chat:visibility', fn),
  onChatLayout: fn => on('chat:layout', fn),
  onChatStarted: fn => on('chat:started', fn),
  onChatCancelled: fn => on('chat:cancelled', fn),
  onInput: fn => on('pet:input', fn),
  onHello: fn => on('pet:hello', fn),
  onClaudeCode: fn => on('cc:state', fn),
  onDelta: fn => on('chat:delta', fn),
  onDone: fn => on('chat:done', fn),
  onError: fn => on('chat:error', fn),
  onRateLimit: fn => on('chat:ratelimit', fn),
  onCleared: fn => on('chat:cleared', fn),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  listApps: () => ipcRenderer.invoke('settings:apps'),
  setSettings: patch => ipcRenderer.invoke('settings:set', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  clearChat: () => ipcRenderer.send('settings:clear-chat'),
  connectMod: on => ipcRenderer.invoke('mod:connect', on),
})
