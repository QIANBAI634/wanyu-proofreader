<template>
  <AppModal
    :open="open"
    title-id="page-content-edit-title"
    @close="$emit('close')"
  >
    <h3 id="page-content-edit-title">修正识别结果</h3>
    <p class="text-sm text-muted">
      第 {{ page?.page_number }} 条 · 修正「导入原文」内容，不涉及校对结果
    </p>

    <div v-if="marks.length" class="alert alert-warning" role="status">
      <div class="font-semibold mb-1">发现 {{ marks.length }} 处可疑格</div>
      <ul class="text-sm">
        <li v-for="(m, i) in marks" :key="i">
          <template v-if="m.field">列「{{ m.field }}」：</template>{{ renderFindingMessage(m.message) }}
        </li>
      </ul>
    </div>

    <div class="edit-fields">
      <label v-for="header in rowHeaders" :key="header" class="form-group">
        <span class="form-label">{{ header }}</span>
        <textarea
          v-model="editedRow[header]"
          class="form-control"
          rows="2"
        ></textarea>
      </label>
    </div>

    <div v-if="error" class="alert alert-error" role="alert">{{ error }}</div>

    <template #actions>
      <button type="button" class="btn btn-secondary" :disabled="submitting" @click="$emit('close')">取消</button>
      <button type="button" class="btn btn-primary" :disabled="submitting" @click="save">
        {{ submitting ? '保存中...' : '保存' }}
      </button>
    </template>
  </AppModal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import AppModal from '@/components/AppModal.vue'
import { useStructuredRow } from '@/composables/useStructuredRow'
import { inspectRow } from '@/lib/rowInspection'
import { renderFindingMessage } from '@/lib/findingMessages'
import { updatePageContent } from '@/services/pagesService'

const props = defineProps({
  open: { type: Boolean, default: false },
  page: { type: Object, default: null },
  projectId: { type: String, required: true }
})

const emit = defineEmits(['close', 'saved'])

const { rowHeaders, editedRow, hydrateForProofread, stringifyEditedRow } = useStructuredRow()
const submitting = ref(false)
const error = ref('')

// 打开时用 page 的 ocr_row_json 填充编辑表单。
watch(() => props.open, (isOpen) => {
  if (isOpen && props.page) {
    error.value = ''
    hydrateForProofread(props.page)
  }
})

// 对当前编辑内容现算可疑格（而非读未修改的 props.page），编辑过程中实时更新。
const marks = computed(() => inspectRow(rowHeaders.value, editedRow.value))

async function save() {
  if (!props.page) return
  submitting.value = true
  error.value = ''
  try {
    const rowJson = stringifyEditedRow()
    const headersJson = JSON.stringify(rowHeaders.value)
    // 服务端按 rowJson + 表头序生成 ocr_text，不接受调用方传入。
    await updatePageContent(props.projectId, props.page.id, {
      rowJson,
      headersJson,
      expectedUpdated: props.page.updated || ''
    })
    emit('saved', props.page.id)
    emit('close')
  } catch (e) {
    error.value = e?.response?.status === 409
      ? '内容已被他人修改，请刷新后重试。'
      : (e?.message || '保存失败，请重试。')
  } finally {
    submitting.value = false
  }
}
</script>
