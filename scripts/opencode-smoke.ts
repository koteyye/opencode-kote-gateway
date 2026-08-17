import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = path.resolve(import.meta.dir, "..")
const opencodeVersion = process.argv[2] ?? process.env.OPENCODE_SMOKE_VERSION ?? "1.18.18"
const tempPrefix = path.join(tmpdir(), "kote-gateway-opencode-smoke-")
const temp = await mkdtemp(tempPrefix)

try {
  const tarballs = path.join(temp, "tarballs")
  const consumer = path.join(temp, "consumer")
  await Promise.all([mkdir(tarballs), mkdir(consumer)])

  await run([process.execPath, "pm", "pack", "--ignore-scripts", "--destination", tarballs, "--quiet"], root)
  const archives = (await readdir(tarballs)).filter((file) => file.endsWith(".tgz"))
  if (archives.length !== 1) throw new Error(`Expected one npm tarball, found ${archives.length}.`)

  await Bun.write(
    path.join(consumer, "package.json"),
    JSON.stringify({
      name: "kote-gateway-opencode-smoke-consumer",
      private: true,
      dependencies: {
        "@koteyye/kote-gateway-opencode": `file:${path.join(tarballs, archives[0]!)}`,
      },
    }),
  )
  await run([process.execPath, "install", "--ignore-scripts"], consumer)

  const toolFixture = path.join(consumer, "smoke-tool.txt")
  await Bun.write(toolFixture, "KOTE_SMOKE_TOOL_RESULT\n")
  const provider = createFakeProvider(toolFixture)

  try {
    const configPath = path.join(temp, "kote-gateway.json")
    await Bun.write(
      configPath,
      JSON.stringify({ version: 1, default: "direct", strict: true, providers: { smoke: "direct" } }),
    )
    const installed = path.join(consumer, "node_modules", "@koteyye", "kote-gateway-opencode")
    const isolated = path.join(temp, "opencode")
    const env = {
      ...process.env,
      // OpenCode also consults PWD on Unix; Bun.spawn's cwd does not rewrite an inherited value.
      PWD: consumer,
      XDG_DATA_HOME: path.join(isolated, "data"),
      XDG_CACHE_HOME: path.join(isolated, "cache"),
      XDG_CONFIG_HOME: path.join(isolated, "config"),
      XDG_STATE_HOME: path.join(isolated, "state"),
      OPENCODE_CONFIG_DIR: path.join(isolated, "config-dir"),
      OPENCODE_PLUGIN_META_FILE: path.join(isolated, "plugin-meta.json"),
      OPENCODE_DB: path.join(isolated, "opencode.db"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: "smoke/smoke-model",
        small_model: "smoke/smoke-model",
        plugin: [[pathToFileURL(installed).href, { configPath }]],
        provider: {
          smoke: {
            npm: "@ai-sdk/openai-compatible",
            name: "KoteGateway runtime smoke",
            options: {
              apiKey: "smoke-api-key",
              baseURL: `${provider.server.url}v1`,
              headers: { "x-kote-smoke-provider": "runtime" },
            },
            models: {
              "smoke-model": {
                name: "KoteGateway smoke model",
                limit: { context: 16_384, output: 2_048 },
              },
            },
          },
        },
      }),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      KOTE_GATEWAY_LOG_LEVEL: "debug",
    }

    const version = await run([process.execPath, "x", "--bun", `opencode-ai@${opencodeVersion}`, "--version"], consumer, env)
    if (version.stdout.trim() !== opencodeVersion) {
      throw new Error(`Expected OpenCode ${opencodeVersion}, received ${JSON.stringify(version.stdout.trim())}.`)
    }

    const smoke = await run(
      modelCommand(
        opencodeVersion,
        "KoteGateway runtime smoke",
        "KOTE_SMOKE_TOOL: read the fixture and finish the transport smoke test.",
      ),
      consumer,
      env,
      90_000,
    )
    const output = `${smoke.stdout}\n${smoke.stderr}`
    assertRuntimeEvidence(output, provider)

    const requestsBeforeBlockedRun = provider.requests.length
    await Bun.write(
      configPath,
      JSON.stringify({ version: 1, default: "invalid", strict: true, providers: { smoke: "direct" } }),
    )
    const blocked = await execute(
      modelCommand(opencodeVersion, "KoteGateway blocked smoke", "This request must be blocked before the provider."),
      consumer,
      env,
      90_000,
    )
    const blockedOutput = `${blocked.stdout}\n${blocked.stderr}`
    if (!blockedOutput.includes("KOTE_CONFIG_INVALID")) {
      throw new Error(`OpenCode did not expose the blocked KoteGateway configuration error.\n${blockedOutput}`)
    }
    if (provider.requests.length !== requestsBeforeBlockedRun) {
      throw new Error("An invalid KoteGateway configuration allowed a request to reach the provider target.")
    }

    console.log(
      `Packed package completed a streamed model/tool round trip and blocked invalid configuration through OpenCode ${opencodeVersion} (${provider.requests.length} provider requests).`,
    )
  } finally {
    provider.server.stop(true)
  }
} finally {
  await removeTemp(temp, tempPrefix)
}

type RecordedRequest = {
  readonly url: URL
  readonly headers: Headers
  readonly body: unknown
}

type FakeProvider = {
  readonly server: ReturnType<typeof Bun.serve>
  readonly requests: RecordedRequest[]
  readonly evidence: {
    sawReadTool: boolean
    sawToolResult: boolean
    streamedFrames: number
  }
}

