import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageRoot, '..', '..');
const applications = ['work-app', 'pet-app'].map((name) => {
  const root = path.join(repositoryRoot, 'packages', name);
  return { name, root, sourceRoot: path.join(root, 'src') };
});

function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) files.push(...filesUnder(absolute));
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry)) files.push(absolute);
  }
  return files;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function isNodePathSpecifier(value) {
  return value === 'node:path' || value === 'path';
}

function requireSpecifier(node) {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'require') {
    return null;
  }
  const argument = node.arguments[0];
  return argument && ts.isStringLiteralLike(argument) ? argument.text : null;
}

function collectFileFacts(source) {
  const constants = new Map();
  const pathNamespaces = new Set();
  const pathFunctions = new Set();
  const declarations = [];

  const collect = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (isNodePathSpecifier(node.moduleSpecifier.text) && node.importClause) {
        if (node.importClause.name) pathNamespaces.add(node.importClause.name.text);
        const bindings = node.importClause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) pathNamespaces.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            if (imported === 'join' || imported === 'resolve') pathFunctions.add(element.name.text);
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      declarations.push(node);
      if (ts.isIdentifier(node.name)) constants.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const { initializer, name } = declaration;
      const required = requireSpecifier(initializer);
      if (required && isNodePathSpecifier(required)) {
        if (ts.isIdentifier(name) && !pathNamespaces.has(name.text)) {
          pathNamespaces.add(name.text);
          changed = true;
        } else if (ts.isObjectBindingPattern(name)) {
          for (const element of name.elements) {
            const imported = element.propertyName?.getText(source) ?? element.name.getText(source);
            const local = element.name.getText(source);
            if ((imported === 'join' || imported === 'resolve') && !pathFunctions.has(local)) {
              pathFunctions.add(local);
              changed = true;
            }
          }
        }
      }
      if (!ts.isIdentifier(name)) continue;
      if (ts.isIdentifier(initializer) && pathNamespaces.has(initializer.text) && !pathNamespaces.has(name.text)) {
        pathNamespaces.add(name.text);
        changed = true;
      }
      if (
        ts.isPropertyAccessExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        pathNamespaces.has(initializer.expression.text) &&
        (initializer.name.text === 'join' || initializer.name.text === 'resolve') &&
        !pathFunctions.has(name.text)
      ) {
        pathFunctions.add(name.text);
        changed = true;
      }
    }
  }
  return { constants, pathNamespaces, pathFunctions };
}

function staticText(node, constants, seen = new Set()) {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return staticText(node.expression, constants, seen);
  }
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      value += staticText(span.expression, constants, new Set(seen)) ?? '';
      value += span.literal.text;
    }
    return value;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left, constants, new Set(seen));
    const right = staticText(node.right, constants, new Set(seen));
    return left === null && right === null ? null : `${left ?? ''}${right ?? ''}`;
  }
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    const initializer = constants.get(node.text);
    if (!initializer) return null;
    seen.add(node.text);
    return staticText(initializer, constants, seen);
  }
  return null;
}

function moduleSpecifier(node, constants) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    return ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
  }
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return null;
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
  if (!isDynamicImport && !isRequire) return null;
  return staticText(node.arguments[0], constants);
}

function packageImportViolation(specifier) {
  if (specifier === 'mocode-ai' || specifier.startsWith('mocode-ai/')) {
    return 'Electron applications must use @mocode/runtime instead of mocode-ai internals';
  }
  if (specifier === '@mocode/runtime' || specifier === '@mocode/runtime/host') return null;
  if (specifier.startsWith('@mocode/runtime/')) return 'non-exported @mocode/runtime subpath';

  const protocolExports = new Set([
    '@mocode/protocol',
    '@mocode/protocol/host',
    '@mocode/protocol/persistence',
    '@mocode/protocol/runtime',
  ]);
  if (protocolExports.has(specifier)) return null;
  if (specifier.startsWith('@mocode/protocol/')) return 'non-exported @mocode/protocol subpath';
  if (/^@mocode\/[^/]+\/(?:src|dist)(?:\/|$)/.test(specifier)) return 'package internal src/dist import';
  return null;
}

function suspiciousFilesystemPath(value) {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.includes('mocode-agent-host.js')) return 'fixed filesystem path to mocode-agent-host';
  if (normalized.includes('..') && /(?:^|\/)(?:src|dist)(?:\/|$)/.test(normalized)) {
    return 'filesystem coupling to another package src/dist layout';
  }
  return null;
}

function pathConstructionViolation(node, facts) {
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
    const first = node.arguments?.[0];
    return first ? suspiciousFilesystemPath(staticText(first, facts.constants) ?? '') : null;
  }
  if (!ts.isCallExpression(node)) return null;

  let isPathCall = false;
  if (ts.isIdentifier(node.expression)) isPathCall = facts.pathFunctions.has(node.expression.text);
  if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
    const owner = node.expression.expression.text;
    const method = node.expression.name.text;
    isPathCall = facts.pathNamespaces.has(owner) && (method === 'join' || method === 'resolve');
  }
  if (!isPathCall) return null;

  const combined = node.arguments
    .map((argument) => staticText(argument, facts.constants))
    .filter((value) => value !== null)
    .join('/');
  return suspiciousFilesystemPath(combined);
}

const violations = [];
for (const application of applications) {
  for (const file of filesUnder(application.sourceRoot)) {
    const text = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
    const facts = collectFileFacts(source);
    const report = (node, reason, detail) => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${path.relative(repositoryRoot, file)}:${line + 1}: ${reason}: ${detail}`);
    };

    const visit = (node) => {
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateExpression(node) ||
        (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
      ) {
        const literalReason = suspiciousFilesystemPath(staticText(node, facts.constants) ?? '');
        if (literalReason) report(node, literalReason, node.getText(source));
      }

      const specifier = moduleSpecifier(node, facts.constants);
      if (specifier) {
        if (path.isAbsolute(specifier)) {
          report(node, 'absolute module import', specifier);
        } else if (specifier.startsWith('.')) {
          const target = path.resolve(path.dirname(file), specifier);
          if (!isWithin(application.root, target))
            report(node, 'relative import escapes application package', specifier);
        } else {
          const reason = packageImportViolation(specifier);
          if (reason) report(node, reason, specifier);
        }
      }

      const pathReason = pathConstructionViolation(node, facts);
      if (pathReason) report(node, pathReason, node.getText(source));
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

if (violations.length) {
  console.error(`Electron package boundary violations:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Electron package boundary check passed.');
}
