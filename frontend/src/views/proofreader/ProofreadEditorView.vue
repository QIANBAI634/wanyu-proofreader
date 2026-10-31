<template>
  <DocumentReviewWorkspace
    :page="page"
    :keyboard-available="keyboardAvailable"
    :suspended="(mobile && overview) || reviewingSubmission"
    :loading="loadingPage"
    :pdf-enabled="!leaseLost && (!!leaseToken || saving || loadingPage)"
    :watermark-user-id="currentUserId"
    return-to="/tasks"
    return-label="返回大厅"
    content-labelled-by="task-panel-title"
    empty-pdf-description="请保存草稿并提交来源问题，待来源 PDF 可用后继续核对。"
  >
    <template #panel-header>
      <header class="editor-panel-header editor-panel-header--task">
        <div class="editor-context">
          <span>{{ projectName }} · 独立校对</span>
          <strong id="task-panel-title">第 {{ page?.page_number || '—' }} 条</strong>
        </div>
        <details class="task-actions-menu" :open="!mobile">
          <summary>任务操作</summary>
          <RouterLink v-if="mobile" to="/tasks" class="btn btn-quiet">返回大厅</RouterLink>
        <div class="editor-toolbar" aria-label="校对任务导航">
          <span class="task-position" aria-label="当前任务位置" aria-live="polite">{{ navigationLabel }}</span>
          <span v-if="navigationHint" class="text-sm text-muted" role="status">{{ navigationHint }}</span>
          <button v-if="neighborsState === 'error' && !submittedHere" class="btn btn-quiet btn-sm" @click="loadNeighbors">重试获取位置</button>
          <button
            class="btn btn-secondary btn-sm"
            @click="gotoPrevTask"
            :disabled="!canSwitchPrev"
          >上一条</button>
          <button
            class="btn btn-secondary btn-sm"
            @click="gotoNextTask"
            :disabled="!canSwitchNext"
          >下一条</button>
          <button
            v-if="page && !leaseLost"
            class="btn btn-quiet btn-sm"
            :disabled="saving || releasing || !leaseToken"
            @click="releaseCurrentTask"
          >{{ releasing ? '释放中…' : '释放任务' }}</button>
          <button
            class="btn btn-success btn-sm"
            @click="openSubmitReview"
            :disabled="saving || loadingPage || !page || leaseLost || !leaseToken"
          >{{ saving ? '提交中…' : '检查并提交' }}</button>
        </div>
        </details>
      </header>
    </template>
    <template #default="{ inputMode }">
        <div v-if="loadingPage" class="panel-loading" aria-live="polite">正在准备校对字段…</div>
        <div v-else-if="!page" class="empty-state">
          <div class="empty-state-text">页面不存在</div>
          <RouterLink to="/tasks" class="btn btn-secondary mt-3">返回项目大厅</RouterLink>
        </div>
        <template v-else>
          <div v-if="saved" class="alert alert-success" role="status">{{ saved }}</div>
          <div v-if="claimNextFailure" class="alert alert-error" role="alert">
            <p>{{ claimNextFailureNotice }}</p>
            <div class="claim-next-actions">
              <RouterLink to="/tasks" class="btn btn-secondary btn-sm">返回大厅</RouterLink>
              <button type="button" class="btn btn-primary btn-sm" :disabled="retryingClaim" @click="retryClaimNext">
                {{ retryingClaim ? '正在领取…' : '重试领取' }}
              </button>
            </div>
          </div>
          <div v-if="leaseLost" class="alert alert-error lease-lost-alert" role="alert">
            <span>{{ saveError || '任务租约已失效，本地草稿仍然保留。' }}</span>
            <button class="btn btn-secondary btn-sm" :disabled="reclaiming" @click="reclaimTask">
              {{ reclaiming ? '重新领取中…' : '重新领取任务' }}
            </button>
          </div>
          <div v-else-if="saveError" class="alert alert-error" role="alert">{{ saveError }}</div>

          <div class="editor-meta" aria-live="polite">
            <span class="draft-indicator" :class="{ 'draft-indicator--saved': draftStatus.includes('已保存') || draftStatus.includes('已恢复') }">
              <i aria-hidden="true"></i>
              {{ draftStatus || '修改后自动保存到本机' }}
            </span>
            <span v-if="leaseStatus" class="lease-indicator" :class="{ 'lease-indicator--lost': leaseLost }">{{ leaseStatus }}</span>
            <span class="shortcut-hint">⌘/Ctrl+S 草稿 · ⌘/Ctrl+Enter 提交 · Alt+←/→ 切换</span>
          </div>
          <details v-if="staleLocalDrafts.length" class="alert" role="note"><summary>本人旧版／失配本机草稿（{{ staleLocalDrafts.length }}）</summary><p>旧值未自动套用到新来源；请逐字段重新核对。</p><dl v-for="(draft, index) in staleLocalDrafts" :key="index"><template v-for="(value, field) in draft.row" :key="field"><dt>{{ field }}</dt><dd>{{ value || '（空白）' }}</dd></template></dl></details>

          <div class="field-progress-summary">
            <div>
              <span>结构化校对</span>
              <strong>{{ rowHeaders.length }} 个字段，已修改 {{ changedFields.length }} 个</strong>
            </div>
            <span class="pass-badge">独立校对</span>
          </div>

      <RareCharacterNotice :texts="[...Object.values(originalRow), ...Object.values(editedRow)]" />
      <TaskVerificationPanel ref="verificationPanel" :page="page" :row="editedRow" :lease-token="leaseToken" :hints="rawFindings" :routing-help="researchSession?.presentation?.display?.routing_help !== false" :active="!!leaseToken && !leaseLost && !submittedHere && !saving" @restore="replaceEditedRow" @context="receiveVerificationContext" />
      <ResearchTelemetry ref="researchTelemetry" :session="researchSession" :submitted="submittedHere" :density-collapsed-ids="densityCollapsedIds" />

          <ul v-if="pageHintList.length || pageHintOverflow" class="field-hint-list field-hint-list--page" aria-label="本条整条级机器疑点">
            <li v-for="(hint, hintIndex) in pageHintList" :key="`page-hint-${hintIndex}`">
              <span class="field-hint-chip" :data-finding-id="hint.id" :class="{ 'field-hint-chip--strong': hint.highlight }">
                <b aria-hidden="true">疑</b>{{ hintLabel(hint.kind) }}
              </span>
              <span class="field-hint-reason">{{ hint.text }}</span>
            </li>
            <li v-if="pageHintOverflow" class="field-hint-overflow">本条疑点较多，已按密度折叠 {{ pageHintOverflow }} 条</li>
          </ul>
          <p v-if="findingsTruncated" class="field-hint-truncated text-sm text-muted" role="status">
            本条疑点数量超出单次读取上限，以上标注不完整，请勿以“无标记”当作已核对通过。
          </p>
          <p v-if="gatedNoticeText" class="field-hint-gated text-sm text-muted" role="status">
            {{ gatedNoticeText }}
          </p>

          <p class="correction-paths text-sm text-muted" role="note">
            字写错了，改对应的文字字段。记音或说法不对，改读音字段，特殊字符用下方字符键盘。还没提交时，用这一栏的「恢复原文」。提交之后不能撤回，系统会尝试打开下一条，不会停在这一条上再改。
          </p>
          <div class="proofread-fields">
            <article
              v-for="(header, index) in rowHeaders"
              :key="header"
              class="proofread-field"
              v-show="!mobile || overview || currentField === header"
              :class="{
                'proofread-field--active': activeField === header,
                'proofread-field--changed': isFieldChanged(header)
              }"
            >
              <header class="proofread-field__header">
                <button v-if="mobile && overview" class="btn btn-secondary" @click="selectField(index)">修改此字段</button>
                <div>
                  <span>字段 {{ index + 1 }}</span>
                  <h2>{{ header }}</h2>
                </div>
                <div class="proofread-field__actions">
                  <span v-if="isFieldChanged(header)" class="field-change-label">已修改</span>
                  <button
                    type="button"
                    class="btn btn-quiet btn-sm"
                    :disabled="!isFieldChanged(header) || saving || submittedHere || leaseLost || !leaseToken"
                    @click="restoreField(header)"
                  >恢复导入值</button>
                </div>
              </header>

              <div class="source-value">
                <span>导入文本（提示定位对象）</span>
                <p v-if="!sourceSegments(header)">{{ originalRow[header] || '（空白）' }}</p>
                <p v-else><span
                  v-for="(segment, segmentIndex) in sourceSegments(header)"
                  :key="`${header}-span-${segmentIndex}`"
                  :class="{ 'source-value__hit': segment.hit }"
                >{{ segment.text }}</span></p>
              </div>

              <ul v-if="fieldHintList(header).length || fieldHintOverflow(header)" class="field-hint-list" :aria-label="`${header} 机器疑点`">
                <li v-for="(hint, hintIndex) in fieldHintList(header)" :key="`${header}-hint-${hintIndex}`">
                  <button
                    type="button"
                    class="field-hint-chip"
                    :data-finding-id="hint.id"
                    :class="{ 'field-hint-chip--strong': hint.highlight }"
                    @click="locateHint(header, hint)"
                  ><b aria-hidden="true">疑</b>{{ hintLabel(hint.kind) }}</button>
                  <span class="field-hint-reason">{{ hint.text }}</span>
                  <small v-if="hint.inputStatus === 'different_input'">提示分析输入与当前导入值不同，已撤去字符定位，请按字段重新核对。</small>
                  <small v-else-if="hint.inputStatus === 'legacy_unrecorded'">旧版提示，完整输入版本未记录。</small>
                </li>
                <li v-if="fieldHintOverflow(header)" class="field-hint-overflow">本字段疑点较多，已按密度折叠 {{ fieldHintOverflow(header) }} 条</li>
              </ul>

              <label class="sr-only" :for="`proofread-field-${index}`">{{ header }} 校对结果</label>
              <textarea
                :inputmode="inputMode"
                :readonly="saving || submittedHere || leaseLost || !leaseToken || (mobile && overview)"
                :id="`proofread-field-${index}`"
                :ref="(el) => setTextareaRef(header, el)"
                v-model="editedRow[header]"
                class="form-control proofread-textarea"
                @focus="activateField(header, $event)"
                @blur="rememberSelection(header, $event)"
                @select="rememberSelection(header, $event)"
                @keyup="rememberSelection(header, $event)"
                @click="rememberSelection(header, $event)"
                @input="onTextChange"
                :placeholder="`输入${header}的校对结果`"
              ></textarea>
            </article>
          </div>

        </template>
    </template>
    <template #navigation><FieldNavigation :headers="rowHeaders" :index="fieldIndex" :overview="overview" @select="selectField" @next="nextField">
      <template #submit><button class="btn btn-success" @click="openSubmitReview">检查并提交</button></template>
    </FieldNavigation></template>
    <template #keyboard><ProjectKeyboard v-if="page" :project-id="page.project" @availability="keyboardAvailable = $event" @insert="insertText" /></template>
  </DocumentReviewWorkspace>

    <AppModal
      :open="reviewingSubmission"
      title-id="submit-review-title"
      mark="校"
      @close="closeSubmitReview"
    >
        <div class="page-eyebrow">提交前确认</div>
        <h2 id="submit-review-title">确认第 {{ page?.page_number }} 条校对结果</h2>
        <p v-if="changedFields.length">
          你修改了 {{ changedFields.length }} 个字段：{{ changedFields.join('、') }}。
        </p>
        <p v-else>
          本条没有修改字段。请确认每个字段均已对照来源 PDF，空白字段也已核对。
        </p>
        <label class="form-label"><input v-model="sourceChecked" type="checkbox"> 我已逐字段对照本条来源 PDF</label>
        <p class="text-sm text-muted">这是本次校对的完整核对声明；机器提示及操作记录不作为独立来源参照。</p>
          <p class="alert alert-error confirmation-dialog__irreversible" role="alert">
            {{ irreversibleSubmitNotice }}
          </p>
          <p class="text-sm text-muted">
            字写错了改文字字段，记音不对改读音字段。这两类都要在确认前改完。
          </p>
          <p class="text-sm text-muted">
            确认后，系统会自动流转并尝试领取本项目下一条。
          </p>
        <template #actions>
          <button type="button" class="btn btn-secondary" @click="closeSubmitReview">继续检查</button>
          <button
            ref="submitConfirmButton"
            type="button"
            class="btn btn-success"
            autofocus
            :disabled="saving || leaseLost || !leaseToken || !sourceChecked"
            @click="submitProofread"
          >{{ saving ? '正在提交…' : '确认提交' }}</button>
        </template>
    </AppModal>

    <AppModal
      :open="researchOpen"
      title-id="research-notice-title"
      mark="研"
      :close-on-backdrop="false"
      :close-on-esc="false"
    >
      <div class="page-eyebrow">提交之前</div>
      <h2 id="research-notice-title">{{ researchCopy.title }}</h2>
      <p>{{ researchCopy.body }}</p>
      <p v-if="researchError" class="alert alert-error" role="alert">{{ researchError }}</p>
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="researchSaving" @click="chooseResearchNotice('opt_out')">
          {{ researchCopy.optOutLabel }}
        </button>
        <button type="button" class="btn btn-primary" :disabled="researchSaving" @click="chooseResearchNotice('participate')">
          {{ researchSaving ? '正在记录…' : researchCopy.participateLabel }}
        </button>
      </template>
    </AppModal>
