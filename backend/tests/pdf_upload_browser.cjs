// Exercises the real upload UI and backend; injects transient HTTP/response loss.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {chromium}=require('playwright')
const fixture=JSON.parse(fs.readFileSync(process.env.PDF_BROWSER_FIXTURE))
const dist=path.resolve(__dirname,'../../frontend/dist')
const csp=fs.readFileSync(path.resolve(__dirname,'../../frontend/nginx.conf'),'utf8').match(/add_header Content-Security-Policy "([^"]+)"/)[1]
// A failed create in chunkedPdfUpload.js sends one POST, then its catch cleanup
// sends another with the same requestId. Update this count and the assertion
// below if that cleanup path changes, so retry still reaches the backend.
const CREATE_POSTS_PER_FAILED_ATTEMPT=2
;(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})})
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}})
 const chunks=[],completions=[],errors=[];let failed=false,lost=false,forwardedCreates=0,blockedCreates=0
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());assert.equal(url.origin,'http://localhost')
  if(url.pathname.startsWith('/api/')){
   assert(!url.pathname.endsWith('/files/pdf'),'UI must use chunked upload')
   if(url.pathname.endsWith('/pdf-uploads')&&req.method()==='POST'){
    // Block both POSTs from the first UI attempt; retry must be forwarded.
    if(blockedCreates<CREATE_POSTS_PER_FAILED_ATTEMPT){blockedCreates++;return route.fulfill({status:403,json:{message:'暂时无法上传，请重试'}})}
    forwardedCreates++
   }
   if(url.pathname.includes('/chunks/')){
    const data=req.postDataBuffer();assert(data.length<=1024*1024);chunks.push({path:url.pathname,size:data.length})
    if(!failed&&url.pathname.endsWith('/chunks/1')) {failed=true;return route.fulfill({status:503,json:{message:'temporary upload failure'}})}
   }
   const headers={...req.headers()};delete headers.host;delete headers['content-length']
   const res=await fetch(fixture.base+url.pathname+url.search,{method:req.method(),headers,body:req.postDataBuffer()||undefined})
   const body=Buffer.from(await res.arrayBuffer())
   if(url.pathname.endsWith('/complete')){
    assert([200,202].includes(res.status),body.toString());completions.push(JSON.parse(body))
    if(!lost){lost=true;return route.abort('failed')}
   }
   const responseHeaders=Object.fromEntries(res.headers);delete responseHeaders['content-length'];delete responseHeaders['content-encoding']
   return route.fulfill({status:res.status,headers:responseHeaders,body})
  }
  const target=path.resolve(dist,'.'+url.pathname);assert(target.startsWith(dist+path.sep)||target===dist)
  if(fs.existsSync(target)&&fs.statSync(target).isFile())return route.fulfill({path:target})
  return route.fulfill({path:path.join(dist,'index.html'),headers:{'Content-Security-Policy':csp}})
 })
 await page.addInitScript(auth=>localStorage.setItem('pocketbase_auth',JSON.stringify({token:auth.token,record:auth.record,model:auth.record})),fixture.auth)
 await page.goto(`http://localhost/admin/projects/${fixture.project.id}`)
 const input=page.locator('input[type=file][accept=".pdf"]')
 assert.equal(await input.getAttribute('multiple'),null,'PDF selection remains single-file')
 const out=process.env.PDF_BROWSER_OUTPUT||path.resolve(__dirname,'../../output/playwright/pdf-upload')
 fs.mkdirSync(out,{recursive:true})
 await input.setInputFiles({name:'invalid.txt',mimeType:'text/plain',buffer:Buffer.from('invalid')})
 await page.getByText('请选择不超过 100 MiB 的 PDF 文件').waitFor()
 assert.equal(blockedCreates,0,'invalid selection must not attempt to create a session')
 assert.equal(forwardedCreates,0,'invalid selection must not forward a create POST')
 await page.screenshot({path:path.join(out,'upload-invalid.png'),fullPage:true})
 await input.setInputFiles({name:'source.pdf',mimeType:'application/pdf',buffer:Buffer.from(fixture.source,'base64')})
 await page.getByRole('button',{name:'重试上传 PDF'}).waitFor()
 assert.equal(blockedCreates,CREATE_POSTS_PER_FAILED_ATTEMPT,'failed create must consume create+cleanup POSTs')
 assert.equal(forwardedCreates,0,'failed create POSTs must be intercepted before forwarding')
 await page.screenshot({path:path.join(out,'upload-failure.png'),fullPage:true})
 await page.getByRole('button',{name:'重试上传 PDF'}).click()
 await page.locator('progress').waitFor({state:'visible'})
 assert(await input.isDisabled(),'selection must be disabled during upload')
 await page.waitForFunction(()=>Number(document.querySelector('progress')?.value)>0)
 await page.screenshot({path:path.join(out,'upload-progress.png'),fullPage:true})
 await page.waitForFunction(()=>document.body.textContent.includes('PDF 深度校验完成，共 4 页')&&!document.querySelector('progress'),{},{timeout:30000})
 assert.equal(forwardedCreates,1,'retry must forward exactly one create POST')
 assert.equal(await page.getByRole('button',{name:'重试上传 PDF'}).count(),0,'success must not show retry')
 await page.screenshot({path:path.join(out,'upload-success.png'),fullPage:true})
 assert.equal(chunks.length,4,'three chunks plus one retry')
 assert.equal(completions.length,2,'lost completion response must retry')
 assert.equal(completions[0].id,completions[1].id)
 const records=await fetch(`${fixture.base}/api/collections/project_files/records?filter=${encodeURIComponent(`project="${fixture.project.id}"`)}`,{headers:{Authorization:fixture.auth.token}}).then(r=>r.json())
 assert.equal(records.totalItems,1)
 assert.equal(records.items[0].status,'ready')
 assert.deepEqual(errors,[])
 console.log('PASS browser: 1 MiB chunks, progress, temporary 503 retry, lost completion response, exactly one ready file')
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)})
