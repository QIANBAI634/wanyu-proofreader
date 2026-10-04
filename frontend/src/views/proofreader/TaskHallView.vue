<template>
  <main class="container page workspace-page">
    <header class="page-heading">
      <div>
        <div class="page-eyebrow">校对工作台</div>
        <h1>从最需要你的项目开始</h1>
        <p>进行中的任务排在最前；每次只需独立判断当前材料。</p>
      </div>
      <button class="btn btn-secondary" @click="loadProjects" :disabled="loading">
        <span aria-hidden="true">↻</span>
        {{ loading ? '正在刷新' : '刷新项目' }}
      </button>
    </header>

    <div v-if="error" class="alert alert-error" role="alert">
      <strong>项目暂时无法加载。</strong>
      <span>{{ error }}</span>
    </div>

    <section class="workspace-summary" aria-label="我的校对概况">
      <article class="workspace-stat workspace-stat--accent">
        <span>正在处理</span>
        <strong>{{ queueSummary.activeProjects }}</strong>
        <small>个项目有我的未提交任务</small>
      </article>
      <article class="workspace-stat">
        <span>现在可领取</span>
        <strong>{{ queueSummary.availableProjects }}</strong>
        <small>个项目有适合我的下一条</small>
      </article>
      <article class="workspace-stat">
        <span>整体已完成</span>
        <strong>{{ queueSummary.completedItems }}<em>/{{ queueSummary.totalItems }}</em></strong>
        <small>条已完成校对流程</small>
      </article>
    </section>

    <section aria-labelledby="project-list-title">
      <div class="section-heading">
        <div>
          <h2 id="project-list-title">项目队列</h2>
          <p>系统会保留本地草稿；完成提交后自动领取同项目下一条。</p>
        </div>
        <span v-if="!loading" class="section-count">{{ projectQueues.length }} 个项目</span>
      </div>

      <div v-if="loading" class="project-card-grid" aria-label="正在加载项目">
        <div v-for="index in 3" :key="index" class="project-work-card skeleton-card" aria-hidden="true">
          <span class="skeleton-line skeleton-line--short"></span>
          <span class="skeleton-line"></span>
          <span class="skeleton-line"></span>
        </div>
      </div>

      <div v-else-if="projectQueues.length === 0" class="empty-state card">
        <div class="empty-state-mark" aria-hidden="true">✓</div>
        <div class="empty-state-text">当前没有需要你处理的项目</div>
        <p>可能是所有条目已经完成，或暂时没有适合你的独立校对任务。</p>
      </div>

      <div v-else class="project-card-grid">
        <article
          v-for="queue in projectQueues"
          :key="queue.project.id"
          class="project-work-card"
          :class="`project-work-card--${queueAction(queue).tone}`"
        >
          <header class="project-work-card__header">
            <div>
              <span class="work-state" :class="`work-state--${queueAction(queue).tone}`">
                {{ queueAction(queue).label }}
              </span>
              <h3>{{ queue.project.name }}</h3>
            </div>
            <span class="project-progress-number">{{ progressPct(queue) }}%</span>
          </header>

          <p class="project-description">
            {{ queue.project.description || '该项目暂未填写简介。' }}
          </p>

          <div class="progress project-progress" role="progressbar" :aria-valuenow="progressPct(queue)" aria-valuemin="0" aria-valuemax="100">
            <div class="progress-bar" :style="{ width: progressPct(queue) + '%' }"></div>
          </div>

          <dl class="queue-metrics">
            <div>
              <dt>可领取</dt>
              <dd>{{ queue.claimable }}</dd>
            </div>
            <div>
              <dt>我的进行中</dt>
              <dd>{{ queue.activeMine }}</dd>
            </div>
            <div>
              <dt>完成</dt>
              <dd>{{ queue.completed }} / {{ queue.total }}</dd>
            </div>
          </dl>

          <div v-if="tierRows(queue).length" class="queue-tiers" aria-label="按难度层级领取">
            <button
              v-for="option in tierRows(queue)"
              :key="option.key"
              class="queue-tier"
              :disabled="claimingProject === queue.project.id"
              @click="enterProject(queue, option.key)"
            >{{ option.label }} · {{ option.count }}</button>
            <span v-if="tierUnknown(queue)" class="queue-tier queue-tier--muted">
              信号不足 {{ tierUnknown(queue) }}
            </span>
            <span v-if="tierUnlabeled(queue)" class="queue-tier queue-tier--muted">
              未评估 {{ tierUnlabeled(queue) }}
            </span>
            <span v-if="tierResidual(queue)" class="queue-tier queue-tier--warn" role="status">
              {{ tierResidualText(queue) }}
            </span>
          </div>

          <footer class="project-work-card__footer">
            <span>{{ queueAction(queue).detail }}</span>
            <button
              class="btn"
              :class="queueAction(queue).tone === 'active' ? 'btn-success' : 'btn-primary'"
              :disabled="claimingProject === queue.project.id || !queueAction(queue).canEnter"
              @click="enterProject(queue)"
            >
              {{ claimingProject === queue.project.id ? '正在打开…' : queueAction(queue).label }}
              <span v-if="queueAction(queue).canEnter" aria-hidden="true">→</span>
            </button>
          </footer>
        </article>
      </div>
      <nav v-if="totalPages > 1" class="admin-pagination" aria-label="项目分页">
        <button class="btn btn-secondary" :disabled="loading || currentPage <= 1" @click="currentPage--; loadProjects()">上一页</button>
        <span>第 {{ currentPage }} / {{ totalPages }} 页</span>
        <button class="btn btn-secondary" :disabled="loading || currentPage >= totalPages" @click="currentPage++; loadProjects()">下一页</button>
      </nav>
    </section>
  </main>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { currentUserId } from '@/services/authService'
