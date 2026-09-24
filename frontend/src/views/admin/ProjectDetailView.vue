<template>
  <main class="container page workspace-page">
    <header class="page-heading project-detail-heading">
      <div>
        <RouterLink to="/admin" class="back-link">← 返回项目总览</RouterLink>
        <div class="page-eyebrow">项目工作区</div>
        <h1>{{ project?.name || '项目详情' }}</h1>
        <p v-if="project?.description">{{ project.description }}</p>
        <RouterLink v-if="project?.capabilities?.canManage" :to="`/admin/projects/${projectId}/settings#project-details`" class="btn btn-secondary btn-sm mt-3">编辑项目资料</RouterLink>
      </div>
      <nav v-if="project" class="project-section-nav" aria-label="项目页面分区">
        <RouterLink :to="`/admin/projects/${projectId}/settings`">项目设置（资料与成员）</RouterLink>
        <a href="#project-files">文件准备</a>
        <a href="#project-export">导出结果</a>
        <a href="#project-entries">条目管理</a>
      </nav>
    </header>

    <div v-if="loadingProject" class="text-muted">加载中...</div>
    <div v-else-if="projectError" class="alert alert-error">{{ projectError }}</div>
    <template v-else>
      <!-- Project summary -->
      <section class="card project-overview mb-6" aria-labelledby="project-overview-title">
        <div class="project-overview__lead">
          <div>
            <div class="page-eyebrow">实时管线</div>
            <h2 id="project-overview-title">{{ approvedPct }}% 已完成</h2>
            <p>{{ pageStats.approved }} / {{ pageStats.total }} 条已形成最终结果</p>
          </div>
          <div class="project-completion-ring" :style="{ '--completion': approvedPct }" aria-hidden="true">
            <span>{{ approvedPct }}%</span>
          </div>
        </div>
        <div class="project-status-actions">
          <button type="button" :class="{ 'is-selected': selectedStatus === PAGE_STATUS.PENDING }" @click="filterByStatus(PAGE_STATUS.PENDING)">
            <span>待开始</span><strong>{{ pageStats.unstarted }}</strong><small>尚无校对结果</small>
          </button>
          <button type="button" :class="{ 'is-selected': selectedStatus === ACTIVE_STATUS_FILTER }" @click="filterActivePages">
            <span>处理中</span><strong>{{ pageStats.active }}</strong><small>校对员已领取</small>
          </button>
          <button type="button" :class="{ 'is-selected': selectedStatus === PAGE_STATUS.PROOFREAD }" @click="filterByStatus(PAGE_STATUS.PROOFREAD)">
            <span>收集中</span><strong>{{ pageStats.collecting }}</strong><small>等待更多独立结果</small>
          </button>
          <button
            type="button"
            class="project-status-action--urgent"
            :class="{ 'is-empty': pageStats.arbitration === 0, 'is-selected': selectedStatus === PAGE_STATUS.ARBITRATION }"
            @click="filterByStatus(PAGE_STATUS.ARBITRATION)"
          >
            <span>待仲裁</span><strong>{{ pageStats.arbitration }}</strong><small>{{ pageStats.arbitration ? '需要管理员处理' : '当前无异常' }}</small>
          </button>
          <button type="button" :class="{ 'is-selected': selectedStatus === PAGE_STATUS.APPROVED }" @click="filterByStatus(PAGE_STATUS.APPROVED)">
            <span>已完成</span><strong>{{ pageStats.approved }}</strong><small>可导出结果</small>
          </button>
        </div>
      </section>

      <!-- Upload section -->
      <section id="project-files" class="card project-section mb-6">
        <div class="card-title">上传文件</div>

        <div class="grid-2">
          <!-- PDF upload -->
          <div>
            <h4 class="font-semibold mb-2">上传 PDF 文件</h4>
            <p class="text-sm text-muted mb-3">上传扫描版 PDF 作为校对原文预览。当前系统不会自动 OCR 或生成条目，请通过 CSV 导入待校对文本。</p>
            <div v-if="pdfResume && !uploadingPdf" class="alert mt-2" role="status">
              <p>
                有未完成的 PDF 上传：{{ pdfResume.name }}
                <span v-if="pdfResumeExpired">，已过期，请重新选择文件上传。</span>
                <span v-else>。请重新选择同一文件继续；不能只靠文件名和大小匹配。</span>
              </p>
              <div class="mt-3 flex gap-2">
                <button type="button" class="btn btn-primary" @click="$refs.pdfInput.click()">重新选择同一 PDF</button>
                <button type="button" class="btn btn-quiet" @click="abandonPdfResume">放弃未完成上传</button>
              </div>
            </div>
            <input type="file" accept=".pdf" @change="onPdfSelected" :disabled="uploadingPdf" ref="pdfInput" style="display:none" />
            <button v-if="!pdfResume || uploadingPdf" class="btn btn-secondary" @click="$refs.pdfInput.click()" :disabled="uploadingPdf">选择 PDF 文件</button>
            <span v-if="pdfFile" class="text-sm ml-2">{{ pdfFile.name }}</span>
            <div v-if="pdfError && pdfFile && !uploadingPdf" class="mt-3">
              <button class="btn btn-primary" @click="uploadPdf">重试上传 PDF</button>
            </div>
            <div v-if="uploadingPdf && !pdfProcessing" class="mt-2" role="status">
              <progress :value="pdfUploadProgress" max="100" aria-label="PDF 上传进度"></progress>
              <span>已上传 {{ pdfUploadProgress }}%{{ pdfUploadProgress === 100 ? '，正在保存…' : '' }}</span>
              <button class="btn btn-quiet btn-sm" @click="pdfUploadController?.abort()">取消上传</button>
            </div>
            <div v-if="pdfProcessing" class="alert mt-2">PDF 已上传，后端正在校验文件...</div>
            <div v-if="pdfSuccess" class="alert alert-success mt-2">
              PDF 深度校验完成，共 {{ pdfMetadata?.page_count || 0 }} 页，已设为项目主 PDF，可在校对编辑器中预览。
            </div>
            <div v-if="pdfError" class="alert alert-error mt-2">{{ pdfError }}</div>
          </div>

          <!-- CSV upload -->
          <div>
            <h4 class="font-semibold mb-2">上传 CSV 文件（每行一条待校对文本）</h4>
            <p class="text-sm text-muted mb-3">
              CSV 需包含 <code>PDF页码</code>、<code>page</code>、<code>pdf_page</code> 或 <code>页码</code> 中的一个字段。<br>
              系统会在后端预检，并将每行去掉页码字段后的内容导入为新条目。
            </p>
            <input type="file" accept=".csv" @change="onCsvSelected" ref="csvInput" style="display:none" />
            <button class="btn btn-secondary" @click="$refs.csvInput.click()">选择 CSV 文件</button>
            <span v-if="csvFile" class="text-sm ml-2">{{ csvFile.name }}</span>
            <div v-if="csvFile" class="mt-3">
              <button class="btn btn-primary" @click="uploadCsv" :disabled="uploadingCsv">
                {{ uploadingCsv ? '后端预检中...' : '后端预检 CSV' }}
              </button>
            </div>
            <div v-if="csvJob" class="import-job-card mt-3">
              <div class="flex items-center justify-between gap-2">
                <strong>{{ csvJobStatusLabel }}</strong>
                <span class="text-sm text-muted">作业 {{ csvJob.id }}</span>
              </div>
              <div class="progress mt-2">
                <div class="progress-bar" :style="{ width: csvJobProgress + '%' }"></div>
              </div>
              <div class="text-sm mt-2">
                已处理 {{ csvJob.processed_count || 0 }} 条；
                成功 {{ csvJob.success_count || 0 }} 条；
                跳过 {{ csvJob.failed_count || 0 }} 条
              </div>
              <div v-if="csvJob.error_message && csvJob.status !== 'failed'" class="text-sm text-muted mt-1">{{ csvJob.error_message }}</div>
            </div>
            <div v-if="csvInspection" class="csv-inspection mt-3">
              <div class="font-semibold">后端预检结果</div>
              <div class="text-sm mt-2">
                编码：{{ csvInspection.encoding || '未知' }}；
                页码字段：<code>{{ csvInspection.pdfPageField }}</code>；
                页码范围：{{ csvInspection.minPdfPage && csvInspection.maxPdfPage ? `${csvInspection.minPdfPage}–${csvInspection.maxPdfPage}` : '无有效页码' }}；
                共 {{ csvInspection.totalRows }} 行，可导入 {{ csvInspection.validRows }} 行，需跳过 {{ csvInspection.invalidRows }} 行。
              </div>
              <div class="text-sm mt-2">
                检测到的表头：<code>{{ csvInspection.headers.join('、') }}</code>
              </div>
              <div v-if="csvInspection.preview.length" class="table-wrapper mt-2">
                <table>
                  <thead>
                    <tr><th v-for="header in csvPreviewHeaders" :key="header">{{ header }}</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, index) in csvInspection.preview" :key="index">
                      <td v-for="header in csvPreviewHeaders" :key="header">{{ row[header] }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <button
                v-if="csvJob?.status === 'validated'"
                class="btn btn-primary mt-3"
                @click="confirmCsvImport"
                :disabled="uploadingCsv"
              >
                {{ uploadingCsv ? '导入处理中...' : '确认导入' }}
              </button>
            </div>
            <div v-if="csvSuccess" class="alert alert-success mt-2">{{ csvSuccess }}</div>
            <div v-if="csvError" class="alert alert-error mt-2" style="white-space:pre-line">{{ csvError }}</div>
            <div v-if="csvImportErrors.length" class="mt-3">
              <div class="font-semibold mb-2">
                错误明细（显示前 {{ csvImportErrors.length }} 条）
              </div>
              <div class="table-wrapper import-error-table">
                <table>
                  <thead>
                    <tr>
                      <th>CSV 行</th>
                      <th>字段</th>
                      <th>错误代码</th>
                      <th>原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in csvImportErrors" :key="item.id">
                      <td>{{ item.row_number || '—' }}</td>
                      <td>{{ item.column_name || '—' }}</td>
                      <td><code>{{ item.error_code }}</code></td>
                      <td>
                        {{ item.message }}
                        <span v-if="item.raw_value" class="text-muted">（值：{{ item.raw_value }}）</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <!-- OCR recognition -->
          <div>
            <h4 class="font-semibold mb-2">OCR 识别</h4>
            <p class="text-sm text-muted mb-3">
              对项目主 PDF 发起识别，把页面文字识别为结构化条目。识别能力尚未接入真实引擎前，会提示当前不可用。
            </p>
            <button
              class="btn btn-secondary"
              @click="startOcrRecognition"
              :disabled="ocrRunning"
            >
              {{ ocrRunning ? '识别进行中...' : '发起识别' }}
            </button>
            <div v-if="ocrJob" class="import-job-card mt-3">
              <div class="flex items-center justify-between gap-2">
                <strong>{{ ocrJobStatusLabel }}</strong>
                <span class="text-sm text-muted">作业 {{ ocrJob.id }}</span>
              </div>
              <div v-if="ocrJob.error_message" class="text-sm text-muted mt-2">{{ ocrJob.error_message }}</div>
              <div v-if="ocrJob.status === 'completed'" class="alert alert-success mt-2">
                识别完成，结果已生成，可进入校对或导出流程查看。
              </div>
            </div>
            <div v-if="ocrError" class="alert alert-error mt-2" style="white-space:pre-line">{{ ocrError }}</div>
          </div>
        </div>
      </section>

      <!-- Export section -->
      <section id="project-export" class="card project-section mb-6">
        <div class="card-title">导出结果</div>
        <p class="text-sm text-muted mb-3">
          导出当前项目的最终校对结果 CSV。只有达到项目人数要求且结果一致，或已完成仲裁的条目会使用最终校对内容；其余条目回退到原始内容。
        </p>
        <div class="flex gap-2 items-center">
          <button class="btn btn-primary" @click="exportCsv" :disabled="exportingCsv">
            {{ exportingCsv ? '导出中...' : '导出校对结果 CSV' }}
          </button>
          <span v-if="exportError" class="alert alert-error" style="margin:0">{{ exportError }}</span>
          <span v-if="exportSuccess" class="alert alert-success" style="margin:0">{{ exportSuccess }}</span>
        </div>
      </section>

      <!-- Pages list -->
      <section id="project-entries" ref="entriesSection" class="card project-section">
        <div class="section-heading admin-entry-heading">
          <div>
            <h2>条目管理</h2>
            <p>共 {{ pageStats.total }} 条<span v-if="hasActiveListFilter">，当前条件显示 {{ totalFilteredItems }} 条</span>。</p>
          </div>
          <button v-if="hasActiveListFilter" type="button" class="btn btn-quiet btn-sm" @click="resetListFilters">查看全部条目</button>
        </div>
        <div v-if="mutationSuccess" class="alert alert-success" role="status">{{ mutationSuccess }}</div>
        <div v-if="mutationError" class="alert alert-error" role="alert">{{ mutationError }}</div>
        <div v-if="pageStats.total" class="admin-list-filters mb-4">
          <label class="admin-filter-field">
            <span>搜索条目</span>
            <input
              v-model="searchQuery"
              type="search"
              class="form-control"
              placeholder="条号、PDF页码、文本或当前校对员"
            />
          </label>
          <label class="admin-filter-field">
            <span>状态</span>
            <select v-model="selectedStatus" class="form-control">
              <option value="">全部状态</option>
              <option :value="ACTIVE_STATUS_FILTER">处理中（已认领/校对中）</option>
              <option v-for="option in statusOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label class="admin-filter-field"><span>PDF 起始页</span><input v-model="minPdfPage" type="number" min="1" class="form-control" /></label>
          <label class="admin-filter-field"><span>PDF 结束页</span><input v-model="maxPdfPage" type="number" min="1" class="form-control" /></label>
          <label class="admin-filter-field admin-filter-size">
            <span>每页显示</span>
            <select v-model.number="listPageSize" class="form-control">
              <option :value="10">10 条</option>
              <option :value="25">25 条</option>
              <option :value="50">50 条</option>
              <option :value="100">100 条</option>
            </select>
          </label>
          <button
            v-if="hasActiveListFilter"
            type="button"
            class="btn btn-secondary btn-sm"
            @click="resetListFilters"
          >
            清除筛选
          </button>
        </div>
        <div v-if="loadingPages" class="text-muted text-sm">加载中...</div>
        <div v-else-if="pagesError" class="alert alert-error">
          {{ pagesError }}
          <button type="button" class="btn btn-secondary btn-sm ml-2" @click="loadPages">重新加载</button>
        </div>
        <div v-else-if="pageStats.total === 0" class="empty-state">
          <div class="empty-state-mark" aria-hidden="true">条</div>
          <div class="empty-state-text">暂无条目，请上传 CSV 文件</div>
        </div>
        <div v-else-if="filteredPages.length === 0" class="empty-state">
          <div class="empty-state-mark" aria-hidden="true">筛</div>
          <div class="empty-state-text">没有符合当前条件的条目</div>
          <button type="button" class="btn btn-secondary mt-3" @click="resetListFilters">清除筛选</button>
        </div>
        <div v-else>
          <div class="admin-table-actions mb-3" :class="{ 'admin-table-actions--selected': selectedPendingIds.length > 0 }">
            <div class="selection-summary">
              <strong>{{ selectedPendingIds.length }}</strong>
              <span>条待校对条目已选择<br><small>范围始终按完整列表条号计算</small></span>
            </div>
            <div class="admin-bulk-actions">
              <input
                v-model.trim="rangeSelectInput"
                type="text"
                class="form-control"
                placeholder="输入范围，如 1-33 或 1,3,5-8"
                aria-label="按完整列表范围选择条目"
                :disabled="mutatingRows"
              />
              <button class="btn btn-secondary btn-sm" @click="selectByRange" :disabled="mutatingRows || !rangeSelectInput">
                范围选中
              </button>
              <button class="btn btn-secondary btn-sm" @click="toggleSelectAllPending" :disabled="mutatingRows || pageStats.unstarted === 0">
                {{ allPendingSelected ? '取消全选待校对' : '全选待校对' }}
              </button>
              <button class="btn btn-secondary btn-sm" @click="moveSelectedRowsDown" :disabled="mutatingRows || selectedPendingIds.length === 0">
                {{ mutatingRows ? '处理中...' : '批量下移所选' }}
              </button>
              <button class="btn btn-danger btn-sm" @click="deleteSelectedRows" :disabled="mutatingRows || selectedPendingIds.length === 0">
                {{ mutatingRows ? '处理中...' : '批量删除所选' }}
              </button>
            </div>
          </div>
          <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th style="width:64px">选择</th>
                <th>条号</th>
                <th>状态</th>
                <th>校对进度</th>
                <th>当前校对员</th>
                <th>不一致次数</th>
                <th>OCR文本预览</th>
                <th style="width:100px">操作</th>
                <th style="width:160px">顺序</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(pg, idx) in displayedPages" :key="pg.id">
                <td>
                  <input
                    type="checkbox"
                    :checked="selectedPendingIds.includes(pg.id)"
                    :disabled="!isPending(pg) || mutatingRows"
                    :aria-label="`选择第 ${formatItemNo(pg.page_number, displayedPageOffset + idx)} 条`"
                    @change="toggleRowSelection(pg.id, $event.target.checked)"
                  />
                </td>
                <td>第 {{ formatItemNo(pg.page_number, displayedPageOffset + idx) }} 条</td>
                <td><span :class="statusBadgeClass(pg.status)" class="badge">{{ statusLabel(pg.status) }}</span></td>
                <td class="text-sm text-muted"><strong>{{ pg.proofread_count || 0 }} / {{ project?.required_proofreads || 2 }}</strong></td>
                <td class="text-sm text-muted">{{ pg.expand?.proofreader?.name || pg.expand?.proofreader?.email || '—' }}</td>
                <td class="text-sm text-muted">{{ pg.mismatch_count || 0 }}</td>
                <td class="text-sm text-muted" style="max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                  {{ Array.from(pg.ocr_text || '').slice(0, 80).join('') || '—' }}
                </td>
                <td>
                  <RouterLink
                    v-if="pg.status === PAGE_STATUS.ARBITRATION"
                    :to="`/admin/projects/${projectId}/arbitration/${pg.id}`"
                    class="btn btn-warn btn-sm"
                  >
                    仲裁
                  </RouterLink>
                  <span v-else class="text-muted">—</span>
                </td>
                <td>
                  <div class="flex gap-2">
                    <button
                      class="btn btn-secondary btn-sm"
                      :disabled="!canMoveUp(pg.id) || mutatingRows"
                      @click="movePendingRow(pg.id, -1)"
                    >
                      上移
                    </button>
                    <button
                      class="btn btn-secondary btn-sm"
                      :disabled="!canMoveDown(pg.id) || mutatingRows"
                      @click="movePendingRow(pg.id, 1)"
                    >
                      下移
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          </div>
          <nav v-if="listPagination.totalPages > 1" class="admin-pagination" aria-label="条目分页">
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="listPagination.page <= 1"
              @click="currentListPage -= 1"
            >
              上一页
            </button>
            <span class="text-sm text-muted">
              第 {{ listPagination.page }} / {{ listPagination.totalPages }} 页
            </span>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="listPagination.page >= listPagination.totalPages"
              @click="currentListPage += 1"
            >
              下一页
            </button>
          </nav>
        </div>
      </section>
    </template>
  </main>
</template>

<script setup>
import { orderedRowHeaders } from '@/composables/useStructuredRow'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { parseRangeInput } from '@/lib/adminPageList'
import { summarizePages } from '@/lib/workspaceInsights'
import { safeParseRowJson } from '@/composables/useStructuredRow'
import {
  PAGE_STATUS,
  PAGE_STATUS_LABELS,
  statusBadgeClass,
  statusLabel
} from '@/constants/pageStatus'
import {
  deletePendingPages,
  listAdminProjectPages,
  listAllProjectPages,
  reorderPendingPages
} from '@/services/pagesService'
import { createProjectPdf, getProjectFile, listProjectPdfUploads, cancelProjectPdfUpload } from '@/services/projectFilesService'
import { validatePdfFile, loadPdfUploadResume, clearPdfUploadResume } from '@/lib/chunkedPdfUpload'
import { currentUserId } from '@/services/authService'
import { commitCsvImport, createCsvInspection, getImportJob, listImportJobErrors, startOcr } from '@/services/importJobsService'
import { csvFatalMessage, parseCsvInspection } from '@/lib/csvInspection'
import { toSafeCsvCell } from '@/lib/csvExport'
import { getProject } from '@/services/projectsService'
import { getPbMessage, getPbStatus, getUploadErrorMessage } from '@/utils/pbErrors'

const route = useRoute()
const router = useRouter()
const projectId = Array.isArray(route.params.id) ? route.params.id[0] : route.params.id
const ACTIVE_STATUS_FILTER = 'active'
const initialStatus = Array.isArray(route.query.status) ? route.query.status[0] : route.query.status

const project = ref(null)
const projectError = ref('')
const pages = ref([])
const pagesError = ref('')
const loadingProject = ref(true)
const loadingPages = ref(true)
const pageStats = ref(summarizePages([]))
const totalFilteredItems = ref(0)
const serverTotalPages = ref(1)
const minPdfPage = ref('')
const maxPdfPage = ref('')
let pageLoadGeneration = 0
let searchTimer

const pdfInput = ref(null)
const csvInput = ref(null)
const pdfFile = ref(null)
const pdfUploadProgress = ref(0)
let pdfUploadController = null
const pdfResume = ref(null)
const csvFile = ref(null)
const uploadingPdf = ref(false)
const uploadingCsv = ref(false)
const mutatingRows = ref(false)
const mutationSuccess = ref('')
const mutationError = ref('')
const pdfSuccess = ref(false)
const pdfMetadata = ref(null)
const pdfProcessing = ref(false)
const pdfError = ref('')
const csvSuccess = ref('')
const csvError = ref('')
const csvJob = ref(null)
const csvImportErrors = ref([])
const ocrJob = ref(null)
const ocrError = ref('')
const ocrRunning = ref(false)
const exportingCsv = ref(false)
const exportError = ref('')
const exportSuccess = ref('')
const entriesSection = ref(null)
const selectedPendingIds = ref([])
const rangeSelectInput = ref('')
const searchQuery = ref('')
const selectedStatus = ref(
  initialStatus === ACTIVE_STATUS_FILTER || PAGE_STATUS_LABELS[initialStatus]
    ? String(initialStatus)
    : ''
)
const currentListPage = ref(1)
const listPageSize = ref(25)
let pdfPollGeneration = 0
let csvPollGeneration = 0

const statusOptions = Object.entries(PAGE_STATUS_LABELS).map(([value, label]) => ({ value, label }))

const approvedPct = computed(() => pageStats.value.completionPct)

const filteredPages = computed(() => pages.value)
const listPagination = computed(() => ({ page: currentListPage.value, perPage: listPageSize.value, totalItems: totalFilteredItems.value, totalPages: serverTotalPages.value }))
const displayedPages = computed(() => pages.value)
const displayedPageOffset = computed(() => (currentListPage.value - 1) * listPageSize.value)
const hasActiveListFilter = computed(() => Boolean(searchQuery.value.trim() || selectedStatus.value || minPdfPage.value || maxPdfPage.value))
const allPendingSelected = computed(() => {
  return pageStats.value.unstarted > 0 && selectedPendingIds.value.length === pageStats.value.unstarted
})
const csvJobProgress = computed(() => {
  const processed = Number(csvJob.value?.processed_count || 0)
  const total = Number(csvJob.value?.total_count || 0)
  if (['validated', 'completed', 'completed_with_errors'].includes(csvJob.value?.status)) return 100
  if (!total) return ['inspecting', 'processing'].includes(csvJob.value?.status) ? 10 : 0
  return Math.min(99, Math.round((processed / total) * 100))
})
const csvJobStatusLabel = computed(() => ({
  inspecting: '后端正在预检',
  validated: '后端预检完成',
  queued: '等待后端处理',
  processing: '后端正在导入',
  completed: '导入完成',
  completed_with_errors: '导入完成，部分条目已跳过',
  failed: '导入失败'
})[csvJob.value?.status] || '准备导入')
const csvInspection = computed(() => parseCsvInspection(csvJob.value?.inspection_json))
const ocrJobStatusLabel = computed(() => ({
  queued: '等待识别',
  processing: '识别进行中',
  completed: '识别完成',
  completed_with_errors: '识别完成，部分失败',
  failed: '识别失败'
})[ocrJob.value?.status] || '未开始')
const csvPreviewHeaders = computed(() => csvInspection.value?.headers.slice(0, 6) || [])
const pdfResumeExpired = computed(() => Boolean(pdfResume.value?.expired))

watch([searchQuery, selectedStatus, listPageSize, minPdfPage, maxPdfPage], () => {
  currentListPage.value = 1
  clearTimeout(searchTimer)
  searchTimer = setTimeout(loadPages, 200)
})
watch(currentListPage, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(loadPages, 200)
})

