const fs=require('fs'),ts=require('typescript'),path=require('path');
const HEB=/[֐-׿]/;
const file=process.argv[2], prefix=process.argv[3];
const src=fs.readFileSync(file,'utf8');
const sf=ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
const snake=(s)=>s.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'');
function insideFunction(n){for(let p=n.parent;p;p=p.parent){if(ts.isFunctionDeclaration(p)||ts.isFunctionExpression(p)||ts.isArrowFunction(p)||ts.isMethodDeclaration(p))return true;if(ts.isSourceFile(p))return false;}return false;}
function pathOf(node){const parts=[];for(let p=node.parent;p;p=p.parent){
  if(ts.isPropertyAssignment(p)&&p.name)parts.unshift(snake(p.name.getText().replace(/['"]/g,'')));
  else if(ts.isVariableDeclaration(p)){parts.unshift(snake(p.name.getText()));break;}}return parts;}
const edits=[],seed={},used=new Set(),owners=new Set();
function visit(n){
  if((ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n))&&HEB.test(n.text)&&!insideFunction(n)){
    const parts=pathOf(n);
    for(let p=n.parent;p;p=p.parent){if(ts.isVariableDeclaration(p)){owners.add(p.name.getText());break;}}
    let base=[prefix,...parts].filter(Boolean).join('.');
    let key=base,i=2;while(used.has(key))key=base+'_'+(i++);
    used.add(key);seed[key]=n.text;
    edits.push({start:n.getStart(sf),end:n.getEnd(),text:JSON.stringify(key)});
  }
  ts.forEachChild(n,(c)=>{visit(c);});
}
ts.forEachChild(sf,(n)=>{visit(n);});
if(!edits.length){console.log(file,'-> nothing');process.exit(0);}
edits.sort((a,b)=>b.start-a.start);
let out=src;for(const e of edits)out=out.slice(0,e.start)+e.text+out.slice(e.end);
fs.writeFileSync(file,out);
const sp=path.resolve(__dirname,'seed.he.json');
const existing=JSON.parse(fs.readFileSync(sp,'utf8'));
fs.writeFileSync(sp,JSON.stringify({...existing,...seed},null,2));
console.log(file,'->',Object.keys(seed).length,'keys; holders:',[...owners].join(', '));
