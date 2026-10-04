<template>
  <main ref="workspace" class="editor-layout" :class="{ 'has-keyboard': keyboardAvailable, 'keyboard-open': keyboardOpen && !suspended, 'pdf-collapsed': sourceCollapsed, 'pdf-unavailable': !loading && !pdfLoading && !pdfUrl && !pdfError }" :style="viewportStyle" @pointerdown="onOutsidePointer">
    <div class="mobile-source-toggle">
      <button class="btn btn-secondary" @click="toggleSource">{{ sourceCollapsed ? '查看原文' : '收起原文' }}</button>
    </div>
    <section class="editor-panel source-panel" aria-labelledby="source-panel-title">
      <header class="editor-panel-header editor-panel-header--source">
        <div class="editor-context">
          <span>原文定位</span>
          <strong id="source-panel-title">PDF 第 {{ currentPdfPage }} 页</strong>
        </div>
        <details class="source-actions-menu" :open="!compact">
          <summary>页码</summary>
        <div class="editor-toolbar" aria-label="PDF 页码导航">
          <button
            class="btn btn-secondary btn-sm"
            :disabled="currentPdfPage <= allowedPdfPages[0]"
            @click="switchPdfPage(-1)"
          >上一页</button>
          <label class="pdf-page-control">
            <span class="sr-only">PDF 页码</span>
            <input
              v-model.number="pdfPageInput"
              type="number"
              class="form-control pdf-page-input"
              :min="allowedPdfPages[0]"
              :max="allowedPdfPages[1]"
              aria-label="PDF 页码"
              @change="applyPdfPageInput"
              @keydown.enter.prevent="applyPdfPageInput"
            />
          </label>
          <button
            class="btn btn-secondary btn-sm"
            :disabled="currentPdfPage >= allowedPdfPages[1]"
            @click="switchPdfPage(1)"
          >下一页</button>
          <RouterLink v-if="returnTo" :to="returnTo" class="btn btn-quiet btn-sm">{{ returnLabel }}</RouterLink>
        </div>
        </details>
      </header>
      <div class="editor-panel-body editor-panel-body--pdf">
        <div v-if="loading || pdfLoading" class="panel-loading pdf-transition-mask" aria-live="polite">正在加载原文…</div>
        <div v-else-if="!pdfEnabled" class="alert alert-error">任务租约已失效，请重新领取。</div>
        <div v-else-if="!page" class="alert alert-error">页面不存在</div>
        <div v-else-if="pdfError" class="alert alert-error editor-inline-alert">{{ pdfError }}</div>
        <div v-if="pdfPageWarning && !loading && !pdfLoading" class="alert alert-warning editor-inline-alert" role="status">{{ pdfPageWarning }}</div>
        <PdfSinglePageViewer
          v-if="pdfUrl"
          :style="{ visibility: loading || pdfLoading ? 'hidden' : 'visible' }"
          :src="pdfUrl"
          :page-image="pageImage"
          @image-error="fallbackToPdf"
          :page-number="localPdfPage"
          :source-page-number="currentPdfPage"
          :source-total-pages="totalPdfPages"
        />
        <div v-else-if="!loading && !pdfLoading && !pdfError && pdfEnabled && page" class="empty-state">
          <div class="empty-state-text">暂无可预览的 PDF</div>
          <p>{{ emptyPdfDescription }}</p>
        </div>
      </div>
    </section>

    <section class="editor-panel fields-panel" :aria-labelledby="contentLabelledBy">
      <slot name="panel-header"></slot>
      <div class="editor-panel-body editor-panel-body--fields">
        <slot :input-mode="compact && keyboardOpen && !suspended ? 'none' : 'text'"></slot>
      </div>
    </section>
    <div class="workspace-navigation"><slot name="navigation"></slot></div>
    <aside v-show="keyboardAvailable" class="keyboard-panel" aria-label="项目字符键盘">
      <p v-if="showKeyboardHint" class="keyboard-discovery" role="note">
        <span>{{ keyboardDiscoveryNotice }}</span>
        <button type="button" class="btn btn-quiet btn-sm" @click="dismissHint">知道了</button>
      </p>
      <div class="keyboard-dock-controls">
        <button class="btn btn-secondary" :aria-expanded="keyboardOpen && !suspended" @click="openKeyboard">字符键盘</button>
        <template v-if="keyboardOpen && !suspended">
          <button class="btn btn-secondary" :aria-pressed="pinned" @click="pinned = !pinned">{{ pinned ? '取消钉住' : '钉住' }}</button>
          <button class="btn btn-quiet" @click="closeKeyboard">系统输入 / 收起</button>
        </template>
      </div>
      <div class="keyboard-dock-content"><slot name="keyboard"></slot></div>
    </aside>
  </main>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref, toRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import PdfSinglePageViewer from '@/components/editor/PdfSinglePageViewer.vue'
