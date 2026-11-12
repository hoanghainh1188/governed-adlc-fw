// X06 (design/ADR-M108 §2.1, §2.3): the Tree-sitter extractor finds the definitions, references
// and imports of each language of the first index format, keeps the lines of the file (also in a
// Vue file), and stops a parse that runs past its time limit.
import { TreeSitterExtractor, vueScript } from '@sdlc/adapter-code-treesitter';
import type { CodeSymbol, ExtractedCode } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

const extractor = new TreeSitterExtractor();

async function run(language: Parameters<typeof extractor.extract>[0], source: string) {
  const result = await extractor.extract(language, source, 5_000);
  if ('skipped' in result) throw new Error('unexpected skip');
  return result;
}

const defs = (r: ExtractedCode) =>
  r.symbols.filter((s) => s.role === 'def').map((s) => `${s.kind}:${s.name}@${s.line}`);
const refs = (r: ExtractedCode) =>
  r.symbols.filter((s) => s.role === 'ref').map((s) => `${s.kind}:${s.name}`);

describe('X06: languageOf (ADR-M108 §2.3)', () => {
  it('maps the extensions of the first format and nothing else', () => {
    expect(extractor.languageOf('src/a.ts')).toBe('typescript');
    expect(extractor.languageOf('src/a.mts')).toBe('typescript');
    expect(extractor.languageOf('src/a.tsx')).toBe('tsx');
    expect(extractor.languageOf('src/a.jsx')).toBe('javascript');
    expect(extractor.languageOf('src/a.cjs')).toBe('javascript');
    expect(extractor.languageOf('web/App.vue')).toBe('vue');
    expect(extractor.languageOf('app/models.py')).toBe('python');
    expect(extractor.languageOf('src/Main.java')).toBe('java');
    expect(extractor.languageOf('cmd/main.go')).toBe('go');
    expect(extractor.languageOf('README.md')).toBeUndefined();
    expect(extractor.languageOf('Makefile')).toBeUndefined();
    expect(extractor.languageOf('dir.ts/Makefile')).toBeUndefined();
  });
});

describe('X06: TypeScript', () => {
  const source = [
    "import { Repo } from './repo.js';",
    "export { x } from '../x';",
    'export interface Order { id: string }',
    'export type Id = string;',
    'export enum Status { Open }',
    'export abstract class Base {}',
    'export class OrderService extends Base implements Svc {',
    '  constructor(private readonly repo: Repo) { super(); }',
    '  find(id: Id): Order { return this.repo.load(id); }',
    '}',
    'export function create(): OrderService { return new OrderService(new Repo()); }',
    'export const handler = async () => create();',
    'const notAFunction = 1;',
    "const lazy = await import('./lazy');",
    "const fs = require('node:fs');",
  ].join('\n');

  it('finds the definitions with their lines', async () => {
    const result = await run('typescript', source);
    expect(defs(result)).toEqual([
      'interface:Order@3',
      'type:Id@4',
      'enum:Status@5',
      'class:Base@6',
      'class:OrderService@7',
      'method:constructor@8',
      'method:find@9',
      'function:create@11',
      'variable:handler@12',
    ]);
  });

  it('finds calls, `new` and type references', async () => {
    const result = await run('typescript', source);
    expect(refs(result)).toEqual(
      expect.arrayContaining([
        'call:load',
        'new:OrderService',
        'new:Repo',
        'call:create',
        'type_ref:Repo',
        'type_ref:Order',
        'type_ref:Svc',
      ]),
    );
    // A definition name is never also a type reference.
    expect(refs(result)).not.toContain('type_ref:OrderService@7');
  });

  it('lists each module once, also re-exports, dynamic imports and require', async () => {
    const result = await run('typescript', source);
    expect(result.imports).toEqual(['./repo.js', '../x', './lazy', 'node:fs']);
  });
});

describe('X06: TSX and JavaScript', () => {
  it('reads a TSX component', async () => {
    const result = await run(
      'tsx',
      "import React from 'react';\nexport function App(): JSX.Element { return <Card title={format()} />; }",
    );
    expect(defs(result)).toEqual(['function:App@2']);
    expect(refs(result)).toContain('call:format');
    expect(result.imports).toEqual(['react']);
  });

  it('reads JavaScript with JSX and classes', async () => {
    const result = await run(
      'javascript',
      "const { a } = require('./a');\nclass Cart { add(item) { return a(item); } }\nexport const total = function () {};",
    );
    expect(defs(result)).toEqual(['class:Cart@2', 'method:add@2', 'variable:total@3']);
    expect(refs(result)).toEqual(['call:require', 'call:a']);
    expect(result.imports).toEqual(['./a']);
  });
});