onMounted(async () => {
  try {
    project.value = await getProject(projectId)
    if (!project.value.capabilities?.canManage) {
      projectError.value = '无权限管理该项目。'
      loadingProject.value = false
      return
    }
  } catch (e) {
    const status = getPbStatus(e)
    if (status === 401) {
      projectError.value = '登录状态已失效，请重新登录。'
    } else if (status === 403) {
      projectError.value = '无权限查看该项目。'
    } else if (status === 404) {
      projectError.value = '项目不存在。'
    } else {
      projectError.value = getPbMessage(e, '加载项目失败，请稍后重试。')
    }
    loadingProject.value = false
    return
  }
  loadingProject.value = false
  await Promise.all([loadPages(), loadPdfResume()])
  if (selectedStatus.value) {
    await nextTick()
    scrollToEntries()
  }
})

onBeforeUnmount(() => {
  pdfUploadController?.abort()
  pdfPollGeneration += 1
  csvPollGeneration += 1
  pageLoadGeneration += 1
  clearTimeout(searchTimer)
})

async function loadPages() {
  const generation = ++pageLoadGeneration
  loadingPages.value = true
  pagesError.value = ''
  try {
    const result = await listAdminProjectPages(projectId, {
      page: currentListPage.value, perPage: listPageSize.value,
      q: searchQuery.value, status: selectedStatus.value,
      minPage: minPdfPage.value, maxPage: maxPdfPage.value
    })
    if (generation !== pageLoadGeneration) return
    pages.value = result.items
    totalFilteredItems.value = result.totalItems
    serverTotalPages.value = result.totalPages
    currentListPage.value = result.page
    pageStats.value = result.stats
  } catch (e) {
    if (generation === pageLoadGeneration) pagesError.value = getPbMessage(e, '条目列表加载失败，请稍后重试。')
  } finally {
    if (generation === pageLoadGeneration) loadingPages.value = false
  }
}

