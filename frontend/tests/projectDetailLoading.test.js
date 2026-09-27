import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as pbErrors from '../src/utils/pbErrors.js'

// Execute the actual mounted callback with the component's declared error
// imports, so a missing import cannot be hidden by the test's own imports.
// The patterns below are anchored to "\n", so normalize CRLF checkouts
// (Windows defaults to core.autocrlf=true) instead of depending on them.
const source = readFileSync(new URL('../src/views/admin/ProjectDetailView.vue', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')
const imports = source.match(/import \{([^}]+)\} from '@\/utils\/pbErrors'/)
const mounted = source.match(/onMounted\((async \(\) => \{[\s\S]*?)\n\}\)\n/)
assert.ok(imports, 'component must declare its error helper imports')
assert.ok(mounted, 'component must register a mounted callback')
const helpers = Object.fromEntries(imports[1].split(',').map((name) => {
  const binding = name.trim()
  return [binding, pbErrors[binding]]
}))

for (const { name, error, message } of [
  { name: 'expired login', error: { status: 401 }, message: '登录状态已失效，请重新登录。' },
  { name: 'forbidden project', error: { status: 403 }, message: '无权限查看该项目。' },
  { name: 'missing project', error: { response: { status: 404 } }, message: '项目不存在。' },
  { name: 'network failure', error: new Error('Failed to fetch'), message: 'Failed to fetch' },
  { name: 'unknown failure', error: {}, message: '加载项目失败，请稍后重试。' }
]) {
  test(`project loading stops and displays an error for ${name}`, async () => {
    const project = { value: null }
    const projectError = { value: '' }
    const loadingProject = { value: true }
    const bindings = {
      ...helpers,
      project,
      projectError,
      loadingProject,
      projectId: 'missing-project',
      getProject: async (id) => {
        assert.equal(id, 'missing-project')
        throw error
      },
      loadPages: () => assert.fail('must not load pages after a project request fails')
    }
    const callback = new Function(...Object.keys(bindings), `return (${mounted[1]}\n})`)(...Object.values(bindings))
    await callback()
    assert.equal(loadingProject.value, false)
    assert.equal(projectError.value, message)
    assert.equal(project.value, null)
  })
}
