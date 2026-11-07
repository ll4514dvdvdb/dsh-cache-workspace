/**
 * dsh-cache-workspace — Host half.
 *
 * Lets the user pick a scratch ("cache") folder inside the session workspace and
 * teaches the agent three rules about it. The folder lives inside the workspace
 * because the sandbox has no per-session writable-root API: anything outside the
 * session cwd is denied to the agent's file and shell tools.
 *
 * State lives in `~/.dsh/dsh-cache-workspace/state.json`, keyed by workspace path,
 * so every session sharing a workspace shares the choice.
 */

import { promises as fsp, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'

export const name = 'dsh-cache-workspace'
export const inject = ['webServer', 'sessions']

const ROUTE = '/dsh-cache-workspace'
const STATE_DIR = path.join(os.homedir(), '.dsh', 'dsh-cache-workspace')
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const LOG_FILE = path.join(STATE_DIR, 'log.txt')
const DEFAULT_NAME = '.dsh-cache'
const MAX_OPTIONS = 60
const MAX_NAME_LENGTH = 64

/* ------------------------------------------------------------------ logging */

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    mkdirSync(STATE_DIR, { recursive: true })
  } catch {
    return
  }
  fsp.appendFile(LOG_FILE, line, 'utf8').catch(() => {})
}

/* -------------------------------------------------------------------- state */

let state = { version: 1, selections: {}, grants: {} }

function loadState() {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
  } catch (error) {
    logLine(`ensureStateDir failed: ${error && error.message}`)
  }
  try {
    const raw = readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.selections && typeof parsed.selections === 'object') {
      const selections = {}
      for (const [key, value] of Object.entries(parsed.selections)) {
        const storedName = value && typeof value.name === 'string' ? value.name.trim() : ''
        const legal = storedName !== '' && (path.isAbsolute(storedName) || validateRelative(storedName) === null)
        if (legal) {
          selections[key] = { name: storedName, updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0 }
        }
      }
      // Folders outside the workspace that this plugin already granted to the
      // sandbox write SID. Keyed by the normalized path.
      const grants = {}
      if (parsed.grants && typeof parsed.grants === 'object') {
        for (const [key, value] of Object.entries(parsed.grants)) {
          if (!value || typeof value.path !== 'string' || !path.isAbsolute(value.path)) continue
          grants[key] = {
            path: value.path,
            sid: typeof value.sid === 'string' ? value.sid : '',
            updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
          }
        }
      }
      state = { version: 1, selections, grants }
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') logLine(`loadState failed: ${error && error.message}`)
  }
}

let saveChain = Promise.resolve()
function saveState() {
  const snapshot = JSON.stringify(state, null, 2)
  saveChain = saveChain
    .then(async () => {
      mkdirSync(STATE_DIR, { recursive: true })
      const tmp = `${STATE_FILE}.tmp`
      await fsp.writeFile(tmp, snapshot, 'utf8')
      await fsp.rename(tmp, STATE_FILE)
    })
    .catch((error) => {
      logLine(`saveState failed: ${error && error.message}`)
    })
  return saveChain
}

/* -------------------------------------------------------------- path helpers */

/** Host context captured by apply(), so the helpers below can read the live sandbox policy. */
let ctxRef = null

/**
 * Roots the sandbox policy lets the agent write to. The policy object is frozen
 * config, so this is a read: extra roots come from the profile's
 * `sandbox-policy` patch entry (`additionalWritableRoots`).
 */
function extraWritableRoots() {
  let policy = null
  try {
    policy = ctxRef && typeof ctxRef.get === 'function' ? ctxRef.get('sandboxPolicy') : null
  } catch (error) {
    logLine(`sandboxPolicy lookup failed: ${error && error.message}`)
    return []
  }
  const list = policy && Array.isArray(policy.additionalWritableRoots) ? policy.additionalWritableRoots : []
  const roots = []
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) continue
    try {
      roots.push(path.resolve(item))
    } catch {
      /* an unparsable root is simply not usable */
    }
  }
  return roots
}

