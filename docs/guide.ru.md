# KoteGateway для OpenCode: установка, настройка и проверка

Это руководство описывает установку и ручную проверку npm-пакета
[`@koteye/kote-gateway-opencode`](https://www.npmjs.com/package/@koteye/kote-gateway-opencode).
Плагин выбирает маршрут для HTTP-трафика провайдера по точному `providerID`:

- `direct` — штатное соединение OpenCode с провайдером;
- `proxy` — HTTPS-соединение через KoteGateway с методом `CONNECT`;
- при ошибке KoteGateway запрос в режиме `proxy` завершается без автоматической попытки `direct`.

Плагин не заменяет провайдеры, не хранит OAuth-токены или API-ключи и не добавляет интерфейс в OpenCode.

## Содержание

1. [Требования и границы совместимости](#требования-и-границы-совместимости)
2. [Установка из npm](#установка-из-npm)
3. [Создание routing-конфигурации](#создание-routing-конфигурации)
4. [Как выбирается маршрут](#как-выбирается-маршрут)
5. [Авторизация и OpenAI OAuth](#авторизация-и-openai-oauth)
6. [Проверка режима Direct](#проверка-режима-direct)
7. [Проверка режима Proxy](#проверка-режима-proxy)
8. [Проверка fail-closed](#проверка-fail-closed)
9. [Автономная проверка без AI-аккаунта](#автономная-проверка-без-ai-аккаунта)
10. [Bootstrap и кэш](#bootstrap-и-кэш)
11. [Логи и диагностика](#логи-и-диагностика)
12. [Обновление и удаление](#обновление-и-удаление)
13. [Контрольный список](#контрольный-список)

## Требования и границы совместимости

Для версии пакета `0.1.0` поддерживается следующий диапазон:

| Компонент | Требование |
| --- | --- |
| OpenCode | `1.18.5`–`1.18.18` включительно |
| Bun | `1.3.14` или новее |
| ОС | Windows, Linux или macOS |

Проверить версии:

```powershell
bun --version
opencode --version
```

Если версия установленного OpenCode ниже или выше проверенного диапазона, вся версия плагина считается неподдерживаемой, включая режим `direct`. Обновите OpenCode либо выполните отдельный source audit и compatibility test. Для теста без замены глобальной установки можно запустить точную версию OpenCode через Bun:

```powershell
bun x --bun opencode-ai@1.18.18 --version
bun x --bun opencode-ai@1.18.18
```

Верхняя граница намеренная: публичный `chat.headers`, перенос его результата в provider fetch и внутренний OpenAI HTTP fallback проверены только на указанных версиях. Перед расширением диапазона нужны повторный source audit и runtime/transport tests.

Публичный API OpenCode не даёт плагину полного контроля над всеми сетевыми клиентами процесса. Гарантированно обрабатывается HTTP-трафик, который дошёл до перехваченного `fetch` и сохранил выданный плагином маршрутный маркер. Немаркированные OAuth/служебные запросы маршрутизируются только по явно известной exact auxiliary-origin policy. Следующие случаи требуют отдельной проверки или внешней сетевой политики:

- плагин отсутствует или не загрузился до установки interceptor;
- другой компонент заранее сохранил старую ссылку на `fetch`;
- провайдер использует собственный WebSocket, native socket или другой клиент, не вызывающий process `fetch`;
- runtime-флаг native transport включён программно и не виден публичным hooks;
- сторонний wrapper одновременно удаляет маршрутный маркер и переписывает URL на auxiliary origin другого провайдера.

Для строгого запрета прямого исходящего трафика используйте дополнительную firewall/container egress policy.

Для OpenAI в проверенном OpenCode proxy-режим запрашивает version-specific HTTP fallback вместо WebSocket. Это внутренний compatibility contract и не означает, что произвольные WebSocket-транспорты других провайдеров автоматически поддерживаются.

## Установка из npm

OpenCode самостоятельно устанавливает npm-плагины через Bun. Отдельная глобальная команда `npm install` не требуется.

Найдите активный `opencode.json`. Типовой глобальный путь:

| ОС | Путь |
| --- | --- |
| Windows | `C:\Users\<имя>\.config\opencode\opencode.json` |
| Linux | `~/.config/opencode/opencode.json` |
| macOS | `~/.config/opencode/opencode.json` |

Пути могут быть переопределены окружением. Проверенная команда OpenCode показывает фактически используемые каталоги:

```powershell
opencode debug paths
```

Для точной тестовой версии:

```powershell
bun x --bun opencode-ai@1.18.18 debug paths
```

Используйте значение `config` из вывода и не заменяйте существующий файл целиком, если в нём уже есть другие настройки.

Сохраните остальные настройки файла и добавьте плагин. Для воспроизводимой установки рекомендуется закрепить точную версию:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@koteye/kote-gateway-opencode@0.1.0"
  ]
}
```

Вариант без закрепления версии использует npm-тег `latest`:

```json
{
  "plugin": [
    "@koteye/kote-gateway-opencode"
  ]
}
```

Это не гарантирует загрузку новой версии при каждом рестарте из-за package cache OpenCode. Для управляемого обновления используйте точный version pin и меняйте его явно.

Если routing-файл находится не по стандартному пути, используйте tuple-конфигурацию:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@koteye/kote-gateway-opencode@0.1.0",
      {
        "configPath": "C:\\Users\\<имя>\\AppData\\Roaming\\KoteGateway\\config.json"
      }
    ]
  ]
}
```

В JSON Windows-пути записываются с двойным обратным слешем `\\`.

Если в `plugin` уже есть другие элементы, добавьте KoteGateway в существующий массив, не удаляя их. После установки или изменения конфигурации полностью перезапустите OpenCode.

> До первого запуска обязательно создайте routing-файл из следующего раздела. Иначе инициализированный плагин перейдёт в blocked-state с `KOTE_CONFIG_NOT_FOUND`.

## Создание routing-конфигурации

Если `configPath` не задан, используется платформенный путь:

| ОС | Routing-файл |
| --- | --- |
| Windows | `%APPDATA%\KoteGateway\config.json` |
| Linux с `XDG_CONFIG_HOME` | `$XDG_CONFIG_HOME/kote-gateway/config.json` |
| Linux без `XDG_CONFIG_HOME` | `~/.config/kote-gateway/config.json` |
| macOS | `~/.config/kote-gateway/config.json` |

Создание каталога в PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:APPDATA\KoteGateway"
```

Конфигурация для первого Direct-теста оставляет неизвестные провайдеры на прямом маршруте и явно задаёт OpenAI как `direct`:

```json
{
  "version": 1,
  "default": "direct",
  "strict": true,
  "providers": {
    "openai": "direct"
  }
}
```

После успешного Direct-теста переключите только `openai` на `proxy` по инструкции ниже. Это compatibility-first, а не запрет прямого выхода: любой новый или ошибочно названный provider ID пойдёт `direct`. Если политика требует не отправлять неизвестные providers напрямую, используйте `default: "proxy"`, но только после transport audit каждого используемого провайдера.

Расширенный пример:

```json
{
  "version": 1,
  "default": "direct",
  "strict": true,
  "providers": {
    "openai": "proxy",
    "anthropic": "proxy",
    "openrouter": "direct",
    "google": "proxy",
    "amazon-bedrock": "proxy",
    "github-copilot": "direct",
    "ollama": "direct",
    "company-openai-compatible": "proxy"
  },
  "auxiliaryOrigins": {
    "company-openai-compatible": [
      "https://login.example.org"
    ]
  }
}
```

### Значение полей

| Поле | Назначение |
| --- | --- |
| `version` | Обязательная версия схемы, сейчас только `1` |
| `default` | Маршрут для provider ID, отсутствующих в `providers` |
| `strict` | При `true` неизвестные поля считаются ошибкой; при `false` игнорируются с предупреждением, но fail-closed и routing guards не ослабляются |
| `providers` | Точное соответствие provider ID режиму `direct` или `proxy` |
| `auxiliaryOrigins` | Дополнительные origin для OAuth или служебных HTTP-запросов конкретного провайдера |

Provider ID чувствителен к регистру и не вычисляется из hostname или API-ключа. В идентификаторе модели `openai/<model-id>` provider ID равен `openai`.

В `auxiliaryOrigins` разрешены только origin без credentials, пути, query или fragment:

```text
https://login.example.org       допустимо
https://login.example.org/token недопустимо
https://user:pass@example.org   недопустимо
```

Один origin нельзя назначить провайдерам с конфликтующими маршрутами.

Запись auxiliary origin охватывает все HTTP-пути этого origin, а не только OAuth endpoint. Держите список минимальным и добавляйте только origin, которыми действительно владеет соответствующий провайдер.

### Приоритет выбора файла

Первый заданный источник имеет приоритет:

1. переменная окружения `KOTE_GATEWAY_CONFIG`;
2. tuple option `configPath` в `opencode.json`;
3. стандартный платформенный путь.

Fallback между заданными источниками не выполняется. Например, если `KOTE_GATEWAY_CONFIG` задан, но указывает на отсутствующий файл, плагин вернёт ошибку и не попробует tuple/default path.

Проверить переменную в PowerShell:

```powershell
Get-Item Env:KOTE_GATEWAY_CONFIG -ErrorAction SilentlyContinue
```

Удалить её из текущей PowerShell-сессии:

```powershell
Remove-Item Env:KOTE_GATEWAY_CONFIG -ErrorAction SilentlyContinue
```

Версия 1 не поддерживает hot reload. После изменения routing-файла перезапустите OpenCode.

## Как выбирается маршрут

### Direct

```text
OpenCode provider -> ранее установленный fetch -> provider
```

В режиме `direct` плагин:

- не загружает bootstrap для модельного запроса;
- не добавляет proxy option;
- не переписывает URL провайдера;
- не использует KoteGateway как запасной маршрут.

### Proxy

```text
OpenCode provider
  -> проверенный подписанный bootstrap
  -> Bun fetch с proxy option
  -> HTTPS CONNECT
  -> исходный provider URL
```

TLS устанавливается между OpenCode и провайдером внутри `CONNECT`-туннеля. KoteGateway не подменяет сертификат провайдера. Заголовок `Authorization` остаётся в зашифрованном запросе к провайдеру и не становится proxy authorization.

CONNECT-proxy всё равно видит сетевые метаданные: IP клиента, hostname и порт назначения, время соединения и приблизительный объём трафика. Содержимое HTTPS-запроса остаётся защищено TLS при отсутствии компрометации конечных сторон.

Если descriptor нельзя получить ни из проверенного remote bootstrap, ни из пригодного подписанного cache, либо CONNECT завершается ошибкой, модельный запрос падает. Плагин не повторяет его напрямую.

## Авторизация и OpenAI OAuth

Авторизуйтесь штатным способом OpenCode через `/connect`. Не добавляйте OAuth-токены, API-ключи, cookies или account ID в routing-конфигурацию.

Для OpenAI встроены следующие auxiliary origins:

- `https://auth.openai.com`;
- `https://api.openai.com`;
- `https://chatgpt.com`.

Их не нужно повторять в `auxiliaryOrigins`. In-process token exchange, refresh и модельный HTTP-запрос используют маршрут `openai`, если проходят через контролируемый `fetch`.

Страница авторизации открывается во внешнем браузере. Браузерный трафик находится вне процесса OpenCode и не маршрутизируется этим плагином. Успешный вход в браузере сам по себе не доказывает прохождение token exchange или модельного запроса через KoteGateway.

Автоматические тесты покрывают синтетическую OAuth-последовательность без реальных credentials. Полный ручной E2E с настоящим OpenAI OAuth, refresh и модельным запросом в режимах Direct/Proxy в репозитории пока не заявлен как выполненный.

Следующие ручные Direct/Proxy команды используют ваш штатный `/connect` или API key, обращаются к реальному провайдеру и могут расходовать платную квоту. Если это нежелательно, начните с [автономной проверки без AI-аккаунта](#автономная-проверка-без-ai-аккаунта).

## Проверка режима Direct

1. Установите прямой маршрут:

```json
{
  "version": 1,
  "default": "direct",
  "strict": true,
  "providers": {
    "openai": "direct"
  }
}
```

2. Включите безопасные диагностические логи:

```powershell
$env:KOTE_GATEWAY_LOG_LEVEL = "debug"
```

В Bash:

```bash
export KOTE_GATEWAY_LOG_LEVEL=debug
```

3. Посмотрите модели:

```powershell
bun x --bun opencode-ai@1.18.18 models openai
```

В Bash используется та же команда:

```bash
bun x --bun opencode-ai@1.18.18 models openai
```

4. Выполните запрос, заменив `<MODEL_ID>`:

```powershell
bun x --bun opencode-ai@1.18.18 `
  --print-logs `
  --log-level DEBUG `
  run `
  --model "openai/<MODEL_ID>" `
  --title "KoteGateway direct check" `
  "Ответь только DIRECT_OK"
```

Эквивалент для Bash:

```bash
bun x --bun opencode-ai@1.18.18 \
  --print-logs \
  --log-level DEBUG \
  run \
  --model "openai/<MODEL_ID>" \
  --title "KoteGateway direct check" \
  "Ответь только DIRECT_OK"
```

Для совместимой глобальной установки вместо `bun x --bun opencode-ai@1.18.18` можно использовать `opencode`.

Ожидается запись `KoteGateway selected a provider route.` со структурированными полями, которые OpenCode может вывести внутри `extra`:

```text
KoteGateway plugin initialized.
KoteGateway selected a provider route.
providerID: openai
mode: direct
```

Модель должна ответить `DIRECT_OK`. Для этого модельного запроса не должно быть bootstrap cache hit/miss.

## Проверка режима Proxy

1. Для compatibility-first проверки оставьте direct-default и включите proxy только для тестируемого провайдера:

```json
{
  "version": 1,
  "default": "direct",
  "strict": true,
  "providers": {
    "openai": "proxy"
  }
}
```

2. Убедитесь, что native transport не включён:

```powershell
Remove-Item Env:OPENCODE_EXPERIMENTAL_NATIVE_LLM -ErrorAction SilentlyContinue
```

В Bash:

```bash
unset OPENCODE_EXPERIMENTAL_NATIVE_LLM
```

Значения `true`, `yes`, `on`, `1` и `y` включают native runtime в OpenCode. Для proxy-маршрута видимый native-флаг блокируется с `KOTE_UNSUPPORTED_TRANSPORT`, потому что публичный API не позволяет доказать перехват его HTTP-клиента.

3. Полностью перезапустите OpenCode и выполните запрос:

```powershell
bun x --bun opencode-ai@1.18.18 `
  --print-logs `
  --log-level DEBUG `
  run `
  --model "openai/<MODEL_ID>" `
  --title "KoteGateway proxy check" `
  "Ответь только PROXY_OK"
```

Эквивалент для Bash:

```bash
bun x --bun opencode-ai@1.18.18 \
  --print-logs \
  --log-level DEBUG \
  run \
  --model "openai/<MODEL_ID>" \
  --title "KoteGateway proxy check" \
  "Ответь только PROXY_OK"
```

Ожидается запись `KoteGateway selected a provider route.` со структурированными route-полями, которые OpenCode может вывести внутри `extra`:

```text
providerID: openai
mode: proxy
```

И одно из сообщений bootstrap:

```text
KoteGateway bootstrap cache miss; using verified remote bootstrap.
```

или:

```text
KoteGateway bootstrap cache hit.
```

При исправном Gateway модель должна ответить `PROXY_OK`. При ошибке CONNECT ожидается `KOTE_PROXY_REQUEST_FAILED`, без повторной прямой попытки.

Debug-лог подтверждает выбранную политику, но независимое доказательство сетевого пути требует наблюдения на стороне Gateway или системного сетевого контроля. Должен наблюдаться `CONNECT` к ожидаемому `<provider-host>:443` и не должно быть прямого соединения OpenCode с provider host. Количество туннелей не фиксировано: оно зависит от connection reuse, continuation и поведения транспорта. TLS MITM для проверки не требуется.

## Проверка fail-closed

### Безопасная проверка некорректной конфигурации

Создайте отдельный временный файл, не изменяя рабочую конфигурацию:

```json
{
  "version": 1,
  "default": "invalid",
  "strict": true,
  "providers": {
    "openai": "proxy"
  }
}
```

Сохраните его и укажите через переменную окружения. Полный PowerShell-сценарий:

```powershell
$invalidConfig = Join-Path ([IO.Path]::GetTempPath()) ("kote-gateway-invalid-{0}.json" -f [guid]::NewGuid())
$invalidJson = @{
  version = 1
  default = "invalid"
  strict = $true
  providers = @{ openai = "proxy" }
} | ConvertTo-Json -Depth 3
[IO.File]::WriteAllText($invalidConfig, $invalidJson, [System.Text.UTF8Encoding]::new($false))

$hadPreviousConfig = Test-Path Env:KOTE_GATEWAY_CONFIG
$previousConfig = $env:KOTE_GATEWAY_CONFIG
$env:KOTE_GATEWAY_CONFIG = $invalidConfig
try {
  bun x --bun opencode-ai@1.18.18 `
    --print-logs `
    --log-level DEBUG `
    run `
    --model "openai/<MODEL_ID>" `
    "Этот запрос не должен попасть к provider"
} finally {
  if ($hadPreviousConfig) {
    $env:KOTE_GATEWAY_CONFIG = $previousConfig
  } else {
    Remove-Item Env:KOTE_GATEWAY_CONFIG -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $invalidConfig -ErrorAction SilentlyContinue
}
```

Эквивалент для Bash:

```bash
invalid_config="$(mktemp "${TMPDIR:-/tmp}/kote-gateway-invalid.XXXXXX")"
trap 'rm -f "$invalid_config"' EXIT
printf '%s\n' '{"version":1,"default":"invalid","strict":true,"providers":{"openai":"proxy"}}' > "$invalid_config"

KOTE_GATEWAY_CONFIG="$invalid_config" \
KOTE_GATEWAY_LOG_LEVEL=debug \
bun x --bun opencode-ai@1.18.18 \
  --print-logs \
  --log-level DEBUG \
  run \
  --model "openai/<MODEL_ID>" \
  "Этот запрос не должен попасть к provider"
```

Ожидается ошибка:

```text
KOTE_CONFIG_INVALID
```

Ответа модели быть не должно. Сценарий наблюдаемо подтверждает, что плагин загрузился и вернул блокирующую `KOTE_CONFIG_INVALID`. Строго доказать нулевое число запросов к provider можно только счётчиком контролируемого target или network capture; автономный smoke ниже делает такую проверку.

Если сам пакет отсутствует или не смог загрузиться до установки interceptor, плагин не может остановить OpenCode — это отдельная граница, для которой нужна внешняя egress policy.

### Реальный локальный тест отказа CONNECT

В checkout репозитория:

Для TLS fixture нужен `openssl` в `PATH`. На Windows подходит OpenSSL из Git for Windows. Проверка:

```powershell
Get-Command openssl -ErrorAction SilentlyContinue
Test-Path "C:\Program Files\Git\usr\bin\openssl.exe"
```

Первый вариант проверяет `openssl` в `PATH`; второй — fallback, который тест автоматически использует при установленном Git for Windows.

```powershell
bun install --frozen-lockfile
bun test tests/integration/https-connect.test.ts
```

Тест поднимает локальный TLS target и TLS CONNECT proxy и проверяет:

- direct-запрос не обращается к proxy;
- proxy-запрос использует реальный CONNECT;
- после остановки proxy целевой сервер не получает прямой запрос.

## Автономная проверка без AI-аккаунта

Эта проверка собирает tarball из текущего Git checkout, устанавливает его в изолированный consumer, поднимает локальный OpenAI-compatible provider, выполняет SSE-stream, безопасный `read` tool-call и continuation. Она проверяет checkout, а не повторно скачивает опубликованный npm artifact:

```powershell
git clone --branch dev https://github.com/koteyye/opencode-kote-gateway.git
Set-Location opencode-kote-gateway

bun install --frozen-lockfile
bun run test:opencode
```

Ожидаемый итог:

```text
Packed package completed a streamed model/tool round trip and blocked invalid configuration through OpenCode 1.18.18 (2 provider requests).
```

Тест не использует внешний AI API или реальные credentials. Он проверяет загрузку packed package, `chat.headers`, сохранение provider headers, удаление внутреннего route marker, streaming и блокировку некорректной конфигурации.

«Автономная» здесь означает независимость от AI-аккаунта. Для `git clone`, `bun install` и первой загрузки точной версии OpenCode через Bun всё равно нужен доступ к GitHub/npm, если зависимости ещё не находятся в локальном cache.

Полный набор проверок разработчика:

Для полного `bun run check` также нужен `openssl` в `PATH`, потому что suite включает локальный HTTPS CONNECT test.

```powershell
bun run check
bun run audit
```

## Bootstrap и кэш

Proxy descriptor получается с фиксированного HTTPS bootstrap endpoint и проверяется встроенным Ed25519 public key. Непроверенный документ не используется.

Проверенная last-known-good копия хранится отдельно от routing-конфигурации:

| ОС | Bootstrap cache |
| --- | --- |
| Windows | `%LOCALAPPDATA%\KoteGateway\bootstrap.json`, fallback `%APPDATA%` |
| Linux | `$XDG_CACHE_HOME/kote-gateway/bootstrap.json` или `~/.cache/kote-gateway/bootstrap.json` |
| macOS | `~/Library/Caches/KoteGateway/bootstrap.json` |

Кэш не содержит OAuth-токены или API-ключи. Не редактируйте его вручную: подпись будет проверена повторно. После истечения подписанного документа допускается только ограниченный семидневный grace period для ранее проверенной копии.

## Логи и диагностика

Уровни логирования:

```text
error
warn
info
debug
```

PowerShell:

```powershell
$env:KOTE_GATEWAY_LOG_LEVEL = "debug"
```

Bash:

```bash
export KOTE_GATEWAY_LOG_LEVEL=debug
```

Логи плагина намеренно не должны содержать authorization headers, cookies, bodies, prompts/tool payloads, полные URL с query или полный bootstrap-документ. Тем не менее не публикуйте полный DEBUG-лог OpenCode, `.npmrc` или npm-токен. Перед отправкой фрагмента дополнительно скройте локальные config paths, чувствительные provider IDs и внутренние origins. Для обращения достаточно:

- версии OpenCode и Bun;
- строк с `KoteGateway` и `KOTE_*`;
- provider ID и выбранного режима;
- указания, был ли ответ провайдера.

### Основные ошибки

| Код | Что означает | Что проверить |
| --- | --- | --- |
| `KOTE_CONFIG_NOT_FOUND` | Routing-файл не найден | Фактический путь и приоритет `KOTE_GATEWAY_CONFIG` |
| `KOTE_CONFIG_INVALID` | JSON или схема некорректны | `version`, `default`, routes, неизвестные поля |
| `KOTE_BOOTSTRAP_UNAVAILABLE` | Remote bootstrap и пригодный LKG недоступны | Сеть, DNS и наличие кэша |
| `KOTE_BOOTSTRAP_INVALID` | Документ bootstrap имеет неверный формат или некорректные временные поля | Источник ответа и системное время |
| `KOTE_BOOTSTRAP_SIGNATURE_INVALID` | Подпись не прошла проверку | Не использовать документ, проверить источник |
| `KOTE_BOOTSTRAP_EXPIRED` | Получен expired bootstrap и нет пригодного verified cache | Дату системы и доступ к bootstrap service |
| `KOTE_PROXY_REQUEST_FAILED` | Ошибка proxy/CONNECT | Доступность Gateway и target origin |
| `KOTE_UNSUPPORTED_TRANSPORT` | Обнаружен видимый native runtime, который нельзя безопасно использовать для proxy | Отключить native runtime либо использовать direct |
| `KOTE_ROUTE_TOKEN_INVALID` | Маршрутный marker неизвестен, истёк или повреждён | Сторонние header/fetch wrappers и задержку запроса |
| `KOTE_PROVIDER_CONTEXT_MISSING` | Provider marker потерян или маршрут неоднозначен | Сторонние fetch wrappers и rewrite URL |
| `KOTE_REQUEST_CLONE_FAILED` | Нельзя безопасно сохранить семантику исходного `Request` | Не был ли body уже использован и не изменяет ли Request provider wrapper |
| `KOTE_GLOBAL_STATE_CONFLICT` | В процессе обнаружена несовместимая версия глобального interceptor state | Полностью перезапустить OpenCode и убрать несовместимые/дублирующиеся версии плагина |

Если отсутствует строка `KoteGateway plugin initialized.`, не считайте маршрутизацию активной. Проверьте имя пакета, совместимость версий и ошибки установки OpenCode.

## Обновление и удаление

### Обновление закреплённой версии

1. Изучите release notes и диапазон совместимости новой версии.
2. Измените spec в `opencode.json`, например с текущей версии на будущую:

```json
"@koteye/kote-gateway-opencode@<NEW_VERSION>"
```

3. Полностью перезапустите OpenCode.
4. Повторите Direct, Proxy и fail-closed проверки.
5. Если новая версия не прошла проверку, верните предыдущий version pin и снова полностью перезапустите OpenCode.

Не расширяйте диапазон OpenCode только потому, что пакет смог установиться: WebSocket/native поведение требует отдельного source audit и runtime smoke.

Не удаляйте внутренний package cache OpenCode вручную: стабильная команда принудительного refresh для него этим проектом не документирована. Управляйте версией через точный pin.

### Удаление

1. Удалите `@koteye/kote-gateway-opencode` или его tuple из массива `plugin`.
2. Удалите `KOTE_GATEWAY_CONFIG` и `KOTE_GATEWAY_LOG_LEVEL`, если задавали их специально для плагина.
3. Полностью перезапустите OpenCode.
4. Убедитесь, что строки `KoteGateway` больше не появляются в логах.
5. При необходимости отдельно удалите routing-файл и bootstrap cache.

PowerShell, только для текущей сессии:

```powershell
Remove-Item Env:KOTE_GATEWAY_CONFIG -ErrorAction SilentlyContinue
Remove-Item Env:KOTE_GATEWAY_LOG_LEVEL -ErrorAction SilentlyContinue
```

Bash:

```bash
unset KOTE_GATEWAY_CONFIG
unset KOTE_GATEWAY_LOG_LEVEL
```

Плагин освобождает свою регистрацию через `dispose()`. Routing-файл и подписанный bootstrap cache автоматически не удаляются.

## Контрольный список

- [ ] OpenCode имеет версию от `1.18.5` до `1.18.18`.
- [ ] Bun имеет версию `1.3.14` или новее.
- [ ] В `opencode.json` указано `@koteye/kote-gateway-opencode@0.1.0`.
- [ ] Routing-файл существует и содержит `version: 1`.
- [ ] `default` выбран осознанно: `direct` удобнее для постепенного внедрения, но разрешает прямой маршрут неизвестным providers.
- [ ] Provider ID указан точно и с правильным регистром.
- [ ] В routing-файле нет токенов, API-ключей или cookies.
- [ ] После изменения конфигурации OpenCode перезапущен.
- [ ] В логах есть `KoteGateway plugin initialized.`.
- [ ] Direct-тест показывает `mode: direct` и успешно отвечает.
- [ ] Proxy-тест показывает `mode: proxy` и bootstrap cache hit/miss.
- [ ] Native transport выключен для proxy-маршрута.
- [ ] Fail-closed тест завершается `KOTE_CONFIG_INVALID` без ответа модели.
- [ ] Для строгой сетевой гарантии настроена внешняя egress policy или проверены Gateway logs.

Дополнительные технические материалы:

- [Архитектура](architecture.md)
- [Полная схема конфигурации](configuration.md)
- [Совместимость провайдеров](provider-compatibility.md)
- [Модель безопасности](security.md)
- [Стратегия тестирования](testing.md)