// Full lightweight metadata is fetched only for explicit global bulk operations.
async function operationRows() {
  mutatingRows.value = true
  try { return await listAllProjectPages(projectId, { fields: 'id,status,page_number', sort: 'page_number,id' }) } finally { mutatingRows.value = false }
}

function resetListFilters() {
  searchQuery.value = ''
  minPdfPage.value = ''
  maxPdfPage.value = ''
  selectedStatus.value = ''
  currentListPage.value = 1
  syncStatusQuery('')
}

function filterActivePages() {
  filterByStatus(ACTIVE_STATUS_FILTER)
}

async function filterByStatus(status) {
  selectedStatus.value = selectedStatus.value === status ? '' : status
  currentListPage.value = 1
  syncStatusQuery(selectedStatus.value)
  await nextTick()
  scrollToEntries()
}

function syncStatusQuery(status) {
  const query = { ...route.query }
  if (status) query.status = status
  else delete query.status
  router.replace({ query })
}

function scrollToEntries() {
  entriesSection.value?.scrollIntoView({
    behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start'
  })
}

function clearMutationFeedback() {
  mutationSuccess.value = ''
  mutationError.value = ''
}

async function onPdfSelected(e) {
  if (uploadingPdf.value) return
  pdfFile.value = e.target.files[0] || null
  pdfSuccess.value = false
  pdfMetadata.value = null
  pdfProcessing.value = false
  pdfError.value = ''
  pdfUploadProgress.value = 0
  if (!pdfFile.value) return
  try {
    validatePdfFile(pdfFile.value)
  } catch (error) {
    pdfFile.value = null
    pdfError.value = error.message
    e.target.value = ''
    return
  }
  await uploadPdf()
}

