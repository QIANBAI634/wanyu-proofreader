import pb from '@/lib/pocketbase'

export async function createCsvImport({ projectId, file }) {
  const formData = new FormData()
  formData.append('file', file)
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/imports/csv`, {
    method: 'POST',
    body: formData,
    requestKey: null
  })
}

export async function createCsvInspection({ projectId, file }) {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('inspect_only', 'true')
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/imports/csv`, {
    method: 'POST',
    body: formData,
    requestKey: null
  })
}

export async function commitCsvImport(jobId) {
  return pb.send(`/api/fangji/imports/${encodeURIComponent(jobId)}/commit`, {
    method: 'POST',
    requestKey: null
  })
}

export async function startOcr({ projectId }) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/imports/ocr`, {
    method: 'POST',
    requestKey: null
  })
}

export async function getImportJob(jobId) {
  return pb.collection('import_jobs').getOne(jobId, {
    requestKey: null
  })
}

export async function listImportJobErrors(jobId, page = 1, perPage = 100) {
  return pb.collection('import_job_errors').getList(page, perPage, {
    filter: `job="${jobId}"`,
    sort: 'row_number,created',
    requestKey: null
  })
}
