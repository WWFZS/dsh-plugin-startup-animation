'use strict'
/**
 * 桌面宠物窗的 preload：渲染端能碰到的全部口子。
 *
 * 渲染端是 file:// 页面，拿不到 Node、也碰不到主进程；这里每个方法都是
 * "转发一条固定形状的 IPC"，不接受任意 channel、不接受任意参数结构 ——
 * 多暴露一个口子都是白白扩大攻击面。
 *
 * @module runtime/pet-desktop/preload
 */const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dsaPet', {
  /** 按住宠物：主进程接管窗口跟随。 */
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  /** 松开：主进程判定是拖拽（甩出去/落盘）还是点击（回传 pet:tap）。 */
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  /** 被点了一下（主进程判定为非拖拽后回传）。 */
  onTap: (fn) => {
    const handler = () => fn()
    ipcRenderer.on('pet:tap', handler)
    return () => ipcRenderer.removeListener('pet:tap', handler)
  },
  /** 撞到屏幕边缘：主进程在反弹那一帧通知，渲染端做一下挤压。 */
  onBump: (fn) => {
    const handler = () => fn()
    ipcRenderer.on('pet:bump', handler)
    return () => ipcRenderer.removeListener('pet:bump', handler)
  },
  /** 停稳了（或飞行被打断）：回到待机。 */
  onLanded: (fn) => {
    const handler = () => fn()
    ipcRenderer.on('pet:landed', handler)
    return () => ipcRenderer.removeListener('pet:landed', handler)
  },
  /** 上报动作表（分类 + 动作名）：右键菜单由主进程画原生菜单，数据只有渲染端取到过。 */
  menuReady: (data) => ipcRenderer.send('pet:menu-data', data),
  /** 菜单项被点击：{ type: 'play' | 'random', id? }。归位/隐藏由主进程自己处理，不下发。 */
  onMenuAction: (fn) => {
    const handler = (_event, msg) => fn(msg)
    ipcRenderer.on('pet:menu-action', handler)
    return () => ipcRenderer.removeListener('pet:menu-action', handler)
  },
  /** 回报演出状态（模式 / 当前动作 / 音效次数）：只用于开发期验收。 */
  report: (state) => ipcRenderer.send('pet:state', state),
})