function onCsvSelected(e) {
  csvFile.value = e.target.files[0] || null
  csvSuccess.value = ''
  csvError.value = ''
  csvJob.value = null
  csvImportErrors.value = []
}

function decoratePdfResume(item) {
  if (!item) return null
  const expiresAt = item.expiresAt
  let expired = false
  if (expiresAt) {
    const date = new Date(expiresAt)
    expired = Number.isNaN(date.getTime()) || date.getTime() <= Date.now()
  }
  return { ...item, expired }
}

async function loadPdfResume() {
  const userId = currentUserId()
  const stored = loadPdfUploadResume(typeof localStorage === 'undefined' ? null : localStorage, userId, projectId)
  try {
    const listed = await listProjectPdfUploads(projectId)
    const item = listed?.items?.[0]
    if (item) {
      pdfResume.value = decoratePdfResume(item)
      return
    }
    // A successful empty list means the upload finished, expired, or was canceled.
    // Do not revive a local key that would hide "选择 PDF 文件" over an already-ready file.
    clearPdfUploadResume(typeof localStorage === 'undefined' ? null : localStorage, userId, projectId)
    pdfResume.value = null
    return
  } catch {
    /* Local resume is enough to prompt re-selection after a network error. */
  }
  pdfResume.value = decoratePdfResume(stored)
}