function normalizeForCompare(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(left, right) {
  return normalizeForCompare(left) === normalizeForCompare(right)
}

/** True when `target` is strictly inside `root` (the root itself does not count). */
function isInsideRoot(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function rootsFor(cwd) {
  const roots = [path.resolve(cwd)]
  for (const extra of writableExtras()) {
    if (!roots.some((root) => samePath(root, extra))) roots.push(extra)
  }
  return roots
}

/** The deployment's default sandbox mode, or null when the policy service is absent. */
function policyMode() {
  try {
    const policy = ctxRef && typeof ctxRef.get === 'function' ? ctxRef.get('sandboxPolicy') : null
    return policy && typeof policy.defaultMode === 'string' ? policy.defaultMode : null
  } catch (error) {
    logLine(`sandboxPolicy mode lookup failed: ${error && error.message}`)
    return null
  }
}

/** Roots outside the workspace that this plugin itself granted to the sandbox write SID. */
function grantedRoots() {
  const roots = []
  const grants = state.grants && typeof state.grants === 'object' ? state.grants : {}
  for (const grant of Object.values(grants)) {
    if (grant && typeof grant.path === 'string' && path.isAbsolute(grant.path)) roots.push(path.resolve(grant.path))
  }
  return roots
}

/** Every directory outside the workspace the sandbox accepts: policy roots plus our own grants. */
function writableExtras() {
  const roots = []
  for (const root of [...extraWritableRoots(), ...grantedRoots()]) {
    if (!roots.some((existing) => samePath(existing, root))) roots.push(root)
  }
  return roots
}

/** The extra writable root that contains `target`, or null. */
function matchExtraRoot(target) {
  for (const extra of writableExtras()) {
    if (samePath(extra, target) || isInsideRoot(extra, target)) return extra
  }
  return null
}

/* ------------------------------------------------------------------ windows ACL */

function runProcess(file, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

const GRANT_SCRIPT = [
  'param([string]$Path, [string]$SidString)',
  'try {',
  '  $acl = Get-Acl -LiteralPath $Path',
  '  $sid = New-Object System.Security.Principal.SecurityIdentifier($SidString)',
  "  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')",
  '  $acl.AddAccessRule($rule)',
  '  Set-Acl -LiteralPath $Path -AclObject $acl',
  "  Write-Output 'GRANTED'",
  '} catch {',
  '  Write-Error $_.Exception.Message',
  '  exit 1',
  '}',
  '',
].join('\n')

const writeSidCache = new Map()

/**
 * The write SID the DSH Windows ACL sandbox derives from a workspace path. It is
 * deterministic (a "per-workspace identity"), so one ACE per directory stays
 * valid across restarts. Read from the workspace's own DACL, which the sandbox
 * already updated the first time it ran a session there.
 */
async function workspaceWriteSidFor(cwd) {
  const key = workspaceKey(cwd)
  const cached = writeSidCache.get(key)
  if (cached) return cached
  const result = await runProcess('icacls.exe', [cwd])
  const match = /S-1-4-\d+-\d+/.exec(result.stdout)
  if (!match) {
    logLine(`write SID not found in workspace ACL: ${cwd}`)
    return null
  }
  writeSidCache.set(key, match[0])
  return match[0]
}

/**
 * Give the sandbox write SID a Modify ACE on a folder outside the workspace so
 * the agent's shell and file tools can actually use it. This replaces
 * `additionalWritableRoots`, which the Windows ACL backend rejects outright.
 */
async function ensureExternalGrant(cwd, dir) {
  const sid = await workspaceWriteSidFor(cwd)
  if (!sid) {
    throw new Error(
      '读不到沙箱的写权限标识：这个工作区还没在「标准模式」下运行过。请把会话切到标准模式跑一次，再回来选工作区外的目录。',
    )
  }
  mkdirSync(STATE_DIR, { recursive: true })
  const scriptPath = path.join(STATE_DIR, 'grant.ps1')
  try {
    writeFileSync(scriptPath, GRANT_SCRIPT, 'utf8')
  } catch (error) {
    throw new Error(`无法写入授权脚本：${error && error.message}`)
  }
  const result = await runProcess('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    dir,
    sid,
  ])
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 400)
    logLine(`grant failed dir=${dir} sid=${sid} code=${result.code} ${detail}`)
    throw new Error(`无法给这个目录加沙箱写权限（通常是目录不属于当前用户）：${detail || `powershell exit ${result.code}`}`)
  }
  state.grants[workspaceKey(dir)] = { path: path.resolve(dir), sid, updatedAt: Date.now() }
  await saveState()
  logLine(`granted dir=${dir} sid=${sid}`)
  return sid
}

