// Generate the asynchronous backend from the existing behavior, avoiding two independently
// maintained implementations of password, token, tenant and portal security rules.
const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
for (const config of [
  { directory:'auth', file:'AuthService', name:'AuthService', singleton:'authService', excluded:['migrateLegal','migratePortal','migrateAccountSecurity','migrateVerification','migrateSessionOrg','close'] },
  { directory:'admin', file:'staffStore', name:'StaffStore', singleton:'staffStore', excluded:[] },
  { directory:'onboarding', file:'OnboardingStore', name:'OnboardingStore', singleton:'onboardingStore', excluded:['close'] },
]) {
const input = path.join(root, `src/${config.directory}/${config.file}.ts`);
const generatedName = `Postgres${config.name}`;
const output = path.join(root, `src/${config.directory}/${generatedName}.ts`);
const source = ts.createSourceFile(input, fs.readFileSync(input, 'utf8').replace(/\r\n/g,'\n'), ts.ScriptTarget.Latest, true);
const f = ts.factory;
const original = source.statements.find(node => ts.isClassDeclaration(node) && node.name.text === config.name);
const excluded = new Set(config.excluded);
const methods = new Set(original.members.filter(ts.isMethodDeclaration).map(node => node.name.text).filter(name => !excluded.has(name)));
const isPrivate = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword);
const promise = type => type ? f.createTypeReferenceNode('Promise', [type]) : undefined;
const result = ts.transform(source, [context => {
  let method;
  function visit(node) {
    if (ts.isNewExpression(node) && method === 'login' && node.expression.getText(source) === 'Error' &&
        node.arguments?.[0]?.text === 'Invalid email or password') {
      return f.updateNewExpression(node, f.createIdentifier('LoginRejected'), node.typeArguments, node.arguments);
    }
    const updated = ts.visitEachChild(node, visit, context);
    if (ts.isCallExpression(updated) && ts.isPropertyAccessExpression(updated.expression)) {
      const receiver = updated.expression.expression;
      const name = updated.expression.name.text;
      const local = receiver.kind === ts.SyntaxKind.ThisKeyword && methods.has(name);
      const database = ['get','all','run'].includes(name) && receiver.getText?.(source)?.includes('this.db');
      if (local || database) return f.createParenthesizedExpression(f.createAwaitExpression(updated));
    }
    return updated;
  }
  return rootNode => {
  const members = [
    f.createConstructorDeclaration([f.createModifier(ts.SyntaxKind.PrivateKeyword)], [
      f.createParameterDeclaration([f.createModifier(ts.SyntaxKind.PrivateKeyword)], undefined, 'db', undefined, f.createTypeReferenceNode('PostgresAuthDatabase')),
    ], f.createBlock([])),
    ...original.members.flatMap(node => {
      if (ts.isConstructorDeclaration(node) || (ts.isPropertyDeclaration(node) && node.name.text === 'db')) return [];
      if (!ts.isMethodDeclaration(node)) return [node];
      if (excluded.has(node.name.text)) return [];
      method = node.name.text;
      let body = ts.visitNode(node.body, visit);
      if (!isPrivate(node)) body = f.createBlock([f.createReturnStatement(f.createCallExpression(
        f.createPropertyAccessExpression(f.createPropertyAccessExpression(f.createThis(), 'db'), 'transaction'), undefined,
        [f.createArrowFunction([f.createModifier(ts.SyntaxKind.AsyncKeyword)], undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), body)]))], true);
      return [f.updateMethodDeclaration(node, [...(node.modifiers || []), f.createModifier(ts.SyntaxKind.AsyncKeyword)], node.asteriskToken,
        node.name, node.questionToken, node.typeParameters, node.parameters, promise(node.type), body)];
    }),
  ];
  const extra = ts.createSourceFile('extra.ts', `
    static fromDatabase(database:PostgresAuthDatabase):${generatedName} { return new ${generatedName}(database); }
    static async connect(url:string):Promise<${generatedName}> {
      const service = ${generatedName}.fromDatabase(await PostgresAuthDatabase.connect(url));
      ${config.name === 'StaffStore' ? 'try { await service.seedFromEnv(); } catch(error) { await service.close(); throw error; }' : ''}
      return service;
    }
    async close():Promise<void> { await this.db.close(); }
  `, ts.ScriptTarget.Latest, true);
  // Parse methods in a class so the compiler owns their syntax and types.
  const helper = ts.createSourceFile('helper.ts', 'class Helper {' + extra.text + '}', ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter({ newLine:ts.NewLineKind.LineFeed });
  const statements = source.statements.filter(node => {
    if (node === original) return false;
    if (ts.isImportDeclaration(node) && ['node:sqlite','node:fs','node:path','path','fs','../persistence/LocalStore'].includes(node.moduleSpecifier.text)) return false;
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ['SCHEMA',config.singleton,'shared'].includes(declaration.name.text))) return false;
    if (ts.isFunctionDeclaration(node) && node.name?.text === config.singleton) return false;
    return true;
  });
  let text = `// Generated by scripts/generate-postgres-auth.cjs from ${config.file}.ts; do not edit.\n` +
    `import { PostgresAuthDatabase, LoginRejected } from "${config.directory === 'auth' ? './' : '../auth/'}PostgresAuthDatabase";\n` +
    `import type { ${config.name} } from "./${config.file}";\n` +
    `type OriginalContract = Omit<${config.name}, "db">;\n` +
    'type AsyncAuthContract = { [K in keyof OriginalContract]: OriginalContract[K] extends (...args:infer A)=>infer R ? (...args:A)=>Promise<R> : never };\n';
  text += statements.map(node => printer.printNode(ts.EmitHint.Unspecified, node, source)).join('\n') + '\n';
  const generated = f.updateClassDeclaration(original, original.modifiers, generatedName, original.typeParameters,
    [f.createHeritageClause(ts.SyntaxKind.ImplementsKeyword, [f.createExpressionWithTypeArguments(f.createIdentifier('AsyncAuthContract'), undefined)])], members);
  text += printer.printNode(ts.EmitHint.Unspecified, generated, source);
  // Print helper methods against their own source to preserve literal positions.
  text = text.replace(/\}\s*$/, helper.statements[0].members.map(node => printer.printNode(ts.EmitHint.Unspecified, node, helper)).join('\n') + '\n}\n');
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(output) || fs.readFileSync(output,'utf8').replace(/\r\n/g,'\n') !== text) throw new Error(`${generatedName} is stale; run generate-postgres-auth.cjs`);
  } else fs.writeFileSync(output, text);
  return rootNode;
  };
}]);
result.dispose();
}
