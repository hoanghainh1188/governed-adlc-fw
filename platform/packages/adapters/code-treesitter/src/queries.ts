// The Tree-sitter queries of the index format `tree-sitter-1` (task X06, design/ADR-M108 §2.3).
// Capture names: `def.<kind>` (a definition), `ref.<kind>` (a use), `import` (a module name).
// When several patterns capture the same node, the earlier pattern wins (a definition before a
// type reference). A change here that changes what is stored is a new index format.

/** Imports and calls shared by TypeScript, TSX and JavaScript. */
const SCRIPT_COMMON = `
(program (lexical_declaration (variable_declarator name: (identifier) @def.variable
  value: [(arrow_function) (function_expression) (class)])))
(program (export_statement declaration: (lexical_declaration (variable_declarator
  name: (identifier) @def.variable value: [(arrow_function) (function_expression) (class)]))))
(function_declaration name: (identifier) @def.function)
(generator_function_declaration name: (identifier) @def.function)
(method_definition name: (property_identifier) @def.method)
(new_expression constructor: (identifier) @ref.new)
(call_expression function: (identifier) @ref.call)
(call_expression function: (member_expression property: (property_identifier) @ref.call))
(import_statement source: (string (string_fragment) @import))
(export_statement source: (string (string_fragment) @import))
(call_expression function: (identifier) @_require
  arguments: (arguments . (string (string_fragment) @import)) (#eq? @_require "require"))
(call_expression function: (import) arguments: (arguments . (string (string_fragment) @import)))
`;

const TYPESCRIPT = `
(class_declaration name: (type_identifier) @def.class)
(abstract_class_declaration name: (type_identifier) @def.class)
(interface_declaration name: (type_identifier) @def.interface)
(type_alias_declaration name: (type_identifier) @def.type)
(enum_declaration name: (identifier) @def.enum)
(method_signature name: (property_identifier) @def.method)
(abstract_method_signature name: (property_identifier) @def.method)
${SCRIPT_COMMON}
(type_identifier) @ref.type_ref
`;

const JAVASCRIPT = `
(class_declaration name: (identifier) @def.class)
${SCRIPT_COMMON}
`;

const PYTHON = `
(class_definition name: (identifier) @def.class)
(class_definition body: (block (function_definition name: (identifier) @def.method)))
(class_definition body: (block (decorated_definition
  definition: (function_definition name: (identifier) @def.method))))
(module (function_definition name: (identifier) @def.function))
(module (decorated_definition definition: (function_definition name: (identifier) @def.function)))
(module (decorated_definition definition: (class_definition name: (identifier) @def.class)))
(call function: (identifier) @ref.call)
(call function: (attribute attribute: (identifier) @ref.call))
(import_statement name: (dotted_name) @import)
(import_statement name: (aliased_import name: (dotted_name) @import))
(import_from_statement module_name: (dotted_name) @import)
(import_from_statement module_name: (relative_import) @import)
`;

const JAVA = `
(class_declaration name: (identifier) @def.class)
(record_declaration name: (identifier) @def.class)
(interface_declaration name: (identifier) @def.interface)
(enum_declaration name: (identifier) @def.enum)
(method_declaration name: (identifier) @def.method)
(constructor_declaration name: (identifier) @def.method)
(method_invocation name: (identifier) @ref.call)
(object_creation_expression type: (type_identifier) @ref.new)
(type_identifier) @ref.type_ref
(import_declaration (scoped_identifier) @import)
`;

const GO = `
(type_spec name: (type_identifier) @def.class type: (struct_type))
(type_spec name: (type_identifier) @def.interface type: (interface_type))
(type_spec name: (type_identifier) @def.type)
(function_declaration name: (identifier) @def.function)
(method_declaration name: (field_identifier) @def.method)
(call_expression function: (identifier) @ref.call)
(call_expression function: (selector_expression field: (field_identifier) @ref.call))
(type_identifier) @ref.type_ref
(import_spec path: (interpreted_string_literal) @import)
`;

/** The grammar file of `@vscode/tree-sitter-wasm` and the query of each grammar. */
export const GRAMMARS = {
  typescript: { wasm: 'tree-sitter-typescript.wasm', query: TYPESCRIPT },
  tsx: { wasm: 'tree-sitter-tsx.wasm', query: TYPESCRIPT },
  javascript: { wasm: 'tree-sitter-javascript.wasm', query: JAVASCRIPT },
  python: { wasm: 'tree-sitter-python.wasm', query: PYTHON },
  java: { wasm: 'tree-sitter-java.wasm', query: JAVA },
  go: { wasm: 'tree-sitter-go.wasm', query: GO },
} as const;

export type GrammarName = keyof typeof GRAMMARS;
