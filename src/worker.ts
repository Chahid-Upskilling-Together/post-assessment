import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";
import { bundlerOptions } from "./bundler-options";
import { ensureSeeded } from "./store";

async function run(): Promise<void> {
  ensureSeeded();
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });
  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: "juniper-waitlist",
    workflowsPath: require.resolve("./workflows"),
    bundlerOptions,
    activities,
  });
  console.log("Worker is polling the juniper-waitlist task queue.");
  await worker.run();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

