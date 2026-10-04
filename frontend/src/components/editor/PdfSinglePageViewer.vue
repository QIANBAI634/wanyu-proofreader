<template>
  <div ref="viewerRef" class="pdf-viewer">
    <div class="pdf-toolbar">
      <div class="pdf-toolbar-group">
        <button type="button" class="pdf-tool" :disabled="zoom <= 0.5" @click="changeZoom(-0.25)">－</button>
        <span class="pdf-zoom-label">{{ Math.round(zoom * 100) }}%</span>
        <button type="button" class="pdf-tool" :disabled="zoom >= 3" @click="changeZoom(0.25)">＋</button>
        <button type="button" class="pdf-tool" @click="resetView">适合宽度</button>
      </div>
      <div class="pdf-toolbar-group">
        <span class="pdf-page-label">第 {{ sourcePageNumber || safePageLabel }} / {{ sourceTotalPages || totalPages || '—' }} 页</span>
        <button type="button" class="pdf-tool" @click="rotateClockwise">旋转 90°</button>
        <button type="button" class="pdf-tool" @click="toggleFullscreen">
          {{ isFullscreen ? '退出全屏' : '全屏' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="alert alert-error" style="margin:1rem">{{ error }}</div>
    <div v-else ref="wrapRef" class="pdf-scroll">
      <div
        class="pdf-canvas-stage"
        :style="{ width: `${canvasCssWidth}px`, height: `${canvasCssHeight}px` }"
      >
        <img v-if="pageImage" class="pdf-page-image" :src="src" :width="pageImage.width" :height="pageImage.height" :style="imageStyle" alt="原文页面" @error="emit('image-error')" />
        <canvas v-else ref="canvasRef" class="pdf-canvas"></canvas>
        <div v-if="pageImage" class="pdf-identity-watermark" aria-hidden="true">{{ identityStamp }}</div>
        <div v-if="loading || rendering" class="pdf-loading-mask">PDF 加载中...</div>

      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import pb from '@/lib/pocketbase'

const emit = defineEmits(['image-error'])

const props = defineProps({
  src: { type: String, default: '' },
  pageImage: { type: Object, default: null },
  pageNumber: { type: Number, default: 1 },
  sourcePageNumber: { type: Number, default: 0 },
  sourceTotalPages: { type: Number, default: 0 }
})

const viewerRef = ref(null)
const wrapRef = ref(null)
const canvasRef = ref(null)
const loading = ref(false)
const rendering = ref(false)
const error = ref('')
const zoom = ref(1)
const rotation = ref(0)
const totalPages = ref(0)
const canvasCssWidth = ref(1)
const canvasCssHeight = ref(1)
const isFullscreen = ref(false)

let pdfDocTask = null
let pdfDoc = null
let renderTask = null
let resizeObserver = null
let pdfjsLib = null
let loadGeneration = 0
let renderGeneration = 0
const identityStamp = computed(() => `Wanyu | ${pb.authStore.record?.id || ''}`)
const imageStyle = computed(() => {
  if (!props.pageImage) return {}
  const odd = rotation.value % 180 !== 0
  const width = odd ? canvasCssHeight.value : canvasCssWidth.value
  const height = odd ? canvasCssWidth.value : canvasCssHeight.value
  return { width: `${width}px`, height: `${height}px`, position: 'absolute', left: '50%', top: '50%', transform: `translate(-50%, -50%) rotate(${rotation.value}deg)` }
})

const safePageLabel = computed(() => {
  const max = totalPages.value || 1
  return Math.max(1, Math.min(max, Number(props.pageNumber) || 1))
})

watch(
  [() => props.src, () => props.pageImage],
  async ([newSrc]) => {
    await loadPdf(newSrc)
  },
  { immediate: true }
)

watch(
  [() => props.pageNumber, zoom, rotation],
  async () => {
    await renderCurrentPage()
  }
)

onMounted(() => {
  document.addEventListener('fullscreenchange', syncFullscreenState)
})

async function loadPdf(src) {
  const generation = ++loadGeneration
  cleanupRenderOnly()
  error.value = ''
  totalPages.value = 0

  if (!src) {
    pdfDoc = null
    loading.value = false
    return
  }

  if (props.pageImage) {
    if (pdfDocTask) { try { await pdfDocTask.destroy() } catch { /* already gone */ } }
    if (generation !== loadGeneration) return
    pdfDocTask = null
    pdfDoc = null
    loading.value = false
    await nextTick()
    await renderCurrentPage()
    attachResizeObserver()
    return
  }

  loading.value = true
  zoom.value = 1
  rotation.value = 0
  try {
    const lib = await ensurePdfJsLib()
    if (generation !== loadGeneration) return
    lib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.js'

    if (pdfDocTask) {
      try { await pdfDocTask.destroy() } catch { /* the previous document may already be gone */ }
    }
    pdfDocTask = lib.getDocument({ url: src, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', isEvalSupported: false })
    const document = await pdfDocTask.promise
    if (generation !== loadGeneration) { await document.destroy(); return }
    pdfDoc = document
    totalPages.value = pdfDoc.numPages || 0
    await nextTick()
    await renderCurrentPage()
    attachResizeObserver()
  } catch (e) {
    if (generation !== loadGeneration) return
    pdfDoc = null
    error.value = e?.message || 'PDF 加载失败'
  } finally {
    if (generation === loadGeneration) loading.value = false
  }
}

async function ensurePdfJsLib() {
  if (pdfjsLib) return pdfjsLib
  if (window.pdfjsLib) {
    pdfjsLib = window.pdfjsLib
    return pdfjsLib
  }
  await loadScript('/pdfjs/pdf.min.js')
  if (!window.pdfjsLib) {
    throw new Error('PDF.js 初始化失败')
  }
  pdfjsLib = window.pdfjsLib
  return pdfjsLib
}

function loadScript(src, type = 'text/javascript') {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.type = type
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('加载 PDF.js 资源失败'))
    document.head.appendChild(script)
  })
}

async function renderCurrentPage() {
  if (props.pageImage && wrapRef.value) {
    const odd = rotation.value % 180 !== 0
    const width = odd ? props.pageImage.height : props.pageImage.width
    const height = odd ? props.pageImage.width : props.pageImage.height
    const scale = Math.max(1, wrapRef.value.clientWidth - 16) / width * zoom.value
    canvasCssWidth.value = width * scale
    canvasCssHeight.value = height * scale
    return
  }
  if (!pdfDoc || !canvasRef.value || !wrapRef.value) return
  rendering.value = true
  const generation = ++renderGeneration
  const safePage = safePageLabel.value

  if (renderTask) {
    try { renderTask.cancel() } catch { /* the task may have already settled */ }
    renderTask = null
  }

  try {
    const page = await pdfDoc.getPage(safePage)
    if (generation !== renderGeneration) return
    const baseViewport = page.getViewport({ scale: 1, rotation: (page.rotate + rotation.value) % 360 })
    const availableWidth = Math.max(1, wrapRef.value.clientWidth - 16)
    const fitScale = availableWidth / baseViewport.width
    const viewport = page.getViewport({
      scale: fitScale * zoom.value,
      rotation: (page.rotate + rotation.value) % 360
    })

    const canvas = canvasRef.value
    const context = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const cssWidth = Math.max(1, Math.floor(viewport.width))
    const cssHeight = Math.max(1, Math.floor(viewport.height))
    canvasCssWidth.value = cssWidth
    canvasCssHeight.value = cssHeight
    canvas.width = Math.floor(cssWidth * dpr)
    canvas.height = Math.floor(cssHeight * dpr)
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`

    renderTask = page.render({
      canvasContext: context,
      viewport,
      transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0]
    })
    await renderTask.promise
    if (generation === renderGeneration) renderTask = null
  } catch (e) {
    if (generation === renderGeneration && e?.name !== 'RenderingCancelledException') {
      error.value = e?.message || '渲染失败'
    }
  } finally {
    if (generation === renderGeneration) rendering.value = false
  }
}

function changeZoom(delta) {
  zoom.value = Math.max(0.5, Math.min(3, Math.round((zoom.value + delta) * 100) / 100))
}

function resetView() {
  zoom.value = 1
  rotation.value = 0
  if (wrapRef.value) {
    wrapRef.value.scrollTop = 0
    wrapRef.value.scrollLeft = 0
  }
}

function rotateClockwise() {
  rotation.value = (rotation.value + 90) % 360
}

async function toggleFullscreen() {
  if (!viewerRef.value) return
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else {
      await viewerRef.value.requestFullscreen()
    }
  } catch {
    error.value = '浏览器未允许进入全屏模式'
  }
}

function syncFullscreenState() {
  isFullscreen.value = document.fullscreenElement === viewerRef.value
  nextTick(() => renderCurrentPage())
}

function attachResizeObserver() {
  if (resizeObserver || !wrapRef.value) return
  resizeObserver = new ResizeObserver(() => {
    renderCurrentPage()
  })
  resizeObserver.observe(wrapRef.value)
}

function cleanupRenderOnly() {
  renderGeneration++
  rendering.value = false
  if (renderTask) {
    try { renderTask.cancel() } catch { /* the task may have already settled */ }
    renderTask = null
  }
}

onBeforeUnmount(async () => {
  loadGeneration++
  cleanupRenderOnly()
  document.removeEventListener('fullscreenchange', syncFullscreenState)
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (pdfDocTask) {
    try { await pdfDocTask.destroy() } catch { /* the previous document may already be gone */ }
    pdfDocTask = null
  }
  pdfDoc = null
})
</script>

<style scoped>
.pdf-viewer {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #e2e8f0;
}

.pdf-viewer:fullscreen {
  min-height: 100vh;
  background: #cbd5e1;
}

.pdf-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
  padding: .5rem .75rem;
  border-bottom: 1px solid #cbd5e1;
  background: #f8fafc;
}

.pdf-toolbar-group {
  display: flex;
  align-items: center;
  gap: .4rem;
}

.pdf-tool {
  padding: .3rem .6rem;
  border: 1px solid #cbd5e1;
  border-radius: 5px;
  background: #fff;
  color: #334155;
  cursor: pointer;
}

.pdf-tool:disabled {
  opacity: .45;
  cursor: not-allowed;
}

.pdf-zoom-label,
.pdf-page-label {
  min-width: 48px;
  color: #475569;
  font-size: .8rem;
  text-align: center;
}

.pdf-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
}

.pdf-canvas-stage {
  position: relative;
  margin: 0 auto;
  background: #fff;
  box-shadow: 0 2px 8px rgba(15, 23, 42, .18);
}

.pdf-canvas {
  display: block;
  background: #fff;
}

.pdf-page-image { display: block; }
.pdf-identity-watermark {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  color: rgba(80, 80, 80, .22);
  transform: rotate(-25deg);
  font-size: 16px;
  overflow: hidden;
}

.pdf-loading-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(248, 250, 252, 0.68);
  color: #475569;
  font-size: 14px;
  pointer-events: none;
}

@media (max-width: 700px) {
  .pdf-toolbar {
    align-items: flex-start;
    flex-direction: row;
    overflow-x: auto;
    padding: .25rem;
  }
  .pdf-toolbar-group { flex: 0 0 auto; }
  .pdf-tool { white-space: nowrap; }
}
</style>
