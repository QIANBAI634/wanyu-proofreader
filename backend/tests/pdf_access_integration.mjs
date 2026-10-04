import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
const base=process.env.PB_URL
async function api(path,{method='GET',token='',body,status=200}={}) {
 const form=body instanceof FormData
 const r=await fetch(base+path,{method,headers:{Authorization:token,...(!form&&body?{'Content-Type':'application/json'}:{})},body:body?form?body:JSON.stringify(body):undefined})
 const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data
}
function fixturePDF() {
 const objects=['','<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>']
 for(let i=0;i<4;i++)objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${i===1?'/Rotate 90':''} /Resources << /Font << /F1 11 0 R >> >> /Contents ${7+i} 0 R >>`)
 for(let i=0;i<4;i++){const content=`BT /F1 24 Tf 50 700 Td (SOURCE_PAGE_${i+1}) Tj ET\n0 0 1 RG 2 w 20 20 572 752 re S\n`;objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`)}
 objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
 let out='%PDF-1.4\n';const offsets=[0];for(let i=1;i<objects.length;i++){offsets.push(out.length);out+=`${i} 0 obj\n${objects[i]}\nendobj\n`}
 const xref=out.length;out+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`;for(const offset of offsets.slice(1))out+=`${String(offset).padStart(10,'0')} 00000 n \n`;return out+`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}
const admin=await api('/api/collections/users/auth-with-password',{method:'POST',body:{identity:process.env.APP_ADMIN_EMAIL,password:process.env.APP_ADMIN_PASSWORD}}),token=admin.token
const superAuth=await api('/api/collections/_superusers/auth-with-password',{method:'POST',body:{identity:process.env.PB_SUPER_EMAIL,password:process.env.PB_SUPER_PASSWORD}})
const project=await api('/api/fangji/projects',{method:'POST',token,body:{name:'PDF access fixture'},status:201}),users=[]
for(let n=0;n<2;n++){
 const email=`pdf-reader-${n}@example.com`,password='PDFReader12345!'
 const user=await api('/api/collections/users/records',{method:'POST',body:{email,name:`reader${n}`,role:'user',password,passwordConfirm:password}})
 users.push(await api('/api/collections/users/auth-with-password',{method:'POST',body:{identity:email,password}}))
 await api(`/api/fangji/projects/${project.id}/members/${user.id}`,{method:'PUT',token,body:{role:'proofreader'}})
}
const form=new FormData();form.set('file',new Blob([fixturePDF()],{type:'application/pdf'}),'source.pdf')
const queued=await api(`/api/fangji/projects/${project.id}/files/pdf`,{method:'POST',token,body:form,status:202})
let file
for(let i=0;i<100;i++){file=await api(`/api/collections/project_files/records/${queued.id}`,{token});if(file.status==='ready')break;assert.notEqual(file.status,'failed');await new Promise(r=>setTimeout(r,100))}
assert.equal(file.page_count,4)
const page=await api('/api/collections/pages/records',{method:'POST',token:superAuth.token,body:{project:project.id,project_file:file.id,page_number:1,pdf_page:2,ocr_text:'test',ocr_row_json:'{"内容":"test"}',status:'pending'}})
const claim=await api(`/api/fangji/projects/${project.id}/claim`,{method:'POST',token:users[0].token});assert.equal(claim.id,page.id)
const url=`/api/fangji/pages/${page.id}/pdf`
async function check(path,auth,status,headers={}) {const r=await fetch(base+path,{headers:{Authorization:auth,...headers}});assert.equal(r.status,status,r.status===status?'':await r.text());return r}
await check(url,'',401);await check(url,users[1].token,403)
const imageDescriptor = `/api/fangji/pages/${page.id}/images/2/descriptor`
await check(imageDescriptor,'',401)
await check(imageDescriptor,users[1].token,403)
await check(`/api/fangji/pages/${page.id}/images/1/descriptor`,users[0].token,403)
await check(`/api/fangji/pages/${page.id}/images/4/descriptor`,users[0].token,403)
let imageInfo
if (process.env.REQUIRE_PAGE_IMAGES === '1') {
 for (let i=0;i<300;i++) {
  const response=await fetch(base+imageDescriptor,{headers:{Authorization:users[0].token}})
  if(response.ok){imageInfo=await response.json();break}
  assert.equal(response.status,404)
  await new Promise(r=>setTimeout(r,100))
 }
 assert.ok(imageInfo,'prewarmed image must become available')
 assert.ok(imageInfo.width>0 && imageInfo.height>0)
 const img=await check(imageInfo.url,users[0].token,200)
 assert.equal(img.headers.get('content-type'),'image/webp')
 assert.equal(img.headers.get('cache-control'),'private, no-store')
 assert.equal(Buffer.from(await img.arrayBuffer()).subarray(8,12).toString(),'WEBP')
 assert.equal((await api(imageDescriptor,{token:users[0].token})).assetId,imageInfo.assetId)
 await check(imageInfo.url,users[1].token,403)
 await check(imageInfo.url,'',401)
 await check(imageInfo.url.replace(/expires=\d+/,'expires=1'),users[0].token,403)
 await check(imageInfo.url.replace(/key=[^&]+/,'key=invalid'),users[0].token,403)
}
const fileURL=`/api/files/${file.collectionId}/${file.id}/${file.file}`
await check(fileURL,'',404)
const ft=await api('/api/files/token',{method:'POST',token:users[0].token})
await check(fileURL+'?token='+ft.token,users[0].token,404)
await check(fileURL,users[0].token,404,{Range:'bytes=0-1024'})
const aft=await api('/api/files/token',{method:'POST',token});await check(fileURL+'?token='+aft.token,token,200)
const preview=await check(url,users[0].token,200)
assert.equal(preview.headers.get('x-pdf-start-page'),'2');assert.equal(preview.headers.get('x-pdf-end-page'),'3');assert.equal(preview.headers.get('cache-control'),'private, no-store')
const firstBytes = Buffer.from(await preview.arrayBuffer())
assert.equal(firstBytes.subarray(0,5).toString(),'%PDF-')
const warm = await check(url,users[0].token,200)
assert.deepEqual(Buffer.from(await warm.arrayBuffer()),firstBytes,'warm preview should reuse the watermarked artifact')
await check(url,users[1].token,403) // Warm cache never bypasses ownership.

