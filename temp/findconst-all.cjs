const fs=require('fs');
const acorn=require('acorn');
const path=require('path');
function checkFile(file){
  const code=fs.readFileSync(file,'utf8');
  let ast;
  try{ ast=acorn.parse(code,{sourceType:'module',ecmaVersion:'latest',locations:true}); }
  catch(e){ return null; }
  const violations=[];
  function walk(node,scope){
    if(!node||typeof node!=='object') return;
    let sc=scope;
    if(['Program','FunctionDeclaration','FunctionExpression','ArrowFunctionExpression','BlockStatement'].includes(node.type)){
      sc={consts:new Set(),parent:scope};
    }
    if(node.type==='VariableDeclaration' && node.kind==='const'){
      for(const decl of node.declarations){
        if(decl.id && decl.id.type==='Identifier') sc.consts.add(decl.id.name);
      }
    }
    if(node.type==='AssignmentExpression' && node.left && node.left.type==='Identifier'){
      let s=sc;
      while(s){
        if(s.consts.has(node.left.name)){
          violations.push({name:node.left.name,line:node.loc.start.line,code:code.split('\n')[node.loc.start.line-1].trim()});
          break;
        }
        s=s.parent;
      }
    }
    if(node.type==='UpdateExpression' && node.argument && node.argument.type==='Identifier'){
      let s=sc;
      while(s){
        if(s.consts.has(node.argument.name)){
          violations.push({name:node.argument.name,line:node.loc.start.line,code:code.split('\n')[node.loc.start.line-1].trim()});
          break;
        }
        s=s.parent;
      }
    }
    for(const key of Object.keys(node)){
      if(['loc','start','end','range'].includes(key)) continue;
      const child=node[key];
      if(Array.isArray(child)) child.forEach(c=>walk(c,sc));
      else if(child && typeof child==='object') walk(child,sc);
    }
  }
  walk(ast,{consts:new Set(),parent:null});
  return violations;
}
function walkDir(dir){
  const entries=fs.readdirSync(dir,{withFileTypes:true});
  let results=[];
  for(const entry of entries){
    if(entry.name==='node_modules'||entry.name==='dist') continue;
    const full=path.join(dir,entry.name);
    if(entry.isDirectory()) results=results.concat(walkDir(full));
    else if(full.endsWith('.js')){
      const v=checkFile(full);
      if(v&&v.length) results.push({file:full,violations:v});
    }
  }
  return results;
}
const res=walkDir(process.cwd());
fs.writeFileSync('findconst-all-output.json', JSON.stringify(res,null,2));
console.log('done',res.length);