import { useProjectPdf } from '@/composables/useProjectPdf'
import {
  KEYBOARD_DISCOVERY_NOTICE,
  dismissKeyboardHint,
  isKeyboardHintDismissed
} from '@/lib/proofreadNotices'

const props = defineProps({
  keyboardAvailable: { type: Boolean, default: false },
  suspended: { type: Boolean, default: false },
  page: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  pdfEnabled: { type: Boolean, default: true },
  watermarkUserId: { type: String, default: '' },
  returnTo: { type: String, default: '' },
  returnLabel: { type: String, default: '返回' },
  contentLabelledBy: { type: String, default: '' },
  emptyPdfDescription: {
    type: String,
    default: '仍可根据已导入的结构化字段继续处理。'
  }
})

const workspace = ref(null)
const keyboardOpen = ref(false)
const keyboardHintDismissed = ref(false)
const keyboardDiscoveryNotice = KEYBOARD_DISCOVERY_NOTICE
const showKeyboardHint = computed(() => props.keyboardAvailable && !keyboardHintDismissed.value && !props.suspended)
const pinned = ref(false)
const pdfCollapsed = ref(false)
const compact = ref(false)
const systemKeyboardOpen = ref(false)
const viewportHeight = ref(0)
const sourceCollapsed = computed(() => pdfCollapsed.value || ((keyboardOpen.value || systemKeyboardOpen.value) && !props.suspended))
function toggleSource() {
  const show = sourceCollapsed.value
  keyboardOpen.value = false
  if (show && document.activeElement?.tagName === 'TEXTAREA') document.activeElement.blur()
  pdfCollapsed.value = !show
}
const viewportStyle = computed(() => compact.value && viewportHeight.value ? { height: `${viewportHeight.value}px` } : {})
function updateViewport() {
  compact.value = window.innerWidth <= 1100
  const viewport = window.visualViewport
  systemKeyboardOpen.value = Boolean(viewport && window.innerHeight - viewport.height > 150)
  viewportHeight.value = Math.max(160, (viewport?.height || window.innerHeight) - Math.max(0, workspace.value?.getBoundingClientRect().top || 0))
}
function dismissHint() {
  keyboardHintDismissed.value = true
  dismissKeyboardHint(window.localStorage)
}
function openKeyboard() {
  if (props.suspended) return
  if (document.activeElement?.tagName === 'TEXTAREA') document.activeElement.blur()
  keyboardOpen.value = true
  dismissHint()
}
function closeKeyboard() { keyboardOpen.value = false; pinned.value = false }
function onOutsidePointer(event) {
  if (compact.value && !pinned.value && !event.target.closest('.keyboard-panel')) keyboardOpen.value = false
}
onMounted(() => {
  keyboardHintDismissed.value = isKeyboardHintDismissed(window.localStorage)
  updateViewport()
  window.addEventListener('resize', updateViewport)
  window.visualViewport?.addEventListener('resize', updateViewport)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', updateViewport)
  window.visualViewport?.removeEventListener('resize', updateViewport)
})
const pdfPageInput = ref(1)
const pageRef = toRef(props, 'page')
const {
  pdfError,
  pdfLoading,
  currentPdfPage,
  pdfPageWarning,
  allowedPdfPages,
  pdfUrl,
  pageImage,
  fallbackToPdf,
  localPdfPage,
  totalPdfPages,
  resetPdf,
  resolveProjectPdf,
  clampPdfPage,
  switchPdfPage
} = useProjectPdf(pageRef)

watch(currentPdfPage, (value) => {
  pdfPageInput.value = value
})

watch([() => props.page?.id, () => props.loading, () => props.pdfEnabled], async ([pageId, loading, enabled]) => {
  if (!enabled) { resetPdf(); return }
  if (loading) return
  if (!pageId) { resetPdf(); return }
  await resolveProjectPdf()
  pdfPageInput.value = currentPdfPage.value
}, { immediate: true })

onBeforeUnmount(resetPdf)

function applyPdfPageInput() {
  currentPdfPage.value = clampPdfPage(pdfPageInput.value)
  pdfPageInput.value = currentPdfPage.value
}
</script>

<style scoped>
.editor-panel-body--pdf { position: relative; }
.pdf-transition-mask { position: absolute; inset: 0; z-index: 1; background: var(--surface, #fff); }
</style>
