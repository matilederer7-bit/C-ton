const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {parseStringPromise}=require('xml2js');
const plist=require('plist');
const {loadConfig}=require('@capacitor/cli/dist/config');
const {verifyBundle,hash}=require('./mobile_bundle_contract.cjs');
const read=p=>fs.readFileSync(p,'utf8');
async function gate() {
  assert(fs.existsSync('capacitor.config.ts'),'Capacitor config missing');
  const config=(await loadConfig()).app.extConfig;
  assert.equal(config.webDir,'.mobile_dist');
  assert.equal(config.server.appStartPath,'/preview/');
  assert(!config.server.url,'Hosted runtime override forbidden');
  assert.equal(config.server.cleartext,false);
  assert.deepEqual(config.server.allowNavigation,[]);
  assert.equal(config.android.allowMixedContent,false);
  assert.notEqual(config.android.webContentsDebuggingEnabled,true);
  const bundle=verifyBundle('.mobile_dist');
  for(const dir of ['android/app/src/main/assets','ios/App/App']) {
    const native=JSON.parse(read(dir+'/capacitor.config.json'));
    assert.equal(native.appId,config.appId);
    assert.deepEqual(native.server,config.server,'Native config stale');
    assert.deepEqual(native.android,config.android,'Native Android settings stale');
    assert.deepEqual(native.plugins,config.plugins,'Native plugins stale');
    assert.deepEqual(JSON.parse(read(dir+'/public/mobile-build.json')),bundle,'Native manifest stale');
    for(const [file,digest] of Object.entries(bundle.files)) assert.equal(hash(fs.readFileSync(path.join(dir,'public',file))),digest,'Native asset stale: '+file);
    assert(!fs.existsSync(dir+'/public/app'),'Legacy runtime remains in native assets');
  }
  const xml=await parseStringPromise(read('android/app/src/main/AndroidManifest.xml'));
  const app=xml.manifest.application[0];
  assert.equal(app.$['android:allowBackup'],'false');
  assert.equal(app.$['android:usesCleartextTraffic'],'false');
  assert.notEqual(app.$['android:debuggable'],'true');
  const permissions=xml.manifest['uses-permission'].map(p=>p.$['android:name']);
  for(const p of ['INTERNET','CAMERA','ACCESS_COARSE_LOCATION','ACCESS_FINE_LOCATION']) assert(permissions.includes('android.permission.'+p),'Missing permission '+p);
  for(const p of permissions) assert(!/BACKGROUND_LOCATION|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|READ_MEDIA/.test(p),'Unnecessary broad permission');
  const activity=app.activity[0];
  assert.equal(activity.$['android:exported'],'true');
  assert(activity['intent-filter'].some(f=>f.$?.['android:autoVerify']==='true' && f.data?.some(d=>d.$['android:pathPrefix']==='/preview/' && d.$['android:host']==='${sitonAppLinkHost}')));
  for(const provider of app.provider||[]) assert.equal(provider.$['android:exported'],'false');
  const paths=(await parseStringPromise(read('android/app/src/main/res/xml/file_paths.xml'))).paths;
  assert(!paths['external-path'] && !paths['root-path'],'Broad file provider exposure');
  const network=(await parseStringPromise(read('android/app/src/main/res/xml/network_security_config.xml')))['network-security-config'];
  assert.equal(network['base-config'][0].$.cleartextTrafficPermitted,'false');
  assert(!network['domain-config'] && !network['debug-overrides'],'Unreviewed network override');
  const info=plist.parse(read('ios/App/App/Info.plist'));
  for(const key of ['NSLocationWhenInUseUsageDescription','NSCameraUsageDescription','NSPhotoLibraryUsageDescription']) assert(typeof info[key]==='string' && info[key].trim(),'Missing iOS usage '+key);
  assert(!info.NSAppTransportSecurity,'Unreviewed ATS exception');
  assert.equal(info.CFBundleVersion,'$(CURRENT_PROJECT_VERSION)');
  const ent=plist.parse(read('ios/App/App/App.entitlements'));
  assert(ent['com.apple.developer.associated-domains'].includes('applinks:$(SITON_APP_LINK_HOST)'));
  const gradle=read('android/app/build.gradle');
  assert(/versionCode\s+1\b/.test(gradle),'Version code drift (update reviewed release metadata)');
  assert(/versionName\s+"1.0"/.test(gradle),'Version name drift');
  assert(/release\s*\{\s*debuggable false/.test(gradle),'Release debugging must be explicitly disabled');
  assert(!/debuggable\s*(?:=\s*)?true|signingConfig\s+signingConfigs.debug/.test(gradle),'Unsafe release config');
  const project=read('ios/App/App.xcodeproj/project.pbxproj');
  assert.equal((project.match(/CURRENT_PROJECT_VERSION = 1;/g)||[]).length,2,'iOS build number drift');
  assert.equal((project.match(/MARKETING_VERSION = 1.0;/g)||[]).length,2,'iOS version drift');
  for(const file of ['android/gradlew','android/gradlew.bat','android/gradle/wrapper/gradle-wrapper.jar','ios/App/CapApp-SPM/Package.swift']) assert(fs.existsSync(file),file+' missing');
  assert(!/path:\s*"[^"\n]*\\/.test(read('ios/App/CapApp-SPM/Package.swift')),'SwiftPM Windows path');
  for(const [file] of Object.entries(bundle.files)) {
    if(!/\.(?:js|html|json|css)$/.test(file)) continue;
    const text=read('.mobile_dist/'+file);
    assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk_live_|sb_secret_)[A-Za-z0-9_-]+|AKIA[A-Z0-9]{16}/.test(text),'Secret pattern in '+file);
  }
  if(process.argv.includes('--release')) {
    assert(!bundle.placeholder_configuration,'Release endpoints not configured');
    assert(!/staging|onrender|localhost|127\.0\.0\.1/i.test(bundle.api_origin),'Staging endpoint in production release');
    assert(!config.appId.endsWith('.preview'),'Release identifier is placeholder');
  }
  console.log('MOBILE_GATE_PASS canonical hashes, synced assets, parsed permissions/security, versions, bundled secret patterns; device behavior NOT certified');
}
module.exports={gate};
if(require.main===module) gate().catch(e=>{console.error('MOBILE_GATE_FAIL '+e.message);process.exitCode=1;});
