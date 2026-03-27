const fs=require('fs');
const acorn=require('acorn');
for(const path of ['frontend/charts.js','frontend/main.js']){
  const code=fs.readFileSync(path,'utf8');
  const ast=acorn.parse(code,{sourceType:'module', ecmaVersion:'latest', locations:true});
  const violations=[];

  function walk(node,scope){
    if(!node || typeof node !== 'object') return;
    let current=scope;
    if(['Program','FunctionDeclaration','FunctionExpression','ArrowFunctionExpression','BlockStatement'].includes(node.type)){
      current={consts:new Set(),parent:scope};
    }
    if(node.type === 'VariableDeclaration' && node.kind === 'const'){
      for(const decl of node.declarations){
        if(decl.id && decl.id.type === 'Identifier') current.consts.add(decl.id.name);
      }
    }
    if(node.type === 'AssignmentExpression' && node.left && node.left.type === 'Identifier'){
      let s=current;
      while(s){
        if(s.consts.has(node.left.name)){
          violations.push({name:node.left.name, line:node.loc.start.line, code: code.split('\n')[node.loc.start.line-1].trim()});
          break;
        }
        s=s.parent;
      }
    }
    if(node.type === 'UpdateExpression' && node.argument && node.argument.type === 'Identifier'){
      let s=current;
      while(s){
        if(s.consts.has(node.argument.name)){
          violations.push({name:node.argument.name, line:node.loc.start.line, code: code.split('\n')[node.loc.start.line-1].trim()});
          break;
        }
        s=s.parent;
      }
    }

    for(const key of Object.keys(node)){
      if(['loc','start','end','range'].includes(key)) continue;
      const child=node[key];
      if(Array.isArray(child)){
        for(const c of child){ walk(c,current); }
      } else if(child && typeof child==='object'){
        walk(child,current);
      }
    }
  }

  walk(ast,{consts:new Set(),parent:null});
  console.log('file',path,'violations',violations.length);
  console.log(violations);
}
