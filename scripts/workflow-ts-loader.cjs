// Compiles the Workflow's TypeScript for Temporal's bundler using the
// TypeScript compiler. Temporal's default is swc, whose native binary can fail
// to load when npm skips install scripts (newer npm versions do); the
// TypeScript compiler is plain JavaScript, so it works on every machine.
const ts = require("typescript");

module.exports = function workflowTsLoader(source) {
  const { outputText, sourceMapText } = ts.transpileModule(source, {
    fileName: this.resourcePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      sourceMap: true,
      inlineSources: true,
    },
  });
  this.callback(null, outputText.replace(/\/\/# sourceMappingURL=.*\s*$/, ""), sourceMapText);
};
