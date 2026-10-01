<template>
  <main class="container page workspace-page">
    <header class="page-heading">
      <div>
        <RouterLink to="/admin" class="back-link">← 返回项目管理</RouterLink>
        <div class="page-eyebrow">AI 辅助校对</div>
        <h1>规则门控</h1>
        <p>
          规则算出的疑点要经过这张表才进得了校对端：缺行按 <code>off</code> 处理，也就是一条都不给。
          升档必须带达到门槛的实测证据，降档随时可以。
        </p>
      </div>
    </header>

    <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>
    <div v-if="success" class="alert alert-success" role="status">{{ success }}</div>

    <div v-if="!auth.isPlatformAdmin" class="card">
      <div class="empty-state">
        <div class="empty-state-text">只有平台管理员能调整规则门控</div>
        <p>档位是跨项目共用的状态：项目管理员可以重算本项目的疑点，但不能决定某条规则全网放不放行。</p>
      </div>
    </div>

    <template v-else>
      <section class="card mb-6">
        <div class="section-heading">
          <div>
            <h2>登记表</h2>
            <p>共 {{ items.length }} 条登记规则。<code>off</code> 不等于不计算：规则照常跑、照常写库，只在管理端统计里可见。</p>
          </div>
          <button class="btn btn-secondary" :disabled="loading" @click="load">刷新</button>
        </div>
        <div v-if="loading" class="text-muted">正在加载门控登记表…</div>
        <div v-else-if="!items.length" class="empty-state">
          <div class="empty-state-text">登记表还是空的</div>
          <p>这意味着所有规则都在 <code>off</code>：校对端看不到任何机器疑点。用下面的变更集入口把已批准的一批写进来。</p>
        </div>
        <div v-else class="table-wrapper">
          <table>
            <thead>
              <tr><th>规则</th><th>档位</th><th>证据</th><th>批准 / 变更集</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in items" :key="ruleKey(item)">
                <td>
                  <code>{{ item.kind }} / {{ item.message_key }}</code>
                  <div class="text-sm text-muted">{{ item.producer }} · {{ item.producer_version }}</div>
                </td>
                <td><span :class="gateBadgeClass(item.gate)">{{ gateLabel(item.gate) }}</span>
                  <div v-if="item.revoked_at" class="text-sm text-muted">已撤销 {{ item.revoked_at }}</div>
                </td>
                <td>{{ evidenceText(item) }}<div class="text-sm text-muted">{{ item.evaluated_at || '未记评估时间' }}</div></td>
                <td>
                  <div class="text-sm">{{ item.approved_by || '未记批准人' }}</div>
                  <div class="text-sm text-muted"><code>{{ item.changeset || '—' }}</code></div>
                </td>
                <td>
                  <button class="btn btn-quiet btn-sm" :disabled="busyRule === ruleKey(item)" @click="openRevoke(item)">
                    撤销降档
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="truncated" class="text-sm text-muted">
          登记表超过单次读取上限，这里只显示前 {{ items.length }} 条；请缩小范围后再操作。
        </p>
      </section>

      <section v-if="revokeTarget" class="card mb-6">
        <div class="section-heading">
          <div>
            <h2>撤销：把 {{ revokeTarget.kind }} / {{ revokeTarget.message_key }} 关回 off</h2>
            <p>撤销是 kill switch，不受证据门槛约束。撤销后这条规则会被标记为人工降档，后续变更集不能把它悄悄抬回去，除非显式恢复。</p>
          </div>
        </div>
        <label class="form-group">
          <span class="form-label">理由（会留在登记行上）</span>
          <input v-model.trim="revokeNote" class="form-control" maxlength="500" placeholder="例如：抽检发现误报率高于门槛" />
        </label>
        <div class="d-flex gap-2">
          <button class="btn btn-primary" :disabled="busy" @click="submitRevoke">{{ busy ? '正在撤销…' : '确认撤销' }}</button>
          <button class="btn btn-quiet" :disabled="busy" @click="revokeTarget = null">取消</button>
        </div>
      </section>

      <section class="card">
        <div class="section-heading">
          <div>
            <h2>应用已批准的变更集</h2>
            <p>
              变更集由 <code>node scripts/assist/gate_changeset.mjs --score … --approved-by …</code> 产出，
              评审通过后把 JSON 贴进来或选文件。判据不满足的升档会被逐条拒绝，其余条目照常应用。
            </p>
          </div>
        </div>
        <input type="file" accept="application/json,.json" class="form-control mb-4" @change="pickFile" />
        <label class="form-group">
          <span class="form-label">变更集 JSON</span>
          <textarea v-model="changesetText" class="form-control" rows="8" spellcheck="false"
            placeholder='{"changeset":"cs-2026-09-30-a","entries":[…]}'></textarea>
        </label>
        <div v-if="problem" class="alert alert-error" role="alert">{{ problem }}</div>
        <div v-if="preview" class="mb-4">
          <p class="text-sm">
            变更集 <code>{{ preview.changeset }}</code>：共 {{ preview.total }} 条 ·
            <span v-for="(count, gate) in preview.by_gate" :key="gate">{{ gateLabel(gate) }} {{ count }} 条，</span>
          </p>
          <p v-if="preview.approvers.length" class="text-sm text-muted">批准人：{{ preview.approvers.join('、') }}</p>
          <p v-else class="text-sm text-muted">条目里没有批准人，提交后会被逐条拒（每条都必须署名）。</p>
        </div>
        <button class="btn btn-primary" :disabled="busy || !parsed" @click="submitChangeset">
          {{ busy ? '正在应用…' : '应用变更集' }}
        </button>
        <div v-if="summary" class="mt-4">
          <p class="text-sm">{{ summary.counts }}</p>
          <p v-if="summary.inert" class="alert alert-warning" role="status">
            这一批没有任何档位被写入：要么全部被拒，要么库里本来就是这个状态。校对端不会因此看到新标记。
          </p>
          <ul v-if="summary.refused.length">
            <li v-for="entry in summary.refused" :key="`${entry.kind}/${entry.message_key}`" class="text-sm">
              <code>{{ entry.kind }} / {{ entry.message_key }}</code> 被拒：{{ entry.reason }}
            </li>
          </ul>
          <ul v-if="summary.locked.length">
            <li v-for="entry in summary.locked" :key="`${entry.kind}/${entry.message_key}`" class="text-sm text-muted">
              <code>{{ entry.kind }} / {{ entry.message_key }}</code> 保持人工降档，变更集不覆盖撤销标记
            </li>
          </ul>
        </div>
      </section>
    </template>
  </main>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import {
  evidenceText,
  gateBadgeClass,
  gateLabel,
  readChangeset,
  summariseApply
} from '@/lib/gateChangeset'
import { applyGateChangeset, listGates, revokeGate } from '@/services/gateService'
import { useAuthStore } from '@/stores/auth'
import { getPbMessage } from '@/utils/pbErrors'

