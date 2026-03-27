const fs = require('fs');
const acorn = require('acorn');
const code = fs.readFileSync('frontend/main.js', 'utf8');
const ast = acorn.parse(code, { sourceType: 'module', ecmaVersion: 'latest', locations: true });

function walk(node, scope) {
  if (!node || typeof node !== 'object') return;
  let newScope = scope;
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    newScope = scope.slice();
    if (node.params) {
      node.params.forEach((param) => {
        if (param.type === 'Identifier') newScope.push(param.name);
      });
    }
  }
  if (node.type === 'VariableDeclaration' && node.kind === 'const') {
    newScope = scope.slice();
    node.declarations.forEach((decl) => {
      if (decl.id.type === 'Identifier') newScope.push(decl.id.name);
    });
  }
  if (node.type === 'AssignmentExpression' && node.left && node.left.type === 'Identifier') {
    if (scope.includes(node.left.name)) {
      console.log('const reassign found', node.left.name, 'line', node.loc.start.line, 'code', code.split('\n')[node.loc.start.line - 1].trim());
    }
  }
  if (node.type === 'UpdateExpression' && node.argument && node.argument.type === 'Identifier') {
    if (scope.includes(node.argument.name)) {
      console.log('const update found', node.argument.name, 'line', node.loc.start.line, 'code', code.split('\n')[node.loc.start.line - 1].trim());
    }
  }

  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      child.forEach(c => walk(c, newScope));
    } else if (child && typeof child === 'object') {
      walk(child, newScope);
    }
  }
}

walk(ast, []);
