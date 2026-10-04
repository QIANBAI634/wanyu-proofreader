// Production Vue build + real disposable PocketBase; only static hosting is simulated.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')
const fixture = JSON.parse(fs.readFileSync(process.env.PDF_BROWSER_FIXTURE))
const dist = path.resolve(__dirname, '../../frontend/dist')
const csp = fs.readFileSync(path.resolve(__dirname, '../../frontend/nginx.conf'), 'utf8').match(/add_header Content-Security-Policy "([^"]+)"/)[1]
;(async () => {
 const browser = await chromium.launch({ headless:true, ...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {}), ...(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {}) })
 try {
  const page = await browser.newPage({viewport:{width:1440,height:900}})
  const errors=[], downloads=[], descriptors=[]
  let rejectRenewal = false
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', async route => {
   const req=route.request(), url=new URL(req.url())
   assert.equal(url.origin,'http://localhost')
   if(url.pathname.startsWith('/api/')) {
    // Keep this regression on the PDF degradation path; images have their own suite.
    if(url.pathname.includes('/images/')) return route.fulfill({status:404,json:{message:'PDF fallback fixture'}})
    if(/\/pdf$/.test(url.pathname)) downloads.push(url.pathname)
    if(/\/pdf\/descriptor$/.test(url.pathname)) descriptors.push(url.pathname)
    if(rejectRenewal && url.pathname.endsWith('/lease/renew')) return route.fulfill({status:403,json:{message:'任务租约已失效，请重新领取'}})
    const headers={...req.headers()};delete headers.host;delete headers['content-length']
    const res=await fetch(fixture.base+url.pathname+url.search,{method:req.method(),headers,body:req.postDataBuffer()||undefined})
    const responseHeaders=Object.fromEntries(res.headers);delete responseHeaders['content-length'];delete responseHeaders['content-encoding']
    return route.fulfill({status:res.status,headers:responseHeaders,body:Buffer.from(await res.arrayBuffer())})
   }
   const target=path.resolve(dist,'.'+url.pathname)
   assert(target.startsWith(dist+path.sep)||target===dist)
   if(fs.existsSync(target)&&fs.statSync(target).isFile()) return route.fulfill({path:target})
   return route.fulfill({path:path.join(dist,'index.html'),headers:{'Content-Security-Policy':csp}})
  })
  await page.addInitScript(({auth,claim})=>{
   localStorage.setItem('pocketbase_auth',JSON.stringify({token:auth.token,record:auth.record,model:auth.record}))
   localStorage.setItem(`fangji:onboarding:v1:${auth.record.id}`,JSON.stringify({version:1,completed:true}))
   sessionStorage.setItem(`fangji:task-lease:v1:${auth.record.id}:${claim.id}`,JSON.stringify({token:claim.leaseToken,expiresAt:claim.leaseExpiresAt}))
   window.__revoked=[];const revoke=URL.revokeObjectURL;URL.revokeObjectURL=function(url){window.__revoked.push(url);return revoke.call(this,url)}
  },fixture)
  await page.goto(`http://localhost/tasks/${fixture.claim.id}/edit`)
  const rendered = async () => {
   await page.locator('.pdf-canvas').waitFor({state:'visible'})
   await page.waitForFunction(()=>document.querySelector('.pdf-canvas')?.width>10 && !document.querySelector('.pdf-loading-mask') && !document.querySelector('.pdf-transition-mask'))
  }
  await rendered()
  // Select the second local page and enlarge it: both selection and reader state
  // must survive route changes within this preview range.
  await page.getByRole('button',{name:'下一页',exact:true}).click()
  await page.getByRole('button',{name:'＋',exact:true}).click()
  await rendered()
  await page.evaluate(()=>{window.__canvas=document.querySelector('.pdf-canvas');document.querySelector('.pdf-scroll').scrollTop=90;window.__scroll=document.querySelector('.pdf-scroll').scrollTop})
  assert(await page.evaluate(()=>window.__scroll>0),'fixture must actually scroll')
  async function submitTo(id) {
   await page.getByRole('button',{name:'检查并提交',exact:true}).first().click()
   await page.getByRole('button',{name:'确认提交',exact:true}).click()
   await page.waitForURL(`**/tasks/${id}/edit`)
   await rendered()
  }
  for(const next of [fixture.pages[2],fixture.pages[3]]) {
   await submitTo(next.id)
   assert(await page.evaluate(()=>window.__canvas===document.querySelector('.pdf-canvas')),'canvas was remounted')
   assert.equal(await page.locator('.pdf-zoom-label').textContent(),'125%')
   assert.equal(await page.locator('.pdf-page-input').inputValue(),'3')
   assert(await page.evaluate(()=>document.querySelector('.pdf-scroll').scrollTop===window.__scroll),'scroll position changed')
  }
  assert.equal(downloads.length,1,'three same-page tasks must download once')
  assert.equal(descriptors.length,3,'each task must authorize its descriptor')
  const out=process.env.PDF_BROWSER_OUTPUT||path.resolve(__dirname,'../../output/playwright/pdf-reuse')
  fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'same-page-reuse.png'),fullPage:true})
  await submitTo(fixture.pages[1].id)
  assert.equal(downloads.length,2,'cross-page fallback must download a new PDF')
  assert.equal(await page.locator('.pdf-zoom-label').textContent(),'100%')
  assert(await page.evaluate(()=>window.__revoked.length>=1),'old blob must be revoked')
  rejectRenewal=true
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
  await page.locator('.lease-lost-alert').waitFor({state:'visible'})
  assert.equal(await page.locator('.pdf-canvas').count(),0,'lost lease must clear preview')
  assert(await page.evaluate(()=>window.__revoked.length>=2))
  assert.deepEqual(errors,[])
  console.log('PASS browser: three same-page tasks, one PDF download, same canvas/zoom/scroll/page; cross-page reload and lease cleanup')
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)})
