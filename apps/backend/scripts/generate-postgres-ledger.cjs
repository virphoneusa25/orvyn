const ts=require('typescript'),fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),input=path.join(root,'src/billing/CreditLedger.ts'),output=path.join(root,'src/billing/PostgresCreditLedger.ts');
const source=ts.createSourceFile(input,fs.readFileSync(input,'utf8').replace(/\r\n/g,'\n'),ts.ScriptTarget.Latest,true),f=ts.factory,printer=ts.createPrinter({newLine:ts.NewLineKind.LineFeed});
const original=source.statements.find(n=>ts.isClassDeclaration(n)&&n.name.text==='CreditLedger');
const excluded=new Set(['close','tx','migrateV1']),sync=new Set(['onAutoRecharge']);
const methods=new Set(original.members.filter(ts.isMethodDeclaration).map(n=>n.name.text).filter(n=>!excluded.has(n)&&!sync.has(n)));
let method;
const isPrivate=n=>n.modifiers?.some(m=>m.kind===ts.SyntaxKind.PrivateKeyword);
function hasAwait(node){let found=false;function walk(n){if(ts.isAwaitExpression(n))found=true;ts.forEachChild(n,walk);}walk(node);return found;}
const result=ts.transform(source,[context=>{
  const transaction=body=>f.createBlock([f.createReturnStatement(f.createCallExpression(f.createPropertyAccessExpression(f.createPropertyAccessExpression(f.createThis(),'db'),'transaction'),undefined,[f.createArrowFunction([f.createModifier(ts.SyntaxKind.AsyncKeyword)],undefined,[],undefined,f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),body)]))],true);
  function visit(node){
    if(method==='maybeAutoRecharge'&&ts.isForOfStatement(node))return f.createExpressionStatement(f.createCallExpression(f.createPropertyAccessExpression(f.createPropertyAccessExpression(f.createThis(),'db'),'afterCommit'),undefined,[f.createArrowFunction(undefined,undefined,[],undefined,f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),f.createBlock([node],true))]));
    let updated=ts.visitEachChild(node,visit,context);
    if(ts.isArrowFunction(updated)&&hasAwait(updated.body)){
      if(method==='reserveImage'&&ts.isReturnStatement(node.parent))updated=f.updateArrowFunction(updated,[f.createModifier(ts.SyntaxKind.AsyncKeyword)],updated.typeParameters,updated.parameters,undefined,updated.equalsGreaterThanToken,transaction(updated.body));
      else updated=f.updateArrowFunction(updated,[f.createModifier(ts.SyntaxKind.AsyncKeyword)],updated.typeParameters,updated.parameters,updated.type,updated.equalsGreaterThanToken,updated.body);
    }
    if(ts.isCallExpression(updated)&&ts.isPropertyAccessExpression(updated.expression)){
      let receiver=updated.expression.expression,name=updated.expression.name.text;
      if(receiver.kind===ts.SyntaxKind.ThisKeyword&&name==='tx'){
        updated=f.updateCallExpression(updated,f.createPropertyAccessExpression(f.createPropertyAccessExpression(f.createThis(),'db'),'transaction'),updated.typeArguments,updated.arguments);
        return f.createParenthesizedExpression(f.createAwaitExpression(updated));
      }
      if(name==='map'&&updated.arguments.some(a=>ts.isArrowFunction(a)&&a.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)))return f.createParenthesizedExpression(f.createAwaitExpression(f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier('Promise'),'all'),undefined,[updated])));
      if(receiver.kind===ts.SyntaxKind.ThisKeyword&&methods.has(name)||['get','all','run'].includes(name)&&receiver.getText?.(source)?.includes('this.db'))return f.createParenthesizedExpression(f.createAwaitExpression(updated));
    }
    return updated;
  }
  return node=>{
    const members=[f.createConstructorDeclaration([f.createModifier(ts.SyntaxKind.PrivateKeyword)],[f.createParameterDeclaration([f.createModifier(ts.SyntaxKind.PrivateKeyword)],undefined,'db',undefined,f.createTypeReferenceNode('PostgresBillingDatabase'))],f.createBlock([])),...original.members.flatMap(n=>{
      if(ts.isConstructorDeclaration(n)||ts.isPropertyDeclaration(n)&&['db','inTx'].includes(n.name.text))return [];
      if(!ts.isMethodDeclaration(n))return [n];
      if(excluded.has(n.name.text))return [];
      if(sync.has(n.name.text))return [n];
      method=n.name.text;let body=ts.visitNode(n.body,visit);if(!isPrivate(n))body=transaction(body);
      let type=n.type?f.createTypeReferenceNode('Promise',[n.type]):undefined;
      if(method==='reserveImage')type=ts.createSourceFile('type.ts','type T=Promise<()=>Promise<void>>',ts.ScriptTarget.Latest,true).statements[0].type;
      return [f.updateMethodDeclaration(n,[...(n.modifiers||[]),f.createModifier(ts.SyntaxKind.AsyncKeyword)],n.asteriskToken,n.name,n.questionToken,n.typeParameters,n.parameters,type,body)];
    })];
    const statements=source.statements.filter(n=>n!==original&&!(ts.isClassDeclaration(n)&&n.name.text==='BillingLimitError')&&!(ts.isImportDeclaration(n)&&['node:sqlite','fs','path'].includes(n.moduleSpecifier.text)));
    const generated=f.updateClassDeclaration(original,original.modifiers,'PostgresCreditLedger',undefined,[f.createHeritageClause(ts.SyntaxKind.ImplementsKeyword,[f.createExpressionWithTypeArguments(f.createIdentifier('AsyncLedgerContract'),undefined)])],members);
    const helper=ts.createSourceFile('helper.ts','class Helper {static fromDatabase(database:PostgresBillingDatabase):PostgresCreditLedger{return new PostgresCreditLedger(database);}}',ts.ScriptTarget.Latest,true);
    let text='// Generated by scripts/generate-postgres-ledger.cjs from CreditLedger.ts; do not edit.\nimport {PostgresBillingDatabase} from "./PostgresBillingDatabase";\nimport {BillingLimitError} from "./CreditLedger";\nexport {BillingLimitError} from "./CreditLedger";\nimport type {CreditLedger} from "./CreditLedger";\ntype OriginalContract=Omit<CreditLedger,"close"|"onAutoRecharge"|"reserveImage">;\ntype AsyncLedgerContract={[K in keyof OriginalContract]:OriginalContract[K] extends (...args:infer A)=>infer R ? (...args:A)=>Promise<R>:never};\n'+statements.map(n=>printer.printNode(ts.EmitHint.Unspecified,n,source)).join('\n')+'\n'+printer.printNode(ts.EmitHint.Unspecified,generated,source);
    text=text.replace(/\}\s*$/,helper.statements[0].members.map(n=>printer.printNode(ts.EmitHint.Unspecified,n,helper)).join('\n')+'\n}\n');
    if(process.argv.includes('--check')){if(!fs.existsSync(output)||fs.readFileSync(output,'utf8').replace(/\r\n/g,'\n')!==text)throw new Error('PostgresCreditLedger is stale; run generate-postgres-ledger.cjs');}else fs.writeFileSync(output,text);
    return node;
  };
}]);result.dispose();

