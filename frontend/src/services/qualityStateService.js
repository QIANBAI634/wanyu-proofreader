import pb from '@/lib/pocketbase'

export async function setPageQualityState(projectId, pageId, { state, basis }) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/pages/${encodeURIComponent(pageId)}/quality-state`, {
    method: 'POST',
    body: { state, basis: basis || '' },
    requestKey: null
  })
}

export async function getProjectQualitySummary(projectId) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/quality-summary`, {
    requestKey: null
  })
}
