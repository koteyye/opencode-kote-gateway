import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const required = ["dist/server.js", "dist/server.d.ts", "dist/core/index.js", "dist/core/index.d.ts"]
const missing = required.filter((file) => !Bun.file(path.join(root, file)).size)
if (missing.length) throw new Error(`Package build is incomplete: ${missing.join(", ")}`)

const output = await Promise.all(required.filter((file) => file.endsWith(".js")).map((file) => Bun.file(path.join(root, file)).text()))
if (output.some((source) => source.includes("workspace:") || source.includes("packages/opencode/src"))) {
  throw new Error("Package output contains an unresolved workspace dependency or OpenCode internal path")
}

const server = await import(`${new URL("../dist/server.js", import.meta.url).href}?smoke=${Date.now()}`)
if (!server.default || typeof server.default !== "object" || typeof server.default.server !== "function") {
  throw new Error("The server entrypoint must default-export a PluginModule with server()")
}

const consumer = Bun.spawnSync(
  [process.execPath, "x", "tsc", "-p", path.join(root, "tests", "package-consumer", "tsconfig.json")],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
)
if (consumer.exitCode !== 0) throw new Error("The public package types failed a NodeNext consumer typecheck.")

console.log("Package entrypoints, standalone output, and NodeNext public types passed the smoke check.")
