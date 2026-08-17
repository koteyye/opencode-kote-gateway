import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const files = [...new Bun.Glob("{src,tests,scripts}/**/*.{ts,tsx,js,mjs}").scanSync({ cwd: root, absolute: true })]
const failures = files.flatMap((file) => {
  const source = Bun.file(file).text()
  return [
    source.then((text) =>
      /(?:from\s+|import\s*\(|require\s*\()\s*["'][^"']*(?:opencode[/\\]packages[/\\]|@opencode-ai[/\\](?:core|server)|packages[/\\]opencode[/\\]src)/.test(
        text,
      )
        ? `${path.relative(root, file)} imports an OpenCode internal path`
        : undefined,
    ),
    source.then((text) =>
      /(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,})/.test(text)
        ? `${path.relative(root, file)} contains secret-like material`
        : undefined,
    ),
  ]
})

const messages = (await Promise.all(failures)).filter((message): message is string => message !== undefined)
if (messages.length) {
  messages.forEach((message) => console.error(message))
  process.exit(1)
}

console.log(`Audited ${files.length} source files: no internal OpenCode imports or secret-like material found.`)
