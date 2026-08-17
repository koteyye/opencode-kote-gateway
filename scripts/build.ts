import { rm } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
await rm(path.join(root, "dist"), { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: [path.join(root, "src", "server.ts"), path.join(root, "src", "core", "index.ts")],
  outdir: path.join(root, "dist"),
  root: path.join(root, "src"),
  target: "bun",
  format: "esm",
  sourcemap: "external",
  packages: "external",
})

if (!result.success) {
  result.logs.forEach((message) => console.error(message))
  process.exit(1)
}

const types = Bun.spawnSync([process.execPath, "x", "tsc", "-p", "tsconfig.build.json"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
})
if (types.exitCode !== 0) process.exit(types.exitCode)