</template>

<script setup>
import RareCharacterNotice from '@/components/editor/RareCharacterNotice.vue'
import TaskVerificationPanel from '@/components/editor/TaskVerificationPanel.vue'
import ResearchTelemetry from '@/components/editor/ResearchTelemetry.vue'
import AppModal from '@/components/AppModal.vue'
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter, RouterLink, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import DocumentReviewWorkspace from '@/components/editor/DocumentReviewWorkspace.vue'
import FieldNavigation from '@/components/editor/FieldNavigation.vue'
import { useFieldNavigation } from '@/composables/useFieldNavigation'
import ProjectKeyboard from '@/components/editor/ProjectKeyboard.vue'
import { useStructuredRow } from '@/composables/useStructuredRow'
import { useTaskNeighbors } from '@/composables/useTaskNeighbors'
import { PAGE_STATUS } from '@/constants/pageStatus'
import { shouldIgnoreEditorShortcut } from '@/lib/onboarding'
import { getChangedFields } from '@/lib/workspaceInsights'
import {
  hintKindLabel,
  locateSpan,
  pageLevelHints,
  pageLevelOverflow,
  prepareFieldHints,
  hintsForField,
  hintsOverflowFor,
  gatedNotice
} from '@/lib/fieldHints'
import {
  clearTaskDraft,
  loadTaskDraft,
  loadTaskDraftHistory,
  saveTaskDraft,
  setTaskFlash,
  takeTaskFlash
} from '@/lib/taskDraft'
import { clearTaskLease, loadGlyphQueue, loadTaskLease, saveGlyphQueue, saveTaskLease } from '@/lib/taskLease'
import { currentUserId as getCurrentUserId } from '@/services/authService'
import {
  claimNextProjectPage,
  getPageFindings,
  getProofreaderTask,
  listProofreaderNeighborTasks,
  releaseTaskLease,
  renewTaskLease,
  submitTwoPassProofread
} from '@/services/pagesService'
import { CLAIM_NEXT_FAILURE_NOTICE, IRREVERSIBLE_SUBMIT_NOTICE } from '@/lib/proofreadNotices'
import { RESEARCH_NOTICE_COPY } from '@/lib/researchNoticeCopy'
import { chooseResearchNotice as saveResearchNotice, getResearchNotice } from '@/services/researchNoticeService'
import { formatClaimConflict, getPbMessage } from '@/utils/pbErrors'

