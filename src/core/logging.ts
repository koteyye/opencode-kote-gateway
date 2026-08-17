export type KoteLogDetails = Readonly<Record<string, unknown>>

export interface KoteGatewayLogger {
  debug(message: string, details?: KoteLogDetails): void
  info(message: string, details?: KoteLogDetails): void
  warn(message: string, details?: KoteLogDetails): void
  error(message: string, details?: KoteLogDetails): void
}

export type KoteGatewayLoggerInput = Partial<KoteGatewayLogger>