function workspaceKey(cwd) {
  const resolved = path.resolve(cwd)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function validateName(raw) {
  if (typeof raw !== 'string') return '名字必须是字符串'
  const value = raw.trim()
  if (!value) return '名字不能为空'
  if (value.length > MAX_NAME_LENGTH) return `名字太长（最多 ${MAX_NAME_LENGTH} 个字符）`
  if (value === '.' || value === '..') return '这个名字不可用'
  if (/[\\/:*?"<>|]/.test(value)) return '不能包含这些字符：\\ / : * ? " < > |'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(value)) return '不能包含控制字符'
  if (/[. ]$/.test(value)) return '不能以点或空格结尾'
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) return '这是 Windows 保留名'
  return null
}

/**
 * Validate a folder path relative to the workspace: every segment must be a legal
 * folder name and the path must not climb out of the workspace.
 */
function validateRelative(raw) {
  if (typeof raw !== 'string') return '路径必须是字符串'
  const value = raw.trim()
  if (!value) return '路径不能为空'
  const segments = value.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return '路径不能为空'
  for (const segment of segments) {
    const invalid = validateName(segment)
    if (invalid) return invalid
  }
  const normalized = path.normalize(value)
  if (normalized === '.' || normalized.startsWith('..')) return '这个名字不可用'
  return null
}

/** Resolve a folder name to an absolute path that is proven to stay inside `cwd`. */
function resolveInside(cwd, name) {
  const target = path.resolve(cwd, name)
  const relative = path.relative(cwd, target)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('缓存目录必须位于当前工作区之内')
  }
  return target
}

function currentSelection(cwd) {
  const key = workspaceKey(cwd)
  const entry = state.selections[key]
  const stored = entry && typeof entry.name === 'string' ? entry.name.trim() : ''

  // A stored absolute path means the folder lives in an extra sandbox root.
  if (stored && path.isAbsolute(stored)) {
    const resolved = path.resolve(stored)
    if (matchExtraRoot(resolved)) {
      return {
        key,
        name: resolved,
        dir: resolved,
        isDefault: false,
        external: true,
        displayName: path.basename(resolved),
      }
    }
    logLine(`stored selection is outside the writable roots: ${stored}`)
  } else if (stored && validateRelative(stored) === null) {
    const dir = resolveInside(cwd, stored)
    return { key, name: stored, dir, isDefault: stored === DEFAULT_NAME, external: false, displayName: path.basename(dir) }
  }

  const dir = resolveInside(cwd, DEFAULT_NAME)
  return { key, name: DEFAULT_NAME, dir, isDefault: true, external: false, displayName: path.basename(dir) }
}

async function listOptions(cwd, current) {
  const options = [{ name: DEFAULT_NAME, label: `${DEFAULT_NAME}（默认）`, isDefault: true }]
  const seen = new Set([DEFAULT_NAME])
  // The native picker can land on a nested folder the flat listing never shows,
  // and it can land outside the workspace entirely; keep both in the list so the
  // control always has a matching option.
  if (typeof current === 'string' && current !== DEFAULT_NAME) {
    if (path.isAbsolute(current)) {
      options.push({ name: current, label: `${path.basename(current)}（工作区外）`, isDefault: false, external: true })
      seen.add(current)
    } else if (validateRelative(current) === null) {
      options.push({ name: current, label: current, isDefault: false })
      seen.add(current)
    }
  }
  try {
    const entries = await fsp.readdir(cwd, { withFileTypes: true })
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((entryName) => !seen.has(entryName) && validateName(entryName) === null)
      .sort((a, b) => {
        const hiddenA = a.startsWith('.') ? 1 : 0
        const hiddenB = b.startsWith('.') ? 1 : 0
        if (hiddenA !== hiddenB) return hiddenA - hiddenB
        return a.localeCompare(b)
      })
      .slice(0, MAX_OPTIONS)
    for (const entryName of dirs) options.push({ name: entryName, label: entryName, isDefault: false })
  } catch (error) {
    logLine(`listOptions(${cwd}) failed: ${error && error.message}`)
  }
  return options
}

async function dirExists(target) {
  try {
    const stat = await fsp.stat(target)
    return stat.isDirectory()
  } catch {
    return false
  }
}

/** Real path when it resolves, the plain absolute path otherwise. */
async function realpathOr(target) {
  try {
    return await fsp.realpath(target)
  } catch {
    return path.resolve(target)
  }
}

/* ------------------------------------------------------------------ responses */

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/* -------------------------------------------------------------------- delete */

/**
 * Removes the folder from a detached `cmd.exe` process: the delete must survive
 * this conversation being archived mid-way, so it must not run inside the agent.
 */
function scheduleClear(target) {
  const child = spawn('cmd.exe', ['/c', 'rd', '/s', '/q', target], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: os.homedir(),
  })
  const collect = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const text = line.trim()
      if (text) logLine(text)
    }
  }
  if (child.stdout) child.stdout.on('data', collect)
  if (child.stderr) child.stderr.on('data', collect)
  child.on('error', (error) => {
    logLine(`clear spawn failed for ${target}: ${error && error.message}`)
  })
  child.on('exit', (code, signal) => {
    logLine(`clear process exit code=${code} signal=${signal} target=${target}`)
  })
  child.unref()
  return child.pid
}

