/**
 * 用 koffi 读写光标位置的小工具（供验证脚本调用）。
 *
 * 为什么单独成文件而不是写在验证脚本里：验证脚本跑在**普通 Node** 下，
 * 而 koffi 通过 Electron 的 Node 模式加载最省事（与主进程同一份二进制）。
 *
 * 用法：
 *   electron --no-sandbox scripts/cursor-tool.cjs get
 *   electron --no-sandbox scripts/cursor-tool.cjs set <x> <y>
 */

const koffi = require('koffi')

const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' })
const user32 = koffi.load('user32.dll')
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)')
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)')

const [, , command, argX, argY] = process.argv

if (command === 'get') {
  const p = { x: 0, y: 0 }
  GetCursorPos(p)
  process.stdout.write(JSON.stringify(p))
} else if (command === 'set') {
  const ok = SetCursorPos(Number(argX), Number(argY))
  process.stdout.write(ok ? 'ok' : 'failed')
} else {
  process.stderr.write('用法：cursor-tool.cjs get | set <x> <y>\n')
  process.exit(2)
}
