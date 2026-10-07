import type { WorkerOptions } from "@temporalio/worker";

type BundlerOptions = NonNullable<WorkerOptions["bundlerOptions"]>;

// Bundle Workflow code with the TypeScript compiler instead of swc's native
// binary, which may be missing when npm skips install scripts.
export const bundlerOptions: BundlerOptions = {
  webpackConfigHook: (config) => {
    for (const rule of config.module?.rules ?? []) {
      if (rule && typeof rule === "object" && JSON.stringify(rule.use ?? "").includes("swc-loader")) {
        rule.use = { loader: require.resolve("../scripts/workflow-ts-loader.cjs") };
      }
    }
    return config;
  },
};
