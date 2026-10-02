import { ref } from 'vue'
import { safeParseRowJson, orderedRowHeaders } from '../lib/structuredRow.js'

export { safeParseRowJson, orderedRowHeaders }

export function composeRowText(headers, rowObj) {
  return headers
    .map((header) => String(rowObj?.[header] || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim()
}

export function insertTextAtSelection(currentValue, insertedText, start, end = start) {
  const current = String(currentValue ?? '')
  const inserted = String(insertedText ?? '')
  const safeStart = Number.isInteger(start) ? Math.max(0, Math.min(current.length, start)) : current.length
  const safeEnd = Number.isInteger(end) ? Math.max(safeStart, Math.min(current.length, end)) : safeStart
  return {
    value: current.slice(0, safeStart) + inserted + current.slice(safeEnd),
    cursor: safeStart + inserted.length
  }
}

export function useStructuredRow() {
  const rowHeaders = ref([])
  const originalRow = ref({})
  const proofreadRow = ref({})
  const editedRow = ref({})
  const activeField = ref('')
  const editedText = ref('')

  function hydrateForProofread(page) {
    const ocrObj = safeParseRowJson(page?.ocr_row_json) || { '内容': page?.ocr_text || '' }
    const headers = orderedRowHeaders(page, ocrObj)

    rowHeaders.value = headers.length ? headers : ['内容']
    originalRow.value = {}
    proofreadRow.value = {}
    editedRow.value = {}

    rowHeaders.value.forEach((header) => {
      originalRow.value[header] = String(ocrObj[header] ?? '')
      editedRow.value[header] = String(ocrObj[header] ?? '')
    })
    activeField.value = rowHeaders.value[0] || ''
    editedText.value = composeCurrentText()
  }

  function hydrateForReview(page) {
    const ocrObj = safeParseRowJson(page?.ocr_row_json) || { '内容': page?.ocr_text || '' }
    const proofObj = safeParseRowJson(page?.proofread_row_json) || {
      ...ocrObj,
      '内容': page?.proofread_text || ocrObj['内容'] || ''
    }
    const headers = orderedRowHeaders(page, ocrObj)

    rowHeaders.value = headers.length ? headers : ['内容']
    originalRow.value = {}
    proofreadRow.value = {}
    editedRow.value = {}

    rowHeaders.value.forEach((header) => {
      originalRow.value[header] = String(ocrObj[header] ?? '')
      proofreadRow.value[header] = String(proofObj[header] ?? '')
      editedRow.value[header] = String(proofObj[header] ?? '')
    })
    activeField.value = rowHeaders.value[0] || ''
    editedText.value = composeCurrentText()
  }

  function composeCurrentText(rowObj = editedRow.value) {
    return composeRowText(rowHeaders.value, rowObj)
  }

  function replaceEditedRow(row) {
    rowHeaders.value.forEach((header) => {
      editedRow.value[header] = String(row?.[header] ?? originalRow.value[header] ?? '')
    })
    editedText.value = composeCurrentText()
  }

  function insertText(char, selection = {}) {
    const key = activeField.value || rowHeaders.value[0]
    if (!key) return null
    const current = String(editedRow.value[key] || '')
    const result = insertTextAtSelection(current, char, selection.start, selection.end)
    editedRow.value[key] = result.value
    editedText.value = composeCurrentText()
    return result.cursor
  }

  function markChanged() {
    editedText.value = composeCurrentText()
  }

  function stringifyEditedRow() {
    return JSON.stringify(editedRow.value)
  }

  return {
    rowHeaders,
    originalRow,
    proofreadRow,
    editedRow,
    activeField,
    editedText,
    hydrateForProofread,
    hydrateForReview,
    replaceEditedRow,
    composeCurrentText,
    insertText,
    markChanged,
    stringifyEditedRow
  }
}
