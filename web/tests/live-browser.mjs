import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium,expect} from '@playwright/test';
const root=new URL('../../',import.meta.url),dist=new URL('dist/',root);
const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;const file=path==='/preview/'?'index.html':path.slice(9);if(!path.startsWith('/preview/')||file.includes('..'))throw Error();const bytes=await readFile(new URL(file,dist));res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html');res.end(bytes);}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const report={date:new Date().toISOString(),mode:'Production export at /preview/ with real public RPC requests; disconnected; no wallet or transactions',pageErrors:[],failedRequests:[],consoleErrors:[]};
page.on('pageerror',e=>report.pageErrors.push(e.message));page.on('requestfailed',r=>report.failedRequests.push({url:r.url(),reason:r.failure()}));page.on('console',msg=>{if(msg.type()==='error')report.consoleErrors.push(msg.text());});
try{
 await page.goto(`http://127.0.0.1:${server.address().port}/preview/`);
 await expect(page.getByText('Updated at block',{exact:false})).toBeVisible({timeout:55000});
 await page.locator('summary').click();
 await expect(page.getByText('Configured contracts have code; RPC chain and hook manager checked.')).toBeVisible({timeout:55000});
 report.observed=await page.locator('.live-strip,.metrics,.price-row').allTextContents();
 await page.locator('summary').click();await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:fileURLToPath(new URL('docs/evidence/live-desktop.png',root)),fullPage:true});
 report.result='PASS';
}catch(e){report.result='INCOMPLETE';report.error=e.message;process.exitCode=1;}finally{await writeFile(new URL('docs/evidence/live-browser.json',root),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));await browser.close();await new Promise(r=>server.close(r));}