function createFakeProvider(toolFixture: string): FakeProvider {
  const requests: RecordedRequest[] = []
  const evidence = { sawReadTool: false, sawToolResult: false, streamedFrames: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
        return Response.json({ error: { message: "Unexpected smoke endpoint." } }, { status: 404 })
      }

      const body: unknown = await request.json()
      requests.push({ url, headers: new Headers(request.headers), body })
      const serialized = JSON.stringify(body)
      const isSmokePrompt = serialized.includes("KOTE_SMOKE_TOOL")
      const sawToolResult = serialized.includes('"role":"tool"') && serialized.includes("KOTE_SMOKE_TOOL_RESULT")
      if (sawToolResult) evidence.sawToolResult = true

      const toolNames = readToolNames(body)
      if (isSmokePrompt && !sawToolResult && toolNames.includes("read")) {
        evidence.sawReadTool = true
        return streamEvents(
          [
            completionChunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_kote_gateway_smoke",
                  type: "function",
                  function: { name: "read", arguments: JSON.stringify({ filePath: toolFixture }) },
                },
              ],
            }),
            completionChunk({}, "tool_calls"),
            "[DONE]",
          ],
          evidence,
        )
      }

      return streamEvents(
        [
          completionChunk({ role: "assistant", content: "KOTE_SMOKE_" }),
          completionChunk({ content: "STREAM_OK" }),
          completionChunk({}, "stop", { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }),
          "[DONE]",
        ],
        evidence,
      )
    },
  })
  return { server, requests, evidence }
}

function readToolNames(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.tools)) return []
  return body.tools.flatMap((tool) => {
    if (!isRecord(tool) || !isRecord(tool.function) || typeof tool.function.name !== "string") return []
    return [tool.function.name]
  })
}

function completionChunk(
  delta: Readonly<Record<string, unknown>>,
  finishReason: string | null = null,
  usage?: Readonly<Record<string, number>>,
) {
  return {
    id: "chatcmpl-kote-gateway-smoke",
    object: "chat.completion.chunk",
    created: 1_787_000_000,
    model: "smoke-model",
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  }
}

function streamEvents(events: ReadonlyArray<unknown>, evidence: FakeProvider["evidence"]) {
  const encoder = new TextEncoder()
  const queue = [...events]
  return new Response(
    new ReadableStream({
      async pull(controller) {
        const event = queue.shift()
        if (event === undefined) {
          controller.close()
          return
        }
        evidence.streamedFrames += 1
        controller.enqueue(encoder.encode(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`))
        await Bun.sleep(2)
      },
    }),
    {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream",
        connection: "keep-alive",
      },
    },
  )
}

function assertRuntimeEvidence(output: string, provider: FakeProvider) {
  if (!output.includes("KoteGateway plugin initialized.")) {
    throw new Error(`OpenCode did not report successful KoteGateway initialization.\n${output}`)
  }
  if (!output.includes("KoteGateway selected a provider route.")) {
    throw new Error(`OpenCode did not expose the chat.headers route decision at debug level.\n${output}`)
  }
  if (!output.includes("KOTE_SMOKE_STREAM_OK")) {
    throw new Error(`OpenCode did not emit the streamed fake-provider response.\n${output}`)
  }
  if (!provider.evidence.sawReadTool || !provider.evidence.sawToolResult) {
    throw new Error("OpenCode did not complete the fake provider's read tool-call round trip.")
  }
  if (provider.evidence.streamedFrames < 7) {
    throw new Error(`Expected multiple SSE frames, observed ${provider.evidence.streamedFrames}.`)
  }
  if (provider.requests.length < 2) {
    throw new Error(`Expected at least two provider requests, observed ${provider.requests.length}.`)
  }

  provider.requests.forEach((request) => {
    if (request.headers.has("x-kote-route-token")) {
      throw new Error("The private KoteGateway route marker reached the provider target.")
    }
    if (request.headers.get("x-kote-smoke-provider") !== "runtime") {
      throw new Error("OpenCode/provider headers were not preserved through the fetch interceptor.")
    }
    if (request.headers.get("authorization") !== "Bearer smoke-api-key") {
      throw new Error("The fake provider did not receive its expected isolated smoke credential.")
    }
  })
}

function modelCommand(opencodeVersion: string, title: string, prompt: string) {
  return [
    process.execPath,
    "x",
    "--bun",
    `opencode-ai@${opencodeVersion}`,
    "--print-logs",
    "--log-level",
    "DEBUG",
    "run",
    "--format",
    "json",
    "--model",
    "smoke/smoke-model",
    "--title",
    title,
    prompt,
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function run(command: string[], cwd: string, env = process.env, timeoutMs = 60_000) {
  const result = await execute(command, cwd, env, timeoutMs)
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with ${result.exitCode}.\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

async function execute(command: string[], cwd: string, env = process.env, timeoutMs = 60_000) {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => child.kill(), timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timeout)
  return { stdout, stderr, exitCode }
}

async function removeTemp(directory: string, prefix: string) {
  const resolved = path.resolve(directory)
  if (!resolved.startsWith(path.resolve(prefix))) {
    throw new Error(`Refusing to remove unexpected smoke directory: ${resolved}`)
  }
  await rm(resolved, { recursive: true, force: true })
}
