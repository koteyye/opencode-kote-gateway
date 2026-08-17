import { expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import https from "node:https"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { ROUTE_HEADER, registerPluginInstance, type AdapterClient } from "../../src/opencode/index.js"

it("proves real direct, HTTPS CONNECT, and gateway-down no-fallback paths", async () => {
  const tempPrefix = path.join(tmpdir(), "kote-connect-integration-")
  const temp = await mkdtemp(tempPrefix)
  const originalFetch = globalThis.fetch
  const certificate = await createCertificate(temp)
  const targetRequests: Array<Readonly<{ authorization?: string; proxyProof?: string; routeToken?: string }>> = []
  const connectRequests: Array<Readonly<{ authority: string; proxyProof?: string; authorization?: string }>> = []
  const target = https.createServer(certificate, (request, response) => {
    targetRequests.push({
      ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
      ...(typeof request.headers["x-kote-proxy-proof"] === "string"
        ? { proxyProof: request.headers["x-kote-proxy-proof"] }
        : {}),
      ...(typeof request.headers[ROUTE_HEADER] === "string" ? { routeToken: request.headers[ROUTE_HEADER] } : {}),
    })
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ tunneled: true }))
  })
  await listen(target)
  const targetPort = port(target)
  const proxy = https.createServer(certificate)
  proxy.on("connect", (request, client, head) => {
    connectRequests.push({
      authority: request.url ?? "",
      ...(typeof request.headers["x-kote-proxy-proof"] === "string"
        ? { proxyProof: request.headers["x-kote-proxy-proof"] }
        : {}),
      ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
    })
    if (request.url !== `127.0.0.1:${targetPort}`) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n")
      return
    }
    const upstream = net.connect({ host: "127.0.0.1", port: targetPort }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.byteLength > 0) upstream.write(head)
      client.pipe(upstream)
      upstream.pipe(client)
    })
    upstream.on("error", () => client.destroy())
    client.on("error", () => upstream.destroy())
  })
  await listen(proxy)

  const gateway = { url: `https://127.0.0.1:${port(proxy)}` }
  const client = fakeClient(gateway)
  const registration = registerPluginInstance({ instanceID: "real-https-connect" })
  registration.activate(client)
  try {
    const directToken = registration.issueRoute("synthetic-direct", "direct", `https://127.0.0.1:${targetPort}`)
    const direct = await globalThis.fetch(`https://127.0.0.1:${targetPort}/direct`, {
      headers: {
        authorization: "Synthetic direct credential",
        [ROUTE_HEADER]: directToken,
      },
      tls: { rejectUnauthorized: false },
    })

    expect(direct.status).toBe(200)
    expect(connectRequests).toHaveLength(0)
    expect(targetRequests).toEqual([{ authorization: "Synthetic direct credential" }])

    const token = registration.issueRoute("synthetic-connect", "proxy", `https://127.0.0.1:${targetPort}`)
    const response = await globalThis.fetch(`https://127.0.0.1:${targetPort}/responses`, {
      headers: {
        authorization: "Synthetic provider credential",
        [ROUTE_HEADER]: token,
      },
      tls: { rejectUnauthorized: false },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tunneled: true })
    expect(connectRequests).toEqual([
      { authority: `127.0.0.1:${targetPort}`, proxyProof: "gateway-only" },
    ])
    expect(targetRequests).toEqual([
      { authorization: "Synthetic direct credential" },
      { authorization: "Synthetic provider credential" },
    ])

    gateway.url = `https://127.0.0.1:${await closedPort()}`
    const failedToken = registration.issueRoute("synthetic-down", "proxy", `https://127.0.0.1:${targetPort}`)
    const failure = await globalThis
      .fetch(`https://127.0.0.1:${targetPort}/must-not-arrive`, {
        headers: { [ROUTE_HEADER]: failedToken },
        tls: { rejectUnauthorized: false },
      })
      .catch((cause: unknown) => cause)

    expect(failure).toMatchObject({ code: "KOTE_PROXY_REQUEST_FAILED" })
    expect(connectRequests).toHaveLength(1)
    expect(targetRequests).toHaveLength(2)
  } finally {
    registration.dispose()
    globalThis.fetch = originalFetch
    await Promise.all([close(proxy), close(target)])
    await removeTemp(temp, tempPrefix)
  }
})

function fakeClient(gateway: { url: string }): AdapterClient {
  return {
    resolveRoute: () => "proxy",
    resolveProviderByOrigin: () => undefined,
    getGateway: () =>
      Promise.resolve({
        proxyUrl: gateway.url,
        proxyHeaders: { "x-kote-proxy-proof": "gateway-only" },
      }),
    invalidateGateway() {},
  }
}

async function createCertificate(directory: string) {
  const openssl = [
    Bun.which("openssl"),
    ...(process.platform === "win32" ? ["C:\\Program Files\\Git\\usr\\bin\\openssl.exe"] : []),
  ].find((candidate): candidate is string => candidate !== null && Bun.file(candidate).size > 0)
  if (!openssl) throw new Error("OpenSSL is required for the local HTTPS CONNECT integration test.")

  const key = path.join(directory, "localhost-key.pem")
  const cert = path.join(directory, "localhost-cert.pem")
  const child = Bun.spawn(
    [
      openssl,
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdout: "ignore", stderr: "pipe" },
  )
  const stderr = new Response(child.stderr).text()
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`OpenSSL exited with ${exitCode}: ${await stderr}`)
  return { key: await Bun.file(key).text(), cert: await Bun.file(cert).text() }
}

async function listen(server: ReturnType<typeof https.createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
}

async function close(server: ReturnType<typeof https.createServer>) {
  if (!server.listening) return
  const closing = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  server.closeAllConnections()
  await closing
}

async function closedPort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const result = port(server)
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return result
}

function port(server: ReturnType<typeof https.createServer> | ReturnType<typeof net.createServer>) {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a server TCP address.")
  return address.port
}

async function removeTemp(directory: string, prefix: string) {
  const resolved = path.resolve(directory)
  if (!resolved.startsWith(path.resolve(prefix))) {
    throw new Error(`Refusing to remove unexpected CONNECT test directory: ${resolved}`)
  }
  await rm(resolved, { recursive: true, force: true })
}
