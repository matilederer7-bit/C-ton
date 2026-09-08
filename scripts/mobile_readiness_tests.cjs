const fs=require('node:fs');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
function runGate(){return spawnSync(process.execPath,['scripts/mobile_release_gate.cjs'],{encoding:'utf8'});}
assert.equal(runGate().status,0,'Baseline gate must pass');
const controls=[
 ['missing config','capacitor.config.ts',null,'Capacitor config missing'],
 ['missing bundle','.mobile_dist/mobile-build.json',null,'ENOENT'],
 ['wrong bundle','.mobile_dist/mobile-build.json',s=>s.replace('"web/"','"frontend/"'),'MOBILE_BUNDLE_STALE_OR_WRONG_SOURCE'],
 ['stale source','web/src/main.tsx',s=>s+'\n// stale negative control\n','MOBILE_BUNDLE_STALE_OR_WRONG_SOURCE'],
 ['stale asset','.mobile_dist/preview/index.html',s=>s+'\n<!-- stale -->','MOBILE_BUNDLE_ASSET_MISMATCH'],
 ['stale native asset','android/app/src/main/assets/public/preview/index.html',s=>s+'\n<!-- stale -->','Native asset stale'],
 ['debuggable release','android/app/build.gradle',s=>s.replace('debuggable false','debuggable true'),'Release debugging'],
 ['unsafe cleartext','android/app/src/main/res/xml/network_security_config.xml',s=>s.replace('cleartextTrafficPermitted="false"','cleartextTrafficPermitted="true"'),'MOBILE_GATE_FAIL'],
 ['Android location','android/app/src/main/AndroidManifest.xml',s=>s.replace(/\s*<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"\s*\/>/,''),'Missing permission ACCESS_FINE_LOCATION'],
 ['iOS location','ios/App/App/Info.plist',s=>s.replace(/<key>NSLocationWhenInUseUsageDescription<\/key>\s*<string>[^<]*<\/string>/,''),'Missing iOS usage NSLocationWhenInUseUsageDescription'],
 ['camera usage','ios/App/App/Info.plist',s=>s.replace(/<key>NSCameraUsageDescription<\/key>\s*<string>[^<]*<\/string>/,''),'Missing iOS usage NSCameraUsageDescription'],
 ['version','android/app/build.gradle',s=>s.replace('versionCode 1','versionCode 0'),'Version code drift']
];
for(const [name,file,mutate,expected] of controls){
 const original=fs.readFileSync(file);
 let result;
 try { if(mutate) fs.writeFileSync(file,mutate(original.toString('utf8'))); else fs.unlinkSync(file); result=runGate(); }
 finally {fs.writeFileSync(file,original);}
 assert.notEqual(result.status,0,name+' did not turn red');
 assert((result.stdout+result.stderr).includes(expected),name+' failed for wrong reason: '+result.stderr);
 console.log('PASS negative control: '+name);
}
assert.equal(runGate().status,0,'Gate must recover after restoring all controls');
const calls=[];
class XHR{open(...args){calls.push(args);}}
let listener;
const sandbox={URL,Request,navigator:{},XMLHttpRequest:XHR,location:{href:'https://localhost/preview/',origin:'https://localhost',assign:url=>calls.push(url)},fetch:(...args)=>calls.push(args),SitonNativeConfig:{apiOrigin:'https://staging.example.test',linkHost:'links.example.test'},Capacitor:{isNativePlatform:()=>true,Plugins:{Share:{share:data=>{calls.push(data);return Promise.resolve({});}},App:{addListener:(_event,fn)=>{listener=fn;},getLaunchUrl:async()=>({})}}}};
vm.runInNewContext(fs.readFileSync('mobile/runtime.js','utf8'),sandbox);
assert.equal(sandbox.SitonNative.apiUrl('/api/preview/meta'),'https://staging.example.test/api/preview/meta');
assert.equal(sandbox.SitonNative.apiUrl('/preview/brand/favicon-64.png'),'/preview/brand/favicon-64.png');
assert.equal(sandbox.SitonNative.apiUrl('https://auth.example.test/auth/v1/token'),'https://auth.example.test/auth/v1/token');
sandbox.fetch('/api/test',{method:'POST',body:'{}'});
assert.equal(calls.at(-1)[0],'https://staging.example.test/api/test');
assert.equal(calls.at(-1)[1].body,'{}');
new sandbox.XMLHttpRequest().open('POST','/api/seller/deals/test/images',true);
assert.equal(calls.at(-1)[1],'https://staging.example.test/api/seller/deals/test/images');
for(const route of ['deal/id','seller','seller/new','seller/deal/id','seller/inquiries','seller/inquiries/thread','reset-password','track/id?t=opaque']){
 assert(sandbox.SitonNative.routeLink('https://links.example.test/preview/#/'+route));
 assert.equal(calls.at(-1),'/preview/#/'+route);
}
for(const bad of ['https://evil.test/preview/#/seller','http://links.example.test/preview/#/seller','https://links.example.test.evil.test/preview/#/seller','https://user@links.example.test/preview/#/seller','siton://evil/preview/#/seller','siton://app/preview/#/admin','garbage']) assert.equal(sandbox.SitonNative.routeLink(bad),false,bad);
listener({url:'siton://app/preview/#/seller'});
assert.equal(calls.at(-1),'/preview/#/seller');
console.log('PASS native transport, XHR image path, route preservation, cold/warm hook registration, hostile-link rejection');


assert(sandbox.SitonNative.routeLink('https://links.example.test/d/deal-id?ref=sample'));
assert.equal(calls.at(-1),'/preview/?ref=sample#/deal/deal-id');
sandbox.location.href='https://localhost/preview/#/seller';
const before=calls.length;
assert(sandbox.SitonNative.routeLink('siton://app/preview/#/seller'));
assert.equal(calls.length,before,'Cold launch must not reload an identical route');

const ts=require('typescript');
const helper=ts.transpileModule(fs.readFileSync('web/src/mobileUrls.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const helperExports={};
const urlContext={exports:helperExports,window:{location:{origin:'https://web.example.test'}},Capacitor:{isNativePlatform:()=>false}};
vm.runInNewContext(helper,urlContext);
assert.equal(helperExports.publicWebOrigin(),'https://web.example.test');
urlContext.Capacitor.isNativePlatform=()=>true;
urlContext.SitonNativeConfig={linkHost:'links.example.test'};
assert.equal(helperExports.publicWebOrigin(),'https://links.example.test');
urlContext.SitonNativeConfig.linkHost='app.siton.invalid';
assert.throws(()=>helperExports.publicWebOrigin(),/MOBILE_PUBLIC_HOST_NOT_CONFIGURED/);
console.log('PASS public share/auth origin boundary: web unchanged, native HTTPS, placeholders refused');

sandbox.navigator.share({title:'test',url:'https://links.example.test/d/id'});
assert.equal(calls.at(-1).url,'https://links.example.test/d/id');
console.log('PASS canonical native Share forwarding');
console.log('MOBILE_TESTS_PASS negative_controls=12 device_e2e=not_run');