import { claimNextProjectPage, listProjectQueueSummaries } from '@/services/pagesService'
import { getProofreaderQueueAction, summarizeProofreaderQueues } from '@/lib/workspaceInsights'
import { tierBreakdown } from '@/lib/taskTiers'
import { formatClaimConflict, formatPbError } from '@/utils/pbErrors'
import { saveTaskLease } from '@/lib/taskLease'

const router = useRouter()
const auth = useAuthStore()
const loading = ref(true)
const claimingProject = ref('')
const error = ref('')
const projectQueues = ref([])
const queueSummary = ref(summarizeProofreaderQueues([]))
const currentPage = ref(1)
const totalPages = ref(1)
let loadGeneration = 0

onMounted(async () => {
  await loadProjects()
})

async function loadProjects() {
  const generation = ++loadGeneration
  loading.value = true
  error.value = ''
  try {
    const userId = currentUserId(auth.user)
    if (!userId) throw new Error('登录状态已失效，请重新登录')
    const result = await listProjectQueueSummaries(currentPage.value)
    if (generation !== loadGeneration) return
    projectQueues.value = result.items
    queueSummary.value = result.summary
    currentPage.value = result.page
    totalPages.value = result.totalPages
  } catch (e) {
    if (generation !== loadGeneration) return
    error.value = formatPbError('加载项目大厅失败', e)
    projectQueues.value = []
  } finally {
    if (generation === loadGeneration) loading.value = false
  }
}

async function enterProject(queue, tier = '') {
  const projectId = queue?.project?.id
  if (!projectId || claimingProject.value || !queueAction(queue).canEnter) return
  claimingProject.value = projectId
  error.value = ''
  try {
    const userId = currentUserId(auth.user)
    if (!userId) throw new Error('登录状态已失效，请重新登录')
    const page = await claimNextProjectPage(projectId, userId, '', tier)
    if (!page?.id) {
      error.value = tier
        ? `${tier} 类暂时没有可领取的条目，换个层级或按默认顺序领一条。`
        : '该项目暂无你可处理的条目。'
      await loadProjects()
      return
    }
    saveTaskLease(window.sessionStorage, {
      userId,
      pageId: page.id,
      token: page.leaseToken,
      expiresAt: page.leaseExpiresAt
    })
    await router.push(`/tasks/${page.id}/edit`)
  } catch (e) {
    error.value = `进入项目失败：${formatClaimConflict(e, '该项目的下一条任务可能已被其他校对员接取，请刷新后重试')}`
    await loadProjects()
  } finally {
    claimingProject.value = ''
  }
}

function queueAction(queue) {
  return getProofreaderQueueAction(queue)
}

// #162：层级是渐进增强。没算过标签的项目在这里就是空数组，卡片与改动前一致。
function tierRows(queue) {
  return tierBreakdown(queue)?.options ?? []
}

function tierUnlabeled(queue) {
  return tierBreakdown(queue)?.unlabeledCount ?? 0
}

// #247：unknown（算过但信号不足）与 unlabeled（从没算过）是两件事，
// 必须各说各的——合成一句"没层级"会让人以为再等等就有了。
function tierUnknown(queue) {
  return tierBreakdown(queue)?.unknownCount ?? 0
}

function tierResidual(queue) {
  return tierBreakdown(queue)?.residual ?? 0
}

function tierResidualText(queue) {
  const gap = tierResidual(queue)
  return gap > 0 ? `另有 ${gap} 条未落任何档` : `分层计数比可领取多 ${-gap} 条`
}

function progressPct(queue) {
  if (!queue?.total) return 0
  return Math.round((queue.completed / queue.total) * 100)
}
</script>
