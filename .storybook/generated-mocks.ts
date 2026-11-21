import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { Plugin } from 'vite';

const MODEL_ID = '#lib/model/model.js';
const MODEL_STUB = '\0sable-model-stub';
const RPC_SHAPES = 'virtual:rpc-shapes';
const RPC_SHAPES_ID = '\0rpc-shapes';
const root = new URL('../', import.meta.url);
const modelSource = fileURLToPath(new URL('src/lib/model/model.ts', root));
const modelOverrides = fileURLToPath(new URL('.storybook/model-2-stub.ts', root));
const protocolSource = fileURLToPath(new URL('src/generated/protocol.ts', root));

export interface RpcShapes {
  methods: Record<string, Shape>;
  defs: Record<string, Shape>;
}

export type Shape =
  | { kind: 'string' | 'number' | 'boolean' | 'null' | 'unknown' }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'union' | 'tuple'; of: Shape[] }
  | { kind: 'array' | 'record'; of: Shape }
  | { kind: 'object'; fields: Record<string, Shape> }
  | { kind: 'ref'; id: string };

function modelStub(): string {
  const names = [
    ...readFileSync(modelSource, 'utf8').matchAll(
      /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm
    ),
  ].map((match) => match[1]);
  return [
    `import * as overrides from ${JSON.stringify(modelOverrides)};`,
    'function stub() { return undefined; }',
    ...names.map(
      (name) => `export const ${name} = '${name}' in overrides ? overrides.${name} : stub;`
    ),
  ].join('\n');
}

function rpcShapes(): RpcShapes {
  const program = ts.createProgram([protocolSource], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(protocolSource);
  const methodsAlias = source?.statements.find(
    (node): node is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) && node.name.text === 'RpcMethods'
  );
  if (!source || !methodsAlias)
    throw new Error('RpcMethods is missing from the generated protocol');
  const anchor: ts.Node = methodsAlias;

  const defs: Record<string, Shape> = {};

  function shapeOf(type: ts.Type): Shape {
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      return { kind: 'literal', value: checker.typeToString(type) === 'true' };
    }
    if (type.isStringLiteral() || type.isNumberLiteral())
      return { kind: 'literal', value: type.value };
    if (type.flags & ts.TypeFlags.StringLike) return { kind: 'string' };
    if (type.flags & ts.TypeFlags.NumberLike) return { kind: 'number' };
    if (type.flags & ts.TypeFlags.BooleanLike) return { kind: 'boolean' };
    if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
      return { kind: 'null' };
    }
    if (type.isUnion()) {
      const members = type.types.map(shapeOf);
      const literals = members.filter((member) => member.kind === 'literal');
      const booleans = literals.filter((member) => typeof member.value === 'boolean');
      if (booleans.length === 2 && members.length === 2) return { kind: 'boolean' };
      return { kind: 'union', of: members };
    }
    if (checker.isTupleType(type)) {
      return { kind: 'tuple', of: checker.getTypeArguments(type as ts.TypeReference).map(shapeOf) };
    }
    if (checker.isArrayType(type)) {
      return { kind: 'array', of: shapeOf(checker.getTypeArguments(type as ts.TypeReference)[0]) };
    }
    if (type.flags & ts.TypeFlags.Object) {
      const index = checker.getIndexInfoOfType(type, ts.IndexKind.String);
      if (index && checker.getPropertiesOfType(type).length === 0) {
        return { kind: 'record', of: shapeOf(index.type) };
      }
      const id = String((type as ts.Type & { id: number }).id);
      if (!(id in defs)) {
        const fields: Record<string, Shape> = {};
        defs[id] = { kind: 'object', fields };
        for (const property of checker.getPropertiesOfType(type)) {
          fields[property.name] = shapeOf(checker.getTypeOfSymbolAtLocation(property, anchor));
        }
      }
      return { kind: 'ref', id };
    }
    return { kind: 'unknown' };
  }

  const methods: Record<string, Shape> = {};
  const table = checker.getTypeAtLocation(methodsAlias.name);
  for (const method of checker.getPropertiesOfType(table)) {
    const signature = checker.getTypeOfSymbolAtLocation(method, anchor).getCallSignatures()[0] as
      | ts.Signature
      | undefined;
    const result = signature && checker.getAwaitedType(signature.getReturnType());
    methods[method.name] = result ? shapeOf(result) : { kind: 'unknown' };
  }
  return { methods, defs };
}

export function generatedMocks(): Plugin {
  return {
    name: 'sable-generated-mocks',
    enforce: 'pre',
    resolveId(id) {
      if (id === MODEL_ID) return MODEL_STUB;
      if (id === RPC_SHAPES) return RPC_SHAPES_ID;
      return null;
    },
    load(id) {
      if (id === MODEL_STUB) {
        this.addWatchFile(modelSource);
        return modelStub();
      }
      if (id === RPC_SHAPES_ID) {
        this.addWatchFile(protocolSource);
        return `export default ${JSON.stringify(rpcShapes())};`;
      }
      return null;
    },
  };
}