if(process.env.PDF_BROWSER_FIXTURE){
 await writeFile(process.env.PDF_BROWSER_FIXTURE,JSON.stringify({base,auth:users[0],claim,page,project,fileURL,imageInfo}))
 if(process.env.PDF_BROWSER_SCRIPT){const {spawnSync}=await import('node:child_process');assert.equal(spawnSync('node',[process.env.PDF_BROWSER_SCRIPT],{stdio:'inherit',env:process.env}).status,0)}
}
await api(`/api/collections/pages/records/${page.id}`,{method:'PATCH',token:superAuth.token,body:{pdf_page:4}})
const last=await check(url,users[0].token,200);assert.equal(last.headers.get('x-pdf-start-page'),'4');assert.equal(last.headers.get('x-pdf-end-page'),'4')
const lease=(await api(`/api/collections/task_leases/records?filter=${encodeURIComponent(`page="${page.id}"`)}`,{token:superAuth.token})).items[0]
await api(`/api/collections/task_leases/records/${lease.id}`,{method:'PATCH',token:superAuth.token,body:{expires_at:'2020-01-01 00:00:00.000Z'}})
await check(url,users[0].token,403)
await check(imageDescriptor,users[0].token,403)
if(imageInfo) await check(imageInfo.url,users[0].token,403)
await api(`/api/collections/pages/records/${page.id}`,{method:'PATCH',token:superAuth.token,body:{status:'pending',proofreader:''}})
await check(url,users[0].token,403)
console.log('PASS: authenticated two-page/last-page preview; anonymous, other-user, full-file/file-token/Range, expired/released access blocked; manager original access preserved')
