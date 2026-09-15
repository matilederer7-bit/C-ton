// Small TypeScript AST helpers for semantic static gates.
//
// Gates that used to grep for an exact expression shape (and broke on a
// harmless refactor) use these instead: they ask about declarations,
// identifiers and literal values, never about whitespace or line layout.
const fs = require("node:fs");
const ts = require("typescript");

function parse(filePath, source = fs.readFileSync(filePath, "utf8")) {
  const kind = /\.tsx$/.test(filePath) ? ts.ScriptKind.TSX : /\.tsx?$/.test(filePath) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, kind);
}

function walk(node, visitor) {
  const stop = visitor(node);
  if (stop === true) return;
  ts.forEachChild(node, (child) => walk(child, visitor));
}

function collect(root, predicate) {
  const out = [];
  walk(root, (node) => { if (predicate(node)) out.push(node); });
  return out;
}

/** Every identifier / property name / string-literal text inside a node. */
function namesIn(node) {
  const names = new Set();
  walk(node, (child) => {
    if (ts.isIdentifier(child) || ts.isPrivateIdentifier(child)) names.add(child.text);
    else if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) names.add(child.text);
    else if (ts.isTemplateExpression(child)) {
      for (const token of [child.head.text, ...child.templateSpans.map((span) => span.literal.text)].join(" ").matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) names.add(token[0]);
    }
  });
  return names;
}

function findFunction(sourceFile, name) {
  return collect(sourceFile, (node) =>
    (ts.isFunctionDeclaration(node) && node.name && node.name.text === name) ||
    (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
  )[0] || null;
}

function findVariable(sourceFile, name) {
  return collect(sourceFile, (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
}

function isExported(declaration) {
  let node = declaration;
  while (node && !ts.isSourceFile(node)) {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (modifiers && modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return true;
    node = node.parent;
  }
  return false;
}

function exportedVariables(sourceFile, name) {
  return findVariable(sourceFile, name).filter(isExported);
}

function numericLiteralValue(node) {
  if (!node) return null;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
  return null;
}

function stringLiteralValue(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

function findTypeAlias(sourceFile, name) {
  return collect(sourceFile, (node) => ts.isTypeAliasDeclaration(node) && node.name.text === name)[0] || null;
}

/** String literal members of a union type alias, or null when not a pure literal union. */
function unionStringMembers(typeAlias) {
  if (!typeAlias) return null;
  const type = typeAlias.type;
  const members = ts.isUnionTypeNode(type) ? type.types : [type];
  const out = [];
  for (const member of members) {
    if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) out.push(member.literal.text);
    else return null;
  }
  return out;
}

/** Property assignments `name: <expr>` anywhere in the file. */
function propertyAssignments(sourceFile, propertyName) {
  return collect(sourceFile, (node) => ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === propertyName);
}

function callExpressions(root, calleeName) {
  return collect(root, (node) => ts.isCallExpression(node) && ((ts.isIdentifier(node.expression) && node.expression.text === calleeName) || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === calleeName)));
}

/** Source text with comments removed (string contents preserved). */
function stripComments(source, fileName = "file.ts") {
  const result = ts.transpileModule(source, { fileName, compilerOptions: { removeComments: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve } });
  return result.outputText;
}

function text(node, sourceFile) {
  return node.getText(sourceFile);
}

module.exports = { ts, parse, walk, collect, namesIn, findFunction, findVariable, exportedVariables, isExported, numericLiteralValue, stringLiteralValue, findTypeAlias, unionStringMembers, propertyAssignments, callExpressions, stripComments, text };
