// The part of the WebAssembly API that phone-mcp.mts uses. Node has the
// whole API, but its declarations live in TypeScript's DOM library, which the
// tools leave out (they are not browser code).
declare namespace WebAssembly {
  class Module {
    static imports(module: Module): { module: string; name: string; kind: string }[]
  }
  class Memory {
    readonly buffer: ArrayBuffer
  }
  interface Instance {
    readonly exports: Record<string, unknown>
  }
  type ImportValue = ((...args: any[]) => unknown) | Memory | number
  type ModuleImports = Record<string, ImportValue>
  type Imports = Record<string, ModuleImports>
  function compile(bytes: Uint8Array | ArrayBuffer): Promise<Module>
  function instantiate(module: Module, imports?: Imports): Promise<Instance>
}