describe('X06: Vue (ADR-M108 §2.3)', () => {
  const vue = [
    '<template>',
    '  <div>{{ total }}</div>',
    '</template>',
    '<script setup lang="ts">',
    "import { useCart } from './cart';",
    'function total(): number { return useCart().sum(); }',
    '</script>',
  ].join('\n');

  it('parses the script block as TypeScript and keeps the lines of the file', async () => {
    const result = await run('vue', vue);
    expect(defs(result)).toEqual(['function:total@6']);
    expect(refs(result)).toEqual(expect.arrayContaining(['call:useCart', 'call:sum']));
    expect(result.imports).toEqual(['./cart']);
  });

  it('blanks everything outside the script blocks, new lines kept', () => {
    const { grammar, source } = vueScript(vue);
    expect(grammar).toBe('typescript');
    expect(source.split('\n')).toHaveLength(vue.split('\n').length);
    expect(source).not.toContain('template');
    expect(vueScript('<script>let a = 1</script>').grammar).toBe('javascript');
  });
});

describe('X06: Python', () => {
  it('finds classes, methods, module functions, calls and imports', async () => {
    const result = await run(
      'python',
      [
        'import os',
        'import numpy as np',
        'from .models import Order',
        'from . import util',
        'class OrderService:',
        '    @staticmethod',
        '    def find(id):',
        '        return Order.get(id)',
        'def main():',
        '    def inner(): pass',
        '    OrderService.find(1)',
      ].join('\n'),
    );
    expect(defs(result)).toEqual(['class:OrderService@5', 'method:find@7', 'function:main@9']);
    expect(refs(result)).toEqual(['call:get', 'call:find']);
    expect(result.imports).toEqual(['os', 'numpy', '.models', '.']);
  });
});

describe('X06: Java', () => {
  it('finds types, methods, calls, `new` and imports', async () => {
    const result = await run(
      'java',
      [
        'package shop;',
        'import java.util.List;',
        'public class OrderService implements Service {',
        '  public OrderService() {}',
        '  public List<Order> find() { return repo.load(new Query()); }',
        '}',
        'interface Service {}',
        'enum Status { OPEN }',
        'record Item(String id) {}',
      ].join('\n'),
    );
    expect(defs(result)).toEqual([
      'class:OrderService@3',
      'method:OrderService@4',
      'method:find@5',
      'interface:Service@7',
      'enum:Status@8',
      'class:Item@9',
    ]);
    expect(refs(result)).toEqual(
      expect.arrayContaining(['type_ref:Service', 'type_ref:Order', 'call:load', 'new:Query']),
    );
    expect(refs(result)).not.toContain('type_ref:Query');
    expect(result.imports).toEqual(['java.util.List']);
  });
});

describe('X06: Go', () => {
  it('finds structs, interfaces, functions, methods, calls and imports', async () => {
    const result = await run(
      'go',
      [
        'package main',
        'import (',
        '  "fmt"',
        '  "example.com/shop/orders"',
        ')',
        'type Order struct { ID string }',
        'type Store interface { Load() Order }',
        'type ID string',
        'func (s *Service) Find() Order { return orders.Load() }',
        'func main() { fmt.Println(1) }',
      ].join('\n'),
    );
    expect(defs(result)).toEqual([
      'class:Order@6',
      'interface:Store@7',
      'type:ID@8',
      'method:Find@9',
      'function:main@10',
    ]);
    expect(refs(result)).toEqual(
      expect.arrayContaining(['type_ref:Order', 'type_ref:Service', 'call:Load', 'call:Println']),
    );
    expect(result.imports).toEqual(['fmt', 'example.com/shop/orders']);
  });
});

describe('X06: limits and broken files (ADR-M108 §2.6)', () => {
  it('drops control characters from names and modules', async () => {
    const result = await run('javascript', "require('./a\u0007b');\nfunction ok() {}");
    expect(result.imports).toEqual(['./ab']);
    // eslint-disable-next-line no-control-regex
    expect(JSON.stringify(result)).not.toMatch(/[\u0000-\u001f]/);
  });

  it('reads a Vue script whose attribute holds `>`', async () => {
    const vue =
      '<script setup lang="ts" generic="T extends Array<string>">\nfunction pick(): T {}\n</script>';
    const result = await run('vue', vue);
    expect(defs(result)).toEqual(['function:pick@2']);
  });

  it('keeps what it can read of a file with syntax errors', async () => {
    const result = await run(
      'typescript',
      'function ok() {}\nclass {{{ broken\nfunction alsoOk() {}',
    );
    expect(defs(result)).toContain('function:ok@1');
  });

  it('stops a parse that runs past its time limit', async () => {
    const huge = 'const a = [' + '['.repeat(20_000) + '1' + ']'.repeat(20_000) + '];\n';
    const result = await extractor.extract('typescript', huge.repeat(50), 1);
    expect(result).toEqual({ skipped: 'parse_timeout' });
  });

  it('cuts very long names', async () => {
    const name = 'x'.repeat(1000);
    const result = await run('typescript', `function ${name}() {}`);
    const symbol = result.symbols[0] as CodeSymbol;
    expect(symbol.name).toHaveLength(256);
  });
});