async function abandonPdfResume() {
  const userId = currentUserId()
  const sessionId = pdfResume.value?.id || pdfResume.value?.sessionId
  try {
    if (sessionId) await cancelProjectPdfUpload(projectId, sessionId)
  } catch {
    /* Clearing the local prompt still lets the user start a new file. */
  }
  clearPdfUploadResume(typeof localStorage === 'undefined' ? null : localStorage, userId, projectId)
  pdfResume.value = null
  pdfError.value = ''
}

async function uploadPdf() {
  if (!pdfFile.value || uploadingPdf.value) return
  uploadingPdf.value = true
  pdfUploadProgress.value = 0
  pdfError.value = ''
  pdfSuccess.value = false
  pdfMetadata.value = null
  pdfProcessing.value = false
  const generation = ++pdfPollGeneration
  try {
    pdfUploadController = new AbortController()
    const signal = pdfUploadController.signal
    let record = await createProjectPdf({
      projectId,
      file: pdfFile.value,
      signal,
      userId: currentUserId(),
      onProgress: value => { if (generation === pdfPollGeneration) pdfUploadProgress.value = value }
    })
    if (generation !== pdfPollGeneration) return
    pdfProcessing.value = record.status === 'processing'
    while (record.status === 'processing' && generation === pdfPollGeneration) {
      await pollDelay(1000)
      record = await getProjectFile(record.id)
    }
    if (generation !== pdfPollGeneration) return
    pdfProcessing.value = false
    if (record.status === 'ready') {
      pdfSuccess.value = true
      pdfMetadata.value = record
      pdfFile.value = null
      pdfResume.value = null
      if (pdfInput.value) pdfInput.value.value = ''
    } else {
      pdfError.value = record.error_message || 'PDF 后端校验失败'
    }
  } catch (e) {
    if (generation !== pdfPollGeneration) return
    pdfError.value = pdfUploadController?.signal.aborted ? '上传已取消' : getUploadErrorMessage(e, 'pdf')
    pdfProcessing.value = false
    await loadPdfResume()
  } finally {
    if (generation === pdfPollGeneration) uploadingPdf.value = false
  }
}