/* -------------------------------------------------------------------- prompt */

function buildSection(cwd) {
  const { displayName, dir, external } = currentSelection(cwd)
  const example = path.join(dir, '<本次工作名>')
  return [
    '## 缓存工作区',
    '',
    '当前工作区有一个插件提供的专用缓存目录：',
    '',
    `\`${dir}\``,
    ...(external ? ['', '（该目录在工作区之外。插件已给沙箱的写权限标识授予了该目录的修改权限，所以你的文件与命令工具可以正常读写它。）'] : []),
    '',
    '规则：',
    '',
    `1. 你可以在缓存目录里任意创建、读取、修改、执行、删除文件。`,
    `2. 不要在缓存目录根目录堆放文件。先按本次工作建一个子文件夹（例如 \`${example}\`），所有中间产物都放进那个子文件夹。`,
    '3. 缓存目录可能在工作结束后被清理，它不是长期存储。需要保留的成果要写到工作区里的其他位置，并向用户说明落在了哪里。',
    `4. 如果你在这个会话里用过缓存目录，任务结束时提醒用户：现在可以清理缓存目录「${displayName}」了——点输入框工具栏里缓存控件右侧的 🧹 按钮，删除在独立进程中进行，即使对话被归档也会完成。`,
    external
      ? '5. 只有上面这个缓存目录（以及工作区本身）可写；其他路径仍受沙箱限制。'
      : '5. 工作区以外的路径受沙箱限制不可写；如果确实需要，可以在缓存控件里选工作区外的文件夹，插件会为它单独授权。',
    '',
  ].join('\n')
}

/* ---------------------------------------------------------------------- apply */

