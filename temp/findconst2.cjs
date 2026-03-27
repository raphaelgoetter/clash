const fs = require('fs');
const acorn = require('acorn');
const code = fs.readFileSync('frontend/main.js', 'utf8');
const ast = acorn.parse(code, { sourceType: 'module', ecmaVersion: 'latest', locations: true });

function walk(node, scopeChain) {
  if (!node || typeof node !== 'object') return;
  let scope = scopeChain;

  const enterFunction = node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
  if (enterFunction || node.type === 'BlockStatement' || node.type === 'Program') {
    scope = { consts: new Set(), parent: scopeChain };
  }

  if (enterFunction && node.params) {
    node.params.forEach((param) => {
      if (param.type === 'Identifier') {
        // parameters are mutable, not const
      }
    });
  }

  if (node.type === 'VariableDeclaration' && node.kind === 'const') {
    node.declarations.forEach((decl) => {
      if (decl.id.type === 'Identifier') {
        scope.consts.add(decl.id.name);
      }
      // pattern support can be added if needed
    });
  }

  const checkAssignment = (name, loc) => {
    let s = scope;
    while (s) {
      if (s.consts.has(name)) {
        console.log('const reassign found', name, 'line', loc.start.line, 'code', code.split('\n')[loc.start.line - 1].trim());
        break;
      }
      s = s.parent;
    }
  };

  if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
    checkAssignment(node.left.name, node.loc);
  }
  if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') {
    checkAssignment(node.argument.name, node.loc);
  }

  for (const key in node) {
    if (['loc', 'start', 'end', 'range'].includes(key)) continue;
    const child = node[key];
    if (Array.isArray(child)) {
      child.forEach(c => walk(c, scope));
    } else if (child && typeof child === 'object') {
      walk(child, scope);
    }
  }
}

walk(ast, { consts: new Set(), parent: null });