const auth = useAuthStore()
const items = ref([])
const truncated = ref(false)
const loading = ref(true)
const busy = ref(false)
const busyRule = ref('')
const error = ref('')
const success = ref('')
const changesetText = ref('')
const problem = ref('')
const summary = ref(null)
const revokeTarget = ref(null)
const revokeNote = ref('')

const parsed = computed(() => readChangeset(changesetText.value))
const preview = computed(() => (parsed.value.ok ? parsed.value.preview : null))

function ruleKey(item) {
  return [item.producer, item.producer_version, item.kind, item.message_key].join('|')
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await listGates({ limit: 500 })
    items.value = result.items || []
    truncated.value = Boolean(result.truncated)
  } catch (cause) {
    error.value = getPbMessage(cause, '门控登记表加载失败')
  } finally {
    loading.value = false
  }
}

async function pickFile(event) {
  const file = event.target?.files?.[0]
  if (!file) return
  changesetText.value = await file.text()
  summary.value = null
}

async function submitChangeset() {
  const read = readChangeset(changesetText.value)
  problem.value = read.ok ? '' : read.problem
  if (!read.ok) return
  busy.value = true
  error.value = ''
  success.value = ''
  try {
    const result = await applyGateChangeset(read.payload)
    summary.value = summariseApply(result)
    success.value = `变更集 ${result.changeset} 已应用完毕，档位变化以下面逐项计数为准。`
    await load()
  } catch (cause) {
    error.value = getPbMessage(cause, '应用变更集失败')
  } finally {
    busy.value = false
  }
}

function openRevoke(item) {
  revokeTarget.value = item
  revokeNote.value = ''
  error.value = ''
}

async function submitRevoke() {
  const target = revokeTarget.value
  if (!target) return
  busy.value = true
  error.value = ''
  try {
    await revokeGate({
      producer: target.producer,
      producer_version: target.producer_version,
      kind: target.kind,
      message_key: target.message_key,
      note: revokeNote.value
    })
    success.value = `${target.kind} / ${target.message_key} 已关回 off：校对端立刻看不到它的疑点，规则仍在计算。`
    revokeTarget.value = null
    await load()
  } catch (cause) {
    error.value = getPbMessage(cause, '撤销失败')
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>