async function uploadCsv() {
  if (!csvFile.value) return
  uploadingCsv.value = true
  csvError.value = ''
  csvSuccess.value = ''
  csvJob.value = null
  csvImportErrors.value = []
  const generation = ++csvPollGeneration
  try {
    let job = await createCsvInspection({ projectId, file: csvFile.value })
    csvJob.value = job
    csvFile.value = null
    if (csvInput.value) csvInput.value.value = ''
    while (['inspecting', 'queued', 'processing'].includes(job.status) && generation === csvPollGeneration) {
      await pollDelay(1000)
      job = await getImportJob(job.id)
      csvJob.value = job
    }
    if (generation !== csvPollGeneration) return

    if (job.status === 'failed') {
      csvError.value = csvFatalMessage(job)
    } else if (job.status === 'validated') {
      const inspection = parseCsvInspection(job.inspection_json)
      csvSuccess.value = inspection
        ? `后端预检完成：${inspection.validRows} 条可导入，${inspection.invalidRows} 条需跳过。请确认后开始导入。`
        : '后端预检完成，请确认后开始导入。'
      if (job.failed_count > 0) {
        const result = await listImportJobErrors(job.id, 1, 100)
        csvImportErrors.value = result.items
      }
    } else if (['completed', 'completed_with_errors'].includes(job.status)) {
      csvSuccess.value = '相同文件已经导入，无需重复处理。'
      await loadPages()
    }
  } catch (e) {
    csvError.value = getUploadErrorMessage(e, 'csv')
  } finally {
    if (generation === csvPollGeneration) uploadingCsv.value = false
  }
}

