import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { createPdfPreviewCache } from '@/lib/pdfPreviewCache'
import { createPageImageCache } from '@/lib/pageImageCache'
import { missingPdfPageNotice } from '@/lib/proofreadNotices'
import pb from '@/lib/pocketbase'

export function useProjectPdf(page) {
  const pdfError = ref('')
  const pdfLoading = ref(false)
  const currentPdfPage = ref(1)
  const firstPage = ref(1)
  const lastPage = ref(1)
  const totalPdfPages = ref(0)
  const pdfUrl = ref(null)
  const cache = createPdfPreviewCache()
  const imageCache = createPageImageCache()
  const pageImage = ref(null)
  const imageMode = ref(false)
  let imageGeneration = 0
  let expiryTimer = null
  let previewKey = ''
  let currentUser = pb.authStore.record?.id || pb.authStore.model?.id || ''
  const unsubscribe = pb.authStore.onChange((_token, record) => {
    if (!record || record.id !== currentUser) resetPdf()
    currentUser = record?.id || ''
  })
  onBeforeUnmount(() => { unsubscribe(); resetPdf() })
  let generation = 0
  let controller = null
  const basePdfPage = computed(() => Number(page.value?.pdf_page) || Number(page.value?.page_number) || 1)
  const pdfPageWarning = computed(() => missingPdfPageNotice(page.value))
  const allowedPdfPages = computed(() => [firstPage.value, lastPage.value])
  const localPdfPage = computed(() => currentPdfPage.value - firstPage.value + 1)

  function resetPdf() {
    generation++
    controller?.abort()
    cache.clear()
    imageCache.clear()
    imageGeneration++
    clearTimeout(expiryTimer)
    previewKey = ''
    imageMode.value = false
    pageImage.value = null
    pdfUrl.value = null
    pdfError.value = ''
    pdfLoading.value = false
    firstPage.value = lastPage.value = basePdfPage.value
    totalPdfPages.value = 0
    currentPdfPage.value = basePdfPage.value
  }
  async function resolveProjectPdf(forcePdf = false, preservePage = false) {
    const request = ++generation
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal
    const userId = currentUser
    pdfLoading.value = true
    pdfError.value = ''
    imageMode.value = false
    imageGeneration++
    clearTimeout(expiryTimer)
    try {
      const base = pb.buildURL(`/api/fangji/pages/${encodeURIComponent(page.value.id)}/pdf`)
      const options = { headers: { Authorization: pb.authStore.token }, signal, cache: 'no-store' }
      const info = await fetch(`${base}/descriptor`, options)
      if (!info.ok) {
        const body = await info.json().catch(() => ({}))
        throw new Error(body.message || '加载任务 PDF 失败')
      }
      let descriptor = await info.json()
      if (request !== generation) return
      const samePreview = previewKey === descriptor.key
      if (!samePreview || forcePdf) {
        imageCache.clear()
        pageImage.value = null
      }
      previewKey = descriptor.key
      firstPage.value = descriptor.start
      lastPage.value = descriptor.end
      totalPdfPages.value = descriptor.total
      currentPdfPage.value = samePreview || forcePdf || preservePage ? clampPdfPage(currentPdfPage.value) : descriptor.start
      if (!forcePdf) {
        const shown = currentPdfPage.value
        try {
          const entry = await imageCache.load(base.replace(/\/pdf$/, ''), shown, options)
          if (request !== generation) return
          cache.clear()
          imageMode.value = true
          pageImage.value = entry
          pdfUrl.value = entry.url
          armExpiry(entry)
          preloadNeighbors(shown, options)
          return
        } catch (error) {
          if (error.name === 'AbortError') throw error
          // Image absence, expiry or rendering failure uses the existing PDF.
        }
      }
      pageImage.value = null
      let entry = cache.get(userId, descriptor)
      if (!entry) {
        // A different range/version must not keep showing the previous task PDF.
        cache.clear()
        pdfUrl.value = null
        const response = await fetch(base, options)
        if (!response.ok) {
          const body = await response.json().catch(() => ({}))
          throw new Error(body.message || '加载任务 PDF 失败')
        }
        const blob = await response.blob()
        if (request !== generation) return
        // The five-minute window or primary source can change between requests.
        descriptor = {
          key: response.headers.get('X-PDF-Preview-Key'), expiresAt: response.headers.get('X-PDF-Expires-At'),
          start: Number(response.headers.get('X-PDF-Start-Page')),
          end: Number(response.headers.get('X-PDF-End-Page')),
          total: Number(response.headers.get('X-PDF-Total-Pages'))
        }
        if (!descriptor.key || !Number.isFinite(Date.parse(descriptor.expiresAt))) throw new Error('PDF 预览信息无效，请刷新后重试')
        entry = cache.put(userId, descriptor, blob)
        currentPdfPage.value = clampPdfPage(currentPdfPage.value)
      }
      firstPage.value = descriptor.start
      lastPage.value = descriptor.end
      totalPdfPages.value = descriptor.total
      pdfUrl.value = entry.url
      currentPdfPage.value = clampPdfPage(currentPdfPage.value)
    } catch (error) {
      if (request === generation && error.name !== 'AbortError') {
        cache.clear(); pdfUrl.value = null
        imageCache.clear(); pageImage.value = null
        pdfError.value = error.message || '加载任务 PDF 失败'
      }
    } finally {
      if (request === generation) pdfLoading.value = false
    }
  }
  function clampPdfPage(value) {
    return Math.max(firstPage.value, Math.min(lastPage.value, Number(value) || firstPage.value))
  }
  function switchPdfPage(delta) {
    currentPdfPage.value = clampPdfPage(currentPdfPage.value + delta)
  }
  function imageBase() { return pb.buildURL(`/api/fangji/pages/${encodeURIComponent(page.value.id)}`) }
  function armExpiry(entry) {
    clearTimeout(expiryTimer)
    expiryTimer = setTimeout(() => { resolveProjectPdf(false, true) }, Math.max(0, entry.expires - Date.now()))
  }
  function preloadNeighbors(number, options) {
    for (const adjacent of [number - 1, number + 1]) {
      if (adjacent >= firstPage.value && adjacent <= lastPage.value) {
        imageCache.load(imageBase(), adjacent, options).catch(() => {})
      }
    }
  }
  watch(currentPdfPage, async (number) => {
    if (!imageMode.value) return
    const request = generation
    const imageRequest = ++imageGeneration
    pdfLoading.value = true
    pageImage.value = null
    pdfUrl.value = null
    const options = { headers: { Authorization: pb.authStore.token }, signal: controller.signal, cache: 'no-store' }
    try {
      const entry = await imageCache.load(imageBase(), number, options)
      if (request !== generation || imageRequest !== imageGeneration) return
      pageImage.value = entry
      pdfUrl.value = entry.url
      armExpiry(entry)
      preloadNeighbors(number, options)
    } catch (error) {
      if (request === generation && imageRequest === imageGeneration && error.name !== 'AbortError') await resolveProjectPdf(true)
    } finally {
      if (request === generation && imageRequest === imageGeneration) pdfLoading.value = false
    }
  })
  function fallbackToPdf() { return resolveProjectPdf(true) }
  return {
    pdfLoading, pdfError, currentPdfPage, basePdfPage, pdfPageWarning,
    allowedPdfPages, pdfUrl, localPdfPage, totalPdfPages,
    pageImage, fallbackToPdf, resetPdf, resolveProjectPdf, clampPdfPage, switchPdfPage
  }
}
