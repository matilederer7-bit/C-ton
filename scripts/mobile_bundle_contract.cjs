const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function files(dir) {
  return fs.readdirSync(dir, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en')).flatMap(e => {
    const p = path.join(dir,e.name);
    return e.isDirectory() ? files(p) : [p.replaceAll('\\','/')];
  });
}
function sourceHash() {
  const paths = ['web/src','web/public','mobile'].flatMap(files).concat(['web/index.html','web/vite.config.ts','web/package.json','web/package-lock.json','scripts/build_mobile_bundle.cjs','capacitor.config.ts']).sort();
  return hash(paths.map(p=>p+'\0'+hash(fs.readFileSync(p))).join('\n'));
}
function inventory(dir) { return Object.fromEntries(files(dir).filter(p=>!p.endsWith('/mobile-build.json')).map(p=>[path.relative(dir,p).replaceAll('\\','/'),hash(fs.readFileSync(p))])); }
function verifyBundle(dir) {
  const m=JSON.parse(fs.readFileSync(path.join(dir,'mobile-build.json'),'utf8'));
  if(m.schema_version!==2 || m.source!=='web/' || m.source_sha256!==sourceHash()) throw Error('MOBILE_BUNDLE_STALE_OR_WRONG_SOURCE');
  if(JSON.stringify(m.files)!==JSON.stringify(inventory(dir))) throw Error('MOBILE_BUNDLE_ASSET_MISMATCH');
  return m;
}
module.exports={hash,files,sourceHash,inventory,verifyBundle};
