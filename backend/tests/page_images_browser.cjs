// Production build, synthetic PDF and real throwaway backend. No real corpus.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')
const fixture = JSON.parse(fs.readFileSync(process.env.PDF_BROWSER_FIXTURE))
const dist = path.resolve(__dirname, '../../frontend/dist')
const out = process.env.PDF_BROWSER_OUTPUT || path.resolve(__dirname, '../../output/playwright/page-images')
const csp = fs.readFileSync(path.resolve(__dirname, '../../frontend/nginx.conf'), 'utf8').match(/add_header Content-Security-Policy "([^"]+)"/)[1]
;(async () => {
 const browser = await chromium.launch({headless:true, ...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {})})
 fs.mkdirSync(out,{recursive:true})
 const evidence = {}
 try {
  for(const mode of ['desktop','mobile','fallback']) {
   const context=await browser.newContext({viewport:mode==='mobile'?{width:390,height:844}:{width:1440,height:900}})
   const page=await context.newPage(), network=[], errors=[]
   page.on('pageerror',e=>errors.push(e.message))
   await page.route('**/*', async route=>{
    const req=route.request(), url=new URL(req.url())
    assert.equal(url.origin,'http://localhost')
    if(url.pathname.startsWith('/api/')) {
     if(url.pathname.includes('/images/') || /\/pdf(?:\/descriptor)?$/.test(url.pathname)) network.push(url.pathname)
     if(mode==='fallback' && url.pathname.includes('/images/')) return route.fulfill({status:404,json:{message:'image unavailable fixture'}})
     const headers={...req.headers()};delete headers.host;delete headers['content-length']
     const response=await fetch(fixture.base+url.pathname+url.search,{method:req.method(),headers,body:req.postDataBuffer()||undefined})
     const responseHeaders=Object.fromEntries(response.headers);delete responseHeaders['content-length'];delete responseHeaders['content-encoding']
     return route.fulfill({status:response.status,headers:responseHeaders,body:Buffer.from(await response.arrayBuffer())})
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
   },fixture)
   const started=Date.now()
   let initialMs
   await page.goto(`http://localhost/tasks/${fixture.claim.id}/edit`)
   if(mode==='fallback') {
    await page.waitForFunction(()=>document.querySelector('.pdf-canvas')?.width>10 && !document.querySelector('.pdf-loading-mask') && !document.querySelector('.pdf-transition-mask'))
    initialMs=Date.now()-started
    assert.equal(network.filter(p=>/\/pdf$/.test(p)).length,1)
   }else {
    await page.waitForFunction(()=>document.querySelector('.pdf-page-image')?.naturalWidth>10 && !document.querySelector('.pdf-transition-mask'))
    await page.waitForFunction(()=>!document.querySelector('.pdf-transition-mask'))
    initialMs=Date.now()-started
    assert.equal(await page.locator('.pdf-canvas').count(),0)
    assert.equal(await page.locator('script[src*="pdf.min.js"]').count(),0)
    // Wait for adjacent preload completion before navigating.
    await page.waitForTimeout(250)
    assert.equal(network.filter(p=>p.endsWith('/asset')).length,2)
    assert.equal(network.filter(p=>/\/pdf$/.test(p)).length,0)
    assert(network.every(p=>!p.includes('/images/') || /\/images\/[23]\//.test(p)))
   }
   if(mode==='desktop') {
    // Coordinates use the descriptor's natural width/height, scaled with the page.
    await page.evaluate(({width,height})=>{
     const stage=document.querySelector('.pdf-canvas-stage')
     stage.dataset.sourceWidth=width;stage.dataset.sourceHeight=height
     const box=document.createElement('div')
     box.textContent='坐标示例 (10%, 15%)'
     Object.assign(box.style,{position:'absolute',left:'10%',top:'15%',width:'35%',height:'8%',border:'2px solid #e11d48',background:'rgba(225,29,72,.08)',color:'#9f1239',fontSize:'14px',pointerEvents:'none'})
     stage.appendChild(box)
    },fixture.imageInfo)
   }
   await page.screenshot({path:path.join(out,`${mode}.png`),fullPage:true})
   if(mode!=='fallback') {
    const before=network.filter(p=>p.endsWith('/asset')).length
    if(mode==='mobile') await page.locator('.source-actions-menu > summary').click()
    await page.getByRole('button',{name:'下一页',exact:true}).click()
    await page.waitForFunction(()=>document.querySelector('.pdf-page-input')?.value==='3' && document.querySelector('.pdf-page-image')?.naturalWidth>10 && !document.querySelector('.pdf-transition-mask'))
    if(mode==='mobile') await page.locator('.source-actions-menu > summary').click()
    assert.equal(network.filter(p=>p.endsWith('/asset')).length,before,'adjacent page should reuse prefetched asset')
    await page.getByRole('button',{name:'旋转 90°',exact:true}).click()
    await page.getByRole('button',{name:'＋',exact:true}).click()
    assert.equal(await page.locator('.pdf-zoom-label').textContent(),'125%')
    assert.equal(network.filter(p=>/\/pdf$/.test(p)).length,0)
   }
   assert.deepEqual(errors,[])
   evidence[mode]={initialMs,network}
   await context.close()
  }
  fs.writeFileSync(path.join(out,'network-and-timing.json'),JSON.stringify(evidence,null,2))
  console.log('PASS browser: page images without PDF.js; adjacent-only preload; cached navigation; rotation/zoom; mobile; PDF fallback',JSON.stringify(evidence))
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)})