const route = useRoute()
const router = useRouter()
const onboardingRef = inject('proofreaderOnboarding', ref(null))
const researchNotice = ref(null)
const researchLoaded = ref(false)
const researchSaving = ref(false)
const researchError = ref('')
const researchDecided = computed(() => Boolean(researchNotice.value?.decided))
const researchOpen = computed(() => researchLoaded.value && !researchDecided.value)
const researchCopy = computed(() => ({
  title: researchNotice.value?.title || RESEARCH_NOTICE_COPY.title,
  body: researchNotice.value?.body || RESEARCH_NOTICE_COPY.body,
  participateLabel: researchNotice.value?.participate_label || RESEARCH_NOTICE_COPY.participateLabel,
  optOutLabel: researchNotice.value?.opt_out_label || RESEARCH_NOTICE_COPY.optOutLabel
}))

const page = ref(null)
const verificationPanel = ref(null)
const verificationContext = ref(null)
const sourceChecked = ref(false)
const rawFindings = ref([])
const staleLocalDrafts = ref([])
const restoredLocalDraft = ref(null)
const researchSession = ref(null)
const researchTelemetry = ref(null)
const loadingPage = ref(true)
const saving = ref(false)
const releasing = ref(false)
const reclaiming = ref(false)
const saved = ref('')
const saveError = ref('')
const initialRowJson = ref('')
const draftStatus = ref('')
const draftReady = ref(false)
const reviewingSubmission = ref(false)
const submitConfirmButton = ref(null)
const activeSelection = ref({ field: '', start: null, end: null })
const leaseToken = ref('')
const leaseExpiresAt = ref('')
const leaseLost = ref(false)
const renewingLease = ref(false)
const leaseNavigationAllowed = ref(false)
const submittedHere = ref(false)
const claimNextFailure = ref(false)
const retryingClaim = ref(false)
const irreversibleSubmitNotice = IRREVERSIBLE_SUBMIT_NOTICE
const claimNextFailureNotice = CLAIM_NEXT_FAILURE_NOTICE
const textareaRefs = new Map()
// 机器疑点（#161 渲染侧）。hints 恒为空时 fieldHints 就是 prepareFieldHints([]) 的
// 冻结空结构：列表与高亮分支全部走 v-if=false，界面与今天像素级一致。
const fieldHints = ref(prepareFieldHints([]))
const findingsTruncated = ref(false)
const findingsSuppressed = ref(0)
const gatedNoticeText = computed(() => gatedNotice(findingsSuppressed.value))
const locatedSpan = ref(null)
let findingsGeneration = 0
let draftTimer = null
let leaseRenewTimer = null