export function apply(ctx) {
  ctxRef = ctx
  loadState()

  function sessionCwd(sessionId) {
    if (!sessionId) return null
    const sessions = ctx.get('sessions')
    if (!sessions) return null
    const session = sessions.get(sessionId)
    if (!session) return null
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory) {
      try {
        const dir = workingDirectory.get(session)
        if (dir) return dir
      } catch (error) {
        logLine(`workingDirectory.get failed: ${error && error.message}`)
      }
    }
    return session.header && session.header.cwd ? session.header.cwd : null
  }

  async function describe(cwd) {
    const selection = currentSelection(cwd)
    const [options, exists] = await Promise.all([listOptions(cwd, selection.name), dirExists(selection.dir)])
    return {
      cwd,
      name: selection.name,
      displayName: selection.displayName,
      cacheDir: selection.dir,
      isDefault: selection.isDefault,
      external: selection.external === true,
      exists,
      defaultName: DEFAULT_NAME,
      mode: policyMode(),
      writableRoots: rootsFor(cwd),
      options,
    }
  }

  async function setSelection(cwd, rawName) {
    const trimmed = typeof rawName === 'string' ? rawName.trim() : ''
    if (trimmed && path.isAbsolute(trimmed)) return setSelectionFromPath(cwd, trimmed)
    const key = workspaceKey(cwd)
    if (!trimmed || trimmed === DEFAULT_NAME) {
      delete state.selections[key]
      await saveState()
      return describe(cwd)
    }
    const invalid = validateRelative(trimmed)
    if (invalid) throw new Error(invalid)
    const target = resolveInside(cwd, trimmed)
    await fsp.mkdir(target, { recursive: true })
    state.selections[key] = { name: path.normalize(trimmed), updatedAt: Date.now() }
    await saveState()
    return describe(cwd)
  }

  /**
   * Select the folder the native picker returned. Two kinds of location are
   * accepted: anywhere inside the session workspace, and anywhere inside a
   * writable root the sandbox policy was configured with — those are exactly the
   * places the agent's file and shell tools can actually write.
   */
  async function setSelectionFromPath(cwd, rawPath) {
    const requested = path.resolve(rawPath)
    const realCwd = await realpathOr(cwd)
    const realTarget = await realpathOr(requested)
    const key = workspaceKey(cwd)

    let stored = null
    if (isInsideRoot(realCwd, realTarget)) {
      stored = path.normalize(path.relative(realCwd, realTarget))
    } else if (samePath(realCwd, realTarget)) {
      throw new Error('不能把工作区根目录本身当缓存目录，请在里面选一个子文件夹')
    } else if (matchExtraRoot(realTarget)) {
      stored = realTarget
    } else {
      // Outside every writable root: create the folder, then hand the sandbox
      // write SID a Modify ACE on it. That ACE — not a policy flag — is what
      // makes the directory usable for the agent's shell and file tools.
      await fsp.mkdir(realTarget, { recursive: true })
      await ensureExternalGrant(realCwd, realTarget)
      stored = realTarget
    }

    await fsp.mkdir(realTarget, { recursive: true })
    state.selections[key] = { name: stored, updatedAt: Date.now() }
    await saveState()
    return describe(cwd)
  }

  function withSession(handler) {
    return async (req, res) => {
      try {
        const url = new URL(req.url ?? ROUTE, 'http://127.0.0.1')
        let body = {}
        if (req.method === 'POST') body = await readJsonBody(req)
        const sessionId =
          (body && typeof body.sessionId === 'string' ? body.sessionId : null) ??
          url.searchParams.get('sessionId')
        const cwd = sessionCwd(sessionId)
        if (!cwd) {
          logLine(`${req.method} ${req.url} -> 404 session=${sessionId ?? '(missing)'}`)
          sendJson(res, 404, { error: '找不到这个会话，或它没有工作区' })
          return
        }
        await handler({ req, res, url, body, cwd })
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        logLine(`${req.method} ${req.url} failed: ${message}`)
        sendJson(res, 400, { error: message })
      }
    }
  }

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'exact',
          path: `${ROUTE}/state`,
          handler: withSession(async ({ res, cwd }) => {
            sendJson(res, 200, await describe(cwd))
          }),
        }),
      'dsh-cache-workspace: state route',
    )

    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'exact',
          path: `${ROUTE}/select`,
          handler: withSession(async ({ res, body, cwd }) => {
            if (body && typeof body.path === 'string' && body.path.trim()) {
              sendJson(res, 200, await setSelectionFromPath(cwd, body.path))
              return
            }
            sendJson(res, 200, await setSelection(cwd, body.name))
          }),
        }),
      'dsh-cache-workspace: select route',
    )

    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'exact',
          path: `${ROUTE}/create`,
          handler: withSession(async ({ res, body, cwd }) => {
            const rawName = typeof body.name === 'string' ? body.name.trim() : ''
            if (!rawName) throw new Error('文件夹名不能为空')
            sendJson(res, 200, await setSelection(cwd, rawName))
          }),
        }),
      'dsh-cache-workspace: create route',
    )

    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'exact',
          path: `${ROUTE}/clear`,
          handler: withSession(async ({ res, cwd }) => {
            const selection = currentSelection(cwd)
            if (!(await dirExists(selection.dir))) {
              sendJson(res, 200, { started: false, reason: '目录不存在或已经是空的', path: selection.dir })
              return
            }
            const pid = scheduleClear(selection.dir)
            logLine(`clear spawned pid=${pid} target=${selection.dir}`)
            sendJson(res, 200, { started: true, path: selection.dir, name: selection.name, pid })
          }),
        }),
      'dsh-cache-workspace: clear route',
    )
  })

  // Per-agent prompt: the text is rebuilt on every assembly so it always names
  // the folder the user currently has selected for that workspace.
  const agentDisposers = new Map()
  ctx.on('agent/created', ({ agent }) => {
    const scope = agent && agent.ctx
    if (!scope || typeof scope.effect !== 'function') return
    const systemPrompt = typeof scope.get === 'function' ? scope.get('systemPrompt') : undefined
    if (!systemPrompt || typeof systemPrompt.section !== 'function') return
    const agentId = agent.id
    const dispose = scope.effect(() => {
      const stop = systemPrompt.section({
        name: 'dsh-cache-workspace',
        order: 90,
        text: () => {
          const cwd = sessionCwd(agentId)
          if (!cwd) return ''
          try {
            return buildSection(cwd)
          } catch (error) {
            logLine(`prompt section failed for ${agentId}: ${error && error.message}`)
            return ''
          }
        },
      })
      return () => {
        try {
          if (typeof stop === 'function') stop()
        } catch (error) {
          logLine(`prompt section dispose failed: ${error && error.message}`)
        }
      }
    }, 'dsh-cache-workspace: agent prompt')
    agentDisposers.set(agentId, dispose)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    if (!agent) return
    const dispose = agentDisposers.get(agent.id)
    if (!dispose) return
    agentDisposers.delete(agent.id)
    try {
      dispose()
    } catch (error) {
      logLine(`agent prompt dispose failed: ${error && error.message}`)
    }
  })

  ctx.effect(() => {
    return () => {
      for (const [agentId, dispose] of agentDisposers) {
        agentDisposers.delete(agentId)
        try {
          dispose()
        } catch (error) {
          logLine(`plugin unload prompt dispose failed: ${error && error.message}`)
        }
      }
    }
  }, 'dsh-cache-workspace: dispose agent prompts')
}
