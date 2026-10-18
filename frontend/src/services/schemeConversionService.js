import pb from '@/lib/pocketbase'

// #190 拼音归一的运行面。作业只读得到项目级路由：conversion_jobs 的集合规则是
// 全 null（写入一律走服务端），所以前端不去读集合，一律走 /projects/{id}/conversions。

export async function listSchemeAdapters() {
  return pb.send('/api/fangji/scheme-adapters', { requestKey: null })
}

export async function startConversion(projectId, sourceSchemeId) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/conversions`, {
    method: 'POST',
    body: { source_scheme_id: sourceSchemeId },
    requestKey: null
  })
}

export async function listConversions(projectId) {
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/conversions`, { requestKey: null })
}

export async function listNormalizations(projectId, { status = 'AMBIGUOUS', page = 1, perPage = 10 } = {}) {
  const query = new URLSearchParams({ status, page: String(page), perPage: String(perPage) })
  return pb.send(`/api/fangji/projects/${encodeURIComponent(projectId)}/normalizations?${query}`, { requestKey: null })
}

export async function decideNormalization(pageId, { canonical, basis }) {
  return pb.send(`/api/fangji/pages/${encodeURIComponent(pageId)}/normalization`, {
    method: 'POST',
    body: { canonical_pronunciation: canonical, basis },
    requestKey: null
  })
}

// 结论回流草案。本轮没有界面调用它（草案由人从接口直接取走），留在这里是为了
// 服务层的形状与服务端一致：source_scheme_id 是必填的——草案要贴进**某一套**方案的
// 规则文件，不传的话服务端会 400，而一个注定失败的包装比没有包装更糟。
export async function listNormalizationExceptions(projectId, sourceSchemeId) {
  const query = new URLSearchParams({ source_scheme_id: String(sourceSchemeId ?? '') })
  return pb.send(
    `/api/fangji/projects/${encodeURIComponent(projectId)}/normalization-exceptions?${query}`,
    { requestKey: null }
  )
}
