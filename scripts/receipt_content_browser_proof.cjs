// Local browser proof of real React components with deterministic API fixtures.
// API authorization/persistence is covered separately by the DB integration suite.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { build } = require('../web/node_modules/esbuild');
const EDGE = [process.env.BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean).find(fs.existsSync);
if (!EDGE) throw Error('A Chromium browser is required for the visual proof');
const wait = ms => new Promise(r => setTimeout(r, ms));
const fixture = `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {ChatPanel} from './src/pages/deal';
import {ReceiptFields, ContentAdmin, PublicSellerPage, BuyerEntitlement, SellerReceipts, PublicProfileEditor, ContentPage} from './src/receiptContent';
const seller = {id:'11111111-1111-4111-8111-111111111111',name:'חנות הספרים',about:'ספרים ושירות אישי לכל הקונים.',stats:{published:3,completed:2,success_rate:67},deals:[{deal_id:'11111111-1111-4111-8111-111111111111',title:'ספר לקבוצה',state:'Completed',price_per_unit:60}]};
const entitlement={entitlement_id:'fixture',method:'qr',title:'ספר לקבוצה',quantity:2,remaining_quantity:2,status:'valid',code:'ABCD-1234-ABCD-1234-ABCD-1234-ABCD-1234',instructions:'הציגו למוכר את הקוד'};
const section={label:'דף הבית',fields:{title:{label:'כותרת ראשית',max:120},sub:{label:'כותרת משנה',max:1000,multiline:true},image:{label:'תמונה',max:100,image:true}},value:{title:'כותרת קיימת',sub:'תוכן קיים לעריכה',image:''},revision:0};
window.saved=[];
window.fetch=async (url,init={})=>{
 let data={ok:true}; const p=String(url); const body=init.body?JSON.parse(init.body):{};
 if(init.method==='PUT'||init.method==='POST')window.saved.push({url:p,body});
 if(p==='/api/admin/site-content')data={ok:true,sections:{home:section}};
 else if(p==='/api/site-content')data={ok:true,content:{legal_terms:{title:'תנאי שימוש',body:'# תנאי שימוש\\n\\n## מידע לקונים\\n\\nתוכן משפטי בתוך עיצוב האתר'}}};
 else if(p==='/api/admin/site-content/home'){section.value=body.value;section.revision++;data={ok:true,sections:{home:section}};}
 else if(p==='/api/seller/public-profile')data={ok:true,profile:seller};
 else if(p.startsWith('/api/public-sellers'))data={ok:true,seller};
 else if(p.includes('/entitlement'))data={ok:true,configured:true,entitlement,public_name_opt_in:false};
 else if(p.startsWith('/api/seller/receipts'))data={ok:true,orders:[{...entitlement,participant_id:'fixture',name:'ישראל',phone:'0500000000'}]};
 else if(p.includes('/chat'))data={ok:true,messages:[]};
 else if(p==='/api/preview/meta')data={ok:true};
 return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
};
function Fields(){const [v,setV]=React.useState({method:'qr',instructions:'',url:''});return <ReceiptFields value={v} onChange={setV}/>}
const root=createRoot(document.getElementById('root'));
window.show=view=>root.render(<div className="app"><main className="container" style={{paddingTop:20}}>
 {view==='chat'?<ChatPanel dealId="fixture" canWrite/>:null}
 {view==='fields'?<Fields/>:null}
 {view==='cms'?<ContentAdmin/>:null}
 {view==='seller'?<PublicSellerPage id={seller.id}/>:null}
 {view==='buyer'?<BuyerEntitlement participantId="fixture" token="test-token"/>:null}
 {view==='redeem'?<SellerReceipts/>:null}
 {view==='profile'?<PublicProfileEditor/>:null}
 {view==='legal'?<ContentPage section="legal_terms"/>:null}
 </main></div>);
window.show('chat');
`;
async function main() {
  const built = await build({ stdin: { contents: fixture, resolveDir: path.resolve('web'), loader: 'tsx' }, bundle: true, write: false, format: 'iife', define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const js = built.outputFiles[0].text;
  const html = '<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/fixture.js"></script></html>';
  const server = createServer((req,res) => {
    if(req.url==='/brand/c-ton-logo-1024.jpg'){ res.setHeader('Content-Type','image/jpeg'); return res.end(fs.readFileSync('web/public/brand/c-ton-logo-1024.jpg')); }
    const type = req.url==='/fixture.js'?'application/javascript':req.url==='/style.css'?'text/css':'text/html'; res.setHeader('Content-Type',type+'; charset=utf-8'); res.end(req.url==='/fixture.js'?js:req.url==='/style.css'?fs.readFileSync('web/src/styles.css'):html);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port = server.address().port;
  const debugPort = 38473;
  const browser=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${path.resolve('.tmp_receipt_browser_profile')}`,'about:blank'],{stdio:'ignore',windowsHide:true});
  let ws;
  try {
    let page;
    for(let i=0;i<80;i++){try{page=(await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(p=>p.type==='page');if(page)break;}catch{}await wait(200);}
    if(!page)throw Error('Browser unavailable');
    ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
    let seq=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
    await send('Page.enable');await send('Page.navigate',{url:`http://127.0.0.1:${port}`});
    for(let i=0;i<80;i++){if(await evaluate('!!document.querySelector(".chat-form")'))break;await wait(100);}
    for(const width of [320,390,768,1440]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
      await evaluate('window.show("chat")');await wait(100);
      const geometry=await evaluate(`(()=>{const title=document.querySelector('[aria-label="כותרת ההודעה"]'),body=document.querySelector('.chat-form textarea'),t=title.getBoundingClientRect(),b=body.getBoundingClientRect();return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,vertical:b.top>=t.bottom,larger:b.height>t.height*2,max:title.maxLength}})()`);
      assert.deepEqual(geometry,{width,overflow:false,vertical:true,larger:true,max:80});
      await evaluate(`document.querySelector('[aria-label="כותרת ההודעה"]').focus()`);await send('Input.insertText',{text:'א'.repeat(85)});
      assert.equal(await evaluate(`document.querySelector('[aria-label="כותרת ההודעה"]').value.length`),80);
      for(const view of ['chat','fields','cms','seller','buyer','redeem','profile','legal']){
        await evaluate(`window.show(${JSON.stringify(view)})`);await wait(150);
        assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,`${view} overflows at ${width}`);
        if(view==='fields'){
          assert.equal(await evaluate(`document.querySelectorAll('[name="receipt-method"]').length`),5);
          await evaluate(`document.querySelectorAll('[name="receipt-method"]')[3].click()`);await wait(30);
          assert.equal(await evaluate(`!!document.querySelector('input[type="url"]')`),true);
        }
        if(view==='cms') assert.equal(await evaluate('document.querySelector("form img").naturalWidth>0'),true,'CMS previews the actual existing hero image');
        if(view==='legal') {
          assert.equal(await evaluate('document.querySelectorAll("h1").length'),1,'legal page has one title');
          assert.equal(await evaluate('document.querySelectorAll("h2").length'),1,'legal body renders section headings');
        }
        if(width===320||width===1440){const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(`.tmp_receipt_${view}_${width}.png`,Buffer.from(shot.data,'base64'));}
      }
      console.log(`PASS ${width}px: vertical chat, enforced maxlength, five methods, all eight screens without overflow`);
    }
    await evaluate('window.show("cms")');await wait(100);
    assert.equal(await evaluate('document.querySelector("form input").value'),'כותרת קיימת');
    await evaluate(`(()=>{const el=document.querySelector('form input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'כותרת מעודכנת');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await evaluate('document.querySelector("form button").click()');await wait(150);
    assert.equal(await evaluate('window.saved.at(-1).body.value.title'),'כותרת מעודכנת');
    console.log('PASS CMS existing content preloaded and edited value submitted; screenshots captured');
  } finally { if(ws)ws.close();browser.kill();await new Promise(r=>server.close(r)); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