const currentUserId = computed(() => getCurrentUserId() || '')
const projectName = computed(() => page.value?.expand?.project?.name || '当前项目')
const changedFields = computed(() => getChangedFields(rowHeaders.value, originalRow.value, editedRow.value))
const canSwitchPrev = computed(() => canNavigatePrev.value && !saving.value && !loadingPage.value && !reviewingSubmission.value && !submittedHere.value)
const canSwitchNext = computed(() => canNavigateNext.value && !saving.value && !loadingPage.value && !reviewingSubmission.value && !submittedHere.value)
const navigationLabel = computed(() => {
  if (submittedHere.value) return '已提交'
  if (loadingPage.value || neighborsState.value === 'loading') return '位置加载中…'
  if (neighborsState.value === 'error') return '位置不可用'
  if (!page.value) return '任务不可用'
  if (taskCount.value === 0) return '暂无任务'
  if (taskPosition.value === 0) return '位置未知'
  return `${taskPosition.value} / ${taskCount.value}`
})
const navigationHint = computed(() => {
  if (submittedHere.value) return '本条已提交，不再计入进行中的任务。'
  if (loadingPage.value || neighborsState.value === 'loading') return ''
  if (saving.value) return '正在提交，暂不能切换任务。'
  if (reviewingSubmission.value) return '请先完成或关闭提交确认。'
  if (neighborsState.value === 'error') return neighborsError.value
  if (!page.value) return ''
  if (taskCount.value === 0) return '当前没有可切换的进行中任务。'
  if (taskPosition.value === 0) return '当前条目不在进行中任务列表。'
  if (taskCount.value === 1) return '当前只有这一条进行中的任务。'
  if (!canNavigatePrev.value) return '已是第一条进行中的任务。'
  if (!canNavigateNext.value) return '已是最后一条进行中的任务。'
  return ''
})
const leaseStatus = computed(() => {
  if (leaseLost.value) return '租约已失效 · 草稿已保留'
  if (!leaseExpiresAt.value) return ''
  const date = new Date(leaseExpiresAt.value)
  if (Number.isNaN(date.getTime())) return '任务租约已启用'
  return `任务保留至 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
})
const hasUnsavedChanges = computed(() => {
  return Boolean(
    page.value &&
    !loadingPage.value &&
    initialRowJson.value &&
    stringifyEditedRow() !== initialRowJson.value
  )
})

const {
  rowHeaders,
  originalRow,
  editedRow,
  activeField,
  editedText,
  hydrateForProofread,
  replaceEditedRow,
  markChanged,
  insertText: insertIntoActiveField,
  stringifyEditedRow
} = useStructuredRow()

const {
  prevTaskId,
  nextTaskId,
  taskPosition,
  taskCount,
  canNavigatePrev,
  canNavigateNext,
  neighborsState,
  neighborsError,
  resetNeighbors,
  loadNeighbors
} = useTaskNeighbors(page, async (currentPage) => {
  const userId = currentUserId.value
  if (!userId) throw new Error('登录状态已失效，请重新登录后重试。')
  if (!currentPage?.project) return []
  return listProofreaderNeighborTasks(currentPage.project, userId)
})

const keyboardAvailable = ref(false)
const { index: fieldIndex, overview, mobile, current: currentField, select: selectField, next: nextField } = useFieldNavigation(rowHeaders, () => page.value?.id)
const fieldSelections = new Map()
watch(() => page.value?.id, () => { fieldSelections.clear(); keyboardAvailable.value = false })
watch([currentField, mobile], ([field]) => {
  if (!field) return
  activeField.value = field
  activeSelection.value = fieldSelections.get(field) || { field, start: null, end: null }
})

watch(() => route.params.id, async () => {
  await loadPage()
}, { immediate: true })

onBeforeRouteLeave(() => {
  if (leaseNavigationAllowed.value) return true
  if (!confirmDiscardChanges()) return false
})

onBeforeRouteUpdate((to, from) => {
  if (leaseNavigationAllowed.value) return true
  if (to.params.id !== from.params.id && !confirmDiscardChanges()) return false
})

onMounted(() => {
  window.addEventListener('beforeunload', handleBeforeUnload)
  window.addEventListener('keydown', handleEditorShortcut)
  window.addEventListener('focus', handleLeaseActivation)
  document.addEventListener('visibilitychange', handleLeaseActivation)
  void loadResearchNotice()
})

onBeforeUnmount(() => {
  flushDraft()
  clearDraftTimer()
  stopLeaseRenewal()
  window.removeEventListener('beforeunload', handleBeforeUnload)
  window.removeEventListener('keydown', handleEditorShortcut)
  window.removeEventListener('focus', handleLeaseActivation)
  document.removeEventListener('visibilitychange', handleLeaseActivation)
})

async function loadPage() {
  clearDraftTimer()
  stopLeaseRenewal()
  reviewingSubmission.value = false
  sourceChecked.value = false
  verificationContext.value = null
  restoredLocalDraft.value = null
  staleLocalDrafts.value = []
  rawFindings.value = []
  researchSession.value = null
  draftReady.value = false
  loadingPage.value = true
  page.value = null
  resetNeighbors()
  saveError.value = ''
  saved.value = ''
  initialRowJson.value = ''
  draftStatus.value = ''
  activeSelection.value = { field: '', start: null, end: null }
  leaseToken.value = ''
  leaseExpiresAt.value = ''
  leaseLost.value = false
  leaseNavigationAllowed.value = false
  submittedHere.value = false
  claimNextFailure.value = false
  retryingClaim.value = false
  textareaRefs.clear()
  fieldHints.value = prepareFieldHints([])
  findingsTruncated.value = false
  findingsSuppressed.value = 0
  locatedSpan.value = null
  findingsGeneration += 1

  try {
    page.value = await getProofreaderTask(route.params.id)
    hydrateForProofread(page.value)
    initialRowJson.value = stringifyEditedRow()
    restoreDraft()
    await restoreOrAcquireLease()
    await loadNeighbors()
    // 疑点读取是渐进增强：不 await，失败或空数组都保持界面原样（getPageFindings 内部已兜错）。
    void loadFindings(page.value.id)
    const flash = takeTaskFlash(window.sessionStorage)
    if (flash) saved.value = flash
    await nextTick()
    onboardingRef.value?.startIfUnseen()
  } catch (e) {
    saveError.value = formatClaimConflict(e, '加载任务失败，请返回项目大厅刷新后重试')
  } finally {
    draftReady.value = Boolean(page.value)
    loadingPage.value = false
  }
}

function gotoPrevTask() {
  if (!canSwitchPrev.value) return
  router.push(`/tasks/${prevTaskId.value}/edit`)
}

function gotoNextTask() {
  if (!canSwitchNext.value) return
  router.push(`/tasks/${nextTaskId.value}/edit`)
}

function onTextChange() {
  sourceChecked.value = false
  saved.value = ''
  saveError.value = ''
  markChanged()
  scheduleDraftSave()
}

async function insertText(char) {
  if (saving.value || submittedHere.value || leaseLost.value || !leaseToken.value) return
  if (mobile.value && overview.value) return
  const field = mobile.value ? currentField.value : activeField.value || rowHeaders.value[0]
  if (!field) return
  activeField.value = field
  const textarea = textareaRefs.get(field)
  const selection = activeSelection.value.field === field
    ? activeSelection.value
    : fieldSelections.get(field) || {
        start: textarea?.selectionStart,
        end: textarea?.selectionEnd
      }
  const cursor = insertIntoActiveField(char, selection)
  onTextChange()
  if (cursor == null) return
  await nextTick()
  const target = textareaRefs.get(field)
  target?.focus({ preventScroll: true })
  if (mobile.value) target?.scrollIntoView({ block: 'nearest' })
  target?.setSelectionRange(cursor, cursor)
  activeSelection.value = { field, start: cursor, end: cursor }
  fieldSelections.set(field, { ...activeSelection.value })
}

function setTextareaRef(header, element) {
  if (element) textareaRefs.set(header, element)
  else textareaRefs.delete(header)
}

function activateField(header, event) {
  rememberSelection(header, event)
}

function rememberSelection(header, event) {
  const target = event?.target
  const selection = {
    field: header,
    start: Number.isInteger(target?.selectionStart) ? target.selectionStart : null,
    end: Number.isInteger(target?.selectionEnd) ? target.selectionEnd : null
  }
  fieldSelections.set(header, selection)
  // A delayed blur/select from the previous field must not retarget mobile input.
  if (mobile.value && header !== currentField.value) return
  activeField.value = header
  activeSelection.value = selection
  if (!mobile.value) {
    const index = rowHeaders.value.indexOf(header)
    if (index >= 0) selectField(index)
  }
}

function isFieldChanged(header) {
  return changedFields.value.includes(header)
}

const pageHintList = computed(() => pageLevelHints(fieldHints.value))
const pageHintOverflow = computed(() => pageLevelOverflow(fieldHints.value))
const densityCollapsedIds = computed(() => {
  const visible = new Set([...pageHintList.value, ...rowHeaders.value.flatMap(header => fieldHintList(header))].map(hint => hint.id))
  return rawFindings.value.filter(hint => hint.id && !visible.has(hint.id)).map(hint => hint.id)
})

function fieldHintList(header) {
  return hintsForField(fieldHints.value, header)
}

function fieldHintOverflow(header) {
  return hintsOverflowFor(fieldHints.value, header)
}

function hintLabel(kind) {
  return hintKindLabel(kind)
}

// 疑点点击联动（#161 期望结果 3 的第一级）：先定位到字段卡，
// 再用 evidence.char_offsets（SourceSpan，码位计）把命中区间标进「待校对原文」。
// 页图内的坐标高亮等 #107-A3 页面图子项落地后再接，本次不动 PDF 侧。
function locateHint(header, hint) {
  const index = rowHeaders.value.indexOf(header)
  if (index >= 0) selectField(index)
  activeField.value = header
  const source = String(originalRow.value?.[header] ?? '')
  const span = hint?.inputStatus === 'different_input' ? null : locateSpan(source, hint?.evidence?.char_offsets)
  locatedSpan.value = span ? { field: header, span } : null
  const textarea = textareaRefs.get(header)
  if (textarea && mobile.value) textarea.scrollIntoView({ block: 'nearest' })
}

// 无定位结果时返回 null——模板走与今天完全一致的单一文本分支。
function sourceSegments(header) {
  if (locatedSpan.value?.field !== header) return null
  const source = String(originalRow.value?.[header] ?? '')
  const { start, end } = locatedSpan.value.span
  if (start >= end || end > source.length) return null
  const segments = []
  if (start > 0) segments.push({ text: source.slice(0, start), hit: false })
  segments.push({ text: source.slice(start, end), hit: true })
  if (end < source.length) segments.push({ text: source.slice(end), hit: false })
  return segments
}

async function loadFindings(pageId) {
  const generation = ++findingsGeneration
  const result = await getPageFindings(pageId)
  if (generation !== findingsGeneration || page.value?.id !== pageId) return
  fieldHints.value = prepareFieldHints(result.hints, rowHeaders.value)
  rawFindings.value = result.hints
  researchSession.value = result.research
  findingsTruncated.value = result.truncated
  findingsSuppressed.value = result.suppressedByGate
}

async function restoreField(header) {
  if (!isFieldChanged(header)) return
  editedRow.value[header] = String(originalRow.value[header] ?? '')
  activeField.value = header
  onTextChange()
  await nextTick()
  textareaRefs.get(header)?.focus()
}

async function loadResearchNotice() {
  researchError.value = ''
  try {
    researchNotice.value = await getResearchNotice()
  } catch (error) {
    researchNotice.value = { decided: false }
    researchError.value = getPbMessage(error, '研究用途告知暂时没有加载出来，请稍后再选择。')
  } finally {
    researchLoaded.value = true
  }
}

async function chooseResearchNotice(choice) {
  if (researchSaving.value) return
  researchSaving.value = true
  researchError.value = ''
  try {
    researchNotice.value = await saveResearchNotice(choice)
  } catch (error) {
    researchError.value = getPbMessage(error, '研究用途选择没有记下，请再试一次。')
  } finally {
    researchSaving.value = false
  }
}

async function openSubmitReview() {
  if (mobile.value && !overview.value) { overview.value = true; return }
  if (!researchDecided.value) return
  if (saving.value || loadingPage.value || !page.value || leaseLost.value || !leaseToken.value) return
  flushDraft()
  reviewingSubmission.value = true
  await nextTick()
  submitConfirmButton.value?.focus()
}

function closeSubmitReview() {
  if (saving.value) return
  reviewingSubmission.value = false
}

function confirmDiscardChanges() {
  if (!hasUnsavedChanges.value) return true
  return window.confirm('当前校对内容尚未提交，确定要离开吗？本地草稿会保留。')
}

function handleBeforeUnload(event) {
  flushDraft()
  if (!hasUnsavedChanges.value) return
  event.preventDefault()
  event.returnValue = ''
}

function scheduleDraftSave() {
  if (!draftReady.value) return
  clearDraftTimer()
  draftStatus.value = '草稿保存中…'
  draftTimer = window.setTimeout(() => flushDraft(), 500)
}

function flushDraft() {
  clearDraftTimer()
  if (!draftReady.value || !page.value || !currentUserId.value || !initialRowJson.value) return
  try {
    if (!hasUnsavedChanges.value) {
      clearTaskDraft(window.localStorage, {
        userId: currentUserId.value,
        pageId: page.value.id
      })
      draftStatus.value = ''
      return
    }
    const draft = saveTaskDraft(window.localStorage, {
      userId: currentUserId.value,
      pageId: page.value.id,
      sourceSignature: initialRowJson.value,
      contextBasis: verificationContext.value?.basis,
      row: JSON.parse(stringifyEditedRow())
    })
    draftStatus.value = draft ? `草稿已保存于 ${formatDraftTime(draft.savedAt)}` : ''
  } catch {
    draftStatus.value = '草稿保存失败，请勿关闭页面'
  }
}

function restoreDraft() {
  const draft = loadTaskDraft(window.localStorage, {
    userId: currentUserId.value,
    pageId: page.value?.id,
    sourceSignature: initialRowJson.value
    , onStale: draft => { staleLocalDrafts.value.push(draft); draftStatus.value = '本机草稿来源已变化，旧值保留，未自动恢复' }
  })
  if (!draft) return
  restoredLocalDraft.value = draft
  replaceEditedRow(draft.row)
  if (stringifyEditedRow() === initialRowJson.value) {
    clearTaskDraft(window.localStorage, {
      userId: currentUserId.value,
      pageId: page.value.id
    })
    return
  }
  draftStatus.value = `已恢复 ${formatDraftTime(draft.savedAt)} 的本地草稿`
}

function receiveVerificationContext(context) {
  verificationContext.value = context
  const draft = restoredLocalDraft.value
  if (draft?.contextBasis && draft.contextBasis !== context.basis) {
    staleLocalDrafts.value.push(draft)
    replaceEditedRow(originalRow.value)
    draftStatus.value = '本机草稿的来源或约定已变化，旧值保留，未套用到当前来源'
  }
  const history = loadTaskDraftHistory(window.localStorage, { userId: currentUserId.value, pageId: page.value?.id })
  staleLocalDrafts.value.push(...history.filter(item => !staleLocalDrafts.value.some(old => old.savedAt === item.savedAt)))
}

function clearDraftTimer() {
  if (draftTimer) {
    window.clearTimeout(draftTimer)
    draftTimer = null
  }
}

function formatDraftTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '刚才'
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function handleEditorShortcut(event) {
  if (researchOpen.value) return
  if (shouldIgnoreEditorShortcut(event, onboardingRef.value)) return
  if (event.key === 'Escape' && reviewingSubmission.value) {
    event.preventDefault()
    closeSubmitReview()
    return
  }
  const control = event.ctrlKey || event.metaKey
  if (control && event.key.toLowerCase() === 's') {
    event.preventDefault()
    flushDraft()
    return
  }
  if (control && event.key === 'Enter') {
    event.preventDefault()
    if (reviewingSubmission.value) submitProofread()
    else openSubmitReview()
    return
  }
  if (!event.altKey || control || reviewingSubmission.value) return
  if (event.key === 'ArrowLeft' && canSwitchPrev.value) {
    event.preventDefault()
    gotoPrevTask()
  } else if (event.key === 'ArrowRight' && canSwitchNext.value) {
    event.preventDefault()
    gotoNextTask()
  }
}

async function submitProofread() {
  if (saving.value || !page.value || leaseLost.value || !leaseToken.value || !researchDecided.value || !sourceChecked.value) return
  saving.value = true
  saved.value = ''
  saveError.value = ''
  claimNextFailure.value = false
  const projectId = page.value?.project
  const userId = currentUserId.value
  const rowJson = stringifyEditedRow()
  const text = editedText.value
  try {
    const verification = await verificationPanel.value.prepareSubmit()
    const telemetry = await researchTelemetry.value?.flush()
    const result = await submitTwoPassProofread(page.value.id, userId, {
      rowJson,
      text,
      leaseToken: leaseToken.value,
      sourceChecked: sourceChecked.value,
      ...verification
      , ...telemetry
    })
    reviewingSubmission.value = false
    initialRowJson.value = rowJson
    page.value.status = result.status
    submittedHere.value = true
    resetNeighbors()
    clearTaskDraft(window.localStorage, {
      userId,
      pageId: page.value.id
    })
    clearStoredLease()
    draftStatus.value = ''
    saved.value = result.message || (
      result.status === PAGE_STATUS.APPROVED
        ? '该条目已完成。'
        : result.status === PAGE_STATUS.ARBITRATION
          ? '该条目将由管理员继续处理。'
          : '校对已提交。'
    )

    try {
      const nextPage = await claimNextProjectPage(projectId, userId, page.value.id, '', glyphQueueFor(projectId))
      if (nextPage?.id) {
        saveClaimedLease(nextPage)
        setTaskFlash(window.sessionStorage, saved.value)
        await router.push(`/tasks/${nextPage.id}/edit`)
        return
      }
      clearGlyphQueue(projectId)
      saved.value += ' 当前项目暂无下一条可由你处理的任务。'
    } catch (claimError) {
      claimNextFailure.value = true
      console.warn('Failed to claim next page after successful proofread submit:', claimError)
    }

  } catch (e) {
    const message = getPbMessage(e, '提交失败，请重试')
    if (message.includes('研究用途')) await loadResearchNotice()
    if (isLeaseFailure(message)) markLeaseLost(message)
    else saveError.value = message
  } finally {
    saving.value = false
  }
}

async function retryClaimNext() {
  if (retryingClaim.value || !page.value || !currentUserId.value) return
  retryingClaim.value = true
  try {
    const nextPage = await claimNextProjectPage(page.value.project, currentUserId.value, page.value.id, '', glyphQueueFor(page.value.project))
    if (nextPage?.id) {
      saveClaimedLease(nextPage)
      setTaskFlash(window.sessionStorage, saved.value)
      claimNextFailure.value = false
      await router.push(`/tasks/${nextPage.id}/edit`)
      return
    }
    claimNextFailure.value = false
    if (!saved.value.includes('暂无下一条')) {
      saved.value += ' 当前项目暂无下一条可由你处理的任务。'
    }
  } catch (claimError) {
    console.warn('Failed to retry claim after proofread submit:', claimError)
  } finally {
    retryingClaim.value = false
  }
}

function glyphQueueFor(projectId) {
  return loadGlyphQueue(window.sessionStorage, { userId: currentUserId.value, projectId })
}

function clearGlyphQueue(projectId) {
  saveGlyphQueue(window.sessionStorage, { userId: currentUserId.value, projectId, glyph: false })
}

function saveClaimedLease(claimedPage) {
  if (!claimedPage?.id || !claimedPage.leaseToken) return false
  saveTaskLease(window.sessionStorage, {
    userId: currentUserId.value,
    pageId: claimedPage.id,
    token: claimedPage.leaseToken,
    expiresAt: claimedPage.leaseExpiresAt
  })
  if (claimedPage.id === page.value?.id) {
    leaseToken.value = claimedPage.leaseToken
    leaseExpiresAt.value = claimedPage.leaseExpiresAt || ''
    leaseLost.value = false
    saveError.value = ''
    startLeaseRenewal()
  }
  return true
}

function clearStoredLease() {
  if (page.value?.id && currentUserId.value) {
    clearTaskLease(window.sessionStorage, { userId: currentUserId.value, pageId: page.value.id })
  }
  leaseToken.value = ''
  leaseExpiresAt.value = ''
  stopLeaseRenewal()
}

async function restoreOrAcquireLease() {
  const stored = loadTaskLease(window.sessionStorage, {
    userId: currentUserId.value,
    pageId: page.value?.id
  })
  if (stored) {
    leaseToken.value = stored.token
    leaseExpiresAt.value = stored.expiresAt
    await renewCurrentLease({ force: true })
    if (!leaseLost.value) startLeaseRenewal()
    return
  }
  await reclaimTask()
}

function startLeaseRenewal() {
  stopLeaseRenewal()
  leaseRenewTimer = window.setInterval(() => renewCurrentLease(), 2 * 60 * 1000)
}

function stopLeaseRenewal() {
  if (!leaseRenewTimer) return
  window.clearInterval(leaseRenewTimer)
  leaseRenewTimer = null
}

function handleLeaseActivation() {
  if (document.visibilityState === 'visible') renewCurrentLease()
}

async function renewCurrentLease({ force = false } = {}) {
  if (renewingLease.value || leaseLost.value || !page.value?.id || !leaseToken.value) return
  if (!force && (document.visibilityState !== 'visible' || !document.hasFocus())) return
  renewingLease.value = true
  try {
    const result = await renewTaskLease(page.value.id, leaseToken.value)
    leaseExpiresAt.value = result.leaseExpiresAt || ''
    saveTaskLease(window.sessionStorage, {
      userId: currentUserId.value,
      pageId: page.value.id,
      token: leaseToken.value,
      expiresAt: leaseExpiresAt.value
    })
  } catch (e) {
    markLeaseLost(getPbMessage(e, '任务租约续期失败，本地草稿仍然保留，请重新领取任务。'))
  } finally {
    renewingLease.value = false
  }
}

function markLeaseLost(message) {
  flushDraft()
  clearStoredLease()
  leaseLost.value = true
  saveError.value = message
  reviewingSubmission.value = false
}

function isLeaseFailure(message) {
  return /租约|重新领取|不属于你|被重新领取/.test(String(message || ''))
}

async function reclaimTask() {
  if (reclaiming.value || !page.value?.project || !currentUserId.value) return
  reclaiming.value = true
  flushDraft()
  try {
    const claimedPage = await claimNextProjectPage(page.value.project, currentUserId.value, '', '', glyphQueueFor(page.value.project))
    if (!claimedPage?.id || !saveClaimedLease(claimedPage)) {
      markLeaseLost('当前项目暂无可重新领取的任务，本地草稿仍然保留。')
      return
    }
    if (claimedPage.id !== page.value.id) {
      setTaskFlash(window.sessionStorage, '原任务已被重新领取；本地草稿仍保留，已为你打开另一条任务。')
      leaseNavigationAllowed.value = true
      await router.push(`/tasks/${claimedPage.id}/edit`)
    }
  } catch (e) {
    markLeaseLost(getPbMessage(e, '重新领取失败，本地草稿仍然保留。'))
  } finally {
    reclaiming.value = false
  }
}

async function releaseCurrentTask() {
  if (releasing.value || !page.value?.id || !leaseToken.value) return
  if (!window.confirm('释放后其他校对员可以领取此任务；当前本地草稿会保留。确定释放吗？')) return
  releasing.value = true
  flushDraft()
  try {
    await verificationPanel.value?.persistDraft()
    await releaseTaskLease(page.value.id, leaseToken.value)
    clearStoredLease()
    leaseNavigationAllowed.value = true
    await router.push('/tasks')
  } catch (e) {
    const message = getPbMessage(e, '释放任务失败，请稍后重试。')
    if (isLeaseFailure(message)) markLeaseLost(message)
    else saveError.value = message
  } finally {
    releasing.value = false
  }
}
</script>