async function confirmCsvImport() {
  if (csvJob.value?.status !== 'validated') return
  uploadingCsv.value = true
  csvError.value = ''
  csvSuccess.value = ''
  csvImportErrors.value = []
  const generation = ++csvPollGeneration
  try {
    let job = await commitCsvImport(csvJob.value.id)
    csvJob.value = job
    while (['queued', 'processing'].includes(job.status) && generation === csvPollGeneration) {
      await pollDelay(1000)
      job = await getImportJob(job.id)
      csvJob.value = job
    }
    if (generation !== csvPollGeneration) return
    if (job.status === 'failed') {
      csvError.value = csvFatalMessage(job)
      return
    }
    csvSuccess.value = job.failed_count > 0
      ? `成功导入 ${job.success_count} 条，跳过 ${job.failed_count} 条错误记录。`
      : `成功导入 ${job.success_count} 条待校对任务！`
    if (job.failed_count > 0) {
      const result = await listImportJobErrors(job.id, 1, 100)
      csvImportErrors.value = result.items
    }
    selectedPendingIds.value = []
    await loadPages()
  } catch (e) {
    csvError.value = getPbMessage(e, '确认导入失败，请稍后重试。')
  } finally {
    if (generation === csvPollGeneration) uploadingCsv.value = false
  }
}

function pollDelay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function startOcrRecognition() {
  if (ocrRunning.value) return
  ocrRunning.value = true
  ocrError.value = ''
  ocrJob.value = null
  try {
    let job = await startOcr({ projectId })
    ocrJob.value = job
    while (['queued', 'processing'].includes(job.status)) {
      await pollDelay(1000)
      job = await getImportJob(job.id)
      ocrJob.value = job
    }
    if (job.status === 'failed') {
      ocrError.value = job.error_message || '识别失败，请稍后重试。'
    }
  } catch (e) {
    ocrError.value = getPbMessage(e, '发起识别失败，请稍后重试。')
  } finally {
    ocrRunning.value = false
  }
}

async function exportCsv() {
  exportingCsv.value = true
  exportError.value = ''
  exportSuccess.value = ''
  try {
    const all = await listAllProjectPages(projectId, {
      fields: 'id,page_number,pdf_page,status,ocr_text,proofread_text,ocr_row_json,proofread_row_json,row_headers_json'
    })
    if (!all.length) {
      throw new Error('当前项目暂无可导出的条目')
    }

    const headers = []
    const rows = all.map((item) => {
      const proofObj = item.status === PAGE_STATUS.APPROVED
        ? safeParseRowJson(item.proofread_row_json)
        : null
      const ocrObj = safeParseRowJson(item.ocr_row_json)
      const rowObj = proofObj || ocrObj || { 内容: item.proofread_text || item.ocr_text || '' }
      for (const key of orderedRowHeaders(item, rowObj)) {
        if (!headers.includes(key)) headers.push(key)
      }
      return {
        pageNumber: Number(item.pdf_page) || Number(item.page_number) || '',
        rowObj
      }
    })

    const finalHeaders = ['PDF页码', ...headers]
    const lines = [finalHeaders.map(toSafeCsvCell).join(',')]
    for (const row of rows) {
      const values = [row.pageNumber, ...headers.map((h) => row.rowObj[h] ?? '')]
      lines.push(values.map(toSafeCsvCell).join(','))
    }

    const csvText = '\uFEFF' + lines.join('\r\n')
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const safeName = (project.value?.name || 'project').replace(/[\\/:*?"<>|]/g, '_')
    link.href = url
    link.download = `${safeName}_校对结果.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    exportSuccess.value = `已导出 ${rows.length} 条记录`
  } catch (e) {
    exportError.value = e?.message || '导出失败，请重试'
  } finally {
    exportingCsv.value = false
  }
}

function isPending(row) {
  return row?.status === PAGE_STATUS.PENDING
}

function toggleRowSelection(id, checked) {
  if (mutatingRows.value) return
  if (checked) {
    if (!selectedPendingIds.value.includes(id)) selectedPendingIds.value.push(id)
    return
  }
  selectedPendingIds.value = selectedPendingIds.value.filter((x) => x !== id)
}

async function toggleSelectAllPending() {
  if (mutatingRows.value) return
  if (allPendingSelected.value) {
    selectedPendingIds.value = []
    return
  }
  try { selectedPendingIds.value = (await operationRows()).filter(isPending).map(p => p.id) } catch (e) { mutationError.value = getPbMessage(e, '选择失败，请重试') }
}

function canMoveUp(id) {
  return Number(pages.value.find(row => row.id === id)?.page_number) > 1
}

function canMoveDown(id) {
  return Number(pages.value.find(row => row.id === id)?.page_number) < pageStats.value.total
}

async function movePendingRow(id, direction) {
  if (mutatingRows.value) return
  let pending
  try { pending = (await operationRows()).filter(isPending) } catch (e) { mutationError.value = getPbMessage(e, '加载顺序失败'); return }
  const idx = pending.findIndex(row => row.id === id)
  if (idx < 0) return
  const targetIdx = idx + direction
  if (targetIdx < 0 || targetIdx >= pending.length) return

  const current = pending[idx]
  if (!current || !pending[targetIdx]) return

  mutatingRows.value = true
  clearMutationFeedback()
  try {
    const currentPageNum = Number(current.page_number)
    const orderedIds = pending.map((page) => page.id)
    ;[orderedIds[idx], orderedIds[targetIdx]] = [orderedIds[targetIdx], orderedIds[idx]]
    await reorderPendingPages(projectId, orderedIds)
    await loadPages()
    mutationSuccess.value = `第 ${currentPageNum} 条已${direction < 0 ? '上移' : '下移'}。`
  } catch (e) {
    mutationError.value = getPbMessage(e, '顺序调整失败，请重试')
  } finally {
    mutatingRows.value = false
  }
}

async function selectByRange() {
  if (mutatingRows.value) return
  clearMutationFeedback()
  let rows
  try { rows = await operationRows() } catch (e) { mutationError.value = getPbMessage(e, '选择失败，请重试'); return }
  const indexes = parseRangeInput(rangeSelectInput.value, rows.length)
  if (!indexes.length) {
    mutationError.value = '范围格式无效，请输入如 1-33 或 1,3,5-8。'
    return
  }

  const ids = []
  for (const idx of indexes) {
    const row = rows[idx]
    if (row && isPending(row)) ids.push(row.id)
  }

  selectedPendingIds.value = ids
  if (!ids.length) {
    mutationError.value = '该范围内没有可操作的待校对条目（仅待校对状态可选）。'
  } else {
    mutationSuccess.value = `已按范围选择 ${ids.length} 条待校对条目。`
  }
}

async function applyPendingOrderByIds(orderedPendingIds) {
  if (!orderedPendingIds.length) return
  await reorderPendingPages(projectId, orderedPendingIds)
}

async function moveSelectedRowsDown() {
  if (mutatingRows.value || selectedPendingIds.value.length === 0) return
  let pending
  try { pending = (await operationRows()).filter(isPending) } catch (e) { mutationError.value = getPbMessage(e, '加载顺序失败'); return }
  if (!pending.length) return

  const ids = pending.map((p) => p.id)
  const selectedSet = new Set(selectedPendingIds.value)
  const reordered = [...ids]

  let moved = false
  for (let i = reordered.length - 2; i >= 0; i--) {
    const curr = reordered[i]
    const next = reordered[i + 1]
    if (selectedSet.has(curr) && !selectedSet.has(next)) {
      reordered[i] = next
      reordered[i + 1] = curr
      moved = true
    }
  }

  if (!moved) {
    clearMutationFeedback()
    mutationError.value = '所选条目已经位于可下移范围的末尾。'
    return
  }

  mutatingRows.value = true
  clearMutationFeedback()
  try {
    await applyPendingOrderByIds(reordered)
    await loadPages()
    mutationSuccess.value = `已下移 ${selectedPendingIds.value.length} 条待校对条目。`
  } catch (e) {
    mutationError.value = getPbMessage(e, '批量下移失败，请重试')
  } finally {
    mutatingRows.value = false
  }
}

async function deleteSelectedRows() {
  if (mutatingRows.value || selectedPendingIds.value.length === 0) return
  const ok = window.confirm(`确认删除已选择的 ${selectedPendingIds.value.length} 条待校对条目吗？此操作不可恢复。`)
  if (!ok) return

  const deleteCount = selectedPendingIds.value.length
  mutatingRows.value = true
  clearMutationFeedback()
  try {
    await deletePendingPages(projectId, selectedPendingIds.value)
    selectedPendingIds.value = []
    await loadPages()
    mutationSuccess.value = `已删除 ${deleteCount} 条待校对条目，并重新整理条号。`
  } catch (e) {
    mutationError.value = getPbMessage(e, '批量删除失败，请重试')
  } finally {
    mutatingRows.value = false
  }
}

function formatItemNo(pageNumber, fallbackIndex) {
  const n = Number(pageNumber)
  if (Number.isFinite(n) && n > 0) return Math.floor(n)
  return fallbackIndex + 1
}

</script>
